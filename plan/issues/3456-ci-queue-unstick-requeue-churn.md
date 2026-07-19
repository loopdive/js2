---
id: 3456
title: "queue-unstick.yml re-enqueue churn cancels in-flight merge_group runs"
status: in-progress
sprint: current
created: 2026-07-19
updated: 2026-07-19
priority: high
horizon: m
feasibility: medium
task_type: bug
area: ci, merge-queue
goal: release-pipeline
related: [3378]
origin: "2026-07-18/19 merge-queue wedge investigation (tech lead, ad-hoc). Workflow disabled as mitigation; this tracks the permanent fix / re-enable decision."
---

# #3456 — queue-unstick.yml dequeue+re-enqueue loop cancels active merge_group runs

## Problem

`queue-unstick.yml` fired on a short (~3 min) cron and, when it detected a
head PR that looked stalled, dequeued and re-enqueued it. Each re-enqueue
**rebuilds the merge group and cancels the in-flight `merge_group` run**
(memory `project_merge_queue_requeue_cancels_run`). During the 2026-07-18
recovery-PR drain this produced sustained cancellation churn — the queue could
not make forward progress because runs were cancelled before they finished.

## Mitigation applied (ad-hoc, 2026-07-18/19)

Disabled `queue-unstick.yml` (`gh workflow disable`) so it stops re-enqueuing.
A genuinely-dangling head (AWAITING_CHECKS with zero `merge_group` runs) still
needs exactly **one** manual dequeue+re-enqueue kick — but never a loop. The
`auto-enqueue.yml` workflow (#2786) remains the primary enqueuer; the shepherd
handles the rare dangling-head kick by hand.

## The real fix (this issue)

Decide the permanent disposition and implement it:
- **Option A — delete the workflow.** With `auto-enqueue.yml` (grace 0) as the
  responsive enqueuer + shepherd/cron backstops, `queue-unstick` may be
  redundant. If so, remove it rather than leave it disabled.
- **Option B — make it safe to re-enable.** Only kick a head that is provably
  dangling (AWAITING_CHECKS **and** zero `merge_group` runs for its SHA for
  >N minutes), kick **at most once** per SHA (idempotency key), and never
  touch a head with an in-flight `merge_group` run.

## Acceptance criteria

- [ ] A decision (A or B) is recorded and implemented via PR.
- [ ] If re-enabled, no code path can re-enqueue a head that has a live
      `merge_group` run.
- [ ] TaskList item "[LEAD] Re-enable queue-unstick.yml after priority PRs
      drain" is resolved by this issue.

## Notes

Currently the workflow stays disabled; this is not a silent state — the
disable is the mitigation, this issue is the follow-through. Related to the
186-gate unblock [[3439]] / #3378 from the same merge-queue-wedge session.
Filed per "file issues for ad-hoc tasks".
