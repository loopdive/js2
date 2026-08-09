// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm `parseInt` / `parseFloat` for standalone / WASI targets (#1663).
 *
 * In JS-host mode `parseInt` / `parseFloat` are `env` imports. Under
 * `--target wasi` / `--target standalone` there is no JS runtime to satisfy
 * them, so this module emits WasmGC-native implementations registered under
 * the same `ctx.funcMap` names ("parseInt" / "parseFloat"). All existing call
 * sites push the string argument as an `externref`, so the native functions
 * take `externref` too: they `any.convert_extern` + `ref.cast` to the WasmGC
 * `$AnyString`, flatten it to a contiguous i16 buffer via `__str_flatten`, then
 * scan the UTF-16 code units.
 *
 * Spec references:
 * - parseInt   — ECMA-262 §19.2.5 (sign, optional 0x prefix, radix digit loop)
 * - parseFloat — ECMA-262 §19.2.4 (longest StrDecimalLiteral prefix, Infinity)
 */
import type { ArrayTypeDef, Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting

/**
 * (#4234) Largest decimal exponent held in the `10^k` lookup table. `1e308` is
 * the last power of ten below `Number.MAX_VALUE`; `1e309` is `Infinity`, so the
 * table stops here and anything beyond is reached by the staged loop below.
 */
const POW10_TABLE_MAX = 308;

/**
 * (#4234) Register — once per module — the immutable `(array f64)` global
 * holding `10^0 … 10^308`, and return its global index.
 *
 * ## Why a table (this is the fix, not an optimisation)
 *
 * §7.1.4.1 StringToNumber must produce the double NEAREST the exact decimal
 * value. The scaling step `mant × 10^totalExp` used to be applied as
 * `|totalExp|` successive `×10` / `÷10` operations whenever `|totalExp| > 22`,
 * and every one of those rounds. Measured over 50k random
 * `<1–17 digits>e<-300…100>` inputs against the correctly-rounded result:
 *
 * | scaling                                   | wrong  | worst error |
 * | ----------------------------------------- | ------ | ----------- |
 * | per-step `×10`/`÷10` (before)             | 75.3 % | 11.7 ulp    |
 * | exact-`10^22` chunks                      | 43.4 % | 2.1 ulp     |
 * | **one op against this table (after)**     | 29.0 % | **1.0 ulp** |
 *
 * The table entries are each the nearest double to `10^k` (they are what the
 * host's own literal parser produces), so a single `f64.mul`/`f64.div` against
 * one of them is a single hardware rounding. That bounds the total error at
 * one ulp — the answer is always the nearest double or its immediate
 * neighbour — where the old loop drifted by up to a dozen.
 *
 * ## What this deliberately does NOT do
 *
 * It is not a correctly-rounded strtod. Getting the last 29 % needs the
 * mantissa carried at ~106 bits (Eisel–Lemire / double-double), i.e. a
 * `(hi, lo)` table plus Dekker two-products — which on Wasm (no scalar FMA)
 * also needs mantissa pre-scaling to keep the split from overflowing near
 * `1e308`. That is a separate, much larger slice; see the issue's "Not done".
 *
 * `array.new_fixed` is a constant instruction, so the engine materialises the
 * 309 doubles once at instantiation rather than per call (same pattern as the
 * Unicode case tables, #3900).
 */
function ensurePow10TableGlobal(ctx: CodegenContext): number {
  if (ctx.pow10TableGlobalIdx !== undefined) return ctx.pow10TableGlobalIdx;

  let arrTypeIdx = ctx.pow10ArrTypeIdx;
  if (arrTypeIdx === undefined) {
    arrTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "array",
      name: "Pow10TableF64",
      element: { kind: "f64" },
      mutable: false,
    } as ArrayTypeDef);
    ctx.pow10ArrTypeIdx = arrTypeIdx;
  }

  const init: Instr[] = [];
  for (let k = 0; k <= POW10_TABLE_MAX; k++) init.push({ op: "f64.const", value: Number(`1e${k}`) });
  init.push({ op: "array.new_fixed", typeIdx: arrTypeIdx, length: POW10_TABLE_MAX + 1 });

  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__pow10_f64",
    type: { kind: "ref", typeIdx: arrTypeIdx },
    mutable: false,
    init,
  });
  ctx.pow10TableGlobalIdx = globalIdx;
  return globalIdx;
}

