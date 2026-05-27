---
id: 1610
title: "codegen: for-of over non-array iterables rejected ('for-of requires an array expression')"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
task_type: feature
area: codegen
language_feature: for-of, iterator-protocol
goal: compiler-correctness
sprint: Backlog
es_edition: es2015
test262_count: 13
---
# #1610 — for-of over a non-array iterable is rejected at compile time

## Problem

13 test262 tests fail with:

```
for-of requires an array expression
```

The compiler only lowers `for (x of <array>)` when the iterand is statically an
array; a general iterable (object with `[Symbol.iterator]`, a generator result,
a Set/Map, a promise-producing async iterator) is rejected at compile time.

## Failing test examples

- `test/built-ins/Temporal/Duration/prototype/round/relativeto-largestunit-smallestunit-combinations.js`
- `test/built-ins/WeakRef/returns-new-object-from-constructor-with-object-target.js`
- `test/language/expressions/class/async-gen-method-static/yield-promise-reject-next-for-await-of-sync-iterator.js`

## Root-cause hypothesis

The for-of statement codegen in `src/codegen/statements.ts` has a fast path
that requires an array-typed iterand and throws otherwise instead of falling
back to the iterator protocol (`[Symbol.iterator]()` → `.next()` loop). Add the
general iterator-protocol lowering as the fallback when the iterand is not a
statically-known array. This unblocks Set/Map/generator/custom-iterable
for-of across the corpus.

## Acceptance criteria

- for-of over a non-array iterable compiles and iterates via the iterator
  protocol.
- >=10 of the 13 tests move off `compile_error`.

## Root cause (confirmed)

`compileForOfStatement` (`src/codegen/statements/loops.ts`) branched on the TS
type symbol name being `Array` and committed unconditionally to
`compileForOfArray`, which throws "for-of requires an array expression" when the
iterand does not lower to a vec struct. An Array-typed iterand is necessary but
not sufficient: a `Symbol.iterator` whose declared return widens to `Array`, an
array-subclass instance, or a union can carry the `Array` symbol yet not lower
to a vec struct, so the loop hard-errored instead of using the (already-present)
iterator-protocol fallback `compileForOfIterator`.

## Fix

Route both branches through the existing `compileForOfArrayTentative` gate: it
tentatively compiles the expression and only takes the fast vec-struct array
path when the result is genuinely a vec struct; otherwise it falls through to
`compileForOfIterator`. The `isArray` symbol-name shortcut is removed. The array
path is unchanged for real arrays (it already re-compiled the expression).

## Test Results

`tests/equivalence/issue-1610.test.ts` (4 tests) + existing for-of/iterator
equivalence suites — all green:
- array fast path (vec struct) — PASS
- for-of over Set — PASS
- for-of over custom `[Symbol.iterator]` object — PASS
- for-of over generator result — PASS
- for-of-basic, for-of-generator, for-of-array-destructuring,
  iterator-protocol-custom, symbol-iterator-class,
  for-of-assign-destructuring-primitive — all PASS (37 tests total)

Out of scope: `for (const [k,v] of map)` returns only the last entry — a
pre-existing Map `@@iterator` semantics gap tracked under #1103, not regressed
by this change (the loop now runs without a compile error).
