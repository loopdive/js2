// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4515 wave-5) Pins for the three roots this slice closed, plus `it.fails`
// pins on the measured residuals it did not.
//
// Every number below comes from an A/B this lane ran in this worktree: the base
// arm is the touched source files reverted to `c42bdbe3e` in the SAME tree
// (`.tmp/base/`, `.tmp/arm.sh`), with the compiler bundle AND the quickjs eval
// adapter rebuilt on each arm — a stale adapter both overstates flips and hides
// regressions (plan/method/es5-standalone-agent-brief.md).
//
// Each positive pin EXECUTES the operation it guards — a pin that only asserts
// a shape is not a pin that exercises it — and each family carries a negative
// control, because all three roots fail by OVER-application:
//
//   - the raw-token directive rule makes a function SLOPPY, so a false positive
//     would un-strict a genuine `'use strict'`;
//   - the completion-value resets WRITE `undefined` into `V`, so a false
//     positive erases a value the spec keeps (hence the `lbl: {}` control, and
//     the do-while row the register was originally built for);
//   - the `in` reassigned-receiver route replaces a static fold with a runtime
//     probe, so its control is a key that must still answer `false`.
//
// ## Two harness facts that are load-bearing, both learned by measurement
//
// 1. `inferModuleStrictArguments: false`. The `export function test()` entry
//    point makes TypeScript flag the source a MODULE, and module code is always
//    strict — so without the flag every function in a strictness pin is strict
//    for a reason unrelated to its directive prologue. Measured: both arms of
//    the directive pin answered `1`, i.e. the pin could not fail for the reason
//    it existed.
// 2. The eval pins keep their bindings at MODULE TOP LEVEL, which is where the
//    test262 original-harness lane puts them. An `eval` body that reads or
//    writes a binding of the ENCLOSING FUNCTION throws
//    `ReferenceError: <name> is not defined` in this backend — pre-existing on
//    both arms, unrelated to this change-set, and it silently turns a pin into
//    a test of that limitation instead.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

/**
 * Compile and run a module whose top level sets `__r4515`, mirroring the
 * test262 standalone original-harness lane's compile options
 * (`tests/test262-runner.ts` ~L4205) so a pin measures the same configuration
 * the conformance numbers come from.
 */
