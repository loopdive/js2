// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4656) Three ES5 standalone defects plus four Function call/apply rows
// fixed, and the measured residuals whose roots this lane corrected rather
// than inherited.
//
// TWO of those residuals were written here as CONTROLS and demoted after
// measurement showed them failing on BOTH arms — recorded rather than quietly
// deleted, because the correction is the finding: `%Function.prototype%.call`
// through an opaque RECEIVER and `%Object.prototype%.toString` through a
// function-valued prototype are the same miss as R1, reached from two other
// directions. A control that has never been run on the base arm is a label,
// not evidence.
//
// FIXED
//   1. An equality whose operand is a VOID-typed call was not compared at all.
//      `compileBinaryExpression` bailed out, the caller ROLLED BACK the operand
//      code and substituted `i32.const 0`, so `f() === u` and `f() !== u` both
//      answered `false` AND `f`'s call disappeared (§13.11.1 evaluates both
//      operands). Fixed in `equality-void-operand.ts` by materialising the
//      canonical `undefined` for the void side and continuing into the ordinary
//      typed dispatch. Row: `language/types/undefined/S8.1_A2_T2.js`.
//   2. `recv.k(…)` where `k` resolves to a PRIMITIVE silently answered
//      `undefined` instead of throwing TypeError. #4221 shipped only the
//      resolved-callee-is-NULL half and declined the rest because a negative
//      callable test can misfire; a POSITIVE primitive brand cannot. Fixed in
//      `resolved-callee-guard.ts`. Row:
//      `language/expressions/call/11.2.3-3_4.js`.
//   3. `o.bar.gar(foo())` threw the RIGHT TypeError at the WRONG time: every
//      guard we had lived inside a CALLEE, and a callee cannot see its
//      arguments un-evaluated. §13.3.6.1 evaluates the callee reference first,
//      so the same predicate is now emitted at the call site, where the
//      receiver is already in a local and the argument list is not yet
//      compiled. Fixed in `closed-method-dispatch.ts`
//      (`buildCallSiteNullishReceiverGuard`) + `call-receiver-method.ts`. Row:
//      `language/expressions/call/11.2.3-3_3.js`.
//   4. Constant standalone Function bodies invoked through `.call`/`.apply`
//      now retain the explicit receiver and materialized argument vector. The
//      foreign body uses dynamic property access and reserved fnctor layouts
//      retain expandos. Rows: Function call/apply A5/A6; A7/A8 remain residuals.
//
// RESIDUALS are `it.fails` and each carries POSITIVE CONTROLS chosen so the
// suite claims the SPECIFIC root, not the general area (brief methodology 8).
// The most important one is R1: #4643 recorded the `built-ins/Function/
// prototype/{apply,call}/…_A1_T*` residual as "#4637's prototype bag has a null
// `$proto`, so the chain never reaches %Function.prototype%". Measured here,
// that attribution is wrong in a way that changes who owns it. A builtin
// prototype's members are reachable ONLY through the #4481 compile-time fold,
// which needs a statically branded receiver AND a literal key; the runtime has
// no table in which they are values. Three independent shapes all miss:
// opaque KEY on a plain function (R1), opaque RECEIVER on a plain function
// (the demoted F2 row), and literal key on a dynamically-typed receiver
// (R2, and %Object.prototype% too). So this is the builtin-as-value family
// (#4480/#4481/#4483, dev-4515's C1), not a prototype-link gap.
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
import { runTest262File } from "./test262-runner.js";

/**
 * CI's changed-root `quality` lane runs `JS2WASM_EVAL_ENGINE=interpreter` with
 * the REFUSAL provider: a module that mints from a body string throws there by
 * design. MEASURED: no pin in this file mints — see the tier block at the
 * bottom — so this only labels the run, it does not gate anything.
 */
const REFUSAL_TIER = process.env.JS2WASM_EVAL_ENGINE === "interpreter";

async function run(body: string): Promise<number> {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4656.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(result.binary, {}, { target: "standalone", providerLabel: "#4656" });
  return (instance.exports as { test(): number }).test();
}

