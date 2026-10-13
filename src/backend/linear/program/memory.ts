// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { PreparedIrBackendOptions } from "../../../ir/program.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "../../../ir/program/prepared-contracts.js";
import {
  assertPreparedIrData,
  freezePreparedIrValue,
  preparedIrDataMismatch,
} from "../../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../../shared/contracts/prepared-ir-invariant-error.js";
import { requirePreparedLinearMemoryInput } from "../../../ir/program/linear-allocation-facts.js";
import { collectPreparedLinearMemoryDemand } from "../../../ir/program/linear-memory-demand.js";
import {
  DEFAULT_ARENA_POLICY,
  planLinearMemoryFromFrozenFacts,
  type LinearMemoryPlan,
} from "../../../ir/analysis/linear-memory-from-facts.js";
import type { LinearRuntimeOperation } from "../../../ir/analysis/contracts/linear-memory-layout.js";
import type { IrType } from "../../../ir/core/types.js";
import type { AllocSiteId } from "../../../ir/core/nodes.js";
import type { LinearVecLowering } from "../../../ir/backend/handles.js";
import { IrUnsupportedError } from "../../../shared/contracts/ir-preparation-errors.js";
import { LINEAR_ARRAY_FORWARDING } from "../../../shared/contracts/linear-memory-layout.js";
import {
  describeLinearBumpArena,
  buildLinearBumpAllocationBody,
} from "../../../wasm/physical/linear-bump-allocation.js";
import {
  describeLinearArrayConstructor,
  buildLinearArrayConstructorBody,
} from "../../../wasm/physical/linear-array-constructor.js";
import {
  describeLinearF64VectorInitialization,
  buildLinearF64VectorInitializationBody,
} from "../../../wasm/physical/linear-vector-initialization.js";
import { buildArrayForwardingResolverBody } from "../../../codegen-linear/runtime/arrays/forwarding-resolver.js";
import type {
  FunctionReservation,
  GlobalReservation,
  MemoryReservation,
  PhysicalModuleReservations,
} from "../../../wasm/physical/module-reservations.js";
import type { WasmExport } from "../../../wasm/model/module-records.js";
import type { PreparedLinearMemoryPlan, PreparedLinearMemoryResult } from "./contracts.js";

interface IssuedPlan {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly options: PreparedIrBackendOptions;
  readonly frozenInputs: unknown;
  readonly planner: LinearMemoryPlan;
  used: boolean;
  failed?: boolean;
}
const issued = new WeakMap<PreparedLinearMemoryPlan, IssuedPlan>();
/** In-process opaque identity, never target DATA or a public receipt. */
export interface PreparedLinearMemoryReservations {
  readonly kind: "prepared-linear-memory-reservations";
}
interface Pack {
  readonly tx: PhysicalModuleReservations;
  readonly plan: PreparedLinearMemoryPlan;
  readonly issuance: IssuedPlan;
  readonly assertEmissionActive: () => void;
  readonly functions: readonly FunctionReservation[];
  readonly memory?: MemoryReservation;
  readonly heap?: GlobalReservation;
  exports: WasmExport[];
  typeIndices?: readonly number[];
  state: "reserved" | "bindings-ready" | "filled" | "verified" | "failed";
}
const packs = new WeakMap<PreparedLinearMemoryReservations, Pack>();
export interface PreparedLinearBodyBindings {
  readonly supportFunctions: readonly FunctionReservation[];
  resolveVectorLayout(element: IrType, allocation?: AllocSiteId): LinearVecLowering;
  resolveRuntimeOperation(operation: LinearRuntimeOperation): number;
}
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("emission-failed", `Linear memory pack: ${detail}`);
}
function unsupported(detail: string, location?: unknown): never {
  throw new IrUnsupportedError("array-representation-unsupported", "resolve", detail, location);
}
function current(plan: PreparedLinearMemoryPlan, record: IssuedPlan): void {
  if (
    preparedIrDataMismatch(record.frozenInputs, {
      program: record.program,
      projection: record.projection,
      options: record.options,
    })
  )
    invalid("issued plan input changed");
  if (!record.program.runtime.includes(record.projection)) invalid("projection identity changed");
  if (issued.get(plan) !== record) invalid("unknown issued plan");
}

/** Pure option refusal shared by planning and genuine zero-resource callers. */
export function linearMemoryOptionsUnsupported(options: PreparedIrBackendOptions): string | undefined {
  const linear = options.linear;
  if (
    linear &&
    (linear.exposeArenaReset ||
      (linear.allocationPolicy !== undefined && linear.allocationPolicy !== "arena-v1") ||
      linear.importMemory ||
      linear.linkedHeap ||
      (linear.heapAllocator !== undefined && linear.heapAllocator !== "bump") ||
      (linear.externImports?.length ?? 0) > 0)
  )
    return "only the default numeric f64 bump arena resource recipe is supported";
  return undefined;
}

