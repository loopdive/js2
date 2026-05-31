// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1514 — Set.prototype set-methods (union, intersection, difference,
// symmetricDifference, isSubsetOf, isSupersetOf, isDisjointFrom) currently
// return real JS Set externrefs. Spreading those externrefs into an array
// literal (`[...combined]`) used to drop the value silently because the
// array-literal spread codegen only handled wasm vec sources, not externref
// iterables — so `[...new Set([1,2,3])]` produced an empty array.
//
// This test ensures that array-spread now materialises any externref
// iterable (Set, Map, generator, JS Array, ...) into the result vec via
// `__array_from_iter` + `__extern_length` / `__extern_get`, matching the
// spec semantics of `ArrayLiteral` evaluating an `Spread`.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function runTest(source: string): Promise<number> {
  const r = await compile(source);
  if (!r.success) {
    throw new Error("compile failed: " + r.errors.map((e) => e.message).join("\n"));
  }
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return (instance.exports.test as () => number)();
}

describe("#1514 — array-spread materialises JS iterables", () => {
  it("spread of a JS Set yields its elements", async () => {
    const src = `
      export function test(): number {
        const s = new Set<number>();
        s.add(1);
        s.add(2);
        s.add(3);
        const arr = [...s];
        if (arr.length !== 3) return 1;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        return sum === 6 ? 0 : 2;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("spread of intersection result iterates elements", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        s1.add(3);
        const s2 = new Set<number>();
        s2.add(2);
        s2.add(3);
        s2.add(4);
        const arr = [...s1.intersection(s2)];
        if (arr.length !== 2) return 1;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        return sum === 5 ? 0 : 2;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("spread of a JS Map (set-like) over Set.intersection", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const m1 = new Map<number, string>();
        m1.set(2, "two");
        m1.set(3, "three");
        const combined = s1.intersection(m1);
        const arr = [...combined];
        if (arr.length !== 1) return 1;
        return arr[0] === 2 ? 0 : 2;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("spread of symmetricDifference yields both unique elements", async () => {
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(1);
        s1.add(2);
        const s2 = new Set<number>();
        s2.add(2);
        s2.add(3);
        const arr = [...s1.symmetricDifference(s2)];
        if (arr.length !== 2) return 1;
        // {1, 2} ⊕ {2, 3} = {1, 3}; spread preserves insertion order so [1, 3]
        if (arr[0] !== 1) return 2;
        if (arr[1] !== 3) return 3;
        return 0;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });

  it("difference treats -0 / +0 as the same set element", async () => {
    // V8 normalises -0 to +0 in Set via SameValueZero — exercise that path
    // by going through the host-native difference call.
    const src = `
      export function test(): number {
        const s1 = new Set<number>();
        s1.add(0);
        s1.add(1);
        const s2 = new Set<number>();
        s2.add(-0);
        const combined = s1.difference(s2);
        // {+0, 1} − {-0} = {1} because SameValueZero treats ±0 as equal
        const arr = [...combined];
        if (arr.length !== 1) return 1;
        return arr[0] === 1 ? 0 : 2;
      }
    `;
    expect(await runTest(src)).toBe(0);
  });
});
