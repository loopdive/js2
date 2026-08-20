// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-Wasm `Number.prototype.{toString,toFixed,toPrecision,toExponential}` for
 * standalone / WASI targets (#1321 / #1335 / #1759).
 *
 * In JS-host mode these are `env` imports (`number_toFixed` etc.). Under
 * `--target wasi` / `--target standalone` there is no JS runtime, so this
 * module emits WasmGC-native implementations registered under the same
 * `ctx.funcMap` names. The method call sites push `(f64 value, f64 arg)` and
 * expect an `externref` result (a `$NativeString` widened via
 * `extern.convert_any`), so those functions keep that `(f64, f64) -> externref`
 * signature. The default `number_toString(value)` helper uses the one-argument
 * host-import-compatible `(f64) -> externref` signature.
 *
 * Algorithm strategy (no Ryu): the three methods all need a *fixed* number of
 * digits, which is computed with straightforward scaled f64 arithmetic and a
 * decimal digit loop. Non-finite inputs short-circuit to "NaN" / "Infinity" /
 * "-Infinity" per spec ordering (the range check follows the non-finite check
 * in §21.1.3.{2,3,5}).
 *
 * Precision limitation: digit extraction is done in f64, so results are exact
 * to f64 precision (~15-16 significant decimal digits). For requests beyond
 * that — e.g. `(7.7).toFixed(20)` — V8 reveals the *exact* binary value's
 * decimal expansion via bignum arithmetic ("7.70000000000000017764"), whereas
 * this implementation returns the f64-rounded "7.70000000000000000000". The
 * common standalone cases (fractionDigits / precision ≲ 7) are exact; the
 * exact-low-digit behaviour is the deferred Ryu/bignum work tracked in #1335
 * Phase 2. JS-host mode (the dominant test path) is unaffected — it keeps the
 * `number_toFixed` etc. host imports.
 *
 * Spec references:
 * - toString      — ECMA-262 §21.1.3.6, §6.1.6.1.20, §7.1.5
 * - toFixed       — ECMA-262 §21.1.3.3
 * - toPrecision   — ECMA-262 §21.1.3.5
 * - toExponential — ECMA-262 §21.1.3.2
 *
 * Shared layout: each function builds its output into a scratch i16 array
 * (`buf`, capacity 256) with a write cursor (`pos`), then `__num_fmt_finalize`
 * copies the first `pos` code units into a tight `$NativeString` and returns it
 * as `externref`.
 */
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { emitRyuToBuf } from "./number-ryu.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import { emitSelfHostedToStringRadix } from "./number-format-selfhost.js";

const BUF_CAP = 256;
const MAX_SAFE_INTEGER = 9007199254740991;
const C_ZERO = 48; // '0'
const C_MINUS = 45; // '-'
const C_PLUS = 43; // '+'
const C_DOT = 46; // '.'
const C_LC_E = 101; // 'e'

/**
 * #1916 S3 — FIRST STABLE-REGIME PRODUCER. This family mints layout-independent
 * stable handles (`mintDefinedFunc`) instead of live absolute indices: the
 * handles are baked into call immediates and funcMap entries, survive every
 * late-import shift untouched (the shifters skip the stable range), and
 * resolve to concrete indices exactly once, at emit (resolve-layout.ts).
 * Every push below goes through `pushDefinedFunc`, which records the
 * ordinal → position mapping.
 */
function nextFuncIdx(ctx: CodegenContext): number {
  return mintDefinedFunc(ctx);
}

/**
 * Emit the shared `__num_fmt_finalize(buf: i16[], len: i32) -> externref`
 * helper: copies `buf[0..len)` into a tight `$NativeString` and returns the
 * widened externref. Registered idempotently in funcMap.
 */
function emitFinalize(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__num_fmt_finalize");
  if (existing !== undefined) return existing;

  const strTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const extern: ValType = { kind: "externref" };
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

  const typeIdx = addFuncType(ctx, [bufType, i32], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("__num_fmt_finalize", funcIdx);
  const fn: WasmFunction = {
    name: "__num_fmt_finalize",
    typeIdx,
    locals: [
      { name: "out", type: bufType },
      { name: "i", type: i32 },
    ],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  return funcIdx;
}

/**
 * Inline instr sequence: write a single code unit `code` (a constant) into
 * `buf[pos]` then `pos++`. `bufLocal`/`posLocal` are local indices.
 */
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

/**
 * Build the non-finite + sign prologue shared by all three formatters.
 *
 * Emits: if value is NaN → write "NaN", finalize, return. If value is
 * ±Infinity → write "Infinity"/"-Infinity", finalize, return. Otherwise set
 * `negLocal = value < 0` and `absLocal = |value|`.
 *
 * Locals used: `valueLocal` (param f64), `bufLocal` (i16[]), `posLocal` (i32),
 * `tmpLocal` (i32), `negLocal` (i32), `absLocal` (f64).
 */
function emitNonFinitePrologue(
  ctx: CodegenContext,
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

/**
 * Emit a loop that writes the integer part of f64 `intval` (>= 0, already
 * truncated to an integer value) as decimal digits into buf. If `intval` is 0,
 * writes a single '0'. Uses scratch: writes digits least-significant first into
 * a temp region then reverses — implemented here by computing digit count via
 * a first pass.
 *
 * Locals: intLocal(f64 working copy), bufLocal, posLocal, tmpLocal(i32),
 *  dcountLocal(i32), digitLocal(f64 scratch).
 *
 * Strategy: digits are produced most-significant-first by repeatedly dividing
 * by the appropriate power of ten. We find the highest power of ten <= intval,
 * then peel digits down.
 */
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

/**
 * (#3912) Does this module provide the number-format family
 * (`number_toString`, `number_toString_radix`, `number_toFixed`,
 * `number_toPrecision`, `number_toExponential`) as WASM-NATIVE functions rather
 * than as `env.number_*` JS-host imports?
 *
 * ## Why this predicate exists
 *
 * The number-format family and the string family used to be gated on DIFFERENT
 * conditions in `collectPrimitiveMethodImports`'s finalize block: number format
 * on `wasi || standalone`, strings on `nativeStrings`. `fast: true` sets
 * `nativeStrings` (see `create-context.ts`) but neither `wasi` nor `standalone`,
 * so it was the one reachable config that paired a **host** `number_toString`
 * with **native** string helpers. The two disagree about representation — the
 * host import returns a real JS string as an externref, while every native
 * consumer (`__str_concat`, the template compiler, `join`) expects that
 * externref to wrap a `$AnyString`. That mismatch is what made six of nine
 * number→string operations trap at runtime in the whole gc-native lane.
 *
 * Each family's gates were internally consistent, which is why the bug read as
 * fine when inspecting either one alone; it lived *between* the two. Keying both
 * on the same question — "are strings natively represented in this module?" —
 * is what removes the mismatched cell.
 *
 * ## Why the disjunction, and not bare `ctx.nativeStrings`
 *
 * `wasi` / `standalone` normally *imply* `nativeStrings`, but the implication is
 * an `options?.nativeStrings ?? …` default, so a caller can pass
 * `{ standalone: true, nativeStrings: false }` and switch it off. Those targets
 * have no JS host at all, so they must keep the native formatter regardless.
 * Spelling out all three keeps standalone/WASI behaviour byte-identical and adds
 * only the previously-missing `nativeStrings` cell.
 */
export function usesNativeNumberFormat(ctx: CodegenContext): boolean {
  return ctx.wasi || ctx.standalone || ctx.nativeStrings;
}

/**
 * (#4462) IR-facing symbol for the native `Number::toString` in the string
 * carrier the IR actually types. The IR's `<number>.toString()` result is
 * `IrType.string`, which `resolveString()` lowers to `(ref $AnyString)` in every
 * native-string lane — but the native formatter keeps the host-import-compatible
 * `(f64) -> externref` ABI (see this module's header), so calling it directly
 * from the IR would put an `externref` in a `(ref $AnyString)` slot.
 *
 * This callable-provider symbol resolves to the adapter in control modes or
 * directly to the raw formatter when tuned lowering fuses the carrier. Like
 * `stringFromCharCodePlan`, it answers the lane question only in the resolver.
 */
export const IR_NATIVE_NUMBER_TO_STRING_FN = "__ir_number_toString_native";

/**
 * (#4462) `__ir_number_toString_native(n: f64) -> (ref $AnyString)` — the native
 * `number_toString` plus the `any.convert_extern` + `ref.cast $AnyString` unwrap
 * that legacy's `(n).toString()` arm performs inline (`unwrapToNative`,
 * call-receiver-method.ts, #3912). Control modes mint it lazily at callable-
 * provider resolution; `mintDefinedFunc`/`pushDefinedFunc` keep the baked inner
 * index in the late-import shift set. Tuned lowering returns the raw formatter
 * and emits these same two adapter instructions at the semantic call site.
 *
 * Returns null when the lane cannot supply it (no native strings, no
 * `$AnyString` type, or the source scan never registered a formatter) — the
 * caller must treat that as "capability absent" and never claim.
 */
export function ensureIrNativeNumberToString(ctx: CodegenContext, fuseCarrier = false): number | null {
  if (!irNativeNumberToStringAvailable(ctx)) return null;
  // The formatter itself may not exist yet: `emitNativeNumberFormat` is driven
  // by the legacy source scan (`state.primitiveNeeded`), which only fires on a
  // spelled-out `.toString()`. `console.log(<number>)` needs it without any such
  // spelling, so mint on demand — the same lazy call the legacy coercion engine,
  // template compiler and `String(n)` arm already make.
  if (!ctx.funcMap.has("number_toString")) emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const inner = ctx.funcMap.get("number_toString");
  if (inner === undefined || anyStrTypeIdx < 0) return null;
  if (fuseCarrier) return inner;

  const existing = ctx.funcMap.get(IR_NATIVE_NUMBER_TO_STRING_FN);
  if (existing !== undefined) return existing;

  const sigIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "ref", typeIdx: anyStrTypeIdx }]);
  const funcIdx = mintDefinedFunc(ctx);
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: inner },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: anyStrTypeIdx },
  ];
  pushDefinedFunc(ctx, funcIdx, {
    name: IR_NATIVE_NUMBER_TO_STRING_FN,
    typeIdx: sigIdx,
    locals: [],
    body,
    exported: false,
  } as WasmFunction);
  ctx.funcMap.set(IR_NATIVE_NUMBER_TO_STRING_FN, funcIdx);
  return funcIdx;
}

