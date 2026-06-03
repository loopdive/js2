// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm runtime JSON helpers for standalone / WASI targets (#1599 Phase 2).
 *
 * Phase 2A (`json-standalone.ts`) folds *statically known* JSON literal graphs
 * at compile time. This module adds the first *runtime* (value-dependent) JSON
 * primitive that needs no JS host: `JSON.stringify(s)` of a **runtime string
 * value**. The serialiser scans the flattened UTF-16 code units of the input
 * `$AnyString` and emits a JSON-quoted `$NativeString` per ECMA-262 §25.5.4.3
 * `QuoteJSONString`:
 *
 *   - wrap in `"`…`"`
 *   - escape `"`  → `\"`
 *   - escape `\`  → `\\`
 *   - escape `\b` (U+0008), `\t` (U+0009), `\n` (U+000A), `\f` (U+000C),
 *     `\r` (U+000D) with their short forms
 *   - escape every other control char U+0000–U+001F as `\u00XX`
 *   - copy all other code units verbatim
 *
 * Result is returned as an `externref` (the WasmGC `$NativeString` widened via
 * `extern.convert_any`), matching how every other standalone string-producing
 * builtin returns its value.
 *
 * The remaining dynamic Phase 2 surface — `JSON.parse` of runtime text into
 * `$AnyValue` primitives, and `JSON.stringify` of runtime object/array graphs —
 * is documented as a follow-up in the #1599 issue file. Object/array graphs
 * need the Wasm-native open-object runtime (#1472 Phase B); string `JSON.parse`
 * needs the shared `$AnyValue` string-equals helper to fall back to native
 * `__str_equals` in standalone mode (cross-cutting runtime change).
 *
 * Spec references:
 * - ECMA-262 §25.5.4   `JSON.stringify`
 * - ECMA-262 §25.5.4.3 `QuoteJSONString`
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers, nativeStringType } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";

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

/**
 * Emit `__json_quote_string(s: externref) -> externref` and register it in
 * `ctx.funcMap`. Idempotent. Must run after `ensureNativeStringHelpers` (called
 * here) so `__str_flatten` exists, and before any function body that calls it.
 *
 * Algorithm: flatten the input to a `$NativeString`, walk its `[off, off+len)`
 * code units twice — first to size the output buffer, then to fill it — so the
 * output `$__str_data` is allocated exactly once at the right capacity.
 */
export function emitJsonQuoteString(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_quote_string");
  if (existing !== undefined) return existing;

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString (FlatString): len, off, data
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx; // (array (mut i16))
  const i32: ValType = { kind: "i32" };
  const extern: ValType = { kind: "externref" };

  const strRef = nativeStringType(ctx);
  const typeIdx = addFuncType(ctx, [extern], [strRef]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__json_quote_string", funcIdx);

  // params: 0 s:externref
  // locals:
  //  1 flat:ref $NativeString   2 data:ref $__str_data   3 end:i32   4 i:i32
  //  5 c:i32   6 outLen:i32   7 out:ref $__str_data   8 w:i32 (write cursor)
  //  9 off:i32  10 nib:i32 (scratch nibble)
  const L_FLAT = 1;
  const L_DATA = 2;
  const L_END = 3;
  const L_I = 4;
  const L_C = 5;
  const L_OUTLEN = 6;
  const L_OUT = 7;
  const L_W = 8;
  const L_OFF = 9;
  const L_NIB = 10;

  // c = data[i]
  const getC: Instr[] = [
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_C },
  ];

  // append code unit (value pushed by `valueInstrs`) into out[w]; w++
  const put = (valueInstrs: Instr[]): Instr[] => [
    { op: "local.get", index: L_OUT },
    { op: "local.get", index: L_W },
    ...valueInstrs,
    { op: "array.set", typeIdx: strDataTypeIdx },
    { op: "local.get", index: L_W },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: L_W },
  ];
  const putConst = (v: number): Instr[] => put([{ op: "i32.const", value: v }]);

  // c == code  (leaves i32 bool)
  const cEq = (code: number): Instr[] => [
    { op: "local.get", index: L_C },
    { op: "i32.const", value: code },
    { op: "i32.eq" },
  ];

  // Shared preamble: flatten s, load data/off, compute end = off + len.
  const preamble: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "local.set", index: L_FLAT },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 }, // data
    { op: "local.set", index: L_DATA },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 }, // off
    { op: "local.set", index: L_OFF },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
    { op: "local.get", index: L_OFF },
    { op: "i32.add" },
    { op: "local.set", index: L_END }, // end = off + len (exclusive)
  ];

  // width(c): '"','\',\b\t\n\f\r -> 2 ; other ctrl (<0x20) -> 6 ; else 1
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
      blockType: { kind: "val", type: i32 },
      then: [{ op: "i32.const", value: 2 }],
      else: [
        { op: "local.get", index: L_C },
        { op: "i32.const", value: 0x20 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [{ op: "i32.const", value: 6 }],
          else: [{ op: "i32.const", value: 1 }],
        },
      ],
    } as unknown as Instr,
  ];

  // Pass 1: outLen = 2 + Σ width(c)
  const sizingLoop: Instr[] = [
    { op: "i32.const", value: 2 },
    { op: "local.set", index: L_OUTLEN },
    { op: "local.get", index: L_OFF },
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
            { op: "local.get", index: L_END },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...getC,
            { op: "local.get", index: L_OUTLEN },
            ...widthExpr,
            { op: "i32.add" },
            { op: "local.set", index: L_OUTLEN },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
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

  // short escape: backslash + letter
  const emitShort = (letter: number): Instr[] => [...putConst(C_BACKSLASH), ...putConst(letter)];

  // \u00XX for control chars (c is 0x00..0x1f so high hex nibbles are 0,0,0..1)
  const emitUnicode: Instr[] = [
    ...putConst(C_BACKSLASH),
    ...putConst(C_LC_U),
    ...putConst(C_ZERO),
    ...putConst(C_ZERO),
    // high nibble = (c >> 4) & 0xf  → always 0 or 1 → '0'+n
    ...put([
      { op: "local.get", index: L_C },
      { op: "i32.const", value: 4 },
      { op: "i32.shr_u" },
      { op: "i32.const", value: 0xf },
      { op: "i32.and" },
      { op: "i32.const", value: C_ZERO },
      { op: "i32.add" },
    ]),
    // low nibble = c & 0xf  → '0'+n (n<10) else 'a'+(n-10)
    ...put([
      { op: "local.get", index: L_C },
      { op: "i32.const", value: 0xf },
      { op: "i32.and" },
      { op: "local.tee", index: L_NIB },
      { op: "i32.const", value: 10 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [{ op: "local.get", index: L_NIB }, { op: "i32.const", value: C_ZERO }, { op: "i32.add" }],
        else: [{ op: "local.get", index: L_NIB }, { op: "i32.const", value: C_LC_A_MINUS_10 }, { op: "i32.add" }],
      } as unknown as Instr,
    ]),
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
                                  else: emitVerbatim,
                                } as unknown as Instr,
                              ],
                            } as unknown as Instr,
                          ],
                        } as unknown as Instr,
                      ],
                    } as unknown as Instr,
                  ],
                } as unknown as Instr,
              ],
            } as unknown as Instr,
          ],
        } as unknown as Instr,
      ],
    } as unknown as Instr,
  ];

  // Pass 2: fill
  const fillLoop: Instr[] = [
    { op: "local.get", index: L_OFF },
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
            { op: "local.get", index: L_END },
            { op: "i32.ge_s" },
            { op: "br_if", depth: 1 },
            ...getC,
            ...fillCharDispatch,
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    ...putConst(C_QUOTE), // closing quote
  ];

  // Build result $NativeString(len=outLen, off=0, data=out) and widen.
  const finalize: Instr[] = [
    { op: "local.get", index: L_OUTLEN },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: L_OUT },
    { op: "struct.new", typeIdx: strTypeIdx },
  ];

  const body: Instr[] = [...preamble, ...sizingLoop, ...allocOut, ...fillLoop, ...finalize];

  ctx.mod.functions.push({
    name: "__json_quote_string",
    typeIdx,
    locals: [
      { count: 1, type: { kind: "ref", typeIdx: strTypeIdx } }, // L_FLAT
      { count: 1, type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_DATA
      { count: 1, type: i32 }, // L_END
      { count: 1, type: i32 }, // L_I
      { count: 1, type: i32 }, // L_C
      { count: 1, type: i32 }, // L_OUTLEN
      { count: 1, type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_OUT
      { count: 1, type: i32 }, // L_W
      { count: 1, type: i32 }, // L_OFF
      { count: 1, type: i32 }, // L_NIB
    ],
    body,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return funcIdx;
}

// ── Slice (b): runtime JSON.parse(s) -> primitive $AnyValue (#1599 Phase 2) ──

const C_LC_N2 = 110; // 'n'
const C_LC_T2 = 116; // 't'
const C_LC_F2 = 102; // 'f'
const C_MINUS = 45; // '-'
const C_PLUS = 43; // '+'
const C_DOT = 46; // '.'
const C_0 = 48; // '0'
const C_9 = 57; // '9'
const C_LC_E2 = 101; // 'e'
const C_UC_E2 = 69; // 'E'
const C_SP = 32;
const C_HT = 9;
const C_NL = 10;
const C_CR2 = 13;

/**
 * Emit `__json_parse_primitive(s: externref) -> ref $AnyValue` and register it in
 * `ctx.funcMap`. Idempotent. Parses a JSON text whose top-level value is a
 * primitive — `null`, `true`, `false`, or a JSON number — into a pure-WasmGC
 * `$AnyValue` (tag 0 = null, 3 = f64 number, 4 = bool). Leading/trailing JSON
 * whitespace is skipped. Any other shape (`"`, `{`, `[`) or malformed text traps
 * via `unreachable` — in standalone this surfaces as the spec `SyntaxError`
 * (ECMA-262 §25.5.1 `JSON.parse` / §25.5.2 `ParseJSON`); object/array/string
 * parse into the WasmGC value graph is the Phase 2 follow-up gated on #1472.
 *
 * Requires `ensureAnyHelpers` (caller-registered) so the `__any_box_*` helpers
 * exist, and `ensureNativeStringHelpers` for `__str_flatten`. Number parsing is
 * inlined (sign, integer, fraction, exponent) to avoid depending on the
 * conditionally-registered `parseFloat`.
 */
