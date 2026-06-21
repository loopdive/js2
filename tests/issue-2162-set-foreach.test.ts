// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2162 — Wasm-native Set.prototype.forEach dispatch (standalone / nativeStrings).
//
// The #2162 Slice-1 native Set runtime served add/has/delete/clear/size but NOT
// iteration, so `s.forEach(cb)` in standalone produced invalid Wasm (the call
// fell through the dispatch interceptors to the generic host path). This slice
// routes `Set.prototype.forEach` to the shared `tryCompileNativeCollectionForEach`
// (the same insertion-ordered, tombstone-skipping `$Map` entries-vector walk that
// Map.forEach #1527 uses) with `isSet=true`, so the callback is invoked as
// `cb(value, value, set)` per live entry (spec 24.2.3.6 — a Set passes the value
// as both value and key).
//
// Each test compiles with `target: "wasi"` and asserts (a) valid Wasm, (b) ZERO
// `Set_*`/`Map_*` host imports, and (c) the expected accumulated value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

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

describe("#2162 native Set.forEach (standalone)", () => {
  it("counts every live element — host-import-free", async () => {
    const { value, collImports, valid } = await runSet(
      `export function test(): number {
         let n = 0;
         const s = new Set<number>();
         s.add(1); s.add(2); s.add(3);
         s.forEach(() => { n++; });
         return n;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(3);
  });

  it("sums element values", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let s = 0;
         const set = new Set<number>();
         set.add(10); set.add(20); set.add(30);
         set.forEach((v) => { s += v; });
         return s;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(60);
  });

  it("passes value as BOTH value and key (spec 24.2.3.6)", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let ok = 1;
         const set = new Set<number>();
         set.add(5); set.add(9);
         set.forEach((v, k) => { if (v !== k) ok = 0; });
         return ok;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("skips deleted (tombstoned) elements", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let n = 0;
         const set = new Set<number>();
         set.add(1); set.add(2); set.add(3);
         set.delete(2);
         set.forEach(() => { n++; });
         return n;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(2);
  });

  it("iterates in insertion order", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let first = 0;
         let seen = 0;
         const set = new Set<number>();
         set.add(7); set.add(3); set.add(9);
         set.forEach((v) => { if (seen === 0) first = v; seen++; });
         return first;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(7);
  });

  it("empty set never invokes the callback", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let n = 0;
         const set = new Set<number>();
         set.forEach(() => { n++; });
         return n;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(0);
  });
});
