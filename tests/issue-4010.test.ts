// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4010 S1′ — the two disjoint array side tables clobbered each other.
//
// A named expando written by assignment lands in the #3537 BAG
// (`src/codegen/vec-props.ts`); a later `Object.defineProperty` on the same key
// lands in the #3251 COMPANION (`src/codegen/vec-overlay.ts`), which had never
// heard of it. `__extern_get`'s named-key prologue treats the companion as
// authoritative for any non-index key, so it returned the companion's
// never-populated value field and `arr.q` became `undefined`.
//
// The fix seeds the companion's PRE-STATE from the bag before delegating the
// define, so §10.1.6.3's existing preserve-the-[[Value]] rule has a value to
// preserve. It is the named-key twin of the pre-existing `seedIfRealElement`.
//
// SCOPE: this slice deliberately moves NO own-property visibility surface —
// `hasOwnProperty` / `Object.keys` / gOPD reach is unchanged. Per #4010's
// ordering law ("visibility cannot ship before deletability", the −684 receipt
// from #4055 v1), visibility widening waits for tombstones. The assertions
// below PIN that: they assert the value is preserved, and separately that the
// visibility answers are still the old ones. If a later slice changes those,
// these tests should be updated deliberately, not deleted.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const standaloneOpts = {
  fileName: "test.ts",
  emitWat: false,
  skipSemanticDiagnostics: true,
  target: "standalone" as const,
};

async function run(src: string): Promise<number> {
  const r = await compile(src, standaloneOpts);
  expect(r.success).toBe(true);
  expect(r.errors.filter((e) => e.severity === "error")).toEqual([]);
  // Standalone must stay host-free: an import here means the module could not
  // instantiate in the real lane, and any assertion below would be vacuous.
  const mod = await WebAssembly.compile(r.binary);
  expect(WebAssembly.Module.imports(mod)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#4010 S1′ — defineProperty no longer clobbers an array expando's value", () => {
  it("preserves the value when the descriptor omits [[Value]] (the reported defect)", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1, 2, 3];
  arr.q = 12;
  Object.defineProperty(arr, "q", { writable: false });
  return arr.q === 12 ? 1 : (arr.q === undefined ? 2 : 3);
}`),
    ).toBe(1);
  });

  it("an explicit [[Value]] in the descriptor still wins over the seeded one", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1, 2, 3];
  arr.q = 12;
  Object.defineProperty(arr, "q", { value: 99 });
  return arr.q === 99 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("defineProperty on a key the bag never held is unaffected", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1, 2, 3];
  Object.defineProperty(arr, "fresh", { value: 7, writable: true });
  return arr.fresh === 7 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("repeated attribute-only defines keep preserving the value", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = "keep";
  Object.defineProperty(arr, "q", { enumerable: false });
  Object.defineProperty(arr, "q", { configurable: false });
  return arr.q === "keep" ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("index keys are untouched — the pre-existing seedIfRealElement path still owns them", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1, 2, 3];
  Object.defineProperty(arr, "1", { writable: false });
  return arr[1] === 2 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("a plain expando with no define at all is unchanged", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = 12;
  return arr.q === 12 ? 1 : 2;
}`),
    ).toBe(1);
  });

  // ---- scope pins: these record what S1′ deliberately did NOT change --------
  // They are the #4010 ordering law in executable form. Flipping any of them is
  // S2/S3 work and must be accompanied by the tombstones + the mandatory
  // built-ins/**/{name,length}.js control run.
  it("SCOPE PIN: hasOwnProperty reach is unchanged (still answers from the overlay)", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = 12;
  return Object.prototype.hasOwnProperty.call(arr, "q") ? 1 : 2;
}`),
    ).toBe(2);
  });

  it("SCOPE PIN: Object.keys reach is unchanged", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = 12;
  const k = Object.keys(arr);
  for (let i = 0; i < k.length; i++) { if (k[i] === "q") return 1; }
  return 2;
}`),
    ).toBe(2);
  });
});

