// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4220) Native body for a reflective `String.prototype.split` closure in
 * `--target standalone`.
 *
 * The DIRECT call path (`"a,b".split(",")`, `string-ops.ts`) has been native
 * for a long time; what was missing is the **transferred/borrowed** form the
 * ES5 sputnik battery exercises almost exclusively:
 *
 * ```js
 * Number.prototype.split = String.prototype.split;
 * (100111122133144155).split(1, 2);   // → ["", "00"]
 * ```
 *
 * That reaches the `native-proto.ts` closure factory, whose String glue
 * (`array-object-proto.ts`) had no `split` arm — so the member fell through to
 * `emitProtoMemberBodyRefusal` and threw
 * `String.prototype.split is not yet implemented in --target standalone`.
 *
 * This module supplies the missing arm. It reuses the existing pure-WasmGC
 * `__str_split` kernel (`native-strings-split.ts`) and adds only the §22.1.3.23
 * preamble the reflective ABI needs: RequireObjectCoercible, ToString(this),
 * ToUint32(limit), ToString(separator), and the two early-out array shapes.
 *
 * Lives in its own module rather than in `array-object-proto.ts` for the same
 * reason `string-proto-substring.ts` and `char-at-transfer.ts` do: the
 * dispatcher stays a dispatcher, and the LOC/function budget gates keep growth
 * in the cohesive sibling.
 *
 * ## Deliberately NOT handled: a RegExp separator
 *
 * §22.1.3.23 step 2 dispatches to `separator[@@split]` when the separator is an
 * object carrying it — i.e. a RegExp. The standalone RegExp engine
 * (`regexp-standalone.ts`) is reachable from the DIRECT path only, and only for
 * a *statically known, backend-created* pattern (`tryCompileStandaloneString-
 * Split`): it compiles the pattern to a matcher at COMPILE time. A reflective
 * closure receives its separator as a runtime `externref`, so there is no
 * static pattern to compile and no runtime interpreter to fall back on. A
 * RegExp separator therefore keeps flowing into ToString(separator) here, which
 * is the pre-existing behaviour of every other reflective String member with a
 * search-value argument (see the `emitStringSearchBooleanMemberBody` "known
 * spec gap" note). Wiring it properly needs a runtime regexp interpreter, which
 * is a separate work item.
 */

import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { ensureExternrefToNumberProvider, getToPrimitiveProvider } from "./coercion-engine.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
  flatStringType,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { emitStringProtoToStringFlat } from "./string-proto-tostring.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import { flushLateImportShifts } from "./shared.js";
import { ensureVecConstructorCarrier } from "./vec-constructor-carrier.js";

/** `__str_split`'s "no limit" sentinel — 0xFFFFFFFF read as a signed i32. */
const NO_LIMIT = -1;

/**
 * Push `1` when the closure param at `paramIdx` holds `undefined`.
 *
 * The reflective ABI pads an omitted trailing argument with `ref.null.extern`,
 * while the #2106 standalone regime represents a written `undefined` as a
 * DISTINCT non-null sentinel externref — so both spellings must be recognized
 * or `x.split(",", undefined)` (§22.1.3.23 step 4's "limit is undefined" arm)
 * silently becomes `ToUint32(undefined)` = 0 and truncates the result to `[]`.
 */
function pushIsUndefined(ctx: CodegenContext, sink: Instr[], paramIdx: number): void {
  sink.push({ op: "local.get", index: paramIdx }, { op: "ref.is_null" });
  const isUndefIdx = undefinedSingletonActive(ctx) ? ctx.funcMap.get("__extern_is_undefined") : undefined;
  if (isUndefIdx !== undefined) {
    sink.push({ op: "local.get", index: paramIdx }, { op: "call", funcIdx: isUndefIdx }, { op: "i32.or" });
  }
}

/**
 * §22.1.3.23 step 1 — `? RequireObjectCoercible(this)`: throw a *catchable*
 * TypeError (never a `ref.cast` trap) when `this` is null or undefined.
 */
function emitRequireObjectCoercible(ctx: CodegenContext, fctx: FunctionContext): void {
  const rocThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, rocThrow, "String.prototype.split called on null or undefined");
  pushIsUndefined(ctx, fctx.body, 1);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: rocThrow });
}

