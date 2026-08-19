---
id: 4107
title: "IR async fetchUser compile-once ownership"
status: done
sprint: 78
created: 2026-08-02
updated: 2026-08-18
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
  - plan/log/ir-optimization-retirement-ledger.md
  - plan/issues/4102-ir-promise-delay-closure-compile-once.md
  - plan/issues/4103-ir-async-runtime-provider-schema.md
  - plan/issues/4104-ir-async-plan-runtime-consumer.md
  - plan/issues/4106-ir-async-fetch-user-state-machine.md
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

## Result

- The exact top-level host `fetchUser` callable freezes its canonical Promise
  ABI before Program ABI publication and enters the sealed prepared-function
  transaction without first compiling a direct body.
- Compile-once admission now requires the awaited call site to resolve to an
  exact already-prepared dependency. Ordinary single-await functions whose
  callees still use the direct route keep their legacy body instead of entering
  an unsealed prepared component.
- Prepared async dependency sealing consumes the semantic async plan and its
  runtime adapters instead of the discarded pre-transform await block.
- Runtime execution still resolves `fetchUser(7)` to `70`; direct-only,
  host-free, near-miss, ABI-mismatch, and terminal-failure cases remain on
  their previous routes.
- The production corpus remains 34/37 IR-emitted with three typed async
  blockers and zero invariants. Legacy body emission is now banked at 33,
  down from 34.
- Numeric Promise-carrier output shape is verified by function-specific WAT
  evidence. Performance evidence remains pending, so the ledger row is not
  retirement-ready.

## Validation

- `pnpm exec vitest run tests/issue-4104-ir-async-plan-runtime-consumer.test.ts tests/issue-4106-ir-async-fetch-user.test.ts tests/ir/issue-1373b-async-plan.test.ts`
  — 22/22 tests pass.
- The three equivalence files that caught premature single-await admission pass
  26/26 tests: `promise-chains`, `async-function`, and `ir-slice10-promise`.
- `pnpm exec tsx scripts/check-ir-only.ts --policy=hybrid` — READY at 34/37
  IR-emitted, 33 legacy bodies, three typed blockers, and zero invariants.
- `pnpm run check:ir-optimization-retirement` — 22 rows, 11 IR-owned, one
  retirement-ready.
- `pnpm run check:ir-fallbacks`, `pnpm run typecheck`, `pnpm run check:issues`,
  focused Prettier and Biome lint, source/function budgets, and
  `git diff --check` pass.
