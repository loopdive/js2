// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651 cluster C, slice C3) A defaulted parameter in a JAVASCRIPT source file
// was lowered to the SCALAR slot the checker inferred from its own default
// initializer.
//
// `method(aFalse = falseCount += 1)` types `aFalse` as `number`, so
// `C.prototype.method(false)` arrived in an `f64` slot and read back as `0` —
// the test262 signature `Expected SameValue(«0», «false»)`. In a `.ts` file
// that inference is a genuine declaration the checker enforces at every call;
// in a `.js` file there are no parameter types at all, so it is a statement
// about ONE call.
//
// Two halves, and a fix that ships only one of them is worse than neither:
//   1. the SLOT (`widenUndefinedDefaultParamSlot`), applied identically at
//      every parameter-list derivation — the class-method collection phase and
//      its fctx-build twin, the function-declaration lane, the closure lane and
//      the three object-literal-method lanes. A disagreement between any two of
//      them is invalid Wasm, not a wrong value;
//   2. the READ (`paramReadIsJsDefaultGuess`). The prologue was already right —
//      `__extern_is_undefined` gates the default — but the next instruction at
//      every use was `call $__unbox_number`, because the identifier read
//      re-narrows an externref local to the checker's type. Widening the slot
//      alone just moves the coercion one instruction later.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJsStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "probe.js",
    skipSemanticDiagnostics: true,
  });
  expect((result.errors ?? []).filter((e) => e.severity !== "warning")).toEqual([]);
  expect(result.imports ?? []).toEqual([]);
  const instance = await WebAssembly.instantiate(result.binary!, {});
  const exports = instance.instance.exports as { test?: () => number };
  expect(typeof exports.test).toBe("function");
  return exports.test!();
}

async function runJsHost(source: string): Promise<number> {
  const result = await compile(source, { fileName: "probe.js", skipSemanticDiagnostics: true });
  expect((result.errors ?? []).filter((e) => e.severity !== "warning")).toEqual([]);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as { test: () => number }).test();
}

// The test262 `*/dflt-params-arg-val-not-undefined.js` body, scored as a bit
// mask so one assertion names exactly which of the six argument kinds survived.
const SIX_ARGUMENT_KINDS = `
var obj = {};
var c1 = 0, c2 = 0, c3 = 0, c4 = 0, c5 = 0, c6 = 0;
var score = 0;
var callCount = 0;
class C {
  method(aFalse = c1 += 1, aString = c2 += 1, aNaN = c3 += 1, a0 = c4 += 1, aNull = c5 += 1, aObj = c6 += 1) {
    if (aFalse === false) score += 1;
    if (aString === '') score += 2;
    if (aNaN !== aNaN) score += 4;
    if (a0 === 0) score += 8;
    if (aNull === null) score += 16;
    if (aObj === obj) score += 32;
    callCount = callCount + 1;
  }
}
C.prototype.method(false, '', NaN, 0, null, obj);
if (callCount === 1) score += 64;
if (c1 === 0 && c2 === 0 && c3 === 0 && c4 === 0 && c5 === 0 && c6 === 0) score += 128;
export function test() { return score; }`;