export function planPreparedLinearMemory(input: {
  program: PreparedIrProgram;
  projection: PreparedIrProgramRuntimeProjection;
  options: PreparedIrBackendOptions;
}): PreparedLinearMemoryResult {
  assertPreparedIrData(input);
  const { program, projection, options } = input;
  if (!program.runtime.includes(projection)) invalid("projection is not an owned runtime attachment");
  try {
    if (
      projection.backend !== "linear" ||
      !["standalone", "wasi"].includes(projection.target) ||
      options.backend !== projection.backend ||
      options.target !== projection.target
    )
      unsupported("requires matching native Linear projection and options");
    const optionGap = linearMemoryOptionsUnsupported(options);
    if (optionGap) unsupported(optionGap);
    const checked = requirePreparedLinearMemoryInput(program, projection);
    const planner = planLinearMemoryFromFrozenFacts(checked.module, checked.facts, DEFAULT_ARENA_POLICY);
    const demand = collectPreparedLinearMemoryDemand(checked);
    const constructors = new Set(
      demand.occurrences.filter((at) => at.kind === "vec.new_fixed").map((at) => at.allocationId),
    );
    for (const at of demand.occurrences) {
      if (at.functionIndex >= projection.prepared.functions.length || !program.units.has(at.unitId))
        unsupported("allocating support is not admitted by the numeric vector recipe", at);
      const allocation = planner.allocation(at.allocationId);
      if (!allocation || allocation.ownerFunction !== at.ownerFunction || !constructors.has(at.allocationId))
        unsupported("vector demand lacks its exact canonical constructor owner", at);
      const layout = planner.requireLayout(allocation.layoutId);
      if (
        layout.kind !== "vector" ||
        layout.elementStorage !== "f64" ||
        layout.elementStride !== 8 ||
        layout.elementsOffset !== 16 ||
        layout.lengthOffset !== 8 ||
        layout.capacityOffset !== 12 ||
        allocation.allocationClass !== "arena"
      )
        unsupported("vector demand is outside the canonical f64 arena recipe", at);
    }
    if (planner.allocations.some((allocation) => !constructors.has(allocation.id)) || planner.dataSegments.length)
      unsupported("complete allocation inventory contains resources outside fixed numeric vectors");
    const functions: PreparedLinearMemoryPlan["functions"][number][] = [];
    const arena = describeLinearBumpArena();
    const ctor = describeLinearArrayConstructor();
    const hasVectors = demand.occurrences.length > 0;
    if (hasVectors) {
      functions.push({
        key: "linear:malloc",
        name: "__malloc",
        role: "malloc",
        params: arena.allocatorType.params,
        results: arena.allocatorType.results,
        locals: arena.allocatorLocals,
      });
      functions.push({
        key: "linear:array-new",
        name: "__arr_new",
        role: "array-new",
        params: ctor.params,
        results: ctor.results,
        locals: ctor.locals,
        operation: { family: "vector", operation: "allocate", allocationClass: "arena", elementStorage: "f64" },
      });
      const initializer = describeLinearF64VectorInitialization();
      functions.push({
        key: "linear:initialize-element",
        name: "__linear_ir_vec_init_f64",
        role: "initialize-element",
        params: initializer.params,
        results: initializer.results,
        locals: initializer.locals,
        operation: {
          family: "vector",
          operation: "initialize-element",
          allocationClass: "arena",
          elementStorage: "f64",
        },
      });
      if (demand.occurrences.some((at) => at.lookups.includes("resolve-forwarding")))
        functions.push({
          key: "linear:resolve-forwarding",
          name: "__arr_resolve",
          role: "resolve-forwarding",
          params: [{ kind: "i32" }],
          results: [{ kind: "i32" }],
          locals: [],
          operation: { family: "vector", operation: "resolve-forwarding" },
        });
    }
    const plan = freezePreparedIrValue({
      schema: "prepared-linear-memory-v1",
      snapshot: planner.toJSON(),
      demand,
      functions,
      ...(hasVectors
        ? {
            memory: { key: "linear:memory", ...arena.memory },
            heapPointer: { key: "linear:heap", name: arena.heapPointer.name, floor: 1024 },
          }
        : {}),
      exports: hasVectors
        ? [{ key: "linear:export:memory", externalName: "memory", kind: "memory", targetKey: "linear:memory" }]
        : [],
    }) as PreparedLinearMemoryPlan;
    issued.set(plan, { ...input, planner, frozenInputs: freezePreparedIrValue(input), used: false });
    return Object.freeze({ kind: "supported", plan });
  } catch (error) {
    if (error instanceof IrUnsupportedError)
      return Object.freeze({
        kind: "unsupported",
        code: "array-representation-unsupported",
        detail: error.message,
        ...(error.cause === undefined ? {} : { location: error.cause }),
      });
    throw error;
  }
}

