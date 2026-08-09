---
id: 3466
title: "promote-baseline job skips on ALL merge-queue merges (github.actor == github-actions[bot]) → baseline never auto-refreshes"
status: wont-fix
completed: 2026-07-24
sprint: current
created: 2026-07-19
updated: 2026-07-24
priority: high
horizon: m
feasibility: medium
task_type: bug
area: ci, test262, merge-queue
goal: release-pipeline
related: [3447, 3437, 1528]
origin: "2026-07-19 tech-lead diagnosis while triaging recurring ratio-drift parks (#3318/#3273)."
---

# #3466 — baseline auto-promote skips on every merge-queue merge

> **SUPERSEDED → wont-fix (2026-07-24, status reconcile).** The motivating
> symptom — a stale auto-promoted main baseline causing the regression-ratio
> gate to false-park net-positive PRs — is handled by **#3467/#3468**: the
> regression gate now diffs against the **real per-SHA merge-base cache**
> (`fix(ci): compare test262 gate against real merge-base per-SHA cache
> (#3467)`, merged), not the auto-promoted `main` baseline, so the actor-guard
> promote-skip no longer drives ratio-drift parks. #3468 closed with the honest
> floor rebaselined. The actor-guard cleanup in this issue is therefore no
> longer load-bearing for the queue; closing as superseded rather than doing a
> now-redundant workflow edit. (If landing-page/other-consumer staleness needs a
> dedicated promote-on-queue-merge fix later, file a fresh scoped issue.)

## Problem

The `promote-baseline` job in `.github/workflows/test262-sharded.yml`
("promote merged report to main baseline", ~line 1467) is gated by:

```yaml
if: (github.event_name == 'push' || github.event_name == 'workflow_dispatch')
    && github.actor != 'github-actions[bot]'
    && !(github.event_name == 'workflow_dispatch' && inputs.ir_first)
```

**Every merge-queue merge to `main` is a push authored by
`github-actions[bot]`.** So `github.actor != 'github-actions[bot]'` is FALSE
for all queue merges → the promote job is **skipped** (observed:
`promote merged report to main baseline: completed/skipped` on the #3387 merge
run 29677436346, even though `merge shard reports` succeeded). The baseline
only refreshes on the rare **non-bot** push or a `workflow_dispatch` — and the
dispatch path is itself unreliable (fails at the run level; see below).

Result: the `loopdive/js2wasm-baselines` JSONL goes **stale for hours** while
main advances (observed 21 commits / ~7h behind on 2026-07-19). A stale
baseline makes the PR/merge_group **regression-ratio gate** trip on PRs that
are actually fine (net-positive pass counts, zero trap growth) — they
"ratio-drift-park" (#3318 net +2, #3273 net +25, both `null_deref` flat,
tripping only on ratio %). This is a recurring queue-drain tax.

This is distinct from #3447 (the compile-time guard flake that ALSO skipped
promote via a failing `merge-shard-reports`): #3447 is now fixed, yet promote
STILL skips — because of this **actor guard**, a second independent skip cause.

## Why the actor guard exists (hypothesis) + the fix

The guard almost certainly exists to stop the promote job's OWN commit from
re-triggering the workflow into a loop. But the promote commit already carries
`[skip ci]` (e.g. "…owns the trend now [skip ci]"), which prevents re-trigger
on its own. So the actor guard is redundant-and-overbroad: it also suppresses
the legitimate merge-queue-merge case.

Candidate fixes (pick after verifying the loop-safety):
- **Drop the `github.actor != 'github-actions[bot]'` clause** and rely on the
  `[skip ci]` on the promote commit to break the loop. Verify the promote
  commit path (baselines-repo push + any main summary commit) can't re-enter.
- **Or** gate on the commit message / a marker instead of the actor: run
  promote unless `contains(github.event.head_commit.message, '[skip ci]')` or
  the head commit is the promote job's own signature.
- Add a **staleness self-check** (`scripts/check-baseline-floor-staleness.mjs`
  already exists) that fails/warns loudly in CI when the baselines HEAD falls
  >N commits behind main, so this can't silently rot again.

## Acceptance criteria

- [ ] `promote-baseline` runs (not skipped) on merge-queue merges to `main`.
- [ ] No re-trigger loop from the promote's own commit(s).
- [ ] Baselines-repo JSONL stays within a small commit-lag of main HEAD as the
      queue drains; drift-ratio false-parks stop recurring.

## Notes

Immediate mitigation on 2026-07-19: manual baseline refresh pushed to the
baselines repo (hand-promote from run 29677436346) to unblock #3318/#3273.
This issue is the durable fix so the manual step isn't needed again. Related:
#3447 (guard flake, the OTHER skip cause, fixed), #3437 (harness speed gate),
#1528 (baseline lives in the separate repo).
