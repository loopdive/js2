---
id: 3907
title: "correctness: fast-mode infers i32 for an accumulator that overflows — mixed/fibonacci gc-native returns -269,534,592 instead of 8,320,400,000"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: numeric-types
goal: performance
sprint: current
horizon: m
es_edition: multi
related: [3898, 1948]
---

# #3907 — fast mode wraps a `number` accumulator at 2³¹

## Status: open — found by the #3898 cross-lane assertion on its first run

## Problem

`mixed/fibonacci` on the published performance page returns **different results
per lane**:

| lane        | returned value  |
| ----------- | --------------- |
| `js`        | 8,320,400,000   |
| `gc-native` | **−269,534,592**|

Fast mode infers **i32** for the accumulator and wraps past 2³¹, while every
other lane carries f64. In TypeScript the variable is `number`, i.e. IEEE-754
double — wrapping is simply wrong, not a permitted approximation.

The benchmark source (`benchmarks/suites/mixed.ts:141-163`) sums `fib(30)`
10,000 times: `fib(30)` is 832,040, so the total is 8,320,400,000 — well past
`Number.MAX_SAFE_INTEGER`? No: it is under 2⁵³ and exactly representable as an
f64. It only overflows if the accumulator is narrowed to i32.

## Why it matters beyond correctness

This invalidated a **published benchmark result**. `mixed/fibonacci` gc-native
was reported as 1.59× faster than JS — but it was comparing wrapping i32 adds
against f64 adds. That is not the same computation, so the number never meant
what the page claimed. Any i32-narrowing win elsewhere is suspect until we
know how far this reaches.

## Scope

1. Find where fast mode decides the accumulator is i32. The narrowing is
   presumably justified by a syntactic `|0`/`&`/`>>`-style matcher or a
   range/`typeof`-based inference; establish which. #1948 tracks the shared
   numeric lattice that should own this decision.
2. The narrowing is only sound when the value **provably** stays in i32 range.
   A `+` accumulation in an unbounded loop does not. Either prove the bound or
   do not narrow.
3. Sweep for other instances: any `number` local that fast mode narrows to i32
   and then accumulates. This is unlikely to be unique to fibonacci.
4. Add a regression test asserting cross-lane result equality, not just
   non-trapping.

## Acceptance criteria

1. `mixed/fibonacci` returns 8,320,400,000 in **every** lane.
2. A test asserts lane-result equality for the numeric benchmarks.
3. The issue documents how many other narrowing sites were found and whether
   any is similarly unsound.
4. Re-measure `mixed/fibonacci` — the honest gc-native number may be slower
   than the 1.59× currently published, and that is the correct outcome.

## Notes

- #3898 worked around this **in the benchmark only** so its baseline run could
  proceed. The compiler bug is untouched and is what this issue is for.
- The cross-lane result assertion #3898 added is what caught this. It had
  never been checked before, which is why a wrong-answer benchmark sat on the
  public page. That guard is now the thing to extend, not to remove.
