// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Self-hosted Math builtins (#3141 — the porffor model, pilot).
 *
 * Each builtin here is ORDINARY TypeScript source written in the
 * IR-claimable subset (annotated f64 params/locals, if/while/return,
 * ternaries, `Math.<abs|sqrt|floor|ceil|trunc>` — the #1371 whitelist —
 * and direct calls to sibling helpers by their funcMap name). The
 * compiler compiles these through its OWN pipeline at compile time
 * (`src/codegen/stdlib-selfhost.ts`: from-ast → IR passes → BackendEmitter)
 * and registers the result exactly where the hand-emitted `Instr[]`
 * versions used to be pushed (`emitInlineMathFunctions`).
 *
 * DIALECT RULES (keep sources inside the claimable subset):
 *   - every param/local/return annotated `: number` (lowered f64);
 *   - no `NaN` / `Infinity` identifiers (not in the IR subset):
 *       * "input is NaN"    → `if (x !== x) return x;` (returns the NaN);
 *       * "produce NaN"     → `0 / 0`;
 *       * "input is ±Inf"   → `Math.abs(x) > 1.7976931348623157e308`
 *         (only ±Infinity exceeds MAX_VALUE; NaN was returned earlier);
 *   - sibling-helper calls (`Math_exp(x)`) resolve by funcMap name at
 *     lowering time — list them in `callees` so the driver seeds
 *     `calleeTypes`; the callee must be registered before this builtin
 *     is emitted (Phase-1 core funcs precede Phase-2 derived ones in
 *     `emitInlineMathFunctions`).
 *
 * NUMERIC EQUIVALENCE: each source mirrors the deleted hand-written
 * `Instr[]` body op-for-op (same operand order, same special-case
 * ladder). Non-NaN IEEE f64 add/sub/mul/div/sqrt results are deterministic
 * and identical between the hand-scheduled and IR-scheduled instruction
 * streams. NaN payloads and signs need an explicit canonicalization whenever
 * a helper promises raw-bit identity. Redundant ±Infinity special cases were
 * dropped ONLY where the shared core (`Math_exp` / `Math_log`) already
 * produces the identical value for the infinite input (noted per function).
 */

export interface StdlibMathBuiltin {
  /** funcMap registration name — also the function's name in `source`. */
  readonly name: string;
  /** Sibling math helpers this builtin calls (all `(f64) -> f64`). */
  readonly callees: readonly string[];
  /** Ordinary TS source, IR-claimable subset (see header). */
  readonly source: string;
  /**
   * Number of `(f64) -> f64` positional params (default 1). `2` is used by
   * `atan2(y, x)` and `pow(base, exp)` — still pure f64, just binary, so they
   * flow through the generalized #3161 typed path with `paramTypes: [F64, F64]`.
   * Callees remain unary `(f64) -> f64`.
   */
  readonly arity?: 1 | 2;
}

/**
 * Math.cbrt — cube root via Newton's method (8 iterations, seeded with
 * copysign(sqrt(sqrt(|x|)), x)). Mirrors the hand version exactly: for
 * x < 0 every Newton step is the exact IEEE negation of the positive
 * run, so seeding with -sqrt(sqrt(|x|)) and iterating signed matches
 * the deleted copysign-seeded body bit-for-bit.
 */
const CBRT_SOURCE = `
export function Math_cbrt(x: number): number {
  if (x === 0) return x;
  if (x !== x) return x;
  let ax: number = Math.abs(x);
  if (ax > 1.7976931348623157e308) return x;
  let guess: number = Math.sqrt(Math.sqrt(ax));
  if (x < 0) guess = -guess;
  let i: number = 8;
  while (i > 0) {
    guess = (guess * 2 + x / (guess * guess)) / 3;
    i = i - 1;
  }
  return guess;
}
`;

/**
 * Math.round — floor/fraction/ceil implements ties toward +Infinity without
 * perturbing large integral f64 values. The explicit zero arm preserves -0
 * for x === -0 and every x in [-0.5, 0). NaN follows the same floor path as
 * the direct emitter so its payload behavior remains identical.
 */
const ROUND_SOURCE = `
export function Math_round(x: number): number {
  let floorValue: number = Math.floor(x);
  let fraction: number = x - floorValue;
  let result: number = fraction >= 0.5 ? Math.ceil(x) : floorValue;
  if (result === 0) {
    if (x === 0) return x;
    return x < 0 ? -0 : 0;
  }
  return result;
}
`;

