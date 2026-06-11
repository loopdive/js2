---
id: 1947
title: "for-of iterator path silently breaks after 1,000,000 iterations (hard guard, counter not reset across re-entries)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: iterators
goal: iterator-protocol
origin: "2026-06-10 deep-audit sweep (control-flow agent): observed in source; loops.ts hard guard"
---

# #1947 — for-of iterator loop has a silent 1M-iteration cap

## Problem

The generic-iterator for-of lowering contains a hard guard that `break`s out of
the loop after 1,000,000 iterations — silently truncating legitimately long
iterations (e.g. consuming a long generator). Worse, the counter is not reset
across re-entries of the same statement, so repeated executions of the same
loop accumulate toward the cap.

## Location

`src/codegen/statements/loops.ts:4024-4031`.

## Why it matters

A correctness-silent guard violates "compile away, don't emulate": a program
iterating 1M+ times gets a wrong result with zero diagnostics. Any large
data-processing loop over an iterator hits this.

## Fix direction

Remove the guard, or (if it exists to protect against runaway non-terminating
iterators in some harness context) gate it behind a debug compile flag and
`throw` a RangeError-style host error instead of silently breaking. At minimum
reset the counter on loop entry so re-entry doesn't accumulate.

## Acceptance criteria

- A for-of consuming a 2,000,000-element iterator/generator produces the full
  result
- Re-entering a loop statement many times doesn't trip the cap
- No silent `break` path remains (error or unlimited)

## Dupe check

Grepped `1000000`, `iteration cap`, `guard` in plan/issues/ — no issue on file
(control-flow audit 2026-06-10).
