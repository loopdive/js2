// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * (#1382) Per-method callback-slot table — maps a method name to the index
 * of its callback argument and the arity at which the engine will invoke
 * it. Consulted by `__proto_method_call` and `__extern_method_call` so a
 * Wasm-closure callback gets pre-wrapped into a JS Function before the
 * native engine tries to call it.
 *
 * Anything not in the table is passed through unchanged (preserving the
 * pre-#1382 behaviour for methods that don't take callbacks). Adding a new
 * method requires only adding a row here; no codegen changes needed.
 */
export const PROTO_CB_SLOTS: Record<string, { argIdx: number; arity: number }> = {
  // Array.prototype — callback at args[0], invoked as (value, index, array)
  forEach: { argIdx: 0, arity: 3 },
  map: { argIdx: 0, arity: 3 },
  filter: { argIdx: 0, arity: 3 },
  find: { argIdx: 0, arity: 3 },
  findIndex: { argIdx: 0, arity: 3 },
  findLast: { argIdx: 0, arity: 3 },
  findLastIndex: { argIdx: 0, arity: 3 },
  every: { argIdx: 0, arity: 3 },
  some: { argIdx: 0, arity: 3 },
  flatMap: { argIdx: 0, arity: 3 },
  // reduce/reduceRight — callback at args[0], invoked as (acc, value, index, array)
  reduce: { argIdx: 0, arity: 4 },
  reduceRight: { argIdx: 0, arity: 4 },
  // sort — comparator at args[0], invoked as (a, b)
  sort: { argIdx: 0, arity: 2 },
  // String.prototype.replace/replaceAll — replacement may be a fn; spec
  // arity is variadic. Use 4 as a sensible cap (match + 1 capture + offset
  // + string). Full variadic support is Phase 2.
  replace: { argIdx: 1, arity: 4 },
  replaceAll: { argIdx: 1, arity: 4 },
  // Map/WeakMap.prototype.getOrInsertComputed (TC39 Stage 3 upsert
  // proposal — see `__extern_method_call` polyfill) — callback at
  // args[1], invoked as `callback(key)`.
  getOrInsertComputed: { argIdx: 1, arity: 1 },
  // Promise.prototype — onFulfilled/onRejected/onFinally at args[0]
  // (then's second arg is also a callback but covered by 1-arg patterns;
  // dynamic-import `import(spec)['then'](x => x)` is the motivating case).
  then: { argIdx: 0, arity: 1 },
  catch: { argIdx: 0, arity: 1 },
  finally: { argIdx: 0, arity: 0 },
};

/** (#6900) The canonical dispatcher a vec receiver under a first-matched extern-class name falls back to. */
export const EXTERN_METHOD_CALL_INTENT = { type: "builtin", name: "__extern_method_call" } as const;
