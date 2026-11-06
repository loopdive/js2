// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 A3 — write-precise runtime-eval liveness. A literal eval source makes a
// top-level function live (routed through its global, kept off the IR) only
// when it can WRITE the name; a computed source still makes every function
// live. With liveness precise, the harness's function objects (`assert`,
// `compareArray`, `Test262Error`) keep their IR value route under the push.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { compileHarnessBody } from "./helpers/harness-module-init.js";

async function outcomes(source: string) {
  const result = await compile(source, { target: "standalone", trackIrOutcomes: true, fileName: "test.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return new Map((result.irOutcomes ?? []).map((outcome) => [outcome.displayName ?? outcome.name, outcome]));
}

const program = (evalCall: string) => `
function f(): number { return 1; }
function g(): number { return f(); }
${evalCall}
export function run(): number { return g(); }
`;

describe("#7106 A3 — write-precise runtime-eval liveness", () => {
  it("leaves a function a literal source only reads static (and `(0, eval)` is no escaped value)", async () => {
    const byName = await outcomes(program('(0, eval)("f()");'));
    for (const name of ["f", "g", "run"]) expect(byName.get(name)?.irBodyEmitted, name).toBe(true);
  });

  it.each([
    ["an assignment", '(0, eval)("f = function () { return 2; }");'],
    ["an Annex B block function", '(0, eval)("{ function f() { return 2; } }");'],
    ["a string-keyed global write", "(0, eval)(\"this['f'] = function () { return 2; }\");"],
    ["a property-defining call", "(0, eval)(\"Object.defineProperty(this, 'f', { value: 2 })\");"],
    ["nested dynamic code that writes", "(0, eval)(\"eval('f = function () { return 2; }')\");"],
    ["nested computed code", '(0, eval)("eval(x)");'],
    ["a computed source", 'var src = "1"; (0, eval)(src);'],
    ["an escaped eval value", 'var e = eval; e("1");'],
    // (#7146 review) a fragment that reaches eval / Function without naming them
    ["a function's constructor", "(0, eval)(\"(function () {}).constructor('f = function () { return 2; }')()\");"],
    ["a constructor chain", "(0, eval)(\"[].constructor.constructor('f = function () { return 2; }')()\");"],
    [
      "the generator constructor",
      "(0, eval)(\"Object.getPrototypeOf(function* () {}).constructor('f = function () { return 2; }')().next()\");",
    ],
    ["a string-keyed eval", "(0, eval)(\"this['eval']('f = function () { return 2; }')\");"],
    ["a computed eval key", "(0, eval)(\"this['ev' + 'al']('f = function () { return 2; }')\");"],
    ["a string-keyed Function", "(0, eval)(\"this['Function']('f = function () { return 2; }')()\");"],
    // the same reaches in the program itself
    ["globalThis.eval", 'globalThis.eval("f = function () { return 2; }");'],
    ['globalThis["eval"]', 'globalThis["eval"]("f = function () { return 2; }");'],
    ["a program-level function constructor", '(function () {}).constructor("f = function () { return 2; }")();'],
  ])("makes the function live for %s", async (_, evalCall) => {
    const byName = await outcomes(program(evalCall));
    expect(byName.get("g")?.irBodyEmitted).toBe(false);
    expect(byName.get("g")?.detail).toContain("eval-visible-binding");
  });

  it("keeps the harness function objects on the IR under the push", async () => {
    const result = await compileHarnessBody(
      'var e = new Test262Error("m"); (0, eval)("1"); assert.sameValue(e.constructor, Test262Error);',
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    for (const name of ["assert", "compareArray", "Test262Error"]) {
      expect(result.irOutcomes?.find((outcome) => outcome.displayName === name)?.irBodyEmitted, name).toBe(true);
    }
  });

  it("keeps a self-guarded constructor evaluated code may rebind on the fnctor path", async () => {
    const result = await compileHarnessBody('(0, eval)("Test262Error = function () {};");');
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irPostClaimErrors ?? []).toEqual([]);
    expect(result.irOutcomes?.find((outcome) => outcome.displayName === "Test262Error")?.irBodyEmitted).toBe(false);
  });
});
