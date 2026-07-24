// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3459 — the merge_group baseline-drift check printed a NEGATIVE clock age
// ("-43m clock age"). Root cause: the age was computed as
// `(MAIN_HEAD_TS - BASELINE_TS) / 60`, but the baselines-repo HEAD commit is
// produced by promote-baseline AFTER the main commit it was generated from and
// can (on a merge_group re-validation) reflect a NEWER main state than the
// speculative checkout's origin/main — so BASELINE_TS > MAIN_HEAD_TS and the
// raw difference goes negative. These tests lock in that the reported clock age
// is NEVER negative and is derived from a single documented clock source /
// epoch unit (git %ct Unix SECONDS), covering the sign per the acceptance
// criteria.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { computeClockAge } from "../scripts/baseline-clock-age.mjs";

const SCRIPT = resolve(__dirname, "../scripts/baseline-clock-age.mjs");
const MIN = 60; // seconds per minute

describe("#3459 computeClockAge — sign & clamping", () => {
  it("reports a positive age when the baseline is genuinely older than main HEAD", () => {
    const mainTs = 1_700_000_000;
    const baseTs = mainTs - 45 * MIN; // baseline 45 min older
    const r = computeClockAge(mainTs, baseTs);
    expect(r.ageMinutes).toBe(45);
    expect(r.rawMinutes).toBe(45);
    expect(r.baselineAhead).toBe(false);
    expect(r.valid).toBe(true);
  });

  it("clamps to 0 (never negative) when the baseline is FRESHER than main HEAD — the -43m repro", () => {
    const mainTs = 1_700_000_000;
    const baseTs = mainTs + 43 * MIN; // baseline commit 43 min NEWER than main HEAD
    const r = computeClockAge(mainTs, baseTs);
    expect(r.ageMinutes).toBe(0); // NOT -43
    expect(r.ageMinutes).toBeGreaterThanOrEqual(0);
    expect(r.rawMinutes).toBe(-43); // raw signed diff preserved for diagnostics
    expect(r.baselineAhead).toBe(true);
    expect(r.valid).toBe(true);
  });

  it("reports age 0 for identical timestamps", () => {
    const r = computeClockAge(1_700_000_000, 1_700_000_000);
    expect(r.ageMinutes).toBe(0);
    expect(r.baselineAhead).toBe(false);
    expect(r.valid).toBe(true);
  });

  it("truncates a sub-minute difference toward zero (a fresh baseline never rounds up to 1m stale)", () => {
    const mainTs = 1_700_000_000;
    const baseTs = mainTs - 59; // 59 seconds older → 0 whole minutes
    const r = computeClockAge(mainTs, baseTs);
    expect(r.ageMinutes).toBe(0);
    expect(r.valid).toBe(true);
  });

  it("treats missing / non-positive / non-numeric timestamps as invalid with age 0", () => {
    for (const [m, b] of [
      [0, 1_700_000_000],
      [1_700_000_000, 0],
      ["", "abc"],
      [-1, 1_700_000_000],
      [NaN, 1_700_000_000],
    ] as Array<[unknown, unknown]>) {
      const r = computeClockAge(m as number, b as number);
      expect(r.ageMinutes).toBe(0);
      expect(r.valid).toBe(false);
    }
  });

  it("accepts string timestamps (as the workflow passes them via argv)", () => {
    const r = computeClockAge("1700002700", "1700000000");
    expect(r.ageMinutes).toBe(45);
    expect(r.valid).toBe(true);
  });
});

describe("#3459 CLI — stdout is a clean non-negative integer for $(...)", () => {
  function run(args: string[]): string {
    return execFileSync("node", [SCRIPT, ...args], { encoding: "utf-8" }).trim();
  }

  it("prints the positive age on the stale path", () => {
    expect(run(["1700002700", "1700000000"])).toBe("45");
  });

  it("prints 0 (never a negative string) when the baseline is ahead", () => {
    const out = run(["1700000000", "1700002580"]); // baseline 43m newer
    expect(out).toBe("0");
    expect(out.startsWith("-")).toBe(false);
  });

  it("prints 0 for the missing-timestamp sentinel (BASELINE_TS=0)", () => {
    expect(run(["1700000000", "0"])).toBe("0");
  });

  it("emits the full record with --json", () => {
    const out = run(["1700000000", "1700002580", "--json"]);
    const parsed = JSON.parse(out);
    expect(parsed.ageMinutes).toBe(0);
    expect(parsed.rawMinutes).toBe(-43);
    expect(parsed.baselineAhead).toBe(true);
    expect(parsed.valid).toBe(true);
  });
});
