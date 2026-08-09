---
id: 3379
title: "baseline-summary-sync staleness guard measures the in-repo file, not public/ → busy queue skips the sync forever"
status: done
completed: 2026-07-24
sprint: 76
created: 2026-07-17
priority: high
feasibility: easy
horizon: s
task_type: infrastructure
area: ci, infra, pages
goal: infrastructure
related: [3375, 1951, 2562]
---

# #3379 — baseline-summary-sync age guard measures the wrong file (follow-up to #3375)

> **DONE (2026-07-24, status reconcile).** Fix `fix(#3379): baseline-sync
> staleness guard must measure public/, not the in-repo copy` merged to `main`
> via **PR #3298** (`git log origin/main --grep="#3379"`). The issue was left at
> `status: ready` after the merge; reconciled to `done` here.

## Context

#3375 fixed the **host drift-check** in `baseline-summary-sync.yml` to compare
against the public file it overwrites. That correctly made the sync **detect**
that the landing page was stale (`host_unchanged=0`). But the sync still did
**not** update `public/` — a second instance of the same "measures the in-repo
copy, not public/" bug blocked it.

## Root cause

After drift is detected, the job has a churn guard: if the merge queue is busy
**and** the committed summary is `< 6h` old **and** not forced, it skips this
cycle to avoid queue-rebuild churn. The age is computed from the **wrong file**:

```bash
COMMITTED_TS=$(git log -1 --format=%ct -- benchmarks/results/test262-current.json ...)
```

`benchmarks/results/test262-current.json` is the **in-repo** copy, refreshed in
lockstep with the baselines repo by forced promotes — so it reads ~0h even when
`public/benchmarks/results/test262-report.json` (the file the landing page
actually serves) is hours stale.

Observed 2026-07-17 (sync run 29604427308, after #3375 landed):

```
Drift detected (host_unchanged=0 standalone_unchanged=0); queue=15 committed-summary age=0h force=false
Merge queue busy and summary <6h old — skipping this cycle (#1951).
```

`host_unchanged=0` (the #3375 fix working) but `age=0h` from the in-repo file +
`queue=15` → skip. During active development the in-repo file keeps getting
refreshed, so `age` never crosses 6h and a busy queue skips the sync
**indefinitely** — the landing page never self-heals. It only updates via a
manual `force=true` dispatch.

## Fix

Measure the age of the **public** file whose staleness actually matters:

```diff
- COMMITTED_TS=$(git log -1 --format=%ct -- benchmarks/results/test262-current.json ...)
+ COMMITTED_TS=$(git log -1 --format=%ct -- public/benchmarks/results/test262-report.json ...)
```

Now when `public/` is > 6h stale, the sync proceeds despite a busy queue and
self-heals — no manual force needed. Combined with #3375, the sync both
**detects** public drift and **acts** on a stale public file.

## Acceptance criteria

- [x] Age guard measures `public/benchmarks/results/test262-report.json`.
- [ ] A busy-queue sync with a >6h-stale public file proceeds (no force needed).
