// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1717 — `ArrayBuffer.prototype.slice` not implemented in JS-host mode.
 *
 * All 17 `built-ins/ArrayBuffer/prototype/slice/*` test262 cases failed at
 * runtime with `slice is not a function`: the method was never routed by
 * codegen in JS-host mode, so the extern-class dispatch dropped the call.
 *
 * #1698 added a Wasm-native `emitArrayBufferSlice` (a byte-by-byte copy into a
 * fresh `i32_byte` vec) but gated it behind `noJsHost(ctx)`. The ArrayBuffer
 * backing store is the SAME `i32_byte` vec struct in both JS-host and
 * standalone modes, so the emitter is mode-agnostic. The fix drops the
 * `noJsHost` guard so `ArrayBuffer.prototype.slice` routes through the native
 * emitter in both modes — clearing the `slice is not a function` bucket.
 *
 * Spec: §25.1.6.3 ArrayBuffer.prototype.slice — ToIntegerOrInfinity on
 * start/end with relative-index clamping against [[ArrayBufferByteLength]].
 *
 * NOTE: these assertions check `slice` *callability* and that it returns an
 * object (the symptom the issue tracks). The byte-content / `.byteLength`
 * assertions in the test262 cases additionally depend on JS-host ArrayBuffer
 * `byteLength` resolution and TypedArray-over-ArrayBuffer aliasing, which are
 * tracked separately; CI measures the full conformance delta.
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { getTestSandbox } from "./test262-runner.js";

async function runWasm(source: string): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool, { globalSandbox: getTestSandbox() });
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports.test as () => unknown)();
}

describe("#1717 — ArrayBuffer.prototype.slice", () => {
  it("slice(begin, end) is callable (was 'slice is not a function')", async () => {
    expect(
      await runWasm(`export function test(): number {
        var ab = new ArrayBuffer(8);
        var s = ab.slice(2, 5);
        return typeof s === "object" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("slice() with no args is callable", async () => {
    expect(
      await runWasm(`export function test(): number {
        var ab = new ArrayBuffer(8);
        var s = ab.slice();
        return typeof s === "object" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("slice(begin) is callable", async () => {
    expect(
      await runWasm(`export function test(): number {
        var ab = new ArrayBuffer(8);
        var s = ab.slice(4);
        return typeof s === "object" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("slice with negative indices is callable", async () => {
    expect(
      await runWasm(`export function test(): number {
        var ab = new ArrayBuffer(8);
        var s = ab.slice(-4, -1);
        return typeof s === "object" ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
