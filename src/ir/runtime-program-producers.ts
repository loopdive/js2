// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Pure complete-program async production. Physical runtime helpers are allocated by the accepted backend. */
import { createIrAsyncPlan, irAsyncPlanNeedsNumberBridge, verifyIrAsyncPlan } from "./async-plan.js";
import { prepareSuspendingIrFunction } from "./async-prepare.js";
import { createDerivedIrUnitId } from "./identity.js";
import { forEachInstrDeep, type IrFunction } from "./nodes.js";
import { classifyIrFailure } from "./outcomes.js";
import {
  preparedIrProgramOwner,
  type PreparedIrProgramFailure,
  type PreparedIrProgramProducerInput,
} from "./program.js";
import type { ProgramAbiDerivedUnitRecord } from "./program-abi.js";
import { assertPreparedIrProgramPopulation } from "./program-population.js";
import { checkFunctionPopulation, invariant, locatedFailure } from "./runtime-program-manifest.js";

export {
  prepareWholeProgramRuntimeManifest,
  type PrepareWholeProgramRuntimeManifestInput,
  type PreparedWholeProgramRuntimeManifest,
} from "./runtime-program-manifest.js";

type ProducerInput = PreparedIrProgramProducerInput;

export type PreparedWholeProgramAsyncFunctions =
  | {
      readonly kind: "prepared";
      /** Complete population, including untouched ordinary bodies and newly derived states. */
      readonly functions: readonly IrFunction[];
      /** Complete provenance, including records already present in the producer input. */
      readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
    }
  | PreparedIrProgramFailure;

function withNumberBridge(fn: IrFunction): IrFunction {
  const plan = fn.asyncPlan;
  if (!plan || !irAsyncPlanNeedsNumberBridge(plan) || plan.runtimeIntents.includes("promise.number.bridge")) return fn;
  return {
    ...fn,
    asyncPlan: createIrAsyncPlan({ ...plan, runtimeIntents: [...plan.runtimeIntents, "promise.number.bridge"] }),
  };
}

/** Prepare every async owner from typed IR, without selector-mediated admission or backend allocation. */
export function prepareWholeProgramAsyncFunctions(input: ProducerInput): PreparedWholeProgramAsyncFunctions {
  const populationFailure = checkFunctionPopulation(input);
  if (populationFailure) return populationFailure;
  const functions: IrFunction[] = [];
  const derivedUnits = [...input.derivedUnits];
  const reservedIds = new Set([...input.ir.functions.map((fn) => fn.unitId), ...derivedUnits.map((unit) => unit.id)]);
  for (const fn of input.ir.functions) {
    try {
      if (fn.funcKind !== "async") {
        let hasAwait = false;
        for (const block of fn.blocks) {
          for (const root of block.instrs)
            forEachInstrDeep(root, (instr) => {
              hasAwait ||= instr.kind === "await";
            });
        }
        if (fn.asyncPlan || hasAwait)
          return invariant(input, fn.unitId, `non-async owner ${fn.name} carries async semantics`);
        functions.push(fn);
        continue;
      }
      if (fn.asyncPlan) {
        const errors = verifyIrAsyncPlan(fn.asyncPlan);
        if (fn.asyncPlan.ownerUnitId !== fn.unitId || errors.length > 0) {
          return invariant(
            input,
            fn.unitId,
            `invalid async plan for ${fn.name}: ${errors.map((error) => error.message).join("; ") || "owner mismatch"}`,
          );
        }
        functions.push(withNumberBridge({ ...fn, asyncPlan: createIrAsyncPlan(fn.asyncPlan) }));
        continue;
      }
      const prepared = prepareSuspendingIrFunction(fn, input.policy.numberBoundary);
      if (!prepared) {
        return locatedFailure(input, fn.unitId, {
          kind: "unsupported",
          code: "body-shape-rejected",
          stage: "build",
          detail: `async-plan producer cannot represent the complete body of ${fn.name}`,
        });
      }
      const owner = preparedIrProgramOwner(input, fn.unitId)!;
      if (prepared.stateFunctions.length !== prepared.provenance.length) {
        return invariant(input, fn.unitId, `async state provenance is incomplete for ${fn.name}`);
      }
      for (let index = 0; index < prepared.stateFunctions.length; index++) {
        const state = prepared.stateFunctions[index]!;
        const provenance = prepared.provenance[index]!;
        if (
          provenance.id !== state.unitId ||
          provenance.parentId !== fn.unitId ||
          provenance.role !== "ir-async-state" ||
          createDerivedIrUnitId(provenance) !== state.unitId ||
          reservedIds.has(state.unitId)
        ) {
          return invariant(
            input,
            fn.unitId,
            `async state ${state.name} has conflicting derived identity or provenance`,
          );
        }
        reservedIds.add(state.unitId);
        derivedUnits.push(
          Object.freeze({ ...provenance, terminalOwnerId: owner.unitId, sourceId: owner.location.sourceId }),
        );
      }
      functions.push(withNumberBridge(prepared.main), ...prepared.stateFunctions);
    } catch (error) {
      return locatedFailure(input, fn.unitId, classifyIrFailure(error, "build"));
    }
  }
  assertPreparedIrProgramPopulation({ ...input, ir: { ...input.ir, functions }, derivedUnits });
  return Object.freeze({
    kind: "prepared",
    functions: Object.freeze(functions),
    derivedUnits: Object.freeze(derivedUnits),
  });
}
