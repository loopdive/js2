// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1835 — C ABI string/array marshaling must use the verified linear-memory
// header layout:
//   string: [header 8B][len:u32 @ +8][utf8 bytes @ +12...]
//   array:  [header 8B][len:u32 @ +8][cap:u32 @ +12][elems:i32×cap @ +16...]
//
// Return marshaling exposes (data ptr, len); param marshaling rehydrates an
// internal header object from a raw (ptr, len) pair via __str_from_data /
// __arr_from_data.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function decodeStr(mem: WebAssembly.Memory, ptr: number, len: number): string {
  return new TextDecoder().decode(new Uint8Array(mem.buffer, ptr, len));
}

function writeStr(mem: WebAssembly.Memory, ptr: number, s: string): number {
  const bytes = new TextEncoder().encode(s);
  new Uint8Array(mem.buffer, ptr, bytes.length).set(bytes);
  return bytes.length;
}

describe("#1835 C ABI string return marshaling", () => {
  it("returns (dataPtr, len) pointing at the UTF-8 bytes, not into the header", async () => {
    const result = await compile(`export function greet(): string { return "Hi"; }`, {
      target: "linear",
      abi: "c",
    });
    expect(result.success).toBe(true);

    const { instance } = await WebAssembly.instantiate(result.binary);
    const mem = instance.exports.memory as WebAssembly.Memory;
    const greet = instance.exports.greet as () => [number, number];
    const ret = greet();
    expect(Array.isArray(ret)).toBe(true);
    const [ptr, len] = ret;
    expect(len).toBe(2);
    expect(decodeStr(mem, ptr, len)).toBe("Hi");
  });

  it("reports the correct length for a multi-byte string", async () => {
    const result = await compile(`export function s(): string { return "hello world"; }`, {
      target: "linear",
      abi: "c",
    });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    const mem = instance.exports.memory as WebAssembly.Memory;
    const [ptr, len] = (instance.exports.s as () => [number, number])();
    expect(len).toBe(11);
    expect(decodeStr(mem, ptr, len)).toBe("hello world");
  });

  it("emits a (T*, len) out-param signature in the C header for string returns", async () => {
    const result = await compile(`export function greet(): string { return "Hi"; }`, {
      target: "linear",
      abi: "c",
    });
    expect(result.success).toBe(true);
    // Two i32 results → header expresses the second as an out-pointer.
    expect(result.cHeader).toContain("greet(");
    expect(result.cHeader).toContain("out_0");
  });
});

describe("#1835 C ABI string param marshaling", () => {
  it("rehydrates a string param from a raw (ptr, len) pair", async () => {
    const result = await compile(`export function lenOf(s: string): number { return s.length; }`, {
      target: "linear",
      abi: "c",
    });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    const mem = instance.exports.memory as WebAssembly.Memory;
    // Scratch region clear of the runtime heap.
    const ptr = 60000;
    const len = writeStr(mem, ptr, "hello");
    const out = (instance.exports.lenOf as (p: number, l: number) => number)(ptr, len);
    expect(out).toBe(5);
  });

  it("handles an empty-string param", async () => {
    const result = await compile(`export function lenOf(s: string): number { return s.length; }`, {
      target: "linear",
      abi: "c",
    });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    const out = (instance.exports.lenOf as (p: number, l: number) => number)(60000, 0);
    expect(out).toBe(0);
  });
});

describe("#1835 C ABI array return marshaling", () => {
  it("returns (dataPtr, len) pointing at the element block, not into the header", async () => {
    const result = await compile(`export function mk(): number[] { return [10, 20, 30]; }`, {
      target: "linear",
      abi: "c",
    });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    const mem = instance.exports.memory as WebAssembly.Memory;
    const ret = (instance.exports.mk as () => [number, number])();
    expect(Array.isArray(ret)).toBe(true);
    const [ptr, len] = ret;
    expect(len).toBe(3);
    // #1938: number[] elements are 8-byte f64 slots (stride 8) — the payload is
    // a contiguous block of doubles, read it as a Float64Array (the C header
    // advertises a `double*` for number-array returns).
    const doubles = new Float64Array(mem.buffer, ptr, len);
    expect(Array.from(doubles)).toEqual([10, 20, 30]);
  });

  it("preserves fractional number[] elements across the C ABI boundary (#1938)", async () => {
    const result = await compile(`export function mk(): number[] { return [1.5, -2.25, 3.75]; }`, {
      target: "linear",
      abi: "c",
    });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    const mem = instance.exports.memory as WebAssembly.Memory;
    const [ptr, len] = (instance.exports.mk as () => [number, number])();
    expect(len).toBe(3);
    const doubles = new Float64Array(mem.buffer, ptr, len);
    expect(Array.from(doubles)).toEqual([1.5, -2.25, 3.75]);
  });
});

describe("#1835 scalar returns remain unaffected", () => {
  it("number return is still a single direct value", async () => {
    const result = await compile(`export function add(a: number, b: number): number { return a + b; }`, {
      target: "linear",
      abi: "c",
    });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary);
    expect((instance.exports.add as (a: number, b: number) => number)(3, 4)).toBe(7);
  });
});
