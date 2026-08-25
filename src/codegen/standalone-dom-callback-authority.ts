// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { DOM_CALLBACK_AUTHORITY_FIELD } from "../dom-capability-contract.js";
import type { IrHostVoidCallbackLoweringPlan } from "../ir/ast-lowering-plans.js";
import type { IrClosureLowering } from "../ir/backend/handles.js";
import type { IrUnitId } from "../ir/identity.js";
import type { IrDomCallbackAuthority } from "../ir/nodes.js";
import type { GlobalDef, Instr, StructTypeDef, ValType, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { CLOSURE_CAPTURE_FIELD_BASE } from "./closures/funcref-wrapper-types.js";
import { definedFuncAt, definedFuncHandleOf, mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import { registerClosureBindingInfo } from "./closures/arrow-phases.js";
import { addFuncType } from "./registry/types.js";

interface StandaloneDomCallbackExpectation {
  readonly node: ts.ArrowFunction;
  readonly authority: IrDomCallbackAuthority;
}

interface StandaloneDomCallbackCarrier {
  readonly lowering: IrClosureLowering;
  readonly liftedFuncTypeIdx: number;
  readonly authorityFieldIdx: number;
  readonly authorityBrandGlobal: GlobalDef;
  liftedFunc?: WasmFunction;
}

interface StandaloneDomCallbackReservation {
  readonly dispatcher: WasmFunction;
  readonly authorityBrandType: StructTypeDef;
  readonly expectedByKey: ReadonlyMap<string, StandaloneDomCallbackExpectation>;
  readonly keyByNode: WeakMap<ts.ArrowFunction, string>;
  readonly carriersByKey: Map<string, StandaloneDomCallbackCarrier>;
  materialized: boolean;
}

const standaloneDomCallbackReservations = new WeakMap<CodegenContext, StandaloneDomCallbackReservation>();

/** Canonical backend-neutral identity for one certified reusable DOM callback. */
export function standaloneDomCallbackAuthorityKey(authority: IrDomCallbackAuthority): string {
  if (!Number.isSafeInteger(authority.liftedOrdinal) || authority.liftedOrdinal < 0) {
    throw new Error(`standalone DOM callback has invalid lifted ordinal ${authority.liftedOrdinal}`);
  }
  return `${authority.ownerUnitId}\0${authority.liftedOrdinal}`;
}

function exactStandaloneDomCallbackExpectations(
  callbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>,
  retainedOwnerUnitIds?: ReadonlySet<IrUnitId>,
): Map<string, StandaloneDomCallbackExpectation> {
  const expected = new Map<string, StandaloneDomCallbackExpectation>();
  for (const [node, plan] of callbacks) {
    if (retainedOwnerUnitIds && !retainedOwnerUnitIds.has(plan.ownerUnitId)) continue;
    if (
      plan.standaloneDomReusable !== true ||
      plan.signature.params.length !== 0 ||
      plan.signature.returnType !== null
    ) {
      throw new Error(`standalone DOM callback ${plan.ownerName}#${plan.liftedOrdinal} is not () -> void`);
    }
    const authority = Object.freeze({
      ownerUnitId: plan.ownerUnitId,
      liftedOrdinal: plan.liftedOrdinal,
    });
    const key = standaloneDomCallbackAuthorityKey(authority);
    if (expected.has(key)) {
      throw new Error(`standalone DOM callback authority ${key} is not unique`);
    }
    expected.set(key, Object.freeze({ node, authority }));
  }
  return expected;
}

function sameStandaloneDomCallbackExpectations(
  left: ReadonlyMap<string, StandaloneDomCallbackExpectation>,
  right: ReadonlyMap<string, StandaloneDomCallbackExpectation>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, expectation] of left) {
    const candidate = right.get(key);
    if (!candidate || candidate.node !== expectation.node) return false;
  }
  return true;
}

/**
 * Reserve the exact `(externref) -> void` dispatcher before prepared-component
 * sealing. The plan population, not a feature Boolean or a generic closure
 * bridge, is the authority root.
 */