const C_TAB = 9;
const C_LF = 10;
const C_VT = 11;
const C_FF = 12;
const C_CR = 13;
const C_SPACE = 32;
const C_NBSP = 0xa0;
// §11.2 WhiteSpace (Zs category beyond NBSP) + §11.3 LineTerminator extras and
// the BOM/ZWNBSP. StrWhiteSpace for ToNumber/parseInt/parseFloat (§19.2.4/.5,
// §7.1.4.1) is WhiteSpace ∪ LineTerminator.
const C_OGHAM_SP = 0x1680; // Zs OGHAM SPACE MARK
const C_ENQUAD = 0x2000; // Zs range start (EN QUAD … HAIR SPACE)
const C_HAIR_SP = 0x200a; // Zs range end
const C_LS = 0x2028; // LINE SEPARATOR (LineTerminator)
const C_PS = 0x2029; // PARAGRAPH SEPARATOR (LineTerminator)
const C_NNBSP = 0x202f; // Zs NARROW NO-BREAK SPACE
const C_MMSP = 0x205f; // Zs MEDIUM MATHEMATICAL SPACE
const C_IDEO_SP = 0x3000; // Zs IDEOGRAPHIC SPACE
const C_BOM = 0xfeff; // ZERO WIDTH NO-BREAK SPACE (BOM)
const C_PLUS = 43;
const C_MINUS = 45;
const C_DOT = 46;
const C_ZERO = 48;
const C_NINE = 57;
const C_UC_A = 65;
const C_UC_B = 66;
const C_UC_E = 69;
const C_UC_O = 79;
const C_UC_X = 88;
const C_UC_Z = 90;
const C_LC_A = 97;
const C_LC_B = 98;
const C_LC_E = 101;
const C_LC_O = 111;
const C_LC_X = 120;
const C_LC_Z = 122;

/**
 * Push the instructions that take an `externref` string on the stack and leave
 * a flat `$NativeString` ref. Mirrors the charCodeAt flatten preamble.
 */
function externToFlat(ctx: CodegenContext, flattenIdx: number): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
  ];
}

/**
 * `isWhiteSpace(c)` inline test — the StrWhiteSpace set consumed by ToNumber /
 * parseInt / parseFloat (ECMA-262 §19.2.4/.5, §7.1.4.1) = WhiteSpace (§11.2) ∪
 * LineTerminator (§11.3): TAB, LF, VT, FF, CR, SP, NBSP, the BOM/ZWNBSP, the
 * LS/PS line terminators, and the Zs (space-separator) category — OGHAM SPACE,
 * the EN-QUAD..HAIR-SPACE range (U+2000–U+200A), NARROW/MEDIUM/IDEOGRAPHIC space.
 * Leaves i32 bool. Operand: the code unit is consumed via a local.
 */
function isWsBody(cLocal: number): Instr[] {
  const get = (): Instr => ({ op: "local.get", index: cLocal });
  const eq = (code: number): Instr[] => [get(), { op: "i32.const", value: code }, { op: "i32.eq" }];
  // c >= lo && c <= hi  (the contiguous Zs run U+2000..U+200A).
  const inRange = (lo: number, hi: number): Instr[] => [
    get(),
    { op: "i32.const", value: lo },
    { op: "i32.ge_u" },
    get(),
    { op: "i32.const", value: hi },
    { op: "i32.le_u" },
    { op: "i32.and" },
  ];
  return [
    ...eq(C_SPACE),
    ...eq(C_TAB),
    { op: "i32.or" },
    ...eq(C_LF),
    { op: "i32.or" },
    ...eq(C_VT),
    { op: "i32.or" },
    ...eq(C_FF),
    { op: "i32.or" },
    ...eq(C_CR),
    { op: "i32.or" },
    ...eq(C_NBSP),
    { op: "i32.or" },
    ...eq(C_BOM),
    { op: "i32.or" },
    ...eq(C_LS),
    { op: "i32.or" },
    ...eq(C_PS),
    { op: "i32.or" },
    ...eq(C_OGHAM_SP),
    { op: "i32.or" },
    ...inRange(C_ENQUAD, C_HAIR_SP),
    { op: "i32.or" },
    ...eq(C_NNBSP),
    { op: "i32.or" },
    ...eq(C_MMSP),
    { op: "i32.or" },
    ...eq(C_IDEO_SP),
    { op: "i32.or" },
  ];
}

