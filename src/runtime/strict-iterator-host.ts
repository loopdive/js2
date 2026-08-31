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
}

export interface StrictIteratorHostOperations {
  nativeIsArray: (value: any) => boolean;
  isWasmStruct: (value: any) => boolean;
  isWasmVec: (value: any, exports: Record<string, Function> | undefined) => boolean;
  isEmptyTupleCarrier: (
    value: any,
    exports: Record<string, Function> | undefined,
    state?: StrictIteratorCallbackState,
  ) => boolean;
  safeGet: (value: any, key: any, state?: StrictIteratorCallbackState) => any;
  stepClosureIterator: (
    iterator: any,
    exports: Record<string, Function> | undefined,
    options: { limit: number; closeOnStop: boolean },
  ) => any[] | null;
  wrapForHost: (value: any, exports: Record<string, Function> | undefined) => any;
  nativePrimitiveToHost: (value: any, exports: Record<string, Function> | undefined) => any;
  missingValue: unknown;
  maybeWrapCallable: (value: any, arity: number, state?: StrictIteratorCallbackState) => any;
}

export interface StrictIteratorHostRuntime {
  getIterator(value: any, state?: StrictIteratorCallbackState): any;
  iteratorNext(iterator: any, state?: StrictIteratorCallbackState): [number, any];
  resolveArrayIterationImport(name: string, state?: StrictIteratorCallbackState): ((...args: any[]) => any) | undefined;
}

