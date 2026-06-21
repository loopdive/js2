// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2162 — `new Set([...])` / `new Map([[k,v],...])` from an array literal in
// standalone / nativeStrings mode.
//
// Slice 1/2 only supported the no-arg `new Set()` / `new Map()` forms; an
// argument fell through to the host path (`new Set([1,2,3])` leaked env imports,
// `new Map([[1,10]])` was a hard "Unsupported new expression"). This slice seeds
// the native `$Map` backing store element-by-element when the single argument is
// an ARRAY LITERAL (the dominant iterable form): each Set element → `__set_add`
// (dedups through the shared insert), each Map `[k,v]` pair → `__map_set`.
// Non-literal iterables still need the general iterator drive (follow-up).
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

describe("#2162 new Set([...]) from array literal (standalone)", () => {
  it("seeds the set and reports size — host-import-free", async () => {
    const { value, collImports, valid } = await run(
      `export function test(): number { const s = new Set([1, 2, 3]); return s.size; }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(3);
  });

  it("dedups equal seed elements", async () => {
    const { value } = await run(
      `export function test(): number { const s = new Set([1, 2, 2, 3, 3, 3]); return s.size; }`,
    );
    expect(value).toBe(3);
  });

  it("seeded elements are present via has()", async () => {
    const { value } = await run(
      `export function test(): number { const s = new Set([10, 20]); return s.has(20) && !s.has(99) ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("empty array literal yields an empty set", async () => {
    const { value } = await run(`export function test(): number { const s = new Set<number>([]); return s.size; }`);
    expect(value).toBe(0);
  });

  it("seeded set iterates via forEach", async () => {
    const { value } = await run(
      `export function test(): number { const s = new Set([4, 5, 6]); let t = 0; s.forEach((v) => { t += v; }); return t; }`,
    );
    expect(value).toBe(15);
  });
});

describe("#2162 new Map([[k,v],...]) from array literal (standalone)", () => {
  it("seeds the map and reports size — host-import-free", async () => {
    const { value, collImports, valid } = await run(
      `export function test(): number { const m = new Map([[1, 10], [2, 20]]); return m.size; }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(2);
  });

  it("seeded keys are present via has()", async () => {
    const { value } = await run(
      `export function test(): number { const m = new Map([[1, 10], [2, 20]]); return m.has(1) && m.has(2) && !m.has(3) ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });

  it("later pair overwrites an earlier duplicate key (size dedups)", async () => {
    const { value } = await run(
      `export function test(): number { const m = new Map([[1, 10], [1, 20]]); return m.size; }`,
    );
    expect(value).toBe(1);
  });

  it("empty array literal yields an empty map", async () => {
    const { value } = await run(
      `export function test(): number { const m = new Map<number, number>([]); return m.size; }`,
    );
    expect(value).toBe(0);
  });

  it("the no-arg Map constructor still works (control)", async () => {
    const { value } = await run(
      `export function test(): number { const m = new Map<number, number>(); m.set(7, 7); return m.size; }`,
    );
    expect(value).toBe(1);
  });
});
