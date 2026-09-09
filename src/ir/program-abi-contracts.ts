// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createIrBindingId } from "./identity-values.js";
import { preparedIrProgramCallableResults } from "./program-callable-contract.js";
import type { IrBindingId, IrSourceId, IrUnitId } from "../shared/contracts/ir-identity.js";
import type { IrUnitInventory } from "../shared/contracts/ir-unit-inventory.js";
import { irCallableBindingKey, irUnitCallableBindingId, irUnitFuncRef } from "./callable-bindings.js";
import { irGlobalBindingKey, irTypeBindingKey } from "./abi-bindings.js";
import type { PreparedIrModule as IrModule } from "./runtime/contracts/prepared.js";
import type { IrClassShape, IrType } from "./core/types.js";
import type { IrGlobalRef } from "./core/value-references.js";
import { irTypeKey } from "./type-key.js";
import type { IrModuleInitPlan } from "./program/startup.js";
import type { ProgramAbiCallableSignature, ProgramAbiDerivedUnitRecord } from "./program/abi.js";
import type { PreparedComponentAbiLookup } from "./program/abi-lookup.js";
import { PreparedIrProgramInvariantError } from "./program.js";
import type { PreparedIrAbiEntry } from "./program/prepared-contracts.js";
import type { TypedIrProgramGlobal } from "./program/input-contracts.js";
import type { IrProgramCallableBindingRecord } from "./program/callable-bindings.js";
import type { IrRuntimeCallableDeclaration } from "./runtime-callable-declarations.js";
import { irRuntimeCallableHasNoSlot } from "./runtime/native-async-callables.js";
import type { IrRuntimeSupport } from "./program/runtime-support.js";
import { numberFormatRadixSupportDeclarations } from "./program/formatter-support.js";
import {
  assertPreparedIrRuntimeCallableDeclaration,
  preparedIrRuntimeAbiAnchor,
  preparedIrRuntimeCallableBindingId,
} from "./program-runtime-abi.js";

/** Semantic signature key; backend layout indices are deliberately not encoded here. */
export function preparedIrTypeKey(type: IrType): string {
  if (type.kind === "support-ref") return irTypeKey(type);
  return `${irTypeKey(type)}:${preparedIrDataKey(type)}`;
}

/** Class references use the existing nominal identity; layouts are checked separately. */
export function preparedIrDataKey(data: unknown): string {
  const active = new Set<object>();
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const typed = value as Partial<IrType>;
    if (typed.kind === "support-ref") {
      if (!typed.ref || typeof typed.nullable !== "boolean" || typed.ref.binding.kind !== "support")
        throw new PreparedIrProgramInvariantError("invalid-prepared-data", "support type lacks its declared identity");
      return { kind: "support-ref", key: preparedIrTypeKey(typed as IrType) };
    }
    if (typed.kind === "class") {
      if (!typed.shape || typeof typed.shape.classId !== "string")
        throw new PreparedIrProgramInvariantError("invalid-prepared-data", "class type lacks its declared identity");
      return { kind: "class", classId: typed.shape.classId };
    }
    if (active.has(value))
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "recursive anonymous data has no declared class identity",
      );
    active.add(value);
    try {
      if (Array.isArray(value)) return value.map(canonical);
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, canonical(item)]),
      );
    } finally {
      active.delete(value);
    }
  };
  return JSON.stringify(canonical(data));
}

export function preparedIrClassLayoutKey(shape: IrClassShape): string {
  return preparedIrDataKey(shape);
}

export function preparedIrCallableSignature(
  params: readonly IrType[],
  results: readonly IrType[],
): ProgramAbiCallableSignature {
  return { params: params.map(preparedIrTypeKey), results: results.map(preparedIrTypeKey) };
}

/** Read surface during preparation over the same entry vector that will be sealed. */
export function preparedIrDraftAbiLookup(entries: readonly PreparedIrAbiEntry[]): PreparedComponentAbiLookup {
  return {
    get: (id) => entries.find((entry) => entry.plan.id === id)?.plan,
    entries: () => entries.map((entry) => entry.plan),
    bindingIdsForStructuralReference: (key) =>
      entries.filter((entry) => entry.plan.structuralReferenceKey === key).map((entry) => entry.plan.id),
  };
}

