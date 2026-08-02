---
id: 4107
title: "IR async fetchUser compile-once ownership"
status: in-progress
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, runtime, codegen
language_feature: async
goal: ir-full-coverage
lane: ir-retirement-r7
parent: 3527
depends_on: [4106]
related: [1042, 1373b, 3518, 3521, 3792]
files:
  - src/codegen/async-ir-planning.ts
  - src/codegen/declarations.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/index.ts
  - src/ir/prepared-component-dependencies.ts
  - scripts/ir-only-baseline.json
  - tests/ir/issue-1373b-async-plan.test.ts
  - tests/issue-4104-ir-async-plan-runtime-consumer.test.ts
  - tests/issue-4106-ir-async-fetch-user.test.ts
  - plan/issues/4107-ir-async-fetch-user-compile-once.md
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/declarations.ts
---

# #4107 — IR async fetchUser compile-once ownership

## Problem

#4106 prepares and emits the exact host single-await `fetchUser` body through
`IrAsyncPlan`, but only after the direct body has already compiled. Its
terminal evidence is therefore `direct=1, IR=1`. That proves replacement
parity, not retirement ownership.

The production readiness gate also reports legacy-body counts but does not
bank their decreases during hybrid operation, so a future change could restore
a retired direct body without failing the baseline gate.

## Scope

- Admit only the exact #4106 suspending owner into the existing sealed
  prepare-before-direct free-function transaction.
- Prove its already allocated source-callable slot has the exact parameter ABI
  and one `externref` Promise result before skipping the direct body.
- Retain direct callers on their current route; they target the same structural
  source slot and Promise ABI.
- Require the terminal owner to report `legacyBodyEmitted: false`,
  `irBodyEmitted: true`, and a non-empty prepared component ID.
- After companion #4109 / PR #4051 adds the hybrid
  `legacyBodyEmittedCeiling`, rebase and bank this slice's measured production
  reduction from 34 to 33.
- Consume #4109's numeric Promise-carrier ledger handoff by flipping only its
  output-shape evidence to the function-specific WAT proof from this slice;
  performance remains pending and the row remains non-retirable.

## Acceptance criteria

- The exact host fixture skips only `fetchUser` after successful sealed
  preparation and still settles `fetchUser(7)` to `70`.
- Near misses, host-free targets, ABI mismatches, and preparation failures keep
  a direct body or fail terminally; there is no skip-then-fallback path.
- The playground census remains 34/37 IR-emitted with three typed async
  blockers and zero invariants, while legacy body emission falls from 34 to
  33.
- Hybrid readiness fails if legacy body emission rises above the committed
  ceiling.
- Focused tests, typecheck, fallback/readiness/optimization gates, formatting,
  and source/function budgets pass.

## Handoff

Measured after this slice: 34/37 playground terminals IR-emit and 33/37 still
emit a legacy body. Continue serially through `fetchAllParallel` (non-identity
continuation), `fetchAllSequential` (for-loop CFG and spills), then `main` (two
awaits and void settlement). Those three admissions project 37/37 IR emission,
but still only 7/37 compile-once owners and 30/37 legacy bodies; broader
retirement remains #3518 R2–R8. Do not add another scheduler or async emitter;
keep the existing frame engine as the sole consumer.
