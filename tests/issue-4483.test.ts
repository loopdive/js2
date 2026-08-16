// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4483) `built-ins/Function` residual families — the five this issue closed,
// plus `it.fails` pins on the measured residuals it deliberately did not.
//
// Scoped sweep of the whole `built-ins/Function` directory (509 `.js` files),
// standalone, run on this branch's base and on this branch by the same driver
// (`runTest262File(…, "standalone")`). The per-family numbers quoted in each
// block are from that same A/B; see the issue file for the flip list.
//
// Every block pins a NEGATIVE control next to its positive one, because each
// family's failure mode is over-application:
//
//   - F1 rewrites a call shape, so the control is that a user-defined
//     `Function` shadow is NOT rewritten;
//   - F2 answers `undefined` for an absent property, so the control is that a
//     property the wrapper chain really HAS still resolves;
//   - F3 blocks an inlining decision, so the control is that same-strictness
//     calls still behave;
//   - F4/F5/F6 turn a silent value into a THROW, so each control pins a shape
//     that must keep working.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

async function compileStandalone(source: string) {
  return await compile(source, {
    allowJs: true,
    fileName: "issue-4483.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
}

/** Compile `body` as `test()` and run it with NO imports — a host-free module. */
async function runHostFree(body: string): Promise<number> {
  const result = await compileStandalone(`export function test(): number { ${body} }`);
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/**
 * Same, but the statements run at MODULE scope and only the verdict is inside
 * `test()`. The IR front-end (`ir/from-ast`, slice 2) refuses a property access
 * on an `f64`/`i32` receiver and its rejection is surfaced as a hard compile
 * error, so an F2 probe written inside an IR-eligible `test()` never reaches
 * the legacy member-get path this issue changed. Module-level init is not an
 * IR slice-2 body, which is also where the test262 lane evaluates these
 * programs — so this shape is the faithful one, not a workaround.
 */
async function runHostFreeModule(prelude: string, verdict: string): Promise<number> {
  const result = await compileStandalone(`${prelude}\nexport function test(): number { return ${verdict}; }`);
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/**
 * The test262 STANDALONE lane's option set — `deferTopLevelInit` +
 * `hostBridge: "always"`, statements at script top level, verdict in `test()`.
 * F1 uses it because that is the lane the reshape was measured in, and the
 * route a `Function.call(…)` mint takes is option-dependent: in a plain ES
 * module (`export function test(){ var f = Function.call(…) }`) the shape is
 * claimed by an earlier eval-boundary arm and yields a non-function — BOTH on
 * this branch and on base, verified by reverting `calls.ts` alone, so it is a
 * pre-existing residual of that lane and not something this change moved.
 */
async function runRunnerLike(prelude: string, verdict: string): Promise<number> {
  const result = await compile(`${prelude}\nexport function test(): number { return ${verdict}; }`, {
    allowJs: true,
    fileName: "issue-4483.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    hostBridge: "always",
  } as Parameters<typeof compile>[1]);
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(result.binary, {}, { target: "standalone", providerLabel: "#4483" });
  return (instance.exports as { test(): number }).test();
}

/** 1 when evaluating `<expr>` threw a TypeError, 2 for another throw, 0 for no throw. */
const evalThrows = (expr: string) =>
  `try { var t = ${expr}; return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }`;

// TIER NOTE. CI's changed-root lane runs `JS2WASM_EVAL_ENGINE=interpreter`
// with the REFUSAL provider, where a module that CALLS the provider at runtime
// throws by design (tests/issue-4442.test.ts and tests/issue-4464.test.ts each
// need a tier arm for that reason). These pins deliberately need none: every
// `Function(…)` below has a CONSTANT body, which `tryStaticFunctionCtorCall`
// compiles away AOT, so the module never reaches the provider. Verified by
// running this whole file under both engines — 29 passed either way. Keep the
// bodies constant, or a tier arm becomes necessary.

describe("#4483 F1 — `Function.call/apply(thisArg, …)` is the Function CONSTRUCTOR", () => {
  // `Function.call` was a dynamic member read on a builtin → `__get_builtin` →
  // the #1472 Phase A standalone COMPILE ERROR. Measured on base: the whole
  // `S15.3_A2_*` / `S15.3_A3_*` family (8 files) was `compile_error`.
  // Flipped: `S15.3_A2_T1`, `S15.3_A2_T2`, `S15.3_A3_T1`, `S15.3_A3_T2`.
  it("compiles `Function.call(this, body)` at all (no `__get_builtin` refusal)", async () => {
    const result = await compileStandalone(
      `export function test(): number { var f = (Function as any).call(this, "return 7;"); return f(); }`,
    );
    expect(
      result.errors.filter((e) => e.message.includes("__get_builtin")).map((e) => e.message),
      "no dynamic-builtin refusal should remain",
    ).toEqual([]);
    expect(result.success).toBe(true);
  });

  it("ignores the thisArg and evaluates the body (§15.3.1)", async () => {
    expect(await runRunnerLike(`var f = (Function as any).call({ a: 1 }, "return 7;");`, `f() === 7 ? 1 : 0`)).toBe(1);
  });

  it("threads named parameters through `.call`", async () => {
    expect(
      await runRunnerLike(`var f = (Function as any).call(null, "a", "b", "return a + b;");`, `f(3, 4) === 7 ? 1 : 0`),
    ).toBe(1);
  });

  it("`.apply` with a literal argument array is the same construction", async () => {
    expect(
      await runRunnerLike(`var f = (Function as any).apply(null, ["a", "return a + 1;"]);`, `f(6) === 7 ? 1 : 0`),
    ).toBe(1);
  });

  // NEGATIVE CONTROL. A user-declared `Function` is NOT the intrinsic, so the
  // reshape must decline and leave the ordinary member call in place.
  it("does NOT rewrite a user-defined `Function` shadow", async () => {
    expect(
      await runHostFree(
        `function Function(x: number): number { return x; }
         var obj = { Function: Function, call: function(a: any, b: number): number { return b + 1; } };
         return obj.call(null, 6);`,
      ),
    ).toBe(7);
  });
});

describe("#4483 F2 — an ABSENT property of a number/boolean primitive is `undefined`", () => {
  // Base answered `ref.null.extern` for these two receiver families (string /
  // object / array / function receivers were already correct), and
  // `typeof null === "object"` made it observable. Measured on base with one
  // module, six receivers (.tmp/probes/p6-missing-prop.js):
  // num=NULL, bool=NULL, str/obj/arr/fn=UNDEF.
  // Flipped: `prototype/{apply,call}/S15.3.4.{3,4}_A5_T{1,2}` (4 files).
  it("number receiver → undefined, not null", async () => {
    expect(await runHostFreeModule(`var n = 1; var t = n.touched;`, `t === undefined ? 1 : 0`)).toBe(1);
  });

  it('number receiver → `typeof` is "undefined", not "object"', async () => {
    expect(await runHostFreeModule(`var n = 1; var ty = typeof n.touched;`, `ty === "undefined" ? 1 : 0`)).toBe(1);
  });

  it("boolean receiver → undefined, not null", async () => {
    expect(await runHostFreeModule(`var b = true; var t = b.touched;`, `t === undefined ? 1 : 0`)).toBe(1);
  });

  it("is NOT null (the exact base answer)", async () => {
    expect(await runHostFreeModule(`var n = 1; var t = n.touched;`, `t === null ? 0 : 1`)).toBe(1);
  });

  // NEGATIVE CONTROLS — properties the wrapper chain really has must keep
  // their existing lowering; a fold that swallowed them would answer
  // `undefined` for `toFixed`/`constructor` and break every numeric method.
  it("does NOT swallow a real `Number.prototype` member", async () => {
    expect(await runHostFreeModule(`var n = 1.5; var s = n.toFixed(1);`, `s === "1.5" ? 1 : 0`)).toBe(1);
  });

  it("does NOT fire when the module extends `Number.prototype`", async () => {
    expect(
      await runHostFreeModule(
        `(Number.prototype as any).touched = 7;
         var n = 1;
         var t = (n as any).touched;`,
        `t === 7 ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("leaves an OBJECT receiver's absent property alone (already correct)", async () => {
    expect(await runHostFreeModule(`var o: any = {}; var t = o.touched;`, `t === undefined ? 1 : 0`)).toBe(1);
  });
});

describe("#4483 F3 — inlining must not merge two activations of different strictness", () => {
  // §15.3.5.4: a sloppy function's `.caller` throws while its immediate caller
  // is STRICT. The marker is emitted per WASM FUNCTION body, and the IR
  // inliner (#4157) had moved a strict callee's calls into a sloppy caller's
  // body — so the call was marked sloppy and nothing threw. Measured on base:
  // `15.3.5.4_2-{20,42,45}gs` failed with "no exception was thrown at all";
  // the strict copy of the callee was left dead in the module.
  it("throws when the strict caller is a FunctionDeclaration nested in a FunctionExpression", async () => {
    expect(
      await runHostFree(
        `var f1 = function() {
           function f() { "use strict"; gNonStrict(); }
           return f();
         };
         function gNonStrict() { return gNonStrict.caller; }
         try { f1(); return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  it("throws when the strict caller is invoked with `new`", async () => {
    expect(
      await runHostFree(
        `function gNonStrict() { return gNonStrict.caller; }
         try {
           var o = new (function() { "use strict"; gNonStrict(); } as any);
           return 0;
         } catch (e) { return (e instanceof TypeError) ? 1 : 2; }`,
      ),
    ).toBe(1);
  });

  // NEGATIVE CONTROL — the guard is keyed on `ctx.callerStrictGlobalIdx >= 0`,
  // i.e. it exists only in a module that actually reads a legacy `caller`. The
  // SAME nested shape with no `.caller` anywhere must keep inlining and keep
  // computing the right answer; if the guard leaked into every module it would
  // be a silent, program-wide cost-model change.
  //
  // (A "sloppy caller does not throw" control cannot be written as a module
  // pin: ES module code is strict, so `test()` itself is a strict caller and
  // the read legitimately throws. `15.3.5.4_2-{1,2,30,60}gs` are that control,
  // and they still pass — see the issue file.)
  it("leaves an identical program that never reads `.caller` untouched", async () => {
    expect(
      await runHostFree(
        `var f1 = function(): number {
           function f(): number { "use strict"; return g(); }
           return f();
         };
         function g(): number { return 5; }
         return f1();`,
      ),
    ).toBe(5);
  });
});

describe("#4483 F4 — `Function.prototype.{call,apply,bind}` read as a value is not a constructor", () => {
  // §20.2.3: those three built-ins have no [[Construct]], so `new (f.call)()`
  // is a §13.3.5.1 step-5 TypeError. Base ran the construction and threw
  // nothing. Flipped: `prototype/apply/S15.3.4.3_A8_T5`,
  // `prototype/call/S15.3.4.4_A7_T5`.
  it("`new (fn.call)` throws TypeError", async () => {
    expect(
      await runHostFree(`function fn() {} var FACTORY: any = (fn as any).call; ${evalThrows("new FACTORY()")}`),
    ).toBe(1);
  });

  it("`new (fn.apply)` throws TypeError", async () => {
    expect(
      await runHostFree(`function fn() {} var FACTORY: any = (fn as any).apply; ${evalThrows("new FACTORY()")}`),
    ).toBe(1);
  });

  // NEGATIVE CONTROL — CALLING (not constructing) the method value still works,
  // and `new` on the function itself is untouched.
  it("still constructs the function itself", async () => {
    expect(
      await runHostFree(`function Ctor(this: any) { this.p = 7; } var o: any = new (Ctor as any)(); return o.p;`),
    ).toBe(7);
  });
});

describe("#4483 F5 — `f.apply(thisArg, <primitive>)` is a TypeError", () => {
  // §20.2.3.1 step 4 → CreateListFromArrayLike step 2. Base called the
  // function instead. Flipped: `prototype/apply/argarray-not-object`.
  it("throws for a boolean argArray", async () => {
    expect(await runHostFree(`function fn() {} ${evalThrows("(fn as any).apply(null, true)")}`)).toBe(1);
  });

  it("throws for a number argArray", async () => {
    expect(await runHostFree(`function fn() {} ${evalThrows("(fn as any).apply(null, 42)")}`)).toBe(1);
  });

  it("throws for a STRING argArray — array-like, but not an Object", async () => {
    expect(await runHostFree(`function fn() {} ${evalThrows("(fn as any).apply(null, '1,2,3')")}`)).toBe(1);
  });

  // NEGATIVE CONTROLS — step 3 (null/undefined ⇒ empty list) and the ordinary
  // array case must NOT throw.
  it("does NOT throw for a null argArray (§20.2.3.1 step 3)", async () => {
    expect(await runHostFree(`function fn(): number { return 7; } return (fn as any).apply(null, null);`)).toBe(7);
  });

  it("does NOT throw for a real array argArray", async () => {
    expect(
      await runHostFree(`function add(a: number, b: number): number { return a + b; }
                         return (add as any).apply(null, [3, 4]);`),
    ).toBe(7);
  });

  // NEGATIVE CONTROL — RECEIVER narrowing. `x.apply` is only
  // `Function.prototype.apply` when `x` is a function; a plain object that owns
  // an `apply` member reaches the very same dispatch site in `calls.ts`. The
  // first cut of this arm keyed only on the method NAME and the argument type,
  // so this program threw a TypeError instead of answering 7 — measured on this
  // branch (`.tmp/probes/p20-user-apply.mts`: `-1`, i.e. it threw), and measured
  // as `7` both on base and after adding the `isCallableReceiver` guard. A
  // wrong throw is worse than no fold, so this control is the one that keeps
  // the arm honest.
  it("does NOT fire on a user object that owns an `apply` method", async () => {
    expect(
      await runHostFree(
        `var obj = { apply: function (a: any, b: number): number { return b + 1; } };
         return obj.apply(null, 6);`,
      ),
    ).toBe(7);
  });
});

describe("#4483 F6 — a `class` constructor called without `new` is a TypeError", () => {
  // §10.2.1 [[Call]] step 2. Base returned `null` silently — the worst answer,
  // because the program continues with a non-instance non-error.
  // Flipped: `internals/Call/class-ctor`.
  it("throws for a class declaration", async () => {
    expect(await runHostFree(`class C {} ${evalThrows("(C as any)()")}`)).toBe(1);
  });

  it("throws for a class expression binding", async () => {
    expect(await runHostFree(`var D = class {}; ${evalThrows("(D as any)()")}`)).toBe(1);
  });

  // NEGATIVE CONTROLS — `new` still constructs, and the ambient builtins that
  // TypeScript models as classes are CALLABLE (this is the exclusion that
  // makes the arm safe).
  it("still constructs with `new`", async () => {
    expect(await runHostFree(`class C { p = 7; } var c = new C(); return c.p;`)).toBe(7);
  });

  it("does NOT intercept the callable ambient builtins", async () => {
    expect(await runHostFree(`var s = String(7); return s === "7" ? 1 : 0;`)).toBe(1);
  });
});

describe("#4483 residuals — measured, NOT fixed here", () => {
  // A bound function carries no `length`/`name`. Measured on this branch
  // (.tmp/probes/p12-bind-meta.js): `bar.bind(null).length` is NaN and
  // `bar.bind(null).name` is undefined; spec says 2 and "bound bar".
  // Owner: family B of #4483, unclaimed — see the issue file's Residuals.
  it.fails("bound function `.length` is the remaining arity", async () => {
    expect(await runHostFree(`function bar(x: number, y: number) {} return (bar as any).bind(null).length;`)).toBe(2);
  });

  it.fails('bound function `.name` is "bound <target>"', async () => {
    expect(await runHostFree(`function bar() {} return (bar as any).bind(null).name === "bound bar" ? 1 : 0;`)).toBe(1);
  });
});
