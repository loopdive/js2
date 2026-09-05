// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { definedFuncAt } from "../codegen/func-space.js";
import type { ProgramAbiSourceCallableRegistry } from "../codegen/program-abi-source-callable-planning.js";
import type { ProgramAbiSession } from "../codegen/program-abi-session.js";
import type { CodegenContext } from "../codegen/context/types.js";
import { irCallableBindingKey, irUnitCallableBindingId } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId, IrUnitInventory } from "./identity.js";
import type { IrLoweredSignature } from "./lower.js";
import { IrInvariantError } from "./outcomes.js";
import type { PreparedComponentClosureSupportEvidence } from "./prepared-instruction-support.js";
import { forEachInstrDeep, type IrFunction, type IrType, type IrValueId } from "./nodes.js";
import type { FuncHandle, FuncTypeDef, ValType, WasmFunction } from "./types.js";

/** The semantic source signature that a boundary candidate is expected to own. */
export interface PreparedCallableBoundarySemanticSignature {
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
}

/** The scoped lookup needed to reconcile one prepared source callable. */
export interface PreparedCallableBoundaryScopeLookup {
  readonly locatorObject: (id: IrBindingId) => object | undefined;
  readonly currentCallableContract: (
    id: IrBindingId,
  ) => { readonly params: readonly ValType[]; readonly results: readonly ValType[] } | undefined;
  readonly resolveCurrentIndex: (id: IrBindingId, expectedSpace: "function", structuralReferenceKey: string) => number;
}

/** Final authenticated evidence retained by an admitted callable boundary. */
export interface PreparedCallableBoundaryContract {
  readonly unitId: IrUnitId;
  readonly bindingId: IrBindingId;
  readonly handle: FuncHandle;
  readonly allocated: WasmFunction;
  readonly allocatedSignature: FuncTypeDef;
  readonly semanticSignature: PreparedCallableBoundarySemanticSignature;
  readonly projectedSignature: FuncTypeDef;
  readonly supportBindingIds: readonly IrBindingId[];
  /** Re-check allocator/session identity immediately before body publication. */
  readonly assertCurrent: () => void;
  /** Re-check the exact final support evidence before body publication. */
  readonly assertSupportCurrent: (fn: IrFunction, support: PreparedComponentClosureSupportEvidence) => void;
}

export interface PreparedCallableBoundaryCandidate {
  readonly unitId: IrUnitId;
  readonly bindingId: IrBindingId;
  readonly handle: FuncHandle;
  readonly allocated: WasmFunction;
  readonly allocatedSignature: FuncTypeDef;
  readonly semanticSignature: PreparedCallableBoundarySemanticSignature;
  readonly certify: (input: {
    readonly fn: IrFunction;
    readonly projectedSignature: IrLoweredSignature<ValType>;
    readonly support: PreparedComponentClosureSupportEvidence;
    readonly scopeLookup?: PreparedCallableBoundaryScopeLookup;
  }) => PreparedCallableBoundaryContract | undefined;
  readonly assertCurrent: () => void;
  readonly assertSupportCurrent: (fn: IrFunction, support: PreparedComponentClosureSupportEvidence) => void;
  readonly contract: PreparedCallableBoundaryContract | undefined;
}

interface CandidateState {
  readonly registry: ProgramAbiSourceCallableRegistry;
  readonly session: ProgramAbiSession;
  readonly inventory: IrUnitInventory;
  readonly ctx: CodegenContext;
  readonly unitId: IrUnitId;
  readonly bindingId: IrBindingId;
  readonly structuralReferenceKey: string;
  readonly handle: FuncHandle;
  readonly allocated: WasmFunction;
  readonly allocatedSignature: FuncTypeDef;
  readonly semanticSignature: PreparedCallableBoundarySemanticSignature;
  contract?: PreparedCallableBoundaryContract;
}

const candidateStates = new WeakMap<object, CandidateState>();

function invariant(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "resolve", detail);
}

function freezeValType(type: ValType): ValType {
  return Object.freeze({ ...type }) as ValType;
}

function freezeFuncType(type: FuncTypeDef): FuncTypeDef {
  return Object.freeze({
    kind: "func" as const,
    ...(type.name === undefined ? {} : { name: type.name }),
    params: Object.freeze(type.params.map(freezeValType)),
    results: Object.freeze(type.results.map(freezeValType)),
  }) as unknown as FuncTypeDef;
}

