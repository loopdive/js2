---
id: 1997
title: "Array.prototype.toString() returns '[object Array]' instead of join() (method call only; String(a) works)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: array-methods
goal: core-semantics
related: [1215]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #1997 — array .toString() falls to generic object-toString dispatch

## Problem

```ts
const a: any[] = [[1,2],[3]];
a.toString()   // wasm: "[object Array]"   node: "1,2,3"
```

Also flat `[1,2,3].toString()`. `String(a)` works; only the method call is
broken. Spec §23.1.3.36: Array toString = join.

## Root cause

`src/codegen/array-methods.ts:2372` — the `ARRAY_METHODS` set has `"join"`
but no `"toString"`, so the call falls to the generic object-toString
dispatch (`src/codegen/index.ts:3770`
`emitDispatchForMethod("toString", "__call_toString")`). Regression /
residual of #1215 (done).

## Fix direction

Add `"toString"` to ARRAY_METHODS, lowering to the join path with the
default separator.

## Acceptance criteria

- Both repros match Node; nested arrays stringify via join recursively

## Dupe check

#1215 (done) registered `number_toString` for array `.toString()`; current
behavior is a residual. New.
