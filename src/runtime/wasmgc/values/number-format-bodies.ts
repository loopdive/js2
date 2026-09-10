// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, LocalDef, ValType } from "../../../wasm/model/instructions.js";
import type { NumberFormatStringTypes } from "./number-format-radix-bodies.js";

export interface NativeNumberFormatBody {
  readonly locals: LocalDef[];
  readonly body: Instr[];
}

/** One reference-parameterized signature owner for recipes and legacy adapters. */
export function numberFormatSignatures<R>(refs: { readonly data: R; readonly nullableData: R; readonly anyString: R }) {
  const f64 = { kind: "f64" } as const;
  const i32 = { kind: "i32" } as const;
  const extern = { kind: "externref" } as const;
  return {
    finalize: { params: [refs.data, i32], results: [extern] },
    new: { params: [f64], results: [refs.nullableData] },
    get: { params: [refs.nullableData, f64], results: [f64] },
    set: { params: [refs.nullableData, f64, f64], results: [] },
    trap: { params: [], results: [] },
    fin: { params: [refs.nullableData, f64], results: [refs.anyString] },
    radixBody: { params: [f64, f64], results: [refs.anyString] },
    radixThunk: { params: [f64, f64], results: [extern] },
    toString: { params: [f64], results: [extern] },
    nativeToString: { params: [f64], results: [refs.anyString] },
    withDigits: { params: [f64, f64], results: [extern] },
  };
}
const BUF_CAP = 256;
const MAX_SAFE_INTEGER = 9007199254740991;
const C_ZERO = 48; // '0'
const C_MINUS = 45; // '-'
const C_PLUS = 43; // '+'
const C_DOT = 46; // '.'
const C_LC_E = 101; // 'e'

function putConst(strDataTypeIdx: number, bufLocal: number, posLocal: number, code: number): Instr[] {
  return [
    { op: "local.get", index: bufLocal },
    { op: "local.get", index: posLocal },
    { op: "i32.const", value: code },
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: posLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: posLocal },
  ];
}

function emitNonFinitePrologue(
  finalizeIdx: number,
  strDataTypeIdx: number,
  valueLocal: number,
  bufLocal: number,
  posLocal: number,
  tmpLocal: number,
  negLocal: number,
  absLocal: number,
): Instr[] {
  const writeWord = (w: string): Instr[] => {
    const out: Instr[] = [];
    for (const ch of w) out.push(...putConst(strDataTypeIdx, bufLocal, posLocal, ch.charCodeAt(0)));
    out.push(
      { op: "local.get", index: bufLocal },
      { op: "local.get", index: posLocal },
      { op: "call", funcIdx: finalizeIdx },
      { op: "return" },
    );
    return out;
  };

  return [
    // buf = array.new_default(BUF_CAP); pos = 0
    { op: "i32.const", value: BUF_CAP },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: bufLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: posLocal },

    // if (value != value)  → NaN
    { op: "local.get", index: valueLocal },
    { op: "local.get", index: valueLocal },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: writeWord("NaN"),
    },

    // neg = value < 0
    { op: "local.get", index: valueLocal },
    { op: "f64.const", value: 0 },
    { op: "f64.lt" },
    { op: "local.set", index: negLocal },
    // abs = |value|
    { op: "local.get", index: valueLocal },
    { op: "f64.abs" },
    { op: "local.set", index: absLocal },

    // if (abs == Infinity) → write sign + "Infinity"
    { op: "local.get", index: absLocal },
    { op: "f64.const", value: Infinity },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // if neg write '-'
        { op: "local.get", index: negLocal },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: putConst(strDataTypeIdx, bufLocal, posLocal, C_MINUS),
        },
        ...writeWord("Infinity"),
      ],
    },
  ];
}

