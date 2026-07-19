import { describe, it, expect } from "vitest";
import {
  REGRESSION_RATIO_LIMIT,
  REGRESSION_BUCKET_LIMIT,
  REGRESSION_BUCKET_PATH_DEPTH,
  REGRESSION_RATIO_SMALL_SAMPLE_FLOOR,
  bucketRegressions,
  evaluateRegressionThresholds,
} from "../scripts/diff-test262.js";

// #1943 — the documented merge thresholds (10% regression ratio, 50-per-bucket)
// must be ENFORCED by the regression gate, not just documented in the
// dev-self-merge skill text. These unit tests pin the pure gate logic so the
// constants and the bucket grouping stay byte-identical to the skill.
//
// #3457 — the ratio arm is now NET-AWARE (see issue-3457.test.ts for the full
// matrix): a ratio breach on a net-positive/neutral diff or below the
// small-sample floor is a WARNING, not a hard fail. `evaluateRegressionThresholds`
// now returns `{ failures, warnings }` instead of a bare `string[]`. The
// per-bucket concentration check remains a hard fail independent of net.
describe("#1943 — regression threshold enforcement", () => {
  it("exposes the documented constants", () => {
    expect(REGRESSION_RATIO_LIMIT).toBe(0.1);
    expect(REGRESSION_BUCKET_LIMIT).toBe(50);
    expect(REGRESSION_BUCKET_PATH_DEPTH).toBe(5);
    expect(REGRESSION_RATIO_SMALL_SAMPLE_FLOOR).toBe(10);
  });

  it("buckets regressions by the first 5 path segments (skill-identical)", () => {
    const buckets = bucketRegressions([
      "test/built-ins/Array/prototype/every/a.js",
      "test/built-ins/Array/prototype/every/b.js",
      "test/built-ins/Array/prototype/some/c.js",
    ]);
    expect(buckets[0]).toEqual({ bucket: "test/built-ins/Array/prototype/every", count: 2 });
    expect(buckets.find((b) => b.bucket === "test/built-ins/Array/prototype/some")?.count).toBe(1);
  });

  it("HARD-FAILS a net-negative 12-improvement / 20-regression diff (ratio 167%, net −8 ≥ floor)", () => {
    const { failures } = evaluateRegressionThresholds({
      improvements: 12,
      regressionsWasmChange: 20,
      regressedFiles: Array.from({ length: 20 }, (_, i) => `test/built-ins/Reg${i}/x/y/t.js`),
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.includes("ratio") && f.includes("166.7%"))).toBe(true);
  });

  it("FAILS a 60-in-one-bucket diff even when the ratio is under 10%", () => {
    const { failures } = evaluateRegressionThresholds({
      improvements: 700, // 60/700 = 8.6% < 10% → ratio OK
      regressionsWasmChange: 60,
      regressedFiles: Array.from({ length: 60 }, (_, i) => `test/built-ins/Array/prototype/every/case${i}.js`),
    });
    expect(failures.some((f) => f.includes("bucket") && f.includes("every") && f.includes("60"))).toBe(true);
    expect(failures.some((f) => f.includes("ratio"))).toBe(false);
  });

  it("PASSES a clean diff (no regressions, few improvements)", () => {
    expect(evaluateRegressionThresholds({ improvements: 2, regressionsWasmChange: 0, regressedFiles: [] })).toEqual({
      failures: [],
      warnings: [],
    });
  });

  it("PASSES a borderline 9% ratio (under the 10% limit) with no warning", () => {
    expect(
      evaluateRegressionThresholds({
        improvements: 100,
        regressionsWasmChange: 9,
        regressedFiles: Array.from({ length: 9 }, (_, i) => `test/reg${i}/x/y/z/t.js`),
      }),
    ).toEqual({ failures: [], warnings: [] });
  });

  it("WARNS (does not fail) with zero improvements below the floor (∞ ratio, net<0, small sample)", () => {
    const { failures, warnings } = evaluateRegressionThresholds({
      improvements: 0,
      regressionsWasmChange: 3,
      regressedFiles: ["test/a/b/c/d/e.js", "test/a/b/c/d/f.js", "test/g/h/i/j/k.js"],
    });
    // 3 regressions < floor(10): the ratio is too noisy to hard-fail; the net
    // gate (net < 0) is what fails such a diff, not the ratio.
    expect(failures).toEqual([]);
    expect(warnings.some((w) => w.includes("ratio") && w.includes("∞") && w.includes("small-sample floor"))).toBe(true);
  });
});
