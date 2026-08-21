// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Bounded GlobalEnvironmentRecord lowering shared by identifier reads, writes,
 * and deletes (#2726). Host/gc uses the current sandbox global; host-free
 * targets use the existing native `$Object` singleton.
 */
import type { Instr, ValType } from "../ir/types.js";
import { ts } from "../ts-api.js";
import { ensureAnyHelpers } from "./any-helpers.js";
import { emitNativeGlobalThisObject } from "./array-object-proto.js";
import { popBody, pushBody } from "./context/bodies.js";
import { allocLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import {
  ensureDirectEvalActivationStatePoolLocal,
  ensureDirectEvalStateBindingDelete,
  ensureDirectEvalStateValueCellLookup,
  RUNTIME_EVAL_DELETABLE_BINDING_MARKER,
  runtimeEvalStateMayShadowBinding,
} from "./direct-eval-environment.js";
import { emitThrowReferenceError } from "./expressions/helpers.js";
import { emitUndefined, ensureLateImport, flushLateImportShifts } from "./expressions/late-imports.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { isStrictContext } from "./helpers/is-strict-function.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { ensureObjVecBuilders } from "./object-runtime.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { buildRuntimeEvalValueUnwrap } from "./runtime-eval-boundary.js";

const RUNTIME_EVAL_CLAIM_STATE_VALUE_CELL = "__runtime_eval_claim_activation_state_value_cell";

export function emitGlobalEnvironmentObject(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  if (ctx.standalone || ctx.wasi) {
    return emitNativeGlobalThisObject(ctx, fctx);
  }

  const getGlobalIdx = ensureLateImport(ctx, "__get_globalThis", [], [{ kind: "externref" }]);
  flushLateImportShifts(ctx, fctx);
  if (getGlobalIdx === undefined) return null;
  fctx.body.push({ op: "call", funcIdx: getGlobalIdx });
  return { kind: "externref" };
}

export function emitGlobalEnvironmentKey(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  addStringConstantGlobal(ctx, name);
  fctx.body.push(...stringConstantExternrefInstrs(ctx, name));
}

export function ensureGlobalEnvironmentOperation(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: "__extern_get" | "__extern_set" | "__delete_property" | "__hasOwnProperty" | "__extern_has",
): number | undefined {
  const externref: ValType = { kind: "externref" };
  const signature =
    name === "__extern_set"
      ? { params: [externref, externref, externref], results: [] }
      : name === "__extern_get"
        ? { params: [externref, externref], results: [externref] }
        : name === "__delete_property" || name === "__hasOwnProperty" || name === "__extern_has"
          ? { params: [externref, externref], results: [{ kind: "i32" } satisfies ValType] }
          : { params: [], results: [] };
  const idx = ensureLateImport(ctx, name, signature.params, signature.results);
  flushLateImportShifts(ctx, fctx);
  return idx;
}

/** Decode the provider's canonical primitive/reference carrier after reading
 * from the shared runtime-eval realm object. Values seeded by the caller are
 * not wrapped; the structural type test preserves them unchanged. */
export function runtimeEvalSharedValueUnwrapInstrs(ctx: CodegenContext, fctx: FunctionContext): Instr[] {
  ensureAnyHelpers(ctx);
  return buildRuntimeEvalValueUnwrap(ctx, fctx.locals, fctx.params.length);
}

export function emitRuntimeEvalSharedValueUnwrap(ctx: CodegenContext, fctx: FunctionContext): void {
  fctx.body.push(...runtimeEvalSharedValueUnwrapInstrs(ctx, fctx));
}

export interface RuntimeEvalBindingValueCell {
  poolLocal: number;
  valueCellLocal: number;
  cellTypeIdx: number;
}

/** Capture the provider-created binding decision at the current evaluation
 * point. A null cell means "not present"; a non-null cell proves that this
 * activation record owns the Reference. The cell itself can be tombstoned or
 * reused while an RHS runs, so writes revalidate it by name below. */
export function emitCaptureRuntimeEvalBindingValueCell(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
): RuntimeEvalBindingValueCell | undefined {
  if (!runtimeEvalStateMayShadowBinding(ctx, fctx, name)) return undefined;
  const state = ensureDirectEvalActivationStatePoolLocal(ctx, fctx);
  const lookupIdx = ensureDirectEvalStateValueCellLookup(ctx, state.cellTypeIdx);
  if (lookupIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, name);
  const valueCellLocal = allocLocal(fctx, `__runtime_eval_binding_cell_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push(
    { op: "local.get", index: state.poolLocal },
    ...stringConstantExternrefInstrs(ctx, name),
    { op: "call", funcIdx: lookupIdx },
    { op: "local.set", index: valueCellLocal },
  );
  return { poolLocal: state.poolLocal, valueCellLocal, cellTypeIdx: state.cellTypeIdx };
}

/** Register the bounded vacancy-claim used after a captured Reference's RHS
 * deletes its binding. The pre-RHS lookup has already proved that this exact
 * declarative environment owned `name`; SetMutableBinding therefore recreates
 * the name in that same environment instead of falling through to the global
 * object. A provider may have reused the original four-cell group meanwhile,
 * so the claim scans for a genuinely empty name/marker pair rather than
 * blindly writing through the stale value-cell pointer. */
function ensureRuntimeEvalStateValueCellClaim(ctx: CodegenContext, cellTypeIdx: number): number | undefined {
  const existing = ctx.funcMap.get(RUNTIME_EVAL_CLAIM_STATE_VALUE_CELL);
  if (existing !== undefined) return existing;

  ensureObjVecBuilders(ctx);
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  const objVecArrTypeIdx = ctx.objectRuntimeTypes?.objVecArrTypeIdx;
  if (objVecTypeIdx === undefined || objVecArrTypeIdx === undefined) return undefined;

  // params 0=pool, 1=name, 2=exact deletability marker; locals 3=poolAny,
  // 4=vec, 5=data, 6=len, 7=i, 8=cellAny.
  const poolAnyLocal = 3;
  const vecLocal = 4;
  const dataLocal = 5;
  const lengthLocal = 6;
  const indexLocal = 7;
  const cellAnyLocal = 8;
  const loadCellAny = (offset: number): Instr[] => [
    { op: "local.get", index: dataLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: indexLocal },
    ...(offset === 0 ? [] : [{ op: "i32.const", value: offset } as Instr, { op: "i32.add" } as Instr]),
    { op: "array.get", typeIdx: objVecArrTypeIdx },
    { op: "any.convert_extern" },
    { op: "local.tee", index: cellAnyLocal },
  ];
  const setCell = (offset: number, value: Instr[]): Instr[] => [
    ...loadCellAny(offset),
    { op: "ref.cast", typeIdx: cellTypeIdx },
    ...value,
    { op: "struct.set", typeIdx: cellTypeIdx, fieldIdx: 0 },
  ];
  const returnValueCell: Instr[] = [
    { op: "local.get", index: dataLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "array.get", typeIdx: objVecArrTypeIdx },
    { op: "return" },
  ];
  const claimVacancy: Instr[] = [
    ...setCell(0, [{ op: "local.get", index: 1 }]),
    ...setCell(1, [{ op: "ref.null.extern" }]),
    ...setCell(2, [{ op: "local.get", index: 2 }]),
    ...setCell(3, [{ op: "ref.null.extern" }]),
    ...returnValueCell,
  ];
  const loopBody: Instr[] = [
    // One binding occupies four cells. A truncated/malformed tail is not a
    // vacancy and must not produce an out-of-bounds access.
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: 3 },
    { op: "i32.add" },
    { op: "local.get", index: lengthLocal },
    { op: "i32.ge_u" },
    { op: "br_if", depth: 1 },
    ...loadCellAny(0),
    { op: "ref.test", typeIdx: cellTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: cellAnyLocal },
        { op: "ref.cast", typeIdx: cellTypeIdx },
        { op: "struct.get", typeIdx: cellTypeIdx, fieldIdx: 0 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            ...loadCellAny(2),
            { op: "ref.test", typeIdx: cellTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: cellAnyLocal },
                { op: "ref.cast", typeIdx: cellTypeIdx },
                { op: "struct.get", typeIdx: cellTypeIdx, fieldIdx: 0 },
                { op: "ref.is_null" },
                { op: "if", blockType: { kind: "empty" }, then: claimVacancy },
              ],
            },
          ],
        },
      ],
    },
    { op: "local.get", index: indexLocal },
    { op: "i32.const", value: 4 },
    { op: "i32.add" },
    { op: "local.set", index: indexLocal },
    { op: "br", depth: 0 },
  ];
  const body: Instr[] = [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: poolAnyLocal },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "return" }],
    },
    { op: "local.get", index: poolAnyLocal },
    { op: "ref.cast", typeIdx: objVecTypeIdx },
    { op: "local.set", index: vecLocal },
    { op: "local.get", index: vecLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: dataLocal },
    { op: "local.get", index: vecLocal },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
    { op: "local.set", index: lengthLocal },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: indexLocal },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
    },
    { op: "ref.null.extern" },
  ];
  const funcIdx = mintDefinedFunc(ctx);
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$runtime_eval_claim_activation_state_value_cell_type",
  );
  ctx.funcMap.set(RUNTIME_EVAL_CLAIM_STATE_VALUE_CELL, funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: RUNTIME_EVAL_CLAIM_STATE_VALUE_CELL,
    typeIdx,
    locals: [
      { name: "poolAny", type: { kind: "anyref" } },
      { name: "vec", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
      { name: "data", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
      { name: "len", type: { kind: "i32" } },
      { name: "i", type: { kind: "i32" } },
      { name: "cellAny", type: { kind: "anyref" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/** Re-resolve a previously captured activation Reference after its RHS ran.
 * If the RHS deleted that binding, SetMutableBinding recreates it in the same
 * record; if it recreated the same name itself, this returns that new cell. */
export function emitRefreshRuntimeEvalBindingValueCellForWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  binding: RuntimeEvalBindingValueCell,
): RuntimeEvalBindingValueCell | undefined {
  const lookupIdx = ensureDirectEvalStateValueCellLookup(ctx, binding.cellTypeIdx);
  const claimIdx = ensureRuntimeEvalStateValueCellClaim(ctx, binding.cellTypeIdx);
  if (lookupIdx === undefined || claimIdx === undefined) return undefined;
  addStringConstantGlobal(ctx, name);
  addStringConstantGlobal(ctx, RUNTIME_EVAL_DELETABLE_BINDING_MARKER);
  const valueCellLocal = allocLocal(fctx, `__runtime_eval_refreshed_binding_cell_${fctx.locals.length}`, {
    kind: "externref",
  });
  fctx.body.push(
    { op: "local.get", index: binding.poolLocal },
    ...stringConstantExternrefInstrs(ctx, name),
    { op: "call", funcIdx: ctx.funcMap.get("__runtime_eval_find_activation_state_value_cell") ?? lookupIdx },
    { op: "local.tee", index: valueCellLocal },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: binding.poolLocal },
        ...stringConstantExternrefInstrs(ctx, name),
        ...stringConstantExternrefInstrs(ctx, RUNTIME_EVAL_DELETABLE_BINDING_MARKER),
        { op: "call", funcIdx: ctx.funcMap.get(RUNTIME_EVAL_CLAIM_STATE_VALUE_CELL) ?? claimIdx },
        { op: "local.set", index: valueCellLocal },
      ],
    },
  );
  return { poolLocal: binding.poolLocal, valueCellLocal, cellTypeIdx: binding.cellTypeIdx };
}

/** Store an externref value through a captured provider-created value cell. */
export function emitRuntimeEvalBindingCellWrite(
  fctx: FunctionContext,
  binding: RuntimeEvalBindingValueCell,
  valueLocal: number,
): void {
  // Land the cast before struct.set. The serializer's backward receiver repair
  // otherwise sees the original externref local.get and inserts a duplicate
  // any.convert_extern/ref.cast in front of this already-correct conversion.
  const structLocal = allocLocal(fctx, `__runtime_eval_binding_struct_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: binding.cellTypeIdx,
  });
  fctx.body.push(
    { op: "local.get", index: binding.valueCellLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: binding.cellTypeIdx },
    { op: "local.set", index: structLocal },
    { op: "local.get", index: structLocal },
    { op: "ref.as_non_null" },
    { op: "local.get", index: valueLocal },
    { op: "struct.set", typeIdx: binding.cellTypeIdx, fieldIdx: 0 },
  );
}

/** Read a pre-scanned sloppy implicit global, throwing when it was deleted. */
export function emitImplicitGlobalRead(ctx: CodegenContext, fctx: FunctionContext, name: string): ValType | null {
  if (!emitGlobalEnvironmentObject(ctx, fctx)) return null;
  const objectLocal = allocLocal(fctx, `__implicit_global_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objectLocal });
  const hasOwnIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__hasOwnProperty");
  const getIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_get");
  if (hasOwnIdx === undefined || getIdx === undefined) return null;

  fctx.body.push({ op: "local.get", index: objectLocal });
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "call", funcIdx: hasOwnIdx }, { op: "i32.eqz" });
  const saved = pushBody(fctx);
  emitThrowReferenceError(ctx, fctx, `${name} is not defined`);
  const throwBody = fctx.body;
  popBody(fctx, saved);
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwBody, else: [] });

  fctx.body.push({ op: "local.get", index: objectLocal });
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "call", funcIdx: getIdx });
  return { kind: "externref" };
}

/** Read a name that runtime eval may have created on the realm global object.
 * Unlike the statically scanned sloppy-implicit-global path, this uses
 * HasProperty because a Global Environment Record delegates object-record
 * lookup through the prototype chain. `missingAsUndefined` implements the
 * special non-throwing lookup required by `typeof IdentifierName`. */
export function emitRuntimeEvalGlobalRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  missingAsUndefined: boolean,
): ValType | null {
  if (!emitGlobalEnvironmentObject(ctx, fctx)) return null;
  const objectLocal = allocLocal(fctx, `__runtime_eval_global_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objectLocal });
  const hasIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_has");
  const getIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_get");
  if (hasIdx === undefined || getIdx === undefined) return null;

  if (!missingAsUndefined) {
    fctx.body.push({ op: "local.get", index: objectLocal });
    emitGlobalEnvironmentKey(ctx, fctx, name);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_has") ?? hasIdx }, { op: "i32.eqz" });
    const saved = pushBody(fctx);
    emitThrowReferenceError(ctx, fctx, `${name} is not defined`);
    const throwBody = fctx.body;
    popBody(fctx, saved);
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: throwBody, else: [] });
    fctx.body.push({ op: "local.get", index: objectLocal });
    emitGlobalEnvironmentKey(ctx, fctx, name);
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? getIdx });
    emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
    return { kind: "externref" };
  }

  const savedPresent = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: objectLocal });
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_get") ?? getIdx });
  emitRuntimeEvalSharedValueUnwrap(ctx, fctx);
  const presentBody = fctx.body;
  popBody(fctx, savedPresent);

  const savedMissing = pushBody(fctx);
  emitUndefined(ctx, fctx);
  const missingBody = fctx.body;
  popBody(fctx, savedMissing);

  fctx.body.push({ op: "local.get", index: objectLocal });
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__extern_has") ?? hasIdx });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "externref" } },
    then: presentBody,
    else: missingBody,
  });
  return { kind: "externref" };
}