function emitIntegerDigits(
  strDataTypeIdx: number,
  intLocal: number,
  bufLocal: number,
  posLocal: number,
  tmpLocal: number,
  powLocal: number,
  digitLocal: number,
): Instr[] {
  return [
    // if (int < 1) { write '0' } else { ... }
    { op: "local.get", index: intLocal },
    { op: "f64.const", value: 1 },
    { op: "f64.lt" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, bufLocal, posLocal, C_ZERO),
      else: [
        // pow = 1; while (pow*10 <= int) pow *= 10
        { op: "f64.const", value: 1 },
        { op: "local.set", index: powLocal },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: powLocal },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.get", index: intLocal },
                { op: "f64.le" },
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: powLocal },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.set", index: powLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // while (pow >= 1) { d = floor(int/pow); write '0'+d; int -= d*pow; pow/=10 }
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: powLocal },
                { op: "f64.const", value: 1 },
                { op: "f64.lt" },
                { op: "br_if", depth: 1 },
                // digit = floor(int/pow)
                { op: "local.get", index: intLocal },
                { op: "local.get", index: powLocal },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: digitLocal },
                // write '0' + (i32)digit
                { op: "local.get", index: bufLocal },
                { op: "local.get", index: posLocal },
                { op: "i32.const", value: C_ZERO },
                { op: "local.get", index: digitLocal },
                { op: "i32.trunc_f64_s" },
                { op: "i32.add" },
                { op: "array.set", typeIdx: strDataTypeIdx },
                { op: "local.get", index: posLocal },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: posLocal },
                // int -= digit*pow
                { op: "local.get", index: intLocal },
                { op: "local.get", index: digitLocal },
                { op: "local.get", index: powLocal },
                { op: "f64.mul" },
                { op: "f64.sub" },
                { op: "local.set", index: intLocal },
                // pow /= 10
                { op: "local.get", index: powLocal },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: powLocal },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

export function buildNumberFormatFinalizeBody(types: NumberFormatStringTypes): NativeNumberFormatBody {
  const strTypeIdx = types.nativeStringTypeIdx;
  const strDataTypeIdx = types.dataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const bufType: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // params: 0 buf:i16[], 1 len:i32 ; locals: 2 out:i16[], 3 i:i32
  const L_BUF = 0;
  const L_LEN = 1;
  const L_OUT = 2;
  const L_I = 3;

  const body: Instr[] = [
    // out = array.new_default(len)
    { op: "local.get", index: L_LEN },
    { op: "array.new_default", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_OUT },
    // i = 0
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_I },
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
            // out[i] = buf[i]
            { op: "local.get", index: L_OUT },
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_BUF },
            { op: "local.get", index: L_I },
            { op: "array.get_u", typeIdx: strDataTypeIdx },
            { op: "array.set", typeIdx: strDataTypeIdx },
            // i++
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // struct.new $NativeString(len, off=0, out)
    { op: "local.get", index: L_LEN },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_OUT },
    { op: "struct.new", typeIdx: strTypeIdx },
    { op: "extern.convert_any" },
    { op: "return" },
  ];

  return {
    locals: [
      { name: "out", type: bufType },
      { name: "i", type: i32 },
    ],
    body,
  };
}

