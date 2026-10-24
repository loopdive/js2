// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { FuncHandle, Instr, TypeHandle } from "../../../wasm/model/instructions.js";
import { PROMISE_STATE_FULFILLED, PROMISE_STATE_REJECTED } from "./settlement-bodies.js";

export interface PromiseReactionRegistration {
  readonly promiseTypeIdx: TypeHandle;
  readonly callbackTypeIdx: TypeHandle;
  readonly promiseFields: { readonly state: number; readonly value: number; readonly callbacks: number };
  readonly promiseLocal: number;
  readonly fulfilled: { readonly function: FuncHandle; readonly capturesLocal: number };
  readonly rejected: { readonly function: FuncHandle; readonly capturesLocal: number };
  readonly enqueue: FuncHandle;
  /** Existing late-rejection tracking runs before enqueueing the rejection reaction. */
  readonly beforeRejected: readonly Instr[];
}

/** Pending reactions prepend immutable nodes; settlement reverses the list to restore FIFO order. */
export function buildPromiseReactionRegistration(r: PromiseReactionRegistration): Instr[] {
  const get = (index: number): Instr => ({ op: "local.get", index });
  const field = (fieldIdx: number): Instr[] => [
    get(r.promiseLocal),
    { op: "struct.get", typeIdx: r.promiseTypeIdx, fieldIdx },
  ];
  const enqueue = (reaction: PromiseReactionRegistration["fulfilled"]): Instr[] => [
    { op: "ref.func", funcIdx: reaction.function },
    get(reaction.capturesLocal),
    ...field(r.promiseFields.value),
    { op: "call", funcIdx: r.enqueue },
  ];
  return [
    ...field(r.promiseFields.state),
    { op: "i32.const", value: PROMISE_STATE_FULFILLED },
    { op: "i32.eq" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: enqueue(r.fulfilled),
      else: [
        ...field(r.promiseFields.state),
        { op: "i32.const", value: PROMISE_STATE_REJECTED },
        { op: "i32.eq" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...structuredClone(r.beforeRejected), ...enqueue(r.rejected)],
          else: [
            get(r.promiseLocal),
            { op: "ref.func", funcIdx: r.fulfilled.function },
            get(r.fulfilled.capturesLocal),
            { op: "ref.func", funcIdx: r.rejected.function },
            get(r.rejected.capturesLocal),
            ...field(r.promiseFields.callbacks),
            { op: "struct.new", typeIdx: r.callbackTypeIdx },
            { op: "extern.convert_any" },
            { op: "struct.set", typeIdx: r.promiseTypeIdx, fieldIdx: r.promiseFields.callbacks },
          ],
        },
      ],
    },
  ];
}
