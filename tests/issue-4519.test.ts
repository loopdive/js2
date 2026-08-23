// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4519) A member READ whose receiver is `undefined` must throw a **catchable**
// TypeError (§13.3.2.1 → §7.3.2 RequireObjectCoercible), not answer a fallback
// value.
//
// ## What was actually wrong, and where
//
// The issue named `property-access.ts`'s member-get multi-struct backup guard
// (`emitNullGuardedStructGet`, ~L1545) as the site. Measured on this branch, that
// guard is emitted **0 times across 120 standalone test262 modules** — it is not
// the guard that governs member reads in practice. The one that does is #4157's
// `emitReceiverNullGuard` (`nonnull-proof.ts`), site `dispatch:extern-get-recv`:
// **2,598 emissions over the same 120 modules**. It tested `ref.is_null` only.
//
// That is a faithful spelling of §7.3.2 exactly until #4489 made `undefined` a
// tag-1 `$AnyValue` SINGLETON in the standalone S1 regime — a genuinely NON-null
// reference. From then on the guard read a real `undefined` receiver as "an
// object", declined to throw, and let the read answer a fallback. Both guards
// are widened here to `is_null ∨ is-singleton`; the receiver guard is the one
// that moves rows.
//
// ## Why these shapes and not `undefined.foo`
//
// A SYNTACTIC `undefined`/`null` receiver has thrown since #4484
// (`nullish-receiver-coercible.ts`), so `undefined.foo` is already right and
// pins nothing about this change. The shapes below source their `undefined`
// from a VALUE — an absent argument and an explicitly-passed `undefined` — which
// is the population #4484 deliberately declined to cover from the checker.
//
// Every case runs the read inside a `try`/`catch` and asserts the TypeError was
// CAUGHT: a wasm trap would kill the module instead of running the handler, so
// "did it throw" and "did it throw catchably" are different assertions and only
// the second one is worth pinning.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
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

/** 1 = caught a TypeError · 0 = no throw · 2 = threw something else. */
const READ_IN_TRY = `
  function probe(a) {
    try { var v = a.foo; return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }
  }
`;

