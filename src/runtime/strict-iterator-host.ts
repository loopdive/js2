// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Strict host iterator provider for #5131.
 *
 * This stays separate from runtime.ts's permissive compatibility iterator
 * bridge. The operations are injected so the strict provider can remain a
 * focused subsystem without changing runtime ownership or import ABI.
 */

export interface StrictIteratorCallbackState {
  getExports: () => Record<string, Function> | undefined;
  getStartExports?: () => Record<string, Function> | undefined;
}

export interface StrictIteratorHostOperations {
  isWasmStruct: (value: any) => boolean;
  safeGet: (value: any, key: any, state?: StrictIteratorCallbackState) => any;
  wrapForHost: (value: any, exports: Record<string, Function> | undefined) => any;
  nativePrimitiveToHost: (value: any, exports: Record<string, Function> | undefined) => any;
  missingValue: unknown;
  maybeWrapCallable: (value: any, arity: number, state?: StrictIteratorCallbackState) => any;
  marshalExports: (
    state?: StrictIteratorCallbackState,
    exports?: Record<string, Function>,
  ) => Record<string, Function> | undefined;
}

export interface StrictIteratorHostRuntime {
  getIterator(value: any, state?: StrictIteratorCallbackState): any;
  iteratorNext(iterator: any, state?: StrictIteratorCallbackState): [number, any];
  /** (#1691) The `__gen_yield_star_step` import; TypeErrors use the module realm's ctor. */
  yieldStarStepImport(
    state: StrictIteratorCallbackState | undefined,
    TypeErrorCtor: new (message: string) => Error,
  ): (iterator: any, mode: number, received: any) => [number, any];
}

