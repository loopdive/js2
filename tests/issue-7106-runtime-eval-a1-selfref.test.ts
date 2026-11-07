// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 A1 forward fix — a recursive reference to a top-level function
// resolves to that same declaration, but the name is bound in the script
// scope. When evaluated code may rebind it, the self-call must read the live
// binding: the function stays direct like any other eval-visible reader.
// Declarations nested in it, and a named function expression's own name, stay
// local and keep the IR.
//
// The end-to-end answer (9) is not asserted here: with the interpreter
// provider, an eval rebinding of a top-level function declaration is not yet
// observed even by a direct legacy `f(1)` — a provider gap measured identically
// before and after this fix (plan/issues/7106-ir-test262-harness-units.md).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const REBIND = 'Function("f = function (n) { return 9; }")();';

async function outcomes(source: string) {
  const result = await compile(source, { target: "standalone", trackIrOutcomes: true, fileName: "test.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return new Map((result.irOutcomes ?? []).map((outcome) => [outcome.displayName ?? outcome.name, outcome]));
}

describe("#7106 A1 — a self-reference crosses the runtime-eval boundary", () => {
  it("keeps a recursive function that eval may rebind direct", async () => {
    const byName = await outcomes(`
function f(n: number): number {
  if (n === 0) return 1;
  return f(n - 1);
}
var saved = f;
${REBIND}
var answer = saved(1);
`);
    expect(byName.get("f")?.irBodyEmitted).toBe(false);
    expect(byName.get("f")?.detail).toContain("eval-visible-binding");
  });

  it("keeps a named function expression's self-reference local", async () => {
    const byName = await outcomes(`
function f(): number { return 1; }
function g(n: number): number {
  const h = function f(k: number): number {
    if (k === 0) return 1;
    return f(k - 1);
  };
  return h(n);
}
${REBIND}
var answer = g(2);
`);
    expect(byName.get("g")?.irBodyEmitted).toBe(true);
  });

  it("keeps a reference to a nested declaration local", async () => {
    const byName = await outcomes(`
function f(): number { return 1; }
function g(): number {
  function f(): number { return 2; }
  return f();
}
${REBIND}
var answer = g();
`);
    expect(byName.get("g")?.irBodyEmitted).toBe(true);
  });
});
