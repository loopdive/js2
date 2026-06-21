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
import { ensureAnyValueType } from "./any-helpers.js";
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
    },
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
      },
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

// eq abstract heap type, signed-LEB128 → 0x6d. Used for the AnyValue $refval
// null payload (matches ensureAnyHelpers in any-helpers.ts).
const EQ_HEAP_TYPE = -19;

/**
 * Emit `__json_parse_primitive(s: externref) -> ref $AnyValue` and register it
 * in `ctx.funcMap`. Idempotent. Parses a runtime string holding a single JSON
 * primitive (number / `true` / `false` / `null`) entirely in Wasm — no
 * `env::JSON_parse` host import — and boxes the result into the host-free
 * `$AnyValue` tagged union (#1599 Phase 2):
 *
 *   - `"null"`             → tag 0 (null)
 *   - `"true"` / `"false"` → tag 4 (boolean), i32val 1 / 0
 *   - JSON number          → tag 3 (f64), f64val = parsed value
 *   - anything else        → `unreachable` (Wasm trap; matches a SyntaxError
 *                             throw under the standalone no-host contract)
 *
 * The caller (`tryEmitJsonParsePrimitive` in expressions/calls.ts) gates this
 * on `ctx.standalone || ctx.wasi` and a string-typed argument, and returns the
 * `ref $AnyValue` type so the existing AnyValue→primitive coercion path in
 * type-coercion.ts unboxes it to number / boolean as the consumer requires.
 *
 * Must run after `ensureNativeStringHelpers` (called here) so `__str_flatten`
 * exists, and before any function body that calls it.
 *
 * Spec: ECMA-262 §25.5.2 `JSON.parse` / `ParseJSON`, ECMA-404 JSON grammar.
 */