/**
 * Math.sign — preserve signed zero, canonicalize NaN like the direct emitter,
 * and otherwise return the exact sign unit. Folding or evaluating `0 / 0` may
 * choose either NaN sign, so `Math.abs` forces the positive canonical sign
 * inside the provider. The argument is evaluated once by the ordinary call
 * boundary.
 */
const SIGN_SOURCE = `
export function Math_sign(x: number): number {
  if (x !== x) return Math.abs(0 / 0);
  if (x === 0) return x;
  return x < 0 ? -1 : 1;
}
`;

/**
 * Math.sinh = (exp(x) - 1/exp(x)) / 2. §21.3.2.31: sinh(±0) = ±0.
 * ±Infinity specials dropped: Math_exp(+Inf)=Inf → (Inf - 0)/2 = Inf;
 * Math_exp(-Inf)=0 → (0 - Inf)/2 = -Inf — identical to the hand ladder.
 */
const SINH_SOURCE = `
export function Math_sinh(x: number): number {
  if (x !== x) return x;
  if (x === 0) return x;
  let ep: number = Math_exp(x);
  return (ep - 1 / ep) / 2;
}
`;

/**
 * Math.cosh = (exp(x) + 1/exp(x)) / 2.
 * ±Infinity special dropped: exp(±Inf) ∈ {Inf, 0} → (Inf+0)/2 = Inf both ways.
 */
const COSH_SOURCE = `
export function Math_cosh(x: number): number {
  if (x !== x) return x;
  let ep: number = Math_exp(x);
  return (ep + 1 / ep) / 2;
}
`;

/**
 * Math.tanh = (exp(2x) - 1) / (exp(2x) + 1), saturated at |x| > 20.
 * §21.3.2.34: tanh(±0) = ±0.
 */
const TANH_SOURCE = `
export function Math_tanh(x: number): number {
  if (x !== x) return x;
  if (x > 20) return 1;
  if (x < -20) return -1;
  if (x === 0) return x;
  let e2x: number = Math_exp(x * 2);
  return (e2x - 1) / (e2x + 1);
}
`;

/**
 * Math.asinh = sign(x) * log(|x| + sqrt(x*x + 1)).
 * asinh(±0) = ±0 handled up front (the ternary sign-restore cannot
 * produce -0). ±Infinity specials dropped: log(Inf + Inf) = Inf via the
 * Math_log special ladder, sign restored by the ternary. The log
 * argument is > 1 for every remaining x, so r > 0 and `x < 0 ? -r : r`
 * equals the hand version's copysign(r, x).
 */
const ASINH_SOURCE = `
export function Math_asinh(x: number): number {
  if (x !== x) return x;
  if (x === 0) return x;
  let r: number = Math_log(Math.abs(x) + Math.sqrt(x * x + 1));
  return x < 0 ? -r : r;
}
`;

/**
 * Math.acosh = log(x + sqrt(x*x - 1)); domain x >= 1.
 */
const ACOSH_SOURCE = `
export function Math_acosh(x: number): number {
  if (x !== x) return x;
  if (x < 1) return 0 / 0;
  if (x === 1) return 0;
  return Math_log(x + Math.sqrt(x * x - 1));
}
`;

/**
 * Math.atanh = 0.5 * log((1+x)/(1-x)); domain |x| <= 1. atanh(±0) = ±0.
 * x === ±1 specials dropped: (2)/(0) = +Inf → log = +Inf, and
 * (0)/(2) = 0 → log(0) = -Inf via the Math_log special ladder —
 * identical to the hand version's explicit returns.
 */
const ATANH_SOURCE = `
export function Math_atanh(x: number): number {
  if (x !== x) return x;
  if (Math.abs(x) > 1) return 0 / 0;
  if (x === 0) return x;
  return Math_log((1 + x) / (1 - x)) * 0.5;
}
`;

/**
 * Math.expm1 = exp(x) - 1, Taylor (order 4) below |x| < 1e-5 for
 * precision. expm1(±0) = ±0. ±Infinity specials dropped:
 * exp(Inf)-1 = Inf; exp(-Inf)-1 = -1 — identical to the hand ladder.
 */
