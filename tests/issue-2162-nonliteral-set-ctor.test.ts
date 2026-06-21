// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2162 — `new Set(arr)` from a NON-LITERAL array-typed argument (a variable, a
// call result) in standalone / nativeStrings mode.
//
// The prior slice seeded `new Set([1,2,3])` only from an array LITERAL; a
// variable/expression argument (`new Set(arr)`) fell through to the host path and
// leaked env imports (`env: module is not an object or function` on instantiate).
// This slice walks the argument's `$Vec` at runtime (a counted loop reading
// `data[i]`, boxing per element kind, calling `__set_add`) so the non-literal
// form is host-import-free.
//
// Each test compiles `target: "wasi"` and asserts valid Wasm, ZERO
// `Set_*`/`Map_*` host imports, and the expected value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function run(source: string): Promise<{ value: number; collImports: number; valid: boolean }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const valid = WebAssembly.validate(result.binary);
  const module = await WebAssembly.compile(result.binary);
  const collImports = WebAssembly.Module.imports(module).filter((i) => /^(Set|Map)_/.test(i.name)).length;
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, collImports, valid };
}

describe("#2162 new Set(nonLiteralArray) (standalone)", () => {
  it("seeds from a numeric array variable and dedups — host-import-free", async () => {
    const { value, collImports, valid } = await run(
      `export function test(): number {
        const arr = [1, 2, 3, 2, 1];
        const s = new Set<number>(arr);
        return s.size;
      }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(3); // dedup: {1,2,3}
  });

  it("membership holds for a value seeded from a variable", async () => {
    const { value } = await run(
      `export function test(): number {
        const arr = [10, 20, 30];
        const s = new Set<number>(arr);
        return s.has(20) ? 1 : 0;
      }`,
    );
    expect(value).toBe(1);
  });

  it("a value not in the source array is absent", async () => {
    const { value } = await run(
      `export function test(): number {
        const arr = [10, 20, 30];
        const s = new Set<number>(arr);
        return s.has(99) ? 1 : 0;
      }`,
    );
    expect(value).toBe(0);
  });

  it("seeds from a string array variable and dedups", async () => {
    const { value, collImports } = await run(
      `export function test(): number {
        const arr = ["x", "y", "x", "z"];
        const s = new Set<string>(arr);
        return s.size;
      }`,
    );
    expect(collImports).toBe(0);
    expect(value).toBe(3); // {"x","y","z"}
  });

  it("seeds from a function-returned array", async () => {
    const { value } = await run(
      `function makeArr(): number[] { return [4, 5, 6]; }
       export function test(): number {
        const s = new Set<number>(makeArr());
        return s.size;
      }`,
    );
    expect(value).toBe(3);
  });

  it("the no-arg form is unaffected", async () => {
    const { value } = await run(
      `export function test(): number {
        const s = new Set<number>();
        s.add(7);
        s.add(7);
        return s.size;
      }`,
    );
    expect(value).toBe(1);
  });

  it("the array-literal form is unaffected", async () => {
    const { value, collImports } = await run(
      `export function test(): number {
        const s = new Set<number>([1, 2, 3]);
        return s.size;
      }`,
    );
    expect(collImports).toBe(0);
    expect(value).toBe(3);
  });
});
