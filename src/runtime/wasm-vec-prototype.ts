// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export const WASM_VEC_PROTOTYPE_MISS = Symbol("wasm-vec-prototype-miss");

/** Recover Array.prototype values for opaque compiler-owned vec carriers. */
export function getWasmVecPrototypeMember(
  obj: unknown,
  key: PropertyKey,
  isArgumentsObject: boolean,
  exports: Record<string, Function> | undefined,
): unknown {
  if (isArgumentsObject) return WASM_VEC_PROTOTYPE_MISS;
  const isVec = exports?.__is_vec as ((value: unknown) => number) | undefined;
  if (typeof isVec !== "function") return WASM_VEC_PROTOTYPE_MISS;
  try {
    if (isVec(obj) === 1 && Reflect.has(Array.prototype, key)) {
      return (Array.prototype as unknown as Record<PropertyKey, unknown>)[key];
    }
  } catch {
    // The value is not a live vec for this module.
  }
  return WASM_VEC_PROTOTYPE_MISS;
}
