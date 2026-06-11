// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Body stack helpers for nested code emission.
 *
 * This module owns the low-level mechanics for temporarily swapping a function
 * body while preserving enough state for late import index shifting.
 */
import type { Instr } from "../../ir/types.js";
import type { FunctionContext } from "./types.js";

export function pushBody(fctx: FunctionContext): Instr[] {
  const saved = fctx.body;
  fctx.savedBodies.push(saved);
  fctx.body = [];
  return saved;
}

export function popBody(fctx: FunctionContext, saved: Instr[]): void {
  fctx.savedBodies.pop();
  fctx.body = saved;
}

/**
 * Like pushBody, but redirect emission into a caller-provided buffer instead
 * of a fresh array. Registers the outgoing body on `savedBodies` so
 * shiftLateImportIndices / global-index fixups can still reach the calls
 * already baked into it while the buffer is active (#1919 slice 3: a raw
 * `const saved = fctx.body; fctx.body = buf` swap detaches the outer body —
 * any late import flushed inside the window leaves its baked funcIdx values
 * one slot low). Restore with popBody(fctx, saved).
 */
export function pushBodyTo(fctx: FunctionContext, buffer: Instr[]): Instr[] {
  const saved = fctx.body;
  fctx.savedBodies.push(saved);
  fctx.body = buffer;
  return saved;
}