/**
 * Emit native `parseInt` / `parseFloat` functions and register them in
 * `ctx.funcMap` (and a dedicated set on ctx for idempotency). Must run before
 * any function bodies that `call ctx.funcMap.get("parseInt")` are compiled, and
 * after `ensureNativeStringHelpers` (which it calls) so `__str_flatten` exists.
 *
 * @param which Set of names to emit — subset of {"parseInt","parseFloat"}.
 */
export function emitNativeParseNumber(ctx: CodegenContext, which: Set<string>): void {
  ensureNativeStringHelpers(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };

  if (which.has("parseFloat") && !ctx.funcMap.has("parseFloat")) {
    // (externref) -> f64
    const typeIdx = addFuncType(ctx, [extern], [f64]);
    const funcIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
    ctx.funcMap.set("parseFloat", funcIdx);

    // locals (after param 0 = s:externref):
    //  1 flat:ref$NativeString  2 data:ref$i16arr  3 len:i32  4 i:i32
    //  5 c:i32  6 sign:f64  7 mant:f64  8 sawDigit:i32  9 frac:f64
    // 10 expSign:i32 11 exp:i32 12 result:f64 13 start:i32
    const L_FLAT = 1;
    const L_DATA = 2;
    const L_LEN = 3;
    const L_I = 4;
    const L_C = 5;
    const L_SIGN = 6;
    const L_MANT = 7;
    const L_SAW = 8;
    // index 9 = fracScale (legacy, now unused after the #2654 integer-mantissa rewrite)
    const L_EXPSIGN = 10;
    const L_EXP = 11;
    const L_RESULT = 12;
    // (#2654) integer-mantissa scaling scratch locals.
    const L_FRACCOUNT = 13; // i32: number of fraction digits consumed
    const L_TEXP = 14; // i32: total decimal exponent (expSign*exp + intDrop - fracCount)
    const L_POW = 15; // f64: 10^|totalExp|
    const L_INTDROP = 16; // i32: integer digits dropped past the ~15-sig-digit cap

    const getC: Instr[] = [
      { op: "local.get", index: L_DATA },
      { op: "local.get", index: L_I },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.set", index: L_C },
    ];

    const body: Instr[] = [
      // flat = flatten(s); data = flat.data; len = flat.len; i = 0
      ...externToFlat(ctx, flattenIdx),
      { op: "local.set", index: L_FLAT },
      { op: "local.get", index: L_FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: L_DATA },
      { op: "local.get", index: L_FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: L_LEN },
      // i = off (flat strings may carry a nonzero off)
      { op: "local.get", index: L_FLAT },
      { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: L_I },
      // len = off + len  (so L_I..L_LEN spans the logical string)
      { op: "local.get", index: L_LEN },
      { op: "local.get", index: L_I },
      { op: "i32.add" },
      { op: "local.set", index: L_LEN },
      { op: "f64.const", value: 1 },
      { op: "local.set", index: L_SIGN },
      { op: "i64.const", value: 0n },
      { op: "local.set", index: L_MANT },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_SAW },

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
              { op: "local.get", index: L_I },
              { op: "local.get", index: L_LEN },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              ...getC,
              // if !ws break
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

      // --- optional sign ---
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

      // --- Infinity check ---
      ...emitInfinityCheck(L_I, L_LEN, L_DATA, L_C, L_SIGN, strDataTypeIdx),

      // --- integer digits ---
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
              // if c<'0' || c>'9' break
              { op: "local.get", index: L_C },
              { op: "i32.const", value: C_ZERO },
              { op: "i32.lt_s" },
              { op: "local.get", index: L_C },
              { op: "i32.const", value: C_NINE },
              { op: "i32.gt_s" },
              { op: "i32.or" },
              { op: "br_if", depth: 1 },
              // (#2654) Cap the i64 integer-mantissa accumulation at ~18
              // significant digits (mant < 9e17 keeps mant*10+9 < 2^63, the i64
              // range — and well within the ~17 digits an f64 can resolve). Past
              // the cap an integer digit is DROPPED from the mantissa but its
              // place value is preserved by bumping the decimal exponent
              // (L_INTDROP), so "12345678901234567890" keeps ~18 sig digits + exp
              // instead of overflowing and corrupting the value.
              { op: "local.get", index: L_MANT },
              { op: "i64.const", value: 900000000000000000n },
              { op: "i64.lt_u" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // mant = mant*10 + (c-'0')
                  { op: "local.get", index: L_MANT },
                  { op: "i64.const", value: 10n },
                  { op: "i64.mul" },
                  { op: "local.get", index: L_C },
                  { op: "i32.const", value: C_ZERO },
                  { op: "i32.sub" },
                  { op: "i64.extend_i32_s" },
                  { op: "i64.add" },
                  { op: "local.set", index: L_MANT },
                ],
                else: [
                  // dropped integer digit → exponent += 1
                  { op: "local.get", index: L_INTDROP },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: L_INTDROP },
                ],
              },
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

      // --- fraction ---
      { op: "local.get", index: L_I },
      { op: "local.get", index: L_LEN },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...getC,
          { op: "local.get", index: L_C },
          { op: "i32.const", value: C_DOT },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // advance past '.'
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
                      { op: "local.get", index: L_LEN },
                      { op: "i32.ge_s" },
                      { op: "br_if", depth: 1 },
                      ...getC,
                      { op: "local.get", index: L_C },
                      { op: "i32.const", value: C_ZERO },
                      { op: "i32.lt_s" },
                      { op: "local.get", index: L_C },
                      { op: "i32.const", value: C_NINE },
                      { op: "i32.gt_s" },
                      { op: "i32.or" },
                      { op: "br_if", depth: 1 },
                      // (#2654) i64 integer-mantissa accumulation, capped at ~18
                      // sig digits (mant < 9e17). Within the cap: mant = mant*10 +
                      // digit and fracCount++ (final scaling divides by 10^count).
                      // Past the cap a fraction digit is dropped (no visible effect
                      // on the rounded double), NOT counted.
                      { op: "local.get", index: L_MANT },
                      { op: "i64.const", value: 900000000000000000n },
                      { op: "i64.lt_u" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: L_MANT },
                          { op: "i64.const", value: 10n },
                          { op: "i64.mul" },
                          { op: "local.get", index: L_C },
                          { op: "i32.const", value: C_ZERO },
                          { op: "i32.sub" },
                          { op: "i64.extend_i32_s" },
                          { op: "i64.add" },
                          { op: "local.set", index: L_MANT },
                          { op: "local.get", index: L_FRACCOUNT },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          { op: "local.set", index: L_FRACCOUNT },
                        ],
                        else: [],
                      },
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

      // --- exponent ---
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_EXP },
      { op: "i32.const", value: 1 },
      { op: "local.set", index: L_EXPSIGN },
      ...emitExponent(L_I, L_LEN, L_DATA, L_C, L_EXP, L_EXPSIGN, strDataTypeIdx, getC),

      // (#2654) result = sign * mant * 10^(expSign*exp + intDrop - fracCount),
      // applied as a single correctly-rounded multiply/divide (see
      // emitApplyDecimalExp).
      ...emitApplyDecimalExp(ctx, L_SIGN, L_MANT, L_FRACCOUNT, L_INTDROP, L_EXP, L_EXPSIGN, L_TEXP, L_POW, L_RESULT),
      { op: "local.get", index: L_RESULT },
      { op: "return" },
    ];

    pushDefinedFunc(ctx, funcIdx, {
      name: "parseFloat",
      typeIdx,
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
      ],
      body,
      exported: false,
    });
  }

  if (which.has("parseInt") && !ctx.funcMap.has("parseInt")) {
    emitParseInt(ctx, flattenIdx, strTypeIdx, strDataTypeIdx);
  }

  if (which.has("__str_to_number") && !ctx.funcMap.has("__str_to_number")) {
    emitStrToNumber(ctx, flattenIdx, strTypeIdx, strDataTypeIdx);
  }
}