const EXPM1_SOURCE = `
export function Math_expm1(x: number): number {
  if (x !== x) return x;
  if (x === 0) return x;
  if (Math.abs(x) < 1e-5) {
    return x + x * x * 0.5 + x * x * x * (1 / 6) + x * x * x * x * (1 / 24);
  }
  return Math_exp(x) - 1;
}
`;

/**
 * Math.log1p = log(1 + x), Taylor (order 3) below |x| < 1e-4.
 * log1p(±0) = ±0 falls out of the Taylor arm (x - (+0) keeps the sign
 * of x, matching the hand instruction sequence). x === -1 → -Inf and
 * x < -1 → NaN both fall out of Math_log's own ladder (log(0) = -Inf,
 * log(negative) = NaN).
 */
const LOG1P_SOURCE = `
export function Math_log1p(x: number): number {
  if (x !== x) return x;
  if (Math.abs(x) < 1e-4) {
    return x - x * x * 0.5 + x * x * x * (1 / 3);
  }
  return Math_log(1 + x);
}
`;

/**
 * Math.log — natural log via range reduction to `f ∈ [sqrt(0.5), sqrt(2)]`
 * (`x = f · 2^e`) plus the `atanh` series `2t(1 + t²/3 + t²²/5 + …)` with
 * `t = (f-1)/(f+1)`. Mirrors the deleted hand `Instr[]` op-for-op (same
 * special-case ladder order, same Horner grouping, same LN2 constant), so
 * results are bit-identical. `-Infinity` for `x === 0` is produced with
 * `-1 / 0` (the dialect forbids the `Infinity` identifier; `0 / 0` is NaN);
 * the `x === +Infinity` arm is the `x > MAX_VALUE` test (negatives and NaN
 * already returned). The hand version's `if (f > sqrt2) { f *= 0.5; e += 1; }`
 * adjust is now expressed as the natural mid-body statement-if it mirrors:
 * the from-ast overlay bug that mis-scoped the `let` declarations FOLLOWING a
 * non-returning statement-if into its then-branch was root-caused and fixed in
 * #2856 (a lower.ts structurizer soundness bug — a tail-duplicated
 * continuation block leaked the `materialized` local set across the two `if`
 * arms, so the else-path read an unset local). The natural form is
 * bit-identical to the previous ternary workaround (`over`/`ea`/`fa`), verified
 * across a dense magnitude sweep + specials. Registered as an EARLY core
 * (before its hand-emitted callers pow/log10/asinh/acosh/atanh), not in the
 * leaf `SELF_HOSTED_MATH` map. (#3204, #2856)
 */
const LOG_SOURCE = `
export function Math_log(x: number): number {
  if (x < 0) return 0 / 0;
  if (x === 0) return -1 / 0;
  if (x !== x) return x;
  if (x > 1.7976931348623157e308) return x;
  if (x === 1) return 0;
  let e: number = 0;
  let f: number = x;
  while (f >= 2) { f = f * 0.5; e = e + 1; }
  while (f < 0.5) { f = f * 2; e = e - 1; }
  if (f > 1.4142135623730951) { f = f * 0.5; e = e + 1; }
  let t: number = (f - 1) / (f + 1);
  let t2: number = t * t;
  let p: number = ((((((t2 * (1 / 13) + 1 / 11) * t2 + 1 / 9) * t2 + 1 / 7) * t2 + 1 / 5) * t2 + 1 / 3) * t2 + 1) * t * 2;
  return p + e * 0.6931471805599453;
}
`;

/**
 * Math.log2 — identical range-reduction + `atanh` series as `Math.log`, then
 * `log2(f) = log(f) · LOG2E` added to the exponent `e`. The hand version's
 * `if (f === 1) return e;` short-circuit is dropped: at `f === 1` the series
 * yields `t = 0 → p = 0 → 0·LOG2E + e = e` exactly, so the result is
 * bit-identical without the branch. LOG2E = 1.4426950408889634. (#3204)
 */
const LOG2_SOURCE = `
export function Math_log2(x: number): number {
  if (x < 0) return 0 / 0;
  if (x === 0) return -1 / 0;
  if (x !== x) return x;
  if (x > 1.7976931348623157e308) return x;
  if (x === 1) return 0;
  let e: number = 0;
  let f: number = x;
  while (f >= 2) { f = f * 0.5; e = e + 1; }
  while (f < 0.5) { f = f * 2; e = e - 1; }
  if (f > 1.4142135623730951) { f = f * 0.5; e = e + 1; }
  let t: number = (f - 1) / (f + 1);
  let t2: number = t * t;
  let p: number = ((((((t2 * (1 / 13) + 1 / 11) * t2 + 1 / 9) * t2 + 1 / 7) * t2 + 1 / 5) * t2 + 1 / 3) * t2 + 1) * t * 2;
  return p * 1.4426950408889634 + e;
}
`;