// ===========================================================================
// #4010 S2 — TOMBSTONES: `delete` is real on the carrier own-property stores.
//
// This block is the promoted, PRECONDITION-GATED delete control. The plain
// version of this matrix was WRONG in two ways at once and is why the gating
// exists (see the issue file):
//
//  - it measured "deleted" as `hasOwnProperty(o,"q") === false`, which is
//    `false` on an array/function receiver whether or not the value survived —
//    so it read "ok" while `o.q === 12` was still true;
//  - on receivers where the write never landed at all, "not an own property
//    afterwards" carries zero information — the cell is VACUOUS, not passing.
//
// So every case below:
//  1. RETURNS 0 when its own precondition fails (`expect(...).toBe(1)` then
//     fails loudly instead of the case quietly measuring nothing), and
//  2. is asserted through TWO INDEPENDENT DERIVATIONS of "is the key in the
//     store?" — a value read, and a path that consults the store's own record
//     without going through the read lane at all (see each case).
//
// `run()` above additionally asserts ZERO imports per compiled module, so a
// case cannot pass by silently falling back to a JS host.
//
// Acceptance for this slice is these cells, NOT pass-count: tombstones alone
// flip few test262 files, because currently-invisible properties fail earlier
// in `propertyHelper`. Deletability and visibility pay out together, and
// visibility is S3 (gated on the ~700-file `{name,length}.js` stratum control).
// ===========================================================================
describe("#4010 S2 — delete is real on a non-$Object receiver's own-property store", () => {
  // ---- ARRAY (the #3537 bag) ----------------------------------------------
  it("array: the value is genuinely gone after delete (derivation 1 — value read)", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1,2,3];
  a.q = 12;
  if (a.q !== 12) return 0;                  // precondition: the write landed
  delete a.q;
  return a.q === undefined ? 1 : (a.q === 12 ? 2 : 3);
}`),
    ).toBe(1);
  });

  it("array: the BAG's own record is empty after delete (derivation 2 — the S1′ seed)", async () => {
    // An attribute-only `defineProperty` seeds the companion's pre-state FROM
    // THE BAG (S1′), and that path never touches `__extern_get`. So the value
    // read here answers "what does the bag still hold?" — 12 if the delete only
    // stopped the read, undefined if the entry is really gone.
    expect(
      await run(`export function test(): number {
  const a: any = [1,2,3];
  a.q = 12;
  if (a.q !== 12) return 0;
  delete a.q;
  Object.defineProperty(a, "q", { writable: false });
  return a.q === undefined ? 1 : (a.q === 12 ? 2 : 3);
}`),
    ).toBe(1);
  });

  it("array: a key held by BOTH tables is gone from both (the companion tombstone must shadow the bag)", async () => {
    // The mechanism that made this fail: `__delete_property` tombstones the
    // companion entry, `__obj_find` then skips it, and `__extern_get`'s
    // named-key prologue falls straight through to the bag — which still had 12.
    expect(
      await run(`export function test(): number {
  const a: any = [1,2,3];
  a.q = 12;
  Object.defineProperty(a, "q", { writable: true });
  if (a.q !== 12) return 0;
  delete a.q;
  return a.q === undefined ? 1 : (a.q === 12 ? 2 : 3);
}`),
    ).toBe(1);
  });

  it("array: a companion-only key stays deletable, by value AND by gOPD", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1,2,3];
  Object.defineProperty(a, "q", { value: 5, writable: true, enumerable: true, configurable: true });
  if (a.q !== 5) return 0;
  if (Object.getOwnPropertyDescriptor(a, "q") === undefined) return 0;   // gOPD must SEE it first
  delete a.q;
  const gone = a.q === undefined && Object.getOwnPropertyDescriptor(a, "q") === undefined;
  return gone ? 1 : 2;
}`),
    ).toBe(1);
  });

  // ---- FUNCTION (the #3468 closure bag) -----------------------------------
  it("function: the value is genuinely gone after delete (derivation 1 — value read)", async () => {
    expect(
      await run(`export function test(): number {
  function f(){}
  const g: any = f;
  g.p = 12;
  if (g.p !== 12) return 0;
  delete g.p;
  return g.p === undefined ? 1 : (g.p === 12 ? 2 : 3);
}`),
    ).toBe(1);
  });

  it("function: the closure BAG's own record is empty after delete (derivation 2 — __desc_has_own)", async () => {
    // #4055's ToPropertyDescriptor reads a function-shaped descriptor through
    // `__desc_has_own`, which queries the closure bag directly — a completely
    // different consumer from the `g.p` read lane. If `value` survived the
    // delete, `o.p` becomes 42.
    expect(
      await run(`export function test(): number {
  function f(){}
  const d: any = f;
  d.value = 42; d.writable = true; d.enumerable = true; d.configurable = true;
  if (d.value !== 42) return 0;
  delete d.value;
  const o: any = {};
  Object.defineProperty(o, "p", d);
  return o.p === undefined ? 1 : (o.p === 42 ? 2 : 3);
}`),
    ).toBe(1);
  });

  // ---- the arm must be ADDITIVE, not a redirection -------------------------
  it("array: a non-configurable companion entry still REFUSES (and the value survives)", async () => {
    // Strict-mode `delete` of a non-configurable own property throws TypeError
    // (§13.5.1.2) — identical to the $Object control below. The bag must not be
    // emptied behind a refusal.
    expect(
      await run(`export function test(): number {
  const a: any = [1,2,3];
  a.q = 12;
  Object.defineProperty(a, "q", { configurable: false });
  if (a.q !== 12) return 0;
  let threw = 0;
  try { delete a.q; } catch (e) { threw = 1; }
  return (threw === 1 && a.q === 12) ? 1 : (threw === 0 ? 2 : 3);
}`),
    ).toBe(1);
  });

  it("CONTROL $Object: the same refusal, so a failure above is the substrate not the harness", async () => {
    expect(
      await run(`export function test(): number {
  const o: any = {};
  Object.defineProperty(o, "q", { value: 5, configurable: false });
  if (o.q !== 5) return 0;
  let threw = 0;
  try { delete o.q; } catch (e) { threw = 1; }
  return (threw === 1 && o.q === 5) ? 1 : (threw === 0 ? 2 : 3);
}`),
    ).toBe(1);
  });

  it("array: a plain expando delete does NOT throw and sibling keys survive", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1,2,3];
  a.q = 12; a.r = 34;
  if (a.q !== 12 || a.r !== 34) return 0;
  let threw = 0;
  try { delete a.q; } catch (e) { threw = 1; }
  return (threw === 0 && a.q === undefined && a.r === 34) ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("array: elements, length and index-delete semantics are untouched", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1,2,3];
  a.q = 12;
  if (a.q !== 12) return 0;
  delete a.q;
  delete a[1];
  return (a.length === 3 && a[0] === 1 && a[1] === undefined && a[2] === 3) ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("array: two arrays keep independent stores (identity keying survives delete)", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1]; const b: any = [2];
  a.q = 12; b.q = 34;
  if (a.q !== 12 || b.q !== 34) return 0;
  delete a.q;
  return (a.q === undefined && b.q === 34) ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("delete of a key the store never held still reports success (§10.1.10 step 2)", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1,2,3];
  function f(){}
  const g: any = f;
  return ((delete a.never) && (delete g.never)) ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("re-setting after a delete round-trips on both receivers", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1]; a.q = 12; delete a.q; a.q = 7;
  function f(){}
  const g: any = f; g.p = 1; delete g.p; g.p = 9;
  return (a.q === 7 && g.p === 9) ? 1 : 2;
}`),
    ).toBe(1);
  });

  // ---- the -684 stratum stays out of scope --------------------------------
  it("REGRESSION GUARD: `delete fn.name` still routes to the #2896 builtin-fn arm", async () => {
    // The builtin-fn metadata arm runs BEFORE the carrier-bag arm and returns,
    // so `built-ins/**/{name,length}.js` — the ~700-file population that cost
    // #4055 v1 -684 host-free passes — never reaches the new code.
    expect(
      await run(`export function test(): number {
  const f: any = Array.prototype.push;
  if (typeof f.name !== "string") return 0;
  delete f.name;
  return f.name === undefined ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("REGRESSION GUARD: #4055's function-as-descriptor path is unchanged", async () => {
    expect(
      await run(`export function test(): number {
  function d(){}
  const dd: any = d;
  dd.value = 42; dd.writable = true; dd.enumerable = true; dd.configurable = true;
  const o: any = {};
  Object.defineProperty(o, "p", dd);
  return o.p === 42 ? 1 : 2;
}`),
    ).toBe(1);
  });

  // ---- S2 moves NO visibility surface (#4010's ordering law) --------------
  it("SCOPE PIN: array hasOwnProperty reach is STILL unchanged after S2", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1];
  a.q = 12;
  return Object.prototype.hasOwnProperty.call(a, "q") ? 1 : 2;
}`),
    ).toBe(2);
  });

  it("SCOPE PIN: function hasOwnProperty reach is STILL unchanged after S2", async () => {
    expect(
      await run(`export function test(): number {
  function f(){}
  const g: any = f;
  g.p = 12;
  return Object.prototype.hasOwnProperty.call(g, "p") ? 1 : 2;
}`),
    ).toBe(2);
  });

  it("SCOPE PIN: array gOPD reach for a bag-only expando is STILL unchanged", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1];
  a.q = 12;
  return Object.getOwnPropertyDescriptor(a, "q") === undefined ? 1 : 2;
}`),
    ).toBe(1);
  });
});
