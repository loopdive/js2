// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "./callable-bindings.js";

export const IR_CLOSURE_VECTOR_APPLY = "js.closure.apply-vector";
export const IR_CLOSURE_METHOD_PREFIX = "js.closure.call:";
export const IR_CLOSURE_UNDEFINED = "js.closure.undefined";
/**
 * A member of an arity family: `prefix` followed by the number of value operands (`js.closure.call:N`,
 * `js.function.construct:N`). One spelling per arity, so a call site's operand count is its symbol.
 */
export function irArityCallableReference(prefix: string, arity: number) {
  if (!Number.isSafeInteger(arity) || arity < 0) throw new Error("invalid arity-family operand count");
  return irIntrinsicFuncRef(`${prefix}${arity}`);
}
/** The operand count of `symbol` in the family `prefix`, or `undefined` for a non-member or non-canonical spelling. */
export function arityCallableArity(prefix: string, symbol: string): number | undefined {
  if (!symbol.startsWith(prefix)) return undefined;
  const suffix = symbol.slice(prefix.length);
  const value = Number(suffix);
  return Number.isSafeInteger(value) && value >= 0 && String(value) === suffix ? value : undefined;
}