export function reservePreparedLinearMemory(
  tx: PhysicalModuleReservations,
  plan: PreparedLinearMemoryPlan,
  assertEmissionActive: () => void,
): PreparedLinearMemoryReservations {
  const record = issued.get(plan);
  if (!record || record.used || record.failed) invalid("unknown or consumed issued plan");
  record.used = true;
  try {
    current(plan, record);
    assertEmissionActive();
    if (tx.state !== "reserving") invalid("reserve requires reserving phase");
    tx.assertReservationKeysAvailable([
      ...plan.functions.map((fn) => fn.key),
      ...(plan.memory ? [plan.memory.key] : []),
      ...(plan.heapPointer ? [plan.heapPointer.key] : []),
      ...plan.exports.map((exp) => exp.key),
    ]);
    const memory = plan.memory
      ? tx.reserveMemory(plan.memory.key, { min: plan.memory.min, max: plan.memory.max })
      : undefined;
    const heap = plan.heapPointer
      ? tx.reserveGlobal(plan.heapPointer.key, plan.heapPointer.name, { kind: "i32" }, true)
      : undefined;
    const functions = Object.freeze(
      plan.functions.map((fn) => tx.reserveFunction(fn.key, fn.name, { params: fn.params, results: fn.results })),
    );
    const authority: PreparedLinearMemoryReservations = Object.freeze({ kind: "prepared-linear-memory-reservations" });
    packs.set(authority, {
      tx,
      plan,
      issuance: record,
      assertEmissionActive,
      functions,
      memory,
      heap,
      state: "reserved",
      exports: [],
    });
    return authority;
  } catch (error) {
    record.failed = true;
    throw error;
  }
}
function use<T>(
  tx: PhysicalModuleReservations,
  authority: PreparedLinearMemoryReservations,
  action: (pack: Pack) => T,
): T {
  const pack = packs.get(authority);
  if (!pack) invalid("unknown pack identity");
  try {
    if (pack.tx !== tx || pack.state === "failed") invalid("foreign or failed pack");
    current(pack.plan, pack.issuance);
    pack.assertEmissionActive();
    if (tx.state !== "filling") invalid("pack use requires filling phase");
    if (
      pack.functions.length !== pack.plan.functions.length ||
      Boolean(pack.memory) !== Boolean(pack.plan.memory) ||
      Boolean(pack.heap) !== Boolean(pack.plan.heapPointer)
    )
      invalid("owned inventory cardinality differs");
    const signatureTypes = new Map<string, number>();
    const typeSignatures = new Map<number, string>();
    pack.functions.forEach((token, index) => {
      tx.physicalIndex(token);
      const description = pack.plan.functions[index]!;
      if (token.kind !== "function" || token.key !== description.key || token.object.name !== description.name)
        invalid("function ownership differs");
      const signature = JSON.stringify([description.params, description.results]);
      const typeIndex = token.object.typeIdx as number;
      if (
        (signatureTypes.has(signature) && signatureTypes.get(signature) !== typeIndex) ||
        (typeSignatures.has(typeIndex) && typeSignatures.get(typeIndex) !== signature)
      )
        invalid("interned provider signatures differ");
      signatureTypes.set(signature, typeIndex);
      typeSignatures.set(typeIndex, signature);
      if (pack.typeIndices && pack.typeIndices[index] !== typeIndex) invalid("provider type ownership changed");
    });
    pack.typeIndices ??= Object.freeze(pack.functions.map((token) => token.object.typeIdx as number));
    if (pack.memory && tx.physicalIndex(pack.memory) !== 0) invalid("canonical providers require memory zero");
    if (pack.heap) tx.physicalIndex(pack.heap);
    return action(pack);
  } catch (error) {
    pack.state = "failed";
    throw error;
  }
}

