---
id: 2022
title: "obj + '' applies string-hint ToPrimitive (toString) instead of default hint (valueOf first) when one operand is string-typed"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [1989, 1900, 1988]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2022 — `+` pre-commits to string concat before ToPrimitive

## Problem

```ts
class P { toString(): string { return "P!"; } valueOf(): number { return 7; } }
(new P() as any) + ""
// wasm: "P!"   node: "7"
```

§13.15.3: `+` applies ToPrimitive with *default* hint to both operands
first (OrdinaryToPrimitive tries valueOf before toString), THEN decides
concat vs add. Template `` `${p}` `` correctly gives "P!" (string hint);
relational `p > 5` correctly uses valueOf.

## Root cause

`src/codegen/binary-ops.ts:950` — `+` with a string-typed operand routes
straight to `compileStringBinaryOp` (string-hint stringification of the
ref operand) instead of applying ToPrimitive(default) to the object
operand before the concat/add decision.

## Fix direction

For ref operands in `+`, emit ToPrimitive(default) (valueOf→toString),
then branch on the primitive's type. Coordinate with #1989 (dispatch
correctness) and #1988 (any path).

## Acceptance criteria

- Repro returns "7"; objects with only toString still concat correctly
- Template literals (string hint) unchanged

## Dupe check

#1253/#1090 done; #1900 is standalone-native ToPrimitive phase 1 —
host-mode `+` hint routing not covered. New.
