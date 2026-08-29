// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FieldDef, Instr, ValType } from "../ir/types.js";
import type { ts } from "../ts-api.js";
import { captureSourceSlot, recordLiftedCaptureSlots } from "./closures/capture-source-slot.js";
import { allocLocal, getLocalType } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { emitFnctorCtorCallSiteArgc } from "./fnctor-ctor-arguments.js";
import { FNCTOR_CONSTRUCTOR_FIELD } from "./fnctor-identity-fields.js";
import { getOrRegisterRefCellType, refCellValueType } from "./registry/types.js";
import { coerceType, compileExpression } from "./shared.js";
import { pushDefaultValue } from "./type-coercion.js";

export interface FnctorCapture {
  name: string;
  outerLocalIdx: number;
  mutable?: boolean;
  valType?: ValType;
  hasTdzFlag?: boolean;
  outerTdzFlagIdx?: number;
}

export interface FnctorCaptureLayout {
  captures: readonly FnctorCapture[];
  valueParamTypes: ValType[];
  tdzFlagParamTypes: ValType[];
  allParamTypes: ValType[];
}

/** Resolve the leading capture-parameter layout for a synthesized fnctor ctor. */
export function fnctorCaptureLayout(ctx: CodegenContext, funcName: string): FnctorCaptureLayout {
  const captures = (ctx.nestedFuncCaptures.get(funcName) ?? []).map((capture) => ({ ...capture }));
  const valueParamTypes = captures.map((capture) => {
    if (capture.mutable && capture.valType) {
      return { kind: "ref" as const, typeIdx: getOrRegisterRefCellType(ctx, capture.valType) };
    }
    return capture.valType ?? { kind: "externref" as const };
  });
  const tdzFlagParamTypes = captures
    .filter((capture) => capture.hasTdzFlag)
    .map(() => ({ kind: "ref" as const, typeIdx: getOrRegisterRefCellType(ctx, { kind: "i32" }) }));
  return {
    captures,
    valueParamTypes,
    tdzFlagParamTypes,
    allParamTypes: [...valueParamTypes, ...tdzFlagParamTypes],
  };
}

/** Add leading captures and, where runtime identity exists, the exact callee as the hidden trailing parameter. */
export function fnctorConstructorParams(
  ctx: CodegenContext,
  userParams: ValType[],
  captureParamTypes: readonly ValType[] = [],
): ValType[] {
  const params = [...captureParamTypes, ...userParams];
  return ctx.wasi ? params : [...params, { kind: "externref" }];
}

/** Recover the user-visible constructor parameters from a cached ctor signature. */
export function fnctorUserParamTypes(
  ctx: CodegenContext,
  captureLayout: FnctorCaptureLayout,
  allParamTypes: ValType[] | undefined,
): ValType[] | undefined {
  if (!allParamTypes) return undefined;
  const firstUser = captureLayout.allParamTypes.length;
  const end = ctx.wasi ? undefined : -1;
  return allParamTypes.slice(firstUser, end);
}

/** Add the hidden parameter definition without shifting user parameter indices. */
export function appendFnctorConstructorParam(ctx: CodegenContext, params: { name: string; type: ValType }[]): void {
  if (!ctx.wasi) params.push({ name: "__constructor_identity", type: { kind: "externref" } });
}

/** Register synthesized ctor capture params as the body-visible bindings. */
export function registerFnctorCaptureParams(
  ctx: CodegenContext,
  fctx: FunctionContext,
  layout: FnctorCaptureLayout,
): void {
  if (layout.captures.length === 0) return;
  recordLiftedCaptureSlots(
    fctx,
    layout.captures.map((capture) => capture.name),
  );
  for (let i = 0; i < layout.captures.length; i++) {
    const capture = layout.captures[i]!;
    if (!capture.mutable) {
      const valueType = layout.valueParamTypes[i]!;
      const isRefCell =
        (valueType.kind === "ref" || valueType.kind === "ref_null") &&
        ctx.typeIdxToStructName.get(valueType.typeIdx)?.startsWith("__ref_cell_");
      if (isRefCell) {
        const inner = refCellValueType(ctx, valueType.typeIdx);
        if (inner) {
          (fctx.boxedCaptures ??= new Map()).set(capture.name, {
            refCellTypeIdx: valueType.typeIdx,
            valType: inner,
          });
        }
      }
      continue;
    }
    const paramType = layout.valueParamTypes[i]!;
    if (paramType.kind !== "ref" && paramType.kind !== "ref_null") continue;
    (fctx.boxedCaptures ??= new Map()).set(capture.name, {
      refCellTypeIdx: paramType.typeIdx,
      valType: capture.valType ?? { kind: "externref" },
    });
  }

  const valueCount = layout.captures.length;
  for (let i = 0; i < layout.captures.length; i++) {
    const capture = layout.captures[i]!;
    if (!capture.hasTdzFlag) continue;
    const flagIndex = valueCount + layout.captures.slice(0, i + 1).filter((entry) => entry.hasTdzFlag).length - 1;
    const flagType =
      layout.tdzFlagParamTypes[layout.captures.slice(0, i + 1).filter((entry) => entry.hasTdzFlag).length - 1]!;
    if (flagType.kind !== "ref" && flagType.kind !== "ref_null") continue;
    (fctx.boxedTdzFlags ??= new Map()).set(capture.name, {
      refCellTypeIdx: flagType.typeIdx,
      localIdx: flagIndex,
    });
    (fctx.tdzFlagLocals ??= new Map()).set(capture.name, flagIndex);
  }
}

