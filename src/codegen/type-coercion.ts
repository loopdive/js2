// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Type coercion utilities for Wasm codegen.
 *
 * Extracted from expressions.ts to keep concerns separated.
 * Contains: coerceType, pushDefaultValue, defaultValueInstrs, coercionInstrs.
 */

import type { ArrayTypeDef, Instr, StructTypeDef, TypeDef, ValType } from "../ir/types.js";
import { coercionPlan } from "./coercion-plan.js";
import { boxToAny, UNDEF_F64_BITS } from "./value-tags.js";
import { allocLocal, allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { ClosureInfo, CodegenContext, FunctionContext, OptionalParamInfo } from "./context/types.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { addUnionImports, ensureAnyHelpers, ensureAnyToExternHelper, isAnyValue } from "./index.js";
import { canonicalUndefinedExternInstrs, undefinedExternInstrs } from "./any-helpers.js"; // (#2106 S1 / #2864 wave-2 S1)
import { ensureAnyToStringHelper, stringConstantExternrefInstrs } from "./native-strings.js";
import { buildThrowJsErrorInstrs } from "./expressions/helpers.js";
import { ensureWrapperStringValueHelper } from "./object-runtime.js";
import { ensureNativeArrayFromIterN } from "./iterator-native.js";
import { markNoBrandSiblingShapes } from "./shape-brand.js";
import { symbolBoundaryCoercionInstrs } from "./symbol-field-carrier.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec } from "./registry/types.js";
import {
  elemGetOp,
  ensureExternrefToStringProvider,
  ensureLateImport,
  flushLateImportShifts,
  materializeStructAsObject,
  registerCoerceType,
  reserveTypedMemberGetF64DispatchLate,
  unpackedElemType,
} from "./shared.js";
import { tryEmitFastToNumber } from "./tonumber-fast-paths.js"; // (#4157) flag-gated, default OFF
import { structMustReifyAtExternrefBoundary } from "./struct-boundary-reify.js"; // (#2358, #4491)

/**
 * Emit a guarded ref.cast: use ref.test to check if the cast will succeed.
 * If it fails, push ref.null instead of trapping with "illegal cast".
 * The value on the stack should be an anyref (from any.convert_extern).
 * The result is always ref_null $typeIdx (nullable) to accommodate the null fallback.
 *
 * Usage: push externref, call any.convert_extern, then call this function.
 */
export function emitGuardedRefCast(fctx: FunctionContext, typeIdx: number): void {
  const tmpLocal = allocTempLocal(fctx, { kind: "anyref" } as ValType);
  fctx.body.push({ op: "local.tee", index: tmpLocal });
  fctx.body.push({ op: "ref.test", typeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "ref_null", typeIdx } as ValType },
    then: [
      { op: "local.get", index: tmpLocal },
      { op: "ref.cast_null", typeIdx },
    ],
    else: [{ op: "ref.null", typeIdx }],
  });
  // Save the pre-cast anyref so downstream multi-struct dispatch can use it
  // when the cast produced null (wrong struct type, not genuinely null). (#792)
  (fctx as any).__lastGuardedCastBackup = tmpLocal;
}

/**
 * Emit a guarded funcref cast: use ref.test to check if the cast will succeed.
 * If it fails, push ref.null instead of trapping with "illegal cast".
 * The value on the stack should be a funcref (from struct.get of a closure field).
 * The result is always ref_null $funcTypeIdx (nullable).
 *
 * Unlike emitGuardedRefCast, this uses funcref locals (not anyref) since
 * funcref is NOT a subtype of anyref in the WasmGC type hierarchy.
 */
export function emitGuardedFuncRefCast(fctx: FunctionContext, funcTypeIdx: number): void {
  const tmpFunc = allocLocal(fctx, `__gfc_${fctx.locals.length}`, { kind: "funcref" } as ValType);
  fctx.body.push({ op: "local.tee", index: tmpFunc });
  fctx.body.push({ op: "ref.test", typeIdx: funcTypeIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "ref_null", typeIdx: funcTypeIdx } as ValType },
    then: [
      { op: "local.get", index: tmpFunc },
      { op: "ref.cast_null", typeIdx: funcTypeIdx },
    ],
    else: [{ op: "ref.null", typeIdx: funcTypeIdx }],
  });
}

/**
 * (#1917 Stage A) Byte-neutral extraction of the guarded-ref-cast idiom that was
 * copy-pasted across `coerceType` (~6×) and `coercionInstrs` (4×): tee the
 * incoming (any/eq/`from`)ref into a temp, `ref.test` the target `toIdx`, and `if`
 * it — `ref.cast_null` on success, `ref.null` on failure (so a wrong runtime
 * struct type yields null instead of an illegal-cast trap). Returns the
 * instruction SEQUENCE (the value to guard must already be on the stack, e.g.
 * after a prefix `any.convert_extern` / `struct.get`). Instr[]-returning callers
 * (`coercionInstrs`) prepend their prefix and `return`; push-style callers
 * (`coerceType`) spread the result into `fctx.body`.
 *
 * Distinct from `emitGuardedRefCast` on three points these 10 sites require: it
 * does NOT record `__lastGuardedCastBackup` (#792 — none of these sites did), it
 * lets the caller choose the temp's ValType (`anyref` vs `eqref` vs the exact
 * `from` type), and it appends the trailing `ref.as_non_null` only when
 * `nonNull` (a non-null `(ref)` target). The `if` blockType is always
 * `ref_null $toIdx`.
 */
function guardedRefCastInstrs(
  fctx: FunctionContext,
  toIdx: number,
  opts: { tempType: ValType; nonNull: boolean },
): Instr[] {
  const tmp = allocTempLocal(fctx, opts.tempType);
  const instrs: Instr[] = [
    { op: "local.tee", index: tmp },
    { op: "ref.test", typeIdx: toIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
      then: [
        { op: "local.get", index: tmp },
        { op: "ref.cast_null", typeIdx: toIdx },
      ],
      else: [{ op: "ref.null", typeIdx: toIdx }],
    },
  ];
  if (opts.nonNull) instrs.push({ op: "ref.as_non_null" });
  releaseTempLocal(fctx, tmp);
  return instrs;
}

/**
 * Callback type for compiling a string literal onto the Wasm stack.
 * Used by coerceType when it needs to push a @@toPrimitive hint string.
 * The caller (expressions.ts) passes its local compileStringLiteral function.
 * @deprecated No longer needed — coerceType now emits hint strings directly via global.get.
 */
export type CompileStringLiteralFn = (ctx: CodegenContext, fctx: FunctionContext, value: string) => void;

/**
 * (#4429) Run an inline OrdinaryToPrimitive dispatch with `__current_this`
 * bound to the RECEIVER (§7.1.1.1 step 4.b `Call(method, O)`), then restore the
 * previous binding.
 *
 * Object-literal methods are stored as `__obj_meth_tramp_*` trampolines that
 * read `this` from the `__current_this` module GLOBAL — param-0 is the closure
 * self/env, not the receiver. The NUMBER-hint valueOf dispatch has installed it
 * since #2679; the STRING-hint dispatches did not (their comment claimed they
 * "static-dispatch the raw method with the receiver as param-0", which stopped
 * being true once object-literal methods moved to trampolines). So `'' + a` /
 * `String(a)` called `toString` with a stale receiver in JS-host mode, and in
 * standalone mode `__current_this` was outright NULL, making the trampoline's
 * `ref.cast` trap ("dereferencing a null pointer") for any `this`-reading
 * `toString`.
 *
 * `emitDispatch` must leave exactly one value of `resultType` on the stack.
 *
 * INDEX DISCIPLINE (#2679 / `project_type_index_shift_and_deadelim`):
 * `ctx.currentThisGlobalIdx` is read FRESH at every global op and never cached
 * across `emitDispatch()`. Compiling the dispatch can flush a late string-
 * constant IMPORT, which inserts an imported global and shifts the defined-
 * global index space; the shift pass bumps both `ctx.currentThisGlobalIdx` and
 * the already-emitted save/install ops in `fctx.body` in lockstep, but a
 * captured local would go stale and make the RESTORE `global.set` target a
 * different (differently typed) global — invalid Wasm, which is what park-held
 * #2078 with a 30-test regression.
 *
 * A negative `ctx.currentThisGlobalIdx` (global never registered) degrades to
 * the plain dispatch — no worse than the pre-#4429 behaviour.
 */
function emitWithCurrentThis(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiverLocal: number,
  resultType: ValType,
  emitDispatch: () => void,
): void {
  if (ctx.currentThisGlobalIdx < 0) {
    emitDispatch();
    return;
  }
  const prevThisLocal = allocTempLocal(fctx, { kind: "externref" });
  const resultLocal = allocTempLocal(fctx, resultType);
  // save __current_this, install the receiver (struct ref → externref)
  fctx.body.push({ op: "global.get", index: ctx.currentThisGlobalIdx });
  fctx.body.push({ op: "local.set", index: prevThisLocal });
  fctx.body.push({ op: "local.get", index: receiverLocal });
  fctx.body.push({ op: "extern.convert_any" });
  fctx.body.push({ op: "global.set", index: ctx.currentThisGlobalIdx });
  emitDispatch();
  // capture the result, restore __current_this (FRESH index), re-push
  fctx.body.push({ op: "local.set", index: resultLocal });
  fctx.body.push({ op: "local.get", index: prevThisLocal });
  fctx.body.push({ op: "global.set", index: ctx.currentThisGlobalIdx });
  fctx.body.push({ op: "local.get", index: resultLocal });
  releaseTempLocal(fctx, prevThisLocal);
  releaseTempLocal(fctx, resultLocal);
}

/**
 * Resolve START-safe OrdinaryToPrimitive(string) for statically-known
 * object-literal closures. Void closures produce the JavaScript primitive
 * `undefined`; the host lane also preserves directly returned strings.
 *
 * This dispatch must remain in Wasm because a host bridge cannot call exported
 * closure trampolines while the module start section is still running.
 */
function tryStructPrimitiveToStringAsExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  typeIdx: number,
  name: string,
): boolean {
  const fields = ctx.structFields.get(name);
  if (!fields) return false;
  const isVoid = (info: ClosureInfo | undefined): boolean =>
    info !== undefined && (info.returnType === null || info.returnType === undefined);
  const isSupported = (info: ClosureInfo | undefined): info is ClosureInfo => info !== undefined && isVoid(info);
  const candidates = (): { closureTypeIdx: number; info: ClosureInfo }[] =>
    (ctx.valueOfClosureTypes.get(name) ?? [])
      .map((closureTypeIdx) => ({ closureTypeIdx, info: ctx.closureInfoByTypeIdx.get(closureTypeIdx) }))
      .filter(
        (candidate): candidate is { closureTypeIdx: number; info: ClosureInfo } =>
          candidate.info?.paramTypes.length === 0 && isSupported(candidate.info),
      );
  const isCallableField = (field: (typeof fields)[number]): boolean =>
    field.type.kind === "ref" || field.type.kind === "ref_null" || field.type.kind === "eqref";
  const supportsDispatch = (field: (typeof fields)[number]): boolean => {
    if (field.type.kind === "ref" || field.type.kind === "ref_null") {
      return isSupported(ctx.closureInfoByTypeIdx.get((field.type as { typeIdx: number }).typeIdx));
    }
    return field.type.kind === "eqref" && candidates().length > 0;
  };

  // OrdinaryToPrimitive with the string hint checks toString first. A
  // non-callable own toString is skipped, so the void-returning valueOf case
  // (the ES5 T9 shape) becomes the next successful primitive conversion.
  let fieldIdx = fields.findIndex((field) => field.name === "toString");
  if (fieldIdx >= 0 && isCallableField(fields[fieldIdx]!)) {
    if (!supportsDispatch(fields[fieldIdx]!)) return false;
  } else {
    fieldIdx = fields.findIndex((field) => field.name === "valueOf");
    if (fieldIdx < 0 || !supportsDispatch(fields[fieldIdx]!)) return false;
  }
  const field = fields[fieldIdx]!;

  if (field.type.kind === "ref" || field.type.kind === "ref_null") {
    const closureTypeIdx = (field.type as { typeIdx: number }).typeIdx;
    const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
    if (!isSupported(closureInfo)) return false;

    const structLocal = allocLocal(fctx, `__primitive_ts_struct_${fctx.locals.length}`, from);
    const closureLocal = allocLocal(fctx, `__primitive_ts_closure_${fctx.locals.length}`, field.type);
    fctx.body.push({ op: "local.set", index: structLocal });
    // (#4429) bind `this` = receiver across the trampoline call.
    emitWithCurrentThis(ctx, fctx, structLocal, { kind: "externref" }, () => {
      fctx.body.push({ op: "local.get", index: structLocal });
      fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
      fctx.body.push({ op: "local.tee", index: closureLocal });
      fctx.body.push({ op: "local.get", index: closureLocal });
      fctx.body.push({ op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 });
      emitGuardedFuncRefCast(fctx, closureInfo.funcTypeIdx);
      fctx.body.push({ op: "ref.as_non_null" });
      fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
      if (isVoid(closureInfo)) pushStringHint(ctx, fctx, "undefined");
    });
    return true;
  }

  if (field.type.kind !== "eqref") return false;
  const dispatchCandidates = candidates();
  if (dispatchCandidates.length === 0) return false;

  const structLocal = allocLocal(fctx, `__primitive_ts_struct_${fctx.locals.length}`, from);
  const eqLocal = allocLocal(fctx, `__primitive_ts_eq_${fctx.locals.length}`, { kind: "eqref" });
  fctx.body.push({ op: "local.set", index: structLocal });
  fctx.body.push({ op: "local.get", index: structLocal });
  fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
  fctx.body.push({ op: "local.set", index: eqLocal });
  addStringConstantGlobal(ctx, "undefined");
  const undefinedString = stringConstantExternrefInstrs(ctx, "undefined");

  const buildDispatch = (candidateIdx: number): Instr[] => {
    if (candidateIdx >= dispatchCandidates.length) {
      return [{ op: "local.get", index: structLocal }, { op: "extern.convert_any" }];
    }
    const { closureTypeIdx, info } = dispatchCandidates[candidateIdx]!;
    const closureLocal = allocLocal(fctx, `__primitive_ts_closure_${fctx.locals.length}`, {
      kind: "ref",
      typeIdx: closureTypeIdx,
    });
    const funcLocal = allocLocal(fctx, `__primitive_ts_func_${fctx.locals.length}`, { kind: "funcref" });
    return [
      { op: "local.get", index: eqLocal },
      { op: "ref.test", typeIdx: closureTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: eqLocal },
          { op: "ref.cast", typeIdx: closureTypeIdx },
          { op: "local.set", index: closureLocal },
          { op: "local.get", index: closureLocal },
          { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: funcLocal },
          { op: "local.get", index: funcLocal },
          { op: "ref.test", typeIdx: info.funcTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [
              { op: "local.get", index: closureLocal },
              { op: "local.get", index: funcLocal },
              { op: "ref.cast", typeIdx: info.funcTypeIdx },
              { op: "call_ref", typeIdx: info.funcTypeIdx },
              ...(isVoid(info) ? undefinedString.map((instr) => ({ ...instr })) : []),
            ],
            // (#4429) Zero-capture closure wrappers share one CANONICAL struct
            // type, so a passing `ref.test closureTypeIdx` does NOT prove the
            // stored funcref has THIS candidate's signature. Mirror the sibling
            // chains (#4426 / the host-lane one below): a signature miss means
            // "try the next candidate", not "manufacture null and trap".
            else: buildDispatch(candidateIdx + 1),
          },
        ],
        else: buildDispatch(candidateIdx + 1),
      },
    ];
  };
  // (#4429) bind `this` = receiver across the candidate chain.
  emitWithCurrentThis(ctx, fctx, structLocal, { kind: "externref" }, () => {
    fctx.body.push(...buildDispatch(0));
  });
  return true;
}

/**
 * Companion to {@link tryStructPrimitiveToStringAsExternref} for
 * zero-argument object-literal closures whose Wasm result is `externref`.
 *
 * `externref` is only a carrier type: it can hold either a primitive string or
 * another object/function. OrdinaryToPrimitive must inspect the runtime value,
 * not accept the carrier as proof of success. Keep the closure call in Wasm so
 * module-start initializers are safe, classify its result with the existing
 * Type(x)-is-Object predicate, and fall through from an object-returning
 * `toString` to `valueOf`. Only primitive results reach the coercion engine's
 * canonical externref ToString provider.
 */
function tryStructStringHintExternrefDispatch(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  typeIdx: number,
  name: string,
): boolean {
  const fields = ctx.structFields.get(name);
  if (!fields) return false;

  const isCallableField = (field: (typeof fields)[number]): boolean =>
    field.type.kind === "ref" || field.type.kind === "ref_null" || field.type.kind === "eqref";
  const isSupported = (info: ClosureInfo | undefined): info is ClosureInfo =>
    info !== undefined &&
    info.paramTypes.length === 0 &&
    (info.returnType === null ||
      info.returnType === undefined ||
      info.returnType.kind === "externref" ||
      info.returnType.kind === "ref_extern" ||
      info.returnType.kind === "ref" ||
      info.returnType.kind === "ref_null" ||
      info.returnType.kind === "anyref" ||
      info.returnType.kind === "eqref" ||
      info.returnType.kind === "f64" ||
      info.returnType.kind === "i32");
  const candidates = (): { closureTypeIdx: number; info: ClosureInfo }[] =>
    (ctx.valueOfClosureTypes.get(name) ?? [])
      .map((closureTypeIdx) => ({ closureTypeIdx, info: ctx.closureInfoByTypeIdx.get(closureTypeIdx) }))
      .filter((candidate): candidate is { closureTypeIdx: number; info: ClosureInfo } => isSupported(candidate.info));
  const supportsDispatch = (fieldIdx: number): boolean => {
    const field = fields[fieldIdx];
    if (!field || !isCallableField(field)) return false;
    if (field.type.kind === "ref" || field.type.kind === "ref_null") {
      return isSupported(ctx.closureInfoByTypeIdx.get(field.type.typeIdx));
    }
    return candidates().length > 0;
  };

  const toStringFieldIdx = fields.findIndex((field) => field.name === "toString");
  // An absent own toString still resolves to Object.prototype.toString. Leave
  // that inherited-method case to the existing dynamic object path.
  if (toStringFieldIdx < 0) return false;

  let primaryFieldIdx: number;
  let secondaryFieldIdx: number | undefined;
  if (supportsDispatch(toStringFieldIdx)) {
    primaryFieldIdx = toStringFieldIdx;
    const valueOfFieldIdx = fields.findIndex((field) => field.name === "valueOf");
    if (valueOfFieldIdx >= 0 && supportsDispatch(valueOfFieldIdx)) {
      secondaryFieldIdx = valueOfFieldIdx;
    }
  } else if (!isCallableField(fields[toStringFieldIdx]!)) {
    // An own non-callable toString is skipped before trying valueOf.
    const valueOfFieldIdx = fields.findIndex((field) => field.name === "valueOf");
    if (valueOfFieldIdx < 0 || !supportsDispatch(valueOfFieldIdx)) return false;
    primaryFieldIdx = valueOfFieldIdx;
  } else {
    // A callable shape with a result we cannot lower safely belongs to the
    // pre-existing dynamic path.
    return false;
  }

  // Register every helper before freezing any function indices below. Each
  // late import can shift defined-function indices; resolving from funcMap only
  // after the final flush keeps the nested instruction arrays relocation-safe.
  addUnionImports(ctx);
  if (!ctx.nativeStrings) {
    ensureLateImport(ctx, "__extern_is_object", [{ kind: "externref" }], [{ kind: "i32" }]);
  }
  ensureExternrefToStringProvider(ctx, fctx, "string");
  const throwTypeError = buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot convert object to primitive value", {
    flush: fctx,
  });
  flushLateImportShifts(ctx, fctx);
  const externIsObjectIdx = ctx.nativeStrings
    ? ctx.funcMap.get("__typeof_object")
    : ctx.funcMap.get("__extern_is_object");
  const externIsFunctionIdx = ctx.nativeStrings ? ctx.funcMap.get("__typeof_function") : undefined;
  const externToStringIdx = ensureExternrefToStringProvider(ctx, fctx, "string");
  const boxNumberIdx = ctx.funcMap.get("__box_number");
  const boxBooleanIdx = ctx.funcMap.get("__box_boolean");
  if (
    externIsObjectIdx === undefined ||
    (ctx.nativeStrings && externIsFunctionIdx === undefined) ||
    externToStringIdx === undefined ||
    boxNumberIdx === undefined ||
    boxBooleanIdx === undefined
  ) {
    return false;
  }

  addStringConstantGlobal(ctx, "undefined");
  const undefinedString = stringConstantExternrefInstrs(ctx, "undefined");
  const structLocal = allocLocal(fctx, `__primitive_host_struct_${fctx.locals.length}`, from);
  const resultToExternref = (info: ClosureInfo): Instr[] => {
    const resultType = info.returnType;
    if (resultType === null || resultType === undefined) {
      return undefinedString.map((instr) => ({ ...instr }));
    }
    if (
      resultType.kind === "ref" ||
      resultType.kind === "ref_null" ||
      resultType.kind === "anyref" ||
      resultType.kind === "eqref"
    ) {
      return [{ op: "extern.convert_any" }];
    }
    if (resultType.kind === "f64") {
      return [{ op: "call", funcIdx: boxNumberIdx }];
    }
    if (resultType.kind === "i32") {
      return resultType.boolean === true
        ? [{ op: "call", funcIdx: boxBooleanIdx }]
        : [{ op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumberIdx }];
    }
    return [];
  };

  const fieldDispatch = (fieldIdx: number): Instr[] | undefined => {
    const field = fields[fieldIdx];
    if (!field) return undefined;

    if (field.type.kind === "ref" || field.type.kind === "ref_null") {
      const closureTypeIdx = field.type.typeIdx;
      const info = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
      if (!isSupported(info)) return undefined;
      const closureLocal = allocLocal(fctx, `__primitive_host_closure_${fctx.locals.length}`, field.type);
      const funcLocal = allocLocal(fctx, `__primitive_host_func_${fctx.locals.length}`, { kind: "funcref" });
      return [
        { op: "local.get", index: structLocal },
        { op: "struct.get", typeIdx, fieldIdx },
        { op: "local.tee", index: closureLocal },
        { op: "local.get", index: closureLocal },
        { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
        { op: "local.tee", index: funcLocal },
        { op: "ref.test", typeIdx: info.funcTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: info.funcTypeIdx } },
          then: [
            { op: "local.get", index: funcLocal },
            { op: "ref.cast_null", typeIdx: info.funcTypeIdx },
          ],
          else: [{ op: "ref.null", typeIdx: info.funcTypeIdx }],
        },
        { op: "ref.as_non_null" },
        { op: "call_ref", typeIdx: info.funcTypeIdx },
        ...resultToExternref(info),
      ];
    }

    if (field.type.kind !== "eqref") return undefined;
    const dispatchCandidates = candidates();
    if (dispatchCandidates.length === 0) return undefined;
    const eqLocal = allocLocal(fctx, `__primitive_host_eq_${fctx.locals.length}`, { kind: "eqref" });
    const buildDispatch = (candidateIdx: number): Instr[] => {
      if (candidateIdx >= dispatchCandidates.length) {
        // A non-callable or unrecognised field is equivalent to a failed
        // OrdinaryToPrimitive attempt. Returning the original object makes the
        // caller take its normal fallthrough/TypeError arm.
        return [{ op: "local.get", index: structLocal }, { op: "extern.convert_any" }];
      }
      const { closureTypeIdx, info } = dispatchCandidates[candidateIdx]!;
      const closureLocal = allocLocal(fctx, `__primitive_host_closure_${fctx.locals.length}`, {
        kind: "ref",
        typeIdx: closureTypeIdx,
      });
      const funcLocal = allocLocal(fctx, `__primitive_host_func_${fctx.locals.length}`, { kind: "funcref" });
      return [
        { op: "local.get", index: eqLocal },
        { op: "ref.test", typeIdx: closureTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: [
            { op: "local.get", index: eqLocal },
            { op: "ref.cast", typeIdx: closureTypeIdx },
            { op: "local.set", index: closureLocal },
            { op: "local.get", index: closureLocal },
            { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
            { op: "local.set", index: funcLocal },
            { op: "local.get", index: funcLocal },
            { op: "ref.test", typeIdx: info.funcTypeIdx },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "externref" } },
              then: [
                { op: "local.get", index: closureLocal },
                { op: "local.get", index: funcLocal },
                { op: "ref.cast", typeIdx: info.funcTypeIdx },
                { op: "call_ref", typeIdx: info.funcTypeIdx },
                ...resultToExternref(info),
              ],
              // Closure wrapper structs can canonicalize to the same runtime
              // type. A funcref-signature miss therefore means "try the next
              // candidate", not "manufacture null and trap".
              else: buildDispatch(candidateIdx + 1),
            },
          ],
          else: buildDispatch(candidateIdx + 1),
        },
      ];
    };
    return [
      { op: "local.get", index: structLocal },
      { op: "struct.get", typeIdx, fieldIdx },
      { op: "local.set", index: eqLocal },
      ...buildDispatch(0),
    ];
  };

  const primaryDispatch = fieldDispatch(primaryFieldIdx);
  if (!primaryDispatch) return false;
  const secondaryDispatch: Instr[] | undefined =
    secondaryFieldIdx === undefined
      ? [{ op: "local.get", index: structLocal }, { op: "extern.convert_any" }]
      : fieldDispatch(secondaryFieldIdx);
  if (!secondaryDispatch) return false;

  const primaryResult = allocLocal(fctx, `__primitive_host_result_${fctx.locals.length}`, { kind: "externref" });
  const secondaryResult = allocLocal(fctx, `__primitive_host_result_${fctx.locals.length}`, { kind: "externref" });
  const isObjectLike = (resultLocal: number): Instr[] =>
    ctx.nativeStrings
      ? [
          // `typeof null` is "object", but ECMA Type(null) is not Object.
          { op: "local.get", index: resultLocal },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 0 }],
            else: [
              { op: "local.get", index: resultLocal },
              { op: "call", funcIdx: externIsObjectIdx },
              { op: "local.get", index: resultLocal },
              { op: "call", funcIdx: externIsFunctionIdx! },
              { op: "i32.or" },
            ],
          },
        ]
      : [
          { op: "local.get", index: resultLocal },
          { op: "call", funcIdx: externIsObjectIdx },
        ];
  const stringify = (resultLocal: number): Instr[] => [
    { op: "local.get", index: resultLocal },
    { op: "call", funcIdx: externToStringIdx },
  ];

  fctx.body.push({ op: "local.set", index: structLocal });
  // (#4429) `primaryDispatch` / `secondaryDispatch` `call_ref` the method's
  // `__obj_meth_tramp_*` trampoline, which reads `this` from `__current_this`.
  // Bind the receiver across BOTH attempts (§7.1.1.1 step 4.b). The stringify /
  // TypeError arms sit inside the wrap only because they are part of the same
  // stack-balanced expression; neither re-enters user code.
  emitWithCurrentThis(ctx, fctx, structLocal, { kind: "externref" }, () => {
    fctx.body.push(...primaryDispatch, { op: "local.set", index: primaryResult }, ...isObjectLike(primaryResult));
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        ...secondaryDispatch,
        { op: "local.set", index: secondaryResult },
        ...isObjectLike(secondaryResult),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "externref" } },
          then: throwTypeError,
          else: stringify(secondaryResult),
        },
      ],
      else: stringify(primaryResult),
    });
  });
  return true;
}

