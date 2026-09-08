// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr, ValType } from "../../../wasm/model/instructions.js";
import type { TypeDef } from "../../../wasm/model/module-records.js";
import type {
  PhysicalModuleReservations,
  TypeReservation,
  GlobalReservation,
  CallableReservation,
  FunctionReservation,
  TagReservation,
  TagImportReservation,
  PhysicalFunctionSignature,
} from "../../../wasm/physical/module-reservations.js";
import { preparedIrDataMismatch, freezePreparedIrValue } from "../../../ir/program/data.js";
import type { NativePromiseResourcePlan, NativePromiseOwner } from "../../../ir/program/native-promise-resources.js";
import { resolveNativeVectorForElement, type NativeVectorTypeReservations } from "./native-vectors.js";
import {
  buildGrowLocals,
  buildGrowBody,
  buildEnqueueBody,
  buildDrainLocals,
  buildDrainBody,
  type PreparedNativeMicrotaskReservations,
} from "../../../runtime/wasmgc/async/microtask-queue-bodies.js";
import {
  buildPromiseSettleLocals,
  buildPromiseSettleBody,
  buildIdentityWrapperLocals,
  buildIdentityWrapperBody,
  PROMISE_STATE_FULFILLED,
  PROMISE_STATE_REJECTED,
  type PromiseHookResources,
} from "../../../runtime/wasmgc/promise/settlement-bodies.js";
import {
  buildNativePromiseResolveValueBody,
  buildPromiseResolveValueLocals,
  buildPromiseThenableJob,
  buildPromiseSettleClosureBody,
} from "../../../runtime/wasmgc/promise/resolution-bodies.js";
import {
  buildPromisePeelValue,
  buildPromiseThenableClassifier,
} from "../../../runtime/wasmgc/promise/thenable-bodies.js";

type Tag = TagReservation | TagImportReservation;
const EXTERN: ValType = { kind: "externref" },
  I32: ValType = { kind: "i32" },
  F64: ValType = { kind: "f64" };
const callbackSignature = { params: [EXTERN, EXTERN], results: [EXTERN] };
export interface NativePromiseReservationDependencies {
  readonly vectors: NativeVectorTypeReservations;
  readonly exceptionTag: Tag;
  /** Actual canonical closure root and builtin metadata reservation from the value materializer. */
  readonly closureRoot: TypeReservation;
  readonly settleMetadata: TypeReservation;
}
export interface NativePromiseReservations {
  readonly types: {
    readonly arguments: TypeReservation;
    readonly functions: TypeReservation;
    readonly callbackSignature: number;
    readonly promise: TypeReservation;
    readonly callback: TypeReservation;
    readonly captures: TypeReservation;
    readonly settleCapture: TypeReservation;
  };
  readonly globals: {
    readonly head: GlobalReservation;
    readonly tail: GlobalReservation;
    readonly capacity: GlobalReservation;
    readonly functions: GlobalReservation;
    readonly captures: GlobalReservation;
    readonly arguments: GlobalReservation;
  };
  readonly functions: {
    readonly grow: FunctionReservation;
    readonly enqueue: FunctionReservation;
    readonly drain: FunctionReservation;
    readonly fulfill: FunctionReservation;
    readonly reject: FunctionReservation;
    readonly identityFulfill: FunctionReservation;
    readonly identityReject: FunctionReservation;
    readonly resolveValue: FunctionReservation;
    readonly peel: FunctionReservation;
    readonly classifier: FunctionReservation;
    readonly thenableJob: FunctionReservation;
    readonly resolveClosure: FunctionReservation;
    readonly rejectClosure: FunctionReservation;
  };
}
export interface NativePromiseStringBinding {
  readonly text: "then" | "Chaining cycle detected for promise";
  readonly global: GlobalReservation;
  readonly representation: "externref" | "gc";
}
export interface NativePromiseInventory {
  /** Checked boundary must account for every selected owner, including empty owners. */
  readonly owners: readonly NativePromiseOwner[];
  readonly selectedOwners: readonly NativePromiseOwner[];
  readonly derivedUnits: NativePromiseResourcePlan["derivedUnits"];
  /** Exact carrier population derived by the checked parent resource plan, not a classifier assertion. */
  readonly requiredCarriers: readonly TypeReservation[];
  /** Every object/closure carrier supplied by the checked resource plan, in canonical order. */
  readonly carriers: readonly {
    readonly type: TypeReservation;
    readonly role: "method" | "accessor" | "field" | "closure" | "other";
    readonly getterGlobal?: GlobalReservation;
    readonly fieldIndex?: number;
  }[];
  readonly anyValue: {
    readonly type: TypeReservation;
    readonly tag: number;
    readonly ref: number;
    readonly extern: number;
  };
  readonly openObject: { readonly type: TypeReservation; readonly get: CallableReservation };
  readonly accessorGet: CallableReservation;
}
export interface NativePromiseFillDependencies {
  readonly inventory: NativePromiseInventory;
  readonly values: {
    readonly boxNumber: CallableReservation;
    readonly unboxNumber: CallableReservation;
    readonly isNumber: CallableReservation;
    readonly undefined: GlobalReservation;
  };
  readonly resolution: {
    readonly newTypeError: CallableReservation;
    readonly selfResolution: NativePromiseStringBinding;
    readonly then: NativePromiseStringBinding;
    readonly argumentVectorNew: CallableReservation;
    readonly argumentVectorPush: CallableReservation;
    readonly applyClosure: CallableReservation;
    readonly thenDispatch: CallableReservation;
    readonly bagHas: CallableReservation;
    readonly externGet: CallableReservation;
    readonly typeofFunction: CallableReservation;
  };
  readonly hooks:
    | { readonly kind: "disabled" }
    | { readonly kind: "dispatch"; readonly dispatch: CallableReservation; readonly parent: GlobalReservation };
  readonly unhandledRejections:
    | { readonly kind: "disabled" }
    | { readonly kind: "track"; readonly head: GlobalReservation; readonly node: TypeReservation };
}

