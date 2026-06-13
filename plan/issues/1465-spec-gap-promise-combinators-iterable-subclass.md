---
id: 1465
title: "spec gap: Promise.all / allSettled / any / race iterable + subclass fidelity"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: promise-combinators
goal: spec-completeness
sprint: 52
related: [1326, 1368]
---
# #1465 - spec gap: Promise.all / allSettled / any / race iterable + subclass fidelity

## Problem

`built-ins/Promise/` accounts for **662 test262 failures** across:

```
124 prototype       104 allSettled    98 all
95  fromAsync (Array.fromAsync is here for some platforms)
94  any             94  race          30  resolve   15  reject
```

The 390 failures in the four combinators (`all`/`allSettled`/`any`/
`race`) cluster around three spec gaps:

### 1. Iterable input semantics

Tests like `Promise/all/iter-arg-is-string-resolve.js`,
`allSettled/iter-assigned-number-reject.js`,
`race/iter-returns-false-reject.js` cover the spec algorithm
`PerformPromiseAll` step 4: `GetIterator(iterable)`. Iterables include:

- a string (its iterator yields code points);
- an arguments object;
- a custom object with `Symbol.iterator` set to `1` / `false` / `null`
  → must call `IfAbruptRejectPromise` → return rejected promise.

Our runtime uses `_toIterable(arr)` (see `src/runtime.ts:3880`+), which
treats anything that is `Array.isArray` as fine but doesn't drive the
spec's full GetIterator → IteratorRecord → IteratorClose protocol.

### 2. Subclass constructor (`Promise.all.call(C, …)`)

Tests `ctx-ctor-throws.js`, `ctx-non-ctor.js`, `subclass-reject-count.js`
verify that:

- `Promise.all.call(C, iter)` throws TypeError if `C` is not a
  constructor;
- the helper invokes `Construct(C, [executor])` (NewPromiseCapability)
  exactly once;
- the result chains correctly when `C` is a subclass with a custom
  `then`.

The `Promise_all` host import receives `thisArg` (good), but
`_resolveCtor(thisArg)` falls back to the global `Promise` silently
when the arg is unusable instead of throwing.

### 3. Trap / hook observation order

`Promise/all/invoke-resolve-get-error.js` and analogous
`invoke-then-error-close.js` (in `allSettled`/`any`/`race`) verify the
spec calls `Get(C, "resolve")` once, calls `Get(resolved, "then")` for
each item, and **closes the underlying iterator** if any of these
throw. Our runtime path inherits the JS host's behaviour for the
trivial case but loses fidelity once `thisArg` is a custom constructor
because the host's `Promise.all.call(C, iter)` re-enters our async
scheduler with the wrong constructor binding.

### Promise.prototype.* (124)

`prototype/` failures include:
- `subclass-reject-count.js` — `[Symbol.species]` not consulted;
- `resolve-settled-fulfilled-poisoned-then.js` — poisoned `then` on a
  fulfilment value must be observed and rejection delivered;
- `S25.4.5.1_A2.1_T1.js` — `.then` argument coercion (non-callable →
  identity);
- `subclass-reject-count.js` — `this.constructor[Symbol.species]`.

## Failure count

662 in `built-ins/Promise/`. Realistic target: **~360** (some
`prototype/` tests depend on full subclassing + Symbol.species which
is a separate axis; carve those off as a follow-up).

## Root cause

In `src/runtime.ts` lines 3880–3905, the four combinator imports look
like:

```js
if (name === "Promise_all")
  return (thisArg, arr) => {
    const C = _resolveCtor(thisArg);
    return Promise.all.call(C, _toIterable(arr));
  };
```

1. **`_toIterable(arr)`** does not run the spec
   `GetIterator(iterable, sync)` — when arr is a primitive iterable
   (string, custom non-array iterable) the iterator may not be invoked,
   producing wrong resolutions.

2. **`_resolveCtor`** falls back to the global `Promise` when
   `thisArg` is non-callable instead of returning a rejected promise
   (Spec `PromiseAll` step 1: `Let C be this value. If Type(C) is not
   Object, throw a TypeError`).

3. **`Get(C, "resolve")` is hidden** behind the host's `Promise.all`
   call, so tests that monkey-patch `C.resolve` see *the host's
   Promise.resolve*, not the patched one.

4. **`[Symbol.species]`** is not honoured by `Promise.prototype.then`
   in our `Promise_then`/`Promise_then2` imports.

5. **`Promise.prototype.then` coercion of non-callable onFulfilled /
   onRejected** uses identity per spec — host engines do this, but our
   standalone Promise (#1326) does not.

## Acceptance criteria

1. `Promise.all/allSettled/any/race` accept any iterable (string,
   arguments, custom `Symbol.iterator`); non-iterable input rejects.
2. `Promise.all.call(C, iter)` with non-constructor `C` throws
   TypeError synchronously (or rejects per spec step).
3. `Promise.all.call(C, iter)` calls `Get(C, "resolve")` and invokes
   the returned resolve function for every item.
4. `Iterator close` invoked when any of the spec-mandated `Get`/`Call`
   hooks throws.
5. `Promise.prototype.then` consults `this.constructor[Symbol.species]`
   to create the resulting promise.
6. Standalone `Promise.then` (#1326) accepts non-callable on*
   arguments via the identity-substitute spec rule.
7. ≥330 of the 662 failures resolved.
8. Tests: `tests/issue-1465.test.ts` covers iterable input (string,
   non-array iterable), subclass constructor non-callable,
   poisoned-resolve, and non-callable then arg.

## Files to inspect

- `src/runtime.ts` lines 3880–3905 (combinator imports) and the
  `_toIterable` / `_resolveCtor` helpers earlier in the file
- `src/codegen/async-scheduler.ts` — standalone Promise.then path
- `src/codegen/expressions/calls.ts` 3331–3500 — call-site dispatch
- `tests/issue-1465.test.ts`

## Notes

- #1326 (standalone microtask queue) is the foundation; combinator
  fidelity in standalone mode is a stretch goal, focus on JS-host.
- #1368 added the `thisArg` plumbing — this issue tightens its
  semantics to match the spec exactly.
- `Promise/fromAsync` (95) tracks `Array.fromAsync` not `Promise.fromAsync`;
  if those tests are mis-pathed, leave them for a separate issue.
