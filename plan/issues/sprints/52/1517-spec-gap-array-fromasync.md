---
id: 1517
sprint: 52
title: "spec gap: Array.fromAsync — ES2024 async-iteration constructor"
status: in-review
created: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: array-builtin, async-iteration
goal: spec-completeness
related: [1373b, 1510]
---
# #1517 — Array.fromAsync

## Problem

`built-ins/Array/fromAsync/` contributes **58 failing test262 cases**
with errors like

```
returned 2 — assert #1 at L42: assert.compareArray(result, [1, 2]);
asyncitems-iterator-null.js …
```

`Array.fromAsync` (ES2024, spec §23.1.2.2) is the async sibling of
`Array.from`:

```ts
Array.fromAsync = async function (items, mapFn, thisArg) {
  const A = new this(0);
  let k = 0;
  if (items != null && items[Symbol.asyncIterator]) {
    for await (const v of items)
      A[k++] = mapFn ? await mapFn.call(thisArg, v, k - 1) : v;
  } else if (items != null && items[Symbol.iterator]) {
    for (const v of items) {
      const w = await v;
      A[k++] = mapFn ? await mapFn.call(thisArg, w, k - 1) : w;
    }
  } else {
    // ToObject + array-like length walk, awaiting each element
    const o = Object(items);
    const len = ToLength(o.length);
    for (; k < len; k++) {
      const w = await o[k];
      A[k] = mapFn ? await mapFn.call(thisArg, w, k) : w;
    }
  }
  A.length = k;
  return A;
};
```

The compiler does not recognize `Array.fromAsync` at all — invocation
falls through to a generic property access on `Array`, which returns
`undefined` and crashes on `undefined(...)`.

## Failure count

**58 fails**. Realistic target: **≥ 50 flips** (the remaining ~8 use
custom subclass `new this(0)` paths that depend on #1455).

## Root cause + files to touch

- `src/codegen/array-methods.ts` — add `from_async` to the static
  Array dispatch table next to existing `Array.from` handling.
- `src/runtime.ts` — implement an async helper that walks the three
  cases above. Re-use the existing for-await-of plumbing (#1373b).
- `src/codegen/expressions/calls.ts` — surface `Array.fromAsync` as
  an async call site (return a Promise externref).

## Acceptance criteria

1. ≥ 50 of 58 in `built-ins/Array/fromAsync/` flip to `pass`.
2. `Array.fromAsync(asyncIterable)` resolves to an Array with the
   awaited values.
3. `Array.fromAsync(iterable, mapFn)` awaits both the iterator step
   and the `mapFn` result.
4. `Array.fromAsync({length: 3, 0: Promise.resolve(1), …})` ToObject
   + array-like branch works.
5. No regression in `built-ins/Array/from/`.

## Reference tests

- `built-ins/Array/fromAsync/asyncitems-array-remove.js`
- `built-ins/Array/fromAsync/asyncitems-iterator-null.js`
- `built-ins/Array/fromAsync/mapfn-awaits-result.js` (if present)
