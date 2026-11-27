// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irIntrinsicFuncRef } from "./callable-bindings.js";

export const IR_CLOSURE_VECTOR_APPLY = "js.closure.apply-vector";
export const IR_CLOSURE_METHOD_PREFIX = "js.closure.call:";
export const IR_CLOSURE_UNDEFINED = "js.closure.undefined";
/** (#7354 C2) The receiver the dispatcher installed for the running call (`__current_this`): OrdinaryCallBindThis's input. */
export const IR_CLOSURE_RECEIVER = "js.closure.receiver";
/**
 * (#7562) The two halves of the dispatcher's count protocol (`__argc`, `__extra_args`) outside the dispatcher: the
 * entry read of a function that reads `arguments` (its `arguments.length`), and a direct call's publication of its
 * count (an i32 operand) with no extras.
 */
export const IR_CLOSURE_ARGUMENTS_LENGTH = "js.closure.arguments-length";
export const IR_CLOSURE_PUBLISH_ARGC = "js.closure.publish-argc";
type FixedKind = "apply-vector" | "undefined" | "receiver" | "arguments-length" | "publish-argc";
const FIXED_KINDS: ReadonlyMap<string, FixedKind> = new Map<string, FixedKind>([
  [IR_CLOSURE_VECTOR_APPLY, "apply-vector"],
  [IR_CLOSURE_UNDEFINED, "undefined"],
  [IR_CLOSURE_RECEIVER, "receiver"],
  [IR_CLOSURE_ARGUMENTS_LENGTH, "arguments-length"],
  [IR_CLOSURE_PUBLISH_ARGC, "publish-argc"],
]);
export function irClosureMethodReference(arity: number) {
  if (!Number.isSafeInteger(arity) || arity < 0) throw new Error("invalid closure method arity");
  return irIntrinsicFuncRef(`${IR_CLOSURE_METHOD_PREFIX}${arity}`);
}
/** Which closure-invocation callable `symbol` names, if any: the one reading of the family's spellings. */
export function closureInvocationKind(symbol: string): "method" | FixedKind | undefined {
  return closureMethodArity(symbol) !== undefined ? "method" : FIXED_KINDS.get(symbol);
}
export function closureMethodArity(symbol: string): number | undefined {
  if (!symbol.startsWith(IR_CLOSURE_METHOD_PREFIX)) return undefined;
  const suffix = symbol.slice(IR_CLOSURE_METHOD_PREFIX.length);
  const value = Number(suffix);
  return Number.isSafeInteger(value) && value >= 0 && String(value) === suffix ? value : undefined;
}
