// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6484 S1/S2 — the intrinsic iterator prototypes are REACHABLE from an
// iterator value under `--target standalone`.
//
// `emitIteratorPrototypeSingleton` has materialized one identity-stable
// `$Object` per family since #3013/#4747/#4777/#5099, but the only route to it
// was four checker-keyed arms in `call-builtin-static.ts`. S1 adds the run-time
// route: an immutable `family` tag on `$__IterRec` plus `__iter_rec_proto`,
// which is what answers when the argument's static type is `any`. S2 makes
// `it.next` readable as a VALUE and gives that closure a real §23.1.5.2 body —
// brand-check, then step — so `iterator.next.call(false)` is a catchable
// TypeError while `iterator.next.call(<a genuine record>)` steps.
//
// EVERY assertion here has to establish that the values compared are real
// objects BEFORE comparing them: `null === null` is `true`, so a build that
// regressed all four prototypes back to null would otherwise read as green on
// the cross-family distinctness checks. Each score below therefore awards
// points for "is an object" separately from "differs from its sibling".

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<{ value: number; hostImports: string[] }> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    deferTopLevelInit: true,
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  // The hard rule for this lane: a standalone module declares ZERO host
  // imports. Read them off the compiled module, not off a summary field.
  const module = await WebAssembly.compile(result.binary);
  const hostImports = WebAssembly.Module.imports(module).map((i) => `${i.module}::${i.name}`);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, unknown>;
  (exports.__module_init as (() => void) | undefined)?.();
  return { value: (exports.test as () => number)(), hostImports };
}