const owners = new WeakMap<
  NativePromiseReservations,
  {
    tx: PhysicalModuleReservations;
    plan: NativePromiseResourcePlan;
    dependencies: NativePromiseReservationDependencies;
    snapshots: readonly { token: TypeReservation; descriptor: TypeDef }[];
    filled: boolean;
  }
>();
function fail(detail: string): never {
  throw new Error(`native Promise resources: ${detail}`);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}
function structFields(token: TypeReservation) {
  if (token.object.kind !== "struct") fail("expected concrete struct reservation");
  return token.object.fields;
}
const closureFields = () => [
  { name: "func", type: { kind: "funcref" } as ValType, mutable: false },
  { name: "$arity", type: I32, mutable: false },
  { name: "$bag", type: EXTERN, mutable: true },
];

/** Reserve only: empty bodies are ledger obligations, never accepted fallback implementations. */
export function reserveNativePromiseResources(
  tx: PhysicalModuleReservations,
  plan: NativePromiseResourcePlan,
  dependencies: NativePromiseReservationDependencies,
): NativePromiseReservations {
  if (!plan.required || !plan.anchor) fail("missing required native Promise plan");
  const layout = resolveNativeVectorForElement(dependencies.vectors, EXTERN);
  const argumentArray = dependencies.vectors.layouts.find((row) => row.element === "externref")?.array;
  if (!layout || !argumentArray || argumentArray.typeIndex !== layout.arrayTypeIdx)
    fail("missing exact shared externref array");
  same(
    argumentArray.object,
    { kind: "array", name: "__arr_externref", element: EXTERN, mutable: true },
    "shared array descriptor mismatch",
  );
  same(structFields(dependencies.closureRoot), closureFields(), "noncanonical closure root");
  const metadataFields = [
    ...closureFields(),
    { name: "bfnstate", type: I32, mutable: true },
    { name: "bfnid", type: I32, mutable: false },
  ];
  same(structFields(dependencies.settleMetadata), metadataFields, "noncanonical settle metadata fields");
  // The actual metadata subtype may sit below a signature wrapper; ancestry is checked by the ledger.
  const key = (role: string) => `physical:promise:${JSON.stringify(plan.anchor)}:${role}`;
  const functionsType = tx.reserveType(key("queue:function-array"), {
    kind: "array",
    name: "__arr_mt_func",
    element: { kind: "funcref" },
    mutable: true,
  });
  const callbackType = tx.internFunctionType(callbackSignature.params, callbackSignature.results, "$__mt_func_type");
  const head = tx.reserveGlobal(key("queue:head"), "__mt_head", I32, true);
  const tail = tx.reserveGlobal(key("queue:tail"), "__mt_tail", I32, true);
  const capacity = tx.reserveGlobal(key("queue:capacity"), "__mt_cap", I32, true);
  const functionsGlobal = tx.reserveGlobal(
    key("queue:functions"),
    "__mt_funcs",
    { kind: "ref_null", typeIdx: functionsType.typeIndex },
    true,
  );
  const capturesGlobal = tx.reserveGlobal(
    key("queue:captures"),
    "__mt_caps",
    { kind: "ref_null", typeIdx: argumentArray.typeIndex },
    true,
  );
  const argumentsGlobal = tx.reserveGlobal(
    key("queue:arguments"),
    "__mt_args",
    { kind: "ref_null", typeIdx: argumentArray.typeIndex },
    true,
  );
  const reserve = (role: string, name: string, signature: PhysicalFunctionSignature) => {
    const bindings = plan.callableBindings.filter(
      (entry) =>
        entry.contract.kind === "callable" &&
        (entry.contract.ref.binding.kind === "runtime" || entry.contract.ref.binding.kind === "intrinsic") &&
        entry.contract.ref.binding.symbol === name,
    );
    if (bindings.length > 1) fail("duplicate canonical helper binding");
    return tx.reserveFunction(bindings[0]?.plan.id ?? key(role), name, signature);
  };
  const grow = reserve("queue:grow", "__microtask_grow", { params: [I32], results: [] });
  const enqueue = reserve("queue:enqueue", "__microtask_enqueue", {
    params: [{ kind: "funcref" }, EXTERN, EXTERN],
    results: [],
  });
  const drain = reserve("queue:drain", "__drain_microtasks", { params: [], results: [] });
  const promise = tx.reserveType(key("carrier"), {
    kind: "struct",
    name: "$Promise",
    fields: [
      { name: "state", type: I32, mutable: true },
      { name: "value", type: EXTERN, mutable: true },
      { name: "callbacks", type: EXTERN, mutable: true },
      { name: "$bag", type: EXTERN, mutable: true },
    ],
  });
  const callback = tx.reserveType(key("callback"), {
    kind: "struct",
    name: "$PromiseCallback",
    fields: [
      { name: "onFulfilledFn", type: { kind: "funcref" }, mutable: false },
      { name: "onFulfilledCaps", type: EXTERN, mutable: false },
      { name: "onRejectedFn", type: { kind: "funcref" }, mutable: false },
      { name: "onRejectedCaps", type: EXTERN, mutable: false },
      { name: "next", type: EXTERN, mutable: false },
    ],
  });
  const promiseRef: ValType = { kind: "ref", typeIdx: promise.typeIndex };
  const captures = tx.reserveType(key("captures"), {
    kind: "struct",
    name: "$__then_caps",
    fields: [
      { name: "callback", type: EXTERN, mutable: false },
      { name: "chained", type: promiseRef, mutable: false },
    ],
  });
  const settle = { params: [promiseRef, EXTERN], results: [EXTERN] };
  const fulfill = reserve("fulfill", "__promise_fulfill", settle);
  const reject = reserve("reject", "__promise_reject", settle);
  const identityFulfill = reserve("identity-fulfill", "__then_identity_fulfill", callbackSignature);
  const identityReject = reserve("identity-reject", "__then_identity_reject", callbackSignature);
  const resolveValue = reserve("resolve-value", "__promise_resolve_value", settle);
  const settleCapture = tx.reserveType(key("settle-capture"), {
    kind: "struct",
    name: "$__promise_settle_cap",
    superTypeIdx: dependencies.settleMetadata.typeIndex,
    fields: [...metadataFields, { name: "cap_promise", type: promiseRef, mutable: false }],
  });
  const trampoline = {
    params: [{ kind: "ref", typeIdx: dependencies.closureRoot.typeIndex } as ValType, EXTERN],
    results: [],
  };
  const resolveClosure = reserve("resolve-closure", "__promise_resolve_cl", trampoline);
  const rejectClosure = reserve("reject-closure", "__promise_reject_cl", trampoline);
  const peel = reserve("peel", "__promise_peel_value", { params: [EXTERN], results: [EXTERN] });
  const classifier = reserve("classifier", "__promise_has_callable_then", { params: [EXTERN], results: [I32] });
  const thenableJob = reserve("thenable-job", "__promise_thenable_job", callbackSignature);
  const result: NativePromiseReservations = Object.freeze({
    types: Object.freeze({
      arguments: argumentArray,
      functions: functionsType,
      callbackSignature: callbackType,
      promise,
      callback,
      captures,
      settleCapture,
    }),
    globals: Object.freeze({
      head,
      tail,
      capacity,
      functions: functionsGlobal,
      captures: capturesGlobal,
      arguments: argumentsGlobal,
    }),
    functions: Object.freeze({
      grow,
      enqueue,
      drain,
      fulfill,
      reject,
      identityFulfill,
      identityReject,
      resolveValue,
      peel,
      classifier,
      thenableJob,
      resolveClosure,
      rejectClosure,
    }),
  });
  const snapshots = [
    argumentArray,
    functionsType,
    promise,
    callback,
    captures,
    settleCapture,
    dependencies.closureRoot,
    dependencies.settleMetadata,
  ].map((token) => ({ token, descriptor: freezePreparedIrValue(token.object) as TypeDef }));
  owners.set(result, {
    tx,
    plan: freezePreparedIrValue(plan) as NativePromiseResourcePlan,
    dependencies: Object.freeze({ ...dependencies }),
    snapshots,
    filled: false,
  });
  return result;
}

