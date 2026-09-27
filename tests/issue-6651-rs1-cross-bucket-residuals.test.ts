// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6651 RS1) Cross-bucket ES2015 residuals on `--target standalone`.
//
// Three independent one-cause fixes, plus negative controls that PIN the
// residuals this lane diagnosed and deliberately did not take. Each positive
// case was proven RED on file copies of the pre-change sources before the fix
// landed; each negative case asserts today's spec-WRONG answer on purpose, so a
// future lane closing one of them gets a failing assertion here instead of
// silently moving a boundary nobody recorded.
//
// Every program is compiled with `target: "standalone"` and instantiated with NO
// import object — the host-free assertion.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6651-rs1.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports, "standalone output leaked host imports").toEqual([]);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#6651 RS1 — §7.1.1.1 step 5 skips a shadowed-to-nullish toString", () => {
  // The three `TypedArray/prototype/toLocaleString/{calls-valueof-from-each-value,
  // return-abrupt-from-{first,next}element-valueof}.js` rows. `stopWhenFirstAbsent`
  // (ordinary-to-primitive-probe.ts) conflated "the receiver does not have
  // toString" — where the inherited `Object.prototype.toString` answers a
  // primitive and `valueOf` is unreachable — with "the receiver OWNS toString and
  // its value is undefined", where step 5's IsCallable check skips it and
  // `valueOf` IS reached.
  it("renders an element through valueOf when its own toString is undefined", async () => {
    expect(
      await runStandalone(`export function test() {
        var calls = 0;
        Number.prototype.toLocaleString = function () {
          return { toString: undefined, valueOf: function () { calls++; return "hacks" + calls; } };
        };
        var s = [42, 0].toLocaleString();
        return (s === "hacks1,hacks2" ? 1 : 0) + (calls === 2 ? 10 : 0);
      }`),
    ).toBe(11);
  });

  it("propagates an abrupt valueOf from that same shape", async () => {
    expect(
      await runStandalone(`export function test() {
        Number.prototype.toLocaleString = function () {
          return { toString: undefined, valueOf: function () { throw 42; } };
        };
        try { [7, 8].toLocaleString(); } catch (e) { return e === 42 ? 1 : 2; }
        return 0;
      }`),
    ).toBe(1);
  });

  // CONTROL for the arm the change must not widen: an object with NO own
  // `toString` must still render "[object Object]", NOT its `valueOf`. That is
  // `built-ins/String/S9.8_A5_T1` check #13, and the reason
  // `stopWhenFirstAbsent` exists at all.
  it("still ignores valueOf when toString is genuinely absent", async () => {
    expect(
      await runStandalone(`export function test() {
        Number.prototype.toLocaleString = function () {
          return { valueOf: function () { return "[object MyObj]"; } };
        };
        var s = [1].toLocaleString();
        return s === "[object Object]" ? 1 : (s === "[object MyObj]" ? 2 : 3);
      }`),
    ).toBe(1);
  });
});

