import { describe, it, expect } from "vitest";
import {
  REGRESSION_RATIO_LIMIT,
  REGRESSION_BUCKET_LIMIT,
  REGRESSION_BUCKET_PATH_DEPTH,
  bucketRegressions,
  evaluateRegressionThresholds,
} from "../scripts/diff-test262.js";

// #1943 — the documented merge thresholds (10% regression ratio, 50-per-bucket)
// must be ENFORCED by the regression gate, not just documented in the
// dev-self-merge skill text. These unit tests pin the pure gate logic so the
// constants and the bucket grouping stay byte-identical to the skill.
describe("#1943 — regression threshold enforcement", () => {
  it("exposes the documented constants", () => {
    expect(REGRESSION_RATIO_LIMIT).toBe(0.1);
    expect(REGRESSION_BUCKET_LIMIT).toBe(50);
    expect(REGRESSION_BUCKET_PATH_DEPTH).toBe(5);
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

  it("FAILS a 10-improvement / 5-regression diff (ratio 50%)", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 10,
      regressionsWasmChange: 5,
      regressedFiles: Array.from({ length: 5 }, (_, i) => `test/built-ins/Reg${i}/x/y/t.js`),
    });
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.some((f) => f.includes("ratio") && f.includes("50.0%"))).toBe(true);
  });

  it("FAILS a 60-in-one-bucket diff even when the ratio is under 10%", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 700, // 60/700 = 8.6% < 10% → ratio OK
      regressionsWasmChange: 60,
      regressedFiles: Array.from({ length: 60 }, (_, i) => `test/built-ins/Array/prototype/every/case${i}.js`),
    });
    expect(failures.some((f) => f.includes("bucket") && f.includes("every") && f.includes("60"))).toBe(true);
    expect(failures.some((f) => f.includes("ratio"))).toBe(false);
  });

  it("PASSES a clean diff (no regressions, few improvements)", () => {
    expect(evaluateRegressionThresholds({ improvements: 2, regressionsWasmChange: 0, regressedFiles: [] })).toEqual([]);
  });

  it("PASSES a borderline 9% ratio (under the 10% limit)", () => {
    expect(
      evaluateRegressionThresholds({
        improvements: 100,
        regressionsWasmChange: 9,
        regressedFiles: Array.from({ length: 9 }, (_, i) => `test/reg${i}/x/y/z/t.js`),
      }),
    ).toEqual([]);
  });

  it("FAILS when regressions exist but there are zero improvements (∞ ratio)", () => {
    const failures = evaluateRegressionThresholds({
      improvements: 0,
      regressionsWasmChange: 3,
      regressedFiles: ["test/a/b/c/d/e.js", "test/a/b/c/d/f.js", "test/g/h/i/j/k.js"],
    });
    expect(failures.some((f) => f.includes("ratio") && f.includes("∞"))).toBe(true);
  });
});
