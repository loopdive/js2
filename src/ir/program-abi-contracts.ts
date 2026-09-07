// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createIrBindingId } from "./identity-values.js";
import type { IrBindingId, IrSourceId, IrUnitId, IrUnitInventory } from "./identity.js";
import { irCallableBindingKey, irUnitCallableBindingId, irUnitFuncRef } from "./callable-bindings.js";
import { irGlobalBindingKey } from "./abi-bindings.js";
import type { IrClassShape, IrGlobalRef, IrModule, IrType } from "./nodes.js";
import { irTypeKey } from "./type-key.js";
import type { IrModuleInitPlan } from "./module-init-plan.js";
import type { ProgramAbiCallableSignature, ProgramAbiDerivedUnitRecord } from "./program-abi.js";
import type { PreparedComponentAbiLookup } from "./prepared-component-dependencies.js";
import { PreparedIrProgramInvariantError, type PreparedIrAbiEntry } from "./program.js";
import type { IrProgramSourcePreparation } from "./program-source.js";
import type { IrProgramCallableBindingRecord } from "./program-callable-bindings.js";
import type { IrRuntimeCallableDeclaration } from "./runtime-callable-declarations.js";
import {
  assertPreparedIrRuntimeCallableDeclaration,
  preparedIrRuntimeAbiAnchor,
  preparedIrRuntimeCallableBindingId,
} from "./program-runtime-abi.js";

/** Semantic signature key; backend layout indices are deliberately not encoded here. */
export function preparedIrTypeKey(type: IrType): string {
  return `${irTypeKey(type)}:${preparedIrDataKey(type)}`;
}

/** Class references use the existing nominal identity; layouts are checked separately. */
export function preparedIrDataKey(data: unknown): string {
  const active = new Set<object>();
  const canonical = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") return value;
    const typed = value as Partial<IrType>;
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
  readonly globals: IrProgramSourcePreparation["globals"];
  readonly startup: readonly IrModuleInitPlan[];
  readonly callables: readonly IrProgramCallableBindingRecord[];
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
          signature: preparedIrCallableSignature(params, fn.resultTypes),
        },
      },
      contract: {
        kind: "callable",
        ref,
        params,
        results: fn.resultTypes,
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
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "runtime",
          signature: preparedIrCallableSignature(declaration.params, declaration.results),
        },
      },
      contract: { kind: "callable", ref: declaration.ref, params: declaration.params, results: declaration.results },
    });
  }
  return entries;
}