/** Read an identifier that may have been introduced by an earlier direct eval
 * in this AOT activation. The caller-owned state pool is the persistent
 * VariableEnvironment sidecar; a miss falls through to the ordinary realm
 * global lookup so direct-eval locals never leak onto `globalThis`.
 *
 * The shared lookup loop is called only after a direct-eval call allocated the
 * pool local in this function. Functions without direct eval remain
 * byte-identical. */
export function emitRuntimeEvalBindingRead(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  missingAsUndefined: boolean,
): ValType | null {
  // Build the global miss arm first: it can add late imports, after which the
  // state-lookup helper below sees the final late-import layout.
  const savedBody = pushBody(fctx);
  const fallbackType = emitRuntimeEvalGlobalRead(ctx, fctx, name, missingAsUndefined);
  const fallbackBody = fctx.body;
  popBody(fctx, savedBody);
  if (fallbackType === null) return null;

  const captured = emitCaptureRuntimeEvalBindingValueCell(ctx, fctx, name);
  if (!captured) {
    fctx.body.push(...fallbackBody);
    return fallbackType;
  }

  const presentBody: Instr[] = [
    { op: "local.get", index: captured.valueCellLocal },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: captured.cellTypeIdx },
    { op: "struct.get", typeIdx: captured.cellTypeIdx, fieldIdx: 0 },
    ...runtimeEvalSharedValueUnwrapInstrs(ctx, fctx),
  ];
  fctx.body.push(
    { op: "local.get", index: captured.valueCellLocal },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: presentBody,
      else: fallbackBody,
    },
  );
  return { kind: "externref" };
}

