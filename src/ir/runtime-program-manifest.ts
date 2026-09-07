// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Source-free runtime preparation and validated replay attachment. Physical helpers remain backend-owned. */
import {
  assertPreparedIrAsyncRuntimeCurrent,
  irAsyncPlanNeedsNumberBridge,
  preparedIrAsyncFrameCapabilityFailure,
} from "./async-plan.js";
import type { IrUnitId } from "./identity.js";
import {
  IrRuntimeFunctionPreparationError,
  prepareIrRuntimeManifest,
  type IrRuntimeManifestDemands,
  type PreparedIrRuntimeManifest,
} from "./intrinsic-support.js";
import { INTRINSIC_DEFINITIONS, type IntrinsicSourceLocation } from "./intrinsics.js";
import { forEachInstrDeep, type IrFunction } from "./nodes.js";
import { classifyIrFailure, IrInvariantError, type IrPreparationFailure } from "./outcomes.js";
import {
  PreparedIrProgramInvariantError,
  preparedIrProgramOwner,
  preparedIrReadonlyMap,
  type PreparedIrProgramFailure,
  type PreparedIrProgramProducerInput,
} from "./program.js";
import { assertPreparedIrProgramPopulation } from "./program-population.js";
import { irRuntimeCallableDeclaration } from "./runtime-callable-declarations.js";
import {
  FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES,
  GENERATOR_NUMBER_BOX_RUNTIME_FEATURES,
  HOST_CALLBACK_WRAP_RUNTIME_FEATURES,
  STRING_CHAR_CODE_AT_RUNTIME_FEATURES,
  STRING_COMPARE_RUNTIME_FEATURES,
  STRING_CONCAT_MANY_RUNTIME_FEATURES,
  STRING_CONCAT_RUNTIME_FEATURES,
  STRING_CONST_RUNTIME_FEATURES,
  STRING_EQ_RUNTIME_FEATURES,
  STRING_LEN_RUNTIME_FEATURES,
  RuntimeManifestInvariantError,
  type RuntimeFeature,
} from "./runtime-manifest.js";

type ProducerInput = PreparedIrProgramProducerInput;

export function locatedFailure(
  input: ProducerInput,
  unitId: IrUnitId,
  failure: IrPreparationFailure,
): PreparedIrProgramFailure {
  const owner = preparedIrProgramOwner(input, unitId);
  if (!owner) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      `runtime producer cannot locate ${unitId}: ${failure.detail}`,
    );
  }
  // Error instances/callbacks must not escape into the serializable diagnostic contract.
  const { cause: _cause, ...diagnostic } = failure;
  return Object.freeze({ ...diagnostic, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile });
}

export function invariant(input: ProducerInput, unitId: IrUnitId, detail: string): PreparedIrProgramFailure {
  return locatedFailure(input, unitId, { kind: "invariant", code: "verifier-failure", stage: "verify", detail });
}

export function checkFunctionPopulation(input: ProducerInput): PreparedIrProgramFailure | undefined {
  assertPreparedIrProgramPopulation(input);
  for (const fn of input.ir.functions) {
    if (fn.asyncRuntime) {
      return invariant(
        input,
        fn.unitId,
        `semantic input ${fn.name} already carries a physical async runtime projection`,
      );
    }
  }
  return undefined;
}

