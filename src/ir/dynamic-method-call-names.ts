// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#7106 Stage 4, #7117) Names of the per-(method, arity) dynamic method-call
 * wrappers `__ir_dyn_mcall_<m>_<n>(recv, a0, …) -> carrier`. The IR names the
 * wrapper; codegen builds it from legacy's own any-receiver call emitter
 * (`codegen/object-model/ir-dynamic-method-call.ts`).
 */
import { BUILTIN_PROTOTYPE_METHOD_NAMES } from "./builtin-method-names.js";

const IR_DYN_MCALL_PREFIX = "__ir_dyn_mcall_";
/** Small fixed arity range: one wrapper per (method, arity) actually used. */
const IR_DYN_MCALL_MAX_ARITY = 3;

const METHOD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** May the IR name a wrapper for `recv.<method>(…arity args)`? (Identifier-safe names only.) */
export function irDynamicMethodCallIsNameable(method: string, arity: number): boolean {
  return METHOD_NAME.test(method) && Number.isInteger(arity) && arity >= 0 && arity <= IR_DYN_MCALL_MAX_ARITY;
}

/**
 * Does `recv.<method>(…arity args)` on a dynamic receiver need the wrapper?
 * The generic `__ir_dyn_method_call_0/1` → `__extern_method_call` serves a
 * USER method name with at most one argument exactly (open `$Object` /
 * instance / closure dispatch), and `charCodeAt` through the string runtime's
 * fast path. A built-in prototype method name needs brand dispatch off the
 * host lane, and a wider call has no generic helper at all.
 */
export function irDynamicMethodCallNeedsWrapper(method: string, arity: number): boolean {
  return arity > 1 || (method !== "charCodeAt" && BUILTIN_PROTOTYPE_METHOD_NAMES.has(method));
}

export function irDynamicMethodCallHelperName(method: string, arity: number): string {
  if (!irDynamicMethodCallIsNameable(method, arity)) {
    throw new Error(`ir/dynamic-method-call: unnameable wrapper ${method}/${arity}`);
  }
  return `${IR_DYN_MCALL_PREFIX}${method}_${arity}`;
}

/** Inverse of {@link irDynamicMethodCallHelperName}; undefined for any other symbol. */
export function parseIrDynamicMethodCallHelperName(
  symbol: string,
): { readonly method: string; readonly arity: number } | undefined {
  if (!symbol.startsWith(IR_DYN_MCALL_PREFIX)) return undefined;
  const rest = symbol.slice(IR_DYN_MCALL_PREFIX.length);
  const cut = rest.lastIndexOf("_");
  if (cut <= 0) return undefined;
  const method = rest.slice(0, cut);
  const arity = Number(rest.slice(cut + 1));
  return irDynamicMethodCallIsNameable(method, arity) ? { method, arity } : undefined;
}
