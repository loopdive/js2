---
id: 1995
title: "flat() with no argument flattens depth 0 instead of default 1 — ref.null arrives as JS null, not undefined"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: host-interop
language_feature: array-methods
goal: core-semantics
related: [1996, 1136]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #1995 — omitted flat() depth becomes null → ToIntegerOrInfinity(null) = 0

## Problem

```ts
const a: any[] = [1, [2, 3], [4, [5]]];
JSON.stringify(a.flat())
// wasm: "[1,[2,3],[4,[5]]]" (no-op copy)   node: "[1,2,3,4,[5]]"
```

Explicit `flat(1)` works.

## Root cause

`src/codegen/array-methods.ts:7074` pushes `ref.null.extern` for the
omitted depth; it arrives in JS as `null`, and `src/runtime.ts:8533`
checks `depth === undefined` (false for null) so it calls
`jsArr.flat(null)` → ToIntegerOrInfinity(null) = 0 → depth 0.

## Fix direction

Either emit `f64.const 1` when the arg is omitted, or change the runtime
check to `depth == null`.

## Acceptance criteria

- `a.flat()` ≡ `a.flat(1)`; `flat(0)` still a no-op copy

## Dupe check

Only #1136 (done, original implementation). New.