export function buildNumberFormatToStringBody(resources: {
  readonly types: NumberFormatStringTypes;
  readonly finalize: FuncHandle;
  readonly radix: FuncHandle;
  readonly ryuToBuffer: FuncHandle;
  readonly integerBeforeScratch: boolean;
}): NativeNumberFormatBody {
  const strDataTypeIdx = resources.types.dataTypeIdx;
  const finalizeIdx = resources.finalize;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const bufType: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  const radixIdx = resources.radix;
  const ryuToBufIdx = resources.ryuToBuffer;
  // params: 0 value:f64 ; locals: 1 buf 2 pos 3 tmp 4 neg 5 abs.
  // The Ryū path keeps its own scratch inside __num_ryu_to_buf, so this function
  // only needs the prologue locals.
  const L_VALUE = 0;
  const L_BUF = 1;
  const L_POS = 2;
  const L_TMP = 3;
  const L_NEG = 4;
  const L_ABS = 5;

  // Integer formatting is the overwhelmingly common ToString path in loops
  // (array indices, counters, template substitutions).  The shared non-finite
  // prologue allocates a 256-code-unit Ryū scratch buffer, but safe integers
  // immediately delegate to the radix-10 formatter and never read that buffer.
  // Test the integer regime first so those calls avoid the dead allocation.
  // Keep an emission kill switch for exact A/B attribution and emergency
  // rollback; disabled output retains the former post-prologue guard.
  const integerBeforeScratch = resources.integerBeforeScratch;

  const safeIntegerReturn = (integerValue: Instr[], magnitude: Instr[]): Instr[] => [
    ...integerValue,
    ...integerValue,
    { op: "f64.floor" },
    { op: "f64.eq" },
    ...magnitude,
    { op: "f64.const", value: MAX_SAFE_INTEGER },
    { op: "f64.le" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_VALUE },
        { op: "f64.const", value: 10 },
        { op: "call", funcIdx: radixIdx },
        { op: "return" },
      ],
    },
  ];

  const preScratchIntegerReturn = (): Instr[] =>
    safeIntegerReturn([{ op: "local.get", index: L_VALUE }], [{ op: "local.get", index: L_VALUE }, { op: "f64.abs" }]);

  const postScratchIntegerReturn = (): Instr[] =>
    safeIntegerReturn([{ op: "local.get", index: L_ABS }], [{ op: "local.get", index: L_ABS }]);

  const finalizeReturn = (): Instr[] => [
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: finalizeIdx },
    { op: "return" },
  ];

  const body: Instr[] = [
    ...(integerBeforeScratch ? preScratchIntegerReturn() : []),
    ...emitNonFinitePrologue(finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),

    // NOTE (#1537): the §6.1.6.1.20 exponential-notation regime is NOT special-
    // cased here. The shortest-roundtrip Ryū formatter below (`__num_ryu_to_buf`)
    // implements the full §6.1.6.1.13 framing and already chooses fixed vs
    // `d.dddde±N` by the decimal-point position `n` (exponential when n > 21 or
    // n <= -6), producing V8-exact output for `1e21`→"1e+21", `1e-7`→"1e-7",
    // `5e-324`, and Number.MAX_VALUE alike. The earlier #1836 magnitude-threshold
    // gate routed those through a fixed 15-significant-digit `emitExponential`,
    // which truncated the shortest representation (e.g. MAX_VALUE →
    // "1.79769313486232e+308"); Ryū supersedes it.

    // Safe integers can reuse the radix-10 formatter exactly. With the fast
    // path enabled this branch already returned before scratch allocation; the
    // disabled form is deliberately the former byte-for-byte position/shape.
    ...(integerBeforeScratch ? [] : postScratchIntegerReturn()),

    // Fractional / unsafe-magnitude branch: shortest-roundtrip Ryū (#1537).
    // `__num_ryu_to_buf(abs, neg, buf, pos)` writes the §6.1.6.1.13-formatted
    // shortest decimal (including the leading '-' when neg) and returns the new
    // write position. Passing `abs` keeps the sign bit clear so the Ryū core
    // sees a positive value; the sign is reapplied by the formatter from `neg`.
    { op: "local.get", index: L_ABS },
    { op: "local.get", index: L_NEG },
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: ryuToBufIdx },
    { op: "local.set", index: L_POS },
    ...finalizeReturn(),
  ];

  return {
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
    ],
    body,
  };
}

