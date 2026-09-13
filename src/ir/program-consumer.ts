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
} from "../wasm/physical/module-reservations.js";
import { irGlobalBindingKey } from "./abi-bindings.js";
import { verifyIrBackendLegality } from "./backend/legality.js";
import { LinearEmitter } from "./backend/linear-emitter.js";
import { WasmGcEmitter } from "./backend/wasmgc-emitter.js";
import { irCallableBindingKey } from "./callable-bindings.js";
import type { IrBindingId, IrUnitId } from "./identity.js";
import { lowerIrFunctionBody, wasmValueTypeConverter, type IrLowerResolver } from "./lower.js";
import { forEachInstrDeep, type IrFuncRef, type IrFunction, type IrGlobalRef } from "./nodes.js";
import type { IrPreparationFailure } from "./outcomes.js";
import { ProgramAbiMap } from "./program-abi.js";
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

/** Acceptance → its deep-frozen physical plan. Only acceptances minted here are known. */
const acceptances = new WeakMap<AcceptedPreparedIrProgram, PhysicalSetupPlan>();
/** Acceptances whose emission has begun (successfully or not); each may begin once. */
const emissions = new WeakSet<AcceptedPreparedIrProgram>();
/** Emission result → the startup adapter's function index, when one was constructed. */
const startupAdapters = new WeakMap<EmittedPreparedIrProgram, number>();

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

/** Exact option data: no own `linear` property unless one was supplied. */
function canonicalOptions(options: PreparedIrBackendOptions): PreparedIrBackendOptions {
  const base = {
    backend: options.backend,
    target: options.target,
    sharedExceptionTag: options.sharedExceptionTag,
    utf8Storage: options.utf8Storage,
    sourceMap: options.sourceMap,
    moduleName: options.moduleName,
  };
  return Object.freeze(options.linear === undefined ? base : { ...base, linear: Object.freeze({ ...options.linear }) });
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

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

  const physical = planPhysicalSetup(program, options, runtime);
  if (physical.kind !== "planned") return physical;

  const accepted = Object.freeze({
    kind: "accepted",
    program,
    options: canonicalOptions(options),
    runtime,
  }) as unknown as AcceptedPreparedIrProgram;
  acceptances.set(accepted, physical.plan);
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
  const plan = acceptances.get(accepted);
  if (!plan)
    programInvariant("invalid-transaction-capability", "acceptance was not produced by acceptPreparedIrProgram");
  return plan;
}