/**
 * Push a string constant onto the Wasm stack using the string_constants global import.
 * Registers the string if not already registered, then emits global.get.
 */
function pushStringHint(ctx: CodegenContext, fctx: FunctionContext, hint: string): void {
  addStringConstantGlobal(ctx, hint);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, hint));
}

/**
 * Emit instructions to call the __to_primitive host import (#1090).
 * Expects a struct ref on the stack. Converts it to externref, pushes
 * the hint string, calls __to_primitive, and converts the result to
 * the target type (f64 or externref).
 *
 * @param targetKind - "f64" to unbox the result to f64, "externref" to leave as externref
 * @param hint - ToPrimitive hint ("number", "string", or "default")
 */
function emitToPrimitiveHostCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetKind: "f64" | "externref",
  hint: "number" | "string" | "default",
): void {
  for (const instr of toPrimitiveHostCallInstrs(ctx, fctx, targetKind, hint)) {
    fctx.body.push(instr);
  }
}

/**
 * Return the instruction sequence for a host ToPrimitive call. Same effect as
 * `emitToPrimitiveHostCall`, but as an `Instr[]` so it can be embedded inside
 * a nested if/else `then` branch (where pushing onto `fctx.body` would emit
 * to the wrong control region).
 *
 * Used by the static-dispatch valueOf code path in
 * `coerceType` for ref→f64: when an inlined `valueOf()` returns a non-
 * primitive (an object ref), the spec (§7.1.1.1) requires us to try
 * `toString()` next and then throw TypeError if that's also non-primitive.
 * The host helper does both for us. Pre-#1253 we silently pushed NaN.
 *
 * The caller must put the struct ref on the (then-branch's) stack BEFORE
 * the returned instructions execute; the sequence consumes it.
 */
function toPrimitiveHostCallInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  targetKind: "f64" | "externref",
  hint: "number" | "string" | "default",
): Instr[] {
  const out: Instr[] = [];
  // Convert struct ref → externref.
  out.push({ op: "extern.convert_any" });
  // Push hint string. `pushStringHint` writes to fctx.body, so use a tiny
  // adapter — collect what it would push.
  const fctxStub = { body: out } as unknown as FunctionContext;
  pushStringHint(ctx, fctxStub, hint);
  // Call __to_primitive(externref, externref) → externref.
  const toPrimIdx = ensureLateImport(
    ctx,
    "__to_primitive",
    [{ kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
  );
  flushLateImportShifts(ctx, fctx);
  if (toPrimIdx !== undefined) {
    out.push({ op: "call", funcIdx: toPrimIdx });
  }
  if (targetKind === "f64") {
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx !== undefined) {
      out.push({ op: "call", funcIdx: unboxIdx });
    } else {
      out.push({ op: "drop" });
      out.push({ op: "f64.const", value: NaN });
    }
  }
  return out;
}

/**
 * Check if a type index corresponds to a vec struct (__vec_*) and return its
 * array type index and element type if so.
 */
export function getVecInfo(ctx: CodegenContext, typeIdx: number): { arrTypeIdx: number; elemType: ValType } | null {
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "struct") return null;
  const sd = typeDef as StructTypeDef;
  if (!sd.name?.startsWith("__vec_")) return null;
  // Vec struct: field 0 = $length (i32), field 1 = $data (ref $arr)
  if (sd.fields.length < 2) return null;
  const dataField = sd.fields[1]!;
  if (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null") return null;
  const arrTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;
  return { arrTypeIdx, elemType: (arrDef as ArrayTypeDef).element };
}

/**
 * (#2161 B0) Structural twin of {@link getVecInfo} for vec-SHAPED structs that
 * are not named `__vec_*` — a struct whose field 0 is `length: i32` and field 1
 * is `data: ref/ref_null <array>` (the `$__regexp_match_vec` subtype shape).
 * Used only by `emitSafeStructConversion` to route such sources through the
 * element-copying vec→vec body instead of the trapping struct-narrow field
 * copy. Deliberately NOT folded into `getVecInfo` itself: its other callers
 * (extern-vec builders, host glue) assume genuine `__vec_*` layout semantics.
 */
function getVecShapedInfo(ctx: CodegenContext, typeIdx: number): { arrTypeIdx: number; elemType: ValType } | null {
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "struct") return null;
  const sd = typeDef as StructTypeDef;
  if (sd.fields.length < 2) return null;
  const lenField = sd.fields[0]!;
  const dataField = sd.fields[1]!;
  if (lenField.name !== "length" || lenField.type.kind !== "i32") return null;
  if (dataField.name !== "data") return null;
  if (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null") return null;
  const arrTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;
  return { arrTypeIdx, elemType: (arrDef as ArrayTypeDef).element };
}

/**
 * Build instructions to construct a vec struct from a JS array (externref).
 * Uses __extern_length + __extern_get to read elements and build the WasmGC array.
 * Returns instruction array producing ref_null $vecType on the stack. (#792)
 */
export function buildVecFromExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  externLocal: number,
  vecTypeIdx: number,
  vecInfo: { arrTypeIdx: number; elemType: ValType },
  strictIterator = false,
): Instr[] {
  // #1472 Phase B Blocker B Slice 2 — standalone enumeration consumer.
  //
  // `__array_from_iter` is a JS-host import (it invokes the Symbol.iterator
  // protocol via the runtime). In standalone there is no host, and the source
  // we are coercing here is already an indexable externref — the native
  // `$ObjVec` produced by `__object_keys`/`values`/`entries` (Slice 1), which
  // `__extern_length` + `__extern_get_idx` read directly. So under
  // `ctx.standalone` we SKIP the materialization step (pass the externref
  // through unchanged) and read it with the native indexed accessor below,
  // never leaking `env::__array_from_iter`. (Generators / custom @@iterator
  // standalone materialization is a separate slice — those don't reach an
  // $ObjVec source.) The JS-host path is unchanged.
  //
  // WASI is host-free at runtime too (the module runs under raw wasmtime — see
  // `examples/native-messaging/scale-test.mjs`), so it must take the SAME native
  // reader path: `__extern_get_idx` / `__extern_get` / `__box_number` /
  // `__unbox_number` are all emitted as DEFINED funcs under WASI, but
  // `__array_from_iter` is only ever a host import — emitting it makes the WASI
  // module fail instantiation (`unknown import: env::__array_from_iter`). #2311
  // gated this on `ctx.standalone` alone, which left the WASI nm_js2wasm_node_*
  // hosts importing `__array_from_iter` (loopdive/js2wasm#389 / #2311 regression);
  // `ctx.standalone || ctx.wasi` is the established host-free idiom used
  // throughout codegen (and elsewhere in this file). (#2839)
  // Native-first JS can reach this coercion with a typed Wasm vector (for
  // example the result of `array.map`) as well as an `$ObjVec`. Normalize that
  // broader iterable set through the native materializer before indexed reads;
  // the historical standalone/WASI sites already prove their source is an
  // `$ObjVec` and keep the cheaper direct path.
  const useNativeMaterializer =
    ctx.targetProfile.semanticProviders === "native-first" && ctx.targetProfile.environment === "javascript";
  const useNativeObjVec = useNativeMaterializer || ctx.standalone || ctx.wasi;
  if (useNativeMaterializer) ensureNativeArrayFromIterN(ctx);
  // #2696 — register EVERY late import (helper) FIRST, flush ONCE, then read the
  // funcIdx values from funcMap. ensureLateImport for a NEW env import shifts the
  // index of every DEFINED helper func (the native `__box_number` /
  // `__unbox_number` / `__str_to_number` emitted under nativeStrings/WASI), so a
  // funcIdx captured BEFORE a later ensureLateImport goes stale and lands the
  // call on the adjacent helper. The previous code captured `boxIdx`
  // (`__box_number`, a defined func) and only THEN registered `__array_from_iter`
  // / `__extern_get_idx`, shifting `boxIdx` by one onto `__str_to_number` — which
  // emitted `call $__str_to_number` with an f64 index argument where an externref
  // is required, producing invalid Wasm (loopdive/js2wasm#389 bug 3, nm_js2wasm_wasi_p3.ts:
  // `type mismatch: expected externref, found f64`). Mirror
  // buildTupleFromIterableFallback's register-all-then-freeze discipline.
  ensureLateImport(ctx, "__extern_length", [{ kind: "externref" }], [{ kind: "f64" }]);
  ensureLateImport(ctx, "__extern_get", [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  if (useNativeObjVec) {
    // In standalone, indexed reads go through the native `__extern_get_idx`
    // (f64 index → element) instead of `__extern_get(obj, boxed-index)` — the
    // native `__extern_get` casts its key to $AnyString and would trap on a
    // boxed number. (#1472 Phase B Blocker B Slice 2)
    ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
  } else {
    ensureLateImport(
      ctx,
      strictIterator ? "__array_from_iter_strict" : "__array_from_iter",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
    );
  }
  flushLateImportShifts(ctx, fctx);
  const lenIdx = ctx.funcMap.get("__extern_length");
  const getIdx = ctx.funcMap.get("__extern_get");
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  const boxIdx = ctx.funcMap.get("__box_number");
  const iterIdx = useNativeMaterializer
    ? ctx.funcMap.get("__array_from_iter_n")
    : useNativeObjVec
      ? undefined
      : ctx.funcMap.get(strictIterator ? "__array_from_iter_strict" : "__array_from_iter");
  const getIdxIdx = useNativeObjVec ? ctx.funcMap.get("__extern_get_idx") : undefined;

  if (lenIdx === undefined || getIdx === undefined) {
    return [{ op: "ref.null", typeIdx: vecTypeIdx }];
  }

  const matLocal = allocLocal(fctx, `__vec_mat_${fctx.locals.length}`, { kind: "externref" });
  const lenLocal = allocLocal(fctx, `__vec_len_${fctx.locals.length}`, { kind: "i32" });
  const arrLocal = allocLocal(fctx, `__vec_arr_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: vecInfo.arrTypeIdx,
  });
  const idxLocal = allocLocal(fctx, `__vec_idx_${fctx.locals.length}`, { kind: "i32" });

  const buildElemCoerce = (): Instr[] => {
    const et = vecInfo.elemType;
    if (et.kind === "f64" && unboxIdx !== undefined) {
      return [{ op: "call", funcIdx: unboxIdx }];
    }
    // i8/i16 are PACKED array element kinds (Uint8Array, Int8Array, Uint16Array,
    // …). Their value-position representation is i32: a packed `array.set`
    // truncates the i32 modulo the storage width (8/16 bits), so the unbox→i32
    // path is identical to the i32 arm here. Signedness is irrelevant on WRITE —
    // it only governs the READ op (`array.get_s`/`array.get_u`), driven
    // elsewhere by the view name. Without this arm the externref falls through
    // to the empty `return []`, leaving an externref on the stack where the
    // packed `array.set` expects i32 → `array.set must have the proper type`
    // (loopdive/js2wasm#389 / #2311 regression — buildElemCoerce only handled
    // f64/i32/externref/ref). (#2839)
    if ((et.kind === "i32" || et.kind === "i8" || et.kind === "i16") && unboxIdx !== undefined) {
      // (#2866 slice 3) In a symbol-bearing module the externref element may be a
      // `$Symbol` carrier (materialising `Object.getOwnPropertySymbols(o)` into a
      // typed `symbol[]` whose value-position rep is the i32 id) rather than a
      // boxed number. `symbol[]` shares the unbranded `$__arr_i32` element type
      // with `number[]`, so it can't be disambiguated statically — dispatch at
      // runtime: a `$Symbol` carrier yields its i32 id (`$Symbol.id`), anything
      // else unboxes as a number. Gated on the carrier being registered
      // (standalone/WASI symbol modules); plain numeric modules are byte-identical.
      if ((ctx.standalone || ctx.wasi) && ctx.symbolTypeIdx >= 0 && et.kind === "i32") {
        const symIdx = ctx.symbolTypeIdx;
        const tmpSym = allocLocal(fctx, `__sym_elem_${fctx.locals.length}`, { kind: "externref" });
        return [
          { op: "local.tee", index: tmpSym },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: symIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: tmpSym },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: symIdx },
              { op: "struct.get", typeIdx: symIdx, fieldIdx: 0 },
            ],
            else: [
              { op: "local.get", index: tmpSym },
              { op: "call", funcIdx: unboxIdx },
              { op: "i32.trunc_sat_f64_s" },
            ],
          },
        ];
      }
      return [{ op: "call", funcIdx: unboxIdx }, { op: "i32.trunc_sat_f64_s" }];
    }
    // (#3024) i64 (BigInt) element arrays previously fell through to the empty
    // terminal arm, leaving the externref element on the stack where the i64
    // `array.set` expects an i64 → invalid Wasm (`array.set expected type i64,
    // found call of type externref`; the postfix/prefix-inc/dec bigint.js
    // family). Unbox via §7.1.13 ToBigInt when the module registered it
    // (precision-preserving, identity on a JS bigint); otherwise the legacy
    // number-unbox + trunc keeps the module valid.
    if (et.kind === "i64") {
      const toBigIdx = ctx.funcMap.get("__to_bigint");
      if (toBigIdx !== undefined) return [{ op: "call", funcIdx: toBigIdx }];
      if (unboxIdx !== undefined) {
        return [{ op: "call", funcIdx: unboxIdx }, { op: "i64.trunc_sat_f64_s" }];
      }
      return [{ op: "drop" }, { op: "i64.const", value: 0n }];
    }
    if (et.kind === "externref") return [];
    if (et.kind === "ref" || et.kind === "ref_null") {
      const elemTypeIdx = (et as { typeIdx: number }).typeIdx;
      // Check if the target is a tuple struct — if so, build the tuple from
      // the externref array element (e.g. [key, value] from Object.entries)
      // instead of trying ref.cast which would fail for JS arrays.
      const tupleFields = getTupleFields(ctx, elemTypeIdx);
      if (tupleFields && getIdx !== undefined) {
        // Stack has: externref (a JS array like [key, value])
        // Save it to a temp local so we can extract each field
        const tmpElem = allocLocal(fctx, `__tuple_src_${fctx.locals.length}`, { kind: "externref" });
        const instrs: Instr[] = [{ op: "local.set", index: tmpElem }];
        // For each tuple field, extract from the source by index.
        for (let fi = 0; fi < tupleFields.length; fi++) {
          const fieldType = tupleFields[fi]!;
          instrs.push({ op: "local.get", index: tmpElem });
          // Standalone: the pair element is a native `$ObjVec` (e.g. the
          // `[k, v]` entry built by `__objvec_new`/`__objvec_push`), so its
          // fields are read positionally with `__extern_get_idx(obj, f64(fi))`.
          // The string-keyed `__extern_get` casts its key to `$AnyString` and
          // returns undefined → every pair field read as 0 (the spread-of-
          // entries bug). Mirror the outer-loop reader choice above. (#2162b)
          if (useNativeObjVec && getIdxIdx !== undefined) {
            instrs.push({ op: "f64.const", value: fi });
            instrs.push({ op: "call", funcIdx: getIdxIdx });
          } else {
            if (boxIdx !== undefined) {
              instrs.push({ op: "f64.const", value: fi });
              instrs.push({ op: "call", funcIdx: boxIdx });
            } else {
              instrs.push({ op: "ref.null.extern" });
            }
            instrs.push({ op: "call", funcIdx: getIdx });
          }
          // Coerce the externref element to the tuple field type
          if (fieldType.kind === "f64" && unboxIdx !== undefined) {
            instrs.push({ op: "call", funcIdx: unboxIdx });
          } else if (fieldType.kind === "i32" && unboxIdx !== undefined) {
            instrs.push({ op: "call", funcIdx: unboxIdx });
            instrs.push({ op: "i32.trunc_sat_f64_s" });
          }
          // externref fields don't need conversion
        }
        // Build the tuple struct from all fields on the stack
        instrs.push({ op: "struct.new", typeIdx: elemTypeIdx });
        return instrs;
      }
      // Default: try anyref cast (works for WasmGC structs passed through externref)
      return [{ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: elemTypeIdx }];
    }
    return [];
  };

  const matInstrs: Instr[] =
    iterIdx !== undefined
      ? [
          { op: "local.get", index: externLocal },
          ...(useNativeMaterializer ? ([{ op: "f64.const", value: -1 }] satisfies Instr[]) : []),
          { op: "call", funcIdx: iterIdx },
          { op: "local.set", index: matLocal },
        ]
      : [
          { op: "local.get", index: externLocal },
          { op: "local.set", index: matLocal },
        ];

  return [
    ...matInstrs,
    { op: "local.get", index: matLocal },
    { op: "call", funcIdx: lenIdx },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.set", index: lenLocal },
    { op: "local.get", index: lenLocal },
    { op: "array.new_default", typeIdx: vecInfo.arrTypeIdx },
    { op: "local.set", index: arrLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: idxLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            { op: "local.get", index: idxLocal },
            { op: "local.get", index: lenLocal },
            { op: "i32.ge_u" },
            { op: "br_if", depth: 1 },
            { op: "local.get", index: arrLocal },
            { op: "local.get", index: idxLocal },
            { op: "local.get", index: matLocal },
            // Standalone: native __extern_get_idx(obj, f64(idx)) — reads the
            // $ObjVec element by index without a boxed-string key. JS-host:
            // __extern_get(obj, boxed-numeric-index) (host handles numeric keys).
            ...(useNativeObjVec && getIdxIdx !== undefined
              ? ([
                  { op: "local.get", index: idxLocal },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: getIdxIdx },
                ] satisfies Instr[])
              : ([
                  ...(boxIdx !== undefined
                    ? ([
                        { op: "local.get", index: idxLocal },
                        { op: "f64.convert_i32_s" },
                        { op: "call", funcIdx: boxIdx },
                      ] satisfies Instr[])
                    : ([{ op: "ref.null.extern" }] satisfies Instr[])),
                  { op: "call", funcIdx: getIdx },
                ] satisfies Instr[])),
            ...buildElemCoerce(),
            { op: "array.set", typeIdx: vecInfo.arrTypeIdx },
            { op: "local.get", index: idxLocal },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: idxLocal },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: lenLocal },
    { op: "local.get", index: arrLocal },
    { op: "struct.new", typeIdx: vecTypeIdx },
  ];
}

/**
 * (#2831) Reserve (or fetch) the per-target-vec materializer
 * `__vec_from_extern_<vecTypeIdx>(val: externref) -> (ref null $vec)` and record
 * its NAME in `ctx.vecFromExternMap`. Returns the helper name (so callers resolve
 * the funcIdx via `funcMap` at emit time, immune to later import shifts), or
 * `undefined` if `vecTypeIdx` is not a vec struct or the index space is frozen.
 *
 * The body is the host-externref → wasm-vec conversion, guarded so it is safe at
 * a dynamic any-receiver write where the inbound value is an OPAQUE host
 * externref (a `[]` already marshalled by `__make_iterable`), not a wasm vec:
 *
 *   1. `null`/`undefined` input            → `ref.null $vec` (store null on the
 *      slot; do NOT route to the sidecar — keeps reads+writes on the same rep).
 *   2. already this exact vec rep (a wasm  → `ref.cast $vec` (identity-preserving
 *      vec boxed via `extern.convert_any`)   short-circuit; no rebuild/copy).
 *   3. otherwise (host array / cross-rep)  → `buildVecFromExternref`: read
 *      `__extern_length` + per-element `__extern_get`, element-coerce, and
 *      `struct.new` a FRESH vec of the exact target type.
 *
 * This is the read-consistent inverse of `__make_iterable`; the produced value is
 * stored by `struct.set` directly on the slot (no sidecar ⇒ no #2664 desync, no
 * unguarded `ref.cast` ⇒ no #2831 `illegal cast` trap).
 *
 * Built with a REAL FunctionContext so `buildVecFromExternref` owns its
 * `ensureLateImport` + single `flushLateImportShifts` — this MUST be called from
 * the pre-fill reserve pass (`reserveVecFieldMaterializers`), where index shifts
 * are still permitted, NOT from inside any `fill*` (which must be funcIdx-stable).
 */
/**
 * (#2831) Resolve the funcIdx of the reserved `__vec_from_extern_<vecTypeIdx>`
 * materializer for `vecTypeIdx`, or `undefined` if none was reserved. Name-based
 * (via `funcMap`) so it stays correct across late-import index shifts. Returns
 * `undefined` pre-reserve, so coercion call sites fall back to their guarded cast.
 */
export function vecFromExternFuncIdx(ctx: CodegenContext, vecTypeIdx: number): number | undefined {
  const name = ctx.vecFromExternMap?.get(vecTypeIdx);
  if (name === undefined) return undefined;
  return ctx.funcMap.get(name);
}

