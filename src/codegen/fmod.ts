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
import type { Instr, WasmFunction } from "../ir/types.js";
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

  // Locals (after the two f64 params at indices 0=a, 1=b):
  //   2 = x (|a|, running remainder), 3 = y (|b|), 4 = t (aligned divisor)
  const A = 0;
  const B = 1;
  const X = 2;
  const Y = 3;
  const T = 4;
  const AI = 5; // (#4150) i32 view of a, for the integral fast path
  const BI = 6; // (#4150) i32 view of b

  const INF = Infinity;

  // For |a| < |b| every ECMAScript remainder edge collapses to `a` itself:
  // zero divisors and NaN/Infinity dividends fail the ordered comparison,
  // while an infinite divisor with finite `a` correctly returns `a`. Put this
  // exact fast path before the integral guards; rolling-modulo accumulators
  // commonly stay below their modulus for almost every iteration.
  const earlyMagnitudeFastPath: Instr[] = earlyMagnitude
    ? [
        { op: "local.get", index: A },
        { op: "f64.abs" },
        { op: "local.get", index: B },
        { op: "f64.abs" },
        { op: "f64.lt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "local.get", index: A }, { op: "return" }],
        },
      ]
    : [];
  const lateMagnitudeCheck: Instr[] = earlyMagnitude
    ? []
    : [
        { op: "local.get", index: X },
        { op: "local.get", index: Y },
        { op: "f64.lt" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: X },
            { op: "local.get", index: A },
            { op: "f64.copysign" },
            { op: "return" },
          ],
        },
      ];

  // `a` remains the sign carrier throughout. The specialized variant can
  // return it directly before any conversion; the standard variant reaches
  // the equivalent late `copysign(|a|, a)` check after the exceptional cases.
  const body: Instr[] = [
    ...earlyMagnitudeFastPath,
    // ── (#4150) Integral fast path — the overwhelmingly common shape ───────
    // `x % 3`, `i % n`, hash folds: both operands are whole numbers in i32
    // range, where the exact remainder is just `i32.rem_s`. Without this every
    // such `%` ran the binary long-division below — ~2× the binary-exponent
    // difference of the operands in f64 loop iterations (≈26 for `19998 % 3`)
    // where V8 issues a handful of instructions. That single helper is what
    // made `array/map-filter` (whose predicate is `x % 3 === 0`) the worst
    // gc-native parity gap.
    //
    // The guard is exact, not a heuristic: `f64.convert_i32_s(trunc_sat(v)) ==
    // v` is true ONLY for a whole number in i32 range. NaN and ±Inf saturate to
    // a finite i32 and fail the compare; a fractional value fails it; a value
    // beyond i32 range saturates and fails it. So everything the slow path
    // handles specially still reaches it.
    //
    // Sign: `i32.rem_s` already gives the dividend's sign for a nonzero
    // remainder, and the trailing `copysign` supplies the two cases i32 cannot
    // represent — `-6 % 3` and `-0 % 3` are both `-0` in JS (§6.1.6.1.6), not
    // `+0`. `-0` as the DIVIDEND takes this path (it converts equal to +0) and
    // copysign restores it; `-0` as the DIVISOR is excluded by `bi != 0` and
    // falls through to the `b == 0 → NaN` case below, which is correct.
    // `INT_MIN % -1` would trap `i32.rem_s`, so it is excluded and handled by
    // the exact path (which answers -0, matching JS).
    { op: "local.get", index: A },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: AI },
    { op: "f64.convert_i32_s" },
    { op: "local.get", index: A },
    { op: "f64.eq" },
    { op: "local.get", index: B },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: BI },
    { op: "f64.convert_i32_s" },
    { op: "local.get", index: B },
    { op: "f64.eq" },
    { op: "i32.and" },
    // bi != 0
    { op: "local.get", index: BI },
    { op: "i32.eqz" },
    { op: "i32.eqz" },
    { op: "i32.and" },
    // !(ai == INT_MIN && bi == -1)
    { op: "local.get", index: AI },
    { op: "i32.const", value: -2147483648 },
    { op: "i32.eq" },
    { op: "local.get", index: BI },
    { op: "i32.const", value: -1 },
    { op: "i32.eq" },
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: AI },
        { op: "local.get", index: BI },
        { op: "i32.rem_s" },
        { op: "f64.convert_i32_s" },
        { op: "local.get", index: A },
        { op: "f64.copysign" },
        { op: "return" },
      ],
    },

    // ── Non-finite / zero-divisor fast cases ───────────────────────────────
    // if (b == 0) return NaN
    { op: "local.get", index: B },
    { op: "f64.const", value: 0 },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (|a| == Inf) return NaN   (Inf % x, and NaN propagates below too)
    { op: "local.get", index: A },
    { op: "f64.abs" },
    { op: "f64.const", value: INF },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (a != a) return NaN  (NaN dividend)
    { op: "local.get", index: A },
    { op: "local.get", index: A },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (b != b) return NaN  (NaN divisor)
    { op: "local.get", index: B },
    { op: "local.get", index: B },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // if (|b| == Inf) return a  (a is finite here → remainder is a itself)
    { op: "local.get", index: B },
    { op: "f64.abs" },
    { op: "f64.const", value: INF },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: A }, { op: "return" }],
    },

    // ── x = |a|; y = |b| ───────────────────────────────────────────────────
    { op: "local.get", index: A },
    { op: "f64.abs" },
    { op: "local.set", index: X },
    { op: "local.get", index: B },
    { op: "f64.abs" },
    { op: "local.set", index: Y },

    ...lateMagnitudeCheck,

    // ── t = y; while (t * 2 <= x) t *= 2 ───────────────────────────────────
    { op: "local.get", index: Y },
    { op: "local.set", index: T },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if !(t * 2 <= x) break
            { op: "local.get", index: T },
            { op: "f64.const", value: 2 },
            { op: "f64.mul" },
            { op: "local.get", index: X },
            { op: "f64.le" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // t = t * 2
            { op: "local.get", index: T },
            { op: "f64.const", value: 2 },
            { op: "f64.mul" },
            { op: "local.set", index: T },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // ── while (t >= y) { if (x >= t) x -= t; t *= 0.5 } ─────────────────────
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if !(t >= y) break
            { op: "local.get", index: T },
            { op: "local.get", index: Y },
            { op: "f64.ge" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            // if (x >= t) x = x - t
            { op: "local.get", index: X },
            { op: "local.get", index: T },
            { op: "f64.ge" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: X },
                { op: "local.get", index: T },
                { op: "f64.sub" },
                { op: "local.set", index: X },
              ],
            },
            // t = t * 0.5
            { op: "local.get", index: T },
            { op: "f64.const", value: 0.5 },
            { op: "f64.mul" },
            { op: "local.set", index: T },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // return copysign(x, a)  — sign of the dividend, incl. -0 case
    { op: "local.get", index: X },
    { op: "local.get", index: A },
    { op: "f64.copysign" },
  ];

  const fn: WasmFunction = {
    name,
    typeIdx: sigIdx,
    locals: [
      { name: "$x", type: { kind: "f64" } }, // X
      { name: "$y", type: { kind: "f64" } }, // Y
      { name: "$t", type: { kind: "f64" } }, // T
      { name: "$ai", type: { kind: "i32" } }, // AI
      { name: "$bi", type: { kind: "i32" } }, // BI
    ],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}