export function buildNumberFormatToFixedBody(resources: {
  readonly types: NumberFormatStringTypes;
  readonly finalize: FuncHandle;
  readonly toString?: FuncHandle;
}): NativeNumberFormatBody {
  const strDataTypeIdx = resources.types.dataTypeIdx;
  const finalizeIdx = resources.finalize;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const bufType: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  // params: 0 value:f64, 1 digits:f64
  // locals: 2 buf  3 pos  4 tmp  5 neg  6 abs  7 scale  8 scaled
  //         9 intpart 10 fracpart 11 pow 12 digit 13 fdig 14 k
  const L_VALUE = 0;
  const L_DIGITS = 1;
  const L_BUF = 2;
  const L_POS = 3;
  const L_TMP = 4;
  const L_NEG = 5;
  const L_ABS = 6;
  const L_SCALE = 7;
  const L_SCALED = 8;
  const L_INT = 9;
  const L_FRAC = 10;
  const L_POW = 11;
  const L_DIGIT = 12;
  const L_FDIG = 13; // fractional digit count (i32)
  const L_K = 14;

  // §21.1.3.3 Number.prototype.toFixed step 5: if x >= 10^21, return ToString(x).
  // Without this, the scaled fixed-point path below overflows the integer-digit
  // emitter and prints a bogus 22-digit integer. number_toString is guaranteed
  // emitted alongside toFixed (see emitNumberFormatHelpers).
  const numToStrIdx = resources.toString;
  const toStringFallback: Instr[] =
    numToStrIdx !== undefined
      ? [
          { op: "local.get", index: L_ABS },
          { op: "f64.const", value: 1e21 },
          { op: "f64.ge" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: L_VALUE }, { op: "call", funcIdx: numToStrIdx }, { op: "return" }],
          },
        ]
      : [];

  const body: Instr[] = [
    ...emitNonFinitePrologue(finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),
    // §21.1.3.3 step 5: |x| >= 1e21 → ToString(x) (defers to number_toString).
    ...toStringFallback,
    // fdig = (i32)digits (truncated)
    { op: "local.get", index: L_DIGITS },
    { op: "i32.trunc_f64_s" },
    { op: "local.set", index: L_FDIG },
    // scale = 10^fdig (computed by loop)
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_SCALE },
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
            { op: "local.get", index: L_K },
            { op: "local.get", index: L_FDIG },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_SCALE },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.set", index: L_SCALE },
            { op: "local.get", index: L_K },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_K },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // scaled = round_half_away(abs * scale) = floor(abs*scale + 0.5)
    { op: "local.get", index: L_ABS },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.const", value: 0.5 },
    { op: "f64.add" },
    { op: "f64.floor" },
    { op: "local.set", index: L_SCALED },
    // int = floor(scaled/scale); frac = scaled - int*scale
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_SCALE },
    { op: "f64.div" },
    { op: "f64.floor" },
    { op: "local.set", index: L_INT },
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_INT },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.sub" },
    { op: "local.set", index: L_FRAC },
    // sign: if neg && (int>0 || frac>0) write '-'
    { op: "local.get", index: L_NEG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, L_BUF, L_POS, C_MINUS),
    },
    // integer digits
    ...emitIntegerDigits(strDataTypeIdx, L_INT, L_BUF, L_POS, L_TMP, L_POW, L_DIGIT),
    // if fdig > 0: write '.' then fdig fractional digits
    { op: "local.get", index: L_FDIG },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...putConst(strDataTypeIdx, L_BUF, L_POS, C_DOT),
        // pow = scale/10 ; for k in 0..fdig: d=floor(frac/pow); write; frac-=d*pow; pow/=10
        { op: "local.get", index: L_SCALE },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "f64.floor" },
        { op: "local.set", index: L_POW },
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
                { op: "local.get", index: L_K },
                { op: "local.get", index: L_FDIG },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // d = floor(frac/pow)  (pow could be 0 on last? no, pow>=1 here)
                { op: "local.get", index: L_FRAC },
                { op: "local.get", index: L_POW },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_DIGIT },
                // write '0'+d
                { op: "local.get", index: L_BUF },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: C_ZERO },
                { op: "local.get", index: L_DIGIT },
                { op: "i32.trunc_f64_s" },
                { op: "i32.add" },
                { op: "array.set", typeIdx: strDataTypeIdx },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_POS },
                // frac -= d*pow
                { op: "local.get", index: L_FRAC },
                { op: "local.get", index: L_DIGIT },
                { op: "local.get", index: L_POW },
                { op: "f64.mul" },
                { op: "f64.sub" },
                { op: "local.set", index: L_FRAC },
                // pow /= 10
                { op: "local.get", index: L_POW },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_POW },
                { op: "local.get", index: L_K },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_K },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // finalize
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: finalizeIdx },
    { op: "return" },
  ];

  return {
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
      { name: "scale", type: f64 },
      { name: "scaled", type: f64 },
      { name: "intpart", type: f64 },
      { name: "fracpart", type: f64 },
      { name: "pow", type: f64 },
      { name: "digit", type: f64 },
      { name: "fdig", type: i32 },
      { name: "k", type: i32 },
    ],
    body,
  };
}

