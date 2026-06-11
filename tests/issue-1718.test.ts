// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildImports } from "../src/runtime.ts";

let I: any;
const restoreDescriptors: Array<{ target: any; key: PropertyKey; desc: PropertyDescriptor }> = [];

function removeForPolyfill(target: any, key: PropertyKey): void {
  const desc = Object.getOwnPropertyDescriptor(target, key);
  if (!desc) return;
  restoreDescriptors.push({ target, key, desc });
  if (desc.configurable) {
    delete target[key];
  } else if (desc.writable) {
    target[key] = undefined;
  }
}

beforeAll(() => {
  const IteratorCtor = (globalThis as any).Iterator;
  if (typeof IteratorCtor === "function") {
    removeForPolyfill(IteratorCtor, "zip");
    removeForPolyfill(IteratorCtor, "zipKeyed");
    removeForPolyfill(IteratorCtor, "concat");
    if (IteratorCtor.prototype) removeForPolyfill(IteratorCtor.prototype, "flatMap");
  }
  buildImports([], undefined, []);
  I = (globalThis as any).Iterator;
});

afterAll(() => {
  for (const { target, key, desc } of restoreDescriptors.reverse()) {
    Object.defineProperty(target, key, desc);
  }
});

describe("#1718 Iterator.concat", () => {
  it("gets @@iterator once at helper creation and opens lazily", () => {
    let gets = 0;
    let calls = 0;
    const iterable: any = {};
    Object.defineProperty(iterable, Symbol.iterator, {
      get() {
        gets++;
        return function iterator() {
          calls++;
          return [1, 2][Symbol.iterator]();
        };
      },
    });

    const helper = I.concat(iterable);
    expect(gets).toBe(1);
    expect(calls).toBe(0);
    expect(Array.from(helper)).toEqual([1, 2]);
    expect(gets).toBe(1);
    expect(calls).toBe(1);
  });

  it("rejects primitive iterable arguments", () => {
    expect(() => I.concat("ab")).toThrow(TypeError);
  });

  it("returns fresh iterator result objects", () => {
    const innerResult = { value: 7, done: false };
    let count = 0;
    const iterable = {
      [Symbol.iterator]() {
        return {
          next() {
            return count++ === 0 ? innerResult : { value: undefined, done: true };
          },
        };
      },
    };

    const result = I.concat(iterable).next();
    expect(result).toEqual({ value: 7, done: false });
    expect(result).not.toBe(innerResult);
  });
});

describe("#1718 Iterator.zip", () => {
  it("rejects primitive outer inputs and primitive inner values", () => {
    expect(() => I.zip("ab")).toThrow(TypeError);
    expect(() => I.zip(["ab"])).toThrow(TypeError);
  });

  it("validates mode and longest-mode padding options eagerly", () => {
    expect(() => I.zip([], { mode: "" })).toThrow(TypeError);
    expect(() => I.zip([], { mode: "longest", padding: 0 })).toThrow(TypeError);
  });

  it("pads longest-mode tuples with undefined when no padding iterable is supplied", () => {
    expect(Array.from(I.zip([[1], [2, 3]], { mode: "longest" }))).toEqual([
      [1, 2],
      [undefined, 3],
    ]);
  });

  it("throws TypeError for strict-mode length mismatch", () => {
    const iter = I.zip([[1], [2, 3]], { mode: "strict" });
    expect(iter.next()).toEqual({ value: [1, 2], done: false });
    expect(() => iter.next()).toThrow(TypeError);
  });
});

describe("#1718 Iterator.zipKeyed", () => {
  it("includes enumerable symbol keys, skips undefined values, and yields null-prototype objects", () => {
    const sym = Symbol("s");
    const iterables: any = { a: [1, 2], skip: undefined };
    Object.defineProperty(iterables, sym, { value: [3, 4], enumerable: true });

    const out = Array.from(I.zipKeyed(iterables)) as any[];
    expect(out.map((row) => [row.a, row[sym]])).toEqual([
      [1, 3],
      [2, 4],
    ]);
    expect(Object.getPrototypeOf(out[0])).toBe(null);
    expect("skip" in out[0]).toBe(false);
    expect(Object.getOwnPropertySymbols(out[0])).toEqual([sym]);
  });

  it("uses keyed longest-mode padding objects", () => {
    const out = Array.from(I.zipKeyed({ a: [1], b: [2, 3] }, { mode: "longest", padding: { a: 10 } })) as any[];
    expect(out.map((row) => [row.a, row.b])).toEqual([
      [1, 2],
      [10, 3],
    ]);
  });
});

describe("#1718 Iterator.prototype.flatMap", () => {
  it("rejects primitive mapper results, including iterable strings", () => {
    const helper = I.prototype.flatMap.call([1][Symbol.iterator](), () => "ab");
    expect(() => helper.next()).toThrow(TypeError);
  });
});
