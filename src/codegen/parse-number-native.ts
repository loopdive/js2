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
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import { registerEmitNativeParseNumber } from "./registry/parse-number-delegates.js";
import {
  buildDecimalPowerArrayType,
  buildDecimalPowerArrayInitializer,
  buildApplyDecimalExp,
} from "../runtime/wasmgc/values/decimal-scale-bodies.js";
import {
  buildStringToNumberPrelude,
  buildStringToNumberResult,
  buildStringToNumberLocals,
} from "../runtime/wasmgc/values/string-number-bodies.js";
import {
  C_TAB,
  C_LF,
  C_VT,
  C_FF,
  C_CR,
  C_SPACE,
  C_NBSP,
  C_OGHAM_SP,
  C_ENQUAD,
  C_HAIR_SP,
  C_LS,
  C_PS,
  C_NNBSP,
  C_MMSP,
  C_IDEO_SP,
  C_BOM,
  C_PLUS,
  C_MINUS,
  C_DOT,
  C_ZERO,
  C_NINE,
  C_UC_A,
  C_UC_B,
  C_UC_E,
  C_UC_O,
  C_UC_X,
  C_UC_Z,
  C_LC_A,
  C_LC_B,
  C_LC_E,
  C_LC_O,
  C_LC_X,
  C_LC_Z,
  isWsBody,
  emitInfinityCheck,
  emitExponent,
  emitDigitValue,
} from "../runtime/wasmgc/values/string-number-grammar.js";

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
    ctx.mod.types.push(buildDecimalPowerArrayType());
    ctx.pow10ArrTypeIdx = arrTypeIdx;
  }

  const init = buildDecimalPowerArrayInitializer(arrTypeIdx);

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

registerEmitNativeParseNumber(emitNativeParseNumber);

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
  const layout = {
    nativeStrDataTypeIdx: strDataTypeIdx,
    anyStrTypeIdx: ctx.anyStrTypeIdx,
    nativeStrTypeIdx: strTypeIdx,
    consStrTypeIdx: ctx.consStrTypeIdx,
    hashedStrTypeIdx: ctx.hashedStrTypeIdx,
    utf8StrDataTypeIdx: ctx.utf8StrDataTypeIdx,
    utf8StrTypeIdx: ctx.utf8StrTypeIdx,
  };
  const body: Instr[] = [
    ...buildStringToNumberPrelude(layout, flattenIdx),
    ...buildStringToNumberResult({
      globalIndex: ensurePow10TableGlobal(ctx),
      arrayTypeIndex: ctx.pow10ArrTypeIdx as number,
    }),
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name: "__str_to_number",
    typeIdx,
    locals: buildStringToNumberLocals(layout),
    body,
    exported: false,
  });
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
  return buildApplyDecimalExp(
    { arrayTypeIndex: pow10ArrTypeIdx, globalIndex: pow10GlobalIdx },
    L_SIGN,
    L_MANT,
    L_FRACCOUNT,
    L_INTDROP,
    L_EXP,
    L_EXPSIGN,
    L_TEXP,
    L_POW,
    L_RESULT,
  );
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