/**
 * __math_reduce_trig — Cody-Waite reduction of `x` to `[-π, π]`.
 * `n = floor(x / 2π + 0.5)` then a two-step `x - n·(2π_hi) - n·(2π_lo)`
 * subtraction (`2π_hi = 6.283185307179586`, `2π_lo = 1.2246467991473532e-16`)
 * for extra precision. `INV_TWO_PI = 0.15915494309189535` (= 1/2π, exact
 * round-trip). Mirrors the deleted hand `Instr[]` op-for-op (`x * INV`,
 * `+ 0.5`, `Math.floor`, then the left-associated double subtract), so
 * bit-identical. Leaf helper (no callees). (#3204 follow-up)
 */
const REDUCE_TRIG_SOURCE = `
export function __math_reduce_trig(x: number): number {
  let n: number = Math.floor(x * 0.15915494309189535 + 0.5);
  return x - n * 6.283185307179586 - n * 1.2246467991473532e-16;
}
`;

/**
 * Math.sin — range-reduce to `[-π, π]` via `__math_reduce_trig`, then the
 * odd Taylor polynomial in Horner form `r·(1 + r²(-1/6 + r²(1/120 + …)))`.
 * Special ladder mirrors the hand version exactly: NaN → NaN, `|x| == ∞` →
 * NaN (spelled `Math.abs(x) > MAX_VALUE`; NaN already returned), `x === 0`
 * → x (preserves -0). The `- 1/N` subtractions are the exact IEEE
 * equivalent of the hand `+ f64.const(-1/N)` adds. (#3204 follow-up)
 */
const SIN_SOURCE = `
export function Math_sin(x: number): number {
  if (x !== x) return x;
  if (Math.abs(x) > 1.7976931348623157e308) return 0 / 0;
  if (x === 0) return x;
  let r: number = __math_reduce_trig(x);
  let r2: number = r * r;
  return ((((((r2 * (1 / 6227020800) - 1 / 39916800) * r2 + 1 / 362880) * r2 - 1 / 5040) * r2 + 1 / 120) * r2 - 1 / 6) * r2 + 1) * r;
}
`;

/**
 * Math.cos — same range reduction, even Taylor polynomial
 * `1 + r²(-1/2 + r²(1/24 + …))`. NaN → NaN, `|x| == ∞` → NaN. No `x === 0`
 * short-circuit needed (cos(0) falls out of the series as exactly 1, which
 * the hand version also computed rather than special-cased). (#3204 follow-up)
 */
const COS_SOURCE = `
export function Math_cos(x: number): number {
  if (x !== x) return x;
  if (Math.abs(x) > 1.7976931348623157e308) return 0 / 0;
  let r: number = __math_reduce_trig(x);
  let r2: number = r * r;
  return ((((((r2 * (1 / 479001600) - 1 / 3628800) * r2 + 1 / 40320) * r2 - 1 / 720) * r2 + 1 / 24) * r2 - 1 / 2) * r2 + 1);
}
`;

/**
 * Math.atan — argument reduction to `|t| ≤ tan(22.5°)` via two SEQUENTIAL
 * mid-body statement-ifs (the from-ast subset takes mid-body ifs without an
 * else), then the odd minimax polynomial. Equivalent to the hand version's
 * `if ax > 2.414… {…} else if ax > 0.414… {…}`: the first branch sets
 * `ax = -1/ax ∈ (-0.414…, 0)`, so the second guard is then always false —
 * exactly the else semantics. Natural statement-if form (a `let`/reassign
 * following a non-returning mid-body if); the from-ast overlay mis-scoping
 * that once forced a ternary rewrite was fixed in #2856 (structurizer
 * materialized-leak) + #2981. The final `copysign(r, x)` is `x < 0 ? -r : r`
 * (r > 0 for every remaining x since the +∞/−∞/0 cases returned early, so
 * this equals copysign bit-for-bit). ±∞ → ±π/2, NaN → NaN, 0 → x (keeps
 * -0). Leaf (no callees). (#3204 follow-up)
 */
