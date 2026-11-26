// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrUnitInventory } from "../../shared/contracts/ir-unit-inventory.js";
import type { IrPreparationFailure } from "../../shared/contracts/ir-preparation-failure.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import type {
  PreparedIrProgramFailure,
  PreparedIrProgramProducerInput,
  PreparedIrProgramOwner,
  PreparedIrSourceLocation,
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
  return owner && ownerAt(input.inventory, owner.id, owner);
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
type FailureOwner<U extends IrUnitId | null = IrUnitId | null> = Omit<PreparedIrProgramOwner, "unitId"> & {
  readonly unitId: U;
};

/** A failure owner at `location`, resolved against the inventory's source records. */
export function ownerAt<U extends IrUnitId | null>(
  inventory: IrUnitInventory,
  unitId: U,
  location: PreparedIrSourceLocation,
): FailureOwner<U> | undefined {
  const sourceRecord = inventory.sources.find((record) => record.id === location.sourceId);
  if (!sourceRecord) return undefined;
  const { sourceId, line, column, declarationStart, declarationEnd } = location;
  return Object.freeze({
    unitId,
    sourceFile: sourceRecord.sourceKey,
    location: Object.freeze({ sourceId, line, column, declarationStart, declarationEnd }),
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
