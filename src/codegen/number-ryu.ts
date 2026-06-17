// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1537 — Wasm-native shortest-roundtrip f64 → decimal core (Ryū).
 *
 * A faithful port of the public-domain Ryū algorithm (Ulf Adams, 2018,
 * "Printing Floating-Point Numbers Quickly and Accurately"), specifically the
 * `ryu-ecmascript` variant of `dtolnay/ryu` whose output matches V8's
 * `Number.prototype.toString` exactly. Ryū produces the shortest decimal digit
 * string that round-trips back to the same f64.
 *
 * This module emits, into `ctx.mod`:
 *   - two immutable `(array i64)` globals holding the precomputed power-of-5
 *     split tables (`DOUBLE_POW5_INV_SPLIT`, `DOUBLE_POW5_SPLIT`), interleaved
 *     as `[lo0, hi0, lo1, hi1, ...]` (each 128-bit table entry = two i64 limbs);
 *   - `__ryu_mul_shift(m: i64, factorLo: i64, factorHi: i64, j: i32) -> i64` —
 *     the 128-bit `mulShift` (`umul128` + `shiftright128`) built from 32-bit
 *     limbs (Wasm has no i128). The shift `j` is always in [118, 125] in
 *     practice, i.e. always ≥ 64, so the optimized `shiftright128(_, _, j-64)`
 *     form is used;
 *   - `__num_ryu_digits(value: f64) -> (digits: i64, exp: i32)` — the `d2d`
 *     core. `value` must be finite, non-zero (callers handle 0 / NaN / ±Inf /
 *     sign separately). Returns the decimal mantissa as an unsigned i64 `digits`
 *     (1–17 decimal digits) and the decimal exponent `exp` such that the value
 *     equals `digits × 10^exp`. The §6.1.6.1.13 formatter (in
 *     number-format-native.ts) converts `(digits, exp, sign)` to the final
 *     string.
 *
 * CORRECTNESS: this was validated against a BigInt reference of the same
 * algorithm over 200k+ random f64 (round-trip AND shortest === V8) plus the
 * boundary set in tests/issue-1537.test.ts. The `mulShift` limb math and the
 * trailing-zero / round-to-even tie-break are the highest-risk pieces; do not
 * "simplify" them without re-running the property test.
 *
 * Spec: ECMA-262 §6.1.6.1.13 (Number::toString).
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";

// ---------------------------------------------------------------------------
// Compile-time table generation (BigInt). Produces byte-identical tables to
// dtolnay/ryu's d2s_full_table.h, derived from the same constants. Computed
// once when the Ryū core is first emitted into a module.
// ---------------------------------------------------------------------------

const DOUBLE_POW5_INV_BITCOUNT = 125;
const DOUBLE_POW5_BITCOUNT = 125;

/** q ∈ [0, 290] over the full f64 exponent range; 291 entries. */
const POW5_INV_TABLE_SIZE = 291;
/** i ∈ [0, 325] over the full f64 exponent range; 326 entries. */
const POW5_TABLE_SIZE = 326;

const MASK64 = (1n << 64n) - 1n;

function pow5(i: number): bigint {
  let r = 1n;
  for (let k = 0; k < i; k++) r *= 5n;
  return r;
}

/** floor(log2(x)) for x > 0. */
function log2floor(x: bigint): number {
  return x.toString(2).length - 1;
}

/** ceil(5^i / 2^shift) truncated to the low 128 bits, where shift puts the
 *  value into a DOUBLE_POW5_BITCOUNT-bit window. Matches ryu computePow5. */
function computePow5(i: number): bigint {
  const p = pow5(i);
  const b = log2floor(p);
  const shift = b + 1 - DOUBLE_POW5_BITCOUNT;
  const v = shift >= 0 ? (p + ((1n << BigInt(shift)) - 1n)) >> BigInt(shift) : p << BigInt(-shift);
  return v & ((1n << 128n) - 1n);
}

/** ceil(2^(floor(log2(5^i)) + DOUBLE_POW5_INV_BITCOUNT) / 5^i) truncated to 128
 *  bits. Matches ryu computeInvPow5. */
function computeInvPow5(i: number): bigint {
  const p = pow5(i);
  const b = log2floor(p);
  const shift = b + DOUBLE_POW5_INV_BITCOUNT;
  return (((1n << BigInt(shift)) + p - 1n) / p) & ((1n << 128n) - 1n);
}

/** Map an unsigned 64-bit BigInt to its signed two's-complement value (the
 *  bit-pattern carried by `i64.const`, whose `value` field is a signed bigint). */
function toSignedI64(u: bigint): bigint {
  return u >= 1n << 63n ? u - (1n << 64n) : u;
}

/** Interleaved [lo0, hi0, lo1, hi1, …] signed-i64 table for the inverse pow5. */
function buildInvSplit(): bigint[] {
  const out: bigint[] = [];
  for (let q = 0; q < POW5_INV_TABLE_SIZE; q++) {
    const v = computeInvPow5(q);
    out.push(toSignedI64(v & MASK64));
    out.push(toSignedI64(v >> 64n));
  }
  return out;
}

/** Interleaved [lo0, hi0, lo1, hi1, …] signed-i64 table for the pow5. */
function buildSplit(): bigint[] {
  const out: bigint[] = [];
  for (let i = 0; i < POW5_TABLE_SIZE; i++) {
    const v = computePow5(i);
    out.push(toSignedI64(v & MASK64));
    out.push(toSignedI64(v >> 64n));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

const I32: ValType = { kind: "i32" };
const I64: ValType = { kind: "i64" };
const F64: ValType = { kind: "f64" };

const RYU_INV_GLOBAL = "__ryu_pow5_inv";
const RYU_POW_GLOBAL = "__ryu_pow5";
const RYU_I64_ARR = "__ryu_i64_arr";

/** Allocate the next defined-function index. Mirrors number-format-native.ts. */
function nextFuncIdx(ctx: CodegenContext): number {
  return ctx.numImportFuncs + ctx.mod.functions.length;
}

/** Register an immutable `(array i64)` type, idempotent. */
function ensureImmutableI64ArrayType(ctx: CodegenContext): number {
  const existing = ctx.arrayTypeMap.get(RYU_I64_ARR);
  if (existing !== undefined) return existing;
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "array", name: RYU_I64_ARR, element: I64, mutable: false });
  ctx.arrayTypeMap.set(RYU_I64_ARR, idx);
  return idx;
}