/**
 * (#4462) Is the native `Number::toString` available to the IR in this lane?
 * Read at BOTH the selector boundary (`supportsNumberToString`) and the builder
 * (`nativeNumberToStringAvailable`) so claim and lowering cannot disagree.
 *
 * Deliberately a LANE question, not a `funcMap` lookup. Keying it on "has the
 * formatter been emitted yet" made the claim depend on the legacy source scan
 * having seen a spelled-out `.toString()` somewhere in the file — so
 * `console.log(<number>)` in a file with no other `.toString()` claimed at
 * selection (which does not consult this) and then demoted post-claim at build.
 * Both lanes that answer true here can mint the formatter on demand.
 */
export function irNativeNumberToStringAvailable(ctx: CodegenContext): boolean {
  return ctx.nativeStrings && usesNativeNumberFormat(ctx);
}

/** Native `toFixed` uses the same carrier and number-format substrate. */
export const irNativeNumberToFixedAvailable = irNativeNumberToStringAvailable;

/**
 * Emit native number-format functions and register them in `ctx.funcMap`.
 * `which` is a subset of {number_toString, number_toString_radix,
 * number_toFixed, number_toPrecision, number_toExponential}. Must run before
 * any function bodies that call them, and (via ensureNativeStringHelpers) sets
 * up the NativeString types.
 */
