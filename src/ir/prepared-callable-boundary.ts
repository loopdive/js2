// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey, irUnitCallableBindingId } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId, IrUnitInventory } from "./identity.js";
import type { IrLoweredSignature } from "./lower.js";
import { IrInvariantError } from "./outcomes.js";
import type { PreparedComponentClosureSupportEvidence } from "./prepared-instruction-support.js";
import { forEachInstrDeep, irTypeEquals, type IrFunction, type IrType, type IrValueId } from "./nodes.js";
import { irTypeKey } from "./type-key.js";
import type { FuncHandle, FuncTypeDef, ValType, WasmFunction, WasmModule } from "./types.js";

/** The semantic source signature that a boundary candidate is expected to own. */
export interface PreparedCallableBoundarySemanticSignature {
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
}

/** Codegen-owned observations needed to issue one IR-only boundary receipt. */
export interface PreparedCallableBoundaryIssueInput {
  readonly unitId: IrUnitId;
  readonly semanticSignature: PreparedCallableBoundarySemanticSignature;
  readonly inventory: IrUnitInventory;
  readonly module: WasmModule;
  readonly hasUnit: (id: IrUnitId) => boolean;
  readonly assertModule: () => void;
  readonly inventoryIsCurrent: () => boolean;
  readonly planUnit: () => void;
  readonly handleForUnit: (id: IrUnitId) => FuncHandle | undefined;
  readonly functionForUnit: (id: IrUnitId) => WasmFunction | undefined;
  readonly definedFunctionAt: (handle: FuncHandle) => WasmFunction | undefined;
  readonly hasPlan: (id: IrBindingId) => boolean;
  readonly hasLocator: (id: IrBindingId, allocatorObject: object) => boolean;
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
  readonly assertCurrent: (fn?: IrFunction) => void;
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
  readonly assertCurrent: (fn?: IrFunction) => void;
  readonly assertSupportCurrent: (fn: IrFunction, support: PreparedComponentClosureSupportEvidence) => void;
  readonly contract: PreparedCallableBoundaryContract | undefined;
}

interface CandidateState {
  readonly inventory: IrUnitInventory;
  readonly module: WasmModule;
  readonly assertModule: () => void;
  readonly inventoryIsCurrent: () => boolean;
  readonly handleForUnit: (id: IrUnitId) => FuncHandle | undefined;
  readonly functionForUnit: (id: IrUnitId) => WasmFunction | undefined;
  readonly definedFunctionAt: (handle: FuncHandle) => WasmFunction | undefined;
  readonly hasPlan: (id: IrBindingId) => boolean;
  readonly hasLocator: (id: IrBindingId, allocatorObject: object) => boolean;
  readonly unitId: IrUnitId;
  readonly bindingId: IrBindingId;
  readonly structuralReferenceKey: string;
  readonly handle: FuncHandle;
  readonly allocated: WasmFunction;
  readonly allocatedSignature: FuncTypeDef;
  readonly semanticSignature: PreparedCallableBoundarySemanticSignature;
  readonly semanticSignatureKey: string;
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

function cloneSemanticValue(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneSemanticValue(item, seen));
    return copy;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = cloneSemanticValue(item, seen);
  return copy;
}

function freezeSemanticValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value)) freezeSemanticValue(item, seen);
  return Object.freeze(value);
}

function snapshotSemanticSignature(
  signature: PreparedCallableBoundarySemanticSignature,
): PreparedCallableBoundarySemanticSignature {
  return freezeSemanticValue(
    cloneSemanticValue({ params: signature.params, returnType: signature.returnType }),
  ) as PreparedCallableBoundarySemanticSignature;
}

/**
 * Record the ValType brands nested in one semantic signature.
 *
 * `irTypeKey` is authoritative for the structural type shape but deliberately
 * describes storage-equivalent values, so it omits `i32.boolean`, `i32.symbol`,
 * `i64.bigint`, and `f64.undefSentinel`.  Keep its recursive handling for all
 * other IR semantics and add this narrow supplementary walk for the brands.
 * Physical attachments such as `typeRef`, `carrierRef`, and `layout` are
 * intentionally not part of this fingerprint; they are checked through the
 * separate prepared ABI evidence.
 */
function semanticValTypeBrandKey(signature: PreparedCallableBoundarySemanticSignature): string {
  const brands: string[] = [];
  const active = new Set<object>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (active.has(value)) throw new Error("IR semantic receipt cannot encode a recursive layout");
    active.add(value);
    try {
      if (!Array.isArray(value)) {
        const candidate = value as { readonly kind?: unknown; readonly val?: unknown };
        if (candidate.kind === "val" && candidate.val !== null && typeof candidate.val === "object") {
          const val = candidate.val as ValType;
          if (val.kind === "i32")
            brands.push(`i32:${val.boolean === true ? "boolean" : ""}:${val.symbol === true ? "symbol" : ""}`);
          if (val.kind === "i64") brands.push(`i64:${val.bigint === true ? "bigint" : ""}`);
          if (val.kind === "f64") brands.push(`f64:${val.undefSentinel === true ? "undefSentinel" : ""}`);
        }
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
      } else {
        for (const [, item] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) visit(item);
      }
    } finally {
      active.delete(value);
    }
  };
  visit(signature.params);
  visit(signature.returnType);
  return brands.join("|");
}

function semanticSignatureKey(signature: PreparedCallableBoundarySemanticSignature): string | undefined {
  try {
    return JSON.stringify({
      params: signature.params.map((type) => irTypeKey(type)),
      returnType: signature.returnType === null ? null : irTypeKey(signature.returnType),
      valTypeBrands: semanticValTypeBrandKey(signature),
    });
  } catch {
    // Recursive anonymous layouts have no canonical key.  They cannot cross
    // this source ABI boundary until a producer supplies a stable identity.
    return undefined;
  }
}

