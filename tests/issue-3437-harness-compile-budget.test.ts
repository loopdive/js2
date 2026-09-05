// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3437 — deterministic pre-merge compile-time budget gate for the test262
// harness path. The oracle-v8 harness switch tanked CI via a quadratic per-file
// AST scan (#3433) that was invisible until the merge queue crawled. This gate
// measures a DETERMINISTIC, load-independent proxy — shared-forEachChild
// traversal count for a fixed representative assembly — against a committed
// budget. These tests lock in:
//   • the pure budget verdict (over / vacuous / wellBelow / ceiling),
//   • the fixture builder's determinism + scaling,
//   • that the committed budget actually HOLDS on current main (acceptance #4:
//     #3433 brought the harness back under budget), and
//   • that the meter is deterministic run-to-run.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "../src/index.js";
import { enableForEachChildMeter, disableForEachChildMeter, readForEachChildCalls } from "../src/ts-api.js";
import { evaluateBudget, buildRepresentativeAssembly } from "../scripts/check-harness-compile-budget.js";

const BUDGET = JSON.parse(readFileSync(resolve(__dirname, "../scripts/harness-compile-budget.json"), "utf-8")) as {
  forEachChildCalls: number;
  marginPct: number;
  fixtureCallSites: number;
  updated: string;
  note: string;
};
const VACUITY_FLOOR = 800;

describe("#3437 evaluateBudget — pure verdict", () => {
  it("passes when measured equals the budget", () => {
    const v = evaluateBudget(1000, 1000, 15, VACUITY_FLOOR);
    expect(v.overBudget).toBe(false);
    expect(v.vacuous).toBe(false);
    expect(v.ceiling).toBe(1150);
  });

  it("passes at the ceiling, fails one over it", () => {
    expect(evaluateBudget(1150, 1000, 15, VACUITY_FLOOR).overBudget).toBe(false);
    expect(evaluateBudget(1151, 1000, 15, VACUITY_FLOOR).overBudget).toBe(true);
  });

  it("flags a large regression as over budget (the #3433 class)", () => {
    const v = evaluateBudget(1_120_948, 98_089, 15, VACUITY_FLOOR);
    expect(v.overBudget).toBe(true);
  });

  it("flags a below-floor measurement as vacuous (meter/fixture broke)", () => {
    const v = evaluateBudget(10, 98_089, 15, VACUITY_FLOOR);
    expect(v.vacuous).toBe(true);
  });

  it("flags a well-below-budget measurement as an improvement to rebank", () => {
    expect(evaluateBudget(800, 1000, 15, VACUITY_FLOOR).wellBelow).toBe(true); // < floor(850)
    expect(evaluateBudget(900, 1000, 15, VACUITY_FLOOR).wellBelow).toBe(false);
  });

  it("rounds the ceiling up (Math.ceil), so a fractional margin never under-gates", () => {
    expect(evaluateBudget(0, 97, 15, VACUITY_FLOOR).ceiling).toBe(Math.ceil(97 * 1.15)); // 112
  });
});

