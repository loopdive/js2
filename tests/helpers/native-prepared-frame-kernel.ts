// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { reserveFrameResolutionKernel } from "./native-frame-resolution-kernel.js";
import { createEmptyModule, type StructTypeDef } from "../../src/ir/types.js";
import type { IrBindingId, IrUnitId } from "../../src/ir/identity.js";
import type { Instr, ValType } from "../../src/wasm/model/instructions.js";
import {
  PhysicalModuleReservations,
  type PhysicalReservation,
  type FunctionReservation,
  type TypeReservation,
} from "../../src/wasm/physical/module-reservations.js";
import {
  createNativePromiseShape,
  buildNativePromiseAllocation,
} from "../../src/runtime/wasmgc/promise/promise-layout.js";
import { emitPreparedIrAsyncFrame } from "../../src/backend/wasmgc/async/prepared-async-frame-adapter.js";
import { assertPreparedIrAsyncRuntimeCurrent } from "../../src/ir/runtime/async-attachment.js";
import { emitPreparedFrame } from "../../src/runtime/wasmgc/async/prepared-async-frame-engine.js";
import type {
  PreparedFramePlan,
  PreparedFrameResources,
} from "../../src/runtime/wasmgc/async/prepared-async-frame-types.js";
import {
  buildGrowBody,
  buildGrowLocals,
  buildEnqueueBody,
  buildDrainBody,
  buildDrainLocals,
  type PreparedNativeMicrotaskReservations,
} from "../../src/runtime/wasmgc/async/microtask-queue-bodies.js";
import {
  buildPromiseSettleBody,
  buildPromiseSettleLocals,
} from "../../src/runtime/wasmgc/promise/settlement-bodies.js";

import { reservePreparedNativeAsyncFrame } from "../../src/backend/wasmgc/resources/prepared-native-async-frame.js";
import {
  planPreparedNativeAsyncFrame,
  type PreparedNativeAsyncFrameInput,
} from "../../src/ir/program/prepared-native-async-frame-plan.js";
import {
  buildBoxNumberBody,
  buildBoxNumberLocals,
  buildUnboxNumberBody,
  buildUnboxNumberLocals,
} from "../../src/runtime/wasmgc/values/number-bodies.js";

const ext = { kind: "externref" } as const;
const i32 = { kind: "i32" } as const;
const get = (index: number): Instr => ({ op: "local.get", index });

