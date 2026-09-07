// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../ir/program-consumer.js";
import { prepareWholeIrProgram, type IrWholeProgramPreparationInput } from "../ir/program-preparation.js";
import { freezePreparedIrValue, type PreparedIrBackendOptions } from "../ir/program.js";
import { IrProgramDriverInvariantError, type IrProgramDriverResult } from "./ir-program-result.js";

/**
 * Internal synchronous transaction over an already analyzed complete graph.
 * Public cutover awaits the metadata/coverage contracts in the lane A handoff.
 * No finalizer may infer public metadata from an empty physical-module field.
 */
export function runIrProgramDriver(
  input: IrWholeProgramPreparationInput,
  options: PreparedIrBackendOptions,
): IrProgramDriverResult {
  // Snapshot data-only target/output options before preparation can notify observers.
  const backendOptions = freezePreparedIrValue(options) as PreparedIrBackendOptions;
  const policy = freezePreparedIrValue(input.policy) as IrWholeProgramPreparationInput["policy"];
  const runtimePolicies =
    input.runtimePolicies &&
    (freezePreparedIrValue(input.runtimePolicies) as IrWholeProgramPreparationInput["runtimePolicies"]);
  const prepared = prepareWholeIrProgram({ ...input, policy, runtimePolicies });
  if (prepared.kind === "invariant") throw new IrProgramDriverInvariantError(prepared);
  if (prepared.kind === "unsupported") {
    return Object.freeze({ kind: "unsupported", phase: "preparation", failure: prepared });
  }
  const accepted = acceptPreparedIrProgram(prepared.program, backendOptions);
  if (accepted.kind === "invariant") throw new IrProgramDriverInvariantError(accepted);
  if (accepted.kind === "unsupported") {
    return Object.freeze({ kind: "unsupported", phase: "acceptance", failure: accepted });
  }
  // C authenticates and consumes this exact token once. Exceptions stay fatal.
  const emission = emitAcceptedIrProgram(accepted);
  return Object.freeze({ kind: "emitted", program: prepared.program, emission });
}
