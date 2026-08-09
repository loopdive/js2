---
id: 3456
title: "queue-unstick.yml re-enqueue churn cancels in-flight merge_group runs"
status: done
completed: 2026-07-24
sprint: 77
created: 2026-07-19
updated: 2026-07-30
priority: high
horizon: m
feasibility: medium
task_type: infrastructure
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

## Resolution — Option A (delete), 2026-07-24

**Deleted** `queue-unstick.yml` + `scripts/unstick-merge-queue.mjs`.

Discriminator that decided A over B: `unstick-merge-queue.mjs` last changed
2026-07-13 (commit `7d4a48c`), **before** the 2026-07-18/19 churn — so the
version that churned was **already** gated (12-min stall, de-alias
`created_at >= enqueuedAt`, "zero `merge_group` runs → nudge else no-op").
It still churned. Option B means adding more guards without a named
root-cause for why the existing guards failed — hardening a footgun blindly.
Combined with the fundamental hazard (a dequeue+re-enqueue rebuilds the
merge group and CANCELS the in-flight `merge_group` run — memory
`project_merge_queue_requeue_cancels_run`) and the fact that
`auto-enqueue.yml` (grace 0) is now the responsive enqueuer with
shepherd/cron backstops, the automated unsticker is net-harmful redundancy.

The rare genuine dangling head (AWAITING_CHECKS + zero `merge_group` runs
for its SHA > 12 min) now gets **one** manual, human/shepherd-initiated
dequeue+re-enqueue kick — never a loop. That procedure is documented in
`docs/ci-policy.md` §3 "Merge-queue wedge recovery — manual, one-shot only".

Comment references to `queue-unstick.yml` in sibling CI files
(`approve-fork-runs.yml`/`.mjs`, `auto-park-merge-group-failure.mjs`,
`auto-park-merge-group-failures.yml`) were trimmed to avoid dangling
references. The workflow was already `disabled_manually` on GitHub since the
2026-07-18/19 mitigation; this deletion makes that permanent and explicit.

## Acceptance criteria

- [x] A decision (A or B) is recorded and implemented via PR. **Option A.**
- [x] If re-enabled, no code path can re-enqueue a head that has a live
      `merge_group` run. **N/A — the workflow is deleted; no automated
      re-enqueue path exists.**
- [x] TaskList item "[LEAD] Re-enable queue-unstick.yml after priority PRs
      drain" is resolved by this issue. **Resolved by deletion — nothing to
      re-enable.**

## Notes

Related to the 186-gate unblock [[3439]] / #3378 from the same
merge-queue-wedge session. Filed per "file issues for ad-hoc tasks".
