// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrUnitInventory } from "../../shared/contracts/ir-unit-inventory.js";
import type { IrJsClassDefinition, IrJsClassStartup } from "../core/js-class-contracts.js";
import type { IrModuleInitPlan } from "./startup.js";
import { irJsClassDefinitionBindingId } from "./js-class-definition.js";
import { copyIrJsClassData } from "../runtime/js-class-verify.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native JS class startup: ${detail}`);
}
/** DATA-only declaration order/census joins. Body and allocation admission are independently checked. */
export function assertPreparedIrJsClassStartup(
  startup: readonly IrModuleInitPlan[],
  definitions: readonly IrJsClassDefinition[],
  inventory: IrUnitInventory,
): void {
  const expected = new Map(definitions.map((definition) => [irJsClassDefinitionBindingId(definition), definition]));
  const seen = new Set<string>();
  for (const plan of startup) {
    const field = Object.getOwnPropertyDescriptor(plan, "jsClassStartup");
    if (!field) {
      if (definitions.length) invalid("class program source omits its explicit startup projection");
      continue;
    }
    if (!("value" in field)) invalid("startup projection is not own DATA");
    const value = copyIrJsClassData<IrJsClassStartup>(field.value);
    if (
      !value ||
      value.schema !== "native-js-class-startup-v1" ||
      Object.keys(value).length !== 2 ||
      !Array.isArray(value.definitions)
    )
      invalid("invalid closed startup projection");
    let previous = -1,
      previousEnd = -1;
    for (const row of value.definitions) {
      if (
        Object.keys(row).length !== 4 ||
        Object.keys(row.span).length !== 2 ||
        !Number.isSafeInteger(row.statementOrdinal) ||
        row.statementOrdinal <= previous ||
        row.span.start < previousEnd
      )
        invalid("invalid original declaration order/fields");
      previous = row.statementOrdinal;
      previousEnd = row.span.end;
      const descriptor = expected.get(row.definitionId);
      if (
        !descriptor ||
        seen.has(row.definitionId) ||
        descriptor.sourceId !== plan.sourceId ||
        descriptor.sourceClassId !== row.sourceClassId ||
        descriptor.evaluationOwnerUnitId !== plan.unitId ||
        descriptor.form !== "declaration" ||
        descriptor.span.start !== row.span.start ||
        descriptor.span.end !== row.span.end
      )
        invalid("startup class differs from its actual descriptor/source/evaluation owner");
      const owner = inventory.allUnits.find((unit) => unit.id === descriptor.evaluationOwnerUnitId);
      if (!owner || owner.kind !== "module-init" || !owner.terminal || !plan.executable)
        invalid("startup definition lacks actual executable original module owner");
      seen.add(row.definitionId);
    }
    const owners = definitions.filter(
      (definition) => definition.sourceId === plan.sourceId && definition.evaluationOwnerUnitId === plan.unitId,
    );
    if (owners.length !== value.definitions.length) invalid("missing/extra module class definition");
  }
  for (const descriptor of definitions) {
    const owner = inventory.allUnits.find((unit) => unit.id === descriptor.evaluationOwnerUnitId);
    if (owner?.kind === "module-init" && !seen.has(irJsClassDefinitionBindingId(descriptor)))
      invalid("module class omitted from startup");
  }
}