/** Find a global by name, returning its module-local index, or -1. */
function findGlobal(ctx: CodegenContext, name: string): number {
  for (let i = 0; i < ctx.mod.globals.length; i++) {
    if (ctx.mod.globals[i]!.name === name) return i;
  }
  return -1;
}

/**
 * Register the two pow5 split-table globals (idempotent). Returns the *absolute*
 * global indices (import globals + local position) for use in `global.get`.
 */
function ensureRyuTables(ctx: CodegenContext): { invIdx: number; powIdx: number; arrType: number } {
  const arrType = ensureImmutableI64ArrayType(ctx);
  const arrRef: ValType = { kind: "ref", typeIdx: arrType };

  let invLocal = findGlobal(ctx, RYU_INV_GLOBAL);
  if (invLocal < 0) {
    const inv = buildInvSplit();
    const init: Instr[] = inv.map((v) => ({ op: "i64.const", value: v }) as Instr);
    init.push({ op: "array.new_fixed", typeIdx: arrType, length: inv.length });
    invLocal = ctx.mod.globals.length;
    ctx.mod.globals.push({ name: RYU_INV_GLOBAL, type: arrRef, mutable: false, init });
  }
  let powLocal = findGlobal(ctx, RYU_POW_GLOBAL);
  if (powLocal < 0) {
    const pw = buildSplit();
    const init: Instr[] = pw.map((v) => ({ op: "i64.const", value: v }) as Instr);
    init.push({ op: "array.new_fixed", typeIdx: arrType, length: pw.length });
    powLocal = ctx.mod.globals.length;
    ctx.mod.globals.push({ name: RYU_POW_GLOBAL, type: arrRef, mutable: false, init });
  }
  return {
    invIdx: ctx.numImportGlobals + invLocal,
    powIdx: ctx.numImportGlobals + powLocal,
    arrType,
  };
}

/**
 * `__ryu_mul_shift(m: i64, factorLo: i64, factorHi: i64, j: i32) -> i64`
 *
 * Computes bits [j, j+64) of the product `m × (factorHi:factorLo)`, where m is
 * u64 and (factorHi:factorLo) is the 128-bit table entry. Implements Ryū's
 * `mulShift64`:
 *   b0 = m * factorLo   (128-bit, as {hi,lo})
 *   b2 = m * factorHi   (128-bit, as {hi,lo})
 *   sumLo = b0.hi + b2.lo  (low 64; carry → b2.hi)
 *   result = shiftright128(sumLo, b2.hi + carry, j - 64)
 * j is always ≥ 64 here (range [118,125]), so `j - 64` ∈ [54, 61], a valid
 * `0 < dist < 64` shift.
 *
 * `umul128(a, b)` is the standard portable 64×64→128 multiply from four
 * 32×32→64 partial products on 32-bit limbs.
 */
