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
