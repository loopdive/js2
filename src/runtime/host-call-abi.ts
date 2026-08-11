// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Fixed-arity imports for erased Wasm-to-host function calls. */
import { reconcileVecMirrors, snapshotVecMirrors } from "./vec-mirror-writeback.js";

type CallbackState = { getExports: () => Record<string, Function> | undefined } | undefined;
type HostCallAdapters = {
  isWasmStruct: (value: any) => boolean;
  maybeWrapCallable: (value: any, callbackState: CallbackState) => any;
  wrapForHost: (value: any, exports: Record<string, Function> | undefined) => any;
  unwrapForHost: (value: any) => any;
};
type InvokeHostFunction = (fn: any, thisArg: any, args: any[]) => any;

export function isHostCallImportName(name: string): boolean {
  return name === "__call_function" || /^__call_function_[0-4]$/.test(name);
}

export function createHostCallImport(name: string, callbackState: CallbackState, adapters: HostCallAdapters): Function {
  const invoke: InvokeHostFunction = (fn, thisArg, args) => {
    if (typeof fn !== "function" && adapters.isWasmStruct(fn)) {
      const wrapped = adapters.maybeWrapCallable(fn, callbackState);
      if (typeof wrapped === "function") fn = wrapped;
    }
    if (typeof fn !== "function") throw new TypeError(String(fn) + " is not a function");

    const exports = callbackState?.getExports();
    const wrapHostValue = (value: any): any => {
      if (!adapters.isWasmStruct(value)) return value;
      const callable = adapters.maybeWrapCallable(value, callbackState);
      return callable !== value ? callable : adapters.wrapForHost(value, exports);
    };
    const wrappedThis = wrapHostValue(thisArg);
    // Preserve the caller's array and clone only when a WasmGC value changes.
    let wrappedArgs = args;
    for (let i = 0; i < args.length; i++) {
      const wrapped = wrapHostValue(args[i]);
      if (wrapped === args[i]) continue;
      if (wrappedArgs === args) wrappedArgs = args.slice();
      wrappedArgs[i] = wrapped;
    }
    const mirrorSnaps = snapshotVecMirrors(wrappedThis, wrappedArgs, exports);
    const result = Reflect.apply(fn, wrappedThis, wrappedArgs);
    reconcileVecMirrors(mirrorSnaps, exports, adapters.unwrapForHost);
    return adapters.unwrapForHost(result);
  };

  switch (name) {
    case "__call_function_0":
      return (fn: any, thisArg: any): any => invoke(fn, thisArg, []);
    case "__call_function_1":
      return (fn: any, thisArg: any, a: any): any => invoke(fn, thisArg, [a]);
    case "__call_function_2":
      return (fn: any, thisArg: any, a: any, b: any): any => invoke(fn, thisArg, [a, b]);
    case "__call_function_3":
      return (fn: any, thisArg: any, a: any, b: any, c: any): any => invoke(fn, thisArg, [a, b, c]);
    case "__call_function_4":
      return (fn: any, thisArg: any, a: any, b: any, c: any, d: any): any => invoke(fn, thisArg, [a, b, c, d]);
    default:
      return (fn: any, thisArg: any, argsArray: any): any =>
        invoke(fn, thisArg, Array.isArray(argsArray) ? argsArray : []);
  }
}