/** No fallback: resolution/classification/value dependencies must all be real same-ledger reservations. */
export function fillNativePromiseResources(
  tx: PhysicalModuleReservations,
  pack: NativePromiseReservations,
  dependencies: NativePromiseFillDependencies,
): void {
  const owner = owners.get(pack);
  if (!owner || owner.tx !== tx) fail("foreign Promise pack");
  if (owner.filled) fail("duplicate Promise pack fill");
  if (!dependencies?.inventory || !dependencies.values || !dependencies.resolution)
    fail("complete native dependencies are missing");
  same(dependencies.inventory.owners, owner.plan.owners, "classification owner population differs");
  same(dependencies.inventory.selectedOwners, owner.plan.selectedOwners, "classification selected population differs");
  same(dependencies.inventory.derivedUnits, owner.plan.derivedUnits, "classification derived population differs");
  // Do not infer an empty AnyValue/open-object inventory from absent registrations.
  if (!dependencies.inventory.anyValue || !dependencies.inventory.openObject || !dependencies.inventory.accessorGet)
    fail("complete native classification materialization is missing");
  if (!Array.isArray(dependencies.inventory.requiredCarriers) || !Array.isArray(dependencies.inventory.carriers))
    fail("checked carrier population is missing");
  if (
    dependencies.inventory.requiredCarriers.length !== dependencies.inventory.carriers.length ||
    dependencies.inventory.requiredCarriers.some(
      (token, index) => dependencies.inventory.carriers[index]?.type !== token,
    )
  )
    fail("classifier inventory differs from checked carrier population");
  if (
    dependencies.hooks?.kind !== owner.plan.configuration.hooks ||
    dependencies.unhandledRejections?.kind !== owner.plan.configuration.unhandledRejections
  )
    fail("hook/unhandled configuration differs from selected runtime");
  for (const { token, descriptor } of owner.snapshots) {
    same(token.object, descriptor, "reserved Promise layout changed");
    if (tx.physicalIndex(token) !== token.typeIndex) fail("type coordinate differs");
  }
  for (const fn of Object.values(pack.functions)) tx.physicalIndex(fn);
  const tag = owner.dependencies.exceptionTag;
  const tagType = tx.internFunctionType([EXTERN], []);
  if (tag.kind === "tag") same(tag.object, { name: "__exn", typeIdx: tagType }, "wrong exception tag");
  else
    same(
      tag.object,
      { module: "env", name: "__exn", desc: { kind: "tag", typeIdx: tagType } },
      "wrong shared exception tag",
    );
  const exn = tx.physicalIndex(tag);
  const bind = (token: CallableReservation, params: ValType[], results: ValType[]): number => {
    if (!token) fail("missing callable dependency");
    tx.physicalIndex(token);
    const actual =
      token.kind === "function"
        ? token.object.typeIdx
        : token.object.desc.kind === "func"
          ? token.object.desc.typeIdx
          : -1;
    if (actual !== tx.internFunctionType(params, results)) fail(`dependency signature mismatch: ${token.key}`);
    return token.handle;
  };
  const string = (binding: NativePromiseStringBinding, text: NativePromiseStringBinding["text"]): Instr[] => {
    if (!binding || binding.text !== text) fail("missing exact native string operand");
    const index = tx.physicalIndex(binding.global);
    if (binding.representation === "externref") {
      same(binding.global.object.type, EXTERN, "wrong extern string global");
      return [{ op: "global.get", index }];
    }
    if (binding.global.object.type.kind !== "ref") fail("wrong GC string global");
    return [{ op: "global.get", index }, { op: "extern.convert_any" }];
  };
  const r = dependencies.resolution,
    v = dependencies.values,
    inventory = dependencies.inventory;
  bind(v.boxNumber, [F64], [EXTERN]);
  bind(v.unboxNumber, [EXTERN], [F64]);
  bind(v.isNumber, [EXTERN], [I32]);
  tx.physicalIndex(v.undefined);
  const newTypeError = bind(r.newTypeError, [EXTERN], [EXTERN]);
  const argumentNew = bind(r.argumentVectorNew, [], [EXTERN]);
  const argumentPush = bind(r.argumentVectorPush, [EXTERN, EXTERN], []);
  const apply = bind(r.applyClosure, [EXTERN, EXTERN, EXTERN], [EXTERN]);
  const thenDispatch = bind(r.thenDispatch, [EXTERN, EXTERN], [EXTERN]);
  const bagHas = bind(r.bagHas, [EXTERN, EXTERN], [I32]);
  const externGet = bind(r.externGet, [EXTERN, EXTERN], [EXTERN]);
  const typeofFunction = bind(r.typeofFunction, [EXTERN], [I32]);
  const selfString = string(r.selfResolution, "Chaining cycle detected for promise"),
    thenString = string(r.then, "then");
  const methods: number[] = [],
    accessors: { typeIdx: number; getGlobal: number }[] = [],
    fields: { typeIdx: number; fieldIdx: number }[] = [],
    closures: number[] = [];
  const seenTypes = new Set<TypeReservation>();
  for (const row of inventory.carriers) {
    if (seenTypes.has(row.type)) fail("duplicate inventory carrier");
    seenTypes.add(row.type);
    const index = tx.physicalIndex(row.type);
    if (row.role === "method") methods.push(index);
    if (row.role === "closure") closures.push(index);
    if (row.role === "accessor") {
      if (!row.getterGlobal) fail("missing accessor global");
      accessors.push({ typeIdx: index, getGlobal: tx.physicalIndex(row.getterGlobal) });
    }
    if (row.role === "field") {
      if (row.fieldIndex === undefined || structFields(row.type)[row.fieldIndex]?.type.kind !== "externref")
        fail("invalid then field");
      fields.push({ typeIdx: index, fieldIdx: row.fieldIndex });
    }
  }
  if (!seenTypes.has(owner.dependencies.closureRoot)) fail("closure root absent from finalized inventory");
  const av = inventory.anyValue;
  const avFields = structFields(av.type);
  if (av.tag !== 0 || av.ref !== 3 || av.extern !== 4) fail("invalid AnyValue peel descriptor");
  same(
    avFields,
    [
      { name: "tag", type: I32, mutable: false },
      { name: "i32val", type: I32, mutable: false },
      { name: "f64val", type: F64, mutable: false },
      { name: "refval", type: { kind: "eqref" }, mutable: false },
      { name: "externval", type: EXTERN, mutable: false },
    ],
    "invalid AnyValue peel descriptor",
  );
  const anyType = tx.physicalIndex(av.type),
    objectType = tx.physicalIndex(inventory.openObject.type);
  same(
    v.undefined.object,
    {
      name: "__undefined",
      type: { kind: "ref", typeIdx: anyType },
      mutable: false,
      init: [
        { op: "i32.const", value: 1 },
        { op: "i32.const", value: 0 },
        { op: "f64.const", value: NaN },
        { op: "ref.null", typeIdx: -19 },
        { op: "ref.null.extern" },
        { op: "struct.new", typeIdx: anyType },
      ],
    },
    "canonical tag-1 undefined initializer is missing",
  );
  const objectGet = bind(inventory.openObject.get, [EXTERN, EXTERN], [EXTERN]);
  const accessorGet = bind(inventory.accessorGet, [EXTERN, EXTERN], [EXTERN]);
  let hook: PromiseHookResources;
  if (dependencies.hooks.kind === "dispatch")
    hook = {
      dispatchFuncIdx: bind(dependencies.hooks.dispatch, [F64, EXTERN, EXTERN], []),
      parentExternInstrs: [{ op: "global.get", index: tx.physicalIndex(dependencies.hooks.parent) }],
    };
  let unhandledHead = -1,
    unhandledNode = -1;
  if (dependencies.unhandledRejections.kind === "track") {
    same(
      dependencies.unhandledRejections.node.object,
      {
        kind: "struct",
        name: "$__unhandled_node",
        fields: [
          { name: "promise", type: { kind: "eqref" }, mutable: false },
          { name: "next", type: EXTERN, mutable: false },
          { name: "handled", type: I32, mutable: true },
        ],
      },
      "invalid unhandled-rejection node",
    );
    same(
      dependencies.unhandledRejections.head.object,
      { name: "__unhandled_head", type: EXTERN, mutable: true, init: [{ op: "ref.null.extern" }] },
      "invalid unhandled-rejection head",
    );
    unhandledHead = tx.physicalIndex(dependencies.unhandledRejections.head);
    unhandledNode = tx.physicalIndex(dependencies.unhandledRejections.node);
  }
  const f = pack.functions,
    t = pack.types;
  const queue: PreparedNativeMicrotaskReservations = {
    types: {
      functions: { kind: "type", index: t.functions.typeIndex },
      arguments: { kind: "type", index: t.arguments.typeIndex },
      callback: { kind: "type", index: t.callbackSignature },
    },
    globals: Object.fromEntries(
      Object.entries(pack.globals).map(([name, token]) => [name, { kind: "global", index: tx.physicalIndex(token) }]),
    ) as PreparedNativeMicrotaskReservations["globals"],
    grow: { kind: "function", index: f.grow.handle },
    initialCapacity: 8192,
  };
  const cap = {
    capTypeIdx: t.settleCapture.typeIndex,
    capMetaTypeIdx: owner.dependencies.settleMetadata.typeIndex,
    capPromiseFieldIdx: 5,
  };
  const target = { wasi: false, standalone: true };
  const resolution = buildNativePromiseResolveValueBody({
    target,
    state: {
      promiseFulfillFuncIdx: f.fulfill.handle,
      promiseRejectFuncIdx: f.reject.handle,
      enqueueFuncIdx: f.enqueue.handle,
      identityFulfillWrapperFuncIdx: f.identityFulfill.handle,
      identityRejectWrapperFuncIdx: f.identityReject.handle,
    },
    promiseTypeIdx: t.promise.typeIndex,
    callbackTypeIdx: t.callback.typeIndex,
    capsTypeIdx: t.captures.typeIndex,
    promiseFields: { state: 0, value: 1, callbacks: 2 },
    callbackFields: [0, 1, 2, 3, 4],
    capsFields: { callback: 0, chained: 1 },
    thenable: {
      hasCallableThenFuncIdx: f.classifier.handle,
      thenableJobFuncIdx: f.thenableJob.handle,
      peelValueFuncIdx: f.peel.handle,
      newTypeErrorFuncIdx: newTypeError,
    },
    exnTagIdx: exn,
    selfResolutionStringInstrs: selfString,
    thenStringInstrs: thenString,
    thenGetStringInstrs: thenString,
    bagHasIdx: bagHas,
    externGetIdx: externGet,
    typeofFunctionIdx: typeofFunction,
    callableRootTypeIdx: owner.dependencies.closureRoot.typeIndex,
  });
  const classifier = buildPromiseThenableClassifier({
    finalized: true,
    peelFuncIdx: f.peel.handle,
    methodTypeIdxs: methods,
    accessors,
    callAccessorGetIdx: accessorGet,
    fields,
    closureWrapperTypeIdxs: closures,
    openObject: { typeIdx: objectType, externGetFuncIdx: objectGet, thenStringInstrs: thenString },
  });
  const job = buildPromiseThenableJob({
    target,
    promiseTypeIdx: t.promise.typeIndex,
    promiseRejectFuncIdx: f.reject.handle,
    capsTypeIdx: t.captures.typeIndex,
    capsFields: { callback: 0, chained: 1 },
    objVecNewIdx: argumentNew,
    objVecPushIdx: argumentPush,
    execClosures: { ...cap, resolveClFuncIdx: f.resolveClosure.handle, rejectClFuncIdx: f.rejectClosure.handle },
    applyClosureIdx: apply,
    peelValueFuncIdx: f.peel.handle,
    varargThenFuncIdx: thenDispatch,
    exnTag: exn,
  });
  for (const token of [pack.globals.head, pack.globals.tail, pack.globals.capacity])
    tx.fillGlobal(token, [{ op: "i32.const", value: 0 }]);
  for (const token of [pack.globals.functions, pack.globals.captures, pack.globals.arguments]) {
    if (token.object.type.kind !== "ref_null") fail("wrong queue storage type");
    tx.fillGlobal(token, [{ op: "ref.null", typeIdx: token.object.type.typeIdx }]);
  }
  tx.fillFunction(f.grow, { locals: buildGrowLocals(queue), body: buildGrowBody(queue) });
  tx.fillFunction(f.enqueue, { locals: [], body: buildEnqueueBody(queue) });
  tx.fillFunction(f.drain, { locals: buildDrainLocals(), body: buildDrainBody(queue) });
  for (const [fn, state] of [
    [f.fulfill, PROMISE_STATE_FULFILLED],
    [f.reject, PROMISE_STATE_REJECTED],
  ] as const)
    tx.fillFunction(fn, {
      locals: buildPromiseSettleLocals(t.callback.typeIndex),
      body: buildPromiseSettleBody(
        {
          promiseTypeIdx: t.promise.typeIndex,
          callbackTypeIdx: t.callback.typeIndex,
          enqueueFuncIdx: f.enqueue.handle,
          resolveHook: hook,
          unhandledHeadGlobalIdx: unhandledHead,
          unhandledNodeTypeIdx: unhandledNode,
        },
        state,
      ),
    });
  for (const [fn, settle] of [
    [f.identityFulfill, f.resolveValue],
    [f.identityReject, f.reject],
  ])
    tx.fillFunction(fn!, {
      locals: buildIdentityWrapperLocals(t.captures.typeIndex),
      body: buildIdentityWrapperBody({
        capsTypeIdx: t.captures.typeIndex,
        settleFuncIdx: settle!.handle,
        beforeHook: hook,
        afterHook: hook,
      }),
    });
  tx.fillFunction(f.resolveValue, { locals: buildPromiseResolveValueLocals(t.promise.typeIndex), body: resolution });
  tx.fillFunction(
    f.peel,
    buildPromisePeelValue({ typeIdx: anyType, tagFieldIdx: av.tag, refFieldIdx: av.ref, externFieldIdx: av.extern }),
  );
  tx.fillFunction(f.classifier, classifier);
  tx.fillFunction(f.thenableJob, job);
  tx.fillFunction(f.resolveClosure, { locals: [], body: buildPromiseSettleClosureBody(cap, f.resolveValue.handle) });
  tx.fillFunction(f.rejectClosure, { locals: [], body: buildPromiseSettleClosureBody(cap, f.reject.handle) });
  for (const fn of [f.identityFulfill, f.identityReject, f.thenableJob, f.resolveClosure, f.rejectClosure])
    tx.declareFunctionReference(fn);
  owner.filled = true;
}
