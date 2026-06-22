// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2593 — TypedArray integer element-width wrapping (standalone / WASI).
 *
 * Integer views pack into i8/i16/i32 storage and apply the spec coercion on
 * write (§7.1.x ToInt8/ToUint8/ToUint8Clamp/ToInt16/ToUint16/ToInt32/ToUint32)
 * and the view-name-driven sign extension on read (signed → `array.get_s`,
 * unsigned → `array.get_u`). Host/gc mode keeps the legacy f64 lane (the
 * marshalling boundary treats non-Uint8 views as `number[]`), so wrapping is
 * asserted under `--target standalone`.
 *
 * The keystone fix is that the COUNT constructor (`new Int32Array(n)`) now
 * allocates the SAME packed vec the read / `.byteLength` paths expect — before
 * #2593 it allocated an f64 vec for every non-Uint8 view, so an inline
 * `new Int32Array(4).byteLength` read field-0 through an i32_byte cast that
 * never matched (returned 0 / illegal cast).
 */

async function runStandalone(source: string): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {} as WebAssembly.Imports);
  return (instance.exports as { run: () => number }).run();
}

describe("#2593 TypedArray integer element-width wrapping (standalone)", () => {
  describe("signed wrap on write + signed read", () => {
    it("Int8Array a[0]=200 → -56 (ToInt8)", async () => {
      expect(
        await runStandalone(`export function run(): number { const a = new Int8Array(1); a[0] = 200; return a[0]; }`),
      ).toBe(-56);
    });

    it("Int16Array a[0]=40000 → -25536 (ToInt16)", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a = new Int16Array(1); a[0] = 40000; return a[0]; }`,
        ),
      ).toBe(-25536);
    });

    it("Int32Array a[0]=70000 → 70000 (in range, no wrap)", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a = new Int32Array(1); a[0] = 70000; return a[0]; }`,
        ),
      ).toBe(70000);
    });
  });

  describe("unsigned wrap on write + unsigned read", () => {
    it("Uint8Array a[0]=300 → 44 (ToUint8)", async () => {
      expect(
        await runStandalone(`export function run(): number { const a = new Uint8Array(1); a[0] = 300; return a[0]; }`),
      ).toBe(44);
    });

    it("Uint16Array a[0]=-1 → 65535 (ToUint16)", async () => {
      expect(
        await runStandalone(`export function run(): number { const a = new Uint16Array(1); a[0] = -1; return a[0]; }`),
      ).toBe(65535);
    });

    it("Uint32Array a[0]=-1 → 4294967295 (ToUint32, unsigned read)", async () => {
      expect(
        await runStandalone(`export function run(): number { const a = new Uint32Array(1); a[0] = -1; return a[0]; }`),
      ).toBe(4294967295);
    });
  });

  describe("Uint8ClampedArray (ToUint8Clamp — clamp + round-half-to-even)", () => {
    it("clamps 300 → 255", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a = new Uint8ClampedArray(1); a[0] = 300; return a[0]; }`,
        ),
      ).toBe(255);
    });

    it("clamps -5 → 0", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a = new Uint8ClampedArray(1); a[0] = -5; return a[0]; }`,
        ),
      ).toBe(0);
    });

    it("rounds 1.6 → 2", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a = new Uint8ClampedArray(1); a[0] = 1.6; return a[0]; }`,
        ),
      ).toBe(2);
    });

    it("rounds 2.5 → 2 (half-to-even)", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a = new Uint8ClampedArray(1); a[0] = 2.5; return a[0]; }`,
        ),
      ).toBe(2);
    });

    it("rounds 3.5 → 4 (half-to-even)", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a = new Uint8ClampedArray(1); a[0] = 3.5; return a[0]; }`,
        ),
      ).toBe(4);
    });
  });

  describe("count-constructor allocates packed storage — .byteLength keystone", () => {
    it("inline new Int32Array(4).byteLength === 16", async () => {
      expect(await runStandalone(`export function run(): number { return new Int32Array(4).byteLength; }`)).toBe(16);
    });

    it("inline new Int16Array(5).byteLength === 10", async () => {
      expect(await runStandalone(`export function run(): number { return new Int16Array(5).byteLength; }`)).toBe(10);
    });

    it("inline empty new Int32Array(0).byteLength === 0 (no illegal cast)", async () => {
      expect(await runStandalone(`export function run(): number { return new Int32Array(0).byteLength; }`)).toBe(0);
    });

    it("typed-local count ctor byteLength === 12", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a: Int32Array = new Int32Array(3); return a.byteLength; }`,
        ),
      ).toBe(12);
    });
  });

  describe("literal constructor packs + wraps", () => {
    it("new Int8Array([255])[0] === -1 (signed read)", async () => {
      expect(
        await runStandalone(`export function run(): number { const a = new Int8Array([255]); return a[0]; }`),
      ).toBe(-1);
    });

    it("new Int32Array([1,2,3])[1] === 2 and .byteLength === 12", async () => {
      expect(
        await runStandalone(`export function run(): number { const a = new Int32Array([1,2,3]); return a[1]; }`),
      ).toBe(2);
      expect(
        await runStandalone(
          `export function run(): number { const a = new Int32Array([1,2,3]); return a.byteLength; }`,
        ),
      ).toBe(12);
    });
  });

  describe("fill applies width-wrapping", () => {
    it("Int8Array(3).fill(200) → -56 at each index", async () => {
      expect(
        await runStandalone(
          `export function run(): number { const a = new Int8Array(3); a.fill(200); return a[0] + a[1] + a[2]; }`,
        ),
      ).toBe(-168);
    });
  });
});
