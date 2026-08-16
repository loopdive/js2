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

  // ── The two families the first catalogue pass omitted ───────────────
  //
  // Both were measured base-vs-new on the compiled module before being pinned.
  // They matter more than the families that were catalogued, because a wrong
  // answer here is not "still wrong, differently" — it would be a REGRESSION
  // from a right answer: `null` and `undefined` are both falsy, so truthiness
  // was already correct before the seed and had to STAY correct, while numeric
  // coercion was the one family where the two values disagree in a way test262
  // scores (`Number(null)` is 0, `Number(undefined)` is NaN).

  it("stays FALSY in every truthiness position (unchanged by the seed — must not regress)", async () => {
    const bits = await runModuleInit(`
      var viaIf = 0, viaNot = 0, viaCond = 0, viaBoolean = 0, viaWhile = 0, viaOr = 0, viaAnd = 0;
      if (x) { viaIf = 0; } else { viaIf = 1; }
      viaNot = (!x) ? 1 : 0;
      viaCond = (x ? 0 : 1);
      viaBoolean = Boolean(x) ? 0 : 1;
      viaWhile = 1; while (x) { viaWhile = 0; break; }
      viaOr = ((x || 7) === 7) ? 1 : 0;
      viaAnd = ((x && 7) === undefined) ? 1 : 0;
      export function test() {
        return viaIf + 2 * viaNot + 4 * viaCond + 8 * viaBoolean + 16 * viaWhile + 32 * viaOr + 64 * viaAnd;
      }
      var x;
    `);
    expect(bits).toBe(1 + 2 + 4 + 8 + 16 + 32 + 64);
  });

  it("coerces NUMERICALLY as undefined (NaN), not as null (0)", async () => {
    // The one family where the two representations give different ANSWERS
    // rather than the same answer by two routes. Measured before the seed:
    // every row below read the null answer (`Number(null)` 0, `null + 1` 1,
    // `null < 1` true).
    const bits = await runModuleInit(`
      var viaNumber = 0, viaPlus = 0, viaUnary = 0, viaLess = 0;
      viaNumber = isNaN(Number(x)) ? 1 : 0;
      viaPlus = isNaN(x + 1) ? 1 : 0;
      viaUnary = isNaN(+x) ? 1 : 0;
      viaLess = (x < 1) ? 0 : 1;
      export function test() { return viaNumber + 2 * viaPlus + 4 * viaUnary + 8 * viaLess; }
      var x;
    `);
    expect(bits).toBe(1 + 2 + 4 + 8);
  });

  it("does not clobber a global that the `var` merely re-declares (§9.1.1.4.18)", async () => {
    // CreateGlobalVarBinding creates the binding with `undefined` ONLY when the
    // name is not already a property of the global object — so `var Math;` must
    // leave `Math` alone. This is the "seeded a slot that meant something else"
    // hazard the issue flagged as the reason a one-line fix needed a corpus A/B.
    const bits = await runModuleInit(`
      var viaMath = 0, viaArray = 0, viaJson = 0, viaObject = 0;
      viaMath = (Math.max(1, 2) === 2) ? 1 : 0;
      viaArray = Array.isArray([]) ? 1 : 0;
      viaJson = (JSON.stringify({}) === "{}") ? 1 : 0;
      viaObject = (Object.keys({ a: 1 }).length === 1) ? 1 : 0;
      export function test() { return viaMath + 2 * viaArray + 4 * viaJson + 8 * viaObject; }
      var Math, Array, JSON, Object;
    `);
    expect(bits).toBe(1 + 2 + 4 + 8);
  });

  // ── The regression the corpus A/B caught, and its fix ──────────────
  //
  // `language/statements/function/S13_A17_T1.js` went pass -> fail on the
  // seed-only tree: calling a `var f = function(){}` BEFORE the initializer
  // must throw a CATCHABLE TypeError, and the seeded singleton made it emit an
  // uncatchable wasm trap instead ("dereferencing a null pointer"). Cause:
  // `emitNullCheckThrow`'s #789 guarded-cast backup guard threw only when the
  // pre-cast value was `ref.is_null`, and the singleton is a NON-null
  // reference, so the guard declined to throw and the caller's `struct.get` on
  // the failed cast trapped. Fixed by widening that guard to
  // `is_null ∨ is-singleton` (`emitIsNullishAnyAt`).
  //
  // A trap is not merely a wrong answer: it is unobservable to the program, so
  // the test's own `catch` never runs. That is why this pin asserts the
  // TypeError is CAUGHT, not just that the call fails.

  it("calling a module `var f = function(){}` before its initializer throws a CATCHABLE TypeError", async () => {
    const bits = await runModuleInit(`
      var viaInitializer = 0, viaAssignment = 0;
      try { var r1 = f(); viaInitializer = 0; } catch (e) { viaInitializer = (e instanceof TypeError) ? 1 : 0; }
      var f = function () { return "ONE"; };
      try { var r2 = g(); viaAssignment = 0; } catch (e) { viaAssignment = (e instanceof TypeError) ? 1 : 0; }
      var g;
      g = function () { return "TWO"; };
      export function test() { return viaInitializer + 2 * viaAssignment; }
    `);
    expect(bits).toBe(1 + 2);
  });

  it("the same shape at FUNCTION scope also throws (the years-latent #737 twin)", async () => {
    // The local hoister has seeded `undefined` for function-scope `var` since
    // #737, so this shape trapped identically LONG BEFORE #4489 — measured on
    // both sides of the seed-only A/B. The widened guard repairs it too, which
    // is the evidence that the fix sits at the right level (the consumer, not
    // the seed).
    const bits = await runModuleInit(`
      var out = 0;
      function scope() {
        try { var r = inner(); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 0; }
        var inner = function () { return "ONE"; };
      }
      out = scope();
      export function test() { return out; }
    `);
    expect(bits).toBe(1);
  });

  // MEASURED RESIDUAL (pre-existing, NOT introduced here — it is what keeps 3
  // of #4465's 5 R1 rows red). The REFLECTIVE String-method arm (an object
  // `searchValue`, or a detached `String.prototype.replace.call`) stringifies
  // the undefined singleton as "[object Object]" instead of "undefined". The
  // provenance does not matter, which is the proof it is not this issue's:
  // an ABSENT ARGUMENT's undefined — a value the seed cannot reach — renders
  // "[object Object]" there both before and after the seed. The direct arm
  // (string `searchValue`) is correct. Owner: standalone-gap, filed against the
  // reflective String dispatch; see `## Residuals` in plan/issues/4489-*.md.
  it.fails('residual: reflective String.replace renders undefined as "[object Object]"', async () => {
    const bits = await runModuleInit(`
      var viaModuleVar = 0, viaAbsentArg = 0;
      var pattern = { toString: function () { return "AB"; } };
      function absent(p) { return p; }
      viaModuleVar = ("ABBABABAB".replace(pattern, function () { return x; }) === "undefinedBABABAB") ? 1 : 0;
      viaAbsentArg = ("ABBABABAB".replace(pattern, function () { return absent(); }) === "undefinedBABABAB") ? 1 : 0;
      export function test() { return viaModuleVar + 2 * viaAbsentArg; }
      var x;
    `);
    expect(bits).toBe(1 + 2);
  });
});
