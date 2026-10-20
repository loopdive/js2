// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irDynamic } from "../core/types.js";
import type { IrGlobalRef } from "../core/value-references.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { irGlobalBindingKey } from "../core/global-binding-keys.js";
import { preparedIrTypeKey } from "./abi-signatures.js";
import type { PreparedIrAbiEntry } from "./prepared-contracts.js";
import type { IrUnitInventory } from "../../shared/contracts/ir-unit-inventory.js";
import type { NativeNumberUndefinedRequirements } from "./native-number-undefined-requirements.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

/** One canonical support declaration; neither runtime type nor singleton is a source allocation. */
export function nativeNumberUndefinedDeclarations(ownerUnitId: IrUnitId) {
  const carrier = irDynamic();
  const undefinedRoot: IrGlobalRef = {
    kind: "global",
    name: "__native_undefined",
    binding: {
      kind: "support",
      bindingId: createIrBindingId({
        ownerId: ownerUnitId,
        domain: "global",
        role: "native-number-undefined:undefined",
      }),
    },
  };
  return { carrier, undefinedRoot };
}

export function appendNativeNumberUndefinedAbi(
  entries: readonly PreparedIrAbiEntry[],
  inventory: IrUnitInventory,
  requirements: NativeNumberUndefinedRequirements | undefined,
): readonly PreparedIrAbiEntry[] {
  if (!requirements) return entries;
  const owner = inventory.allUnits.find((unit) => unit.id === requirements.units[0]);
  const source = inventory.sources.find((record) => record.id === owner?.sourceId);
  if (!owner || !source)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native Number/Undefined support lacks original source owner",
    );
  const { carrier, undefinedRoot } = nativeNumberUndefinedDeclarations(owner.id);
  let ordinal =
    Math.max(
      -1,
      ...entries
        .filter((entry) => entry.plan.order.sourceOrder === source.order)
        .map((entry) => entry.plan.order.declarationOrder),
    ) + 1;
  const order = () => ({
    sourceOrder: source.order,
    declarationOrder: ordinal++,
  });
  return [
    ...entries,
    {
      plan: {
        id: undefinedRoot.binding.bindingId,
        order: order(),
        displayName: undefinedRoot.name,
        structuralReferenceKey: irGlobalBindingKey(undefinedRoot.binding),
        slotPolicy: "required",
        slotSpace: "global",
        intent: {
          kind: "global",
          origin: "support",
          valueType: preparedIrTypeKey(carrier),
          mutable: false,
          unitId: owner.id,
          sourceId: owner.sourceId,
        },
      },
      contract: {
        kind: "global",
        ref: undefinedRoot,
        type: carrier,
        mutable: false,
      },
    },
  ];
}
