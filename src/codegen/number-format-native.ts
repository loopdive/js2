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
import type { ValType, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureNativeStringHelpers } from "./native-strings.js";
import { emitRyuToBuf } from "./number-ryu.js";
import { addFuncType } from "./registry/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3) stable-regime minting
import { emitSelfHostedToStringRadix } from "./number-format-selfhost.js";
import { ensureLateImport } from "./shared.js";

import {
  buildNumberFormatFinalizeBody,
  buildNumberFormatToStringBody,
  buildNumberFormatToFixedBody,
  buildNumberFormatToExponentialBody,
  buildNumberFormatToPrecisionBody,
  buildNumberFormatNativeAdapterBody,
  numberFormatSignatures,
} from "../runtime/wasmgc/values/number-format-bodies.js";
import type { NumberFormatStringTypes } from "../runtime/wasmgc/values/number-format-radix-bodies.js";

function numberFormatTypes(ctx: CodegenContext): NumberFormatStringTypes {
  return {
    dataTypeIdx: ctx.nativeStrDataTypeIdx,
    nativeStringTypeIdx: ctx.nativeStrTypeIdx,
    anyStringTypeIdx: ctx.anyStrTypeIdx,
  };
}

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
  const types = numberFormatTypes(ctx);
  const built = buildNumberFormatFinalizeBody(types);
  const signature = numberFormatSignatures<ValType>({
    data: { kind: "ref", typeIdx: types.dataTypeIdx },
    nullableData: { kind: "ref_null", typeIdx: types.dataTypeIdx },
    anyString: { kind: "ref", typeIdx: types.anyStringTypeIdx },
  }).finalize;
  const typeIdx = addFuncType(ctx, signature.params, signature.results);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("__num_fmt_finalize", funcIdx);
  const fn: WasmFunction = {
    name: "__num_fmt_finalize",
    typeIdx,
    locals: built.locals,
    body: built.body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  return funcIdx;
}

/**
 * Inline instr sequence: write a single code unit `code` (a constant) into
 * `buf[pos]` then `pos++`. `bufLocal`/`posLocal` are local indices.
 */

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

  const signature = numberFormatSignatures<ValType>({
    data: { kind: "ref", typeIdx: ctx.nativeStrDataTypeIdx },
    nullableData: { kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx },
    anyString: { kind: "ref", typeIdx: anyStrTypeIdx },
  }).nativeToString;
  const sigIdx = addFuncType(ctx, signature.params, signature.results);
  const funcIdx = mintDefinedFunc(ctx);
  const { body } = buildNumberFormatNativeAdapterBody({ toString: inner, anyStringTypeIdx: anyStrTypeIdx });
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
  // #2527 / #2514 — an explicitly linked runtime owns the formatter family.
  // Keep the ABI identical to the historical helpers (`externref` results)
  // so native-string call sites can continue to perform their existing
  // `any.convert_extern` + `ref.cast $AnyString` recovery. This is deliberately
  // opt-in: without a declared provider we retain the in-module implementation
  // and never emit an unsatisfied runtime import by default.
  if (ctx.linkedNamespaces.has("js2wasm:runtime")) {
    emitLinkedNumberFormatImports(ctx, which);
    return;
  }
  ensureNativeStringHelpers(ctx);
  const finalizeIdx = emitFinalize(ctx);
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };
  const bufType: ValType = { kind: "ref", typeIdx: strDataTypeIdx };

  // number_toFixed needs number_toString for its |x| >= 1e21 branch (§21.1.3.3
  // step 5 defers to ToString there), so emit it whenever toFixed/toPrecision is
  // requested even if the program never calls .toString() directly.
  const needPrecision = which.has("number_toPrecision");
  const needFixed = which.has("number_toFixed") || needPrecision;
  // …and `number_toString` in turn BAILS OUT when `number_toString_radix` is
  // absent (it delegates the safe-integer regime to it), so the radix helper has
  // to ride along on `needFixed` too. Omitting that link is what made a module
  // whose only number formatting was `x.toPrecision()` silently ship WITHOUT
  // `number_toString`: `emitToString` returned early, and both the toFixed
  // >= 1e21 branch and the toPrecision no-arg branch then fell back to their
  // approximations — `(123.456).toPrecision()` rendered "1.234560e+2".
  const needRadix = which.has("number_toString") || which.has("number_toString_radix") || needFixed;
  if (needRadix && !ctx.funcMap.has("number_toString_radix")) {
    // (#3305) SELF-HOSTED: TS source in src/stdlib/number-format.ts compiled
    // through the compiler's own IR pipeline; legacy (f64,f64)->externref ABI
    // preserved by a thunk. See number-format-selfhost.ts.
    emitSelfHostedToStringRadix(ctx);
  }
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

