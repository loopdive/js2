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
    expect(
      await runModule(
        `function P(){}
         var o = Object.create(P);
         var other = {};`,
        `(P.isPrototypeOf(other) ? 1 : 0) + (P.isPrototypeOf(o) ? 2 : 0)`,
      ),
    ).toBe(2);
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
  it.fails("new Object(<Date>) keeps the receiver's method dispatch (S15.2.2.1_A2_T5)", async () => {
    // Identity holds; the checker types the expression `Object`, so
    // `n_obj.getFullYear` does not dispatch. Needs `Object(x)`'s STATIC type to
    // follow the argument — outside this issue's proto-representation scope.
    expect(
      await runModule(
        `var obj = new Date(1978, 3);
         var n_obj = new Object(obj);`,
        `n_obj.getFullYear() === 1978 ? 1 : 0`,
      ),
    ).toBe(1);
  });

  it.fails("a function value's `.constructor` is %Function% (S15.2.1.1_A2_T11 / _A2_T7)", async () => {
    // Needs `%Function.prototype%` materialized as a real chain object with its
    // §20.2.3 own properties; the standalone `%Function.prototype%` `$Object`
    // singleton is currently EMPTY (`array-object-proto.ts`).
    expect(
      await runModule(`var n_obj = Object(function func(){ return 1; });`, `n_obj.constructor === Function ? 1 : 0`),
    ).toBe(1);
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

  it.fails("an `undefined`-initialized var can hold an object (preventExtensions/15.2.3.10-2)", async () => {
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
