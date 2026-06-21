// #2159 — standalone TypedArray element WRITE leaked a packed storage type.
//
// `a[i] = v` where `a` is a Uint8Array / Int8Array / Uint8ClampedArray /
// Int16Array / Uint16Array allocated the value temp local with the array's RAW
// element type (`i8`/`i16`). Those are *packed storage* types — valid only
// inside array elements / struct fields, never in a value position
// (param/result/local/global). The binary emitter rejected the leaked local
// with "Binary emit error: encodeValType: packed storage type \"i8\" is not
// valid in a value position", so EVERY byte/short typed-array element write was
// a hard compile error in standalone mode (the largest single slice of the
// TypedArray standalone-conformance gap, #2159).
//
// Fix (src/codegen/expressions/assignment.ts compileElementAssignment): unpack
// the store-value local type i8/i16 → i32, mirroring the read path
// (property-access.ts uses array.get_u/_s → i32). array.set re-packs the i32.
//
// These run in pure-WasmGC standalone mode (no JS host, empty import object) to
// pin the codegen path that test262 exercises.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2159 standalone typed-array element write (packed i8/i16 local leak)", () => {
  it("Uint8Array set/get compiles and round-trips", async () => {
    expect(
      await runStandalone(`export function run(): number { const a = new Uint8Array(3); a[0] = 255; return a[0]; }`),
    ).toBe(255);
  });

  it("Int8Array set/get (negative in-range value)", async () => {
    expect(
      await runStandalone(`export function run(): number { const a = new Int8Array(3); a[0] = -5; return a[0]; }`),
    ).toBe(-5);
  });

  it("Uint8ClampedArray set/get", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = new Uint8ClampedArray(3); a[1] = 200; return a[1]; }`,
      ),
    ).toBe(200);
  });

  it("Int16Array set/get (negative in-range value)", async () => {
    expect(
      await runStandalone(`export function run(): number { const a = new Int16Array(3); a[0] = -1000; return a[0]; }`),
    ).toBe(-1000);
  });

  it("Uint16Array set/get", async () => {
    expect(
      await runStandalone(`export function run(): number { const a = new Uint16Array(3); a[0] = 60000; return a[0]; }`),
    ).toBe(60000);
  });

  it("Uint8Array write in a loop", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = new Uint8Array(4); for (let i = 0; i < 4; i++) a[i] = i * 10; return a[3]; }`,
      ),
    ).toBe(30);
  });

  it("Uint8Array compound assignment (read-modify-write)", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = new Uint8Array(2); a[0] = 5; a[0] += 3; return a[0]; }`,
      ),
    ).toBe(8);
  });

  it("Uint8Array stores wrap to 8 bits (256 → 0)", async () => {
    expect(
      await runStandalone(`export function run(): number { const a = new Uint8Array(1); a[0] = 256; return a[0]; }`),
    ).toBe(0);
  });
});

// Slice 3 (#2159) — standalone DataView get/set typed accessors.
//
// `new DataView(buf)` unconditionally emitted a host `__dv_register_view`
// import (for the JS-host runtime bridge), so under `--target standalone` /
// `--target wasi` every DataView was an unsatisfiable import → hard instantiate
// failure (the 336-test DataView bucket, mostly `(none)`-leak compile errors).
// Fix: gate the host registration on JS-host mode; standalone lowers the
// accessors to pure-Wasm byte reads/writes on the i32_byte backing struct
// (dataview-native.ts). Also fixed the integer setter to wrap modulo 2^(8*bytes)
// (spec ToInt/ToUint) instead of saturating, so values ≥ 2^31 store correctly.
describe("#2159 standalone DataView typed accessors (no __dv_register_view leak)", () => {
  it("new DataView(buf) instantiates standalone with no host import", async () => {
    const r = await compile(
      `export function run(): number { const dv = new DataView(new ArrayBuffer(8)); dv.setInt32(0, 7, true); return dv.getInt32(0, true); }`,
      { target: "standalone" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect(
      (r.imports ?? []).some((i) => i.name === "__dv_register_view"),
      "no host-import leak",
    ).toBe(false);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as Record<string, () => number>).run()).toBe(7);
  });

  it("Int8/Uint8 round-trip + signed/unsigned reinterpretation", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const dv = new DataView(new ArrayBuffer(8));
           dv.setInt8(0, -56);
           if (dv.getInt8(0) !== -56) return 1;
           if (dv.getUint8(0) !== 200) return 2;
           return 0;
         }`,
      ),
    ).toBe(0);
  });

  it("Int16/Uint16/Int32/Uint32 round-trip, both endiannesses", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const dv = new DataView(new ArrayBuffer(32));
           dv.setInt16(0, -1000, true);   if (dv.getInt16(0, true)  !== -1000) return 1;
           dv.setInt16(2, -1000, false);  if (dv.getInt16(2, false) !== -1000) return 2;
           dv.setUint16(4, 40000, true);  if (dv.getUint16(4, true) !== 40000) return 3;
           dv.setInt32(8, -2000000000, false); if (dv.getInt32(8, false) !== -2000000000) return 4;
           dv.setUint32(12, 4000000000, true); if (dv.getUint32(12, true) !== 4000000000) return 5;
           return 0;
         }`,
      ),
    ).toBe(0);
  });

  it("Float32/Float64 round-trip, both endiannesses", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const dv = new DataView(new ArrayBuffer(32));
           dv.setFloat32(0, 1.5, true);   if (dv.getFloat32(0, true)  !== 1.5) return 1;
           dv.setFloat32(4, 1.5, false);  if (dv.getFloat32(4, false) !== 1.5) return 2;
           dv.setFloat64(8, -2.71828, true);  if (Math.abs(dv.getFloat64(8, true)  + 2.71828) > 1e-9) return 3;
           dv.setFloat64(16, -2.71828, false); if (Math.abs(dv.getFloat64(16, false) + 2.71828) > 1e-9) return 4;
           return 0;
         }`,
      ),
    ).toBe(0);
  });

  it("endianness controls byte order (little vs big)", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const dv = new DataView(new ArrayBuffer(8));
           dv.setUint16(0, 0x0102, true);
           if (dv.getUint8(0) !== 0x02 || dv.getUint8(1) !== 0x01) return 1;
           dv.setUint16(2, 0x0102, false);
           if (dv.getUint8(2) !== 0x01 || dv.getUint8(3) !== 0x02) return 2;
           return 0;
         }`,
      ),
    ).toBe(0);
  });

  it("integer setters apply modular wrap, NaN truncates to 0", async () => {
    expect(
      await runStandalone(
        `export function run(): number {
           const dv = new DataView(new ArrayBuffer(8));
           dv.setInt32(0, NaN, true);   if (dv.getInt32(0, true) !== 0) return 1;
           dv.setUint8(4, 256);         if (dv.getUint8(4) !== 0) return 2;
           dv.setUint8(5, 257);         if (dv.getUint8(5) !== 1) return 3;
           return 0;
         }`,
      ),
    ).toBe(0);
  });
});

// #2159 Slice 2 — standalone `byteLength` / `byteOffset` view-semantics.
//
// In standalone/WASI mode ArrayBuffer/SharedArrayBuffer are an `i32_byte` vec
// (field 0 = byte length) and TypedArrays are an f64 vec (or i8_byte for native
// Uint8Array) with field 0 = element COUNT. `byteLength` is element-size-scaled
// (`count * BYTES_PER_ELEMENT`); pre-fix it fell through to a 0 default. See
// src/codegen/property-access.ts (byteLength/byteOffset interception).
describe("#2159 standalone TypedArray/ArrayBuffer byteLength + byteOffset", () => {
  it("ArrayBuffer.byteLength is the byte count", async () => {
    expect(await runStandalone(`export function run(): number { return new ArrayBuffer(8).byteLength; }`)).toBe(8);
  });

  it("Int32Array.byteLength = length * 4", async () => {
    expect(await runStandalone(`export function run(): number { return new Int32Array(4).byteLength; }`)).toBe(16);
  });

  it("Float64Array.byteLength = length * 8", async () => {
    expect(await runStandalone(`export function run(): number { return new Float64Array(3).byteLength; }`)).toBe(24);
  });

  it("Int16Array.byteLength = length * 2", async () => {
    expect(await runStandalone(`export function run(): number { return new Int16Array(5).byteLength; }`)).toBe(10);
  });

  it("Uint8Array.byteLength = length * 1", async () => {
    expect(await runStandalone(`export function run(): number { return new Uint8Array(4).byteLength; }`)).toBe(4);
  });

  it("byteLength reads through a typed local", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a: Int32Array = new Int32Array(3); return a.byteLength; }`,
      ),
    ).toBe(12);
  });

  it("byteLength reads through a typed parameter", async () => {
    expect(
      await runStandalone(
        `function g(a: Float64Array): number { return a.byteLength; } export function run(): number { return g(new Float64Array(2)); }`,
      ),
    ).toBe(16);
  });

  it("empty TypedArray byteLength is 0", async () => {
    expect(await runStandalone(`export function run(): number { return new Int32Array(0).byteLength; }`)).toBe(0);
  });

  it("byteOffset on a fresh view is 0", async () => {
    expect(await runStandalone(`export function run(): number { return new Int32Array(4).byteOffset; }`)).toBe(0);
  });
});
