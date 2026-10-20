// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrClassId } from "../../shared/contracts/ir-identity.js";
import type { IrUnitInventory } from "../../shared/contracts/ir-unit-inventory.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import { irSupportTypeRef } from "../core/type-references.js";
import { irSupportRef, irVal } from "../core/types.js";
import { irSupportGlobalRef, irTypeBindingKey, irGlobalBindingKey } from "../core/binding-references.js";
import type { IrJsClassBinding, IrJsClassDefinition, IrJsClassRole } from "../core/js-class-contracts.js";
import type { PreparedIrAbiEntry } from "./prepared-contracts.js";
import { preparedIrTypeKey } from "./abi-signatures.js";
import { irJsClassDefinitionBindingId } from "./js-class-definition.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export const IR_JS_CLASS_ROLES = [
  "object",
  "constructor",
  "prototype",
  "environment",
  "binding-cell",
  "frame",
  "method",
] as const;
export function irJsClassRoleRefs(inventory: IrUnitInventory): IrJsClassDefinition["roles"] {
  const owner = inventory.sources.find((source) => source.kind === "entry");
  if (!owner)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native JS classes require their original entry source",
    );
  return Object.freeze(
    Object.fromEntries(
      IR_JS_CLASS_ROLES.map((role) => [
        role,
        irSupportTypeRef(owner.id, `native-js-class-role:${role}`, `native_js_class_${role}`),
      ]),
    ) as Record<IrJsClassRole, ReturnType<typeof irSupportTypeRef>>,
  );
}
export function irJsClassBinding(
  classId: IrClassId,
  name: string,
  storage: "module" | "cell",
  mutable: boolean,
  roles: IrJsClassDefinition["roles"],
  role: "outer" | "inner",
): IrJsClassBinding {
  return Object.freeze({
    id: createIrBindingId({ ownerId: classId, domain: "support", role: `native-js-class-binding:${role}` }),
    name,
    storage,
    mutable,
    valueType: irSupportRef(roles.constructor, true),
    valueGlobal:
      storage === "module" ? irSupportGlobalRef(classId, `native-js-class-binding:${role}:value`, name) : null,
    tdzGlobal:
      storage === "module" ? irSupportGlobalRef(classId, `native-js-class-binding:${role}:tdz`, `${name}_tdz`) : null,
  });
}

/** Declarations only: this does not issue a physical carrier, initialized binding or readiness capability. */
export function prepareIrJsClassAbiEntries(
  definitions: readonly IrJsClassDefinition[],
  inventory: IrUnitInventory,
  order: (sourceId: IrJsClassDefinition["sourceId"]) => PreparedIrAbiEntry["plan"]["order"],
): readonly PreparedIrAbiEntry[] {
  const entries: PreparedIrAbiEntry[] = [];
  if (!definitions.length) return entries;
  const entry = inventory.sources.find((source) => source.kind === "entry")!;
  const roles = irJsClassRoleRefs(inventory);
  for (const role of IR_JS_CLASS_ROLES) {
    const ref = roles[role],
      type = irSupportRef(ref, false);
    entries.push({
      plan: {
        id: ref.binding.bindingId,
        order: order(entry.id),
        displayName: ref.name,
        // Logical roles share a backend-owned carrier; they are not seven Wasm type slots.
        slotPolicy: "none",
        structuralReferenceKey: irTypeBindingKey(ref.binding),
        intent: { kind: "type", shapeKey: preparedIrTypeKey(type) },
      },
      contract: { kind: "type", ref, type },
    });
  }
  const realm = definitions[0]!.realm;
  for (const [name, semantic, type] of [
    ["objectPrototype", "Object.prototype", irSupportRef(roles.prototype, false)],
    ["functionPrototype", "Function.prototype", irSupportRef(roles.method, false)],
    ["referenceError", "ReferenceError", irSupportRef(roles.constructor, false)],
    ["typeError", "TypeError", irSupportRef(roles.constructor, false)],
  ] as const) {
    const ref = irSupportGlobalRef(entry.id, `native-js-class-realm:${semantic}`, `native-js-class-realm:${name}`);
    if (ref.binding.bindingId !== realm[name])
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "native class realm ID differs from actual entry source owner",
      );
    entries.push({
      plan: {
        id: ref.binding.bindingId,
        order: order(entry.id),
        displayName: ref.name,
        slotPolicy: "required",
        slotSpace: "global",
        structuralReferenceKey: irGlobalBindingKey(ref.binding),
        intent: { kind: "global", origin: "support", valueType: preparedIrTypeKey(type), mutable: false },
      },
      contract: { kind: "global", ref, type, mutable: false },
    });
  }
  for (const definition of definitions) {
    entries.push({
      plan: {
        id: irJsClassDefinitionBindingId(definition),
        order: order(definition.sourceId),
        displayName: definition.name,
        slotPolicy: "none",
        intent: { kind: "support", role: "native-js-class-definition-v1" },
      },
      contract: { kind: "support", role: "native-js-class-definition-v1", nativeJsClassDefinition: definition },
    });
    for (const binding of [definition.outerBinding, definition.innerBinding]) {
      if (!binding || binding.storage !== "module") continue;
      for (const [ref, type] of [
        [binding.valueGlobal!, binding.valueType],
        [binding.tdzGlobal!, irVal({ kind: "i32" })],
      ] as const)
        entries.push({
          plan: {
            id: ref.binding.bindingId,
            order: order(definition.sourceId),
            displayName: ref.name,
            slotPolicy: "required",
            slotSpace: "global",
            structuralReferenceKey: irGlobalBindingKey(ref.binding),
            intent: { kind: "global", origin: "support", valueType: preparedIrTypeKey(type), mutable: true },
          },
          contract: { kind: "global", ref, type, mutable: true },
        });
    }
  }
  return entries;
}