function sameValType(left: ValType, right: ValType): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "ref" || left.kind === "ref_null") {
    return right.kind === left.kind && right.typeIdx === left.typeIdx;
  }
  if (left.kind === "i32")
    return right.kind === "i32" && left.boolean === right.boolean && left.symbol === right.symbol;
  if (left.kind === "f64") return right.kind === "f64" && left.undefSentinel === right.undefSentinel;
  if (left.kind === "i64") return right.kind === "i64" && left.bigint === right.bigint;
  return true;
}

function sameFuncType(left: FuncTypeDef, right: FuncTypeDef): boolean {
  return (
    left.params.length === right.params.length &&
    left.results.length === right.results.length &&
    left.params.every((type, index) => sameValType(type, right.params[index]!)) &&
    left.results.every((type, index) => sameValType(type, right.results[index]!))
  );
}

function semanticTypeKey(type: IrType | null): string {
  if (type === null) return "null";
  switch (type.kind) {
    case "val":
      return JSON.stringify({ kind: type.kind, val: type.val, signed: type.signed });
    case "string":
      return JSON.stringify({ kind: type.kind });
    case "vec":
      return JSON.stringify({ kind: type.kind, nullable: type.nullable, element: semanticTypeKey(type.elementType) });
    case "object":
      return JSON.stringify({
        kind: type.kind,
        fields: type.shape.fields.map((field) => ({ name: field.name, type: semanticTypeKey(field.type) })),
      });
    case "closure":
    case "callable":
      return JSON.stringify({
        kind: type.kind,
        params: type.signature.params.map((param) => semanticTypeKey(param)),
        returnType: semanticTypeKey(type.signature.returnType),
        defaultParamStart: type.signature.defaultParamStart,
      });
    case "class":
      return JSON.stringify({ kind: type.kind, classId: type.shape.classId });
    case "extern":
      return JSON.stringify({ kind: type.kind, className: type.className });
    case "dynamic":
      return JSON.stringify({ kind: type.kind });
    case "boxed":
      return JSON.stringify({ kind: type.kind, inner: semanticTypeKey(type.inner) });
    case "union":
      return JSON.stringify({ kind: type.kind, members: type.members.map((member) => semanticTypeKey(member)) });
    case "fnctor":
      return JSON.stringify({ kind: type.kind, constructorName: type.shape.constructorName });
  }
}

function sameSemanticSignature(left: PreparedCallableBoundarySemanticSignature, fn: IrFunction): boolean {
  return (
    left.params.length === fn.params.length &&
    left.params.every((type, index) => semanticTypeKey(type) === semanticTypeKey(fn.params[index]?.type ?? null)) &&
    semanticTypeKey(left.returnType) ===
      semanticTypeKey(fn.resultTypes.length === 0 ? null : fn.resultTypes.length === 1 ? fn.resultTypes[0]! : null)
  );
}

function flattenProjectedSignature(projected: IrLoweredSignature<ValType>): FuncTypeDef {
  return Object.freeze({
    kind: "func" as const,
    params: Object.freeze(projected.params.flatMap((param) => [...param.slots])),
    results: Object.freeze(projected.results.flatMap((slots) => [...slots])),
  }) as unknown as FuncTypeDef;
}

function collectCallableTypes(type: IrType, out: Set<IrType>): void {
  if (out.has(type)) return;
  out.add(type);
  switch (type.kind) {
    case "callable":
    case "closure":
      for (const param of type.signature.params) collectCallableTypes(param, out);
      if (type.signature.returnType) collectCallableTypes(type.signature.returnType, out);
      return;
    case "vec":
      collectCallableTypes(type.elementType, out);
      return;
    case "object":
      for (const field of type.shape.fields) collectCallableTypes(field.type, out);
      return;
    case "boxed":
      collectCallableTypes(type.inner, out);
      return;
    case "union":
      for (const member of type.members) collectCallableTypes(member, out);
      return;
    case "val":
    case "string":
    case "class":
    case "extern":
    case "dynamic":
    case "fnctor":
      return;
  }
}