export function buildNumberFormatToExponentialBody(resources: {
  readonly types: NumberFormatStringTypes;
  readonly finalize: FuncHandle;
}): NativeNumberFormatBody {
  const strDataTypeIdx = resources.types.dataTypeIdx;
  const finalizeIdx = resources.finalize;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const bufType: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  // params 0 value 1 digits
  // locals: 2 buf 3 pos 4 tmp 5 neg 6 abs 7 exp(i32) 8 mant 9 scale
  //         10 scaled 11 pow 12 digit 13 fdig(i32) 14 k(i32) 15 noarg(i32) 16 lead(f64)
  const L_VALUE = 0;
  const L_DIGITS = 1;
  const L_BUF = 2;
  const L_POS = 3;
  const L_TMP = 4;
  const L_NEG = 5;
  const L_ABS = 6;
  const L_EXP = 7;
  const L_MANT = 8;
  const L_SCALE = 9;
  const L_SCALED = 10;
  const L_POW = 11;
  const L_DIGIT = 12;
  const L_FDIG = 13;
  const L_K = 14;
  const L_NOARG = 15;

  const body: Instr[] = [
    ...emitNonFinitePrologue(finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),
    // noarg = (digits != digits)   [NaN sentinel]
    { op: "local.get", index: L_DIGITS },
    { op: "local.get", index: L_DIGITS },
    { op: "f64.ne" },
    { op: "local.set", index: L_NOARG },
    // fdig = noarg ? 6 : (i32)digits
    { op: "local.get", index: L_NOARG },
    {
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [{ op: "i32.const", value: 6 }],
      else: [{ op: "local.get", index: L_DIGITS }, { op: "i32.trunc_f64_s" }],
    },
    { op: "local.set", index: L_FDIG },

    // sign
    { op: "local.get", index: L_NEG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, L_BUF, L_POS, C_MINUS),
    },

    // exp = 0; mant = abs
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_EXP },
    { op: "local.get", index: L_ABS },
    { op: "local.set", index: L_MANT },
    ...buildExponentialNormalization(L_MANT, L_EXP),
    // scale = 10^fdig
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_SCALE },
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
            { op: "local.get", index: L_K },
            { op: "local.get", index: L_FDIG },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_SCALE },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.set", index: L_SCALE },
            { op: "local.get", index: L_K },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_K },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // scaled = floor(mant*scale + 0.5)
    { op: "local.get", index: L_MANT },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.const", value: 0.5 },
    { op: "f64.add" },
    { op: "f64.floor" },
    { op: "local.set", index: L_SCALED },
    // rounding may push scaled to >= 10*scale → mant rounded to 10.xxx, bump exp
    // if scaled >= 10*scale: scaled/=10 (drop last digit by div+floor not needed:
    // instead divide scaled by 10 and exp++). We re-derive digits from scaled.
    { op: "local.get", index: L_SCALED },
    { op: "f64.const", value: 10 },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.ge" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_SCALED },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "f64.floor" },
        { op: "local.set", index: L_SCALED },
        { op: "local.get", index: L_EXP },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L_EXP },
      ],
    },
    // now scaled is an integer with (fdig+1) decimal digits (leading digit + fdig).
    // Write leading digit = floor(scaled/scale)
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "i32.const", value: C_ZERO },
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_SCALE },
    { op: "f64.div" },
    { op: "f64.floor" },
    { op: "i32.trunc_f64_s" },
    { op: "i32.add" },
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: L_POS },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: L_POS },
    // remainder = scaled - lead*scale  → reuse L_MANT as fractional remainder
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_SCALED },
    { op: "local.get", index: L_SCALE },
    { op: "f64.div" },
    { op: "f64.floor" },
    { op: "local.get", index: L_SCALE },
    { op: "f64.mul" },
    { op: "f64.sub" },
    { op: "local.set", index: L_MANT },
    // if fdig>0: write '.' and fdig digits from remainder with pow=scale/10
    { op: "local.get", index: L_FDIG },
    { op: "i32.const", value: 0 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...putConst(strDataTypeIdx, L_BUF, L_POS, C_DOT),
        { op: "local.get", index: L_SCALE },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "f64.floor" },
        { op: "local.set", index: L_POW },
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
                { op: "local.get", index: L_K },
                { op: "local.get", index: L_FDIG },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_MANT },
                { op: "local.get", index: L_POW },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_DIGIT },
                { op: "local.get", index: L_BUF },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: C_ZERO },
                { op: "local.get", index: L_DIGIT },
                { op: "i32.trunc_f64_s" },
                { op: "i32.add" },
                { op: "array.set", typeIdx: strDataTypeIdx },
                { op: "local.get", index: L_POS },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_POS },
                { op: "local.get", index: L_MANT },
                { op: "local.get", index: L_DIGIT },
                { op: "local.get", index: L_POW },
                { op: "f64.mul" },
                { op: "f64.sub" },
                { op: "local.set", index: L_MANT },
                { op: "local.get", index: L_POW },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "f64.floor" },
                { op: "local.set", index: L_POW },
                { op: "local.get", index: L_K },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_K },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // write 'e'
    ...putConst(strDataTypeIdx, L_BUF, L_POS, C_LC_E),
    // sign of exponent: '+' if exp>=0 else '-'
    { op: "local.get", index: L_EXP },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: putConst(strDataTypeIdx, L_BUF, L_POS, C_PLUS),
      else: [
        ...putConst(strDataTypeIdx, L_BUF, L_POS, C_MINUS),
        // exp = -exp
        { op: "i32.const", value: 0 },
        { op: "local.get", index: L_EXP },
        { op: "i32.sub" },
        { op: "local.set", index: L_EXP },
      ],
    },
    // write exponent magnitude as integer digits via emitIntegerDigits on f64
    { op: "local.get", index: L_EXP },
    { op: "f64.convert_i32_s" },
    { op: "local.set", index: L_MANT },
    ...emitIntegerDigits(strDataTypeIdx, L_MANT, L_BUF, L_POS, L_TMP, L_POW, L_DIGIT),
    // finalize
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: finalizeIdx },
    { op: "return" },
  ];

  return {
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
      { name: "exp", type: i32 },
      { name: "mant", type: f64 },
      { name: "scale", type: f64 },
      { name: "scaled", type: f64 },
      { name: "pow", type: f64 },
      { name: "digit", type: f64 },
      { name: "fdig", type: i32 },
      { name: "k", type: i32 },
      { name: "noarg", type: i32 },
    ],
    body,
  };
}

