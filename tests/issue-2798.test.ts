// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2798 — Hybrid type-soundness audit Row 9: a typed-array (Uint8Array /
// Int32Array / Float64Array / …) OUT-OF-BOUNDS element read returns JS
// `undefined`. The *view length* is the bound, per the integer-indexed exotic
// object semantics (TC39 §10.4.5 `[[Get]]` of an out-of-range
// CanonicalNumericIndexString returns `undefined`).
//
// Scope / discipline (see the issue file for the full rationale):
//   - The policy is applied at the `compileElementAccessBody` call sites via a
//     DEDICATED helper (`emitTypedArrayUndefinedOobGet`), sibling to #2760's
//     `emitPlainArrayUndefinedOobGet`. The shared `emitBoundsCheckedArrayGet`
//     default AND `emitPlainArrayUndefinedOobGet` both stay byte-identical —
//     flipping the shared default was the #2198 S2 blast-radius leak.
//   - The unproven (non-bounds-eliminated) read widens to a boxed-number /
//     undefined externref; the proven in-bounds read keeps the unboxed fast
//     path. Numeric-context reads stay unboxed (the OOB element coerces to NaN).
//   - Typed-array elements are always `number` (the recognized views exclude
//     BigInt64Array/BigUint64Array), so the box is plain `__box_number` —
//     standalone-native, no new carrier (unlike #2792's `symbol[]`). Ships host
//     AND standalone.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

// Host-mode harness (buildImports + setExports — the canonical host runtime glue
// so a newly-imported helper can never be silently masked).
async function run(source: string, fn = "test"): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const instance = await instantiateWithRuntime(result);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]();
}

// Standalone harness (empty imports `{}` — a leaked host import fails
// instantiation; the binary must be valid Wasm). Standalone conflates
// `undefined` with `null`, so `=== undefined` is satisfied by the native
// `ref.null.extern` OOB sentinel — exactly as #2760's `number[]` floor.
async function runStandalone(source: string, fn = "test"): Promise<number> {
  const r = await compile(source, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as Record<string, () => number>)[fn]() as number;
}

