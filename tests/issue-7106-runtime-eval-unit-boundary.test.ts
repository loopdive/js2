// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 A1 — runtime eval is a per-unit boundary on standalone. One eval site
// used to withdraw every unit of the program (#2928). Now only a unit that
// references a script binding evaluated code may replace stays direct, with
// its call-graph component; the rest prepare, and the global push publishes
// their values through function-value support planned before the prepared
// component seals.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
var counter = 0;
function helper(x: number): number { return x * 2 + 1; }
function shadow(counter: number): number { return counter + 1; }
function live(): number { return 1; }
function callsLive(): number { return live(); }
function callsCallsLive(): number { return callsLive() + 1; }
function bump(): number { counter = counter + 1; return counter; }
Function("live = function () { return 2; }")();
export function useHelper(): number { return helper(20) + shadow(1); }
`;

async function outcomes(target: "standalone" | "wasi") {
  const result = await compile(SOURCE, { target, trackIrOutcomes: true, fileName: "test.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  // A withdrawn function never leaves a claimed caller or callee behind.
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return new Map((result.irOutcomes ?? []).map((outcome) => [outcome.displayName ?? outcome.name, outcome]));
}

const direct = (byName: Awaited<ReturnType<typeof outcomes>>, name: string, why: string) => {
  expect(byName.get(name)?.irBodyEmitted, name).toBe(false);
  expect(byName.get(name)?.detail, name).toContain(why);
};

function expectPerUnitBoundary(byName: Awaited<ReturnType<typeof outcomes>>): void {
  // Published to evaluated code as values; their trampolines are planned
  // before the component seals (no sealed-scope error). `shadow`'s
  // `counter` is its own parameter.
  for (const name of ["helper", "shadow", "useHelper"]) expect(byName.get(name)?.irBodyEmitted, name).toBe(true);
  // `live` is named by the literal fragment, so legacy routes it through its
  // live global; the script `var counter` lives in an externref slot that
  // evaluated code may overwrite with any value.
  direct(byName, "callsLive", "(eval-visible-binding)");
  direct(byName, "bump", "(eval-visible-binding)");
  // The call-graph component of a withdrawn function goes with it.
  direct(byName, "live", "(boundary-closure)");
  direct(byName, "callsCallsLive", "(boundary-closure)");
}

describe("#7106 A1 — runtime-eval boundary per unit", () => {
  it("prepares the units eval cannot observe and keeps eval-visible readers direct", async () => {
    expectPerUnitBoundary(await outcomes("standalone"));
  });

  // (#6979 S7-c) WASI lowers with the same native semantic regime, so the
  // global push publishes cached function values there too and WASI takes the
  // per-unit boundary instead of main's former whole-program `(uncached-push)`
  // withdrawal. Its eval calls still refuse at run time (no linkable provider,
  // #4195); this pins the selection.
  it("takes the same per-unit boundary on WASI", async () => {
    expectPerUnitBoundary(await outcomes("wasi"));
  });
});
