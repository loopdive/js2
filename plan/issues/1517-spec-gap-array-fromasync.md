---
id: 1517
title: "spec gap: Array.fromAsync — ES2024 async-iteration constructor"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: array-builtin, async-iteration
goal: spec-completeness
sprint: 52
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

## Suspended Work

- **PR**: https://github.com/loopdive/js2wasm/pull/381
- **Branch**: `issue-1517-array-fromasync`
- **Worktree**: `/workspace/.claude/worktrees/issue-1517-array-fromasync/`
- **HEAD SHA**: `1b4992a109a2f9aeb7efd6fba1d569dfedeb7ac8`
- **State**: PR pushed, waiting for CI (`/workspace/.claude/ci-status/pr-381.json` not yet present at suspend time).

### What was implemented
- `src/codegen/expressions/calls.ts`: new dispatch block before the existing `Array.from` handler that lowers `Array.fromAsync(items, mapFn?, thisArg?)` into a host call. Compiles all three args to `externref`, registers `__array_from_async` via `ensureLateImport`, flushes late-import shifts, then `call` it. Returns `externref` (the Promise).
- `src/runtime.ts`: new `__array_from_async` host import next to `__array_from`. Implements ES2024 §23.1.2.2:
  1. Async iterable branch (`Symbol.asyncIterator`) — manual `iter.next()` + `await` loop.
  2. Sync iterable / string branch — `for (const raw of src)` + `await raw` per element.
  3. Array-like fallback — `ToObject` + `ToLength(o.length)` + `await o[k]` per index.
  - Wraps Wasm closures via `_wrapWasmClosure(mapFn, 2, callbackState)` (arity 2 — `(value, index)`).
  - Materializes opaque Wasm vec sources via `_materializeIterable`.
- `tests/issue-1517.test.ts`: 7 unit tests (array, async generator, mapFn, awaited mapFn result, mapFn with index, empty source, promise-return).

### Local validation
- `npm test -- tests/issue-1517.test.ts` → 7/7 pass.
- `Array.from` regression checks via `tests/stdlib.test.ts` → unchanged from main (pre-existing `Array.at` / `String.at` failures are unrelated).

### Resume steps (for the next dev)
1. `cd /workspace/.claude/worktrees/issue-1517-array-fromasync && git fetch origin`
2. Check `/workspace/.claude/ci-status/pr-381.json` exists and `head_sha == 1b4992a1…`.
3. Run `/dev-self-merge 381`. If MERGE → `gh pr merge 381 --admin --merge`. If ESCALATE → message team-lead with criterion + values.
4. After merge: set `status: done` in this file, update `plan/log/dependency-graph.md`, `git worktree remove /workspace/.claude/worktrees/issue-1517-array-fromasync`, mark task #45 completed.

### Known limitations / non-goals (out of scope for #1517)
- The dispatch returns `externref`, but TypeScript types `Array.fromAsync` as `Promise<U[]>`. When the awaited result is bound to a Wasm-vec-typed local, `.length` reads field 0 of an opaque externref and returns 0. The unit tests work around this by returning the awaited externref directly to the host (where it is a real JS array). Test262 cases route comparisons through host-injected `assert_compareArray`, so they should work — CI will confirm.
- Subclass `new this(0)` paths (test262 cases that exercise `Array.fromAsync.call(Subclass, …)`) depend on #1455 and may not flip.
