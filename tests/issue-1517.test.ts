// #1517 — Array.fromAsync (ES2024)
//
// `Array.fromAsync` (spec §23.1.2.2) is the async sibling of `Array.from`.
// Routes to the `__array_from_async` host import which implements the
// algorithm using native `for await...of` over async iterables, sync
// iterables (awaiting each yielded value), and array-likes.
//
// These tests return the awaited externref array directly to the host so
// the JS test harness can inspect it. Test262 conformance is gated by CI
// against `built-ins/Array/fromAsync/` (~58 cases).

import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime.ts";

async function runAsync(src: string, fname = "main"): Promise<unknown> {
  const exports = await compileAndInstantiate(src);
  const fn = (exports as any)[fname];
  if (typeof fn !== "function") throw new Error(`Export ${fname} not a function`);
  return await fn();
}

describe("#1517 Array.fromAsync", () => {
  it("creates an array from a sync iterable (array)", async () => {
    const src = `
      export async function main(): Promise<any> {
        return await Array.fromAsync([1, 2, 3]);
      }
    `;
    const r = (await runAsync(src)) as any;
    expect(Array.isArray(r)).toBe(true);
    expect(r).toEqual([1, 2, 3]);
  });

  it("supports a numeric mapFn", async () => {
    const src = `
      export async function main(): Promise<any> {
        return await Array.fromAsync([1, 2, 3], (x: number) => x * 10);
      }
    `;
    expect(await runAsync(src)).toEqual([10, 20, 30]);
  });

  it("handles an async generator iterable", async () => {
    const src = `
      async function* gen() {
        yield 1;
        yield 2;
        yield 3;
      }
      export async function main(): Promise<any> {
        return await Array.fromAsync(gen());
      }
    `;
    expect(await runAsync(src)).toEqual([1, 2, 3]);
  });

  it("returns a Promise that resolves to the array", async () => {
    const src = `
      export async function main(): Promise<any> {
        const p = Array.fromAsync([1, 2]);
        return await p;
      }
    `;
    expect(await runAsync(src)).toEqual([1, 2]);
  });

  it("awaits the mapFn result (thenable mapper return)", async () => {
    const src = `
      export async function main(): Promise<any> {
        const mapFn: any = (x: any): any => Promise.resolve((x as number) + 100);
        return await Array.fromAsync([1, 2, 3], mapFn);
      }
    `;
    expect(await runAsync(src)).toEqual([101, 102, 103]);
  });

  it("mapFn receives (value, index)", async () => {
    const src = `
      export async function main(): Promise<any> {
        return await Array.fromAsync([10, 20, 30], (x: number, i: number) => x + i);
      }
    `;
    expect(await runAsync(src)).toEqual([10, 21, 32]);
  });

  it("returns an empty array for an empty source", async () => {
    const src = `
      export async function main(): Promise<any> {
        return await Array.fromAsync([]);
      }
    `;
    const r = (await runAsync(src)) as any;
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(0);
  });
});
