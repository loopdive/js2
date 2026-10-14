// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3518 package C — the backend consumer of the production `PreparedIrProgram`
// (package A's schema, acceptance and emission types), in ONE module so that
// every authority is module-private:
//
//   acceptPreparedIrProgram(program, options)  →  PreparedIrBackendAcceptance
//   emitAcceptedIrProgram(accepted)            →  EmittedPreparedIrProgram
//
// Acceptance decides everything that can be known before emission, in order:
// A's complete validator; exact backend/target runtime projection selection;
// in-program body closure of every unit call on the PHYSICAL functions of that
// projection; the backend's own legality verdict per body; and the complete
// source-free physical setup plan (imports, globals, slots, exports with their
// index space, startup adapter, exception tag). Anything this increment cannot
// materialize is a located typed `unsupported` here — never a smaller module
// later. The plan is deep-frozen; the copy exposed for evidence cannot change
// what emission builds.
//
// Emission takes one argument and builds the physical setup itself. The
// acceptance token is consumed exactly once; the `accepted`,
// `emission-started` and `emitted` observations are raised only from this
// module — `emitted` only after construction succeeded — so no caller can
// forge, repeat or skip a phase. C owns these three phases; A emits `prepared`.
//
// Physical allocation is owned by the Wasm module reservation ledger. This
// consumer imports no source frontend, checker or legacy CodegenContext.

import {
  planNativeInvocationRequirements,
  assertNativeInvocationRequirementsCurrent,
  type NativeInvocationRequirements,
} from "./program/native-invocation-requirements.js";
import {
  deriveNativeRealmRequirements,
  assertNativeRealmRequirementsCurrent,
  type NativeRealmRequirements,
} from "./program/native-realm-requirements.js";
import {
  prepareNativeProgramStringInput,
  reserveNativeProgramFoundation,
  reserveNativeRealmKernel,
  nativeRealmReservationInventory,
  fillNativeRealmResources,
  requireCompletedNativeRealmBootstrap,
} from "../backend/wasmgc/program/native-realm.js";
import {
  reserveNativeInvocationResources,
  nativeInvocationFunctions,
  fillNativeInvocationResources,
  requireCompletedNativeInvocation,
} from "../backend/wasmgc/resources/native-invocation.js";
import { nativeSourceClosureCallableBindings } from "./program-native-invocation.js";
import {
  reservePreparedAsyncFrame,
  fillPreparedAsyncFrame,
  type PreparedAsyncFrameReservations,
} from "../backend/wasmgc/resources/prepared-async-frame.js";
import { sameValTypes } from "../wasm/physical/function-types.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  nativeStringValueReservationInventory,
  publishNativeStringValueOutput,
  fillNativeStringValueResources,
  requireCompletedNativeStringValues,
  emitPreparedNativeStringLiteral,
  emitPreparedNativeStringConcat,
  type NativeStringValueReservationInput,
} from "../backend/wasmgc/program/native-string-values.js";
import { collectNativeStringValueDemands } from "./program/native-string-value-demands.js";
import { reserveNativeRefCells } from "../backend/wasmgc/resources/native-ref-cells.js";
import {
  prepareNativeSourceClosureInput,
  beginNativeSourceClosureEmission,
  bindNativeSourceClosureUnits,
  nativeSourceClosureValueType,
  fillPreparedPrimaryUnit,
  requireCompletedNativeSourceClosures,
  type NativeSourceClosureEmission,
} from "./program-native-invocation.js";
import {
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "./program/native-source-closure-requirements.js";
import { assertNativeValueResourcePlanFor } from "./program/native-value-resources.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./program/data.js";
import {
  reserveNativeStringLiteralResources,
  nativeStringLiteralReservationInventory,
  fillNativeStringLiteralResources,
  requireCompletedNativeStringLiterals,
  requireNativeStringLiteral,
  nativeStringLiteralGlobalMatches,
  type NativeStringLiteralReservations,
  type NativeStringLiteralTypeReservations,
} from "../backend/wasmgc/resources/native-string-literals.js";
import {
  reserveNativeNumberFormatResources,
  requireNativeNumberFormatReservations,
  nativeNumberFormatReservationInventory,
  fillNativeNumberFormatResources,
  requireCompletedNativeNumberFormat,
  type NativeNumberFormatResourceRow,
} from "../backend/wasmgc/resources/native-number-format.js";
import {
  planNativeNumberFormatStringLayout,
  planNativeNumberFormatPhysical,
} from "../backend/wasmgc/program/native-number-format.js";
import { buildInlineNativeStringLiteral } from "../runtime/wasmgc/values/string-literal-bodies.js";
import {
  deriveNativeNumberFormatRequirements,
  assertNativeNumberFormatRequirementsCurrent,
  type NativeNumberFormatRequirements,
} from "./program/native-number-format-requirements.js";
import { numberFormatRadixSupportDeclarations } from "./program/formatter-support.js";
import { prepareIrRuntimeManifest } from "./intrinsic-support.js";
import type { PreparedIrRuntimeManifest, PreparedIrFunction } from "./runtime/contracts/prepared.js";
import { compareNativeResourceDeclarationShape } from "../backend/wasmgc/resources/native-resource-declarations.js";
import { indexPhysicalTypes } from "../wasm/physical/type-layout.js";
import {
  reserveNativeVectorHelper,
  fillNativeVectorHelper,
  reserveNativeNumericAppend,
  nativeNumericAppendFunction,
  fillNativeNumericAppend,
  requireCompletedNativeNumericAppend,
  nativeVectorPhysicalType,
  requireNativeVectorTypeReservations,
  type NativeVectorLayout,
  resolveNativeVector,
  resolveNativeVectorForElement,
  type NativeVectorTypeReservations,
} from "../backend/wasmgc/resources/native-vectors.js";
import {
  PhysicalModuleReservations,
  type CallableReservation,
  type FunctionReservation,
  type GlobalReservation,
  type GlobalImportReservation,
  type TypeReservation,
} from "../wasm/physical/module-reservations.js";
import { irGlobalBindingKey, irTypeBindingKey } from "./abi-bindings.js";
import { verifyIrBackendLegality } from "./backend/legality.js";
import { LinearEmitter } from "./backend/linear-emitter.js";
import { WasmGcEmitter } from "./backend/wasmgc-emitter.js";
import { irCallableBindingKey } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId } from "./identity.js";
import { lowerIrFunctionBody, wasmValueTypeConverter, type IrLowerResolver } from "./lower.js";
import { forEachInstrDeep, type IrFuncRef, type IrFunction } from "./nodes.js";
import type { IrPreparationFailure } from "./outcomes.js";
import { ProgramAbiMap, type ProgramAbiFinalIndex } from "./program-abi.js";
import { observePreparedIrProgram } from "./program-observation.js";
import { planPhysicalSetup, type PhysicalSetupPlan, type PhysicalSignatureType } from "./program-physical-plan.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import {
  preparedIrProgramOwner,
  PreparedIrProgramInvariantError,
  type AcceptedPreparedIrProgram,
  type EmittedPreparedIrProgram,
  type PreparedIrBackendAcceptance,
  type PreparedIrBackendOptions,
  type PreparedIrProgram,
  type PreparedIrProgramFailure,
  type PreparedIrProgramRuntimeProjection,
} from "./program.js";
import {
  reservePhysicalImports,
  reservePhysicalExceptionTag,
  reserveStartupAdapter,
  physicalBodyResolver,
  physicalSignatureConverter,
  bindPhysicalAbi,
  fillStartupAdapter,
  fillPhysicalScalarResources,
  indexSupportFunctions,
  completedStartupGuardIndex,
  collectPhysicalUnitReceipts,
} from "./program-body-resources.js";
import { createNativeVectorEmission } from "./program-native-vector-emission.js";
import { acquirePreparedLinearAllocation } from "./program/linear-allocation-outcome.js";
import {
  reserveAndBindPhysicalReferenceError,
  fillPhysicalReferenceError,
  requireCompletedPhysicalReferenceError,
  completedPhysicalReferenceErrorReceipt,
  verifyCompletedPhysicalReferenceErrorReceipt,
  type CompletedPhysicalReferenceErrorReceipt,
} from "./program-reference-error.js";
import {
  planPreparedLinearMemory,
  linearMemoryOptionsUnsupported,
  reservePreparedLinearMemory,
  preparedLinearMemoryBindings,
  preparedLinearNumericAppendReservation,
  fillPreparedLinearMemory,
  requireCompletedPreparedLinearMemory,
} from "../backend/linear/program/memory.js";
import type { PreparedLinearMemoryPlan } from "../backend/linear/program/contracts.js";
import type { PreparedLinearBodyBindings } from "../backend/linear/program/memory.js";
import { createEmptyModule, type Instr, type ValType, type WasmFunction } from "./types.js";

