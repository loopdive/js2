---
id: 4109
title: "Bank hybrid legacy-body emission reductions"
status: done
completed: 2026-08-16
sprint: 78
created: 2026-08-02
updated: 2026-08-18
priority: critical
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: test
area: ir, tooling
language_feature: ir-retirement
goal: ir-full-coverage
lane: ir-retirement-r6
parent: 3518
depends_on: [4106]
related: [3090, 3792, 4107]
files:
  - scripts/check-ir-only.ts
  - scripts/ir-only-baseline.json
  - tests/issue-3519-ir-only-gate.test.ts
  - tests/issue-3792-ir-optimization-retirement-gate.test.ts
  - plan/log/ir-optimization-retirement-ledger.md
  - plan/issues/4109-ir-legacy-body-ceiling.md
---

# #4109 — Bank hybrid legacy-body emission reductions

## Problem

The IR-only readiness report measures how many terminal units still emit a
legacy body, but the committed hybrid baseline does not retain that count.
Consequently, a later change can reintroduce direct body emission without
crossing any existing emitted, unsupported, or invariant threshold. Missing
legacy-body evidence is also interpreted as false by the current counter.

## Scope

- Add a per-lane `legacyBodyEmittedCeiling` to the committed readiness
  baseline and record the observed count during supported regeneration.
- Reject a hybrid observation when legacy-body emission rises above the
  committed ceiling.
- Fail when either a terminal outcome's legacy-body evidence or the baseline
  ceiling is absent or invalid.
- Record the numeric Promise-carrier round-trip decision in the optimization
  retirement ledger so the direct implementation cannot be deleted before
  #4107 supplies output-shape evidence.

## Acceptance criteria

- The post-#4050 single-host corpus is freshly measured and its legacy-body
  count is committed as the production ceiling.
- A lower or equal observed count passes the hybrid ratchet; a higher count
  fails with the measured and allowed populations in the diagnostic.
- Missing per-terminal evidence and a missing/invalid committed ceiling both
  fail instead of silently appearing as zero.
- Baseline regeneration writes the measured legacy-body count.
- Focused tests, typecheck, formatting, issue consistency, the IR fallback
  ratchet, and the optimization-retirement ledger check pass.

## Measured evidence

On merged #4050 (`6660c1158c0269`), the five-entry production corpus reports
37 terminal units: 34 IR-emitted, 34 legacy-body-emitted, three typed async
blockers, and zero invariants. The committed hybrid ceiling is therefore 34.

## Result

- The hybrid baseline now records `legacyBodyEmittedCeiling` and supported
  regeneration derives it from the observed terminal outcomes.
- The shared evaluator rejects a measured increase and fails closed when a
  terminal's legacy-body evidence or the committed ceiling is unobservable.
- The retirement ledger now has 22 decisions: 11 have complete IR ownership,
  one is retirement-ready, and the numeric Promise-carrier round trip remains
  blocked on #4107 output-shape evidence and #3792 performance evidence.

## Validation

- `pnpm exec vitest run tests/issue-3519-ir-only-gate.test.ts tests/issue-3792-ir-optimization-retirement-gate.test.ts`
  — 19/19 tests pass.
- `pnpm exec tsx scripts/check-ir-only.ts --policy=hybrid --update` — READY
  at 34/37 IR-emitted, 34 legacy bodies, three typed blockers, and zero
  invariants; regeneration writes ceiling 34.
- `pnpm run check:ir-optimization-retirement` — 22 rows, 11 IR-owned, one
  retirement-ready.
- `pnpm run check:ir-fallbacks`, `pnpm run typecheck`, focused Prettier,
  `pnpm run check:issues`, and `git diff --check` pass.
