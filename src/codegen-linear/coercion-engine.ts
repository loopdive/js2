// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Representation-aware JS coercion operations for the linear backend.
 *
 * The formatter owns Ryū arithmetic and memory layout; this module owns the
 * symbolic ToString operation and the stack-level call contract.
 */
import type { LinearContext, LinearFuncContext } from "./context.js";

export const NUMBER_TO_STRING_RUNTIME = "number_toString";

export function hasNumberToString(ctx: LinearContext): boolean {
  return ctx.funcMap.has(NUMBER_TO_STRING_RUNTIME);
}

export function emitNumberToStringCall(ctx: LinearContext, fctx: LinearFuncContext): void {
  const funcIdx = ctx.funcMap.get(NUMBER_TO_STRING_RUNTIME);
  if (funcIdx !== undefined) fctx.body.push({ op: "call", funcIdx });
}
