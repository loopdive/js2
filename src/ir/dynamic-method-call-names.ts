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
const IR_WRAPPER_MAX_ARITY = 3;

/** Identifier-safe and wasm-name-safe: `$` is legal in both. */
const METHOD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * May the IR name a per-(method, arity) wrapper symbol `<prefix><method>_<arity>`?
 * Identifier-safe method names and the small fixed arity range only — shared by
 * every wrapper family codegen builds from legacy's emitters over a template.
 */
export function irWrapperSymbolIsNameable(method: string, arity: number): boolean {
  return METHOD_NAME.test(method) && Number.isInteger(arity) && arity >= 0 && arity <= IR_WRAPPER_MAX_ARITY;
}

/**
 * The admission every template wrapper family shares: the family's own
 * question (`admits` — its lane, or its method list) and the IR contract's
 * nameable (method, arity). One predicate, so a family cannot admit a pair it
 * could not name.
 */
export function irWrapperAdmitted(admits: boolean, method: string, arity: number): boolean {
  return admits && irWrapperSymbolIsNameable(method, arity);
}

/** `<prefix><method>_<arity>`; throws for a pair {@link irWrapperSymbolIsNameable} declines. */
export function irWrapperSymbol(prefix: string, method: string, arity: number): string {
  if (!irWrapperSymbolIsNameable(method, arity)) {
    throw new Error(`ir/wrapper-names: unnameable wrapper ${prefix}${method}/${arity}`);
  }
  return `${prefix}${method}_${arity}`;
}

/** Inverse of {@link irWrapperSymbol} for one prefix; undefined for any other symbol. */
export function parseIrWrapperSymbol(
  prefix: string,
  symbol: string,
): { readonly method: string; readonly arity: number } | undefined {
  if (!symbol.startsWith(prefix)) return undefined;
  const rest = symbol.slice(prefix.length);
  const cut = rest.lastIndexOf("_");
  if (cut <= 0) return undefined;
  const method = rest.slice(0, cut);
  const arity = Number(rest.slice(cut + 1));
  return irWrapperSymbolIsNameable(method, arity) ? { method, arity } : undefined;
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
  return irWrapperSymbol(IR_DYN_MCALL_PREFIX, method, arity);
}

/** Inverse of {@link irDynamicMethodCallHelperName}; undefined for any other symbol. */
export function parseIrDynamicMethodCallHelperName(
  symbol: string,
): { readonly method: string; readonly arity: number } | undefined {
  return parseIrWrapperSymbol(IR_DYN_MCALL_PREFIX, symbol);
}