function supportBindingIds(
  fn: IrFunction,
  support: PreparedComponentClosureSupportEvidence,
): { readonly complete: boolean; readonly bindingIds: readonly IrBindingId[] } {
  const refs = new Map<IrBindingId, true>();
  let missingInvocationSupport = false;
  const callableTypes = new Set<IrType>();
  for (const param of fn.params) collectCallableTypes(param.type, callableTypes);
  for (const result of fn.resultTypes) collectCallableTypes(result, callableTypes);
  for (const type of callableTypes) {
    if (type.kind !== "callable") continue;
    const typeRefs = support.typeRefs.get(type);
    if (typeRefs === undefined) return { complete: false, bindingIds: [] };
    for (const ref of typeRefs) refs.set(ref.binding.bindingId, true);
  }

  const valueTypes = new Map<IrValueId, IrType>(fn.params.map((param) => [param.value, param.type] as const));
  for (const block of fn.blocks) {
    for (const type of block.blockArgTypes) collectCallableTypes(type, callableTypes);
    for (const root of block.instrs) {
      forEachInstrDeep(root, (instr) => {
        if (instr.result !== null && instr.resultType !== null) {
          valueTypes.set(instr.result, instr.resultType);
          collectCallableTypes(instr.resultType, callableTypes);
        }
        if (instr.kind === "closure.call") {
          const calleeType = valueTypes.get(instr.callee);
          if (calleeType?.kind !== "callable") return;
          const instructionRefs = support.instructionRefs.get(instr);
          // Callable carrier proof may be empty; invocation support may not.
          if (!instructionRefs || instructionRefs.length === 0) {
            missingInvocationSupport = true;
            return;
          }
          for (const ref of instructionRefs) refs.set(ref.binding.bindingId, true);
        }
      });
    }
  }
  for (const type of callableTypes) {
    if (type.kind !== "callable") continue;
    if (!support.typeRefs.has(type)) return { complete: false, bindingIds: [] };
  }
  if (missingInvocationSupport) return { complete: false, bindingIds: [] };
  const bindingIds = Object.freeze([...refs.keys()].sort());
  return { complete: true, bindingIds };
}

function assertScopedLookup(state: CandidateState, lookup: PreparedCallableBoundaryScopeLookup): void {
  if (lookup.locatorObject(state.bindingId) !== state.allocated) {
    invariant(`prepared callable boundary ${state.unitId} lost its scoped allocator locator`);
  }
  const scoped = lookup.currentCallableContract(state.bindingId);
  if (scoped === undefined) {
    invariant(`prepared callable boundary ${state.unitId} has no scoped callable contract`);
  }
  if (
    !scoped ||
    scoped.params.length !== state.allocatedSignature.params.length ||
    scoped.results.length !== state.allocatedSignature.results.length ||
    scoped.params.some((type, index) => !sameValType(type, state.allocatedSignature.params[index]!)) ||
    scoped.results.some((type, index) => !sameValType(type, state.allocatedSignature.results[index]!))
  ) {
    invariant(`prepared callable boundary ${state.unitId} has a changed scoped callable signature`);
  }
  try {
    lookup.resolveCurrentIndex(state.bindingId, "function", state.structuralReferenceKey);
  } catch (error) {
    invariant(`prepared callable boundary ${state.unitId} has no current scoped ABI index: ${String(error)}`);
  }
}

function assertAllocatorCurrent(state: CandidateState): void {
  state.session.assertModule(state.ctx.mod);
  if (state.session.inventory !== state.inventory || state.registry.identityContext?.inventory !== state.inventory) {
    invariant(`prepared callable boundary ${state.unitId} was issued against a foreign ABI inventory`);
  }
  const handle = state.registry.handleForUnit(state.unitId);
  const current = state.registry.functionForUnit(state.unitId);
  if (
    handle !== state.handle ||
    current !== state.allocated ||
    definedFuncAt(state.ctx, state.handle) !== state.allocated
  ) {
    invariant(`prepared callable boundary ${state.unitId} no longer owns its exact allocator object`);
  }
  const type = state.ctx.mod.types[state.allocated.typeIdx];
  if (!type || type.kind !== "func" || !sameFuncType(type, state.allocatedSignature)) {
    invariant(`prepared callable boundary ${state.unitId} allocator signature changed after issuance`);
  }
  if (!state.session.hasPlan(state.bindingId) || !state.session.hasLocator(state.bindingId, state.allocated)) {
    invariant(`prepared callable boundary ${state.unitId} lost its exact Program ABI locator`);
  }
}

function makeContract(
  state: CandidateState,
  projectedSignature: FuncTypeDef,
  supportIds: readonly IrBindingId[],
): PreparedCallableBoundaryContract {
  const contract: PreparedCallableBoundaryContract = Object.freeze({
    unitId: state.unitId,
    bindingId: state.bindingId,
    handle: state.handle,
    allocated: state.allocated,
    allocatedSignature: state.allocatedSignature,
    semanticSignature: state.semanticSignature,
    projectedSignature,
    supportBindingIds: Object.freeze([...supportIds]),
    assertCurrent: () => assertAllocatorCurrent(state),
    assertSupportCurrent: (fn: IrFunction, support: PreparedComponentClosureSupportEvidence) => {
      assertAllocatorCurrent(state);
      const current = supportBindingIds(fn, support);
      if (
        !current.complete ||
        current.bindingIds.length !== supportIds.length ||
        current.bindingIds.some((id, index) => id !== supportIds[index])
      ) {
        invariant(`prepared callable boundary ${state.unitId} support evidence changed after certification`);
      }
    },
  });
  return contract;
}

