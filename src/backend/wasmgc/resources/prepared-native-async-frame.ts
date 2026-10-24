// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  planPreparedNativeAsyncFrame,
  type PreparedNativeAsyncFrameInput,
} from "../../../ir/program/prepared-native-async-frame-plan.js";
import type {
  PreparedNativeAsyncFramePlan,
  NativeFrameBridge,
} from "../../../ir/program/prepared-async-frame-contracts.js";
import { preparedIrDataMismatch } from "../../../ir/program/data.js";
import { assertPreparedIrAsyncRuntimeCurrent } from "../../../ir/runtime/async-attachment.js";
import type {
  PhysicalModuleReservations,
  FunctionReservation,
  TypeReservation,
  TagReservation,
} from "../../../wasm/physical/module-reservations.js";
import type {
  PreparedIrAsyncFrameResources,
  PreparedFrameFunction,
} from "../../../runtime/wasmgc/async/prepared-async-frame-types.js";
import { assertNativePromiseShape } from "../../../runtime/wasmgc/promise/promise-layout.js";
import { emitPreparedIrAsyncFrame } from "../async/prepared-async-frame-adapter.js";
import { reservePreparedFrameLayout } from "./prepared-frame-layout.js";
import { NativeFrameBindings } from "./native-frame-bindings.js";
import { nativePromiseObjectBinding, type NativePromiseObjects } from "./native-promise-objects.js";
import type { PreparedAsyncFrameReservations } from "./prepared-async-frame.js";

const ext = { kind: "externref" } as const,
  f64 = { kind: "f64" } as const;
export interface NativeFrameDependencies {
  readonly promise: TypeReservation;
  readonly reaction: TypeReservation;
  readonly objects: NativePromiseObjects;
  readonly enqueue: FunctionReservation;
  readonly resolveValue: FunctionReservation;
  readonly reject: FunctionReservation;
  readonly markHandled:
    | { readonly kind: "not-required" }
    | { readonly kind: "function"; readonly target: FunctionReservation };
  readonly tag: TagReservation;
  readonly bridges: ReadonlyMap<NativeFrameBridge["role"], FunctionReservation>;
  readonly calls: ReadonlyMap<string, FunctionReservation>;
  /** Parent checks complete program/provider/inventory acceptance, not merely layout. */
  assertAccepted(): void;
}
const owners = new WeakMap<
  PreparedAsyncFrameReservations,
  {
    tx: PhysicalModuleReservations;
    input: PreparedNativeAsyncFrameInput;
    plan: PreparedNativeAsyncFramePlan;
    promise: TypeReservation;
  }
>();
function fail(detail: string): never {
  throw new Error(`native frame: ${detail}`);
}

/** Reserve the source-owned frame using the actual native Promise carrier. */
export function reservePreparedNativeAsyncFrame(
  tx: PhysicalModuleReservations,
  input: PreparedNativeAsyncFrameInput,
  entry: FunctionReservation,
  promise: TypeReservation,
): PreparedAsyncFrameReservations {
  const outcome = planPreparedNativeAsyncFrame(input);
  if (outcome.kind !== "planned") return fail(outcome.detail);
  tx.assertTypeReservation(promise);
  if (promise.object.kind !== "struct") return fail("expected native Promise struct");
  assertNativePromiseShape(promise.object);
  const plan = outcome.plan;
  const fields = plan.frame.fields.map((field) => ({
    ...field,
    type: field.type.kind === "native-promise" ? { kind: "ref" as const, typeIdx: promise.typeIndex } : field.type,
  }));
  const reserved = reservePreparedFrameLayout(tx, { ...plan, frame: { ...plan.frame, fields } }, entry);
  owners.set(reserved, { tx, input, plan, promise });
  return reserved;
}

function bindDependencies(
  bindings: NativeFrameBindings,
  plan: PreparedNativeAsyncFramePlan,
  d: NativeFrameDependencies,
  create: FunctionReservation,
) {
  if (!d.resolveValue) fail("missing PromiseResolve dependency");
  const reaction = bindings.struct(d.reaction);
  if (
    reaction.target.fields.length !== 5 ||
    reaction.target.fields.some(
      (field, index) => field.mutable || field.type.kind !== (index === 0 || index === 2 ? "funcref" : "externref"),
    )
  )
    fail("wrong native reaction layout");
  const promiseRef = { kind: "ref", typeIdx: d.promise.typeIndex } as const;
  const bridge = new Map<NativeFrameBridge["role"], PreparedFrameFunction>();
  for (const { role } of plan.bridges) {
    const token = d.bridges.get(role) ?? fail(`missing bridge ${role}`);
    const params = role === "number.box" ? [f64] : role === "number.unbox" ? [ext] : [];
    bridge.set(role, bindings.function(token, params, role === "number.unbox" ? [f64] : [ext]));
  }
  const calls = new Map(
    plan.calls.map((row) => [
      row.referenceKey,
      bindings.function(
        d.calls.get(row.referenceKey) ?? fail(`missing call ${row.referenceKey}`),
        row.params,
        row.results,
      ),
    ]),
  );
  return {
    bridge: (role: NativeFrameBridge["role"]) => bridge.get(role) ?? fail(`unplanned bridge ${role}`),
    calls,
    operations: [...bridge.values(), ...calls.values()],
    runtime: {
      kind: "native" as const,
      promise: bindings.struct(d.promise),
      create: bindings.function(create, [{ kind: "i32" }], [promiseRef]),
      reaction,
      enqueue: bindings.function(d.enqueue, [{ kind: "funcref" }, ext, ext], []),
      resolveValue: bindings.function(d.resolveValue, [promiseRef, ext], [ext]),
      reject: bindings.function(d.reject, [promiseRef, ext], [ext]),
      markHandled:
        d.markHandled.kind === "not-required"
          ? d.markHandled
          : { kind: "function" as const, target: bindings.function(d.markHandled.target, [promiseRef], []) },
    },
  };
}