/** Delete a provider-created binding before falling back to the ordinary
 * global/static delete. Returns false when this activation cannot own such a
 * binding, in which case the caller should emit its fallback directly. */
export function emitRuntimeEvalBindingDelete(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  fallbackBody: Instr[],
): boolean {
  if (!runtimeEvalStateMayShadowBinding(ctx, fctx, name)) return false;
  const state = ensureDirectEvalActivationStatePoolLocal(ctx, fctx);
  const deleteIdx = ensureDirectEvalStateBindingDelete(ctx, state.cellTypeIdx);
  if (deleteIdx === undefined) return false;
  addStringConstantGlobal(ctx, name);
  addStringConstantGlobal(ctx, RUNTIME_EVAL_DELETABLE_BINDING_MARKER);
  fctx.body.push(
    { op: "local.get", index: state.poolLocal },
    ...stringConstantExternrefInstrs(ctx, name),
    ...stringConstantExternrefInstrs(ctx, RUNTIME_EVAL_DELETABLE_BINDING_MARKER),
    { op: "call", funcIdx: deleteIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 1 }],
      else: fallbackBody,
    },
  );
  return true;
}

/**
 * (#3985) Capture the GlobalEnvironmentRecord's HasBinding answer for `name`
 * BEFORE the RHS is compiled, returning the global-object temp plus the i32
 * result temp.
 *
 * §13.15.2 (`AssignmentExpression : LeftHandSideExpression = Assignment`)
 * resolves the LHS Reference in step 1.a — *before* `GetValue` of the RHS in
 * step 1.e. Computing HasBinding after the RHS would let an RHS that adds the
 * property to the global object change the binding decision, which is the exact
 * mis-lowering that regressed `S11.13.1_A6_T3` for the dynamic-`with` gate (see
 * `emitCaptureWithHasBinding` in `with-scope.ts`).
 *
 * The predicate is `__extern_has` (§7.3.12 HasProperty — own **and** prototype
 * chain), NOT `__hasOwnProperty`: §9.1.1.4.1 `GlobalEnvironmentRecord.HasBinding`
 * delegates to the object Environment Record, whose HasBinding is HasProperty.
 * The global object inherits from `Object.prototype`, so `toString = 1` in
 * strict code resolves and must not throw.
 *
 * Returns `undefined` when the global environment could not be materialised;
 * the caller must then fall back rather than emit a half-formed sequence.
 */