export interface PrepareIrProgramAbiInput {
  readonly inventory: IrUnitInventory;
  readonly ir: IrModule;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly globals: readonly TypedIrProgramGlobal[];
  readonly startup: readonly IrModuleInitPlan[];
  readonly callables: readonly IrProgramCallableBindingRecord[];
  readonly runtimeSupport?: IrRuntimeSupport;
}

/** Produce semantic contracts from declared bodies/storage, never from a call's guessed usage. */
export function prepareIrProgramAbiEntries(
  input: PrepareIrProgramAbiInput,
  runtimeDeclarations: readonly IrRuntimeCallableDeclaration[] = [],
): readonly PreparedIrAbiEntry[] {
  const entries: PreparedIrAbiEntry[] = [];
  const sourceOrders = new Map(input.inventory.sources.map((source) => [source.id, source.order]));
  const nextOrder = new Map<IrSourceId, number>();
  const order = (sourceId: IrSourceId) => {
    const sourceOrder = sourceOrders.get(sourceId);
    if (sourceOrder === undefined)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `ABI owner ${sourceId} is not a program source`,
      );
    const declarationOrder = nextOrder.get(sourceId) ?? 0;
    nextOrder.set(sourceId, declarationOrder + 1);
    return { sourceOrder, declarationOrder };
  };
  const sourceOf = (unitId: IrUnitId): IrSourceId => {
    const record =
      input.inventory.allUnits.find((unit) => unit.id === unitId) ??
      input.derivedUnits.find((unit) => unit.id === unitId);
    if (!record)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `ABI body ${unitId} has no declared provenance`,
      );
    return record.sourceId;
  };
  for (const fn of input.ir.functions) {
    const ref = irUnitFuncRef(fn);
    const params = fn.params.map((param) => param.type);
    const results = preparedIrProgramCallableResults(fn);
    entries.push({
      plan: {
        id: irUnitCallableBindingId(fn.unitId),
        order: order(sourceOf(fn.unitId)),
        displayName: fn.name,
        structuralReferenceKey: irCallableBindingKey(ref.binding),
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "source",
          unitId: fn.unitId,
          signature: preparedIrCallableSignature(params, results),
        },
      },
      contract: {
        kind: "callable",
        ref,
        params,
        results,
        ...(fn.asyncPlan ? { promise: fn.asyncPlan.abi } : {}),
      },
    });
  }
  for (const { binding, identity } of input.globals) {
    const storage: [IrGlobalRef, IrType][] = [[binding.globalRef, binding.type]];
    if (binding.tdzGlobalRef) storage.push([binding.tdzGlobalRef, { kind: "val", val: { kind: "i32" } }]);
    for (const [ref, type] of storage) {
      entries.push({
        plan: {
          id: ref.binding.bindingId,
          order: order(identity.sourceId),
          displayName: ref.name,
          structuralReferenceKey: irGlobalBindingKey(ref.binding),
          slotPolicy: "required",
          slotSpace: "global",
          intent: {
            kind: "global",
            origin: "source",
            sourceId: identity.sourceId,
            unitId: identity.storageOwnerUnitId,
            valueType: preparedIrTypeKey(type),
            mutable: true,
          },
        },
        contract: { kind: "global", ref, type, mutable: true },
      });
    }
  }
  for (const alias of input.callables) {
    if (alias.kind === "source") continue;
    const target = entries.find((entry) => entry.plan.id === alias.canonicalBindingId);
    if (!target || target.contract.kind !== "callable")
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `callable alias ${alias.bindingId} has no declared body contract`,
      );
    entries.push({
      plan: {
        id: alias.bindingId,
        order: order(alias.sourceId),
        displayName: alias.localName,
        slotPolicy: "alias",
        aliasOf: alias.canonicalBindingId,
        intent: {
          kind: "callable",
          origin: "module-alias",
          sourceId: alias.sourceId,
          aliasKind: alias.kind,
          targetUnitId: alias.targetUnitId,
          signature: preparedIrCallableSignature(target.contract.params, target.contract.results),
        },
      },
      contract: target.contract,
    });
  }
  const entrySource =
    input.inventory.sources.find((source) => source.kind === "entry") ?? input.inventory.sources.at(-1);
  if (entrySource) {
    const exports = new Map<string, IrBindingId>();
    for (const item of input.startup.find((plan) => plan.sourceId === entrySource.id)?.exports ?? [])
      if (item.targetBindingId) exports.set(item.externalName, item.targetBindingId);
    for (const alias of input.callables)
      if (alias.sourceId === entrySource.id && alias.kind === "export-alias")
        exports.set(alias.localName, alias.canonicalBindingId);
    for (const [externalName, targetId] of exports) {
      entries.push({
        plan: {
          id: createIrBindingId({ ownerId: entrySource.id, domain: "export", role: externalName }),
          order: order(entrySource.id),
          displayName: externalName,
          slotPolicy: "alias",
          aliasOf: targetId,
          intent: { kind: "export", externalName, targetId },
        },
        contract: { kind: "export", externalName, targetId },
      });
    }
  }
  // These are real type/function declarations, never ordinary source units or
  // slotless runtime intents. Keep the canonical runtime tail after this vector.
  for (const batch of input.runtimeSupport?.batches ?? []) {
    const declaration = numberFormatRadixSupportDeclarations(batch.sourceId);
    const type = declaration.scratch.type;
    entries.push({
      plan: {
        id: type.ref.binding.bindingId,
        order: order(batch.sourceId),
        displayName: type.ref.name,
        structuralReferenceKey: irTypeBindingKey(type.ref.binding),
        slotPolicy: "required",
        slotSpace: "type",
        intent: { kind: "type", shapeKey: preparedIrTypeKey(type) },
      },
      contract: { kind: "type", ref: type.ref, type },
    });
    for (const callable of [...declaration.kernels, declaration.implementation]) {
      if (callable.ref.binding.kind !== "support")
        throw new PreparedIrProgramInvariantError("invalid-prepared-data", "formatter callable lacks support binding");
      entries.push({
        plan: {
          id: callable.ref.binding.bindingId,
          order: order(batch.sourceId),
          displayName: callable.ref.name,
          structuralReferenceKey: irCallableBindingKey(callable.ref.binding),
          slotPolicy: "required",
          slotSpace: "function",
          intent: {
            kind: "callable",
            origin: "support",
            sourceId: batch.sourceId,
            signature: preparedIrCallableSignature(callable.params, callable.results),
          },
        },
        contract: { kind: "callable", ref: callable.ref, params: callable.params, results: callable.results },
      });
    }
  }
  const runtimeKeys = new Set<string>();
  for (const declaration of [...runtimeDeclarations].sort((left, right) =>
    irCallableBindingKey(left.ref.binding).localeCompare(irCallableBindingKey(right.ref.binding)),
  )) {
    assertPreparedIrRuntimeCallableDeclaration(declaration);
    const key = irCallableBindingKey(declaration.ref.binding);
    if (runtimeKeys.has(key))
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", `runtime ABI duplicates declaration ${key}`);
    runtimeKeys.add(key);
    const anchor = preparedIrRuntimeAbiAnchor(input.inventory);
    entries.push({
      plan: {
        id: preparedIrRuntimeCallableBindingId(input.inventory, declaration.ref),
        order: order(anchor.id),
        displayName: declaration.ref.name,
        structuralReferenceKey: key,
        ...(irRuntimeCallableHasNoSlot(declaration.ref)
          ? { slotPolicy: "none" as const }
          : { slotPolicy: "required" as const, slotSpace: "function" as const }),
        intent: {
          kind: "callable",
          origin: declaration.ref.binding.kind === "intrinsic" ? "intrinsic" : "runtime",
          signature: preparedIrCallableSignature(declaration.params, declaration.results),
        },
      },
      contract: { kind: "callable", ref: declaration.ref, params: declaration.params, results: declaration.results },
    });
  }
  return entries;
}
