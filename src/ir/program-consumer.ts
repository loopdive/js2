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

import { sameValTypes } from "../wasm/physical/function-types.js";
import {
  planNativeStringValuePhysical,
  reserveNativeStringValueResources,
  nativeStringValueReservationInventory,
  fillNativeStringValueResources,
  requireCompletedNativeStringValues,
  emitPreparedNativeStringLiteral,
  type NativeStringValueReservationInput,
} from "../backend/wasmgc/program/native-string-values.js";
import { collectNativeStringValueDemands } from "./program/native-string-value-demands.js";
import { deriveNativeValueResourcePlan, assertNativeValueResourcePlanFor } from "./program/native-value-resources.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./program/data.js";
import {
  reserveNativeStringLiteralTypes,
  reserveNativeStringLiteralResources,
  nativeStringLiteralReservationInventory,
  fillNativeStringLiteralResources,
  requireCompletedNativeStringLiterals,
  type NativeStringLiteralReservations,
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
  reserveNativeVectorTypes,
  reserveNativeVectorHelper,
  fillNativeVectorHelper,
  nativeVectorPhysicalType,
  resolveNativeVector,
  resolveNativeVectorForElement,
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
import { forEachInstrDeep, type IrFuncRef, type IrFunction, type IrGlobalRef } from "./nodes.js";
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
import { createEmptyModule, type Instr, type ValType, type WasmFunction } from "./types.js";

// ---------------------------------------------------------------------------
// Module-private authority
// ---------------------------------------------------------------------------

interface AcceptanceRecord {
  readonly physical: PhysicalSetupPlan;
  /** Exact issued dependencies; never deep-clone the native-value plan. */
  readonly nativeStrings?: NativeStringValueReservationInput;
  readonly nativeSnapshot?: unknown;
  readonly nativeNumberFormat?: AcceptedNativeNumberFormat;
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
interface EmissionObservation {
  readonly startupAdapterIndex?: number;
  readonly bindings: readonly (readonly [IrBindingId, ProgramAbiFinalIndex])[];
}
/** Historical observations of successful emissions, not reservation authority. */
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

  let nativeStrings: NativeStringValueReservationInput | undefined;
  if (options.backend === "wasmgc" && options.target === "standalone") {
    const demands = collectNativeStringValueDemands(program, runtime);
    const native = planNativeStringValuePhysical(demands, {
      representation: "native-string",
      utf8Storage: options.utf8Storage === true,
    });
    if (native.kind !== "none" && native.kind !== "planned") return native;
    if (native.kind === "planned") {
      nativeStrings = Object.freeze({
        demands,
        plan: native.plan,
        ...(native.plan.mode === "number-boundary"
          ? { valueRequirements: deriveNativeValueResourcePlan(program, runtime, "native-string") }
          : {}),
      });
    }
  }
  const nativeNumberFormat = prepareNativeNumberFormat(program, options, runtime);
  const physical = planPhysicalSetup(program, options, runtime, nativeStrings, nativeNumberFormat);
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
      ...(nativeStrings ? { nativeStrings, nativeSnapshot: freezePreparedIrValue(nativeStrings.demands) } : {}),
      ...(nativeNumberFormat ? { nativeNumberFormat } : {}),
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

function defaultInit(type: ValType): Instr[] {
  switch (type.kind) {
    case "i32":
      return [{ op: "i32.const", value: 0 }];
    case "i64":
      return [{ op: "i64.const", value: 0n }];
    case "f32":
      return [{ op: "f32.const", value: 0 }];
    case "f64":
      return [{ op: "f64.const", value: 0 }];
    default:
      return emissionFailed(`no default initializer for global type ${type.kind}`);
  }
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
  const backend = options.backend;
  observePreparedIrProgram({ phase: "emission-started", program, backend, target: options.target });
  let result: EmittedPreparedIrProgram;
  try {
    result = materializePhysicalProgram(accepted, plan);
  } catch (error) {
    if (error instanceof PreparedIrProgramInvariantError) throw error;
    return emissionFailed(
      `physical module construction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  observePreparedIrProgram({ phase: "emitted", program, backend, target: options.target });
  return result;
}

/** Authenticate accepted native inputs and seal their ABI before any allocation. */
function prepareNativeEmission(accepted: AcceptedPreparedIrProgram, plan: PhysicalSetupPlan) {
  const { program, runtime } = accepted;
  const record = acceptances.get(accepted);
  if (!record || record.physical !== plan) emissionFailed("physical plan does not belong to acceptance");
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
    const current = planPhysicalSetup(program, accepted.options, runtime, record.nativeStrings, formatter);
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
  let abi: ProgramAbiMap | undefined;
  if (native) {
    // Native supplemental ABI is accepted planning data, sealed before even
    // the first physical reservation. Reused semantic entries stay unchanged.
    abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
    const entries = new Map(program.abi.entries.map((entry) => [entry.plan.id, entry.plan]));
    for (const entry of program.abi.entries) abi.plan(entry.plan);
    for (const binding of [...native.bindings, ...(plan.nativeNumberFormat?.bindings ?? [])]) {
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
  abi: ProgramAbiMap,
  reservations: PhysicalModuleReservations,
  startAdapter: FunctionReservation | undefined,
): void {
  const bindings: (readonly [IrBindingId, ProgramAbiFinalIndex])[] = [];
  for (const entry of abi.entries()) {
    const index = abi.resolveFinalIndex(entry.id);
    if (index) bindings.push(Object.freeze([entry.id, Object.freeze({ ...index })] as const));
  }
  startupAdapters.set(
    result,
    Object.freeze({
      ...(startAdapter ? { startupAdapterIndex: reservations.physicalIndex(startAdapter) } : {}),
      bindings: Object.freeze(bindings),
    }),
  );
}

function physicalSignatureConverter(
  vectorTypes: ReturnType<typeof reserveNativeVectorTypes>,
  stringTypes: ReturnType<typeof reserveNativeStringLiteralTypes> | undefined,
  formatterScratch: NonNullable<PhysicalSetupPlan["nativeStrings"]>["formatterScratch"],
) {
  const physicalSignature = (signature: {
    readonly params: readonly PhysicalSignatureType[];
    readonly results: readonly PhysicalSignatureType[];
  }) => {
    const convert = (types: readonly PhysicalSignatureType[]): ValType[] =>
      types.map((type) => {
        if (type.kind === "support-ref") {
          if (!stringTypes || !formatterScratch || preparedIrDataMismatch(type, formatterScratch) !== undefined)
            emissionFailed("support signature is not the accepted formatter scratch type");
          return { kind: type.nullable ? "ref_null" : "ref", typeIdx: stringTypes.layout.nativeStrDataTypeIdx };
        }
        if (type.kind === "string") {
          if (!stringTypes) emissionFailed("logical string signature has no accepted string resources");
          return { kind: "ref", typeIdx: stringTypes.layout.anyStrTypeIdx };
        }
        const value = nativeVectorPhysicalType(vectorTypes, type.kind === "vec" ? type : { kind: "val", val: type });
        if (!value) emissionFailed("accepted signature has no reserved physical carrier");
        return value;
      });
    return { params: convert(signature.params), results: convert(signature.results) };
  };

  return physicalSignature;
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
): void {
  const { backend, target } = accepted.options;
  let lowered: ReturnType<typeof lowerIrFunctionBody<Instr[], ValType>>;
  try {
    const ownerResolver: IrLowerResolver = nativePack
      ? {
          ...resolver,
          emitStringConst: (value, alloc, storage, materializer) =>
            emitPreparedNativeStringLiteral(reservations, nativePack, fn.unitId, value, alloc, storage, materializer),
        }
      : resolver;
    const emitter = backend === "wasmgc" ? new WasmGcEmitter(ownerResolver) : new LinearEmitter();
    lowered = lowerIrFunctionBody<Instr[], ValType>(
      fn,
      ownerResolver,
      emitter,
      wasmValueTypeConverter(backend, ownerResolver, fn.name),
    );
  } catch (error) {
    emissionFailed(
      `${backend}:${target} accepted body ${declared.unitId} and then failed to lower it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const params = lowered.params.flatMap((param) => [...param.slots]);
  const results = lowered.results.flatMap((result) => [...result]);
  const signature = physicalSignature(declared);
  if (!sameValTypes(params, signature.params) || !sameValTypes(results, signature.results))
    emissionFailed(`body ${declared.unitId} lowered to a signature that contradicts its reserved ABI slot`);
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

/** Publish the already reserved startup adapter without allocating a new slot. */
function fillStartupAdapter(
  startAdapter: FunctionReservation | undefined,
  plan: PhysicalSetupPlan,
  slots: ReadonlyMap<IrUnitId, FunctionReservation>,
  reservations: PhysicalModuleReservations,
): void {
  if (!startAdapter) return;
  const body = plan.startup.units.map((unitId): Instr => {
    const target = slots.get(unitId);
    if (!target) emissionFailed(`startup unit ${unitId} has no reserved slot`);
    return { op: "call", funcIdx: target.handle };
  });
  reservations.fillFunction(startAdapter, { locals: [], body });
  if (plan.startup.adapter === "wasm-start") reservations.defineStart(startAdapter);
  else if (plan.startup.adapter === "deferred-export")
    reservations.defineExport("publication:startup", "__module_init", startAdapter);
  else emissionFailed(`startup adapter ${plan.startup.adapter} has executable units but no materialization`);
}

/** No observation or reusable capability escapes the physical transaction. */
function materializePhysicalProgram(
  accepted: AcceptedPreparedIrProgram,
  plan: PhysicalSetupPlan,
): EmittedPreparedIrProgram {
  const { program, runtime } = accepted;
  const { record, native, abi: plannedAbi } = prepareNativeEmission(accepted, plan);
  let abi = plannedAbi;

  // 1. Reserve every physical resource before any body is lowered.
  const module = createEmptyModule();
  const reservations = new PhysicalModuleReservations(module);
  const functionsByKey = new Map<string, CallableReservation>();
  const globalsByKey = new Map<string, GlobalReservation | GlobalImportReservation>();
  const resourcesByBinding = new Map<
    IrBindingId,
    CallableReservation | GlobalReservation | GlobalImportReservation | TypeReservation
  >();
  const typesByKey = new Map<string, TypeReservation>();
  const exceptionTag = plan.exceptionTag.required
    ? reservations.reserveTag(
        "physical:exception-tag",
        { params: [{ kind: "externref" }], results: [] },
        plan.exceptionTag.shared
          ? { kind: "import", module: "env", name: "__exn" }
          : { kind: "defined", name: "__exn" },
      )
    : undefined;

  const vectorTypes = reserveNativeVectorTypes(reservations, plan.vectors);
  const stringTypes = native
    ? reserveNativeStringLiteralTypes(
        reservations,
        native.resources.key,
        native.resources.literalRequirements.utf8Storage,
      )
    : undefined;
  const physicalSignature = physicalSignatureConverter(vectorTypes, stringTypes, native?.formatterScratch);

  for (const imported of plan.importedFunctions) {
    const reserved = reservations.reserveFunctionImport(
      imported.bindingId,
      imported.module,
      imported.field,
      physicalSignature(imported),
    );
    functionsByKey.set(imported.referenceKey, reserved);
    resourcesByBinding.set(imported.bindingId, reserved);
  }
  for (const imported of plan.importedGlobals) {
    const reserved = reservations.reserveGlobalImport(
      imported.bindingId,
      imported.module,
      imported.field,
      imported.type,
      imported.mutable,
    );
    globalsByKey.set(imported.referenceKey, reserved);
    resourcesByBinding.set(imported.bindingId, reserved);
  }
  const nativePack =
    native && stringTypes && record.nativeStrings
      ? reserveNativeStringValueResources(reservations, record.nativeStrings, stringTypes)
      : undefined;
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
  if (formatter) {
    if (!formatterPack || !strings) emissionFailed("formatter resources were not reserved");
    requireNativeNumberFormatReservations(reservations, formatterPack, formatter.resources.input, strings);
    const sharedTypes = new Map(
      nativeRows.flatMap((row) => (row.space === "type" ? [[row.key, row.reservation] as const] : [])),
    );
    const owned = reconcileNativeEmission(
      formatter,
      nativeNumberFormatReservationInventory(reservations, formatterPack),
      reconciliation,
      sharedTypes,
    );
    for (const fn of owned) {
      if (nativeFunctions.has(fn)) emissionFailed("formatter and source resource function owners overlap");
      nativeFunctions.add(fn);
    }
  }
  for (const global of plan.definedGlobals) {
    const reserved = reservations.reserveGlobal(global.bindingId, global.name, global.type, global.mutable);
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
  const vectorHelper = reserveNativeVectorHelper(reservations, plan.vectors, vectorTypes, exceptionTag);
  if (vectorHelper) {
    if (!plan.vectors.helper) emissionFailed("vector helper has no authenticated binding plan");
    functionsByKey.set(plan.vectors.helper.referenceKey, vectorHelper.function);
    resourcesByBinding.set(plan.vectors.helper.bindingId, vectorHelper.function);
  } else if (plan.vectors.helper) {
    emissionFailed("planned vector helper was not reserved");
  }
  let startAdapter: FunctionReservation | undefined;
  if (plan.startup.units.length > 0) {
    startAdapter = reservations.reserveFunction("physical:startup-adapter", "__module_init", {
      params: [],
      results: [],
    });
  }

  // 2. Freeze the index space: nothing below may add an import or a slot.
  reservations.freezeReservations();
  const exnTagIdx = exceptionTag === undefined ? undefined : reservations.physicalIndex(exceptionTag);
  for (const global of plan.definedGlobals) {
    const reserved = globalsByKey.get(global.referenceKey);
    if (!reserved || reserved.kind !== "global") emissionFailed(`global ${global.name} has no defined reservation`);
    reservations.fillGlobal(reserved, defaultInit(global.type));
  }

  // 3. A's authoritative ABI over the program's entries, bound to the reserved indices.
  if (!abi) {
    abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
    for (const entry of program.abi.entries) abi.plan(entry.plan);
    abi.sealPlan();
  }
  for (const imported of plan.importedFunctions) {
    abi.bindFinalIndex(imported.bindingId, {
      space: "function",
      index: reservations.physicalIndex(functionsByKey.get(imported.referenceKey)!),
    });
  }
  for (const declared of plan.functions) {
    abi.bindFinalIndex(declared.bindingId, {
      space: "function",
      index: reservations.physicalIndex(slots.get(declared.unitId)!),
    });
  }
  if (vectorHelper && plan.vectors.helper) {
    abi.bindFinalIndex(plan.vectors.helper.bindingId, {
      space: "function",
      index: reservations.physicalIndex(vectorHelper.function),
    });
  }
  for (const global of [...plan.importedGlobals, ...plan.definedGlobals]) {
    abi.bindFinalIndex(global.bindingId, {
      space: "global",
      index: reservations.physicalIndex(globalsByKey.get(global.referenceKey)!),
    });
  }
  if (native) {
    const bound = new Set<IrBindingId>();
    for (const binding of [...native.bindings, ...(formatter?.bindings ?? [])]) {
      if (bound.has(binding.entry.id)) continue;
      const resource = resourcesByBinding.get(binding.entry.id);
      if (!resource || binding.entry.slotPolicy !== "required") emissionFailed("native ABI resource vanished");
      abi.bindFinalIndex(binding.entry.id, {
        space: binding.entry.slotSpace,
        index: reservations.physicalIndex(resource),
      });
      bound.add(binding.entry.id);
    }
  }
  abi.finishBinding();
  if (nativePack) fillNativeStringValueResources(reservations, nativePack);
  else if (strings) fillNativeStringLiteralResources(reservations, strings);
  if (formatterPack) fillNativeNumberFormatResources(reservations, formatterPack);
  if (vectorHelper) fillNativeVectorHelper(reservations, vectorHelper);

  // 4. Lower every physical body into its reserved slot.
  // Resource validation authenticates this exact shared two-field layout.
  const vectorLowering = (layout: ReturnType<typeof resolveNativeVector>) =>
    layout ? { ...layout, lengthFieldIdx: 0, dataFieldIdx: 1 } : null;
  const resolver: IrLowerResolver = {
    resolveFunc: (ref: IrFuncRef) => {
      const reserved = functionsByKey.get(irCallableBindingKey(ref.binding));
      if (!reserved) emissionFailed(`callable ${ref.name} (${ref.binding.kind}) was not reserved`);
      return reserved.handle;
    },
    resolveGlobal: (ref: IrGlobalRef) => {
      const reserved = globalsByKey.get(irGlobalBindingKey(ref.binding));
      if (!reserved) emissionFailed(`global ${ref.name} (${ref.binding.kind}) was not reserved`);
      return reservations.physicalIndex(reserved);
    },
    resolveType: (ref) => {
      const reserved = typesByKey.get(irTypeBindingKey(ref.binding));
      if (!reserved) emissionFailed(`type ${ref.name} was not reserved`);
      return reservations.physicalIndex(reserved);
    },
    ...(stringTypes
      ? {
          resolveString: (): ValType => ({ kind: "ref", typeIdx: stringTypes.layout.anyStrTypeIdx }),
          nativeStrings: () => true,
        }
      : {}),
    resolveVec: (type) => vectorLowering(resolveNativeVector(vectorTypes, type)),
    resolveVecForElement: (element) => vectorLowering(resolveNativeVectorForElement(vectorTypes, element)),
    internFuncType: (type) => reservations.internFunctionType(type.params, type.results),
    ensureExnTag: () => {
      if (exnTagIdx === undefined) emissionFailed("a body requires the __exn tag but the plan reserved none");
      return exnTagIdx;
    },
  };
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
    fillPrimaryBody(accepted, declared, fn, reserved, resolver, nativePack, reservations, physicalSignature);
  }

  // 5. Startup adapter and ABI export aliases (by their planned index space).
  fillStartupAdapter(startAdapter, plan, slots, reservations);
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

  reservations.seal();
  if (nativePack) requireCompletedNativeStringValues(reservations, nativePack);
  else if (strings) requireCompletedNativeStringLiterals(reservations, strings);
  if (formatterPack) requireCompletedNativeNumberFormat(reservations, formatterPack);

  // 6. Receipts come from the module itself, never from the loop counter.
  const emittedUnitIds: IrUnitId[] = [];
  for (const fn of module.functions) {
    const unitId = slotOwners.get(fn);
    if (unitId === undefined) {
      if (
        fn !== startAdapter?.object &&
        fn !== vectorHelper?.function.object &&
        fn !== formatterPack?.functions["radix-body"].object &&
        !nativeFunctions.has(fn)
      ) {
        emissionFailed(`module carries an unowned function ${fn.name}`);
      }
      continue;
    }
    emittedUnitIds.push(unitId);
  }
  if (emittedUnitIds.length !== plan.functions.length) {
    emissionFailed(`module holds ${emittedUnitIds.length} owned bodies but the plan reserved ${plan.functions.length}`);
  }
  if (emittedUnitIds.some((unitId, index) => unitId !== plan.functions[index]!.unitId)) {
    emissionFailed("module function ownership order contradicts the reserved program projection");
  }
  const result: EmittedPreparedIrProgram = Object.freeze({ module, emittedUnitIds: Object.freeze(emittedUnitIds) });
  recordEmissionObservation(result, abi, reservations, startAdapter);
  return result;
}
