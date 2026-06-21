// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2379 — Uint8ClampedArray methods mis-dispatched to the host extern-class
// path (env.Uint8ClampedArray_<method>) instead of the native typed-array
// array-method path used by every other typed array. In GC mode the host
// import's externref `self` param mismatched the GC vec receiver → invalid Wasm
// ("call[0] expected externref"); in standalone it leaked an unsatisfiable
// env import. Root cause: "Uint8ClampedArray" was missing from BUILTIN_TYPES
// in src/checker/type-mapper.ts (every other typed array was listed), so
// isExternalDeclaredClass() claimed it and routed methods to the extern path.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileRun(source: string): Promise<Record<string, (...a: number[]) => number>> {
  const result = await compile(source);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as unknown as Record<string, (...a: number[]) => number>;
}

async function compileStandalone(source: string) {
  return compile(source, { target: "standalone" } as Parameters<typeof compile>[1]);
}

describe("#2379 Uint8ClampedArray method dispatch", () => {
  it("reduce returns the correct value (was invalid Wasm in GC mode)", async () => {
    const e = await compileRun(`
      export function test(): number {
        const a = new Uint8ClampedArray([1, 2, 3, 4]);
        return a.reduce((acc, x) => acc + x, 0);
      }
    `);
    expect(e.test()).toBe(10);
  });

  it("forEach / map / indexOf / length dispatch natively", async () => {
    const e = await compileRun(`
      export function test(): number {
        const a = new Uint8ClampedArray([1, 2, 3, 4]);
        let sum: number = 0;
        a.forEach((x) => { sum = sum + x; });        // 10
        const b = a.map((x) => x * 2);                // [2,4,6,8]
        return sum * 1000 + b[3] * 10 + a.indexOf(3) + a.length;
        //     10000      +   80       +   2          +   4   = 10086
      }
    `);
    expect(e.test()).toBe(10086);
  });

  it("standalone: no env.Uint8ClampedArray_* host import leaks", async () => {
    const result = await compileStandalone(`
      export function test(): number {
        const a = new Uint8ClampedArray([1, 2, 3, 4]);
        return a.reduce((acc, x) => acc + x, 0);
      }
    `);
    expect(result.success).toBe(true);
    const envImports = (result.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
    expect(envImports.filter((n) => n.startsWith("Uint8ClampedArray_"))).toEqual([]);
  });

  it("does not regress the sibling typed arrays (Uint8Array / Int8Array / Float64Array reduce)", async () => {
    const e = await compileRun(`
      export function test(): number {
        const u8 = new Uint8Array([1, 2, 3, 4]).reduce((a, x) => a + x, 0);   // 10
        const i8 = new Int8Array([1, 2, 3, 4]).reduce((a, x) => a + x, 0);     // 10
        const f64 = new Float64Array([0.5, 1.5]).reduce((a, x) => a + x, 0);   // 2
        return u8 * 100 + i8 * 10 + f64;                                       // 1102
      }
    `);
    expect(e.test()).toBe(1102);
  });
});