export function createStrictIteratorHostRuntime(ops: StrictIteratorHostOperations): StrictIteratorHostRuntime {
  const { isWasmStruct, safeGet, wrapForHost, nativePrimitiveToHost, missingValue, maybeWrapCallable, marshalExports } =
    ops;

  function isCallable(value: any, exports: Record<string, Function> | undefined): boolean {
    if (typeof value === "function") return true;
    if (value == null || typeof value !== "object" || !isWasmStruct(value)) return false;
    const isClosure = exports?.__is_closure as ((candidate: any) => number) | undefined;
    try {
      return typeof isClosure === "function" && isClosure(value) === 1;
    } catch {
      return false;
    }
  }

  function isObjectValue(value: any, exports: Record<string, Function> | undefined): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === "function") return true;
    if (typeof value !== "object") return false;
    return !isWasmStruct(value) || nativePrimitiveToHost(value, exports) === missingValue;
  }

  function invokeCallable(
    receiver: any,
    callable: any,
    args: readonly any[],
    state?: StrictIteratorCallbackState,
  ): any {
    if (typeof callable === "function") return callable.apply(receiver, args);
    const exports = state?.getExports();
    if (!isCallable(callable, exports)) throw new TypeError("value is not callable");
    const arity = args.length;
    const methodCall = exports?.[`__call_fn_method_${arity}`];
    if (typeof methodCall === "function") return methodCall(receiver, callable, ...args);
    const plainCall = exports?.[`__call_fn_${arity}`];
    if (typeof plainCall === "function") return plainCall(callable, ...args);
    const wrapped = maybeWrapCallable(callable, arity, state);
    if (typeof wrapped === "function") return wrapped.apply(receiver, args);
    throw new TypeError("value is not callable");
  }

  function getIterator(value: any, state?: StrictIteratorCallbackState): any {
    if (value === null || value === undefined) throw new TypeError(`${value} is not iterable`);
    const exports = state?.getExports();
    const marshalView = marshalExports(state, exports);
    let method = safeGet(value, Symbol.iterator, state);
    if (method === undefined) method = safeGet(value, "@@iterator", state);
    if (method === undefined && isWasmStruct(value)) {
      const hostView = wrapForHost(value, marshalView);
      method = safeGet(hostView, Symbol.iterator, state) ?? safeGet(hostView, "@@iterator", state);
    }
    const strictDispatch = exports?.["__call_@@iterator_strict"];
    if (isWasmStruct(value) && typeof strictDispatch === "function" && !isCallable(method, exports)) {
      const iterator = strictDispatch(value);
      if (!isObjectValue(iterator, marshalView)) throw new TypeError("iterator is not an object");
      return iterator;
    }
    if (method === undefined || method === null) {
      if (isWasmStruct(value) && typeof strictDispatch === "function") {
        const iterator = strictDispatch(value);
        if (!isObjectValue(iterator, marshalView)) throw new TypeError("iterator is not an object");
        return iterator;
      }
      const dispatch = exports?.["__call_@@iterator"];
      if (isWasmStruct(value) && typeof dispatch === "function") {
        const iterator = dispatch(value);
        if (!isObjectValue(iterator, marshalView)) throw new TypeError("iterator is not an object");
        return iterator;
      }
      throw new TypeError("value is not iterable");
    }
    if (!isCallable(method, exports)) throw new TypeError("@@iterator is not callable");
    const iterator = invokeCallable(value, method, [], state);
    if (!isObjectValue(iterator, marshalView)) throw new TypeError("iterator is not an object");
    return iterator;
  }

  function iteratorNext(iterator: any, state?: StrictIteratorCallbackState): [number, any] {
    const exports = state?.getExports();
    const marshalView = marshalExports(state, exports);
    const next = safeGet(iterator, "next", state);
    const strictDispatch = exports?.["__call_next_strict"];
    let result: any;
    if (isWasmStruct(iterator) && typeof strictDispatch === "function" && !isCallable(next, exports)) {
      result = strictDispatch(iterator);
    } else if (next !== undefined && next !== null) {
      if (!isCallable(next, exports)) throw new TypeError("iterator.next is not a function");
      result = invokeCallable(iterator, next, [], state);
    } else if (isWasmStruct(iterator) && typeof strictDispatch === "function") {
      result = strictDispatch(iterator);
    } else {
      const dispatch = exports?.["__call_next"];
      if (!isWasmStruct(iterator) || typeof dispatch !== "function")
        throw new TypeError("iterator.next is not a function");
      result = dispatch(iterator);
    }
    if (!isObjectValue(result, marshalView)) throw new TypeError("iterator result is not an object");
    const doneValue = safeGet(result, "done", state);
    const donePrimitive = nativePrimitiveToHost(doneValue, marshalView);
    const done = donePrimitive === missingValue ? !!doneValue : !!donePrimitive;
    return [done ? 1 : 0, done ? undefined : safeGet(result, "value", state)];
  }

  /**
   * (#1691) One `yield*` resumption (§14.4.14 step 7) against a host iterator.
   * `mode` 0 = next(received), 1 = return(received), 2 = throw(received).
   * Status 0 = the delegate yielded `value`; 1 = it completed normally with
   * `value` (the `yield*` result); 2 = the outer must return `value`.
   * IteratorValue is read eagerly even when not done — the native result
   * struct cannot re-yield the delegate's result object itself.
   */
  function yieldStarStep(
    iterator: any,
    mode: number,
    received: any,
    state: StrictIteratorCallbackState | undefined,
    TypeErrorCtor: new (message: string) => Error,
  ): [number, any] {
    const typeError = (message: string): Error => new TypeErrorCtor(message);
    const exports = state?.getExports();
    const marshalView = marshalExports(state, exports);
    // Closed object-literal carriers expose their fields only through the
    // `__sget_<key>` exports (gated on the struct's own field shape);
    // accessors and sidecar properties go through `safeGet` first.
    const hasField = (receiver: any, key: string): boolean => {
      const names = exports?.__struct_field_names?.(receiver);
      if (typeof names !== "string" || !names.split(",").includes(key)) return false;
      const presence = exports?.[`__shas_${key}`];
      return typeof presence !== "function" || presence(receiver) !== 0;
    };
    const read = (receiver: any, key: string): any => {
      const value = safeGet(receiver, key, state);
      if (value !== undefined || !isWasmStruct(receiver) || !hasField(receiver, key)) return value;
      const getter = exports?.[`__sget_${key}`];
      return typeof getter === "function" ? getter(receiver) : undefined;
    };
    const method = (key: string): any => {
      const value = read(iterator, key);
      if (value === undefined || value === null) return undefined;
      if (!isCallable(value, exports)) throw typeError(`iterator.${key} is not a function`);
      return value;
    };
    const settle = (result: any, doneStatus: number): [number, any] => {
      if (!isObjectValue(result, marshalView)) throw typeError("iterator result is not an object");
      const doneValue = read(result, "done");
      const donePrimitive = nativePrimitiveToHost(doneValue, marshalView);
      const done = donePrimitive === missingValue ? !!doneValue : !!donePrimitive;
      return [done ? doneStatus : 0, read(result, "value")];
    };
    if (mode === 0) {
      const next = method("next");
      if (next === undefined) throw typeError("iterator.next is not a function");
      return settle(invokeCallable(iterator, next, [received], state), 1);
    }
    if (mode === 2) {
      const throwMethod = method("throw");
      if (throwMethod !== undefined) return settle(invokeCallable(iterator, throwMethod, [received], state), 1);
      // Protocol violation: IteratorClose with a normal completion, then TypeError.
      const returnMethod = method("return");
      if (returnMethod !== undefined && !isObjectValue(invokeCallable(iterator, returnMethod, [], state), marshalView))
        throw typeError("iterator result is not an object");
      throw typeError("The iterator does not provide a 'throw' method");
    }
    const returnMethod = method("return");
    if (returnMethod === undefined) return [2, received];
    return settle(invokeCallable(iterator, returnMethod, [received], state), 2);
  }

  const yieldStarStepImport: StrictIteratorHostRuntime["yieldStarStepImport"] =
    (state, TypeErrorCtor) => (iterator, mode, received) =>
      yieldStarStep(iterator, mode, received, state, TypeErrorCtor);

  return { getIterator, iteratorNext, yieldStarStepImport };
}