export function emitNativeNumberFormat(ctx: CodegenContext, which: Set<string>): void {
  ensureNativeStringHelpers(ctx);
  const finalizeIdx = emitFinalize(ctx);
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };
  const bufType: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  const needRadix = which.has("number_toString") || which.has("number_toString_radix");
  if (needRadix && !ctx.funcMap.has("number_toString_radix")) {
    // (#3305) SELF-HOSTED: TS source in src/stdlib/number-format.ts compiled
    // through the compiler's own IR pipeline; legacy (f64,f64)->externref ABI
    // preserved by a thunk. See number-format-selfhost.ts.
    emitSelfHostedToStringRadix(ctx);
  }
  // number_toFixed needs number_toString for its |x| >= 1e21 branch (§21.1.3.3
  // step 5 defers to ToString there), so emit it whenever toFixed/toPrecision is
  // requested even if the program never calls .toString() directly.
  const needPrecision = which.has("number_toPrecision");
  const needFixed = which.has("number_toFixed") || needPrecision;
  if ((which.has("number_toString") || needFixed) && !ctx.funcMap.has("number_toString")) {
    emitToString(ctx, strDataTypeIdx, i32, f64, extern, bufType);
  }

  // number_toPrecision delegates to number_toFixed + number_toExponential, so
  // those two must be emitted whenever toPrecision is requested — even if the
  // program never calls them directly.
  const needExp = which.has("number_toExponential") || needPrecision;

  if (needFixed && !ctx.funcMap.has("number_toFixed")) {
    emitToFixed(ctx, finalizeIdx, strDataTypeIdx, i32, f64, extern, bufType);
  }
  if (needExp && !ctx.funcMap.has("number_toExponential")) {
    emitToExponential(ctx, finalizeIdx, strDataTypeIdx, i32, f64, extern, bufType);
  }
  if (needPrecision && !ctx.funcMap.has("number_toPrecision")) {
    emitToPrecision(ctx, finalizeIdx, strDataTypeIdx, i32, f64, extern, bufType);
  }
}

