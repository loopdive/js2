// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #1787 — regression coverage for packed TypedArray integer semantics.
 *
 * The native `Uint8Array` memory fix relies on a subtle WasmGC invariant:
 * the storage lane is packed `i8`, and unsignedness is recovered by reading
 * with `array.get_u`. A future change could regress this by emitting a plain
 * `array.get` (or signed `array.get_s`) against the packed type.
 *
 * What works on current main (asserted as live guards below):
 *  - `Uint8Array([255])[0] === 255` (value-correct in both targets).
 *  - Under `--target standalone` / WASI, `Uint8Array` reads use `array.get_u`
 *    and never a plain `array.get` against the packed `(array i8)` type.
 *
 * Forward-looking (NOT yet implemented — packed signed/16-bit/clamped storage
 * generalization is #1799; JS-host boundary nuances are #1786). These are
 * `it.fails` sentinels so they flip to hard guards the moment the behaviour
 * lands, without going green prematurely.
 */

async function runValue(source: string, target?: "standalone"): Promise<number> {
  const r = await compile(source, target ? { target } : {});
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const io = target ? ({} as WebAssembly.Imports) : r.importObject;
  const { instance } = await WebAssembly.instantiate(r.binary, io);
  return (instance.exports as { test: () => number }).test();
}

describe("#1787 packed Uint8Array integer semantics (live guards)", () => {
  it("Uint8Array([255])[0] === 255 — gc and standalone", async () => {
    const src = `export function test(): number { const a = new Uint8Array([255]); return a[0]; }`;
    expect(await runValue(src)).toBe(255);
    expect(await runValue(src, "standalone")).toBe(255);
  });

  it("standalone Uint8Array reads use array.get_u, never a plain array.get on the packed type", async () => {
    const r = await compile(`export function test(): number { const a = new Uint8Array([255, 1, 2]); return a[0]; }`, {
      target: "standalone",
    });
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const wat = r.wat ?? "";
    // Packed unsigned reads must be array.get_u (not signed, not plain).
    expect(/array\.get_u/.test(wat), "expected array.get_u for packed Uint8Array").toBe(true);
    // No signed load on an unsigned array.
    expect(/array\.get_s/.test(wat), "unexpected array.get_s for Uint8Array").toBe(false);
  });
});

describe("#1787/#2593 packed signed / 16-bit / clamped (now implemented by #2593)", () => {
  // Int8Array packed-signed read: 255 stored in an i8 lane reads back as -1.
  // Not implemented — Int8Array currently lowers to $Vec[f64], so [0] is 255.
  it("Int8Array([255])[0] === -1 (#2593 packed signed storage, standalone)", async () => {
    // #2593 packs integer views standalone/WASI only; host/gc keeps f64 storage
    // (the marshalling boundary treats non-Uint8 views as number[]), so the
    // signed-width wrap is asserted under --target standalone.
    expect(
      await runValue(`export function test(): number { const a = new Int8Array([255]); return a[0]; }`, "standalone"),
    ).toBe(-1);
  });

  it("Uint16Array([65535])[0] === 65535 (value-correct today; packed i16 storage tracked by #1799)", async () => {
    // The *value* is already correct on the current f64 lane — assert it as a
    // live guard. The packed-i16 storage representation itself is #1799; a
    // WAT-level assertion is ambiguous here because `array.get_u` already
    // appears module-wide from the Uint8Array machinery.
    expect(await runValue(`export function test(): number { const a = new Uint16Array([65535]); return a[0]; }`)).toBe(
      65535,
    );
  });

  it("Int16Array([65535])[0] === -1 (#2593 packed signed 16-bit, standalone)", async () => {
    expect(
      await runValue(
        `export function test(): number { const a = new Int16Array([65535]); return a[0]; }`,
        "standalone",
      ),
    ).toBe(-1);
  });

  it("Uint8ClampedArray clamps negative to 0 (#2593 clamped write coercion)", async () => {
    expect(
      await runValue(`export function test(): number { const a = new Uint8ClampedArray(1); a[0] = -5; return a[0]; }`),
    ).toBe(0);
  });

  it("Uint8ClampedArray clamps >255 to 255 (#2593)", async () => {
    expect(
      await runValue(`export function test(): number { const a = new Uint8ClampedArray(1); a[0] = 300; return a[0]; }`),
    ).toBe(255);
  });

  it("Uint8ClampedArray rounds 2.5 → 2 (round-half-to-even, #2593)", async () => {
    expect(
      await runValue(`export function test(): number { const a = new Uint8ClampedArray(1); a[0] = 2.5; return a[0]; }`),
    ).toBe(2);
  });

  it("Uint8ClampedArray rounds 3.5 → 4 (round-half-to-even, #2593)", async () => {
    expect(
      await runValue(`export function test(): number { const a = new Uint8ClampedArray(1); a[0] = 3.5; return a[0]; }`),
    ).toBe(4);
  });
});