export function emitJsonParsePrimitive(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_parse_primitive");
  if (existing !== undefined) return existing;

  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };
  const anyTypeIdx = ctx.anyValueTypeIdx;
  const anyRef: ValType = { kind: "ref", typeIdx: anyTypeIdx };

  const boxNull = ctx.funcMap.get("__any_box_null")!;
  const boxBool = ctx.funcMap.get("__any_box_bool")!;
  const boxF64 = ctx.funcMap.get("__any_box_f64")!;

  const typeIdx = addFuncType(ctx, [extern], [anyRef]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__json_parse_primitive", funcIdx);

  // params: 0 s:externref
  // locals: 1 flat 2 data 3 i 4 end 5 c 6 sign:f64 7 mant:f64 8 sawDigit
  //         9 frac:f64 10 expSign 11 exp 12 off
  const L_FLAT = 1;
  const L_DATA = 2;
  const L_I = 3;
  const L_END = 4;
  const L_C = 5;
  const L_SIGN = 6;
  const L_MANT = 7;
  const L_SAW = 8;
  const L_FRAC = 9;
  const L_EXPSIGN = 10;
  const L_EXP = 11;
  const L_OFF = 12;

  const getC: Instr[] = [
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_C },
  ];
  const cEq = (code: number): Instr[] => [
    { op: "local.get", index: L_C },
    { op: "i32.const", value: code },
    { op: "i32.eq" },
  ];
  const cIsWs: Instr[] = [
    ...cEq(C_SP),
    ...cEq(C_HT),
    { op: "i32.or" },
    ...cEq(C_NL),
    { op: "i32.or" },
    ...cEq(C_CR2),
    { op: "i32.or" },
  ];
  const skipWs: Instr[] = [
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
            ...cIsWs,
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
  ];
  const expectChar = (code: number): Instr[] => [
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] } as unknown as Instr,
    ...getC,
    { op: "local.get", index: L_C },
    { op: "i32.const", value: code },
    { op: "i32.ne" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] } as unknown as Instr,
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: L_I },
  ];
  const cIsDigit: Instr[] = [
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_0 },
    { op: "i32.ge_s" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_9 },
    { op: "i32.le_s" },
    { op: "i32.and" },
  ];

  const parseNumber: Instr[] = [
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_SIGN },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: L_MANT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_SAW },
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_FRAC },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L_EXPSIGN },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_EXP },
    ...getC,
    ...cEq(C_MINUS),
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
    } as unknown as Instr,
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
            ...cIsDigit,
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_MANT },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_0 },
            { op: "i32.sub" },
            { op: "f64.convert_i32_s" },
            { op: "f64.add" },
            { op: "local.set", index: L_MANT },
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
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        ...cEq(C_DOT),
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
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
                    { op: "local.get", index: L_END },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    ...getC,
                    ...cIsDigit,
                    { op: "i32.eqz" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_FRAC },
                    { op: "f64.const", value: 10 },
                    { op: "f64.div" },
                    { op: "local.set", index: L_FRAC },
                    { op: "local.get", index: L_MANT },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_0 },
                    { op: "i32.sub" },
                    { op: "f64.convert_i32_s" },
                    { op: "local.get", index: L_FRAC },
                    { op: "f64.mul" },
                    { op: "f64.add" },
                    { op: "local.set", index: L_MANT },
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
          ],
        } as unknown as Instr,
      ],
    } as unknown as Instr,
    { op: "local.get", index: L_SAW },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] } as unknown as Instr,
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        ...cEq(C_LC_E2),
        ...cEq(C_UC_E2),
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_END },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...getC,
                ...cEq(C_MINUS),
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    { op: "i32.const", value: -1 },
                    { op: "local.set", index: L_EXPSIGN },
                    { op: "local.get", index: L_I },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: L_I },
                  ],
                  else: [
                    ...cEq(C_PLUS),
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: L_I },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: L_I },
                      ],
                    } as unknown as Instr,
                  ],
                } as unknown as Instr,
              ],
            } as unknown as Instr,
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
                    ...cIsDigit,
                    { op: "i32.eqz" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_EXP },
                    { op: "i32.const", value: 10 },
                    { op: "i32.mul" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_0 },
                    { op: "i32.sub" },
                    { op: "i32.add" },
                    { op: "local.set", index: L_EXP },
                    { op: "local.get", index: L_I },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: L_I },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
          ],
        } as unknown as Instr,
      ],
    } as unknown as Instr,
    // acc = sign * mant, stored back into L_MANT so the exponent loop can scale
    // it in place (a value left on the wasm stack cannot cross a block boundary).
    { op: "local.get", index: L_SIGN },
    { op: "local.get", index: L_MANT },
    { op: "f64.mul" },
    { op: "local.set", index: L_MANT },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: L_EXP },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_MANT },
            { op: "local.get", index: L_EXPSIGN },
            { op: "i32.const", value: 0 },
            { op: "i32.gt_s" },
            {
              op: "if",
              blockType: { kind: "val", type: f64 },
              then: [{ op: "f64.const", value: 10 }],
              else: [{ op: "f64.const", value: 0.1 }],
            } as unknown as Instr,
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
    { op: "local.get", index: L_MANT },
  ];

  const loadField = (fieldIdx: number, dst: number): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx },
    { op: "local.set", index: dst },
  ];

  const body: Instr[] = [
    // flat once into L_FLAT, then read fields off it
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
    { op: "ref.cast", typeIdx: strTypeIdx },
    { op: "local.set", index: L_FLAT },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
    { op: "local.set", index: L_DATA },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: L_OFF },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
    { op: "local.get", index: L_OFF },
    { op: "i32.add" },
    { op: "local.set", index: L_END },
    { op: "local.get", index: L_OFF },
    { op: "local.set", index: L_I },
    ...skipWs,
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] } as unknown as Instr,
    ...getC,
    ...cEq(C_LC_N2),
    {
      op: "if",
      blockType: { kind: "val", type: anyRef },
      then: [
        ...expectChar(C_LC_N2),
        ...expectChar(117),
        ...expectChar(C_LC_N2),
        ...expectChar(108),
        { op: "call", funcIdx: boxNull },
      ],
      else: [
        ...cEq(C_LC_T2),
        {
          op: "if",
          blockType: { kind: "val", type: anyRef },
          then: [
            ...expectChar(C_LC_T2),
            ...expectChar(114),
            ...expectChar(117),
            ...expectChar(C_LC_E2),
            { op: "i32.const", value: 1 },
            { op: "call", funcIdx: boxBool },
          ],
          else: [
            ...cEq(C_LC_F2),
            {
              op: "if",
              blockType: { kind: "val", type: anyRef },
              then: [
                ...expectChar(C_LC_F2),
                ...expectChar(97),
                ...expectChar(108),
                ...expectChar(115),
                ...expectChar(C_LC_E2),
                { op: "i32.const", value: 0 },
                { op: "call", funcIdx: boxBool },
              ],
              else: [
                ...cEq(C_MINUS),
                ...cIsDigit,
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "val", type: anyRef },
                  then: [...parseNumber, { op: "call", funcIdx: boxF64 }],
                  else: [{ op: "unreachable" }],
                } as unknown as Instr,
              ],
            } as unknown as Instr,
          ],
        } as unknown as Instr,
      ],
    } as unknown as Instr,
    // trailing: skip ws, require i==end else trap (value $AnyValue stays on stack)
    ...skipWs,
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.lt_s" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] } as unknown as Instr,
  ];
  void loadField;

  ctx.mod.functions.push({
    name: "__json_parse_primitive",
    typeIdx,
    locals: [
      { count: 1, type: { kind: "ref", typeIdx: strTypeIdx } }, // L_FLAT
      { count: 1, type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_DATA
      { count: 1, type: i32 }, // L_I
      { count: 1, type: i32 }, // L_END
      { count: 1, type: i32 }, // L_C
      { count: 1, type: f64 }, // L_SIGN
      { count: 1, type: f64 }, // L_MANT
      { count: 1, type: i32 }, // L_SAW
      { count: 1, type: f64 }, // L_FRAC
      { count: 1, type: i32 }, // L_EXPSIGN
      { count: 1, type: i32 }, // L_EXP
      { count: 1, type: i32 }, // L_OFF
    ],
    body,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return funcIdx;
}
