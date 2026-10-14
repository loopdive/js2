// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrPreparationFailure } from "../../shared/contracts/ir-preparation-failure.js";
import { preparedIrProgramOwner } from "./owner.js";
import type { PreparedIrProgram, PreparedIrProgramFailure } from "./prepared-contracts.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export function physicalSetupFailure(
  program: PreparedIrProgram,
  options: { readonly backend: string; readonly target: string },
  rows: readonly { readonly unitId: IrUnitId | undefined; readonly detail: string }[],
  firstUnit: IrUnitId | undefined,
): PreparedIrProgramFailure | undefined {
  if (rows.length > 0) {
    const first = rows[0]!;
    const unitId = first.unitId ?? firstUnit ?? program.inventory.terminalUnits[0]?.id;
    if (!unitId) {
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", `physical plan: ${first.detail}`);
    }
    const failure: IrPreparationFailure = {
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "build",
      detail: `${options.backend}:${options.target} physical setup cannot be materialized (${rows.length} gap${
        rows.length === 1 ? "" : "s"
      }): ${rows.map((row) => row.detail).join("; ")}`,
    };
    const owner = preparedIrProgramOwner(program, unitId);
    if (!owner)
      throw new PreparedIrProgramInvariantError("invalid-prepared-data", `physical plan cannot locate ${unitId}`);
    return Object.freeze({ ...failure, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile });
  }

  return undefined;
}