/** Function index of the startup adapter this emission constructed, if any. */
export function emittedStartupAdapterIndex(emitted: EmittedPreparedIrProgram): number | undefined {
  return startupAdapters.get(emitted);
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

/** No observation or reusable capability escapes the physical transaction. */
function materializePhysicalProgram(
  accepted: AcceptedPreparedIrProgram,
  plan: PhysicalSetupPlan,
): EmittedPreparedIrProgram {
  const { program, options, runtime } = accepted;
  const backend = options.backend;

  // 1. Reserve every physical resource before any body is lowered.
  const module = createEmptyModule();
  const reservations = new PhysicalModuleReservations(module);
  const functionsByKey = new Map<string, CallableReservation>();
  const globalsByKey = new Map<string, GlobalReservation | GlobalImportReservation>();
  const resourcesByBinding = new Map<IrBindingId, CallableReservation | GlobalReservation | GlobalImportReservation>();
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
  const physicalSignature = (signature: {
    readonly params: readonly PhysicalSignatureType[];
    readonly results: readonly PhysicalSignatureType[];
  }) => {
    const convert = (types: readonly PhysicalSignatureType[]): ValType[] =>
      types.map((type) => {
        const value = nativeVectorPhysicalType(vectorTypes, type.kind === "vec" ? type : { kind: "val", val: type });
        if (!value) emissionFailed("accepted signature has no reserved physical carrier");
        return value;
      });
    return { params: convert(signature.params), results: convert(signature.results) };
  };

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
  const abi = new ProgramAbiMap(program.inventory, program.derivedUnits);
  for (const entry of program.abi.entries) abi.plan(entry.plan);
  abi.sealPlan();
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
  abi.finishBinding();
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
    resolveType: (ref) => emissionFailed(`type ${ref.name} was not reserved`),
    resolveVec: (type) => vectorLowering(resolveNativeVector(vectorTypes, type)),
    resolveVecForElement: (element) => vectorLowering(resolveNativeVectorForElement(vectorTypes, element)),
    internFuncType: (type) => reservations.internFunctionType(type.params, type.results),
    ensureExnTag: () => {
      if (exnTagIdx === undefined) emissionFailed("a body requires the __exn tag but the plan reserved none");
      return exnTagIdx;
    },
  };
  const bodies = new Map<IrUnitId, IrFunction>(runtime.prepared.functions.map((fn) => [fn.unitId, fn] as const));
  for (const declared of plan.functions) {
    const fn = bodies.get(declared.unitId);
    const reserved = slots.get(declared.unitId);
    if (!fn || !reserved) emissionFailed(`physical body ${declared.unitId} vanished between acceptance and emission`);
    let lowered: ReturnType<typeof lowerIrFunctionBody<Instr[], ValType>>;
    try {
      const emitter = backend === "wasmgc" ? new WasmGcEmitter(resolver) : new LinearEmitter();
      lowered = lowerIrFunctionBody<Instr[], ValType>(
        fn,
        resolver,
        emitter,
        wasmValueTypeConverter(backend, resolver, fn.name),
      );
    } catch (error) {
      emissionFailed(
        `${backend}:${options.target} accepted body ${declared.unitId} and then failed to lower it: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const params = lowered.params.flatMap((param) => [...param.slots]);
    const results = lowered.results.flatMap((result) => [...result]);
    const signature = physicalSignature(declared);
    if (!sameValTypes(params, signature.params) || !sameValTypes(results, signature.results)) {
      emissionFailed(`body ${declared.unitId} lowered to a signature that contradicts its reserved ABI slot`);
    }
    reservations.fillFunction(reserved, {
      locals: lowered.locals.flatMap((local) =>
        local.slots.map((type, slot) => ({ name: slot === 0 ? local.name : `${local.name}$${slot}`, type })),
      ),
      body: lowered.body,
    });
  }

  // 5. Startup adapter and ABI export aliases (by their planned index space).
  if (startAdapter) {
    const body = plan.startup.units.map((unitId): Instr => {
      const target = slots.get(unitId);
      if (!target) emissionFailed(`startup unit ${unitId} has no reserved slot`);
      return { op: "call", funcIdx: target.handle };
    });
    reservations.fillFunction(startAdapter, { locals: [], body });
    if (plan.startup.adapter === "wasm-start") reservations.defineStart(startAdapter);
    else if (plan.startup.adapter === "deferred-export") {
      reservations.defineExport("publication:startup", "__module_init", startAdapter);
    } else emissionFailed(`startup adapter ${plan.startup.adapter} has executable units but no materialization`);
  }
  const exportNames = new Set<string>(module.exports.map((entry) => entry.name));
  for (const exported of plan.exports) {
    const final = abi.resolveFinalIndex(exported.targetBindingId);
    if (!final || final.space !== exported.space) {
      emissionFailed(`export ${exported.externalName} does not resolve to a bound ${exported.space}`);
    }
    const reserved = resourcesByBinding.get(abi.canonicalId(exported.targetBindingId));
    if (
      !reserved ||
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

  // 6. Receipts come from the module itself, never from the loop counter.
  const emittedUnitIds: IrUnitId[] = [];
  for (const fn of module.functions) {
    const unitId = slotOwners.get(fn);
    if (unitId === undefined) {
      if (fn !== startAdapter?.object && fn !== vectorHelper?.function.object) {
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
  if (startAdapter) startupAdapters.set(result, reservations.physicalIndex(startAdapter));
  return result;
}
