---
id: 4681
title: "ES2015 exponentiation defers ToNumeric until both operands are evaluated"
status: done
sprint: current
created: 2026-08-25
updated: 2026-08-25
completed: 2026-08-25
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: exponentiation
goal: spec-completeness
assignee: codex/es6-language-tail-wave4
loc-budget-allow:
  - src/codegen/binary-ops.ts
func-budget-allow:
  - src/codegen/binary-ops.ts::compileBinaryExpression
oracle-ratchet-allow:
  - src/codegen/binary-ops.ts
---

# Exponentiation evaluates the right operand before coercing the left

## Exact cohort and plan

The 2026-08-25 standalone artifact at
`/private/tmp/js2-es6-functionproto-wave3/.test262-cache/test262-standalone-current.jsonl`
has 7 failing `language/expressions/exponentiation` rows. This issue takes the
single shared object-ToNumeric ordering cohort (3 rows):

- `test/language/expressions/exponentiation/order-of-evaluation.js`
- `test/language/expressions/exponentiation/exp-operator-evaluation-order.js`
- `test/language/expressions/exponentiation/exp-operator-precedence-unary-expression-semantics.js`

The BigInt negative-exponent and wrapper/mixed-type rows are explicitly outside
this issue. The implementation will preserve each operand value first, then
apply ToNumeric/coercion in left-to-right spec order, with no change to the
numeric fast path. Focused tests will cover valueOf ordering, unary RHS
evaluation, and a numeric control; the artifact cohort will be rechecked
before/after to prove zero loss outside the selected rows.

## Baseline evidence

Artifact oracle: version 13, honest standalone lane, timestamp 2026-08-25
04:31:xx Europe/Berlin. Selected rows are all `fail` with assertion failures;
the two direct ordering probes observe left-side `valueOf` before the right
expression. Current upstream base is `loopdive/js2:main` at `a1e65f5b1`.

## Root cause

The regular binary lowering compiles each operand with an f64 numeric hint.
For an object operand that hint invokes `coerceType` immediately, so the
left object's `valueOf` runs before the right operand expression is evaluated.
ECMAScript evaluates both operands and only then applies ToNumeric to the
saved values.

## Fix

Add a narrow `**` object-like lowering in `src/codegen/binary-ops.ts`: compile
and save both natural operand values first, then reload and coerce them to f64
before the existing numeric exponentiation operation. Primitive numeric
expressions retain the existing path.

## Test Results

All runs below use the isolated worktree at upstream `main` `a1e65f5b1`.

- `node_modules/.bin/vitest run tests/issue-4681.test.ts --reporter=verbose`:
  **3 passed** (right-expression ordering, unary RHS ordering, numeric control).
- Exact selected cohort through `runTest262File(..., "standalone")`: **3/3
  pass** after the fix. The artifact baseline had **0/3 pass, 3/3 fail**.
- Family guard over all 7 failing exponentiation rows: selected **3 flips
  fail→pass**; excluded BigInt/mixed-type rows remain **4 fail→4 fail** with
  no status loss or new failure.
- `/.../node_modules/typescript/bin/tsc --noEmit --pretty false`: **exit 0**.
- Targeted Prettier check for source, test, issue, and lock files: **exit 0**.
- `pnpm run check:loc-budget` and `pnpm run check:func-budget`: **exit 0**
  with the issue-scoped allowances above.