export function buildVecFromExternMaterializer(ctx: CodegenContext, vecTypeIdx: number): string | undefined {
  const name = `__vec_from_extern_${vecTypeIdx}`;
  if (ctx.funcMap.get(name) !== undefined) return name; // idempotent
  if (ctx.indexSpaceFrozen) return undefined; // cannot register a defining func / import past the freeze
  const vecInfo = getVecInfo(ctx, vecTypeIdx);
  if (!vecInfo) return undefined;

  const resultType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  // Synthetic FunctionContext: one externref param (the value), returns ref_null
  // vec. buildVecFromExternref allocLocals on this fctx and reads param slot 0.
  const fctx: FunctionContext = {
    name,
    params: [{ name: "val", type: { kind: "externref" } }],
    locals: [],
    localMap: new Map<string, number>(),
    returnType: resultType,
    body: [],
    blockDepth: 0,
    breakStack: [],
    continueStack: [],
    labelMap: new Map(),
    savedBodies: [],
  };

  // The cross-rep / host-array conversion (registers its late imports + flushes
  // against fctx; produces ref_null $vec). Built first so its locals are
  // allocated before the short-circuit temp below.
  const matInstrs = buildVecFromExternref(ctx, fctx, 0, vecTypeIdx, vecInfo);
  const tmpAny = allocLocal(fctx, `__vfe_any_${fctx.locals.length}`, { kind: "anyref" } as ValType);

  const body: Instr[] = [
    // (1) null/undefined guard.
    { op: "local.get", index: 0 },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [{ op: "ref.null", typeIdx: vecTypeIdx }],
      else: [
        // (2) same-rep short-circuit: a wasm vec of this exact type, boxed via
        // extern.convert_any, is cast straight through (identity preserved). The
        // value is non-null here, so the non-null ref.test/ref.cast pair is safe.
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: tmpAny },
        { op: "ref.test", typeIdx: vecTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: resultType },
          then: [
            { op: "local.get", index: tmpAny },
            { op: "ref.cast", typeIdx: vecTypeIdx },
          ],
          // (3) host externref / cross-rep → materialize a fresh exact-type vec.
          else: matInstrs,
        },
      ],
    },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [resultType], "$vec_from_extern_type");
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name,
    typeIdx,
    locals: fctx.locals,
    body,
    exported: false,
  });
  ctx.funcMap.set(name, funcIdx);
  (ctx.vecFromExternMap ??= new Map<number, string>()).set(vecTypeIdx, name);
  return name;
}

/**
 * Build the terminal else-branch for buildTupleFromExternref: when no known
 * vec type matched, materialize the externref via `__array_from_iter` (so
 * iterables + array-likes become a real JS array), then read each tuple
 * field by index via `__extern_get_idx`. Null/undefined externrefs stay
 * null — the callee's destructure guard turns that into a spec TypeError.
 *
 * If the externref backup isn't available or the host imports are missing
 * (standalone mode), fall back to ref.null so downstream code can detect
 * the conversion failure. (#1161)
 */
function buildTupleFromIterableFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  externLocal: number | undefined,
  tupleTypeIdx: number,
  tupleFields: ValType[],
): Instr[] {
  if (externLocal === undefined) {
    return [{ op: "ref.null", typeIdx: tupleTypeIdx }];
  }
  // (#2995) In host-free targets (standalone / WASI) the host `__array_from_iter`
  // import is unavailable — emitting it leaks `env::__array_from_iter` and breaks
  // zero-import instantiation. Materialize through the NATIVE `__array_from_iter_n`
  // instead (registered by `ensureNativeArrayFromIterN`, #2904), passing `-1` for
  // an unbounded drain that is byte-semantics-equivalent to the host
  // `__array_from_iter` (fully drain the iterable, then index each tuple slot via
  // `__extern_get_idx`). Host mode keeps the JS-host `__array_from_iter` path
  // unchanged (byte-inert). Mirrors the native ObjVec steering in
  // `buildVecFromExternref`.
  const useNativeFromIter = ctx.targetProfile.semanticProviders === "native-first" || ctx.standalone || ctx.wasi;
  if (useNativeFromIter) ensureNativeArrayFromIterN(ctx);
  // Register all helpers first so every ensureLateImport shift completes
  // before we freeze funcIdx values — otherwise a later ensureLateImport
  // could shift a previously-captured funcIdx and produce the wrong call.
  if (!useNativeFromIter) {
    ensureLateImport(ctx, "__array_from_iter", [{ kind: "externref" }], [{ kind: "externref" }]);
  }
  ensureLateImport(ctx, "__extern_get_idx", [{ kind: "externref" }, { kind: "f64" }], [{ kind: "externref" }]);
  ensureLateImport(ctx, "__extern_is_undefined", [{ kind: "externref" }], [{ kind: "i32" }]);
  ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  ensureLateImport(ctx, "__box_number", [{ kind: "f64" }], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  const iterIdx = useNativeFromIter ? ctx.funcMap.get("__array_from_iter_n") : ctx.funcMap.get("__array_from_iter");
  const getIdxFn = ctx.funcMap.get("__extern_get_idx");
  const isUndefFn = ctx.funcMap.get("__extern_is_undefined");
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (iterIdx === undefined || getIdxFn === undefined) {
    return [{ op: "ref.null", typeIdx: tupleTypeIdx }];
  }

  const matLocal = allocLocal(fctx, `__tup_mat_${fctx.locals.length}`, { kind: "externref" });

  // Build field extraction
  const fieldExtracts: Instr[] = [];
  for (let i = 0; i < tupleFields.length; i++) {
    const fieldType = tupleFields[i]!;
    // matLocal[i] via __extern_get_idx(matLocal, f64(i))
    fieldExtracts.push(
      { op: "local.get", index: matLocal },
      { op: "f64.const", value: i },
      { op: "call", funcIdx: getIdxFn },
    );
    // Coerce externref element to tuple field type
    if (fieldType.kind === "f64" && unboxIdx !== undefined) {
      fieldExtracts.push({ op: "call", funcIdx: unboxIdx });
    } else if (fieldType.kind === "i32" && unboxIdx !== undefined) {
      fieldExtracts.push({ op: "call", funcIdx: unboxIdx });
      fieldExtracts.push({ op: "i32.trunc_sat_f64_s" });
    } else if (fieldType.kind === "externref") {
      // same type, no coercion
    } else if (fieldType.kind === "ref" || fieldType.kind === "ref_null") {
      const toIdx = (fieldType as { typeIdx: number }).typeIdx;
      fieldExtracts.push({ op: "any.convert_extern" });
      fieldExtracts.push({ op: "ref.cast_null", typeIdx: toIdx });
    } else if (fieldType.kind === "f64") {
      // unbox unavailable — fall back to NaN
      fieldExtracts.push({ op: "drop" });
      fieldExtracts.push({ op: "f64.const", value: NaN });
    } else if (fieldType.kind === "i32") {
      fieldExtracts.push({ op: "drop" });
      fieldExtracts.push({ op: "i32.const", value: 0 });
    }
  }

  // Result shape: if (isNull || isUndefined) then ref.null else build tuple.
  // Native `__array_from_iter_n(externref, f64)` takes a count arg — pass `-1`
  // (unbounded drain, byte-semantics-equivalent to the host `__array_from_iter`).
  const buildTupleInstrs: Instr[] = [
    { op: "local.get", index: externLocal },
    ...(useNativeFromIter ? ([{ op: "f64.const", value: -1 }] satisfies Instr[]) : []),
    { op: "call", funcIdx: iterIdx },
    { op: "local.set", index: matLocal },
    ...fieldExtracts,
    { op: "struct.new", typeIdx: tupleTypeIdx },
  ];

  // Preserve null/undefined so the callee's destructure guard can throw
  // TypeError per spec (RequireObjectCoercible). Without this check,
  // __array_from_iter(null) returns [] silently, which skips the guard.
  if (isUndefFn !== undefined) {
    return [
      { op: "local.get", index: externLocal },
      { op: "ref.is_null" },
      { op: "local.get", index: externLocal },
      { op: "call", funcIdx: isUndefFn },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "ref_null", typeIdx: tupleTypeIdx } as ValType },
        then: [{ op: "ref.null", typeIdx: tupleTypeIdx }],
        else: buildTupleInstrs,
      },
    ];
  }
  return [
    { op: "local.get", index: externLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: tupleTypeIdx } as ValType },
      then: [{ op: "ref.null", typeIdx: tupleTypeIdx }],
      else: buildTupleInstrs,
    },
  ];
}

/**
 * (#4451) Is there no way for a tuple element of type `elem` to reach a tuple
 * slot of type `slot`? True exactly when one side lives in a numeric
 * representation and the other in a reference one: no instruction turns a raw
 * `f64`/`i32` into a GC reference, or a GC reference into a number.
 * (`externref` is excluded — box/unbox bridge it, and those rows are handled
 * above.)
 */
function tupleSlotIsUnreachableFrom(elem: ValType, slot: ValType): boolean {
  const isNumeric = (vt: ValType): boolean =>
    vt.kind === "f64" || vt.kind === "f32" || vt.kind === "i32" || vt.kind === "i64";
  const isGcRef = (vt: ValType): boolean => vt.kind === "ref" || vt.kind === "ref_null";
  return (isNumeric(elem) && isGcRef(slot)) || (isGcRef(elem) && isNumeric(slot));
}

/**
 * Build instructions to construct a tuple struct from an externref value at runtime.
 * Tries each known vec type via ref.test; if one matches, extracts elements and
 * constructs the tuple. When no vec type matches, falls back to iterable
 * materialization via `__array_from_iter` + `__extern_get_idx` so that JS
 * iterables (generators, custom @@iterator, plain JS arrays) also coerce
 * correctly into the tuple shape. Null/undefined externrefs propagate as
 * ref.null so the callee's destructure guard fires a spec TypeError (#1161).
 *
 * This handles the case where an externref wraps a vec (e.g. __vec_f64 from [1,2,3])
 * OR a JS iterable, but the target parameter type is a tuple struct (__tuple_*).
 */