/** Runtime-kernel harness: actual builders and ledger, no source-admission claim or substitute helpers. */
export function nativePreparedFrameKernel(
  promiseShape = createNativePromiseShape(),
  source?: PreparedNativeAsyncFrameInput,
  completion: "await" | "return" = "await",
) {
  const module = createEmptyModule(),
    tx = new PhysicalModuleReservations(module);
  const promise = tx.reserveType("promise", promiseShape);
  const reaction = tx.reserveType("reaction", {
    kind: "struct",
    name: "$PromiseCallback",
    fields: [
      { name: "fulfill", type: { kind: "funcref" }, mutable: false },
      { name: "fulfillCaps", type: ext, mutable: false },
      { name: "reject", type: { kind: "funcref" }, mutable: false },
      { name: "rejectCaps", type: ext, mutable: false },
      { name: "next", type: ext, mutable: false },
    ],
  });
  const argumentsType = tx.reserveType("arguments", { kind: "array", name: "arguments", element: ext, mutable: true });
  const functionsType = tx.reserveType("functions", {
    kind: "array",
    name: "functions",
    element: { kind: "funcref" },
    mutable: true,
  });
  const promiseRef: ValType = { kind: "ref", typeIdx: promise.typeIndex };
  const fn = (name: string, params: readonly ValType[], results: readonly ValType[]) =>
    tx.reserveFunction(name, name, { params, results });
  const sourcePlan = source ? planPreparedNativeAsyncFrame(source) : undefined;
  if (sourcePlan && sourcePlan.kind !== "planned") throw Error(sourcePlan.detail);
  const sourceEntry = sourcePlan
    ? fn(sourcePlan.plan.primary.bindingId, sourcePlan.plan.primary.params as ValType[], [ext])
    : undefined;
  const sourceFrame =
    source && sourceEntry ? reservePreparedNativeAsyncFrame(tx, source, sourceEntry, promise) : undefined;
  const frame =
    sourceFrame?.frame ??
    tx.reserveType("frame", {
      kind: "struct",
      name: "frame",
      fields: [
        ...["state", "sent", "mode", "abrupt", "error"].map((name, index) => ({
          name,
          type: index === 0 || index === 2 ? i32 : ext,
          mutable: true,
        })),
        { name: "seed", type: ext, mutable: false },
        { name: "result", type: promiseRef, mutable: true },
      ],
    });
  const grow = fn("grow", [i32], []),
    enqueue = fn("enqueue", [{ kind: "funcref" }, ext, ext], []),
    drain = fn("drain", [], []);
  const fulfill = fn("fulfill", [promiseRef, ext], [ext]),
    reject = fn("reject", [promiseRef, ext], [ext]);
  const entry = sourceFrame?.entry ?? fn("run", [ext], [ext]),
    resume = sourceFrame?.resume ?? fn("resume", [{ kind: "ref", typeIdx: frame.typeIndex }], []);
  const fulfillStep = sourceFrame?.fulfillStep ?? fn("fulfillStep", [ext, ext], [ext]),
    rejectStep = sourceFrame?.rejectStep ?? fn("rejectStep", [ext, ext], [ext]);
  const tag = tx.reserveTag("exception", { params: [ext], results: [] }, { kind: "defined", name: "exception" });
  if (tag.kind !== "tag") throw Error("kernel requires a defined tag");
  const resolution = reserveFrameResolutionKernel(tx, { promise, reaction, enqueue, fulfill, reject, tag });
  const functionsRef: ValType = { kind: "ref_null", typeIdx: functionsType.typeIndex };
  const argumentsRef: ValType = { kind: "ref_null", typeIdx: argumentsType.typeIndex };
  const globals = {
    head: tx.reserveGlobal("head", "head", i32, true),
    tail: tx.reserveGlobal("tail", "tail", i32, true),
    capacity: tx.reserveGlobal("capacity", "capacity", i32, true),
    functions: tx.reserveGlobal("functionStorage", "functionStorage", functionsRef, true),
    captures: tx.reserveGlobal("captures", "captures", argumentsRef, true),
    arguments: tx.reserveGlobal("argumentStorage", "argumentStorage", argumentsRef, true),
  };
  const callbackType = tx.internFunctionType([ext, ext], [ext]);
  const inspectors = Object.fromEntries(
    ["state", "value", "handled"].map((name, index) => [name, fn(name, [ext], [index === 1 ? ext : i32])]),
  ) as Record<"state" | "value" | "handled", FunctionReservation>;
  const pending = fn("pending", [], [ext]);
  // A finite kernel control; full realm integration supplies NativePromiseObjects.create.
  const create = fn("createPromise", [i32], [promiseRef]);
  const bag = tx.reserveType("promiseBag", { kind: "struct", name: "kernelPromiseBag", fields: [] });
  const settleExports = {
    fulfill: fn("settleFulfill", [ext, ext], [ext]),
    reject: fn("settleReject", [ext, ext], [ext]),
  };
  const tokens = new Map<object, PhysicalReservation>();
  const handle = <T extends PhysicalReservation & { object: object }>(
    token: T,
  ): { bindingId: IrBindingId; target: T["object"] } => {
    tokens.set(token.object, token);
    return { bindingId: token.key as IrBindingId, target: token.object };
  };
  const struct = (token: TypeReservation) => {
    if (token.object.kind !== "struct") throw Error("expected struct");
    return handle(token) as { bindingId: IrBindingId; target: StructTypeDef };
  };
  const owner = "native-frame-kernel" as IrUnitId;
  const resources: PreparedFrameResources = {
    owner,
    frame: struct(frame),
    resultField: 6,
    entry: handle(entry),
    resume: handle(resume),
    fulfillStep: handle(fulfillStep),
    rejectStep: handle(rejectStep),
    exceptionTag: handle(tag),
    runtime: {
      kind: "native",
      create: handle(create),
      promise: struct(promise),
      reaction: struct(reaction),
      enqueue: handle(enqueue),
      resolveValue: handle(resolution.resolveValue),
      reject: handle(reject),
      markHandled: { kind: "not-required" },
    },
    operations: [],
    conversions: [],
    undefinedSource: { kind: "not-required" },
    allocator: {
      function(h) {
        const t = tokens.get(h.target);
        if (!t || t.kind !== "function") throw Error("foreign function");
        tx.physicalIndex(t);
        return { index: t.handle, target: h.target };
      },
      type(h) {
        const t = tokens.get(h.target);
        if (!t || t.kind !== "type") throw Error("foreign type");
        return { index: tx.physicalIndex(t), target: h.target };
      },
      tag(h) {
        const t = tokens.get(h.target);
        if (!t || t.kind !== "tag") throw Error("foreign tag");
        return { index: tx.physicalIndex(t), target: h.target };
      },
    },
    assertCurrent() {
      if (tx.state !== "filling") throw Error("wrong transaction phase");
      tx.physicalIndices([...tokens.values()]);
    },
  };
  const plan: PreparedFramePlan = {
    owner,
    handlers: [],
    values: [
      { id: 0, type: ext, param: 0 },
      { id: 1, type: ext },
    ],
    states:
      completion === "return"
        ? [
            {
              id: 0,
              restore: [],
              body() {},
              terminator: {
                kind: "resolve",
                value(e) {
                  e.body.push(get(e.local(0)));
                },
              },
            },
          ]
        : [
            {
              id: 0,
              restore: [],
              body() {},
              terminator: {
                kind: "suspend",
                awaited(e) {
                  e.body.push(get(e.local(0)));
                },
                next: 1,
                live: [],
              },
            },
            {
              id: 1,
              restore: [],
              resume(e) {
                e.resumeValue();
                e.body.push({ op: "local.set", index: e.local(1) });
              },
              body() {},
              terminator: {
                kind: "resolve",
                value(e) {
                  e.body.push(get(e.local(1)));
                },
              },
            },
          ],
  };
  const number = source
    ? {
        boxType: tx.reserveType("number", {
          kind: "struct",
          name: "number",
          fields: [{ name: "value", type: { kind: "f64" }, mutable: false }],
        }),
        boolType: tx.reserveType("bool", {
          kind: "struct",
          name: "bool",
          fields: [{ name: "value", type: i32, mutable: false }],
        }),
        box: fn("box", [{ kind: "f64" }], [ext]),
        unbox: fn("unbox", [ext], [{ kind: "f64" }]),
      }
    : undefined;
  tx.freezeReservations();
  const queue: PreparedNativeMicrotaskReservations = {
    types: {
      functions: { kind: "type", index: functionsType.typeIndex },
      arguments: { kind: "type", index: argumentsType.typeIndex },
      callback: { kind: "type", index: callbackType },
    },
    globals: Object.fromEntries(
      Object.entries(globals).map(([name, token]) => [name, { kind: "global", index: tx.physicalIndex(token) }]),
    ) as PreparedNativeMicrotaskReservations["globals"],
    grow: { kind: "function", index: grow.handle },
    initialCapacity: 4,
  };
  for (const token of Object.values(globals))
    tx.fillGlobal(token, [
      token.object.type.kind === "i32"
        ? { op: "i32.const", value: 0 }
        : { op: "ref.null", typeIdx: (token.object.type as { typeIdx: number }).typeIdx },
    ]);
  function fillSupport() {
    tx.fillFunction(create, {
      locals: [],
      body: buildNativePromiseAllocation(
        promise.typeIndex,
        [{ op: "struct.new", typeIdx: bag.typeIndex }, { op: "extern.convert_any" }],
        [get(0)],
      ),
    });
    resolution.fill();
    if (number) {
      tx.fillFunction(number.box, {
        locals: buildBoxNumberLocals(),
        body: buildBoxNumberBody(number.boxType.typeIndex),
      });
      tx.fillFunction(number.unbox, {
        locals: buildUnboxNumberLocals(),
        body: buildUnboxNumberBody(number.boxType.typeIndex, number.boolType.typeIndex, {
          kind: "absent",
          evidence: "selected-primitive-only",
        }),
      });
      tx.defineExport("export:number", "number", number.unbox);
    }
    tx.fillFunction(grow, { locals: buildGrowLocals(queue), body: buildGrowBody(queue) });
    tx.fillFunction(enqueue, { locals: [], body: buildEnqueueBody(queue) });
    tx.fillFunction(drain, { locals: buildDrainLocals(), body: buildDrainBody(queue) });
    for (const [index, token] of [fulfill, reject].entries())
      tx.fillFunction(token, {
        locals: buildPromiseSettleLocals(reaction.typeIndex),
        body: buildPromiseSettleBody(
          {
            promiseTypeIdx: promise.typeIndex,
            callbackTypeIdx: reaction.typeIndex,
            enqueueFuncIdx: enqueue.handle,
            resolveHook: undefined,
            unhandledHeadGlobalIdx: -1,
            unhandledNodeTypeIdx: -1,
          },
          index === 0 ? 1 : 2,
        ),
      });
    for (const [name, field] of [
      ["state", 0],
      ["value", 1],
      ["handled", 4],
    ] as const)
      tx.fillFunction(inspectors[name], {
        locals: [],
        body: [
          get(0),
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: promise.typeIndex },
          { op: "struct.get", typeIdx: promise.typeIndex, fieldIdx: field },
        ],
      });
    tx.fillFunction(pending, {
      locals: [],
      body: [
        { op: "i32.const", value: 0 },
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        { op: "ref.null.extern" },
        { op: "i32.const", value: 0 },
        { op: "struct.new", typeIdx: promise.typeIndex },
        { op: "extern.convert_any" },
      ],
    });
    for (const name of ["fulfill", "reject"] as const)
      tx.fillFunction(settleExports[name], {
        locals: [],
        body: [
          get(0),
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: promise.typeIndex },
          get(1),
          { op: "call", funcIdx: name === "fulfill" ? fulfill.handle : reject.handle },
        ],
      });
  }
  return {
    module,
    tx,
    plan,
    resources,
    sourceFrame,
    publish() {
      if (sourceFrame && source && sourcePlan && number) {
        const plan = sourcePlan.plan;
        const box = handle(number.box),
          unbox = handle(number.unbox);
        const bridge = (role: string) => {
          if (role === "number.box") return box;
          if (role === "number.unbox") return unbox;
          throw Error("unplanned kernel bridge: " + role);
        };
        const output = emitPreparedIrAsyncFrame(
          source.fn,
          assertPreparedIrAsyncRuntimeCurrent(
            source.fn.unitId,
            source.fn.name,
            source.fn.asyncPlan,
            source.fn.asyncRuntime,
          ),
          {
            ...resources,
            owner: plan.owner,
            resultField: plan.resultField,
            values: plan.values,
            operations: [box, unbox],
            callTargets: new Map(),
            callSignatures: new Map(),
            conversions: plan.conversions.map((row) => ({
              ...row,
              operation:
                row.operation.kind === "native-helper"
                  ? { kind: "helper" as const, target: bridge(row.operation.role) }
                  : row.operation,
            })),
            undefinedSource:
              plan.undefinedSource.kind === "native-helper"
                ? { kind: "helper", target: bridge(plan.undefinedSource.role) }
                : plan.undefinedSource,
          },
        );
        for (const role of ["entry", "resume", "fulfillStep", "rejectStep"] as const)
          tx.fillFunction(sourceFrame[role], output[role]);
      } else {
        const out = emitPreparedFrame(plan, resources);
        for (const [name, token] of Object.entries({ entry, resume, fulfillStep, rejectStep }))
          tx.fillFunction(token, out[name as keyof typeof out]);
      }
      fillSupport();
      tx.declareFunctionReference(fulfillStep);
      tx.declareFunctionReference(rejectStep);
      for (const [name, token] of Object.entries({ run: entry, drain, pending, ...inspectors, ...settleExports }))
        tx.defineExport("export:" + name, name, token);
      tx.seal();
    },
  };
}