/**
 * Native `Number(string)` — ECMA-262 §7.1.4.1 StringToNumber. Signature
 * `(externref) -> f64`. Differs from `parseFloat` (§19.2.4) in three ways:
 *   - the ENTIRE trimmed string must be a valid StrNumericLiteral, else NaN
 *     (parseFloat takes the longest matching prefix);
 *   - an empty / all-whitespace string is `0` (parseFloat → NaN);
 *   - `0x`/`0X`, `0o`/`0O`, `0b`/`0B` prefixes select hex/octal/binary integer
 *     literals (parseFloat ignores them).
 *
 * Approach: flatten → trim leading+trailing whitespace → handle the empty,
 * Infinity and radix-prefix cases, then scan a signed decimal literal and
 * require the scan to consume the whole trimmed range.
 */
function emitStrToNumber(ctx: CodegenContext, flattenIdx: number, strTypeIdx: number, strDataTypeIdx: number): void {
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [extern], [f64]);
  const funcIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("__str_to_number", funcIdx);

  // params: 0 s:externref
  // locals: 1 flat 2 data 3 end:i32 4 i:i32 5 c:i32 6 sign:f64 7 mant:f64
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
  const L_FRAC = 9; // legacy fracScale, unused after the #2654 integer-mantissa rewrite
  const L_EXPSIGN = 10;
  const L_EXP = 11;
  const L_RESULT = 12;
  const L_RADIX = 13;
  const L_DIG = 14;
  // (#2654) integer-mantissa scaling scratch locals.
  const L_FRACCOUNT = 15; // i32: number of fraction digits consumed
  const L_TEXP = 16; // i32: total decimal exponent (expSign*exp + intDrop - fracCount)
  const L_POW = 17; // f64: 10^|totalExp|
  const L_INTDROP = 18; // i32: integer digits dropped past the ~15-sig-digit cap
  // (#3570) i32: 1 iff an explicit '+'/'-' sign char was consumed. A
  // NonDecimalIntegerLiteral (0x/0o/0b) is INVALID with any leading sign
  // (§7.1.4.1), so `Number('+0x10')`/`Number('-0x10')` must be NaN. The old
  // radix guard keyed on `sign==1`, which admits the '+' case (it leaves
  // sign=+1); this flag distinguishes "no sign" from "explicit +".
  const L_SAWSIGN = 19;

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

  const body: Instr[] = [
    // flat = flatten(s); data = flat.data; i = flat.off; end = off + len
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
    { op: "call", funcIdx: flattenIdx },
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

    // --- decimal mantissa ---
    { op: "i64.const", value: 0n },
    { op: "local.set", index: L_MANT },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_SAW },
    // integer digits
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
            { op: "i32.const", value: C_ZERO },
            { op: "i32.lt_s" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_NINE },
            { op: "i32.gt_s" },
            { op: "i32.or" },
            { op: "br_if", depth: 1 },
            // (#2654) i64 integer-mantissa accumulation, capped at ~18 sig digits
            // (mant < 9e17 keeps mant*10+9 < 2^63). Past the cap an integer digit
            // is dropped from the mantissa and its place value preserved by
            // bumping the exponent (L_INTDROP).
            { op: "local.get", index: L_MANT },
            { op: "i64.const", value: 900000000000000000n },
            { op: "i64.lt_u" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_MANT },
                { op: "i64.const", value: 10n },
                { op: "i64.mul" },
                { op: "local.get", index: L_C },
                { op: "i32.const", value: C_ZERO },
                { op: "i32.sub" },
                { op: "i64.extend_i32_s" },
                { op: "i64.add" },
                { op: "local.set", index: L_MANT },
              ],
              else: [
                { op: "local.get", index: L_INTDROP },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_INTDROP },
              ],
            },
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
    // fraction
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_DOT },
        { op: "i32.eq" },
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
                    { op: "i32.const", value: C_ZERO },
                    { op: "i32.lt_s" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_NINE },
                    { op: "i32.gt_s" },
                    { op: "i32.or" },
                    { op: "br_if", depth: 1 },
                    // (#2654) i64 integer-mantissa accumulation, capped at ~18 sig
                    // digits (mant < 9e17). Within the cap: mant = mant*10 + digit
                    // and fracCount++. Past the cap a fraction digit is dropped (no
                    // visible effect on the rounded double), NOT counted.
                    { op: "local.get", index: L_MANT },
                    { op: "i64.const", value: 900000000000000000n },
                    { op: "i64.lt_u" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [
                        { op: "local.get", index: L_MANT },
                        { op: "i64.const", value: 10n },
                        { op: "i64.mul" },
                        { op: "local.get", index: L_C },
                        { op: "i32.const", value: C_ZERO },
                        { op: "i32.sub" },
                        { op: "i64.extend_i32_s" },
                        { op: "i64.add" },
                        { op: "local.set", index: L_MANT },
                        { op: "local.get", index: L_FRACCOUNT },
                        { op: "i32.const", value: 1 },
                        { op: "i32.add" },
                        { op: "local.set", index: L_FRACCOUNT },
                      ],
                      else: [],
                    },
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
        },
      ],
    },
    // if no digit seen at all → NaN (e.g. ".", "+", "e5")
    { op: "local.get", index: L_SAW },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // exponent
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_EXP },
    { op: "i32.const", value: 1 },
    { op: "local.set", index: L_EXPSIGN },
    ...emitExponent(L_I, L_END, L_DATA, L_C, L_EXP, L_EXPSIGN, strDataTypeIdx, getC),
    // full-match requirement: if i != end → NaN (trailing junk)
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_END },
    { op: "i32.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "f64.const", value: NaN }, { op: "return" }],
    },
    // (#2654) result = sign * mant * 10^(expSign*exp + intDrop - fracCount),
    // applied as a single correctly-rounded multiply/divide (see
    // emitApplyDecimalExp).
    ...emitApplyDecimalExp(ctx, L_SIGN, L_MANT, L_FRACCOUNT, L_INTDROP, L_EXP, L_EXPSIGN, L_TEXP, L_POW, L_RESULT),
    { op: "local.get", index: L_RESULT },
    { op: "return" },
  ];

  pushDefinedFunc(ctx, funcIdx, {
    name: "__str_to_number",
    typeIdx,
    locals: [
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
    ],
    body,
    exported: false,
  });
}

