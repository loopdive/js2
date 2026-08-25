// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { Instr } from "../ir/types.js";

interface NativeAwaitClassificationOptions {
  readonly alwaysAsync: boolean;
  readonly awaitedLocal: number;
  readonly promiseLocal: number;
  readonly frameLocal: number;
  readonly suspendedLocal: number;
  readonly promiseTypeIdx: number;
  readonly stateTypeIdx: number;
  readonly sentField: number;
  readonly errorField: number;
  readonly enqueueFuncIdx: number;
  readonly fulfillStepFuncIdx: number;
  readonly rejectStepFuncIdx: number;
  readonly markRejectionHandledFuncIdx: number;
  readonly setThrowMode: readonly Instr[];
}

/** Build the native Promise/plain-value classification shared by prepared awaits. */
export function buildNativeAwaitClassification(options: NativeAwaitClassificationOptions): Instr[] {
  const { alwaysAsync, awaitedLocal, promiseLocal, frameLocal, suspendedLocal, promiseTypeIdx, stateTypeIdx } = options;
  if (alwaysAsync && (options.enqueueFuncIdx < 0 || options.fulfillStepFuncIdx < 0 || options.rejectStepFuncIdx < 0)) {
    throw new Error("prepared native async await has no complete microtask-step runtime");
  }
  const settledPromiseValue: Instr[] = [
    { op: "local.get", index: promiseLocal },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 1 },
  ];
  const queueStep = (funcIdx: number, value: readonly Instr[]): Instr[] => [
    { op: "ref.func", funcIdx },
    { op: "local.get", index: frameLocal },
    { op: "extern.convert_any" },
    ...value,
    { op: "call", funcIdx: options.enqueueFuncIdx },
    { op: "i32.const", value: 2 },
    { op: "local.set", index: suspendedLocal },
  ];
  const deliverFromPromise: Instr[] = alwaysAsync
    ? queueStep(options.fulfillStepFuncIdx, settledPromiseValue)
    : [
        { op: "local.get", index: frameLocal },
        ...settledPromiseValue,
        { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: options.sentField },
      ];
  const rejectFromPromise: Instr[] = [
    ...(options.markRejectionHandledFuncIdx >= 0
      ? [
          { op: "local.get", index: promiseLocal } as Instr,
          { op: "call", funcIdx: options.markRejectionHandledFuncIdx } as Instr,
        ]
      : []),
    ...(alwaysAsync
      ? queueStep(options.rejectStepFuncIdx, settledPromiseValue)
      : [
          { op: "local.get", index: frameLocal } as Instr,
          ...settledPromiseValue,
          { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: options.errorField } as Instr,
          ...options.setThrowMode,
        ]),
  ];
  const markPending: Instr[] = [
    { op: "i32.const", value: 1 },
    { op: "local.set", index: suspendedLocal },
  ];
  const deliverPlain: Instr[] = alwaysAsync
    ? queueStep(options.fulfillStepFuncIdx, [{ op: "local.get", index: awaitedLocal }])
    : [
        { op: "local.get", index: frameLocal },
        { op: "local.get", index: awaitedLocal },
        { op: "struct.set", typeIdx: stateTypeIdx, fieldIdx: options.sentField },
      ];
  const pendingOrRejected: Instr[] = [
    { op: "local.get", index: promiseLocal },
    { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
    { op: "i32.const", value: 2 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: rejectFromPromise, else: markPending },
  ];
  return [
    { op: "i32.const", value: 0 },
    { op: "local.set", index: suspendedLocal },
    { op: "local.get", index: awaitedLocal },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: promiseTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: awaitedLocal },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: promiseTypeIdx },
        { op: "local.set", index: promiseLocal },
        { op: "local.get", index: promiseLocal },
        { op: "struct.get", typeIdx: promiseTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 1 },
        { op: "i32.eq" },
        { op: "if", blockType: { kind: "empty" }, then: deliverFromPromise, else: pendingOrRejected },
      ],
      else: deliverPlain,
    },
  ];
}

/** Choose a real pending subscription or the already-queued return path. */
export function buildNativeAwaitSuspendArm(
  alwaysAsync: boolean,
  suspendedLocal: number,
  pendingArm: readonly Instr[],
  queuedArm: readonly Instr[],
): Instr[] {
  if (!alwaysAsync) return [...pendingArm];
  return [
    { op: "local.get", index: suspendedLocal },
    { op: "i32.const", value: 1 },
    { op: "i32.eq" },
    { op: "if", blockType: { kind: "empty" }, then: [...pendingArm], else: [...queuedArm] },
  ];
}
