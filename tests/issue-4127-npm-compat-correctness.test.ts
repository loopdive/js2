// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4127) npm-compat's correctness axis.
 *
 * `compile.success` + `validation.validates` answer "did a valid module come
 * out". A reader sees one row per package and reads green as "works". Four
 * packages do run a differential workload against a native-node oracle; every
 * *catalogued* package does not — its harness hardcodes `diff.runnable = false`
 * — and before this axis existed nothing on the row said so.
 *
 * The load-bearing tests here are the ones that prove the gate DETECTS a wrong
 * answer, not merely that a field was added. A correctness gate that cannot go
 * red is decoration.
 */
import { describe, expect, it } from "vitest";

import { correctnessRollup, correctnessVerdict } from "../scripts/lib/npm-compat-correctness.mjs";

describe("#4127 — the gate goes red on a wrong answer", () => {
  it("reports DIVERGENT when any operation disagrees with native node", () => {
    const verdict = correctnessVerdict({ kind: "differential-ops", passed: 20, total: 21 });
    expect(verdict.status).toBe("divergent");
    expect(verdict.reason).toContain("1 of 21");
  });

  it("is strict — a single divergence is not 'mostly fine'", () => {
    // 20/21 is 95%. It is still a wrong answer, and the whole point of the axis
    // is that a wrong answer must never read as green.
    expect(correctnessVerdict({ kind: "d", passed: 20, total: 21 }).status).not.toBe("verified");
    expect(correctnessVerdict({ kind: "d", passed: 0, total: 1 }).status).toBe("divergent");
  });

  it("reports VERIFIED only when every operation matched", () => {
    const verdict = correctnessVerdict({ kind: "differential-ops", passed: 21, total: 21 });
    expect(verdict.status).toBe("verified");
    expect(verdict.passed).toBe(21);
    expect(verdict.total).toBe(21);
  });

  it("catches the live case: cookie's committed 18/21 is divergent, not compatible", () => {
    // This is the demonstration, and it is not synthetic — `npm-compat.json`
    // ships `tests: { kind: "differential-ops", passed: 18, total: 21 }` for
    // cookie today, on a row that reads as compatible.
    const verdict = correctnessVerdict({ kind: "differential-ops", passed: 18, total: 21 });
    expect(verdict.status).toBe("divergent");
    expect(verdict.reason).toContain("3 of 21");
  });
});

describe("#4127 — 'never checked' must not look like 'checked and fine'", () => {
  it("reports UNVERIFIED when no workload exists", () => {
    const verdict = correctnessVerdict(null);
    expect(verdict.status).toBe("unverified");
    expect(verdict.status).not.toBe("verified");
    expect(verdict.reason).toMatch(/no differential workload/);
  });

  it("distinguishes 'did not compile' from 'compiled but never run'", () => {
    expect(correctnessVerdict(null, { compiles: false }).reason).toMatch(/does not compile/);
    expect(correctnessVerdict(null, { compiles: true }).reason).toMatch(/no differential workload/);
  });

  it("does not accept a workload that ran zero operations", () => {
    // A harness that silently drives nothing would otherwise report a perfect
    // 0/0 score and pass as verified.
    expect(correctnessVerdict({ kind: "d", passed: 0, total: 0 }).status).toBe("unverified");
  });

  it("does not accept a workload with missing counts", () => {
    expect(correctnessVerdict({ kind: "d", passed: null, total: null }).status).toBe("unverified");
    expect(correctnessVerdict({ kind: "d" } as never).status).toBe("unverified");
  });

  it("does not call implementation-blocked upstream tests divergent", () => {
    const verdict = correctnessVerdict({
      kind: "upstream-suite",
      status: "blocked",
      reason: "implementation did not produce a valid Wasm module",
      passed: 0,
      total: 294,
    });
    expect(verdict.status).toBe("unverified");
    expect(verdict.reason).toMatch(/did not produce a valid Wasm module/);
  });
});

describe("#4127 — the blind spot is counted and named", () => {
  const packages = [
    { name: "cookie", correctness: correctnessVerdict({ kind: "d", passed: 18, total: 21 }) },
    { name: "clsx", correctness: correctnessVerdict({ kind: "d", passed: 5, total: 5 }) },
    { name: "eslint", correctness: correctnessVerdict(null) },
    { name: "webpack", correctness: correctnessVerdict(null) },
  ];

  it("counts each state", () => {
    expect(correctnessRollup(packages).counts).toEqual({ verified: 1, divergent: 1, unverified: 2 });
  });

  it("NAMES the unverified packages, so the blind spot is legible", () => {
    // Counting alone lets a reader assume the unverified ones are the obscure
    // ones. Naming them is the point.
    expect(correctnessRollup(packages).unverified).toEqual(["eslint", "webpack"]);
    expect(correctnessRollup(packages).divergent).toEqual(["cookie"]);
  });

  it("records what the oracle is, so a future change cannot quietly weaken it", () => {
    const rollup = correctnessRollup(packages);
    expect(rollup.oracle).toMatch(/native Node/);
    expect(rollup.oracle).toMatch(/never read from a committed pin/);
  });

  it("never folds unverified into the compatible set", () => {
    const rollup = correctnessRollup(packages);
    expect(rollup.verified).not.toContain("eslint");
    expect(rollup.verified).not.toContain("webpack");
    expect(rollup.definition.unverified).toMatch(/UNKNOWN, not confirmed/);
  });
});