export function emitJsonParsePrimitive(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__json_parse_primitive");
  if (existing !== undefined) return existing;

  ensureNativeStringHelpers(ctx);
  ensureAnyValueType(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx; // $NativeString (FlatString): len, off, data
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx; // (array (mut i16))
  const anyTypeIdx = ctx.anyValueTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };

  const anyRef: ValType = { kind: "ref", typeIdx: anyTypeIdx };
  const typeIdx = addFuncType(ctx, [extern], [anyRef]);
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.funcMap.set("__json_parse_primitive", funcIdx);

  // params: 0 s:externref
  // locals:
  //  1 flat:ref $NativeString  2 data:ref $__str_data  3 end:i32  4 i:i32
  //  5 c:i32  6 sign:f64  7 mant:f64  8 frac:f64  9 expSign:i32  10 exp:i32
  const L_FLAT = 1;
  const L_DATA = 2;
  const L_END = 3;
  const L_I = 4;
  const L_C = 5;
  const L_SIGN = 6;
  const L_MANT = 7;
  const L_FRAC = 8;
  const L_EXPSIGN = 9;
  const L_EXP = 10;
  const L_EXPMAG = 11;

  // c = data[i]
  const getC: Instr[] = [
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_C },
  ];

  // boxed AnyValue constructors (push a ref $AnyValue)
  const boxNull: Instr[] = [
    { op: "i32.const", value: 0 }, // tag 0 = null
    { op: "i32.const", value: 0 },
    { op: "f64.const", value: 0 },
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ];
  const boxBool = (v: number): Instr[] => [
    { op: "i32.const", value: 4 }, // tag 4 = boolean
    { op: "i32.const", value: v },
    { op: "f64.const", value: 0 },
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ];
  // box the f64 currently in local L_MANT*... — caller leaves value in L_FRAC
  const boxF64FromLocal = (local: number): Instr[] => [
    { op: "i32.const", value: 3 }, // tag 3 = f64 number
    { op: "i32.const", value: 0 },
    { op: "local.get", index: local },
    { op: "ref.null", typeIdx: EQ_HEAP_TYPE },
    { op: "ref.null.extern" },
    { op: "struct.new", typeIdx: anyTypeIdx },
  ];

  // ── Preamble: flatten, load data, skip leading whitespace, read first char ──
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
    { op: "local.set", index: L_I },
    { op: "local.get", index: L_FLAT },
    { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 }, // len
    { op: "local.get", index: L_I },
    { op: "i32.add" },
    { op: "local.set", index: L_END }, // end = off + len (exclusive)
  ];

  // skip whitespace: while i<end && (c==' '|'\t'|'\n'|'\r') i++
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
            // ws = c==32 | c==9 | c==10 | c==13
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 32 },
            { op: "i32.eq" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 9 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 10 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 13 },
            { op: "i32.eq" },
            { op: "i32.or" },
            { op: "i32.eqz" },
            { op: "br_if", depth: 1 }, // non-ws → stop
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // c = data[i] (first non-ws char). If i>=end the input is empty → trap.
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.ge_s" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "unreachable" }] },
    ...getC,
  ];

  // c==code → i32 bool
  const cEq = (code: number): Instr[] => [
    { op: "local.get", index: L_C },
    { op: "i32.const", value: code },
    { op: "i32.eq" },
  ];

  // ── Number parser: sign? int frac? exp? → f64 in L_FRAC ──
  // Reads from cursor L_I (positioned at first digit or '-'). Accumulates the
  // mantissa as f64 (sufficient precision for the primitive slice), applies a
  // base-10 exponent for the fractional and 'e' parts, and stores into L_FRAC.
  const parseNumber: Instr[] = [
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_SIGN },
    { op: "f64.const", value: 0 },
    { op: "local.set", index: L_MANT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_EXP }, // net base-10 exponent
    // optional '-'
    ...cEq(45),
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
    },
    // integer digits: while i<end && '0'<=c<='9' { mant=mant*10+(c-'0'); i++ }
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
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 48 },
            { op: "i32.lt_s" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 57 },
            { op: "i32.gt_s" },
            { op: "br_if", depth: 1 },
            // mant = mant*10 + (c-48)
            { op: "local.get", index: L_MANT },
            { op: "f64.const", value: 10 },
            { op: "f64.mul" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: 48 },
            { op: "i32.sub" },
            { op: "f64.convert_i32_s" },
            { op: "f64.add" },
            { op: "local.set", index: L_MANT },
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    // fraction: if c=='.' { i++; while digit { mant=mant*10+d; exp--; i++ } }
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        ...cEq(46), // '.'
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
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.lt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: 57 },
                    { op: "i32.gt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_MANT },
                    { op: "f64.const", value: 10 },
                    { op: "f64.mul" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.sub" },
                    { op: "f64.convert_i32_s" },
                    { op: "f64.add" },
                    { op: "local.set", index: L_MANT },
                    { op: "local.get", index: L_EXP },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
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
        },
      ],
    },
    // exponent: if c=='e'|'E' { i++; optional sign; exp += expSign * digits }
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        ...cEq(101), // 'e'
        ...cEq(69), // 'E'
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // consume 'e'/'E'
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
            // expSign = 1
            { op: "i32.const", value: 1 },
            { op: "local.set", index: L_EXPSIGN },
            // optional exponent sign
            { op: "local.get", index: L_I },
            { op: "local.get", index: L_END },
            { op: "i32.lt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                ...getC,
                ...cEq(45), // '-'
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
                    ...cEq(43), // '+'
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
            // explicit exponent digits: expMag = Σ digits; exp += expSign*expMag
            { op: "i32.const", value: 0 },
            { op: "local.set", index: L_EXPMAG },
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
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.lt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: 57 },
                    { op: "i32.gt_s" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_EXPMAG },
                    { op: "i32.const", value: 10 },
                    { op: "i32.mul" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: 48 },
                    { op: "i32.sub" },
                    { op: "i32.add" },
                    { op: "local.set", index: L_EXPMAG },
                    { op: "local.get", index: L_I },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: L_I },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            // exp += expSign * expMag
            { op: "local.get", index: L_EXP },
            { op: "local.get", index: L_EXPSIGN },
            { op: "local.get", index: L_EXPMAG },
            { op: "i32.mul" },
            { op: "i32.add" },
            { op: "local.set", index: L_EXP },
          ],
        },
      ],
    },
    // result = sign * mant * 10^exp  → L_FRAC
    // Compute 10^exp by repeated multiply/divide (exp is small for the
    // primitive slice; loop |exp| times). pow accumulates in L_FRAC.
    { op: "f64.const", value: 1 },
    { op: "local.set", index: L_FRAC }, // pow = 1
    // if exp >= 0: multiply by 10, exp times; else divide by 10, -exp times.
    { op: "local.get", index: L_EXP },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
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
                { op: "local.get", index: L_EXP },
                { op: "i32.eqz" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_FRAC },
                { op: "f64.const", value: 10 },
                { op: "f64.mul" },
                { op: "local.set", index: L_FRAC },
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
      else: [
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
                { op: "local.get", index: L_FRAC },
                { op: "f64.const", value: 10 },
                { op: "f64.div" },
                { op: "local.set", index: L_FRAC },
                { op: "local.get", index: L_EXP },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_EXP },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
    // L_FRAC = sign * mant * pow
    { op: "local.get", index: L_SIGN },
    { op: "local.get", index: L_MANT },
    { op: "f64.mul" },
    { op: "local.get", index: L_FRAC },
    { op: "f64.mul" },
    { op: "local.set", index: L_FRAC },
  ];

  // Build the result by switching on the first char.
  const dispatch: Instr[] = [
    ...cEq(110), // 'n' → null
    {
      op: "if",
      blockType: { kind: "val", type: anyRef },
      then: boxNull,
      else: [
        ...cEq(116), // 't' → true
        {
          op: "if",
          blockType: { kind: "val", type: anyRef },
          then: boxBool(1),
          else: [
            ...cEq(102), // 'f' → false
            {
              op: "if",
              blockType: { kind: "val", type: anyRef },
              then: boxBool(0),
              else: [
                // number: '-' or digit; otherwise trap
                ...cEq(45),
                { op: "local.get", index: L_C },
                { op: "i32.const", value: 48 },
                { op: "i32.ge_s" },
                { op: "local.get", index: L_C },
                { op: "i32.const", value: 57 },
                { op: "i32.le_s" },
                { op: "i32.and" },
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "val", type: anyRef },
                  then: [...parseNumber, ...boxF64FromLocal(L_FRAC)],
                  else: [{ op: "unreachable" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ];

  const body: Instr[] = [...preamble, ...skipWs, ...dispatch];

  ctx.mod.functions.push({
    name: "__json_parse_primitive",
    typeIdx,
    locals: [
      { count: 1, type: { kind: "ref", typeIdx: strTypeIdx } }, // L_FLAT
      { count: 1, type: { kind: "ref", typeIdx: strDataTypeIdx } }, // L_DATA
      { count: 1, type: i32 }, // L_END
      { count: 1, type: i32 }, // L_I
      { count: 1, type: i32 }, // L_C
      { count: 1, type: f64 }, // L_SIGN
      { count: 1, type: f64 }, // L_MANT
      { count: 1, type: f64 }, // L_FRAC
      { count: 1, type: i32 }, // L_EXPSIGN
      { count: 1, type: i32 }, // L_EXP
      { count: 1, type: i32 }, // L_EXPMAG
    ],
    body,
    exported: false,
  } as unknown as (typeof ctx.mod.functions)[number]);

  return funcIdx;
}
