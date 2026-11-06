// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 A1 — runtime eval is a per-unit boundary on standalone. One eval site
// used to withdraw every unit of the program (#2928). Now only a unit that
// references a script binding evaluated code may replace stays direct; the
// rest prepare, and the global push publishes their values through
// function-value support planned before the prepared component seals.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SOURCE = `
var counter = 0;
function helper(x: number): number { return x * 2 + 1; }
function shadow(counter: number): number { return counter + 1; }
function live(): number { return 1; }
function callsLive(): number { return live(); }
function bump(): number { counter = counter + 1; return counter; }
var src = "live = function () { return 2; }";
(0, eval)(src);
export function run(): number { return helper(20) + callsLive() + shadow(bump()); }
`;

async function outcomes(target: "standalone" | "wasi") {
  const result = await compile(SOURCE, { target, trackIrOutcomes: true, fileName: "test.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return new Map((result.irOutcomes ?? []).map((outcome) => [outcome.displayName ?? outcome.name, outcome]));
}

describe("#7106 A1 — runtime-eval boundary per unit", () => {
  it("prepares the units eval cannot observe and keeps eval-visible readers direct", async () => {
    const byName = await outcomes("standalone");
    // `helper`, `shadow` and `live` are published to evaluated code as values;
    // their trampolines are planned before the component seals (no
    // sealed-scope error). `shadow`'s `counter` is its own parameter.
    for (const name of ["helper", "shadow", "live"]) expect(byName.get(name)?.irBodyEmitted).toBe(true);
    // `live` is named by the literal fragment, so legacy routes it through its
    // live global; the script `var counter` lives in an externref slot that
    // evaluated code may overwrite with any value.
    for (const name of ["callsLive", "bump", "run"]) {
      expect(byName.get(name)?.irBodyEmitted).toBe(false);
      expect(byName.get(name)?.detail).toContain("eval-visible-binding");
    }
  });

  it("keeps the whole-program withdrawal on WASI", async () => {
    const byName = await outcomes("wasi");
    for (const name of ["helper", "shadow", "live", "callsLive", "bump", "run"]) {
      expect(byName.get(name)?.irBodyEmitted).toBe(false);
      expect(byName.get(name)?.detail).toContain("(uncached-push)");
    }
  });
});
