---
id: 1454
title: "spec gap: iterator protocol — error propagation and IteratorClose during destructuring"
status: done
completed: 2026-06-12
created: 2026-05-20
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: iterators, destructuring
goal: spec-completeness
sprint: 52
related: [1396, 1397, 1432]
---
# #1454 — Iterator protocol during destructuring: GetIterator, IteratorStep, IteratorClose

## Problem

ECMA-262 §13.3.3.5–§13.3.3.7 specify that array destructuring of an
iterable goes through the **IteratorRecord protocol**:

1. `GetIterator(value)` — if the `@@iterator` getter throws, the
   exception propagates.
2. `IteratorStep(record)` — if `.next()` throws or returns a
   non-object, the exception propagates.
3. **`IteratorClose(record, completion)`** — if a binding initializer
   throws *and* the iterator is not yet exhausted, the spec requires
   calling `iterator.return()` to release resources.

These three failure modes are covered by test262 patterns
`iter-get-err`, `iter-step-err`, `iter-thrw-close`, and
`iter-rtrn-close`. We currently fail ~160 such tests:

- `iter-get-err`: 77
- `iter-step-err`: 57
- `iter-thrw-close`: 14
- `iter-rtrn-close`: 12

Typical symptoms:

- `assertion_fail` on `assert.throws(Test262Error, ...)` — the test
  expects an error from the iterator hook to propagate but we
  swallow it.
- `illegal_cast` — the externref destructure path receives an
  unexpected shape and the cast fails before the spec'd error point.
- `TypeError: Cannot access property on null or undefined` —
  destructuring tries to read `.next` on something the spec says
  shouldn't be reached.

## Failure count

**~160 fails** across §13–§15, spread across function parameter
destructuring, for-of destructuring, catch destructuring, class
method param destructuring, and object literal method param
destructuring.

## Root cause

The externref array-destructuring fast path
(`src/codegen/destructuring-params.ts` and the for-of array path in
`src/codegen/statements/loops.ts:compileForOfArray`) bypasses the
formal iterator record protocol. It treats the source as a known
JS array and uses bounds-checked index access plus
`__extern_get_idx`/`__get_undefined`, skipping:

- The **@@iterator getter call** (so `iter-get-err` is never
  triggered).
- The **`.next()` call** (so `iter-step-err` is never triggered).
- The **IteratorClose call** on abnormal completion (so
  `iter-thrw-close` and `iter-rtrn-close` never `return()`).

The slow path (`__array_from_iter` materialise-then-index) does call
`.next()` but then materializes the full sequence eagerly, which
prevents `iter-thrw-close` semantics (close on partial consumption)
and breaks tests that expect lazy iteration.

## Implementation strategy

This is essentially the same shape as #1396/#1397 (for-of dstr) but
extended to all sites that consume an iterable into a binding
pattern.

1. Introduce a runtime helper `__iter_record_create(value)` that
   returns an opaque iterator record (or throws on missing
   `@@iterator` / non-callable).
2. Use it from every destructure entry point that observes an
   external iterable. Each binding-element access calls
   `__iter_record_next(record)` (which throws on bad result).
3. On any abnormal completion *during* the destructure (default
   initializer throws, nested pattern throws), call
   `__iter_record_close(record, completion)` before rethrowing —
   per spec §7.4.6 IteratorClose.
4. Provide a **fast-path bypass** when:
   - The source is statically known to be a JS Array literal
     created in the same scope (no observable @@iterator side-
     effects), and
   - No binding-element initializer is observable (or the
     initializer is a pure constant).
   This keeps benchmarks fast.

Because the externref dstr path is used by parameter destructuring,
for-of destructuring, and assignment destructuring, a small
refactor to share an "iterate-into-bindings" emitter (with the
iterator record threaded through) will simplify the implementation.

## Acceptance criteria

1. `test/language/statements/function/dstr/ary-init-iter-get-err-array-prototype.js`
   passes (throwing `@@iterator` getter → exception propagates).
2. `test/language/statements/function/dstr/dflt-ary-ptrn-rest-id-iter-step-err.js`
   passes (`.next()` throws → exception propagates).
3. `test/language/statements/for-of/dstr/array-rest-iter-thrw-close.js`
   passes (`.return()` is called when destructure inner-initializer
   throws).
4. `test/language/statements/for-of/dstr/array-elem-trlg-iter-rest-rtrn-close.js`
   passes.
5. The combined `iter-get-err`/`iter-step-err`/`iter-thrw-close`/
   `iter-rtrn-close` failures across §13–§15 reduce by **≥ 120**.
6. No perf regression > 5% on the playground array-iteration
   benchmark (the static-array fast path stays).

## Files to inspect

- `src/codegen/destructuring-params.ts` — `destructureParamArray`
  (externref branch), `__array_from_iter`, `__extern_get_idx`.
- `src/codegen/statements/loops.ts` — `compileForOfArray`,
  `compileForOfIterator`, `compileForOfDestructuring`.
- `src/codegen/statements/destructuring.ts` —
  `compileArrayDestructuring` and helpers.
- `src/runtime.ts` — register `__iter_record_create`,
  `__iter_record_next`, `__iter_record_close` (or extend existing
  iterator imports).
- `tests/issue-1454.test.ts` — explicit close-on-throw tests.

## Out of scope

- Object-destructuring `OwnPropertyKeys` ordering (separate spec
  area).
- `for-await-of` IteratorClose with async iterators — covered by
  #1373.
