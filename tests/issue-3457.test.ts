import { describe, it, expect } from "vitest";
import {
  REGRESSION_RATIO_SMALL_SAMPLE_FLOOR,
  evaluateRegressionThresholds,
  evaluateTrapCategoryGrowth,
} from "../scripts/diff-test262.js";

// #3457 — NET-AWARE / FLAP-TOLERANT regression-ratio gate.
//
// The raw 10 % regression-ratio gate (#1943) false-parked clean, net-positive
// and net-neutral PRs on small-sample flap:
//   • #3406 — issue-ID *scripts* only (0 codegen files): net +29, ratio 17 %
//             (6/35). The 6 "regressions" are physically impossible with no
//             codegen change → pure runner flake. Parked anyway.
//   • #3409 — real codegen lane-flip: stable-path net +30 (34 improvements − 4
//             regressions), ratio 11.8 %. A genuine net conformance GAIN parked.
//   • #3351/#3318/#3359 — symmetric content-current async/$DONE flap, net ≈ 0.
//
// The fix classifies the ratio breach against the NET (improvements −
// regressions): net ≥ 0 → advisory WARNING; net < 0 with regressions ≥ the
// small-sample floor → hard FAIL; net < 0 below the floor → advisory WARNING
// (the independent net gate fails it). The per-bucket (>50) concentration check
// and the #3189 uncatchable-trap growth ratchet stay independent hard gates.
describe("#3457 — net-aware / flap-tolerant regression-ratio gate", () => {
  const regFiles = (n: number, prefix = "Reg") =>
    Array.from({ length: n }, (_, i) => `test/built-ins/${prefix}${i}/a/b/c.js`);

  it("WAIVES the ratio on a net-positive high-ratio diff — #3409 signature (34 imp / 4 reg, net +30, 11.8%)", () => {
    const { failures, warnings } = evaluateRegressionThresholds({
      improvements: 34,
      regressionsWasmChange: 4,
      regressedFiles: regFiles(4),
    });
    expect(failures).toEqual([]); // NOT parked
    expect(warnings.some((w) => w.includes("11.8%") && w.includes("WAIVED") && w.includes("+30"))).toBe(true);
  });

  it("WAIVES the ratio on a net-positive high-ratio diff — #3406 signature (35 imp / 6 reg, net +29, 17.1%)", () => {
    const { failures, warnings } = evaluateRegressionThresholds({
      improvements: 35,
      regressionsWasmChange: 6,
      regressedFiles: regFiles(6),
    });
    expect(failures).toEqual([]);
    expect(warnings.some((w) => w.includes("WAIVED") && w.includes("net conformance change is +29"))).toBe(true);
  });

  it("WAIVES the ratio on net-NEUTRAL symmetric churn — #3351/#3318/#3359 signature (20 imp / 20 reg, net 0)", () => {
    const { failures, warnings } = evaluateRegressionThresholds({
      improvements: 20,
      regressionsWasmChange: 20,
      regressedFiles: regFiles(20),
    });
    expect(failures).toEqual([]); // net 0 ≥ 0 → not parked
    expect(warnings.some((w) => w.includes("WAIVED") && w.includes("+0"))).toBe(true);
  });

  it("HARD-FAILS a genuine net-negative one-directional regression (10 imp / 25 reg, net −15 ≥ floor)", () => {
    const { failures } = evaluateRegressionThresholds({
      improvements: 10,
      regressionsWasmChange: 25,
      regressedFiles: regFiles(25),
    });
    expect(failures.some((f) => f.includes("ratio") && f.includes("net -15"))).toBe(true);
  });

  it("HARD-FAILS a net-negative diff with zero improvements once at/above the floor (0 imp / 10 reg, ∞ ratio)", () => {
    const { failures } = evaluateRegressionThresholds({
      improvements: 0,
      regressionsWasmChange: REGRESSION_RATIO_SMALL_SAMPLE_FLOOR, // exactly the floor
      regressedFiles: regFiles(REGRESSION_RATIO_SMALL_SAMPLE_FLOOR),
    });
    expect(failures.some((f) => f.includes("ratio") && f.includes("∞"))).toBe(true);
  });

  it("small-sample floor: WARNS (does not fail) a net-negative diff just below the floor (2 imp / 9 reg, net −7)", () => {
    const { failures, warnings } = evaluateRegressionThresholds({
      improvements: 2,
      regressionsWasmChange: 9, // < floor(10)
      regressedFiles: regFiles(9),
    });
    expect(failures).toEqual([]); // ratio does not hard-fail; net gate (elsewhere) does
    expect(warnings.some((w) => w.includes("small-sample floor") && w.includes("WAIVED"))).toBe(true);
  });

  it("per-bucket >50 concentration STILL hard-fails even when the diff is net-positive (#3457 keeps the bucket gate)", () => {
    const files = Array.from({ length: 60 }, (_, i) => `test/built-ins/Array/prototype/every/case${i}.js`);
    const { failures } = evaluateRegressionThresholds({
      improvements: 1000, // net +940, ratio 6% — ratio arm would waive
      regressionsWasmChange: 60,
      regressedFiles: files,
    });
    expect(failures.some((f) => f.includes("bucket") && f.includes("every") && f.includes("60"))).toBe(true);
    expect(failures.some((f) => f.includes("ratio"))).toBe(false); // ratio under 10% and net-positive anyway
  });

  it("a net-positive diff with NO ratio breach produces neither failure nor warning (5% ratio)", () => {
    expect(
      evaluateRegressionThresholds({ improvements: 100, regressionsWasmChange: 5, regressedFiles: regFiles(5) }),
    ).toEqual({ failures: [], warnings: [] });
  });

  // The #3189 uncatchable-trap growth ratchet is a SEPARATE hard gate that must
  // still fire regardless of net — a net-positive PR that introduces a new
  // null_deref / illegal_cast / oob / unreachable trap still parks.
  it("trap-growth ratchet HARD-FAILS a new illegal_cast trap even when the surrounding diff is net-positive", () => {
    const baseline = new Map<string, { status: string; error_category?: string; wasm_sha?: string | null }>([
      ["test/a.js", { status: "pass", wasm_sha: "aaaa" }],
    ]);
    const newer = new Map<string, { status: string; error_category?: string; wasm_sha?: string | null }>([
      ["test/a.js", { status: "pass", wasm_sha: "aaaa" }],
      // A brand-new illegal_cast trap on a file that changed binary.
      ["test/b.js", { status: "fail", error_category: "illegal_cast", wasm_sha: "bbbb" }],
    ]);
    const growth = evaluateTrapCategoryGrowth(baseline, newer);
    expect(growth.failures.some((f) => f.includes("illegal_cast") && f.includes("ratchet"))).toBe(true);
    // The net-aware ratio arm on its own would WAIVE this diff (net-positive),
    // proving the two gates are orthogonal: the trap ratchet parks it anyway.
    const ratio = evaluateRegressionThresholds({
      improvements: 50,
      regressionsWasmChange: 1,
      regressedFiles: ["test/b.js"],
    });
    expect(ratio.failures).toEqual([]);
  });
});
