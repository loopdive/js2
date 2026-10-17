---
id: 7035
title: "JS host: array destructuring over a custom iterable whose iterator is a compiled object literal throws 'iterator.next is not a function' (issue-3023/3040 red)"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: iterators
goal: core-semantics
parent: 7014
related: [3023, 3040, 7029]
---

# #7035 — strict iterator host must call a struct iterator's compiled `next`

## Evidence

`tests/issue-3023.test.ts` (4 red) and `tests/issue-3040.test.ts` (1 red; the
IteratorClose count is 1 instead of 101) on upstream/main 0727e2985b. Stack:
`iteratorNext` (`src/runtime/strict-iterator-host.ts` ~L155) ←
`drainStrictIterator` ← `arrayFromIter` ← `__array_from_iter_n`. The iterator
is `{ next: function () {…}, return: function () {…} }`, lowered to a closed
WasmGC struct. `safeGet(iterator, "next")` returns a value that `isCallable`
rejects, and since it is not `undefined` the `__call_next_strict` / `__call_next`
struct dispatch arms are never tried. The harness does call `setExports`.

The strict iterator host replaced the older `_drainIterable` path that #3023
fixed (9657ceacfa / a81fd24a53, 2026-08-31/09-01 era).

## Plan

1. Log what `safeGet` returns for the struct's `next` (closure struct vs
   `_wrapForHost` proxy) and what `isCallable(next, exports)` checks.
2. Either teach `isCallable`/`invokeCallable` the compiled-closure carrier, or
   try the struct dispatch when `isWasmStruct(iterator)` and `next` is a compiled
   closure. Apply the same to `return` for IteratorClose.
3. Scoped test262 `language/statements/for-of/dstr`, `language/expressions/assignment/dstr` base vs fix, gc lane.

## Acceptance criteria

- [ ] 3023 and 3040 green
- [ ] no gc test262 regression in the scoped dirs