function sameSemanticSignature(
  left: PreparedCallableBoundarySemanticSignature,
  leftKey: string,
  fn: IrFunction,
): boolean {
  // The boundary contract carries at most one semantic result.  Treat a
  // multi-result IR function as unsupported explicitly; otherwise its
  // collapsed `null` sentinel could masquerade as a genuine void signature.
  if (fn.resultTypes.length > 1) return false;
  const currentReturnType =
    fn.resultTypes.length === 0 ? null : fn.resultTypes.length === 1 ? fn.resultTypes[0]! : null;
  const current: PreparedCallableBoundarySemanticSignature = {
    params: fn.params.map((param) => param.type),
    returnType: currentReturnType,
  };
  return (
    semanticSignatureKey(current) === leftKey &&
    left.params.length === current.params.length &&
    left.params.every((type, index) => irTypeEquals(type, current.params[index]!)) &&
    (left.returnType === null || current.returnType === null
      ? left.returnType === current.returnType
      : irTypeEquals(left.returnType, current.returnType))
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
  state.assertModule();
  if (!state.inventoryIsCurrent()) {
    invariant(`prepared callable boundary ${state.unitId} was issued against a foreign ABI inventory`);
  }
  const handle = state.handleForUnit(state.unitId);
  const current = state.functionForUnit(state.unitId);
  if (
    handle !== state.handle ||
    current !== state.allocated ||
    state.definedFunctionAt(state.handle) !== state.allocated
  ) {
    invariant(`prepared callable boundary ${state.unitId} no longer owns its exact allocator object`);
  }
  const type = state.module.types[state.allocated.typeIdx];
  if (!type || type.kind !== "func" || !sameFuncType(type, state.allocatedSignature)) {
    invariant(`prepared callable boundary ${state.unitId} allocator signature changed after issuance`);
  }
  if (!state.hasPlan(state.bindingId) || !state.hasLocator(state.bindingId, state.allocated)) {
    invariant(`prepared callable boundary ${state.unitId} lost its exact Program ABI locator`);
  }
}

function assertSemanticCurrent(state: CandidateState, fn: IrFunction): void {
  if (fn.unitId !== state.unitId || !sameSemanticSignature(state.semanticSignature, state.semanticSignatureKey, fn)) {
    invariant(`prepared callable boundary ${state.unitId} semantic signature changed after issuance`);
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
    assertCurrent: (fn?: IrFunction) => {
      assertAllocatorCurrent(state);
      if (fn) assertSemanticCurrent(state, fn);
    },
    assertSupportCurrent: (fn: IrFunction, support: PreparedComponentClosureSupportEvidence) => {
      assertAllocatorCurrent(state);
      assertSemanticCurrent(state, fn);
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
export function issuePreparedCallableBoundary(
  input: PreparedCallableBoundaryIssueInput,
): PreparedCallableBoundaryCandidate | undefined {
  const { unitId, semanticSignature } = input;
  input.assertModule();
  if (!input.inventoryIsCurrent()) {
    invariant(`prepared callable boundary ${unitId} has a foreign source/inventory context`);
  }
  if (!input.hasUnit(unitId)) {
    invariant(`prepared callable boundary ${unitId} is outside the source inventory`);
  }
  const immutableSemanticSignature = snapshotSemanticSignature(semanticSignature);
  const immutableSemanticSignatureKey = semanticSignatureKey(immutableSemanticSignature);
  if (immutableSemanticSignatureKey === undefined) return undefined;
  input.planUnit();
  const handle = input.handleForUnit(unitId);
  const allocated = input.functionForUnit(unitId);
  if (handle === undefined || !allocated || input.definedFunctionAt(handle) !== allocated) {
    invariant(`prepared callable boundary ${unitId} has no exact live allocator observation`);
  }
  const signature = input.module.types[allocated.typeIdx];
  if (!signature || signature.kind !== "func") {
    invariant(`prepared callable boundary ${unitId} has no function allocator signature`);
  }
  const bindingId = irUnitCallableBindingId(unitId);
  if (!input.hasPlan(bindingId) || !input.hasLocator(bindingId, allocated)) {
    invariant(`prepared callable boundary ${unitId} was not attached to its source ABI binding`);
  }
  const state: CandidateState = {
    inventory: input.inventory,
    module: input.module,
    assertModule: input.assertModule,
    inventoryIsCurrent: input.inventoryIsCurrent,
    handleForUnit: input.handleForUnit,
    functionForUnit: input.functionForUnit,
    definedFunctionAt: input.definedFunctionAt,
    hasPlan: input.hasPlan,
    hasLocator: input.hasLocator,
    unitId,
    bindingId,
    structuralReferenceKey: irCallableBindingKey({ kind: "unit", unitId }),
    handle,
    allocated,
    allocatedSignature: freezeFuncType(signature),
    semanticSignature: immutableSemanticSignature,
    semanticSignatureKey: immutableSemanticSignatureKey,
  };
  const certify: PreparedCallableBoundaryCandidate["certify"] = ({ fn, projectedSignature, support, scopeLookup }) => {
    assertAllocatorCurrent(state);
    if (fn.unitId !== unitId) invariant(`prepared callable boundary ${unitId} received a foreign IR function`);
    if (scopeLookup) assertScopedLookup(state, scopeLookup);
    if (!sameSemanticSignature(state.semanticSignature, state.semanticSignatureKey, fn)) return undefined;
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
    assertCurrent: (fn?: IrFunction) => {
      assertAllocatorCurrent(state);
      if (fn) assertSemanticCurrent(state, fn);
      if (state.contract) state.contract.assertCurrent(fn);
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