describe("#6651 C3 — a JS defaulted parameter is not a scalar contract", () => {
  it("a class method receives every argument kind it was passed (standalone)", async () => {
    // Base 204 (= 128+64+8+4): only the two NUMERIC arguments and the two
    // bookkeeping assertions survived the f64 slot. `false`/`''`/`null`/`obj`
    // all read back as `0`. Node answers 255.
    expect(await runJsStandalone(SIX_ARGUMENT_KINDS)).toBe(255);
  });

  it("the same program on the HOST lane", async () => {
    // The widening is NOT target-gated: the defect is the checker's inference,
    // which is the same on both lanes, so the host answer must move with it.
    expect(await runJsHost(SIX_ARGUMENT_KINDS)).toBe(255);
  });

  it("all four parameter-list derivations agree", async () => {
    // Base 0. Each lane derives its own parameter list, and #5221 recorded that
    // widening only ONE of them turns a wrong answer into a thrown error — so
    // the object-literal method, the function declaration, the function
    // expression and the class generator method are pinned together.
    expect(
      await runJsStandalone(`
var obj = {};
var c = 0;
var score = 0;
var O = { meth(aFalse = c += 1, aNull = c += 1) {
  if (aFalse === false) score += 1;
  if (aNull === null) score += 2;
} };
O.meth(false, null);
function fd(aFalse = c += 1, aNull = c += 1) {
  if (aFalse === false) score += 4;
  if (aNull === null) score += 8;
}
fd(false, null);
var fe = function (aFalse = c += 1, aNull = c += 1) {
  if (aFalse === false) score += 16;
  if (aNull === null) score += 32;
};
fe(false, null);
class G { *gm(aFalse = c += 1, aNull = c += 1) {
  if (aFalse === false) score += 64;
  if (aNull === null) score += 128;
  yield 1;
} }
new G().gm(false, null).next();
export function test() { return score; }`),
    ).toBe(255);
  });

  it("the default still runs when the argument really is absent", async () => {
    // The negative direction, green on both sides: widening the slot must not
    // cost the §9.2.12 default itself. `undefined` — explicit or omitted — is
    // still what selects the initializer, and the initializer's own value is
    // still delivered unchanged. Both call shapes must score the same 3, so
    // the total is 6.
    expect(
      await runJsStandalone(`
var score = 0;
class C {
  method(a = 5, b = 'd') {
    if (a === 5) score += 1;
    if (b === 'd') score += 2;
  }
}
new C().method();
new C().method(undefined, undefined);
export function test() { return score; }`),
    ).toBe(6);
  });

  it("strict equality reads the value instead of folding from the guess", async () => {
    // Base 22 on BOTH lanes. The slot widening alone does NOT fix this: even
    // with the argument correctly boxed, the §7.2.16 step-1 fold in
    // `binary-ops-typed-dispatch` compared Type(number) against Type(boolean)
    // from the checker types and answered a constant `false` — `a == false`
    // and `!a` were right while `a === false` was wrong, in the same function.
    // `equalityOperandHasStaleStaticType` now refuses the fold for this
    // carrier, the same way it already refuses it for a for-in target.
    const source = `
var score = 0;
class C {
  method(aFalse = 1, aString = 2) {
    if (typeof aFalse === 'boolean') score += 1;
    if (typeof aFalse === 'number') score += 2;
    if (aFalse == false) score += 4;
    if (aFalse === false) score += 8;
    if (!aFalse) score += 16;
    if (typeof aString === 'string') score += 32;
    if (aString === '') score += 64;
  }
}
C.prototype.method(false, '');
export function test() { return score; }`;
    // 125 = every bit except the `typeof aFalse === 'number'` one, which is
    // the wrong answer disappearing.
    expect(await runJsStandalone(source)).toBe(125);
    expect(await runJsHost(source)).toBe(125);
  });

  it("the call-site candidate signature agrees with the widened callee", async () => {
    // This is the case that made the first cut UNSHIPPABLE, and it is why the
    // rule lives in one helper that ~20 derivations call rather than in the
    // four callee lanes the manifest rows needed. A call through a value
    // rebuilds the callee's signature from the CHECKER
    // (`matchClosureInfoBySignature`); with only the callee widened, the
    // candidate asked for an `f64` the compiled closure no longer declared,
    // the `ref.test` failed, and `outer()` — correct on the base — threw an
    // uncaught Wasm exception. Base 14 on both lanes, 31 here.
    const source = `
var score = 0;
function apply(fn, a) { return fn(a); }
function cb(x = 1) { return x === false ? 1 : 0; }
score += apply(cb, false);
var arr = [1, 2, 3];
function mapper(v, i = 0) { return v + i; }
var m = arr.map(mapper);
if (m[2] === 5) score += 2;
var sum = 0;
arr.forEach(function (v, i = 0) { sum += v * (i + 1); });
if (sum === 14) score += 4;
function outer(f = function (q = 2) { return q; }) { return f(7); }
if (outer() === 7) score += 8;
var o = { run(cbk = cb) { return cbk(false); } };
if (o.run() === 1) score += 16;
export function test() { return score; }`;
    expect(await runJsStandalone(source)).toBe(31);
    expect(await runJsHost(source)).toBe(31);
  });

  it("a lifted IIFE pads a missing defaulted argument with undefined, not null", async () => {
    // Found by the corpus control, not by the manifest: widening the slot
    // routed nine `annexB/language/function-code/*-func-skip-dft-param.js`
    // rows into a PRE-EXISTING `compileIIFE` defect. Its missing-argument pad
    // was `ref.null.extern`, which is JS `null` under the standalone value
    // model (#2864), so `emitDefaultParamInit`'s `__extern_is_undefined` test
    // answered false and the default never ran. Latent on the base tree, where
    // the TypeScript twin below already answered `null`.
    const source = `
var score = 0;
var init;
(function (f = 123) { init = f; }());
if (init === 123) score += 1;
var p2;
(function (x = 23) { p2 = x; }());
if (p2 === 23) score += 2;
(function (a, b = 5) { if (a === undefined && b === 5) score += 4; }());
export function test() { return score; }`;
    expect(await runJsStandalone(source)).toBe(7);
    expect(await runJsHost(source)).toBe(7);

    // The same defect on the TypeScript lane, which this slice's file gate
    // never touches: base answered 0 here.
    const tsResult = await compile(
      `let init: any;\n(function (f: any = 123) { init = f; }());\nexport function test(): number { return init === 123 ? 1 : 0; }`,
      { target: "standalone", fileName: "probe.ts" },
    );
    expect((tsResult.errors ?? []).filter((e) => e.severity !== "warning")).toEqual([]);
    const tsInstance = await WebAssembly.instantiate(tsResult.binary!, {});
    expect((tsInstance.instance.exports as { test: () => number }).test()).toBe(1);
  });

  it("a block-nested function declaration never writes a same-named parameter", async () => {
    // The corpus control's second finding. B.3.3.1 step 1.a.ii guards the whole
    // web-compat step on `parameterNames does not contain F`, and #4131 had
    // implemented step 3 (`SetMutableBinding` on an existing binding) without
    // that guard. It was invisible while the parameter sat on an `f64` slot —
    // the function object could not be stored there, so the spec-wrong write
    // was dropped and the eight `*-func-skip-dft-param.js` rows passed by
    // accident. Widening the slot made the write land.
    //
    // The simple-parameter twin (bits 4/8) is asserted alongside the defaulted
    // one because it is the row that was ALREADY green — it is what says the
    // guard belongs on `parameterNames`, not on "has an initializer".
    //
    // The complementary #4131 case this guard must not undo — a `var f` that
    // DOES take the step-3 write — is not asserted here because it is not
    // expressible in a probe this small (the compiler's own `var` carrier
    // drops the write in the `typeof` shape, on the base tree too). It is
    // covered directly instead: `block-decl-func-existing-var-update.js`,
    // `-existing-fn-update.js`, `-func-update.js` and `-func-init.js` were
    // run against this branch and pass.
    const source = `
var score = 0;
var init, after;
(function (f = 123) { init = f; { function f() {} } after = f; }());
if (init === 123) score += 1;
if (after === 123) score += 2;
var i2, a2;
(function (g) { i2 = g; { function g() {} } a2 = g; }(123));
if (i2 === 123) score += 4;
if (a2 === 123) score += 8;
export function test() { return score; }`;
    expect(await runJsStandalone(source)).toBe(15);
    expect(await runJsHost(source)).toBe(15);
  });

  it("a TypeScript source keeps its numeric slot — the gate is the FILE", async () => {
    // Green on both sides, and the reason the rule is keyed on the file rather
    // than on the shape of the initializer: in a `.ts` file the inferred
    // `number` IS a declaration the checker enforces at every call site, so the
    // scalar ABI is chosen, not guessed.
    const result = await compile(`export function f(a = 1): number { return a + 1; }`, {
      target: "standalone",
      fileName: "probe.ts",
    });
    expect(result.success).toBe(true);
    expect(result.wat).toMatch(/\(func \$f \(param f64\)/);
  });
});
