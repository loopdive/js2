---
id: 3463
title: "ci(test262): two-oracle wiring — fast merge_group gate + daily honest cron + #3448 fast-lane rework + landing-page honest-only guard"
status: ready
sprint: Backlog
priority: high
horizon: l
task_type: ci
area: ci
goal: maintainability
parent: 3450
depends_on: [3461, 3462, 3465]
---

# ci(test262): two-oracle CI wiring

Child (c) of the #3450 HYBRID two-oracle pipeline. Full spec:
`plan/design/3450-hybrid-two-oracle-plan.md` §3, §4, §6.

## Problem

Wire the fast oracle to gate the merge queue and move the honest v8 oracle to a
daily change-gated cron; re-scope #3448 to feed the fast baseline; keep the
published number honest-only.

## Scope

### Fast lane gates merge_group (`.github/workflows/test262-sharded.yml`)
- `test262-shard-mg` host shards export `TEST262_ORACLE_MODE=fast`; standalone
  stays honest v8. Re-derive the mg host/standalone chunk split (host is no
  longer the long pole; coordinate with L6 `gen-test262-mg-matrix.mjs`).
- `regression-gate` selects the fast host baseline (`ensureFastBaselineJsonl`)
  for host rows when fast-mode; standalone diff unchanged.
- Required-check topology UNCHANGED (`cheap gate`, `merge shard reports`,
  `check for test262 regressions`, `quality`).

### Honest lane = daily change-gated cron (NEW `.github/workflows/test262-honest-daily.yml`)
- `schedule` daily + `workflow_dispatch`.
- `honest-change-probe`: skip when `git diff <last_honest_sha>..HEAD` touches
  none of `src/**`, `tests/test262-*`, `scripts/test262-*`,
  `scripts/test262-fyi-runtime.js`, `test262/harness/**`, the compiler bundle
  hash, or the `test262` submodule pin. Fail-safe = run on missing marker /
  dispatch.
- Full 57×2 honest matrix (no `TEST262_ORACLE_MODE`) → honest-merge-report →
  honest-regression-gate → honest-promote-baseline (sole writer of
  `test262-current.jsonl`, `test262-standalone-current.jsonl`, the landing-page
  summary, and the `test262-current.meta.json` `last_honest_sha`/`bundle_hash`).
- Independent concurrency group (never contends merge_group).

### #3448 rework (spec §4)
- KEEP `mg-artifact-probe` + reuse-by-SHA + `SHARD_SKIP_OK`.
- CHANGE: the push:main reuse promotes the **fast** host baseline
  (`test262-fast-current.jsonl`, `fast-nativeharness`), NOT the honest host
  baseline. Remove honest-host promote from push:main (now daily-cron-owned).
- One writer per baseline file (no races).

### Landing page (spec §6)
- Site data-build asserts published summary is `oracle_lane: honest` (or none);
  rejects `fast-nativeharness` input. Cross-reference #3458 cumulative fix —
  same JSON source.

## Acceptance criteria

1. merge_group host = fast oracle, standalone = honest; both required checks
   green on the seeded fast baseline, no false failures.
2. Daily honest workflow runs full honest matrix, promotes both honest
   baselines + the number, SKIPS when change-gate finds no relevant diff.
3. Required-check topology on PR/merge_group unchanged.
4. Daily workflow concurrency independent of `test262-sharded`.
5. push:main promotes ONLY the fast host baseline; daily cron is sole writer of
   the honest baselines + published number.
6. Badge/site render honest data; a `fast-nativeharness` JSONL fed to the site
   build is rejected.