const ATAN_SOURCE = `
export function Math_atan(x: number): number {
  if (x !== x) return x;
  if (x > 1.7976931348623157e308) return 1.5707963267948966;
  if (x < -1.7976931348623157e308) return -1.5707963267948966;
  if (x === 0) return x;
  let ax: number = Math.abs(x);
  let offset: number = 0;
  // Two SEQUENTIAL bare ifs (the from-ast subset takes mid-body ifs without
  // an else). Equivalent to the hand version's if/else-if: when the first
  // branch fires it sets ax = -1/ax ∈ (-0.414…, 0), so the second guard
  // (ax > 0.414…) is then always false — exactly the else semantics.
  if (ax > 2.414213562373095) {
    offset = 1.5707963267948966;
    ax = -(1 / ax);
  }
  if (ax > 0.414213562373095) {
    offset = 0.7853981633974483;
    ax = (ax - 1) / (ax + 1);
  }
  let t2: number = ax * ax;
  let p: number = (((((((t2 * (-1 / 15) + 1 / 13) * t2 - 1 / 11) * t2 + 1 / 9) * t2 - 1 / 7) * t2 + 1 / 5) * t2 - 1 / 3) * t2 + 1) * ax;
  let r: number = p + offset;
  return x < 0 ? -r : r;
}
`;

/**
 * Math.tan = sin/cos. NaN → NaN, `|x| == ∞` → NaN; otherwise
 * `Math_sin(x) / Math_cos(x)`. (#3204 follow-up)
 */
const TAN_SOURCE = `
export function Math_tan(x: number): number {
  if (x !== x) return x;
  if (Math.abs(x) > 1.7976931348623157e308) return 0 / 0;
  return Math_sin(x) / Math_cos(x);
}
`;

/**
 * Math.asin = atan(x / sqrt(1 - x²)). Domain guard `|x| > 1` → NaN; the
 * endpoints x = ±1 return ±π/2 directly (the general expression would
 * divide by sqrt(0) = 0). NaN → NaN. (#3204 follow-up)
 */
const ASIN_SOURCE = `
export function Math_asin(x: number): number {
  if (x !== x) return x;
  if (Math.abs(x) > 1) return 0 / 0;
  if (x === 1) return 1.5707963267948966;
  if (x === -1) return -1.5707963267948966;
  return Math_atan(x / Math.sqrt(1 - x * x));
}
`;

/**
 * Math.acos = π/2 - asin(x) = π/2 - atan(x / sqrt(1 - x²)). Domain guard
 * `|x| > 1` → NaN; x = 1 → 0, x = -1 → π. NaN → NaN. (#3204 follow-up)
 */
const ACOS_SOURCE = `
export function Math_acos(x: number): number {
  if (x !== x) return x;
  if (Math.abs(x) > 1) return 0 / 0;
  if (x === 1) return 0;
  if (x === -1) return 3.141592653589793;
  return 1.5707963267948966 - Math_atan(x / Math.sqrt(1 - x * x));
}
`;

/**
 * Math.atan2(y, x) — binary, pure f64 (#3226 pointer: NOT a dialect gap,
 * just 2-arg, so it flows through the generalized #3161 typed path with
 * `paramTypes: [F64, F64]`; the sole callee `Math_atan` stays unary f64).
 * Mirrors the deleted hand `Instr[]` body op-for-op — and, crucially,
 * calls the SAME self-hosted `Math_atan`, so results are bit-identical to
 * the hand version (they share that polynomial), not merely to JS Math.atan2.
 *
 * Dialect encodings of the hand ops:
 *   - NaN in either arg → return that NaN;
 *   - `copysign(mag, y)` with `mag >= 0` is `y < 0 ? -mag : mag` in the
 *     finite-nonzero-y branches (the sign of y is exactly its sign bit),
 *     and `1 / y < 0 ? -mag : mag` in the `y === 0` branch (probing the
 *     sign of ±0 via 1/±0 = ±Infinity);
 *   - `copysign(0, y)` for finite nonzero y is `y * 0` (IEEE multiply
 *     carries y's sign into the zero: (-5)*0 = -0, 5*0 = +0);
 *   - `x === ±Infinity` is `x > MAX_VALUE` / `x < -MAX_VALUE` (only ±Inf
 *     exceeds the finite max), `|y| === Infinity` is
 *     `Math.abs(y) > MAX_VALUE` (NaN already returned).
 * Constants are the exact f64s the hand body used: π = 3.141592653589793,
 * 3π/4 = 2.356194490192345, π/4 = 0.7853981633974483, π/2 = 1.5707963267948966.
 */