/** Feature requests from existing caller-owned semantic scans; no provider is chosen here. */
function demandFeatures(demand: IrRuntimeManifestDemands): readonly RuntimeFeature[] {
  const features: RuntimeFeature[] = [];
  if (demand.generatorNumberBoxDemand) features.push(GENERATOR_NUMBER_BOX_RUNTIME_FEATURES[0]);
  if (demand.stringCompareDemand) features.push(STRING_COMPARE_RUNTIME_FEATURES[0]);
  if (demand.stringEqDemand) features.push(STRING_EQ_RUNTIME_FEATURES[0]);
  if (demand.stringLenDemand) features.push(STRING_LEN_RUNTIME_FEATURES[0]);
  if (demand.stringConcatDemand?.immutable) features.push(STRING_CONCAT_RUNTIME_FEATURES[0]);
  if (demand.stringConcatDemand?.owned) features.push(STRING_CONCAT_RUNTIME_FEATURES[1]);
  if (demand.stringCharCodeAtDemand) features.push(STRING_CHAR_CODE_AT_RUNTIME_FEATURES[0]);
  if (demand.stringConcatManyDemand?.arities.length) features.push(STRING_CONCAT_MANY_RUNTIME_FEATURES[0]);
  if (demand.stringConstDemand?.literal) features.push(STRING_CONST_RUNTIME_FEATURES[0]);
  if (demand.stringConstDemand?.utf16) features.push(STRING_CONST_RUNTIME_FEATURES[1]);
  if (demand.hostCallbackWrapDemand?.host || demand.hostCallbackWrapDemand?.nativeDispatch)
    features.push(HOST_CALLBACK_WRAP_RUNTIME_FEATURES[0]);
  if (demand.functionPrototypeCallDemand) features.push(FUNCTION_PROTOTYPE_CALL_RUNTIME_FEATURES[0]);
  return features;
}

function mergeDemands(demands: readonly IrRuntimeManifestDemands[]): IrRuntimeManifestDemands {
  return {
    generatorNumberBoxDemand: demands.some((demand) => demand.generatorNumberBoxDemand),
    stringCompareDemand: demands.some((demand) => demand.stringCompareDemand),
    stringEqDemand: demands.some((demand) => demand.stringEqDemand),
    stringLenDemand: demands.some((demand) => demand.stringLenDemand),
    stringConcatDemand: {
      immutable: demands.some((demand) => demand.stringConcatDemand?.immutable),
      owned: demands.some((demand) => demand.stringConcatDemand?.owned),
    },
    stringCharCodeAtDemand: demands.some((demand) => demand.stringCharCodeAtDemand),
    stringConcatManyDemand: {
      arities: [...new Set(demands.flatMap((demand) => demand.stringConcatManyDemand?.arities ?? []))].sort(
        (left, right) => left - right,
      ),
    },
    stringConstDemand: {
      literal: demands.some((demand) => demand.stringConstDemand?.literal),
      utf16: demands.some((demand) => demand.stringConstDemand?.utf16),
    },
    hostCallbackWrapDemand: {
      host: demands.some((demand) => demand.hostCallbackWrapDemand?.host),
      nativeDispatch: demands.some((demand) => demand.hostCallbackWrapDemand?.nativeDispatch),
    },
    functionPrototypeCallDemand: demands.some((demand) => demand.functionPrototypeCallDemand),
  };
}

export interface PrepareWholeProgramRuntimeManifestInput extends ProducerInput {
  /** One explicit result of the existing semantic scans for EVERY final artifact. */
  readonly demands: ReadonlyMap<IrUnitId, IrRuntimeManifestDemands>;
}

export type PreparedWholeProgramRuntimeManifest =
  | { readonly kind: "prepared"; readonly runtime: PreparedIrRuntimeManifest }
  | PreparedIrProgramFailure;