/**
 * `if (data[i..end] === "Infinity") return sign*Infinity`. Requires the match
 * to span exactly to `end` (StringToNumber is a full-match grammar).
 */
function emitInfinityExact(
  L_I: number,
  L_END: number,
  L_DATA: number,
  L_SIGN: number,
  strDataTypeIdx: number,
): Instr[] {
  const word = "Infinity";
  const charChecks: Instr[] = [];
  for (let k = 0; k < word.length; k++) {
    charChecks.push({ op: "local.get", index: L_DATA });
    charChecks.push({ op: "local.get", index: L_I });
    charChecks.push({ op: "i32.const", value: k });
    charChecks.push({ op: "i32.add" });
    charChecks.push({ op: "array.get_u", typeIdx: strDataTypeIdx });
    charChecks.push({ op: "i32.const", value: word.charCodeAt(k) });
    charChecks.push({ op: "i32.eq" });
    if (k > 0) charChecks.push({ op: "i32.and" });
  }
  return [
    // require exactly word.length chars remaining: i + 8 == end
    { op: "local.get", index: L_I },
    { op: "i32.const", value: word.length },
    { op: "i32.add" },
    { op: "local.get", index: L_END },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...charChecks,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_SIGN },
            { op: "f64.const", value: Infinity },
            { op: "f64.mul" },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/**
 * Detect a `0x`/`0X`/`0o`/`0O`/`0b`/`0B` prefix at `L_I` and, if present, parse
 * the remainder as a NonDecimalIntegerLiteral in radix 16/8/2. The entire
 * remaining range must be valid digits, else NaN. Only fires when no sign was
 * consumed (sign==1) — a signed non-decimal literal is NaN per spec. Returns
 * directly from the enclosing function on a match (value or NaN).
 */
function emitRadixPrefixParse(
  L_I: number,
  L_END: number,
  L_DATA: number,
  L_C: number,
  L_SAWSIGN: number,
  L_RADIX: number,
  L_DIG: number,
  L_RESULT: number,
  L_SAW: number,
  strDataTypeIdx: number,
): Instr[] {
  // Build a single prefix arm. Self-conditioned: it reads data[i+1] and uses
  // the (== lc || == uc) test as its own `if` condition, so multiple arms can
  // be sequenced inside the shared `0`-prefix guard — a non-matching arm is a
  // no-op and control falls through to the next arm.
  const buildArm = (lc: number, uc: number, radix: number): Instr[] => [
    // second char is lc/uc?
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.tee", index: L_C },
    { op: "i32.const", value: lc },
    { op: "i32.eq" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: uc },
    { op: "i32.eq" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "i32.const", value: radix },
        { op: "local.set", index: L_RADIX },
        // advance past "0x"/"0o"/"0b"
        { op: "local.get", index: L_I },
        { op: "i32.const", value: 2 },
        { op: "i32.add" },
        { op: "local.set", index: L_I },
        // require at least one digit
        { op: "local.get", index: L_I },
        { op: "local.get", index: L_END },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "f64.const", value: NaN }, { op: "return" }],
        },
        { op: "f64.const", value: 0 },
        { op: "local.set", index: L_RESULT },
        // digit loop over [i, end)
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
                ...([
                  { op: "local.get", index: L_DATA },
                  { op: "local.get", index: L_I },
                  { op: "array.get_u", typeIdx: strDataTypeIdx },
                  { op: "local.set", index: L_C },
                ] satisfies Instr[]),
                ...emitDigitValue(L_C, L_DIG),
                // invalid digit or >= radix → NaN
                { op: "local.get", index: L_DIG },
                { op: "i32.const", value: 0 },
                { op: "i32.lt_s" },
                { op: "local.get", index: L_DIG },
                { op: "i32.const", value: radix },
                { op: "i32.ge_s" },
                { op: "i32.or" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "f64.const", value: NaN }, { op: "return" }],
                },
                { op: "local.get", index: L_RESULT },
                { op: "f64.const", value: radix },
                { op: "f64.mul" },
                { op: "local.get", index: L_DIG },
                { op: "f64.convert_i32_s" },
                { op: "f64.add" },
                { op: "local.set", index: L_RESULT },
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
        { op: "local.get", index: L_RESULT },
        { op: "return" },
      ],
    },
  ];
  void L_SAW;
  return [
    // guard: NO sign char consumed (sawSign==0) && i+1 < end && data[i]=='0'.
    // (#3570) A NonDecimalIntegerLiteral admits no leading sign, so both
    // '+0x10' and '-0x10' must fall through to the decimal scanner → NaN. The
    // old `sign==1` test let '+' through (it leaves sign=+1); keying on the
    // explicit sawSign flag rejects both signs.
    { op: "local.get", index: L_SAWSIGN },
    { op: "i32.eqz" },
    { op: "local.get", index: L_I },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: L_END },
    { op: "i32.lt_s" },
    { op: "i32.and" },
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "i32.const", value: C_ZERO },
    { op: "i32.eq" },
    { op: "i32.and" },
    // §7.1.4.1 StringToNumber: 0x/0X → hex, 0o/0O → octal, 0b/0B → binary.
    // Each arm re-reads data[i+1] and only acts on its prefix letter, so a
    // non-matching arm is a no-op and control falls through to the next.
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...buildArm(C_LC_X, C_UC_X, 16), ...buildArm(C_LC_O, C_UC_O, 8), ...buildArm(C_LC_B, C_UC_B, 2)],
    },
  ];
}

