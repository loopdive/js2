// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6492 round 4c — `Iterator.prototype.chunks` / `.windows` (Iterator Chunking).
//
// Round 4b predicted that `Iterator/prototype/{chunks,windows}/
// next-method-returns-non-object.js` would pass on CI because CI's Node would
// supply the methods. It does not: checked 2026-09-17, NEITHER the container's
// Node 22.22 nor Node 25.9 (`npx -y node@25`, the version CI pins) has
// `Iterator.prototype.chunks`/`.windows` — `Iterator`'s only own static in both
// is `from`. Both rows' pre-4b "pass" was accidental: with `chunks` absent,
// `new Sub().chunks(1)` returned `null` and the TypeError the test asserts came
// from the NEXT line (`iterator.next()` on null).
//
// So js2 implements them. These cases are host-side (the polyfill is installed
// by `buildImports`), which is what makes them fast and what makes them
// verifiable on a Node that ships nothing to defer to.
//
// Real-runner measurement over all 654 rows of `built-ins/Iterator/`:
// linked 352 → 394, honest 355 → 397, zero rows lost in either lane.

import { beforeAll, describe, expect, it } from "vitest";

import { buildImports } from "../src/runtime.js";

/** The intrinsic the polyfill installs onto, as the compiled body reaches it. */
let IteratorProto: any;

function iterOf(values: readonly unknown[]): any {
  let i = 0;
  const it: any = {
    next: () => (i < values.length ? { value: values[i++], done: false } : { value: undefined, done: true }),
  };
  Object.setPrototypeOf(it, IteratorProto);
  return it;
}

const drain = (it: any): unknown[] => {
  const out: unknown[] = [];
  for (;;) {
    const r = it.next();
    if (r.done) return out;
    out.push(r.value);
  }
};

describe("#6492 r4c — Iterator Chunking (chunks / windows)", () => {
  beforeAll(() => {
    // `buildImports` is the seam that installs the helper polyfills.
    buildImports([] as never, undefined, undefined as never);
    IteratorProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  });

  it("installs both with spec descriptors (neither Node 22 nor Node 25 ships them)", () => {
    for (const name of ["chunks", "windows"] as const) {
      expect(typeof IteratorProto[name]).toBe("function");
      expect(IteratorProto[name].name).toBe(name);
      expect(IteratorProto[name].length).toBe(1);
      const desc = Object.getOwnPropertyDescriptor(IteratorProto, name)!;
      expect(desc.enumerable).toBe(false);
      expect(desc.writable).toBe(true);
      expect(desc.configurable).toBe(true);
    }
  });

  it("chunks: even split, partial tail, size 1, size larger than the source", () => {
    expect(drain(iterOf([0, 1, 2, 3]).chunks(2))).toEqual([
      [0, 1],
      [2, 3],
    ]);
    // The trailing partial chunk IS yielded — this is where `windows` differs.
    expect(drain(iterOf([0, 1, 2]).chunks(2))).toEqual([[0, 1], [2]]);
    expect(drain(iterOf([0, 1]).chunks(1))).toEqual([[0], [1]]);
    expect(drain(iterOf([0, 1]).chunks(100))).toEqual([[0, 1]]);
    expect(drain(iterOf([]).chunks(2))).toEqual([]);
  });

  it("windows: slides by one, and a short source yields nothing by default", () => {
    expect(drain(iterOf([0, 1, 2, 3]).windows(2))).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(drain(iterOf([0, 1]).windows(100))).toEqual([]);
    expect(drain(iterOf([0, 1]).windows(100, "only-full"))).toEqual([]);
    expect(drain(iterOf([0, 1]).windows(100, undefined))).toEqual([]);
    // "allow-partial" yields the short buffer exactly once.
    expect(drain(iterOf([0, 1]).windows(100, "allow-partial"))).toEqual([[0, 1]]);
    expect(drain(iterOf([]).windows(2, "allow-partial"))).toEqual([]);
  });

  it("validates the size WITHOUT coercing it, and separates TypeError from RangeError", () => {
    for (const bad of [undefined, "1", true, null, {}, [2], Number.NaN, 0.5, Number.POSITIVE_INFINITY]) {
      expect(() => iterOf([]).chunks(bad as never)).toThrow(TypeError);
      expect(() => iterOf([]).windows(bad as never)).toThrow(TypeError);
    }
    // A valid Number outside [1, 2**32-1] is a RangeError, not a TypeError.
    for (const bad of [0, -0, -1, 2 ** 32, 2 ** 53]) {
      expect(() => iterOf([]).chunks(bad)).toThrow(RangeError);
      expect(() => iterOf([]).windows(bad)).toThrow(RangeError);
    }
    expect(() => iterOf([]).chunks(1)).not.toThrow();
    expect(() => iterOf([]).chunks(2 ** 32 - 1)).not.toThrow();
    // No `valueOf` coercion is attempted.
    let coerced = 0;
    const sneaky = {
      valueOf() {
        coerced++;
        return 2;
      },
    };
    expect(() => iterOf([]).chunks(sneaky as never)).toThrow(TypeError);
    expect(coerced).toBe(0);
  });

  it("windows: `undersized` is one of two strings, checked without coercion", () => {
    for (const bad of [null, "", "something else", 0, true, false, {}, Symbol()]) {
      expect(() => iterOf([]).windows(1, bad as never)).toThrow(TypeError);
    }
  });

  it("a non-object iterator result is a TypeError — the row this round exists for", () => {
    const it: any = { next: () => null };
    Object.setPrototypeOf(it, IteratorProto);
    expect(() => it.chunks(1).next()).toThrow(TypeError);
    const it2: any = { next: () => 42 };
    Object.setPrototypeOf(it2, IteratorProto);
    expect(() => it2.windows(1).next()).toThrow(TypeError);
  });

  it("reads the `next` method exactly once, at helper-creation time", () => {
    let reads = 0;
    let i = 0;
    const it: any = {
      get next() {
        reads++;
        return () => (i < 3 ? { value: i++, done: false } : { value: undefined, done: true });
      },
    };
    Object.setPrototypeOf(it, IteratorProto);
    const helper = it.chunks(1);
    expect(reads).toBe(1);
    drain(helper);
    expect(reads).toBe(1);
  });

  it("`return()` forwards to the underlying iterator", () => {
    let closed = 0;
    const it: any = {
      next: () => ({ value: 1, done: false }),
      return: () => {
        closed++;
        return { value: undefined, done: true };
      },
    };
    Object.setPrototypeOf(it, IteratorProto);
    const helper = it.windows(2);
    helper.next();
    helper.return();
    expect(closed).toBe(1);
  });
});