export function reserveStandaloneDomCallbackDispatch(
  ctx: CodegenContext,
  callbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>,
  retainedOwnerUnitIds?: ReadonlySet<IrUnitId>,
): boolean {
  if (
    ctx.requiresStandaloneDomInteractionCapability !== true ||
    !ctx.standalone ||
    ctx.wasi ||
    !ctx.nativeStrings ||
    ctx.targetProfile.environment !== "none"
  ) {
    return false;
  }
  const expectedByKey = exactStandaloneDomCallbackExpectations(callbacks, retainedOwnerUnitIds);
  const existing = standaloneDomCallbackReservations.get(ctx);
  if (existing) return sameStandaloneDomCallbackExpectations(existing.expectedByKey, expectedByKey);

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [], "$standalone_dom_callback_dispatch_type");
  const dispatcher: WasmFunction = {
    name: "__js2_standalone_dom_callback_dispatch_impl",
    typeIdx,
    locals: [{ name: "__callback", type: { kind: "anyref" } }],
    body: [{ op: "unreachable" }],
    exported: false,
  };
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, dispatcher);
  const authorityBrandTypeIdx = ctx.mod.types.length;
  let authorityBrandTypeName = "$__js2_dom_callback_authority_brand";
  while (ctx.structMap.has(authorityBrandTypeName)) authorityBrandTypeName += "$";
  const authorityBrandType: StructTypeDef = {
    kind: "struct",
    name: authorityBrandTypeName,
    fields: [],
  };
  ctx.mod.types.push(authorityBrandType);
  ctx.structMap.set(authorityBrandType.name!, authorityBrandTypeIdx);
  ctx.typeIdxToStructName.set(authorityBrandTypeIdx, authorityBrandType.name!);
  const keyByNode = new WeakMap<ts.ArrowFunction, string>();
  for (const [key, expectation] of expectedByKey) keyByNode.set(expectation.node, key);
  standaloneDomCallbackReservations.set(ctx, {
    dispatcher,
    authorityBrandType,
    expectedByKey,
    keyByNode,
    carriersByKey: new Map(),
    materialized: false,
  });
  return true;
}

function standaloneDomCallbackAuthorityGlobalIdx(ctx: CodegenContext, authorityBrandGlobal: GlobalDef): number {
  const localIdx = ctx.mod.globals.indexOf(authorityBrandGlobal);
  if (localIdx < 0 || ctx.mod.globals.indexOf(authorityBrandGlobal, localIdx + 1) >= 0) {
    throw new Error("standalone DOM callback plan lost its exact singleton global");
  }
  return ctx.numImportGlobals + localIdx;
}

/** True only for the exact already-reserved callback plan population. */
export function hasReservedStandaloneDomCallbackDispatch(
  ctx: CodegenContext,
  callbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>,
  retainedOwnerUnitIds?: ReadonlySet<IrUnitId>,
): boolean {
  const reservation = standaloneDomCallbackReservations.get(ctx);
  if (!reservation || definedFuncHandleOf(ctx, reservation.dispatcher) === undefined) return false;
  return sameStandaloneDomCallbackExpectations(
    reservation.expectedByKey,
    exactStandaloneDomCallbackExpectations(callbacks, retainedOwnerUnitIds),
  );
}

/** Exact authority attached to one reserved direct-front-end callback node. */
export function standaloneDomCallbackAuthorityForNode(
  ctx: CodegenContext,
  node: ts.ArrowFunction | ts.FunctionExpression,
): IrDomCallbackAuthority | undefined {
  if (!ts.isArrowFunction(node)) return undefined;
  const reservation = standaloneDomCallbackReservations.get(ctx);
  const key = reservation?.keyByNode.get(node);
  return key === undefined ? undefined : reservation!.expectedByKey.get(key)?.authority;
}

function requireStandaloneDomCallbackExpectation(
  ctx: CodegenContext,
  authority: IrDomCallbackAuthority,
): { reservation: StandaloneDomCallbackReservation; key: string } {
  const reservation = standaloneDomCallbackReservations.get(ctx);
  const key = standaloneDomCallbackAuthorityKey(authority);
  if (!reservation?.expectedByKey.has(key)) {
    throw new Error(`standalone DOM callback authority ${key} was not reserved from the certified plan population`);
  }
  return { reservation, key };
}

