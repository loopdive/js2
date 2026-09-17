// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ASYNC_CALLBACK_EXCEPTION_POLICY } from "./contracts/async-provider-schema.js";
import { createNativeFunctionCallbackBridge } from "./native-function-source.js";
import { createPromiseThenImport } from "./promise-then-reactions.js";

export interface HostAsyncCallbackState {
  readonly getExports: () => Record<string, Function> | undefined;
  readonly getStartExports?: () => Record<string, Function> | undefined;
  readonly deferToExports?: (callback: () => void) => void;
}

export type HostAsyncPromiseBuiltinName =
  | "Promise_resolve"
  | "Promise_new_pending"
  | "Promise_settle_resolve"
  | "Promise_settle_reject"
  | "Promise_then"
  | "Promise_then2"
  | "Promise_then2_frame";

type PrimitiveWalker = (
  value: any,
  hint: "number" | "string" | "default",
  callbackState?: HostAsyncCallbackState,
) => any;

/** The facade supplies its existing coherent value operations, with the same shared state. */
export interface HostAsyncValueOperations {
  readonly wrapThenable: (value: any) => any;
  readonly wrapPromiseReaction: (callback: any) => any;
  readonly toPrimitive: PrimitiveWalker;
  readonly hostToPrimitive: PrimitiveWalker;
  readonly wrapVoidHostCallback: (
    value: any,
    callbackState?: HostAsyncCallbackState,
    preserveIdentity?: boolean,
  ) => any;
}

export interface HostAsyncImportAdapters {
  readonly caughtException: () => Function;
  readonly callbackMaker: (constructible?: boolean) => Function;
  readonly boxNumber: () => Function;
  readonly unboxNumber: () => Function;
  readonly undefinedValue: () => Function;
  readonly promiseBuiltin: (name: HostAsyncPromiseBuiltinName) => Function;
}

export function createCaughtExceptionImport(getCaughtException?: () => unknown): Function {
  return () => getCaughtException?.();
}

export function createHostUndefinedImport(): Function {
  return () => undefined;
}

export function createHostNumberBoxImport(): Function {
  return (v: number) => v;
}

export function createHostAsyncCallbackMaker(
  callbackState: HostAsyncCallbackState | undefined,
  _wrapVoidHostCallback: HostAsyncValueOperations["wrapVoidHostCallback"],
  getConstructible: () => boolean,
): Function {
  return (id: number, cap: any) => {
    if (id === -2) return _wrapVoidHostCallback(cap, callbackState, false);
    if (id === -1) return _wrapVoidHostCallback(cap, callbackState);
    const policy = ASYNC_CALLBACK_EXCEPTION_POLICY;
    const constructible = getConstructible();
    return createNativeFunctionCallbackBridge(id, cap, callbackState, policy, constructible);
  };
}

export function createHostNumberUnboxImport(
  callbackState: HostAsyncCallbackState | undefined,
  _toPrimitive: PrimitiveWalker,
  _hostToPrimitive: PrimitiveWalker,
): Function {
  return (v: any) => {
    // For objects, try our ToPrimitive first — Number() on WasmGC structs
    // returns NaN without throwing (#866), and proxied structs may have
    // WasmGC closures for Symbol.toPrimitive that V8 can't call (#1090).
    if (v != null && typeof v === "object") {
      const prim = _toPrimitive(v, "number", callbackState);
      if (prim !== undefined) {
        // #1434 — Number() throws TypeError on Symbol/BigInt primitives.
        // Per ECMA-262 §7.1.4 ToNumber, Symbol MUST throw TypeError; the
        // unbox/number intent is the centralized ToNumber funnel, so we
        // let the exception propagate to Wasm catch_all instead of
        // silently turning it into NaN.
        return Number(prim);
      }
      // _toPrimitive returned undefined — try the full host ToPrimitive (#1090)
      // which checks real JS properties, sidecar, and Wasm exports.
      // Let TypeError propagate so Wasm catch_all can intercept it.
      const prim2 = _hostToPrimitive(v, "number", callbackState);
      return Number(prim2);
    }
    // #1434 — Symbol/BigInt primitives: Number() throws TypeError per
    // §7.1.4. The previous try/catch swallowed this and returned NaN,
    // letting `Number(Symbol())`, `+Symbol()`, `-Symbol()`, `~Symbol()`,
    // `0 + Symbol()` etc. silently coerce. Let the exception propagate.
    return Number(v);
  };
}