/** Issue one authenticated source callable boundary candidate. */
export function issuePreparedCallableBoundary(input: {
  readonly registry: ProgramAbiSourceCallableRegistry;
  readonly unitId: IrUnitId;
  readonly semanticSignature: PreparedCallableBoundarySemanticSignature;
}): PreparedCallableBoundaryCandidate | undefined {
  const { registry, unitId, semanticSignature } = input;
  const session = registry.session;
  const identityContext = registry.identityContext;
  if (!session || !identityContext) return undefined;
  session.assertModule(registry.ctx.mod);
  if (identityContext.inventory !== session.inventory) {
    invariant(`prepared callable boundary ${unitId} has a foreign source/inventory context`);
  }
  if (!identityContext.unitByUnitId.has(unitId)) {
    invariant(`prepared callable boundary ${unitId} is outside the source inventory`);
  }
  registry.planUnits([unitId]);
  const handle = registry.handleForUnit(unitId);
  const allocated = registry.functionForUnit(unitId);
  if (handle === undefined || !allocated || definedFuncAt(registry.ctx, handle) !== allocated) {
    invariant(`prepared callable boundary ${unitId} has no exact live allocator observation`);
  }
  const signature = registry.ctx.mod.types[allocated.typeIdx];
  if (!signature || signature.kind !== "func") {
    invariant(`prepared callable boundary ${unitId} has no function allocator signature`);
  }
  const bindingId = irUnitCallableBindingId(unitId);
  if (!session.hasPlan(bindingId) || !session.hasLocator(bindingId, allocated)) {
    invariant(`prepared callable boundary ${unitId} was not attached to its source ABI binding`);
  }
  const state: CandidateState = {
    registry,
    session,
    inventory: identityContext.inventory,
    ctx: registry.ctx,
    unitId,
    bindingId,
    structuralReferenceKey: irCallableBindingKey({ kind: "unit", unitId }),
    handle,
    allocated,
    allocatedSignature: freezeFuncType(signature),
    semanticSignature: Object.freeze({
      params: Object.freeze([...semanticSignature.params]),
      returnType: semanticSignature.returnType,
    }),
  };
  const certify: PreparedCallableBoundaryCandidate["certify"] = ({ fn, projectedSignature, support, scopeLookup }) => {
    assertAllocatorCurrent(state);
    if (fn.unitId !== unitId) invariant(`prepared callable boundary ${unitId} received a foreign IR function`);
    if (scopeLookup) assertScopedLookup(state, scopeLookup);
    if (!sameSemanticSignature(state.semanticSignature, fn)) return undefined;
    const projected = flattenProjectedSignature(projectedSignature);
    if (!sameFuncType(projected, state.allocatedSignature)) return undefined;
    const evidence = supportBindingIds(fn, support);
    if (!evidence.complete) return undefined;
    const contract = makeContract(state, projected, evidence.bindingIds);
    if (state.contract && state.contract.projectedSignature !== contract.projectedSignature) {
      invariant(`prepared callable boundary ${unitId} was certified with contradictory signatures`);
    }
    state.contract = contract;
    return contract;
  };
  const candidate: PreparedCallableBoundaryCandidate = Object.freeze({
    unitId,
    bindingId,
    handle,
    allocated,
    allocatedSignature: state.allocatedSignature,
    semanticSignature: state.semanticSignature,
    certify,
    assertCurrent: () => {
      assertAllocatorCurrent(state);
      if (state.contract) state.contract.assertCurrent();
    },
    assertSupportCurrent: (fn: IrFunction, support: PreparedComponentClosureSupportEvidence) => {
      if (!state.contract) invariant(`prepared callable boundary ${unitId} was used before certification`);
      state.contract.assertSupportCurrent(fn, support);
    },
    get contract() {
      return state.contract;
    },
  });
  candidateStates.set(candidate, state);
  return candidate;
}

export function isPreparedCallableBoundaryCandidate(value: unknown): value is PreparedCallableBoundaryCandidate {
  return typeof value === "object" && value !== null && candidateStates.has(value);
}

export function assertPreparedCallableBoundaryCandidate(
  value: unknown,
): asserts value is PreparedCallableBoundaryCandidate {
  if (!isPreparedCallableBoundaryCandidate(value)) {
    invariant("prepared callable boundary candidate is not an authenticated registry-issued receipt");
  }
}