export function emitCaptureGlobalEnvironmentHasBinding(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
): { objLocalIdx: number; hasLocalIdx: number } | undefined {
  if (!emitGlobalEnvironmentObject(ctx, fctx)) return undefined;
  const objLocalIdx = allocLocal(fctx, `__genv_obj_${fctx.locals.length}`, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: objLocalIdx });

  const hasIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_has");
  if (hasIdx === undefined) return undefined;

  fctx.body.push({ op: "local.get", index: objLocalIdx });
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "call", funcIdx: hasIdx });
  const hasLocalIdx = allocLocal(fctx, `__genv_has_${fctx.locals.length}`, { kind: "i32" });
  fctx.body.push({ op: "local.set", index: hasLocalIdx });
  return { objLocalIdx, hasLocalIdx };
}

/**
 * (#3985) §6.2.5.6 PutValue steps 6.a–6.b, the STRICT arm for an identifier
 * whose Reference the compiler could not resolve statically.
 *
 *   if (HasBinding) Set(globalObj, name, value)
 *   else            throw ReferenceError(`<name> is not defined`)
 *
 * `hasLocalIdx` / `objLocalIdx` come from
 * {@link emitCaptureGlobalEnvironmentHasBinding} (captured before the RHS);
 * `valueLocalIdx` holds the already-evaluated RHS as an `externref`, so the
 * RHS's side effects are observable *before* the throw, per §13.15.2 step 1.e.
 *
 * Leaves nothing on the stack — the caller pushes the assignment's result.
 * Returns `false` when the set operation could not be registered.
 */