function buildTupleFromExternref(
  ctx: CodegenContext,
  fctx: FunctionContext,
  anyLocal: number,
  tupleTypeIdx: number,
  tupleFields: ValType[],
  externLocal?: number,
): Instr[] {
  const resultType: ValType = { kind: "ref_null", typeIdx: tupleTypeIdx };

  // Terminal fallback when no vec type matches: if we have the original
  // externref, materialize it via __array_from_iter and read each tuple
  // field by index. This lets iterables (generators, custom @@iterator)
  // flow into binding-pattern params without throwing "Cannot destructure"
  // prematurely. Preserve null/undefined by leaving ref.null in those
  // cases so the callee's destructure guard throws a spec TypeError. (#1161)
  let instrs: Instr[] = buildTupleFromIterableFallback(ctx, fctx, externLocal, tupleTypeIdx, tupleFields);

  for (const [_key, vecIdx] of ctx.vecTypeMap) {
    const vecInfo = getVecInfo(ctx, vecIdx);
    if (!vecInfo) continue;

    const { arrTypeIdx, elemType } = vecInfo;

    // Build the then-branch: cast to this vec, extract elements, build tuple
    const vecLocal = allocLocal(fctx, `__tup_vec_${fctx.locals.length}`, { kind: "ref_null", typeIdx: vecIdx });
    const dataLocal = allocLocal(fctx, `__tup_data_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    } as ValType);
    const lenLocal = allocLocal(fctx, `__tup_len_${fctx.locals.length}`, { kind: "i32" });

    const thenInstrs: Instr[] = [
      { op: "local.get", index: anyLocal },
      { op: "ref.cast", typeIdx: vecIdx },
      { op: "local.set", index: vecLocal },
      // Get data array and length
      { op: "local.get", index: vecLocal },
      { op: "struct.get", typeIdx: vecIdx, fieldIdx: 1 },
      { op: "local.set", index: dataLocal },
      { op: "local.get", index: vecLocal },
      { op: "struct.get", typeIdx: vecIdx, fieldIdx: 0 },
      { op: "local.set", index: lenLocal },
    ];

    // (#2934) Packed i8/i16 vec elements (byte/short typed arrays) read with
    // `array.get_u`/`get_s` and live on the stack widened to i32 — a plain
    // `array.get` on a packed array and a packed `if` result type are both
    // invalid Wasm. This chain tests every vec type at runtime (the shared
    // i8_byte vec serves Int8Array AND Uint8Array), so no view name exists
    // here — use the storage-kind heuristic for the read op.
    const readType = unpackedElemType(elemType);
    const readOp = elemGetOp(elemType, undefined);

    // For each tuple field, bounds-checked read from the vec
    for (let i = 0; i < tupleFields.length; i++) {
      const fieldType = tupleFields[i]!;

      // Bounds check: if i < len, read data[i]; else default
      const readInstrs: Instr[] = [
        { op: "local.get", index: dataLocal },
        { op: "i32.const", value: i },
        { op: readOp, typeIdx: arrTypeIdx },
      ];

      const defaultInstrs: Instr[] = defaultValueInstrs(readType);

      thenInstrs.push(
        { op: "i32.const", value: i },
        { op: "local.get", index: lenLocal },
        { op: "i32.lt_u" },
        {
          op: "if",
          blockType: { kind: "val" as const, type: readType },
          then: readInstrs,
          else: defaultInstrs,
        },
      );

      // (#2934) A packed element arrives as the widened i32; lift it to f64 (a
      // JS number) so the generic coercion arms below (which only know
      // f64/externref/ref) apply. `convert_i32_s` is correct for both
      // signednesses — get_u/get_s already produced the small-range i32.
      let effElemType = elemType;
      if (readType.kind === "i32" && elemType.kind !== "i32") {
        thenInstrs.push({ op: "f64.convert_i32_s" });
        effElemType = { kind: "f64" };
      }

      // Coerce element type to tuple field type if needed
      if (
        effElemType.kind !== fieldType.kind ||
        ((effElemType.kind === "ref" || effElemType.kind === "ref_null") &&
          (fieldType.kind === "ref" || fieldType.kind === "ref_null") &&
          (effElemType as { typeIdx: number }).typeIdx !== (fieldType as { typeIdx: number }).typeIdx)
      ) {
        // Ensure __box_number / __unbox_number are imported before use (#822)
        if (
          (effElemType.kind === "f64" && fieldType.kind === "externref") ||
          (effElemType.kind === "externref" && fieldType.kind === "f64")
        ) {
          addUnionImports(ctx);
        }
        // Inline coercion: most common case is f64 → externref (box) or externref → f64 (unbox)
        if (effElemType.kind === "f64" && fieldType.kind === "externref") {
          const boxIdx = ctx.funcMap.get("__box_number");
          if (boxIdx !== undefined) {
            thenInstrs.push({ op: "call", funcIdx: boxIdx });
          }
        } else if (effElemType.kind === "externref" && fieldType.kind === "f64") {
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            thenInstrs.push({ op: "call", funcIdx: unboxIdx });
          }
        } else if (effElemType.kind === "f64" && fieldType.kind === "f64") {
          // same type, no coercion needed
        } else if (effElemType.kind === "externref" && fieldType.kind === "externref") {
          // same type, no coercion needed
        } else if ((effElemType.kind === "ref" || effElemType.kind === "ref_null") && fieldType.kind === "externref") {
          thenInstrs.push({ op: "extern.convert_any" });
        } else if (effElemType.kind === "externref" && (fieldType.kind === "ref" || fieldType.kind === "ref_null")) {
          const toRefIdx = (fieldType as { typeIdx: number }).typeIdx;
          thenInstrs.push({ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: toRefIdx });
        } else if (effElemType.kind === "i32" && fieldType.kind === "f64") {
          thenInstrs.push({ op: "f64.convert_i32_s" });
        } else if (effElemType.kind === "f64" && fieldType.kind === "i32") {
          thenInstrs.push({ op: "i32.trunc_sat_f64_s" });
        } else if (tupleSlotIsUnreachableFrom(effElemType, fieldType)) {
          // (#4451) No conversion exists, so give the slot its own default.
          //
          // This chain speculatively `ref.test`s EVERY known vec type, so the
          // numeric vecs (`__vec_f64`) get an arm even when the tuple's slot is
          // a GC reference — as in `Object.entries(rec).sort(([l], [r]) => …)`,
          // whose comparator parameter is a `[string, Sig]` tuple. A raw f64 can
          // never inhabit that slot, and leaving it on the stack made
          // `struct.new` ill-typed and the whole MODULE invalid
          // ("struct.new[1] expected type (ref null N), found if of type f64")
          // even though the arm is unreachable at run time. Falling through with
          // no instruction at all was the defect; the slot's default keeps the
          // arm well-typed, matching the out-of-bounds guard just above and the
          // `ref.null` convention of `buildTupleFromIterableFallback`.
          thenInstrs.push({ op: "drop" }, ...defaultValueInstrs(fieldType));
        }
      }
    }

    // Construct the tuple
    thenInstrs.push({ op: "struct.new", typeIdx: tupleTypeIdx });

    // Wrap in: ref.test(vecIdx) → if then: build tuple, else: previous chain
    instrs = [
      { op: "local.get", index: anyLocal },
      { op: "ref.test", typeIdx: vecIdx },
      {
        op: "if",
        blockType: { kind: "val", type: resultType },
        then: thenInstrs,
        else: instrs,
      },
    ];
  }

  return instrs;
}

/**
 * Check if a type index corresponds to a tuple struct (__tuple_*) and return
 * its field types if so.
 */
function getTupleFields(ctx: CodegenContext, typeIdx: number): ValType[] | null {
  const typeDef = ctx.mod.types[typeIdx];
  if (!typeDef || typeDef.kind !== "struct") return null;
  const sd = typeDef as StructTypeDef;
  if (!sd.name?.startsWith("__tuple_")) return null;
  return sd.fields.map((f) => f.type);
}

/**
 * Emit instructions to convert a vec struct on the stack to a tuple struct,
 * or between two different vec types (e.g. vec_externref -> vec_f64).
 * Returns true if conversion was emitted, false if the types don't match.
 *
 * Vec layout:  struct { $length: i32, $data: ref $arr }
 * Tuple layout: struct { $_0: T0, $_1: T1, ... }
 */
/**
 * Check if the source and destination are both named struct types (__anon_*)
 * where the destination fields are a subset of the source fields. If so, emit
 * field-by-field extraction to construct the narrower struct.
 */
function getStructNarrowInfo(
  ctx: CodegenContext,
  fromTypeIdx: number,
  toTypeIdx: number,
): {
  srcFields: { name: string; type: ValType; fieldIdx: number }[];
  dstFields: { name: string; type: ValType }[];
} | null {
  const fromDef = ctx.mod.types[fromTypeIdx];
  const toDef = ctx.mod.types[toTypeIdx];
  if (!fromDef || fromDef.kind !== "struct") return null;
  if (!toDef || toDef.kind !== "struct") return null;
  const srcStruct = fromDef as StructTypeDef;
  const dstStruct = toDef as StructTypeDef;

  // Build field name -> index map for source struct
  const srcFieldMap = new Map<string, { type: ValType; fieldIdx: number }>();
  for (let i = 0; i < srcStruct.fields.length; i++) {
    srcFieldMap.set(srcStruct.fields[i]!.name, { type: srcStruct.fields[i]!.type, fieldIdx: i });
  }

  // Check if all destination fields exist in the source
  const srcFields: { name: string; type: ValType; fieldIdx: number }[] = [];
  for (const field of dstStruct.fields) {
    const srcField = srcFieldMap.get(field.name);
    if (!srcField) return null; // field not found in source
    srcFields.push({ name: field.name, type: srcField.type, fieldIdx: srcField.fieldIdx });
  }

  return {
    srcFields,
    dstFields: dstStruct.fields.map((f) => ({ name: f.name, type: f.type })),
  };
}

function emitSafeStructConversion(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fromTypeIdx: number,
  toTypeIdx: number,
): boolean {
  // Case 1: vec -> tuple
  const srcVec = getVecInfo(ctx, fromTypeIdx);
  if (srcVec) {
    const tupleFields = getTupleFields(ctx, toTypeIdx);
    if (tupleFields) {
      return emitVecToTupleBody(ctx, fctx, fromTypeIdx, toTypeIdx, srcVec, tupleFields);
    }

    // Case 2: vec -> vec (different element types)
    const dstVec = getVecInfo(ctx, toTypeIdx);
    if (dstVec && srcVec.elemType.kind !== dstVec.elemType.kind) {
      return emitVecToVecBody(ctx, fctx, fromTypeIdx, toTypeIdx, srcVec, dstVec);
    }
    // Also handle vec -> vec where both are ref but different typeIdx
    if (
      dstVec &&
      (srcVec.elemType.kind === "ref" || srcVec.elemType.kind === "ref_null") &&
      (dstVec.elemType.kind === "ref" || dstVec.elemType.kind === "ref_null")
    ) {
      const srcRefIdx = (srcVec.elemType as { typeIdx: number }).typeIdx;
      const dstRefIdx = (dstVec.elemType as { typeIdx: number }).typeIdx;
      if (srcRefIdx !== dstRefIdx) {
        return emitVecToVecBody(ctx, fctx, fromTypeIdx, toTypeIdx, srcVec, dstVec);
      }
    }
  }

  // (#1299) Wasm GC subtype check: if `from` is a declared subtype of `to`
  // (via `superTypeIdx` chain on the struct definitions), no conversion is
  // needed — the value on the stack is already valid as the wider type.
  // Skipping the field-by-field copy here PRESERVES the runtime subclass
  // identity, which is required for virtual method dispatch on
  // base-typed locals (e.g. `const a: Base = new A(); a.id()` where `id`
  // is overridden in `A`).
  if (isDeclaredStructSubtype(ctx, fromTypeIdx, toTypeIdx)) {
    return true;
  }

  // (#2161 B0) Vec-SHAPED source struct → genuine vec: ELEMENT COPY, never the
  // struct-narrow field copy below. `getVecInfo` only recognises structs NAMED
  // `__vec_*`, so the `$__regexp_match_vec` subtype (a `{length, data}` vec
  // prefix + index/input/groups/indices result fields, #1914/#2588/#2589)
  // missed Case 2 above and fell into struct narrowing. Narrowing "copies" the
  // `data` field with a guarded ref-cast to the DESTINATION's array type —
  // `__arr_ref_<anyStr>` never passes `ref.test $__arr_externref`, so the else
  // arm produced null and the trailing non-null assert TRAPPED ("dereferencing
  // a null pointer": every harness call passing a match result to an `any[]`
  // param, e.g. `assert_compareArray("foo".match(re), ["foo"])`). Element-wise
  // copy coerces each nullable-native-string capture to the destination element
  // (null captures = `undefined` flow through as null externrefs). Checked
  // AFTER the declared-subtype fast path so a match-vec flowing to its own base
  // vec keeps identity (no copy).
  if (!srcVec) {
    const vecShaped = getVecShapedInfo(ctx, fromTypeIdx);
    if (vecShaped) {
      const dstVec = getVecInfo(ctx, toTypeIdx);
      if (dstVec) {
        const srcRefIdx =
          vecShaped.elemType.kind === "ref" || vecShaped.elemType.kind === "ref_null"
            ? (vecShaped.elemType as { typeIdx: number }).typeIdx
            : undefined;
        const dstRefIdx =
          dstVec.elemType.kind === "ref" || dstVec.elemType.kind === "ref_null"
            ? (dstVec.elemType as { typeIdx: number }).typeIdx
            : undefined;
        if (vecShaped.elemType.kind !== dstVec.elemType.kind || srcRefIdx !== dstRefIdx) {
          return emitVecToVecBody(ctx, fctx, fromTypeIdx, toTypeIdx, vecShaped, dstVec);
        }
      }
    }
  }

  // Case 3: struct narrowing — destination fields are a subset of source fields
  const narrowInfo = getStructNarrowInfo(ctx, fromTypeIdx, toTypeIdx);
  if (narrowInfo) {
    return emitStructNarrowBody(ctx, fctx, fromTypeIdx, toTypeIdx, narrowInfo);
  }

  return false;
}

/** Returns true if `fromTypeIdx` is a declared Wasm subtype of `toTypeIdx`
 *  via the struct `superTypeIdx` chain (or identical types). Used to skip
 *  field-copy narrowing when the source ref is already a valid wider ref
 *  under Wasm GC subtyping (#1299). */
function isDeclaredStructSubtype(ctx: CodegenContext, fromTypeIdx: number, toTypeIdx: number): boolean {
  if (fromTypeIdx === toTypeIdx) return true;
  let cur: number | undefined = fromTypeIdx;
  let depth = 0;
  while (cur !== undefined && depth < 64) {
    if (cur === toTypeIdx) return true;
    const def: TypeDef | undefined = ctx.mod.types[cur];
    if (!def || def.kind !== "struct") return false;
    cur = (def as StructTypeDef).superTypeIdx;
    depth++;
  }
  return false;
}

/** Emit vec -> tuple conversion body */
function emitVecToTupleBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fromTypeIdx: number,
  toTypeIdx: number,
  srcVec: { arrTypeIdx: number; elemType: ValType },
  tupleFields: ValType[],
): boolean {
  const { arrTypeIdx, elemType } = srcVec;

  // Save the vec ref to a temp local (must be ref_null since locals need a default value)
  const vecRefType: ValType = { kind: "ref_null", typeIdx: fromTypeIdx };
  const tmpLocal = allocTempLocal(fctx, vecRefType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // Save the data array and length for bounds checking
  const dataLocal = allocTempLocal(fctx, { kind: "ref_null", typeIdx: arrTypeIdx } as ValType);
  const lenLocal = allocTempLocal(fctx, { kind: "i32" });
  fctx.body.push({ op: "local.get", index: tmpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.set", index: dataLocal });
  fctx.body.push({ op: "local.get", index: tmpLocal });
  fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: 0 });
  fctx.body.push({ op: "local.set", index: lenLocal });

  // (#2934) Packed i8/i16 vec elements read with `array.get_u`/`get_s` and
  // arrive on the stack widened to i32 — a plain `array.get` on a packed array
  // and a packed `if` result type are both invalid Wasm. No view name is
  // available on this generic coercion path, so use the storage-kind heuristic.
  const readType = unpackedElemType(elemType);
  const readOp = elemGetOp(elemType, undefined);

  // For each tuple field, read from the vec's data array with bounds check and coerce
  for (let i = 0; i < tupleFields.length; i++) {
    const fieldType = tupleFields[i]!;

    // Bounds-checked read: if i < len, read data[i]; else push default
    fctx.body.push({ op: "i32.const", value: i });
    fctx.body.push({ op: "local.get", index: lenLocal });
    fctx.body.push({ op: "i32.lt_u" });

    const thenInstrs: Instr[] = [
      { op: "local.get", index: dataLocal },
      { op: "i32.const", value: i },
      { op: readOp, typeIdx: arrTypeIdx },
    ];
    const elseInstrs: Instr[] = defaultValueInstrs(readType);

    fctx.body.push({
      op: "if",
      blockType: { kind: "val" as const, type: readType },
      then: thenInstrs,
      else: elseInstrs,
    });

    // Coerce the READ value's type (widened i32 for packed elements, #2934) to
    // the tuple field type if needed
    if (readType.kind !== fieldType.kind) {
      coerceType(ctx, fctx, readType, fieldType);
    } else if (
      (readType.kind === "ref" || readType.kind === "ref_null") &&
      (fieldType.kind === "ref" || fieldType.kind === "ref_null")
    ) {
      const fromRefIdx = (elemType as { typeIdx: number }).typeIdx;
      const toRefIdx = (fieldType as { typeIdx: number }).typeIdx;
      if (fromRefIdx !== toRefIdx) {
        coerceType(ctx, fctx, elemType, fieldType);
      }
    }
  }

  releaseTempLocal(fctx, lenLocal);
  releaseTempLocal(fctx, dataLocal);

  // Construct the tuple struct
  fctx.body.push({ op: "struct.new", typeIdx: toTypeIdx });

  releaseTempLocal(fctx, tmpLocal);
  return true;
}

/** Emit vec -> vec conversion body (element-by-element with coercion) */
function emitVecToVecBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fromTypeIdx: number,
  toTypeIdx: number,
  srcVec: { arrTypeIdx: number; elemType: ValType },
  dstVec: { arrTypeIdx: number; elemType: ValType },
): boolean {
  // Save the source vec ref to a temp local
  const srcRefType: ValType = { kind: "ref_null", typeIdx: fromTypeIdx };
  const srcLocal = allocTempLocal(fctx, srcRefType);
  fctx.body.push({ op: "local.set", index: srcLocal });

  // Get the length from the source vec
  fctx.body.push({ op: "local.get", index: srcLocal });
  fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: 0 }); // length (i32)

  // Allocate a temp for the length
  const lenLocal = allocTempLocal(fctx, { kind: "i32" });
  fctx.body.push({ op: "local.tee", index: lenLocal });

  // Create the destination array: array.new_default $dstArr length
  fctx.body.push({ op: "array.new_default", typeIdx: dstVec.arrTypeIdx });

  // Save the new array to a temp local
  const dstArrRefType: ValType = { kind: "ref_null", typeIdx: dstVec.arrTypeIdx };
  const dstArrLocal = allocTempLocal(fctx, dstArrRefType);
  fctx.body.push({ op: "local.set", index: dstArrLocal });

  // Loop: copy elements with coercion using nested block/loop structure.
  // We capture the loop body by recording the fctx.body position before and after
  // emitting, then splicing the instructions into a nested block/loop. This avoids
  // swapping fctx.body which would break addUnionImports index shifting.
  const iLocal = allocTempLocal(fctx, { kind: "i32" });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iLocal });

  const loopBodyStart = fctx.body.length;

  // if (i >= len) break out of block (depth 1 from loop body)
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "i32.ge_u" });
  fctx.body.push({ op: "br_if", depth: 1 });

  // dstArr[i] = coerce(srcArr[i])
  fctx.body.push({ op: "local.get", index: dstArrLocal });
  fctx.body.push({ op: "local.get", index: iLocal });
  // Read source element. (#2934 1c) A packed i8/i16 source (byte/short typed
  // array backing) must read with `array.get_u`/`get_s` — a plain `array.get`
  // on a packed array is invalid Wasm. No view name exists on this generic
  // coercion path (the i8_byte array type is shared by Int8Array AND
  // Uint8Array), so use the storage-kind heuristic; the read value is the
  // widened i32.
  fctx.body.push({ op: "local.get", index: srcLocal });
  fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: 1 });
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: elemGetOp(srcVec.elemType, undefined), typeIdx: srcVec.arrTypeIdx });
  const readElemType = unpackedElemType(srcVec.elemType);
  // Coerce element type. Important: comparing only `.kind` is insufficient
  // when both sides are `ref` / `ref_null` to DIFFERENT struct types — e.g.
  // a vec of `IncompatibleKeyError` being copied into a vec of `__anon_24`
  // (#1289 — ESLint `FileReport.addRuleMessage` failure). Both have
  // `kind: "ref"`, so the old check skipped the coercion and the
  // `array.set` below saw a value of the wrong element type, failing Wasm
  // validation. Force a coercion when the typeIdx differs too.
  const srcKind = readElemType.kind;
  const dstKind = dstVec.elemType.kind;
  const srcRefIdx =
    srcKind === "ref" || srcKind === "ref_null" ? (readElemType as { typeIdx: number }).typeIdx : undefined;
  const dstRefIdx =
    dstKind === "ref" || dstKind === "ref_null" ? (dstVec.elemType as { typeIdx: number }).typeIdx : undefined;
  const needsCoerce = srcKind !== dstKind || srcRefIdx !== dstRefIdx;
  // (#2161/#2106) RegExp match vectors use a nullable native-string slot for
  // unmatched captures. When that slot crosses the compareArray-style `any[]`
  // boundary, preserve its JS meaning: the singleton regime represents
  // `undefined` as a tag-1 externref, not as a null externref.
  const undefinedInstrs =
    srcKind === "ref_null" && srcRefIdx === ctx.anyStrTypeIdx && dstKind === "externref"
      ? undefinedExternInstrs(ctx)
      : undefined;
  if (undefinedInstrs) {
    const elemLocal = allocTempLocal(fctx, readElemType);
    fctx.body.push(
      { op: "local.tee", index: elemLocal },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: undefinedInstrs,
        else: [{ op: "local.get", index: elemLocal }, { op: "extern.convert_any" }],
      },
    );
    releaseTempLocal(fctx, elemLocal);
  } else if (needsCoerce) {
    coerceType(ctx, fctx, readElemType, dstVec.elemType);
  }
  // Write to destination
  fctx.body.push({ op: "array.set", typeIdx: dstVec.arrTypeIdx });

  // i++
  fctx.body.push({ op: "local.get", index: iLocal });
  fctx.body.push({ op: "i32.const", value: 1 });
  fctx.body.push({ op: "i32.add" });
  fctx.body.push({ op: "local.set", index: iLocal });

  // continue loop (depth 0 = innermost = loop)
  fctx.body.push({ op: "br", depth: 0 });

  // Splice the emitted loop body into a nested block/loop structure
  const loopBody = fctx.body.splice(loopBodyStart);
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: loopBody,
      },
    ],
  });

  // Construct the destination vec struct: { length, dstArr }
  fctx.body.push({ op: "local.get", index: lenLocal });
  fctx.body.push({ op: "local.get", index: dstArrLocal });
  fctx.body.push({ op: "struct.new", typeIdx: toTypeIdx });

  releaseTempLocal(fctx, iLocal);
  releaseTempLocal(fctx, dstArrLocal);
  releaseTempLocal(fctx, lenLocal);
  releaseTempLocal(fctx, srcLocal);
  return true;
}

/** Emit struct narrowing: extract a subset of fields from a larger struct */
function emitStructNarrowBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fromTypeIdx: number,
  toTypeIdx: number,
  info: {
    srcFields: { name: string; type: ValType; fieldIdx: number }[];
    dstFields: { name: string; type: ValType }[];
  },
): boolean {
  // Save the source struct ref to a temp local
  const srcRefType: ValType = { kind: "ref_null", typeIdx: fromTypeIdx };
  const tmpLocal = allocTempLocal(fctx, srcRefType);
  fctx.body.push({ op: "local.set", index: tmpLocal });

  // For each destination field, get the corresponding source field
  for (let i = 0; i < info.dstFields.length; i++) {
    const srcField = info.srcFields[i]!;
    const dstField = info.dstFields[i]!;

    fctx.body.push({ op: "local.get", index: tmpLocal });
    fctx.body.push({ op: "struct.get", typeIdx: fromTypeIdx, fieldIdx: srcField.fieldIdx });

    // Coerce if types differ
    if (srcField.type.kind !== dstField.type.kind) {
      coerceType(ctx, fctx, srcField.type, dstField.type);
    } else if (
      (srcField.type.kind === "ref" || srcField.type.kind === "ref_null") &&
      (dstField.type.kind === "ref" || dstField.type.kind === "ref_null")
    ) {
      const fromRefIdx = (srcField.type as { typeIdx: number }).typeIdx;
      const toRefIdx = (dstField.type as { typeIdx: number }).typeIdx;
      if (fromRefIdx !== toRefIdx) {
        coerceType(ctx, fctx, srcField.type, dstField.type);
      }
    }
  }

  // Construct the destination struct
  fctx.body.push({ op: "struct.new", typeIdx: toTypeIdx });

  releaseTempLocal(fctx, tmpLocal);
  return true;
}

/**
 * (#2864 wave-2 S1) Box an UNDEF-SENTINEL-branded f64 (top of stack) to
 * externref: the `UNDEF_F64_BITS` pattern becomes the lane's canonical
 * `undefined`, everything else goes through `__box_number`.
 *
 * Deliberately INLINED rather than importing `sentinelAwareF64BoxInstrs` from
 * `generators-native.js` — that module reaches back into the coercion engine,
 * and `iterator-native.ts` already set the precedent of inlining this same
 * four-instruction recipe to keep the dependency edge one-way.
 *
 * The `undefined` producer is lane-dependent and READ-ONLY (`funcMap.get`, no
 * late-import registration mid-body, which would shift funcidxs under the
 * caller): under a JS host the null externref surfaces as JS `null` and is
 * `!== undefined`, so the host lane needs the real `__get_undefined`; in
 * standalone/native-strings the null externref IS the canonical `undefined`
 * (`__extern_is_undefined` is `ref.is_null`), with the #2106 S1 singleton taking
 * precedence when that regime is active.
 */
function undefSentinelAwareBoxInstrs(ctx: CodegenContext, f64ScratchIdx: number, boxNumberIdx: number): Instr[] {
  const undefinedInstrs = canonicalUndefinedExternInstrs(ctx);
  return [
    { op: "local.tee", index: f64ScratchIdx },
    { op: "i64.reinterpret_f64" },
    { op: "i64.const", value: UNDEF_F64_BITS },
    { op: "i64.eq" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: undefinedInstrs,
      else: [
        { op: "local.get", index: f64ScratchIdx },
        { op: "call", funcIdx: boxNumberIdx },
      ],
    },
  ];
}

/**
 * Coerce a Wasm value on the stack from one type to another.
 *
 * @param toPrimitiveHint Optional ToPrimitive hint ("number", "string", or "default").
 *   When converting ref → f64 or ref → externref, the hint determines which string
 *   is passed to [Symbol.toPrimitive]. If not specified, defaults to "number" for
 *   f64 targets and "string" for externref targets.
 * @param compileStringLiteralFn Deprecated — no longer used, kept for API compat.
 */
export function coerceType(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  to: ValType,
  toPrimitiveHint?: "number" | "string" | "default",
  compileStringLiteralFn?: CompileStringLiteralFn,
): void {
  const fromKind = from.kind === "i8" || from.kind === "i16" ? "i32" : from.kind;
  const toKind = to.kind === "i8" || to.kind === "i16" ? "i32" : to.kind;
  if (from.kind !== fromKind || to.kind !== toKind) {
    if (fromKind === toKind) return;
    if (fromKind === "i32" && toKind === "f64") {
      fctx.body.push({ op: "f64.convert_i32_s" });
      return;
    }
    if (fromKind === "f64" && toKind === "i32") {
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      return;
    }
  }

  if (from.kind === to.kind) {
    // Same kind but check if ref typeIdx differs (e.g. ref $AnyValue vs ref $SomeStruct)
    if ((from.kind === "ref" || from.kind === "ref_null") && (to.kind === "ref" || to.kind === "ref_null")) {
      const fromIdx = (from as { typeIdx: number }).typeIdx;
      const toIdx = (to as { typeIdx: number }).typeIdx;
      if (fromIdx === toIdx) return;
      // Boxing: non-any ref → any ref (#2104: via boxToAny → __any_box_ref)
      if (isAnyValue(to, ctx) && !isAnyValue(from, ctx)) {
        ensureAnyHelpers(ctx);
        if (boxToAny(ctx, fctx, from, "unknown")) {
          return;
        }
      }
      // Unboxing: any ref → non-any ref (extract refval and cast)
      if (isAnyValue(from, ctx) && !isAnyValue(to, ctx)) {
        ensureAnyHelpers(ctx);
        // (#1988 / #745 S3) A native string is boxed into $AnyValue tag 5 with
        // its payload in `externval` (field 4, externref-wrapped $AnyString) —
        // NOT `refval` (field 3, eqref). The `ref_null → ref` arm below got the
        // externval handling in #1988, but this same-kind (`ref_null → ref_null`)
        // arm kept reading field 3 only, so unboxing a tag-5 string box to a
        // nullable native-string target always produced null (a `number|string`
        // $AnyValue local compared `=== "lit"` answered false — #745 S3).
        // Mirror the #1988 native-string-target path here.
        const toIdxStr = (to as { typeIdx: number }).typeIdx;
        const isNativeStrTarget =
          ctx.nativeStrings &&
          (toIdxStr === ctx.anyStrTypeIdx || (ctx.nativeStrTypeIdx >= 0 && toIdxStr === ctx.nativeStrTypeIdx));
        if (isNativeStrTarget) {
          fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 4 }); // externval
          fctx.body.push({ op: "any.convert_extern" });
          fctx.body.push(
            ...guardedRefCastInstrs(fctx, toIdxStr, {
              tempType: { kind: "anyref" } as ValType,
              nonNull: to.kind === "ref",
            }),
          );
          return;
        }
        // Get the refval field (eqref), then guarded ref.cast to target type
        fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 });
        // Guard: ref.test before ref.cast to avoid illegal cast traps
        // Non-null `(ref)` target appends `ref.as_non_null` (nonNull); the
        // `ref_null` target's original `if` blockType `to` is byte-identical to
        // the helper's `ref_null $toIdx`.
        fctx.body.push(
          ...guardedRefCastInstrs(fctx, toIdx, { tempType: { kind: "eqref" } as ValType, nonNull: to.kind === "ref" }),
        );
        return;
      }
      // Different struct types, neither is AnyValue.
      // Check if this is a vec-to-tuple conversion (array passed to destructuring param).
      // Vec structs have layout: { $length: i32, $data: ref $arr }
      // Tuple structs have layout: { $_0: T0, $_1: T1, ... }
      // A blind ref.cast would trap since they are unrelated types.
      if (emitSafeStructConversion(ctx, fctx, fromIdx, toIdx)) {
        return;
      }
      // For related struct types (subtypes), use guarded ref.cast to avoid
      // illegal cast traps when runtime type differs from static type.
      // (#2853 park fix) If from/to are same-layout sibling shapes, this guarded
      // downcast would trap post-brand — exclude both from nominal branding.
      markNoBrandSiblingShapes(ctx.mod.types, ctx.noBrandShapeTypes, fromIdx, toIdx);
      // `guardFrom` was always `anyref` (both ternary arms), preserved as tempType;
      // non-null `(ref)` target appends `ref.as_non_null` via nonNull.
      fctx.body.push(
        ...guardedRefCastInstrs(fctx, toIdx, { tempType: { kind: "anyref" } as ValType, nonNull: to.kind === "ref" }),
      );
      return;
    }
    return;
  }
  const symbolBoundary = symbolBoundaryCoercionInstrs(ctx, from, to, fctx);
  if (symbolBoundary) {
    fctx.body.push(...symbolBoundary);
    return;
  }
  // ref is a subtype of ref_null — no coercion needed for same typeIdx
  if (from.kind === "ref" && to.kind === "ref_null") {
    // But check for any-value boxing (ref $X → ref_null $AnyValue) (#2104)
    if (isAnyValue(to, ctx) && !isAnyValue(from, ctx)) {
      ensureAnyHelpers(ctx);
      if (boxToAny(ctx, fctx, from, "unknown")) {
        return;
      }
    }
    // (#4178) Unboxing: ref $AnyValue → ref_null $X. The three SIBLING arms
    // (`ref_null→ref_null` above, `ref_null→ref` and `ref→ref` below) all carry
    // this case; this one did NOT, so a non-null `$AnyValue` flowing into a
    // NULLABLE target fell through to the generic guarded `ref.cast` below —
    // which tests the BOX against the target type, always fails, and stores
    // `ref.null`. `compileAnyBinaryDispatch` returns exactly `{kind:"ref",
    // typeIdx:$AnyValue}`, so every `any`-operand `+`/`-`/`*` result assigned to
    // a nullable native-string (or any other) slot became null — the value is
    // then dereferenced by the next `__str_concat`/`.length` and TRAPS
    // ("dereferencing a null pointer"). That is the whole of the
    // `coercion/arithmetic-add` any-concat family and of the mixed-type-ternary
    // `"" + v` report in #4178. Mirrors the `ref_null → ref` arm verbatim except
    // for `nonNull: false` (the target is nullable here).
    if (isAnyValue(from, ctx) && !isAnyValue(to, ctx)) {
      ensureAnyHelpers(ctx);
      const toUnboxIdx = (to as { typeIdx: number }).typeIdx;
      // A native string lives in `externval` (field 4), NOT `refval` (field 3) —
      // the same #1988 split the sibling arms document.
      const isNativeStrTargetHere =
        ctx.nativeStrings &&
        (toUnboxIdx === ctx.anyStrTypeIdx || (ctx.nativeStrTypeIdx >= 0 && toUnboxIdx === ctx.nativeStrTypeIdx));
      if (isNativeStrTargetHere) {
        fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 4 }); // externval
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push(
          ...guardedRefCastInstrs(fctx, toUnboxIdx, { tempType: { kind: "anyref" } as ValType, nonNull: false }),
        );
        return;
      }
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 }); // refval
      fctx.body.push(
        ...guardedRefCastInstrs(fctx, toUnboxIdx, { tempType: { kind: "eqref" } as ValType, nonNull: false }),
      );
      return;
    }
    // ref $X is a subtype of ref_null $X for same typeIdx — no coercion needed.
    // For different typeIdx, cast to target type (handles subtypes/related structs).
    const fromRefIdx = (from as { typeIdx: number }).typeIdx;
    const toRefNullIdx = (to as { typeIdx: number }).typeIdx;
    if (fromRefIdx !== toRefNullIdx) {
      if (!emitSafeStructConversion(ctx, fctx, fromRefIdx, toRefNullIdx)) {
        // (#2853 park fix) same-layout sibling shapes → exclude from branding.
        markNoBrandSiblingShapes(ctx.mod.types, ctx.noBrandShapeTypes, fromRefIdx, toRefNullIdx);
        // Guarded cast: ref $X → ref_null $Y — avoid illegal cast trap. Original
        // `if` blockType `to` is byte-identical to the helper's `ref_null $toIdx`.
        fctx.body.push(
          ...guardedRefCastInstrs(fctx, toRefNullIdx, { tempType: { kind: "anyref" } as ValType, nonNull: false }),
        );
      }
    }
    return;
  }
  if (from.kind === "ref_null" && to.kind === "ref") {
    // Unboxing: ref_null $AnyValue → ref $X
    if (isAnyValue(from, ctx) && !isAnyValue(to, ctx)) {
      ensureAnyHelpers(ctx);
      const toIdx = (to as { typeIdx: number }).typeIdx;
      // (#1988) A native string is boxed into $AnyValue tag 5 with its payload
      // in `externval` (field 4, externref-wrapped $AnyString) — NOT `refval`
      // (field 3, eqref). The generic unbox below reads field 3, so a tag-5
      // string box (e.g. the result of the `__any_add` concat arm) deref'd null.
      // When the target is a native-string type, pull the string out of
      // externval and cast it; fall through to the field-3 eqref path for every
      // other GC ref target (objects/arrays/tag 6).
      const isNativeStrTarget =
        ctx.nativeStrings &&
        (toIdx === ctx.anyStrTypeIdx || (ctx.nativeStrTypeIdx >= 0 && toIdx === ctx.nativeStrTypeIdx));
      if (isNativeStrTarget) {
        fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 4 }); // externval
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push(
          ...guardedRefCastInstrs(fctx, toIdx, { tempType: { kind: "anyref" } as ValType, nonNull: true }),
        );
        return;
      }
      fctx.body.push({ op: "struct.get", typeIdx: ctx.anyValueTypeIdx, fieldIdx: 3 });
      // Guarded cast: eqref → ref $X
      fctx.body.push(...guardedRefCastInstrs(fctx, toIdx, { tempType: { kind: "eqref" } as ValType, nonNull: true }));
      return;
    }
    // ref_null $X → ref $Y: cast and assert non-null at runtime
    const fromNullIdx = (from as { typeIdx: number }).typeIdx;
    const toNonNullIdx = (to as { typeIdx: number }).typeIdx;
    if (fromNullIdx !== toNonNullIdx) {
      if (!emitSafeStructConversion(ctx, fctx, fromNullIdx, toNonNullIdx)) {
        // (#2853 park fix) same-layout sibling shapes → exclude from branding.
        markNoBrandSiblingShapes(ctx.mod.types, ctx.noBrandShapeTypes, fromNullIdx, toNonNullIdx);
        // Guarded cast: ref_null $X → ref $Y
        // nonNull: false — the trailing `ref.as_non_null` is emitted CONDITIONALLY
        // below (the #2161 native-string-target exception), NOT unconditionally here.
        fctx.body.push(
          ...guardedRefCastInstrs(fctx, toNonNullIdx, { tempType: { kind: "anyref" } as ValType, nonNull: false }),
        );
      }
    }
    // (#2161 family B0) NATIVE-STRING targets skip the non-null assert: a null
    // native-string ref is the in-band `undefined` sentinel, not a bug. The
    // non-strict checker ERASES `undefined` from unions, so a
    // `["a", undefined, "c"]` literal types as `string[]` while its lowered
    // array legitimately stores a null slot — the element read is `ref_null`
    // and the `string`-typed sink requests `ref`. Asserting non-null here
    // turned every such value into a "dereferencing a null pointer" trap (the
    // standalone RegExp exec-vs-expected-array / split-harness family, 100+
    // tests). Passing the null through is validation-safe — every native-string
    // sink is physically NULLABLE (`string` params/locals/struct fields all
    // encode `(ref null $AnyString)`) — and matches the behaviour of a
    // `string | undefined` local, whose null already flows through compare/
    // concat/call paths. Non-string ref targets keep the assert: their sinks
    // (method dispatch on typed struct receivers) genuinely assume non-null.
    const isNativeStringTarget =
      ctx.nativeStrings &&
      ((ctx.anyStrTypeIdx >= 0 && toNonNullIdx === ctx.anyStrTypeIdx) ||
        (ctx.nativeStrTypeIdx >= 0 && toNonNullIdx === ctx.nativeStrTypeIdx));
    if (!isNativeStringTarget) {
      fctx.body.push({ op: "ref.as_non_null" });
    }
    return;
  }

  // ── Boxing: primitive → ref $AnyValue ──
  // #2104: tag-selection policy now lives in `boxToAny` (value-tags.ts) — the
  // single home so the type-aware boxing fix (#2072/#2080 P0) can't erode. This
  // arm keeps the `addUnionImports`/`ensureAnyHelpers` setup (helper
  // registration is the caller's job, so resolution+call stays shift-safe) and
  // delegates the kind-keyed dispatch. `jsType: "unknown"` reproduces the
  // historical externref→tag-5 (#1888) / ref→tag-6 behaviour exactly.
  if (isAnyValue(to, ctx)) {
    if (from.kind === "externref" && (ctx.standalone || ctx.wasi)) {
      addUnionImports(ctx);
    }
    ensureAnyHelpers(ctx);
    if (boxToAny(ctx, fctx, from, "unknown")) {
      return;
    }
  }

  // ── Unboxing: ref $AnyValue → primitive ──
  if (isAnyValue(from, ctx)) {
    ensureAnyHelpers(ctx);
    if (to.kind === "i32") {
      const funcIdx = ctx.funcMap.get("__any_unbox_i32");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    if (to.kind === "f64") {
      // Inline AnyValue → f64 unboxing with correct handling for all tags.
      // The __any_unbox_f64 helper only handles tag 2 (i32) and falls back to
      // reading f64val for everything else, which is wrong for:
      //   tag 1 (undefined) → should be NaN, not 0.0
      //   tag 4 (boolean)   → should be f64(i32val), not 0.0
      const anyTypeIdx = ctx.anyValueTypeIdx;
      if (anyTypeIdx >= 0) {
        const tmpAny = allocTempLocal(fctx, from);
        const tmpTag = allocTempLocal(fctx, { kind: "i32" });
        fctx.body.push({ op: "local.tee", index: tmpAny });
        fctx.body.push({ op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 0 }); // tag
        fctx.body.push({ op: "local.set", index: tmpTag });

        // tag == 2 (i32 number) || tag == 4 (boolean) → f64.convert_i32_s(i32val)
        fctx.body.push({ op: "local.get", index: tmpTag });
        fctx.body.push({ op: "i32.const", value: 2 });
        fctx.body.push({ op: "i32.eq" });
        fctx.body.push({ op: "local.get", index: tmpTag });
        fctx.body.push({ op: "i32.const", value: 4 });
        fctx.body.push({ op: "i32.eq" });
        fctx.body.push({ op: "i32.or" });
        fctx.body.push({
          op: "if",
          blockType: { kind: "val", type: { kind: "f64" } },
          then: [
            { op: "local.get", index: tmpAny },
            { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 1 }, // i32val
            { op: "f64.convert_i32_s" },
          ],
          else: [
            // tag == 1 (undefined) → NaN
            { op: "local.get", index: tmpTag },
            { op: "i32.const", value: 1 },
            { op: "i32.eq" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } },
              then: [{ op: "f64.const", value: NaN }],
              else: [
                // default: f64val (covers tag 0/null=0, tag 3/f64, tag 5/string, tag 6/object)
                { op: "local.get", index: tmpAny },
                { op: "struct.get", typeIdx: anyTypeIdx, fieldIdx: 2 }, // f64val
              ],
            },
          ],
        });
        releaseTempLocal(fctx, tmpTag);
        releaseTempLocal(fctx, tmpAny);
        return;
      }
      // Fallback to helper if anyTypeIdx not available
      const funcIdx = ctx.funcMap.get("__any_unbox_f64");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
    }
    if (to.kind === "i64") {
      // AnyValue → i64: unbox as f64 first, then truncate to i64
      const funcIdx = ctx.funcMap.get("__any_unbox_f64");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        fctx.body.push({ op: "i64.trunc_sat_f64_s" });
        return;
      }
    }
    if (to.kind === "externref") {
      if (ctx.standalone || ctx.wasi) {
        addUnionImports(ctx);
        const anyToExternIdx = ensureAnyToExternHelper(ctx);
        if (anyToExternIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: anyToExternIdx });
          return;
        }
      }
      // Convert GC ref (AnyValue struct) to externref via extern.convert_any.
      fctx.body.push({ op: "extern.convert_any" });
      return;
    }
  }

  // i64 → f64 (Number(bigint))
  if (from.kind === "i64" && to.kind === "f64") {
    fctx.body.push({ op: "f64.convert_i64_s" });
    return;
  }
  // f64 → i64 (BigInt(number))
  if (from.kind === "f64" && to.kind === "i64") {
    fctx.body.push({ op: "i64.trunc_sat_f64_s" });
    return;
  }
  // i32 → i64
  if (from.kind === "i32" && to.kind === "i64") {
    fctx.body.push({ op: "i64.extend_i32_s" });
    return;
  }
  // i64 → i32
  if (from.kind === "i64" && to.kind === "i32") {
    // Truncate: check if non-zero (truthiness for conditions)
    fctx.body.push({ op: "i64.const", value: 0n });
    fctx.body.push({ op: "i64.ne" });
    return;
  }
  // i32 → f64
  if (from.kind === "i32" && to.kind === "f64") {
    fctx.body.push({ op: "f64.convert_i32_s" });
    return;
  }
  // f64 → i32
  if (from.kind === "f64" && to.kind === "i32") {
    fctx.body.push({ op: "i32.trunc_sat_f64_s" });
    return;
  }
  // externref → i32 (unbox as number to preserve value, then truncate)
  if (from.kind === "externref" && to.kind === "i32") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      fctx.body.push({ op: "i32.trunc_sat_f64_s" });
      return;
    }
    fctx.body.push({ op: "ref.is_null" });
    fctx.body.push({ op: "i32.eqz" });
    return;
  }
  // externref → f64 (unbox number)
  if (from.kind === "externref" && to.kind === "f64") {
    if (ctx.standalone) {
      const hint = toPrimitiveHint ?? "number";
      // (#3673) Typed member-get rewrite: when the externref on the stack is
      // literally the result of a `call __get_member_<p>` generic dispatcher
      // (the acorn `this.pos + size` shape), swap that call for the typed
      // `__get_member_<p>__f64` twin and skip the `__to_primitive` +
      // `__unbox_number` chain here — a numeric-slot hit becomes ONE call with
      // a bare `struct.get` arm instead of three calls plus a number box. The
      // typed dispatcher's non-numeric/miss arms re-emit this exact chain, so
      // semantics are unchanged. Flush first: funcMap may be ahead of the
      // body across a pending late-import shift, and the funcIdx compare
      // below needs the two in the same regime.
      if (hint === "number") {
        flushLateImportShifts(ctx, fctx);
        const last = fctx.body[fctx.body.length - 1];
        if (last?.op === "call") {
          let matchedProp: string | undefined;
          for (const p of ctx.memberGetDispatchNames ?? []) {
            if (ctx.funcMap.get(`__get_member_${p}`) === last.funcIdx) {
              matchedProp = p;
              break;
            }
          }
          if (matchedProp !== undefined) {
            const typedIdx = reserveTypedMemberGetF64DispatchLate(ctx, matchedProp, fctx);
            if (typedIdx !== undefined) {
              fctx.body.pop();
              fctx.body.push({ op: "call", funcIdx: typedIdx });
              return;
            }
          }
        }
      }
      // (#4157) Flag-gated ToNumber fast paths, both default OFF — returns
      // false before touching `ctx` when they are, so the chain below stays
      // byte-identical. Rationale in tonumber-fast-paths.ts.
      if (tryEmitFastToNumber(ctx, fctx, hint)) return;
      pushStringHint(ctx, fctx, hint);
      const toPrimIdx = ensureLateImport(
        ctx,
        "__to_primitive",
        [{ kind: "externref" }, { kind: "externref" }],
        [{ kind: "externref" }],
      );
      flushLateImportShifts(ctx, fctx);
      if (toPrimIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: toPrimIdx });
      }
      addUnionImports(ctx);
      const funcIdx = ctx.funcMap.get("__unbox_number");
      if (funcIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx });
        return;
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return;
    }
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
    // Fallback: drop and push default
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: 0 });
    return;
  }
  // externref → i64
  if (from.kind === "externref" && to.kind === "i64") {
    addUnionImports(ctx);
    // (#1644) A bigint-branded target unboxes via __to_bigint (§7.1.13
    // ToBigInt): identity on a JS bigint, parse on a string (SyntaxError on
    // bad syntax), TypeError on a number. Preserves full i64 precision —
    // the legacy __unbox_number→f64→trunc path loses precision above 2^53.
    // A native (unbranded) i64 keeps the legacy number-unbox path unchanged.
    if (to.bigint) {
      const toBigIdx = ctx.funcMap.get("__to_bigint");
      if (toBigIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: toBigIdx });
        return;
      }
    }
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx });
      fctx.body.push({ op: "i64.trunc_sat_f64_s" });
      return;
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "i64.const", value: 0n });
    return;
  }
  // externref → ref/ref_null: convert externref back to anyref, then cast to target struct type.
  // When the cast fails (e.g., JS array passed where vec struct expected),
  // try to construct the target from the JS object via __extern_get (#792).
  if (from.kind === "externref" && (to.kind === "ref" || to.kind === "ref_null")) {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    const vecInfo = getVecInfo(ctx, toIdx);

    // Save externref BEFORE converting to anyref — needed for __extern_get fallback
    const tmpExternLocal = allocTempLocal(fctx, { kind: "externref" });
    fctx.body.push({ op: "local.tee", index: tmpExternLocal });

    fctx.body.push({ op: "any.convert_extern" });
    const tmpAnyLocal = allocTempLocal(fctx, { kind: "anyref" } as ValType);
    fctx.body.push({ op: "local.tee", index: tmpAnyLocal });
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });

    // Build else-branch: when cast fails, construct from JS object if possible
    let elseBranch: Instr[];
    if (vecInfo) {
      elseBranch = buildVecFromExternref(ctx, fctx, tmpExternLocal, toIdx, vecInfo);
    } else {
      // Check if the target is a tuple struct — if so, try converting from any known vec type
      const tupleFields = getTupleFields(ctx, toIdx);
      if (tupleFields) {
        elseBranch = buildTupleFromExternref(ctx, fctx, tmpAnyLocal, toIdx, tupleFields, tmpExternLocal);
      } else if (
        // (#2161 B1) externref → native `$AnyString` where the cast failed: the
        // source may be a boxed-`new String(...)` wrapper ($Object carrying its
        // [[StringData]] under the FLAG_INTERNAL WRAPPER_PRIMITIVE_KEY slot). The
        // generic `ref.test $AnyString` misses it (a wrapper is an object, not a
        // string) so it was dropped to null → downstream `__str_flatten` trapped
        // on `new String(s).split/search/match/replace`. Recover the wrapper's
        // primitive string via `__wrapper_string_value` (the same internal-slot
        // read `__to_primitive` does inline, WITHOUT the OrdinaryToPrimitive
        // valueOf/toString dispatch — a bare slot probe). Gated on the object
        // runtime already being present (`ensureWrapperStringValueHelper` returns
        // -1 for gc/host mode or a string-free / object-free module) so string-
        // free programs stay byte-identical. Only the `$AnyString` supertype
        // target qualifies — the wrapper's stored string is a native-string
        // subtype of it, so the helper's `ref.cast $AnyString` never traps;
        // narrower string-subtype targets keep the prior null fallthrough.
        toIdx === ctx.anyStrTypeIdx &&
        ctx.anyStrTypeIdx >= 0 &&
        ctx.objectRuntimeTypes !== undefined &&
        ctx.funcMap.has("__obj_find") &&
        ensureWrapperStringValueHelper(ctx) >= 0
      ) {
        const wrapperValIdx = ctx.funcMap.get("__wrapper_string_value")!;
        elseBranch = [
          { op: "local.get", index: tmpExternLocal },
          { op: "call", funcIdx: wrapperValIdx },
        ];
      } else {
        elseBranch = [{ op: "ref.null", typeIdx: toIdx }];
      }
    }

    // (#2608 / #3098) A native string crossing an open property/call boundary
    // may be carried by `$AnyValue` tag 5. Recover only an actual native-string
    // payload. Generic ToString here would corrupt null/undefined sentinels and
    // silently stringify unrelated objects at every typed-string boundary.
    if (
      (ctx.standalone || ctx.wasi) &&
      ctx.nativeStrings &&
      toIdx === ctx.anyStrTypeIdx &&
      ctx.anyStrTypeIdx >= 0 &&
      ctx.anyValueTypeIdx >= 0
    ) {
      const anyValueTypeIdx = ctx.anyValueTypeIdx;
      const priorElse = elseBranch;
      const loadAnyValueStringPayload = (): Instr[] => [
        { op: "local.get", index: tmpAnyLocal },
        { op: "ref.cast", typeIdx: anyValueTypeIdx },
        { op: "struct.get", typeIdx: anyValueTypeIdx, fieldIdx: 4 },
        { op: "any.convert_extern" },
      ];
      elseBranch = [
        { op: "local.get", index: tmpAnyLocal },
        { op: "ref.test", typeIdx: anyValueTypeIdx },
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } },
          then: [
            ...loadAnyValueStringPayload(),
            { op: "ref.test", typeIdx: toIdx },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } },
              then: [...loadAnyValueStringPayload(), { op: "ref.cast_null", typeIdx: toIdx }],
              else: [{ op: "ref.null", typeIdx: toIdx }],
            },
          ],
          else: priorElse,
        },
      ];
    }

    const resultType: ValType = { kind: "ref_null", typeIdx: toIdx };
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: resultType },
      then: [
        { op: "local.get", index: tmpAnyLocal },
        { op: "ref.cast_null", typeIdx: toIdx },
      ],
      else: elseBranch,
    });
    // Don't ref.as_non_null for non-null targets — let downstream handle null
    // via multi-struct dispatch (#792)

    // Save pre-cast anyref backup for multi-struct dispatch
    (fctx as any).__lastGuardedCastBackup = tmpAnyLocal;
    releaseTempLocal(fctx, tmpExternLocal);
    return;
  }
  // f64 → externref (box number)
  if (from.kind === "f64" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    // (#2864 wave-2 S1) UNDEF-SENTINEL-BRANDED f64 (`{kind:"f64",
    // undefSentinel:true}`) — an f64 read out of a slot that genuinely holds
    // `undefined`, today a native generator's IteratorResult `value`. This is
    // the "dedicated identity-carrying-slot boxing site" the #3315 note below
    // points at, hoisted to the ONE coercion engine so it applies at every
    // consuming context rather than being re-derived per read site.
    //
    // Measured (from-catch.js, standalone, host-free): the terminal
    // `{value: undefined, done: true}` read took the `valueStaticNumeric` f64
    // fast path in `tryCompileNativeGeneratorResultProperty`, whose comment
    // reasoned "an exhausted read yields NaN, which is the spec
    // ToNumber(undefined)" — true in a NUMERIC context, false in the `any`
    // context the test262 harness actually uses. `assert.sameValue(result.value,
    // undefined)` boxed the sentinel as a NUMBER and reported
    // `SameValue(«NaN», «undefined»)`, silently, on every terminal-result
    // assertion across the generator suites.
    //
    // Numeric consumers are untouched: they read the brand as a plain `f64`
    // and never reach this arm.
    if (from.undefSentinel === true && funcIdx !== undefined) {
      const scratch = allocLocal(fctx, `__undef_sentinel_f64_${fctx.locals.length}`, { kind: "f64" });
      fctx.body.push(...undefSentinelAwareBoxInstrs(ctx, scratch, funcIdx));
      return;
    }
    if (funcIdx !== undefined) {
      // (#3315) The generic f64→externref box does NOT resurrect the
      // UNDEF_F64_BITS sentinel to `undefined`. An arbitrary f64 reaching this
      // arm is a COMPUTED NUMBER — ToNumber(undefined) = NaN-the-number, and
      // `Math.log2(undefined)` / `Math.abs(undefined)` etc. must box as a NaN
      // number, not `undefined`. The original #3315 fix intercepted here on
      // the premise "JS arithmetic only produces the quiet NaN 0x7FF8…, never
      // this signaling pattern", but that premise fails for the self-hosted
      // Math family: its `if (x !== x) return x` NaN fast-path (and the
      // payload-preserving `f64.abs` bit-op) return the INPUT sentinel bits
      // unchanged, so a genuine numeric NaN reached this arm carrying the
      // sentinel and was wrongly boxed to `undefined` (the log2-basicTests
      // assert #8 merge_group regression on the JS-host lane). Undefined
      // IDENTITY is preserved at the dedicated identity-carrying-slot boxing
      // sites instead — the destructure vec read-back (vec-access-exports.ts)
      // and the standalone any-box tag-1 recovery (any-helpers.ts) — which box
      // a value read from a slot that genuinely holds `undefined`, never a
      // fresh arithmetic result.
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
    // Fallback: drop f64 and push null externref
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // i32 → externref. TYPE-AWARE box (#2785): the box helper is chosen by the
  // i32's BRAND (its TS type), NEVER by the bare Wasm kind. `i32` is overloaded
  // — it backs `number`, `boolean` (1/0), and symbol HANDLES (ids) — and a
  // type-blind `__box_number` corrupts the non-numbers (boolean `true` → the
  // number 1; a symbol handle → a number). This was the root cause of the two
  // R1 merge_group parks (#2760/#2766) and forced F1's f64-only narrowing.
  if (from.kind === "i32" && to.kind === "externref") {
    addUnionImports(ctx);
    // boolean → __box_boolean (takes the i32 directly; preserves the boolean
    // TAG so a boxed boolean compares value-correctly — in standalone native
    // `===`, `__box_boolean_struct` is classified as a boolean, distinct from a
    // number, so `boxedBool === true` holds, whereas `__box_number` would tag it
    // a number and `1 !== true`). Registered by addUnionImports in both modes.
    if (from.boolean === true) {
      const boxBoolIdx = ctx.funcMap.get("__box_boolean");
      if (boxBoolIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
        return;
      }
    }
    // symbol → __box_symbol (takes the i32 handle/id directly; identity-stable
    // via the host symbol cache in gc mode, via the i32 `$id` in the native
    // `$Symbol` carrier in standalone/wasi). (#2792/#2866) `ensureLateImport`
    // resolves the right `__box_symbol`: a host `env::__box_symbol` import in gc
    // mode (added by `addUnionImports` above) and the in-module `$Symbol` carrier
    // builder under `ctx.standalone || ctx.wasi` (`ensureSymbolCarrier`). Before
    // #2866 the standalone branch had no native helper, so a symbol-keyed boxing
    // (e.g. `o[sym] = v`) fell through to the number box and corrupted the symbol
    // id — or leaked an unsatisfiable host import. Still guarded: falls through to
    // the number box only if the helper is genuinely absent.
    if (from.symbol === true) {
      const boxSymIdx = ensureLateImport(ctx, "__box_symbol", [{ kind: "i32" }], [{ kind: "externref" }]);
      if (boxSymIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: boxSymIdx });
        return;
      }
    }
    // number (or unbranded i32) → __box_number (convert i32 → f64 first).
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i32_s" });
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
    // Fallback: drop i32 and push null externref
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // i64 → externref
  if (from.kind === "i64" && to.kind === "externref") {
    addUnionImports(ctx);
    // (#1644) A bigint-branded i64 boxes as a JS bigint via __box_bigint
    // (JS-BigInt-integration makes the i64 cross the boundary already a JS
    // bigint, so the host body is identity). A native (unbranded) i64 keeps
    // the legacy number boxing — byte-identical to before — so `type i64 =
    // number` code is unaffected.
    if (from.bigint) {
      const boxBigIdx = ctx.funcMap.get("__box_bigint");
      if (boxBigIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxBigIdx });
        return;
      }
    }
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      fctx.body.push({ op: "f64.convert_i64_s" });
      fctx.body.push({ op: "call", funcIdx });
      return;
    }
    // Fallback: drop i64 and push null externref
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // ref/ref_null → externref:
  // - With explicit toPrimitiveHint (e.g. template literal span, String() call):
  //   walk @@toPrimitive("string") → toString() per §7.1.1 OrdinaryToPrimitive.
  // - Without a hint (plain `any`/externref typing): just `extern.convert_any`.
  //   #1525: previously this path eagerly called `${name}_toString` whenever a
  //   matching standalone method existed, so `const obj: any = { toString(){...} }`
  //   would store the toString result as obj instead of the struct itself —
  //   breaking `typeof obj === "object"`, downstream `obj + n`, `obj != 0`, and
  //   any host method that runs its own ToPrimitive on the wasmGC arg.
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "externref") {
    const typeIdx = (from as { typeIdx: number }).typeIdx;
    const name = ctx.typeIdxToStructName.get(typeIdx);
    if (name !== undefined && toPrimitiveHint !== undefined) {
      // Check for [Symbol.toPrimitive] method first
      const toPrimFuncIdx = ctx.funcMap.get(`${name}_@@toPrimitive`);
      if (toPrimFuncIdx !== undefined) {
        // Call ClassName_@@toPrimitive(self, hint)
        const hint = toPrimitiveHint;
        pushStringHint(ctx, fctx, hint);
        fctx.body.push({ op: "call", funcIdx: toPrimFuncIdx });
        // Coerce result to externref if needed
        const funcDef = definedFuncAt(ctx, toPrimFuncIdx);
        const funcType = funcDef ? ctx.mod.types[funcDef.typeIdx] : undefined;
        // Default to "externref" for imports (funcDefIdx < 0) which typically return externref
        const retKind = (funcType?.kind === "func" && funcType.results?.[0]?.kind) || "externref";
        if (retKind === "f64" || retKind === "i32") {
          if (retKind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
          // (#2866 slice 4) Under a STRING hint (String()/concat ToString context,
          // target externref), a numeric `@@toPrimitive` result must be ToString'd
          // — NOT boxed. Returning a boxed-number externref as the "string" result
          // null-derefs on the next string op (e.g. `String(o).length`). Use the
          // native `number_toString` formatter (registered eagerly for String()
          // calls), which returns an externref wrapping a native string. Fall back
          // to boxing when it is unavailable (no string-hint context, or host mode
          // without the formatter) — preserves prior behaviour, no regression.
          const numToStrIdx = hint === "string" && ctx.nativeStrings ? ctx.funcMap.get("number_toString") : undefined;
          if (numToStrIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: numToStrIdx });
          } else {
            addUnionImports(ctx);
            const boxIdx = ctx.funcMap.get("__box_number")!;
            fctx.body.push({ op: "call", funcIdx: boxIdx });
          }
        }
        // externref/ref return → use extern.convert_any for ref types
        if (retKind === "ref" || retKind === "ref_null") {
          fctx.body.push({ op: "extern.convert_any" });
        }
        return;
      }
      if (
        toPrimitiveHint === "string" &&
        (tryStructStringHintExternrefDispatch(ctx, fctx, from, typeIdx, name) ||
          tryStructPrimitiveToStringAsExternref(ctx, fctx, from, typeIdx, name))
      ) {
        return;
      }
      const toStringFuncIdx = ctx.funcMap.get(`${name}_toString`);
      if (toStringFuncIdx !== undefined) {
        // Call ClassName_toString(self) — self is already on stack.
        // Only fire when ToPrimitive("string") was explicitly requested.
        fctx.body.push({ op: "call", funcIdx: toStringFuncIdx });
        // A JavaScript function with no return statement produces the
        // primitive `undefined`; it is not a failed OrdinaryToPrimitive
        // attempt. The named wrapper has no Wasm result in that case, so
        // materialize ToString(undefined) for this externref string target.
        const funcDef = definedFuncAt(ctx, toStringFuncIdx);
        const funcType = funcDef ? ctx.mod.types[funcDef.typeIdx] : undefined;
        if (funcType?.kind === "func" && (funcType.results?.length ?? 0) === 0) {
          pushStringHint(ctx, fctx, "undefined");
        }
        return;
      }
    }
    // (#2358) No explicit hint (plain `any`/externref typing): a nominal object
    // struct that carries a user ToPrimitive method (`valueOf`/`@@toPrimitive`/
    // `toString`) must reach the dynamic boundary as a `$Object` so the native
    // `__to_primitive` helper (which only recognises `$Object`) can reduce it
    // when the typeIdx is later erased (e.g. inside an `any`-typed parameter).
    // Materialize it here, where the concrete typeIdx is still known. Plain data
    // structs (no ToPrimitive method) keep the byte-identical `extern.convert_any`
    // below — preserving `typeof`/field-read/identity for the common case.
    if (
      (ctx.standalone === true || ctx.wasi === true) &&
      name !== undefined &&
      structMustReifyAtExternrefBoundary(ctx, name) &&
      materializeStructAsObject(ctx, fctx, typeIdx)
    ) {
      return;
    }
    fctx.body.push({ op: "extern.convert_any" });
    // Vec structs (arrays) need Symbol.iterator to be iterable by JS APIs (#854).
    // After extern.convert_any, call __make_iterable to attach Symbol.iterator via sidecar.
    // Skip i32_byte vec structs (ArrayBuffer/DataView backing) — neither is
    // iterable in JS and converting them to a JS array loses the wasmGC
    // struct identity that DataView method dispatch depends on (#1056).
    //
    // #1539/#1470/#1664/#4397: `__make_iterable` is the compatibility JS-host
    // materializer. Host-free targets and native-first semantics keep the
    // canonical `$Vec`; native consumers operate on it directly and an actual
    // JS boundary exposes the identity-cached live array view. Materializing a
    // detached JS array merely because an internal type widens to externref
    // would make the embedder a semantic provider again and lose ownership.
    if (
      !ctx.standalone &&
      !ctx.wasi &&
      ctx.targetProfile.semanticProviders !== "native-first" &&
      getArrTypeIdxFromVec(ctx, typeIdx) >= 0 &&
      ctx.vecTypeMap.get("i32_byte") !== typeIdx
    ) {
      const makeIterIdx = ensureLateImport(ctx, "__make_iterable", [{ kind: "externref" }], [{ kind: "externref" }]);
      if (makeIterIdx !== undefined) {
        flushLateImportShifts(ctx, fctx);
        fctx.body.push({ op: "call", funcIdx: makeIterIdx });
      }
    }
    return;
  }
  // ref/ref_null → eqref: no-op (GC struct refs are subtypes of eqref)
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "eqref") {
    return;
  }
  // ref/ref_null → anyref: no-op (GC struct refs are subtypes of anyref)
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "anyref") {
    return;
  }
  // externref → ref (non-nullable): convert to anyref then guarded cast
  if (from.kind === "externref" && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    fctx.body.push({ op: "any.convert_extern" });
    // Guarded: ref.test before ref.cast to avoid illegal cast traps
    const tmpExtRef = allocTempLocal(fctx, { kind: "anyref" } as ValType);
    fctx.body.push({ op: "local.tee", index: tmpExtRef });
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
      then: [
        { op: "local.get", index: tmpExtRef },
        { op: "ref.cast_null", typeIdx: toIdx },
      ],
      else: [{ op: "ref.null", typeIdx: toIdx }],
    });
    fctx.body.push({ op: "ref.as_non_null" });
    releaseTempLocal(fctx, tmpExtRef);
    return;
  }
  // externref → ref_null: convert to anyref, then use if/else to handle null and type mismatch
  if (from.kind === "externref" && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    fctx.body.push({ op: "any.convert_extern" });
    // Store in a temp local, check for null or type mismatch
    const tmpLocal = allocTempLocal(fctx, { kind: "anyref" });
    fctx.body.push({ op: "local.tee", index: tmpLocal });
    // Use ref.test to check both null and type compatibility (ref.test returns 0 for null)
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: to },
      then: [
        { op: "local.get", index: tmpLocal },
        { op: "ref.cast", typeIdx: toIdx },
      ],
      else: [{ op: "ref.null", typeIdx: toIdx }],
    });
    releaseTempLocal(fctx, tmpLocal);
    return;
  }
  // eqref/anyref → ref: guarded cast to target struct type
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    // Guarded: ref.test before ref.cast to avoid illegal cast traps
    const tmpEqAny = allocTempLocal(fctx, from);
    // (#3149) When the target is a VEC struct and the direct cast misses, the
    // source is an indexable-but-differently-typed native collection (e.g. the
    // `$ObjVec` group value handed back by `Map.groupBy(...).get(k)` — `map.get`
    // returns anyref, not the externref `Object.groupBy`'s `__extern_get`
    // yields). The legacy else-branch emitted `ref.null` + `ref.as_non_null`,
    // which NULL-DEREF-TRAPPED the moment the harness's `any[]`-typed
    // `compareArray` read `.length`. Mirror the `externref → ref` arm below:
    // materialize a real vec by reading the source via
    // `__extern_length`/`__extern_get_idx` (`buildVecFromExternref`), which an
    // `$ObjVec` responds to. `buildVecFromExternref` needs an externref, so
    // convert the anyref first. Non-vec struct targets keep the null fallback.
    const eqVecInfo = to.kind === "ref" ? getVecInfo(ctx, toIdx) : undefined;
    if (eqVecInfo) {
      const tmpEqExtern = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "local.tee", index: tmpEqAny });
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "local.set", index: tmpEqExtern });
      fctx.body.push({ op: "local.get", index: tmpEqAny });
      fctx.body.push({ op: "ref.test", typeIdx: toIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
        then: [
          { op: "local.get", index: tmpEqAny },
          { op: "ref.cast_null", typeIdx: toIdx },
        ],
        else: buildVecFromExternref(ctx, fctx, tmpEqExtern, toIdx, eqVecInfo),
      });
      fctx.body.push({ op: "ref.as_non_null" });
      releaseTempLocal(fctx, tmpEqExtern);
      releaseTempLocal(fctx, tmpEqAny);
      return;
    }
    fctx.body.push({ op: "local.tee", index: tmpEqAny });
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: toIdx } as ValType },
      then: [
        { op: "local.get", index: tmpEqAny },
        { op: "ref.cast_null", typeIdx: toIdx },
      ],
      else: [{ op: "ref.null", typeIdx: toIdx }],
    });
    fctx.body.push({ op: "ref.as_non_null" });
    releaseTempLocal(fctx, tmpEqAny);
    return;
  }
  // eqref/anyref → ref_null: null-safe and type-safe cast
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    const tmpLocal = allocTempLocal(fctx, from);
    // (#3149) Vec target + cast-miss → materialize instead of dropping to null.
    // This is the `any[]`-typed-parameter path (a `ref_null $vec`) that the
    // harness `compareArray(a: any[], …)` forces on a `Map.groupBy(...).get(k)`
    // `$ObjVec` group (`map.get` returns anyref). The legacy null fallback then
    // NULL-DEREF-TRAPPED on `a.length`. Mirror the `externref → ref_null` arm:
    // read the indexable source via `buildVecFromExternref`. Non-vec targets
    // keep the null fallback.
    const anyVecInfo = getVecInfo(ctx, toIdx);
    if (anyVecInfo) {
      const tmpExtern = allocTempLocal(fctx, { kind: "externref" });
      fctx.body.push({ op: "local.tee", index: tmpLocal });
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "local.set", index: tmpExtern });
      fctx.body.push({ op: "local.get", index: tmpLocal });
      fctx.body.push({ op: "ref.test", typeIdx: toIdx });
      fctx.body.push({
        op: "if",
        blockType: { kind: "val", type: to },
        then: [
          { op: "local.get", index: tmpLocal },
          { op: "ref.cast", typeIdx: toIdx },
        ],
        else: buildVecFromExternref(ctx, fctx, tmpExtern, toIdx, anyVecInfo),
      });
      releaseTempLocal(fctx, tmpExtern);
      releaseTempLocal(fctx, tmpLocal);
      return;
    }
    fctx.body.push({ op: "local.tee", index: tmpLocal });
    // Use ref.test to check both null and type compatibility (ref.test returns 0 for null)
    fctx.body.push({ op: "ref.test", typeIdx: toIdx });
    fctx.body.push({
      op: "if",
      blockType: { kind: "val", type: to },
      then: [
        { op: "local.get", index: tmpLocal },
        { op: "ref.cast", typeIdx: toIdx },
      ],
      else: [{ op: "ref.null", typeIdx: toIdx }],
    });
    releaseTempLocal(fctx, tmpLocal);
    return;
  }

  // anyref/eqref → externref: extern.convert_any
  if ((from.kind === "anyref" || from.kind === "eqref") && to.kind === "externref") {
    fctx.body.push({ op: "extern.convert_any" });
    return;
  }
  // externref → anyref: any.convert_extern
  if (from.kind === "externref" && to.kind === "anyref") {
    fctx.body.push({ op: "any.convert_extern" });
    return;
  }
  // anyref → f64 (#1103a): a value read out of a native collection (e.g.
  // `Map.prototype.get` returns anyref) used in numeric context. Numbers are
  // stored boxed (`__box_number` externref converted to anyref), so externalize
  // back to externref then unbox. Mirrors the `externref → f64` arm.
  if (from.kind === "anyref" && to.kind === "f64") {
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx !== undefined) {
      fctx.body.push({ op: "extern.convert_any" });
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
      return;
    }
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: 0 });
    return;
  }
  // externref → eqref: any.convert_extern yields ANYREF (the SUPERtype of
  // eqref), so a bare conversion is one step too wide — a consuming eqref-slot
  // store fails validation ("expected eqref, found anyref"). Narrow anyref →
  // eqref with a nullable ref.cast to the abstract `eq` heap type (-19). Mirrors
  // the fctx-less `coercionInstrs` arm (#2878).
  if (from.kind === "externref" && to.kind === "eqref") {
    const EQ_HEAP_TYPE = -19;
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast_null", typeIdx: EQ_HEAP_TYPE });
    return;
  }
  // Remaining → externref fallback (funcref, etc.): drop and push null
  if (to.kind === "externref") {
    fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "ref.null.extern" });
    return;
  }
  // ref (struct) → f64: JS ToNumber semantics — check @@toPrimitive("number") first, then valueOf
  // Re-entrancy guard: prevent infinite recursion when valueOf itself returns a struct.
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "f64") {
    const typeIdx = (from as { typeIdx: number }).typeIdx;
    if (
      ctx.nativeStrings &&
      (typeIdx === ctx.anyStrTypeIdx || (ctx.nativeStrTypeIdx >= 0 && typeIdx === ctx.nativeStrTypeIdx))
    ) {
      let strToNumberIdx = ctx.funcMap.get("__str_to_number");
      if (strToNumberIdx === undefined) {
        addUnionImports(ctx);
        strToNumberIdx = ctx.funcMap.get("__str_to_number");
      }
      if (strToNumberIdx !== undefined) {
        fctx.body.push({ op: "extern.convert_any" });
        fctx.body.push({ op: "call", funcIdx: strToNumberIdx });
        return;
      }
      addUnionImports(ctx);
      const unboxIdx = ctx.funcMap.get("__unbox_number");
      if (unboxIdx !== undefined) {
        fctx.body.push({ op: "extern.convert_any" });
        fctx.body.push({ op: "call", funcIdx: unboxIdx });
        return;
      }
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return;
    }
    const wasInsideValueOf = (ctx as any).__insideValueOfCoercion ?? false;
    if (wasInsideValueOf) {
      // Already inside a valueOf coercion — don't recurse, return NaN
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
      return;
    }
    (ctx as any).__insideValueOfCoercion = true;
    // The flag is cleared in a finally-like pattern — we save/restore it
    // before every return. Using a wrapper to keep it clean:
    const cleanup = () => {
      (ctx as any).__insideValueOfCoercion = wasInsideValueOf;
    };
    const name = ctx.typeIdxToStructName.get(typeIdx);
    if (name !== undefined) {
      // Check for [Symbol.toPrimitive] method first — takes precedence over valueOf
      const toPrimFuncIdx = ctx.funcMap.get(`${name}_@@toPrimitive`);
      if (toPrimFuncIdx !== undefined) {
        // Call ClassName_@@toPrimitive(self, hint)
        // Use provided hint, or default to "number" for f64 target
        const hint = toPrimitiveHint ?? "number";
        pushStringHint(ctx, fctx, hint);
        fctx.body.push({ op: "call", funcIdx: toPrimFuncIdx });
        // Coerce result to f64 if needed
        const funcDef = definedFuncAt(ctx, toPrimFuncIdx);
        const funcType = funcDef ? ctx.mod.types[funcDef.typeIdx] : undefined;
        const retKind = (funcType?.kind === "func" && funcType.results?.[0]?.kind) || "f64";
        if (retKind === "i32") {
          fctx.body.push({ op: "f64.convert_i32_s" });
        } else if (retKind === "externref") {
          addUnionImports(ctx);
          const unboxIdx = ctx.funcMap.get("__unbox_number");
          if (unboxIdx !== undefined) {
            fctx.body.push({ op: "call", funcIdx: unboxIdx });
          } else {
            fctx.body.push({ op: "drop" });
            fctx.body.push({ op: "f64.const", value: NaN });
          }
        }
        // f64 return → already correct type
        cleanup();
        return;
      }
      const fields = ctx.structFields.get(name);
      if (fields) {
        const fieldIdx = fields.findIndex((f) => f.name === "valueOf");
        if (fieldIdx < 0) {
          // No valueOf field — check for a class method valueOf (ClassName_valueOf)
          const valueOfFuncIdx = ctx.funcMap.get(`${name}_valueOf`);
          if (valueOfFuncIdx !== undefined) {
            // Call ClassName_valueOf(self) — self is already on stack
            fctx.body.push({ op: "call", funcIdx: valueOfFuncIdx });
            // Check return type — if not f64, convert to f64
            const voFuncDef = definedFuncAt(ctx, valueOfFuncIdx);
            const funcType = voFuncDef ? ctx.mod.types[voFuncDef.typeIdx] : undefined;
            if (funcType?.kind === "func" && funcType.results?.[0]?.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
            } else if (funcType?.kind === "func" && funcType.results?.[0]?.kind === "externref") {
              // valueOf returned externref (e.g. WrapperString_valueOf returns a string)
              // Convert externref → f64 via __unbox_number or parseFloat
              addUnionImports(ctx);
              const unboxIdx = ctx.funcMap.get("__unbox_number");
              if (unboxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: unboxIdx });
              } else {
                const pfIdx = ctx.funcMap.get("parseFloat");
                if (pfIdx !== undefined) {
                  fctx.body.push({ op: "call", funcIdx: pfIdx });
                } else {
                  // Last resort: drop and push NaN
                  fctx.body.push({ op: "drop" });
                  fctx.body.push({ op: "f64.const", value: NaN });
                }
              }
            } else if (
              funcType?.kind === "func" &&
              (funcType.results?.[0]?.kind === "ref" || funcType.results?.[0]?.kind === "ref_null")
            ) {
              // valueOf returned an object ref — drop and push NaN
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "f64.const", value: NaN });
            }
            cleanup();
            return;
          }
          // No valueOf — try toString per ToPrimitive spec (#866)
          // JS spec: for "number"/"default" hint, valueOf is tried first, then toString.
          if (tryToStringFallback(ctx, fctx, from, typeIdx, name!, fields)) {
            cleanup();
            return;
          }
          // No compile-time toString either — fall through to host ToPrimitive (#1090)
          // Sidecar may have dynamically-set valueOf/toString/Symbol.toPrimitive
          {
            const hint = toPrimitiveHint ?? "number";
            emitToPrimitiveHostCall(ctx, fctx, "f64", hint);
          }
          cleanup();
          return;
        }
        const valueOfField = fields[fieldIdx];
        if (!valueOfField) {
          // Field index valid from findIndex but entry missing — fall through to host (#1090)
          {
            const hint = toPrimitiveHint ?? "number";
            emitToPrimitiveHostCall(ctx, fctx, "f64", hint);
          }
          cleanup();
          return;
        }
        if (valueOfField.type.kind === "ref" || valueOfField.type.kind === "ref_null") {
          // valueOf is a closure ref — call it via call_ref
          const closureTypeIdx = (valueOfField.type as { typeIdx: number }).typeIdx;
          // Find closure info by struct type index
          const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
          if (closureInfo) {
            // Save struct ref to local, extract valueOf closure, call it
            const structLocal = allocLocal(fctx, `__coerce_struct_${fctx.locals.length}`, from);
            fctx.body.push({ op: "local.set", index: structLocal });
            // Get closure ref from struct
            fctx.body.push({ op: "local.get", index: structLocal });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
            const closureLocal = allocLocal(fctx, `__coerce_closure_${fctx.locals.length}`, valueOfField.type);
            fctx.body.push({ op: "local.tee", index: closureLocal });
            // Push closure ref as self param, then funcref from field 0
            // call_ref signature: [closure_ref, funcref] → results
            fctx.body.push({ op: "local.get", index: closureLocal });
            fctx.body.push({ op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 });
            {
              const tmpFunc = allocTempLocal(fctx, { kind: "funcref" } as ValType);
              fctx.body.push({ op: "local.tee", index: tmpFunc });
              fctx.body.push({ op: "ref.test", typeIdx: closureInfo.funcTypeIdx });
              fctx.body.push({
                op: "if",
                blockType: { kind: "val", type: { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx } as ValType },
                then: [
                  { op: "local.get", index: tmpFunc },
                  { op: "ref.cast_null", typeIdx: closureInfo.funcTypeIdx },
                ],
                else: [{ op: "ref.null", typeIdx: closureInfo.funcTypeIdx }],
              });
              releaseTempLocal(fctx, tmpFunc);
            }
            fctx.body.push({ op: "ref.as_non_null" });
            fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
            // Convert valueOf result to f64
            if (!closureInfo.returnType) {
              // void return — push NaN
              fctx.body.push({ op: "f64.const", value: NaN });
            } else if (closureInfo.returnType.kind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
            } else if (closureInfo.returnType.kind === "externref" || closureInfo.returnType.kind === "ref_extern") {
              // valueOf returned a string (externref) — convert to f64
              addUnionImports(ctx);
              const unboxIdx = ctx.funcMap.get("__unbox_number");
              if (unboxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: unboxIdx });
              } else {
                fctx.body.push({ op: "drop" });
                fctx.body.push({ op: "f64.const", value: NaN });
              }
            } else if (closureInfo.returnType.kind === "ref" || closureInfo.returnType.kind === "ref_null") {
              // (#1525b §7.1.1.1 step 6) valueOf returned an object — must try
              // toString and throw TypeError if both return non-primitives.
              // Route through the host __to_primitive helper (same path the
              // eqref subpath uses at line ~1882, fixed by #1253). Re-push the
              // ORIGINAL struct so the host sees it; the valueOf result is
              // already dropped. Pre-#1525b this silently emitted NaN.
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "local.get", index: structLocal });
              const hintRefRet = toPrimitiveHint ?? "number";
              emitToPrimitiveHostCall(ctx, fctx, "f64", hintRefRet);
            }
            // f64 return → value is already on stack
            cleanup();
            return;
          }
        }
        if (valueOfField.type.kind === "externref") {
          // valueOf is externref (can't call_ref) — push NaN
          fctx.body.push({ op: "drop" });
          fctx.body.push({ op: "f64.const", value: NaN });
          cleanup();
          return;
        }
        if (valueOfField.type.kind === "eqref") {
          // valueOf field is eqref (a closure struct stored without externref wrapping).
          // Recover the closure and call it by trying each known closure type
          // that was tracked for this struct's valueOf field.
          const trackedTypes = ctx.valueOfClosureTypes.get(name) ?? [];
          const callableClosureTypes: { closureTypeIdx: number; info: ClosureInfo }[] = [];
          for (const closureTypeIdx of trackedTypes) {
            const info = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
            // Include all zero-param closures: f64/i32 return for value, void/null for side effects (returns NaN)
            if (info && info.paramTypes.length === 0) {
              callableClosureTypes.push({ closureTypeIdx, info });
            }
          }
          if (callableClosureTypes.length > 0) {
            // Save struct ref, extract valueOf eqref
            const structLocal = allocLocal(fctx, `__vo_struct_${fctx.locals.length}`, from);
            fctx.body.push({ op: "local.set", index: structLocal });
            fctx.body.push({ op: "local.get", index: structLocal });
            fctx.body.push({ op: "struct.get", typeIdx, fieldIdx });
            const eqLocal = allocLocal(fctx, `__vo_eq_${fctx.locals.length}`, { kind: "eqref" });
            fctx.body.push({ op: "local.set", index: eqLocal });
            // Try each closure type with nested if/else
            const buildDispatch = (idx: number): Instr[] => {
              if (idx >= callableClosureTypes.length) {
                return [{ op: "f64.const", value: NaN }];
              }
              const { closureTypeIdx, info } = callableClosureTypes[idx]!;
              const closureLocal = allocLocal(fctx, `__vo_cl_${fctx.locals.length}`, {
                kind: "ref",
                typeIdx: closureTypeIdx,
              });
              const funcTmp = allocLocal(fctx, `__vo_fn_${fctx.locals.length}`, { kind: "funcref" } as ValType);
              // Post-call result normalization (return-type dependent), built
              // first so it can be spliced after the call inside the guarded if.
              const postCallInstrs: Instr[] = [];
              if (info.returnType?.kind === "i32") {
                postCallInstrs.push({ op: "f64.convert_i32_s" });
              } else if (info.returnType?.kind === "externref" || info.returnType?.kind === "ref_extern") {
                // valueOf returned externref — could be a primitive (string,
                // number, bool) OR an object. Per ECMA-262 §7.1.1.1, if the
                // result is an object, OrdinaryToPrimitive must continue to
                // toString and then throw TypeError if that's also non-
                // primitive. The static `__unbox_number` path silently
                // returns NaN for objects (it falls through to
                // Object.prototype.toString = "[object Object]"). Fix #1253:
                // drop the inlined result and route through the host
                // __to_primitive helper using the ORIGINAL struct, which
                // re-runs valueOf, tries toString, and throws TypeError if
                // appropriate.
                postCallInstrs.push({ op: "drop" });
                postCallInstrs.push({ op: "local.get", index: structLocal });
                const hintExtRet = toPrimitiveHint ?? "number";
                for (const i of toPrimitiveHostCallInstrs(ctx, fctx, "f64", hintExtRet)) {
                  postCallInstrs.push(i);
                }
              } else if (!info.returnType) {
                // void return — call was for side effects; push NaN
                postCallInstrs.push({ op: "f64.const", value: NaN });
              } else if (info.returnType.kind !== "f64") {
                // valueOf returned a non-primitive (object ref). Per ECMA-262
                // §7.1.1.1 OrdinaryToPrimitive step 2.b.ii: continue to the
                // next method (toString); step 3: throw TypeError if neither
                // returns a primitive. Both behaviours live in the host
                // __to_primitive helper. Pre-#1253 we silently pushed NaN.
                postCallInstrs.push({ op: "drop" });
                postCallInstrs.push({ op: "local.get", index: structLocal });
                const hint2 = toPrimitiveHint ?? "number";
                for (const i of toPrimitiveHostCallInstrs(ctx, fctx, "f64", hint2)) {
                  postCallInstrs.push(i);
                }
              }
              // Zero-capture closure wrappers share one CANONICAL struct type
              // (field 0 is plain `funcref`), so `ref.test closureTypeIdx`
              // passing does NOT prove the stored function has THIS candidate's
              // signature — two same-shape object literals assigned to one var
              // land here with each other's canonical type. A funcref-signature
              // miss therefore means "try the next candidate", not "manufacture
              // null and trap" (the old guarded-cast + ref.as_non_null pair
              // null-deref'd on the second literal's `Number(object)` —
              // test262 S9.1_A1_T1).
              const thenInstrs: Instr[] = [
                { op: "local.get", index: eqLocal },
                { op: "ref.cast", typeIdx: closureTypeIdx },
                { op: "local.set", index: closureLocal },
                { op: "local.get", index: closureLocal },
                { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
                { op: "local.set", index: funcTmp },
                { op: "local.get", index: funcTmp },
                { op: "ref.test", typeIdx: info.funcTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val" as const, type: { kind: "f64" as const } },
                  then: [
                    { op: "local.get", index: closureLocal },
                    { op: "local.get", index: funcTmp },
                    { op: "ref.cast", typeIdx: info.funcTypeIdx },
                    { op: "call_ref", typeIdx: info.funcTypeIdx },
                    ...postCallInstrs,
                  ],
                  else: buildDispatch(idx + 1),
                },
              ];
              return [
                { op: "local.get", index: eqLocal },
                { op: "ref.test", typeIdx: closureTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val" as const, type: { kind: "f64" as const } },
                  then: thenInstrs,
                  else: buildDispatch(idx + 1),
                },
              ];
            };
            // (#2679) The valueOf field stores the method as an
            // `__obj_meth_tramp_*` trampoline whose `this` is read from the
            // `__current_this` module global (NOT param-0 — param-0 is the
            // closure self/env). This inline ToNumber dispatch `call_ref`s that
            // trampoline directly without installing `__current_this`, so a
            // `valueOf(){…this…}` saw a stale receiver (`+a`/`Number(a)`/`a*1`
            // returned the wrong `this`; only the §7.1.1.1 string-hint path,
            // which static-dispatches the raw method with the receiver as
            // param-0, was correct). Install `__current_this` = the receiver
            // (§7.1.1.1 step 4.b `Call(method, O)`) around the dispatch and
            // restore it afterward (nesting-safe). Arrow-valued `valueOf`
            // captures `this` lexically and never reads `__current_this`, so
            // this is a no-op for that case.
            //
            // The `__current_this` global is registered eagerly during setup
            // (`ensureCurrentThisGlobal` in index.ts), so we read the cached
            // `ctx.currentThisGlobalIdx` directly here — importing
            // `ensureCurrentThisGlobal` from `nested-declarations.ts` would
            // create a module-init import cycle (it imports `getVecInfo` back
            // from this file) and a TDZ ReferenceError. If unset (-1), skip
            // threading (no worse than the legacy behaviour).
            if (ctx.currentThisGlobalIdx >= 0) {
              const prevThisLocal = allocTempLocal(fctx, { kind: "externref" });
              const tpResultLocal = allocTempLocal(fctx, { kind: "f64" });
              // (#2679 fix) Read `ctx.currentThisGlobalIdx` FRESH at each global
              // op — do NOT cache it across `buildDispatch(0)`. Compiling the
              // valueOf dispatch can register a new global (verified: the
              // `__current_this` slot shifts +1 mid-dispatch), and the
              // late-import/global shift pass bumps BOTH `ctx.currentThisGlobalIdx`
              // AND the already-emitted save/install instructions in `fctx.body`
              // in lockstep — but a captured local would go stale, so the RESTORE
              // `global.set` would target the pre-shift index (now a different,
              // f64-typed global), storing an externref into an f64 global →
              // invalid Wasm ("global.set expected type f64, found externref" —
              // the 30-test regression that park-held #2078). Reading fresh keeps
              // the restore aligned with the shifted save/install.
              // (`project_type_index_shift_and_deadelim`: never cache a shiftable
              // index across a sub-compilation.)
              // save __current_this, install the receiver (struct → externref)
              fctx.body.push({ op: "global.get", index: ctx.currentThisGlobalIdx });
              fctx.body.push({ op: "local.set", index: prevThisLocal });
              fctx.body.push({ op: "local.get", index: structLocal });
              fctx.body.push({ op: "extern.convert_any" });
              fctx.body.push({ op: "global.set", index: ctx.currentThisGlobalIdx });
              // dispatch (leaves f64 on stack) → capture
              for (const instr of buildDispatch(0)) {
                fctx.body.push(instr);
              }
              fctx.body.push({ op: "local.set", index: tpResultLocal });
              // restore __current_this (FRESH index — see note above), then
              // re-push the captured result
              fctx.body.push({ op: "local.get", index: prevThisLocal });
              fctx.body.push({ op: "global.set", index: ctx.currentThisGlobalIdx });
              fctx.body.push({ op: "local.get", index: tpResultLocal });
              releaseTempLocal(fctx, prevThisLocal);
              releaseTempLocal(fctx, tpResultLocal);
            } else {
              for (const instr of buildDispatch(0)) {
                fctx.body.push(instr);
              }
            }
            // (#1989) Restore the re-entrancy guard before returning. Without
            // this, coercing the FIRST of two struct operands (e.g. `a < b`)
            // leaves `__insideValueOfCoercion` set, so the SECOND operand's
            // coercion takes the recursion-guard early-return and silently
            // yields NaN. (Latent since this eqref-closure path was rarely
            // reached for method-shorthand before per-instance dispatch.)
            cleanup();
            return;
          }
          // No closure types found — check for a standalone ClassName_valueOf function (#433)
          // Method shorthand syntax (e.g. { valueOf() { ... } }) compiles as a standalone
          // function rather than a closure stored in the struct field.
          const standaloneValueOf = ctx.funcMap.get(`${name}_valueOf`);
          if (standaloneValueOf !== undefined) {
            const funcType = ctx.mod.types[definedFuncAt(ctx, standaloneValueOf)?.typeIdx ?? -1];
            const retKind = funcType?.kind === "func" ? funcType.results?.[0]?.kind : undefined;
            // (#1525b §7.1.1.1 step 6) For object-ref return, we must re-route
            // through the host helper using the ORIGINAL struct. Save it before
            // the call consumes it. For other return kinds the original code
            // path is unchanged.
            const needsHostFallback = retKind === "ref" || retKind === "ref_null";
            let savedStructLocal = -1;
            if (needsHostFallback) {
              savedStructLocal = allocLocal(fctx, `__svo_struct_${fctx.locals.length}`, from);
              // Stack currently has `from` (struct) — duplicate via tee then
              // restore via local.get so the call sees the same value.
              fctx.body.push({ op: "local.tee", index: savedStructLocal });
            }
            fctx.body.push({ op: "call", funcIdx: standaloneValueOf });
            if (retKind === "i32") {
              fctx.body.push({ op: "f64.convert_i32_s" });
            } else if (retKind === "externref" || retKind === "ref_extern") {
              // valueOf returned a string (externref) — convert to f64
              addUnionImports(ctx);
              const unboxIdx = ctx.funcMap.get("__unbox_number");
              if (unboxIdx !== undefined) {
                fctx.body.push({ op: "call", funcIdx: unboxIdx });
              } else {
                fctx.body.push({ op: "drop" });
                fctx.body.push({ op: "f64.const", value: NaN });
              }
            } else if (needsHostFallback) {
              // (#1525b) valueOf returned an object — try toString and throw
              // TypeError per §7.1.1.1. Mirror the eqref subpath at ~line 1882.
              fctx.body.push({ op: "drop" });
              fctx.body.push({ op: "local.get", index: savedStructLocal });
              const hintSvoRet = toPrimitiveHint ?? "number";
              emitToPrimitiveHostCall(ctx, fctx, "f64", hintSvoRet);
            }
            return;
          }
          // No valueOf via eqref — try toString fallback (#866)
          if (tryToStringFallback(ctx, fctx, from, typeIdx, name!, fields)) {
            cleanup();
            return;
          }
          // Fall through to host ToPrimitive (#1090)
          {
            const hint = toPrimitiveHint ?? "number";
            emitToPrimitiveHostCall(ctx, fctx, "f64", hint);
          }
          cleanup();
          return;
        }
      }
    }
  }

  // Fallback: drop + push default
  fctx.body.push({ op: "drop" });
  pushDefaultValue(fctx, to, ctx);
}

