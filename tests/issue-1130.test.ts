// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1130 PR-0 — array-index-exotic `length` growth on Object.defineProperty.
 *
 * Per ES §10.4.2.1 (array exotic `[[DefineOwnProperty]]` / ArraySetLength):
 * `Object.defineProperty(arr, "n", desc)` with a canonical array index `n`
 * where `n >= arr.length` sets `arr.length = n + 1`. Our WasmGC vec stores
 * the logical length in struct field 0; defineProperty must bump it.
 *
 * This is the prerequisite slice for the broader getter-observing work
 * (PR-1/PR-2): without length growth the callback loop never reaches a
 * newly accessor-defined index. PR-0 only grows `length`; element reads
 * still take the raw fast path (accessor-observation lands in PR-1).
 */
import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

async function run(source: string): Promise<unknown> {
  const exports = await compileAndInstantiate(source);
  return (exports as Record<string, () => unknown>).test();
}

describe("#1130 PR-0: array-index-exotic length growth", () => {
  it("accessor descriptor on index >= length grows length", async () => {
    // empty array, define a getter on index 2 -> length becomes 3
    expect(
      await run(
        `export function test(): number {
           var arr: number[] = [];
           Object.defineProperty(arr, "2", { get() { return 12; } });
           return arr.length;
         }`,
      ),
    ).toBe(3);
  });

  it("value descriptor on index >= length grows length", async () => {
    expect(
      await run(
        `export function test(): number {
           var arr: number[] = [0];
           Object.defineProperty(arr, "4", { value: 9 });
           return arr.length;
         }`,
      ),
    ).toBe(5);
  });

  it("index within current length does not change length", async () => {
    expect(
      await run(
        `export function test(): number {
           var arr: number[] = [0, 1, 2, 3];
           Object.defineProperty(arr, "1", { get() { return 9; } });
           return arr.length;
         }`,
      ),
    ).toBe(4);
  });

  it('the "length" key is not a canonical array index — no growth', async () => {
    expect(
      await run(
        `export function test(): number {
           var arr: number[] = [0, 1, 2];
           Object.defineProperty(arr, "length", { value: 2 } as any);
           return arr.length;
         }`,
      ),
    ).toBe(2);
  });

  it('non-canonical numeric key "01" is not an array index — no growth', async () => {
    expect(
      await run(
        `export function test(): number {
           var arr: number[] = [0];
           Object.defineProperty(arr, "01", { value: 9 });
           return arr.length;
         }`,
      ),
    ).toBe(1);
  });

  it("string element array grows length too", async () => {
    expect(
      await run(
        `export function test(): number {
           var arr: string[] = ["a"];
           Object.defineProperty(arr, "3", { value: "z" });
           return arr.length;
         }`,
      ),
    ).toBe(4);
  });

  it("existing forEach over a non-accessor array is unaffected", async () => {
    expect(
      await run(
        `export function test(): number {
           var arr: number[] = [1, 2, 3];
           var sum = 0;
           arr.forEach(function (v) { sum += v; });
           return sum;
         }`,
      ),
    ).toBe(6);
  });
});
