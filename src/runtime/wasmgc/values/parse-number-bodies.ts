// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7350 B2c-1) Native `parseFloat` / `parseInt` bodies (ECMA-262 §19.2.4, §19.2.5), shared by the codegen
 * natives (`src/codegen/parse-number-native.ts`) and, later, the realm's global functions. Pure: each builder
 * reads only its bindings. Both take the argument as `externref` in param 0; the bindings' `flatString` turns it
 * into a flat native string (ToString first, for a non-string argument).
 */
import type { Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import { buildApplyDecimalExp, type DecimalPowerResources } from "./decimal-scale-bodies.js";
import { buildDecimalMantissa } from "./string-number-bodies.js";
import {
  C_PLUS,
  C_MINUS,
  C_DOT,
  C_ZERO,
  C_NINE,
  C_UC_X,
  C_LC_X,
  isWsBody,
  emitInfinityCheck,
  emitExponent,
  emitDigitValue,
} from "./string-number-grammar.js";

export interface ParseNumberBindings {
  readonly nativeStrTypeIdx: number;
  readonly nativeStrDataTypeIdx: number;
  /** Instructions that read param 0 (scratch `anyref` in `argLocal`) and leave a flat native string. */
  readonly flatString: (argLocal: number) => readonly Instr[];
}

export interface ParseNumberDefinition {
  readonly locals: LocalDef[];
  readonly body: Instr[];
}

// parseFloat locals (after param 0 = s:externref):
//  1 flat:ref$NativeString  2 data:ref$i16arr  3 len:i32  4 i:i32  5 c:i32  6 sign:f64  7 mant:i64
//  8 sawDigit:i32  9 fracScale:f64  10 expSign:i32  11 exp:i32  12 result:f64  13 fracCount:i32
// 14 texp:i32  15 pow:f64  16 intDrop:i32  17 arg:anyref
const PF_FLAT = 1;
const PF_DATA = 2;
const PF_LEN = 3;
const PF_I = 4;
const PF_C = 5;
const PF_SIGN = 6;
const PF_MANT = 7;
const PF_SAW = 8;
// index 9 = fracScale: unread since the #2654 integer-mantissa rewrite, kept so the local layout (and the bytes) stay
const PF_EXPSIGN = 10;
const PF_EXP = 11;
const PF_RESULT = 12;
// (#2654) integer-mantissa scaling scratch locals.
const PF_FRACCOUNT = 13; // i32: number of fraction digits consumed
const PF_TEXP = 14; // i32: total decimal exponent (expSign*exp + intDrop - fracCount)
const PF_POW = 15; // f64: 10^|totalExp|
const PF_INTDROP = 16; // i32: integer digits dropped past the ~18-digit cap (mant < 9e17)
const PF_ANY = 17; // (#6969) anyref: the argument, for the ToString arm

/** `parseFloat(string)`: `(externref) -> f64`, the longest StrDecimalLiteral prefix. */
export function buildParseFloatDefinition(
  bindings: ParseNumberBindings & { readonly powerResources: DecimalPowerResources },
): ParseNumberDefinition {
  const strTypeIdx = bindings.nativeStrTypeIdx;
  const strDataTypeIdx = bindings.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };

  const getC: Instr[] = [
    { op: "local.get", index: PF_DATA },
    { op: "local.get", index: PF_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: PF_C },
  ];

  const body: Instr[] = [
    // flat = flatten(s); data = flat.data; len = flat.len; i = 0
    ...bindings.flatString(PF_ANY),
    { op: "local.set", index: PF_FLAT },
    { op: "local.get", index: PF_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: PF_DATA },
    { op: "local.get", index: PF_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: PF_LEN },
    // i = off (flat strings may carry a nonzero off)
    { op: "local.get", index: PF_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: PF_I },
    // len = off + len  (so PF_I..PF_LEN spans the logical string)
    { op: "local.get", index: PF_LEN },
    { op: "local.get", index: PF_I },
    { op: "i32.add" },
    { op: "local.set", index: PF_LEN },
    { op: "f64.const", value: 1 },
    { op: "local.set", index: PF_SIGN },
    { op: "i64.const", value: 0n },
    { op: "local.set", index: PF_MANT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: PF_SAW },

    // --- skip leading whitespace ---
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if i>=len break
            { op: "local.get", index: PF_I },
            { op: "local.get", index: PF_LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...getC,
            // if !ws break
            ...isWsBody(PF_C),
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: PF_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: PF_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // --- optional sign ---
    { op: "local.get", index: PF_I },
    { op: "local.get", index: PF_LEN },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        { op: "local.get", index: PF_C },
        { op: "i32.const", value: C_MINUS },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "f64.const", value: -1 },
            { op: "local.set", index: PF_SIGN },
            { op: "local.get", index: PF_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: PF_I },
          ],
          else: [
            { op: "local.get", index: PF_C },
            { op: "i32.const", value: C_PLUS },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: PF_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: PF_I },
              ],
            },
          ],
        },
      ],
    },

    // --- Infinity check ---
    ...emitInfinityCheck(PF_I, PF_LEN, PF_DATA, PF_C, PF_SIGN, strDataTypeIdx),

    ...buildDecimalMantissa(
      { i: PF_I, end: PF_LEN, c: PF_C, mant: PF_MANT, saw: PF_SAW, fracCount: PF_FRACCOUNT, intDrop: PF_INTDROP },
      getC,
    ),

    // --- exponent ---
    { op: "i32.const", value: 0 },
    { op: "local.set", index: PF_EXP },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: PF_EXPSIGN },
    ...emitExponent(PF_I, PF_LEN, PF_DATA, PF_C, PF_EXP, PF_EXPSIGN, strDataTypeIdx, getC),

    // (#2654) result = sign * mant * 10^(expSign*exp + intDrop - fracCount),
    // applied as a single correctly-rounded multiply/divide (see
    // buildApplyDecimalExp).
    ...buildApplyDecimalExp(
      bindings.powerResources,
      PF_SIGN,
      PF_MANT,
      PF_FRACCOUNT,
      PF_INTDROP,
      PF_EXP,
      PF_EXPSIGN,
      PF_TEXP,
      PF_POW,
      PF_RESULT,
    ),
    { op: "local.get", index: PF_RESULT },
    { op: "return" },
  ];

  return {
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
      { name: "len", type: i32 },
      { name: "i", type: i32 },
      { name: "c", type: i32 },
      { name: "sign", type: f64 },
      { name: "mant", type: { kind: "i64" } },
      { name: "sawDigit", type: i32 },
      { name: "fracScale", type: f64 },
      { name: "expSign", type: i32 },
      { name: "exp", type: i32 },
      { name: "result", type: f64 },
      { name: "fracCount", type: i32 },
      { name: "texp", type: i32 },
      { name: "pow", type: f64 },
      { name: "intDrop", type: i32 },
      { name: "arg", type: { kind: "anyref" } },
    ],
    body,
  };
}

