// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import {
  nativeCommonPromiseRuntimeBinding,
  type NativeCommonPromiseRuntime,
} from "../../src/backend/wasmgc/resources/native-common-promise-runtime.js";
import type { fullRealmFixture } from "./native-full-realm-call.js";
import { reserveFrameResolutionKernel } from "./native-frame-resolution-kernel.js";
import {
  reservePreparedNativeAsyncFrame,
  fillPreparedNativeAsyncFrame,
  type NativeFrameDependencies,
} from "../../src/backend/wasmgc/resources/prepared-native-async-frame.js";
import { planPreparedNativeAsyncFrame } from "../../src/ir/program/prepared-native-async-frame-plan.js";
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

/** Actual source frame, realm and queue; finite resolver kernel, not full public Promise admission. */
export function reserveRealmAsyncFrame(r: ReturnType<typeof fullRealmFixture>, common?: NativeCommonPromiseRuntime) {
  const { tx, f } = r,
    objects = r.promiseObjects!,
    pack = objects.promise;
  const fn = f.projection.prepared.functions.find((row) => row.name === "run")!;
  const input = {
    fn,
    backend: "wasmgc" as const,
    target: "standalone" as const,
    abiEntries: f.program.abi.entries,
    anchor: f.program.inventory.sources.find((row) => row.kind === "entry")!,
    declarationOrderStart: Math.max(...f.program.abi.entries.map((row) => row.plan.order.declarationOrder)) + 1,
  };
  const planned = planPreparedNativeAsyncFrame(input);
  if (planned.kind !== "planned") throw Error(planned.detail);
  const entry = tx.reserveFunction(planned.plan.primary.bindingId, "run", {
    params: [{ kind: "f64" }],
    results: [{ kind: "externref" }],
  });
  const frame = reservePreparedNativeAsyncFrame(tx, input, entry, pack.types.promise);
  if (f.exception.tag.kind !== "tag") throw Error("defined exception tag required");
  const resolution = common
    ? undefined
    : reserveFrameResolutionKernel(tx, {
        promise: pack.types.promise,
        reaction: pack.types.callback,
        enqueue: pack.functions.enqueue,
        fulfill: pack.functions.fulfill,
        reject: pack.functions.reject,
        tag: f.exception.tag,
      });
  const observedAdapter = tx.reserveGlobal("control:async:adapter", "awaitAdapter", { kind: "externref" }, true);
  const observeResolution = tx.reserveFunction("control:async:observe-resolution", "observeResolution", {
    params: [{ kind: "ref", typeIdx: pack.types.promise.typeIndex }, { kind: "externref" }],
    results: [{ kind: "externref" }],
  });
  const implemented = new Set(
    common
      ? Object.values(pack.functions)
      : [
          pack.functions.grow,
          pack.functions.enqueue,
          pack.functions.drain,
          pack.functions.fulfill,
          pack.functions.reject,
        ],
  );
  const dependencies: NativeFrameDependencies = {
    promise: pack.types.promise,
    reaction: pack.types.callback,
    objects,
    enqueue: pack.functions.enqueue,
    resolveValue: observeResolution,
    reject: pack.functions.reject,
    markHandled: { kind: "not-required" },
    tag: f.exception.tag,
    bridges: new Map([
      ["number.box", r.values.functions.boxNumber],
      ["number.unbox", r.values.functions.unboxNumber],
    ]),
    calls: new Map(),
    assertAccepted() {
      if (common && nativeCommonPromiseRuntimeBinding(tx, common).promise !== pack) throw Error("different runtime");
      // This fixture certifies its actual source association, not whole-program admission.
      if (!f.projection.prepared.functions.includes(fn)) throw Error("foreign source association");
    },
  };
  return {
    frame,
    implemented,
    dependencies,
    fill() {
      tx.fillGlobal(observedAdapter, [{ op: "ref.null.extern" }]);
      tx.fillFunction(observeResolution, {
        locals: [],
        body: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: pack.types.promise.typeIndex, fieldIdx: 4 },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "extern.convert_any" },
              { op: "global.set", index: tx.physicalIndex(observedAdapter) },
            ],
          },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: common ? pack.functions.resolveValue.handle : resolution!.resolveValue.handle },
        ],
      });
      tx.defineExport("control:async:export:adapter", "awaitAdapter", observedAdapter);
      fillPreparedNativeAsyncFrame(tx, frame, dependencies);
      if (!common) {
        const queue: PreparedNativeMicrotaskReservations = {
          types: {
            functions: { kind: "type", index: pack.types.functions.typeIndex },
            arguments: { kind: "type", index: pack.types.arguments.typeIndex },
            callback: { kind: "type", index: pack.types.callbackSignature },
          },
          globals: Object.fromEntries(
            Object.entries(pack.globals).map(([name, token]) => [
              name,
              { kind: "global", index: tx.physicalIndex(token) },
            ]),
          ) as PreparedNativeMicrotaskReservations["globals"],
          grow: { kind: "function", index: pack.functions.grow.handle },
          initialCapacity: 4,
        };
        tx.fillFunction(pack.functions.grow, { locals: buildGrowLocals(queue), body: buildGrowBody(queue) });
        tx.fillFunction(pack.functions.enqueue, { locals: [], body: buildEnqueueBody(queue) });
        tx.fillFunction(pack.functions.drain, { locals: buildDrainLocals(), body: buildDrainBody(queue) });
        for (const [index, token] of [pack.functions.fulfill, pack.functions.reject].entries())
          tx.fillFunction(token, {
            locals: buildPromiseSettleLocals(pack.types.callback.typeIndex),
            body: buildPromiseSettleBody(
              {
                promiseTypeIdx: pack.types.promise.typeIndex,
                callbackTypeIdx: pack.types.callback.typeIndex,
                enqueueFuncIdx: pack.functions.enqueue.handle,
                resolveHook: undefined,
                unhandledHeadGlobalIdx: -1,
                unhandledNodeTypeIdx: -1,
              },
              index === 0 ? 1 : 2,
            ),
          });
        resolution!.fill();
      }
      tx.defineExport("control:async:export:run", "run", entry);
      tx.defineExport("control:async:export:drain", "drain", pack.functions.drain);
    },
  };
}
