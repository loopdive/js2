// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey } from "../ir/abi-bindings.js";
import { irCallableBindingKey, irSupportFuncRef, irUnitCallableBindingId } from "../ir/callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrClassId, type IrSourceId, type IrUnitId } from "../ir/identity.js";
import type { IrFuncRef, IrGlobalRef } from "../ir/nodes.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncHandle, FuncTypeDef, GlobalDef, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncHandleOf } from "./func-space.js";
import {
  canonicalProgramAbiCallableTypeContract,
  canonicalProgramAbiValType,
  cloneProgramAbiCallableTypeContract,
} from "./program-abi-signatures.js";

export const PROGRAM_ABI_CALLABLE_ROLE = Object.freeze({
  body: 0,
  functionValueTrampoline: 1,
  classMethodAdapter: 3,
  classHostConstructor: 4,
  moduleInit: 5,
  retainedModuleFunction: 6,
  typedThisTwin: 7,
  vecHostBridge: 8,
  closureHostBridge: 9,
  dateCivilSupport: 10,
  dataStructHostBridge: 11,
  // (#4033) Callable providers (`runtime-provider` / `intrinsic-provider`) used
  // a bare `PROGRAM_ABI_PROVIDER_ROLE_ORDINAL = 5` literal in
  // program-abi-provider-planning.ts, duplicating `moduleInit: 5` above.
  // Nothing tied the two together, so nothing kept them distinct: a provider
  // and a `legacy-module-init-pass` support callable anchored to the same entry
  // source both landed on structural order `<src>:0:0:5:0` and the session's
  // duplicate-order check aborted the compile. Every role ordinal now lives in
  // this one table, and `programAbiCallableRoleOrdinalsAreDistinct()` below is
  // the guard that keeps it that way.
  callableProvider: 12,
  classConstructorNew: 13,
} as const);

/**
 * (#4033) True iff every role in {@link PROGRAM_ABI_CALLABLE_ROLE} has a unique
 * ordinal. Structural order is `(source, declaration, domain, role, derived)`,
 * so two roles sharing an ordinal are indistinguishable whenever their other
 * components coincide — which is exactly how #4033 aborted the ESLint compile.
 * Exported so a test can assert it directly rather than waiting for a graph
 * large enough to collide.
 */
export function programAbiCallableRoleOrdinalsAreDistinct(): boolean {
  const ordinals = Object.values(PROGRAM_ABI_CALLABLE_ROLE);
  return new Set(ordinals).size === ordinals.length;
}

export const PROGRAM_ABI_GLOBAL_ROLE = Object.freeze({
  moduleValue: 0,
  moduleTdz: 1,
  functionValueCache: 2,
  argc: 3,
} as const);

export type ProgramAbiGlobalAnchor =
  | { readonly kind: "source"; readonly sourceId: IrSourceId }
  | { readonly kind: "unit"; readonly unitId: IrUnitId };

export interface ProgramAbiGlobalPlan {
  readonly ref: IrGlobalRef;
  readonly anchor: ProgramAbiGlobalAnchor;
  /** Exact terminal owner of source storage when the binding ID is source-owned. */
  readonly storageOwnerUnitId?: IrUnitId;
  readonly roleOrdinal: number;
  readonly derivedOrdinal?: number;
  readonly global: GlobalDef;
}

export interface ProgramAbiUnitCallablePlan {
  readonly ref: IrFuncRef;
  readonly signature: FuncTypeDef;
  readonly func: WasmFunction;
}

export type ProgramAbiSupportCallableAnchor =
  | { readonly kind: "unit"; readonly unitId: IrUnitId }
  | { readonly kind: "class"; readonly classId: IrClassId }
  | { readonly kind: "source"; readonly sourceId: IrSourceId };

interface ProgramAbiSupportCallablePlanBase {
  readonly ref: IrFuncRef;
  readonly anchor: ProgramAbiSupportCallableAnchor;
  readonly role: string;
  readonly roleOrdinal: number;
  readonly derivedOrdinal?: number;
  readonly signature: FuncTypeDef;
}