function retainAssociations(d: NativeFrameDependencies): () => void {
  const associations = [
    d.promise,
    d.objects,
    d.reaction,
    d.enqueue,
    d.resolveValue,
    d.reject,
    d.tag,
    d.markHandled,
    d.markHandled.kind === "function" ? d.markHandled.target : undefined,
  ];
  const bridges = [...d.bridges],
    calls = [...d.calls];
  return () => {
    const currentAssociations = [
      d.promise,
      d.objects,
      d.reaction,
      d.enqueue,
      d.resolveValue,
      d.reject,
      d.tag,
      d.markHandled,
      d.markHandled.kind === "function" ? d.markHandled.target : undefined,
    ];
    if (
      associations.some((token, i) => token !== currentAssociations[i]) ||
      bridges.length !== d.bridges.size ||
      bridges.some(([key, token]) => d.bridges.get(key) !== token) ||
      calls.length !== d.calls.size ||
      calls.some(([key, token]) => d.calls.get(key) !== token)
    )
      fail("changed dependency association");
  };
}

/** Detached emission and complete revalidation precede publication of all four bodies. */
export function fillPreparedNativeAsyncFrame(
  tx: PhysicalModuleReservations,
  reserved: PreparedAsyncFrameReservations,
  d: NativeFrameDependencies,
): void {
  const owner = owners.get(reserved);
  if (!owner || owner.tx !== tx || owner.promise !== d.promise) fail("foreign frame reservations");
  const { input, plan } = owner;
  const fn = input.fn;
  const runtime = assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime);
  if (runtime.kind !== "standalone-native-wasmgc") fail("missing native runtime attachment");
  d.assertAccepted();
  const assertAssociations = retainAssociations(d);
  const bindings = new NativeFrameBindings(tx);
  const allocation = () => {
    const binding = nativePromiseObjectBinding(tx, d.objects, true);
    if (binding.promise !== d.promise || binding.realm.exception.tag !== d.tag)
      fail("different Promise allocation owner");
    return binding.create;
  };
  const bound = bindDependencies(bindings, plan, d, allocation());
  const frame = bindings.struct(reserved.frame);
  const expectedFields = plan.frame.fields.map((field) => ({
    ...field,
    type: field.type.kind === "native-promise" ? { kind: "ref", typeIdx: d.promise.typeIndex } : field.type,
  }));
  const assertCurrent = () => {
    d.assertAccepted();
    assertAssociations();
    allocation();
    if (tx.state !== "filling" || fn.asyncRuntime !== runtime) fail("stale frame transaction");
    const current = planPreparedNativeAsyncFrame(input);
    if (current.kind !== "planned" || preparedIrDataMismatch(current.plan, plan) !== undefined)
      fail("changed source frame plan");
    if (preparedIrDataMismatch(frame.target.fields, expectedFields) !== undefined) fail("changed frame layout");
    bindings.assertCurrent();
  };
  const value = (type: PreparedNativeAsyncFramePlan["primary"]["params"][number]) =>
    type.kind === "support-ref"
      ? { kind: type.nullable ? ("ref_null" as const) : ("ref" as const), typeIdx: reserved.frame.typeIndex }
      : type;
  const primary = (role: "entry" | "resume" | "fulfillStep" | "rejectStep") => {
    const row = role === "entry" ? plan.primary : plan.auxiliaries[role];
    return bindings.function(reserved[role], row.params.map(value), row.results.map(value));
  };
  const resources: PreparedIrAsyncFrameResources = {
    owner: plan.owner,
    frame,
    resultField: plan.resultField,
    entry: primary("entry"),
    resume: primary("resume"),
    fulfillStep: primary("fulfillStep"),
    rejectStep: primary("rejectStep"),
    exceptionTag: bindings.tag(d.tag),
    values: plan.values,
    operations: bound.operations,
    callTargets: bound.calls,
    callSignatures: new Map(plan.calls.map((row) => [row.referenceKey, { params: row.params, results: row.results }])),
    conversions: plan.conversions.map((row) => ({
      ...row,
      operation:
        row.operation.kind === "native-helper"
          ? { kind: "helper", target: bound.bridge(row.operation.role) }
          : row.operation,
    })),
    undefinedSource:
      plan.undefinedSource.kind === "native-helper"
        ? { kind: "helper", target: bound.bridge(plan.undefinedSource.role) }
        : plan.undefinedSource,
    runtime: bound.runtime,
    allocator: bindings.allocator,
    assertCurrent,
  };
  const output = emitPreparedIrAsyncFrame(fn, runtime, resources);
  assertCurrent();
  for (const role of ["entry", "resume", "fulfillStep", "rejectStep"] as const)
    tx.fillFunction(reserved[role], output[role]);
  tx.declareFunctionReference(reserved.fulfillStep);
  tx.declareFunctionReference(reserved.rejectStep);
}