describe("#2798 Row 9 — typed-array OOB element read → JS `undefined`", () => {
  describe("host — OOB reads undefined across the integer + float views", () => {
    it("Uint8Array OOB === undefined (literal index past end)", async () => {
      expect(
        await run(`export function test(): boolean { const a = new Uint8Array(2); return a[5] === undefined; }`),
      ).toBe(1);
    });

    it("Uint8Array OOB surfaces to JS as undefined (not 0 / sNaN)", async () => {
      expect(await run(`export function test(): any { const a = new Uint8Array(2); return a[5]; }`)).toBe(undefined);
    });

    it("Int32Array OOB === undefined", async () => {
      expect(
        await run(`export function test(): boolean { const a = new Int32Array(3); return a[9] === undefined; }`),
      ).toBe(1);
    });

    it("Float64Array OOB === undefined", async () => {
      expect(
        await run(`export function test(): boolean { const a = new Float64Array(2); return a[5] === undefined; }`),
      ).toBe(1);
    });

    it("Int8Array / Uint16Array / Uint32Array OOB all surface as undefined", async () => {
      expect(await run(`export function test(): any { const a = new Int8Array(2); return a[7]; }`)).toBe(undefined);
      expect(await run(`export function test(): any { const a = new Uint16Array(2); return a[7]; }`)).toBe(undefined);
      expect(await run(`export function test(): any { const a = new Uint32Array(2); return a[7]; }`)).toBe(undefined);
    });

    it("negative index reads undefined", async () => {
      expect(
        await run(`export function test(): boolean { const a = new Int32Array(3); return a[-1] === undefined; }`),
      ).toBe(1);
    });

    it("dynamic OOB index reads undefined", async () => {
      expect(
        await run(
          `export function test(): boolean { const a = new Uint8Array(2); let i = 9; return a[i] === undefined; }`,
        ),
      ).toBe(1);
    });

    // NOTE: `typeof a[OOB]` is deliberately NOT asserted here. `typeof` of a
    // statically `number`-typed operand folds to the string "number" WITHOUT
    // reading the runtime value (a separate static-typeof unsoundness), so it
    // returns "number" for an OOB typed-array read — and equally for R1's
    // already-merged `number[]` floor (#2760). That folding is orthogonal to
    // Row 9 and out of scope.
  });

  describe("host — in-bounds reads return the correct numeric value (unchanged)", () => {
    it("Uint8Array in-bounds (zero-extended)", async () => {
      expect(
        await run(`export function test(): any { const a = new Uint8Array(2); a[0] = 10; a[1] = 200; return a[1]; }`),
      ).toBe(200);
    });

    it("Int8Array in-bounds preserves the SIGN (get_s)", async () => {
      expect(await run(`export function test(): any { const a = new Int8Array(2); a[0] = -5; return a[0]; }`)).toBe(-5);
    });

    it("Int32Array in-bounds (signed)", async () => {
      expect(
        await run(`export function test(): any { const a = new Int32Array(2); a[0] = -123456; return a[0]; }`),
      ).toBe(-123456);
    });

    it("Uint32Array in-bounds is UNSIGNED (0..2^32-1, not the signed i32)", async () => {
      expect(
        await run(`export function test(): any { const a = new Uint32Array(1); a[0] = 4000000000; return a[0]; }`),
      ).toBe(4000000000);
    });

    it("Float64Array in-bounds (fractional)", async () => {
      expect(await run(`export function test(): any { const a = new Float64Array(2); a[0] = 3.5; return a[0]; }`)).toBe(
        3.5,
      );
    });
  });

  describe("host — numeric context keeps the unboxed read (OOB → NaN, the R1 lesson)", () => {
    it("OOB element in arithmetic is NaN (undefined → ToNumber)", async () => {
      expect(
        await run(
          `export function test(): boolean { const a = new Int32Array(2); let i = 9; let v = a[i] + 1; return v !== v; }`,
        ),
      ).toBe(1);
    });

    it("Math.max with two in-bounds typed-array element args is correct/unboxed", async () => {
      expect(
        await run(
          `export function test(): number { const a = new Int32Array(2); a[0] = 3; a[1] = 5; return Math.max(a[0], a[1]); }`,
        ),
      ).toBe(5);
    });
  });

  describe("host — bounds-eliminated counted loop keeps the unboxed fast path", () => {
    it("Int32Array counted-loop sum (no box)", async () => {
      expect(
        await run(
          `export function test(): number { const a = new Int32Array(4); for (let i = 0; i < 4; i++) a[i] = i + 1; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }`,
        ),
      ).toBe(10);
    });
  });

  describe("standalone — OOB undefined (≡ null), in-bounds preserved, valid Wasm", () => {
    it("Uint8Array OOB === undefined", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const a = new Uint8Array(2); return a[5] === undefined; }`,
        ),
      ).toBe(1);
    });

    it("Int32Array OOB === undefined", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const a = new Int32Array(3); return a[9] === undefined; }`,
        ),
      ).toBe(1);
    });

    it("Float64Array OOB === undefined", async () => {
      expect(
        await runStandalone(
          `export function test(): boolean { const a = new Float64Array(2); return a[5] === undefined; }`,
        ),
      ).toBe(1);
    });

    it("Uint8Array in-bounds read is preserved", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a = new Uint8Array(2); a[0] = 10; a[1] = 200; return a[1]; }`,
        ),
      ).toBe(200);
    });

    it("counted-loop sum (bounds-eliminated, no host import) is valid Wasm", async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a = new Int32Array(4); for (let i = 0; i < 4; i++) a[i] = i + 1; let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; }`,
        ),
      ).toBe(10);
    });
  });

  describe("shared-helper callers stay byte-identical — plain-array F1 still scoped (#2760)", () => {
    it("number[] OOB === undefined (plain-array F1 path, NOT the typed-array helper)", async () => {
      expect(
        await run(`export function test(): boolean { const a: number[] = [1, 4, 5]; return a[4] === undefined; }`),
      ).toBe(1);
    });

    it("number[] in-bounds read round-trips through arithmetic (unchanged)", async () => {
      expect(
        await run(`export function test(): number { const a: number[] = [1, 4, 5]; let i = 1; return a[i] + 10; }`),
      ).toBe(14);
    });
  });
});