/** Host-realm Promise allocation and the existing live `then`/capability dispatch. */
export function createHostPromiseBuiltinImport(
  name: HostAsyncPromiseBuiltinName,
  _wrapThenable: HostAsyncValueOperations["wrapThenable"],
  _wrapPromiseReaction: HostAsyncValueOperations["wrapPromiseReaction"],
): Function {
  if (name === "Promise_resolve") return (val: any) => Promise.resolve(_wrapThenable(val));
  if (name === "Promise_new_pending")
    return () => {
      let r: (v: any) => void = () => {};
      let j: (e: any) => void = () => {};
      const p: any = new Promise((res: any, rej: any) => {
        r = res;
        j = rej;
      });
      p.__r = r;
      p.__j = j;
      return p;
    };
  if (name === "Promise_settle_resolve")
    return (p: any, val: any) => {
      if (p && typeof p.__r === "function") p.__r(val);
    };
  if (name === "Promise_settle_reject")
    return (p: any, reason: any) => {
      if (p && typeof p.__j === "function") p.__j(reason);
    };
  if (name === "Promise_then" || name === "Promise_then2" || name === "Promise_then2_frame") {
    return createPromiseThenImport(name, _wrapPromiseReaction);
  }
  throw new TypeError(`unsupported host async Promise builtin: ${name}`);
}

export function createHostAsyncImportAdapters(
  callbackState: HostAsyncCallbackState | undefined,
  getCaughtException: (() => unknown) | undefined,
  values: HostAsyncValueOperations,
): HostAsyncImportAdapters {
  return {
    caughtException: () => createCaughtExceptionImport(getCaughtException),
    callbackMaker: (constructible = false) =>
      createHostAsyncCallbackMaker(callbackState, values.wrapVoidHostCallback, () => constructible),
    boxNumber: createHostNumberBoxImport,
    unboxNumber: () => createHostNumberUnboxImport(callbackState, values.toPrimitive, values.hostToPrimitive),
    undefinedValue: createHostUndefinedImport,
    promiseBuiltin: (name) => createHostPromiseBuiltinImport(name, values.wrapThenable, values.wrapPromiseReaction),
  };
}

/** A located replay capability refusal, never a substitute object coercion. */
export class HostAsyncReplayValueUnsupportedError extends Error {
  readonly code = "unsupported-host-async-replay-value";
  constructor(readonly operation: string) {
    super(`${operation}: this replay provider requires the full host value adapter for object values`);
    this.name = "HostAsyncReplayValueUnsupportedError";
  }
}

function admitScalar(operation: string, value: any): any {
  if (value !== null && typeof value === "object") throw new HostAsyncReplayValueUnsupportedError(operation);
  return value;
}

/**
 * Explicitly partial replay provider for scalar crossings and real JS callback bridges.
 * Captures may be opaque frame structs: only the canonical callback dispatcher uses them.
 * Object resolution inputs/results, raw object callbacks, object number coercion and the
 * legacy void-closure sentinels require the full facade adapter and are refused first.
 * In particular this does not claim support for awaiting externally supplied Promises.
 */
export function createScalarHostAsyncImportAdapters(
  callbackState?: HostAsyncCallbackState,
  getCaughtException?: () => unknown,
): HostAsyncImportAdapters {
  const adapters = createHostAsyncImportAdapters(callbackState, getCaughtException, {
    wrapThenable: (value) => admitScalar("async.promise.resolve", value),
    wrapPromiseReaction: (callback) => {
      const wrapped = admitScalar("async.promise.react.callback", callback);
      return typeof wrapped === "function"
        ? (...args: any[]) => admitScalar("async.promise.react.result", wrapped(...args))
        : wrapped;
    },
    toPrimitive: () => {
      throw new HostAsyncReplayValueUnsupportedError("number.unbox");
    },
    hostToPrimitive: () => {
      throw new HostAsyncReplayValueUnsupportedError("number.unbox");
    },
    wrapVoidHostCallback: () => {
      throw new HostAsyncReplayValueUnsupportedError("async.callback.wrap.legacy-void");
    },
  });
  return {
    ...adapters,
    promiseBuiltin: (name) => {
      const operation = adapters.promiseBuiltin(name);
      if (name !== "Promise_settle_resolve") return operation;
      return (promise: any, value: any) => operation(promise, admitScalar("async.promise.settle.fulfill", value));
    },
  };
}
