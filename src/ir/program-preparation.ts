// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { prepareIrProgramSources, captureTypedIrProgramInput, type IrProgramSourceInput } from "./program-source.js";
import { resolveIrPreparationControlsFromEnv } from "./program-middleend.js";
import { createGvnCounters } from "./passes/gvn-core.js";
import { recordLegacyGvnCountersOnce } from "./passes/gvn.js";
import { prepareTypedIrProgram } from "./program-prepare-ir.js";
import { preparedIrDataMismatch, PreparedIrProgramInvariantError, type IrProgramPreparationResult } from "./program.js";
import { observePreparedIrProgram } from "./program-observation.js";
import type { RuntimeManifestPolicy } from "./runtime-manifest.js";

export interface IrWholeProgramPreparationInput extends IrProgramSourceInput {
  /** Internal resolved projection requests; all consume the same semantic module. */
  readonly runtimePolicies?: readonly RuntimeManifestPolicy[];
}

/** One complete preparation before any backend has permission to allocate or emit. */
export function prepareWholeIrProgram(input: IrWholeProgramPreparationInput): IrProgramPreparationResult {
  const policies = input.runtimePolicies ?? [input.policy];
  const keys = new Set(policies.map((policy) => `${policy.backend}:${policy.target}`));
  if (
    keys.size !== policies.length ||
    !policies.some((policy) => preparedIrDataMismatch(policy, input.policy) === undefined)
  ) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "runtime policies duplicate a backend/target pair or omit the source preparation policy",
    );
  }
  const source = prepareIrProgramSources(input);
  if (source.kind !== "prepared") return source;
  const typed = captureTypedIrProgramInput(source);
  const controls = resolveIrPreparationControlsFromEnv();
  const counters = createGvnCounters();
  let result: IrProgramPreparationResult;
  try {
    result = prepareTypedIrProgram(typed, { policy: input.policy, runtimePolicies: policies, controls }, counters);
  } finally {
    recordLegacyGvnCountersOnce(counters);
  }
  if (result.kind === "prepared")
    observePreparedIrProgram({
      phase: "prepared",
      program: result.program,
      backend: input.policy.backend,
      target: input.policy.target,
    });
  return result;
}
