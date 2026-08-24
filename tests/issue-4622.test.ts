// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4622) `delete arguments.length` — the crash-class defect behind #4620's
// family B.
//
// The `arguments` object is an opaque `$Vec` copy of the parameters, so the
// generic delete path routes through `__delete_property`, whose vec arm asks
// `__vec_gopd` for the descriptor. `__vec_gopd` answers with ARRAY rules, where
// `length` is `{configurable: false}` — right for `[1, 2]`, wrong for an
// arguments object, whose `length` is `{writable: true, enumerable: false,
// configurable: true}` in BOTH CreateMappedArgumentsObject and
// CreateUnmappedArgumentsObject (§10.4.4). The refusal surfaced as `false` in
// sloppy code and, via `emitStrictDeleteCheck`, a THROWN TypeError in strict
// code — the "compiler crash" #4620 recorded (a wasm exception whose JS-side
// `.message` is `undefined`, which is why it read as a compiler crash rather
// than a wrong answer).
//
// `__vec_gopd` cannot be fixed here: it is shared with real arrays and there is
// no runtime brand separating an arguments vec from one (#4620 family B). So
// the arm is SYNTACTIC — the compiler-materialized `arguments` local of this
// function, a static `length` key — and DECLINES whenever the object is
// reachable as a value (`Object.defineProperty(arguments, …)`, `Object.seal`,
// `var esc = arguments`, `with`, direct `eval`), because those can legitimately
// make `length` non-configurable and a wrong `true` is worse than no fold.
//
// Every case runs in a MODULE, so the code is STRICT — which is the half where
// the defect threw. The sloppy half (`false` instead of `true`) is covered by
// the test262 rows themselves; `language/arguments-object/S10.6_A5_T3` runs in
// both goals and flipped FAIL → PASS with this change.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runModule(src: string): Promise<number | string> {
  const r = await compile(src, {
    fileName: "test.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number | string }).test();
}

/**
 * Run `<body>` as the whole body of `f(a)`, called as `f(7)`, with the call
 * site wrapped so a thrown error becomes a code instead of an escaping wasm
 * exception: `9` = TypeError, `8` = any other throw.
 *
 * The wrapper is at the CALL site on purpose. An in-function `try`/`catch` also
 * catches, but it makes "did the delete throw" and "did the later read throw"
 * indistinguishable, which is exactly the confusion this issue started from.
 */
function fn(body: string): string {
  return `
    function f(a) {
${body}
    }
    var r;
    try { r = f(7); } catch (e) { r = (e instanceof TypeError) ? 9 : 8; }
    export function test() { return r; }`;
}

/** `1` when the delete succeeded, `2` when it was refused, `9` on TypeError. */
const deleteResult = (expr: string): string => fn(`      return (${expr}) ? 1 : 2;`);

describe("#4622 delete arguments.length no longer throws", () => {
  it("evaluates to true instead of throwing a TypeError (§10.4.4: length is configurable)", async () => {
    expect(await runModule(deleteResult("delete arguments.length"))).toBe(1);
  });

  it("answers the same through a bracketed static key", async () => {
    expect(await runModule(deleteResult('delete arguments["length"]'))).toBe(1);
  });

  it("does not throw when the result is discarded (statement position)", async () => {
    expect(await runModule(fn(`      delete arguments.length;\n      return 42;`))).toBe(42);
  });

  it("applies to a nested function's OWN arguments object, not the outer one", async () => {
    expect(
      await runModule(
        fn(`      var g = function () { return (delete arguments.length) ? 1 : 2; };
      return g(1, 2);`),
      ),
    ).toBe(1);
  });

  it("leaves the indexed slots reachable — the vec itself is untouched", async () => {
    expect(await runModule(fn(`      delete arguments.length;\n      return arguments[0];`))).toBe(7);
  });
});

describe("#4622 the arm declines rather than answering wrongly", () => {
  // Object.defineProperty / Object.seal can make `length` non-configurable, at
  // which point §10.4.4's fresh-object attribute table no longer describes this
  // object. Each of these passes `arguments` as a VALUE, which is the signal the
  // guard keys on; the generic `__delete_property` path then keeps its own
  // answer (a strict refusal ⇒ TypeError). The first two are also the
  // SPEC-CORRECT answers, not merely conservative ones.
  it("declines after Object.defineProperty(arguments, 'length', {configurable:false})", async () => {
    expect(
      await runModule(
        fn(`      Object.defineProperty(arguments, "length", { configurable: false });
      return (delete arguments.length) ? 1 : 2;`),
      ),
    ).toBe(9);
  });

  it("declines after Object.seal(arguments)", async () => {
    expect(
      await runModule(
        fn(`      Object.seal(arguments);
      return (delete arguments.length) ? 1 : 2;`),
      ),
    ).toBe(9);
  });

  it("declines once the arguments object escapes into a variable", async () => {
    expect(
      await runModule(
        fn(`      var esc = arguments;
      return (delete arguments.length) ? 1 : 2;`),
      ),
    ).toBe(9);
  });

  it("declines for a dynamic key", async () => {
    expect(
      await runModule(
        fn(`      var k = "length";
      return (delete arguments[k]) ? 1 : 2;`),
      ),
    ).toBe(9);
  });
});

describe("#4622 neighbouring delete shapes are unchanged", () => {
  it("keeps `delete arr.length` refused — a real Array's length IS non-configurable", async () => {
    expect(
      await runModule(`
    var arr = [1, 2];
    var r;
    try { r = (delete arr.length) ? 1 : 2; } catch (e) { r = (e instanceof TypeError) ? 9 : 8; }
    export function test() { return r; }`),
    ).toBe(9);
  });

  it("keeps `delete arguments.callee` refused in strict code (unmapped ⇒ configurable:false)", async () => {
    expect(await runModule(deleteResult("delete arguments.callee"))).toBe(9);
  });

  it("keeps `delete arguments[0]` succeeding", async () => {
    expect(await runModule(deleteResult("delete arguments[0]"))).toBe(1);
  });

  it("keeps `delete arguments.<absent>` succeeding", async () => {
    expect(await runModule(deleteResult("delete arguments.zork"))).toBe(1);
  });
});

describe("#4622 measured residuals — the $Vec representation cannot express these", () => {
  // The delete now REPORTS success, but the property SURVIVES: `arguments.length`
  // folds to the vec's length field and `hasOwnProperty` / `in` / the descriptor
  // all go through the shared vec helpers, none of which has anywhere to record
  // a deleted named key. Making the deletion observable is the descriptor
  // sidecar / [[ParameterMap]] work of #3251 (representation), not delete
  // lowering. Owner: #3251.
  it.fails("(#3251) a re-read of arguments.length still sees the pre-delete value", async () => {
    expect(await runModule(fn(`      delete arguments.length;\n      return arguments.length;`))).toBe(-1);
  });

  // `Object.getOwnPropertyDescriptor(arguments, "length").configurable` is
  // `false` because `__vec_gopd` (vec-overlay.ts) answers with Array rules. This
  // is what `language/arguments-object/10.6-6-2` and `10.6-7-1` assert, and both
  // still fail. Splitting it needs a runtime brand distinguishing the arguments
  // vec from an array — #4620's family-B finding. Owner: #4620 family B /
  // the vec-overlay + gOPD lane.
  it.fails("(#4620 family B) the length descriptor still reports configurable:false", async () => {
    expect(
      await runModule(
        fn(`      var d = Object.getOwnPropertyDescriptor(arguments, "length");
      return d.configurable ? 1 : 2;`),
      ),
    ).toBe(1);
  });

  // An ESCAPED arguments object (`var a = arguments; delete a.length`) is
  // declined by the guard above — deliberately, since a syntactic arm cannot
  // follow the value. #4620 recorded the same wall for `Array.isArray(arguments)`:
  // it needs the runtime brand, not a wider syntactic net. Owner: #4620 family B.
  it.fails("(#4620 family B) delete through an escaped alias is still refused", async () => {
    expect(
      await runModule(`
    function f() { return arguments; }
    var a = f(1, 2);
    var r;
    try { r = (delete a.length) ? 1 : 2; } catch (e) { r = (e instanceof TypeError) ? 9 : 8; }
    export function test() { return r; }`),
    ).toBe(1);
  });
});