export function buildNumberFormatToPrecisionBody(resources: {
  readonly types: NumberFormatStringTypes;
  readonly finalize: FuncHandle;
  readonly toFixed?: FuncHandle;
  readonly toExponential?: FuncHandle;
  readonly toString?: FuncHandle;
}): NativeNumberFormatBody {
  const strDataTypeIdx = resources.types.dataTypeIdx;
  const finalizeIdx = resources.finalize;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const bufType: ValType = { kind: "ref", typeIdx: strDataTypeIdx };
  // We reduce toPrecision to: compute decimal exponent e of value, then
  // significant digits = precision. If -6 <= e < precision, render fixed with
  // (precision-1-e) fractional digits. Else render exponential with
  // (precision-1) fractional digits. We delegate the actual rendering to the
  // already-emitted number_toFixed / number_toExponential helpers.
  const toFixedIdx = resources.toFixed;
  const toExpIdx = resources.toExponential;
  const numToStringIdx = resources.toString;

  // params 0 value 1 precision
  // locals: 2 buf 3 pos 4 tmp 5 neg 6 abs 7 e(i32) 8 m(f64) 9 prec(i32)
  //         10 noarg(i32) 11 fdig(i32)
  const L_VALUE = 0;
  const L_PRECISION = 1;
  const L_BUF = 2;
  const L_POS = 3;
  const L_TMP = 4;
  const L_NEG = 5;
  const L_ABS = 6;
  const L_E = 7;
  const L_M = 8;
  const L_PREC = 9;
  const L_NOARG = 10;
  const L_FDIG = 11;
  const L_RSCALE = 12;
  const L_RK = 13;

  const body: Instr[] = [
    ...emitNonFinitePrologue(finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),
    // noarg = precision != precision
    { op: "local.get", index: L_PRECISION },
    { op: "local.get", index: L_PRECISION },
    { op: "f64.ne" },
    { op: "local.set", index: L_NOARG },
    // §21.1.3.5 step 2 — an absent precision is `! ToString(x)`, full stop.
    // This used to delegate to `toExponential(value, NaN)` as an approximation,
    // which rendered `(123.456).toPrecision()` as "1.23456e+2". Number::toString
    // is the operation the spec names, and it is the SAME helper the reflective
    // `Number.prototype.toPrecision` body (#5269 J-1) calls for this case, so the
    // two spellings of the no-arg call cannot drift apart.
    { op: "local.get", index: L_NOARG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then:
        numToStringIdx !== undefined
          ? [{ op: "local.get", index: L_VALUE }, { op: "call", funcIdx: numToStringIdx }, { op: "return" }]
          : [
              // Unreachable in practice: `emitNativeNumberFormat` emits
              // `number_toString` before this helper whenever toPrecision is
              // requested. Kept so a future caller that skips it still gets a
              // renderable answer instead of a bad funcIdx.
              { op: "local.get", index: L_VALUE },
              { op: "f64.const", value: NaN },
              { op: "call", funcIdx: toExpIdx! },
              { op: "return" },
            ],
    },
    // prec = (i32)precision
    { op: "local.get", index: L_PRECISION },
    { op: "i32.trunc_f64_s" },
    { op: "local.set", index: L_PREC },
    // if value == 0: render fixed with (prec-1) frac digits
    { op: "local.get", index: L_ABS },
    { op: "f64.const", value: 0 },
    { op: "f64.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_VALUE },
        { op: "local.get", index: L_PREC },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: toFixedIdx! },
        { op: "return" },
      ],
    },
    // e = floor(log10(abs)) computed by a normalize loop (no Math.log import)
    // m = abs; e = 0; while m>=10 {m/=10;e++}; while m<1 {m*=10;e--}
    { op: "local.get", index: L_ABS },
    { op: "local.set", index: L_M },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_E },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_M },
            { op: "f64.const", value: 10 },
            { op: "f64.lt" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_M },
            { op: "f64.const", value: 10 },
            { op: "f64.div" },
            { op: "local.set", index: L_M },
            { op: "local.get", index: L_E },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_E },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_M },
            { op: "f64.const", value: 1 },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_M },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.set", index: L_M },
            { op: "local.get", index: L_E },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "local.set", index: L_E },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // Rounding can bump the magnitude (e.g. 9.999 with prec=3 → "10.0"), which
    // increments the decimal exponent. Round m (in [1,10)) to (prec-1)
    // fractional digits; if the rounded mantissa reaches 10, divide by 10 and
    // e++. This corrects the fixed/exp decision and digit count below.
    // rscale = 10^(prec-1)
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_RSCALE },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_RK },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_RK },
            { op: "local.get", index: L_PREC },
            { op: "i32.const", value: 1 },
            { op: "i32.sub" },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_RSCALE },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.set", index: L_RSCALE },
            { op: "local.get", index: L_RK },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_RK },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // m = floor(m*rscale + 0.5) / rscale
    { op: "local.get", index: L_M },
    { op: "local.get", index: L_RSCALE },
    { op: "f64.mul" },
    { op: "f64.const", value: 0.5 },
    { op: "f64.add" },
    { op: "f64.floor" },
    { op: "local.get", index: L_RSCALE },
    { op: "f64.div" },
    { op: "local.set", index: L_M },
    // if m >= 10: m/=10; e++
    { op: "local.get", index: L_M },
    { op: "f64.const", value: 10 },
    { op: "f64.ge" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_M },
        { op: "f64.const", value: 10 },
        { op: "f64.div" },
        { op: "local.set", index: L_M },
        { op: "local.get", index: L_E },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: L_E },
      ],
    },
    // if (e < -6 || e >= prec): exponential with (prec-1) frac digits
    {
      op: "local.get",
      index: L_E,
    },
    { op: "i32.const", value: -6 },
    { op: "i32.lt_s" },
    { op: "local.get", index: L_E },
    { op: "local.get", index: L_PREC },
    { op: "i32.ge_s" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_VALUE },
        { op: "local.get", index: L_PREC },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: toExpIdx! },
        { op: "return" },
      ],
      else: [
        // fixed with fdig = prec - 1 - e fractional digits
        { op: "local.get", index: L_PREC },
        { op: "i32.const", value: 1 },
        { op: "i32.sub" },
        { op: "local.get", index: L_E },
        { op: "i32.sub" },
        { op: "local.set", index: L_FDIG },
        { op: "local.get", index: L_VALUE },
        { op: "local.get", index: L_FDIG },
        { op: "f64.convert_i32_s" },
        { op: "call", funcIdx: toFixedIdx! },
        { op: "return" },
      ],
    },
    // unreachable fallthrough — finalize empty buffer
    { op: "local.get", index: L_BUF },
    { op: "local.get", index: L_POS },
    { op: "call", funcIdx: finalizeIdx },
    { op: "return" },
  ];

  return {
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
      { name: "e", type: i32 },
      { name: "m", type: f64 },
      { name: "prec", type: i32 },
      { name: "noarg", type: i32 },
      { name: "fdig", type: i32 },
      { name: "rscale", type: f64 },
      { name: "rk", type: i32 },
    ],
    body,
  };
}

function buildExponentialNormalization(L_MANT: number, L_EXP: number): Instr[] {
  return [
    // if mant != 0: normalize to [1,10)
    { op: "local.get", index: L_MANT },
    { op: "f64.const", value: 0 },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // while mant >= 10: mant/=10; exp++
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_MANT },
                { op: "f64.const", value: 10 },
                { op: "f64.lt" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_MANT },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "local.set", index: L_MANT },
                { op: "local.get", index: L_EXP },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_EXP },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        // while mant < 1: mant*=10; exp--
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_MANT },
                { op: "f64.const", value: 1 },
                { op: "f64.ge" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_MANT },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.set", index: L_MANT },
                { op: "local.get", index: L_EXP },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "local.set", index: L_EXP },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];
}

export function buildNumberFormatNativeAdapterBody(resources: {
  readonly toString: FuncHandle;
  readonly anyStringTypeIdx: number;
}): NativeNumberFormatBody {
  return {
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: resources.toString },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: resources.anyStringTypeIdx },
    ],
  };
}
