// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "./callable-bindings.js";

export const IR_CLOSURE_VECTOR_APPLY = "js.closure.apply-vector";
export const IR_CLOSURE_METHOD_PREFIX = "js.closure.call:";
export const IR_CLOSURE_UNDEFINED = "js.closure.undefined";
export const IR_CLOSURE_RECEIVER = "js.closure.receiver";
export function irClosureMethodReference(arity: number) {
  if (!Number.isSafeInteger(arity) || arity < 0) throw new Error("invalid closure method arity");
  return irIntrinsicFuncRef(`${IR_CLOSURE_METHOD_PREFIX}${arity}`);
}
export function closureMethodArity(symbol: string): number | undefined {
  if (!symbol.startsWith(IR_CLOSURE_METHOD_PREFIX)) return undefined;
  const suffix = symbol.slice(IR_CLOSURE_METHOD_PREFIX.length);
  const value = Number(suffix);
  return Number.isSafeInteger(value) && value >= 0 && String(value) === suffix ? value : undefined;
}

/** Closed semantic invocation family, shared by declarations and actual demand census. */
export function closureInvocationKind(
  symbol: string,
): "method" | "apply-vector" | "undefined" | "receiver" | undefined {
  if (closureMethodArity(symbol) !== undefined) return "method";
  if (symbol === IR_CLOSURE_VECTOR_APPLY) return "apply-vector";
  if (symbol === IR_CLOSURE_UNDEFINED) return "undefined";
  if (symbol === IR_CLOSURE_RECEIVER) return "receiver";
  return undefined;
}
