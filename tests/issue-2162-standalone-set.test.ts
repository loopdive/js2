// #2162 — Wasm-native Set dispatch (standalone / nativeStrings).
//
// A standalone `Set` had no Wasm-native runtime, so `new Set()` + add/has/
// delete/size leaked `Set_*` host imports a pure-Wasm engine can't satisfy
// (286 standalone Set test262 failures). This adds a native Set that REUSES the
// #1103a Map backing store (a Set is a Map with `value === key`). This file is
// the regression net for the wiring that routes `new Set()` +
// `.add/.has/.delete/.clear/.size` onto that runtime under `--target wasi`.
//
// Slice 1 scope: no-arg `new Set()`, number + native-string + chained add,
// add/has/delete/clear/size. Iteration (for-of / forEach / `new Set(iterable)`)
// and ES2025 set-algebra are follow-up slices.
//
// Each test compiles with `target: "wasi"` and asserts (a) the module is valid
// Wasm, (b) it carries ZERO `Set_*`/`Map_*` host imports, and (c) it returns
// the expected value when instantiated against the WASI polyfill and run.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

/** Compile `source` with `--target wasi`, run `test()`, return its value. */
async function runSet(source: string): Promise<{ value: number; collImports: number; valid: boolean }> {
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

describe("#2162 native Set dispatch (standalone)", () => {
  it("add + has for number elements — host-import-free", async () => {
    const { value, collImports, valid } = await runSet(
      `export function test(): number {
         const s = new Set<number>();
         s.add(5);
         return (s.has(5) ? 1 : 0) + (s.has(9) ? 10 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(1); // has(5)=true, has(9)=false
  });

  it("size dedups equal elements", async () => {
    const { value, collImports, valid } = await runSet(
      `export function test(): number {
         const s = new Set<number>();
         s.add(1); s.add(1); s.add(2);
         return s.size;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(2);
  });

  it("delete removes the element and returns whether it was present", async () => {
    const { value, collImports, valid } = await runSet(
      `export function test(): number {
         const s = new Set<number>();
         s.add(7);
         const first = s.delete(7) ? 1 : 0;   // present → true
         const second = s.delete(7) ? 1 : 0;  // already gone → false
         const stillHas = s.has(7) ? 1 : 0;   // false
         return first * 100 + second * 10 + stillHas;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(100); // 1,0,0
  });

  it("clear empties the set", async () => {
    const { value, collImports, valid } = await runSet(
      `export function test(): number {
         const s = new Set<number>();
         s.add(1); s.add(2); s.add(3);
         s.clear();
         return s.size;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(0);
  });

  it("string elements dedup by content", async () => {
    const { value, collImports, valid } = await runSet(
      `export function test(): number {
         const s = new Set<string>();
         s.add("a"); s.add("b"); s.add("a");
         return s.size * 10 + (s.has("b") ? 1 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(21); // size 2, has("b") true
  });

  it("add is chainable and returns the set", async () => {
    const { value, collImports, valid } = await runSet(
      `export function test(): number {
         const s = new Set<number>();
         s.add(1).add(2).add(3);
         return s.size;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(3);
  });
});