export interface ProgramAbiSupportCallablePlan extends ProgramAbiSupportCallablePlanBase {
  readonly func: WasmFunction;
}

export interface ProgramAbiSupportCallableAliasPlan extends ProgramAbiSupportCallablePlanBase {
  readonly derivedOrdinal: number;
  readonly aliasOf: IrBindingId;
}

export interface ProgramAbiFunctionValuePlan {
  readonly trampoline: IrFuncRef;
  readonly cacheGlobal: IrGlobalRef;
  readonly target: IrFuncRef;
}

export interface ProgramAbiEntrySourceSupportCallablePlan {
  readonly role: string;
  readonly roleOrdinal: number;
  readonly derivedOrdinal: number;
  readonly displayName: string;
  readonly func: WasmFunction;
}

function canonicalEntrySourceId(ctx: CodegenContext): IrSourceId {
  const session = ctx.programAbiSession;
  if (!session) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      "entry-source support callable planning requires an active Program ABI session",
    );
  }
  const entries = session.inventory.sources.filter((source) => source.kind === "entry");
  if (entries.length !== 1) {
    throw new ProgramAbiInvariantError(
      "unknown-order-anchor",
      `entry-source support callable planning requires exactly one canonical entry source, found ${entries.length}`,
    );
  }
  return entries[0]!.id;
}

/**
 * Give one already-allocated compiler support function an exact entry-source
 * owner before the retained-callable sweep can classify it generically.
 *
 * The allocator object, not its diagnostic label or current numeric index,
 * owns the slot. Callers can therefore resolve the same binding after late
 * imports or dead-slot compaction through
 * {@link resolveProgramAbiSupportCallableHandle}.
 */
export function planProgramAbiEntrySourceSupportCallable(
  ctx: CodegenContext,
  plan: ProgramAbiEntrySourceSupportCallablePlan,
): IrFuncRef | undefined {
  const session = ctx.programAbiSession;
  if (!session) return undefined;
  const sourceId = canonicalEntrySourceId(ctx);
  const signature = ctx.mod.types[plan.func.typeIdx];
  if (!signature || signature.kind !== "func") {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `entry-source support callable ${plan.displayName} references non-function or missing type ${plan.func.typeIdx}`,
    );
  }
  const ref = irSupportFuncRef(sourceId, plan.role, plan.displayName, plan.derivedOrdinal);
  if (ref.binding.kind !== "support") {
    throw new ProgramAbiInvariantError(
      "invalid-binding-reference",
      `entry-source support callable ${plan.displayName} did not produce a support binding`,
    );
  }
  const expectedBindingId = ref.binding.bindingId;
  const bindingId = planProgramAbiSupportCallable(ctx, {
    ref,
    anchor: { kind: "source", sourceId },
    role: plan.role,
    roleOrdinal: plan.roleOrdinal,
    derivedOrdinal: plan.derivedOrdinal,
    signature,
    func: plan.func,
  });
  if (bindingId !== expectedBindingId) {
    throw new ProgramAbiInvariantError(
      "invalid-binding-reference",
      `entry-source support callable ${plan.displayName} was not accepted for ${expectedBindingId}`,
    );
  }
  return ref;
}

/**
 * Resolve an exact planned support allocator to its current function handle.
 *
 * This consults the Program ABI locator while tracking is active and validates
 * that the locator still owns the supplied function object. The untracked
 * compilation path falls back to the same allocator-object lookup so enabling
 * outcome tracking cannot change emitted bytes.
 */
export function resolveProgramAbiSupportCallableHandle(
  ctx: CodegenContext,
  ref: IrFuncRef | undefined,
  func: WasmFunction,
): FuncHandle | undefined {
  const session = ctx.programAbiSession;
  if (!session || !ref) return definedFuncHandleOf(ctx, func);
  if (ref.binding.kind !== "support" || !session.hasLocator(ref.binding.bindingId, func)) {
    throw new ProgramAbiInvariantError(
      "missing-required-locator",
      `support callable ${ref.name} is not owned by its exact Program ABI allocator object`,
    );
  }
  return session.resolveCurrentIndex(ref.binding.bindingId, "function", irCallableBindingKey(ref.binding));
}

