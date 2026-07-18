---
id: 3382
title: "Baseline goes stale under high PR velocity — main-audit push loses all retries; make baselines-repo push resilient"
status: in-progress
sprint: current
created: 2026-07-17
updated: 2026-07-17
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: infrastructure
area: tooling
language_feature: n/a
goal: correctness
assignee: "ttraenkler/senior-dev"
---

> **Status note:** kept at `in-progress` (not `done`) in this impl PR on
> purpose. The `quality` gate's #2093 issue→probe-coverage check fails any issue
> (created ≥ 2026-06-15) that flips to `done` without citing a `tests/…` /
> `test262/…` probe path — which this CI-infra issue legitimately has none of.
> It will be reconciled to `done` post-merge (the reconciler / a follow-up doc
> commit), per the tech-lead-confirmed workaround (cf. #3298→#3375).

## Problem

The on-push `promote-baseline` (`test262-sharded.yml`) uses SHA-unique
concurrency groups, so post-merge pushes do NOT cancel each other (correct — do
not change). But the promote's **main audit-commit push** uses an Option-A
re-anchor loop of only **5 attempts** (in `test262-sharded.yml` promote-baseline
"Commit refreshed summary JSON to main repo" AND `refresh-baseline.yml`'s "Commit
baseline refresh to main (audit trail)").

Under sustained two-lane merge velocity (24+ open PRs on 2026-07-17), `main`
advances between the fetch and the push on every one of the 5 attempts, so all 5
retries lose the race -> the promote job is marked FAILURE (verified: 99/100 jobs
success, 1 fail = the push loop) -> the committed `benchmarks/results/*.json`
baseline + the synced prose-doc conformance numbers don't land. That freezes the
committed main summary (the dashboard's committed-file fallback + report.html
input) and shows a phantom regression in `git status`.

Separately, `refresh-baseline.yml`'s baselines-repo push ("Deploy to baselines
repo") is a **single-shot `git push`** with no re-anchor loop, unlike
`test262-sharded.yml`'s 8-attempt Option-A loop. Under a cross-workflow race
(a concurrent `promote-baseline` push to `js2wasm-baselines`) that single push is
rejected non-fast-forward and the whole backstop refresh fails — exactly when an
emergency refresh is most needed.

## Root cause

- Main-advance race >> a 5-attempt loop under continuous two-lane velocity.
- The baselines-repo push (the PUBLIC source of truth — it feeds
  `baseline-summary-sync.yml`) is a **separate, earlier step** than the main-audit
  push in both workflows, so a main-audit failure already cannot undo it. But in
  `refresh-baseline.yml` that public push has no retry, so it can fail on its own
  under a race.

## Fix

- **(b) Increase the main-audit re-anchor loop 5 -> 14** with capped
  exponential-ish backoff (`min(attempt*5, 30)s`), in BOTH `test262-sharded.yml`
  promote-baseline and `refresh-baseline.yml`. Under continuous main-advance a
  larger loop eventually wins; the capped backoff keeps total wait bounded
  (~5+10+15+20+25+30\*9 ≈ 5 min worst case).
- **(a) Make `refresh-baseline.yml`'s baselines-repo push resilient** by wrapping
  it in the SAME proven Option-A re-anchor loop `test262-sharded.yml`'s
  promote-baseline uses for its baselines push (snapshot the promoted files,
  fetch, hard-reset onto the fresh remote tip, re-apply, re-commit, push; 8
  attempts, capped backoff). The baselines-repo push stays BEFORE the main-audit
  push (ordering preserved), so a later main-audit failure never masks a
  successful public push.
- Concurrency (SHA-unique groups) is UNCHANGED — it is correct; pushes must not
  cancel each other. No merge-queue churn, no re-enqueue loops introduced.
- **(d) Debounce the floor-staleness auto-heal (`baseline-floor-staleness-alert.yml`,
  #2178).** That alert fires on `workflow_run` after EVERY "Test262 Sharded"
  completion on push:main (plus hourly) and, on a floor breach, dispatches an
  emergency `refresh-baseline.yml`. Because refresh-baseline was HOST-ONLY
  (#3381), the STANDALONE floor never healed → the same breach recurred forever →
  a fresh emergency refresh (57, now 114 shards) was re-dispatched every ~15 min,
  perpetually occupying the runner pool and STARVING the merge queue's own checks
  (2026-07-17: queue head sat AWAITING_CHECKS ~1h). The `#3381` standalone-heal is
  the real loop-breaker (once the standalone floor is fresh, the breach flips
  false and nothing is dispatched); this issue ADDS a debounce so the auto-heal
  step skips dispatching when a refresh-baseline run is already queued/in_progress
  — bounding the damage during the heal transition and under sustained
  main-advance.

## Third symptom (the dispatch storm + merge-queue starvation)

`baseline-floor-staleness-alert.yml`'s staleness check
(`scripts/check-baseline-floor-staleness.mjs`) reads the `baseline_sha` of
`test262-standalone-current.json` + `test262-current.json` in the baselines repo.
`#3381` now promotes a fresh `test262-standalone-current.json` (with
`--baseline-sha`) on every refresh, so the standalone lane heals and the breach
stops recurring. The added debounce (this issue) prevents overlapping dispatches.

**MANUAL ACTION REQUIRED post-merge (cannot be done via a PR file change):**
`baseline-floor-staleness-alert.yml` was **manually disabled** by the tech lead
on 2026-07-17 (`gh workflow disable baseline-floor-staleness-alert.yml`) to stop
the storm. A manually-disabled workflow's state is stored in GitHub, NOT in the
file, so merging this PR does NOT re-enable it. Once this PR lands, run
`gh workflow enable baseline-floor-staleness-alert.yml -R loopdive/js2` (the gh
slug that resolves in this container) to restore the floor-staleness safety net —
it is now safe because standalone heals
(#3381) and the auto-heal is debounced.

## Acceptance criteria

- Both main-audit loops retry 14x with capped backoff; error message updated.
- `refresh-baseline.yml`'s baselines-repo push retries under a race and lands the
  PUBLIC standalone+host baseline even when the main-audit push later loses.
- No change to SHA-unique concurrency; no new merge-queue churn.

## Implementation Notes (WHY)

- **Why 14, not "infinite".** A bounded loop with capped backoff eventually wins a
  continuous race without unbounded job time; 14 x cap-30s ≈ 5 min ceiling sits
  comfortably under the job's runtime budget. The hourly `baseline-summary-sync.yml`
  (6h staleness floor) + the 8h `refresh-baseline` cron are the outer backstops if
  14 still loses (transient, self-heals next cycle).
- **Why the baselines push must be resilient independently.** The committed-main
  JSON is only a dashboard FALLBACK; the LIVE public number comes from the
  baselines repo via the hourly sync. So the baselines-repo push landing is what
  keeps the public page fresh. It already runs first (before main-audit) in both
  workflows, so a main-audit failure can't abort it — the only remaining gap was
  refresh-baseline's single-shot push, now given the proven re-anchor loop.
- **Not done here / deferred:** tightening the `refresh-baseline` cron 8h -> 2-4h
  (defense-in-depth) was considered but NOT taken — it runs full test262 (now 2x
  the shards after #3381) and (a)+(b) are the real fix. Left as a possible
  follow-up if freshness floor proves insufficient.