const ATAN2_SOURCE = `
export function Math_atan2(y: number, x: number): number {
  if (y !== y) return y;
  if (x !== x) return x;
  if (y === 0) {
    if (x > 0) return y;
    if (x < 0) return 1 / y < 0 ? -3.141592653589793 : 3.141592653589793;
    if (1 / x > 0) return y;
    return 1 / y < 0 ? -3.141592653589793 : 3.141592653589793;
  }
  if (x > 1.7976931348623157e308) {
    if (Math.abs(y) > 1.7976931348623157e308) return y < 0 ? -0.7853981633974483 : 0.7853981633974483;
    return y * 0;
  }
  if (x < -1.7976931348623157e308) {
    if (Math.abs(y) > 1.7976931348623157e308) return y < 0 ? -2.356194490192345 : 2.356194490192345;
    return y < 0 ? -3.141592653589793 : 3.141592653589793;
  }
  if (Math.abs(y) > 1.7976931348623157e308) return y < 0 ? -1.5707963267948966 : 1.5707963267948966;
  if (x > 0) return Math_atan(y / x);
  if (x < 0) {
    let a: number = Math_atan(y / x);
    return y >= 0 ? a + 3.141592653589793 : a - 3.141592653589793;
  }
  return y < 0 ? -1.5707963267948966 : 1.5707963267948966;
}
`;

/**
 * Early-core self-hosted builtins (#3204) — registered INLINE by
 * `emitInlineMathFunctions` at the exact emission point their hand-`Instr[]`
 * predecessors occupied (BEFORE the later hand cores that call them by
 * funcMap name: pow/log10 → Math_log; asin/acos/tan → atan/sin/cos). NOT
 * part of `SELF_HOSTED_MATH` (that map's leaves are emitted last).
 * Ordering constraint: `__math_reduce_trig` before sin/cos; sin/cos before
 * tan; atan before asin/acos (callees resolve by funcMap name at lower
 * time — see the phase order in `emitInlineMathFunctions`).
 */
export const LOG_BUILTIN: StdlibMathBuiltin = { name: "Math_log", callees: [], source: LOG_SOURCE };
export const LOG2_BUILTIN: StdlibMathBuiltin = { name: "Math_log2", callees: [], source: LOG2_SOURCE };
export const REDUCE_TRIG_BUILTIN: StdlibMathBuiltin = {
  name: "__math_reduce_trig",
  callees: [],
  source: REDUCE_TRIG_SOURCE,
};
export const SIN_BUILTIN: StdlibMathBuiltin = { name: "Math_sin", callees: ["__math_reduce_trig"], source: SIN_SOURCE };
export const COS_BUILTIN: StdlibMathBuiltin = { name: "Math_cos", callees: ["__math_reduce_trig"], source: COS_SOURCE };
export const ATAN_BUILTIN: StdlibMathBuiltin = { name: "Math_atan", callees: [], source: ATAN_SOURCE };
export const TAN_BUILTIN: StdlibMathBuiltin = {
  name: "Math_tan",
  callees: ["Math_sin", "Math_cos"],
  source: TAN_SOURCE,
};
export const ASIN_BUILTIN: StdlibMathBuiltin = { name: "Math_asin", callees: ["Math_atan"], source: ASIN_SOURCE };
export const ACOS_BUILTIN: StdlibMathBuiltin = { name: "Math_acos", callees: ["Math_atan"], source: ACOS_SOURCE };
export const ATAN2_BUILTIN: StdlibMathBuiltin = {
  name: "Math_atan2",
  callees: ["Math_atan"],
  source: ATAN2_SOURCE,
  arity: 2,
};

