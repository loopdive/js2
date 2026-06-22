import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2601 — Standalone String.fromCodePoint RangeError guard (§22.1.2.2).
//   Each argument, after ToNumber, must be an INTEGRAL Number in [0, 0x10FFFF]
//   else RangeError (steps 2b/2c). The native lowering omitted both guards, so
//   fromCodePoint(3.14) / (-1) / (0x10FFFF+1) / (NaN) / (Infinity) silently
//   truncated/wrapped instead of throwing.
//
//   Fix adds an `isFromCodePoint` flag to compileFromCharCodeFamily that, per
//   argument, coerces ToNumber→f64 (existing engine) then emits the integral
//   (trunc(cp) != cp, also catches NaN) + range (cp<0 || cp>0x10FFFF, catches
//   ±∞) check → emitThrowRangeError. fromCharCode does ToUint16 with NO such
//   check, so the guard is fromCodePoint-only. Substrate-independent (static
//   method, numeric args).
//
// `skipSemanticDiagnostics` mirrors the test262 runner.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

async function runGc(src: string): Promise<unknown> {
  const r = await compile(src, { skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2601 standalone String.fromCodePoint RangeError", () => {
  it("fromCodePoint(3.14) throws RangeError (non-integral)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { String.fromCodePoint(3.14); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  it("fromCodePoint(-1) throws RangeError (< 0)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { String.fromCodePoint(-1); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  it("fromCodePoint(0x10FFFF + 1) throws RangeError (> max)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { String.fromCodePoint(0x10FFFF + 1); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  it("fromCodePoint(NaN) throws RangeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { String.fromCodePoint(NaN); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  it("fromCodePoint(Infinity) throws RangeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { String.fromCodePoint(Infinity); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  it("fromCodePoint('x') → NaN → throws RangeError", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { String.fromCodePoint("x"); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  it("multi-arg: a later bad code point throws", async () => {
    expect(
      await runStandalone(
        `export function test(): number { try { String.fromCodePoint(65, 3.14); return 0; } catch(e) { return 1; } }`,
      ),
    ).toBe(1);
  });

  // Valid code points return correct strings (no over-throw).
  it("fromCodePoint(65) → 'A'", async () => {
    expect(
      await runStandalone(`export function test(): number { return String.fromCodePoint(65).charCodeAt(0); }`),
    ).toBe(65);
  });

  it("fromCodePoint(65.0) integral float → 'A'", async () => {
    expect(
      await runStandalone(`export function test(): number { return String.fromCodePoint(65.0).charCodeAt(0); }`),
    ).toBe(65);
  });

  it("fromCodePoint(0) is valid (inclusive lower bound)", async () => {
    expect(await runStandalone(`export function test(): number { return String.fromCodePoint(0).length; }`)).toBe(1);
  });

  it("fromCodePoint(0x10FFFF) is valid (inclusive upper bound, surrogate pair)", async () => {
    expect(
      await runStandalone(`export function test(): number { return String.fromCodePoint(0x10FFFF).length; }`),
    ).toBe(2);
  });

  it("fromCodePoint('65') → ToNumber → 'A'", async () => {
    expect(
      await runStandalone(`export function test(): number { return String.fromCodePoint("65").charCodeAt(0); }`),
    ).toBe(65);
  });

  it("fromCodePoint(65,66,67) multi-arg valid", async () => {
    expect(
      await runStandalone(`export function test(): number { return String.fromCodePoint(65, 66, 67).length; }`),
    ).toBe(3);
  });

  // Regression — fromCharCode must NOT throw on a fractional arg (ToUint16).
  it("fromCharCode(3.14) does NOT throw (guard is fromCodePoint-only)", async () => {
    expect(await runStandalone(`export function test(): number { return String.fromCharCode(3.14).length; }`)).toBe(1);
  });

  it("fromCharCode(65) → 'A'", async () => {
    expect(
      await runStandalone(`export function test(): number { return String.fromCharCode(65).charCodeAt(0); }`),
    ).toBe(65);
  });
});

describe("#2601 gc-mode (host path) unchanged", () => {
  it("gc fromCodePoint(65) → 'A'", async () => {
    expect(await runGc(`export function test(): number { return String.fromCodePoint(65).charCodeAt(0); }`)).toBe(65);
  });

  it("gc fromCharCode(65) → 'A'", async () => {
    expect(await runGc(`export function test(): number { return String.fromCharCode(65).charCodeAt(0); }`)).toBe(65);
  });
});
