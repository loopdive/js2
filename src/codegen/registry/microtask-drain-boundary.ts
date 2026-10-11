// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AsyncSchedulerState } from "../async-scheduler.js";
import type { CodegenContext } from "../context/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "../func-space.js";
import { addFuncType } from "./types.js";
import {
  buildDrainBody,
  buildDrainLocals,
  type PreparedNativeMicrotaskReservations,
} from "../../runtime/wasmgc/async/microtask-queue-bodies.js";

/** Same Wasm-owned queue, but return after one job so a host can interleave
 * graphs with its native queue. Empty queues are a no-op, not a fabricated job.
 */
export function exportOneMicrotaskDrain(
  ctx: CodegenContext,
  state: AsyncSchedulerState,
  initialCapacity: number,
): void {
  const resources: PreparedNativeMicrotaskReservations = {
    types: {
      functions: { kind: "type", index: state.microtaskFuncArrTypeIdx },
      arguments: { kind: "type", index: state.microtaskArgsArrTypeIdx },
      callback: { kind: "type", index: state.microtaskFuncTypeIdx },
    },
    globals: {
      head: { kind: "global", index: state.microtaskHeadGlobalIdx },
      tail: { kind: "global", index: state.microtaskTailGlobalIdx },
      capacity: { kind: "global", index: state.microtaskCapGlobalIdx },
      functions: { kind: "global", index: state.microtaskFuncsGlobalIdx },
      captures: { kind: "global", index: state.microtaskCapsGlobalIdx },
      arguments: { kind: "global", index: state.microtaskArgsGlobalIdx },
    },
    grow: { kind: "function", index: state.growFuncIdx },
    initialCapacity,
  };
  const name = "__drain_one_microtask";
  const index = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, index, {
    name,
    typeIdx: addFuncType(ctx, [], [], "$__mt_drain_one_type"),
    locals: buildDrainLocals(),
    body: buildDrainBody(resources, true),
    exported: true,
  });
  ctx.mod.exports.push({ name, desc: { kind: "func", index } });
}
