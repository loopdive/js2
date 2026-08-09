// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4241 step 1 — the carrier-intrinsic `$bag` slot on the closure family.
 *
 * `__closure_bag_lookup` was the acorn standalone profile's #1 frame (12.98 %
 * self, paired measurement 2026-08-08): a LINEAR `ref.eq` walk of a global
 * `$ClosurePropEntry` registry, consulted 39,455×/self-parse, over a list that
 * grew ~75 entries/parse and was never pruned. Closure carriers now hold their
 * own-property bag INTRINSICALLY, in a nullable mutable `externref` at
 * `CLOSURE_BAG_FIELD_IDX = 2` of the closure header — so the lookup is one
 * `struct.get`, the bag dies with its carrier, and a slotted carrier never
 * enters the registry at all.
 *
 * Two families of pin here, and the second is the load-bearing one:
 *
 *  1. **Behaviour** — expando read/write/delete round-trips, bag identity
 *     across aliases of the same carrier, and the reflective surfaces
 *     (`in` / `hasOwnProperty` / `Object.keys`) still agree with the bag.
 *
 *  2. **Layout** — inserting a field at index 2 SHIFTS every capture, TDZ slot
 *     and `__constructible` marker one place right, and shifts the builtin-fn
 *     meta subtype's `bfnstate`/`bfnid`. A wrong index there is usually a loud
 *     Wasm validation failure, but not always: two adjacent fields of the same
 *     type would validate and silently swap. So the capture-heavy and
 *     builtin-meta cases below are regression pins for the SHIFT, not just for
 *     the bag — and `header layout` asserts the emitted field order directly,
 *     so a future header change is noticed at the type table rather than three
 *     subsystems downstream.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import {
  CLOSURE_ARITY_FIELD_IDX,
  CLOSURE_BAG_FIELD_IDX,
  CLOSURE_CAPTURE_FIELD_BASE,
} from "../src/codegen/closures/funcref-wrapper-types.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, {
    target: "standalone",
    allowJs: true,
    fileName: "issue-4241.ts",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const init = instance.exports.__module_init as (() => void) | undefined;
  if (typeof init === "function") init();
  const fn = instance.exports.test as (() => unknown) | undefined;
  return fn?.();
}