/**
 * §7.1.7 ToUint32 of the f64 in `scratch`, leaving the i32 result on the stack.
 *
 * Inlined rather than routed through the module-level `__toUint32` helper
 * (`codegen/index.ts`) because that helper is minted at a fixed point in
 * finalize, gated on `ctx.needsToUint32` — a reflective closure body is emitted
 * lazily during expression compilation, long before it exists.
 *
 * The arithmetic is the same sequence `__toUint32` uses: NaN and ±∞ map to 0,
 * everything else truncates toward zero (`i64.trunc_sat_f64_s`) and keeps the
 * low 32 bits (`i32.wrap_i64` = modulo 2^32). That makes `ToUint32(2**32 - 1)`
 * land on `0xFFFFFFFF`, which is `__str_split`'s own "no limit" encoding — so
 * the `Math.pow(2,32)-1` cases and an absent limit take the same unbounded
 * path, as the spec intends.
 */
function toUint32Instrs(scratch: number): Instr[] {
  return [
    { op: "local.get", index: scratch },
    { op: "local.get", index: scratch },
    { op: "f64.ne" }, // x !== x  ⇔  NaN
    { op: "local.get", index: scratch },
    { op: "f64.abs" },
    { op: "f64.const", value: Number.POSITIVE_INFINITY },
    { op: "f64.eq" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [{ op: "local.get", index: scratch }, { op: "i64.trunc_sat_f64_s" }, { op: "i32.wrap_i64" }],
    },
  ];
}

/**
 * Native body for a reflective `String.prototype.split(separator, limit)`
 * closure. Closure ABI: `this` = param 1, separator = param 2, limit = param 3
 * (`split` is spec arity 2, so both arg slots exist).
 *
 * Emits §22.1.3.23 in spec order, which the sputnik battery observes directly
 * (`separator-override-tostring-throws-limit-override-valueof-throws.js` asserts
 * the *limit*'s `valueOf` runs before the *separator*'s `toString`):
 *
 *   1. `? RequireObjectCoercible(this)`
 *   3. `S = ? ToString(this)`
 *   4. `lim` = `limit` is undefined ? 2^32-1 : `ℝ(? ToUint32(limit))`
 *   5. `R = ? ToString(separator)`
 *   6. `lim = 0` → `[]`
 *   7. `separator` is undefined → `[S]`
 *   8+. the native `__str_split` kernel (empty-separator → per-code-unit split,
 *      limit capping, and the ordinary scan all live there already)
 *
 * Step 5 is emitted unconditionally even though steps 6/7 may discard `R`: the
 * only separator values that reach it without being consumed are `undefined`
 * and any value under a zero limit, and `ToString` of a value whose ToPrimitive
 * runs user code is exactly the observable the spec wants evaluated there.
 *
 * Returns externref — the uniform closure result type — carrying the same
 * native string vec the direct path produces, so `.constructor`/`.length`/
 * element reads resolve through the existing boxed-vec surface.
 */
