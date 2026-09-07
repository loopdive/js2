// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { prepareIrProgramSources, type IrProgramSourceInput } from "./program-source.js";
import { prepareIrProgramAbiEntries, preparedIrDraftAbiLookup } from "./program-abi-contracts.js";
import { assertPreparedIrProgramPopulation } from "./program-population.js";
import { prepareIrProgramRuntimeCallables } from "./program-runtime-abi.js";
import { optimizePreparedIrProgram } from "./program-middleend.js";
import { prepareWholeProgramAsyncFunctions, prepareWholeProgramRuntimeManifest } from "./runtime-program-producers.js";
import { irProgramRuntimeDemands } from "./program-runtime-demands.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import {
  freezePreparedIrValue,
  freezePreparedIrRuntimeValue,
  preparedIrReadonlyMap,
  preparedIrDataMismatch,
  PreparedIrProgramInvariantError,
  type IrProgramPreparationResult,
  type PreparedIrProgram,
  type PreparedIrProgramRuntimeProjection,
} from "./program.js";
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
  assertPreparedIrProgramPopulation(source);
  const initialRuntime = prepareIrProgramRuntimeCallables(source);
  if (initialRuntime.kind !== "prepared") return initialRuntime;
  const initialEntries = prepareIrProgramAbiEntries(source, initialRuntime.declarations);
  const async = prepareWholeProgramAsyncFunctions({
    ...source,
    abi: preparedIrDraftAbiLookup(initialEntries),
    policy: input.policy,
  });
  if (async.kind !== "prepared") return async;
  const transformed = { ...source, ir: { ...source.ir, functions: async.functions }, derivedUnits: async.derivedUnits };
  const transformedRuntime = prepareIrProgramRuntimeCallables(transformed);
  if (transformedRuntime.kind !== "prepared") return transformedRuntime;
  const optimized = optimizePreparedIrProgram(
    {
      ...transformed,
      abi: preparedIrDraftAbiLookup(prepareIrProgramAbiEntries(transformed, transformedRuntime.declarations)),
      policy: input.policy,
    },
    source.allocations,
  );
  const finalSource = { ...source, ...optimized };
  const finalRuntime = prepareIrProgramRuntimeCallables(finalSource);
  if (finalRuntime.kind !== "prepared") return finalRuntime;
  const entries = prepareIrProgramAbiEntries(finalSource, finalRuntime.declarations);
  // Clone/freeze semantic data BEFORE runtime attachments authenticate exact
  // plan/manifest identities. Never clone the attached result afterward.
  const semantic = freezePreparedIrValue({
    inventory: source.inventory,
    ...optimized,
    abi: { entries },
    startup: source.startup,
    allocations: source.allocations.snapshot(),
  }) as Pick<PreparedIrProgram, "inventory" | "ir" | "derivedUnits" | "abi" | "startup" | "allocations">;
  const runtime: PreparedIrProgramRuntimeProjection[] = [];
  const demands = new Map(semantic.ir.functions.map((fn) => [fn.unitId, irProgramRuntimeDemands(fn)]));
  for (const policy of policies) {
    const projection = prepareWholeProgramRuntimeManifest({
      ...semantic,
      abi: preparedIrDraftAbiLookup(semantic.abi.entries),
      policy,
      demands,
    });
    if (projection.kind !== "prepared") return projection;
    freezePreparedIrRuntimeValue(projection.runtime);
    runtime.push(Object.freeze({ backend: policy.backend, target: policy.target, prepared: projection.runtime }));
  }
  const program: PreparedIrProgram = Object.freeze({
    schema: "prepared-ir-program-v1",
    ...semantic,
    units: preparedIrReadonlyMap(semantic.inventory.terminalUnits.map((unit) => [unit.id, unit])),
    runtime: Object.freeze(runtime),
    reconciliation: "complete",
    sealed: true,
  });
  assertPreparedIrProgram(program);
  observePreparedIrProgram({ phase: "prepared", program, backend: input.policy.backend, target: input.policy.target });
  return { kind: "prepared", program };
}