/** Freeze the single provider graph for the final complete program, including empty programs. */
export function prepareWholeProgramRuntimeManifest(
  input: PrepareWholeProgramRuntimeManifestInput,
): PreparedWholeProgramRuntimeManifest {
  const populationFailure = checkFunctionPopulation(input);
  if (populationFailure) return populationFailure;
  const sourceLocationsByUnit = new Map<IrUnitId, IntrinsicSourceLocation>();
  const requestOwners = new Map<RuntimeFeature, IrUnitId>();
  for (const fn of input.ir.functions) {
    const owner = preparedIrProgramOwner(input, fn.unitId)!;
    const demand = input.demands.get(fn.unitId);
    if (fn.funcKind === "async" && !fn.asyncPlan) {
      return invariant(input, fn.unitId, `semantic async plan is missing for ${fn.name}`);
    }
    if (!demand) return invariant(input, fn.unitId, `runtime demand scan is missing for ${fn.name}`);
    if (
      fn.asyncPlan &&
      irAsyncPlanNeedsNumberBridge(fn.asyncPlan) &&
      !fn.asyncPlan.runtimeIntents.includes("promise.number.bridge")
    ) {
      return invariant(input, fn.unitId, `numeric Promise bridge intent is missing for ${fn.name}`);
    }
    sourceLocationsByUnit.set(fn.unitId, {
      file: owner.sourceFile,
      line: owner.location.line,
      column: owner.location.column,
    });
    const features = [...demandFeatures(demand), ...(fn.asyncPlan?.runtimeIntents ?? [])];
    const note = (feature: RuntimeFeature): void => {
      if (!requestOwners.has(feature)) requestOwners.set(feature, fn.unitId);
    };
    features.forEach(note);
    const scan = (roots: IrFunction["blocks"][number]["instrs"]): void => {
      for (const root of roots)
        forEachInstrDeep(root, (instr) => {
          if (instr.kind === "intrinsic" && INTRINSIC_DEFINITIONS[instr.id])
            note(INTRINSIC_DEFINITIONS[instr.id].feature);
          if (instr.kind === "call" || instr.kind === "closure.new") {
            const declaration = irRuntimeCallableDeclaration(instr.kind === "call" ? instr.target : instr.liftedFunc);
            if (declaration) note(declaration.feature);
          }
        });
    };
    for (const block of fn.blocks) scan(block.instrs);
    for (const state of fn.asyncPlan?.states ?? []) scan(state.body);
  }
  for (const unitId of input.demands.keys()) {
    if (!sourceLocationsByUnit.has(unitId))
      return invariant(input, unitId, `runtime demand scan names absent artifact ${unitId}`);
  }
  try {
    const runtime = prepareIrRuntimeManifest({
      functions: input.ir.functions,
      // Every nonempty function population has exact entries above. Empty manifests contain no use locations.
      sourceFile: "",
      sourceLocationsByUnit,
      policy: input.policy,
      includeEmpty: true,
      ...mergeDemands([...input.demands.values()]),
    });
    for (const fn of runtime.functions) {
      if (!fn.asyncRuntime) continue;
      const current = assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime);
      const failure = preparedIrAsyncFrameCapabilityFailure(current);
      if (failure)
        return locatedFailure(input, fn.unitId, {
          kind: "unsupported",
          code: "body-shape-rejected",
          stage: "resolve",
          detail: failure,
        });
    }
    return Object.freeze({
      kind: "prepared",
      runtime: Object.freeze({ ...runtime, providers: preparedIrReadonlyMap(runtime.providers) }),
    });
  } catch (error) {
    if (error instanceof IrRuntimeFunctionPreparationError) {
      const failure =
        error.cause instanceof RuntimeManifestInvariantError
          ? {
              kind: "invariant" as const,
              code: "verifier-failure" as const,
              stage: "verify" as const,
              detail: error.message,
            }
          : classifyIrFailure(error.cause, "verify");
      return locatedFailure(input, error.unitId, failure);
    }
    if (error instanceof RuntimeManifestInvariantError && error.requestedFeature) {
      const unitId = requestOwners.get(error.requestedFeature);
      if (unitId) {
        if (error.code === "missing-backend-adapter" || error.code === "provider-target-unavailable") {
          return locatedFailure(input, unitId, {
            kind: "unsupported",
            code: "body-shape-rejected",
            stage: "build",
            detail: error.message,
          });
        }
        return invariant(input, unitId, error.message);
      }
    }
    // Policy/catalogue failures have no source owner. Do not manufacture one from the first file.
    throw new IrInvariantError("verifier-failure", "verify", error instanceof Error ? error.message : String(error));
  }
}
