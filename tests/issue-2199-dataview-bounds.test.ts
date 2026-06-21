// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2199 — standalone DataView accessor §24.2.1.1 bounds validation.
 *
 * Before this slice, the native DataView get/set accessors
 * (`emitDataViewAccessor`, src/codegen/dataview-native.ts) computed
 * `trunc(byteOffset) + base` and read/wrote the backing i32-byte array with NO
 * argument validation. A negative / non-finite `byteOffset`, or one whose
 * `getIndex + elementSize` exceeds the view's byte length, **trapped**
 * `array element access out of bounds` (an uncatchable Wasm trap) instead of
 * throwing the spec-mandated **RangeError** — failing the whole
 * `built-ins/DataView/prototype/<accessor>/detached-buffer-after-toindex-byteoffset.js`
 * cluster (~59 tests), which asserts `RangeError` from `getX(-1)` / `getX(Infinity)`.
 *
 * Fix (§24.2.1.1 GetViewValue / §24.2.1.2 SetViewValue): an additive guard
 * prologue throws a catchable RangeError (the standalone-native in-module
 * `__new_RangeError` via the shared `$exc` tag — zero host imports) when the
 * request is NaN, the truncated index is negative, or
 * `getIndex + elementSize > viewByteLength`. `recoverDvBacking` now also yields
 * the view's byte length (window's `byteLength` field, or `array.len` of the
 * bare backing). Valid accesses are byte-identical to before.
 *
 * Standalone native byte buffers don't marshal across the export boundary, so
 * each case returns a number the test asserts directly.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runNum(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const labels = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(
    labels.filter((l) => !l.startsWith("wasi")),
    "standalone module must have zero host imports",
  ).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2199 standalone DataView accessor bounds → RangeError", () => {
  it("getFloat64(-1) throws RangeError, not an OOB trap", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(10)); try{ dv.getFloat64(-1); }catch(e){ return (e instanceof RangeError)?1:2; } return 0; }`,
      ),
    ).toBe(1);
  });

  it("getFloat64(Infinity) throws RangeError", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(10)); try{ dv.getFloat64(Infinity); }catch(e){ return (e instanceof RangeError)?1:2; } return 0; }`,
      ),
    ).toBe(1);
  });

  it("getUint8(100) past the end throws RangeError", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(8)); try{ dv.getUint8(100); }catch(e){ return (e instanceof RangeError)?1:2; } return 0; }`,
      ),
    ).toBe(1);
  });

  it("getInt32(5) on an 8-byte view (5+4>8) throws RangeError", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(8)); try{ dv.getInt32(5); }catch(e){ return (e instanceof RangeError)?1:2; } return 0; }`,
      ),
    ).toBe(1);
  });

  it("setUint8(-1, v) throws RangeError", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(4)); try{ dv.setUint8(-1, 5); }catch(e){ return (e instanceof RangeError)?1:2; } return 0; }`,
      ),
    ).toBe(1);
  });

  it("setFloat64(100, v) past the end throws RangeError", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(8)); try{ dv.setFloat64(100, 1.5); }catch(e){ return (e instanceof RangeError)?1:2; } return 0; }`,
      ),
    ).toBe(1);
  });

  it("windowed view: out-of-window access throws RangeError", async () => {
    expect(
      await runNum(
        `export function test(): number { const ab=new ArrayBuffer(16); const dv=new DataView(ab,4,8); try{ dv.getFloat64(4); }catch(e){ return (e instanceof RangeError)?1:2; } return 0; }`,
      ),
    ).toBe(1);
  });
});

describe("#2199 regression guards — valid DataView access unchanged", () => {
  it("getInt32 at the exact last valid offset (4 on 8-byte) works", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(8)); dv.setInt32(4, 77); return dv.getInt32(4); }`,
      ),
    ).toBe(77);
  });

  it("setFloat64/getFloat64 round-trip", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(8)); dv.setFloat64(0, 3.5); return dv.getFloat64(0); }`,
      ),
    ).toBe(3.5);
  });

  it("getUint16 little-endian round-trip", async () => {
    expect(
      await runNum(
        `export function test(): number { const dv=new DataView(new ArrayBuffer(4)); dv.setUint16(0, 0x1234, true); return dv.getUint16(0, true); }`,
      ),
    ).toBe(0x1234);
  });

  it("windowed view: valid read/write through the base offset", async () => {
    expect(
      await runNum(
        `export function test(): number { const ab=new ArrayBuffer(16); const dv=new DataView(ab,4,8); dv.setFloat64(0, 9.5); return dv.getFloat64(0); }`,
      ),
    ).toBe(9.5);
  });
});