/**
 * Plan and locate one exact unit-owned function body.
 *
 * The compatibility name is diagnostic only. Both the ABI identity and the
 * resolver payload derive from the structural unit ID, while the signature
 * preserves every ValType index and semantic brand used by function typing.
 */
export function planProgramAbiUnitCallable(
  ctx: CodegenContext,
  plan: ProgramAbiUnitCallablePlan,
): IrBindingId | undefined {
  const session = ctx.programAbiSession;
  if (!session) return undefined;
  if (plan.ref.binding.kind !== "unit") {
    throw new TypeError("program ABI unit callable planning requires an exact unit reference");
  }
  const unitId = plan.ref.binding.unitId;
  if (!session.hasKnownUnit(unitId)) return undefined;
  const derived = session.registeredDerivedUnit(unitId);
  if (
    derived &&
    derived.role !== "lifted-closure" &&
    derived.role !== "ir-async-state" &&
    derived.role !== "monomorphization-clone"
  ) {
    return undefined;
  }
  const bindingId = irUnitCallableBindingId(unitId);
  const structuralReferenceKey = irCallableBindingKey(plan.ref.binding);
  const typeContract = cloneProgramAbiCallableTypeContract(plan.signature);
  session.ensurePlan({
    id: bindingId,
    structuralOrder: session.structuralOrder.forUnit(unitId, {
      domain: "callable",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.body,
    }),
    structuralReferenceKey,
    displayName: plan.func.name,
    slotPolicy: "required",
    slotSpace: "function",
    intent: {
      kind: "callable",
      origin: "source",
      unitId,
      signature: canonicalProgramAbiCallableTypeContract(typeContract),
    },
  });
  session.registerCallableTypeContract(bindingId, typeContract);
  session.registerStructuralReference(bindingId, structuralReferenceKey);
  if (!session.hasLocator(bindingId, plan.func)) {
    session.attachLocator(bindingId, { kind: "defined-function", value: plan.func });
  }
  return bindingId;
}

/**
 * Plan and locate one compiler-owned support callable beneath an exact
 * inventoried unit, class, or source.
 *
 * The explicit structural anchor supplies deterministic whole-program order and
 * provenance without parsing the opaque support binding ID. The support
 * reference supplies identity; its compatibility label cannot redirect the
 * exact allocator-owned function locator.
 */