describe("#6484 — intrinsic iterator prototypes are reachable (standalone)", () => {
  it("all four array-iterator producers report ONE %ArrayIteratorPrototype%", async () => {
    const { value, hostImports } = await runStandalone(
      `var a = [1, 2, 3];
       var pValues = Object.getPrototypeOf(a.values());
       var pKeys = Object.getPrototypeOf(a.keys());
       var pEntries = Object.getPrototypeOf(a.entries());
       var pSym = Object.getPrototypeOf(a[Symbol.iterator]());
       var score = 0;
       // "is an object" first — four nulls would compare equal to each other.
       if (pValues !== null && pValues !== undefined) score += 1;
       if (pKeys !== null && pKeys !== undefined) score += 2;
       if (pEntries !== null && pEntries !== undefined) score += 4;
       if (pSym !== null && pSym !== undefined) score += 8;
       if (score === 15) {
         if (pKeys === pValues) score += 16;
         if (pEntries === pValues) score += 32;
         if (pSym === pValues) score += 64;
       }
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(127);
  });

  it("Array / Map / Set / String iterator prototypes are four DISTINCT objects", async () => {
    const { value, hostImports } = await runStandalone(
      `var pa = Object.getPrototypeOf([1][Symbol.iterator]());
       var pm = Object.getPrototypeOf(new Map([[1, 2]])[Symbol.iterator]());
       var ps = Object.getPrototypeOf(new Set([1])[Symbol.iterator]());
       var pt = Object.getPrototypeOf("ab"[Symbol.iterator]());
       var score = 0;
       if (pa !== null && pa !== undefined) score += 1;
       if (pm !== null && pm !== undefined) score += 2;
       if (ps !== null && ps !== undefined) score += 4;
       if (pt !== null && pt !== undefined) score += 8;
       // Distinctness is only meaningful once all four are objects: two nulls
       // are EQUAL, so a broken build must not be able to score these points.
       if (score === 15) {
         if (pa !== pm) score += 16;
         if (pa !== ps) score += 32;
         if (pa !== pt) score += 64;
         if (pm !== ps) score += 128;
         if (pm !== pt) score += 256;
         if (ps !== pt) score += 512;
       }
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(1023);
  });

  it("a DYNAMICALLY-typed iterator resolves its prototype too (the #6484 defect)", async () => {
    // The whole point of the `family` tag: the checker cannot name the type of
    // a value that reached `any`, which is the shape every test262 program has
    // once it stores an iterator in a reassigned `var`.
    const { value, hostImports } = await runStandalone(
      `var arr: any = [1, 2, 3];
       var ai: any = arr[Symbol.iterator]();
       var mi: any = (new Map([[1, 2]]) as any)[Symbol.iterator]();
       var si: any = (new Set([1]) as any)[Symbol.iterator]();
       var pa: any = Object.getPrototypeOf(ai);
       var pm: any = Object.getPrototypeOf(mi);
       var ps: any = Object.getPrototypeOf(si);
       var score = 0;
       if (pa !== null && pa !== undefined) score += 1;
       if (pm !== null && pm !== undefined) score += 2;
       if (ps !== null && ps !== undefined) score += 4;
       if (score === 7) {
         if (pa !== pm) score += 8;
         if (pa !== ps) score += 16;
         if (pm !== ps) score += 32;
         // …and they are the SAME objects the statically-typed route answers.
         if (pa === Object.getPrototypeOf([1][Symbol.iterator]())) score += 64;
       }
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(127);
  });

  it("%IteratorPrototype% is the shared parent, with an own [Symbol.iterator]", async () => {
    const { value, hostImports } = await runStandalone(
      `var pa = Object.getPrototypeOf([1][Symbol.iterator]());
       var pm = Object.getPrototypeOf(new Map([[1, 2]])[Symbol.iterator]());
       var ra = Object.getPrototypeOf(pa);
       var rm = Object.getPrototypeOf(pm);
       var score = 0;
       if (ra !== null && ra !== undefined) score += 1;
       if (rm !== null && rm !== undefined) score += 2;
       if (score === 3 && ra === rm) score += 4;
       var d = ra === null || ra === undefined ? undefined : Object.getOwnPropertyDescriptor(ra, Symbol.iterator);
       if (d !== undefined) score += 8;
       if (d !== undefined && typeof d.value === "function") score += 16;
       if (d !== undefined && d.value.name === "[Symbol.iterator]") score += 32;
       if (d !== undefined && d.value.length === 0) score += 64;
       if (d !== undefined && d.writable === true) score += 128;
       if (d !== undefined && d.enumerable === false) score += 256;
       if (d !== undefined && d.configurable === true) score += 512;
       // §27.1.2.1: "Return the this value" — unchanged, primitives included.
       if (d !== undefined && typeof d.value === "function") {
         var f: any = d.value;
         var o: any = {};
         if (f.call(o) === o) score += 1024;
         if (f.call(4) === 4) score += 2048;
       }
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(4095);
  });

  it('%ArrayIteratorPrototype% owns `next` with name "next" and length 0', async () => {
    const { value, hostImports } = await runStandalone(
      `var proto = Object.getPrototypeOf([][Symbol.iterator]());
       var d = Object.getOwnPropertyDescriptor(proto, "next");
       var score = 0;
       if (d !== undefined) score += 1;
       if (d !== undefined && typeof d.value === "function") score += 2;
       if (d !== undefined && d.value.name === "next") score += 4;
       if (d !== undefined && d.value.length === 0) score += 8;
       if (d !== undefined && d.writable === true) score += 16;
       if (d !== undefined && d.enumerable === false) score += 32;
       if (d !== undefined && d.configurable === true) score += 64;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(127);
  });

  it("`it.next` is readable as a VALUE off an iterator", async () => {
    const { value, hostImports } = await runStandalone(
      `var map = new Map([[1, 11]]);
       var set = new Set([1]);
       var arr: any = [1, 2, 3];
       var mNext: any = map.entries().next;
       var sNext: any = set.values().next;
       var aNext: any = Object.getPrototypeOf(arr[Symbol.iterator]()).next;
       var score = 0;
       if (typeof mNext === "function") score += 1;
       if (typeof sNext === "function") score += 2;
       if (typeof aNext === "function") score += 4;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(7);
  });

  it("the `next` closure is brand-checked: TypeError, never a trap", async () => {
    const { value, hostImports } = await runStandalone(
      `var map = new Map([[1, 11], [2, 22]]);
       var next: any = map.entries().next;
       var score = 0;
       // Five primitive receivers and a plain object must ALL throw a
       // catchable TypeError — a ref.cast trap is not catchable and would
       // abort the module instead of scoring here.
       var bad: any[] = [false, 1, "", undefined, null, {}];
       var thrown = 0;
       for (var i = 0; i < bad.length; i++) {
         try { next.call(bad[i]); } catch (e: any) { if (e instanceof TypeError) thrown++; }
       }
       if (thrown === 6) score += 1;
       // A genuine record of the SAME family steps.
       try {
         var r: any = next.call(map[Symbol.iterator]());
         if (r !== null && r !== undefined && r.done === false) score += 2;
       } catch (e: any) { /* scores nothing */ }
       // A genuine record of a DIFFERENT family is still a TypeError.
       var setNext: any = new Set([1]).values().next;
       try { setNext.call(map[Symbol.iterator]()); } catch (e: any) { if (e instanceof TypeError) score += 4; }
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(7);
  });

  // --- Order independence (adversarial review, 2026-09-16) -----------------
  //
  // `emitBuiltinGetPrototypeOfFallback` registers the resolver BEFORE it
  // compiles its argument (the #2043 shift discipline), so on the module's
  // FIRST `Object.getPrototypeOf(<iterator>)` the record runtime is not up yet.
  // The first cut declined there and answered the historical null — while the
  // identical expression one statement later answered a real prototype. Every
  // case above is immune by construction, because each builds its iterators in
  // earlier statements. These three are deliberately not.

  it("answers on the module's FIRST iterator-touching expression", async () => {
    const { value, hostImports } = await runStandalone(
      // Nothing above this line touches an iterator: no warm-up, no for-of.
      `var a: any = [1, 2, 3];
       var p: any = Object.getPrototypeOf(a[Symbol.iterator]());
       var m: any = new Map([[1, 2]]);
       var pm: any = Object.getPrototypeOf(m[Symbol.iterator]());
       var score = 0;
       if (p !== null && p !== undefined) score += 1;
       if (pm !== null && pm !== undefined) score += 2;
       if (score === 3 && p !== pm) score += 4;
       // The same expression later in the module must agree with the first one.
       if (Object.getPrototypeOf([9][Symbol.iterator]()) === p) score += 8;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(15);
  });

  it("a class METHOD reading `this.<field>` agrees with a direct read", async () => {
    // Methods are compiled before the top-level body, so the read inside
    // `protoInMethod` is the module's first occurrence — the same first-touch
    // decline, reached through a different compile order.
    const { value, hostImports } = await runStandalone(
      `class Holder {
         it: any;
         constructor(it: any) { this.it = it; }
         protoInMethod(): any { return Object.getPrototypeOf(this.it); }
       }
       var arr: any = [1, 2];
       var direct: any = Object.getPrototypeOf(arr[Symbol.iterator]());
       var h = new Holder(arr[Symbol.iterator]());
       var viaMethod: any = h.protoInMethod();
       var score = 0;
       if (direct !== null && direct !== undefined) score += 1;
       if (viaMethod !== null && viaMethod !== undefined) score += 2;
       if (score === 3 && viaMethod === direct) score += 4;
       // Reading the same field from OUTSIDE the class must agree too.
       var viaField: any = Object.getPrototypeOf(h.it);
       if (viaField !== null && viaField !== undefined && viaField === direct) score += 8;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(15);
  });

  it("a live cursor re-reads its length every step (externref carrier)", async () => {
    // §23.1.5.1 step 6: the length is re-read from the subject each step, and
    // the step body has no cached bound, so a record whose `vec` IS the
    // subject's storage observes growth. (A NUMBER-element array does not, and
    // that is the #3100 normalization copy, not this latch — see the residual
    // note on #6484; it is deliberately NOT pinned here, because pinning it
    // would lock in the wrong answer.)
    const { value, hostImports } = await runStandalone(
      `var a: any = ["a", "b"];
       var it: any = a[Symbol.iterator]();
       var steps = 0;
       var n = 0;
       while (steps < 6) {
         var r: any = it.next();
         if (r.done) break;
         n++;
         if (steps === 0) a.push("c");
         steps++;
       }
       // Exhaustion LATCHES: growth after done must not resume the cursor.
       a.push("d");
       var after: any = it.next();
       var score = n;
       if (after.done === true) score += 100;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(103);
  });

  it("an iterator VALUE still drives the eager helper loop (carrier migration)", async () => {
    // S2 migrated `arr[Symbol.iterator]()` from a snapshot `$Vec` to a live
    // `$__IterRec`. `__iter_hof_open` admitted the vec and not the record, so
    // `iter.reduce(cb, init)` answered `undefined` WITHOUT calling `cb` once —
    // silent, and it cost a test262 row that had been passing. The record is
    // now a pass-through handle there.
    const { value, hostImports } = await runStandalone(
      `var values = [1, 2, 3];
       var iter: any = values[Symbol.iterator]();
       var initialValue: any = { tag: 7 };
       var calls = 0;
       var firstMemoWasInitial = 0;
       var result: any = iter.reduce(function (memo: any, v: any) {
         if (calls === 0) firstMemoWasInitial = memo === initialValue ? 1 : 0;
         calls++;
         return v;
       }, initialValue);
       var score = 0;
       if (calls === 3) score += 1;
       if (firstMemoWasInitial === 1) score += 2;
       if (result === 3) score += 4;
       export function test(): number { return score; }`,
    );
    expect(hostImports).toEqual([]);
    expect(value).toBe(7);
  });
});