export function emitStrictUnresolvableGlobalWrite(
  ctx: CodegenContext,
  fctx: FunctionContext,
  name: string,
  objLocalIdx: number,
  hasLocalIdx: number,
  valueLocalIdx: number,
): boolean {
  const setIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__extern_set");
  if (setIdx === undefined) return false;

  const savedThen = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: objLocalIdx });
  emitGlobalEnvironmentKey(ctx, fctx, name);
  fctx.body.push({ op: "local.get", index: valueLocalIdx });
  fctx.body.push({ op: "call", funcIdx: setIdx });
  const thenArm = fctx.body;
  popBody(fctx, savedThen);

  const savedElse = pushBody(fctx);
  emitThrowReferenceError(ctx, fctx, `${name} is not defined`);
  const elseArm = fctx.body;
  popBody(fctx, savedElse);

  fctx.body.push({ op: "local.get", index: hasLocalIdx });
  fctx.body.push({ op: "if", blockType: { kind: "empty" }, then: thenArm, else: elseArm });
  return true;
}

/** Delete a global-object property; an absent property succeeds. */
export function emitGlobalEnvironmentDelete(ctx: CodegenContext, fctx: FunctionContext, name: string): void {
  if (!emitGlobalEnvironmentObject(ctx, fctx)) {
    fctx.body.push({ op: "i32.const", value: 1 });
    return;
  }
  emitGlobalEnvironmentKey(ctx, fctx, name);
  const deleteIdx = ensureGlobalEnvironmentOperation(ctx, fctx, "__delete_property");
  if (deleteIdx === undefined) {
    fctx.body.push({ op: "drop" }, { op: "drop" }, { op: "i32.const", value: 1 });
    return;
  }
  fctx.body.push({ op: "call", funcIdx: deleteIdx });
}

