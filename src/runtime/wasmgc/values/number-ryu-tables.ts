// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ArrayTypeDef } from "../../../wasm/model/module-records.js";
import { RYU_I64 } from "./number-ryu-signatures.js";

export const DOUBLE_POW5_INV_BITCOUNT = 125;
export const DOUBLE_POW5_BITCOUNT = 125;

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

export function buildRyuPowerTables(): { readonly inverse: readonly bigint[]; readonly powers: readonly bigint[] } {
  return { inverse: buildRyuInverseSplit(), powers: buildRyuSplit() };
}

export function buildRyuInverseSplit(): bigint[] {
  return buildInvSplit();
}

export function buildRyuSplit(): bigint[] {
  return buildSplit();
}

export function createRyuPowerArrayType(): ArrayTypeDef {
  return { kind: "array", name: "__ryu_i64_arr", element: RYU_I64, mutable: false };
}
