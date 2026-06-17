import { describe, it, expect } from "vitest";
import { compileToWasm, evaluateAsJs } from "./helpers.js";

/**
 * Promise/async tests for equivalence.
 *
 * The js2wasm compiler compiles async functions synchronously:
 * - `await` is identity (pass-through)
 * - async functions return their value directly, not wrapped in a Promise
 * - Promise.resolve/reject are not runtime JS promises in Wasm
 *
 * So these tests verify the synchronous async compilation pattern matches
 * the expected numeric results, comparing Wasm output vs JS evaluation.
 */
describe("Promise / async equivalence", () => {
  it("async function returning literal", async () => {
    const src = `
      async function getValue(): Promise<number> { return 42; }
      export function main(): number {
        return getValue() as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    // In JS, getValue() returns a Promise, but main() casts it
    // In Wasm, async is synchronous so getValue() returns 42 directly
    expect(wasm.main()).toBe(42);
  });

  it("async function with parameters", async () => {
    const src = `
      async function add(a: number, b: number): Promise<number> {
        return a + b;
      }
      export function main(): number {
        return add(17, 25) as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(42);
  });

  it("await of a suspending call resolves through a real Promise (#1796 CPS)", async () => {
    // `test` awaits `getVal()` (a non-static async call) so it genuinely
    // suspends and is CPS-lowered to return a real Promise. `main` awaits it;
    // the result resolves through a microtask tick. (Was "await expression
    // passes through value" under the legacy synchronous-async fakery.)
    const src = `
      async function getVal(): Promise<number> { return 100; }
      async function test(): Promise<number> {
        const v = await getVal();
        return v;
      }
      export async function main(): Promise<number> {
        return await test();
      }
    `;
    const wasm = await compileToWasm(src);
    await expect(wasm.main()).resolves.toBe(100);
  });

  it("multiple sequential awaits", async () => {
    const src = `
      async function getA(): Promise<number> { return 10; }
      async function getB(): Promise<number> { return 20; }
      async function getC(): Promise<number> { return 30; }
      async function sum(): Promise<number> {
        const a = await getA();
        const b = await getB();
        const c = await getC();
        return a + b + c;
      }
      export function main(): number {
        return sum() as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(60);
  });

  it("async function with conditional logic", async () => {
    const src = `
      async function clamp(x: number, lo: number, hi: number): Promise<number> {
        if (x < lo) return lo;
        if (x > hi) return hi;
        return x;
      }
      export function test1(): number { return clamp(5, 0, 10) as any as number; }
      export function test2(): number { return clamp(-3, 0, 10) as any as number; }
      export function test3(): number { return clamp(15, 0, 10) as any as number; }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.test1()).toBe(5);
    expect(wasm.test2()).toBe(0);
    expect(wasm.test3()).toBe(10);
  });

  it("async arrow function", async () => {
    const src = `
      const double = async (x: number): Promise<number> => x * 2;
      export function main(): number {
        return double(21) as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(42);
  });

  it("nested async calls resolve through a real Promise (#1796 CPS)", async () => {
    // `outer` awaits `inner(x)` (a non-static async call) so it genuinely
    // suspends, then computes `squared + 1` in its continuation — exercising
    // a captured prefix local across the suspension. CPS-lowered to a real
    // Promise; awaited through a microtask tick. (Was "nested async calls"
    // under the legacy synchronous-async fakery.)
    const src = `
      async function inner(x: number): Promise<number> { return x * x; }
      async function outer(x: number): Promise<number> {
        const squared = await inner(x);
        return squared + 1;
      }
      export async function main(): Promise<number> {
        return await outer(5);
      }
    `;
    const wasm = await compileToWasm(src);
    await expect(wasm.main()).resolves.toBe(26);
  });

  it("async function with loop", async () => {
    const src = `
      async function sumTo(n: number): Promise<number> {
        let total = 0;
        for (let i = 1; i <= n; i++) {
          total += i;
        }
        return total;
      }
      export function main(): number {
        return sumTo(10) as any as number;
      }
    `;
    const wasm = await compileToWasm(src);
    expect(wasm.main()).toBe(55);
  });
});
