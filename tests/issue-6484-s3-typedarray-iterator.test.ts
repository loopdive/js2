// #6484 S3 — `new Int8Array([1,2])[Symbol.iterator]()` under `--target standalone`.
//
// TWO independent defects, both pinned here.
//
// 1. DYNAMIC (`any`) receiver — the native `__iterator` dispatcher's vec-family
//    carrier collector borrowed `NON_ARRAY_BYTE_VEC_ELEM_KINDS` as its filter.
//    That set is an **IsArray classification** set (§7.2.2:
//    `Array.isArray(new Int8Array(1)) === false`), not an iterability set, so
//    the packed TypedArray element carriers `i8_byte` / `i16_byte` / `i32_elem`
//    matched no family arm, control fell through to the §7.4.1 tail and the
//    program threw `TypeError: value is not iterable` — for a value
//    §23.2.3.36 says IS iterable. (The float views share the generic `f64`
//    carrier, so they were already admitted; only the seven integer views threw.)
//
// 2. STATIC receiver — `var array = new Int8Array([3,1,2])` is NOT `any`, so
//    `array[Symbol.iterator]()` took the snapshot-`$Vec` producer, which has no
//    cursor: `iterator.next()` answered null and `result.value` threw
//    "Cannot access property on null or undefined". A TypedArray receiver now
//    routes through `__iterator`, producing a real `$__IterRec`. Scoped to
//    TypedArray: a PLAIN-array receiver deliberately keeps the vec carrier, so
//    the #3013 `%ArrayIteratorPrototype%` identity rows are untouched.
//
// Every case asserts `result.imports` is `[]` — standalone must stay host-free.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

const VIEWS = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
] as const;

async function run(source: string, target: "standalone" | "wasi"): Promise<Record<string, unknown>> {
  const r = await compile(source, { fileName: "test.ts", target });
  expect(r.success, JSON.stringify(r.errors?.slice(0, 3))).toBe(true);
  // Host-free lane: a single leaked import makes the module unusable standalone.
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as Record<string, (...a: unknown[]) => unknown>;
  if (typeof ex._start === "function") ex._start();
  const out: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(ex)) {
    if (name === "_start" || typeof fn !== "function" || name.includes("\0")) continue;
    out[name] = fn();
  }
  return out;
}

async function runStandalone(source: string): Promise<Record<string, unknown>> {
  return run(source, "standalone");
}

