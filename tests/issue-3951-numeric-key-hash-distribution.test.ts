// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3951 — numeric keys in the WasmGC-native collection runtime hashed into a
// single bucket, making every `Map`/`Set` lookup O(n).
//
// ## The defect
//
// `__hash_anyref`'s number arm folded the f64 bits with
// `wrap(bits ^ (bits >>> 32)) & 0x3fffffff`. A small integer as an IEEE-754
// double has an all-zero low mantissa — `3.0` = `0x4008000000000000`,
// `6.0` = `0x4018000000000000` — so the fold lands entirely in the HIGH bits
// (`0x00080000`, `0x00180000`, …) and the low bits stay zero. The bucket index
// is `hash & (cap-1)`, i.e. exactly those low bits, so EVERY integer key hashed
// to bucket 0. Rehashing could not rescue it: doubling the bucket count still
// reads zeros. Strings were unaffected because FNV-1a has live low bits.
//
// Measured on the standalone lane (`target: "wasi"`), median of 9 runs:
//
//   | entries | Set.has before | after | Map.get before | after |
//   |       8 |         61 ns  | 20 ns |         70 ns  | 22 ns |
//   |      32 |        201 ns  | 29 ns |        225 ns  | 30 ns |
//   |     128 |        784 ns  | 27 ns |        728 ns  | 35 ns |
//   |     512 |       2996 ns  | 32 ns |       3074 ns  | 32 ns |
//
// i.e. ~linear before (44x cost for a 64x size increase), flat after — 94x
// faster at 512 entries. The string arm was flat throughout (134 -> 215 ns/op
// over the same range), which is what isolated the fault to the numeric arm.
//
// ## The fix
//
// A murmur3 finalizer after the fold, mixing high entropy down into the low
// bits so the caller's mask selects a well-distributed bucket.
//
// ## What this test guards
//
// Distribution is a PERFORMANCE property and timing assertions are flaky in
// CI, so this file asserts the SEMANTICS that a hash change could break —
// every key still round-trips, SameValueZero still holds for -0/+0 and NaN,
// insertion order is still what iteration yields, and tombstones still work.
// The scaling numbers above are recorded in the issue, not asserted here.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, { fileName: "t.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown"}`);
  }
  const module = await WebAssembly.compile(result.binary);
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  return (exports.test as () => number)();
}

describe("#3951 — numeric-key hashing keeps Map/Set semantics", () => {
  it("every integer key round-trips at a size that spans several rehashes", async () => {
    // 512 keys forces repeated rehashing (INIT_CAP doubling at load factor
    // 0.75). Before the fix these all shared bucket 0; the walk still FOUND
    // them, just slowly — so this rung is about the fix not LOSING any.
    expect(
      await runStandalone(`
export function test(): number {
  const m = new Map<number, number>();
  for (let i = 0; i < 512; i++) m.set(i * 3, i);
  let sum = 0;
  for (let i = 0; i < 512; i++) { sum = sum + (m.get(i * 3) ?? -1); }
  return sum + m.size;
}
`),
      // sum of 0..511 = 130816; any missing key contributes -1 instead.
    ).toBe(130816 + 512);
  });

  it("negative, fractional and large keys round-trip", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  const m = new Map<number, number>();
  m.set(-7, 1); m.set(0.5, 2); m.set(-0.25, 3); m.set(1e15, 4); m.set(-1e-9, 5);
  return (m.get(-7) ?? 0) + (m.get(0.5) ?? 0) * 10 + (m.get(-0.25) ?? 0) * 100
       + (m.get(1e15) ?? 0) * 1000 + (m.get(-1e-9) ?? 0) * 10000 + m.size * 100000;
}
`),
    ).toBe(554321);
  });

  it("SameValueZero: -0 and +0 are the same key", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  const m = new Map<number, number>();
  m.set(0, 1);
  m.set(-0, 2);
  return m.size * 10 + (m.get(0) ?? 0);
}
`),
      "-0 and +0 must hash to the same bucket AND compare equal — size 1, value 2",
    ).toBe(12);
  });

  it("SameValueZero: NaN is a usable key and matches itself", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  const m = new Map<number, number>();
  const nan = 0 / 0;
  m.set(nan, 7);
  return m.size * 10 + (m.get(0 / 0) ?? 0);
}
`),
    ).toBe(17);
  });

  it("iteration yields insertion order, not bucket order", async () => {
    // The strongest guard that the fix is bucket-only: entries iterate from the
    // insertion-ordered entries array, so re-bucketing must not reorder them.
    // Keys are chosen so hash order and insertion order differ.
    expect(
      await runStandalone(`
export function test(): number {
  const s = new Set<number>();
  s.add(500); s.add(3); s.add(97); s.add(1); s.add(64);
  let acc = 0;
  s.forEach((v: number) => { acc = acc * 1000 + v; });
  return acc;
}
`),
      "forEach must yield 500,3,97,1,64 in insertion order",
    ).toBe(500 * 1e12 + 3 * 1e9 + 97 * 1e6 + 1 * 1e3 + 64);
  });

  it("delete tombstones still resolve after re-bucketing", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  const m = new Map<number, number>();
  for (let i = 0; i < 64; i++) m.set(i * 3, i);
  for (let i = 0; i < 64; i = i + 2) m.delete(i * 3);
  let present = 0;
  for (let i = 0; i < 64; i++) { if (m.has(i * 3)) present = present + 1; }
  return present * 1000 + m.size;
}
`),
    ).toBe(32 * 1000 + 32);
  });

  it("re-adding a deleted key works", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  const m = new Map<number, number>();
  m.set(42, 1); m.delete(42); m.set(42, 9);
  return m.size * 100 + (m.get(42) ?? 0);
}
`),
    ).toBe(109);
  });

  it("Set dedups integer members", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  const s = new Set<number>();
  for (let r = 0; r < 4; r++) for (let i = 0; i < 100; i++) s.add(i * 7);
  return s.size;
}
`),
    ).toBe(100);
  });

  it("string keys are unaffected (the arm that was already correct)", async () => {
    expect(
      await runStandalone(`
export function test(): number {
  const m = new Map<string, number>();
  for (let i = 0; i < 128; i++) m.set("k" + i, i);
  let sum = 0;
  for (let i = 0; i < 128; i++) { sum = sum + (m.get("k" + i) ?? -1); }
  return sum + m.size;
}
`),
      // sum of 0..127 = 8128; any missing key contributes -1 instead.
    ).toBe(8128 + 128);
  });
});