describe("#4656 F1 — a VOID-typed equality operand is compared, not folded away", () => {
  // Verified to FAIL on the campaign base by file-copy revert of
  // `equality-void-operand.ts` + `binary-ops.ts`: base answers 0.
  it("`v0() === void 0` is true (base: false)", async () => {
    expect(
      await run(`
        function v0() {}
        return (v0() === void 0) ? 1 : 0;
      `),
    ).toBe(1);
  });

  // Base answered `false` here TOO, which is the tell: `===` and `!==` cannot
  // both be false. Pinned as its own row so a future regression that fixes one
  // and breaks the other cannot read as green.
  it("`v0() !== void 0` is false (base: false, but for the wrong reason)", async () => {
    expect(
      await run(`
        function v0() {}
        return (v0() !== void 0) ? 1 : 0;
      `),
    ).toBe(0);
  });

  it("a void-typed operand compares against a value-producing `any` (base: false)", async () => {
    expect(
      await run(`
        function v0() {}
        var u;
        return (v0() === u) ? 1 : 0;
      `),
    ).toBe(1);
  });

  // §13.11.1 evaluates BOTH operands. The base rollback discarded the emitted
  // call with the code it rolled back, so three of these four never ran.
  it("all four void-operand comparisons EVALUATE their operand (base: 1 of 4)", async () => {
    expect(
      await run(`
        var calls = 0;
        function bump() { calls = calls + 1; }
        var u;
        var r1 = (bump() === u);
        var r2 = (bump() !== u);
        var r3 = (u === bump());
        var r4 = (bump() == null);
        return calls;
      `),
    ).toBe(4);
  });

  // ── localisation controls: these pass on BOTH arms ───────────────────────
  it("CONTROL the bare `undefined` IDENTIFIER spelling was already right", async () => {
    expect(
      await run(`
        function v0() {}
        return (v0() === undefined) ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("CONTROL a DECIDABLE void-vs-number equality still folds to false", async () => {
    expect(
      await run(`
        function n1() { return 1; }
        return (n1() === void 0) ? 1 : 0;
      `),
    ).toBe(0);
  });

  it("CONTROL a decidable fold still evaluates both operands", async () => {
    expect(
      await run(`
        var calls = 0;
        function bump() { calls = calls + 1; }
        var s = "x";
        var a = (bump() === s);
        var b = (bump() !== 1);
        return calls;
      `),
    ).toBe(2);
  });
});

describe("#4656 F2 — calling a resolved callee that BRANDS as a primitive is a TypeError", () => {
  // `language/expressions/call/11.2.3-3_4.js`. Verified to FAIL on base by
  // file-copy revert of `object-runtime.ts` (base: no throw at all — the getter
  // ran, the argument evaluated, the call answered undefined).
  it("an ACCESSOR whose getter returns 42, then called, throws (base: no throw)", async () => {
    expect(
      await run(`
        var fooCalled = 0;
        function foo() { fooCalled = 1; return 0; }
        var o: any = {};
        Object.defineProperty(o, "bar", {
          get: function () { return 42; },
          set: function (x: any) {},
        });
        var threw = 0;
        try { o.bar(foo()); } catch (e) { threw = (e instanceof TypeError) ? 2 : 1; }
        return threw * 10 + fooCalled;
      `),
    ).toBe(21);
  });

  it("a plain data property holding a STRING, then called, throws", async () => {
    expect(
      await run(`
        var o: any = { k: "s" };
        var threw = 0;
        try { o.k(1); } catch (e) { threw = (e instanceof TypeError) ? 2 : 1; }
        return threw;
      `),
    ).toBe(2);
  });

  it("a plain data property holding a BOOLEAN, then called, throws", async () => {
    expect(
      await run(`
        var o: any = { k: true };
        var threw = 0;
        try { o.k(1); } catch (e) { threw = (e instanceof TypeError) ? 2 : 1; }
        return threw;
      `),
    ).toBe(2);
  });

  // ── the guard must not over-throw: these pass on BOTH arms ───────────────
  it("CONTROL an ordinary method call still runs", async () => {
    expect(
      await run(`
        var o: any = { k: function (n: number) { return n + 40; } };
        return o.k(2);
      `),
    ).toBe(42);
  });

  // MEASURED CORRECTION (this was written as a CONTROL and is not one — it
  // fails on BOTH arms, so it pins a third residual, not a guard against
  // over-throwing). It is R1's shape reached from the other side: an opaque
  // RECEIVER instead of an opaque KEY. `box[i].call(...)` cannot see
  // `%Function.prototype%.call` because the #4481 fold needs a statically
  // branded receiver, and nothing answers it at runtime. Same owner as R1.
  it.fails("RESIDUAL %Function.prototype%.call/.apply through an OPAQUE receiver", async () => {
    expect(
      await run(`
        function add(this: any, a: number, b: number) { return a + b; }
        var box: any[] = [add];
        var i = 0;
        for (var n = 0; n < 1; n++) { i = i + 0; }
        var viaCall = box[i].call(null, 1, 2);
        var viaApply = box[i].apply(null, [3, 4]);
        return viaCall * 100 + viaApply;
      `),
    ).toBe(307);
  });

  it("CONTROL an ACCESSOR whose getter returns a FUNCTION is still callable", async () => {
    expect(
      await run(`
        var o: any = {};
        Object.defineProperty(o, "bar", { get: function () { return function () { return 7; }; } });
        return o.bar();
      `),
    ).toBe(7);
  });
});

describe("#4656 A — standalone Function call/apply preserves an explicit thisArg", () => {
  it("call boxes a number primitive before running a dynamic Function body", async () => {
    expect(
      await run(`
        var obj = 1;
        var ret = Function("this.touched = true; return this;").call(obj);
        return typeof obj.touched === "undefined" && ret.touched ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("call boxes a boolean primitive before running a dynamic Function body", async () => {
    expect(
      await run(`
        var obj = true;
        var ret = new Function("this.touched = true; return this;").call(obj);
        return typeof obj.touched === "undefined" && ret.touched ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("apply boxes a number primitive before running a dynamic Function body", async () => {
    expect(
      await run(`
        var obj = 1;
        var ret = Function("this.touched = true; return this;").apply(obj);
        return typeof obj.touched === "undefined" && ret.touched ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("apply boxes a boolean primitive before running a dynamic Function body", async () => {
    expect(
      await run(`
        var obj = true;
        var ret = new Function("this.touched = true; return this;").apply(obj);
        return typeof obj.touched === "undefined" && ret.touched ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("call writes an expando on a Function() receiver", async () => {
    expect(
      await run(`
        var obj: any = Function();
        Function("this.touched = true; return this;").call(obj);
        return obj.touched ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("apply writes an expando on a Function() receiver", async () => {
    expect(
      await run(`
        var obj: any = Function();
        Function("this.touched = true; return this;").apply(obj);
        return obj.touched ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("apply forwards the FACTORY arguments object to a standalone Function", async () => {
    expect(
      await run(`
        function FACTORY() {
          Function("a1,a2,a3", "this.shifted = a1 + a2 + a3;").apply(this, arguments);
        }
        var obj: any = new (FACTORY as any)("", 4, 2);
        return obj.shifted === "42" ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("call forwards an arguments object and trailing values", async () => {
    expect(
      await run(`
        function FACTORY() {
          Function("a1,a2,a3", "this.shifted = a1.length + a2 + a3;").call(this, arguments, "", 2);
        }
        var obj: any = new (FACTORY as any)("", 4, 2, "A");
        return obj.shifted === "42" ? 1 : 0;
      `),
    ).toBe(1);
  });
});

describe("#4656 R1 — %Function.prototype% members are not reachable as a dynamic VALUE", () => {
  // The correction to #4643's residual attribution. `f.apply` answers
  // "function" only through the compile-time fold on a LITERAL key; with an
  // opaque key it is `undefined` — on a plain function, with no prototype
  // chain involved. Owner: the builtin-as-value family (dev-4515's C1).
  it.fails("RESIDUAL an OPAQUE-key read of `apply` on a plain function is undefined", async () => {
    expect(
      await run(`
        function target(a: number, b: number) { return 1; }
        var KEYS = ["zzz", "apply"];
        var i = 0;
        for (var n = 0; n < 1; n++) { i = i + 1; }
        return (typeof (target as any)[KEYS[i]] === "function") ? 1 : 0;
      `),
    ).toBe(1);
  });

  it("CONTROL the LITERAL-key spelling of the same read answers `function`", async () => {
    expect(
      await run(`
        function target(a: number, b: number) { return 1; }
        return (typeof target.apply === "function") ? 1 : 0;
      `),
    ).toBe(1);
  });

  // This is the control that makes R1 claim the SPECIFIC root: the opaque-key
  // READ PATH itself works on the same receiver, so the miss is about
  // %Function.prototype% membership, not about key opacity.
  it("CONTROL an OPAQUE-key read of an OWN property on the same function works", async () => {
    expect(
      await run(`
        function target(a: number, b: number) { return 1; }
        (target as any).own = 5;
        var KEYS = ["zzz", "own"];
        var i = 0;
        for (var n = 0; n < 1; n++) { i = i + 1; }
        return (target as any)[KEYS[i]];
      `),
    ).toBe(5);
  });
});

/**
 * MEASURED CORRECTION — R2 was gated `skipIf(REFUSAL_TIER)` on the assumption
 * that `Function()` MINTS from a body string and would therefore throw under
 * the refusal provider (where a throw makes an `it.fails` pass for the wrong
 * reason — brief methodology 8). It does not: an ARGUMENT-LESS `Function()` is
 * AOT-synthesized by #2924 and never reaches the provider at all. Pinned by
 * running the block on `JS2WASM_EVAL_ENGINE=interpreter` and watching it
 * answer `0`, identically to the quickjs tier, instead of rejecting. The
 * aggregate ES5 branch now supplies the missing builtin prototype values, so
 * the same probe correctly answers `1` on both tiers.
 *
 * So this file has NO tier-sensitive pin and needs no tier arm — every one of
 * its 36 tests executes on both tiers. Recorded rather than deleted because
 * "does this snippet mint?" is not answerable by looking at it; the compiler
 * decides, and here it declines.
 */
describe("#4656 R2 — a function-valued prototype carries its builtin prototype chain", () => {
  it("`FACTORY.prototype = Function()` exposes %Function.prototype%.apply", async () => {
    expect(
      await run(`
        var P: any = Function();
        P.own = "OWN";
        function FACTORY() {}
        (FACTORY as any).prototype = P;
        var inst: any = new (FACTORY as any)();
        return (typeof inst.apply === "function") ? 1 : 0;
      `),
    ).toBe(1);
  });

  // Controls: the prototype LINK itself works, and the Object.prototype
  // companion is reachable through it. So R2's miss is R1's miss, reached one
  // link further out — not a broken link.
  it("CONTROL an OWN property of the function-valued prototype reads through", async () => {
    expect(
      await run(`
        var P: any = Function();
        P.own = 5;
        function FACTORY() {}
        (FACTORY as any).prototype = P;
        var inst: any = new (FACTORY as any)();
        return inst.own;
      `),
    ).toBe(5);
  });

  // The aggregate implementation also carries the next builtin link through
  // to %Object.prototype%, matching ordinary JavaScript prototype lookup.
  it("%Object.prototype%.toString is reachable through the same link", async () => {
    expect(
      await run(`
        var P: any = Function();
        function FACTORY() {}
        (FACTORY as any).prototype = P;
        var inst: any = new (FACTORY as any)();
        return (typeof inst.toString === "function") ? 1 : 0;
      `),
    ).toBe(1);
  });
});

describe("#4656 tier — an argument-less `Function()` does NOT reach the eval provider", () => {
  // The pin that carries the correction above. It asserts the SAME answer on
  // both tiers, so it fails the moment `Function()` starts routing through the
  // provider — which is exactly when R2 would need a tier arm again.
  it(`answers identically under ${REFUSAL_TIER ? "the REFUSAL provider" : "quickjs"}`, async () => {
    expect(
      await run(`
        var P: any = Function();
        function FACTORY() {}
        (FACTORY as any).prototype = P;
        var inst: any = new (FACTORY as any)();
        return (typeof inst.apply === "function") ? 1 : 0;
      `),
    ).toBe(1);
  });
});

describe("#4656 F3 — the callee-reference TypeError precedes argument evaluation", () => {
  // `language/expressions/call/11.2.3-3_3.js`: `o.bar.gar(foo())` must throw
  // while EVALUATING `o.bar.gar`, so `foo()` never runs. Base threw the RIGHT
  // error at the WRONG time (`fooCalled` was 1). Verified to fail on base by
  // file-copy revert of `closed-method-dispatch.ts` + `call-receiver-method.ts`.
  it("`o.bar.gar(foo())` must not evaluate `foo()` (base: it did)", async () => {
    expect(
      await run(`
        var fooCalled = 0;
        function foo() { fooCalled = 1; return 0; }
        var o: any = {};
        try { o.bar.gar(foo()); } catch (e) {}
        return fooCalled;
      `),
    ).toBe(0);
  });

  it("the TypeError itself is still thrown (passes on BOTH arms)", async () => {
    expect(
      await run(`
        function foo() { return 0; }
        var o: any = {};
        var threw = 0;
        try { o.bar.gar(foo()); } catch (e) { threw = (e instanceof TypeError) ? 2 : 1; }
        return threw;
      `),
    ).toBe(2);
  });

  // The guard must not over-throw. `undefined` here is a RECEIVER that is
  // nullish, which is the only predicate the guard tests — a live receiver
  // whose method is merely absent keeps its pre-existing answer, and a live
  // receiver with a real method still calls it.
  it("CONTROL a live receiver's method still runs, and its arguments still evaluate", async () => {
    expect(
      await run(`
        var calls = 0;
        function bump() { calls = calls + 1; return 2; }
        var o: any = { k: function (n: number) { return n + 40; } };
        var v = o.k(bump());
        return v * 10 + calls;
      `),
    ).toBe(421);
  });

  it("CONTROL a nullish receiver reached through a LOOP-carried value still throws", async () => {
    expect(
      await run(`
        var box: any[] = [{ k: function () { return 1; } }, undefined];
        var i = 0;
        for (var n = 0; n < 1; n++) { i = i + 1; }
        var threw = 0;
        try { box[i].k(); } catch (e) { threw = (e instanceof TypeError) ? 2 : 1; }
        return threw;
      `),
    ).toBe(2);
  });
});

describe("#4656 R4 — a function declaration does not override a same-named PARAMETER", () => {
  // §10.2.11 FunctionDeclarationInstantiation instantiates function
  // declarations AFTER the formal parameters, so the declaration wins.
  // `language/function-code/S10.2.1_A4_T1.js` check #2.
  it.fails("RESIDUAL `function f(x){ return typeof x; function x(){} }` must be `function`", async () => {
    expect(
      await run(`
        function f(x?: any) {
          return typeof x === "function" ? 1 : 0;
          function x() { return 7; }
        }
        return f();
      `),
    ).toBe(1);
  });

  // The two controls that isolate it to PARAMETERS: the same collision against
  // a `var` and against `arguments` already resolves the spec way, so the
  // hoist itself is not broken.
  it("CONTROL the same collision against a `var` DOES override", async () => {
    expect(
      await run(`
        function f() {
          var x: any;
          return typeof x === "function" ? 1 : 0;
          function x() { return 7; }
        }
        return f();
      `),
    ).toBe(1);
  });

  it("CONTROL an inner declaration with a NON-colliding name is hoisted", async () => {
    expect(
      await run(`
        function f(y?: any) {
          return typeof z === "function" ? 1 : 0;
          function z() { return 7; }
        }
        return f();
      `),
    ).toBe(1);
  });
});

// ───────────────────── Function.bind residual cluster ─────────────────────
// These are the exact standalone Test262 rows owned by the bind lane. The
// controls below exercise both direct and indirect bind for an ordinary user
// function, so a constructor-only arm cannot silently regress closure binding.
const BIND_TEST262_ROOT = join(__dirname, "..", "test262");
const BIND_TEST262 = existsSync(join(BIND_TEST262_ROOT, "harness", "assert.js"));
const BIND_CONTROL_DIR = join(__dirname, "..", ".tmp", "issue-4656-bind-controls");

function pinBindRow(rel: string, note: string): void {
  it.skipIf(!BIND_TEST262)(rel, { timeout: 60_000 }, async () => {
    const result = await runTest262File(join(BIND_TEST262_ROOT, "test", rel), "issue-4656-bind", 30_000, "standalone");
    expect(`${result.status}: ${result.error ?? ""}`, note).toBe("pass: ");
  });
}

function pinBindSource(name: string, source: string, note: string): void {
  it.skipIf(!BIND_TEST262)(name, { timeout: 60_000 }, async () => {
    mkdirSync(BIND_CONTROL_DIR, { recursive: true });
    const path = join(BIND_CONTROL_DIR, `${name}.js`);
    writeFileSync(path, source);
    const result = await runTest262File(path, "issue-4656-bind", 30_000, "standalone");
    expect(`${result.status}: ${result.error ?? ""}`, note).toBe("pass: ");
  });
}

describe("#4656 — Function.prototype.bind standalone residuals", () => {
  pinBindRow(
    "built-ins/Function/prototype/bind/15.3.4.5-2-6.js",
    "Object.bind(null)(42) must return the boxed argument",
  );
  pinBindRow(
    "built-ins/Function/prototype/bind/15.3.4.5-2-8.js",
    "Array.bind(null)(42) must preserve Array length and indexed writes",
  );
  pinBindRow(
    "built-ins/Function/prototype/bind/S15.3.4.5_A5.js",
    "bind.apply(Date, [null].concat(args)) must curry [[Construct]]",
  );

  pinBindSource(
    "ordinary-direct-bind",
    `
      function add(a, b) { return this.base + a + b; }
      var bound = add.bind({ base: 1 }, 2);
      assert.sameValue(bound(3), 6);
    `,
    "direct bind must preserve its receiver and partial argument",
  );

  pinBindSource(
    "ordinary-indirect-bind-apply",
    `
      function add(a, b) { return a + b; }
      var args = [2];
      var bound = Function.prototype.bind.apply(add, [null].concat(args));
      assert.sameValue(bound(3), 5);
    `,
    "indirect bind.apply must preserve partial arguments for an ordinary function",
  );
});