/**
 * Math.exp — Cody-style reduction `x = n·ln2 + r`, `|r| ≤ ln2/2`, then
 * `exp(r)` by an order-7 Taylor Horner and `2^n` by repeated SQUARING of the
 * non-negative integer `ni = |n|`. #3226 established this needs NO IEEE
 * exponent-field extraction / `reinterpret` — the hand body's `ni & 1` /
 * `ni >>> 1` are just parity + halve of a small non-negative integer, exactly
 * `ni - Math.floor(ni/2)*2` and `Math.floor(ni/2)` in pure f64 (bit-identical
 * for a non-negative integer). ±Infinity / overflow / underflow specials
 * mirror the hand ladder: `x == +Inf` → `x`; `x == -Inf` / `x < -745` → 0;
 * `x > 709.7` → `1 / 0` (= +Inf; the dialect forbids the `Infinity` identifier).
 * LOG2E = 1.4426950408889634, LN2 = 0.6931471805599453.
 */
const EXP_SOURCE = `
export function Math_exp(x: number): number {
  if (x !== x) return x;
  if (x > 1.7976931348623157e308) return x;
  if (x < -1.7976931348623157e308) return 0;
  if (x > 709.7) return 1 / 0;
  if (x < -745) return 0;
  let n: number = Math.floor(x * 1.4426950408889634 + 0.5);
  let r: number = x - n * 0.6931471805599453;
  let expR: number = ((((((r * (1 / 5040) + 1 / 720) * r + 1 / 120) * r + 1 / 24) * r + 1 / 6) * r + 1 / 2) * r + 1) * r + 1;
  let ni: number = Math.abs(n);
  let pow2: number = 1;
  let base: number = 2;
  while (ni > 0) {
    let half: number = Math.floor(ni / 2);
    if (ni - half * 2 === 1) { pow2 = pow2 * base; }
    base = base * base;
    ni = half;
  }
  if (n < 0) { pow2 = 1 / pow2; }
  return expR * pow2;
}
`;

/**
 * Math.log10 = `log(x) · LOG10E` with a round-to-nearest-integer correction
 * for exact powers of 10. #3226: the hand body's `f64.nearest` is AVOIDABLE —
 * the correction is gated by `|result - round| < 1e-12`, and within that guard
 * `Math.floor(result + 0.5)` (Math.floor is whitelisted) is bit-identical to
 * `f64.nearest` (the round-half-to-even tie at `x.5` is ~0.5 from any integer,
 * so it never enters the guard; both paths return the raw `result` there).
 * One sign-of-zero fix-up: `f64.nearest` preserves the sign of a near-zero
 * input (nearest(-4.3e-13) = -0) whereas `Math.floor(result + 0.5)` yields +0,
 * so when the rounded value is 0 the sign is restored from `result`
 * (`result < 0 ? -0 : 0`) — needed for `log10` of values just below 1.
 * LOG10E = 0.4342944819032518. Domain/specials fall out of `Math_log`'s own
 * ladder (log(≤0)/NaN/±Inf) then flow through the guard unchanged.
 */
const LOG10_SOURCE = `
export function Math_log10(x: number): number {
  let result: number = Math_log(x) * 0.4342944819032518;
  let rounded: number = Math.floor(result + 0.5);
  if (Math.abs(result - rounded) < 1e-12) {
    if (rounded === 0) return result < 0 ? -0 : 0;
    return rounded;
  }
  return result;
}
`;

/**
 * Math.pow(b, e) — binary, pure f64 (#3226: NOT a dialect gap). Mirrors the
 * hand `Instr[]` body's special-case ladder op-for-op, then two shared cores:
 *   - integer-exponent fast path (`trunc(e)===e && |e| < 2^31`): exact
 *     exponentiation-by-SQUARING, the f64 encoding of the hand i32 loop
 *     (`powN & 1` → `powN - Math.floor(powN/2)*2 === 1`, `powN >>> 1` →
 *     `Math.floor(powN/2)`) — bit-identical for the non-negative integer counter;
 *   - general path `Math_exp(e * Math_log(|b|/b))` — calls the SAME self-hosted
 *     exp/log, so bit-identical to the hand version (which shares those cores).
 * `i32.and` boolean combines become `&&`; `-0` results use a `-0` literal
 * (survives the IR path) or `b` itself (which is -0 in the neg-zero-base arm);
 * `±Infinity` via `1 / 0` / `-1 / 0`; NaN-out via `0 / 0`. §21.3.2.26 corner
 * `pow(±1, ±Infinity) → NaN` is preserved (checked before the base==1 arm).
 */
