// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { ts } from "../../ts-api.js";
import { buildIrUnitInventory, type BuildIrUnitInventoryOptions } from "../identity.js";
import { isAmbientDeclaration } from "../analysis/ambient-declarations.js";
import {
  buildIrPlanningIdentityContext,
  requireIrPlanningClassRecord,
  type IrPlanningIdentityContext,
} from "../planning-identity.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type { PreparedIrProgramFailure } from "./prepared-contracts.js";

/**
 * A source class record requires definition execution, even with no members.
 * Until the source producer supplies it, do not seal a smaller complete program.
 * This check is frontend-only; constructed typed IR retains its own validation.
 */
export function unloweredSourceClassDefinition(
  identity: IrPlanningIdentityContext,
): PreparedIrProgramFailure | undefined {
  for (const record of identity.inventory.classes) {
    const declaration = identity.declarationByClassId.get(record.id);
    if (!declaration || requireIrPlanningClassRecord(identity, declaration) !== record)
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", "source class has no exact declaration");
    if (isAmbientDeclaration(declaration)) continue;
    const constructors = identity.inventory.allUnits.filter(
      (unit) =>
        unit.lexicalOwnerId === record.id &&
        (unit.kind === "class-constructor" || unit.kind === "class-implicit-constructor"),
    );
    if (constructors.length !== 1)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "source class lacks one actual constructor unit",
      );
    const unit = constructors[0]!,
      source = identity.inventory.sources.find((row) => row.id === unit.sourceId);
    if (!source || unit.sourceId !== record.sourceId || identity.unitByUnitId.get(unit.id) !== unit)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        "source class constructor lost its exact source",
      );
    // This is a diagnostic locator for original source work, not a terminal
    // body ownership receipt. Empty classes currently own a support unit.
    return Object.freeze({
      kind: "unsupported",
      code: "class-definition-execution-unsupported",
      stage: "build",
      detail: `whole-program source class ${JSON.stringify(record.displayName)} requires executable ClassDefinitionEvaluation`,
      unitId: unit.id,
      sourceFile: source.sourceKey,
      location: Object.freeze({
        sourceId: unit.sourceId,
        line: unit.line,
        column: unit.column,
        declarationStart: unit.declarationStart,
        declarationEnd: unit.declarationEnd,
      }),
    });
  }
  return undefined;
}

/** Keep scanner/identity setup and its requested preflight in their original order. */
export function prepareIrSourceDefinitionPopulation(
  input: {
    readonly sourceFiles: readonly ts.SourceFile[];
    readonly entrySource: ts.SourceFile;
    readonly checker: ts.TypeChecker;
    readonly inventoryOptions?: BuildIrUnitInventoryOptions;
  },
  preflight?: (inventory: IrPlanningIdentityContext["inventory"]) => void,
): {
  readonly inventory: IrPlanningIdentityContext["inventory"];
  readonly identity: IrPlanningIdentityContext;
} {
  const inventory = buildIrUnitInventory(input.sourceFiles, {
    ...input.inventoryOptions,
    entrySource: input.entrySource,
    checker: input.checker,
  });
  // Source-map capture validates the scanner tree before identity projection,
  // in the same phase/order as the original source producer.
  preflight?.(inventory);
  const identity = buildIrPlanningIdentityContext(inventory);
  return { inventory, identity };
}
