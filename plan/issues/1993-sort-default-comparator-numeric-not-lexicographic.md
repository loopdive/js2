---
id: 1993
title: "sort() with no comparator sorts numerically instead of lexicographic ToString order ([10,9,1,100] → 1,9,10,100)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-10
completed: 2026-06-11
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-methods
goal: core-semantics
related: [1361, 1816, 1967]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #1993 — default sort comparator is numeric, spec requires string comparison

## Problem

```ts
const a = [10, 9, 1, 100]; a.sort(); a.join(",")
// wasm: "1,9,10,100"   node: "1,10,100,9"
```

Spec §23.1.3.30: with no comparator, elements compare by ToString.

## Root cause

`src/codegen/array-methods.ts:6260-6261` — no-comparator path calls
`ensureTimsortHelper` (`src/codegen/timsort.ts`) which hard-codes
`i32.lt_s`/`f64.lt`. #1816's fix (`tryCompileComparatorSort`) only covered
the with-comparator case; #1361 (done) listed this exact case in its
acceptance criteria but the fix never landed for the default path.

## Fix direction

No-comparator path on numeric arrays: compare `number_toString(a) <
number_toString(b)` (or synthesize the default comparator per spec) instead
of raw numeric less-than.

## Acceptance criteria

- Repro matches Node; with-comparator sorts unchanged
- String arrays default sort unchanged

## Dupe check

#1967 covers element-type gates (struct elements), not default ordering.
#1361/#1816 done but residual. Refiled as residual.