function allocateStandaloneDomCallbackCarrier(
  ctx: CodegenContext,
  authority: IrDomCallbackAuthority,
  source: IrClosureLowering,
  superTypeIdx: number,
): StandaloneDomCallbackCarrier {
  const { reservation, key } = requireStandaloneDomCallbackExpectation(ctx, authority);
  const existing = reservation.carriersByKey.get(key);
  if (existing) {
    if (existing.liftedFuncTypeIdx !== source.funcTypeIdx) {
      throw new Error(`standalone DOM callback authority ${key} changed its lifted function type`);
    }
    return existing;
  }
  const sourceType = ctx.mod.types[source.structTypeIdx];
  const superType = ctx.mod.types[superTypeIdx];
  const funcType = ctx.mod.types[source.funcTypeIdx];
  if (!sourceType || sourceType.kind !== "struct" || !superType || superType.kind !== "struct") {
    throw new Error(`standalone DOM callback authority ${key} has no exact closure struct hierarchy`);
  }
  if (
    funcType?.kind !== "func" ||
    funcType.params.length !== 1 ||
    funcType.results.length !== 0 ||
    (funcType.params[0]?.kind !== "ref" && funcType.params[0]?.kind !== "ref_null")
  ) {
    throw new Error(`standalone DOM callback authority ${key} has no exact zero-argument void lifted ABI`);
  }
  const authorityBrandTypeIdx = ctx.mod.types.indexOf(reservation.authorityBrandType);
  if (
    authorityBrandTypeIdx < 0 ||
    ctx.mod.types.indexOf(reservation.authorityBrandType, authorityBrandTypeIdx + 1) >= 0
  ) {
    throw new Error(`standalone DOM callback authority ${key} lost its exact brand type`);
  }
  const carrierOrdinal = reservation.carriersByKey.size;
  const occupiedGlobalNames = new Set(ctx.mod.globals.map(({ name }) => name));
  let authorityBrandGlobalName = `$__js2_dom_callback_authority_${carrierOrdinal}`;
  while (occupiedGlobalNames.has(authorityBrandGlobalName)) authorityBrandGlobalName += "$";
  const authorityBrandGlobal: GlobalDef = {
    name: authorityBrandGlobalName,
    type: { kind: "ref", typeIdx: authorityBrandTypeIdx },
    mutable: false,
    init: [{ op: "struct.new", typeIdx: authorityBrandTypeIdx }],
  };
  ctx.mod.globals.push(authorityBrandGlobal);
  const typeIdx = ctx.mod.types.length;
  let typeName = `$__js2_dom_callback_${carrierOrdinal}`;
  while (ctx.structMap.has(typeName)) typeName += "$";
  const type: StructTypeDef = {
    kind: "struct",
    name: typeName,
    fields: [
      ...sourceType.fields.map((field) => ({ ...field })),
      {
        name: DOM_CALLBACK_AUTHORITY_FIELD,
        type: { ...authorityBrandGlobal.type },
        mutable: false,
      },
    ],
    superTypeIdx,
  };
  ctx.mod.types.push(type);
  ctx.structMap.set(typeName, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, typeName);
  const sourceInfo = ctx.closureInfoByTypeIdx.get(source.structTypeIdx);
  if (!sourceInfo || sourceInfo.paramTypes.length !== 0 || sourceInfo.returnType !== null) {
    throw new Error(`standalone DOM callback authority ${key} has no exact closure metadata`);
  }
  ctx.closureInfoByTypeIdx.set(typeIdx, {
    ...sourceInfo,
    structTypeIdx: typeIdx,
    hostOneShotOnly: undefined,
    domCallbackOnly: true,
  });
  const lowering: IrClosureLowering = {
    structTypeIdx: typeIdx,
    funcFieldIdx: source.funcFieldIdx,
    capFieldIdx: source.capFieldIdx,
    funcTypeIdx: source.funcTypeIdx,
    domCallbackAuthorityGlobalIdx: () => standaloneDomCallbackAuthorityGlobalIdx(ctx, authorityBrandGlobal),
  };
  const carrier = {
    lowering,
    liftedFuncTypeIdx: source.funcTypeIdx,
    authorityFieldIdx: type.fields.length - 1,
    authorityBrandGlobal,
  };
  reservation.carriersByKey.set(key, carrier);
  return carrier;
}

function recordStandaloneDomCallbackLiftedFunc(
  ctx: CodegenContext,
  authority: IrDomCallbackAuthority,
  carrier: StandaloneDomCallbackCarrier,
  liftedFuncIdx: number | undefined,
): void {
  if (liftedFuncIdx === undefined) return;
  const key = standaloneDomCallbackAuthorityKey(authority);
  const liftedFunc = definedFuncAt(ctx, liftedFuncIdx);
  if (!liftedFunc || liftedFunc.typeIdx !== carrier.liftedFuncTypeIdx) {
    throw new Error(`standalone DOM callback authority ${key} lost its exact lifted function object`);
  }
  if (carrier.liftedFunc && carrier.liftedFunc !== liftedFunc) {
    throw new Error(`standalone DOM callback authority ${key} was assigned more than one lifted function`);
  }
  carrier.liftedFunc = liftedFunc;
}

/** Resolve the unique nominal carrier used by prepared IR for one plan. */
export function resolveStandaloneDomCallbackClosureSubtype(
  ctx: CodegenContext,
  authority: IrDomCallbackAuthority,
  allocationWrapper: IrClosureLowering,
  semanticSubtype: IrClosureLowering,
  liftedFuncIdx?: number,
): IrClosureLowering {
  const carrier = allocateStandaloneDomCallbackCarrier(
    ctx,
    authority,
    semanticSubtype,
    allocationWrapper.structTypeIdx,
  );
  recordStandaloneDomCallbackLiftedFunc(ctx, authority, carrier, liftedFuncIdx);
  return carrier.lowering;
}

