// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AsyncCallbackExceptionPolicy } from "../ir/async-runtime-providers.js";

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
 * Remove only this module's Wasm exception carrier at a host callback edge.
 * A foreign tag, a WebAssembly.RuntimeError, or an ordinary host throw passes
 * through by identity. The returned payload may itself be any JS value.
 */
export function normalizeModuleCallbackException(
  error: any,
  callbackState?: CallbackState,
  exceptionPolicy?: AsyncCallbackExceptionPolicy,
): any {
  if (exceptionPolicy !== "module-tag-payload") return error;
  const exports = callbackState?.getExports();
  const tag = exports?.__exn_tag ?? exports?.__tag;
  const WasmException = typeof WebAssembly === "undefined" ? undefined : (WebAssembly as any).Exception;
  if (typeof WasmException !== "function" || !(error instanceof WasmException) || tag === undefined) {
    return error;
  }
  try {
    // `getArg` rejects a foreign tag. Checking `is` first makes the policy
    // explicit on engines that expose it; the guarded getArg is the same
    // exact-tag proof on older engines.
    const tagged = error as { is?: (candidate: any) => boolean; getArg: (candidate: any, index: number) => any };
    if (typeof tagged.is === "function" && !tagged.is(tag)) return error;
    return tagged.getArg(tag, 0);
  } catch {
    return error;
  }
}

export function invokeNativeFunctionCallback(
  id: number,
  cap: any,
  args: readonly any[],
  callbackState?: CallbackState,
  exceptionPolicy?: AsyncCallbackExceptionPolicy,
): any {
  try {
    return callbackState?.getExports()?.[`__cb_${id}`]?.(cap, ...args);
  } catch (error) {
    throw normalizeModuleCallbackException(error, callbackState, exceptionPolicy);
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
  exceptionPolicy?: AsyncCallbackExceptionPolicy,
  constructible = false,
): (...args: any[]) => any {
  const dispatch = (args: any[]): any => invokeNativeFunctionCallback(id, cap, args, callbackState, exceptionPolicy);
  const body = (args: any[]): any => {
    const exports = callbackState?.getExports();
    if (exports === undefined && callbackState?.deferToExports) {
      callbackState.deferToExports(() => {
        dispatch(args);
      });
      return undefined;
    }
    return dispatch(args);
  };
  // (#4394) The bridge's [[Construct]] must mirror the compiled callable's.
  // An arrow has none, so every compiled function that crossed to the host was
  // rejected by `Reflect.construct` / `new` — which is what made the harness's
  // `isConstructor` answer `false` for a plain `function () {}`. A function
  // EXPRESSION carries [[Construct]]; the arrow stays the default so arrows,
  // generators, async functions and methods keep refusing construction.
  //
  // Neither form reads `this`: the compiled body reaches its receiver through
  // the `__current_this` protocol, not the bridge's binding, so the only
  // observable difference is constructibility.
  return installNativeFunctionSourceFacade(
    constructible
      ? function nativeFunctionCallbackBridge(...args: any[]): any {
          return body(args);
        }
      : (...args: any[]): any => body(args),
  );
}
