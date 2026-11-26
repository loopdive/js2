// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import type { NativeStringLayout } from "./string-layouts.js";
import { buildApplyDecimalExp, type DecimalPowerResources } from "./decimal-scale-bodies.js";
import {
  C_MINUS,
  C_PLUS,
  C_ZERO,
  C_NINE,
  C_DOT,
  C_LC_E,
  C_UC_E,
  isWsBody,
  emitInfinityExact,
  emitRadixPrefixParse,
  emitExponent,
} from "./string-number-grammar.js";
// params: 0 s:externref
// locals: 1 flat 2 data 3 end:i32 4 i:i32 5 c:i32 6 sign:f64 7 mant:i64
//         8 sawDigit:i32 9 fracScale:f64 10 expSign:i32 11 exp:i32
//         12 result:f64 13 radix:i32 14 dig:i32
const L_FLAT = 1;
const L_DATA = 2;
const L_END = 3;
const L_I = 4;
const L_C = 5;
const L_SIGN = 6;
const L_MANT = 7;
const L_SAW = 8;
const L_FRAC = 9; // fracScale: unread since the #2654 integer-mantissa rewrite, kept for the local layout (and bytes)
const L_EXPSIGN = 10;
const L_EXP = 11;
const L_RESULT = 12;
const L_RADIX = 13;
const L_DIG = 14;
// (#2654) integer-mantissa scaling scratch locals.
const L_FRACCOUNT = 15; // i32: number of fraction digits consumed
const L_TEXP = 16; // i32: total decimal exponent (expSign*exp + intDrop - fracCount)
const L_POW = 17; // f64: 10^|totalExp|
const L_INTDROP = 18; // i32: integer digits dropped past the ~18-digit cap (mant < 9e17)
// (#3570) i32: 1 iff an explicit '+'/'-' sign char was consumed. A
// NonDecimalIntegerLiteral (0x/0o/0b) is INVALID with any leading sign
// (§7.1.4.1), so `Number('+0x10')`/`Number('-0x10')` must be NaN. The old
// radix guard keyed on `sign==1`, which admits the '+' case (it leaves
// sign=+1); this flag distinguishes "no sign" from "explicit +".
const L_SAWSIGN = 19;
/** Complete scanner through exponent/full-match rejection; no power allocation. */
export function buildStringToNumberPrelude(layout: NativeStringLayout, flattenHandle: FuncHandle): Instr[] {
  const strTypeIdx = layout.nativeStrTypeIdx;
  const strDataTypeIdx = layout.nativeStrDataTypeIdx;
  const getC: Instr[] = [
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_C },
  ];
  const getCharAt = (idxInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: L_DATA },
    ...idxInstrs,
    { op: "array.get_u", typeIdx: strDataTypeIdx },
  ];
  return [
    // flat = flatten(s); data = flat.data; i = flat.off; end = off + len
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: layout.anyStrTypeIdx },
    { op: "call", funcIdx: flattenHandle },
    { op: "local.set", index: L_FLAT },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: L_DATA },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: L_I }, // i = off
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: L_I },
    { op: "i32.add" },
    { op: "local.set", index: L_END }, // end = off + len

    // --- trim leading whitespace ---
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_END },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...getC,
            ...isWsBody(L_C),
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // --- trim trailing whitespace (shrink end while end>i and data[end-1] ws) ---
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_END },
            { op: "local.get", index: L_I },
            { op: "i32.le_s" },
            { op: "br_if", depth: 1 }, // end<=i → done
            ...getCharAt([{ op: "local.get", index: L_END }, { op: "i32.const", value: 1 }, { op: "i32.sub" }]),
            { op: "local.set", index: L_C },
            ...isWsBody(L_C),
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 }, // not ws → done
            { op: "local.get", index: L_END },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: L_END },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // --- empty (after trim) → 0 ---
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: 0 }, { op: "return" }],
    },

    // --- optional sign ---
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_SIGN },
    ...getC,
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_MINUS },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: -1 },
        { op: "local.set", index: L_SIGN },
        { op: "i32.const", value: 1 },
        { op: "local.set", index: L_SAWSIGN },
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L_I },
      ],
      else: [
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_PLUS },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 1 },
            { op: "local.set", index: L_SAWSIGN },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
          ],
        },
      ],
    },

    // --- Infinity (must be exactly "Infinity" to the end) ---
    ...emitInfinityExact(L_I, L_END, L_DATA, L_SIGN, strDataTypeIdx),

    // --- radix prefix 0x / 0o / 0b (only valid when NO sign was consumed;
    //     StrNumericLiteral allows them only as NonDecimalIntegerLiteral with
    //     no sign). We detect "0[xob]" at the current i and require i to be the
    //     original start with sign==1; to keep it simple we allow it whenever
    //     two chars remain — sign already shifted i, and a signed 0x is NaN per
    //     spec, so guard on sign==1. ---
    ...emitRadixPrefixParse(L_I, L_END, L_DATA, L_C, L_SAWSIGN, L_RADIX, L_DIG, L_RESULT, L_SAW, strDataTypeIdx),

    { op: "i64.const", value: 0n },
    { op: "local.set", index: L_MANT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_SAW },
    ...buildDecimalMantissa(
      { i: L_I, end: L_END, c: L_C, mant: L_MANT, saw: L_SAW, fracCount: L_FRACCOUNT, intDrop: L_INTDROP },
      getC,
    ),
    // exponent
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_EXP },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L_EXPSIGN },
    ...emitExponent(L_I, L_END, L_DATA, L_C, L_EXP, L_EXPSIGN, strDataTypeIdx, getC),
    // StringToNumber requires exponent digits, unlike parseFloat's prefix grammar.
    // Read the last consumed character: L_C may instead hold unconsumed lookahead.
    // The mantissa's no-digit rejection guarantees L_I - 1 is a valid index.
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 1 },
    { op: "i32.sub" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_C },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_LC_E },
    { op: "i32.eq" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_UC_E },
    { op: "i32.eq" },
    { op: "i32.or" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_PLUS },
    { op: "i32.eq" },
    { op: "i32.or" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_MINUS },
    { op: "i32.eq" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // full-match requirement: if i != end → NaN (trailing junk)
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
  ];
}
/** The legacy caller constructs the lazy power table immediately before this tail. */
export function buildStringToNumberResult(powerResources: DecimalPowerResources): Instr[] {
  return [
    // (#2654) result = sign * mant * 10^(expSign*exp + intDrop - fracCount),
    // applied as a single correctly-rounded multiply/divide (see
    // buildApplyDecimalExp).
    ...buildApplyDecimalExp(
      powerResources,
      L_SIGN,
      L_MANT,
      L_FRACCOUNT,
      L_INTDROP,
      L_EXP,
      L_EXPSIGN,
      L_TEXP,
      L_POW,
      L_RESULT,
    ),
    { op: "local.get", index: L_RESULT },
    { op: "return" },
  ];
}
export function buildStringToNumberLocals(layout: NativeStringLayout): LocalDef[] {
  const strTypeIdx = layout.nativeStrTypeIdx;
  const strDataTypeIdx = layout.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  return [
    { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
    { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
    { name: "end", type: i32 },
    { name: "i", type: i32 },
    { name: "c", type: i32 },
    { name: "sign", type: f64 },
    { name: "mant", type: { kind: "i64" } },
    { name: "sawDigit", type: i32 },
    { name: "fracScale", type: f64 },
    { name: "expSign", type: i32 },
    { name: "exp", type: i32 },
    { name: "result", type: f64 },
    { name: "radix", type: i32 },
    { name: "dig", type: i32 },
    { name: "fracCount", type: i32 },
    { name: "texp", type: i32 },
    { name: "pow", type: f64 },
    { name: "intDrop", type: i32 },
    { name: "sawSign", type: i32 },
  ];
}

/** The locals the decimal mantissa scan reads and writes (StringToNumber's and parseFloat's differ). */
export interface DecimalMantissaLocals {
  readonly i: number;
  readonly end: number;
  readonly c: number;
  readonly mant: number;
  readonly saw: number;
  readonly fracCount: number;
  readonly intDrop: number;
}

/**
 * The integer and fraction digits from `i` to `end`: every significant digit into the i64 `mant` (capped at
 * ~18 digits, the rest counted in `intDrop`), fraction digits counted in `fracCount`, `saw` set on any digit.
 * The caller zeroes `mant` and `saw` first.
 */
export function buildDecimalMantissa(locals: DecimalMantissaLocals, getC: readonly Instr[]): Instr[] {
  return [
    // --- decimal mantissa ---
    // integer digits
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: locals.i },
            { op: "local.get", index: locals.end },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...getC,
            { op: "local.get", index: locals.c },
            { op: "i32.const", value: C_ZERO },
            { op: "i32.lt_s" },
            { op: "local.get", index: locals.c },
            { op: "i32.const", value: C_NINE },
            { op: "i32.gt_s" },
            { op: "i32.or" },
            { op: "br_if", depth: 1 },
            // (#2654) i64 integer-mantissa accumulation, capped at ~18 sig digits
            // (mant < 9e17 keeps mant*10+9 < 2^63). Past the cap an integer digit
            // is dropped from the mantissa and its place value preserved by
            // bumping the exponent (locals.intDrop).
            { op: "local.get", index: locals.mant },
            { op: "i64.const", value: 900000000000000000n },
            { op: "i64.lt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: locals.mant },
                { op: "i64.const", value: 10n },
                { op: "i64.mul" },
                { op: "local.get", index: locals.c },
                { op: "i32.const", value: C_ZERO },
                { op: "i32.sub" },
                { op: "i64.extend_i32_s" },
                { op: "i64.add" },
                { op: "local.set", index: locals.mant },
              ],
              else: [
                { op: "local.get", index: locals.intDrop },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: locals.intDrop },
              ],
            },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: locals.saw },
            { op: "local.get", index: locals.i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: locals.i },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // fraction
    { op: "local.get", index: locals.i },
    { op: "local.get", index: locals.end },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        { op: "local.get", index: locals.c },
        { op: "i32.const", value: C_DOT },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: locals.i },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: locals.i },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: locals.i },
                    { op: "local.get", index: locals.end },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    ...getC,
                    { op: "local.get", index: locals.c },
                    { op: "i32.const", value: C_ZERO },
                    { op: "i32.lt_s" },
                    { op: "local.get", index: locals.c },
                    { op: "i32.const", value: C_NINE },
                    { op: "i32.gt_s" },
                    { op: "i32.or" },
                    { op: "br_if", depth: 1 },
                    // (#2654) i64 integer-mantissa accumulation, capped at ~18 sig
                    // digits (mant < 9e17). Within the cap: mant = mant*10 + digit
                    // and fracCount++. Past the cap a fraction digit is dropped (no
                    // visible effect on the rounded double), NOT counted.
                    { op: "local.get", index: locals.mant },
                    { op: "i64.const", value: 900000000000000000n },
                    { op: "i64.lt_u" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: locals.mant },
                        { op: "i64.const", value: 10n },
                        { op: "i64.mul" },
                        { op: "local.get", index: locals.c },
                        { op: "i32.const", value: C_ZERO },
                        { op: "i32.sub" },
                        { op: "i64.extend_i32_s" },
                        { op: "i64.add" },
                        { op: "local.set", index: locals.mant },
                        { op: "local.get", index: locals.fracCount },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: locals.fracCount },
                      ],
                      else: [],
                    },
                    { op: "i32.const", value: 1 },
                    { op: "local.set", index: locals.saw },
                    { op: "local.get", index: locals.i },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: locals.i },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    // if no digit seen at all → NaN (e.g. ".", "+", "e5")
    { op: "local.get", index: locals.saw },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
  ];
}
