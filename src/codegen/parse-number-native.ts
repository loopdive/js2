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
import {
  ANY_TO_STRING_HELPER,
  EXTERN_TO_STRING_HELPER,
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
} from "./native-strings.js";
import { addFuncType } from "./registry/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S3b) stable-regime minting
import { buildParseFloatDefinition, buildParseIntDefinition } from "../runtime/wasmgc/values/parse-number-bodies.js";
import { registerEmitNativeParseNumber } from "./registry/parse-number-delegates.js";
import { ensureSpecExternrefToStringProvider } from "./coercion-engine.js";
import {
  buildDecimalPowerArrayType,
  buildDecimalPowerArrayInitializer,
} from "../runtime/wasmgc/values/decimal-scale-bodies.js";
import {
  buildStringToNumberPrelude,
  buildStringToNumberResult,
  buildStringToNumberLocals,
} from "../runtime/wasmgc/values/string-number-bodies.js";

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
 * (#6969) Non-string ToString arms of the parse natives, filled at finalize by
 * {@link fillParseNumberToStringArms}. Each entry is the (initially
 * `unreachable`) `else` arm of a native's prologue plus the `anyref` scratch
 * local holding the argument.
 */
const pendingToStringArms = new WeakMap<CodegenContext, { arm: Instr[]; anyLocal: number }[]>();

/**
 * Push the instructions that take the `externref` param 0 and leave a flat
 * `$NativeString` ref. ECMA-262 §19.2.4 / §19.2.5 step 1 is `ToString(string)`:
 * a string argument takes the `ref.test` fast path; anything else (a boxed
 * number held as externref — `F.parseUInt = function (y) { return parseInt(y) }`
 * — `undefined`, `null`, an object) goes through the arm
 * {@link fillParseNumberToStringArms} fills. It cannot be filled here: these
 * natives are minted at import collection, before the object runtime (and so
 * `__to_primitive` / `__extern_toString`) exists, and building the module-wide
 * cached `__any_to_string` that early would bake it without its object arms.
 */
function externToFlat(ctx: CodegenContext, flattenIdx: number, anyLocal: number): Instr[] {
  const arm: Instr[] = [{ op: "unreachable" }];
  let arms = pendingToStringArms.get(ctx);
  if (!arms) pendingToStringArms.set(ctx, (arms = []));
  arms.push({ arm, anyLocal });
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref", typeIdx: ctx.anyStrTypeIdx } },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
      ],
      else: arm,
    },
    { op: "call", funcIdx: flattenIdx },
  ];
}

/**
 * (#6969) Finalize-time fill of the parse natives' ToString arms (see
 * {@link externToFlat}). Prefers the object runtime's `__extern_toString`
 * (ToString ∘ ToPrimitive, so `parseInt({ valueOf() {…} })` and arrays are
 * spec-correct); without an object runtime, a standalone/WASI module builds
 * `__any_to_string` now, when every dependency it captures exists. A module
 * that never emitted `parseInt`/`parseFloat` returns immediately (byte-identical).
 */
export function fillParseNumberToStringArms(ctx: CodegenContext): void {
  const arms = pendingToStringArms.get(ctx);
  if (!arms || arms.length === 0) return;
  pendingToStringArms.delete(ctx);
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const externToStringIdx = ctx.funcMap.get(EXTERN_TO_STRING_HELPER);
  let convert: Instr[] | undefined;
  if (externToStringIdx !== undefined && definedFuncAt(ctx, externToStringIdx) !== undefined) {
    // Abstract ToString throws a TypeError for a Symbol (input, wrapper, or
    // ToPrimitive result); `__extern_toString` renders one, as `String(sym)` must.
    const toStringIdx = ensureSpecExternrefToStringProvider(ctx, null) ?? externToStringIdx;
    convert = [
      { op: "extern.convert_any" },
      { op: "call", funcIdx: toStringIdx },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
    ];
  } else {
    const anyToStringIdx = ctx.nativeStrHelpers.get(ANY_TO_STRING_HELPER) ?? ensureAnyToStringHelper(ctx);
    if (anyToStringIdx !== undefined) convert = [{ op: "call", funcIdx: anyToStringIdx }];
  }
  if (!convert) return; // host-backed lane without a native ToString: keep the trap
  for (const { arm, anyLocal } of arms) {
    arm.splice(0, arm.length, { op: "local.get", index: anyLocal }, ...convert);
  }
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

  if (which.has("parseFloat") && !ctx.funcMap.has("parseFloat")) {
    emitParseFloat(ctx, flattenIdx, strTypeIdx, strDataTypeIdx);
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

/** Native `parseFloat(s)` — signature `(externref) -> f64`, ECMA-262 §19.2.4. */
function emitParseFloat(ctx: CodegenContext, flattenIdx: number, strTypeIdx: number, strDataTypeIdx: number): void {
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };
  // (externref) -> f64
  const typeIdx = addFuncType(ctx, [extern], [f64]);
  const funcIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("parseFloat", funcIdx);

  const { locals, body } = buildParseFloatDefinition({
    nativeStrTypeIdx: strTypeIdx,
    nativeStrDataTypeIdx: strDataTypeIdx,
    flatString: (argLocal) => externToFlat(ctx, flattenIdx, argLocal),
    powerResources: { globalIndex: ensurePow10TableGlobal(ctx), arrayTypeIndex: ctx.pow10ArrTypeIdx as number },
  });
  pushDefinedFunc(ctx, funcIdx, {
    name: "parseFloat",
    typeIdx,
    locals,
    body,
    exported: false,
  });
}

/**
 * Native `parseInt(s, radix)` — signature `(externref, f64) -> f64`. The radix
 * arg is NaN when omitted (matches the host-import convention). Implements
 * ECMA-262 §19.2.5: trim ws, optional sign, optional 0x prefix (radix 16 /
 * auto), digit loop in radix 2..36, NaN if no digits.
 */
function emitParseInt(ctx: CodegenContext, flattenIdx: number, strTypeIdx: number, strDataTypeIdx: number): void {
  const f64: ValType = { kind: "f64" };
  const extern: ValType = { kind: "externref" };
  const typeIdx = addFuncType(ctx, [extern, f64], [f64]);
  const funcIdx = mintDefinedFunc(ctx); // (#1916 S3b) stable-regime handle
  ctx.funcMap.set("parseInt", funcIdx);

  const { locals, body } = buildParseIntDefinition({
    nativeStrTypeIdx: strTypeIdx,
    nativeStrDataTypeIdx: strDataTypeIdx,
    flatString: (argLocal) => externToFlat(ctx, flattenIdx, argLocal),
  });
  pushDefinedFunc(ctx, funcIdx, {
    name: "parseInt",
    typeIdx,
    locals,
    body,
    exported: false,
  });
}
