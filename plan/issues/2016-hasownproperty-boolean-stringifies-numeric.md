---
id: 2016
title: "hasOwnProperty result stringifies as '1'/'0' instead of 'true'/'false' (i32 result lacks boolean brand)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: low
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [2005]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2016 — boolean-returning builtin formats as number in concat

## Problem

```ts
const o: any = { x: 1 };
o.hasOwnProperty("x") + "," + o.hasOwnProperty("y")
// wasm: "1,0"   node: "true,false"
```

Ordinary booleans stringify correctly (baseline probe passed).

## Root cause

`src/codegen/object-ops.ts:3299` (and sibling returns at 3117/3226/3327) —
`__hasOwnProperty` import returns `{kind:"i32"}` with no boolean brand, so
string concatenation formats it as a number.

## Fix direction

Mark the result boolean (same brand the comparison operators carry) so
`emitBoolToString` fires; audit sibling i32-returning predicates at the
listed lines.

## Acceptance criteria

- Repro returns "true,false"; numeric contexts unchanged

## Dupe check

No issue on hasOwnProperty stringification. New.