export function planProgramAbiSupportCallable(
  ctx: CodegenContext,
  plan: ProgramAbiSupportCallablePlan,
): IrBindingId | undefined {
  const session = ctx.programAbiSession;
  if (!session) return undefined;
  if (plan.ref.binding.kind !== "support") {
    throw new TypeError("program ABI support callable planning requires an exact support reference");
  }
  const ownerId =
    plan.anchor.kind === "unit"
      ? plan.anchor.unitId
      : plan.anchor.kind === "class"
        ? plan.anchor.classId
        : plan.anchor.sourceId;
  const expectedBindingId = createIrBindingId({
    ownerId,
    domain: "support",
    role: plan.role,
    ordinal: plan.derivedOrdinal,
  });
  if (plan.ref.binding.bindingId !== expectedBindingId) {
    throw new TypeError(
      `program ABI support callable reference does not match ${plan.anchor.kind} anchor ${ownerId} and role ${plan.role}`,
    );
  }
  const bindingId = plan.ref.binding.bindingId;
  const structuralReferenceKey = irCallableBindingKey(plan.ref.binding);
  const typeContract = cloneProgramAbiCallableTypeContract(plan.signature);
  const structuralOrder =
    plan.anchor.kind === "unit"
      ? session.structuralOrder.forUnit(plan.anchor.unitId, {
          domain: "callable",
          roleOrdinal: plan.roleOrdinal,
          derivedOrdinal: plan.derivedOrdinal,
        })
      : plan.anchor.kind === "class"
        ? session.structuralOrder.forClass(plan.anchor.classId, {
            domain: "callable",
            roleOrdinal: plan.roleOrdinal,
            derivedOrdinal: plan.derivedOrdinal,
          })
        : session.structuralOrder.forSource(plan.anchor.sourceId, {
            domain: "callable",
            roleOrdinal: plan.roleOrdinal,
            derivedOrdinal: plan.derivedOrdinal,
          });
  const provenance =
    plan.anchor.kind === "unit"
      ? { unitId: plan.anchor.unitId }
      : plan.anchor.kind === "class"
        ? { classId: plan.anchor.classId }
        : { sourceId: plan.anchor.sourceId };
  session.ensurePlan({
    id: bindingId,
    structuralOrder,
    structuralReferenceKey,
    displayName: plan.func.name,
    slotPolicy: "required",
    slotSpace: "function",
    intent: {
      kind: "callable",
      origin: "support",
      ...provenance,
      signature: canonicalProgramAbiCallableTypeContract(typeContract),
    },
  });
  session.registerCallableTypeContract(bindingId, typeContract);
  session.registerStructuralReference(bindingId, structuralReferenceKey);
  if (!session.hasLocator(bindingId, plan.func)) {
    session.attachLocator(bindingId, { kind: "defined-function", value: plan.func });
  }
  return bindingId;
}

/**
 * Plan one compiler-owned support identity as an explicit alias of an exact
 * canonical callable.
 *
 * Aliases retain their own structural reference, ordering, provenance, and
 * callable contract, but deliberately own no allocator locator. Resolution
 * follows `aliasOf` to the canonical required function slot.
 */
export function planProgramAbiSupportCallableAlias(
  ctx: CodegenContext,
  plan: ProgramAbiSupportCallableAliasPlan,
): IrBindingId | undefined {
  const session = ctx.programAbiSession;
  if (!session) return undefined;
  if (plan.ref.binding.kind !== "support") {
    throw new TypeError("program ABI support callable alias planning requires an exact support reference");
  }
  const ownerId =
    plan.anchor.kind === "unit"
      ? plan.anchor.unitId
      : plan.anchor.kind === "class"
        ? plan.anchor.classId
        : plan.anchor.sourceId;
  const expectedBindingId = createIrBindingId({
    ownerId,
    domain: "support",
    role: plan.role,
    ordinal: plan.derivedOrdinal,
  });
  if (plan.ref.binding.bindingId !== expectedBindingId) {
    throw new TypeError(
      `program ABI support callable alias reference does not match ${plan.anchor.kind} anchor ${ownerId}, role ${plan.role}, and derived ordinal ${plan.derivedOrdinal}`,
    );
  }
  const bindingId = plan.ref.binding.bindingId;
  const structuralReferenceKey = irCallableBindingKey(plan.ref.binding);
  const typeContract = cloneProgramAbiCallableTypeContract(plan.signature);
  const structuralOrder =
    plan.anchor.kind === "unit"
      ? session.structuralOrder.forUnit(plan.anchor.unitId, {
          domain: "callable",
          roleOrdinal: plan.roleOrdinal,
          derivedOrdinal: plan.derivedOrdinal,
        })
      : plan.anchor.kind === "class"
        ? session.structuralOrder.forClass(plan.anchor.classId, {
            domain: "callable",
            roleOrdinal: plan.roleOrdinal,
            derivedOrdinal: plan.derivedOrdinal,
          })
        : session.structuralOrder.forSource(plan.anchor.sourceId, {
            domain: "callable",
            roleOrdinal: plan.roleOrdinal,
            derivedOrdinal: plan.derivedOrdinal,
          });
  const provenance =
    plan.anchor.kind === "unit"
      ? { unitId: plan.anchor.unitId }
      : plan.anchor.kind === "class"
        ? { classId: plan.anchor.classId }
        : { sourceId: plan.anchor.sourceId };
  session.ensurePlan({
    id: bindingId,
    structuralOrder,
    structuralReferenceKey,
    displayName: plan.ref.name,
    slotPolicy: "alias",
    aliasOf: plan.aliasOf,
    intent: {
      kind: "callable",
      origin: "support",
      ...provenance,
      signature: canonicalProgramAbiCallableTypeContract(typeContract),
    },
  });
  session.registerCallableTypeContract(bindingId, typeContract);
  session.registerStructuralReference(bindingId, structuralReferenceKey);
  return bindingId;
}