/**
 * Try to call toString on a struct as a fallback for ToPrimitive when valueOf is missing (#866).
 * Per JS spec, ToPrimitive with "number"/"default" hint tries valueOf first, then toString.
 * If toString is found and returns a primitive, converts the result to f64 via __unbox_number.
 * Returns true if toString was found and code was emitted, false otherwise.
 * Expects the struct ref on top of the Wasm stack; consumes it.
 */
function tryToStringFallback(
  ctx: CodegenContext,
  fctx: FunctionContext,
  from: ValType,
  typeIdx: number,
  structName: string,
  fields: { name: string; type: ValType }[],
): boolean {
  // 1. Check for toString struct field (closure ref)
  const toStrFieldIdx = fields.findIndex((f) => f.name === "toString");
  if (toStrFieldIdx >= 0) {
    const toStrField = fields[toStrFieldIdx]!;
    if (toStrField.type.kind === "ref" || toStrField.type.kind === "ref_null") {
      const closureTypeIdx = (toStrField.type as { typeIdx: number }).typeIdx;
      const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
      if (closureInfo) {
        // Save struct ref, extract toString closure, call it
        const structLocal = allocLocal(fctx, `__ts_struct_${fctx.locals.length}`, from);
        fctx.body.push({ op: "local.set", index: structLocal });
        fctx.body.push({ op: "local.get", index: structLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: toStrFieldIdx });
        const closureLocal = allocLocal(fctx, `__ts_closure_${fctx.locals.length}`, toStrField.type);
        fctx.body.push({ op: "local.tee", index: closureLocal });
        fctx.body.push({ op: "local.get", index: closureLocal });
        fctx.body.push({ op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 });
        {
          const tmpFunc = allocTempLocal(fctx, { kind: "funcref" } as ValType);
          fctx.body.push({ op: "local.tee", index: tmpFunc });
          fctx.body.push({ op: "ref.test", typeIdx: closureInfo.funcTypeIdx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx } as ValType },
            then: [
              { op: "local.get", index: tmpFunc },
              { op: "ref.cast_null", typeIdx: closureInfo.funcTypeIdx },
            ],
            else: [{ op: "ref.null", typeIdx: closureInfo.funcTypeIdx }],
          });
          releaseTempLocal(fctx, tmpFunc);
        }
        fctx.body.push({ op: "ref.as_non_null" });
        fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
        // Convert toString result to f64
        emitToStringResultToF64(ctx, fctx, closureInfo.returnType);
        return true;
      }
    }
    if (toStrField.type.kind === "eqref") {
      // toString field is eqref — try tracked closure types
      const trackedTypes = ctx.valueOfClosureTypes.get(structName) ?? [];
      // Also check toStringClosureTypes if available
      for (const closureTypeIdx of trackedTypes) {
        const info = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
        if (info && info.paramTypes.length === 0) {
          // Try this closure type
          const structLocal = allocLocal(fctx, `__ts_struct_${fctx.locals.length}`, from);
          fctx.body.push({ op: "local.set", index: structLocal });
          fctx.body.push({ op: "local.get", index: structLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: toStrFieldIdx });
          const eqLocal = allocLocal(fctx, `__ts_eq_${fctx.locals.length}`, { kind: "eqref" });
          fctx.body.push({ op: "local.set", index: eqLocal });
          // ref.test + cast + call
          fctx.body.push({ op: "local.get", index: eqLocal });
          fctx.body.push({ op: "ref.test", typeIdx: closureTypeIdx });
          fctx.body.push({
            op: "if",
            blockType: { kind: "val", type: { kind: "f64" } },
            then: (
              [
                { op: "local.get", index: eqLocal },
                { op: "ref.cast", typeIdx: closureTypeIdx },
                (() => {
                  const closureLocal2 = allocLocal(fctx, `__ts_cl2_${fctx.locals.length}`, {
                    kind: "ref",
                    typeIdx: closureTypeIdx,
                  });
                  return { op: "local.tee", index: closureLocal2 };
                })(),
                (() => {
                  const closureLocal2 = fctx.locals.length - 1 + fctx.params.length;
                  return { op: "local.get", index: closureLocal2 };
                })(),
                { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
                (() => {
                  const funcTmp = allocTempLocal(fctx, { kind: "funcref" } as ValType);
                  const instrs: Instr[] = [
                    { op: "local.tee", index: funcTmp },
                    { op: "ref.test", typeIdx: info.funcTypeIdx },
                    {
                      op: "if",
                      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: info.funcTypeIdx } as ValType },
                      then: [
                        { op: "local.get", index: funcTmp },
                        { op: "ref.cast_null", typeIdx: info.funcTypeIdx },
                      ],
                      else: [{ op: "ref.null", typeIdx: info.funcTypeIdx }],
                    },
                    { op: "ref.as_non_null" },
                    { op: "call_ref", typeIdx: info.funcTypeIdx },
                  ];
                  releaseTempLocal(fctx, funcTmp);
                  // Convert result to f64
                  if (info.returnType?.kind === "i32") {
                    instrs.push({ op: "f64.convert_i32_s" });
                  } else if (info.returnType?.kind === "externref" || info.returnType?.kind === "ref_extern") {
                    addUnionImports(ctx);
                    const unboxIdx = ctx.funcMap.get("__unbox_number");
                    if (unboxIdx !== undefined) {
                      instrs.push({ op: "call", funcIdx: unboxIdx });
                    } else {
                      instrs.push({ op: "drop" });
                      instrs.push({ op: "f64.const", value: NaN });
                    }
                  } else if (
                    info.returnType &&
                    (info.returnType.kind === "ref" ||
                      info.returnType.kind === "ref_null" ||
                      info.returnType.kind === "anyref" ||
                      info.returnType.kind === "eqref")
                  ) {
                    // (#3306) ref-kind result — under nativeStrings this is the
                    // native string `toString` returned; StringToNumber it
                    // (§7.1.4.1). This is the arm object-literal `{toString}`
                    // shapes actually hit (eqref-typed field): the old
                    // drop+NaN ran the method and threw away "7".
                    const strInstrs = refResultStringToF64Instrs(ctx, fctx);
                    if (strInstrs !== null) {
                      instrs.push(...strInstrs);
                    } else {
                      instrs.push({ op: "drop" });
                      instrs.push({ op: "f64.const", value: NaN });
                    }
                  } else if (!info.returnType || info.returnType.kind !== "f64") {
                    if (info.returnType) instrs.push({ op: "drop" });
                    instrs.push({ op: "f64.const", value: NaN });
                  }
                  return instrs;
                })(),
              ] satisfies (Instr | Instr[])[]
            ).flat(),
            else: [{ op: "f64.const", value: NaN }],
          });
          return true;
        }
      }
    }
  }

  // 2. Check for standalone ClassName_toString method
  const toStrFuncIdx = ctx.funcMap.get(`${structName}_toString`);
  if (toStrFuncIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: toStrFuncIdx });
    const funcType = ctx.mod.types[definedFuncAt(ctx, toStrFuncIdx)?.typeIdx ?? -1];
    const retKind = funcType?.kind === "func" ? funcType.results?.[0]?.kind : undefined;
    emitToStringResultToF64ByKind(ctx, fctx, retKind);
    return true;
  }

  return false;
}

