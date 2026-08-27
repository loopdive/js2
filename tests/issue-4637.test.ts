// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4637) fnctor-prototype edge + Function-constructor surface, `--target standalone`.
//
// Four families, in the order the issue works them:
//
//   A1 — a FUNCTION VALUE in a `[[Prototype]]` slot. `$Object.$proto` is
//        `(ref null $Object)`, so `F.prototype = P; new F()` and
//        `Object.create(P)` both stored **null** for a callable `P`. Fixed by
//        canonicalizing a callable to its #3468 own-property bag `$Object` at
//        the proto-position choke points, with a reverse map so
//        `Object.getPrototypeOf` still answers the FUNCTION and never the
//        internal bag (`src/codegen/proto-function-value.ts` records the
//        decision and the rejected alternative).
//   A2 — §10.2.1.3 step 13: a constructor that `return`s a function. The
//        override already landed (`i === G`, `i.prop`); the checker's INSTANCE
//        shape was still trusted by `typeof` and by the non-callable call
//        guard, which turned a legal call into a hard TypeError.
//   A3 — §7.1.18 ToObject is the identity on objects, so `new Object(f)` IS
//        `f`: callable, `=== f`.
//   A4 — §20.2.4.2: a function's `prototype` is an OWN property, so
//        `f.hasOwnProperty("prototype")` must agree with `f.prototype`.
//
// Every case is a MODULE-scope program compiled with `deferTopLevelInit` —
// the shape the failing test262 rows have. No case mints a function from a
// body string, so this suite needs no eval-tier arm (it runs identically under
// `JS2WASM_EVAL_ENGINE=interpreter` with the REFUSAL provider).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

/**
 * Compile `pre` at MODULE scope plus `return <expr>` as the `test()` export and
 * run it host-free. Mirrors `tests/issue-4506.test.ts`'s harness.
 */
