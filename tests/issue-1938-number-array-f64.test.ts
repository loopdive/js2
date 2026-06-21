// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1938 (part 2) — the linear backend stored `number[]` elements as i32, so
// `[1.5][0]` silently truncated to 1. Element storage is now an 8-byte f64 slot
// (`__arr_get`/`__arr_set`/`__arr_push` take/return f64); a fractional value
// round-trips exactly, while reference/string elements keep their i32 handle in
// the low 4 bytes of the slot (encode on store, decode on load).
//
// Part 1 (RHS-once) is covered separately in linear-element-assign.test.ts.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileLinear(source: string) {
  const result = await compile(source, { target: "linear" });
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary);
  return instance.exports as Record<string, (...args: number[]) => number>;
}

describe("#1938 linear number[] f64 element storage", () => {
  it("[1.5][0] returns 1.5 (was 1) — the headline regression", async () => {
    const e = await compileLinear(`export function f(): number { const a = [1.5]; return a[0]; }`);
    expect(e.f()).toBe(1.5);
  });

  it("preserves fractional precision across a sum read", async () => {
    const e = await compileLinear(
      `export function f(): number { const a = [0.1, 0.2, 0.3]; return a[0] + a[1] + a[2]; }`,
    );
    expect(e.f()).toBeCloseTo(0.6, 12);
  });

  it("push of a fractional value round-trips on index read", async () => {
    const e = await compileLinear(`export function f(): number { const a: number[] = []; a.push(1.25); return a[0]; }`);
    expect(e.f()).toBe(1.25);
  });

  it("element assignment stores the fractional value (set + read, RHS-once)", async () => {
    const e = await compileLinear(`export function f(): number { const a = [0, 0]; a[0] = 3.75; return a[0]; }`);
    expect(e.f()).toBe(3.75);
  });

  it("map stores fractional/doubled values without truncation", async () => {
    // Was [3, 5] (truncated) — now [3, 5] exactly for these, but the doubled
    // 1.5→3 path used to truncate the *intermediate* before storing.
    const e = await compileLinear(
      `export function f(): number { const a = [1.5, 2.5].map(x => x * 2); return a[0] + a[1]; }`,
    );
    expect(e.f()).toBe(8); // 3 + 5
  });

  it("map of a fractional transform keeps the fraction", async () => {
    const e = await compileLinear(
      `export function f(): number { const a = [2, 4].map(x => x / 4); return a[0] + a[1]; }`,
    );
    expect(e.f()).toBe(1.5); // 0.5 + 1.0
  });

  it("filter preserves fractional elements in the result array", async () => {
    const e = await compileLinear(
      `export function f(): number { const a = [1.5, 2.5, 3.5].filter(x => x > 2); return a[0] + a[1]; }`,
    );
    expect(e.f()).toBe(6); // 2.5 + 3.5
  });

  it("destructuring rest (__arr_slice) copies fractional elements via the raw 8-byte slot", async () => {
    // The rest binding routes through __arr_slice, which copies slots verbatim
    // via __arr_get → __arr_push — representation-correct for free once both are
    // f64-typed (#1938).
    const e = await compileLinear(`
      export function f(): number {
        const a = [9.25, 1.5, -2.5];
        const [, ...rest] = a;
        return rest[0] + rest[1];
      }
    `);
    expect(e.f()).toBe(-1); // 1.5 + (-2.5)
  });

  it("for-of read yields fractional elements", async () => {
    const e = await compileLinear(`
      export function f(): number {
        const a = [0.5, 1.25, 2.25];
        let sum: number = 0;
        for (const x of a) { sum = sum + x; }
        return sum;
      }
    `);
    expect(e.f()).toBe(4); // 0.5 + 1.25 + 2.25
  });

  it("NaN element round-trips (f64 store/load, no canonicalisation surprise)", async () => {
    const e = await compileLinear(`export function f(): number { const a = [NaN]; return a[0]; }`);
    expect(Number.isNaN(e.f())).toBe(true);
  });

  it("negative zero is preserved (was lost under i32 truncation)", async () => {
    const e = await compileLinear(`
      export function f(): number {
        const a = [-0];
        // 1 / -0 === -Infinity distinguishes -0 from +0
        return 1 / a[0];
      }
    `);
    expect(e.f()).toBe(-Infinity);
  });

  it("large integer beyond 2^31 is not truncated to i32 range", async () => {
    const e = await compileLinear(`export function f(): number { const a = [3000000000]; return a[0]; }`);
    expect(e.f()).toBe(3000000000); // would overflow i32
  });

  it("string[] element read still works (ref handle in low 4 bytes)", async () => {
    const e = await compileLinear(`
      export function f(): number {
        const a = ["ab", "cde"];
        // .length proves the slot decoded back to a valid string handle
        return a[1].length;
      }
    `);
    expect(e.f()).toBe(3);
  });

  it("string[] join round-trips through f64 slots", async () => {
    const e = await compileLinear(`
      export function f(): number {
        const a = ["x", "yy", "zzz"];
        return a.join("-").length;
      }
    `);
    expect(e.f()).toBe(8); // "x-yy-zzz"
  });

  it("nested number[][] inner element keeps its fraction", async () => {
    const e = await compileLinear(`
      export function f(): number {
        const a = [[1.5, 2.5], [3.5]];
        return a[0][0] + a[1][0];
      }
    `);
    expect(e.f()).toBe(5); // 1.5 + 3.5
  });

  it("boolean[] element reads back correctly (rides the f64 path)", async () => {
    const e = await compileLinear(`
      export function f(): number {
        const a = [true, false, true];
        let n: number = 0;
        if (a[0]) n = n + 1;
        if (a[1]) n = n + 10;
        if (a[2]) n = n + 100;
        return n;
      }
    `);
    expect(e.f()).toBe(101);
  });

  it("store-beyond-length zero-fills the gap with f64 zeros", async () => {
    const e = await compileLinear(`
      export function f(): number {
        const a: number[] = [1.5];
        a[3] = 4.5;
        // a[1], a[2] are the zero-filled gap; a[0]=1.5, a[3]=4.5
        return a[0] + a[1] + a[2] + a[3];
      }
    `);
    expect(e.f()).toBe(6); // 1.5 + 0 + 0 + 4.5
  });
});