describe("#6484 S3 — TypedArray [Symbol.iterator]() steps under standalone", () => {
  for (const view of VIEWS) {
    it(`dynamic (any) receiver: new ${view}([3,1,2])[Symbol.iterator]() iterates`, async () => {
      // The `any` annotation is load-bearing: every test262 program is plain JS,
      // so the checker proves nothing and this is the path that threw.
      const out = await runStandalone(`
        const ta: any = new ${view}([3, 1, 2]);
        const it: any = ta[Symbol.iterator]();
        let acc = 0;
        let r: any = it.next();
        acc += (r.value as number) * 100;
        r = it.next();
        acc += (r.value as number) * 10;
        r = it.next();
        acc += r.value as number;
        r = it.next();
        const doneUndef = r.value === undefined && r.done === true;
        r = it.next();
        const repeatUndef = r.value === undefined && r.done === true;
        export function digits(): number { return acc; }
        export function exhausted(): boolean { return doneUndef; }
        export function exhaustedAgain(): boolean { return repeatUndef; }
      `);
      expect(out.digits).toBe(312);
      expect(out.exhausted).toBe(1); // a standalone `boolean` export is an i32
      expect(out.exhaustedAgain).toBe(1); // a standalone `boolean` export is an i32
    });

    it(`static receiver: var array = new ${view}(...) — iterator.next() has a cursor`, async () => {
      // Exactly the shape the test262 wrapper produces for
      // built-ins/ArrayIteratorPrototype/next/<View>Array.js.
      const out = await runStandalone(`
        var array = new ${view}([3, 1, 2]);
        var iterator = array[Symbol.iterator]();
        var result: any;
        result = iterator.next();
        const v1 = result.value as number;
        const d1 = result.done as boolean;
        result = iterator.next();
        const v2 = result.value as number;
        result = iterator.next();
        const v3 = result.value as number;
        result = iterator.next();
        const doneUndef = result.value === undefined && result.done === true;
        export function first(): number { return v1; }
        export function firstNotDone(): boolean { return d1 === false; }
        export function second(): number { return v2; }
        export function third(): number { return v3; }
        export function exhausted(): boolean { return doneUndef; }
      `);
      expect(out.first).toBe(3);
      expect(out.firstNotDone).toBe(1); // a standalone `boolean` export is an i32
      expect(out.second).toBe(1);
      expect(out.third).toBe(2);
      expect(out.exhausted).toBe(1); // a standalone `boolean` export is an i32
    });
  }

  it("the same site executed twice yields two independent cursors", async () => {
    // A helper that caches its result in a module global would make the second
    // iterator resume where the first stopped (#5349 r4 → r5 hazard).
    const out = await runStandalone(`
      var array = new Int8Array([3, 1, 2]);
      function firstOf(it: any): number { return it.next().value as number; }
      const a = firstOf(array[Symbol.iterator]());
      const b = firstOf(array[Symbol.iterator]());
      const dyn: any = array;
      const c = firstOf(dyn[Symbol.iterator]());
      export function firstA(): number { return a; }
      export function firstB(): number { return b; }
      export function firstDyn(): number { return c; }
    `);
    expect(out.firstA).toBe(3);
    expect(out.firstB).toBe(3);
    expect(out.firstDyn).toBe(3);
  });

  it("for-of over an `any`-held TypedArray no longer throws 'not iterable'", async () => {
    const out = await runStandalone(`
      const ta: any = new Uint16Array([1, 2, 3]);
      let n = 0;
      for (const v of ta) { n += v as number; }
      export function sum(): number { return n; }
    `);
    expect(out.sum).toBe(6);
  });

  it("ArrayBuffer and DataView stay NON-iterable (the i32_byte carrier is not admitted)", async () => {
    // The fix narrows the iterability filter to `i32_byte` — the raw
    // ArrayBuffer/DataView byte store — which must keep throwing a CATCHABLE
    // §7.4.1 TypeError, never iterate and never trap.
    const out = await runStandalone(`
      const ab: any = new ArrayBuffer(4);
      const dv: any = new DataView(new ArrayBuffer(4));
      let abThrew = false;
      let dvThrew = false;
      try { ab[Symbol.iterator](); } catch (e: any) { abThrew = String(e.name) === "TypeError"; }
      try { dv[Symbol.iterator](); } catch (e: any) { dvThrew = String(e.name) === "TypeError"; }
      export function arrayBufferThrowsTypeError(): boolean { return abThrew; }
      export function dataViewThrowsTypeError(): boolean { return dvThrew; }
    `);
    expect(out.arrayBufferThrowsTypeError).toBe(1); // a standalone `boolean` export is an i32
    expect(out.dataViewThrowsTypeError).toBe(1); // a standalone `boolean` export is an i32
  });

  it("a plain-array receiver keeps the snapshot-vec carrier (S1/S2's to migrate)", async () => {
    // Deliberate scope pin, NOT an endorsement: `[1,2][Symbol.iterator]().next()`
    // still answers null because the plain-array arm was left byte-identical so
    // the #3013 %ArrayIteratorPrototype% identity rows could not move. If a later
    // slice gives the plain array a real cursor, this expectation FLIPS — update
    // it there rather than here.
    const out = await runStandalone(`
      var arr = [3, 1, 2];
      var it = arr[Symbol.iterator]();
      var res: any = it.next();
      export function plainNextIsNullish(): boolean { return res === null || res === undefined; }
    `);
    expect(out.plainNextIsNullish).toBe(1); // a standalone `boolean` export is an i32
  });

  // ── review round 1 ──────────────────────────────────────────────────────────

  it("the diverted iterator reports %ArrayIteratorPrototype%, not null", async () => {
    // REGRESSION PIN. The divert replaces a snapshot `$Vec` with a `$__IterRec`,
    // and the record models no [[Prototype]] — so an `any`-typed binding of it
    // answered `null` from `Object.getPrototypeOf`. §23.2.3.36 makes a TypedArray
    // iterator an Array Iterator, so the answer is the ONE #3013
    // `%ArrayIteratorPrototype%` singleton `[].values()` reports. Bitmask, so a
    // `null === null` tautology cannot read as a pass.
    const out = await runStandalone(`
      const ta = new Int8Array([1, 2]);
      const arr = [1, 2];
      export function bits(): number {
        const it: any = ta[Symbol.iterator]();
        const p: any = Object.getPrototypeOf(it);
        const aip: any = Object.getPrototypeOf([].values());
        let r = 0;
        if (p === null) r += 1;
        if (aip === null) r += 2;
        if (p === aip) r += 4;
        if (p === Object.getPrototypeOf(arr)) r += 8;
        return r;
      }
      export function twice(): number {
        // The singleton is cached in a module global; a site that only works on
        // its first execution is the #5349 r4 → r5 hazard.
        let n = 0;
        for (let i = 0; i < 2; i++) {
          const it: any = ta[Symbol.iterator]();
          const p: any = Object.getPrototypeOf(it);
          if (p !== null && p === Object.getPrototypeOf([].values())) n += 1;
        }
        return n;
      }
    `);
    expect(out.bits).toBe(4); // not null, IS %ArrayIteratorPrototype%, is NOT %Array.prototype%
    expect(out.twice).toBe(2);
  });

  it("Map/Set iterator prototypes do NOT collapse onto %ArrayIteratorPrototype%", async () => {
    // The runtime arm is `kind == ITER_KIND_VEC` only, so a Map/Set record
    // (ITER_KIND_MAPSET) keeps its own singleton — the distinctness #3013 asks
    // for. Asserted INSIDE a module that also iterates a TypedArray, which is
    // the only module shape where the arm is emitted at all.
    const out = await runStandalone(`
      const ta = new Int8Array([1, 2]);
      const m = new Map<number, number>(); m.set(1, 2);
      const s = new Set<number>(); s.add(3);
      export function distinct(): number {
        const aip: any = Object.getPrototypeOf([].values());
        const tip: any = Object.getPrototypeOf(ta[Symbol.iterator]());
        const mi: any = m.keys();
        const si: any = s.values();
        const pm: any = Object.getPrototypeOf(mi);
        const ps: any = Object.getPrototypeOf(si);
        let r = 0;
        if (tip === aip && aip !== null) r += 1;
        if (pm !== aip) r += 2;
        if (ps !== aip) r += 4;
        return r;
      }
    `);
    expect(out.distinct).toBe(7);
  });

  it("the static receiver also steps under --target wasi", async () => {
    // WASI is the other no-JS-host lane and the divert's guard names it, but the
    // #5147 native-iterator `.next()` arm in closed-method-dispatch.ts was gated
    // `ctx.standalone` alone — so `iterator.next()` threw `next is not a
    // function` under wasi while standalone answered. Map/Set hid the gap: they
    // carry their own `__extern_method_call` arm.
    const out = await run(
      `
        var array = new Int8Array([3, 1, 2]);
        var iterator = array[Symbol.iterator]();
        var result: any = iterator.next();
        const v1 = result.value as number;
        result = iterator.next();
        const v2 = result.value as number;
        const dyn: any = array;
        const dynIt: any = dyn[Symbol.iterator]();
        const v3 = dynIt.next().value as number;
        export function first(): number { return v1; }
        export function second(): number { return v2; }
        export function dynFirst(): number { return v3; }
      `,
      "wasi",
    );
    expect(out.first).toBe(3);
    expect(out.second).toBe(1);
    expect(out.dynFirst).toBe(3);
  });
});
