// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4489) A module-scope `var` must READ AS `undefined` before its declaration
// statement — not as `null`.
//
// `registerModuleGlobal` can only give an externref module global a CONSTANT
// initializer, and the only constant externref is `ref.null.extern`. Under the
// #2106 S1 regime that value is `null`, which is a genuinely different value
// from the tag-1 `$undefined` singleton: `x === undefined` read false and
// `x === null` read true for a plain `var x;`. It is also the value the
// reflective closure ABI uses as its "argument not passed" pad
// (`string-proto-concat.ts`, §22.1.3.5 step 3), so a trailing `undefined`
// argument sourced from such a slot was DROPPED rather than stringified —
// #4465's R1 residual, five test262 rows.
//
// ## Why every case below is written in MODULE-INIT shape
//
// The obvious pin —
//
//     export function test() { var x; return x === undefined; }
//
// — cannot fail. A function-scoped `var` is seeded by the #737 local hoister,
// which has emitted a real `undefined` since long before this issue. #4465's
// R1 had no pin for exactly that reason: the harness's exported-function shape
// masks the defect. So each case here does its work in TOP-LEVEL statements
// (the `__module_init` body, which is where the module-global slot is actually
// read) and the exported function only hands back an already-computed answer.
// A pin that moves the computation inside `test()` is not testing this issue.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runModuleInit(src: string): Promise<number> {
  const r = await compile(src, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#4489 module-scope `var` seeds the undefined singleton", () => {
  it("`x === undefined` is true and `x === null` is false before the declaration", async () => {
    const bits = await runModuleInit(`
      var isUndefined = 0, isNull = 0, isLooseNullish = 0;
      isUndefined = (x === undefined) ? 1 : 0;
      isNull = (x === null) ? 1 : 0;
      isLooseNullish = (x == null) ? 1 : 0;
      export function test() { return isUndefined + 2 * isNull + 4 * isLooseNullish; }
      var x;
    `);
    // undefined: yes · null: no · == null: yes (§7.2.14 covers both)
    expect(bits).toBe(1 + 0 + 4);
  });

  it("passes `undefined`, not the absent-argument pad, as a trailing call argument", async () => {
    const bits = await runModuleInit(`
      var viaUser = 0, viaArguments = 0, viaCount = 0;
      // The second call site is load-bearing, not decoration: with ONE call
      // passing only \`x\`, TypeScript infers the parameter's type from that
      // single site and the slot narrows away from \`any\`, which is a property
      // of the pin's own shape rather than of the module-global path.
      function probe(a, b) { return (b === undefined) ? 1 : 0; }
      function counts(a) { return arguments.length; }
      function slot(a) { return (arguments[1] === undefined) ? 1 : 0; }
      viaUser = probe(1, x) * probe(1, "s" === "s" ? undefined : "s");
      viaArguments = slot(1, x);
      viaCount = counts(1, x) === 2 ? 1 : 0;
      export function test() { return viaUser + 2 * viaArguments + 4 * viaCount; }
      var x;
    `);
    // b === undefined · arguments[1] === undefined · the argument WAS passed
    expect(bits).toBe(1 + 2 + 4);
  });

  it('stringifies as "undefined" through String(), concat and `+`', async () => {
    const bits = await runModuleInit(`
      var viaString = 0, viaConcat = 0, viaPlus = 0, viaTemplate = 0;
      viaString = (String(x) === "undefined") ? 1 : 0;
      viaConcat = ("lego".concat(x) === "legoundefined") ? 1 : 0;
      viaPlus = ((x + "") === "undefined") ? 1 : 0;
      viaTemplate = (\`\${x}\` === "undefined") ? 1 : 0;
      export function test() { return viaString + 2 * viaConcat + 4 * viaPlus + 8 * viaTemplate; }
      var x;
    `);
    expect(bits).toBe(1 + 2 + 4 + 8);
  });

  it('`typeof x` is "undefined" (and stays so once assigned a real null)', async () => {
    const bits = await runModuleInit(`
      var beforeDecl = 0, afterNull = 0;
      beforeDecl = (typeof x === "undefined") ? 1 : 0;
      var y = null;
      afterNull = (typeof y === "object") ? 1 : 0;
      export function test() { return beforeDecl + 2 * afterNull; }
      var x;
    `);
    expect(bits).toBe(1 + 2);
  });

  it("the #4465 R1 shape: a trailing `var x;` argument to a reflective String method", async () => {
    const bits = await runModuleInit(`
      var viaConcat = 0, viaTail = 0;
      var __str = "lego";
      viaConcat = (__str.concat("A", "true", "42", x) === "legoAtrue42undefined") ? 1 : 0;
      viaTail = ("lego".concat(x) === "legoundefined") ? 1 : 0;
      export function test() { return viaConcat + 2 * viaTail; }
      var x;
    `);
    expect(bits).toBe(1 + 2);
  });

  it("a `var` hoisted out of top-level control flow gets the same seed", async () => {
    const bits = await runModuleInit(`
      var fromIf = 0, fromLoop = 0, fromTry = 0;
      fromIf = (a === undefined) ? 1 : 0;
      fromLoop = (b === undefined) ? 1 : 0;
      fromTry = (c === undefined) ? 1 : 0;
      export function test() { return fromIf + 2 * fromLoop + 4 * fromTry; }
      if (false) { var a; }
      for (var i = 0; i < 0; i++) { var b; }
      try { var c; } catch (e) {}
    `);
    expect(bits).toBe(1 + 2 + 4);
  });

  it("a later assignment still wins over the seed", async () => {
    const bits = await runModuleInit(`
      var before = 0, after = 0;
      before = (x === undefined) ? 1 : 0;
      var x;
      x = 42;
      after = (x === 42) ? 1 : 0;
      export function test() { return before + 2 * after; }
    `);
    expect(bits).toBe(1 + 2);
  });

  // MEASURED RESIDUAL (not fixed here). A module `var` whose slot the type
  // inference narrows to a PRIMITIVE (`var x = 42` ⇒ `(mut f64)`, `var s = "a"`
  // ⇒ `(mut (ref null $NativeString))`) cannot physically hold the singleton, so
  // its pre-declaration read still answers the wasm zero-init (`0` / `null`)
  // instead of `undefined`. This is the module-scope twin of #684, which the
  // function-local hoister solves by seeding `f64.const NaN`; #4264 solves it
  // for `with`-body vars by WIDENING the slot to externref. Both remedies are
  // slot-type changes with their own corpus-wide blast radius, so they are out
  // of this issue's scope — see `## Residuals` in plan/issues/4489-*.md.
  it.fails("residual: a primitive-slotted module `var` still reads as its zero-init", async () => {
    const bits = await runModuleInit(`
      var before = 0;
      before = (n === undefined) ? 1 : 0;
      var n = 42;
      export function test() { return before; }
    `);
    expect(bits).toBe(1);
  });

  it("a name that is both a `var` and a function declaration keeps the function", async () => {
    // §9.1.1.4.18 creates the `var` binding with `undefined` only when the name
    // is absent; GlobalDeclarationInstantiation then initialises the function
    // binding. The seed must therefore run BEFORE the function-binding seeds.
    const bits = await runModuleInit(`
      var isFunction = 0;
      isFunction = (typeof f === "function") ? 1 : 0;
      function f() { return 1; }
      export function test() { return isFunction; }
      var f;
    `);
    expect(bits).toBe(1);
  });
});