/** Emit `if (substring starting at i == "Infinity") return sign*Infinity`. */
function emitInfinityCheck(
  L_I: number,
  L_LEN: number,
  L_DATA: number,
  L_C: number,
  L_SIGN: number,
  strDataTypeIdx: number,
): Instr[] {
  const word = "Infinity";
  // The array reads must be guarded by the length check FIRST — Wasm `i32.and`
  // does not short-circuit, so reading data[i+k] before confirming i+8<=len
  // would trap (array OOB). Structure: if (i+8<=len) { chained char compare; if
  // (allMatch) return sign*Infinity }.
  const charChecks: Instr[] = [];
  for (let k = 0; k < word.length; k++) {
    charChecks.push({ op: "local.get", index: L_DATA });
    charChecks.push({ op: "local.get", index: L_I });
    charChecks.push({ op: "i32.const", value: k });
    charChecks.push({ op: "i32.add" });
    charChecks.push({ op: "array.get_u", typeIdx: strDataTypeIdx });
    charChecks.push({ op: "i32.const", value: word.charCodeAt(k) });
    charChecks.push({ op: "i32.eq" });
    if (k > 0) charChecks.push({ op: "i32.and" });
  }
  void L_C;
  return [
    { op: "local.get", index: L_I },
    { op: "i32.const", value: word.length },
    { op: "i32.add" },
    { op: "local.get", index: L_LEN },
    { op: "i32.le_s" }, // i+8 <= len
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...charChecks,
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_SIGN },
            { op: "f64.const", value: Infinity },
            { op: "f64.mul" },
            { op: "return" },
          ],
        },
      ],
    },
  ];
}