/**
 * `number_toString(value: f64) -> externref`
 *
 * Host-compatible default radix-10 Number::toString for standalone/WASI. Safe
 * integers delegate to the radix-10 formatter; every other finite value goes
 * through the shortest-roundtrip Ryū formatter `__num_ryu_to_buf` (#1537),
 * which produces the exact §6.1.6.1.13 string (fixed or `d.dddde±N`) without any
 * JS host bridge.
 */
function emitToString(
  ctx: CodegenContext,
  strDataTypeIdx: number,
  i32: ValType,
  f64: ValType,
  extern: ValType,
  bufType: ValType,
): void {
  const radixIdx = ctx.funcMap.get("number_toString_radix");
  if (radixIdx === undefined) return;
  const finalizeIdx = ctx.funcMap.get("__num_fmt_finalize");
  if (finalizeIdx === undefined) return;
  // #1537: shortest-roundtrip Ryū formatter for the fractional / unsafe branch.
  const ryuToBufIdx = emitRyuToBuf(ctx, strDataTypeIdx);

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
  const integerBeforeScratch = process.env.JS2WASM_NUMBER_TO_STRING_INTEGER_FASTPATH !== "0";

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
    ...emitNonFinitePrologue(ctx, finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),

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

  const typeIdx = addFuncType(ctx, [f64], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toString", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "number_toString",
    typeIdx,
    locals: [
      { name: "buf", type: bufType },
      { name: "pos", type: i32 },
      { name: "tmp", type: i32 },
      { name: "neg", type: i32 },
      { name: "abs", type: f64 },
    ],
    body,
    exported: false,
  });
}

