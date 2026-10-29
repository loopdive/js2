// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7195 S1 — a zero-parameter, void FunctionExpression passed as an argument of
// a top-level call through a same-source function object's member (the
// test262 `assert.throws(C, function () { … })` shape) gets the member-closure
// plan's canonical wrapper ABI, so `<module-init>` claims it on standalone.
// Shapes the plan cannot prove stay refused at select, never withdrawn after
// the claim.

import { describe, expect, it } from "vitest";
import { compile, type CompileResult } from "../src/index.js";

const HARNESS = `/** @returns {void} */ function assert(mustBeTrue, message) { if (mustBeTrue === true) return; throw message; }
assert.throws = function (expected, func, message) {
  try { func(); } catch (thrown) { if (thrown !== expected) throw "wrong " + thrown; return; }
  throw "no throw";
};
assert.twice = function (func) {
  try { func(); } catch (first) { try { func(); } catch (second) { throw "ran twice"; } }
};
`;

const OPTIONS = {
  target: "standalone",
  allowJs: true,
  fileName: "test.js",
  skipSemanticDiagnostics: true,
  trackIrOutcomes: true,
  deferTopLevelInit: true,
  hostBridge: "always",
} as const;

function initRow(result: CompileResult) {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const rows = (result.irOutcomes ?? []).filter((entry) => entry.displayName === "<module-init>");
  expect(rows).toHaveLength(1);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  return rows[0]!;
}

/** "ok", or the string a native throw carried out of `<module-init>` ("threw"). */
async function runInit(result: CompileResult): Promise<string> {
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  try {
    (instance.exports.__module_init as () => void)();
    return "ok";
  } catch (error) {
    if (error instanceof WebAssembly.Exception) return "threw";
    throw error;
  }
}

function node(source: string): string {
  try {
    new Function(source)();
    return "ok";
  } catch {
    return "threw";
  }
}

describe("#7195 S1 — callback-argument closures in <module-init>", () => {
  it.each([
    ["a throwing callback", `assert.throws("y", function () { throw "y"; });`],
    ["a callback that throws the wrong value", `assert.throws("y", function () { throw "z"; });`],
    ["a callback that does not throw", `assert.throws("y", function () { void 0; });`],
    [
      // `assert.twice` throws only if the second call also threw.
      "a callback the callee runs twice",
      `assert.twice(function () { throw "x"; });`,
    ],
    [
      "two callbacks in sequence",
      `assert.throws("a", function () { throw "a"; });\nassert.throws("b", function () { throw "b"; });`,
    ],
  ])(
    "claims %s and runs it like legacy and node",
    async (_name, statements) => {
      const source = HARNESS + statements + "\n";
      const ir = await compile(source, OPTIONS);
      expect(initRow(ir).irBodyEmitted).toBe(true);
      const legacy = await compile(source, { ...OPTIONS, experimentalIR: false });
      const expected = node(source);
      expect(await runInit(ir)).toBe(expected);
      expect(await runInit(legacy)).toBe(expected);
    },
    60_000,
  );

  it.each([
    // No callee unit joins the component for a call-argument site, so a direct
    // call would withdraw after the claim.
    [
      "a module-function call",
      `/** @returns {void} */ function f() { throw "y"; }\nassert.throws("y", function () { f(); });`,
    ],
    ["an ambient call", `assert.throws("y", function () { Symbol(); });`],
    ["a parameter", `assert.throws("y", function (x) { throw "y"; });`],
    ["a returned value", `assert.throws("y", function () { return 1; });`],
    ["an arrow", `assert.throws("y", () => { throw "y"; });`],
    // A <module-init> closure cannot capture a script-level binding.
    ["a script var read", `var n = 1;\nassert.throws("y", function () { if (n === 1) throw "y"; });`],
    ["a script let write", `let m = 0;\nassert.throws("y", function () { m = 1; throw "y"; });`],
    ["a script const read", `const c = "y";\nassert.throws("y", function () { throw c; });`],
  ])(
    "refuses a callback with %s at select",
    async (_name, statements) => {
      const result = await compile(HARNESS + statements + "\n", OPTIONS);
      expect(initRow(result)).toMatchObject({ irBodyEmitted: false, stage: "select" });
    },
    60_000,
  );

  it.each([
    ["reads", `var stored = 1;\nassert.store = function () { if (stored === 1) throw "y"; };`],
    ["writes", `var stored;\nassert.store = function (f) { stored = f; };`],
  ])(
    "refuses a member closure that %s a script var at select",
    async (_name, statements) => {
      const result = await compile(HARNESS + statements + "\n", OPTIONS);
      expect(initRow(result)).toMatchObject({ irBodyEmitted: false, stage: "select" });
    },
    60_000,
  );

  it("leaves the gc lane on legacy", async () => {
    const result = await compile(HARNESS + `assert.throws("y", function () { throw "y"; });\n`, {
      ...OPTIONS,
      target: "gc",
    });
    expect(initRow(result).irBodyEmitted).toBe(false);
  }, 60_000);
});