/**
 * (#4394) Whether `expr` denotes the GLOBAL OBJECT itself — `globalThis`, or a
 * script's top-level `this`.
 *
 * The global object is always a host value in the JS-host lane; it never has a
 * compiled WasmGC struct representation. But `var $262 = { global: globalThis }`
 * — which the test262 harness prefix puts in FRONT of every single test — makes
 * the checker mint a struct for `typeof globalThis`, and a later
 * `Object.defineProperty(globalThis, …)` then took the struct fast path. Its
 * guarded `ref.test`/`ref.cast` cannot match a host externref, so the receiver
 * became `ref.null` and the call threw "Object method called on null or
 * undefined" — a receiver that was never null.
 *
 * `this` counts only in a SCRIPT's top-level code, where it is the global
 * object; inside any function, or in a module, it is not. Mirrors the same
 * gate `isNonConfigurableGlobalObjectDelete` uses below.
 */
export function isGlobalObjectExpr(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): boolean {
  let cur: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  if (cur.kind === ts.SyntaxKind.ThisKeyword) return fctx.name === "__module_init" && !ctx.sourceIsModule;
  return ts.isIdentifier(cur) && cur.text === "globalThis" && !ctx.moduleGlobals.has("globalThis");
}

/**
 * The deleted member's NAME, for either spelling of a global-object member
 * access — `this.x` and `this["x"]` name the same property (§13.5.1.2 runs
 * ToPropertyKey on the computed form), so the `{ DontDelete }` answer must not
 * depend on which one the source used.
 *
 * (#4491 T4) The element-access arm is the gap: `S12.2_A2` spells its checks
 * `delete this["__variable"]`, which fell past a property-access-only guard to
 * the generic member delete and answered `true` for a declared `var`. The
 * identifier form of the same check (`delete __variable`) already answered
 * `false` in the same file — one binding, two answers, decided by spelling.
 * Only a STRING/no-substitution-template literal key qualifies; a computed key
 * is not knowable here and keeps the runtime path.
 */