/**
 * #1806 Phase 1 (string-hint slice) — OrdinaryToPrimitive over a compile-time
 * resolvable object struct in the **string** direction, for `--target standalone`
 * / WASI (native-strings) mode where there is no JS host `__to_primitive`.
 *
 * Mirrors the closure/method dispatch of {@link tryToStringFallback} (the
 * numeric-hint walker) but produces a string instead of an f64, so that
 * `obj + "s"`, `` `${obj}` `` and `String(obj)` invoke the object's own
 * `@@toPrimitive("string")` / `toString` instead of falling through to the
 * `$__any_to_string` helper, which can only emit `"[object Object]"` for a
 * struct it cannot introspect.
 *
 * Per ECMA-262 §7.1.1.1 OrdinaryToPrimitive with hint "string": try `toString`
 * first, then `valueOf`. We dispatch (in precedence order):
 *   1. the `toString` closure field (object-literal method) via call_ref
 *   2. a named `${name}_toString` method in funcMap
 * Each result is normalised to a `ref $AnyString` (the native string the concat
 * / template path expects). On success the struct ref on top of the stack is
 * consumed and a `ref $AnyString` is left; returns true. When neither form is
 * statically resolvable, the struct ref is left untouched and the function
 * returns false so the caller can fall back to `$__any_to_string`.
 *
 * NOTE: a user `[Symbol.toPrimitive]` ("string"-hint precedence over toString)
 * is intentionally NOT handled here yet — its hint argument must be marshalled
 * as a native string in standalone/native-strings mode, which the existing
 * `pushStringHint` (externref-global) path does not satisfy. Left to a follow-up
 * so this slice stays regression-free; objects with only `toString`/`valueOf`
 * (the dominant cluster) are covered.
 *
 * Expects the struct ref on top of the Wasm stack; consumes it only on success.
 */
