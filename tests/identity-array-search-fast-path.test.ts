// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function compileRun(source: string): Promise<{ value: number; runWat: string }> {
  const result = await compile(source, {
    fileName: "identity-search.ts",
    fast: true,
    optimize: 4,
    emitWat: true,
    emitWatOnlyFunctions: ["run"],
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  const wat = result.wat ?? "";
  const runWat = wat.slice(wat.indexOf("(func $run"), wat.indexOf('(export "run"'));
  return { value: (instance.exports.run as () => number)(), runWat };
}

describe("canonical identity-array search fast paths", () => {
  it("returns an in-range indexOf search expression without scanning", async () => {
    const { value, runWat } = await compileRun(`
      export function run(): number {
        const arr: number[] = [];
        for (let i = 0; i < 100; i = i + 1) arr.push(i);
        let sum = 0;
        for (let i = 0; i < 10; i = i + 1) sum = sum + arr.indexOf(i * 10);
        return sum;
      }
    `);
    expect(value).toBe(450);
    expect(runWat).not.toContain("__arr_iof");
    expect(runWat).not.toContain("array.get");
  });

  it("returns an in-range equality find literal without invoking the callback", async () => {
    const { value, runWat } = await compileRun(`
      export function run(): number {
        const arr: number[] = [];
        for (let i = 0; i < 100; i = i + 1) arr.push(i);
        return arr.find((value: number): boolean => value === 50) ?? -1;
      }
    `);
    expect(value).toBe(50);
    expect(runWat).not.toContain("array.get");
    expect(runWat).not.toContain("call_ref");
  });

  it("keeps runtime searches when identity or predicate proofs do not hold", async () => {
    const mutated = await compileRun(`
      export function run(): number {
        const arr: number[] = [];
        for (let i = 0; i < 10; i = i + 1) arr.push(i);
        arr[5] = 99;
        return arr.indexOf(5);
      }
    `);
    expect(mutated.value).toBe(-1);
    expect(mutated.runWat).toContain("array.get");

    const dynamicPredicate = await compileRun(`
      export function run(): number {
        const arr: number[] = [];
        for (let i = 0; i < 10; i = i + 1) arr.push(i);
        return arr.find((value: number): boolean => value > 5) ?? -1;
      }
    `);
    expect(dynamicPredicate.value).toBe(6);
    expect(dynamicPredicate.runWat).toContain("array.get");
  });
});
