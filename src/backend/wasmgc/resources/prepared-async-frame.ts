// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createIrBindingId } from "../../../shared/contracts/identity-values.js";
import type { IrBindingId } from "../../../shared/contracts/ir-identity.js";
import type {
  PreparedHostAsyncFramePlan,
  PreparedAsyncFrameSignatureType,
} from "../../../ir/program/prepared-async-frame-plan.js";
import type { PreparedIrFunction } from "../../../ir/runtime/contracts/prepared.js";
import { assertPreparedIrAsyncRuntimeCurrent } from "../../../ir/runtime/async-attachment.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { StructTypeDef, WasmFunction } from "../../../wasm/model/module-records.js";
import type {
  PhysicalModuleReservations,
  FunctionReservation,
  CallableReservation,
  TypeReservation,
  TagReservation,
  TagImportReservation,
} from "../../../wasm/physical/module-reservations.js";
import type {
  PreparedFrameHandle,
  PreparedFrameFunction,
  PreparedIrAsyncFrameResources,
} from "../../../runtime/wasmgc/async/prepared-async-frame-types.js";
import { emitPreparedIrAsyncFrame } from "../async/prepared-async-frame-adapter.js";

export interface PreparedAsyncFrameReservations {
  readonly frame: TypeReservation;
  readonly entry: FunctionReservation;
  readonly resume: FunctionReservation;
  readonly fulfillStep: FunctionReservation;
  readonly rejectStep: FunctionReservation;
}
const owners = new WeakMap<
  PreparedAsyncFrameReservations,
  { transaction: PhysicalModuleReservations; plan: PreparedHostAsyncFramePlan }
>();
function fail(detail: string): never {
  throw new Error(`prepared async resources: ${detail}`);
}

/** Allocate the accepted layout and machinery on the one module-owned ledger. */
export function reservePreparedAsyncFrame(
  transaction: PhysicalModuleReservations,
  plan: PreparedHostAsyncFramePlan,
  entry: FunctionReservation,
): PreparedAsyncFrameReservations {
  if (entry.key !== plan.primary.bindingId) fail("foreign primary slot");
  const frame = transaction.reserveType(plan.frame.entry.id, {
    kind: "struct",
    name: plan.frame.entry.displayName,
    fields: plan.frame.fields.map((field) => ({ ...field })),
  });
  const value = (type: PreparedAsyncFrameSignatureType): ValType => {
    if (type.kind !== "support-ref") return type;
    if (type.ref.binding.bindingId !== plan.frame.entry.id) return fail("foreign frame signature");
    return { kind: type.nullable ? "ref_null" : "ref", typeIdx: frame.typeIndex };
  };
  const reserve = (row: PreparedHostAsyncFramePlan["primary"]): FunctionReservation =>
    transaction.reserveFunction(row.bindingId, row.entry.displayName, {
      params: row.params.map(value),
      results: row.results.map(value),
    });
  const result = Object.freeze({
    frame,
    entry,
    resume: reserve(plan.auxiliaries.resume),
    fulfillStep: reserve(plan.auxiliaries.fulfillStep),
    rejectStep: reserve(plan.auxiliaries.rejectStep),
  });
  owners.set(result, { transaction, plan });
  return result;
}

