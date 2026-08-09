---
id: 3375
title: "baseline-summary-sync host drift-check compares the wrong baseline → landing page silently strands stale/inflated test262 number"
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
related: [1951, 1528, 1078, 2562]
---

# #3375 — baseline-summary-sync host drift-check uses the wrong `--baseline`, stranding the public landing-page number

> **DONE (2026-07-24, status reconcile).** Fix `fix(#3375): baseline-sync host
> drift-check must compare the public file it overwrites` merged to `main` via
> **PR #3272** (`git log origin/main --grep="#3375"`); a `chore(#3375): mark
> done` commit followed but the issue frontmatter stayed `ready`. Reconciled to
> `done` here.

## Symptom

The deployed landing page (`js2.loopdive.com`) showed a **stale AND inflated**
test262 number — **32,788** (generated 07:44Z) — while the honest current
number under oracle-v7 was **32,165**. The gap is not just staleness: 32,788
predates today's assert_throws harness tightening (#3104/#3285), which correctly
reclassified ~600 tests that weren't checking the real thrown error type. So the
public page advertised a number ~600 too high for hours.

## The pipeline (3 hops)

1. **CI promote-baseline** (`test262-sharded.yml`, per push to main) pushes the
   fresh report to the separate repo `loopdive/js2wasm-baselines` — the
   "source of truth."
2. **`baseline-summary-sync.yml` (#1951)** (hourly cron) reads the baselines
   repo and writes `public/benchmarks/results/test262-report.json`.
3. **`deploy-pages.yml`** publishes `public/` to the landing page.

## Root cause (the real bug — not just "cron is unreliable")

`.github/workflows/baseline-summary-sync.yml` decides whether to sync via a
semantic drift check. The **standalone** check correctly compares against the
**public** file it is about to overwrite:

```yaml
--baseline public/benchmarks/results/test262-standalone-report.json \
--candidate /tmp/js2wasm-baselines/test262-standalone-report.json && STANDALONE_UNCHANGED=1
```

But the **host** check compares against the **in-repo** file instead of the
public one:

```yaml
--baseline benchmarks/results/test262-current.json \   # <-- WRONG: in-repo, not public
--candidate /tmp/js2wasm-baselines/test262-current.json && HOST_UNCHANGED=1
```

The commit step (later in the job) copies the baselines report into **both**
`benchmarks/results/test262-report.json` **and**
`public/benchmarks/results/test262-report.json`. So `public/…test262-report.json`
is a **copy target but never the host comparison baseline.**

Failure sequence observed 2026-07-17:
1. A "FORCED baseline refresh" updated the baselines repo **and** the in-repo
   `benchmarks/results/test262-current.json` in lockstep to 32,165.
2. Next sync: host check compares baselines-repo (32,165) against in-repo
   (32,165) → **match → `HOST_UNCHANGED=1`**.
3. Standalone also unchanged → `HOST_UNCHANGED && STANDALONE_UNCHANGED` →
   "nothing to sync" → the job exits **before** the copy step.
4. `public/…test262-report.json` is never rewritten → the landing page stays
   frozen at the pre-refresh **32,788**, indefinitely, even though the sync job
   runs and reports **success** every hour.

The `force` dispatch input does **not** help — it only bypasses the
merge-queue-non-empty guard, which is checked *after* the unchanged-skip.

## Fix

One line: make the host drift check compare against the same public file it
overwrites, mirroring the standalone check.

```diff
- --baseline benchmarks/results/test262-current.json \
+ --baseline public/benchmarks/results/test262-report.json \
```

After this lands, the next sync detects the real public-vs-baselines drift
(32,788 ≠ 32,165) → does the copy → `deploy-pages` republishes → the landing
page shows 32,165. (Dispatch one sync post-merge to correct the page
immediately rather than waiting for the delayed cron.)

## Why it matters / severity

The public conformance number is a credibility-facing figure. This bug let it
silently advertise a stale, inflated value for hours while every layer reported
"success." It is a **change-detection correctness bug**, not a transient — the
in-repo/baselines lockstep makes it permanent until the baselines repo diverges
from the in-repo copy again, which the FORCED-refresh path guarantees it won't.

## Acceptance criteria

- [x] Host drift check compares against `public/benchmarks/results/test262-report.json`.
- [ ] Post-merge: a `baseline-summary-sync` run detects drift and updates
      `public/…test262-report.json` to the current number; landing page reflects it.
- [ ] (Follow-up, separate) consider a guard: sync should also fire when the
      committed `public/` summary is older than the baselines-repo `generated_at`
      by > N hours, independent of the semantic compare, as defense-in-depth.