async function runModule(topLevel: string): Promise<number> {
  const source = `${topLevel}\nexport function test(): number { return __r4515; }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4515-wave5.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    inferModuleStrictArguments: false,
    deferTopLevelInit: true,
    hostBridge: "always",
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(result.binary, {}, { target: "standalone", providerLabel: "#4515" });
  const exports = instance.exports as { test(): number; __module_init?: () => void };
  exports.__module_init?.();
  return exports.test();
}

/**
 * A direct `eval` with a constant body is USUALLY spliced by the inline path
 * (`eval-inline.ts`) and never reaches the runtime-eval provider — but that is
 * NOT universal, and the original blanket claim here ("these need no tier arm")
 * was wrong. It cost two CI failures on PR #4814.
 *
 * MEASURED AXIS (2026-08-23, varying one dimension at a time — the earlier
 * reading blamed loops, which is refuted by row B):
 *
 *   A  `1; 2;`                            no var, no loop   -> spliced, passes
 *   B  `1; do { 2; break; } while(true)`  no var, WITH loop -> spliced, passes
 *   C  `var q=0; 3;`                      VAR, no loop      -> PROVIDER
 *   D  `var q=0; do { q++; } while(q<2)`  VAR, with loop    -> PROVIDER
 *
 * A `var` in the body must hoist into the ENCLOSING variable environment, which
 * the inline splice cannot do, so it declines and the call reaches the provider.
 * Under CI's changed-root `quality` lane (`JS2WASM_EVAL_ENGINE=interpreter`,
 * REFUSAL provider) that throws a raw WebAssembly.Exception out of the module.
 * So: a `var`-declaring eval body needs a tier arm; the others genuinely do not.
 * `const`/`let` are block-scoped and stay splicable (see the `const t4515` pin).
 *
 * `expected` is the REFERENCE-ENGINE answer, recorded per case with the `node`
 * expression that produced it — never a guess from the grammar.
 */
const evalIs = (body: string, expected: string) =>
  `var v4515 = eval(${JSON.stringify(body)});\nvar __r4515 = (v4515 === ${expected}) ? 1 : 0;`;

/**
 * Tier arm for the `var`-declaring eval bodies above. Same seam as
 * `tests/issue-4464.test.ts`: under the refusal provider the observable that
 * survives is that the eval REACHES the provider and its refusal escapes the
 * module, so the pin still fails if the call is silently folded away instead.
 */
const REFUSAL_TIER = process.env.JS2WASM_EVAL_ENGINE === "interpreter";
async function expectRefusalEscape(p: Promise<number>): Promise<void> {
  let threw = false;
  try {
    await p;
  } catch {
    threw = true;
  }
  expect(threw, "refusal-tier eval should throw out of the module").toBe(true);
}

describe("#4515 wave-5 — a Use Strict Directive is matched on the RAW token (§11.2.2)", () => {
  // A directive containing a LineContinuation or an EscapeSequence is NOT a Use
  // Strict Directive, so the function stays sloppy and `f.call(undefined)`
  // substitutes the global object for `this`.
  //
  // Both pins call BOTH functions and combine the answers positionally
  // (`n*10 + …`), so the expected `1` can only be produced by "sloppy answered
  // 0, then genuinely-strict answered 1". Base arm: `11` — the cooked text
  // matched and both were compiled strict.
  it("a line continuation inside the directive leaves the function sloppy", async () => {
    expect(
      await runModule(`
      function lc4515() { 'use str\\
ict'; return (this === undefined) ? 1 : 0; }
      function strict4515() { 'use strict'; return (this === undefined) ? 1 : 0; }
      var __r4515 = 0;
      for (var i4515 = 0; i4515 < 2; i4515++) {
        var recv4515 = undefined;
        __r4515 = __r4515 * 10 + (i4515 === 0 ? lc4515.call(recv4515) : strict4515.call(recv4515));
      }`),
    ).toBe(1);
  });

  it("a unicode escape inside the directive leaves the function sloppy", async () => {
    expect(
      await runModule(`
      function esc4515() { 'use\\u0020strict'; return (this === undefined) ? 1 : 0; }
      function strictB4515() { "use strict"; return (this === undefined) ? 1 : 0; }
      var __r4515 = 0;
      for (var j4515 = 0; j4515 < 2; j4515++) {
        var recvB4515 = undefined;
        __r4515 = __r4515 * 10 + (j4515 === 0 ? esc4515.call(recvB4515) : strictB4515.call(recvB4515));
      }`),
    ).toBe(1);
  });
});

describe("#4515 wave-5 — §13 completion value: the forms that RESET V", () => {
  it("a break inside an if carries `undefined` out of the loop", async () => {
    // node: undefined. The row that made the omission visible
    // (`language/statements/for/head-init-expr-check-empty-inc-empty-completion.js`):
    // the `break` sits inside an `if`, so the iteration's completion is
    // (break, undefined) and the loop's UpdateEmpty has nothing to fill.
    // Base arm: 0 — we answered `4`, the last `c4515++` to run.
    const run = runModule(evalIs("var c4515=0; for(c4515=0;;) {if (c4515===5)break;else c4515++; }", "undefined"));
    if (REFUSAL_TIER) return expectRefusalEscape(run);
    expect(await run).toBe(1);
  });

  it("an if whose branch produces a value still yields it", async () => {
    expect(await runModule(evalIs("1; if(true){2;}", "2"))).toBe(1); // node: 2
  });

  it("an if that produces nothing yields undefined, not the inherited value", async () => {
    expect(await runModule(evalIs("1; if(false);", "undefined"))).toBe(1); // node: undefined
  });

  it("a labelled block does NOT reset — the inherited value survives", async () => {
    // The control for the reset LIST: `Block` and `LabelledStatement` thread `V`
    // (`UpdateEmpty(s, sl)`) and must not be in it. node: 1.
    expect(await runModule(evalIs("1; lbl: {}", "1"))).toBe(1);
  });

  it("a do-while still reports the last value-producing statement that ran", async () => {
    // The row the register was originally built for (`do-while/S12.6.1_A8`).
    // The `continue` inside an `if` now carries `undefined`, and the answer is
    // still the last `o++` to execute. node: 4.
    const run = runModule(evalIs("var c=0,o=0; do { c++; if (c%2) continue; o++; } while (c<10)", "4"));
    if (REFUSAL_TIER) return expectRefusalEscape(run);
    expect(await run).toBe(1);
  });
});

describe("#4515 wave-5 — §13 completion value spans the whole StatementList", () => {
  it("an EmptyStatement tail answers with the last value-producing statement", async () => {
    expect(await runModule(evalIs("2;;", "2"))).toBe(1); // node: 2 — base arm: undefined
  });

  it("a LexicalDeclaration tail answers with the last value-producing statement", async () => {
    expect(await runModule(evalIs("4; const t4515 = 5;", "4"))).toBe(1); // node: 4 — base arm: undefined
  });

  it("an ExpressionStatement tail still wins over everything before it", async () => {
    // The control for the fast path deliberately left in place.
    expect(await runModule(evalIs("1; 2; 3;", "3"))).toBe(1); // node: 3
  });
});

describe("#4515 wave-5 — a normally-completing `finally` contributes no value (§14.15.3 step 5)", () => {
  it("discards the finally block's own value", async () => {
    expect(await runModule(evalIs("4; try { } finally { 5; }", "undefined"))).toBe(1); // node: undefined
  });

  it("keeps the try block's value across the finally", async () => {
    expect(await runModule(evalIs("6; try { 7; } finally { 8; }", "7"))).toBe(1); // node: 7
  });

  it("an ABRUPT finally keeps its own value (step 7)", async () => {
    // The control for WHERE the restore is emitted: a `break` out of the finally
    // branches PAST the restore, so `V` keeps the finally's value. node: 3.
    expect(await runModule(evalIs("1; do { try { 2; } finally { 3; break; } } while(true)", "3"))).toBe(1);
  });
});

describe("#4515 wave-5 — `in` on a REASSIGNED binding asks the value, not the stale type", () => {
  it("finds a builtin's own property behind a comma-assignment", async () => {
    // §13.10.1 evaluates the LHS first, so `NUMBER` holds the real `Number`
    // constructor by the time the operator reads it — while TS still types the
    // binding `number | NumberConstructor` from its initializer. Base arm: 0.
    expect(await runModule(`var NUMBER = 0; var __r4515 = ((NUMBER = Number, "MAX_VALUE") in NUMBER) ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("still answers false for a key the value does not have", async () => {
    expect(await runModule(`var N2 = 0; var __r4515 = ((N2 = Number, "no_such_key_4515") in N2) ? 1 : 0;`)).toBe(0);
  });

  it("an ordinary (never-reassigned) receiver keeps its fold", async () => {
    expect(
      await runModule(`var N3 = Number; var __r4515 = (("MAX_VALUE" in N3) && !("no_such_key_4515" in N3)) ? 1 : 0;`),
    ).toBe(1);
  });
});

