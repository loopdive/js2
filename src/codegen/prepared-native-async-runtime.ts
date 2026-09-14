// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export type {
  PreparedNativeQueueHandle,
  PreparedNativeMicrotaskReservations,
} from "../runtime/wasmgc/async/microtask-queue-bodies.js";
export {
  buildGrowLocals,
  buildGrowBody,
  buildEnqueueBody,
  buildDrainLocals,
  buildDrainBody,
} from "../runtime/wasmgc/async/microtask-queue-bodies.js";
