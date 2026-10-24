// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { Instr, FuncHandle } from "../../../wasm/model/instructions.js";
import type { NativePromiseReservations } from "./native-promises.js";
import {
  buildNativePromiseResolveValueBody,
  buildPromiseResolveValueLocals,
  buildPromiseThenableJob,
} from "../../../runtime/wasmgc/promise/resolution-bodies.js";
interface Inputs {
  readonly commonGet?: true;
  readonly metadataType: number;
  readonly closureRoot: number;
  readonly exn: number;
  readonly newTypeError: FuncHandle;
  readonly selfString: readonly Instr[];
  readonly thenString: readonly Instr[];
  readonly bagHas?: FuncHandle;
  readonly externGet?: FuncHandle;
  readonly typeofFunction?: FuncHandle;
  readonly argumentNew: FuncHandle;
  readonly argumentPush: FuncHandle;
  readonly apply: FuncHandle;
  readonly thenDispatch?: FuncHandle;
}
/** Both native classifiers share the exact resolution/job assembly and resolving-pair layout. */
export function nativePromiseResolutionDefinitions(pack: NativePromiseReservations, input: Inputs) {
  const f = pack.functions,
    t = pack.types;
  const cap = {
    capTypeIdx: t.settleCapture.typeIndex,
    capMetaTypeIdx: input.metadataType,
    capPromiseFieldIdx: 5,
    guardTypeIdx: t.resolvingPair.typeIndex,
  };
  const target = { wasi: false, standalone: true };
  const resolution = buildNativePromiseResolveValueBody({
    ...(input.commonGet ? { resolutionMode: "common-get" as const } : {}),
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
      lookupThenFuncIdx: f.lookupThen.handle,
      thenableJobFuncIdx: f.thenableJob.handle,
      peelValueFuncIdx: f.peel.handle,
      newTypeErrorFuncIdx: input.newTypeError,
    },
    exnTagIdx: input.exn,
    selfResolutionStringInstrs: input.selfString,
    thenStringInstrs: input.thenString,
    thenGetStringInstrs: input.thenString,
    bagHasIdx: input.bagHas,
    externGetIdx: input.externGet,
    typeofFunctionIdx: input.typeofFunction,
    callableRootTypeIdx: input.closureRoot,
  });
  const job = buildPromiseThenableJob({
    ...(input.commonGet ? { invocationMode: "captured" as const } : {}),
    target,
    promiseTypeIdx: t.promise.typeIndex,
    promiseRejectFuncIdx: f.reject.handle,
    capsTypeIdx: t.captures.typeIndex,
    capsFields: { callback: 0, chained: 1 },
    objVecNewIdx: input.argumentNew,
    objVecPushIdx: input.argumentPush,
    execClosures: { ...cap, resolveClFuncIdx: f.resolveClosure.handle, rejectClFuncIdx: f.rejectClosure.handle },
    applyClosureIdx: input.apply,
    peelValueFuncIdx: f.peel.handle,
    varargThenFuncIdx: input.thenDispatch,
    exnTag: input.exn,
  });
  return {
    resolveValue: { locals: buildPromiseResolveValueLocals(t.promise.typeIndex), body: resolution },
    thenableJob: job,
  };
}
