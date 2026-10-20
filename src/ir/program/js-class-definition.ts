// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrBindingId } from "../../shared/contracts/ir-identity.js";
import type { IrUnitInventory } from "../../shared/contracts/ir-unit-inventory.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import type { IrJsClassBody, IrJsClassDefinition } from "../core/js-class-contracts.js";
import { copyIrJsClassData, verifyIrJsClassDefinitionData } from "../runtime/js-class-verify.js";
import type { PreparedIrModule as IrModule } from "../runtime/contracts/prepared.js";
import type { PreparedIrAbiEntry } from "./prepared-contracts.js";
import { irTypeEquals } from "../core/types.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export interface PreparedIrJsClassDefinition {
  readonly bindingId: IrBindingId;
  readonly definition: IrJsClassDefinition;
}
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native JS class: ${detail}`);
}
function data(value: object, name: string): unknown {
  const field = Object.getOwnPropertyDescriptor(value, name);
  if (!field || !("value" in field)) return invalid("missing own DATA field");
  return field.value;
}
export function irJsClassDefinitionBindingId(definition: Pick<IrJsClassDefinition, "sourceClassId">): IrBindingId {
  return createIrBindingId({
    ownerId: definition.sourceClassId,
    domain: "support",
    role: "native-js-class-definition-v1",
  });
}

/** Extract canonical immutable descriptors from the one ABI, never a source sidecar. */
export function preparedIrJsClassDefinitions(
  entries: readonly PreparedIrAbiEntry[],
): readonly PreparedIrJsClassDefinition[] {
  const rows: PreparedIrJsClassDefinition[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const contract = data(entry, "contract") as object;
    const kind = data(contract, "kind");
    const attachment = Object.getOwnPropertyDescriptor(contract, "nativeJsClassDefinition");
    if (!attachment) continue;
    if (!("value" in attachment) || kind !== "support" || data(contract, "role") !== "native-js-class-definition-v1")
      invalid("definition attachment belongs to a foreign ABI contract");
    const captured = copyIrJsClassData(entry);
    const c = captured.contract;
    if (c.kind !== "support" || c.role !== "native-js-class-definition-v1" || !c.nativeJsClassDefinition)
      invalid("definition support contract missing");
    const problems = verifyIrJsClassDefinitionData(c.nativeJsClassDefinition);
    if (problems.length) invalid(problems.join("; "));
    const definition = c.nativeJsClassDefinition;
    const bindingId = irJsClassDefinitionBindingId(definition);
    const plan = captured.plan;
    if (
      plan.id !== bindingId ||
      plan.slotPolicy !== "none" ||
      plan.intent.kind !== "support" ||
      plan.intent.role !== "native-js-class-definition-v1" ||
      ids.has(bindingId)
    )
      invalid("noncanonical or duplicate definition ABI identity");
    ids.add(bindingId);
    rows.push(Object.freeze({ bindingId, definition }));
  }
  return Object.freeze(rows);
}

/** Complete original class/body denominator; immutable DATA alone cannot invent source ownership. */
export function assertPreparedIrJsClassDefinitions(
  inventory: IrUnitInventory,
  definitions: readonly IrJsClassDefinition[],
  ir?: IrModule,
): void {
  if (definitions.length !== inventory.classes.length) invalid("original class census differs");
  const originals = new Map(inventory.classes.map((record) => [record.id, record]));
  const units = new Map(inventory.allUnits.map((unit) => [unit.id, unit]));
  const seen = new Set<string>();
  const bodies = new Set<string>();
  for (const descriptor of definitions) {
    const problems = verifyIrJsClassDefinitionData(descriptor);
    if (problems.length) invalid(problems.join("; "));
    const original = originals.get(descriptor.sourceClassId);
    if (
      !original ||
      seen.has(original.id) ||
      original.sourceId !== descriptor.sourceId ||
      original.declarationStart !== descriptor.span.start ||
      original.declarationEnd !== descriptor.span.end ||
      original.declarationKind !== descriptor.form
    )
      invalid("descriptor differs from original ClassId/source span/form");
    seen.add(original.id);
    const owner = units.get(descriptor.evaluationOwnerUnitId);
    if (!owner?.terminal || owner.sourceId !== original.sourceId)
      invalid("definition has no actual original evaluation owner");
    const inspectBody = (body: IrJsClassBody): void => {
      const unit = units.get(body.unitId);
      const expectedKinds =
        body.sourceBodyKind === "constructor"
          ? ["class-constructor", "class-implicit-constructor"]
          : body.sourceBodyKind === "method"
            ? ["class-instance-method", "class-static-method"]
            : body.sourceBodyKind === "field-initializer"
              ? ["class-instance-field-initializer"]
              : ["class-static-field-initializer", "class-static-block"];
      if (
        !unit ||
        bodies.has(unit.id) ||
        unit.sourceId !== original.sourceId ||
        unit.lexicalOwnerId !== original.id ||
        unit.lexicalOwnerId !== body.lexicalOwnerId ||
        unit.terminalOwnerId !== body.terminalOwnerId ||
        unit.ordinal !== body.ordinal ||
        unit.declarationStart !== body.span.start ||
        unit.declarationEnd !== body.span.end ||
        !expectedKinds.includes(unit.kind)
      )
        invalid("original class body/initializer population mismatch");
      bodies.add(unit.id);
      if (!ir) return;
      const functions = ir.functions.filter((fn) => fn.unitId === unit.id);
      if (functions.length !== 1) invalid("original class body missing or duplicated");
      const fn = functions[0]!;
      const hidden = [
        body.frame.environmentType,
        body.frame.thisType,
        body.frame.homeObjectType,
        body.frame.newTargetType,
      ];
      const params = [...hidden, ...body.params];
      if (
        fn.params.length !== params.length ||
        fn.params.some((param, index) => !irTypeEquals(param.type, params[index]!))
      )
        invalid("original class hidden frame/user parameter ABI differs");
      const first = fn.blocks[0]?.instrs[0];
      if (
        !first ||
        first.kind !== "js.class.frame.new" ||
        first.definition !== irJsClassDefinitionBindingId(descriptor) ||
        first.environment !== fn.params[0]!.value ||
        first.thisValue !== fn.params[1]!.value ||
        first.homeObject !== fn.params[2]!.value ||
        first.newTarget !== fn.params[3]!.value ||
        first.resultType?.kind !== "support-ref" ||
        first.resultType.ref.binding.bindingId !== descriptor.roles.frame.binding.bindingId
      )
        invalid("original callee lacks its genuine entry frame producer");
    };
    inspectBody(descriptor.constructor);
    for (const member of descriptor.members) inspectBody(member.body);
    for (const field of descriptor.instanceElements) if (field.initializer) inspectBody(field.initializer);
  }
  for (const unit of inventory.allUnits)
    if (
      unit.lexicalOwnerId &&
      originals.has(unit.lexicalOwnerId as (typeof inventory.classes)[number]["id"]) &&
      [
        "class-constructor",
        "class-implicit-constructor",
        "class-instance-method",
        "class-static-method",
        "class-instance-field-initializer",
        "class-static-field-initializer",
        "class-static-block",
      ].includes(unit.kind) &&
      !bodies.has(unit.id)
    )
      invalid("original class executable body omitted");
}