describe("#6651 RS1 — subarray on a dyn-view receiver the call-site two-arm declines", () => {
  // `new TA(4).subarray(2)` answered `null`: the species two-arm's gate requires
  // an IDENTIFIER receiver (three of its four members rebind that identifier and
  // recompile the call), so a NewExpression receiver fell through to the generic
  // externref path. `__ta_dyn_subarray` serves those shapes from the ladder.
  it("windows a chained new-expression receiver", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var chained = new TA(4).subarray(2);
          if (chained === null || chained === undefined) return -1;
          var paren = (new TA(4)).subarray(1, 3);
          if (paren === null || paren === undefined) return -2;
          return chained.length * 10 + paren.length;
        }
        return probe(Float64Array);
      }`),
    ).toBe(22);
  });

  it("keeps the identifier-receiver two-arm answer (control)", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var a = new TA(4);
          var s = a.subarray(2);
          var neg = a.subarray(-1);
          if (s === null || neg === null) return -1;
          return s.length * 10 + neg.length;
        }
        return probe(Float64Array);
      }`),
    ).toBe(21);
  });

  // The three `TypedArrayConstructors/internals/OwnPropertyKeys/*` rows. Their
  // reported error was `Reflect.ownKeys called on non-object` and the plan file
  // recorded the cause as a Reflect target-guard gap plus a missing integer-index
  // enumeration. Neither reproduces: the receiver was simply `null` from the
  // `subarray` above.
  it("Reflect.ownKeys sees the windowed view's integer indices", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var k = Reflect.ownKeys(new TA(4).subarray(2));
          if (k === null || k === undefined) return -1;
          var s1 = new TA([42, 42, 42]);
          s1.test262 = 42;
          var k1 = Reflect.ownKeys(s1);
          return k.length * 10000 + (k[0] === "0" ? 1000 : 0) + k1.length * 10 + (k1[3] === "test262" ? 1 : 0);
        }
        return probe(Float64Array);
      }`),
    ).toBe(21041);
  });
});

describe("#6651 RS1 — Array.prototype.{values,keys,entries} as a first-class value", () => {
  // `built-ins/Array/prototype/{values,keys,entries}/returns-iterator-from-object.js`
  // — all three ES2015 (`features: [Symbol.iterator]`). The reflective closure
  // body was the "not yet callable as a value" refusal; it now builds the same
  // `ITER_KIND_VEC` / `ITER_FAMILY_ARRAY` record the Map/Set and dyn-view
  // factories build, which is what makes the %ArrayIteratorPrototype% identity
  // hold.
  it("iterates an ordinary array-like and reports %ArrayIteratorPrototype%", async () => {
    expect(
      await runStandalone(`export function test() {
        var obj = { length: 2, 0: "a", 1: "b" };
        var proto = Object.getPrototypeOf([][Symbol.iterator]());
        var it = Array.prototype.values.call(obj);
        var k = Array.prototype.keys.call(obj);
        var en = Array.prototype.entries.call(obj);
        var r = 0;
        if (Object.getPrototypeOf(it) === proto) r += 1;
        if (Object.getPrototypeOf(k) === proto) r += 10;
        if (Object.getPrototypeOf(en) === proto) r += 100;
        if (it.next().value === "a") r += 1000;
        if (k.next().value === 0) r += 10000;
        var e0 = en.next().value;
        if (e0[0] === 0) r += 100000;
        if (e0[1] === "a") r += 1000000;
        return r;
      }`),
    ).toBe(1111111);
  });

  // PINNED residual, and NOT one this change introduced: reading `.length` on
  // the yielded `entries` PAIR is order-dependent under `--target standalone`.
  // Read after any other property traffic it answers 2 (see the case above);
  // read as the first access after the factory call it answers something else,
  // so the `&&`-chain `pair.length === 2 && pair[0] === 0 && …` is false while
  // each conjunct alone is true. Measured control (2026-09-26): the PRE-EXISTING
  // `$Vec` path — a real array's `[...].entries()`, which does not go through
  // this module at all — does not merely mis-answer here, it TRAPS on the same
  // read. So the pair carrier's `length` is a standalone weak spot in the
  // #2358 value-representation area, upstream of this lane; the new array-like
  // factory reuses the same `ensureObjVecBuilders` carrier and inherits it. The
  // three test262 rows this fix lands do not read `pair.length`.
  it("pair.length on an entries pair is order-dependent (pinned, pre-existing)", async () => {
    expect(
      await runStandalone(`export function test() {
        var en = Array.prototype.entries.call({ length: 2, 0: "a", 1: "b" });
        var e0 = en.next().value;
        var r = 0;
        if (e0.length === 2 && e0[0] === 0 && e0[1] === "a") r += 1;
        if (e0.length === 2) r += 10;
        if (e0[0] === 0) r += 100;
        if (e0[1] === "a") r += 1000;
        if (e0[0] === 0 && e0[1] === "a") r += 1000000;
        return r;
      }`),
    ).toBe(1001100); // spec: 1001111 — the two `length`-bearing conjuncts are wrong
  });

  it("exhausts and stays done", async () => {
    expect(
      await runStandalone(`export function test() {
        var it = Array.prototype.values.call({ length: 1, 0: 9 });
        var a = it.next();
        var b = it.next();
        var c = it.next();
        return (a.done === false ? 1 : 0) + (b.done === true ? 10 : 0) +
               (b.value === undefined ? 100 : 0) + (c.done === true ? 1000 : 0);
      }`),
    ).toBe(1111);
  });

  it("§23.1.3 step 1 ToObject — a nullish receiver throws", async () => {
    expect(
      await runStandalone(`export function test() {
        var r = 0;
        try { Array.prototype.values.call(undefined); } catch (e) { r += 1; }
        try { Array.prototype.keys.call(null); } catch (e) { r += 10; }
        return r;
      }`),
    ).toBe(11);
  });
});

describe("#6651 RS1 — residuals PINNED at today's spec-wrong answer", () => {
  // Diagnosed, not fixed. Each assertion below is WRONG per spec and is here so
  // that closing the cause is a visible, deliberate edit.

  // `TypedArray/prototype/{filter,map,slice,subarray}/speciesctor-get-species-
  // custom-ctor-invocation.js` (7 standalone rows incl. BigInt twins).
  // TWO causes, not one: (1) an anonymous function expression has no runtime
  // edge to a `prototype` object, so §10.2.5's own property is missing — a
  // §10.2.5 vivify into the #3468 closure bag was built and measured to fix
  // `Get(S,"prototype")`, `hasOwnProperty`, `gOPD` and the constructed
  // instance's `[[Prototype]]`; and (2) `instanceof` STILL answers false for
  // that target even with all four of those right, because the closure arrived
  // through a dyn-view expando round-trip and `__typeof_function` no longer
  // classifies it as callable (the #2358 value-representation area). The vivify
  // was reverted rather than landed: on its own it moves 0 rows and edits
  // `__closure_prop_get`, a hot shared path.
  it("species-constructor `this` is not an instance of the species function", async () => {
    expect(
      await runStandalone(`export function test() {
        function probe(TA) {
          var sample = new TA([40, 42, 42]);
          var ctorThis;
          sample.constructor = {};
          sample.constructor[Symbol.species] = function (count) { ctorThis = this; return new TA(count); };
          sample.map(function (v) { return v === 42; });
          var S = sample.constructor[Symbol.species];
          return (ctorThis === undefined ? -1 : 0) +
                 (typeof S === "function" ? 1 : 0) +
                 (ctorThis instanceof S ? 10 : 0);
        }
        return probe(Float64Array);
      }`),
    ).toBe(1); // spec: 11 — `ctorThis instanceof S` must be true
  });

  // `built-ins/Symbol/constructor.js` — and it is NOT Symbol work: the same
  // answer comes back for `Object(1)` and `Object("s")`. Belongs with the #2175
  // proto-index store, per SY1's routing note.
  it("a primitive wrapper's [[Prototype]] is Object.prototype for every wrapper", async () => {
    expect(
      await runStandalone(`export function test() {
        var op = Object.prototype;
        return (Object.getPrototypeOf(Object(1)) === op ? 1 : 0) +
               (Object.getPrototypeOf(Object("s")) === op ? 10 : 0) +
               (Object.getPrototypeOf(Object(true)) === op ? 100 : 0);
      }`),
    ).toBe(111); // spec: 0 — each wrapper's proto is its own %X.prototype%
  });
});
