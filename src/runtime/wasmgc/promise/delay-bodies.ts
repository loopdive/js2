// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { FuncHandle, Instr, LocalDef, TypeHandle, ValType } from "../../../wasm/model/instructions.js";
import { buildStandardTryTable } from "../../../wasm/physical/exception-control.js";
import { PROMISE_STATE_PENDING } from "./settlement-bodies.js";

export interface NativePromiseDelayCaptureLayout {
  readonly captureTypeIdx: TypeHandle;
  readonly promiseFieldIdx: 3;
  readonly valueFieldIdx: 4;
}

export interface NativePromiseDelayCallbackResources {
  readonly capture: NativePromiseDelayCaptureLayout;
  readonly boxNumberFuncIdx: FuncHandle;
  readonly resolveValueFuncIdx: FuncHandle;
}

export interface NativePromiseDelayProviderResources {
  readonly promiseTypeIdx: TypeHandle;
  readonly capture: NativePromiseDelayCaptureLayout;
  readonly timerCallbackFuncIdx: FuncHandle;
  readonly timerFuncIdx: FuncHandle;
  readonly boxNumberFuncIdx: FuncHandle;
  readonly rejectFuncIdx: FuncHandle;
  readonly exnTagIdx: number;
  readonly callbackArity: 0;
  readonly bagInit: { readonly op: "ref.null.extern" };
}

export function buildNativePromiseDelayCallbackLocals(): LocalDef[] {
  return [];
}

export function buildNativePromiseDelayCallbackBody(resources: NativePromiseDelayCallbackResources): Instr[] {
  return [
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: resources.capture.captureTypeIdx },
    { op: "struct.get", typeIdx: resources.capture.captureTypeIdx, fieldIdx: resources.capture.promiseFieldIdx },
    { op: "local.get", index: 0 },
    { op: "ref.cast", typeIdx: resources.capture.captureTypeIdx },
    { op: "struct.get", typeIdx: resources.capture.captureTypeIdx, fieldIdx: resources.capture.valueFieldIdx },
    { op: "call", funcIdx: resources.boxNumberFuncIdx },
    { op: "call", funcIdx: resources.resolveValueFuncIdx },
    { op: "drop" },
  ];
}

export function buildNativePromiseDelayProviderLocals(promiseTypeIdx: TypeHandle): LocalDef[] {
  const externref: ValType = { kind: "externref" };
  return [
    { name: "$promise", type: { kind: "ref", typeIdx: promiseTypeIdx } },
    { name: "$reason", type: externref },
  ];
}

export function buildNativePromiseDelayProviderBody(resources: NativePromiseDelayProviderResources): Instr[] {
  const promiseLocal = 2;
  const reasonLocal = 3;
  const timerRegistration: Instr[] = [
    { op: "ref.func", funcIdx: resources.timerCallbackFuncIdx },
    { op: "i32.const", value: resources.callbackArity },
    { op: resources.bagInit.op },
    { op: "local.get", index: promiseLocal },
    { op: "local.get", index: 1 },
    { op: "struct.new", typeIdx: resources.capture.captureTypeIdx },
    { op: "extern.convert_any" },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: resources.boxNumberFuncIdx },
    { op: "call", funcIdx: resources.timerFuncIdx },
    { op: "drop" },
  ];
  return [
    { op: "i32.const", value: PROMISE_STATE_PENDING },
    { op: "ref.null.extern" },
    { op: "ref.null.extern" },
    { op: resources.bagInit.op },
    { op: "struct.new", typeIdx: resources.promiseTypeIdx },
    { op: "local.set", index: promiseLocal },
    buildStandardTryTable({ kind: "empty" }, timerRegistration, [
      {
        kind: "catch",
        tagIdx: resources.exnTagIdx,
        payloadType: { kind: "externref" },
        body: [
          { op: "local.set", index: reasonLocal },
          { op: "local.get", index: promiseLocal },
          { op: "local.get", index: reasonLocal },
          { op: "call", funcIdx: resources.rejectFuncIdx },
          { op: "drop" },
        ],
      },
      // A JavaScript timer provider can throw a foreign host exception rather
      // than the module's tagged `throw` payload. The Promise constructor must
      // still return a rejected Promise instead of leaking that exception
      // synchronously. No host exception-value import is introduced here: the
      // rejection reason is the native null/undefined boundary sentinel.
      {
        kind: "catch_all",
        body: [
          { op: "local.get", index: promiseLocal },
          { op: "ref.null.extern" },
          { op: "call", funcIdx: resources.rejectFuncIdx },
          { op: "drop" },
        ],
      },
    ]),
    { op: "local.get", index: promiseLocal },
    { op: "extern.convert_any" },
  ];
}
