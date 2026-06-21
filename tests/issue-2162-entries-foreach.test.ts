// #2162 — Wasm-native Map/Set `entries()` `[k, v]` for-of (standalone).
//
// Prior slices materialized Map/Set `keys()`/`values()` and bare Set for-of as a
// canonical externref `$Vec` the array fast path drives. The `entries()` pair
// projection was deferred: a Map's bare `for (const [k, v] of m)` defaults to the
// entries projection, but building externref `$ObjVec` `[k, v]` pairs and then
// destructuring them through the generic array-element path routed `pair[0]` /
// `pair[1]` through the host `__extern_get` (+ `__array_from_iter_n` /
// `__get_undefined`) — leaking imports standalone.
//
// This slice (`compileForOfNativeMapEntries`, statements/loops.ts): a dedicated
// native walk over the `$Map` entries vector that binds the STORED key/value
// directly into the `[k, v]` targets per live entry (skipping tombstones) — no
// intermediate pair object, no host import. Mirrors the forEach driver's entry
// walk and the array for-of break/continue bookkeeping.
//
// Covers `for (const [k, v] of m)` (Map default entries), explicit
// `m.entries()`, the Set `[v, v]` form, numeric + string keys, tombstone-skip
// after delete, insertion order, break / continue, and the empty collection.
//
// Each test compiles with `target: "standalone"` and asserts the module
// instantiates with ZERO host imports and returns the expected value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandaloneZeroImports(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2162 native Map/Set entries() [k, v] for-of (standalone)", () => {
  it("explicit Map.entries() — sum k*100 + v", async () => {
    // k=1,v=10→110; k=2,v=20→220; k=3,v=30→330 = 660
    expect(
      await runStandaloneZeroImports(
        `export function run(): number {
           const m = new Map<number, number>();
           m.set(1, 10); m.set(2, 20); m.set(3, 30);
           let s = 0;
           for (const [k, v] of m.entries()) s += k * 100 + v;
           return s;
         }`,
      ),
    ).toBe(660);
  });

  it("bare Map for-of defaults to [k, v] entries", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number {
           const m = new Map<number, number>();
           m.set(5, 50);
           let s = 0;
           for (const [k, v] of m) s += k + v;
           return s;
         }`,
      ),
    ).toBe(55);
  });

  it("tombstone slots are skipped after delete", async () => {
    // after delete(2): k=1,v=10→110; k=3,v=30→330 = 440
    expect(
      await runStandaloneZeroImports(
        `export function run(): number {
           const m = new Map<number, number>();
           m.set(1, 10); m.set(2, 20); m.set(3, 30);
           m.delete(2);
           let s = 0;
           for (const [k, v] of m) s += k * 100 + v;
           return s;
         }`,
      ),
    ).toBe(440);
  });

  it("break exits the entries loop", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number {
           const m = new Map<number, number>();
           m.set(1, 10); m.set(2, 20); m.set(3, 30);
           let s = 0;
           for (const [k, v] of m) { if (k === 2) break; s += k * 100 + v; }
           return s;
         }`,
      ),
    ).toBe(110);
  });

  it("continue skips an iteration (cursor still advances)", async () => {
    // skip k=2: 110 + 330 = 440
    expect(
      await runStandaloneZeroImports(
        `export function run(): number {
           const m = new Map<number, number>();
           m.set(1, 10); m.set(2, 20); m.set(3, 30);
           let s = 0;
           for (const [k, v] of m) { if (k === 2) continue; s += k * 100 + v; }
           return s;
         }`,
      ),
    ).toBe(440);
  });

  it("Set.entries() yields [value, value] pairs", async () => {
    // 5,5→55; 7,7→77 = 132
    expect(
      await runStandaloneZeroImports(
        `export function run(): number {
           const set = new Set<number>();
           set.add(5); set.add(7);
           let s = 0;
           for (const [a, b] of set.entries()) s += a * 10 + b;
           return s;
         }`,
      ),
    ).toBe(132);
  });

  it("string keys read back natively", async () => {
    // a=97*10+1=971, b=98*10+2=982 = 1953
    expect(
      await runStandaloneZeroImports(
        `export function run(): number {
           const m = new Map<string, number>();
           m.set("a", 1); m.set("b", 2);
           let s = 0;
           for (const [k, v] of m) s += k.charCodeAt(0) * 10 + v;
           return s;
         }`,
      ),
    ).toBe(1953);
  });

  it("entries iterate in insertion order", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number {
           const m = new Map<number, number>();
           m.set(3, 1); m.set(1, 1); m.set(2, 1);
           let r = 0;
           for (const [k, v] of m) r = r * 10 + k;
           return r;
         }`,
      ),
    ).toBe(312);
  });

  it("empty Map entries for-of is a no-op", async () => {
    expect(
      await runStandaloneZeroImports(
        `export function run(): number {
           const m = new Map<number, number>();
           let s = 0;
           for (const [k, v] of m) s += k + v;
           return s;
         }`,
      ),
    ).toBe(0);
  });
});