describe("#4241 — carrier-intrinsic $bag slot", () => {
  it("header layout: the closure constants stay contiguous and $bag sits between $arity and the captures", () => {
    // Not a tautology: these three are read by three different subsystems
    // (closure-exports' arity read, the bag helpers, every capture emit), and
    // the whole change is that inserting one field keeps them consistent.
    expect(CLOSURE_ARITY_FIELD_IDX).toBe(1);
    expect(CLOSURE_BAG_FIELD_IDX).toBe(2);
    expect(CLOSURE_CAPTURE_FIELD_BASE).toBe(CLOSURE_BAG_FIELD_IDX + 1);
  });

  it("write/read round-trips on a noncapturing function carrier", async () => {
    expect(
      await runStandalone(`
        function f(a, b) { return a + b; }
        f.tag = 7;
        export function test() { return f(1, 2) === 3 && f.tag === 7 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("write/read round-trips on a CAPTURING closure — the capture-shift pin", async () => {
    // Every capture moved from field 2 to field 3. If a capture read kept the
    // old index it would read `$bag` (externref) where an f64 was expected —
    // loud here, but the point is that `n` must still be 5, not just validate.
    expect(
      await runStandalone(`
        function make(n) { return function inner(x) { return x + n; }; }
        var g = make(5);
        g.mark = 11;
        export function test() { return g(1) === 6 && g.mark === 11 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("multi-capture closure still reads every capture in order", async () => {
    expect(
      await runStandalone(`
        function make3(a, b, c) { return function (x) { return x * 1000 + a * 100 + b * 10 + c; }; }
        var h = make3(1, 2, 3);
        export function test() { return h(9) === 9123 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("the bag is per-CARRIER identity, shared by every alias", async () => {
    expect(
      await runStandalone(`
        function f() { return 1; }
        export function test() {
          var h = f;
          h.alias = 42;
          var k = h;
          return (f.alias === 42 && k.alias === 42) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("two distinct carriers get two distinct bags", async () => {
    expect(
      await runStandalone(`
        function make(n) { return function () { return n; }; }
        export function test() {
          var a = make(1);
          var b = make(2);
          a.p = "A";
          b.p = "B";
          return (a.p === "A" && b.p === "B") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("overwrite replaces the value rather than adding a second entry", async () => {
    expect(
      await runStandalone(`
        function f() { return 0; }
        export function test() {
          f.v = 1;
          f.v = 2;
          var n = 0;
          for (var k in f) { n++; }
          return (f.v === 2) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("reflective surfaces agree with the slot-backed bag", async () => {
    // `in`, `hasOwnProperty` and `Object.keys` each reach the bag through a
    // DIFFERENT helper (carrier-bag-visibility / -hasown / the enumeration
    // arms). All of them route through `__closure_bag_lookup`'s name, so this
    // is the pin that the body swap kept every consumer in agreement.
    expect(
      await runStandalone(`
        function f() { return 0; }
        f.one = 1;
        f.two = 2;
        export function test() {
          var okIn = ("one" in f) && ("two" in f) && !("three" in f);
          var okOwn = f.hasOwnProperty("one") && !f.hasOwnProperty("three");
          var keys = Object.keys(f);
          return (okIn && okOwn && keys.length === 2) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("a carrier that never grew a property reads undefined (the null-slot fast path)", async () => {
    expect(
      await runStandalone(`
        function f() { return 0; }
        export function test() { return f.neverSet === undefined ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("a QUERY does not create a bag (carrier-bag-hasown's rule survives the swap)", async () => {
    // Reading a missing key, then `in`, then hasOwnProperty — none may deposit
    // anything. If a query allocated, `Object.keys` would report it.
    expect(
      await runStandalone(`
        function f() { return 0; }
        export function test() {
          var a = f.missing;
          var b = ("missing" in f);
          var c = f.hasOwnProperty("missing");
          return (a === undefined && !b && !c && Object.keys(f).length === 0) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("$arity still answers .length after the insert", async () => {
    expect(
      await runStandalone(`
        function two(a, b) { return a + b; }
        function none() { return 0; }
        export function test() { return (two.length === 2 && none.length === 0) ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("builtin-fn meta name/length still resolve — the bfnstate/bfnid shift pin", async () => {
    // `bfnstate` moved 2 -> 3 and `bfnid` 3 -> 4. `bfnid` is the exact-identity
    // discriminator for structurally-equal meta types, so a stale index makes
    // the arm match the WRONG builtin rather than fail loudly.
    expect(
      await runStandalone(`
        export function test() {
          return (Math.abs.name === "abs" && Math.max.name === "max" && Math.abs.length === 1) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("a bound function carries expandos through its own appended slot", async () => {
    // `$__bound_fn` is a final, super-less struct, so its `$bag` is APPENDED
    // (index 3) rather than inserted — no field shift, but it does mean every
    // `struct.new $__bound_fn` site needs the extra operand, and one of the two
    // was missed on the first cut (caught loudly: "need 4, got 3").
    //
    // Deliberately does NOT invoke the bound function: `inc(2)` traps with
    // "dereferencing a null pointer" on this lane, and it does so IDENTICALLY
    // on the pre-#4241 build (probed 2026-08-08, both lanes). That is a
    // separate, pre-existing `.bind` invocation gap, not a bag defect — pinning
    // it here would make this file fail for someone else's reason.
    expect(
      await runStandalone(`
        function add(a, b) { return a + b; }
        export function test() {
          var inc = add.bind(null, 1);
          inc.note = 5;
          return inc.note === 5 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("closures still dispatch through .call after the header insert", async () => {
    // `.apply(null, [array])` answers 0 here and answers 0 on the pre-#4241
    // build too (same probe) — a pre-existing `__closure_method_call` apply
    // gap, deliberately out of scope.
    expect(
      await runStandalone(`
        function f(a, b) { return a + b; }
        export function test() {
          var g = f;
          return g.call(null, 1, 2) === 3 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("the IR path's own header validator agrees with the mint sites — the miss-#3 pin", async () => {
    // The `check:ir-only` readiness gate (#3519) validates the physical closure
    // wrapper types it planned, and it used to state the header layout in its
    // OWN words: `fields.length === 2 && fields[0] funcref && fields[1] i32`.
    // That is a second, disconnected copy of the layout, so inserting `$bag`
    // satisfied every mint site and silently violated the validator — which
    // does not warn, it THROWS. All five async functions in
    // `website/playground/examples/js/async.ts` failed IR-first with
    // "non-canonical physical wrapper root", 10 fatal diagnostics, gate exit 1.
    //
    // The trigger is narrower than "an async function": it is a `setTimeout`
    // callback nested INSIDE a `new Promise` executor. That pair mints the
    // `(externref) -> void` wrapper root the validator inspects. Verified by
    // kill-switch — with the pre-fix literal predicate restored, this source
    // fails (2 fatal diagnostics) while the same source WITHOUT the
    // `setTimeout` compiles clean. The first draft of this test omitted the
    // `setTimeout` and therefore passed against the known-broken predicate:
    // a pin that cannot fail defends the defect, so the shape matters.
    const source = `
      function delay(ms: number, value: number): Promise<number> {
        return new Promise<number>((resolve) => {
          setTimeout(() => resolve(value), ms);
        });
      }
      export async function test(): Promise<number> { return await delay(1, 2); }
    `;
    const r = await compile(source, { fileName: "issue-4241-ir.ts", trackIrOutcomes: true });
    const messages = (r.errors ?? []).map((d) => d.message).join("\n");
    expect(messages).not.toMatch(/non-canonical physical wrapper root/);
    expect(messages).not.toMatch(/mismatched captured subtype/);
    expect(r.success, messages).toBe(true);
  });

  it("gc/host lane still compiles the same sources (the slot is standalone-visible only)", async () => {
    const r = await compile(
      `function f(a) { return a; }
       f.tag = 1;
       export function test(): number { return f(2) + f.tag; }`,
      { allowJs: true, skipSemanticDiagnostics: true, fileName: "issue-4241-host.ts" },
    );
    expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  });
});