/** Publish the exact cached function-value singleton as one ABI-owned pair. */
export function planProgramAbiFunctionValue(
  ctx: CodegenContext,
  plan: ProgramAbiFunctionValuePlan,
  func: WasmFunction,
  global: GlobalDef,
): boolean {
  const signature = ctx.mod.types[func.typeIdx];
  if (
    plan.target.binding.kind !== "unit" ||
    func.name !== plan.trampoline.name ||
    global.name !== plan.cacheGlobal.name ||
    !signature ||
    signature.kind !== "func"
  ) {
    return false;
  }
  planProgramAbiSupportCallable(ctx, {
    ref: plan.trampoline,
    anchor: { kind: "unit", unitId: plan.target.binding.unitId },
    role: "function-value-trampoline",
    roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.functionValueTrampoline,
    signature,
    func,
  });
  planProgramAbiGlobal(ctx, {
    ref: plan.cacheGlobal,
    anchor: { kind: "unit", unitId: plan.target.binding.unitId },
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.functionValueCache,
    global,
  });
  return true;
}

/**
 * Plan and locate one exact IR-visible global.
 *
 * Repeated references to the same binding are idempotent only when they point
 * at the same allocator-owned GlobalDef object.
 */
export function planProgramAbiGlobal(ctx: CodegenContext, plan: ProgramAbiGlobalPlan): void {
  const session = ctx.programAbiSession;
  if (!session) return;
  const { binding } = plan.ref;
  const origin = binding.kind === "source" ? "source" : binding.kind;
  const capability = binding.kind === "source" ? binding.capability : undefined;
  if (origin === "source" && (plan.anchor.kind !== "source" || plan.storageOwnerUnitId === undefined)) {
    throw new ProgramAbiInvariantError(
      "invalid-callable-provenance",
      `source global ${plan.ref.name} requires exact source and storage-terminal provenance`,
    );
  }
  const structuralReferenceKey = irGlobalBindingKey(binding);
  const suborder = {
    domain: "global" as const,
    roleOrdinal: plan.roleOrdinal,
    derivedOrdinal: plan.derivedOrdinal,
  };
  const structuralOrder =
    plan.anchor.kind === "source"
      ? session.structuralOrder.forSource(plan.anchor.sourceId, suborder)
      : session.structuralOrder.forUnit(plan.anchor.unitId, suborder);
  session.ensurePlan({
    id: binding.bindingId,
    structuralOrder,
    structuralReferenceKey,
    displayName: plan.ref.name,
    slotPolicy: "required",
    slotSpace: "global",
    intent: {
      kind: "global",
      origin,
      valueType: canonicalProgramAbiValType(plan.global.type),
      mutable: plan.global.mutable,
      ...(origin === "source" && plan.anchor.kind === "source"
        ? {
            sourceId: plan.anchor.sourceId,
            unitId: plan.storageOwnerUnitId,
            ...(capability ? { capability } : {}),
          }
        : {}),
    },
  });
  session.registerGlobalTypeContract(binding.bindingId, plan.global.type, plan.global.mutable);
  session.registerStructuralReference(binding.bindingId, structuralReferenceKey);
  if (!session.hasLocator(binding.bindingId, plan.global)) {
    session.attachLocator(binding.bindingId, { kind: "defined-global", value: plan.global });
  }
}
