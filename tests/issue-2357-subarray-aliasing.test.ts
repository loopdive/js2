import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// (#2357 / #47) Standalone TypedArray.prototype.subarray offset-windowing.
//
// `a.subarray(begin, end)` must return a VIEW that shares the parent's backing
// store (ECMA §23.2.3.30): a write through the view is visible in the parent and
// vice-versa. Before this slice, standalone `subarray` returned a COPY.
//
// Representation (Option B from the #2357 architect spec): an additive
// `$__subview {length, data:(ref null $__arr_<elem>), byteOffset}` struct that
// holds the parent's backing array directly (shared) + the element window offset.
// A `subarray`-result binding statically resolves to `$__subview`, so element
// access discriminates view-vs-plain at COMPILE time — plain `a[i]` on a regular
// typed array pays ZERO extra instructions (no per-access runtime branch).
//
// Standalone native buffers don't marshal across the JS boundary, so each case
// returns an i32/number asserted directly.
async function runNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // No host import may leak (the view path is fully Wasm-native).
  const labels = r.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.some((l) => /__extern_get|__extern_set/.test(l))).toBe(false);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { t: () => number }).t();
}

describe("#2357 — standalone TypedArray subarray aliasing", () => {
  it("write through the view is visible in the parent (aliasing)", async () => {
    expect(
      await runNum(`
export function t(): number {
  let a = new Uint8Array(4);
  a[0]=10; a[1]=20; a[2]=30; a[3]=40;
  let s = a.subarray(1, 3);
  s[0] = 99;        // → parent byte 1
  return a[1];
}`),
    ).toBe(99);
  });

  it("write to the parent is visible through the view", async () => {
    expect(
      await runNum(`
export function t(): number {
  let a = new Uint8Array(4);
  a[2] = 77;
  let s = a.subarray(1, 3);
  return s[1];       // → parent byte 2
}`),
    ).toBe(77);
  });

  it("view read at index 0 maps to parent[begin]", async () => {
    expect(
      await runNum(`
export function t(): number {
  let a = new Uint8Array(4);
  a[1] = 55;
  let s = a.subarray(1, 3);
  return s[0];
}`),
    ).toBe(55);
  });

  it("write-then-read through the view round-trips", async () => {
    expect(
      await runNum(`
export function t(): number {
  let a = new Uint8Array(4);
  let s = a.subarray(1, 3);
  s[1] = 88;
  return s[1];
}`),
    ).toBe(88);
  });

  it("view length = end - begin", async () => {
    expect(
      await runNum(`
export function t(): number {
  let a = new Uint8Array(8);
  let s = a.subarray(2, 6);
  return s.length;
}`),
    ).toBe(4);
  });

  it("default end → bufferLength - begin", async () => {
    expect(
      await runNum(`
export function t(): number {
  let a = new Uint8Array(8);
  let s = a.subarray(3);
  return s.length;
}`),
    ).toBe(5);
  });

  it("nested subarray aliases the same backing store with accumulated offset", async () => {
    expect(
      await runNum(`
export function t(): number {
  let a = new Uint8Array(8);
  let s = a.subarray(2, 6);   // window [2,6)
  let s2 = s.subarray(1, 3);  // window [3,5) of the original
  s2[0] = 42;                 // → parent byte 3
  return a[3];
}`),
    ).toBe(42);
  });

  it("plain typed-array element access is unaffected (no view path)", async () => {
    expect(
      await runNum(`
export function t(): number {
  let a = new Uint8Array(4);
  a[0]=1; a[1]=2; a[2]=3; a[3]=4;
  let sum = 0;
  for (let i = 0; i < 4; i++) sum = sum + a[i];
  return sum;   // 1+2+3+4
}`),
    ).toBe(10);
  });
});
