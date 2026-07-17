// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

/**
 * #2649 — Standalone `TypedArray.prototype.subarray(...).length` read 0.
 *
 * `a.subarray(b, e)` builds a `$__subview_<elem>` struct ({length, data,
 * byteOffset}) whose length field IS computed correctly. The bug was in the
 * `.length` MEMBER READ on the DIRECT chain `a.subarray(1).length`: the compiled
 * receiver type is the subview struct, but `resolveWasmType(Int8Array)` yields
 * the plain `$__vec_<elem>` type — the length dispatch `ref.test`ed the subview
 * against the vec type, missed, and returned the `f64.const 0` else-arm. Storing
 * the result in a typed variable first (`const s = a.subarray(1); s.length`)
 * masked it (the local carried the subview type). The fix reads `.length` field 0
 * directly off the compiled length-bearing struct type (property-access-dispatch).
 */
async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {} as WebAssembly.Imports);
  return (instance.exports as { test: () => number }).test();
}

async function runGc(source: string): Promise<number> {
  const r = await compile(source, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports as unknown as WebAssembly.Imports);
  return (instance.exports as { test: () => number }).test();
}

describe("#2649 standalone TypedArray.prototype.subarray().length", () => {
  it("direct chain a.subarray(begin).length (was 0)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = new Int8Array([10, 11, 12, 13]);
        return a.subarray(1).length;
      }`),
    ).toBe(3);
  });

  it("direct chain a.subarray(begin, end).length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = new Int8Array([10, 11, 12, 13]);
        return a.subarray(0, 2).length;
      }`),
    ).toBe(2);
  });

  it("direct chain a.subarray().length (full range)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = new Int8Array([10, 11, 12, 13]);
        return a.subarray().length;
      }`),
    ).toBe(4);
  });

  it("negative begin clamps against length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = new Int32Array([1, 2, 3, 4, 5]);
        return a.subarray(-2).length;
      }`),
    ).toBe(2);
  });

  it("element data through the subarray view still reads correctly", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = new Int8Array([10, 11, 12, 13]);
        return a.subarray(1)[0]!;
      }`),
    ).toBe(11);
  });

  it("32-bit view (Int32Array) direct-chain length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = new Int32Array([100, 200, 300, 400]);
        return a.subarray(1, 3).length;
      }`),
    ).toBe(2);
  });

  it("Float64Array direct-chain length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = new Float64Array([1, 2, 3, 4]);
        return a.subarray(2).length;
      }`),
    ).toBe(2);
  });

  it("nested subarray direct-chain length", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = new Int8Array([1, 2, 3, 4, 5, 6]);
        return a.subarray(1).subarray(1).length;
      }`),
    ).toBe(4);
  });

  it("via-variable form remains correct (regression guard)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const a = new Int8Array([10, 11, 12, 13]);
        const s = a.subarray(1);
        return s.length;
      }`),
    ).toBe(3);
  });

  it("gc-mode subarray length is unaffected", async () => {
    expect(
      await runGc(`export function test(): number {
        const a = new Int8Array([10, 11, 12, 13]);
        return a.subarray(1).length;
      }`),
    ).toBe(3);
  });
});