/**
 * `parseInt(string, radix)`: `(externref, f64) -> f64`; the radix is NaN when omitted. Trim whitespace, optional
 * sign, optional `0x` prefix (radix 16 or auto), digit loop in radix 2..36, NaN if no digits.
 */
export function buildParseIntDefinition(bindings: ParseNumberBindings): ParseNumberDefinition {
  const strTypeIdx = bindings.nativeStrTypeIdx;
  const strDataTypeIdx = bindings.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  // params: 0 s:externref, 1 radixF:f64
  // locals: 2 flat 3 data 4 len 5 i 6 c 7 sign:f64 8 radix:i32
  //         9 value:f64 10 sawDigit:i32 11 dig:i32 12 arg:anyref (#6969)
  const L_FLAT = 2;
  const L_DATA = 3;
  const L_LEN = 4;
  const L_I = 5;
  const L_C = 6;
  const L_SIGN = 7;
  const L_RADIX = 8;
  const L_VALUE = 9;
  const L_SAW = 10;
  const L_DIG = 11;
  const L_ANY = 12;

  const getC: Instr[] = [
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_C },
  ];

  const body: Instr[] = [
    ...bindings.flatString(L_ANY),
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
    { op: "local.set", index: L_LEN }, // len = off + len
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_SIGN },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: L_VALUE },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_SAW },
    // radix = (radixF != radixF) ? 0 : trunc(radixF)
    { op: "local.get", index: 1 },
    { op: "local.get", index: 1 },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_RADIX },
      ],
      else: [{ op: "local.get", index: 1 }, { op: "i32.trunc_sat_f64_s" }, { op: "local.set", index: L_RADIX }],
    },

    // skip whitespace
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_LEN },
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

    // optional sign
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_LEN },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
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
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_I },
              ],
            },
          ],
        },
      ],
    },

    // 0x prefix handling: if radix==0||16 and next two chars are "0x"/"0X"
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: L_LEN },
    { op: "i32.lt_s" }, // i+1 < len
    { op: "local.get", index: L_RADIX },
    { op: "i32.eqz" },
    { op: "local.get", index: L_RADIX },
    { op: "i32.const", value: 16 },
    { op: "i32.eq" },
    { op: "i32.or" }, // radix==0||16
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_DATA },
        { op: "local.get", index: L_I },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "i32.const", value: C_ZERO },
        { op: "i32.eq" },
        { op: "local.get", index: L_DATA },
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "i32.const", value: C_LC_X },
        { op: "i32.eq" },
        { op: "local.get", index: L_DATA },
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "array.get_u", typeIdx: strDataTypeIdx },
        { op: "i32.const", value: C_UC_X },
        { op: "i32.eq" },
        { op: "i32.or" }, // [i+1]=='x'||'X'
        { op: "i32.and" }, // [i]=='0' && ...
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 16 },
            { op: "local.set", index: L_RADIX },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 2 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
          ],
        },
      ],
    },

    // default radix 10 if still 0
    { op: "local.get", index: L_RADIX },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: 10 },
        { op: "local.set", index: L_RADIX },
      ],
    },
    // radix range check: 2..36 else NaN
    { op: "local.get", index: L_RADIX },
    { op: "i32.const", value: 2 },
    { op: "i32.lt_s" },
    { op: "local.get", index: L_RADIX },
    { op: "i32.const", value: 36 },
    { op: "i32.gt_s" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },

    // digit loop
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_LEN },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...getC,
            // dig = digitValue(c)
            ...emitDigitValue(L_C, L_DIG),
            // if dig < 0 || dig >= radix break
            { op: "local.get", index: L_DIG },
            { op: "i32.const", value: 0 },
            { op: "i32.lt_s" },
            { op: "local.get", index: L_DIG },
            { op: "local.get", index: L_RADIX },
            { op: "i32.ge_s" },
            { op: "i32.or" },
            { op: "br_if", depth: 1 },
            // value = value*radix + dig
            { op: "local.get", index: L_VALUE },
            { op: "local.get", index: L_RADIX },
            { op: "f64.convert_i32_s" },
            { op: "f64.mul" },
            { op: "local.get", index: L_DIG },
            { op: "f64.convert_i32_s" },
            { op: "f64.add" },
            { op: "local.set", index: L_VALUE },
            { op: "i32.const", value: 1 },
            { op: "local.set", index: L_SAW },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },

    // if !sawDigit return NaN
    { op: "local.get", index: L_SAW },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    { op: "local.get", index: L_SIGN },
    { op: "local.get", index: L_VALUE },
    { op: "f64.mul" },
    { op: "return" },
  ];

  return {
    locals: [
      { name: "flat", type: { kind: "ref", typeIdx: strTypeIdx } },
      { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
      { name: "len", type: i32 },
      { name: "i", type: i32 },
      { name: "c", type: i32 },
      { name: "sign", type: f64 },
      { name: "radix", type: i32 },
      { name: "value", type: f64 },
      { name: "sawDigit", type: i32 },
      { name: "dig", type: i32 },
      { name: "arg", type: { kind: "anyref" } },
    ],
    body,
  };
}
