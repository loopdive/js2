// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, LocalDef } from "../../../wasm/model/instructions.js";
import type {
  PhysicalModuleReservations,
  FunctionReservation,
  GlobalReservation,
} from "../../../wasm/physical/module-reservations.js";
import type { NativePromiseReservations } from "./native-promises.js";
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
import { buildPromiseSettleClosureBody } from "../../../runtime/wasmgc/promise/resolution-bodies.js";

type Definition = { locals: LocalDef[]; body: Instr[] };
interface KernelBodies {
  readonly metadataType: number;
  readonly hook: PromiseHookResources;
  readonly unhandledHead: number;
  readonly unhandledNode: number;
  readonly resolveValue: Definition;
  readonly peel: Definition;
  readonly classifier: Definition;
  readonly lookupThen: Definition;
  readonly thenableJob: Definition;
}
function promiseQueueReservations(
  tx: PhysicalModuleReservations,
  pack: NativePromiseReservations,
): PreparedNativeMicrotaskReservations {
  const t = pack.types;
  return {
    types: {
      functions: { kind: "type", index: t.functions.typeIndex },
      arguments: { kind: "type", index: t.arguments.typeIndex },
      callback: { kind: "type", index: t.callbackSignature },
    },
    globals: Object.fromEntries(
      Object.entries(pack.globals).map(([name, token]) => [name, { kind: "global", index: tx.physicalIndex(token) }]),
    ) as PreparedNativeMicrotaskReservations["globals"],
    grow: { kind: "function", index: pack.functions.grow.handle },
    initialCapacity: 8192,
  };
}

/** Shared assembly of queue, settlement and resolving closures; caller retains semantic ownership. */
export function nativePromiseKernelDefinitions(
  tx: PhysicalModuleReservations,
  pack: NativePromiseReservations,
  input: KernelBodies,
) {
  const f = pack.functions,
    t = pack.types,
    queue = promiseQueueReservations(tx, pack);
  const functions: { token: FunctionReservation; definition: Definition }[] = [];
  const globals: { token: GlobalReservation; init: Instr[] }[] = [];
  const add = (token: FunctionReservation, definition: Definition) => functions.push({ token, definition });
  for (const token of [pack.globals.head, pack.globals.tail, pack.globals.capacity])
    globals.push({ token, init: [{ op: "i32.const", value: 0 }] });
  for (const token of [pack.globals.functions, pack.globals.captures, pack.globals.arguments]) {
    if (token.object.type.kind !== "ref_null") throw Error("native Promise resources: wrong queue storage type");
    globals.push({ token, init: [{ op: "ref.null", typeIdx: token.object.type.typeIdx }] });
  }
  add(f.grow, { locals: buildGrowLocals(queue), body: buildGrowBody(queue) });
  add(f.enqueue, { locals: [], body: buildEnqueueBody(queue) });
  add(f.drain, { locals: buildDrainLocals(), body: buildDrainBody(queue) });
  for (const [fn, state] of [
    [f.fulfill, PROMISE_STATE_FULFILLED],
    [f.reject, PROMISE_STATE_REJECTED],
  ] as const)
    add(fn, {
      locals: buildPromiseSettleLocals(t.callback.typeIndex),
      body: buildPromiseSettleBody(
        {
          promiseTypeIdx: t.promise.typeIndex,
          callbackTypeIdx: t.callback.typeIndex,
          enqueueFuncIdx: f.enqueue.handle,
          resolveHook: input.hook,
          unhandledHeadGlobalIdx: input.unhandledHead,
          unhandledNodeTypeIdx: input.unhandledNode,
        },
        state,
      ),
    });
  for (const [fn, settle] of [
    [f.identityFulfill, f.resolveValue],
    [f.identityReject, f.reject],
  ] as const)
    add(fn, {
      locals: buildIdentityWrapperLocals(t.captures.typeIndex),
      body: buildIdentityWrapperBody({
        capsTypeIdx: t.captures.typeIndex,
        settleFuncIdx: settle.handle,
        beforeHook: input.hook,
        afterHook: input.hook,
      }),
    });
  for (const role of ["resolveValue", "peel", "classifier", "lookupThen", "thenableJob"] as const)
    add(f[role], input[role]);
  const cap = {
    capTypeIdx: t.settleCapture.typeIndex,
    capMetaTypeIdx: input.metadataType,
    capPromiseFieldIdx: 5,
    guardTypeIdx: t.resolvingPair.typeIndex,
  };
  add(f.resolveClosure, {
    locals: [],
    body: buildPromiseSettleClosureBody({ ...cap, duplicateEvent: 3 }, f.resolveValue.handle),
  });
  add(f.rejectClosure, {
    locals: [],
    body: buildPromiseSettleClosureBody({ ...cap, duplicateEvent: 2 }, f.reject.handle),
  });
  return { functions, globals };
}
/** Does not issue a completion certificate; producer-specific completion follows separately. */
export function fillNativePromiseKernelDefinitions(
  tx: PhysicalModuleReservations,
  pack: NativePromiseReservations,
  definitions: ReturnType<typeof nativePromiseKernelDefinitions>,
): void {
  for (const { token, init } of definitions.globals) tx.fillGlobal(token, init);
  for (const { token, definition } of definitions.functions) tx.fillFunction(token, definition);
  const f = pack.functions;
  for (const fn of [f.identityFulfill, f.identityReject, f.thenableJob, f.resolveClosure, f.rejectClosure])
    tx.declareFunctionReference(fn);
}
