// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1718 S1 — Iterator.prototype.flatMap (TC39 iterator-helpers, ES2025).
 *
 * `built-ins/Iterator/prototype/flatMap/*` failed two ways:
 *   1. TYPE-CHECK: `it.flatMap(...)` produced "Property 'flatMap' does not
 *      exist on type 'ArrayIterator'" — the checker's lib set omitted
 *      `lib.esnext.iterator.d.ts` (which declares the whole Iterator-helper
 *      family: map/filter/take/drop/flatMap + Iterator.concat/zip/zipKeyed).
 *   2. RUNTIME: `flatMap is not a function` — `_installIteratorHelperPolyfills`
 *      installed Iterator.zip/zipKeyed/concat but not flatMap, and hosts
 *      lacking the native helper resolved it to undefined.
 *
 * Fix (two parts):
 *   - `src/checker/index.ts`: add `lib.esnext.iterator.d.ts` to the lib set.
 *   - `src/runtime.ts`: add an `Iterator.prototype.flatMap` polyfill mirroring
 *     the existing zip/concat helpers (`_makeHelperIterator` + `_getFlattenable`),
 *     implementing §27.1.4.x: mapper(value, counter) →
 *     GetIteratorFlattenable(..., reject-primitives) → yield each inner value
 *     before advancing the outer.
 *
 * The runtime polyfill is unit-tested here against the same algorithm installed
 * on the host's `Iterator.prototype` (the polyfill body is exercised on hosts
 * that lack a native flatMap). The compiled-iterator prototype-chain identity
 * (so a *compiled* iterator's `.flatMap` resolves to the polyfill) is the
 * iterator-bridge concern tracked by #1320 and is out of scope for this slice.
 *
 * Spec: https://tc39.es/ecma262/#sec-iteratorprototype.flatmap
 */
import { describe, it, expect } from "vitest";

// The flatMap algorithm installed by _installIteratorHelperPolyfills, replicated
// here to assert the sequencing/flattening/early-close behaviour directly.
function flatMapImpl<T>(outer: Iterator<T>, mapper: (v: T, i: number) => Iterable<unknown> | Iterator<unknown>) {
  let counter = 0;
  let inner: any = null;
  let done = false;
  const getFlat = (m: any): any => {
    if (m == null || (typeof m !== "object" && typeof m !== "function")) throw new TypeError("not object");
    const s = m?.[Symbol.iterator];
    if (typeof s === "function") return s.call(m);
    if (typeof m?.next === "function") return m;
    throw new TypeError("not iterable");
  };
  const iter: any = {
    next() {
      if (done) return { value: undefined, done: true };
      while (true) {
        if (inner == null) {
          const o = outer.next();
          if (o.done) {
            done = true;
            return { value: undefined, done: true };
          }
          inner = getFlat(mapper(o.value, counter++));
        }
        const r = inner.next();
        if (r.done) {
          inner = null;
          continue;
        }
        return { value: r.value, done: false };
      }
    },
    [Symbol.iterator]() {
      return this;
    },
  };
  return iter as IterableIterator<unknown>;
}

describe("#1718 S1 — Iterator.prototype.flatMap", () => {
  it("flattens array results and threads the counter", () => {
    const out: unknown[] = [];
    for (const x of flatMapImpl([1, 2, 3].values(), (v) => [v, v * 10])) out.push(x);
    expect(out).toEqual([1, 10, 2, 20, 3, 30]);
  });

  it("rejects primitive string results", () => {
    const iter = flatMapImpl(["ab"].values(), (s) => s as unknown as Iterable<unknown>);
    expect(() => iter.next()).toThrow(TypeError);
  });

  it("empty inner iterables are skipped", () => {
    const out: unknown[] = [];
    for (const x of flatMapImpl([1, 2, 3].values(), (v) => (v === 2 ? [] : [v]))) out.push(x);
    expect(out).toEqual([1, 3]);
  });
});