// #5306 — the soft band. The gate's margin is consumed CUMULATIVELY by every
// PR, so a 99.98 %-spent budget makes the next harness-path PR fail for two
// weeks of other people's drift. Warning at the half-margin line surfaces that
// drift in every `quality` log; it must never change the exit status.
describe("#5306 evaluateBudget — soft warning band", () => {
  it("puts the soft ceiling at half the margin", () => {
    const v = evaluateBudget(1000, 1000, 15, VACUITY_FLOOR);
    expect(v.softCeiling).toBe(Math.ceil(1000 * 1.075)); // 1075
    expect(v.ceiling).toBe(1150);
  });

  it("does not warn at or below the half-margin line", () => {
    expect(evaluateBudget(1000, 1000, 15, VACUITY_FLOOR).nearCeiling).toBe(false);
    expect(evaluateBudget(1075, 1000, 15, VACUITY_FLOOR).nearCeiling).toBe(false);
  });

  it("warns between the soft ceiling and the hard ceiling, without failing", () => {
    const v = evaluateBudget(1076, 1000, 15, VACUITY_FLOOR);
    expect(v.nearCeiling).toBe(true);
    expect(v.overBudget).toBe(false);
    const atCeiling = evaluateBudget(1150, 1000, 15, VACUITY_FLOOR);
    expect(atCeiling.nearCeiling).toBe(true);
    expect(atCeiling.overBudget).toBe(false);
  });

  it("stops warning once it is a hard failure (a fail is not softened into a warning)", () => {
    const v = evaluateBudget(1151, 1000, 15, VACUITY_FLOOR);
    expect(v.overBudget).toBe(true);
    expect(v.nearCeiling).toBe(false);
  });

  it("reports the remaining margin in absolute traversals and as a share of the ceiling", () => {
    // The state this issue was filed from: 150,774 measured against the
    // 2026-08-20 budget of 131,133 — 29 traversals (0.02 %) of headroom left.
    const v = evaluateBudget(150_774, 131_133, 15, VACUITY_FLOOR);
    expect(v.nearCeiling).toBe(true);
    expect(v.marginLeft).toBe(29);
    expect(v.marginLeftPct.toFixed(2)).toBe("0.02");
  });

  it("reports a negative margin once over budget", () => {
    const v = evaluateBudget(1200, 1000, 15, VACUITY_FLOOR);
    expect(v.marginLeft).toBe(-50);
  });
});

describe("#5306 committed budget carries its provenance", () => {
  it("the note records the rebank date and the measured figure", () => {
    expect(BUDGET.note).toContain(BUDGET.updated);
    expect(BUDGET.note).toContain(String(BUDGET.forEachChildCalls));
  });

  it("main sits below the soft ceiling, so the band is not pre-tripped", () => {
    const v = evaluateBudget(BUDGET.forEachChildCalls, BUDGET.forEachChildCalls, BUDGET.marginPct, VACUITY_FLOOR);
    expect(v.nearCeiling).toBe(false);
  });
});

describe("#3437 buildRepresentativeAssembly — deterministic fixture", () => {
  it("is byte-identical across calls (same input, same string)", () => {
    expect(buildRepresentativeAssembly(120)).toBe(buildRepresentativeAssembly(120));
  });

  it("grows with the call-site count and includes the scanned constructs", () => {
    const small = buildRepresentativeAssembly(5);
    const big = buildRepresentativeAssembly(120);
    expect(big.length).toBeGreaterThan(small.length);
    // Exercises the async-assign scan (#3433 site), a class, a delete, defineProperty.
    expect(big).toContain("asyncRef = async function");
    expect(big).toContain("class Marker");
    expect(big).toContain("delete obj[");
    expect(big).toContain("Object.defineProperty(obj");
  });
});

describe("#3437 committed budget holds on current main", () => {
  async function measure(callSites: number): Promise<number> {
    enableForEachChildMeter();
    await compile(buildRepresentativeAssembly(callSites), { fileName: "harness-budget-fixture.ts" });
    const n = readForEachChildCalls();
    disableForEachChildMeter();
    return n;
  }

  it("the meter is deterministic run-to-run", async () => {
    const a = await measure(BUDGET.fixtureCallSites);
    const b = await measure(BUDGET.fixtureCallSites);
    expect(a).toBe(b);
    expect(a).toBeGreaterThan(VACUITY_FLOOR);
  });

  it("current main is within the committed ceiling (#3433 kept it fast)", async () => {
    const measured = await measure(BUDGET.fixtureCallSites);
    const v = evaluateBudget(measured, BUDGET.forEachChildCalls, BUDGET.marginPct, VACUITY_FLOOR);
    expect(v.overBudget, `measured ${measured} exceeded ceiling ${v.ceiling}`).toBe(false);
    expect(v.vacuous).toBe(false);
  });
});
