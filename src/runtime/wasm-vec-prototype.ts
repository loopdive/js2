// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export const WASM_VEC_PROTOTYPE_MISS = Symbol("wasm-vec-prototype-miss");

/**
 * Recover the one Array.prototype value that still crosses the JS-host seam.
 *
 * Do not expose the whole native prototype here. Native mutating/search
 * methods cannot observe properties stored in the compiled object's sidecar;
 * for example, `[].copyWithin.call({ length: Symbol() }, ...)` would miss the
 * symbolic length and fail to throw. Reflective `slice.call(arguments, ...)`
 * remains necessary for published ES5 bundles and is safe because the runtime
 * already presents arguments objects through their live host mirror.
 */
export function getWasmVecPrototypeMember(
  obj: unknown,
  key: PropertyKey,
  isArgumentsObject: boolean,
  exports: Record<string, Function> | undefined,
): unknown {
  if (isArgumentsObject) return WASM_VEC_PROTOTYPE_MISS;
  if (key !== "slice") return WASM_VEC_PROTOTYPE_MISS;
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
