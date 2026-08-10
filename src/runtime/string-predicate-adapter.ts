// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export type HostStringPredicate = "includes" | "startsWith" | "endsWith";

const HOST_STRING_SYMBOL_DISPATCH = new Set(["replace", "replaceAll", "match", "matchAll", "search", "split"]);

export function isHostStringSymbolDispatch(method: string): boolean {
  return HOST_STRING_SYMBOL_DISPATCH.has(method);
}

/**
 * Build the fixed host ABI shared by the three String search predicates.
 *
 * Their Wasm signature is always
 * `(receiver, searchString, positionOrNaNSentinel) -> i32`. Keeping that
 * shape in the generic rest-argument adapter allocates two arrays per call
 * (`...args` plus its coerced copy). A fixed function preserves the live
 * prototype lookup and observable argument count without either allocation.
 */
export function makeHostStringPredicateAdapter(
  method: string,
  coerce: (value: any) => any,
): ((receiver: any, search: any, position: number) => any) | null {
  if (
    (typeof process !== "undefined" && process.env?.JS2WASM_HOST_STRING_PREDICATE_ABI === "0") ||
    (method !== "includes" && method !== "startsWith" && method !== "endsWith")
  ) {
    return null;
  }
  const predicate = method as HostStringPredicate;
  return (receiver: any, search: any, position: number): any => {
    const recv = coerce(receiver);
    const needle = coerce(search);
    const recvStr = typeof recv === "string" ? recv : String(recv);
    return Number.isNaN(position) ? (recvStr as any)[predicate](needle) : (recvStr as any)[predicate](needle, position);
  };
}