describe("#4519 member read on an undefined VALUE throws a catchable TypeError", () => {
  it("an ABSENT argument receiver throws (the closure-ABI pad)", async () => {
    // The flip this issue shipped. `probe()` leaves `a` unbound; the closure ABI
    // pads it with the null externref, which IS `undefined` to the program.
    expect(
      await runStandalone(`
        var out = 0;
        ${READ_IN_TRY}
        out = probe();
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it("an EXPLICIT `undefined` argument receiver throws (the #4489 singleton)", async () => {
    // The second flip, and the one that is specifically about #4489: here the
    // receiver is the tag-1 singleton, a NON-null reference that the pre-fix
    // `ref.is_null` guard could not see.
    expect(
      await runStandalone(`
        var out = 0;
        ${READ_IN_TRY}
        out = probe(undefined);
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it("a `null` argument receiver still throws (the control that must NOT move)", async () => {
    expect(
      await runStandalone(`
        var out = 0;
        ${READ_IN_TRY}
        out = probe(null);
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it("an ABSENT property used as the next receiver throws (`o.missing.foo`)", async () => {
    // The most common real-world shape of this defect, and the one that makes
    // the change worth its blast radius: the intermediate read answers
    // `undefined` and the NEXT read must reject it.
    expect(
      await runStandalone(`
        var out = 0;
        var o = { a: 1 };
        ${READ_IN_TRY}
        out = probe(o.missing);
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it("an OUT-OF-RANGE array element used as a receiver throws (`arr[3].foo`)", async () => {
    expect(
      await runStandalone(`
        var out = 0;
        var arr = [];
        ${READ_IN_TRY}
        out = probe(arr[3]);
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it("a STRICT-mode detached `this.foo` throws", async () => {
    // §10.2.1.2: a strict function called with no receiver gets `this ===
    // undefined`, and §7.3.2 then rejects `this.foo`. Measured flipping here.
    expect(
      await runStandalone(`
        var out = 0;
        function m() {
          "use strict";
          try { var v = this.foo; return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }
        }
        var detached = m;
        out = detached();
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it("the §15.3.5.4 strict-`.caller` shape throws — the three corpus rows this flipped", async () => {
    // `built-ins/Function/15.3.5.4_2-{10,96,97}gs.js` all end with
    //     return g.caller || g.caller.throwTypeError;
    // `.caller` of a strict-called function is `undefined`, so the second read
    // must throw the TypeError the tests' `assert.throws` is waiting for.
    // Pinned in the corpus' own shape (`fn.caller` on a function value) rather
    // than by re-deriving it from a parameter.
    expect(
      await runStandalone(`
        var out = 0;
        function g() { }
        function probeCaller(fn) {
          try { var v = fn.caller.throwTypeError; return 0; } catch (e) { return (e instanceof TypeError) ? 1 : 2; }
        }
        out = probeCaller(g);
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it("a syntactic `undefined.foo` still throws (#4484's arm, unchanged)", async () => {
    expect(
      await runStandalone(`
        var out = 0;
        try { var v = undefined.foo; out = 0; } catch (e) { out = (e instanceof TypeError) ? 1 : 2; }
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  // ── The half that would make this change unshippable if it moved ──────────
  //
  // Widening a guard that sits on every member access is only safe if it stays
  // ABSENT for every receiver that is not nullish. These are the over-throw
  // pins: a present property, an ABSENT property (still `undefined`, no throw —
  // §7.3.2 tests the RECEIVER, not the result), a string receiver, and a number
  // receiver (which reaches the guard boxed through `__box_number`).

  it("a live object receiver still reads its property", async () => {
    expect(
      await runStandalone(`
        var out = 0;
        function get(a) { return a.foo; }
        out = (get({ foo: 5 }) === 5) ? 1 : 0;
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it("an ABSENT property on a live object still answers undefined, not a throw", async () => {
    expect(
      await runStandalone(`
        var out = 0;
        function get(a) {
          try { return (a.nope === undefined) ? 1 : 0; } catch (e) { return 2; }
        }
        out = get({ foo: 5 });
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it("primitive receivers (string, number, boolean) are still object-coercible", async () => {
    // A number receiver reaches the widened guard BOXED (`__box_number`), which
    // is the one arm where the elision proof and the nullish test could
    // disagree, so it is pinned by value rather than by "did not throw".
    //
    // Deliberately NOT pinned here: `typeof (42).toString === "function"`, which
    // answers falsy. Measured identical on BOTH arms of this issue's A/B, so it
    // is a pre-existing gap in method-value reads off a boxed primitive, not
    // something this guard moved.
    expect(
      await runStandalone(`
        var viaString = 0, viaNumber = 0, viaBool = 0;
        function len(a) { try { return a.length; } catch (e) { return -1; } }
        function tos(a) { try { return a.toString(); } catch (e) { return "THREW"; } }
        viaString = (len("abc") === 3) ? 1 : 0;
        viaNumber = (tos(42) === "42") ? 1 : 0;
        viaBool = (tos(true) === "true") ? 1 : 0;
        export function test() { return viaString + 2 * viaNumber + 4 * viaBool; }
      `),
    ).toBe(1 + 2 + 4);
  });

  it("chained reads, for-in, `arguments`, string chains and Error.message are unmoved", async () => {
    // Five whole-shape controls in one module: each one routes through the same
    // widened guard on a NON-nullish receiver, and each was measured identical
    // on both arms.
    expect(
      await runStandalone(`
        var a = 0, b = 0, c = 0, d = 0, e2 = 0;
        function chain(x) { return x.a.b.c; }
        function count(x) { var k, n = 0; for (k in x) { n = n + 1; } return n; }
        function argc() { return arguments.length; }
        function upper(s) { return s.toUpperCase().charAt(0); }
        function msg() { try { throw new TypeError("boom"); } catch (err) { return err.message; } }
        a = (chain({ a: { b: { c: 7 } } }) === 7) ? 1 : 0;
        b = (count({ a: 1, b: 2, c: 3 }) === 3) ? 1 : 0;
        c = (argc(1, 2) === 2) ? 1 : 0;
        d = (upper("abc") === "A") ? 1 : 0;
        e2 = (msg() === "boom") ? 1 : 0;
        export function test() { return a + 2 * b + 4 * c + 8 * d + 16 * e2; }
      `),
    ).toBe(1 + 2 + 4 + 8 + 16);
  });

  it("an object flowing through the same parameter as an undefined one still reads", async () => {
    // The guard is per-SITE, not per-value: one call site sees both a nullish
    // and a live receiver. The nullish call must throw and the live one must
    // not, from the same emitted guard.
    expect(
      await runStandalone(`
        var threw = 0, read = 0;
        ${READ_IN_TRY}
        function get(a) { return a.foo; }
        threw = probe(undefined);
        read = (get({ foo: 9 }) === 9) ? 1 : 0;
        export function test() { return threw + 2 * read; }
      `),
    ).toBe(1 + 2);
  });

  // ── Measured residuals — shapes that STILL do not throw ───────────────────
  //
  // These reads never reach `emitReceiverNullGuard` at all: they are claimed by
  // lowering paths that carry no receiver check. Two populations, both measured
  // on this branch with the emitter instrumented:
  //
  //   · `tryEmitPinnedStructMemberGet` (property-access.ts) — a receiver the
  //     compiler resolved to a registered fnctor struct. It compiles the
  //     receiver straight onto the stack and calls `__get_member_<name>` with no
  //     guard, deliberately holding no scratch local (#2681: an `allocTempLocal`
  //     here orphaned its slot inside a swapped body).
  //   · the standalone terminal of `finalizeStructAndDynamicMemberGet`, reached
  //     when `__extern_get` is not registerable.
  //
  // Both are follow-up surface, not this issue's: fixing them changes which
  // lowering path answers a read, not what a guard tests. They are pinned
  // `it.fails` so the day one of them starts throwing is visible.

  it.fails("residual: a module-scope `var` receiver does not throw (no guard on its path)", async () => {
    expect(
      await runStandalone(`
        var out = 0;
        try { var v = x.foo; out = 0; } catch (e) { out = (e instanceof TypeError) ? 1 : 2; }
        export function test() { return out; }
        var x;
      `),
    ).toBe(1);
  });

  it.fails("residual: a struct-typed slot holding undefined does not throw (pinned-struct read)", async () => {
    expect(
      await runStandalone(`
        function C() { this.foo = 1; }
        var out = 0;
        var o;
        if (1 === 2) { o = new C(); }
        try { var v = o.foo; out = 0; } catch (e) { out = (e instanceof TypeError) ? 1 : 2; }
        export function test() { return out; }
      `),
    ).toBe(1);
  });

  it.fails("residual: element access on a module-scope `var` receiver does not throw", async () => {
    expect(
      await runStandalone(`
        var out = 0;
        try { var v = x["foo"]; out = 0; } catch (e) { out = (e instanceof TypeError) ? 1 : 2; }
        export function test() { return out; }
        var x;
      `),
    ).toBe(1);
  });
});