function emitFnctorCaptureArgument(
  ctx: CodegenContext,
  fctx: FunctionContext,
  capture: FnctorCapture,
  expectedType: ValType,
): void {
  if (capture.mutable && capture.valType && (expectedType.kind === "ref" || expectedType.kind === "ref_null")) {
    const existing = fctx.boxedCaptures?.has(capture.name) ? fctx.localMap.get(capture.name) : undefined;
    if (existing !== undefined) {
      fctx.body.push({ op: "local.get", index: existing });
      const actual = getLocalType(fctx, existing);
      if (actual && actual.kind !== expectedType.kind) coerceType(ctx, fctx, actual, expectedType);
      return;
    }
    const promoted =
      fctx.localMap.get(capture.name) === undefined ? ctx.capturedBoxGlobals?.get(capture.name) : undefined;
    if (promoted !== undefined) {
      fctx.body.push({ op: "global.get", index: promoted.globalIdx });
      fctx.body.push({ op: "ref.as_non_null" });
      return;
    }
    const source = captureSourceSlot(fctx, capture);
    fctx.body.push({ op: "local.get", index: source });
    fctx.body.push({ op: "struct.new", typeIdx: expectedType.typeIdx });
    const boxedLocal = allocLocal(fctx, `__boxed_${capture.name}`, expectedType);
    fctx.body.push({ op: "local.tee", index: boxedLocal });
    fctx.localMap.set(capture.name, boxedLocal);
    (fctx.boxedCaptures ??= new Map()).set(capture.name, {
      refCellTypeIdx: expectedType.typeIdx,
      valType: capture.valType,
    });
    return;
  }

  if (fctx.localMap.get(capture.name) === undefined && ctx.capturedGlobals.has(capture.name)) {
    fctx.body.push({ op: "global.get", index: ctx.capturedGlobals.get(capture.name)! });
    if (ctx.capturedGlobalsWidened.has(capture.name)) fctx.body.push({ op: "ref.as_non_null" });
    return;
  }
  const source = captureSourceSlot(fctx, capture);
  fctx.body.push({ op: "local.get", index: source });
  const actual = getLocalType(fctx, source);
  if (actual && actual.kind !== expectedType.kind) coerceType(ctx, fctx, actual, expectedType);
}

function emitFnctorCaptureFlagArgument(ctx: CodegenContext, fctx: FunctionContext, capture: FnctorCapture): void {
  const existing = fctx.boxedTdzFlags?.get(capture.name);
  if (existing) {
    fctx.body.push({ op: "local.get", index: existing.localIdx });
    return;
  }
  const live = fctx.tdzFlagLocals?.get(capture.name);
  const liveType = live === undefined ? undefined : getLocalType(fctx, live);
  if (live !== undefined && liveType?.kind === "i32") {
    fctx.body.push({ op: "local.get", index: live });
  } else {
    fctx.body.push({ op: "i32.const", value: 1 });
  }
  const flagType = getOrRegisterRefCellType(ctx, { kind: "i32" });
  fctx.body.push({ op: "struct.new", typeIdx: flagType });
  const flagLocal = allocLocal(fctx, `__tdz_box_${capture.name}`, { kind: "ref", typeIdx: flagType });
  fctx.body.push({ op: "local.tee", index: flagLocal });
  (fctx.boxedTdzFlags ??= new Map()).set(capture.name, { refCellTypeIdx: flagType, localIdx: flagLocal });
  (fctx.tdzFlagLocals ??= new Map()).set(capture.name, flagLocal);
}

/**
 * Initialize the native fnctor instance. The constructor identity is installed
 * before the user body runs; every other field retains its legacy zero/null
 * initializer.
 */
