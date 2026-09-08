// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ownTypedIrProgramInput, ownTypedIrProgramOptions } from "./program-input.js";
import type { TypedIrProgramInput, TypedIrProgramOptions } from "./program/input-contracts.js";
import { createGvnCounters, type GvnCounters } from "./passes/gvn-core.js";
import { optimizePreparedIrProgramIr } from "./program-middleend-ir.js";
import { prepareIrProgramAbiEntries, preparedIrDraftAbiLookup } from "./program-abi-contracts.js";
import { assertPreparedIrProgramPopulation } from "./program-population.js";
import { prepareIrProgramRuntimeCallables } from "./program-runtime-abi.js";
import { prepareWholeProgramAsyncFunctions, prepareWholeProgramRuntimeManifest } from "./runtime-program-producers.js";
import { irProgramRuntimeDemands } from "./program-runtime-demands.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import {
  freezePreparedIrValue,
  freezePreparedIrRuntimeValue,
  preparedIrReadonlyMap,
  PreparedIrProgramInvariantError,
} from "./program.js";
import type {
  IrProgramPreparationResult,
  PreparedIrProgram,
  PreparedIrProgramRuntimeProjection,
} from "./program/prepared-contracts.js";

function assertCounters(counters: GvnCounters): void {
  const keys = ["functions", "merged", "poisoned"];
  if (
    !counters ||
    Object.getPrototypeOf(counters) !== null ||
    !Object.isSealed(counters) ||
    Reflect.ownKeys(counters).length !== keys.length ||
    keys.some((key) => {
      const property = Object.getOwnPropertyDescriptor(counters, key);
      return (
        !property ||
        !("value" in property) ||
        !property.writable ||
        !Number.isSafeInteger(property.value) ||
        property.value < 0
      );
    })
  )
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", "invalid preparation diagnostic counters");
}

/**
 * Own the typed transaction; no frontend, environment, legacy telemetry or
 * observation. Uses the internal input contract on TypedIrProgramInput; this
 * does not relax compiler handling of invalid or adversarial JavaScript source.
 */
export function prepareTypedIrProgram(
  input: TypedIrProgramInput,
  options: TypedIrProgramOptions,
  counters: GvnCounters = createGvnCounters(),
): IrProgramPreparationResult {
  assertCounters(counters);
  const resolved = ownTypedIrProgramOptions(options);
  const { input: source, allocations } = ownTypedIrProgramInput(input);
  assertPreparedIrProgramPopulation(source);
  const initialRuntime = prepareIrProgramRuntimeCallables(source);
  if (initialRuntime.kind !== "prepared") return initialRuntime;
  const initialEntries = prepareIrProgramAbiEntries(source, initialRuntime.declarations);
  const async = prepareWholeProgramAsyncFunctions({
    inventory: source.inventory,
    ir: source.ir,
    derivedUnits: source.derivedUnits,
    abi: preparedIrDraftAbiLookup(initialEntries),
    policy: resolved.policy,
  });
  if (async.kind !== "prepared") return async;
  const transformed = { ...source, ir: { ...source.ir, functions: async.functions }, derivedUnits: async.derivedUnits };
  const transformedRuntime = prepareIrProgramRuntimeCallables(transformed);
  if (transformedRuntime.kind !== "prepared") return transformedRuntime;
  const optimized = optimizePreparedIrProgramIr(
    {
      inventory: transformed.inventory,
      ir: transformed.ir,
      derivedUnits: transformed.derivedUnits,
      abi: preparedIrDraftAbiLookup(prepareIrProgramAbiEntries(transformed, transformedRuntime.declarations)),
      policy: resolved.policy,
    },
    allocations,
    resolved.controls,
    counters,
  );
  const finalSource = { ...source, ...optimized };
  const finalRuntime = prepareIrProgramRuntimeCallables(finalSource);
  if (finalRuntime.kind !== "prepared") return finalRuntime;
  const entries = prepareIrProgramAbiEntries(finalSource, finalRuntime.declarations);
  // Freeze semantic data BEFORE runtime attachments authenticate exact identities.
  // Attached objects must never be cloned after authentication.
  const semantic = freezePreparedIrValue({
    inventory: source.inventory,
    ...optimized,
    abi: { entries },
    startup: source.startup,
    allocations: allocations.snapshot(),
  }) as Pick<PreparedIrProgram, "inventory" | "ir" | "derivedUnits" | "abi" | "startup" | "allocations">;
  const runtime: PreparedIrProgramRuntimeProjection[] = [];
  const demands = new Map(semantic.ir.functions.map((fn) => [fn.unitId, irProgramRuntimeDemands(fn)]));
  for (const policy of resolved.runtimePolicies) {
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
  assertPreparedIrProgram(program, { verifyDominanceNaive: resolved.controls.verifyDominanceNaive });
  return { kind: "prepared", program };
}
