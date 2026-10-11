// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#2056) Wasm-native IEEE-754 remainder (`fmod`) helper for the JS `%`
 * operator on f64 operands.
 *
 * ## Why a dedicated function instead of inline `a - trunc(a/b)*b`
 * The legacy formula `a - trunc(a/b)*b` (+ `f64.copysign`) is NOT
 * [Number::remainder (§6.1.6.1.6)](https://tc39.es/ecma262/#sec-numeric-types-number-remainder),
 * which is the *exact* mathematical remainder (IEEE fmod). The formula has
 * three rounding steps and:
 *   - drifts by ULPs whenever `a/b` rounds,
 *   - collapses to `0` when `trunc(a/b)*b` rounds back to `a`
 *     (e.g. `1e16 % 0.0001`, `123456789.123 % 0.001`),
 *   - produces `±Infinity` when `a/b` overflows f64 (ratio ≳ 1e308,
 *     e.g. `1e308 % 1e-308`) — a categorically wrong value from core arithmetic.
 *
 * ## Algorithm — exact, no host import (dual-mode standalone)
 * Classic binary long-division remainder operating purely in f64. All
 * intermediate values stay ≤ |a|, so nothing overflows, and every step is an
 * exact f64 operation (multiply/halve by 2 and subtraction of aligned values
 * are exact), so there is zero rounding drift:
 *
 *   fmod(a, b):
 *     [large static divisor] if |a| < |b|             -> a
 *     if b == 0 or a is ±Inf or a/b is NaN          -> NaN
 *     if b is ±Inf (a finite)                        -> a
 *     x = |a|; y = |b|
 *     if x < y                                       -> copysign(x, a)
 *     t = y; while (t * 2 <= x) t *= 2     // t = y·2^k, largest ≤ x
 *     while (t >= y) { if (x >= t) x -= t; t *= 0.5 }
 *     return copysign(x, a)
 *
 * Iteration count is bounded by the binary-exponent difference of the operands
 * (≤ ~2098), i.e. O(1) for ordinary operands and bounded in the worst case.
 * Verified bit-for-bit against Node for the #2056 repro set, the #216 edge
 * cases (`x % Inf`, `-0 % x`, `x % -x`, `Inf % x`, `x % 0`, `NaN % x`), and
 * 500k randomized cases including subnormal divisors.
 *
 * The funcIdx is registered in `funcMap` (not handed out as a raw number) so
 * the late-import index-shift contract (#329/#1899) patches both the map entry
 * and every emitted `call` by the same delta — same discipline as the accessor
 * drivers (`accessor-driver.ts`).
 */
import type { WasmFunction } from "../ir/types.js";
import { buildNumberRemainderBody } from "../wasm/physical/number-remainder.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";

/** Reserved name for the f64 remainder helper. */
export const FMOD_FN = "__fmod";
/** Large-static-divisor variant that checks `|a| < |b|` before integer guards. */
export const FMOD_EARLY_MAGNITUDE_FN = "__fmod_early_magnitude";

/**
 * Ensure the `__fmod` helper function exists in the module and return its
 * funcIdx. Idempotent — a second call returns the already-registered index.
 *
 * Signature: `(f64 a, f64 b) -> f64`.
 */
export function ensureFmod(ctx: CodegenContext): number {
  return ensureFmodVariant(ctx, FMOD_FN, false);
}

export function isFmodIntrinsic(name: string): name is typeof FMOD_FN | typeof FMOD_EARLY_MAGNITUDE_FN {
  return name === FMOD_FN || name === FMOD_EARLY_MAGNITUDE_FN;
}

/** Materialize either exact helper after the IR resolver validates its symbol. */
export function ensureFmodIntrinsic(
  ctx: CodegenContext,
  name: typeof FMOD_FN | typeof FMOD_EARLY_MAGNITUDE_FN,
): number {
  return ensureFmodVariant(ctx, name, name === FMOD_EARLY_MAGNITUDE_FN);
}

function ensureFmodVariant(ctx: CodegenContext, name: string, earlyMagnitude: boolean): number {
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const sigIdx = addFuncType(
    ctx,
    [{ kind: "f64" }, { kind: "f64" }],
    [{ kind: "f64" }],
    earlyMagnitude ? "$fmod_early_magnitude_type" : "$fmod_type",
  );
  const funcIdx = mintDefinedFunc(ctx);

  const fn: WasmFunction = {
    name,
    typeIdx: sigIdx,
    ...buildNumberRemainderBody(earlyMagnitude),
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}