// ---------------------------------------------------------------------------
// Module-private authority
// ---------------------------------------------------------------------------

interface AcceptanceRecord {
  readonly physical: PhysicalSetupPlan;
  /** Private whole-attempt lifetime, including failures outside ledger operations. */
  readonly emission: { state: "accepted" | "emitting" | "completed" | "failed" };
  /** Exact issued dependencies; never deep-clone the native-value plan. */
  readonly nativeStrings?: NativeStringValueReservationInput;
  readonly nativeSnapshot?: unknown;
  readonly nativeNumberFormat?: AcceptedNativeNumberFormat;
  readonly sourceClosures?: NativeSourceClosureRequirements;
  readonly nativeInvocation?: NativeInvocationRequirements;
  readonly nativeRealm?: NativeRealmRequirements;
  readonly linearMemory?: PreparedLinearMemoryPlan;
}
interface AcceptedNativeNumberFormat {
  readonly requirements: NativeNumberFormatRequirements;
  readonly support: PreparedIrRuntimeManifest;
  readonly body: PreparedIrFunction;
  readonly snapshot: unknown;
}
/** Only this module can mint acceptance or retain its issued dependencies. */
const acceptances = new WeakMap<AcceptedPreparedIrProgram, AcceptanceRecord>();
/** Acceptances whose emission has begun (successfully or not); each may begin once. */
const emissions = new WeakSet<AcceptedPreparedIrProgram>();
export interface EmittedSupportFunctionReceipt {
  readonly key: string;
  readonly index: number;
}
interface EmissionObservation {
  readonly program: PreparedIrProgram;
  readonly physical: PhysicalSetupPlan;
  readonly reservations: PhysicalModuleReservations;
  readonly functions: readonly FunctionReservation[];
  readonly support: readonly EmittedSupportFunctionReceipt[];
  readonly referenceError?: CompletedPhysicalReferenceErrorReceipt;
  readonly vectorTypes?: NativeVectorTypeReservations;
  readonly startupAdapterIndex?: number;
  readonly startupGuard?: GlobalReservation;
  readonly bindings: readonly (readonly [IrBindingId, ProgramAbiFinalIndex])[];
}
/** Private completed-emission evidence; reservation capabilities never escape. */
const startupAdapters = new WeakMap<EmittedPreparedIrProgram, EmissionObservation>();

function programInvariant(code: PreparedIrProgramInvariantError["code"], detail: string): never {
  throw new PreparedIrProgramInvariantError(code, `program consumer: ${detail}`);
}

function locate(program: PreparedIrProgram, unitId: IrUnitId, failure: IrPreparationFailure): PreparedIrProgramFailure {
  const owner = preparedIrProgramOwner(program, unitId);
  if (!owner) programInvariant("invalid-prepared-data", `cannot locate ${unitId}: ${failure.detail}`);
  const { cause: _cause, ...diagnostic } = failure;
  return Object.freeze({ ...diagnostic, unitId: owner.unitId, location: owner.location, sourceFile: owner.sourceFile });
}

function instructionBuffers(fn: IrFunction) {
  return [...fn.blocks.map((block) => block.instrs), ...(fn.asyncPlan?.states.map((state) => state.body) ?? [])];
}

function selectProjection(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
): PreparedIrProgramRuntimeProjection | undefined {
  return program.runtime.find(
    (projection) => projection.backend === options.backend && projection.target === options.target,
  );
}

