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
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import {
  buildRyuInverseSplit,
  buildRyuSplit,
  createRyuPowerArrayType,
} from "../runtime/wasmgc/values/number-ryu-tables.js";
import {
  buildRyuMulShiftBody,
  buildRyuDigitsBody,
  buildRyuToBufferBody,
  ryuMulShiftSignature,
  ryuDigitsSignature,
  ryuToBufferSignature,
} from "../runtime/wasmgc/values/number-ryu-bodies.js";

// ---------------------------------------------------------------------------
// Compile-time table generation (BigInt). Produces byte-identical tables to
// dtolnay/ryu's d2s_full_table.h, derived from the same constants. Computed
// once when the Ryū core is first emitted into a module.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Emitters
// ---------------------------------------------------------------------------

const RYU_INV_GLOBAL = "__ryu_pow5_inv";
const RYU_POW_GLOBAL = "__ryu_pow5";
const RYU_I64_ARR = "__ryu_i64_arr";

/**
 * #1916 S3b — STABLE-REGIME PRODUCER (see number-format-native.ts, the first
 * flip). Handles minted here are layout-independent: baked call immediates and
 * funcMap entries survive every late-import shift and resolve at emit.
 * Every push below goes through `pushDefinedFunc`.
 */
function nextFuncIdx(ctx: CodegenContext): number {
  return mintDefinedFunc(ctx);
}

/** Register an immutable `(array i64)` type, idempotent. */
function ensureImmutableI64ArrayType(ctx: CodegenContext): number {
  const existing = ctx.arrayTypeMap.get(RYU_I64_ARR);
  if (existing !== undefined) return existing;
  const idx = ctx.mod.types.length;
  ctx.mod.types.push(createRyuPowerArrayType());
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
    const inv = buildRyuInverseSplit();
    const init: Instr[] = inv.map((v) => ({ op: "i64.const", value: v }));
    init.push({ op: "array.new_fixed", typeIdx: arrType, length: inv.length });
    invLocal = ctx.mod.globals.length;
    ctx.mod.globals.push({ name: RYU_INV_GLOBAL, type: arrRef, mutable: false, init });
  }
  let powLocal = findGlobal(ctx, RYU_POW_GLOBAL);
  if (powLocal < 0) {
    const pw = buildRyuSplit();
    const init: Instr[] = pw.map((v) => ({ op: "i64.const", value: v }));
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

  const definition = buildRyuMulShiftBody();
  const signature = ryuMulShiftSignature();
  const typeIdx = addFuncType(ctx, signature.params, signature.results);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("__ryu_mul_shift", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__ryu_mul_shift",
    typeIdx,
    locals: definition.locals,
    body: definition.body,
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

  const definition = buildRyuDigitsBody({
    mulShift: mulShiftIdx,
    tableTypeIdx: arrType,
    inverseGlobalIdx: invIdx,
    powersGlobalIdx: powIdx,
  });
  const signature = ryuDigitsSignature();
  const typeIdx = addFuncType(ctx, signature.params, signature.results);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("__num_ryu_digits", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__num_ryu_digits",
    typeIdx,
    locals: definition.locals,
    body: definition.body,
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

  const definition = buildRyuToBufferBody({ digits: digitsIdx, stringDataTypeIdx: strDataTypeIdx });
  const signature = ryuToBufferSignature({ kind: "ref", typeIdx: strDataTypeIdx });
  const typeIdx = addFuncType(ctx, signature.params, signature.results);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("__num_ryu_to_buf", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__num_ryu_to_buf",
    typeIdx,
    locals: definition.locals,
    body: definition.body,
    exported: false,
  });
  return funcIdx;
}
