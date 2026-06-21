// #2159 — standalone TypedArray.prototype.fill() on byte/short typed arrays.
//
// `compileArrayFill` (src/codegen/array-methods.ts) allocated the fill-value
// temp local with the array's RAW element type. For byte/short typed arrays
// (Uint8Array / Int8Array / Uint8ClampedArray / Int16Array / Uint16Array) that
// element type is PACKED (`i8` / `i16`) — valid only inside array elements /
// struct fields, never in a value position. The leaked packed local made the
// binary emitter reject the module (`packed storage type "i8" is not valid in a
// value position`), so `a.fill(v)` was a hard compile error for every byte/short
// typed array standalone. (Int32Array / Float64Array were unaffected — their
// element type is already a value type.)
//
// Fix: unpack the value-local type `i8`/`i16` → `i32`; `array.set` re-packs the
// `i32` into the element on store (mirrors the element-assignment fix, Slice 1).
// The other prototype methods (set / subarray / copyWithin / slice) already hold
// their staging values as wider value types and were not affected.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  const hardErrors = (r.errors ?? []).filter((e) => e.severity !== "warning");
  expect(hardErrors, JSON.stringify(hardErrors)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>).run();
}

describe("#2159 standalone TypedArray.fill on byte/short arrays (packed local leak)", () => {
  it("Uint8Array.fill compiles and fills every slot", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = new Uint8Array(4); a.fill(255); return a[0] + a[3]; }`,
      ),
    ).toBe(510);
  });

  it("Int8Array.fill with a negative value round-trips signed", async () => {
    expect(
      await runStandalone(`export function run(): number { const a = new Int8Array(4); a.fill(-5); return a[0]; }`),
    ).toBe(-5);
  });

  it("Int16Array.fill with a negative value round-trips signed", async () => {
    expect(
      await runStandalone(`export function run(): number { const a = new Int16Array(4); a.fill(-1000); return a[0]; }`),
    ).toBe(-1000);
  });

  it("Uint16Array.fill compiles", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = new Uint16Array(3); a.fill(40000); return a[1]; }`,
      ),
    ).toBe(40000);
  });

  it("Uint8Array.fill with start/end fills only the requested range", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = new Uint8Array(4); a.fill(7, 1, 3); return a[0] * 100 + a[1] + a[3]; }`,
      ),
    ).toBe(7);
  });

  it("byte fill wraps modulo 256", async () => {
    expect(
      await runStandalone(`export function run(): number { const a = new Uint8Array(2); a.fill(257); return a[0]; }`),
    ).toBe(1);
  });

  it("Int32Array.fill still works (no regression for value-type elements)", async () => {
    expect(
      await runStandalone(
        `export function run(): number { const a = new Int32Array(4); a.fill(123456); return a[2]; }`,
      ),
    ).toBe(123456);
  });
});