export function tryStructToString(ctx: CodegenContext, fctx: FunctionContext, from: ValType): boolean {
  if (from.kind !== "ref" && from.kind !== "ref_null") return false;
  const typeIdx = (from as { typeIdx: number }).typeIdx;
  const name = ctx.typeIdxToStructName.get(typeIdx);
  if (name === undefined) return false;
  // The native string type indices (`anyStrTypeIdx`, used by the result
  // normaliser + `$__any_to_string`) are populated lazily; ensure they exist
  // before any `ref.cast`/helper emission below references them.
  ensureAnyToStringHelper(ctx);
  if (ctx.anyStrTypeIdx < 0) return false;

  // Reuse the full OrdinaryToPrimitive dispatcher so object-returning
  // `toString` methods fall through to `valueOf` in standalone mode too.
  if (tryStructStringHintExternrefDispatch(ctx, fctx, from, typeIdx, name)) {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
    return true;
  }

  // START-safe void-returning object-literal methods need the same dispatch in
  // native-string mode as the externref target above. The helper leaves the
  // canonical "undefined" string as externref; recover its `$AnyString` ref.
  if (tryStructPrimitiveToStringAsExternref(ctx, fctx, from, typeIdx, name)) {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
    return true;
  }

  // Normalise whatever the dispatched method left on the stack into a
  // `ref $AnyString`. Strings come back as externref / ref $AnyString; numbers
  // and booleans are routed through the standalone `$__any_to_string` dispatcher
  // (which handles AnyValue boxes + AnyString passthrough). A bare ref_null
  // string is cast to the concrete $AnyString so the value type is exact.
  const normaliseToString = (retKind: string | undefined): void => {
    // A dispatched method with no Wasm result either always throws (`never`) or
    // returns JavaScript `undefined` (`void`). In the first case the following
    // literal is dead code; in the second, `undefined` is a legitimate
    // primitive result of OrdinaryToPrimitive and the surrounding ToString
    // must produce the string "undefined".
    if (retKind === undefined || retKind === "void") {
      addStringConstantGlobal(ctx, "undefined");
      fctx.body.push(...stringConstantExternrefInstrs(ctx, "undefined"));
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
      return;
    }
    if (retKind === "externref" || retKind === "ref_extern") {
      // externref holding a native string → any.convert_extern + cast.
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
    } else if (retKind === "ref" || retKind === "ref_null") {
      // Already an anyref subtype (the native `$AnyString` is `ref null 5`).
      // ref.cast to the concrete $AnyString so the value type is exact.
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
    } else {
      // f64 / i32 / boolean / void → box and route through $__any_to_string.
      const anyToStrIdx = ensureAnyToStringHelper(ctx);
      if (retKind === "i32") {
        // Could be a bare number or a boolean; treat as number for ToString.
        fctx.body.push({ op: "f64.convert_i32_s" });
        addUnionImports(ctx);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "any.convert_extern" });
      } else if (retKind === "f64") {
        addUnionImports(ctx);
        const boxIdx = ctx.funcMap.get("__box_number");
        if (boxIdx !== undefined) fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "any.convert_extern" });
      }
      fctx.body.push({ op: "call", funcIdx: anyToStrIdx });
    }
  };

  const funcResultKind = (funcIdx: number): string | undefined => {
    const def = definedFuncAt(ctx, funcIdx);
    const ft = def ? ctx.mod.types[def.typeIdx] : undefined;
    return ft?.kind === "func" ? ft.results?.[0]?.kind : undefined;
  };

  // 0. `[Symbol.toPrimitive]` method (`${name}_@@toPrimitive`) — takes precedence
  // over toString/valueOf per §7.1.1.1 (ToString(obj) = ToString(ToPrimitive(obj,
  // "string"))). (#2866 slice 4) Mirrors the numeric (ref→f64) @@toPrimitive
  // dispatch in `coerceType`: self is already on the stack, push the "string" hint
  // externref, call the wrapper, then normalise the result (f64/i32/string-ref) to
  // a `ref $AnyString`. Host-free: the only late import is `__box_number` (native
  // in standalone), reached only when the method returns a number. This was the
  // deferred residual noted in the old comment below — String()/template-literal
  // string coercion now dispatches `[Symbol.toPrimitive]("string")` natively.
  const toPrimFuncIdx = ctx.funcMap.get(`${name}_@@toPrimitive`);
  if (toPrimFuncIdx !== undefined) {
    pushStringHint(ctx, fctx, "string");
    fctx.body.push({ op: "call", funcIdx: toPrimFuncIdx });
    const retKind = funcResultKind(toPrimFuncIdx);
    if (retKind === "f64" || retKind === "i32") {
      // Numeric primitive result → ToString via the native `number_toString`
      // formatter (host-free), mirroring the f64→string bridge in
      // `coercion-engine.ts`. Register it on demand — `emitNativeNumberFormat`
      // only APPENDS defined funcs (no import insertion → no funcIdx-shift
      // hazard). This is preferred over `normaliseToString`'s
      // `__box_number`→`$__any_to_string` route, whose boxed-number arm is
      // OMITTED when `number_toString` was absent at the (cached) helper's build
      // time (an object-only program never registers it otherwise → the result
      // would mis-stringify to "[object Object]").
      if (retKind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
      let numToStrIdx = ctx.funcMap.get("number_toString");
      if (numToStrIdx === undefined) {
        emitNativeNumberFormat(ctx, new Set(["number_toString"]));
        numToStrIdx = ctx.funcMap.get("number_toString");
      }
      if (numToStrIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: numToStrIdx });
        fctx.body.push({ op: "any.convert_extern" });
        fctx.body.push({ op: "ref.cast", typeIdx: ctx.anyStrTypeIdx });
        return true;
      }
    }
    normaliseToString(retKind);
    return true;
  }

  // 1. `toString` closure field (object-literal method) via call_ref.
  const fields = ctx.structFields.get(name);
  if (fields) {
    const toStrFieldIdx = fields.findIndex((f) => f.name === "toString");
    if (toStrFieldIdx >= 0) {
      const toStrField = fields[toStrFieldIdx]!;
      if (toStrField.type.kind === "ref" || toStrField.type.kind === "ref_null") {
        const closureTypeIdx = (toStrField.type as { typeIdx: number }).typeIdx;
        const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
        if (closureInfo) {
          const structLocal = allocLocal(fctx, `__sts_struct_${fctx.locals.length}`, from);
          fctx.body.push({ op: "local.set", index: structLocal });
          fctx.body.push({ op: "local.get", index: structLocal });
          fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: toStrFieldIdx });
          const closureLocal = allocLocal(fctx, `__sts_closure_${fctx.locals.length}`, toStrField.type);
          fctx.body.push({ op: "local.tee", index: closureLocal });
          fctx.body.push({ op: "local.get", index: closureLocal });
          fctx.body.push({ op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 });
          {
            const tmpFunc = allocTempLocal(fctx, { kind: "funcref" } as ValType);
            fctx.body.push({ op: "local.tee", index: tmpFunc });
            fctx.body.push({ op: "ref.test", typeIdx: closureInfo.funcTypeIdx });
            fctx.body.push({
              op: "if",
              blockType: { kind: "val", type: { kind: "ref_null", typeIdx: closureInfo.funcTypeIdx } as ValType },
              then: [
                { op: "local.get", index: tmpFunc },
                { op: "ref.cast_null", typeIdx: closureInfo.funcTypeIdx },
              ],
              else: [{ op: "ref.null", typeIdx: closureInfo.funcTypeIdx }],
            });
            releaseTempLocal(fctx, tmpFunc);
          }
          fctx.body.push({ op: "ref.as_non_null" });
          fctx.body.push({ op: "call_ref", typeIdx: closureInfo.funcTypeIdx });
          normaliseToString(closureInfo.returnType?.kind);
          return true;
        }
      }
      // eqref-stored closure (object-literal method) — recover the concrete
      // closure type from the tracked list (populated in literals.ts; the map
      // name covers toString too) and call it. Mirrors the numeric-hint eqref
      // dispatch (ref→f64) but normalises the result to a native string.
      if (toStrField.type.kind === "eqref") {
        const trackedTypes = ctx.valueOfClosureTypes.get(name) ?? [];
        const allCallable: { closureTypeIdx: number; info: ClosureInfo }[] = [];
        for (const closureTypeIdx of trackedTypes) {
          const info = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
          if (info && info.paramTypes.length === 0) allCallable.push({ closureTypeIdx, info });
        }
        // The tracked list mixes the `valueOf` (f64-returning) and `toString`
        // (string-returning) closure types for this struct, and structurally
        // identical closure structs are indistinguishable by `ref.test`. For a
        // string hint prefer the string-returning closure(s) so we never call a
        // number-returning `valueOf` with the wrong signature (a null-deref /
        // illegal cast). If none return a string, fall back to all candidates.
        const isStringReturn = (rt: ValType | null | undefined): boolean =>
          rt?.kind === "externref" || rt?.kind === "ref_extern" || rt?.kind === "ref" || rt?.kind === "ref_null";
        const stringReturning = allCallable.filter((c) => isStringReturn(c.info.returnType));
        const callable = stringReturning.length > 0 ? stringReturning : allCallable;
        if (callable.length === 0) return false;
        const structLocal = allocLocal(fctx, `__sts_estruct_${fctx.locals.length}`, from);
        fctx.body.push({ op: "local.set", index: structLocal });
        fctx.body.push({ op: "local.get", index: structLocal });
        fctx.body.push({ op: "struct.get", typeIdx, fieldIdx: toStrFieldIdx });
        const eqLocal = allocLocal(fctx, `__sts_eq_${fctx.locals.length}`, { kind: "eqref" });
        fctx.body.push({ op: "local.set", index: eqLocal });
        // Build a nested if/else that tries each candidate closure type. Every
        // arm produces a `ref $AnyString`; the final fallback is "[object Object]".
        const buildDispatch = (idx: number): Instr[] => {
          if (idx >= callable.length) {
            return [
              { op: "local.get", index: structLocal },
              { op: "call", funcIdx: ensureAnyToStringHelper(ctx) },
            ];
          }
          const { closureTypeIdx, info } = callable[idx]!;
          const closureLocal = allocLocal(fctx, `__sts_cl_${fctx.locals.length}`, {
            kind: "ref",
            typeIdx: closureTypeIdx,
          });
          const funcTmp = allocLocal(fctx, `__sts_fn_${fctx.locals.length}`, { kind: "funcref" } as ValType);
          const thenInstrs: Instr[] = [
            { op: "local.get", index: eqLocal },
            { op: "ref.cast", typeIdx: closureTypeIdx },
            { op: "local.tee", index: closureLocal },
            { op: "local.get", index: closureLocal },
            { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
            { op: "local.tee", index: funcTmp },
            { op: "ref.test", typeIdx: info.funcTypeIdx },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "ref_null", typeIdx: info.funcTypeIdx } as ValType },
              then: [
                { op: "local.get", index: funcTmp },
                { op: "ref.cast_null", typeIdx: info.funcTypeIdx },
              ],
              else: [{ op: "ref.null", typeIdx: info.funcTypeIdx }],
            },
            { op: "ref.as_non_null" },
            { op: "call_ref", typeIdx: info.funcTypeIdx },
          ];
          // Inline the result normalisation into this arm's instruction list.
          const savedBody = fctx.body;
          const scratch: Instr[] = [];
          fctx.body = scratch;
          // (#2182) Register the detached outer body in liveBodies so a late
          // import triggered inside `normaliseToString` shifts its accumulated
          // `call` funcIdxs too (the shifter only walks fctx.body = scratch
          // here, not this raw local).
          ctx.liveBodies.add(savedBody);
          normaliseToString(info.returnType?.kind);
          fctx.body = savedBody;
          ctx.liveBodies.delete(savedBody);
          thenInstrs.push(...scratch);
          return [
            { op: "local.get", index: eqLocal },
            { op: "ref.test", typeIdx: closureTypeIdx },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "ref", typeIdx: ctx.anyStrTypeIdx } as ValType },
              then: thenInstrs,
              else: buildDispatch(idx + 1),
            },
          ];
        };
        for (const instr of buildDispatch(0)) fctx.body.push(instr);
        return true;
      }
    }
  }

  // 2. Named `${name}_toString` method.
  const toStrFuncIdx = ctx.funcMap.get(`${name}_toString`);
  if (toStrFuncIdx !== undefined) {
    fctx.body.push({ op: "call", funcIdx: toStrFuncIdx });
    normaliseToString(funcResultKind(toStrFuncIdx));
    return true;
  }

  return false;
}