export function emitStringSplitMemberBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  ensureNativeStringHelpers(ctx);
  ensureObjectRuntime(ctx); // registers `__extern_is_undefined`
  if (undefinedSingletonActive(ctx)) flushLateImportShifts(ctx, fctx);

  // (1) Every late-import adder runs FIRST and flushes, so each helper funcIdx
  // fetched BY NAME below is post-shift-correct (the discipline every sibling
  // reflective body follows — see emitStringSearchNumericMemberBody).
  //
  // The result is an ARRAY reaching the caller as an `externref`, so every
  // property read on it goes through the dynamic `__extern_get` native. Demand
  // the runtime `.constructor` carrier here — `__split.constructor === Array`
  // is asserted by essentially the whole ES5 split battery, and without the
  // carrier the finalize-time vec arm is not installed and the read answers
  // `undefined`. Minting is idempotent and must precede the funcIdx captures
  // below (it can register late imports of its own).
  ensureVecConstructorCarrier(ctx);
  const unboxIdx = ensureExternrefToNumberProvider(ctx, fctx);

  // (2) Helper funcIdxs, after the shifts.
  const anyToStrIdx = ensureAnyToStringHelper(ctx);
  const toPrimitiveIdx = getToPrimitiveProvider(ctx);
  const flattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const splitIdx = ctx.nativeStrHelpers.get("__str_split");
  if (
    unboxIdx === undefined ||
    toPrimitiveIdx === undefined ||
    flattenIdx === undefined ||
    splitIdx === undefined ||
    ctx.anyStrTypeIdx < 0
  ) {
    return null; // caller falls through to its refusal body
  }
  addStringConstantGlobal(ctx, "number");

  // The result array type: the SAME `$vec_nstr` shape `__str_split` returns and
  // the direct path hands back, so both lanes produce one array representation.
  const elemType: ValType = { kind: "ref_null", typeIdx: ctx.anyStrTypeIdx };
  const vecTypeIdx = getOrRegisterVecType(ctx, `ref_${ctx.anyStrTypeIdx}`, elemType);
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
  const vecRef: ValType = { kind: "ref", typeIdx: vecTypeIdx };

  // Step 1.
  emitRequireObjectCoercible(ctx, fctx);

  // Step 3: S = ? ToString(this), flattened.
  emitStringProtoToStringFlat(ctx, fctx, 1, anyToStrIdx, flattenIdx);
  const sLocal = allocLocal(fctx, `__split_s_${fctx.locals.length}`, flatStringType(ctx));
  fctx.body.push({ op: "local.set", index: sLocal });

  // Step 4: lim. `undefined` (absent OR written) ⇒ unbounded; otherwise
  // ToUint32(? ToNumber(limit)).
  //
  // ToNumber of an OBJECT is `ToPrimitive(input, number)` first (§7.1.4 →
  // §7.1.1), which is what consults `valueOf`. `__unbox_number` alone answers
  // NaN for an object without ever calling it — so `x.split(o1, {valueOf(){
  // throw "intoint" }})` would silently take the lim-0 path and then throw from
  // the SEPARATOR's `toString` instead, inverting the observable step-4/step-5
  // order the sputnik battery asserts. Routing through `__to_primitive` with
  // the "number" hint (the mirror of what `emitStringProtoToStringFlat` does
  // with the "string" hint) restores it.
  const numScratch = allocLocal(fctx, `__split_num_${fctx.locals.length}`, { kind: "f64" });
  const limLocal = allocLocal(fctx, `__split_lim_${fctx.locals.length}`, { kind: "i32" });
  pushIsUndefined(ctx, fctx.body, 3);
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: NO_LIMIT }],
    else: [
      { op: "local.get", index: 3 },
      ...stringConstantExternrefInstrs(ctx, "number"),
      { op: "call", funcIdx: toPrimitiveIdx },
      { op: "call", funcIdx: unboxIdx },
      { op: "local.set", index: numScratch },
      ...toUint32Instrs(numScratch),
    ],
  });
  fctx.body.push({ op: "local.set", index: limLocal });

  // Step 5: R = ? ToString(separator), flattened.
  emitStringProtoToStringFlat(ctx, fctx, 2, anyToStrIdx, flattenIdx);
  const rLocal = allocLocal(fctx, `__split_r_${fctx.locals.length}`, flatStringType(ctx));
  fctx.body.push({ op: "local.set", index: rLocal });

  // Steps 6–8: pick the result shape.
  const sepUndefLocal = allocLocal(fctx, `__split_sepu_${fctx.locals.length}`, { kind: "i32" });
  pushIsUndefined(ctx, fctx.body, 2);
  fctx.body.push({ op: "local.set", index: sepUndefLocal });

  const emptyVec: Instr[] = [
    { op: "i32.const", value: 0 },
    { op: "i32.const", value: 0 },
    { op: "array.new_default", typeIdx: arrTypeIdx },
    { op: "struct.new", typeIdx: vecTypeIdx },
  ];
  const wholeVec: Instr[] = [
    { op: "i32.const", value: 1 },
    { op: "local.get", index: sLocal },
    { op: "array.new_fixed", typeIdx: arrTypeIdx, length: 1 },
    { op: "struct.new", typeIdx: vecTypeIdx },
  ];
  const kernel: Instr[] = [
    { op: "local.get", index: sLocal },
    { op: "local.get", index: rLocal },
    { op: "local.get", index: limLocal },
    { op: "call", funcIdx: splitIdx },
  ];
  fctx.body.push(
    { op: "local.get", index: limLocal },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "val", type: vecRef },
      then: emptyVec,
      else: [
        { op: "local.get", index: sepUndefLocal },
        { op: "if", blockType: { kind: "val", type: vecRef }, then: wholeVec, else: kernel },
      ],
    },
    { op: "extern.convert_any" },
  );
  return { kind: "externref" };
}
