// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ts } from "../../ts-api.js";
import type { IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrUnitInventory, IrUnitRecord } from "../../shared/contracts/ir-unit-inventory.js";
import type { IrPreparationFailure } from "../../shared/contracts/ir-preparation-failure.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type {
  PreparedIrProgramFailure,
  PreparedIrProgramProducerInput,
  PreparedIrProgramOwner,
} from "./prepared-contracts.js";

/** Resolve diagnostics through the existing original/derived ownership records. */
export function preparedIrProgramOwner(
  input: Pick<PreparedIrProgramProducerInput, "inventory" | "derivedUnits">,
  unitId: IrUnitId,
): PreparedIrProgramOwner | undefined {
  const derived = input.derivedUnits.find((record) => record.id === unitId);
  const source = input.inventory.allUnits.find((record) => record.id === unitId);
  const ownerId = derived?.terminalOwnerId ?? source?.terminalOwnerId ?? unitId;
  const owner = input.inventory.terminalUnits.find((record) => record.id === ownerId);
  return owner && unitOwner(input.inventory, owner);
}

/** `unit` itself as a diagnostic owner: its id, source file and declaration position. */
export function unitOwner(inventory: IrUnitInventory, unit: IrUnitRecord): PreparedIrProgramOwner | undefined {
  const sourceRecord = inventory.sources.find((record) => record.id === unit.sourceId);
  if (!sourceRecord) return undefined;
  return Object.freeze({
    unitId: unit.id,
    sourceFile: sourceRecord.sourceKey,
    location: Object.freeze({
      sourceId: unit.sourceId,
      line: unit.line,
      column: unit.column,
      declarationStart: unit.declarationStart,
      declarationEnd: unit.declarationEnd,
    }),
  });
}

/** `failure` as a Prepared producer's refusal, owned by the terminal unit around `unitId`. */
export function locatedFailure(
  input: Pick<PreparedIrProgramProducerInput, "inventory" | "derivedUnits">,
  unitId: IrUnitId,
  failure: IrPreparationFailure,
): PreparedIrProgramFailure {
  return failureAt(preparedIrProgramOwner(input, unitId), failure, unitId);
}

/** The owner of a failure: a unit, or (`unitId: null`) source text no unit owns. */
type FailureOwner = Omit<PreparedIrProgramOwner, "unitId"> & { readonly unitId: IrUnitId | null };

export function sourceOwner(
  inventory: IrUnitInventory,
  sourceId: IrSourceId | undefined,
  node: ts.Node,
): FailureOwner | undefined {
  const sourceRecord = inventory.sources.find((record) => record.id === sourceId);
  if (!sourceRecord) return undefined;
  const file = node.getSourceFile();
  const start = node.getStart(file);
  const { line, character } = file.getLineAndCharacterOfPosition(start);
  return Object.freeze({
    unitId: null,
    sourceFile: sourceRecord.sourceKey,
    location: Object.freeze({
      sourceId: sourceRecord.id,
      line: line + 1,
      column: character + 1,
      declarationStart: start,
      declarationEnd: node.end,
    }),
  });
}

/** `failure` as a refusal owned by `owner`; `subject` names what was being located when the owner is missing. */
export function failureAt(
  owner: FailureOwner | undefined,
  failure: IrPreparationFailure,
  subject: string,
): PreparedIrProgramFailure {
  if (!owner) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `prepared producer cannot locate ${subject}: ${failure.detail}`,
    );
  }
  // Error instances/callbacks must not escape into the serializable diagnostic contract.
  const { cause: _cause, ...diagnostic } = failure;
  return Object.freeze({ ...diagnostic, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile });
}
