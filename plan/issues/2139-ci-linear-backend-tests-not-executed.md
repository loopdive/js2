---
id: 2139
title: "CI: linear-backend tests (22 files) are not executed by any CI job"
status: done
sprint: 63
created: 2026-06-12
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-2139
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

## Resolution (2026-06-16)

Added a dedicated **`linear-tests`** job to `.github/workflows/ci.yml` that
runs the 20 previously-ungated test files directly:

```
pnpm exec vitest run \
  tests/linear-*.test.ts tests/c-abi.test.ts tests/simd.test.ts tests/simd-wat.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

(17 `linear-*.test.ts` + `c-abi.test.ts` + `simd.test.ts` + `simd-wat.test.ts`
= 20 files, 203 tests.) Single-fork / no-file-parallelism mirrors the
equivalence-shard RAM pattern (peak ~1 GB).

**No baseline-gate needed.** The approach note suggested baseline-gating "if
any currently fail" — but all 20 files / 203 tests **pass on main**, so the
job runs them directly. Any failure is therefore a genuine regression that
hard-blocks the PR (simpler than the equivalence-gate baseline machinery, and
matches AC #1 exactly).

Promoted `linear-tests` to a **required status check** in the two
source-of-truth files: `scripts/enable-branch-protection.sh` (`REQUIRED_CHECKS`)
and `docs/ci-policy.md` (§1 required-checks table + §7 mapping table). The
GitHub ruleset itself is applied out-of-band by an admin running
`./scripts/enable-branch-protection.sh` (needs Administration:write); the job
already runs and reports on every PR regardless, so it gates the merge queue
once the ruleset is re-applied.

### Acceptance criteria — verified

- **A deliberately-broken linear lowering fails PR CI** ✓ — dropped a probe
  test into `tests/linear-broken-probe.test.ts` with a failing assertion and
  ran the exact CI command: vitest exited **1** (1 file / 1 test failed,
  20 files / 203 tests passed). Probe removed; no leftover test changes.
- **The four in-flight linear fix PRs (#1409/#1412/#1414/#1415) are
  permanently guarded once merged** ✓ — the job runs the full linear-backend
  suite on every PR, so any later regression of those fixes fails CI.