/** Construct all four bodies detached, then publish into authenticated reserved slots. */
export function fillPreparedAsyncFrame(
  transaction: PhysicalModuleReservations,
  reserved: PreparedAsyncFrameReservations,
  fn: PreparedIrFunction,
  functions: ReadonlyMap<string, CallableReservation>,
  tag: TagReservation | TagImportReservation,
  assertAccepted: () => void,
): void {
  const owner = owners.get(reserved);
  if (!owner || owner.transaction !== transaction || owner.plan.owner !== fn.unitId) fail("foreign frame reservations");
  const plan = owner.plan;
  const runtime = assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime);
  if (runtime.kind !== "host-wasmgc") fail("missing host runtime attachment");
  const frameObject = reserved.frame.object;
  if (frameObject.kind !== "struct") fail("frame reservation is not a struct");
  const handles = new Map<PreparedFrameFunction, CallableReservation>();
  const byBinding = new Map<IrBindingId, PreparedFrameFunction>();
  const callable = (id: IrBindingId, token: CallableReservation): PreparedFrameFunction => {
    const previous = byBinding.get(id);
    if (previous) {
      if (handles.get(previous) !== token) fail("binding has two physical owners");
      return previous;
    }
    const handle = Object.freeze({ bindingId: id, target: token.object });
    handles.set(handle, token);
    byBinding.set(id, handle);
    return handle;
  };
  const defined = (id: IrBindingId, token: FunctionReservation): PreparedFrameHandle<WasmFunction> => {
    const handle = callable(id, token);
    if (handle.target !== token.object) fail("foreign defined handle");
    return handle as PreparedFrameHandle<WasmFunction>;
  };
  const entry = defined(plan.primary.bindingId, reserved.entry);
  const resume = defined(plan.auxiliaries.resume.bindingId, reserved.resume);
  const fulfillStep = defined(plan.auxiliaries.fulfillStep.bindingId, reserved.fulfillStep);
  const rejectStep = defined(plan.auxiliaries.rejectStep.bindingId, reserved.rejectStep);
  for (const row of [...plan.imports, ...plan.calls]) {
    const token = functions.get(row.referenceKey);
    if (!token) fail(`missing call ${row.referenceKey}`);
    callable(row.bindingId, token);
  }
  const binding = (id: IrBindingId): PreparedFrameFunction =>
    byBinding.get(id) ?? fail(`missing accepted binding ${id}`);
  const capability = (id: PreparedHostAsyncFramePlan["imports"][number]["capability"]): PreparedFrameFunction => {
    const row = plan.imports.find((row) => row.capability === id);
    return row ? binding(row.bindingId) : fail(`missing capability ${id}`);
  };
  const callback = (id: IrBindingId, target: PreparedFrameHandle<WasmFunction>) => {
    const rows = plan.callbacks.filter((row) => row.targetBindingId === id);
    if (rows.length !== 1) return fail("callback has no unique planned publication");
    return { id: rows[0]!.id, target };
  };
  const frame = Object.freeze({ bindingId: plan.frame.entry.id, target: frameObject as StructTypeDef });
  const exceptionTag = Object.freeze({
    bindingId: createIrBindingId({ ownerId: plan.owner, domain: "support", role: "prepared-frame-exception-tag" }),
    target: tag.object,
  });
  const assertCurrent = (): void => {
    assertAccepted();
    if (fn.asyncRuntime !== runtime || transaction.state !== "filling") fail("stale frame transaction");
    assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, runtime);
    if (preparedIrDataMismatch(frameObject.fields, plan.frame.fields) !== undefined) fail("frame layout changed");
    transaction.physicalIndex(reserved.frame);
    transaction.physicalIndex(tag);
    for (const token of handles.values()) transaction.physicalIndex(token);
  };
  const resources: PreparedIrAsyncFrameResources = {
    owner: fn.unitId,
    frame,
    resultField: plan.resultField,
    entry,
    resume,
    fulfillStep,
    rejectStep,
    exceptionTag,
    values: plan.values,
    operations: [...byBinding.values()],
    callTargets: new Map(plan.calls.map((row) => [row.referenceKey, binding(row.bindingId)])),
    callSignatures: new Map(plan.calls.map((row) => [row.referenceKey, { params: row.params, results: row.results }])),
    conversions: plan.conversions.map((row) => ({
      ...row,
      operation:
        row.operation.kind === "helper" ? { kind: "helper", target: binding(row.operation.bindingId) } : row.operation,
    })),
    undefinedSource:
      plan.undefinedSource.kind === "helper"
        ? { kind: "helper", target: binding(plan.undefinedSource.bindingId) }
        : plan.undefinedSource,
    runtime: {
      kind: "host",
      create: capability("async.promise.capability.create"),
      resolve: capability("async.promise.resolve"),
      react: capability("async.promise.react"),
      wrap: capability("async.callback.wrap"),
      caught: capability("async.exception.caught"),
      fulfill: capability("async.promise.settle.fulfill"),
      reject: capability("async.promise.settle.reject"),
      fulfillCallback: callback(plan.auxiliaries.fulfillStep.bindingId, fulfillStep),
      rejectCallback: callback(plan.auxiliaries.rejectStep.bindingId, rejectStep),
    },
    allocator: {
      function(handle) {
        const token = handles.get(handle);
        if (!token || token.object !== handle.target) return fail("foreign callable handle");
        transaction.physicalIndex(token);
        return { index: token.handle, target: token.object };
      },
      type(handle) {
        if (handle !== frame) return fail("foreign type handle");
        return { index: transaction.physicalIndex(reserved.frame), target: frame.target };
      },
      tag(handle) {
        if (handle !== exceptionTag) return fail("foreign tag handle");
        return { index: transaction.physicalIndex(tag), target: tag.object };
      },
    },
    assertCurrent,
  };
  const output = emitPreparedIrAsyncFrame(fn, runtime, resources);
  assertCurrent();
  for (const role of ["entry", "resume", "fulfillStep", "rejectStep"] as const)
    transaction.fillFunction(reserved[role], output[role]);
  for (const role of ["entry", "resume", "fulfillStep", "rejectStep"] as const)
    transaction.assertCompletedReservation(reserved[role]);
}
