---
id: 3923
title: "linear backend: 7 Array builtins unimplemented — pop, sort, reduce, indexOf, slice, reverse, forEach (blocks 7 benchmarks)"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen-linear
language_feature: array-methods
goal: performance
sprint: current
horizon: l
es_edition: multi
related: [3908, 3902, 3922]
---

# #3923 — linear lane: missing Array builtins

## Status: open — from #3908's 26-lane inventory

## Problem

Seven `Array.prototype` methods are unimplemented in the linear-memory backend,
each failing at **compile** time with `Unsupported Array method`:

`pop`, `sort`, `reduce`, `indexOf`, `slice`, `reverse`, `forEach`

One blocked benchmark each: `array/push-pop`, `array/sort-i32`, `array/reduce`,
`array/indexOf`, `array/slice`, `array/reverse`, `array/forEach`.

As with #3922 these are **missing features, not miscompiles**.

## Note on `sort` specifically

#3902 replaced both WasmGC `Array.prototype.sort` insertion sorts with a shared
stable merge sort in `src/codegen/merge-sort.ts`, parameterised by
`buildCompareGtZero(pushLeft, pushRight)`. That parameterisation was deliberate.
Before writing a separate linear sort, check whether the emitter can be reused
with linear-memory push callbacks — a second sort implementation is exactly the
kind of duplication that later diverges. #3902 also found the WasmGC versions
were O(n²) insertion sorts; do not reproduce that shape here.

## Scope

1. Decide the intended Array surface for the linear lane and record it.
2. Implement what is in scope, reusing `merge-sort.ts` for `sort` if the
   parameterisation allows.
3. `forEach`/`reduce`/`indexOf` are close relatives of the `filter`/`map`/
   `some`/`find` family already handled by `compileArrayHOF` — start there. Note
   #3908 found `find`'s accumulator had a hard-coded `i32` slot while siblings
   were correct, so **check each new accumulator's ValType against the element
   type explicitly** rather than copying a neighbour.

## Acceptance criteria

1. Each method implemented or explicitly scoped out with a reason.
2. Benchmarks whose only blocker was a listed method produce a linear bar.
3. `sort` is stable and not O(n²); reuse over reimplementation where possible.
4. Equivalence coverage for whatever lands.

## Provenance

`issue-3908-linear-validation`'s 26-lane inventory. See #3922 for the full
bucket breakdown.
