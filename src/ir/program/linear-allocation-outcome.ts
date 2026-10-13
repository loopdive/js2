// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { IrUnsupportedError } from "../../shared/contracts/ir-preparation-errors.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import { forEachInstrDeep } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { PreparedLinearMemoryInput } from "./linear-allocation-facts.js";
import { assertPreparedIrProgramLinearAllocationEvidence } from "./validation.js";
import type {
  PreparedIrProgram,
  PreparedIrProgramRuntimeProjection,
  PreparedIrProgramFailure,
} from "./prepared-contracts.js";

/** Adapt only a canonical located required-allocation capability refusal. */
export function preparedLinearAllocationOutcome(
  error: unknown,
): Extract<PreparedIrProgramFailure, { kind: "unsupported" }> {
  if (!(error instanceof IrUnsupportedError)) throw error;
  const located = error.cause as
    | Partial<Pick<PreparedIrProgramFailure, "unitId" | "location" | "sourceFile">>
    | undefined;
  if (!located?.unitId || !located.location || typeof located.sourceFile !== "string")
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "required Linear allocation refusal lacks canonical location",
    );
  return Object.freeze({
    kind: "unsupported",
    code: error.code,
    stage: error.stage,
    detail: error.message,
    cause: error.cause,
    unitId: located.unitId,
    location: located.location,
    sourceFile: located.sourceFile,
  });
}

/** Locate only the authenticated first fact's actual owner; this grants no resources. */
function checkedLinearAllocationOwner(input: PreparedLinearMemoryInput | undefined): IrUnitId | undefined {
  const firstSite = input?.facts.allocations[0]?.id;
  return input?.module.functions.find((fn) => {
    let found = false;
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ])
      for (const root of buffer)
        forEachInstrDeep(root, (instr) => {
          found ||= firstSite !== undefined && instr.alloc === firstSite;
        });
    return found;
  })?.unitId;
}

/** Acquire before the physical caller reads projection/ABI data or allocates resources. */
export function acquirePreparedLinearAllocation(
  program: PreparedIrProgram,
  options: { readonly backend: string; readonly target: string },
  projection: PreparedIrProgramRuntimeProjection,
):
  | { readonly kind: "checked"; readonly input: PreparedLinearMemoryInput | undefined }
  | Extract<PreparedIrProgramFailure, { kind: "unsupported" }> {
  if (options.backend !== "linear" || (options.target !== "standalone" && options.target !== "wasi"))
    return { kind: "checked", input: undefined };
  try {
    return { kind: "checked", input: assertPreparedIrProgramLinearAllocationEvidence(program, projection) };
  } catch (error) {
    return preparedLinearAllocationOutcome(error);
  }
}

/** Retain the located allocation gap until genuine resources are materializable. */
export function addPreparedLinearAllocationGap(
  program: PreparedIrProgram,
  options: { readonly backend: string },
  input: PreparedLinearMemoryInput | undefined,
  gaps: { add(detail: string, unitId?: IrUnitId): void },
): void {
  if (options.backend === "linear" && program.allocations.size > 0)
    gaps.add(
      `linear memory plan for ${program.allocations.size} allocation site(s) is not materializable`,
      checkedLinearAllocationOwner(input),
    );
}

export class Gaps {
  readonly rows: { readonly unitId: IrUnitId | undefined; readonly detail: string }[] = [];
  add(detail: string, unitId?: IrUnitId): void {
    this.rows.push({ unitId, detail });
  }
}
