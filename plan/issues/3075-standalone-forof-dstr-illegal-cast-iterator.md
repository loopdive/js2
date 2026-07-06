---
id: 3075
title: "standalone: for-of / for-await-of destructuring throws 'illegal cast [in __iterator]' (residual after #1323)"
status: ready
sprint: Backlog
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: iterator-protocol, for-of, for-await-of, destructuring
goal: standalone-mode
related: [1781, 1323, 1454, 1347, 1471]
created: 2026-07-06
updated: 2026-07-06
origin: "2026-07-06 /harvest-errors run against standalone current.jsonl (6.7.2026)."
---

# #3075 — standalone for-of/for-await destructuring: illegal cast in `__iterator`

## Summary

**468 standalone-lane records** (0 in the default lane) fail with:

```
illegal_cast:L#:## illegal cast [in __iterator() ← fn ← test]
```

Category breakdown:

- **421 `language/statements`** — overwhelmingly `for-of/dstr/*` and
  `for-await-of/*` destructuring patterns.
- 11 `built-ins/Iterator`, 10 `built-ins/Array`, 8 `built-ins/TypedArray`,
  4 `AsyncFromSyncIteratorPrototype`, misc.

This is a **standalone-specific** iterator-protocol residual: the native
`__iterator()` bridge performs a `ref.cast` that traps when the iterated value's
runtime shape doesn't match the expected iterator-result / element type — most
often in destructuring-binding for-of/for-await targets (array/object patterns,
elision, rest holes, `iter-done` paths).

## Why filed now

`#1323` (Iterator protocol bridging — `$IteratorResult` struct in pure Wasm) is
`status: done`, and `#1471` (host boxing/unboxing elimination) is done, yet
this illegal-cast cluster persists at 468 in standalone. The residual is not
tracked by an open issue. Related open/borderline issues #1454
(iterator-protocol destructuring close) and #1347 (iterator-close-on-throw)
touch adjacent surface but do not name this `illegal cast [in __iterator]`
signature.

## Sample files

```
language/statements/for-await-of/async-func-dstr-let-async-ary-ptrn-elem-ary-empty-iter.js
language/statements/for-of/iterator-next-error.js
language/statements/for-of/iterator-close-via-continue.js
language/statements/for-await-of/async-func-dstr-var-async-obj-ptrn-prop-obj.js
language/statements/for-await-of/async-gen-dstr-var-async-ary-ptrn-elem-id-iter-done.js
```

## Suggested investigation

1. Compile one repro (e.g. `for-of/iterator-next-error.js`) with
   `--target standalone --no-host-imports`, dump the WAT, and locate the
   `ref.cast` inside the emitted `__iterator` helper that traps.
2. Determine whether the cast assumes a concrete iterator-result struct shape
   where the value is `any`/externref-shaped (native-string or boxed element)
   — this mirrors the substrate value-read gaps
   (`project_standalone_any_string_value_read_substrate`).
3. Widen the cast to the correct supertype (or add a type-guarded slow path)
   for the destructuring-target element read.

## Acceptance

- `illegal cast [in __iterator]` standalone count drops materially (<100).
- No net regression in either lane.