/** Exact option data: optional physical policies are retained only when supplied. */
function canonicalOptions(options: PreparedIrBackendOptions): PreparedIrBackendOptions {
  const base = {
    backend: options.backend,
    target: options.target,
    sharedExceptionTag: options.sharedExceptionTag,
    utf8Storage: options.utf8Storage,
    ...(options.backend === "wasmgc" && options.target === "standalone"
      ? { stringConcatEmptyIdentity: options.stringConcatEmptyIdentity ?? true }
      : {}),
    sourceMap: options.sourceMap,
    moduleName: options.moduleName,
    ...(options.numberFormat === undefined
      ? {}
      : {
          numberFormat: Object.freeze({ integerBeforeScratch: options.numberFormat.integerBeforeScratch }),
        }),
  };
  return Object.freeze(options.linear === undefined ? base : { ...base, linear: Object.freeze({ ...options.linear }) });
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/** Retain the actual canonical preparation, never a caller-supplied body clone. */
function prepareNativeNumberFormat(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
): AcceptedNativeNumberFormat | undefined {
  if (options.backend !== "wasmgc" || options.target !== "standalone" || !program.runtimeSupport) return undefined;
  const integerBeforeScratch = options.numberFormat?.integerBeforeScratch;
  if (typeof integerBeforeScratch !== "boolean")
    programInvariant("invalid-prepared-data", "formatter support requires its resolved integer policy");
  const requirements = deriveNativeNumberFormatRequirements({ program, projection, integerBeforeScratch });
  if (!requirements) programInvariant("invalid-prepared-data", "formatter support has no actual demand");
  const literalOwners = new Set<string>();
  for (const use of requirements.literals) {
    const instruction = use.instruction;
    const key = JSON.stringify([use.allocation, instruction.value]);
    if (
      literalOwners.has(key) ||
      Object.hasOwn(instruction, "storage") ||
      Object.hasOwn(instruction, "materializer") ||
      instruction.value.length > 10000
    )
      programInvariant("invalid-prepared-data", "formatter support literal lacks a unique bounded inline owner");
    literalOwners.add(key);
  }
  const support = prepareIrRuntimeManifest({
    functions: [requirements.batch.implementation.body],
    sourceFile: "<stdlib:__sh_num_toString_radix>",
    policy: projection.prepared.manifest.policy,
    includeEmpty: true,
  });
  const body = support.functions[0];
  if (support.functions.length !== 1 || !body || body.asyncPlan || body.asyncRuntime)
    programInvariant("invalid-prepared-data", "formatter preparation must retain one synchronous support body");
  return Object.freeze({ requirements, support, body, snapshot: freezePreparedIrValue(body) });
}

/**
 * Accept one complete program for one exact backend/target. Returns A's typed
 * located failure for a backend capability gap (`unsupported`) or a program
 * contradiction found at consumption time (`invariant`); throws
 * `PreparedIrProgramInvariantError` for defects that have no owning unit.
 */
export function acceptPreparedIrProgram(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
): PreparedIrBackendAcceptance {
  assertPreparedIrProgram(program);
  if (
    options.stringConcatEmptyIdentity !== undefined &&
    (typeof options.stringConcatEmptyIdentity !== "boolean" ||
      options.backend !== "wasmgc" ||
      options.target !== "standalone")
  )
    programInvariant("invalid-prepared-data", "string output options require standalone WasmGC and a resolved boolean");
  if (
    options.numberFormat !== undefined &&
    (options.backend !== "wasmgc" ||
      options.target !== "standalone" ||
      options.numberFormat === null ||
      typeof options.numberFormat !== "object" ||
      Object.keys(options.numberFormat).length !== 1 ||
      !Object.hasOwn(options.numberFormat, "integerBeforeScratch") ||
      typeof options.numberFormat.integerBeforeScratch !== "boolean")
  ) {
    programInvariant(
      "invalid-prepared-data",
      "number formatter options require standalone WasmGC and one resolved boolean",
    );
  }
  if (options.linear !== undefined && options.backend !== "linear") {
    programInvariant("invalid-prepared-data", `linear physical options were supplied for backend ${options.backend}`);
  }
  const runtime = selectProjection(program, options);
  if (!runtime) {
    const available = program.runtime.map((projection) => `${projection.backend}:${projection.target}`).join(", ");
    const unitId = program.ir.functions[0]?.unitId ?? program.inventory.terminalUnits[0]?.id;
    if (!unitId) programInvariant("invalid-prepared-data", "program carries no unit to locate a projection failure");
    return locate(program, unitId, {
      kind: "unsupported",
      code: "body-shape-rejected",
      stage: "build",
      detail: `program has no ${options.backend}:${options.target} runtime projection (available: ${available || "none"})`,
    });
  }

  // The physical functions of the selected projection are what gets lowered.
  const bodies = new Map<IrUnitId, IrFunction>(runtime.prepared.functions.map((fn) => [fn.unitId, fn] as const));
  for (const fn of runtime.prepared.functions) {
    let missing: string | undefined;
    const check = (ref: IrFuncRef, what: string): void => {
      if (missing === undefined && ref.binding.kind === "unit" && !bodies.has(ref.binding.unitId)) {
        missing = `${what} unit body ${ref.binding.unitId}, which the ${options.backend}:${options.target} projection does not carry`;
      }
    };
    for (const buffer of instructionBuffers(fn)) {
      for (const root of buffer) {
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "call") check(instruction.target, "calls");
          else if (instruction.kind === "closure.new") check(instruction.liftedFunc, "captures");
        });
      }
    }
    if (missing !== undefined) {
      return locate(program, fn.unitId, {
        kind: "invariant",
        code: "unknown-function-ref",
        stage: "resolve",
        detail: `body ${fn.unitId} ${missing}`,
      });
    }
  }

  for (const fn of runtime.prepared.functions) {
    const errors = verifyIrBackendLegality(fn, options.backend);
    if (errors.length > 0) {
      return locate(program, fn.unitId, {
        kind: "unsupported",
        code: "body-shape-rejected",
        stage: "build",
        detail: `${options.backend}:${options.target} cannot lower body ${fn.unitId}: ${errors.map((error) => error.message).join("; ")}`,
      });
    }
  }

  const sourceClosures =
    options.backend === "wasmgc" && options.target === "standalone"
      ? prepareNativeSourceClosureInput(program, runtime)
      : undefined;
  const nativeInvocation =
    sourceClosures && planNativeInvocationRequirements(sourceClosures, { utf8Storage: options.utf8Storage === true });
  const standalone = options.backend === "wasmgc" && options.target === "standalone";
  const nativeRealm = standalone ? deriveNativeRealmRequirements(program, runtime, sourceClosures) : undefined;
  const nativeStrings = standalone
    ? prepareNativeProgramStringInput(program, runtime, options, nativeInvocation, nativeRealm)
    : undefined;
  if (nativeStrings && "kind" in nativeStrings) return nativeStrings;
  const nativeNumberFormat = prepareNativeNumberFormat(program, options, runtime);
  const optionGap = options.backend === "linear" ? linearMemoryOptionsUnsupported(options) : undefined;
  if (optionGap) {
    const unitId = runtime.prepared.functions[0]?.unitId ?? program.inventory.terminalUnits[0]?.id;
    if (!unitId) programInvariant("invalid-prepared-data", "Linear option refusal has no canonical owner");
    return locate(program, unitId, {
      kind: "unsupported",
      code: "array-representation-unsupported",
      stage: "resolve",
      detail: optionGap,
    });
  }
  const linearEvidence = acquirePreparedLinearAllocation(program, options, runtime);
  if (linearEvidence.kind === "unsupported") return linearEvidence;
  const linearResult = linearEvidence.input
    ? planPreparedLinearMemory({ program, projection: runtime, options })
    : undefined;
  if (linearResult?.kind === "unsupported") {
    const location = linearResult.location as { readonly unitId?: IrUnitId } | undefined;
    const unitId = location?.unitId ?? runtime.prepared.functions[0]?.unitId ?? program.inventory.terminalUnits[0]?.id;
    if (!unitId) programInvariant("invalid-prepared-data", "Linear refusal has no canonical owning unit");
    const located = locate(program, unitId, {
      kind: "unsupported",
      code: "array-representation-unsupported",
      stage: "resolve",
      detail: linearResult.detail,
      ...(linearResult.location === undefined ? {} : { cause: linearResult.location }),
    });
    return Object.freeze({
      ...located,
      ...(linearResult.location === undefined ? {} : { cause: linearResult.location }),
    });
  }

  const linearMemory = linearResult?.kind === "supported" ? linearResult.plan : undefined;
  const physical = planPhysicalSetup(program, options, runtime, nativeStrings, nativeNumberFormat, linearMemory);
  if (physical.kind !== "planned") return physical;

  const accepted = Object.freeze({
    kind: "accepted",
    program,
    options: canonicalOptions(options),
    runtime,
  }) as unknown as AcceptedPreparedIrProgram;
  acceptances.set(
    accepted,
    Object.freeze({
      physical: physical.plan,
      emission: { state: "accepted" as const },
      ...(nativeStrings ? { nativeStrings, nativeSnapshot: freezePreparedIrValue(nativeStrings.demands) } : {}),
      ...(nativeNumberFormat ? { nativeNumberFormat } : {}),
      ...(sourceClosures ? { sourceClosures } : {}),
      ...(nativeInvocation ? { nativeInvocation } : {}),
      ...(nativeRealm ? { nativeRealm } : {}),
      ...(linearMemory ? { linearMemory } : {}),
    }),
  );
  observePreparedIrProgram({ phase: "accepted", program, backend: options.backend, target: options.target });
  return accepted;
}

/** True only for an acceptance minted by `acceptPreparedIrProgram` in this process. */
export function isAuthenticAcceptedIrProgram(value: unknown): value is AcceptedPreparedIrProgram {
  return typeof value === "object" && value !== null && acceptances.has(value as AcceptedPreparedIrProgram);
}

/**
 * The physical plan acceptance derived, for evidence tools. It is the same
 * deep-frozen object emission reads, so it cannot be changed from outside.
 */
export function acceptedPhysicalSetupPlan(accepted: AcceptedPreparedIrProgram): PhysicalSetupPlan {
  const record = acceptances.get(accepted);
  if (!record)
    programInvariant("invalid-transaction-capability", "acceptance was not produced by acceptPreparedIrProgram");
  return record.physical;
}

/** Function index of the startup adapter this emission constructed, if any. */
export function emittedStartupAdapterIndex(emitted: EmittedPreparedIrProgram): number | undefined {
  return startupAdapters.get(emitted)?.startupAdapterIndex;
}
/** Exact once-only startup storage, authenticated against this completed attempt. */
export function emittedStartupGuardIndex(emitted: EmittedPreparedIrProgram): number | undefined {
  return completedStartupGuardIndex(startupAdapters.get(emitted), () => emittedSupportFunctionReceipts(emitted));
}

/** Exact non-source helper bodies, authenticated against the completed module. */
export function emittedSupportFunctionReceipts(
  emitted: EmittedPreparedIrProgram,
): readonly EmittedSupportFunctionReceipt[] {
  const record = startupAdapters.get(emitted);
  if (!record) programInvariant("invalid-transaction-capability", "emission was not produced by this consumer");
  for (const token of record.functions) record.reservations.assertCompletedReservation(token);
  if (record.functions.length !== emitted.module.functions.length)
    emissionFailed("completed emission function census changed");
  return record.support;
}

/** Exact immutable semantic owner, never reconstructed from structurally equal IDs. */
export function assertEmittedPreparedIrProgram(program: PreparedIrProgram, emitted: EmittedPreparedIrProgram): void {
  const record = startupAdapters.get(emitted);
  if (!record || record.program !== program)
    programInvariant("invalid-transaction-capability", "emission does not belong to this prepared program");
  emittedSupportFunctionReceipts(emitted);
}

/** The exact accepted plan used by this authenticated completed emission. */
export function emittedPhysicalSetupPlan(emitted: EmittedPreparedIrProgram): PhysicalSetupPlan {
  const record = startupAdapters.get(emitted);
  if (!record) programInvariant("invalid-transaction-capability", "emission was not produced by this consumer");
  emittedSupportFunctionReceipts(emitted);
  return record.physical;
}

/** Read-only canonical vector coordinates from this exact completed reservation pack. */
export function emittedNativeVectorLayouts(emitted: EmittedPreparedIrProgram): readonly NativeVectorLayout[] {
  const record = startupAdapters.get(emitted);
  if (!record) programInvariant("invalid-transaction-capability", "emission was not produced by this consumer");
  emittedSupportFunctionReceipts(emitted);
  if (!record.vectorTypes) return Object.freeze([]);
  requireNativeVectorTypeReservations(record.reservations, record.vectorTypes, record.physical.vectors);
  return Object.freeze(record.vectorTypes.layouts.map((row) => row.layout));
}

