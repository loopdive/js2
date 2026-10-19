// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Live eager-generator gap adapter for #1691 / #6979.
 *
 * Only yield-star resumption still reaches the host. GetIterator, IteratorNext
 * and array materialization providers are retired; native semantics own them.
 */

export interface StrictIteratorCallbackState {
  getExports: () => Record<string, Function> | undefined;
  getStartExports?: () => Record<string, Function> | undefined;
}

export interface StrictIteratorHostOperations {
  isWasmStruct: (value: any) => boolean;
  safeGet: (value: any, key: any, state?: StrictIteratorCallbackState) => any;
  nativePrimitiveToHost: (value: any, exports: Record<string, Function> | undefined) => any;
  missingValue: unknown;
  maybeWrapCallable: (value: any, arity: number, state?: StrictIteratorCallbackState) => any;
  marshalExports: (
    state?: StrictIteratorCallbackState,
    exports?: Record<string, Function>,
  ) => Record<string, Function> | undefined;
}

export interface StrictIteratorHostRuntime {
  /** (#1691) The `__gen_yield_star_step` import; TypeErrors use the module realm's ctor. */
  yieldStarStepImport(
    state: StrictIteratorCallbackState | undefined,
    TypeErrorCtor: new (message: string) => Error,
  ): (iterator: any, mode: number, received: any) => [number, any];
}

export function createStrictIteratorHostRuntime(ops: StrictIteratorHostOperations): StrictIteratorHostRuntime {
  const { isWasmStruct, safeGet, nativePrimitiveToHost, missingValue, maybeWrapCallable, marshalExports } = ops;

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

  return { yieldStarStepImport };
}
