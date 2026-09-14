// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { irCallableBindingKey } from "./callable-bindings.js";
import { irTypeEquals } from "./core/types.js";
import type { IrValueId } from "./core/nodes.js";
import type { IrType } from "./nodes.js";
import { preparedIrCallableSignature } from "./program-abi-contracts.js";
import { preparedIrRuntimeAbiAnchor, preparedIrRuntimeCallableBindingId } from "./program-runtime-abi.js";
import { preparedIrDataMismatch } from "./program/data.js";
import {
  collectNativeStringValueDemands,
  type NativeStringValueDemands,
} from "./program/native-string-value-demands.js";
import { assertPreparedIrProgram } from "./program-validation.js";
import {
  PreparedIrProgramInvariantError,
  type PreparedIrProgram,
  type PreparedIrBackendOptions,
  type PreparedIrProgramRuntimeProjection,
} from "./program.js";
import {
  deriveNativePromiseResourcePlan,
  type NativePromiseConfiguration,
  type NativePromiseResourcePlan,
} from "./program/native-promise-resources.js";
import {
  irNativeAsyncCallableDeclaration,
  nativeAsyncCallMismatch,
  nativeAsyncCallablePolicyMismatch,
  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
} from "./runtime/native-async-callables.js";
import type { PhysicalModuleReservations } from "../wasm/physical/module-reservations.js";
import { assertNativePromiseResourcePlanFor } from "../backend/wasmgc/resources/native-promises.js";
import {
  declareNativeDelayCombinatorResources,
  reserveNativeDelayCombinatorResources,
  nativeDelayCombinatorReservationInventory,
  assertNativeDelayCombinatorReservationInputFor,
  type NativeDelayCombinatorSelection,
  type NativeDelayCombinatorRequirements,
  type NativeDelayCombinatorDeclarationPlan,
  type NativeDelayCombinatorReservationDependencies,
  type NativeDelayCombinatorReservations,
} from "../backend/wasmgc/resources/native-delay-combinator.js";

/** Authenticate the program and projection; runtime configuration remains an explicit caller choice. */
export function planNativePromiseResources(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  configuration: NativePromiseConfiguration,
): NativePromiseResourcePlan {
  assertPreparedIrProgram(program);
  if (
    !program.runtime.includes(projection) ||
    projection.backend !== options.backend ||
    projection.target !== options.target
  ) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native Promise resources: selected projection does not belong to the requested program/backend/target",
    );
  }
  const entry = program.inventory.sources.find((source) => source.kind === "entry");
  if (!entry) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-data",
      "native Promise resources: missing entry-source anchor",
    );
  }
  return deriveNativePromiseResourcePlan({
    anchor: entry.id,
    functions: program.ir.functions,
    selectedFunctions: projection.prepared.functions,
    derivedUnits: program.derivedUnits,
    abiEntries: program.abi.entries,
    policy: projection.prepared.manifest.policy,
    providers: projection.prepared.manifest.providers,
    backend: options.backend,
    target: options.target,
    configuration,
  });
}

function delayCombinatorInvalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native delay/combinator: ${detail}`);
}

function delayCombinatorSame(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) delayCombinatorInvalid(detail);
}

/** All three buffer families contribute SSA facts, including executable runtime states. */
function delayCombinatorValueTypes(
  demands: NativeStringValueDemands,
  buffer: NativeStringValueDemands["buffers"][number],
): ReadonlyMap<IrValueId, IrType> {
  const owner = demands.owners.find((row) => row.unitId === buffer.ownerUnitId);
  if (!owner) delayCombinatorInvalid("missing call owner");
  const fn = buffer.view === "program" ? owner.programFunction : owner.projectedFunction;
  const types = new Map<IrValueId, IrType>();
  const note = (id: IrValueId, type: IrType): void => {
    const previous = types.get(id);
    if (previous && !irTypeEquals(previous, type)) delayCombinatorInvalid("conflicting call operand type");
    types.set(id, type);
  };
  fn.params.forEach((row) => note(row.value, row.type));
  fn.asyncPlan?.values.forEach((row) => note(row.value, row.type));
  fn.blocks.forEach((block) =>
    block.blockArgs.forEach((id, index) => {
      if (block.blockArgTypes[index]) note(id, block.blockArgTypes[index]!);
    }),
  );
  for (const occurrence of demands.occurrences) {
    const coordinate = demands.buffers[occurrence.bufferIndex]!;
    if (coordinate.ownerUnitId !== buffer.ownerUnitId || coordinate.view !== buffer.view) continue;
    const instruction = occurrence.instruction;
    if (instruction.result !== null && instruction.resultType) note(instruction.result, instruction.resultType);
  }
  return types;
}

/** Source authority lives here; the backend recipe and its inventory are descriptive. */
export function planPreparedNativeDelayCombinatorResources(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  configuration: NativePromiseConfiguration,
  requests: NativeDelayCombinatorSelection,
): NativeDelayCombinatorRequirements | undefined {
  const promiseRequirements = planNativePromiseResources(program, options, projection, configuration);
  if (options.backend !== "wasmgc" || options.target !== "standalone")
    delayCombinatorInvalid("resources require standalone WasmGC");
  const demands = collectNativeStringValueDemands(program, projection);
  const uses: NativeDelayCombinatorRequirements["uses"][number][] = [];
  for (const [index, occurrence] of demands.occurrences.entries()) {
    if (!Object.hasOwn(demands.occurrences, index)) delayCombinatorInvalid("missing occurrence coordinate");
    const buffer = demands.buffers[occurrence.bufferIndex];
    if (
      !buffer ||
      !Object.hasOwn(demands.buffers, occurrence.bufferIndex) ||
      !Object.hasOwn(buffer.instructions, occurrence.instructionIndex) ||
      buffer.instructions[occurrence.instructionIndex] !== occurrence.instruction
    )
      delayCombinatorInvalid("detached call coordinate");
    const call = occurrence.instruction;
    if (call.kind !== "call") continue;
    const declaration = irNativeAsyncCallableDeclaration(call.target);
    if (declaration?.feature !== "async.native.delay" && declaration?.feature !== "async.native.all") continue;
    const policyMismatch = nativeAsyncCallablePolicyMismatch(declaration.feature, projection.prepared.manifest.policy);
    if (policyMismatch) delayCombinatorInvalid(policyMismatch);
    const mismatch = nativeAsyncCallMismatch(call, declaration, delayCombinatorValueTypes(demands, buffer));
    if (mismatch) delayCombinatorInvalid(mismatch);
    delayCombinatorSame(call.target.binding, declaration.ref.binding, "noncanonical call binding");
    const provider = NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS.find((row) => row.feature === declaration.feature);
    if (!provider) delayCombinatorInvalid("missing canonical provider");
    const selected = projection.prepared.manifest.providers.filter(
      (row) => row.id === provider.id || row.feature === provider.feature,
    );
    if (selected.length !== 1) delayCombinatorInvalid("missing or duplicate selected provider");
    delayCombinatorSame(selected[0], provider, "noncanonical complete provider definition");
    const id = preparedIrRuntimeCallableBindingId(program.inventory, declaration.ref);
    const entries = program.abi.entries.filter((row) => row.plan.id === id);
    const entry = entries[0];
    if (
      entries.length !== 1 ||
      !entry ||
      entry.contract.kind !== "callable" ||
      Object.hasOwn(entry.contract, "promise")
    )
      delayCombinatorInvalid("missing canonical synchronous callable ABI owner");
    if (entry.plan.order.sourceOrder !== preparedIrRuntimeAbiAnchor(program.inventory).order)
      delayCombinatorInvalid("foreign callable source provenance");
    delayCombinatorSame(
      entry.contract,
      {
        kind: "callable",
        ref: entry.contract.ref,
        params: declaration.params,
        results: declaration.results,
      },
      "noncanonical complete callable contract",
    );
    delayCombinatorSame(entry.contract.ref.binding, declaration.ref.binding, "foreign callable ABI binding");
    delayCombinatorSame(
      entry.plan,
      {
        id,
        order: entry.plan.order,
        displayName: entry.plan.displayName,
        structuralReferenceKey: irCallableBindingKey(declaration.ref.binding),
        slotPolicy: "required",
        slotSpace: "function",
        intent: {
          kind: "callable",
          origin: "runtime",
          signature: preparedIrCallableSignature(declaration.params, declaration.results),
        },
      },
      "noncanonical required callable ABI plan",
    );
    uses.push(
      Object.freeze({ occurrence: index, kind: declaration.feature === "async.native.delay" ? "delay" : "all" }),
    );
  }
  if (!uses.length) return undefined;
  const delay = uses.some((row) => row.kind === "delay");
  if (
    !requests ||
    !Object.hasOwn(requests, "settleMetadataRequestId") ||
    typeof requests.settleMetadataRequestId !== "string" ||
    !requests.settleMetadataRequestId.length
  )
    delayCombinatorInvalid("missing explicit settlement metadata request");
  if (
    delay
      ? !Object.hasOwn(requests, "delaySignatureRequestId") ||
        typeof requests.delaySignatureRequestId !== "string" ||
        !requests.delaySignatureRequestId.length
      : Object.hasOwn(requests, "delaySignatureRequestId")
  )
    delayCombinatorInvalid("delay signature request must match selected delay demand");
  const entry = program.inventory.sources.find((source) => source.kind === "entry");
  if (!entry) delayCombinatorInvalid("missing entry-source anchor");
  return Object.freeze({
    key: `native-delay-combinator:v1:${JSON.stringify(entry.id)}`,
    demands,
    promiseRequirements,
    requests: Object.freeze({
      settleMetadataRequestId: requests.settleMetadataRequestId,
      ...(delay ? { delaySignatureRequestId: requests.delaySignatureRequestId! } : {}),
    }),
    uses: Object.freeze(uses),
    delay,
    all: uses.some((row) => row.kind === "all"),
  });
}

/** Recheck source and borrowed identities before the lower owner allocates anything. */
function assertPreparedNativeDelayCombinatorReservationInput(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  configuration: NativePromiseConfiguration,
  tx: PhysicalModuleReservations,
  requirements: NativeDelayCombinatorRequirements,
  dependencies: NativeDelayCombinatorReservationDependencies,
  expectedPlan: NativeDelayCombinatorDeclarationPlan,
): void {
  const current = planPreparedNativeDelayCombinatorResources(
    program,
    options,
    projection,
    configuration,
    requirements.requests,
  );
  if (!current) delayCombinatorInvalid("no selected delay/combinator calls");
  delayCombinatorSame(requirements, current, "changed or incomplete source requirements");
  const demands = requirements.demands,
    fresh = current.demands;
  if (
    demands.program !== program ||
    demands.projection !== projection ||
    demands.allocations !== fresh.allocations ||
    fresh.owners.some(
      (row, i) =>
        row.programFunction !== demands.owners[i]?.programFunction ||
        row.projectedFunction !== demands.owners[i]?.projectedFunction,
    ) ||
    fresh.buffers.some((row, i) => row.instructions !== demands.buffers[i]?.instructions) ||
    fresh.occurrences.some((row, i) => row.instruction !== demands.occurrences[i]?.instruction)
  )
    delayCombinatorInvalid("detached borrowed source census");
  fresh.literals.forEach((row, index) => {
    const prior = demands.literals[index];
    if (row.kind !== "string.const" || prior?.kind !== "string.const") return;
    const actual = row.allocation,
      previous = prior.allocation;
    if (
      (actual.metadataRow.present &&
        (!previous.metadataRow.present || actual.metadataRow.value !== previous.metadataRow.value)) ||
      (actual.encoding.present &&
        (!previous.encoding.present || !Object.is(actual.encoding.value, previous.encoding.value)))
    )
      delayCombinatorInvalid("detached allocation metadata");
  });
  const vectors = dependencies.vectors.layouts.filter((row) => row.element === "externref");
  if (vectors.length !== 1) delayCombinatorInvalid("missing unique shared externref vector");
  const plan = declareNativeDelayCombinatorResources(requirements, {
    closurePlan: dependencies.closurePlan,
    promisePlan: dependencies.promisePlan,
    vectorCarrierKey: vectors[0]!.carrier.key,
    vectorArrayKey: vectors[0]!.array.key,
  });
  delayCombinatorSame(expectedPlan, plan, "declaration recipe differs from actual producer dependencies");
  assertNativePromiseResourcePlanFor(
    tx,
    dependencies.promises,
    dependencies.promisePlan,
    requirements.promiseRequirements,
  );
}

export function reservePreparedNativeDelayCombinatorResources(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  configuration: NativePromiseConfiguration,
  tx: PhysicalModuleReservations,
  requirements: NativeDelayCombinatorRequirements,
  dependencies: NativeDelayCombinatorReservationDependencies,
  expectedPlan: NativeDelayCombinatorDeclarationPlan,
): NativeDelayCombinatorReservations {
  assertPreparedNativeDelayCombinatorReservationInput(
    program,
    options,
    projection,
    configuration,
    tx,
    requirements,
    dependencies,
    expectedPlan,
  );
  return reserveNativeDelayCombinatorResources(tx, requirements, dependencies, expectedPlan);
}

/** Revalidate source admission whenever the parent consumes the reserved inventory. */
export function preparedNativeDelayCombinatorReservationInventory(
  program: PreparedIrProgram,
  options: PreparedIrBackendOptions,
  projection: PreparedIrProgramRuntimeProjection,
  configuration: NativePromiseConfiguration,
  tx: PhysicalModuleReservations,
  requirements: NativeDelayCombinatorRequirements,
  dependencies: NativeDelayCombinatorReservationDependencies,
  expectedPlan: NativeDelayCombinatorDeclarationPlan,
  pack: NativeDelayCombinatorReservations,
) {
  assertPreparedNativeDelayCombinatorReservationInput(
    program,
    options,
    projection,
    configuration,
    tx,
    requirements,
    dependencies,
    expectedPlan,
  );
  assertNativeDelayCombinatorReservationInputFor(tx, pack, expectedPlan, requirements, dependencies);
  return nativeDelayCombinatorReservationInventory(tx, pack, expectedPlan);
}
