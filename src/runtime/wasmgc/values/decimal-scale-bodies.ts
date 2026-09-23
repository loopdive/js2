// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../../../wasm/model/instructions.js";
import type { ArrayTypeDef } from "../../../wasm/model/module-records.js";
export interface DecimalPowerResources {
  readonly arrayTypeIndex: number;
  readonly globalIndex: number;
}
/**
 * (#4234) Largest decimal exponent held in the `10^k` lookup table. `1e308` is
 * the last power of ten below `Number.MAX_VALUE`; `1e309` is `Infinity`, so the
 * table stops here and anything beyond is reached by the staged loop below.
 */
export const POW10_TABLE_MAX = 308;
export function buildDecimalPowerArrayType(): ArrayTypeDef {
  return { kind: "array", name: "Pow10TableF64", element: { kind: "f64" }, mutable: false };
}
export function buildDecimalPowerArrayInitializer(arrTypeIdx: number): Instr[] {
  const init: Instr[] = [];
  for (let k = 0; k <= POW10_TABLE_MAX; k++) init.push({ op: "f64.const", value: Number(`1e${k}`) });
  init.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: POW10_TABLE_MAX + 1 });
  return init;
}
/**
 * (#2654) Correctly-rounded final scaling for the integer-mantissa parse path.
 *
 * The integer + fraction loops accumulate ALL significant digits into `L_MANT`
 * as a single exact integer (`mant = mant*10 + digit`, exact while ≤ 2^53) and
 * count the fraction digits into `L_FRACCOUNT`. The decimal value is therefore
 * `sign * mant * 10^(expSign*exp - fracCount)`. This replaces the legacy
 * per-digit `mant += digit*0.1^k` accumulation, which compounded rounding error
 * (`parseFloat("0.3")` → 0.30000000000000004, `Number("0.01")` → 0.0100…2).
 *
 *   totalExp = (expSign<0 ? -exp : exp) - fracCount          // i32, in L_TEXP
 *
 * Scaling strategy (#4234 — one rounding wherever the table reaches):
 *   |totalExp| ≤ 308 → read `pow = 10^|totalExp|` from the module's immutable
 *                      `__pow10_f64` table (`ensurePow10TableGlobal`) and apply
 *                      ONE `f64.mul`/`f64.div`. Below 10^23 the entry is exact,
 *                      above it the entry is the nearest double — either way the
 *                      single operation is the ONLY rounding, so the result is
 *                      within one ulp of correct.
 *   |totalExp| > 308 → apply 10^308 first, then walk the remaining exponent with
 *                      the incremental per-step `*10`/`/10` loop
 *                      (`emitApplyExpResult`). Only this tail can reach
 *                      subnormals / saturate to ±Infinity, and stepping there is
 *                      what makes `1e-320` / `5e-324` / `1e400` degrade
 *                      gracefully instead of collapsing to 0 or Infinity via an
 *                      overflowing single power.
 *
 * The old cutover was at 22 (the largest exactly-representable power of ten), on
 * the reasoning that an inexact `pow` must be avoided. That was the wrong
 * trade: one rounding against a 0.5-ulp-accurate `pow` beats |totalExp| roundings
 * against an exact one. See `ensurePow10TableGlobal` for the measured table.
 *
 * Locals: `L_TEXP` (i32 scratch), `L_POW` (f64 scratch). `L_EXP` is reused as the
 * count-down scratch (its parsed value is no longer needed once `totalExp` is
 * computed). `L_RESULT` receives the final value (sign folded in via L_SIGN).
 */
