// #4429 — the STRING-hint OrdinaryToPrimitive dispatch must call `toString`
// with the RECEIVER as `this` (§7.1.1.1 step 4.b `Call(method, O)`).
//
// Object-literal methods are stored as `__obj_meth_tramp_*` trampolines that
// read `this` from the `__current_this` module GLOBAL — param-0 is the closure
// self/env, not the receiver. The NUMBER-hint valueOf dispatch installs that
// global (#2679); the string-hint dispatches did not, so `'' + a` / `String(a)`
// saw a stale receiver. The JS-host half of that is asserted by
// `tests/issue-2679-toprimitive-this.test.ts`; this file pins the STANDALONE
// (native-strings) lane, where a missing binding did not merely read the wrong
// object but left `__current_this` NULL — the trampoline's `ref.cast` then
// trapped with "dereferencing a null pointer" at runtime.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const OPTS = {
  target: "standalone",
  allowJs: true,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
  hostBridge: "always",
  fileName: "test.ts",
} as const;

async function runStandalone(body: string): Promise<number> {
  const result: any = await compile(`export function test(): any { ${body} }`, OPTS as any);
  expect(result.success).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  return (instance.exports as any).test();
}

describe("#4429 — string-hint ToPrimitive binds `this` (standalone)", () => {
  it("`'' + a` reads `this` inside a method-shorthand toString", async () => {
    // Pre-fix: RuntimeError "dereferencing a null pointer" in
    // __obj_meth_tramp_*_toString (global __current_this was never installed).
    expect(
      await runStandalone(`var a = { x: 7, toString() { return "v" + this.x; } }; return ("" + a) === "v7" ? 1 : 0;`),
    ).toBe(1);
  });

  it("`String(a)` reads `this` inside a method-shorthand toString", async () => {
    expect(
      await runStandalone(`var a = { x: 3, toString() { return "v" + this.x; } }; return String(a) === "v3" ? 1 : 0;`),
    ).toBe(1);
  });

  it("a template literal reads `this` inside a function-expression toString", async () => {
    expect(
      await runStandalone(
        `var a = { x: 5, toString: function () { return "v" + this.x; } }; return \`\${a}\` === "v5" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("the toString call still returns the right value and runs exactly once", async () => {
    expect(
      await runStandalone(
        `var n = 0; var a = { toString() { n = n + 1; return "x"; } }; var s = "" + a; return (n === 1 && s === "x") ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("`__current_this` is RESTORED after the dispatch (no leak into an enclosing method)", async () => {
    // The outer method's `this` must survive coercing an inner object.
    expect(
      await runStandalone(
        `var outer = { x: 1, m() { var inner = { x: 2, toString() { return "i" + this.x; } }; var s = "" + inner; return s + "/" + this.x; } };` +
          ` return outer.m() === "i2/1" ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});
