---
id: 2547
title: "Auto-park PRs that fail required CI in the merge_group"
status: done
sprint: 64
created: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: medium
task_type: infrastructure
area: tooling
language_feature: n/a
goal: correctness
related: [2519, 2531, 1758]
assignee: "ttraenkler/dev"
---

# #2547 — auto-park PRs that fail required CI in the merge_group

## Problem

After the #2519 slim-down, the full test262 matrix runs **only in the
merge_group**, not on the PR. So a PR can be fully green at PR-time yet carry a
**real** test262/quality regression that surfaces only when the merge queue
validates it on the merged-with-main state. GitHub ejects that PR from the
queue, but `auto-enqueue` (`scripts/enqueue-green-prs.mjs`) still sees it as
PR-green and re-enqueues it. The PR then cycles forever, burning a ~15-minute
merge_group CI run every lap and starving the serial queue.

There is no human or workflow that parks such a PR, so the cycle only stops when
someone notices and hand-labels it.

## Fix

A new additive workflow `.github/workflows/auto-park-merge-group-failures.yml`
listens for the required CI workflows completing (`Test262 Sharded`, `CI`). When
a run was a `merge_group` run that concluded `failure`, it routes to
`scripts/auto-park-merge-group-failure.mjs`, which:

1. Maps the run's `head_branch` (`gh-readonly-queue/main/pr-<N>-<sha>`) → PR N.
2. **Distinguishes a real failure from a cancellation** (see below).
3. On a genuine failure, parks PR N: adds the `hold` label (which
   `enqueue-green-prs.mjs` skips via `HOLD_LABELS`, stopping the re-enqueue
   loop) and posts ONE idempotent comment (HTML-marker guarded) telling the
   author to fix the failure and remove `hold` to re-enqueue.

Labelling + commenting do not trigger a downstream workflow, so the default
`GITHUB_TOKEN` is sufficient (no App token needed). The script is idempotent:
if the PR already carries `hold`, it does nothing.

### Real failure vs cancellation (the critical footgun)

When the merge queue rebuilds a group (membership change: main advanced, a PR
ahead was dequeued, a PR added/removed) it **cancels** the in-flight runs of the
old group. GitHub surfaces that cancellation as a **run-level `failure`** too —
but with **zero failed jobs** (jobs are `cancelled`/`success`/`skipped`, none
`failure`). Parking on those would wrongly hold healthy, merely-re-grouped PRs.

So the script never trusts the run-level conclusion. It fetches the run's jobs
(`repos/<repo>/actions/runs/<id>/jobs`, paginated for the 114-job matrix) and
parks **only when at least one job has `conclusion == "failure"`**. Zero failed
jobs ⇒ cancellation ⇒ do nothing. This is exactly the failure mode recorded in
memory `project_merge_queue_requeue_cancels_run`.

## Acceptance criteria

- New workflow triggers on `workflow_run` { `Test262 Sharded`, `CI` } completion
  and acts only when `event == 'merge_group'` and `conclusion == 'failure'`.
- A genuinely-failed merge_group run → offending PR gets `hold` + one comment.
- A cancelled merge_group run (0 failed jobs) → no action.
- Re-running on an already-parked PR is a no-op (no duplicate comment/label).
- Additive: auto-enqueue / queue-unstick / merge-group-sweeper unchanged.
- `node scripts/auto-park-merge-group-failure.mjs --self-check` passes (branch
  parse + failure/cancellation classification, no network).

## Files

- `.github/workflows/auto-park-merge-group-failures.yml` — the trigger + gate.
- `scripts/auto-park-merge-group-failure.mjs` — mapping, real-vs-cancellation
  classification, parking, and the `--self-check` unit checks.