export function buildApplyDecimalExp(
  powerResources: DecimalPowerResources,
  L_SIGN: number,
  L_MANT: number,
  L_FRACCOUNT: number,
  L_INTDROP: number,
  L_EXP: number,
  L_EXPSIGN: number,
  L_TEXP: number,
  L_POW: number,
  L_RESULT: number,
): Instr[] {
  const pow10GlobalIdx = powerResources.globalIndex;
  const pow10ArrTypeIdx = powerResources.arrayTypeIndex;
  /** `L_POW = 10^idxInstrs` — one table read, no arithmetic. */
  const loadPow = (idxInstrs: Instr[]): Instr[] => [
    { op: "global.get", index: pow10GlobalIdx },
    ...idxInstrs,
    { op: "array.get", typeIdx: pow10ArrTypeIdx },
    { op: "local.set", index: L_POW },
  ];
  /** `L_RESULT = (totalExp < 0) ? result / pow : result * pow` — ONE rounding. */
  const applyPow: Instr[] = [
    { op: "local.get", index: L_TEXP },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_RESULT },
        { op: "local.get", index: L_POW },
        { op: "f64.div" },
        { op: "local.set", index: L_RESULT },
      ],
      else: [
        { op: "local.get", index: L_RESULT },
        { op: "local.get", index: L_POW },
        { op: "f64.mul" },
        { op: "local.set", index: L_RESULT },
      ],
    },
  ];
  return [
    // totalExp = (expSign<0 ? -exp : exp) + intDrop - fracCount
    { op: "local.get", index: L_EXPSIGN },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.get", index: L_EXP },
        { op: "i32.sub" },
        { op: "local.set", index: L_TEXP },
      ],
      else: [
        { op: "local.get", index: L_EXP },
        { op: "local.set", index: L_TEXP },
      ],
    },
    // + intDrop (integer digits dropped past the significant-digit cap)
    { op: "local.get", index: L_TEXP },
    { op: "local.get", index: L_INTDROP },
    { op: "i32.add" },
    { op: "local.set", index: L_TEXP },
    // - fracCount
    { op: "local.get", index: L_TEXP },
    { op: "local.get", index: L_FRACCOUNT },
    { op: "i32.sub" },
    { op: "local.set", index: L_TEXP },
    // result = sign * (f64)mant   (mant is a non-negative i64 exact integer
    // ≤ ~9e17 < 2^63, so the signed convert is exact and == the unsigned value).
    { op: "local.get", index: L_SIGN },
    { op: "local.get", index: L_MANT },
    { op: "f64.convert_i64_s" },
    { op: "f64.mul" },
    { op: "local.set", index: L_RESULT },
    // count = |totalExp|  → into L_EXP (count-down scratch)
    { op: "local.get", index: L_TEXP },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.get", index: L_TEXP },
        { op: "i32.sub" },
        { op: "local.set", index: L_EXP },
      ],
      else: [
        { op: "local.get", index: L_TEXP },
        { op: "local.set", index: L_EXP },
      ],
    },
    // (#4234) |totalExp| ≤ 308 → ONE table read + ONE mul/div. Otherwise apply
    // 10^308 first and step the remainder, so only genuine subnormal/overflow
    // territory pays the per-step loop.
    { op: "local.get", index: L_EXP },
    { op: "i32.const", value: POW10_TABLE_MAX },
    { op: "i32.le_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...loadPow([{ op: "local.get", index: L_EXP }]), ...applyPow],
      else: [
        ...loadPow([{ op: "i32.const", value: POW10_TABLE_MAX }]),
        ...applyPow,
        // count -= 308, then walk what is left one power at a time. `L_TEXP`
        // still carries the direction, which is all `emitApplyExpResult` reads
        // from it.
        { op: "local.get", index: L_EXP },
        { op: "i32.const", value: POW10_TABLE_MAX },
        { op: "i32.sub" },
        { op: "local.set", index: L_EXP },
        ...emitApplyExpResult(L_TEXP, L_EXP, L_RESULT),
      ],
    },
  ];
}

/**
 * Incremental `result *= 10` / `result /= 10`, `count` (in `L_COUNT`) times.
 * Direction is taken from the sign of `L_TEXP` (the signed total exponent).
 * (#4234) Now used by `emitApplyDecimalExp` only for the residue BEYOND
 * `10^308`, i.e. exponents that necessarily land in subnormal or saturated
 * territory. Stepping there is deliberate: it reaches subnormals and saturates
 * to ±Infinity gracefully, which a single overflowing power cannot.
 */
function emitApplyExpResult(L_TEXP: number, L_COUNT: number, L_RESULT: number): Instr[] {
  return [
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_COUNT },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_TEXP },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_RESULT },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "local.set", index: L_RESULT },
              ],
              else: [
                { op: "local.get", index: L_RESULT },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.set", index: L_RESULT },
              ],
            },
            { op: "local.get", index: L_COUNT },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: L_COUNT },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
  ];
}
