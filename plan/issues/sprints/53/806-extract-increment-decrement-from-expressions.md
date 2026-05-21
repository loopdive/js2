---
id: 806
title: "Extract increment/decrement from expressions/unary.ts → unary-updates.ts"
status: done
created: 2026-03-26
updated: 2026-05-21
priority: medium
feasibility: easy
reasoning_effort: medium
goal: maintainability
subtask_of: 688
---
# #806 — Extract increment/decrement → unary-updates.ts

## Outcome

The original extraction from `expressions.ts` already happened in a prior
refactor (the monolithic `expressions.ts` was split into `expressions/*.ts`
files). This issue was re-scoped to split the existing
`src/codegen/expressions/unary.ts` (1643 lines, mixed concerns) into:

- `unary.ts` — 151 lines, non-update prefix unary (`+`, `-`, `!`, `~`).
- `unary-updates.ts` — 1537 lines, all UpdateExpression codegen:
  - `unwrapParens`, `emitToNumericForUpdate`
  - `compileMemberIncDec`
  - `compilePrefixUpdate` (new; covers `PlusPlusToken` / `MinusMinusToken`)
  - `compilePostfixUnary`
  - `compilePrefixIncrementProperty` / `compilePrefixIncrementElement`
  - `compilePostfixIncrementProperty` / `compilePostfixIncrementElement`

`compilePrefixUnary` in `unary.ts` delegates the `++` / `--` switch arms to
`compilePrefixUpdate`. No behavioural change.

## Validation

- `pnpm run build` → green.
- 14/14 scoped smoke tests (`i++`, `++i`, `i--`, `--i` on locals; `obj.x++`,
  `++o.x`, `o.x++`, `++o.x`; `arr[1]++`, `--a[2]`; arrow capture variants).
- 32/32 equivalence tests pass:
  `prefix-postfix-increment-property`, `compound-assignment-{coercion,
  property}`, `unary-plus-coercion-{185,215}`.
- Pre-existing failures on `main` (`labeled-loops`, private postfix
  increment in `issue-334`, `arguments-*` helper-resolution) confirmed
  identical pre/post; unrelated to this refactor.

## Risk: LOW

Self-contained cluster. Public export surface unchanged — `expressions.ts`
still imports `compilePostfixUnary` / `compilePrefixUnary` and re-exports
`compileMemberIncDec` / `compilePostfixUnary` / `compilePrefixUnary` from
`./expressions/unary.js`. The update implementations are re-exported by
`unary.ts` from `unary-updates.ts`, so no caller outside this directory
needs to change.

## Complexity: S