/**
 * `number_toFixed(value: f64, digits: f64) -> externref` (§21.1.3.3).
 * Fixed-point with `digits` fractional places (0..100), round-half-away.
 * For |value| >= 1e21 falls back to integer rendering (toString-style); the
 * spec also defers to ToString there, and the integer path produces the same
 * leading digits.
 */
function emitToFixed(
  ctx: CodegenContext,
  finalizeIdx: number,
  strDataTypeIdx: number,
  i32: ValType,
  f64: ValType,
  extern: ValType,
  bufType: ValType,
): void {
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
  const numToStrIdx = ctx.funcMap.get("number_toString");
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
    ...emitNonFinitePrologue(ctx, finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),
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

  const typeIdx = addFuncType(ctx, [f64, f64], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toFixed", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "number_toFixed",
    typeIdx,
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
    exported: false,
  });
}

/**
 * `number_toExponential(value: f64, digits: f64) -> externref` (§21.1.3.2).
 * `digits` is fractional digits after the leading digit. NaN sentinel (digits
 * != digits) means "no argument" → use as-many-digits-as-needed; we render the
 * shortest representation that round-trips is out of scope, so for the no-arg
 * case we default to up to 6 fractional digits trimmed of trailing zeros (good
 * enough for standalone output; exact-arg case is precise).
 */
function emitToExponential(
  ctx: CodegenContext,
  finalizeIdx: number,
  strDataTypeIdx: number,
  i32: ValType,
  f64: ValType,
  extern: ValType,
  bufType: ValType,
): void {
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
    ...emitNonFinitePrologue(ctx, finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),
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

  const typeIdx = addFuncType(ctx, [f64, f64], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toExponential", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "number_toExponential",
    typeIdx,
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
    exported: false,
  });
}

/**
 * `number_toPrecision(value: f64, precision: f64) -> externref` (§21.1.3.5).
 * NaN sentinel (precision != precision) means "no argument" → behaves like
 * toString. We implement the no-arg case by delegating to a toFixed-style
 * render with enough fractional digits; the with-arg case formats `precision`
 * significant digits, choosing fixed or exponential notation per spec
 * (exponent < -6 or >= precision → exponential).
 */
function emitToPrecision(
  ctx: CodegenContext,
  finalizeIdx: number,
  strDataTypeIdx: number,
  i32: ValType,
  f64: ValType,
  extern: ValType,
  bufType: ValType,
): void {
  // We reduce toPrecision to: compute decimal exponent e of value, then
  // significant digits = precision. If -6 <= e < precision, render fixed with
  // (precision-1-e) fractional digits. Else render exponential with
  // (precision-1) fractional digits. We delegate the actual rendering to the
  // already-emitted number_toFixed / number_toExponential helpers.
  const toFixedIdx = ctx.funcMap.get("number_toFixed");
  const toExpIdx = ctx.funcMap.get("number_toExponential");

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
    ...emitNonFinitePrologue(ctx, finalizeIdx, strDataTypeIdx, L_VALUE, L_BUF, L_POS, L_TMP, L_NEG, L_ABS),
    // noarg = precision != precision
    { op: "local.get", index: L_PRECISION },
    { op: "local.get", index: L_PRECISION },
    { op: "f64.ne" },
    { op: "local.set", index: L_NOARG },
    // if noarg: return number_toFixed-style? toString semantics differ, but for
    // standalone output we approximate via toExponential no-arg (NaN sentinel).
    { op: "local.get", index: L_NOARG },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // delegate to toExponential(value, NaN) — close enough for no-arg output
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

  const typeIdx = addFuncType(ctx, [f64, f64], [extern]);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toPrecision", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "number_toPrecision",
    typeIdx,
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
    exported: false,
  });
}