export function emitFnctorFieldInitializers(
  ctx: CodegenContext,
  fctx: FunctionContext,
  fields: FieldDef[],
  constructorIdentityParamIdx: number,
): void {
  for (const field of fields) {
    let instr: Instr;
    if (ctx.standalone && field.name === FNCTOR_CONSTRUCTOR_FIELD) {
      instr = { op: "local.get", index: constructorIdentityParamIdx };
    } else if (field.type.kind === "f64") {
      instr = { op: "f64.const", value: 0 };
    } else if (field.type.kind === "i32") {
      instr = { op: "i32.const", value: 0 };
    } else if (field.type.kind === "i64") {
      instr = { op: "i64.const", value: 0n };
    } else if (field.type.kind === "externref") {
      instr = { op: "ref.null.extern" };
    } else if (field.type.kind === "ref_null" || field.type.kind === "ref") {
      instr = { op: "ref.null", typeIdx: field.type.typeIdx };
    } else {
      instr = { op: "i32.const", value: 0 };
    }
    fctx.body.push(instr);
  }
}

/**
 * Evaluate and park the exact callee before user arguments, then append it
 * after those arguments for the synthesized native constructor signature.
 */
export function emitFnctorConstructorArguments(
  ctx: CodegenContext,
  fctx: FunctionContext,
  captureLayout: FnctorCaptureLayout,
  callee: ts.Expression,
  args: readonly ts.Expression[],
  userParamTypes: ValType[] | undefined,
  ctorReadsArguments = false,
): void {
  let constructorIdentityLocal: number | undefined;
  if (!ctx.wasi) {
    const valueType = compileExpression(ctx, fctx, callee, { kind: "externref" });
    if (!valueType) {
      fctx.body.push({ op: "ref.null.extern" });
    } else if (valueType.kind !== "externref" && valueType.kind !== "ref_extern") {
      coerceType(ctx, fctx, valueType, { kind: "externref" });
    }
    constructorIdentityLocal = allocLocal(fctx, `__fnctor_ctor_value_${fctx.locals.length}`, {
      kind: "externref",
    });
    fctx.body.push({ op: "local.set", index: constructorIdentityLocal });
  }

  for (let i = 0; i < captureLayout.captures.length; i++) {
    emitFnctorCaptureArgument(ctx, fctx, captureLayout.captures[i]!, captureLayout.valueParamTypes[i]!);
  }
  for (const capture of captureLayout.captures) {
    if (capture.hasTdzFlag) emitFnctorCaptureFlagArgument(ctx, fctx, capture);
  }

  // (#4464) An OVER-supplied `new F(a, b)` on a one-parameter `F` used to push
  // BOTH values, so the `call` consumed the trailing ones and every declared
  // parameter read the argument to its right: `function __func(arg){this.foo=
  // arg}` called as `new __func(__FOO, __BAR)` stored `__BAR`
  // (`S13.2.2_A6_T2`). §10.2.1.3 passes the extra arguments to [[Call]], where
  // only `arguments` can observe them — but they must still be EVALUATED for
  // their side effects, in source order, before the call. So compile each one
  // in place and drop it: order preserved, arity restored.
  //
  // (fnctor-ctor-arguments.ts) …but only `arguments` can observe them, so when
  // the ctor body READS `arguments` the over-supplied values are parked in
  // externref locals and published through `__extras_argv`/`__argc` instead of
  // being discarded. Same evaluation order, same arity; the drop becomes a
  // `local.set`. Every other constructor keeps the drop byte-identically.
  const declaredCount = userParamTypes?.length;
  const extrasLocals: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const actual = compileExpression(ctx, fctx, args[i]!, userParamTypes?.[i]);
    if (declaredCount !== undefined && i >= declaredCount && actual !== null && actual !== undefined) {
      if (ctorReadsArguments) {
        if (actual.kind !== "externref") coerceType(ctx, fctx, actual, { kind: "externref" });
        const slot = allocLocal(fctx, `__fnctor_extra_${fctx.locals.length}`, { kind: "externref" });
        fctx.body.push({ op: "local.set", index: slot });
        extrasLocals.push(slot);
      } else {
        fctx.body.push({ op: "drop" });
      }
    }
  }
  for (let i = args.length; i < (userParamTypes?.length ?? 0); i++) {
    pushDefaultValue(fctx, userParamTypes![i]!, ctx);
  }
  if (ctorReadsArguments) {
    emitFnctorCtorCallSiteArgc(ctx, fctx, declaredCount ?? args.length, extrasLocals, args.length);
  }
  if (constructorIdentityLocal !== undefined) {
    fctx.body.push({ op: "local.get", index: constructorIdentityLocal });
  }
}