export function createStrictIteratorHostRuntime(ops: StrictIteratorHostOperations): StrictIteratorHostRuntime {
  const {
    nativeIsArray,
    isWasmStruct,
    isWasmVec,
    isEmptyTupleCarrier,
    safeGet,
    stepClosureIterator,
    wrapForHost,
    nativePrimitiveToHost,
    missingValue,
    maybeWrapCallable,
  } = ops;

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
    let method = safeGet(value, Symbol.iterator, state);
    if (method === undefined) method = safeGet(value, "@@iterator", state);
    if (method === undefined && isWasmStruct(value)) {
      const hostView = wrapForHost(value, exports);
      method = safeGet(hostView, Symbol.iterator, state) ?? safeGet(hostView, "@@iterator", state);
    }
    const strictDispatch = exports?.["__call_@@iterator_strict"];
    if (isWasmStruct(value) && typeof strictDispatch === "function" && !isCallable(method, exports)) {
      const iterator = strictDispatch(value);
      if (!isObjectValue(iterator, exports)) throw new TypeError("iterator is not an object");
      return iterator;
    }
    if (method === undefined || method === null) {
      if (isWasmStruct(value) && typeof strictDispatch === "function") {
        const iterator = strictDispatch(value);
        if (!isObjectValue(iterator, exports)) throw new TypeError("iterator is not an object");
        return iterator;
      }
      const dispatch = exports?.["__call_@@iterator"];
      if (isWasmStruct(value) && typeof dispatch === "function") {
        const iterator = dispatch(value);
        if (!isObjectValue(iterator, exports)) throw new TypeError("iterator is not an object");
        return iterator;
      }
      throw new TypeError("value is not iterable");
    }
    if (!isCallable(method, exports)) throw new TypeError("@@iterator is not callable");
    const iterator = invokeCallable(value, method, [], state);
    if (!isObjectValue(iterator, exports)) throw new TypeError("iterator is not an object");
    return iterator;
  }

  function iteratorNext(iterator: any, state?: StrictIteratorCallbackState): [number, any] {
    const exports = state?.getExports();
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
    if (!isObjectValue(result, exports)) throw new TypeError("iterator result is not an object");
    const doneValue = safeGet(result, "done", state);
    const donePrimitive = nativePrimitiveToHost(doneValue, exports);
    const done = donePrimitive === missingValue ? !!doneValue : !!donePrimitive;
    return [done ? 1 : 0, done ? undefined : safeGet(result, "value", state)];
  }

  function drainStrictIterator(iterator: any, limit: number, state?: StrictIteratorCallbackState): any[] {
    const out: any[] = [];
    while (out.length < limit) {
      const [done, value] = iteratorNext(iterator, state);
      if (done) break;
      out.push(value);
    }
    return out;
  }

  function resolveArrayIterationImport(
    name: string,
    state?: StrictIteratorCallbackState,
  ): ((...args: any[]) => any) | undefined {
    if (
      name !== "__array_from_iter" &&
      name !== "__array_from_iter_n" &&
      name !== "__array_from_iter_strict" &&
      name !== "__array_from_iter_n_strict"
    ) {
      return undefined;
    }
    const originalArrayIterator: any = (Array.prototype as any)[Symbol.iterator];
    const walkWasmIterator = (iterator: any, limit: number): any[] =>
      stepClosureIterator(iterator, state?.getExports(), { limit, closeOnStop: true }) as any[];
    const drainIterable = (obj: any, limit: number, strict = false, knownIterator?: any): any[] => {
      const iteratorMethod = knownIterator ?? safeGet(obj, Symbol.iterator, state) ?? safeGet(obj, "@@iterator", state);
      if (typeof iteratorMethod !== "function") {
        if (strict) throw new TypeError("@@iterator is not callable");
        return Array.from(obj);
      }
      const iterator = iteratorMethod.call(obj);
      if (iterator != null && typeof iterator === "object" && typeof (iterator as any).next !== "function") {
        return walkWasmIterator(iterator, limit);
      }
      const out: any[] = [];
      while (out.length < limit) {
        const step = iterator.next();
        if (step == null || step.done) break;
        out.push(step.value);
      }
      return out;
    };
    const arrayFromIter = (obj: any, limit: number, strict = false): any => {
      if (obj == null) {
        if (strict) throw new TypeError(`${obj} is not iterable`);
        return [];
      }
      if (typeof obj === "object" && isWasmStruct(obj)) {
        const exports = state?.getExports();
        const vecLen = exports?.__vec_len;
        const vecGet = exports?.__vec_get;
        if (typeof vecLen === "function" && typeof vecGet === "function" && isWasmVec(obj, exports)) {
          try {
            const length = vecLen(obj) as number;
            if (typeof length === "number" && length >= 0) {
              const out: any[] = [];
              const count = limit < length ? limit : length;
              for (let index = 0; index < count; index++) out.push(vecGet(obj, index));
              return out;
            }
          } catch {
            // A genuine element-read trap preserves the legacy fallback.
          }
        }
        if (strict && isEmptyTupleCarrier(obj, exports, state)) {
          if ((Array.prototype as any)[Symbol.iterator] === originalArrayIterator) return [];
          return arrayFromIter([], limit, true);
        }
      }
      if (nativeIsArray(obj)) {
        const ownIterator = (obj as any)[Symbol.iterator];
        if (ownIterator !== originalArrayIterator) {
          if (strict) return drainStrictIterator(getIterator(obj, state), limit, state);
          return drainIterable(obj, limit, strict, ownIterator);
        }
        return limit < obj.length ? obj.slice(0, limit) : obj;
      }
      if (strict) return drainStrictIterator(getIterator(obj, state), limit, state);
      if (typeof obj === "object") {
        const iteratorMethod = safeGet(obj, Symbol.iterator, state) ?? safeGet(obj, "@@iterator", state);
        if (iteratorMethod !== undefined && typeof iteratorMethod !== "function") {
          if (isWasmStruct(iteratorMethod)) {
            const callFn0 = state?.getExports()?.["__call_fn_0"];
            if (typeof callFn0 === "function") {
              const iterator = callFn0(iteratorMethod);
              if (iterator != null && typeof iterator === "object") return walkWasmIterator(iterator, limit);
            }
          }
          const length = typeof (obj as any).length === "number" ? (obj as any).length >>> 0 : 0;
          const out: any[] = [];
          for (let index = 0; index < Math.min(length, limit); index++) out.push((obj as any)[index]);
          return out;
        }
        if (typeof iteratorMethod === "function") return drainIterable(obj, limit, false, iteratorMethod);
      }
      return drainIterable(obj, limit);
    };
    if (name === "__array_from_iter") return (obj: any): any => arrayFromIter(obj, Infinity);
    if (name === "__array_from_iter_strict") return (obj: any): any => arrayFromIter(obj, Infinity, true);
    if (name === "__array_from_iter_n_strict")
      return (obj: any, count: number): any => arrayFromIter(obj, count < 0 ? Infinity : count >>> 0, true);
    return (obj: any, count: number): any => arrayFromIter(obj, count < 0 ? Infinity : count >>> 0);
  }

  return { getIterator, iteratorNext, resolveArrayIterationImport };
}