/** Completed physical Error DATA is authenticated against this exact consumer emission and module. */
export function emittedReferenceErrorResourceReceipt(
  emitted: EmittedPreparedIrProgram,
): CompletedPhysicalReferenceErrorReceipt | undefined {
  const record = startupAdapters.get(emitted);
  if (!record) programInvariant("invalid-transaction-capability", "emission was not produced by this consumer");
  emittedSupportFunctionReceipts(emitted);
  return record.referenceError
    ? verifyCompletedPhysicalReferenceErrorReceipt(emitted.module, record.referenceError)
    : undefined;
}

/** Final binding index observed at emission; does not authenticate later module mutations. */
export function emittedProgramBindingIndex(
  emitted: EmittedPreparedIrProgram,
  id: IrBindingId,
): ProgramAbiFinalIndex | undefined {
  return startupAdapters.get(emitted)?.bindings.find(([bindingId]) => bindingId === id)?.[1];
}

// ---------------------------------------------------------------------------
// Emission — one argument, internal source-free physical setup
// ---------------------------------------------------------------------------

function emissionFailed(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", `program emission: ${detail}`);
}

/**
 * Emit one accepted program exactly once. Every physical resource is reserved
 * from the plan acceptance derived, the index space is frozen, A's ABI map is
 * sealed and bound to the reserved indices, every physical body is lowered
 * into its slot (all or nothing), startup and exports are materialized from
 * the plan, and the unit receipts are derived from the functions actually
 * present in the module. A forged or cloned acceptance, a second emission, or
 * a body that fails after acceptance is an invariant and nothing is returned.
 */