export function preparedLinearMemoryBindings(
  tx: PhysicalModuleReservations,
  authority: PreparedLinearMemoryReservations,
): PreparedLinearBodyBindings {
  return use(tx, authority, (pack) => {
    if (pack.state === "reserved") pack.state = "bindings-ready";
    const resolveRuntimeOperation = (operation: LinearRuntimeOperation): number =>
      use(tx, authority, (active) => {
        const index = active.plan.functions.findIndex(
          (fn) => fn.operation && preparedIrDataMismatch(fn.operation, operation) === undefined,
        );
        if (index < 0) invalid("unplanned runtime operation");
        return tx.physicalIndex(active.functions[index]!);
      });
    return Object.freeze({
      supportFunctions: pack.functions,
      resolveRuntimeOperation,
      resolveVectorLayout: (element: IrType, allocationId?: AllocSiteId): LinearVecLowering =>
        use(tx, authority, (active) => {
          if (element.kind !== "val" || element.val.kind !== "f64") invalid("unplanned vector element carrier");
          const allocation = allocationId === undefined ? undefined : active.issuance.planner.allocation(allocationId);
          if (
            allocationId !== undefined &&
            (!allocation || !active.plan.demand.occurrences.some((at) => at.allocationId === allocationId))
          )
            invalid("unplanned allocation identity");
          const layout = allocation
            ? active.issuance.planner.requireLayout(allocation.layoutId)
            : active.issuance.planner.layoutForVector(element);
          if (
            !layout ||
            layout.kind !== "vector" ||
            !active.plan.demand.occurrences.length ||
            layout.elementStorage !== "f64"
          )
            invalid("unplanned vector layout");
          const allocate: LinearRuntimeOperation = {
            family: "vector",
            operation: "allocate",
            allocationClass: "arena",
            elementStorage: "f64",
          };
          const initializeElement: LinearRuntimeOperation = {
            family: "vector",
            operation: "initialize-element",
            allocationClass: "arena",
            elementStorage: "f64",
          };
          resolveRuntimeOperation(allocate);
          resolveRuntimeOperation(initializeElement);
          return Object.freeze({
            elementValType: Object.freeze({ kind: "f64" as const }),
            linearMemory: Object.freeze({
              ...(allocation ? { allocation } : {}),
              layout,
              allocate: Object.freeze(allocate),
              initializeElement: Object.freeze(initializeElement),
            }),
          });
        }),
    });
  });
}

export function fillPreparedLinearMemory(
  tx: PhysicalModuleReservations,
  authority: PreparedLinearMemoryReservations,
): void {
  use(tx, authority, (pack) => {
    if (pack.state === "filled" || pack.state === "verified") invalid("duplicate pack fill");
    const functionIndex = (role: PreparedLinearMemoryPlan["functions"][number]["role"]): number => {
      const index = pack.plan.functions.findIndex((fn) => fn.role === role);
      if (index < 0) invalid("missing provider dependency");
      return tx.physicalIndex(pack.functions[index]!);
    };
    if (pack.heap) tx.fillGlobal(pack.heap, [{ op: "i32.const", value: pack.plan.heapPointer!.floor }]);
    pack.plan.functions.forEach((fn, index) => {
      const body =
        fn.role === "malloc"
          ? buildLinearBumpAllocationBody(tx.physicalIndex(pack.heap!))
          : fn.role === "array-new"
            ? buildLinearArrayConstructorBody(functionIndex("malloc"))
            : fn.role === "initialize-element"
              ? buildLinearF64VectorInitializationBody()
              : buildArrayForwardingResolverBody(LINEAR_ARRAY_FORWARDING);
      tx.fillFunction(pack.functions[index]!, { locals: fn.locals.map((local) => ({ ...local })), body });
      tx.assertCompletedReservation(pack.functions[index]!);
    });
    if (pack.heap) tx.assertCompletedReservation(pack.heap);
    pack.exports = pack.plan.exports.map((intent) => {
      if (!pack.memory || intent.targetKey !== pack.memory.key) invalid("unknown target export");
      return tx.defineExport(intent.key, intent.externalName, pack.memory);
    });
    pack.state = "filled";
  });
}

export function requireCompletedPreparedLinearMemory(
  tx: PhysicalModuleReservations,
  authority: PreparedLinearMemoryReservations,
): void {
  use(tx, authority, (pack) => {
    if (pack.state !== "filled" && pack.state !== "verified") invalid("provider pack is incomplete");
    for (const token of pack.functions) tx.assertCompletedReservation(token);
    if (pack.heap) tx.assertCompletedReservation(pack.heap);
    if (
      pack.exports.length !== pack.plan.exports.length ||
      pack.exports.some(
        (exp, index) =>
          exp.name !== pack.plan.exports[index]!.externalName ||
          exp.desc.kind !== "memory" ||
          exp.desc.index !== tx.physicalIndex(pack.memory!),
      )
    )
      invalid("target export inventory differs");
    pack.state = "verified";
  });
}
