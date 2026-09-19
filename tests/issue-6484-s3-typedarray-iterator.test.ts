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

  it("a plain-array receiver now carries a LIVE cursor (S1/S2's carrier migration)", async () => {
    // FLIPPED, exactly as this pin's own earlier text instructed. It used to
    // assert `[3,1,2][Symbol.iterator]().next()` was NULLISH — the snapshot-`$Vec`
    // carrier had no cursor — and it pinned that only to fence S3's scope: "If a
    // later slice gives the plain array a real cursor, this expectation FLIPS —
    // update it there rather than here." S1+S2 IS that slice: it made the carrier
    // migration general, so every array-typed `@@iterator` receiver answers a
    // live `$__IterRec`.
    //
    // The replacement is STRICTLY STRONGER than the nullish pin it replaces. The
    // old assertion is still recoverable — `firstIsNullish` is its exact
    // inverse — and a nullish `next()` cannot satisfy any other line here.
    // Stepping the whole sequence and asserting cursor INDEPENDENCE closes the
    // two ways a nominally "live" cursor can still be broken: one that restarts
    // from zero on every `next()`, and one shared across sites.
    const out = await runStandalone(`
      var arr = [3, 1, 2];
      var it = arr[Symbol.iterator]();
      var res: any = it.next();
      export function firstIsNullish(): boolean { return res === null || res === undefined; }
      export function firstValue(): number { return res.value as number; }
      export function firstNotDone(): boolean { return res.done === false; }
      export function stepsThenExhausts(): number {
        const i: any = arr[Symbol.iterator]();
        let r = 0;
        if ((i.next().value as number) === 3) r += 1;
        if ((i.next().value as number) === 1) r += 2;
        if ((i.next().value as number) === 2) r += 4;
        const end: any = i.next();
        if (end.value === undefined && end.done === true) r += 8;
        return r;
      }
      export function independentCursors(): number {
        // Two cursors over ONE array. A cursor shared between the sites would
        // make b.next() answer 1, and a restarting one would never let a reach 1.
        const a: any = arr[Symbol.iterator]();
        const b: any = arr[Symbol.iterator]();
        a.next();
        return (b.next().value as number) === 3 && (a.next().value as number) === 1 ? 1 : 0;
      }
    `);
    expect(out.firstIsNullish).toBe(0); // the OLD assertion, now inverted
    expect(out.firstValue).toBe(3);
    expect(out.firstNotDone).toBe(1); // a standalone `boolean` export is an i32
    expect(out.stepsThenExhausts).toBe(15);
    expect(out.independentCursors).toBe(1);
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

  it("Map/Set/String/Array iterator prototypes are four DISTINCT non-null singletons", async () => {
    // The runtime arm is `kind == ITER_KIND_VEC` only, so a Map/Set record
    // (ITER_KIND_MAPSET) must not be dragged onto `%ArrayIteratorPrototype%`.
    // Asserted INSIDE a module that also iterates a TypedArray — the only module
    // shape where the arm is emitted at all.
    //
    // CORRECTION (review round 2). The first version of this test was VACUOUS.
    // It asserted only `pm !== aip` / `ps !== aip`, in a module whose ONLY
    // Map/Set iterator queries were `any`-typed. Measured: in that module shape
    // `Object.getPrototypeOf(m.keys())` is `null` on base AND on branch, so both
    // assertions were `null !== <singleton>` — true whatever the arm does. The
    // test could not have caught the collapse it advertised, and its comment's
    // claim that Map/Set "keep their own singleton" described `null`.
    //
    // Fixing it needs TWO module shapes, because the shape decides which
    // mechanism answers and therefore which regression is reachable:
    //
    //   Shape A — Map/Set queried ONLY through `any`. The iterator stays a
    //     `$__IterRec`, so the RUNTIME route (`__iter_rec_proto`) is what
    //     answers.
    //
    //     UPDATED for S1 (this is the line the round-2 text predicted would
    //     flip: "when S1 gives these a real singleton this line SHOULD fail and
    //     be updated to match"). Shape A used to assert `dynIsNull === 3`,
    //     i.e. BOTH prototypes are `null` — which was the honest reading of the
    //     pre-S1 gap, but is a pin on a MISSING feature. S1's `family` field
    //     gives every record its real intrinsic, so the answer is now four
    //     genuine objects and the assertion below is object-vs-object.
    //
    //     It is STRONGER, not weaker, in the one way that matters here: two
    //     nulls compare EQUAL, so a distinctness bitmask alone would score full
    //     marks on a build that answered `null` for everything. Every identity
    //     bit is therefore PAIRED with a non-null bit for both of its operands,
    //     and the mask is only complete when all four families are present AND
    //     mutually distinct. Collapsing any pair — the `kind == ITER_KIND_VEC`
    //     widening the old comment described, or a regression to `null` — clears
    //     bits and fails.
    //
    //   Shape B — the SAME question with the static type left visible:
    //     `Object.getPrototypeOf(m.keys())` directly, whose argument still has
    //     type `MapIterator`. That reaches the REAL singletons, so every
    //     comparison is object-vs-object. This shape guards the singleton
    //     machinery itself: a collapse onto the AIP, onto `null`, or of Map onto
    //     Set clears a bit.
    //
    // Shape B alone is NOT enough — the round-2 first attempt used only it, and
    // with the kind narrowing defeated it still passed, because in that shape the
    // runtime arm is not on the path at all.
    const shapeA = await runStandalone(`
      const ta = new Int8Array([1, 2]);
      const m = new Map<number, number>(); m.set(1, 2);
      const s = new Set<number>(); s.add(3);
      const str = "ab";
      export function tipIsAip(): number {
        const aip: any = Object.getPrototypeOf([].values());
        const tip: any = Object.getPrototypeOf(ta[Symbol.iterator]());
        return tip === aip && aip !== null ? 1 : 0;
      }
      export function dynFourDistinct(): number {
        // The any-typed LOCAL is load-bearing. Passing m.keys() straight into
        // Object.getPrototypeOf keeps its static MapIterator type, which fires
        // the #3013 COMPILE-TIME arm and never reaches the runtime one. Binding
        // it to an any local first erases the type -- which is what every
        // test262 program does, and the whole subject of this issue.
        const aip: any = Object.getPrototypeOf([].values());
        const mi: any = m.keys();
        const si: any = s.values();
        const sti: any = str[Symbol.iterator]();
        const pm: any = Object.getPrototypeOf(mi);
        const ps: any = Object.getPrototypeOf(si);
        const pst: any = Object.getPrototypeOf(sti);
        let r = 0;
        // NON-NULLNESS FIRST. Every distinctness bit below is paired with these,
        // because two nulls compare EQUAL: a build that answered null for all
        // four would score every "!==" bit if they stood alone.
        if (aip !== null) r += 1;
        if (pm !== null) r += 2;
        if (ps !== null) r += 4;
        if (pst !== null) r += 8;
        // ...THEN distinctness: four families, four different singletons. The
        // ITER_KIND_VEC widening collapses Map/Set onto the AIP (clears 16/32);
        // a family field that ignored STRING collapses it too (clears 64).
        if (pm !== aip) r += 16;
        if (ps !== aip) r += 32;
        if (pst !== aip) r += 64;
        if (pm !== ps) r += 128;
        if (pm !== pst) r += 256;
        if (ps !== pst) r += 512;
        return r;
      }
    `);
    expect(shapeA.tipIsAip).toBe(1);
    // All ten bits. Four real objects (Array / Map / Set / String iterator
    // prototypes), pairwise distinct, reached through an `any` local -- i.e. via
    // the RUNTIME route, which is the one an ordinary test262 program takes.
    expect(shapeA.dynFourDistinct).toBe(1023);

    const shapeB = await runStandalone(`
      const ta = new Int8Array([1, 2]);
      const m = new Map<number, number>(); m.set(1, 2);
      const s = new Set<number>(); s.add(3);
      export function tipIsAip(): number {
        const aip: any = Object.getPrototypeOf([].values());
        const tip: any = Object.getPrototypeOf(ta[Symbol.iterator]());
        return tip === aip && aip !== null ? 1 : 0;
      }
      export function staticNonNull(): number {
        // Statically-typed argument -> the #3013 compile-time arm -> the REAL
        // %MapIteratorPrototype% / %SetIteratorPrototype% singletons.
        const aip: any = Object.getPrototypeOf([].values());
        const pm: any = Object.getPrototypeOf(m.keys());
        const ps: any = Object.getPrototypeOf(s.values());
        let r = 0;
        if (aip !== null) r += 1;
        if (pm !== null) r += 2;
        if (ps !== null) r += 4;
        return r;
      }
      export function distinctFromAip(): number {
        const aip: any = Object.getPrototypeOf([].values());
        const pm: any = Object.getPrototypeOf(m.keys());
        const ps: any = Object.getPrototypeOf(s.values());
        let r = 0;
        if (pm !== null) r += 1;
        if (ps !== null) r += 2;
        if (pm !== aip) r += 4;
        if (ps !== aip) r += 8;
        if (pm !== ps) r += 16;
        return r;
      }
    `);
    expect(shapeB.tipIsAip).toBe(1);
    expect(shapeB.staticNonNull).toBe(7);
    // No bit here can be satisfied by a null.
    expect(shapeB.distinctFromAip).toBe(31);
  });

  it("Object.prototype.toString on the diverted iterator returns a value, not a throw", async () => {
    // REGRESSION PIN (review round 2). Swapping the snapshot `$Vec` for a
    // `$__IterRec` removed the receiver from every arm of the §20.1.3.6
    // classifier, so it fell through to the refusal tail: base answered the
    // STRING "[object Array]" (length 14) and the branch THREW a catchable
    // TypeError. A value turning into a throw is a regression even though no
    // test262 row under built-ins/TypedArray/prototype/{Symbol.iterator,values,
    // keys,entries} asks for the iterator's class tag.
    //
    // The answer is `[object Array Iterator]`, not base's `[object Array]`:
    // §23.2.3.36 makes this an Array Iterator, and the same module already hands
    // out `%ArrayIteratorPrototype%` as its [[Prototype]] — a tag of "Array"
    // would contradict that.
    const out = await runStandalone(`
      const ta = new Int8Array([1, 2]);
      export function tagLen(): number {
        // Uncaught on purpose: a throw here fails the test rather than being
        // scored as one more bitmask value.
        const it: any = ta[Symbol.iterator]();
        const s: any = Object.prototype.toString.call(it);
        return (s as string).length;
      }
      export function isArrayIteratorTag(): number {
        const it: any = ta[Symbol.iterator]();
        const s: any = Object.prototype.toString.call(it);
        return s === "[object Array Iterator]" ? 1 : 0;
      }
      export function stepsStillWork(): number {
        const it: any = ta[Symbol.iterator]();
        const a: any = it.next();
        return a.value === 1 ? 1 : 0;
      }
    `);
    expect(out.tagLen).toBe("[object Array Iterator]".length);
    expect(out.isArrayIteratorTag).toBe(1);
    expect(out.stepsStillWork).toBe(1);
  });

  it("the class-tag arm does not disturb neighbouring receivers", async () => {
    // The arm is spliced into a SHARED classifier body, so the controls matter
    // more than the fix: a NON-iterator receiver must keep its exact base answer.
    //
    // UPDATED for the S1+S2 merge and the family-driven arm that replaces S3's
    // `kind == ITER_KIND_VEC` one. Two lines here pinned base answers that base
    // only gave because the receiver was the WRONG OBJECT:
    //
    //   * a plain-array iterator read "[object Array]" on base because it WAS a
    //     snapshot `$Vec` answering for itself. S1+S2 makes it a real
    //     `$__IterRec`, and `Array.prototype[@@iterator]` IS `.values`, i.e.
    //     CreateArrayIterator (§23.1.5.1) — an Array Iterator — so the tag is
    //     "[object Array Iterator]".
    //     "[object Array]" would also contradict the `%ArrayIteratorPrototype%`
    //     this same module hands out as that object's [[Prototype]].
    //   * a Map iterator REFUSED (threw) on base. A throw where §20.1.3.6
    //     specifies a string is a defect, not a contract; S1's `family` field
    //     supplies "[object Map Iterator]" and the refusal is closed.
    //
    // The genuine neighbours — a plain object, a plain array — are asserted
    // unchanged, and are what would catch the arm over-reaching.
    const out = await runStandalone(`
      const ta = new Int8Array([1, 2]);
      const arr = [1, 2, 3];
      const m = new Map<number, number>(); m.set(1, 2);
      export function armed(): number {
        const it: any = ta[Symbol.iterator]();
        const a: any = it.next();
        return a.value === 1 ? 1 : 0;
      }
      export function plainArrayIteratorTag(): number {
        const it: any = arr[Symbol.iterator]();
        const s: any = Object.prototype.toString.call(it);
        return s === "[object Array Iterator]" ? 1 : 0;
      }
      export function plainObjectTag(): number {
        const o: any = { a: 1 };
        const s: any = Object.prototype.toString.call(o);
        return s === "[object Object]" ? 1 : 0;
      }
      export function plainArrayTag(): number {
        const a: any = arr;
        const s: any = Object.prototype.toString.call(a);
        return s === "[object Array]" ? 1 : 0;
      }
      export function mapIteratorTag(): number {
        // Was mapIteratorStillRefuses, pinning base's THROW. The family-driven
        // arm answers instead — and answers Map, not Array, which is the bit
        // that would catch a collapse onto %ArrayIteratorPrototype%'s tag.
        const it: any = m.keys();
        const s: any = Object.prototype.toString.call(it);
        return s === "[object Map Iterator]" ? 1 : 0;
      }
      export function neitherIteratorTagIsPlain(): number {
        // Cross-check: neither iterator may fall back to a non-iterator tag.
        const ai: any = arr[Symbol.iterator]();
        const mi: any = m.keys();
        const sa: any = Object.prototype.toString.call(ai);
        const sm: any = Object.prototype.toString.call(mi);
        return sa !== "[object Array]" && sm !== "[object Array]" && sa !== sm ? 1 : 0;
      }
    `);
    expect(out.armed).toBe(1);
    expect(out.plainArrayIteratorTag).toBe(1);
    expect(out.plainObjectTag).toBe(1);
    expect(out.plainArrayTag).toBe(1);
    expect(out.mapIteratorTag).toBe(1);
    expect(out.neitherIteratorTagIsPlain).toBe(1);
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