export function emitAcceptedIrProgram(accepted: AcceptedPreparedIrProgram): EmittedPreparedIrProgram {
  const plan = acceptedPhysicalSetupPlan(accepted);
  if (emissions.has(accepted)) programInvariant("invalid-transaction-capability", "acceptance was already emitted");
  emissions.add(accepted);
  const { program, options } = accepted;
  const record = acceptances.get(accepted)!;
  const runtime = accepted.runtime;
  record.emission.state = "emitting";
  const assertEmissionActive = (): void => {
    if (
      acceptances.get(accepted) !== record ||
      record.physical !== plan ||
      accepted.program !== program ||
      accepted.runtime !== runtime ||
      accepted.options !== options ||
      record.emission.state !== "emitting"
    )
      emissionFailed("emission attempt is no longer active for this acceptance");
  };
  const backend = options.backend;
  let observing = true;
  try {
    observePreparedIrProgram({ phase: "emission-started", program, backend, target: options.target });
    observing = false;
    assertEmissionActive();
    const result = materializePhysicalProgram(accepted, plan, assertEmissionActive);
    assertEmissionActive();
    observing = true;
    observePreparedIrProgram({ phase: "emitted", program, backend, target: options.target });
    record.emission.state = "completed";
    return result;
  } catch (error) {
    record.emission.state = "failed";
    // Existing observation clients receive their original exception identity.
    if (observing || error instanceof PreparedIrProgramInvariantError) throw error;
    return emissionFailed(
      `physical module construction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (record.emission.state === "emitting") record.emission.state = "failed";
  }
}

/** Captured emission-local callables lose authority when the entire attempt ends. */
function activeEmissionResolver(resolver: IrLowerResolver, assertEmissionActive: () => void): IrLowerResolver {
  assertEmissionActive();
  return Object.fromEntries(
    Object.entries(resolver).map(([key, value]) => [
      key,
      typeof value === "function"
        ? (...args: unknown[]) => {
            assertEmissionActive();
            return Reflect.apply(value, resolver, args);
          }
        : value,
    ]),
  ) as IrLowerResolver;
}

/** Authenticate accepted native inputs and seal their ABI before any allocation. */
function prepareNativeEmission(accepted: AcceptedPreparedIrProgram, plan: PhysicalSetupPlan) {
  const { program, runtime } = accepted;
  const record = acceptances.get(accepted);
  if (!record || record.physical !== plan) emissionFailed("physical plan does not belong to acceptance");
  if (Boolean(record.nativeRealm) !== Boolean(plan.nativeRealm))
    emissionFailed("realm acceptance/physical plan mismatch");
  if (record.nativeRealm) {
    assertNativeRealmRequirementsCurrent(record.nativeRealm);
    if (
      record.nativeRealm !== record.nativeStrings?.realmRequirements ||
      record.nativeRealm.source !== record.sourceClosures ||
      preparedIrDataMismatch(record.nativeRealm.description, plan.nativeRealm) !== undefined
    )
      emissionFailed("realm input differs from its accepted program/source owner");
  }
  if (Boolean(record.nativeInvocation) !== Boolean(plan.nativeInvocation))
    emissionFailed("native invocation acceptance/physical plan mismatch");
  if (record.nativeInvocation) {
    assertNativeInvocationRequirementsCurrent(record.nativeInvocation);
    if (
      record.nativeInvocation.source !== record.sourceClosures ||
      record.nativeStrings?.invocationRequirements !== record.nativeInvocation ||
      record.nativeInvocation.key !== plan.nativeInvocation?.key
    )
      emissionFailed("native invocation input differs from its selected source owner");
  }
  if (Boolean(record.sourceClosures) !== Boolean(plan.sourceClosures))
    emissionFailed("source closure acceptance/physical plan mismatch");
  if (record.sourceClosures) {
    assertNativeSourceClosureRequirementsCurrent(record.sourceClosures);
    const { demands, ...description } = record.sourceClosures;
    if (
      demands.program !== program ||
      demands.projection !== runtime ||
      preparedIrDataMismatch(description, plan.sourceClosures) !== undefined
    )
      emissionFailed("source closure input differs from its accepted physical plan");
    const current = planPhysicalSetup(
      program,
      accepted.options,
      runtime,
      record.nativeStrings,
      record.nativeNumberFormat,
      record.linearMemory,
    );
    if (current.kind !== "planned" || preparedIrDataMismatch(current.plan, plan) !== undefined)
      emissionFailed("source closure physical plan is no longer current");
  }
  if (Boolean(record.nativeNumberFormat) !== Boolean(plan.nativeNumberFormat))
    emissionFailed("formatter acceptance/physical plan mismatch");
  if (record.nativeNumberFormat) {
    assertPreparedIrProgram(program);
    const formatter = record.nativeNumberFormat;
    assertNativeNumberFormatRequirementsCurrent(formatter.requirements, formatter.requirements);
    const fresh = prepareNativeNumberFormat(program, accepted.options, runtime);
    if (
      !fresh ||
      preparedIrDataMismatch(fresh.support, formatter.support) !== undefined ||
      preparedIrDataMismatch(formatter.body, formatter.snapshot) !== undefined ||
      formatter.support.functions[0] !== formatter.body
    )
      emissionFailed("formatter support changed after acceptance");
    const current = planPhysicalSetup(
      program,
      accepted.options,
      runtime,
      record.nativeStrings,
      formatter,
      record.linearMemory,
    );
    if (current.kind !== "planned" || preparedIrDataMismatch(current.plan, plan) !== undefined)
      emissionFailed("formatter physical plan is no longer current");
  }
  if (record.nativeStrings) {
    assertPreparedIrProgram(program);
    if (record.nativeStrings.demands.program !== program || record.nativeStrings.demands.projection !== runtime)
      emissionFailed("native demands belong to another program/projection");
    if (preparedIrDataMismatch(record.nativeStrings.demands, record.nativeSnapshot) !== undefined)
      emissionFailed("native demands changed after acceptance");
    if (record.nativeStrings.valueRequirements)
      assertNativeValueResourcePlanFor(record.nativeStrings.valueRequirements, program, runtime, "native-string");
  }
  if (
    Boolean(record.linearMemory) !== Boolean(plan.linearMemory) ||
    (record.linearMemory && preparedIrDataMismatch(record.linearMemory, plan.linearMemory) !== undefined)
  )
    emissionFailed("Linear memory plan differs from its acceptance owner");
  const native = plan.nativeStrings;
  const layoutOnly = native?.resources.mode === "formatter-layout";
  if (layoutOnly) {
    if (record.nativeStrings || !record.nativeNumberFormat)
      emissionFailed("formatter layout has contradictory source dependencies");
    const demands = collectNativeStringValueDemands(program, runtime);
    const source = planNativeStringValuePhysical(demands, {
      representation: "native-string",
      utf8Storage: accepted.options.utf8Storage === true,
    });
    const fresh = planNativeNumberFormatStringLayout(
      record.nativeNumberFormat.requirements,
      accepted.options.utf8Storage === true,
    );
    if (source.kind !== "none" || preparedIrDataMismatch(native.resources, fresh) !== undefined)
      emissionFailed("formatter layout no longer matches genuine empty source demand");
  } else if (Boolean(native) !== Boolean(record.nativeStrings))
    emissionFailed("native acceptance/physical plan mismatch");
  if (
    native &&
    record.nativeStrings &&
    preparedIrDataMismatch(native.resources, record.nativeStrings.plan) !== undefined
  )
    emissionFailed("native physical resources contradict the accepted reservation input");
  if (plan.nativeNumberFormat) {
    if (!native || !record.nativeNumberFormat) emissionFailed("formatter has no shared string dependency");
    const fresh = planNativeNumberFormatPhysical(
      record.nativeNumberFormat.requirements,
      native.resources.literalRequirements.key,
      native.resources,
    );
    if (preparedIrDataMismatch(fresh, plan.nativeNumberFormat.resources) !== undefined)
      emissionFailed("formatter resources or scratch join changed");
  }
  if (plan.asyncFrames || plan.hostNumberBoundary) {
    const current = planPhysicalSetup(
      program,
      accepted.options,
      runtime,
      record.nativeStrings,
      record.nativeNumberFormat,
      record.linearMemory,
    );
    if (current.kind !== "planned" || preparedIrDataMismatch(current.plan, plan) !== undefined)
      emissionFailed("async physical plan is no longer current");
  }
  let abi: ProgramAbiMap | undefined;
  if (native || plan.asyncFrames || plan.hostNumberBoundary) {
    // Native supplemental ABI is accepted planning data, sealed before even
    // the first physical reservation. Reused semantic entries stay unchanged.
    abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
    const entries = new Map(program.abi.entries.map((entry) => [entry.plan.id, entry.plan]));
    for (const entry of program.abi.entries) abi.plan(entry.plan);
    for (const row of [
      ...(native?.bindings ?? []).map((binding) => binding.entry),
      ...(plan.nativeNumberFormat?.bindings ?? []).map((binding) => binding.entry),
      ...(plan.nativeInvocation?.bindings ?? []).map((binding) => binding.entry),
      ...(plan.hostNumberBoundary?.entries ?? []),
      ...(plan.asyncFrames?.entries ?? []),
    ]) {
      const binding = { entry: row };
      const existing = entries.get(binding.entry.id);
      if (existing) {
        if (preparedIrDataMismatch(existing, binding.entry) !== undefined)
          emissionFailed("native binding contradicts an existing ABI entry");
      } else {
        abi.plan(binding.entry);
        entries.set(binding.entry.id, binding.entry);
      }
    }
    abi.sealPlan();
  }

  return { record, native, abi };
}

type ConsumerReservation = CallableReservation | GlobalReservation | GlobalImportReservation | TypeReservation;
interface NativeReconciliationContext {
  readonly module: ReturnType<typeof createEmptyModule>;
  readonly reservations: PhysicalModuleReservations;
  readonly functionsByKey: Map<string, CallableReservation>;
  readonly globalsByKey: Map<string, GlobalReservation | GlobalImportReservation>;
  readonly resourcesByBinding: Map<IrBindingId, ConsumerReservation>;
  readonly typesByKey: Map<string, TypeReservation>;
}
/** Read actual owned module descriptors and populate the existing resolver maps. */
function reconcileNativeEmission(
  native: PhysicalSetupPlan["nativeStrings"] | PhysicalSetupPlan["nativeNumberFormat"],
  nativeRows: readonly NativeNumberFormatResourceRow[],
  context: NativeReconciliationContext,
  sharedTypes: ReadonlyMap<string, TypeReservation> = new Map(),
): Set<WasmFunction> {
  const { module, reservations, functionsByKey, globalsByKey, resourcesByBinding, typesByKey } = context;
  const nativeFunctions = new Set<WasmFunction>();
  if (native) {
    const rows = new Map(nativeRows.map((row) => [row.key, row]));
    if (rows.size !== nativeRows.length || rows.size !== native.resources.declarations.length)
      emissionFailed("native declaration/reservation population mismatch");
    const expectedOrder = native.resources.reservationSteps.flatMap((step) =>
      step.kind === "reserve" ? [step.resourceKey] : [],
    );
    if (
      preparedIrDataMismatch(
        nativeRows.map((row) => row.key),
        expectedOrder,
      ) !== undefined
    )
      emissionFailed("native inventory contradicts accepted reservation order");
    const typeTokens = new Map<string, TypeReservation>(sharedTypes);
    for (const row of nativeRows) {
      if (row.space === "type") {
        const prior = typeTokens.get(row.key);
        if (prior && prior !== row.reservation) emissionFailed("native type dependency has two owners");
        typeTokens.set(row.key, row.reservation);
      }
      if (row.space === "function") nativeFunctions.add(row.reservation.object);
    }
    const physicalTypes = indexPhysicalTypes(module.types);
    for (const declaration of native.resources.declarations) {
      const row = rows.get(declaration.key);
      if (!row || row.space !== declaration.space) emissionFailed("native declaration key/space mismatch");
      if (row.space === "type") {
        compareNativeResourceDeclarationShape(
          reservations,
          declaration,
          { key: row.key, space: "type", definition: row.reservation.object },
          typeTokens,
        );
      } else if (row.space === "global") {
        const { name, type, mutable } = row.reservation.object;
        compareNativeResourceDeclarationShape(
          reservations,
          declaration,
          { key: row.key, space: "global", header: { name, type, mutable } },
          typeTokens,
        );
      } else {
        const fn = row.reservation.object;
        const definition = physicalTypes.entries[fn.typeIdx]?.definition;
        if (!definition || definition.kind !== "func") emissionFailed("native function has no actual signature");
        compareNativeResourceDeclarationShape(
          reservations,
          declaration,
          {
            key: row.key,
            space: "function",
            name: fn.name,
            signature: { params: definition.params, results: definition.results },
          },
          typeTokens,
        );
      }
    }
    for (const binding of native.bindings) {
      const row = rows.get(binding.resourceKey);
      if (!row || binding.entry.slotPolicy !== "required" || binding.entry.slotSpace !== row.space)
        emissionFailed("native ABI binding has no matching reserved resource");
      const existing = resourcesByBinding.get(binding.entry.id);
      if (existing && existing !== row.reservation) emissionFailed("native ABI binding has two owners");
      resourcesByBinding.set(binding.entry.id, row.reservation);
      const ref = binding.reference;
      if (row.space === "function" && ref.kind === "func") {
        const key = irCallableBindingKey(ref.binding);
        const previous = functionsByKey.get(key);
        if (previous && previous !== row.reservation) emissionFailed("native callable reference has two owners");
        functionsByKey.set(key, row.reservation);
      } else if (row.space === "global" && ref.kind === "global") {
        const key = irGlobalBindingKey(ref.binding);
        const previous = globalsByKey.get(key);
        if (previous && previous !== row.reservation) emissionFailed("native global reference has two owners");
        globalsByKey.set(key, row.reservation);
      } else if (row.space === "type" && ref.kind === "type") {
        const key = irTypeBindingKey(ref.binding);
        const previous = typesByKey.get(key);
        if (previous && previous !== row.reservation) emissionFailed("native type reference has two owners");
        typesByKey.set(key, row.reservation);
      } else emissionFailed("native ABI reference has the wrong resource space");
    }
  }
  return nativeFunctions;
}

/** Snapshot the completed ABI using the existing successful-emission record. */
function recordEmissionObservation(
  result: EmittedPreparedIrProgram,
  program: PreparedIrProgram,
  plan: PhysicalSetupPlan,
  abi: ProgramAbiMap,
  reservations: PhysicalModuleReservations,
  startAdapter: FunctionReservation | undefined,
  sourceFunctions: readonly FunctionReservation[],
  supportFunctions: readonly FunctionReservation[],
  referenceError?: CompletedPhysicalReferenceErrorReceipt,
  vectorTypes?: NativeVectorTypeReservations,
  startupGuard?: GlobalReservation,
): void {
  const bindings: (readonly [IrBindingId, ProgramAbiFinalIndex])[] = [];
  for (const entry of abi.entries()) {
    const index = abi.resolveFinalIndex(entry.id);
    if (index) bindings.push(Object.freeze([entry.id, Object.freeze({ ...index })] as const));
  }
  const functions = [...sourceFunctions, ...supportFunctions, ...(startAdapter ? [startAdapter] : [])];
  if (
    new Set(functions.map((token) => token.object)).size !== functions.length ||
    functions.length !== result.module.functions.length
  )
    emissionFailed("completed emission function ownership is not an exact partition");
  const support = supportFunctions.map((token) => {
    reservations.assertCompletedReservation(token);
    return Object.freeze({ key: token.key, index: reservations.physicalIndex(token) });
  });
  startupAdapters.set(
    result,
    Object.freeze({
      ...(startAdapter ? { startupAdapterIndex: reservations.physicalIndex(startAdapter) } : {}),
      ...(startupGuard ? { startupGuard } : {}),
      bindings: Object.freeze(bindings),
      program,
      physical: plan,
      reservations,
      functions: Object.freeze(functions),
      support: Object.freeze(support),
      ...(referenceError ? { referenceError } : {}),
      ...(vectorTypes ? { vectorTypes } : {}),
    }),
  );
}

/** Authenticate the genuinely empty literal owner before exposing its type rows. */
function emptyLayoutRows(
  tx: PhysicalModuleReservations,
  strings: NativeStringLiteralReservations,
): readonly NativeNumberFormatResourceRow[] {
  const inventory = nativeStringLiteralReservationInventory(tx, strings);
  if (inventory.requests.length || inventory.globals.length || inventory.functions.length)
    emissionFailed("formatter-only string pack contains source literal resources");
  return inventory.typePack.types.map((reservation) => ({ key: reservation.key, space: "type", reservation }));
}

/** The separate support owner can reach only its canonical kernels and scratch. */
function fillFormatterSupport(
  record: AcceptedNativeNumberFormat,
  pack: ReturnType<typeof reserveNativeNumberFormatResources>,
  resolver: IrLowerResolver,
  reservations: PhysicalModuleReservations,
  module: ReturnType<typeof createEmptyModule>,
): void {
  const { requirements, body } = record;
  assertNativeNumberFormatRequirementsCurrent(requirements, requirements);
  if (preparedIrDataMismatch(body, record.snapshot) !== undefined) emissionFailed("formatter support body changed");
  const declarations = numberFormatRadixSupportDeclarations(requirements.batch.sourceId);
  const calls = [...declarations.kernels, declarations.implementation];
  const supportResolver: IrLowerResolver = {
    ...resolver,
    resolveFunc: (ref) => {
      if (!calls.some((entry) => preparedIrDataMismatch(entry.ref, ref) === undefined))
        emissionFailed("formatter support called a foreign function");
      return resolver.resolveFunc(ref);
    },
    resolveType: (ref) => {
      if (preparedIrDataMismatch(ref, declarations.scratch.type.ref) !== undefined)
        emissionFailed("formatter support used a foreign type");
      if (!resolver.resolveType) emissionFailed("formatter support has no type resolver");
      return resolver.resolveType(ref);
    },
    resolveGlobal: () => emissionFailed("formatter support has no global authority"),
    emitStringConst: (value, alloc, storage, materializer) => {
      if (storage !== undefined || materializer !== undefined) emissionFailed("formatter literal is not inline");
      const uses = requirements.literals.filter(
        (use) =>
          use.instruction.value === value &&
          use.allocation === alloc &&
          requirements.supportBuffers[use.bufferIndex]?.ownerUnitId === body.unitId,
      );
      if (uses.length !== 1) emissionFailed("formatter literal has no unique original allocation owner");
      const instruction = uses[0]!.instruction;
      if (Object.hasOwn(instruction, "storage") || Object.hasOwn(instruction, "materializer") || value.length > 10000)
        emissionFailed("formatter inline literal exceeds its accepted construction contract");
      return buildInlineNativeStringLiteral(pack.strings.layout, value);
    },
  };
  const lowered = lowerIrFunctionBody<Instr[], ValType>(
    body,
    supportResolver,
    new WasmGcEmitter(supportResolver),
    wasmValueTypeConverter("wasmgc", supportResolver, body.name),
  );
  const reserved = pack.functions["radix-body"];
  const signature = indexPhysicalTypes(module.types).entries[reserved.object.typeIdx]?.definition;
  if (
    !signature ||
    signature.kind !== "func" ||
    !sameValTypes(
      lowered.params.flatMap((param) => [...param.slots]),
      signature.params,
    ) ||
    !sameValTypes(
      lowered.results.flatMap((result) => [...result]),
      signature.results,
    )
  )
    emissionFailed("formatter support signature contradicts the actual reserved function type");
  reservations.fillFunction(reserved, {
    locals: lowered.locals.flatMap((local) =>
      local.slots.map((type, slot) => ({
        name: slot === 0 ? local.name : `${local.name}$${slot}`,
        type,
      })),
    ),
    body: lowered.body,
  });
}

/** Lower one actual primary owner without extending its resolver authority. */
function fillPrimaryBody(
  accepted: AcceptedPreparedIrProgram,
  declared: PhysicalSetupPlan["functions"][number],
  fn: IrFunction,
  reserved: FunctionReservation,
  resolver: IrLowerResolver,
  nativePack: ReturnType<typeof reserveNativeStringValueResources> | undefined,
  reservations: PhysicalModuleReservations,
  physicalSignature: ReturnType<typeof physicalSignatureConverter>,
  assertEmissionActive: () => void,
  sourceClosures?: NativeSourceClosureEmission,
  linearBindings?: PreparedLinearBodyBindings,
): void {
  const { backend, target } = accepted.options;
  try {
    const scopedResolver: IrLowerResolver = declared.dynamicCarrier
      ? { ...resolver, resolveDynamic: () => declared.dynamicCarrier! }
      : resolver;
    const ownerResolver: IrLowerResolver = nativePack
      ? {
          ...scopedResolver,
          ...(nativePack.output
            ? ({
                emitStringConcat: (alloc, mode, provider) =>
                  emitPreparedNativeStringConcat(reservations, nativePack, fn.unitId, alloc, mode, provider),
              } satisfies Pick<IrLowerResolver, "emitStringConcat">)
            : {}),
          emitStringConst: (value, alloc, storage, materializer) =>
            emitPreparedNativeStringLiteral(reservations, nativePack, fn.unitId, value, alloc, storage, materializer),
        }
      : scopedResolver;
    fillPreparedPrimaryUnit(
      reservations,
      fn,
      reserved,
      physicalSignature(declared),
      activeEmissionResolver(ownerResolver, assertEmissionActive),
      backend,
      sourceClosures,
      linearBindings?.resolveRuntimeOperation,
    );
  } catch (error) {
    emissionFailed(
      `${backend}:${target} accepted body ${declared.unitId} and then failed to lower it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Bind the already sealed ABI to the exact reservations of this transaction. */
function reserveNumberRemainders(
  plan: PhysicalSetupPlan,
  context: NativeReconciliationContext,
  supportFunctions: Map<WasmFunction, FunctionReservation>,
): void {
  const { reservations, functionsByKey, resourcesByBinding } = context;
  for (const resource of plan.numberRemainders) {
    const token = reservations.reserveFunction(resource.bindingId, resource.symbol, {
      params: [...resource.params],
      results: [...resource.results],
    });
    if (functionsByKey.has(resource.referenceKey) || resourcesByBinding.has(resource.bindingId))
      emissionFailed("number remainder has competing physical owners");
    functionsByKey.set(resource.referenceKey, token);
    resourcesByBinding.set(resource.bindingId, token);
    supportFunctions.set(token.object, token);
  }
}

/** No observation or reusable capability escapes the physical transaction. */

/** Preserve global-before-unit reservation in the consumer's sole slot allocator. */
function reservePhysicalProgramSlots(
  plan: PhysicalSetupPlan,
  context: NativeReconciliationContext,
  physicalSignature: ReturnType<typeof physicalSignatureConverter>,
) {
  const { reservations, globalsByKey, resourcesByBinding, functionsByKey } = context;
  for (const global of plan.definedGlobals) {
    const type = physicalSignature({ params: [global.type], results: [] }).params[0]!;
    const reserved = reservations.reserveGlobal(global.bindingId, global.name, type, global.mutable);
    globalsByKey.set(global.referenceKey, reserved);
    resourcesByBinding.set(global.bindingId, reserved);
  }

  const slots = new Map<IrUnitId, FunctionReservation>();
  const slotOwners = new Map<WasmFunction, IrUnitId>();
  for (const declared of plan.functions) {
    const reserved = reservations.reserveFunction(declared.bindingId, declared.name, physicalSignature(declared));
    slots.set(declared.unitId, reserved);
    slotOwners.set(reserved.object, declared.unitId);
    functionsByKey.set(irCallableBindingKey({ kind: "unit", unitId: declared.unitId }), reserved);
    resourcesByBinding.set(declared.bindingId, reserved);
  }
  return { slots, slotOwners };
}

/** Publish only the exact canonical reservations after their physical bodies are filled. */
function publishPhysicalExports(
  plan: PhysicalSetupPlan,
  abi: ProgramAbiMap,
  context: NativeReconciliationContext,
): void {
  const { module, reservations, resourcesByBinding } = context;
  const exportNames = new Set<string>(module.exports.map((entry) => entry.name));
  for (const exported of plan.exports) {
    const final = abi.resolveFinalIndex(exported.targetBindingId);
    if (!final || final.space !== exported.space) {
      emissionFailed(`export ${exported.externalName} does not resolve to a bound ${exported.space}`);
    }
    const reserved = resourcesByBinding.get(abi.canonicalId(exported.targetBindingId));
    if (
      !reserved ||
      reserved.kind === "type" ||
      reservations.physicalIndex(reserved) !== final.index ||
      (reserved.kind === "function" || reserved.kind === "function-import" ? "function" : "global") !== final.space
    ) {
      emissionFailed(`export ${exported.externalName} contradicts its canonical physical reservation`);
    }
    if (exportNames.has(exported.externalName)) emissionFailed(`export ${exported.externalName} is declared twice`);
    exportNames.add(exported.externalName);
    reservations.defineExport(`publication:export:${exported.externalName}`, exported.externalName, reserved);
  }
}

/** Fill the reserved globals only after the physical index space is frozen. */

/** Bind selected invocation entry points to their exact, uniquely owned resources. */
function reconcileInvocationBindings(
  plan: PhysicalSetupPlan,
  functions: readonly FunctionReservation[],
  { functionsByKey, resourcesByBinding }: NativeReconciliationContext,
): void {
  for (const binding of plan.nativeInvocation?.bindings ?? []) {
    const token = functions.find((row) => row.key === binding.resourceKey);
    if (
      !token ||
      functionsByKey.has(irCallableBindingKey(binding.reference.binding)) ||
      resourcesByBinding.has(binding.entry.id)
    )
      emissionFailed("invocation semantic binding lacks its unique actual resource");
    functionsByKey.set(irCallableBindingKey(binding.reference.binding), token);
    resourcesByBinding.set(binding.entry.id, token);
  }
}

/** Seal the original program ABI when no native supplemental entries were planned. */
function sealedPhysicalProgramAbi(program: PreparedIrProgram): ProgramAbiMap {
  const abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
  for (const entry of program.abi.entries) abi.plan(entry.plan);
  abi.sealPlan();
  return abi;
}

/** Pass exact canonical producers at this attempt's existing reservation phase. */
function physicalVectorCarrierProducers() {
  return {
    physicalType: nativeVectorPhysicalType,
    resolve: resolveNativeVector,
    resolveElement: resolveNativeVectorForElement,
    reserveExternref: reserveNativeVectorHelper,
    fillExternref: fillNativeVectorHelper,
    reserveAppend: reserveNativeNumericAppend,
    appendFunction: nativeNumericAppendFunction,
    fillAppend: fillNativeNumericAppend,
    completeAppend: requireCompletedNativeNumericAppend,
    linearAppendFunction: preparedLinearNumericAppendReservation,
  };
}
function physicalReferenceErrorLiteralProducers() {
  return {
    reserve: reserveNativeStringLiteralResources,
    inventory: nativeStringLiteralReservationInventory,
    fill: fillNativeStringLiteralResources,
    requireCompleted: requireCompletedNativeStringLiterals,
    requireLiteral: requireNativeStringLiteral,
    globalMatches: nativeStringLiteralGlobalMatches,
  };
}

function materializePhysicalProgram(
  accepted: AcceptedPreparedIrProgram,
  plan: PhysicalSetupPlan,
  assertEmissionActive: () => void,
): EmittedPreparedIrProgram {
  assertEmissionActive();
  const { program, runtime } = accepted;
  const { record, native, abi: plannedAbi } = prepareNativeEmission(accepted, plan);
  let abi = plannedAbi;

  // 1. Reserve every physical resource before any body is lowered.
  const module = createEmptyModule();
  const reservations = new PhysicalModuleReservations(module);
  const functionsByKey = new Map<string, CallableReservation>();
  const globalsByKey = new Map<string, GlobalReservation | GlobalImportReservation>();
  const resourcesByBinding = new Map<IrBindingId, ConsumerReservation>();
  const typesByKey = new Map<string, TypeReservation>();
  const exceptionTag = reservePhysicalExceptionTag(plan, reservations);

  const { vectorTypes, stringTypes, earlyStrings, realm } = reserveNativeProgramFoundation(
    reservations,
    plan.vectors,
    native?.resources.literalRequirements,
    record.nativeStrings,
  );
  const sourceClosures = record.sourceClosures
    ? beginNativeSourceClosureEmission(
        reservations,
        record.sourceClosures,
        {
          vectors: vectorTypes,
          vectorPlan: plan.vectors,
          ...(record.sourceClosures.refCells.length
            ? { refCells: reserveNativeRefCells(reservations, record.sourceClosures) }
            : {}),
          ...(stringTypes
            ? { strings: { types: stringTypes, key: stringTypes.key, utf8Storage: stringTypes.utf8Storage } }
            : {}),
        },
        realm?.requests,
      )
    : undefined;
  const vectorProducers = physicalVectorCarrierProducers();
  const physicalSignature = physicalSignatureConverter(
    vectorProducers,
    vectorTypes,
    stringTypes,
    native?.formatterScratch,
    reservations,
    sourceClosures,
  );

  reservePhysicalImports(plan, reservations, physicalSignature, {
    functionsByKey,
    globalsByKey,
    resourcesByBinding,
  });

  const nativePack =
    earlyStrings ??
    (native && stringTypes && record.nativeStrings
      ? reserveNativeStringValueResources(reservations, record.nativeStrings, stringTypes)
      : undefined);
  const strings =
    nativePack?.strings ??
    (native?.resources.mode === "formatter-layout" && stringTypes
      ? reserveNativeStringLiteralResources(reservations, native.resources.literalRequirements, stringTypes)
      : undefined);
  const nativeRows = nativePack
    ? nativeStringValueReservationInventory(reservations, nativePack)
    : strings
      ? emptyLayoutRows(reservations, strings)
      : [];
  const reconciliation = {
    module,
    reservations,
    functionsByKey,
    globalsByKey,
    resourcesByBinding,
    typesByKey,
  };
  const nativeFunctions = reconcileNativeEmission(native, nativeRows, reconciliation);
  const formatter = plan.nativeNumberFormat;
  const formatterPack =
    formatter && strings
      ? reserveNativeNumberFormatResources(reservations, formatter.resources.input, strings)
      : undefined;
  const formatterRows = formatterPack ? nativeNumberFormatReservationInventory(reservations, formatterPack) : [];
  if (formatter) {
    if (!formatterPack || !strings) emissionFailed("formatter resources were not reserved");
    requireNativeNumberFormatReservations(reservations, formatterPack, formatter.resources.input, strings);
    const sharedTypes = new Map(
      nativeRows.flatMap((row) => (row.space === "type" ? [[row.key, row.reservation] as const] : [])),
    );
    const owned = reconcileNativeEmission(formatter, formatterRows, reconciliation, sharedTypes);
    for (const fn of owned) {
      if (nativeFunctions.has(fn)) emissionFailed("formatter and source resource function owners overlap");
      nativeFunctions.add(fn);
    }
  }
  const { slots, slotOwners } = reservePhysicalProgramSlots(plan, reconciliation, physicalSignature);
  const invocationPack =
    record.nativeInvocation && sourceClosures && nativePack?.number && record.nativeStrings?.valueRequirements
      ? reserveNativeInvocationResources(reservations, record.nativeInvocation, {
          source: sourceClosures.types,
          values: nativePack.number.values,
          valuePlan: record.nativeStrings.valueRequirements,
          valueDependencies: nativePack.number.dependencies,
          ...(nativePack.number.booleanBoxes ? { booleanBoxes: nativePack.number.booleanBoxes } : {}),
          strings: nativePack.strings,
          vectors: vectorTypes,
          vectorPlan: plan.vectors,
          ...(realm ? { substrate: realm.substrate } : {}),
        })
      : undefined;
  if (Boolean(invocationPack) !== Boolean(plan.nativeInvocation))
    emissionFailed("native invocation prerequisites were not reserved");
  const invocationFunctions = invocationPack ? nativeInvocationFunctions(reservations, invocationPack) : [];
  if (realm) reserveNativeRealmKernel(reservations, realm, sourceClosures?.types);
  const realmFunctions = realm ? nativeRealmReservationInventory(reservations, realm).functions : [];
  for (const token of [...invocationFunctions, ...realmFunctions]) {
    if (nativeFunctions.has(token.object)) emissionFailed("invocation function has competing native owners");
    nativeFunctions.add(token.object);
  }
  reconcileInvocationBindings(plan, invocationFunctions, reconciliation);
  const asyncReservations = new Map<IrUnitId, PreparedAsyncFrameReservations>();
  const supportFunctions = indexSupportFunctions([...nativeRows, ...formatterRows]);
  for (const token of [...invocationFunctions, ...realmFunctions]) supportFunctions.set(token.object, token);
  for (const frame of plan.asyncFrames?.frames ?? []) {
    const entry = slots.get(frame.owner);
    if (!entry || !exceptionTag) emissionFailed("async frame has no reserved entry or exception tag");
    const pack = reservePreparedAsyncFrame(reservations, frame, entry);
    asyncReservations.set(frame.owner, pack);
    resourcesByBinding.set(frame.frame.entry.id, pack.frame);
    typesByKey.set(irTypeBindingKey(frame.frame.reference.binding), pack.frame);
    for (const role of ["resume", "fulfillStep", "rejectStep"] as const) {
      const row = frame.auxiliaries[role];
      const token = pack[role];
      resourcesByBinding.set(row.bindingId, token);
      functionsByKey.set(irCallableBindingKey(row.reference.binding), token);
      supportFunctions.set(token.object, token);
    }
  }
  const vectorOwner = createNativeVectorEmission(accepted, plan, reconciliation, vectorProducers);
  const vectorEmission = vectorOwner.reserve(vectorTypes, exceptionTag, supportFunctions, assertEmissionActive);
  const vectorHelper = vectorEmission.externref;
  reserveNumberRemainders(plan, reconciliation, supportFunctions);
  const referenceError = reserveAndBindPhysicalReferenceError(
    reservations,
    plan.referenceError,
    assertEmissionActive,
    reconciliation,
    supportFunctions,
    physicalReferenceErrorLiteralProducers(),
  );
  const startAdapter = reserveStartupAdapter(plan, reservations);
  const startupGuard = plan.startup.onceGuard
    ? reservations.reserveGlobal("physical:startup-once", "__startup_once", { kind: "i32" }, true)
    : undefined;

  const linearPack = record.linearMemory
    ? reservePreparedLinearMemory(reservations, record.linearMemory, assertEmissionActive)
    : undefined;

  // 2. Freeze the index space: nothing below may add an import or a slot.
  reservations.freezeReservations();
  if (sourceClosures) bindNativeSourceClosureUnits(reservations, sourceClosures, slots);
  const exnTagIdx = exceptionTag === undefined ? undefined : reservations.physicalIndex(exceptionTag);
  fillPhysicalScalarResources(plan, reconciliation);
  const linearBindings = linearPack ? preparedLinearMemoryBindings(reservations, linearPack) : undefined;
  for (const token of linearBindings?.supportFunctions ?? []) supportFunctions.set(token.object, token);

  const appendBinding = vectorEmission.bind(linearPack);

  // 3. A's authoritative ABI over the program's entries, bound to the reserved indices.
  abi ??= sealedPhysicalProgramAbi(program);
  bindPhysicalAbi(abi, plan, { ...reconciliation, slots, vectorHelper });
  if (referenceError) fillPhysicalReferenceError(reservations, referenceError);
  if (linearPack) fillPreparedLinearMemory(reservations, linearPack);
  if (nativePack) fillNativeStringValueResources(reservations, nativePack);
  else if (strings) fillNativeStringLiteralResources(reservations, strings);
  if (realm) fillNativeRealmResources(reservations, realm);
  if (formatterPack) fillNativeNumberFormatResources(reservations, formatterPack);
  vectorEmission.fill();
  if (invocationPack) {
    if (!sourceClosures || !exceptionTag || !record.nativeInvocation)
      emissionFailed("native invocation lost its source or exception owner");
    fillNativeInvocationResources(
      reservations,
      invocationPack,
      nativeSourceClosureCallableBindings(reservations, sourceClosures, record.nativeInvocation),
      exceptionTag,
    );
  }

  // 4. Lower every physical body into its reserved slot.
  const resolver = activeEmissionResolver(
    physicalBodyResolver(
      vectorProducers,
      reconciliation,
      vectorTypes,
      stringTypes,
      exnTagIdx,
      sourceClosures,
      linearBindings,
      plan.target,
      appendBinding,
    ),
    assertEmissionActive,
  );
  const bodies = new Map<IrUnitId, IrFunction>(runtime.prepared.functions.map((fn) => [fn.unitId, fn] as const));
  if (formatterPack) {
    if (!record.nativeNumberFormat) emissionFailed("formatter support authority vanished");
    if (!formatter || resourcesByBinding.get(formatter.support.bindingId) !== formatterPack.functions["radix-body"])
      emissionFailed("formatter support slot differs from its accepted ABI owner");
    fillFormatterSupport(record.nativeNumberFormat, formatterPack, resolver, reservations, module);
    if (!nativeFunctions.delete(formatterPack.functions["radix-body"].object))
      emissionFailed("formatter support body is missing from its producer census");
  }
  for (const declared of plan.functions) {
    const fn = bodies.get(declared.unitId);
    const reserved = slots.get(declared.unitId);
    if (!fn || !reserved) emissionFailed(`physical body ${declared.unitId} vanished between acceptance and emission`);
    const asyncFrame = asyncReservations.get(declared.unitId);
    if (asyncFrame) {
      if (!exceptionTag) emissionFailed("async exception tag vanished");
      fillPreparedAsyncFrame(reservations, asyncFrame, fn, functionsByKey, exceptionTag, () => {
        assertEmissionActive();
        if (
          acceptances.get(accepted) !== record ||
          record.physical !== plan ||
          !runtime.prepared.functions.includes(fn)
        )
          emissionFailed("async frame belongs to a different acceptance");
      });
    } else
      fillPrimaryBody(
        accepted,
        declared,
        fn,
        reserved,
        resolver,
        nativePack,
        reservations,
        physicalSignature,
        assertEmissionActive,
        sourceClosures,
        linearBindings,
      );
  }

  // 5. Startup adapter and ABI export aliases (by their planned index space).
  fillStartupAdapter(startAdapter, plan, slots, reservations, startupGuard);
  publishPhysicalExports(plan, abi, reconciliation);

  if (nativePack?.output) publishNativeStringValueOutput(reservations, nativePack);
  if (referenceError) requireCompletedPhysicalReferenceError(reservations, referenceError);
  if (linearPack) requireCompletedPreparedLinearMemory(reservations, linearPack);
  vectorEmission.complete();
  const referenceErrorReceipt = referenceError
    ? completedPhysicalReferenceErrorReceipt(reservations, referenceError, module)
    : undefined;
  reservations.seal();
  if (sourceClosures) requireCompletedNativeSourceClosures(reservations, sourceClosures);
  if (realm) requireCompletedNativeRealmBootstrap(reservations, realm);
  if (invocationPack) requireCompletedNativeInvocation(reservations, invocationPack);
  if (nativePack) requireCompletedNativeStringValues(reservations, nativePack);
  else if (strings) requireCompletedNativeStringLiterals(reservations, strings);
  if (formatterPack) requireCompletedNativeNumberFormat(reservations, formatterPack);

  // 6. Receipts come from the module itself, never from the loop counter.
  const emittedUnitIds = collectPhysicalUnitReceipts(
    module,
    plan,
    slotOwners,
    new Set([
      ...nativeFunctions,
      ...supportFunctions.keys(),
      ...(startAdapter ? [startAdapter.object] : []),
      ...(vectorHelper ? [vectorHelper.function.object] : []),
      ...(formatterPack ? [formatterPack.functions["radix-body"].object] : []),
    ]),
  );
  const result: EmittedPreparedIrProgram = Object.freeze({ module, emittedUnitIds: Object.freeze(emittedUnitIds) });
  recordEmissionObservation(
    result,
    program,
    plan,
    abi,
    reservations,
    startAdapter,
    [...slots.values()],
    [...supportFunctions.values()],
    referenceErrorReceipt,
    vectorTypes,
    startupGuard,
  );
  return result;
}
