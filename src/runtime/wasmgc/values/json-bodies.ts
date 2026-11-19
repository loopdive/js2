// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#7350 B2c-2) Native JSON primitive bodies for standalone / WASI targets
 * (#1599 Phase 2), shared by the codegen registration
 * (`src/codegen/json-runtime.ts`) and, later, the realm's `JSON` object. Pure:
 * each builder reads only its bindings.
 *
 * - `__json_quote_string(s: externref) -> ref $NativeString` — ECMA-262
 *   §25.5.4.3 `QuoteJSONString` over the flattened UTF-16 code units of a
 *   runtime string:
 *   - wrap in `"`…`"`
 *   - escape `"`  → `\"`
 *   - escape `\`  → `\\`
 *   - escape `\b` (U+0008), `\t` (U+0009), `\n` (U+000A), `\f` (U+000C),
 *     `\r` (U+000D) with their short forms
 *   - escape every other control char U+0000–U+001F as `\u00XX`
 *   - escape a **lone** UTF-16 surrogate (unpaired U+D800–U+DFFF) as `\uXXXX`
 *     (well-formed JSON.stringify, ES2019 §25.5.4.3); copy the two code units
 *     of a valid high+low pair through verbatim
 *   - copy all other code units verbatim
 * - `__json_parse_primitive(s: externref) -> ref $AnyValue` — §25.5.2
 *   `JSON.parse` of a runtime string holding one JSON primitive (ECMA-404):
 *   - `"null"`             → tag 0 (null)
 *   - `"true"` / `"false"` → tag 4 (boolean), i32val 1 / 0
 *   - JSON number          → tag 3 (f64), f64val = parsed value
 *   - anything else        → `unreachable` (Wasm trap; matches a SyntaxError
 *                             throw under the standalone no-host contract)
 */
import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import { counterLoopInstrs } from "./emit-idioms.js";

/** Module resources both bodies read. */
export interface JsonBodyBindings {
  /** `$AnyString`, which the argument is cast to before flattening. */
  readonly anyStrTypeIdx: number;
  /** `$NativeString` (FlatString): len, off, data. */
  readonly nativeStrTypeIdx: number;
  /** `$__str_data`, (array (mut i16)). */
  readonly nativeStrDataTypeIdx: number;
  /** `__str_flatten`. */
  readonly flattenHandle: number;
}

export interface JsonParsePrimitiveBindings extends JsonBodyBindings {
  readonly anyValueTypeIdx: number;
}

/** Locals in the run-length form the encoder groups; these bodies carry no local names. */
export interface JsonBodyDefinition {
  readonly locals: { count: number; type: ValType }[];
  readonly body: Instr[];
}

const C_QUOTE = 34; // '"'
const C_BACKSLASH = 92; // '\'
const C_BS = 8; // backspace  -> \b
const C_TAB = 9; // tab        -> \t
const C_LF = 10; // line feed  -> \n
const C_FF = 12; // form feed  -> \f
const C_CR = 13; // carriage   -> \r
const C_LC_B = 98; // 'b'
const C_LC_T = 116; // 't'
const C_LC_N = 110; // 'n'
const C_LC_F = 102; // 'f'
const C_LC_R = 114; // 'r'
const C_LC_U = 117; // 'u'
const C_ZERO = 48; // '0'
const C_LC_A_MINUS_10 = 87; // 'a' - 10  (for hex digit a-f)
// UTF-16 surrogate ranges (well-formed JSON.stringify, ES2019 §25.5.4.3):
// a lone surrogate code unit must be escaped as \uXXXX; a valid high+low pair
// is copied through verbatim (the astral code point).
const SURR_HIGH_LO = 0xd800; // high (leading) surrogate range 0xD800..0xDBFF
const SURR_HIGH_HI = 0xdbff;
const SURR_LOW_LO = 0xdc00; // low (trailing) surrogate range 0xDC00..0xDFFF
const SURR_LOW_HI = 0xdfff;

const I32: ValType = { kind: "i32" };

// Local index layout. Both bodies (param 0 = s:externref) open with the same
// five locals:  1 flat  2 data  3 end  4 i  5 c
const L_FLAT = 1;
const L_DATA = 2;
const L_END = 3;
const L_I = 4;
const L_C = 5;
// __json_quote_string, shared by the sizing and fill passes:
//  6 outLen  7 out  8 w  9 off  10 nib  11 nb
const L_OUTLEN = 6;
const L_OUT = 7;
const L_W = 8;
const L_OFF = 9;
const L_NIB = 10;
const L_NB = 11;

// c = data[i]
function readCodeUnit(d: number): Instr[] {
  return [
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: d },
    { op: "local.set", index: L_C },
  ];
}

// c == code  (leaves i32 bool)
function cEq(code: number): Instr[] {
  return [{ op: "local.get", index: L_C }, { op: "i32.const", value: code }, { op: "i32.eq" }];
}

/**
 * flat = flatten(s); data = flat.data; `offLocal` = flat.off; end = off + len
 * (exclusive). The quote body keeps the offset in its own local, the parser
 * starts its cursor there.
 */
function flatStringPreamble(b: JsonBodyBindings, offLocal: number): Instr[] {
  const strTypeIdx = b.nativeStrTypeIdx;
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: b.anyStrTypeIdx },
    { op: "call", funcIdx: b.flattenHandle },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "local.set", index: L_FLAT },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
    { op: "local.set", index: L_DATA },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
    { op: "local.set", index: offLocal },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
    { op: "local.get", index: offLocal },
    { op: "i32.add" },
    { op: "local.set", index: L_END }, // end = off + len (exclusive)
  ];
}

/**
 * The `__json_quote_string` pieces the definition assembles, kept apart so no
 * function exceeds the per-function LOC ceiling (#3400). `d` is the
 * `$__str_data` (array (mut i16)) type index; the smaller helpers stay closed
 * over `d` internally.
 */
function qQuoteBuilders(d: number): {
  putConst: (v: number) => Instr[];
  widthExpr: Instr[];
  fillCharDispatch: Instr[];
} {
  // append code unit (value pushed by `valueInstrs`) into out[w]; w++
  const put = (valueInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: L_OUT },
    { op: "local.get", index: L_W },
    ...valueInstrs,
    { op: "array.set", typeIdx: d },
    { op: "local.get", index: L_W },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: L_W },
  ];
  const putConst = (v: number): Instr[] => put([{ op: "i32.const", value: v }]);

  // (local at `idx`) is in the inclusive unsigned range [lo, hi]  (leaves i32)
  const localInRange = (idx: number, lo: number, hi: number): Instr[] => [
    { op: "local.get", index: idx },
    { op: "i32.const", value: lo },
    { op: "i32.ge_u" },
    { op: "local.get", index: idx },
    { op: "i32.const", value: hi },
    { op: "i32.le_u" },
    { op: "i32.and" },
  ];

  // Well-formed JSON.stringify (ES2019 §25.5.4.3, feature well-formed-json-
  // stringify): a code unit at data[i] that is a LONE surrogate must be escaped
  // as \uXXXX; a code unit that is part of a valid high+low pair is copied
  // verbatim. This predicate leaves i32 (1 = c is a lone surrogate → escape).
  //
  // Adjacency is unambiguous: a high surrogate pairs forward with the
  // immediately-following low; a low pairs backward with the immediately-
  // preceding high. Both passes (sizing + fill) iterate the same indices with
  // the same bounds, so they compute identical decisions. Uses L_NB scratch.
  const escapeSurr: Instr[] = [
    ...localInRange(L_C, SURR_HIGH_LO, SURR_HIGH_HI), // c is a high surrogate?
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      // High: escape unless the NEXT unit (i+1 < end) is a low surrogate.
      then: [
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.get", index: L_END },
        { op: "i32.lt_u" },
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: [
            { op: "local.get", index: L_DATA },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "array.get_u", typeIdx: d },
            { op: "local.set", index: L_NB },
            ...localInRange(L_NB, SURR_LOW_LO, SURR_LOW_HI),
          ],
          else: [{ op: "i32.const", value: 0 }], // no next unit → lone high
        },
        { op: "i32.eqz" }, // escape = !nextIsLow
      ],
      else: [
        ...localInRange(L_C, SURR_LOW_LO, SURR_LOW_HI), // c is a low surrogate?
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          // Low: escape unless the PREV unit (i > off) is a high surrogate.
          then: [
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_OFF },
            { op: "i32.gt_u" },
            {
              op: "if",
              blockType: { kind: "val", type: I32 },
              then: [
                { op: "local.get", index: L_DATA },
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.sub" },
                { op: "array.get_u", typeIdx: d },
                { op: "local.set", index: L_NB },
                ...localInRange(L_NB, SURR_HIGH_LO, SURR_HIGH_HI),
              ],
              else: [{ op: "i32.const", value: 0 }], // no prev unit → lone low
            },
            { op: "i32.eqz" }, // escape = !prevIsHigh
          ],
          else: [{ op: "i32.const", value: 0 }], // not a surrogate → not escaped
        },
      ],
    },
  ];

  // width(c): '"','\',\b\t\n\f\r -> 2 ; ctrl (<0x20) or lone surrogate -> 6 ;
  // else 1 (verbatim, incl. code units of a valid surrogate pair)
  const widthExpr: Instr[] = [
    ...cEq(C_QUOTE),
    ...cEq(C_BACKSLASH),
    { op: "i32.or" },
    ...cEq(C_BS),
    { op: "i32.or" },
    ...cEq(C_TAB),
    { op: "i32.or" },
    ...cEq(C_LF),
    { op: "i32.or" },
    ...cEq(C_FF),
    { op: "i32.or" },
    ...cEq(C_CR),
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: I32 },
      then: [{ op: "i32.const", value: 2 }],
      else: [
        { op: "local.get", index: L_C },
        { op: "i32.const", value: 0x20 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "val", type: I32 },
          then: [{ op: "i32.const", value: 6 }],
          else: [
            ...escapeSurr,
            {
              op: "if",
              blockType: { kind: "val", type: I32 },
              then: [{ op: "i32.const", value: 6 }],
              else: [{ op: "i32.const", value: 1 }],
            },
          ],
        },
      ],
    },
  ];

  // short escape: backslash + letter
  const emitShort = (letter: number): Instr[] => [...putConst(C_BACKSLASH), ...putConst(letter)];

  // Emit one hex digit for nibble `(c >> shift) & 0xf`, mapped '0'-'9'/'a'-'f'.
  const emitHexNibble = (shift: number): Instr[] =>
    put([
      { op: "local.get", index: L_C },
      ...(shift > 0 ? [{ op: "i32.const", value: shift } as Instr, { op: "i32.shr_u" } as Instr] : []),
      { op: "i32.const", value: 0xf },
      { op: "i32.and" },
      { op: "local.tee", index: L_NIB },
      { op: "i32.const", value: 10 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: I32 },
        then: [{ op: "local.get", index: L_NIB }, { op: "i32.const", value: C_ZERO }, { op: "i32.add" }],
        else: [{ op: "local.get", index: L_NIB }, { op: "i32.const", value: C_LC_A_MINUS_10 }, { op: "i32.add" }],
      },
    ]);

  // \uXXXX for control chars (U+0000–U+001F) and lone surrogates. All four hex
  // nibbles are emitted with the full 0-9/a-f mapping — for control chars the
  // top two nibbles are 0, reproducing the prior `\u00XX`; for surrogates the
  // top nibble is `d`, giving e.g. `\ud834`.
  const emitUnicode: Instr[] = [
    ...putConst(C_BACKSLASH),
    ...putConst(C_LC_U),
    ...emitHexNibble(12),
    ...emitHexNibble(8),
    ...emitHexNibble(4),
    ...emitHexNibble(0),
  ];

  // copy verbatim
  const emitVerbatim: Instr[] = put([{ op: "local.get", index: L_C }]);

  // per-char dispatch (nested if/else chain on c)
  const fillCharDispatch: Instr[] = [
    ...cEq(C_QUOTE),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: emitShort(C_QUOTE),
      else: [
        ...cEq(C_BACKSLASH),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: emitShort(C_BACKSLASH),
          else: [
            ...cEq(C_BS),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: emitShort(C_LC_B),
              else: [
                ...cEq(C_TAB),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: emitShort(C_LC_T),
                  else: [
                    ...cEq(C_LF),
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: emitShort(C_LC_N),
                      else: [
                        ...cEq(C_FF),
                        {
                          op: "if",
                          blockType: { kind: "empty" },
                          then: emitShort(C_LC_F),
                          else: [
                            ...cEq(C_CR),
                            {
                              op: "if",
                              blockType: { kind: "empty" },
                              then: emitShort(C_LC_R),
                              else: [
                                { op: "local.get", index: L_C },
                                { op: "i32.const", value: 0x20 },
                                { op: "i32.lt_s" },
                                {
                                  op: "if",
                                  blockType: { kind: "empty" },
                                  then: emitUnicode,
                                  // Not a control char: a lone surrogate is
                                  // escaped \uXXXX; everything else (incl. the
                                  // units of a valid pair) is copied verbatim.
                                  else: [
                                    ...escapeSurr,
                                    {
                                      op: "if",
                                      blockType: { kind: "empty" },
                                      then: emitUnicode,
                                      else: emitVerbatim,
                                    },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  return { putConst, widthExpr, fillCharDispatch };
}
/**
 * `__json_quote_string`: walk the flat string's `[off, off+len)` code units
 * twice — first to size the output buffer, then to fill it — so the output
 * `$__str_data` is allocated exactly once at the right capacity.
 */
export function buildJsonQuoteStringDefinition(b: JsonBodyBindings): JsonBodyDefinition {
  const strTypeIdx = b.nativeStrTypeIdx;
  const strDataTypeIdx = b.nativeStrDataTypeIdx;
  const getC = readCodeUnit(strDataTypeIdx);
  const { putConst, widthExpr, fillCharDispatch } = qQuoteBuilders(strDataTypeIdx);

  // Pass 1: outLen = 2 + Σ width(c)
  const sizingLoop: Instr[] = [
    { op: "i32.const", value: 2 },
    { op: "local.set", index: L_OUTLEN },
    { op: "local.get", index: L_OFF },
    { op: "local.set", index: L_I },
    ...counterLoopInstrs({
      i: L_I,
      bound: [{ op: "local.get", index: L_END }],
      body: [
        ...getC,
        { op: "local.get", index: L_OUTLEN },
        ...widthExpr,
        { op: "i32.add" },
        { op: "local.set", index: L_OUTLEN },
      ],
    }),
  ];

  // Allocate out buffer (outLen), w=0, write opening quote.
  const allocOut: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_OUTLEN },
    { op: "array.new", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_OUT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_W },
    ...putConst(C_QUOTE),
  ];

  // Pass 2: fill
  const fillLoop: Instr[] = [
    { op: "local.get", index: L_OFF },
    { op: "local.set", index: L_I },
    ...counterLoopInstrs({
      i: L_I,
      bound: [{ op: "local.get", index: L_END }],
      body: [...getC, ...fillCharDispatch],
    }),
    ...putConst(C_QUOTE), // closing quote
  ];

  // Build result $NativeString(len=outLen, off=0, data=out).
  const finalize: Instr[] = [
    { op: "local.get", index: L_OUTLEN },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_OUT },
    { op: "struct.new", typeIdx: strTypeIdx },
  ];

  return {
    locals: [
      { count: 1, type: { kind: "ref", typeIdx: strTypeIdx } }, // L_FLAT
      { count: 1, type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_DATA
      { count: 1, type: I32 }, // L_END
      { count: 1, type: I32 }, // L_I
      { count: 1, type: I32 }, // L_C
      { count: 1, type: I32 }, // L_OUTLEN
      { count: 1, type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_OUT
      { count: 1, type: I32 }, // L_W
      { count: 1, type: I32 }, // L_OFF
      { count: 1, type: I32 }, // L_NIB
      { count: 1, type: I32 }, // L_NB
    ],
    body: [...flatStringPreamble(b, L_OFF), ...sizingLoop, ...allocOut, ...fillLoop, ...finalize],
  };
}

// __json_parse_primitive, after the shared five:
//  6 sign:f64  7 mant:f64  8 frac:f64 (the parsed number)  9 expSign:i32
// 10 exp:i32 (net base-10 exponent)  11 expMag:i32
const P_SIGN = 6;
const P_MANT = 7;
const P_FRAC = 8;
const P_EXPSIGN = 9;
const P_EXP = 10;
const P_EXPMAG = 11;

const F64: ValType = { kind: "f64" };

// eq abstract heap type, signed-LEB128 → 0x6d. Used for the AnyValue $refval
// null payload (matches ensureAnyHelpers in any-helpers.ts).
const EQ_HEAP_TYPE = -19;

// i = i + 1
const advance = (): Instr[] => [
  { op: "local.get", index: L_I },
  { op: "i32.const", value: 1 },
  { op: "i32.add" },
  { op: "local.set", index: L_I },
];

// i < end  (leaves i32 bool)
const inBounds = (): Instr[] => [
  { op: "local.get", index: L_I },
  { op: "local.get", index: L_END },
  { op: "i32.lt_s" },
];

// c = data[i]; leave the enclosing digit loop unless '0' <= c <= '9'
function digitOrExit(d: number): Instr[] {
  return [
    ...readCodeUnit(d),
    { op: "local.get", index: L_C },
    { op: "i32.const", value: 48 },
    { op: "i32.lt_s" },
    { op: "br_if", depth: 1 },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: 57 },
    { op: "i32.gt_s" },
    { op: "br_if", depth: 1 },
  ];
}

// while i<end && '0'<=c<='9' { body; i++ }
function digitLoop(d: number, body: Instr[]): Instr[] {
  return counterLoopInstrs({ i: L_I, bound: [{ op: "local.get", index: L_END }], body: [...digitOrExit(d), ...body] });
}

// mant = mant*10 + (c-'0')
const accumulateMantissa = (): Instr[] => [
  { op: "local.get", index: P_MANT },
  { op: "f64.const", value: 10 },
  { op: "f64.mul" },
  { op: "local.get", index: L_C },
  { op: "i32.const", value: 48 },
  { op: "i32.sub" },
  { op: "f64.convert_i32_s" },
  { op: "f64.add" },
  { op: "local.set", index: P_MANT },
];

// A boxed `$AnyValue` (pushes a ref $AnyValue) with null ref / extern payloads.
function boxAnyValue(
  anyTypeIdx: number,
  tag: number,
  i32val: number,
  f64val: Instr = { op: "f64.const", value: 0 },
): Instr[] {
  return [
    { op: "i32.const", value: tag },
    { op: "i32.const", value: i32val },
    f64val,
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ];
}

// skip whitespace: while i<end && (c==' '|'\t'|'\n'|'\r') i++; then c = the
// first non-ws char. If i>=end the input is empty → trap.
function skipJsonWhitespace(d: number): Instr[] {
  return [
    ...counterLoopInstrs({
      i: L_I,
      bound: [{ op: "local.get", index: L_END }],
      body: [
        ...readCodeUnit(d),
        // ws = c==32 | c==9 | c==10 | c==13
        ...cEq(32),
        ...cEq(9),
        { op: "i32.or" },
        ...cEq(10),
        { op: "i32.or" },
        ...cEq(13),
        { op: "i32.or" },
        { op: "i32.eqz" },
        { op: "br_if", depth: 1 }, // non-ws → stop
      ],
    }),
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
    ...readCodeUnit(d),
  ];
}

// sign? int frac?  Reads from cursor i (positioned at the first digit or '-').
// Accumulates the mantissa as f64 (sufficient precision for the primitive
// slice); each fraction digit lowers the exponent by one.
function jsonNumberMantissa(d: number): Instr[] {
  return [
    { op: "f64.const", value: 1 },
    { op: "local.set", index: P_SIGN },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: P_MANT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: P_EXP },
    // optional '-'
    ...cEq(45),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: -1 }, { op: "local.set", index: P_SIGN }, ...advance()],
    },
    ...digitLoop(d, accumulateMantissa()),
    // fraction: if c=='.' { i++; while digit { mant=mant*10+d; exp--; i++ } }
    ...inBounds(),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...readCodeUnit(d),
        ...cEq(46), // '.'
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...advance(),
            ...digitLoop(d, [
              ...accumulateMantissa(),
              { op: "local.get", index: P_EXP },
              { op: "i32.const", value: 1 },
              { op: "i32.sub" },
              { op: "local.set", index: P_EXP },
            ]),
          ],
        },
      ],
    },
  ];
}

// exponent: if c=='e'|'E' { i++; optional sign; exp += expSign * digits }
function jsonNumberExponent(d: number): Instr[] {
  return [
    ...inBounds(),
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...readCodeUnit(d),
        ...cEq(101), // 'e'
        ...cEq(69), // 'E'
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...advance(), // consume 'e'/'E'
            { op: "i32.const", value: 1 },
            { op: "local.set", index: P_EXPSIGN },
            // optional exponent sign
            ...inBounds(),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...readCodeUnit(d),
                ...cEq(45), // '-'
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "i32.const", value: -1 }, { op: "local.set", index: P_EXPSIGN }, ...advance()],
                  else: [
                    ...cEq(43), // '+'
                    { op: "if", blockType: { kind: "empty" }, then: advance() },
                  ],
                },
              ],
            },
            // explicit exponent digits: expMag = Σ digits; exp += expSign*expMag
            { op: "i32.const", value: 0 },
            { op: "local.set", index: P_EXPMAG },
            ...digitLoop(d, [
              { op: "local.get", index: P_EXPMAG },
              { op: "i32.const", value: 10 },
              { op: "i32.mul" },
              { op: "local.get", index: L_C },
              { op: "i32.const", value: 48 },
              { op: "i32.sub" },
              { op: "i32.add" },
              { op: "local.set", index: P_EXPMAG },
            ]),
            { op: "local.get", index: P_EXP },
            { op: "local.get", index: P_EXPSIGN },
            { op: "local.get", index: P_EXPMAG },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "local.set", index: P_EXP },
          ],
        },
      ],
    },
  ];
}

// while exp != 0 { pow = pow (op) 10; exp += step }
function scaleByTenLoop(op: "f64.mul" | "f64.div", step: "i32.sub" | "i32.add"): Instr {
  return {
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          { op: "local.get", index: P_EXP },
          { op: "i32.eqz" },
          { op: "br_if", depth: 1 },
          { op: "local.get", index: P_FRAC },
          { op: "f64.const", value: 10 },
          { op },
          { op: "local.set", index: P_FRAC },
          { op: "local.get", index: P_EXP },
          { op: "i32.const", value: 1 },
          { op: step },
          { op: "local.set", index: P_EXP },
          { op: "br", depth: 0 },
        ],
      },
    ],
  };
}

// frac = sign * mant * 10^exp, with 10^exp by repeated multiply / divide
// (exp is small for the primitive slice; the loop runs |exp| times).
const jsonNumberScale = (): Instr[] => [
  { op: "f64.const", value: 1 },
  { op: "local.set", index: P_FRAC }, // pow = 1
  { op: "local.get", index: P_EXP },
  { op: "i32.const", value: 0 },
  { op: "i32.ge_s" },
  {
    op: "if",
    blockType: { kind: "empty" },
    then: [scaleByTenLoop("f64.mul", "i32.sub")],
    else: [scaleByTenLoop("f64.div", "i32.add")],
  },
  { op: "local.get", index: P_SIGN },
  { op: "local.get", index: P_MANT },
  { op: "f64.mul" },
  { op: "local.get", index: P_FRAC },
  { op: "f64.mul" },
  { op: "local.set", index: P_FRAC },
];

/**
 * `__json_parse_primitive`: flatten, skip leading whitespace, then switch on the
 * first character — `n` / `t` / `f` box the literal, `-` or a digit parses a
 * number into `frac`, anything else traps.
 */
export function buildJsonParsePrimitiveDefinition(b: JsonParsePrimitiveBindings): JsonBodyDefinition {
  const d = b.nativeStrDataTypeIdx;
  const anyTypeIdx = b.anyValueTypeIdx;
  const anyRef: ValType = { kind: "ref", typeIdx: anyTypeIdx };
  const parseNumber: Instr[] = [...jsonNumberMantissa(d), ...jsonNumberExponent(d), ...jsonNumberScale()];
  const isNumberStart: Instr[] = [
    ...cEq(45),
    { op: "local.get", index: L_C },
    { op: "i32.const", value: 48 },
    { op: "i32.ge_s" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: 57 },
    { op: "i32.le_s" },
    { op: "i32.and" },
    { op: "i32.or" },
  ];
  const dispatch: Instr[] = [
    ...cEq(110), // 'n' → null
    {
      op: "if",
      blockType: { kind: "val", type: anyRef },
      then: boxAnyValue(anyTypeIdx, 0, 0),
      else: [
        ...cEq(116), // 't' → true
        {
          op: "if",
          blockType: { kind: "val", type: anyRef },
          then: boxAnyValue(anyTypeIdx, 4, 1),
          else: [
            ...cEq(102), // 'f' → false
            {
              op: "if",
              blockType: { kind: "val", type: anyRef },
              then: boxAnyValue(anyTypeIdx, 4, 0),
              else: [
                ...isNumberStart,
                {
                  op: "if",
                  blockType: { kind: "val", type: anyRef },
                  then: [...parseNumber, ...boxAnyValue(anyTypeIdx, 3, 0, { op: "local.get", index: P_FRAC })],
                  else: [{ op: "unreachable" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  return {
    locals: [
      { count: 1, type: { kind: "ref", typeIdx: b.nativeStrTypeIdx } }, // L_FLAT
      { count: 1, type: { kind: "ref", typeIdx: d } }, // L_DATA
      { count: 1, type: I32 }, // L_END
      { count: 1, type: I32 }, // L_I
      { count: 1, type: I32 }, // L_C
      { count: 1, type: F64 }, // P_SIGN
      { count: 1, type: F64 }, // P_MANT
      { count: 1, type: F64 }, // P_FRAC
      { count: 1, type: I32 }, // P_EXPSIGN
      { count: 1, type: I32 }, // P_EXP
      { count: 1, type: I32 }, // P_EXPMAG
    ],
    body: [...flatStringPreamble(b, L_I), ...skipJsonWhitespace(d), ...dispatch],
  };
}
