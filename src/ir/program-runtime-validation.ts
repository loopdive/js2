// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { assertPreparedIrAsyncRuntimeCurrent } from "./async-plan.js";
import { forEachInstrDeep } from "./nodes.js";
import { preparedIrDraftAbiLookup } from "./program-abi-contracts.js";
import { irProgramRuntimeDemands } from "./program-runtime-demands.js";
import { prepareWholeProgramRuntimeManifest } from "./runtime-program-manifest.js";
import {
  preparedIrDataMismatch,
  PreparedIrProgramInvariantError,
  type PreparedIrProgram,
  type PreparedIrProgramRuntimeProjection,
} from "./program.js";

/** The shared IR owns meaning; provider and runtime attachments belong only to projections. */
export function assertPreparedIrSemanticRuntimeSeparation(program: Pick<PreparedIrProgram, "ir">): void {
  for (const fn of program.ir.functions) {
    if (fn.asyncRuntime)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `semantic body ${fn.unitId} contains a runtime attachment`,
      );
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((state) => state.body) ?? []),
    ]) {
      for (const root of buffer)
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "intrinsic" && instruction.provider !== undefined) {
            throw new PreparedIrProgramInvariantError(
              "invalid-prepared-data",
              `semantic body ${fn.unitId} contains a physical intrinsic provider`,
            );
          }
        });
    }
  }
}

/** Reuse B's deterministic pure producer to check every field; never replace contradictory evidence. */
export function assertPreparedIrRuntimeProjection(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): void {
  const key = `${projection.backend}:${projection.target}`;
  const expected = prepareWholeProgramRuntimeManifest({
    inventory: program.inventory,
    ir: program.ir,
    derivedUnits: program.derivedUnits,
    // The caller validated the complete ABI already. Re-entering the public lookup would recurse.
    abi: preparedIrDraftAbiLookup(program.abi.entries),
    policy: projection.prepared.manifest.policy,
    demands: new Map(program.ir.functions.map((fn) => [fn.unitId, irProgramRuntimeDemands(fn)])),
  });
  if (expected.kind !== "prepared")
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `runtime projection ${key} cannot be reproduced: ${expected.detail}`,
    );
  const mismatch = preparedIrDataMismatch(expected.runtime, projection.prepared);
  if (mismatch !== undefined)
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `runtime projection ${key} contradicts complete semantic/provider data at ${mismatch}`,
    );
  for (const fn of projection.prepared.functions) {
    if (!fn.asyncPlan && !fn.asyncRuntime) continue;
    const current = assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime);
    if (current.manifest !== projection.prepared.manifest)
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-data",
        `runtime owner ${fn.unitId} is attached to a foreign manifest`,
      );
  }
}
