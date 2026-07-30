// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

type CallbackState = {
  getExports: () => Record<string, Function> | undefined;
  deferToExports?: (fn: () => void) => void;
};

// #3540 — Compiled closures do not retain source text, so their observable
// Function stringification uses the implementation-defined NativeFunction
// grammar rather than exposing a WasmGC struct fallback (`[object Object]`) or
// the source of an internal JS callback bridge. This is deliberately a facade:
// closure storage/call dispatch stays unchanged.
const NATIVE_FUNCTION_SOURCE = "function () { [native code] }";
const nativeFunctionToString = {
  toString(): string {
    return NATIVE_FUNCTION_SOURCE;
  },
}.toString;

export function installNativeFunctionSourceFacade<T extends Function>(fn: T): T {
  try {
    Object.defineProperty(fn, "toString", {
      value: nativeFunctionToString,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  } catch {
    /* Bridge source facades are best-effort for non-extensible host functions. */
  }
  return fn;
}

export function compiledClosureNativeSource(value: any, callbackState?: CallbackState): string | undefined {
  if (value == null || typeof value !== "object") return undefined;
  const isClosure = callbackState?.getExports()?.__is_closure as ((v: any) => number) | undefined;
  if (typeof isClosure !== "function") return undefined;
  try {
    return isClosure(value) === 1 ? NATIVE_FUNCTION_SOURCE : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build the host bridge used by the legacy callback-maker import.
 *
 * Keeping this beside the source facade makes every JS function exposed for a
 * compiled callback acquire the same observable NativeFunction syntax. The
 * deferred dispatch preserves callbacks fired during module instantiation,
 * before the Wasm exports have been wired into the host runtime.
 */
export function createNativeFunctionCallbackBridge(
  id: number,
  cap: any,
  callbackState?: CallbackState,
): (...args: any[]) => any {
  return installNativeFunctionSourceFacade((...args: any[]) => {
    const exports = callbackState?.getExports();
    if (exports === undefined && callbackState?.deferToExports) {
      callbackState.deferToExports(() => {
        callbackState.getExports()?.[`__cb_${id}`]?.(cap, ...args);
      });
      return undefined;
    }
    return exports?.[`__cb_${id}`]?.(cap, ...args);
  });
}