/**
 * Convert the result of a toString call to f64.
 * Handles f64 (passthrough), i32 (convert), externref (unbox), and other types.
 */
function emitToStringResultToF64(
  ctx: CodegenContext,
  fctx: FunctionContext,
  returnType: ValType | null | undefined,
): void {
  if (!returnType) {
    // void return — push NaN
    fctx.body.push({ op: "f64.const", value: NaN });
  } else if (returnType.kind === "f64") {
    // already f64 — passthrough
  } else if (returnType.kind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (returnType.kind === "externref" || returnType.kind === "ref_extern") {
    // toString returned a string — convert to f64 via __unbox_number
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
    }
  } else {
    // (#3306) ref-kind result: under nativeStrings a `toString(){return "7"}`
    // closure returns the NATIVE string struct — StringToNumber it. Genuine
    // object returns keep the legacy NaN.
    const strInstrs = refResultStringToF64Instrs(ctx, fctx);
    if (strInstrs !== null) {
      fctx.body.push(...strInstrs);
    } else {
      // ref or other — drop and push NaN
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
    }
  }
}

/**
 * (#3306 — the #3174 "toString-only object → NaN" residual) Instruction
 * sequence converting a REF-kind ToPrimitive-method result that may be a
 * native string into f64 per §7.1.4 ToNumber step "If argument is a String,
 * return StringToNumber(argument)".
 *
 * Every `tryToStringFallback` result-converter treated a `ref`/`ref_null`
 * return as "object → drop + NaN" — but under nativeStrings that is exactly
 * what `toString(){ return "…" }` returns (a `ref $NativeString`/`$AnyString`
 * subtype), so `+{toString(){return "7"}}` executed toString and then dropped
 * the "7" (NaN). The test is a RUNTIME `ref.test $AnyString` (not a static
 * typeIdx match) so loosely-typed closure returns (eqref/anyref carriers)
 * convert too; a genuine object return misses the test and keeps the legacy
 * NaN (the spec's both-non-primitive TypeError remains a follow-up, unchanged
 * by this fix).
 *
 * Expects the ref-kind result on the stack; the sequence leaves an f64.
 * Returns `null` when native strings / `__str_to_number` are unavailable
 * (host lane — externref strings never reach the ref arm) so callers keep
 * their legacy drop+NaN byte-identically.
 */
function refResultStringToF64Instrs(ctx: CodegenContext, fctx: FunctionContext): Instr[] | null {
  if (!ctx.nativeStrings || ctx.anyStrTypeIdx < 0) return null;
  let strToNumberIdx = ctx.funcMap.get("__str_to_number");
  if (strToNumberIdx === undefined) {
    addUnionImports(ctx);
    strToNumberIdx = ctx.funcMap.get("__str_to_number");
  }
  if (strToNumberIdx === undefined) return null;
  const tmp = allocTempLocal(fctx, { kind: "anyref" } as ValType);
  const instrs: Instr[] = [
    { op: "local.set", index: tmp },
    { op: "local.get", index: tmp },
    { op: "ref.test", typeIdx: ctx.anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "f64" } },
      then: [{ op: "local.get", index: tmp }, { op: "extern.convert_any" }, { op: "call", funcIdx: strToNumberIdx }],
      else: [{ op: "f64.const", value: NaN }],
    },
  ];
  releaseTempLocal(fctx, tmp);
  return instrs;
}

/**
 * Same as emitToStringResultToF64 but takes a string kind.
 */
function emitToStringResultToF64ByKind(ctx: CodegenContext, fctx: FunctionContext, retKind: string | undefined): void {
  if (retKind === "f64") {
    // already f64 — passthrough
  } else if (retKind === "i32") {
    fctx.body.push({ op: "f64.convert_i32_s" });
  } else if (retKind === "externref" || retKind === "ref_extern") {
    addUnionImports(ctx);
    const unboxIdx = ctx.funcMap.get("__unbox_number");
    if (unboxIdx !== undefined) {
      fctx.body.push({ op: "call", funcIdx: unboxIdx });
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
    }
  } else if (retKind === "ref" || retKind === "ref_null" || retKind === "anyref" || retKind === "eqref") {
    // (#3306) ref-kind result — may be a native string; StringToNumber it.
    const strInstrs = refResultStringToF64Instrs(ctx, fctx);
    if (strInstrs !== null) {
      fctx.body.push(...strInstrs);
    } else {
      fctx.body.push({ op: "drop" });
      fctx.body.push({ op: "f64.const", value: NaN });
    }
  } else {
    // non-f64 return — drop and push NaN
    if (retKind && retKind !== "void") fctx.body.push({ op: "drop" });
    fctx.body.push({ op: "f64.const", value: NaN });
  }
}

/**
 * Emit instructions that push the JS `undefined` value onto the stack (#737).
 * Uses the __get_undefined host import when available; falls back to
 * ref.null.extern (indistinguishable from null) in standalone mode.
 * This is a local version to avoid circular deps with expressions.ts.
 */
function emitUndefinedValue(ctx: CodegenContext, fctx: FunctionContext): void {
  // (#2029) Standalone / native-strings mode has no JS host to satisfy a
  // `__get_undefined` import, and `ensureLateImport` does NOT refuse this name —
  // so without this guard the import LEAKS and the module fails to instantiate
  // with an empty import object (the `env: module is not an object` linker
  // error). Mirror the canonical `ensureGetUndefined` guard: undefined collapses
  // to `ref.null.extern` standalone (indistinguishable from null, by design).
  const funcIdx = ctx.nativeStrings ? undefined : ensureLateImport(ctx, "__get_undefined", [], [{ kind: "externref" }]);
  if (funcIdx !== undefined) {
    flushLateImportShifts(ctx, fctx);
    fctx.body.push({ op: "call", funcIdx });
    return;
  }
  // (#2106 S1) In standalone/nativeStrings with the $undefined singleton flag ON,
  // an absent optional/default parameter must be the tag-1 singleton so the
  // callee's externref default-check (`__extern_is_undefined`, singleton-only
  // under the flag) fires the default. Flag OFF → the legacy `ref.null.extern`
  // (byte-identical). Without this, a missing `any`-typed default param
  // (`function f(x = 9){} ; f()`) padded with raw null was invisible to the
  // flag-on check → the default spuriously failed to fire.
  const singletonInstrs = undefinedExternInstrs(ctx);
  if (singletonInstrs !== undefined) {
    fctx.body.push(...singletonInstrs);
  } else {
    fctx.body.push({ op: "ref.null.extern" });
  }
}

export function pushDefaultValue(fctx: FunctionContext, type: ValType, ctx?: CodegenContext): void {
  switch (type.kind) {
    case "f64":
      // Default value for missing f64 args without initializers: 0.
      // For params WITH initializers, callers should use pushParamSentinel instead (#866).
      fctx.body.push({ op: "f64.const", value: 0 });
      break;
    case "i32":
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
    case "i64":
      fctx.body.push({ op: "i64.const", value: 0n });
      break;
    case "externref":
      // When ctx is available, emit the actual JS `undefined` value (#737).
      // Missing function arguments should be `undefined`, not `null`.
      // In standalone mode (no host imports), falls back to ref.null.extern.
      if (ctx) {
        emitUndefinedValue(ctx, fctx);
      } else {
        fctx.body.push({ op: "ref.null.extern" });
      }
      break;
    case "eqref":
      fctx.body.push({ op: "ref.null.eq" });
      break;
    case "anyref":
      fctx.body.push({ op: "ref.null.eq" });
      break;
    case "ref_null":
      fctx.body.push({ op: "ref.null", typeIdx: type.typeIdx });
      break;
    case "ref":
      // ref.null produces (ref null N), but (ref N) is non-nullable.
      // Push ref.null then ref.as_non_null to satisfy Wasm validation.
      // This traps at runtime if actually executed, but parameter-padding
      // contexts typically don't reach non-null ref params with null values.
      // For if/else branches, callers should widen to ref_null first.
      fctx.body.push({ op: "ref.null", typeIdx: type.typeIdx });
      fctx.body.push({ op: "ref.as_non_null" });
      break;
    default:
      fctx.body.push({ op: "i32.const", value: 0 });
      break;
  }
}

/**
 * Push the caller-side default for a missing optional parameter (#869).
 *
 * For constant defaults (number literal, boolean, null, undefined):
 *   Emit the constant value directly — no sentinel needed, callee never checks.
 *
 * For expression defaults (non-constant initializer):
 *   Fall back to the sNaN sentinel (0x7FF00000DEADC0DE) for f64 params.
 *   The callee detects this via i64.reinterpret_f64 + i64.eq and evaluates the expression.
 *
 * For params without initializers (just `?`):
 *   Emit the type's zero value (0, ref.null, etc.).
 */
export function pushParamSentinel(
  fctx: FunctionContext,
  type: ValType,
  ctx?: CodegenContext,
  optInfo?: OptionalParamInfo,
): void {
  // If we have a constant default, emit it directly (#869)
  if (optInfo?.constantDefault) {
    const cd = optInfo.constantDefault;
    if (cd.kind === "f64") {
      fctx.body.push({ op: "f64.const", value: cd.value });
    } else {
      fctx.body.push({ op: "i32.const", value: cd.value });
    }
    return;
  }

  // Expression default or no constant available — use sentinel for f64
  if (type.kind === "f64" && (optInfo?.hasExpressionDefault ?? true)) {
    // Unique sNaN sentinel: quiet bit (bit 51) clear, custom payload.
    // JS NaN is always 0x7FF8000000000000 (quiet NaN), so this is distinguishable.
    fctx.body.push({ op: "i64.const", value: 0x7ff00000deadc0den });
    fctx.body.push({ op: "f64.reinterpret_i64" });
  } else {
    pushDefaultValue(fctx, type, ctx);
  }
}

export function defaultValueInstrs(vt: ValType): Instr[] {
  switch (vt.kind) {
    case "f64":
      // Use sNaN sentinel so destructuring default checks (which compare against
      // 0x7FF00000DEADC0DE) correctly trigger for out-of-bounds elements (#866)
      return [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }];
    case "f32":
      return [{ op: "f32.const", value: 0 }];
    case "i32":
    case "i8":
    case "i16":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "externref":
    case "ref_extern":
      return [{ op: "ref.null.extern" }];
    case "ref":
      return [{ op: "ref.null", typeIdx: (vt as { typeIdx: number }).typeIdx }];
    case "ref_null":
      return [{ op: "ref.null", typeIdx: (vt as { typeIdx: number }).typeIdx }];
    case "eqref":
      return [{ op: "ref.null.eq" }];
    case "anyref":
      return [{ op: "ref.null.eq" }];
    case "funcref":
      return [{ op: "ref.null.func" }];
    default:
      // Fallback: sNaN sentinel (most arrays are f64 in this compiler)
      return [{ op: "i64.const", value: 0x7ff00000deadc0den }, { op: "f64.reinterpret_i64" }];
  }
}

/**
 * Generate Instr[] to coerce a value from one Wasm type to another.
 * Used in pre-built instruction arrays (e.g. array method callback loops)
 * where we can't call coerceType() which pushes to fctx.body.
 * Returns an empty array if no coercion is needed.
 */
export function coercionInstrs(ctx: CodegenContext, from: ValType, to: ValType, fctx?: FunctionContext): Instr[] {
  const fromKind = from.kind === "i8" || from.kind === "i16" ? "i32" : from.kind;
  const toKind = to.kind === "i8" || to.kind === "i16" ? "i32" : to.kind;
  if (from.kind !== fromKind || to.kind !== toKind) {
    if (fromKind === toKind) return [];
    if (fromKind === "i32" && toKind === "f64") return [{ op: "f64.convert_i32_s" }];
    if (fromKind === "f64" && toKind === "i32") return [{ op: "i32.trunc_sat_f64_s" }];
  }
  if (from.kind === to.kind) return [];

  const symbolBoundary = symbolBoundaryCoercionInstrs(ctx, from, to, fctx);
  if (symbolBoundary) return symbolBoundary;

  // #1917 Step 0: scalar / numeric / box-unbox rows come from the single
  // coercion table. Excluded here (kept as the original rows below): `from`
  // ref/ref_null — coercionInstrs intentionally NaNs/0s a bare GC ref ToNumber
  // (object without valueOf, §7.1.4) and has its own AnyValue→externref helper
  // + guarded ref.cast arms that need `ctx`/`fctx`.
  if (from.kind !== "ref" && from.kind !== "ref_null") {
    const needsBox =
      (to.kind === "externref" || to.kind === "ref_extern") &&
      (fromKind === "f64" || fromKind === "i32" || fromKind === "i64");
    const needsUnbox =
      (from.kind === "externref" || from.kind === "ref_extern") &&
      (toKind === "f64" || toKind === "i32" || toKind === "i64");
    if (needsBox || needsUnbox) addUnionImports(ctx);
    const plan = coercionPlan(from, to, {
      boxNumberIdx: ctx.funcMap.get("__box_number") ?? null,
      unboxNumberIdx: ctx.funcMap.get("__unbox_number") ?? null,
    });
    if (plan && !plan.lossy) return plan.instrs;
  }

  // ref_null → ref: assert non-null
  if (from.kind === "ref_null" && to.kind === "ref") {
    return [{ op: "ref.as_non_null" }];
  }
  // ref/ref_null → externref: extern.convert_any
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "externref") {
    if ((ctx.standalone || ctx.wasi) && isAnyValue(from, ctx)) {
      addUnionImports(ctx);
      const anyToExternIdx = ensureAnyToExternHelper(ctx);
      if (anyToExternIdx !== undefined) {
        return [{ op: "call", funcIdx: anyToExternIdx }];
      }
    }
    return [{ op: "extern.convert_any" }];
  }
  // externref → i32: unbox number then truncate
  if (from.kind === "externref" && to.kind === "i32") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      return [{ op: "call", funcIdx }, { op: "i32.trunc_sat_f64_s" }];
    }
  }
  // i64 → f64
  if (from.kind === "i64" && to.kind === "f64") {
    return [{ op: "f64.convert_i64_s" }];
  }
  // f64 → i64
  if (from.kind === "f64" && to.kind === "i64") {
    return [{ op: "i64.trunc_sat_f64_s" }];
  }
  // i32 → i64
  if (from.kind === "i32" && to.kind === "i64") {
    return [{ op: "i64.extend_i32_s" }];
  }
  // i64 → i32
  if (from.kind === "i64" && to.kind === "i32") {
    return [{ op: "i32.wrap_i64" }];
  }
  // i64 → externref: convert to f64 then box
  if (from.kind === "i64" && to.kind === "externref") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__box_number");
    if (funcIdx !== undefined) {
      return [{ op: "f64.convert_i64_s" }, { op: "call", funcIdx }];
    }
  }
  // externref → i64: unbox number then truncate
  if (from.kind === "externref" && to.kind === "i64") {
    addUnionImports(ctx);
    const funcIdx = ctx.funcMap.get("__unbox_number");
    if (funcIdx !== undefined) {
      return [{ op: "call", funcIdx }, { op: "i64.trunc_sat_f64_s" }];
    }
  }
  // ref/ref_null → f64: drop and push NaN (ToNumber on object without valueOf)
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "f64") {
    return [{ op: "drop" }, { op: "f64.const", value: NaN }];
  }
  // ref/ref_null → i32: drop and push 0
  if ((from.kind === "ref" || from.kind === "ref_null") && to.kind === "i32") {
    return [{ op: "drop" }, { op: "i32.const", value: 0 }];
  }
  // funcref → externref: funcref is NOT a subtype of anyref in WasmGC,
  // so extern.convert_any cannot be used. Drop and push null as fallback.
  if (from.kind === "funcref" && to.kind === "externref") {
    return [{ op: "drop" }, { op: "ref.null.extern" }];
  }
  // funcref → anyref: separate hierarchies in WasmGC, keep as no-op fallback
  if (from.kind === "funcref" && to.kind === "anyref") {
    return [];
  }
  // eqref → externref: extern.convert_any
  if (from.kind === "eqref" && to.kind === "externref") {
    return [{ op: "extern.convert_any" }];
  }
  // anyref → externref: extern.convert_any
  if (from.kind === "anyref" && to.kind === "externref") {
    return [{ op: "extern.convert_any" }];
  }
  // externref → anyref: any.convert_extern
  if (from.kind === "externref" && to.kind === "anyref") {
    return [{ op: "any.convert_extern" }];
  }
  // externref → eqref: defensive fallback mirroring the `coercionPlan` row
  // (which normally intercepts this above). `any.convert_extern` yields ANYREF —
  // the SUPERtype of eqref — so it must be narrowed with a nullable ref.cast to
  // the abstract `eq` heap type (-19), else an eqref-slot store fails validation
  // (#2878). See coercion-plan.ts for the authoritative rationale.
  if (from.kind === "externref" && to.kind === "eqref") {
    const EQ_HEAP_TYPE = -19;
    return [{ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: EQ_HEAP_TYPE }];
  }
  // externref → ref_null: any.convert_extern + guarded ref.cast_null
  if (from.kind === "externref" && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    // (#2831) Vec-typed target: the inbound externref may be a HOST value (a `[]`
    // already marshalled by `__make_iterable` at a dynamic any-receiver write),
    // NOT a wasm vec. A bare/guarded ref.cast either TRAPS (no fctx) or silently
    // returns null → DROPPED write (the #2664 desync). Route through the reserved
    // per-vec materializer (host-externref-aware; empty/non-empty/host/same-rep/
    // null uniformly → fresh vec of the exact type, on the slot). Only once
    // `reserveVecFieldMaterializers` has populated the map (finalize); pre-finalize
    // callers keep the guarded-cast path below (byte-identical).
    const vecMatIdx = vecFromExternFuncIdx(ctx, toIdx);
    if (vecMatIdx !== undefined) return [{ op: "call", funcIdx: vecMatIdx }];
    if (fctx) {
      return [
        { op: "any.convert_extern" },
        ...guardedRefCastInstrs(fctx, toIdx, { tempType: { kind: "anyref" } as ValType, nonNull: false }),
      ];
    }
    // No fctx available — use original ref.cast (may trap as illegal_cast,
    // but that's more informative than silently returning null).
    return [{ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: toIdx }];
  }
  // externref → ref: any.convert_extern + guarded ref.cast
  if (from.kind === "externref" && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    // (#2831) Vec-typed non-null target — same materializer routing as the
    // ref_null arm above; the materializer returns ref_null $vec, so assert
    // non-null for the (ref $vec) field type (a null write traps, matching the
    // non-null field contract — never silently dropped).
    const vecMatIdx = vecFromExternFuncIdx(ctx, toIdx);
    if (vecMatIdx !== undefined) return [{ op: "call", funcIdx: vecMatIdx }, { op: "ref.as_non_null" }];
    if (fctx) {
      // NOTE: no trailing `ref.as_non_null` even though `to.kind === "ref"` — this
      // arm has always yielded a `ref_null` (nonNull: false), preserved exactly.
      return [
        { op: "any.convert_extern" },
        ...guardedRefCastInstrs(fctx, toIdx, { tempType: { kind: "anyref" } as ValType, nonNull: false }),
      ];
    }
    // No fctx available — use ref.cast_null (passes null through instead of trapping)
    return [{ op: "any.convert_extern" }, { op: "ref.cast_null", typeIdx: toIdx }];
  }
  // eqref/anyref → ref_null: guarded ref.cast_null
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref_null") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    if (fctx) {
      return guardedRefCastInstrs(fctx, toIdx, { tempType: from, nonNull: false });
    }
    return [{ op: "ref.cast_null", typeIdx: toIdx }];
  }
  // eqref/anyref → ref: guarded ref.cast
  if ((from.kind === "eqref" || from.kind === "anyref") && to.kind === "ref") {
    const toIdx = (to as { typeIdx: number }).typeIdx;
    if (fctx) {
      // NOTE: no trailing `ref.as_non_null` even though `to.kind === "ref"` — this
      // arm has always yielded a `ref_null` (nonNull: false), preserved exactly.
      return guardedRefCastInstrs(fctx, toIdx, { tempType: from, nonNull: false });
    }
    return [{ op: "ref.cast", typeIdx: toIdx }];
  }
  return [];
}

// Register coerceType so shared.ts callers (closures, statements) can use it
registerCoerceType(coerceType);
