---
id: 7424
title: "Array destructuring of a class or object-literal iterator does not call return() on early exit"
status: done
sprint: current
created: 2026-11-19
updated: 2026-11-26
completed: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7413, 2033, 3100]
---

# #7424: destructuring a user iterator skips `return()`

## Problem

Found by RV7342's review of PR #7342 (#7413), measured on main `89e47482`; details in https://github.com/loopdive/js2/pull/7342#issuecomment-7019348242.

`const [a] = it` stops before the iterator is done, so §8.6.2
IteratorBindingInitialization is followed by IteratorClose, which calls
`return()`.

Re-measured on main `6694a8b8`, on gc, standalone and wasi:

```js
class It { constructor() { this.i = 0; this.r = 0; }
  [Symbol.iterator]() { return this; }
  next() { this.i++; return { value: this.i, done: this.i > 2 }; }
  return() { this.r++; return {}; } }
export function main() { const it = new It(); const [a] = it; return it.r * 100 + it.i * 10 + a * 1000; }
```

- **Node:** 1110. One `next()`, then `return()` once.
- **Ours:** 1030. Three `next()` calls (the iterator is drained to the end),
  no `return()`.
- **Object-literal iterators are affected too** (`const o = { next() {…},
  return() {…}, [Symbol.iterator]() { return o; } }`). The old text said they
  were correct; they take the same arm.
- `let`, `var`, elisions (`const [, x] = it`) and module-level declarations
  behave the same way.
- A typed parameter, `function f([a]: It)` in a `.ts` file, never iterated at
  all: it bound `0`.
- Assignment (`[a] = it`) and an untyped parameter (`function f([a])`) were
  already correct.

## Root cause

Two arms treated a user iterable struct (a struct whose
`${struct}_@@iterator` method is registered) differently from every other
iterable:

1. `src/codegen/statements/destructuring.ts`, `compileArrayDestructuring`:
   the #2033 arm drained the whole iterator into an f64 vec with
   `emitDrainCustomIterableToVec` (the spread drain), then destructured the
   vec. A full drain has no step bound and no IteratorClose, and the f64 vec
   also lost non-numeric values.
2. `src/codegen/destructuring-params.ts`, `destructureParamArray`: a
   non-vec, non-tuple struct only registered the binding locals, so a typed
   parameter never called `next()`.

The bounded drive that does both steps already exists: the externref lane
calls `__array_from_iter_n(src, elements.length)`, which steps the pattern's
count and calls `__iterator_return` when the iterator is not done (#3100 S5).
Assignment, untyped parameters and `externref` declarations all use it.

## Fix

Route the user iterable into that lane instead of keeping a parallel one:

- Remove the #2033 arm. The struct now reaches the existing unknown-struct
  arm, which converts it to externref and calls the externref lane.
- In `destructureParamArray`, an `isCustomIterable` struct is viewed as
  externref (`customIterableExternrefView`, `src/codegen/custom-iterable.ts`)
  and destructured by the same function's externref branch.
- `fillNativeIteratorLateArms` (`src/codegen/iterator-native.ts`): the
  `__array_from_iter_n` drain guard admitted closed iterable structs only when
  the USER arm exists, which needs some struct with a `next` method. With
  `{ [Symbol.iterator]() { return { next: () => … }; } }` no such method
  exists, so the guard passed the value through and every binding read
  `undefined` (the #2033 equivalence tests caught this). `__iterator` already
  drives that shape through its #3146 PARTIAL tail; the guard now admits the
  structs whenever either arm exists.

No new runtime helper or import. The spread drain stays for spread, where
draining to the end is correct. The stale #1719 S2 "placement note only"
comment at the top of `destructureParamArray` is dropped (the #1719 CPR-2
block below it does the wiring), which keeps the function and file at their
size budgets.

## Acceptance

- `tests/issue-7424-destructure-iterator-close.test.ts` pins node's answer on
  gc, standalone and wasi for: class and object-literal `const [a]`,
  `let [a, b]` (not done after `b`), `var [a, b, c]` (exhausted, no close),
  elisions, rest (no close), assignment, untyped and typed parameters,
  a module-level declaration, typed `.ts` declarations, and a closure-field
  iterator (`next` / `return` as arrow fields) in `.ts` and `.js`. Eleven of
  the 15 cases fail on `6694a8b8`.
- `tests/equivalence/issue-2033-custom-iterable-spread-destructure.test.ts`
  stays green.

## Not fixed here

- A class `return(x)` with a declared formal sees `arguments.length === 1`
  (node: 0). The `__call_return` dispatcher pads the formal (#7413). for-of
  `break` shows the same difference on main, so it is not part of this fix.
- `const [] = it` does not call `@@iterator` or `return()` (node: both,
  once). The externref lane skips empty patterns on purpose (#1016, #1158).
  Before this fix the class case drained the iterator instead, which was
  also wrong.
- `const [o, b = 5] = [{ x: 7 }, undefined]` binds `b` to null instead of 5,
  for a plain array as well as an iterator. That is a separate defect.
