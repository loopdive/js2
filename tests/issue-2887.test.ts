import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #2887 — the runtime Math_pow helper (used by the `**` operator, `**=`
// compound assignment, and Math.pow) computed base^exp via the generic
// `exp(exp * log(base))` path even for integer exponents. That is ~1 ULP low
// for non-power-of-two integer results (3**3 → 26.999999999461526,
// 5**3 → 124.99999…, 10**3 → 999.99999…). With an i32-typed accumulator this
// truncated to a visibly wrong integer (3 **= 3 → 26, -3 **= 3 → -26).
//
// Fix: an exact exponentiation-by-squaring fast path for integer exponents
// that fit an i32 counter (mirrors V8's `power_double_int`), so integer
// powers are exact while ±Infinity / huge / fractional exponents keep the
// existing exp/log behaviour.

async function pow(): Promise<(x: number, y: number) => number> {
  const exports = await compileToWasm(`export function test(x: number, y: number): number { return x ** y; }`);
  return (exports as { test: (x: number, y: number) => number }).test;
}

async function powAssign(base: number, exp: number): Promise<number> {
  // Use a parameter as the base so the operation is NOT constant-folded.
  const exports = await compileToWasm(`export function test(b: number): number { b **= ${exp}; return b; }`);
  return (exports as { test: (b: number) => number }).test(base);
}

describe("#2887 runtime exponentiation precision", () => {
  it("integer powers are exact via the `**` operator at runtime", async () => {
    const p = await pow();
    expect(p(3, 3)).toBe(27);
    expect(p(5, 3)).toBe(125);
    expect(p(10, 3)).toBe(1000);
    expect(p(-3, 3)).toBe(-27);
    expect(p(7, 4)).toBe(2401);
    expect(p(2, 10)).toBe(1024);
  });

  it("negative and zero integer exponents are exact", async () => {
    const p = await pow();
    expect(p(2, -3)).toBe(0.125);
    expect(p(-2, -3)).toBe(-0.125);
    expect(p(5, 0)).toBe(1);
    expect(p(-3, 2)).toBe(9);
  });

  it("`**=` compound assignment is exact (was 3**=3 → 26)", async () => {
    expect(await powAssign(3, 3)).toBe(27);
    expect(await powAssign(-3, 3)).toBe(-27);
    expect(await powAssign(5, 3)).toBe(125);
    expect(await powAssign(10, 3)).toBe(1000);
  });

  it("preserves fractional / sqrt exponents", async () => {
    const p = await pow();
    // exp == 0.5 is special-cased to f64.sqrt → exact.
    expect(p(4, 0.5)).toBe(2);
    expect(p(9, 0.5)).toBe(3);
    // Other fractional exponents keep the generic exp(exp*log(base)) path
    // (documented ~4-ULP approximation); the fast path must NOT hijack them.
    expect(Math.abs(p(27, 1 / 3) - 3)).toBeLessThan(1e-6);
  });

  it("preserves the special-value semantics (Infinity / NaN / negative base)", async () => {
    const p = await pow();
    // |base| > 1 with ±Infinity exponent
    expect(p(-1.5, Infinity)).toBe(Infinity);
    expect(p(-1.5, -Infinity)).toBe(0);
    expect(p(2, Infinity)).toBe(Infinity);
    // negative base with a non-integer exponent → NaN
    expect(Number.isNaN(p(-8, 0.5))).toBe(true);
    expect(Number.isNaN(p(-2, 2.5))).toBe(true);
    // NaN propagation
    expect(Number.isNaN(p(NaN, 2))).toBe(true);
    expect(Number.isNaN(p(2, NaN))).toBe(true);
    // base 0
    expect(p(0, 3)).toBe(0);
    expect(p(0, -1)).toBe(Infinity);
  });
});