describe("#4515 wave-5 — measured residuals (owners named)", () => {
  // OWNER: the #2916 Slice B / #2660 M3 dynamic-instanceof substrate.
  // `__instanceof_dynamic` answers its documented conservative `false` here.
  // Measured on BOTH arms of this branch, and it is not an identifier-resolution
  // gap: `(function (v, C) { return v instanceof C; })(new U(), U)` is `false`
  // too, for a plain user constructor. The missing piece is the runtime
  // constructor→prototype edge, not this operator's RHS resolution.
  it.fails("instanceof with a comma-assigned builtin RHS (#2916 Slice B / #2660 M3)", async () => {
    expect(
      await runModule(`var OBJECT4515 = 0; var __r4515 = ((OBJECT4515 = Object, {}) instanceof OBJECT4515) ? 1 : 0;`),
    ).toBe(1);
  });

  // OWNER: #4491 T4. FIXED on `issue-4491-t4-parity` (`60f32935b`) after this
  // lane handed it back — **flip this to a passing pin when that lands here.**
  //
  // That is CONFIRMED, not predicted: dev-4491 copied this file into their
  // fixed worktree as a gitignored `tests/probe-*.test.ts` and ran it, and this
  // pin failed with exactly `Error: Expect test to fail`. Their run is also an
  // independent check of their fix on a shape they did not write — `runModule`
  // here uses `deferTopLevelInit: true, hostBridge: "always"` and a
  // module-level `var __r4515 = …`, neither of which their own pins use.
  //
  // Measured on THIS branch's tree (8794ab2c9 + this lane): `f1 + 1` is
  // "function () { [native code] }1" while `f1.toString() + 1` is
  // "function f1() { return 0; }1" (`language/expressions/addition/
  // S11.6.1_A2.2_T3`).
  //
  // Worth keeping when the pin flips: the asymmetry this lane reported —
  // `addOperandCallableSourceText` refuses on `fctx.localMap` while
  // `call-receiver-method.ts` reads the same `ctx.funcSourceText` unguarded —
  // was real but NOT sufficient. For this shape the helper is never called at
  // all: `binary-ops.ts` has two `+` object dispatches and `emitObjectAdd`
  // (`addition-to-primitive.ts`, #4564) wins, not `emitAnyAdd`
  // (`add-to-primitive.ts`). Fixing only the guard moved 0 of 128 rows.
  // CLOSED by #4491 T4 (`60f32935b`): `emitObjectAdd` now consults the shared
  // source-text helper per operand, and the guard became an oracle resolution
  // question. Flipped from `it.fails` to `it` at merge, as this pin's author
  // instructed — the cross-lane arm is that this suite's shape
  // (`deferTopLevelInit: true`, `hostBridge: "always"`, a module-level `var`)
  // is one the fixing lane's own pins never used.
  it("f + 1 must agree with f.toString() + 1 (#4491 T4)", async () => {
    expect(
      await runModule(`function f1x4515() { return 0; }
       var __r4515 = (f1x4515 + 1 === f1x4515.toString() + 1) ? 1 : 0;`),
    ).toBe(1);
  });

  // OWNER: #4491 (arguments-object property bag). `arguments.length` is not a
  // real writable/configurable own data property. Note the NUMBER-valued write
  // does stick — it is the STRING write and the descriptor that fail, which is
  // why the pin uses the census row's own spelling
  // (`language/arguments-object/S10.6_A5_T4`, `10.6-6-2`, `10.6-7-1`).
  it.fails("arguments.length is a writable own property (#4491)", async () => {
    expect(
      await runModule(`var str4515 = "something different";
       function fb4515() { arguments.length = str4515; return arguments; }
       var __r4515 = (fb4515().length === str4515) ? 1 : 0;`),
    ).toBe(1);
  });

  // OWNER: #4204 slot widening. An object literal types each property from its
  // own initializer, so a write of the other type is not representable: the read
  // back gives NaN from a number slot (and `undefined` from a string slot).
  // This is the root of `language/expressions/assignment/S8.12.5_A2` — whose
  // reported failure is a `__str_concat` null dereference in the assertion
  // MESSAGE, one step downstream of the wrong read.
  it.fails("a heterogeneous object literal accepts a cross-type write (#4204)", async () => {
    expect(
      await runModule(`var m4515 = { 1: "one", two: 2 }; m4515.two = "duo";
       var __r4515 = (m4515.two === "duo") ? 1 : 0;`),
    ).toBe(1);
  });

  // OWNER: #4204 slot widening. A hoisted `var` read before its initializer must
  // be `undefined`; a boolean-typed slot answers `false` (an f64 one answers
  // NaN — same convention). `language/types/boolean/S8.3_A1_T1`.
  it.fails("a hoisted var read before its initializer is undefined (#4204)", async () => {
    expect(await runModule(`var __r4515 = (xh4515 !== undefined) ? 0 : 1; var xh4515 = true;`)).toBe(1);
  });

  // OWNER: catch-clause scoping. The catch parameter is lowered to a plain
  // function local, so a reference AFTER the catch block resolves instead of
  // throwing a ReferenceError (`language/statements/try/12.14-7.js`).
  it.fails("the catch binding does not leak past its block", async () => {
    expect(
      await runModule(`var __r4515 = 0;
       try { throw { foo: 1 }; } catch (eo4515) { }
       try { eo4515; __r4515 = 0; } catch (e2) { __r4515 = (e2 instanceof ReferenceError) ? 1 : 0; }`),
    ).toBe(1);
  });
});
