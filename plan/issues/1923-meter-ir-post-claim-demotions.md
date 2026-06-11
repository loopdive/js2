---
id: 1923
title: "Meter IR post-claim demotions in the fallback ratchet — build/verify/lower failures are invisible to CI"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ir
language_feature: compiler-internals
goal: correctness
---
# #1923 — Meter IR post-claim demotions in the ratchet

## Problem

The IR fallback ratchet (`pnpm run check:ir-fallbacks`,
`scripts/ir-fallback-baseline.json`) counts **only selector-level rejection
reasons** (`IrFallbackReason`). Functions that the selector *claims* and that
then fail during build/verify/lower demote to legacy through the warning
channel (`src/codegen/index.ts:889-896`) and are **counted nowhere**:

- `from-ast.ts` has 174 `throw new Error` sites that land as `kind: "build"`
  errors in `IrIntegrationReport` (`ir/integration.ts:238-240`, `:84`).
- `STRICT_IR_BUILD_ERRORS` exists but is empty (`codegen/index.ts:906`).
- Selector/lowerer disagreement is institutionalized: the selector
  deliberately accepts shapes the lowerer is known to reject (class
  receivers `select.ts:44-48`; array literals accepted purely to protect the
  call-graph closure with a guaranteed lowerer throw, `from-ast.ts:1221-1230`).

Consequence: a regression that makes claimed functions fail **after**
claiming bypasses CI entirely. The #1922 while-loop defect is a live example
— ordinary loops fell off the IR path and no gate noticed. The #1530
phase-out of the warning channel cannot be trusted while its main leak is
unmetered.

## Proposed approach

1. Aggregate `IrIntegrationReport.errors` by `kind` (build/verify/lower) and
   a normalized message class (first line, identifiers stripped) over the
   same `playground/examples/` corpus the ratchet already walks.
2. Add these as a second bucket family in `ir-fallback-baseline.json`
   (`postClaim: { build: {...}, verify: {...}, lower: {...} }`).
3. Same gate semantics: growth fails CI; `--update-on-decrease` banks
   improvements; `--verbose` prints per-file breakdown.
4. As buckets hit zero, promote the message class into
   `STRICT_IR_BUILD_ERRORS` so regressions become hard compile errors.

## Acceptance criteria

- `check:ir-fallbacks` output shows selector buckets AND post-claim buckets.
- A deliberate injected `from-ast` throw on a claimed shape fails the gate
  (test).
- Baseline committed; ci.yml quality job unchanged otherwise.

## Source

Compiler quality review 2026-06. Related: #1376 (ratchet), #1530 (phase-out),
#1922 (the defect this would have caught).