/** Scan optional exponent `[eE][+-]?digits`, accumulating into L_EXP / L_EXPSIGN. */
function emitExponent(
  L_I: number,
  L_LEN: number,
  L_DATA: number,
  L_C: number,
  L_EXP: number,
  L_EXPSIGN: number,
  strDataTypeIdx: number,
  getC: Instr[],
): Instr[] {
  return [
    { op: "local.get", index: L_I },
    { op: "local.get", index: L_LEN },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...getC,
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_LC_E },
        { op: "i32.eq" },
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_UC_E },
        { op: "i32.eq" },
        { op: "i32.or" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // tentatively consume 'e'
            { op: "local.get", index: L_I },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: L_I },
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
                    { op: "i32.const", value: -1 },
                    { op: "local.set", index: L_EXPSIGN },
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
            // exponent digits
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
                    { op: "local.get", index: L_DATA },
                    { op: "local.get", index: L_I },
                    { op: "array.get_u", typeIdx: strDataTypeIdx },
                    { op: "local.set", index: L_C },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_ZERO },
                    { op: "i32.lt_s" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_NINE },
                    { op: "i32.gt_s" },
                    { op: "i32.or" },
                    { op: "br_if", depth: 1 },
                    { op: "local.get", index: L_EXP },
                    { op: "i32.const", value: 10 },
                    { op: "i32.mul" },
                    { op: "local.get", index: L_C },
                    { op: "i32.const", value: C_ZERO },
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
        },
      ],
    },
  ];
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
function emitApplyDecimalExp(
  ctx: CodegenContext,
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
  const pow10GlobalIdx = ensurePow10TableGlobal(ctx);
  const pow10ArrTypeIdx = ctx.pow10ArrTypeIdx as number;
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

/**
 * Native `parseInt(s, radix)` — signature `(externref, f64) -> f64`. The radix
 * arg is NaN when omitted (matches the host-import convention). Implements
 * ECMA-262 §19.2.5: trim ws, optional sign, optional 0x prefix (radix 16 /
 * auto), digit loop in radix 2..36, NaN if no digits.
 */
function emitParseInt(ctx: CodegenContext, flattenIdx: number, strTypeIdx: number, strDataTypeIdx: number): void {
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [extern, f64], [f64]);
  const funcIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("parseInt", funcIdx);

  // params: 0 s:externref, 1 radixF:f64
  // locals: 2 flat 3 data 4 len 5 i 6 c 7 sign:f64 8 radix:i32
  //         9 value:f64 10 sawDigit:i32 11 dig:i32
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

  const getC: Instr[] = [
    { op: "local.get", index: L_DATA },
    { op: "local.get", index: L_I },
    { op: "array.get_u", typeIdx: strDataTypeIdx },
    { op: "local.set", index: L_C },
  ];

  const body: Instr[] = [
    ...([
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      { op: "call", funcIdx: flattenIdx },
      { op: "local.set", index: L_FLAT },
    ] satisfies Instr[]),
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

  pushDefinedFunc(ctx, funcIdx, {
    name: "parseInt",
    typeIdx,
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
    ],
    body,
    exported: false,
  });
}