function unwrapTypeOnly(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function globalObjectDeletedMember(operand: ts.Expression): { name: string; receiver: ts.Expression } | undefined {
  // `delete(this["k"])` — the Sputnik spelling — parses the operand as a
  // ParenthesizedExpression, so an unwrapped test misses the very files this
  // guard exists for.
  const target = unwrapTypeOnly(operand);
  if (ts.isPropertyAccessExpression(target)) {
    if (ts.isPrivateIdentifier(target.name)) return undefined;
    return { name: target.name.text, receiver: unwrapTypeOnly(target.expression) };
  }
  if (ts.isElementAccessExpression(target)) {
    const key = unwrapTypeOnly(target.argumentExpression);
    if (!ts.isStringLiteral(key) && !ts.isNoSubstitutionTemplateLiteral(key)) return undefined;
    return { name: key.text, receiver: unwrapTypeOnly(target.expression) };
  }
  return undefined;
}

/** Whether a direct module-init member delete targets a script var/function. */
export function isNonConfigurableGlobalObjectDelete(
  ctx: CodegenContext,
  fctx: FunctionContext,
  operand: ts.Expression,
): boolean {
  if (fctx.name !== "__module_init" || ctx.sourceIsModule) return false;
  const member = globalObjectDeletedMember(operand);
  if (member === undefined) return false;
  const { name, receiver } = member;
  const isGlobalObject =
    receiver.kind === ts.SyntaxKind.ThisKeyword ||
    (ts.isIdentifier(receiver) && receiver.text === "globalThis" && !ctx.moduleGlobals.has("globalThis"));
  return isGlobalObject && (ctx.globalObjectVarBindings?.has(name) || ctx.topLevelFunctionNames.has(name));
}

/** Emit the known outcome for a direct delete of a script var/function property. */
export function tryEmitNonConfigurableGlobalObjectDelete(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.DeleteExpression,
): ValType | null {
  if (!isNonConfigurableGlobalObjectDelete(ctx, fctx, expr.expression)) return null;
  if (isStrictContext(expr, ctx.inferModuleStrictArguments)) {
    fctx.body.push(
      ...buildThrowJsErrorInstrs(ctx, "TypeError", "Cannot delete non-configurable property in strict mode", {
        flush: fctx,
      }),
    );
  } else {
    fctx.body.push({ op: "i32.const", value: 0 });
  }
  return { kind: "i32" };
}
