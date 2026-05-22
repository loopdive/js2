---
id: 804
title: "Extract new expressions from expressions.ts → new-expression.ts"
status: done
created: 2026-03-26
updated: 2026-05-21
priority: medium
feasibility: easy
reasoning_effort: medium
goal: maintainability
subtask_of: 688
---
# #804 — Extract new expressions from expressions.ts → new-expression.ts

## What moves

~1,300 lines:

- `compileNewExpression` (line 14620, 950 lines)
- `compileNewFunctionExpression` (line 14250, 335 lines)
- `compileClassExpression` (line 14585)

## Validation

1. `npm test` must pass
2. Compile test262 files using `new` expressions: class instantiation, `new Function()`, `new Error()`
3. No behavior change

## Risk: LOW

Self-contained — these functions call into `compileExpression` but nothing calls back into them except the switch dispatcher.

## Complexity: S

## Resolution (2026-05-21)

Already done in prior refactor. `compileNewExpression`, `compileNewFunctionExpression`, and `compileClassExpression` now live in `src/codegen/expressions/new-super.ts` (lines 1252, 851, 1212). `src/codegen/expressions.ts` (down to 1061 lines from 14k+) imports and re-exports them at lines 54, 140–141. Closed as done with no code change.
