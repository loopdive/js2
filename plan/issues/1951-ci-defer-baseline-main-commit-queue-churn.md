---
id: 1951
title: "CI: per-merge baseline pushes to main rebuild every queued merge group — defer commit while queue busy + scheduled summary sync"
status: done
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
sprint: 61
area: ci
---
## Problem

Every merged test262-relevant PR ends with `promote-baseline` (test262-sharded.yml)
pushing a summary commit to `main` (`chore(test262): refresh sharded baseline …
[skip ci]`). `[skip ci]` suppresses workflow triggers, but **the merge queue does
not care**: any advance of `main` rebuilds every queued merge group.

Observed directly on 2026-06-10: PR #1283 had its merge group rebuilt twice
(group runs at 22:21, 22:25 — both ran the full 114-job matrix to completion
for refs that were already dead — then a third at 22:37 that counted). Cost per
churn event: **~3 runner-hours of wasted full-matrix validation per queued PR,
plus ~10 min added queue latency each**. Under merge traffic this compounds:
each merge → baseline push → all k queued groups rebuild.

## Fix (implemented by this issue's PR)

Split the two pushes promote-baseline makes:

1. **Baselines repo push (`loopdive/js2wasm-baselines`)** — unchanged, stays
   per-merge. It does not move `main`, and the regression gates need it fresh.
2. **Main-repo summary commit** (committed report JSONs + conformance-number
   doc sync) — now **deferred while the merge queue is non-empty**. The step
   checks queue depth via GraphQL (`mergeQueue.entries.totalCount`); if > 0 it
   exits 0 with a note. Fail-open: if the query errors, push as before.
3. **New scheduled workflow `baseline-summary-sync.yml`** (hourly + dispatch)
   closes the gap when the queue never empties between merges: it sparse-clones
   the baselines repo, compares the latest report against the committed
   `benchmarks/results/test262-current.json` (semantic compare via
   `scripts/compare-test262-artifact.mjs`), and if drifted AND the queue is
   empty (or the committed summary is >6h behind), re-runs
   `sync-conformance-numbers.mjs` and pushes the same atomic file set over the
   MAIN_DEPLOY_KEY remote (same GH013-bypass dance as promote-baseline),
   then triggers deploy-pages.

Consistency note: main stays self-consistent at all times (old number + old
docs until the sync lands number + docs atomically, exactly as promote-baseline
does today, just less often). Side benefit: the conformance number moves less
frequently, so fewer in-flight PRs are dropped by the `quality` gate's
`sync:conformance:check` at the queue head (#1522 failure class).

## Acceptance criteria

- A merge while ≥1 PR is queued produces NO main-repo baseline commit.
- The committed summary on main is never more than ~7h behind the baselines
  repo (hourly sync + 6h force threshold).
- Baselines-repo freshness (regression-gate input) is unchanged per-merge.
