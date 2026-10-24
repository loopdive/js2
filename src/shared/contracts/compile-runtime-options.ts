// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Explicit embedding policy; absence never means that either facility is disabled. */
export interface NativePromiseConfiguration {
  readonly hooks: "disabled" | "dispatch";
  readonly unhandledRejections: "disabled" | "track";
}

/** Capture only this finite own-data contract, without executing option getters. */
export function snapshotNativePromiseConfiguration(
  value: unknown,
  scope?: { readonly backend: string; readonly target: string },
): NativePromiseConfiguration | undefined {
  if (value === undefined) return undefined;
  if (scope && (scope.backend !== "wasmgc" || scope.target !== "standalone"))
    throw new TypeError("invalid native Promise configuration: requires standalone WasmGC");
  const fail = (): never => {
    throw new TypeError("invalid native Promise configuration: expected own hooks and unhandledRejections policies");
  };
  if (value === null || typeof value !== "object") return fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("hooks") || !keys.includes("unhandledRejections")) return fail();
  const hooks = Object.getOwnPropertyDescriptor(value, "hooks");
  const rejections = Object.getOwnPropertyDescriptor(value, "unhandledRejections");
  if (!hooks || !("value" in hooks) || !rejections || !("value" in rejections)) return fail();
  if (hooks.value !== "disabled" && hooks.value !== "dispatch") return fail();
  if (rejections.value !== "disabled" && rejections.value !== "track") return fail();
  return Object.freeze({ hooks: hooks.value, unhandledRejections: rejections.value });
}

/** Public compile options for selecting runtime target and explicit Promise embedding policy. */
export interface CompileRuntimeOptions {
  /** Compilation target: "gc" (WasmGC, default), "linear" (linear memory),
   *  "wasi" (WASI-compatible GC), or "standalone" (pure WasmGC, no JS host
   *  and no WASI runtime — #1470). `target: "standalone"` implies
   *  `nativeStrings: true` and refuses to emit any `wasm:js-string` or
   *  `env` JS-host string imports. */
  target?: "gc" | "linear" | "wasi" | "standalone";
  /** Explicit standalone Promise embedding policy. Omission leaves runtime configuration unresolved. */
  nativePromise?: NativePromiseConfiguration;
}