function emitRyuMulShift(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__ryu_mul_shift");
  if (existing !== undefined) return existing;

  // params: 0 m, 1 factorLo, 2 factorHi (i64), 3 j (i32)
  const P_M = 0;
  const P_FLO = 1;
  const P_FHI = 2;
  const P_J = 3;
  // i64 locals
  const L_B0_LO = 4;
  const L_B0_HI = 5;
  const L_B2_LO = 6;
  const L_B2_HI = 7;
  const L_MIDLO = 8;
  const L_MIDHI = 9;
  // umul128 scratch (i64)
  const S_ALO = 10;
  const S_AHI = 11;
  const S_BLO = 12;
  const S_BHI = 13;
  const S_B00 = 14;
  const S_B01 = 15;
  const S_B10 = 16;
  const S_B11 = 17;
  const S_MID = 18;
  // i32 local
  const L_DIST = 19;

  const M32 = 0xffffffffn;

  // umul128(aLocal, bLocal) → {hi → hiOut, lo → loOut}
  const umul128 = (aLocal: number, bLocal: number, hiOut: number, loOut: number): Instr[] => [
    { op: "local.get", index: aLocal },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "local.set", index: S_ALO },
    { op: "local.get", index: aLocal },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "local.set", index: S_AHI },
    { op: "local.get", index: bLocal },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "local.set", index: S_BLO },
    { op: "local.get", index: bLocal },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "local.set", index: S_BHI },
    // b00 = aLo*bLo
    { op: "local.get", index: S_ALO },
    { op: "local.get", index: S_BLO },
    { op: "i64.mul" },
    { op: "local.set", index: S_B00 },
    // b01 = aLo*bHi
    { op: "local.get", index: S_ALO },
    { op: "local.get", index: S_BHI },
    { op: "i64.mul" },
    { op: "local.set", index: S_B01 },
    // b10 = aHi*bLo
    { op: "local.get", index: S_AHI },
    { op: "local.get", index: S_BLO },
    { op: "i64.mul" },
    { op: "local.set", index: S_B10 },
    // b11 = aHi*bHi
    { op: "local.get", index: S_AHI },
    { op: "local.get", index: S_BHI },
    { op: "i64.mul" },
    { op: "local.set", index: S_B11 },
    // mid = (b00>>32) + (b10 & M32) + (b01 & M32)
    { op: "local.get", index: S_B00 },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "local.get", index: S_B10 },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "i64.add" },
    { op: "local.get", index: S_B01 },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "i64.add" },
    { op: "local.set", index: S_MID },
    // lo = ((mid & M32) << 32) | (b00 & M32)
    { op: "local.get", index: S_MID },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "i64.const", value: 32n },
    { op: "i64.shl" },
    { op: "local.get", index: S_B00 },
    { op: "i64.const", value: M32 },
    { op: "i64.and" },
    { op: "i64.or" },
    { op: "local.set", index: loOut },
    // hi = b11 + (b10>>32) + (b01>>32) + (mid>>32)
    { op: "local.get", index: S_B11 },
    { op: "local.get", index: S_B10 },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "i64.add" },
    { op: "local.get", index: S_B01 },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "i64.add" },
    { op: "local.get", index: S_MID },
    { op: "i64.const", value: 32n },
    { op: "i64.shr_u" },
    { op: "i64.add" },
    { op: "local.set", index: hiOut },
  ];

  const body: Instr[] = [
    ...umul128(P_M, P_FLO, L_B0_HI, L_B0_LO),
    ...umul128(P_M, P_FHI, L_B2_HI, L_B2_LO),
    // midLo = b0.hi + b2.lo
    { op: "local.get", index: L_B0_HI },
    { op: "local.get", index: L_B2_LO },
    { op: "i64.add" },
    { op: "local.set", index: L_MIDLO },
    // midHi = b2.hi + (midLo <u b0.hi ? 1 : 0)
    { op: "local.get", index: L_B2_HI },
    { op: "local.get", index: L_MIDLO },
    { op: "local.get", index: L_B0_HI },
    { op: "i64.lt_u" },
    { op: "i64.extend_i32_u" },
    { op: "i64.add" },
    { op: "local.set", index: L_MIDHI },
    // dist = j - 64
    { op: "local.get", index: P_J },
    { op: "i32.const", value: 64 },
    { op: "i32.sub" },
    { op: "local.set", index: L_DIST },
    // result = (midHi << (64 - dist)) | (midLo >>u dist)
    { op: "local.get", index: L_MIDHI },
    { op: "i64.const", value: 64n },
    { op: "local.get", index: L_DIST },
    { op: "i64.extend_i32_u" },
    { op: "i64.sub" },
    { op: "i64.shl" },
    { op: "local.get", index: L_MIDLO },
    { op: "local.get", index: L_DIST },
    { op: "i64.extend_i32_u" },
    { op: "i64.shr_u" },
    { op: "i64.or" },
    { op: "return" },
  ];

  const typeIdx = addFuncType(ctx, [I64, I64, I64, I32], [I64]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("__ryu_mul_shift", funcIdx);
  ctx.mod.functions.push({
    name: "__ryu_mul_shift",
    typeIdx,
    locals: [
      { name: "b0lo", type: I64 },
      { name: "b0hi", type: I64 },
      { name: "b2lo", type: I64 },
      { name: "b2hi", type: I64 },
      { name: "midlo", type: I64 },
      { name: "midhi", type: I64 },
      { name: "alo", type: I64 },
      { name: "ahi", type: I64 },
      { name: "blo", type: I64 },
      { name: "bhi", type: I64 },
      { name: "b00", type: I64 },
      { name: "b01", type: I64 },
      { name: "b10", type: I64 },
      { name: "b11", type: I64 },
      { name: "mid", type: I64 },
      { name: "dist", type: I32 },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * `__num_ryu_digits(value: f64) -> (digits: i64, exp: i32)`
 *
 * The Ryū `d2d` shortest-decimal core. `value` is assumed finite and non-zero.
 * Returns `(digits, exp)` such that `value == ±digits × 10^exp`, where `digits`
 * is the shortest decimal mantissa (sign dropped — caller tracks it). A faithful
 * translation of the validated BigInt reference; comments mark each step against
 * the Adams / dtolnay reference.
 */
export function emitRyuDigits(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__num_ryu_digits");
  if (existing !== undefined) return existing;

  const mulShiftIdx = emitRyuMulShift(ctx);
  const { invIdx, powIdx, arrType } = ensureRyuTables(ctx);

  // param 0: value (f64)
  const P_VALUE = 0;
  // i64 locals (1..14)
  const L_BITS = 1;
  const L_M2 = 2;
  const L_MV = 3;
  const L_VR = 4;
  const L_VP = 5;
  const L_VM = 6;
  const L_MMSHIFT = 7;
  const L_OUTPUT = 8;
  const L_LASTREMOVED = 9;
  const L_FLO = 10;
  const L_FHI = 11;
  const L_PFV = 12; // pow5Factor scratch value
  // i32 locals (15..27)
  const L_IEEEEXP = 15;
  const L_E2 = 16;
  const L_Q = 17;
  const L_I = 18; // shift amount i / j
  const L_K = 19; // k, or pow5 table index ii (negative branch)
  const L_E10 = 20;
  const L_REMOVED = 21;
  const L_ACCEPT = 22;
  const L_VRTZ = 23;
  const L_VMTZ = 24;
  const L_TIDX = 25;
  const L_PFCNT = 26;

  const MANT_MASK = (1n << 52n) - 1n;
  const EXP_MASK = 0x7ffn;
  const IMPLICIT_BIT = 1n << 52n;

  // load table[tidx], table[tidx+1] into L_FLO / L_FHI
  const loadFactor = (globalIdx: number): Instr[] => [
    { op: "global.get", index: globalIdx },
    { op: "local.get", index: L_TIDX },
    { op: "array.get", typeIdx: arrType },
    { op: "local.set", index: L_FLO },
    { op: "global.get", index: globalIdx },
    { op: "local.get", index: L_TIDX },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "array.get", typeIdx: arrType },
    { op: "local.set", index: L_FHI },
  ];

  // call __ryu_mul_shift(<m-expr>, L_FLO, L_FHI, L_I) leaving i64 on stack.
  const mulShiftCall = (mExpr: Instr[]): Instr[] => [
    ...mExpr,
    { op: "local.get", index: L_FLO },
    { op: "local.get", index: L_FHI },
    { op: "local.get", index: L_I },
    { op: "call", funcIdx: mulShiftIdx },
  ];

  // multipleOfPowerOf5(<value-expr>, <p-expr i32>) -> i32 on stack.
  // pow5Factor: count factors of 5 in value, compare >= p. value-expr leaves an
  // i64 on the stack; p-expr leaves an i32 on the stack.
  const multipleOfPow5 = (valExpr: Instr[], pExpr: Instr[]): Instr[] => [
    ...valExpr,
    { op: "local.set", index: L_PFV },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_PFCNT },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_PFV },
            { op: "i64.const", value: 5n },
            { op: "i64.rem_u" },
            { op: "i64.const", value: 0n },
            { op: "i64.ne" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_PFV },
            { op: "i64.const", value: 5n },
            { op: "i64.div_u" },
            { op: "local.set", index: L_PFV },
            { op: "local.get", index: L_PFCNT },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_PFCNT },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: L_PFCNT },
    ...pExpr,
    { op: "i32.ge_s" },
  ];

  // multipleOfPowerOf2(<value-expr i64>, <p-expr i32>) -> i32 on stack.
  const multipleOfPow2 = (valExpr: Instr[], pExpr: Instr[]): Instr[] => [
    ...valExpr,
    { op: "i64.const", value: 1n },
    ...pExpr,
    { op: "i64.extend_i32_u" },
    { op: "i64.shl" },
    { op: "i64.const", value: 1n },
    { op: "i64.sub" },
    { op: "i64.and" },
    { op: "i64.const", value: 0n },
    { op: "i64.eq" },
  ];

  const log10Pow2 = (eExpr: Instr[]): Instr[] => [
    ...eExpr,
    { op: "i32.const", value: 78913 },
    { op: "i32.mul" },
    { op: "i32.const", value: 18 },
    { op: "i32.shr_u" },
  ];
  const log10Pow5 = (eExpr: Instr[]): Instr[] => [
    ...eExpr,
    { op: "i32.const", value: 732923 },
    { op: "i32.mul" },
    { op: "i32.const", value: 20 },
    { op: "i32.shr_u" },
  ];
  const pow5bits = (eExpr: Instr[]): Instr[] => [
    ...eExpr,
    { op: "i32.const", value: 1217359 },
    { op: "i32.mul" },
    { op: "i32.const", value: 19 },
    { op: "i32.shr_u" },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
  ];

  // (mv - 1 - mmShift) as an expression leaving i64 on stack.
  const mvLessMm = (): Instr[] => [
    { op: "local.get", index: L_MV },
    { op: "i64.const", value: 1n },
    { op: "i64.sub" },
    { op: "local.get", index: L_MMSHIFT },
    { op: "i64.sub" },
  ];
  const mvPlus2 = (): Instr[] => [{ op: "local.get", index: L_MV }, { op: "i64.const", value: 2n }, { op: "i64.add" }];

  function emitE2NonNegative(): Instr[] {
    return [
      // q = log10Pow2(e2) - (e2 > 3 ? 1 : 0)
      ...log10Pow2([{ op: "local.get", index: L_E2 }]),
      { op: "local.get", index: L_E2 },
      { op: "i32.const", value: 3 },
      { op: "i32.gt_s" },
      { op: "i32.sub" },
      { op: "local.set", index: L_Q },
      // e10 = q
      { op: "local.get", index: L_Q },
      { op: "local.set", index: L_E10 },
      // k = DOUBLE_POW5_INV_BITCOUNT + pow5bits(q) - 1
      { op: "i32.const", value: DOUBLE_POW5_INV_BITCOUNT },
      ...pow5bits([{ op: "local.get", index: L_Q }]),
      { op: "i32.add" },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: L_K },
      // i = -e2 + q + k
      { op: "i32.const", value: 0 },
      { op: "local.get", index: L_E2 },
      { op: "i32.sub" },
      { op: "local.get", index: L_Q },
      { op: "i32.add" },
      { op: "local.get", index: L_K },
      { op: "i32.add" },
      { op: "local.set", index: L_I },
      // tidx = 2*q
      { op: "local.get", index: L_Q },
      { op: "i32.const", value: 1 },
      { op: "i32.shl" },
      { op: "local.set", index: L_TIDX },
      ...loadFactor(invIdx),
      // vr / vp / vm
      ...mulShiftCall([{ op: "local.get", index: L_MV }]),
      { op: "local.set", index: L_VR },
      ...mulShiftCall(mvPlus2()),
      { op: "local.set", index: L_VP },
      ...mulShiftCall(mvLessMm()),
      { op: "local.set", index: L_VM },
      // if (q <= 21)
      { op: "local.get", index: L_Q },
      { op: "i32.const", value: 21 },
      { op: "i32.le_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // if (mv % 5 == 0) vrtz = mul5(mv,q)
          { op: "local.get", index: L_MV },
          { op: "i64.const", value: 5n },
          { op: "i64.rem_u" },
          { op: "i64.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...multipleOfPow5([{ op: "local.get", index: L_MV }], [{ op: "local.get", index: L_Q }]),
              { op: "local.set", index: L_VRTZ },
            ],
            else: [
              // else if (acceptBounds) vmtz = mul5(mv-1-mmShift,q)
              { op: "local.get", index: L_ACCEPT },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...multipleOfPow5(mvLessMm(), [{ op: "local.get", index: L_Q }]),
                  { op: "local.set", index: L_VMTZ },
                ],
                else: [
                  // vp -= mul5(mv+2,q) ? 1 : 0
                  { op: "local.get", index: L_VP },
                  ...multipleOfPow5(mvPlus2(), [{ op: "local.get", index: L_Q }]),
                  { op: "i64.extend_i32_u" },
                  { op: "i64.sub" },
                  { op: "local.set", index: L_VP },
                ],
              },
            ],
          },
        ],
      },
    ];
  }

  function emitE2Negative(): Instr[] {
    return [
      // q = log10Pow5(-e2) - (-e2 > 1 ? 1 : 0)
      ...log10Pow5([{ op: "i32.const", value: 0 }, { op: "local.get", index: L_E2 }, { op: "i32.sub" }]),
      { op: "i32.const", value: 0 },
      { op: "local.get", index: L_E2 },
      { op: "i32.sub" },
      { op: "i32.const", value: 1 },
      { op: "i32.gt_s" },
      { op: "i32.sub" },
      { op: "local.set", index: L_Q },
      // e10 = q + e2
      { op: "local.get", index: L_Q },
      { op: "local.get", index: L_E2 },
      { op: "i32.add" },
      { op: "local.set", index: L_E10 },
      // ii = -e2 - q  (pow5 table index) → store in L_K
      { op: "i32.const", value: 0 },
      { op: "local.get", index: L_E2 },
      { op: "i32.sub" },
      { op: "local.get", index: L_Q },
      { op: "i32.sub" },
      { op: "local.set", index: L_K },
      // i = q - (pow5bits(ii) - DOUBLE_POW5_BITCOUNT)
      { op: "local.get", index: L_Q },
      ...pow5bits([{ op: "local.get", index: L_K }]),
      { op: "i32.const", value: DOUBLE_POW5_BITCOUNT },
      { op: "i32.sub" },
      { op: "i32.sub" },
      { op: "local.set", index: L_I },
      // tidx = 2 * ii
      { op: "local.get", index: L_K },
      { op: "i32.const", value: 1 },
      { op: "i32.shl" },
      { op: "local.set", index: L_TIDX },
      ...loadFactor(powIdx),
      ...mulShiftCall([{ op: "local.get", index: L_MV }]),
      { op: "local.set", index: L_VR },
      ...mulShiftCall(mvPlus2()),
      { op: "local.set", index: L_VP },
      ...mulShiftCall(mvLessMm()),
      { op: "local.set", index: L_VM },
      // if (q <= 1) {...} else if (q < 63) {...}
      { op: "local.get", index: L_Q },
      { op: "i32.const", value: 1 },
      { op: "i32.le_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: L_VRTZ },
          { op: "local.get", index: L_ACCEPT },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // vmtz = (mmShift == 1)
              { op: "local.get", index: L_MMSHIFT },
              { op: "i64.const", value: 1n },
              { op: "i64.eq" },
              { op: "local.set", index: L_VMTZ },
            ],
            else: [
              // vp -= 1
              { op: "local.get", index: L_VP },
              { op: "i64.const", value: 1n },
              { op: "i64.sub" },
              { op: "local.set", index: L_VP },
            ],
          },
        ],
        else: [
          { op: "local.get", index: L_Q },
          { op: "i32.const", value: 63 },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...multipleOfPow2([{ op: "local.get", index: L_MV }], [{ op: "local.get", index: L_Q }]),
              { op: "local.set", index: L_VRTZ },
            ],
          },
        ],
      },
    ];
  }

  function emitCommonPath(): Instr[] {
    return [
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if (vp/10 <= vm/10) break
              { op: "local.get", index: L_VP },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "local.get", index: L_VM },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "i64.le_u" },
              { op: "br_if", depth: 1 },
              // lastRemoved = vr % 10
              { op: "local.get", index: L_VR },
              { op: "i64.const", value: 10n },
              { op: "i64.rem_u" },
              { op: "local.set", index: L_LASTREMOVED },
              // vr/=10 ; vp/=10 ; vm/=10 ; removed++
              { op: "local.get", index: L_VR },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "local.set", index: L_VR },
              { op: "local.get", index: L_VP },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "local.set", index: L_VP },
              { op: "local.get", index: L_VM },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "local.set", index: L_VM },
              { op: "local.get", index: L_REMOVED },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_REMOVED },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // output = vr + ((vr == vm || lastRemoved >= 5) ? 1 : 0)
      { op: "local.get", index: L_VR },
      { op: "local.get", index: L_VR },
      { op: "local.get", index: L_VM },
      { op: "i64.eq" },
      { op: "local.get", index: L_LASTREMOVED },
      { op: "i64.const", value: 5n },
      { op: "i64.ge_u" },
      { op: "i32.or" },
      { op: "i64.extend_i32_u" },
      { op: "i64.add" },
      { op: "local.set", index: L_OUTPUT },
    ];
  }

  function emitSlowPath(): Instr[] {
    return [
      // loop 1: while (vp/10 > vm/10)
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: L_VP },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "local.get", index: L_VM },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "i64.gt_u" },
              { op: "i32.eqz" },
              { op: "br_if", depth: 1 },
              // vmtz = vmtz && (vm % 10 == 0)
              { op: "local.get", index: L_VMTZ },
              { op: "local.get", index: L_VM },
              { op: "i64.const", value: 10n },
              { op: "i64.rem_u" },
              { op: "i64.eqz" },
              { op: "i32.and" },
              { op: "local.set", index: L_VMTZ },
              // vrtz = vrtz && (lastRemoved == 0)
              { op: "local.get", index: L_VRTZ },
              { op: "local.get", index: L_LASTREMOVED },
              { op: "i64.eqz" },
              { op: "i32.and" },
              { op: "local.set", index: L_VRTZ },
              // lastRemoved = vr % 10
              { op: "local.get", index: L_VR },
              { op: "i64.const", value: 10n },
              { op: "i64.rem_u" },
              { op: "local.set", index: L_LASTREMOVED },
              // vr/=10 ; vp/=10 ; vm/=10 ; removed++
              { op: "local.get", index: L_VR },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "local.set", index: L_VR },
              { op: "local.get", index: L_VP },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "local.set", index: L_VP },
              { op: "local.get", index: L_VM },
              { op: "i64.const", value: 10n },
              { op: "i64.div_u" },
              { op: "local.set", index: L_VM },
              { op: "local.get", index: L_REMOVED },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_REMOVED },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // if (vmtz) loop 2: while (vm % 10 == 0)
      { op: "local.get", index: L_VMTZ },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          {
            op: "block",
            blockType: { kind: "empty" },
            body: [
              {
                op: "loop",
                blockType: { kind: "empty" },
                body: [
                  { op: "local.get", index: L_VM },
                  { op: "i64.const", value: 10n },
                  { op: "i64.rem_u" },
                  { op: "i64.const", value: 0n },
                  { op: "i64.ne" },
                  { op: "br_if", depth: 1 },
                  // vrtz = vrtz && (lastRemoved == 0)
                  { op: "local.get", index: L_VRTZ },
                  { op: "local.get", index: L_LASTREMOVED },
                  { op: "i64.eqz" },
                  { op: "i32.and" },
                  { op: "local.set", index: L_VRTZ },
                  // lastRemoved = vr % 10
                  { op: "local.get", index: L_VR },
                  { op: "i64.const", value: 10n },
                  { op: "i64.rem_u" },
                  { op: "local.set", index: L_LASTREMOVED },
                  { op: "local.get", index: L_VR },
                  { op: "i64.const", value: 10n },
                  { op: "i64.div_u" },
                  { op: "local.set", index: L_VR },
                  { op: "local.get", index: L_VP },
                  { op: "i64.const", value: 10n },
                  { op: "i64.div_u" },
                  { op: "local.set", index: L_VP },
                  { op: "local.get", index: L_VM },
                  { op: "i64.const", value: 10n },
                  { op: "i64.div_u" },
                  { op: "local.set", index: L_VM },
                  { op: "local.get", index: L_REMOVED },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: L_REMOVED },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
        ],
      },
      // if (vrtz && lastRemoved == 5 && (vr & 1) == 0) lastRemoved = 4
      { op: "local.get", index: L_VRTZ },
      { op: "local.get", index: L_LASTREMOVED },
      { op: "i64.const", value: 5n },
      { op: "i64.eq" },
      { op: "i32.and" },
      { op: "local.get", index: L_VR },
      { op: "i64.const", value: 1n },
      { op: "i64.and" },
      { op: "i64.eqz" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i64.const", value: 4n },
          { op: "local.set", index: L_LASTREMOVED },
        ],
      },
      // output = vr + (( (vr==vm && (!accept || !vmtz)) || lastRemoved >= 5 ) ? 1 : 0)
      { op: "local.get", index: L_VR },
      { op: "local.get", index: L_VR },
      { op: "local.get", index: L_VM },
      { op: "i64.eq" },
      { op: "local.get", index: L_ACCEPT },
      { op: "i32.eqz" },
      { op: "local.get", index: L_VMTZ },
      { op: "i32.eqz" },
      { op: "i32.or" },
      { op: "i32.and" },
      { op: "local.get", index: L_LASTREMOVED },
      { op: "i64.const", value: 5n },
      { op: "i64.ge_u" },
      { op: "i32.or" },
      { op: "i64.extend_i32_u" },
      { op: "i64.add" },
      { op: "local.set", index: L_OUTPUT },
    ];
  }

  const body: Instr[] = [
    // bits = reinterpret(value)
    { op: "local.get", index: P_VALUE },
    { op: "i64.reinterpret_f64" },
    { op: "local.set", index: L_BITS },
    // ieeeExponent = (bits >>u 52) & 0x7ff
    { op: "local.get", index: L_BITS },
    { op: "i64.const", value: 52n },
    { op: "i64.shr_u" },
    { op: "i64.const", value: EXP_MASK },
    { op: "i64.and" },
    { op: "i32.wrap_i64" },
    { op: "local.set", index: L_IEEEEXP },
    // if (ieeeExponent == 0) subnormal else normal
    { op: "local.get", index: L_IEEEEXP },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: -1076 },
        { op: "local.set", index: L_E2 },
        { op: "local.get", index: L_BITS },
        { op: "i64.const", value: MANT_MASK },
        { op: "i64.and" },
        { op: "local.set", index: L_M2 },
      ],
      else: [
        { op: "local.get", index: L_IEEEEXP },
        { op: "i32.const", value: 1077 },
        { op: "i32.sub" },
        { op: "local.set", index: L_E2 },
        { op: "local.get", index: L_BITS },
        { op: "i64.const", value: MANT_MASK },
        { op: "i64.and" },
        { op: "i64.const", value: IMPLICIT_BIT },
        { op: "i64.or" },
        { op: "local.set", index: L_M2 },
      ],
    },
    // acceptBounds = (m2 & 1) == 0
    { op: "local.get", index: L_M2 },
    { op: "i64.const", value: 1n },
    { op: "i64.and" },
    { op: "i64.eqz" },
    { op: "local.set", index: L_ACCEPT },
    // mv = 4 * m2
    { op: "local.get", index: L_M2 },
    { op: "i64.const", value: 4n },
    { op: "i64.mul" },
    { op: "local.set", index: L_MV },
    // mmShift = (mantissa != 0 || ieeeExponent <= 1) ? 1 : 0
    { op: "local.get", index: L_BITS },
    { op: "i64.const", value: MANT_MASK },
    { op: "i64.and" },
    { op: "i64.const", value: 0n },
    { op: "i64.ne" },
    { op: "local.get", index: L_IEEEEXP },
    { op: "i32.const", value: 1 },
    { op: "i32.le_s" },
    { op: "i32.or" },
    { op: "i64.extend_i32_u" },
    { op: "local.set", index: L_MMSHIFT },
    // init flags
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_VRTZ },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_VMTZ },
    // branch on e2 >= 0
    { op: "local.get", index: L_E2 },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: emitE2NonNegative(),
      else: emitE2Negative(),
    },
    // Step 4
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_REMOVED },
    { op: "i64.const", value: 0n },
    { op: "local.set", index: L_LASTREMOVED },
    { op: "local.get", index: L_VMTZ },
    { op: "local.get", index: L_VRTZ },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: emitSlowPath(),
      else: emitCommonPath(),
    },
    // return (output, e10 + removed)
    { op: "local.get", index: L_OUTPUT },
    { op: "local.get", index: L_E10 },
    { op: "local.get", index: L_REMOVED },
    { op: "i32.add" },
    { op: "return" },
  ];

  const typeIdx = addFuncType(ctx, [F64], [I64, I32]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("__num_ryu_digits", funcIdx);
  ctx.mod.functions.push({
    name: "__num_ryu_digits",
    typeIdx,
    locals: [
      // i64 group: indices 1..12
      { name: "bits", type: I64 },
      { name: "m2", type: I64 },
      { name: "mv", type: I64 },
      { name: "vr", type: I64 },
      { name: "vp", type: I64 },
      { name: "vm", type: I64 },
      { name: "mmShift", type: I64 },
      { name: "output", type: I64 },
      { name: "lastRemoved", type: I64 },
      { name: "flo", type: I64 },
      { name: "fhi", type: I64 },
      { name: "pfv", type: I64 },
      // padding to keep i32 group starting at index 15
      { name: "pad13", type: I64 },
      { name: "pad14", type: I64 },
      // i32 group: indices 15..26
      { name: "ieeeExp", type: I32 },
      { name: "e2", type: I32 },
      { name: "q", type: I32 },
      { name: "i", type: I32 },
      { name: "k", type: I32 },
      { name: "e10", type: I32 },
      { name: "removed", type: I32 },
      { name: "accept", type: I32 },
      { name: "vrtz", type: I32 },
      { name: "vmtz", type: I32 },
      { name: "tidx", type: I32 },
      { name: "pfcnt", type: I32 },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/**
 * `__num_ryu_to_buf(value: f64, neg: i32, buf: ref $strData, pos: i32) -> i32`
 *
 * Formats the shortest-roundtrip decimal of a finite, non-zero `value` into the
 * caller's i16 string buffer at `pos`, writing a leading '-' when `neg`. Returns
 * the new write position. Implements ECMA-262 §6.1.6.1.13 framing on top of the
 * `(digits, exp)` produced by `__num_ryu_digits`:
 *   let k = #digits(digits), n = exp + k.
 *   - k <= n <= 21         → digits followed by (n-k) zeros               (integer)
 *   - 0 < n <= 21          → digits[0..n] '.' digits[n..]                 (fixed)
 *   - -6 < n <= 0          → "0." (-n zeros) digits                       (fixed)
 *   - otherwise            → digits[0] ['.' digits[1..]] 'e' sign |n-1|   (exp)
 *
 * `strDataTypeIdx` is the native-string i16 array type (caller's buffer type).
 */
export function emitRyuToBuf(ctx: CodegenContext, strDataTypeIdx: number): number {
  const existing = ctx.funcMap.get("__num_ryu_to_buf");
  if (existing !== undefined) return existing;

  const digitsIdx = emitRyuDigits(ctx);
  const digArrType = ensureImmutableI64ArrayType(ctx); // unused ref; ensures core present
  void digArrType;

  const C_ZERO = 48;
  const C_MINUS = 45;
  const C_PLUS = 43;
  const C_DOT = 46;
  const C_LC_E = 101;

  // params
  const P_VALUE = 0;
  const P_NEG = 1;
  const P_BUF = 2;
  const P_POS = 3;
  // i64 locals
  const L_DIGITS = 4;
  const L_W = 5; // working copy of digits during extraction
  // i32 locals
  const L_EXP = 6;
  const L_K = 7;
  const L_N = 8;
  const L_J = 9; // loop counter
  const L_E = 10; // exponent for scientific
  const L_EABS = 11;
  const L_EPOW = 12; // power of ten for exponent digit peel
  const L_DIG_OFF = 13; // base offset of digit scratch within buf (write area beyond pos)
  const L_TMP = 14;

  // We extract the decimal digits of `digits` into a scratch region of the
  // SAME buffer, parked well past the final output (offset 200), LSB-first, so
  // we can then emit them MSB-first by reading dig[k-1-j]. BUF_CAP is 256 and a
  // shortest decimal is ≤ 17 digits, so [200,217) is safe and never overlaps
  // the ≤ ~24-char formatted output that starts at `pos` (pos ≤ a few).
  const DIG_SCRATCH = 200;

  // write digit char (value 0-9 already in L_TMP) at P_POS, advance P_POS
  const writeDigitFromTmp = (): Instr[] => [
    { op: "local.get", index: P_BUF },
    { op: "local.get", index: P_POS },
    { op: "i32.const", value: C_ZERO },
    { op: "local.get", index: L_TMP },
    { op: "i32.add" },
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: P_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: P_POS },
  ];
  const writeChar = (code: number): Instr[] => [
    { op: "local.get", index: P_BUF },
    { op: "local.get", index: P_POS },
    { op: "i32.const", value: code },
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: P_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: P_POS },
  ];

  // emit dig[idxExpr] (a stored digit value 0-9) → write as char.
  // idxExpr leaves an i32 (0-based index into DIG_SCRATCH, MSB-first via k-1-j).
  const writeStoredDigit = (idxExpr: Instr[]): Instr[] => [
    // L_TMP = buf[DIG_SCRATCH + idx]
    { op: "local.get", index: P_BUF },
    { op: "i32.const", value: DIG_SCRATCH },
    ...idxExpr,
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_TMP },
    ...writeDigitFromTmp(),
  ];

  // loop: emit a run of MSB-first stored digits for j in [startExpr, endExpr).
  // We implement specific loops inline rather than a generic helper.

  const body: Instr[] = [
    // (digits, exp) = __num_ryu_digits(value)
    { op: "local.get", index: P_VALUE },
    { op: "call", funcIdx: digitsIdx },
    { op: "local.set", index: L_EXP },
    { op: "local.set", index: L_DIGITS },
    // Extract decimal digits LSB-first into DIG_SCRATCH; count = k.
    { op: "local.get", index: L_DIGITS },
    { op: "local.set", index: L_W },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_K },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // buf[DIG_SCRATCH + k] = (w % 10)
            { op: "local.get", index: P_BUF },
            { op: "i32.const", value: DIG_SCRATCH },
            { op: "local.get", index: L_K },
            { op: "i32.add" },
            { op: "local.get", index: L_W },
            { op: "i64.const", value: 10n },
            { op: "i64.rem_u" },
            { op: "i32.wrap_i64" },
            { op: "array.set", typeIdx: strDataTypeIdx },
            // w /= 10 ; k++
            { op: "local.get", index: L_W },
            { op: "i64.const", value: 10n },
            { op: "i64.div_u" },
            { op: "local.set", index: L_W },
            { op: "local.get", index: L_K },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_K },
            // if (w != 0) continue
            { op: "local.get", index: L_W },
            { op: "i64.const", value: 0n },
            { op: "i64.ne" },
            { op: "br_if", depth: 0 },
          ],
        },
      ],
    },
    // n = exp + k
    { op: "local.get", index: L_EXP },
    { op: "local.get", index: L_K },
    { op: "i32.add" },
    { op: "local.set", index: L_N },
    // sign
    { op: "local.get", index: P_NEG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: writeChar(C_MINUS),
    },
  ];

  // --- case selection (§6.1.6.1.13) ---
  // Each case writes its output and `return`s P_POS, so the four `if`s execute
  // as a sequential dispatch; the last (exponential) is the fallthrough.
  // case A condition: (n >= k) && (n <= 21)  → integer, k digits + (n-k) zeros
  body.push(
    { op: "local.get", index: L_N },
    { op: "local.get", index: L_K },
    { op: "i32.ge_s" },
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 21 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // emit all k digits MSB-first: for j in [0,k): writeStoredDigit(k-1-j)
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_K },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit([
                  { op: "local.get", index: L_K },
                  { op: "i32.const", value: 1 },
                  { op: "i32.sub" },
                  { op: "local.get", index: L_J },
                  { op: "i32.sub" },
                ]),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // (n - k) trailing zeros
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_N },
                { op: "local.get", index: L_K },
                { op: "i32.sub" },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeChar(C_ZERO),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: P_POS },
        { op: "return" },
      ],
    },
  );

  // case B condition: (n > 0) && (n <= 21)  → fixed with point inside digits
  body.push(
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 21 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // first n digits, then '.', then remaining k-n digits
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_N },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit([
                  { op: "local.get", index: L_K },
                  { op: "i32.const", value: 1 },
                  { op: "i32.sub" },
                  { op: "local.get", index: L_J },
                  { op: "i32.sub" },
                ]),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        ...writeChar(C_DOT),
        // remaining: j in [n, k)
        { op: "local.get", index: L_N },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_K },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit([
                  { op: "local.get", index: L_K },
                  { op: "i32.const", value: 1 },
                  { op: "i32.sub" },
                  { op: "local.get", index: L_J },
                  { op: "i32.sub" },
                ]),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: P_POS },
        { op: "return" },
      ],
    },
  );

  // case C condition: (n > -6) && (n <= 0)  → "0." (-n zeros) digits
  body.push(
    { op: "local.get", index: L_N },
    { op: "i32.const", value: -6 },
    { op: "i32.gt_s" },
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 0 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...writeChar(C_ZERO),
        ...writeChar(C_DOT),
        // -n leading zeros
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 0 },
                { op: "local.get", index: L_N },
                { op: "i32.sub" },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeChar(C_ZERO),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // all k digits MSB-first
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_K },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit([
                  { op: "local.get", index: L_K },
                  { op: "i32.const", value: 1 },
                  { op: "i32.sub" },
                  { op: "local.get", index: L_J },
                  { op: "i32.sub" },
                ]),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: P_POS },
        { op: "return" },
      ],
    },
  );

  // case D (fallthrough): exponential.  digits[0] ['.' digits[1..]] 'e' sign |e|, e=n-1
  body.push(
    // first digit (MSB) = dig[k-1]
    ...writeStoredDigit([{ op: "local.get", index: L_K }, { op: "i32.const", value: 1 }, { op: "i32.sub" }]),
    // if (k > 1) '.' then digits[1..k)
    { op: "local.get", index: L_K },
    { op: "i32.const", value: 1 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...writeChar(C_DOT),
        { op: "i32.const", value: 1 },
        { op: "local.set", index: L_J },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_J },
                { op: "local.get", index: L_K },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                ...writeStoredDigit([
                  { op: "local.get", index: L_K },
                  { op: "i32.const", value: 1 },
                  { op: "i32.sub" },
                  { op: "local.get", index: L_J },
                  { op: "i32.sub" },
                ]),
                { op: "local.get", index: L_J },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_J },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // 'e'
    ...writeChar(C_LC_E),
    // e = n - 1
    { op: "local.get", index: L_N },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "local.set", index: L_E },
    // sign + abs
    { op: "local.get", index: L_E },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...writeChar(C_MINUS),
        // eabs = -e
        { op: "i32.const", value: 0 },
        { op: "local.get", index: L_E },
        { op: "i32.sub" },
        { op: "local.set", index: L_EABS },
      ],
      else: [...writeChar(C_PLUS), { op: "local.get", index: L_E }, { op: "local.set", index: L_EABS }],
    },
    // write eabs as decimal (1..3 digits, no leading zeros). Find highest power
    // of ten <= eabs, then peel. eabs in [0, 323].
    // epow = 1; while (epow*10 <= eabs) epow*=10
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L_EPOW },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_EPOW },
            { op: "i32.const", value: 10 },
            { op: "i32.mul" },
            { op: "local.get", index: L_EABS },
            { op: "i32.le_s" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_EPOW },
            { op: "i32.const", value: 10 },
            { op: "i32.mul" },
            { op: "local.set", index: L_EPOW },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // while (epow >= 1) { d = eabs/epow; write '0'+d; eabs -= d*epow; epow/=10 }
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_EPOW },
            { op: "i32.const", value: 1 },
            { op: "i32.lt_s" },
            { op: "br_if", depth: 1 },
            // d = eabs / epow → L_TMP
            { op: "local.get", index: L_EABS },
            { op: "local.get", index: L_EPOW },
            { op: "i32.div_s" },
            { op: "local.set", index: L_TMP },
            ...writeDigitFromTmp(),
            // eabs -= d*epow
            { op: "local.get", index: L_EABS },
            { op: "local.get", index: L_TMP },
            { op: "local.get", index: L_EPOW },
            { op: "i32.mul" },
            { op: "i32.sub" },
            { op: "local.set", index: L_EABS },
            // epow /= 10
            { op: "local.get", index: L_EPOW },
            { op: "i32.const", value: 10 },
            { op: "i32.div_s" },
            { op: "local.set", index: L_EPOW },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: P_POS },
    { op: "return" },
  );

  const strDataRef: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const typeIdx = addFuncType(ctx, [F64, I32, strDataRef, I32], [I32]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("__num_ryu_to_buf", funcIdx);
  ctx.mod.functions.push({
    name: "__num_ryu_to_buf",
    typeIdx,
    locals: [
      { name: "digits", type: I64 },
      { name: "w", type: I64 },
      { name: "exp", type: I32 },
      { name: "k", type: I32 },
      { name: "n", type: I32 },
      { name: "j", type: I32 },
      { name: "e", type: I32 },
      { name: "eabs", type: I32 },
      { name: "epow", type: I32 },
      { name: "digoff", type: I32 },
      { name: "tmp", type: I32 },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}
