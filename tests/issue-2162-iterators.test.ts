// #2162 — Wasm-native Map/Set iterators (standalone / nativeStrings).
//
// This slice: `keys()` / `values()` and bare `for-of` over a native Map/Set,
// materialized as a canonical externref `$Vec` the array for-of consumer drives
// — no `Map_*`/`Set_*` host import. `Set.forEach` (the shared collection-forEach
// helper, previously only wired for Map) is also enabled here.
//
// A latent bug surfaced and is fixed by this slice: the `$Map` struct's
// `entries` field is a ref-to-array, so `getArrTypeIdxFromVec($Map)` returns a
// valid array index and the array-iterator-receiver detection misidentified a
// native Map/Set as a plain vec — iterating its raw struct as garbage. The
// native-collection for-of path now runs *before* that detection.
//
// FOLLOW-UP (not in this slice): `entries()` `[k, v]`-pair iteration and value
// spread (`[...map.values()]`) need the `__iterator` pair consumer (the array
// `.entries()` route), not the array fast path — tracked on #2162.
//
// Each test compiles with `target: "wasi"`, asserts (a) valid Wasm, (b) ZERO
// `Map_*`/`Set_*` host imports, and (c) the expected returned value.

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
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi,
  });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, collImports, valid };
}

describe("#2162 native Map/Set iterators (standalone)", () => {
  it("Map.values() summed via for-of — host-import-free", async () => {
    const { value, collImports, valid } = await run(
      `export function test(): number {
         const m = new Map<number, number>();
         m.set(1, 10); m.set(2, 20); m.set(3, 30);
         let sum = 0;
         for (const v of m.values()) sum += v;
         return sum;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(60);
  });

  it("Map.keys() summed via for-of", async () => {
    const { value, collImports } = await run(
      `export function test(): number {
         const m = new Map<number, number>();
         m.set(4, 0); m.set(5, 0); m.set(6, 0);
         let sum = 0;
         for (const k of m.keys()) sum += k;
         return sum;
       }`,
    );
    expect(collImports).toBe(0);
    expect(value).toBe(15);
  });

  it("Map.values() iterators skip deleted (tombstone) entries", async () => {
    const { value, collImports } = await run(
      `export function test(): number {
         const m = new Map<number, number>();
         m.set(1, 1); m.set(2, 2); m.set(3, 3);
         m.delete(2);
         let sum = 0;
         for (const v of m.values()) sum += v;
         return sum;
       }`,
    );
    expect(collImports).toBe(0);
    expect(value).toBe(1 + 3);
  });

  it("Set.values() summed via for-of — host-import-free", async () => {
    const { value, collImports, valid } = await run(
      `export function test(): number {
         const s = new Set<number>();
         s.add(3); s.add(4); s.add(3); s.add(5);
         let sum = 0;
         for (const v of s.values()) sum += v;
         return sum;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(3 + 4 + 5); // 3 deduped
  });

  it("Set.keys() aliases values() (yields elements)", async () => {
    const { value, collImports } = await run(
      `export function test(): number {
         const s = new Set<number>();
         s.add(11); s.add(22);
         let sum = 0;
         for (const v of s.keys()) sum += v;
         return sum;
       }`,
    );
    expect(collImports).toBe(0);
    expect(value).toBe(33);
  });

  it("bare for-of over a Set yields its elements", async () => {
    const { value, collImports } = await run(
      `export function test(): number {
         const s = new Set<number>();
         s.add(10); s.add(20); s.add(30);
         let sum = 0;
         for (const v of s) sum += v;
         return sum;
       }`,
    );
    expect(collImports).toBe(0);
    expect(value).toBe(60);
  });

  it("Set.forEach drives the callback over elements", async () => {
    const { value, collImports } = await run(
      `export function test(): number {
         const s = new Set<number>();
         s.add(1); s.add(2); s.add(4);
         let sum = 0;
         s.forEach((v: number) => { sum += v; });
         return sum;
       }`,
    );
    expect(collImports).toBe(0);
    expect(value).toBe(7);
  });
});