const POW_SOURCE = `
export function Math_pow(b: number, e: number): number {
  if (e === 0) return 1;
  if (b !== b) return b;
  if (e !== e) return e;
  if (Math.abs(b) === 1 && Math.abs(e) > 1.7976931348623157e308) return 0 / 0;
  if (b === 1) return 1;
  if (e === 1) return b;
  if (e === -1) return 1 / b;
  if (e === 0.5) return Math.sqrt(b);
  if (e === 2) return b * b;
  if (b === 0) {
    if (1 / b < 0 && e === Math.trunc(e) && Math.floor(Math.trunc(e) / 2) * 2 !== Math.trunc(e)) {
      if (e > 0) return b;
      return 1 / b;
    }
    if (e > 0) return 0;
    return 1 / 0;
  }
  if (b > 1.7976931348623157e308) {
    if (e > 0) return 1 / 0;
    return 0;
  }
  if (b < -1.7976931348623157e308) {
    if (e === Math.trunc(e) && Math.floor(Math.trunc(e) / 2) * 2 !== Math.trunc(e)) {
      if (e > 0) return -1 / 0;
      return -0;
    }
    if (e > 0) return 1 / 0;
    return 0;
  }
  if (e === Math.trunc(e) && Math.abs(e) < 2147483648) {
    let powRes: number = 1;
    let powBase: number = b;
    let powN: number = Math.abs(e);
    while (powN > 0) {
      let half: number = Math.floor(powN / 2);
      if (powN - half * 2 === 1) { powRes = powRes * powBase; }
      powBase = powBase * powBase;
      powN = half;
    }
    if (e < 0) { powRes = 1 / powRes; }
    return powRes;
  }
  if (b < 0) {
    if (e !== Math.trunc(e)) return 0 / 0;
    let res: number = Math_exp(e * Math_log(Math.abs(b)));
    if (Math.floor(Math.trunc(e) / 2) * 2 !== Math.trunc(e)) return -res;
    return res;
  }
  return Math_exp(e * Math_log(b));
}
`;

export const EXP_BUILTIN: StdlibMathBuiltin = { name: "Math_exp", callees: [], source: EXP_SOURCE };
export const LOG10_BUILTIN: StdlibMathBuiltin = { name: "Math_log10", callees: ["Math_log"], source: LOG10_SOURCE };
export const POW_BUILTIN: StdlibMathBuiltin = {
  name: "Math_pow",
  callees: ["Math_exp", "Math_log"],
  source: POW_SOURCE,
  arity: 2,
};

/**
 * The self-hosted subset of the Math family, keyed by `Math.<method>`
 * name. `exp`/`log10`/`pow` (#3226) and `atan2` (#3233) are self-hosted as
 * EARLY cores above — #3226 established none of them needs new dialect
 * intrinsics (the presumed i32-bit-op / reinterpret / `f64.nearest` gaps are
 * all avoidable in pure f64; see the per-source docs). The ONLY remaining
 * hand-emitted Math core is `random` — a host RNG import, not a dialect gap.
 * `log`/`log2` and the trig cores (reduce_trig, sin/cos/tan, atan/asin/acos)
 * are EARLY cores too.
 */
export const SELF_HOSTED_MATH: ReadonlyMap<string, StdlibMathBuiltin> = new Map([
  ["cbrt", { name: "Math_cbrt", callees: [], source: CBRT_SOURCE }],
  ["round", { name: "Math_round", callees: [], source: ROUND_SOURCE }],
  ["sign", { name: "Math_sign", callees: [], source: SIGN_SOURCE }],
  ["sinh", { name: "Math_sinh", callees: ["Math_exp"], source: SINH_SOURCE }],
  ["cosh", { name: "Math_cosh", callees: ["Math_exp"], source: COSH_SOURCE }],
  ["tanh", { name: "Math_tanh", callees: ["Math_exp"], source: TANH_SOURCE }],
  ["asinh", { name: "Math_asinh", callees: ["Math_log"], source: ASINH_SOURCE }],
  ["acosh", { name: "Math_acosh", callees: ["Math_log"], source: ACOSH_SOURCE }],
  ["atanh", { name: "Math_atanh", callees: ["Math_log"], source: ATANH_SOURCE }],
  ["expm1", { name: "Math_expm1", callees: ["Math_exp"], source: EXPM1_SOURCE }],
  ["log1p", { name: "Math_log1p", callees: ["Math_log"], source: LOG1P_SOURCE }],
]);
