// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
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
  if (!owner) return undefined;
  const sourceRecord = input.inventory.sources.find((record) => record.id === owner.sourceId);
  if (!sourceRecord) return undefined;
  return Object.freeze({
    unitId: owner.id,
    sourceFile: sourceRecord.sourceKey,
    location: Object.freeze({
      sourceId: owner.sourceId,
      line: owner.line,
      column: owner.column,
      declarationStart: owner.declarationStart,
      declarationEnd: owner.declarationEnd,
    }),
  });
}

/** `failure` as a Prepared producer's refusal, owned by the terminal unit around `unitId`. */
export function locatedFailure(
  input: Pick<PreparedIrProgramProducerInput, "inventory" | "derivedUnits">,
  unitId: IrUnitId,
  failure: IrPreparationFailure,
): PreparedIrProgramFailure {
  const owner = preparedIrProgramOwner(input, unitId);
  if (!owner) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `prepared producer cannot locate ${unitId}: ${failure.detail}`,
    );
  }
  // Error instances/callbacks must not escape into the serializable diagnostic contract.
  const { cause: _cause, ...diagnostic } = failure;
  return Object.freeze({ ...diagnostic, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile });
}