/**
 * Map code unit in L_C to its digit value in L_DIG: '0'-'9' → 0-9,
 * 'A'-'Z'/'a'-'z' → 10-35, else -1.
 */
function emitDigitValue(L_C: number, L_DIG: number): Instr[] {
  return [
    { op: "i32.const", value: -1 },
    { op: "local.set", index: L_DIG },
    // 0-9
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_ZERO },
    { op: "i32.ge_s" },
    { op: "local.get", index: L_C },
    { op: "i32.const", value: C_NINE },
    { op: "i32.le_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_ZERO },
        { op: "i32.sub" },
        { op: "local.set", index: L_DIG },
      ],
      else: [
        // A-Z
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_UC_A },
        { op: "i32.ge_s" },
        { op: "local.get", index: L_C },
        { op: "i32.const", value: C_UC_Z },
        { op: "i32.le_s" },
        { op: "i32.and" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_UC_A - 10 },
            { op: "i32.sub" },
            { op: "local.set", index: L_DIG },
          ],
          else: [
            // a-z
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_LC_A },
            { op: "i32.ge_s" },
            { op: "local.get", index: L_C },
            { op: "i32.const", value: C_LC_Z },
            { op: "i32.le_s" },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: L_C },
                { op: "i32.const", value: C_LC_A - 10 },
                { op: "i32.sub" },
                { op: "local.set", index: L_DIG },
              ],
            },
          ],
        },
      ],
    },
  ];
}