/** Register the complete dependency closure for the linkable runtime ABI. */
function emitLinkedNumberFormatImports(ctx: CodegenContext, which: Set<string>): void {
  const extern: ValType = { kind: "externref" };
  const f64: ValType = { kind: "f64" };
  const runtime = "js2wasm:runtime";
  const importFn = (name: string, params: ValType[]): void => {
    ensureLateImport(ctx, name, params, [extern], runtime);
  };

  const needPrecision = which.has("number_toPrecision");
  const needFixed = which.has("number_toFixed") || needPrecision;
  const needExponential = which.has("number_toExponential") || needPrecision;
  // Same dependency closure as the native emitter above: number_toString rides
  // on needFixed, and number_toString_radix rides on number_toString.
  const needRadix = which.has("number_toString") || which.has("number_toString_radix") || needFixed;

  // The provider's fixed/precision implementations delegate through these
  // same named helpers, so retain the dependency closure rather than relying
  // on the consumer's source-level call set.
  if (needRadix) importFn("number_toString_radix", [f64, f64]);
  if (which.has("number_toString") || needFixed) importFn("number_toString", [f64]);
  if (needFixed) importFn("number_toFixed", [f64, f64]);
  if (needExponential) importFn("number_toExponential", [f64, f64]);
  if (needPrecision) importFn("number_toPrecision", [f64, f64]);
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

  const types = numberFormatTypes(ctx);
  const signature = numberFormatSignatures<ValType>({
    data: bufType,
    nullableData: { kind: "ref_null", typeIdx: strDataTypeIdx },
    anyString: { kind: "ref", typeIdx: ctx.anyStrTypeIdx },
  }).toString;
  const built = buildNumberFormatToStringBody({
    types,
    finalize: finalizeIdx,
    radix: radixIdx,
    ryuToBuffer: ryuToBufIdx,
    integerBeforeScratch: process.env.JS2WASM_NUMBER_TO_STRING_INTEGER_FASTPATH !== "0",
  });
  const typeIdx = addFuncType(ctx, signature.params, signature.results);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toString", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "number_toString",
    typeIdx,
    locals: built.locals,
    body: built.body,
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
  const types = numberFormatTypes(ctx);
  const signature = numberFormatSignatures<ValType>({
    data: bufType,
    nullableData: { kind: "ref_null", typeIdx: strDataTypeIdx },
    anyString: { kind: "ref", typeIdx: ctx.anyStrTypeIdx },
  }).withDigits;
  const built = buildNumberFormatToFixedBody({
    types,
    finalize: finalizeIdx,
    toString: ctx.funcMap.get("number_toString"),
  });
  const typeIdx = addFuncType(ctx, signature.params, signature.results);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toFixed", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "number_toFixed",
    typeIdx,
    locals: built.locals,
    body: built.body,
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
  const types = numberFormatTypes(ctx);
  const signature = numberFormatSignatures<ValType>({
    data: bufType,
    nullableData: { kind: "ref_null", typeIdx: strDataTypeIdx },
    anyString: { kind: "ref", typeIdx: ctx.anyStrTypeIdx },
  }).withDigits;
  const built = buildNumberFormatToExponentialBody({ types, finalize: finalizeIdx });
  const typeIdx = addFuncType(ctx, signature.params, signature.results);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toExponential", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "number_toExponential",
    typeIdx,
    locals: built.locals,
    body: built.body,
    exported: false,
  });
}

/**
 * `number_toPrecision(value: f64, precision: f64) -> externref` (§21.1.3.5).
 * NaN sentinel (precision != precision) means "no argument", which §21.1.3.5
 * step 2 defines as `return ! ToString(x)` — so the no-arg case delegates to
 * `number_toString`, the same Number::toString this lane uses everywhere else.
 * The with-arg case formats `precision` significant digits, choosing fixed or
 * exponential notation per spec (exponent < -6 or >= precision → exponential).
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
  const types = numberFormatTypes(ctx);
  const signature = numberFormatSignatures<ValType>({
    data: bufType,
    nullableData: { kind: "ref_null", typeIdx: strDataTypeIdx },
    anyString: { kind: "ref", typeIdx: ctx.anyStrTypeIdx },
  }).withDigits;
  const built = buildNumberFormatToPrecisionBody({
    types,
    finalize: finalizeIdx,
    toFixed: ctx.funcMap.get("number_toFixed"),
    toExponential: ctx.funcMap.get("number_toExponential"),
    toString: ctx.funcMap.get("number_toString"),
  });
  const typeIdx = addFuncType(ctx, signature.params, signature.results);
  const funcIdx = nextFuncIdx(ctx);
  ctx.funcMap.set("number_toPrecision", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "number_toPrecision",
    typeIdx,
    locals: built.locals,
    body: built.body,
    exported: false,
  });
}
