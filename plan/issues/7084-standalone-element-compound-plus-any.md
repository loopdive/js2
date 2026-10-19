---
id: 7084
title: "standalone: `o[k] += str` on an `any` receiver is numeric — `buffer[0] += str` stores NaN (hono `escapeToBuffer`)"
status: done
sprint: current
created: 2026-10-18
updated: 2026-10-18
completed: 2026-10-18
assignee: ttraenkler/wave17-hono-residual
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
goal: standalone-gap
language_feature: assignment, strings
related: [7013, 3673, 2850]
loc-budget-allow:
  # 2026-10-18 (#7084) operator-assignment.ts +8: import + one routed branch; the
  #   lowering lives in the new expressions/element-compound-any-add.ts.
  - src/codegen/expressions/operator-assignment.ts
func-budget-allow:
  - src/codegen/expressions/operator-assignment.ts::compileElementCompoundAssignment
---

# Element `+=` on a dynamic receiver

The externref element compound path unboxed the current value, `f64.add`-ed the
RHS and stored the number back. #3673 fixed the PROPERTY twin (`obj.p += s`) on
the native-semantics lane; the element form was left behind.

## Implementation Plan

After the `__extern_get` read, a `+=` on the native-first lane parks both
operands and runs `emitAnyAddFromExternTemps` (§13.15.3 dispatch), then writes
back through `__extern_set(_strict)`. Every other operator stays numeric. New
leaf `expressions/element-compound-any-add.ts`.

## Resolution

Implemented; hono `utils/html` `escapeToBuffer` passes.

Regression: `tests/issue-7059-hono-standalone-residuals.test.ts` (the `#7084` block).