/**
 * Resolve the unique nominal child used by the direct front end. Its parent is
 * the exact semantic allocation type so the already-built lifted capture
 * downcast remains valid.
 */
export function resolveStandaloneDomCallbackDirectCarrier(
  ctx: CodegenContext,
  node: ts.ArrowFunction | ts.FunctionExpression,
  semanticAllocation: IrClosureLowering,
  liftedFuncIdx: number,
): IrClosureLowering | undefined {
  const authority = standaloneDomCallbackAuthorityForNode(ctx, node);
  if (!authority) return undefined;
  const carrier = allocateStandaloneDomCallbackCarrier(
    ctx,
    authority,
    semanticAllocation,
    semanticAllocation.structTypeIdx,
  );
  recordStandaloneDomCallbackLiftedFunc(ctx, authority, carrier, liftedFuncIdx);
  return carrier.lowering;
}

interface StandaloneDomCallbackDirectClosureInput {
  readonly structTypeIdx: number;
  readonly liftedFuncTypeIdx: number;
  readonly closureReturnType: ValType | null;
  readonly arrowParams: ValType[];
  readonly inlineBody?: Instr[];
  readonly liftedFuncIdx: number;
  readonly baseConstruction?: { allocTypeIdx: number; init: Instr[] };
}

/** Register the semantic closure layout, then specialize only a certified DOM callback allocation. */
export function registerStandaloneDomCallbackDirectClosure(
  ctx: CodegenContext,
  node: ts.ArrowFunction | ts.FunctionExpression,
  input: StandaloneDomCallbackDirectClosureInput,
): { allocTypeIdx: number; init: Instr[] } | undefined {
  registerClosureBindingInfo(
    ctx,
    node,
    input.structTypeIdx,
    input.liftedFuncTypeIdx,
    input.closureReturnType,
    input.arrowParams,
    input.inlineBody,
  );
  const semanticAllocationTypeIdx = input.baseConstruction?.allocTypeIdx ?? input.structTypeIdx;
  const carrier = resolveStandaloneDomCallbackDirectCarrier(
    ctx,
    node,
    {
      structTypeIdx: semanticAllocationTypeIdx,
      funcFieldIdx: 0,
      capFieldIdx: (index: number) => CLOSURE_CAPTURE_FIELD_BASE + index,
      funcTypeIdx: input.liftedFuncTypeIdx,
    },
    input.liftedFuncIdx,
  );
  if (!carrier) return input.baseConstruction;
  return {
    allocTypeIdx: carrier.structTypeIdx,
    init: [
      ...(input.baseConstruction?.init ?? []),
      { op: "global.get", index: carrier.domCallbackAuthorityGlobalIdx!() },
    ],
  };
}

/** Finalize the exact fail-closed dispatcher after every certified carrier exists. */
export function materializeStandaloneDomCallbackDispatch(ctx: CodegenContext): WasmFunction {
  const reservation = standaloneDomCallbackReservations.get(ctx);
  if (!reservation || definedFuncHandleOf(ctx, reservation.dispatcher) === undefined) {
    throw new Error("standalone DOM callback dispatcher was not reserved before component sealing");
  }
  if (reservation.materialized) return reservation.dispatcher;
  const body: Instr[] = [{ op: "local.get", index: 0 }, { op: "any.convert_extern" }, { op: "local.set", index: 1 }];
  const observedFunctions = new Set<WasmFunction>();
  for (const [key] of reservation.expectedByKey) {
    const carrier = reservation.carriersByKey.get(key);
    const liftedFuncIdx = carrier?.liftedFunc ? definedFuncHandleOf(ctx, carrier.liftedFunc) : undefined;
    if (!carrier?.liftedFunc || liftedFuncIdx === undefined) {
      throw new Error(`standalone DOM callback authority ${key} has no exact allocated carrier/function pair`);
    }
    if (observedFunctions.has(carrier.liftedFunc)) {
      throw new Error(`standalone DOM callback authority ${key} reused another plan's lifted function`);
    }
    observedFunctions.add(carrier.liftedFunc);
    const typeIdx = carrier.lowering.structTypeIdx;
    body.push(
      { op: "local.get", index: 1 },
      { op: "ref.test", typeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: carrier.authorityFieldIdx },
          { op: "global.get", index: standaloneDomCallbackAuthorityGlobalIdx(ctx, carrier.authorityBrandGlobal) },
          { op: "ref.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx },
              { op: "call", funcIdx: liftedFuncIdx },
              { op: "return" },
            ],
            else: [],
          },
        ],
        else: [],
      },
    );
  }
  body.push({ op: "unreachable" });
  reservation.dispatcher.body = body;
  reservation.materialized = true;
  return reservation.dispatcher;
}