async function runModule(pre: string, expr: string): Promise<number> {
  const source = `${pre}\nexport function test() { return ${expr}; }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4637.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  // Host-free: a standalone module must instantiate against an empty import
  // object. If this ever needs a bridge, an arm leaked a host import.
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => number>;
  if (typeof exports.__module_init === "function") exports.__module_init();
  return exports.test!();
}

/**
 * Run a module through the test262 runtime-eval provider when the exact
 * assertion reads the bare `Function` intrinsic. The provider is required for
 * identity with that realm-owned value; no dynamic source evaluation is used.
 */
async function runLinkedModule(pre: string, expr: string): Promise<number> {
  const source = `${pre}\nexport function test() { return ${expr}; }`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4637-linked.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    { target: "standalone", providerLabel: "issue-4637" },
  );
  const exports = instance.exports as Record<string, () => number>;
  if (typeof exports.__module_init === "function") exports.__module_init();
  return exports.test!();
}

describe("#4637 A1 — a function value in the `.prototype` slot", () => {
  it("links the instance's [[Prototype]] to the function (S13.2.2_A1_T1)", async () => {
    // The row verbatim, reduced: `__PROTO` carries an own property, `__FACTORY`
    // takes it as its prototype, and the instance must both BE in its chain and
    // read through it.
    expect(
      await runModule(
        `function __PROTO(){}
         __PROTO.type = "monster";
         function __FACTORY(){}
         __FACTORY.prototype = __PROTO;
         var __monster = new __FACTORY();`,
        `(__PROTO.isPrototypeOf(__monster) ? 1 : 0) + (__monster.type === "monster" ? 2 : 0)`,
      ),
    ).toBe(3);
  });

  it("answers getPrototypeOf with the FUNCTION, not the internal bag", async () => {
    // The absent-not-wrong half. Without the reverse map this would answer the
    // proto-VIEW `$Object` — an object the program can never name — where the
    // base answered a merely-missing `null`.
    expect(
      await runModule(
        `function __PROTO(){}
         function __FACTORY(){}
         __FACTORY.prototype = __PROTO;
         var m = new __FACTORY();
         var p = Object.getPrototypeOf(m);`,
        `(p === __PROTO ? 1 : 0) + (__FACTORY.prototype === __PROTO ? 2 : 0)`,
      ),
    ).toBe(3);
  });

  it("carries instanceof through a function-valued prototype", async () => {
    // The MEASURED-flipping shape (`.tmp/p1.js`): base `8` — only
    // `__FACTORY.prototype === __PROTO` — after `31`, so `instanceof` is one of
    // the four bits this arm turns on. `S15.3.5.3_A3_T2`'s shape.
    //
    // The bare `function __PROTO(){} function __FACTORY(){}
    // __FACTORY.prototype = __PROTO; new __FACTORY() instanceof __FACTORY`
    // spelling is deliberately NOT used here: it already answers `true` on the
    // base (verified by running this suite against `81445abf7`), so pinning it
    // would have looked like a test of this change while asserting only
    // pre-existing behaviour. `instanceof` is escape-gate-shape-dependent, and
    // that is precisely why the pin has to use a shape whose flip was measured.
    expect(
      await runModule(
        `function __PROTO(){}
         __PROTO.type = "monster";
         function __FACTORY(){}
         __FACTORY.prototype = __PROTO;
         var __monster = new __FACTORY();`,
        `(__PROTO.isPrototypeOf(__monster) ? 1 : 0) + (__monster.type === "monster" ? 2 : 0) +
         (Object.getPrototypeOf(__monster) === __PROTO ? 4 : 0) +
         (__FACTORY.prototype === __PROTO ? 8 : 0) +
         (__monster instanceof __FACTORY ? 16 : 0)`,
      ),
    ).toBe(31);
  });

  it("REGRESSION GUARD (green on base): plain instanceof on a fnctor instance", async () => {
    // Companion to the case above and labelled for what it is. This shape
    // answers `true` on the base too, so it proves nothing about the fix — it
    // exists so the A1 arm cannot QUIETLY BREAK an `instanceof` that already
    // worked, which is a distinct and real risk given the arm changes what sits
    // in the `$proto` slot.
    expect(
      await runModule(
        `function __PROTO(){}
         function __FACTORY(){}
         __FACTORY.prototype = __PROTO;
         var m = new __FACTORY();`,
        `m instanceof __FACTORY ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("serves Object.create(<function>) through the same choke point", async () => {
    // `__object_create` is the single place both spellings converge, which is
    // why one arm fixes `new F()` and `Object.create(f)` together.
    expect(
      await runModule(
        `function P(){}
         P.type = "monster";
         var o = Object.create(P);`,
        `(o.type === "monster" ? 1 : 0) + (Object.getPrototypeOf(o) === P ? 2 : 0) + (P.isPrototypeOf(o) ? 4 : 0)`,
      ),
    ).toBe(7);
  });

  it("leaves an ordinary object prototype untouched", async () => {
    // The negative: a plain `$Object` proto is not in the reverse map, so
    // `getPrototypeOf` maps it to itself and `Object.create(null)` still
    // answers null.
    expect(
      await runModule(
        `var base = {q: 7};
         var o = Object.create(base);
         var n = Object.create(null);`,
        `(Object.getPrototypeOf(o) === base ? 1 : 0) + (o.q === 7 ? 2 : 0) + (Object.getPrototypeOf(n) === null ? 4 : 0)`,
      ),
    ).toBe(7);
  });

  it("does not report a function as the prototype of an unrelated object", async () => {
    // PURE negative control — asserts ONLY the false-positive direction, so it
    // is green on the base as well as after. It was previously bundled with the
    // positive half (`P.isPrototypeOf(o)`), which made the whole case fail on
    // the base and meant the no-false-positive property was never independently
    // exercised: a build that answered `true` for BOTH would have failed the
    // bundled assertion for the right total and the wrong reason. The positive
    // half is covered by the `Object.create(<function>)` case above.
    expect(
      await runModule(
        `function P(){}
         var o = Object.create(P);
         var other = {};`,
        `P.isPrototypeOf(other) ? 1 : 0`,
      ),
    ).toBe(0);
  });

  it("A1 holds at an ARG-BEARING site (NOT a C1 canary — see the case below)", async () => {
    // Added as `CANARY (dev-4639 C1 x A1)` and RENAMED after measuring what it
    // is actually sensitive to. It IS a real test of the A1 arm at a site that
    // also has a `new` argument (`.tmp/p20.js`, standalone: base `33` → after
    // `63`, the four flipping bits being `instanceof`, `isPrototypeOf`, the
    // inherited read and `getPrototypeOf` identity).
    //
    // It is NOT sensitive to dev-4639's C1 lever, and that was measurable
    // without their branch: delete the `var h = new H(g);` line and the answer
    // is still `63` (`.tmp/p21.js`). So the NewExpression-ARGUMENT position is
    // not what drives the reconstruction here — the other dynamic uses
    // (`isPrototypeOf`, `getPrototypeOf`, the property read) already classify
    // `g` as dynamic without C1's widening. A pin whose named interaction can
    // be deleted without changing its answer is not a canary for it.
    //
    // This is the same blindness dev-4639 found in their own C2 canary, one
    // round after we both articulated the rule — reverting shows a pin is
    // sensitive to YOUR change and says nothing about whether it is sensitive
    // to THEIRS.
    expect(
      await runModule(
        `function P(){}
         P.type = "monster";
         function G(){}
         G.prototype = P;
         function H(x){ this.wrapped = x; }
         var g = new G();
         var h = new H(g);`,
        `(G.prototype === P ? 1 : 0) + (g instanceof G ? 2 : 0) + (P.isPrototypeOf(g) ? 4 : 0) +
         (g.type === "monster" ? 8 : 0) + (Object.getPrototypeOf(g) === P ? 16 : 0) +
         (h.wrapped === g ? 32 : 0)`,
      ),
    ).toBe(63);
  });

  // (#4643, 2026-08-23) THE PREDICTION RESOLVED — and its own instruction was
  // "if it reaches 31, delete the `it.fails` and keep it as an ordinary pin".
  // Measured 31 on `issue-4643`, so the `it.fails` is gone.
  //
  // It resolved at 31 only after a SECOND defect was fixed, which is the part
  // worth carrying forward: C1 + A1 composed give bits 1|2|8 (classification,
  // instanceof, and — once the callable store is canonicalized — the inherited
  // read). Bits 4|16 (`isPrototypeOf`, `getPrototypeOf`) were NOT an A1 question
  // at all: `__isPrototypeOf`/`__getPrototypeOf` had no chain start for a
  // `__fnctor_<F>` INSTANCE STRUCT, so they answered false/null for every such
  // instance regardless of what its prototype was — measured on an
  // object-valued prototype too (see `tests/issue-4643.test.ts`'s `OBJ` pins).
  // The composition question and the chain-start question looked like one row
  // because both surfaced on the same shape.
  it("CROSS-LANE PREDICTION RESOLVED (dev-4639 C1 x A1 x #4643): arg-position-ONLY instance", async () => {
    // The shape where C1's lever actually acts: `new G()` appears ONLY as a
    // `new` ARGUMENT, and every read goes through `h.wrapped`, so no other
    // dynamic use of the instance can classify it. Measured `.tmp/p22.js`,
    // standalone, BOTH arms: `2` — only `instanceof` holds, the A1 arm does not
    // fire, because the site never reconstructs. Base and branch agree, which is
    // exactly why it belongs here as a PREDICTION rather than as a result.
    //
    // The prediction, stated so it is falsifiable — and now decomposed into two
    // SEPARATELY OBSERVABLE halves, because dev-4639 measured the first one on
    // their branch (their run, not this agent's):
    //
    //   bit 1  `G.prototype === P`   — C1 ALONE fixes this. Measured by
    //          dev-4639 on `issue-4639`: false on the tip, true on their branch,
    //          and back to false with ONLY `fnctor-escape-gate.ts` reverted.
    //   bit 2  `instanceof`          — already true on both arms here.
    //   bits 4|8|16  `isPrototypeOf`, the inherited read, `getPrototypeOf`
    //          — these need the A1 arm in THIS branch to fire at the site C1
    //          newly classifies. Nobody has observed them yet.
    //
    // So the sharpened prediction: C1 alone should take this shape from `2` to
    // `3`; C1 + A1 composed should take it to `31`. **If both land and this pin
    // sits at 3 rather than 31, the halves did not compose — the site got
    // classified but the A1 arm did not link its function-valued prototype, and
    // THAT is the finding.** If it reaches 31, delete the `it.fails` and keep it
    // as an ordinary pin.
    //
    // NOT diagnosed, and deliberately not guessed at: `G.prototype === P` also
    // reads false in this shape, which the other A1 cases do not. It is
    // recorded because it is measured, not explained.
    //
    // It is however PRE-EXISTING, not introduced here — `.tmp/p23.js` isolates
    // it against two controls and measures base `11` = after `11`:
    //   bare, `function P(){}`        → `G.prototype === P` true  (both arms)
    //   bare, `var P = function(){}`  → true  (both arms)
    //   this arg-only shape           → FALSE (both arms)
    // So it is a property of the arg-only instantiation shape, not of
    // function-valued prototypes and not of declaration-vs-expression.
    // dev-4639 read it as "introduced by your branch" from a RECONSTRUCTED
    // version of this shape; the A/B above is the direct measurement and
    // supersedes that inference. They then measured the THIRD state neither
    // arm-pair could represent: pre-existing on the tip AND **fixed by C1**
    // (their run — tip false, `issue-4639` true, false again with only
    // `fnctor-escape-gate.ts` reverted). Both readings are correct; "pre-existing
    // AND fixed by the other lane" is simply not expressible in a tip-vs-own-
    // branch A/B, which is the blind spot, not either measurement.
    expect(
      await runModule(
        `function P(){}
         P.type = "monster";
         function G(){}
         G.prototype = P;
         function H(x){ this.wrapped = x; }
         var h = new H(new G());
         var w = h.wrapped;`,
        `(G.prototype === P ? 1 : 0) + (w instanceof G ? 2 : 0) + (P.isPrototypeOf(w) ? 4 : 0) +
         (w.type === "monster" ? 8 : 0) + (Object.getPrototypeOf(w) === P ? 16 : 0)`,
      ),
    ).toBe(31);
  });
});

describe("#4637 A2 — §10.2.1.3 step 13, a constructor that returns a function", () => {
  it("makes the returned function the construction result, callable (S13.2.2_A8_T1)", async () => {
    expect(
      await runModule(
        `function G(arg){ return arg + 1; }
         var F = function(a,b){ this.first=a; G.prop=b; return G; };
         var i = new F("one","two");`,
        `(i === G ? 1 : 0) + (typeof i === "function" ? 2 : 0) + (i.prop === "two" ? 4 : 0) +
         (i.first === undefined ? 8 : 0) + (i(1) === 2 ? 16 : 0)`,
      ),
    ).toBe(31);
  });

  it("still throws on a construction result that is genuinely not callable", async () => {
    // The negative that `language/expressions/call/S11.2.3_A4_*` needs: the
    // #4221 guard must keep firing for a constructor with no foreign return.
    expect(
      await runModule(
        `var threw = 0;
         function Plain(){ this.x = 1; }
         var p = new Plain();
         try { p(); } catch (e) { threw = 1; }`,
        `threw`,
      ),
    ).toBe(1);
  });
});

describe("#4637 A3 — Object(f) / new Object(f) identity", () => {
  it("returns the SAME function, callable (S15.2.2.1_A2_T2 / _A2_T6)", async () => {
    expect(
      await runModule(
        `var func = function(){ return 1; };
         var n_obj = new Object(func);
         var o2 = Object(func);`,
        `(n_obj === func ? 1 : 0) + (n_obj() === 1 ? 2 : 0) + (o2 === func ? 4 : 0) + (o2() === 1 ? 8 : 0)`,
      ),
    ).toBe(15);
  });

  it("keeps ToObject of a primitive non-callable", async () => {
    expect(
      await runModule(
        `var a = 0, b = 0;
         try { (new Object(42))(); } catch (e) { a = 1; }
         try { (new Object())(); } catch (e) { b = 1; }`,
        `a + b * 2`,
      ),
    ).toBe(3);
  });
});

describe("#4637 A4 — a function's `prototype` is an OWN property (§20.2.4.2)", () => {
  it("agrees with the value read", async () => {
    expect(
      await runModule(
        `function f(){}`,
        `(f.hasOwnProperty("prototype") ? 1 : 0) + (typeof f.prototype === "object" ? 2 : 0)`,
      ),
    ).toBe(3);
  });

  it("does not claim `prototype` for a plain object or an array", async () => {
    expect(
      await runModule(
        `var o = {};
         var arr = [1,2];`,
        `(o.hasOwnProperty("prototype") ? 1 : 0) + (arr.hasOwnProperty("prototype") ? 2 : 0)`,
      ),
    ).toBe(0);
  });
});

describe("#4637 — measured residuals (see the issue's Residuals table for owners)", () => {
  it("new Object(<Date>) keeps the receiver's method dispatch (S15.2.2.1_A2_T5)", async () => {
    // ToObject returns an object argument unchanged. The native Date method
    // arm must therefore see the preserved Date receiver despite TypeScript's
    // broad `Object` type for the constructor expression.
    expect(
      await runModule(
        `var obj = new Date(1978, 3);
         var n_obj = new Object(obj);`,
        `n_obj.getFullYear() === 1978 ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("a function value's `.constructor` is %Function% (S15.2.1.1_A2_T11 / _A2_T7)", async () => {
    expect(
      await runLinkedModule(
        `var call_obj = Object(function call_func(){ return 1; });
         var new_obj = new Object(function new_func(){ return 2; });`,
        `(call_obj.constructor === Function ? 1 : 0) + (new_obj.constructor === Function ? 2 : 0)`,
      ),
    ).toBe(3);
  });

  it("keeps ordinary and primitive Object results on their existing constructor paths", async () => {
    expect(
      await runModule(
        `var plain_obj = new Object({});
         var number_obj = Object(42);`,
        `(plain_obj.constructor === Object ? 1 : 0) + (number_obj.constructor === Number ? 2 : 0)`,
      ),
    ).toBe(3);
  });

  it.fails("obj.call resolves through a %Function.prototype% prototype (S15.3.4.4_A1_T2)", async () => {
    // Same missing materialization, reached from the other side.
    expect(
      await runModule(
        `function FACTORY(){}
         FACTORY.prototype = Function.prototype;
         var obj = new FACTORY;`,
        `typeof obj.call === "function" ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it("an `undefined`-initialized var can hold an object (preventExtensions/15.2.3.10-2)", async () => {
    // NOT a `preventExtensions` bug: `Object.preventExtensions(o) === o` holds
    // and `var b; b = Object.preventExtensions(o)` works. `var a = undefined`
    // types the SLOT from the initializer, so the later object write is lost.
    // Belongs to the module-global slot typer, not to this issue.
    expect(
      await runModule(
        `var o = {};
         var a = undefined;
         a = o;`,
        `a === o ? 1 : 0`,
      ),
    ).toBe(1);
  });
});
