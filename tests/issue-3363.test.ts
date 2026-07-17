// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3363 — standalone-native Array.prototype.flat() (depth-1 homogeneous nested array).
//
// #2717 only added the fail-loud refusal for standalone flat() (it swapped the
// unsatisfiable __array_flat host import for a loud CE) and deferred the native
// flatten arm. This slice lands the common, tractable case: a depth-1 flatten of
// a statically-typed homogeneous nested array `T[][]` — a straight concatenation
// of the inner vecs into a fresh result vec of the inner element kind. An
// explicit depth argument / non-nested receiver still refuses loudly. Host mode
// keeps the __array_flat delegation (unchanged).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#3363 — Array.prototype.flat() (standalone, depth-1 homogeneous)", () => {
  it("flattens [[1,2],[3]] to length 3", async () => {
    expect(await runStandalone(`export function test(): number { return [[1,2],[3]].flat().length; }`)).toBe(3);
  });

  it("preserves element values and order ([[1,2],[3]] -> [1,2,3])", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const b = [[1,2],[3]].flat(); return b[0]*100 + b[1]*10 + b[2]; }`,
      ),
    ).toBe(123);
  });

  it("sums all flattened elements ([[1,2],[3,4]] -> 10)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const b = [[1,2],[3,4]].flat(); return b[0]+b[1]+b[2]+b[3]; }`,
      ),
    ).toBe(10);
  });

  it("skips empty inner arrays ([[1],[],[2,3]] -> [1,2,3])", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const b = [[1],[],[2,3]].flat(); return b.length*10 + b[1]; }`,
      ),
    ).toBe(32);
  });

  it("empty outer array flattens to empty", async () => {
    expect(
      await runStandalone(`export function test(): number { const a: number[][] = []; return a.flat().length; }`),
    ).toBe(0);
  });

  it("all-empty inner arrays flatten to empty", async () => {
    expect(
      await runStandalone(`export function test(): number { const b = [[],[]].flat() as number[]; return b.length; }`),
    ).toBe(0);
  });

  it("single inner array ([[5,6,7]] -> [5,6,7])", async () => {
    expect(
      await runStandalone(`export function test(): number { const b = [[5,6,7]].flat(); return b.length*100 + b[2]; }`),
    ).toBe(307);
  });

  it("works on a statically-typed number[][] variable receiver", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: number[][] = [[9,8],[7]]; const b = a.flat(); return b[0] + b[2]; }`,
      ),
    ).toBe(16);
  });

  it("flattens nested string arrays too (homogeneous inner vec of any kind)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a: string[][] = [["ab","cd"],["ef"]]; const b = a.flat(); return b.length*10 + b[2].length; }`,
      ),
    ).toBe(32);
  });

  it("does not leak host imports (zero-import instantiation)", async () => {
    const r = await compile(`export function test(): number { return [[1,2,3],[4,5]].flat().length; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(5);
  });

  it("an explicit depth argument still refuses loudly (out of scope)", async () => {
    const r = await compile(`export function test(): number { return [[1,2],[3]].flat(1).length; }`, {
      target: "standalone",
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.errors)).toContain("flat()");
  });
});
