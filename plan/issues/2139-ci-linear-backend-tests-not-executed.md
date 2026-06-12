---
id: 2139
title: "CI: linear-backend tests (22 files) are not executed by any CI job"
status: ready
sprint: 62
created: 2026-06-12
updated: 2026-06-12
priority: critical
feasibility: easy
reasoning_effort: low
task_type: infra
area: ci
language_feature: compiler-internals
goal: trustworthiness
related: [1854, 1937, 1974, 1975, 1976, 1977]
origin: "2026-06-12 sprint-62 architecture analysis (quality workstream N1) — root cause of the 1974-1977 class shipping silently"
---

# #2139 — every linear-backend change lands ungated

## Problem

`tests/linear-*.test.ts` (22 files), `tests/c-abi.test.ts`, and
`tests/simd.test.ts` sit at `tests/` root. CI's equivalence shards run only
`tests/equivalence/` (`scripts/equivalence-gate.mjs:58`); ci.yml's
`quality` job runs lint/typecheck/gates plus 3 named files. No workflow
runs them. `scripts/diff-test.ts` has zero `linear` references; the test262
matrix has no linear leg. This — not a differential-testing gap — is why
#1974/#1975/#1976/#1977 shipped silently: nothing executed linear output at
all after merge.

## Approach

Add a `linear-tests` job to ci.yml
(`pnpm exec vitest run tests/linear-*.test.ts tests/c-abi.test.ts`),
baseline-gated via the equivalence-gate pattern if any currently fail; add
to required checks per `docs/ci-policy.md`.

## Acceptance criteria

- A deliberately-broken linear lowering fails PR CI.
- The four in-flight linear fix PRs (#1409/#1412/#1414/#1415) are
  permanently guarded once merged.

## Notes

S-size, routine dev, but sprint-62 P0: do first in the quality lane, it
gates the permanence of all in-flight linear fixes. The cheapest, biggest
trust win found by the analysis.
