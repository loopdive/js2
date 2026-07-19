// #3459 — the baseline drift/staleness "clock age" must never be negative.
//
// The merge-shard-reports drift footer in test262-sharded.yml printed a
// `-43m clock age` when the baseline (refreshed post-merge) was fresher than
// the origin/main HEAD committer time. These pin the extracted computation:
//   1. a baseline older than main HEAD → positive age (normal staleness),
//   2. a baseline FRESHER than main HEAD → clamped to 0 with a skew flag
//      (the actual bug: never a negative age),
//   3. the epoch unit is a single documented one (SECONDS in, MINUTES out),
//   4. missing/sentinel-zero inputs → 0, undetermined (not a skew).
import { describe, expect, it } from "vitest";
import { computeClockAgeMinutes } from "../scripts/baseline-clock-age.mjs";

describe("#3459 baseline clock-age is never negative", () => {
  it("reports positive whole-minute age when baseline is older than main HEAD", () => {
    // main HEAD committed 90 minutes after the baseline was generated.
    const mainHead = 1_700_000_000;
    const baseline = mainHead - 90 * 60;
    const r = computeClockAgeMinutes(mainHead, baseline);
    expect(r.ageMinutes).toBe(90);
    expect(r.rawMinutes).toBe(90);
    expect(r.clamped).toBe(false);
  });

  it("clamps to 0 (not negative) when the baseline is FRESHER than main HEAD — the -43m bug", () => {
    // Reproduces the observed skew: baseline generated 43 minutes AFTER the
    // main HEAD commit time (baseline refresh runs post-merge).
    const mainHead = 1_700_000_000;
    const baseline = mainHead + 43 * 60;
    const r = computeClockAgeMinutes(mainHead, baseline);
    expect(r.ageMinutes).toBe(0); // never -43
    expect(r.ageMinutes).toBeGreaterThanOrEqual(0);
    expect(r.rawMinutes).toBe(-43); // raw skew preserved for the log
    expect(r.clamped).toBe(true);
  });

  it("treats seconds in and minutes out as the single documented epoch unit", () => {
    // 3600 seconds difference == 60 minutes, truncated toward zero.
    const r = computeClockAgeMinutes(2000 + 3661, 2000);
    expect(r.ageMinutes).toBe(61); // 3661s -> 61m (trunc)
    expect(r.clamped).toBe(false);
  });

  it("returns 0 and undetermined for sentinel-zero / missing timestamps", () => {
    expect(computeClockAgeMinutes(0, 1_700_000_000)).toEqual({
      ageMinutes: 0,
      rawMinutes: 0,
      clamped: false,
    });
    expect(computeClockAgeMinutes(1_700_000_000, 0)).toEqual({
      ageMinutes: 0,
      rawMinutes: 0,
      clamped: false,
    });
    expect(computeClockAgeMinutes(NaN, NaN)).toEqual({
      ageMinutes: 0,
      rawMinutes: 0,
      clamped: false,
    });
  });

  it("accepts string timestamps (as passed from bash) and never goes negative", () => {
    const r = computeClockAgeMinutes("1700000000", "1700002580");
    expect(r.ageMinutes).toBe(0); // baseline 43m fresher
    expect(r.clamped).toBe(true);
  });
});
