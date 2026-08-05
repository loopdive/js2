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

  // ---- scope pins: these recorded what S1′ deliberately did NOT change ------
  // They were the #4010 ordering law in executable form: "flipping any of them
  // is S2/S3 work and must be accompanied by the tombstones + the mandatory
  // built-ins/**/{name,length}.js control run." S2 landed the tombstones, S3
  // ran the control, so BOTH are flipped here — DELIBERATELY, which is exactly
  // what these cases existed to force. They are kept (not deleted) so the
  // before/after of the ordering law stays readable in one place.
  it("PIN FLIPPED BY S3: hasOwnProperty now reaches the array expando bag", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = 12;
  return Object.prototype.hasOwnProperty.call(arr, "q") ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("PIN FLIPPED BY S3: Object.keys now reaches the array expando bag", async () => {
    expect(
      await run(`export function test(): number {
  const arr: any = [1];
  arr.q = 12;
  const k = Object.keys(arr);
  for (let i = 0; i < k.length; i++) { if (k[i] === "q") return 1; }
  return 2;
}`),
    ).toBe(1);
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

  // ---- S2 moved NO visibility surface; S3 moves all of them ---------------
  // Same deliberate flip as the two S1′ pins above.
  it("PIN FLIPPED BY S3: array hasOwnProperty now reaches the bag", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1];
  a.q = 12;
  return Object.prototype.hasOwnProperty.call(a, "q") ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("PIN FLIPPED BY S3: function hasOwnProperty now reaches the closure bag", async () => {
    expect(
      await run(`export function test(): number {
  function f(){}
  const g: any = f;
  g.p = 12;
  return Object.prototype.hasOwnProperty.call(g, "p") ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("PIN FLIPPED BY S3: array gOPD now reaches a bag-only expando", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1];
  a.q = 12;
  return Object.getOwnPropertyDescriptor(a, "q") === undefined ? 1 : 2;
}`),
    ).toBe(2);
  });
});

// ===========================================================================
// #4010 S3 — VISIBILITY: hasOwnProperty / `in` / gOPD / keys see the store.
//
// This is the slice #4010's ordering law held back:
//
//   > Own-property VISIBILITY cannot ship before own-property DELETABILITY.
//
// S2 landed deletability (+13/-0), so the `configurable` wall that made #4055
// v1 cost -684 host-free passes is gone — but only because the -684's actual
// mechanism was finally isolated and fixed at its SOURCE. That mechanism has
// its own guards below (the "-684" block); they are the most load-bearing
// cases in this file.
//
// `run()` asserts ZERO imports per compiled module, so nothing here can pass by
// falling back to a JS host.
// ===========================================================================
describe("#4010 S3 — the -684 mechanism, isolated and closed at the source", () => {
  it("a write to a builtin fn's non-writable `name` never reaches the bag", async () => {
    // THE defect. `__extern_set` had no builtin-fn arm, so `fn.name = x` was
    // deposited in the #3468 closure bag while the #2896 read arm shadowed it —
    // invisible until a `delete` removed the shadow. Widening hasOwnProperty
    // over a bag polluted this way is what produced 696 "descriptor should be
    // configurable" failures. Derivation: delete the metadata, then read.
    expect(
      await run(`export function test(): number {
  const f: any = Array.prototype.push;
  if (typeof f.name !== "string") return 0;
  f.name = "unlikelyValue";
  if (f.name !== "push") return 3;          // precondition: the write is shadowed
  delete f.name;
  return f.name === undefined ? 1 : (f.name === "unlikelyValue" ? 2 : 4);
}`),
    ).toBe(1);
  });

  it("propertyHelper's exact isWritable→isConfigurable sequence still says configurable", async () => {
    // The harness order verbatim: `isWritable` writes `obj[name] =
    // "unlikelyValue"` BEFORE `isConfigurable` deletes and asks hasOwnProperty.
    // A `2` here IS the -684, in one file.
    expect(
      await run(`export function test(): number {
  const f: any = Array.prototype.push;
  if (typeof f.name !== "string") return 0;
  f.name = "unlikelyValue";
  delete f.name;
  return Object.prototype.hasOwnProperty.call(f, "name") ? 2 : 1;
}`),
    ).toBe(1);
  });

  it("the refusal is scoped to LIVE metadata — after delete, assignment lands", async () => {
    // §10.1.9 refuses only because `name` exists and is non-writable. Once it is
    // deleted the property is gone, so an assignment must create a fresh own
    // property. A refusal that outlived the metadata would be a new defect.
    expect(
      await run(`export function test(): number {
  const f: any = Array.prototype.push;
  delete f.name;
  f.name = "fresh";
  return f.name === "fresh" ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("`length` takes the same route as `name`", async () => {
    expect(
      await run(`export function test(): number {
  const f: any = Array.prototype.push;
  if (typeof f.length !== "number") return 0;
  f.length = 999;
  if (f.length === 999) return 3;           // precondition: the write is refused
  delete f.length;
  return Object.prototype.hasOwnProperty.call(f, "length") ? 2 : 1;
}`),
    ).toBe(1);
  });

  it("REGRESSION GUARD: builtin fn name/length reflection is byte-unchanged", async () => {
    expect(
      await run(`export function test(): number {
  const f: any = Array.prototype.push;
  const d: any = Object.getOwnPropertyDescriptor(f, "name");
  if (d === undefined) return 2;
  return (d.value === "push" && d.writable === false && d.enumerable === false
    && d.configurable === true && Object.prototype.hasOwnProperty.call(f, "length")) ? 1 : 3;
}`),
    ).toBe(1);
  });
});

describe("#4010 S3 — the capability matrix's array + function rows", () => {
  it("array: hasOwnProperty / Object.hasOwn / `in` all see a bag expando", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1]; a.q = 12;
  const h1 = Object.prototype.hasOwnProperty.call(a, "q");
  const h2 = (Object as any).hasOwn(a, "q");
  const h3 = ("q" in a);
  return (h1 && h2 && h3) ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("array: gOPD returns the full data descriptor, not just presence", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1]; a.q = 12;
  const d: any = Object.getOwnPropertyDescriptor(a, "q");
  if (d === undefined) return 2;
  return (d.value === 12 && d.writable === true && d.enumerable === true
    && d.configurable === true) ? 1 : 3;
}`),
    ).toBe(1);
  });

  it("array: Object.keys puts the expando AFTER the indices (§10.1.11.1 order)", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [7, 8]; a.q = 12;
  const k: any = Object.keys(a);
  return (k.length === 3 && k[0] === "0" && k[1] === "1" && k[2] === "q") ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("array: for-in and getOwnPropertyNames agree with Object.keys", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [7]; a.q = 12;
  let seen = "";
  for (const k in a) seen += k + ",";
  const n: any = Object.getOwnPropertyNames(a);
  let inNames = false;
  for (let i = 0; i < n.length; i++) if (n[i] === "q") inNames = true;
  return (seen === "0,q," && inNames) ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("array: propertyIsEnumerable agrees (a key in keys must be enumerable)", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [7]; a.q = 12;
  return Object.prototype.propertyIsEnumerable.call(a, "q") ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("function: hasOwnProperty / `in` / gOPD / keys all see a closure-bag expando", async () => {
    expect(
      await run(`export function test(): number {
  function f(){} const g: any = f; g.p = 12;
  const d: any = Object.getOwnPropertyDescriptor(g, "p");
  const k: any = Object.keys(g);
  return (Object.prototype.hasOwnProperty.call(g, "p") && ("p" in g)
    && d !== undefined && d.value === 12 && d.configurable === true
    && k.length === 1 && k[0] === "p") ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("function: getOwnPropertyNames includes the expando", async () => {
    expect(
      await run(`export function test(): number {
  function f(){} const g: any = f; g.p = 12;
  const n: any = Object.getOwnPropertyNames(g);
  for (let i = 0; i < n.length; i++) if (n[i] === "p") return 1;
  return 2;
}`),
    ).toBe(1);
  });
});

describe("#4010 S3 — S2's tombstones shadow every widened surface", () => {
  // The whole reason visibility could not ship first: a property that is visible
  // but undeletable gives `propertyHelper` a longer runway and then fails at the
  // `configurable` wall. These assert the two slices compose.
  it("array: after delete, all four surfaces answer absent", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [1]; a.q = 12;
  if (!Object.prototype.hasOwnProperty.call(a, "q")) return 0;   // precondition
  delete a.q;
  const k: any = Object.keys(a);
  let inKeys = false;
  for (let i = 0; i < k.length; i++) if (k[i] === "q") inKeys = true;
  return (!Object.prototype.hasOwnProperty.call(a, "q") && !("q" in a)
    && Object.getOwnPropertyDescriptor(a, "q") === undefined && !inKeys) ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("function: after delete, all four surfaces answer absent", async () => {
    expect(
      await run(`export function test(): number {
  function f(){} const g: any = f; g.p = 12;
  if (!Object.prototype.hasOwnProperty.call(g, "p")) return 0;   // precondition
  delete g.p;
  const k: any = Object.keys(g);
  let inKeys = false;
  for (let i = 0; i < k.length; i++) if (k[i] === "p") inKeys = true;
  return (!Object.prototype.hasOwnProperty.call(g, "p") && !("p" in g)
    && Object.getOwnPropertyDescriptor(g, "p") === undefined && !inKeys) ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("array: the isConfigurable round trip now completes on an expando", async () => {
    // `delete obj[name]` then `!hasOwnProperty(obj, name)` — propertyHelper's
    // actual configurability probe, which is what S2 + S3 together make answer.
    expect(
      await run(`export function test(): number {
  const a: any = [1]; a.q = 12;
  const d: any = Object.getOwnPropertyDescriptor(a, "q");
  if (d === undefined || d.configurable !== true) return 0;
  delete a.q;
  return Object.prototype.hasOwnProperty.call(a, "q") ? 2 : 1;
}`),
    ).toBe(1);
  });
});

describe("#4010 S3 — the screens that must NOT move", () => {
  it("#4071 GUARD: Object.keys(new Date(0)) is still []", async () => {
    // #4071 measured -5 for letting closed-struct internals into Object.keys and
    // reverted it. The bag holds only user-written keys, so enumerating it
    // cannot surface an internal field — this pins that the screen is
    // structural, not a name-shape heuristic (#4086).
    expect(
      await run(`export function test(): number {
  const d: any = new Date(0);
  return Object.keys(d).length === 0 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("#4071 GUARD: Object.keys(/ab/) is still []", async () => {
    expect(
      await run(`export function test(): number {
  const r: any = /ab/;
  return Object.keys(r).length === 0 ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("an array with no expando enumerates exactly its indices", async () => {
    expect(
      await run(`export function test(): number {
  const a: any = [7, 8, 9];
  const k: any = Object.keys(a);
  return (k.length === 3 && k[0] === "0" && k[2] === "2") ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("CONTROL $Object: every widened surface is still correct on the open substrate", async () => {
    expect(
      await run(`export function test(): number {
  const o: any = {}; o.q = 12;
  const d: any = Object.getOwnPropertyDescriptor(o, "q");
  return (Object.prototype.hasOwnProperty.call(o, "q") && ("q" in o)
    && d !== undefined && d.value === 12 && Object.keys(o).length === 1) ? 1 : 2;
}`),
    ).toBe(1);
  });

  it("(#4161) Object.defineProperty on a FUNCTION now LANDS — gOPD and the read agree", async () => {
    // Flipped DELIBERATELY from the S3-era "still lands nowhere" pin. That pin
    // guarded against gOPD reporting a descriptor the next read disproves; with
    // the #4161 applier arm the define reaches the SAME #3468 bag gOPD reads,
    // so the two surfaces now agree on presence instead of on absence. The
    // invariant being pinned is the AGREEMENT, not the absence.
    expect(
      await run(`export function test(): number {
  function f(){} const g: any = f;
  Object.defineProperty(g, "p", { value: 5, writable: true, enumerable: true, configurable: true });
  const d = Object.getOwnPropertyDescriptor(g, "p");
  if (d === undefined) return 2;
  if (d.value !== 5) return 3;
  if (g.p !== 5) return 4;
  return 1;
}`),
    ).toBe(1);
  });

  it("REGRESSION GUARD: #4055's function-as-descriptor path still resolves", async () => {
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
});
