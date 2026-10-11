// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#6879) The JS view of a value minted by a native-regime module (native-first
 * codegen behind the JS value boundary).
 *
 * Such a module exports its own object MOP. Its CLOSED structs — a fnctor
 * instance such as acorn's `Node` — keep expando properties (`node.body = []`)
 * in the native carrier bag, which no `__sget_<field>` getter and no host
 * sidecar can see; only `__extern_get` / `__object_keys` reach them. The host
 * lane imports those names instead of exporting them, so it never takes these
 * arms.
 */
export function isNativeRegimeExports(
  exports: Record<string, Function> | undefined,
): exports is Record<string, Function> {
  return typeof exports?.__extern_get === "function" && typeof exports?.__object_is_native_open === "function";
}

/**
 * Read `key` off `obj` through the module's own `__extern_get`, for the view's
 * last resort before the host prototype lookup. Answers `undefined` on a miss
 * (the native undefined box) or when the module is not a native-regime module,
 * so the caller's remaining arms run unchanged.
 */
export function readNativeRegimeBag(
  obj: unknown,
  key: unknown,
  exports: Record<string, Function> | undefined,
  toNativeKey: (key: string | number, exports: Record<string, Function>) => unknown,
  toHostPrimitive: (value: unknown, exports: Record<string, Function>) => unknown,
): unknown {
  if (!isNativeRegimeExports(exports) || (typeof key !== "string" && typeof key !== "number")) return undefined;
  try {
    const value = exports.__extern_get(obj, toNativeKey(key, exports));
    return toHostPrimitive(value, exports) === undefined ? undefined : value;
  } catch {
    return undefined;
  }
}
