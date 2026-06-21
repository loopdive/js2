---
id: 2517
title: "reliable queue-unstick trigger — fire on CI/Test262 completion, not just the throttled */15 cron"
status: done
completed: 2026-06-19
priority: high
feasibility: easy
reasoning_effort: low
task_type: ci
area: ci, merge-queue
goal: dev-velocity
sprint: 64
related: [2079, 2043]
---

# #2517 — Reliable queue-unstick trigger

## Problem

GitHub's merge queue has a recurring silent-wedge failure mode: the head
entry sits `AWAITING_CHECKS`, the synthetic `gh-readonly-queue` branch
exists, but the `merge_group` workflow runs are never created — the
webhooks silently don't fire. Nothing self-heals for ~3 h (entry timeout),
and the next head often wedges the same way.

`queue-unstick.yml` (`scripts/unstick-merge-queue.mjs`) is the mitigation —
it surgically dequeues + re-enqueues a genuinely-wedged head to force GitHub
to rebuild the merge group and re-fire the webhooks. **But its only trigger
was `schedule: */15` + `workflow_dispatch`.** GitHub deprioritizes scheduled
workflows under load, so the cron is unreliable: on 2026-06-19 it skipped for
~80 min (last fired 11:30, next not until ~12:53), and the queue sat wedged
the entire time until a human noticed and dispatched the unstick manually.

So the self-healing mechanism existed but wasn't reliably *triggered*.

## Root cause

`queue-unstick.yml` lacked an **event-driven** trigger. The sibling
`auto-enqueue.yml` already fires on `workflow_run` completion of
`["Test262 Sharded", "CI"]` (plus a schedule) — an event-driven trigger that
is NOT subject to the scheduled-workflow throttling. `queue-unstick` should
mirror it.

## Fix

Add the same `workflow_run` trigger to `queue-unstick.yml`:

```yaml
on:
  workflow_run:
    workflows: ["Test262 Sharded", "CI"]
    types: [completed]
  schedule:
    - cron: "*/15 * * * *"
  workflow_dispatch:
```

Now the unstick fires on **every** CI / Test262 completion (frequent,
event-driven, un-throttled) in addition to the cron. The script
(`unstick-merge-queue.mjs`) is unchanged — it is already SURGICAL: it acts
only when the head has been `AWAITING_CHECKS` ≥ 12 min with **zero**
`merge_group` runs created since its enqueue, and the only mutation is a
dequeue + re-enqueue of that head. So firing it frequently is safe — it
no-ops on a healthy queue.

## Acceptance criteria

- [x] `queue-unstick.yml` fires on `workflow_run` completion of Test262
      Sharded / CI, not only the `*/15` cron.
- [x] Script logic unchanged (self-gating; no behavior change on a healthy
      queue).
- [x] A wedge now clears within minutes of the next CI completion without a
      manual `gh workflow run` dispatch.

## Notes

- Interim mitigation while this lands: a session-local watchdog
  (`queue-watchdog.sh`) fires the self-gating unstick every 10 min. This issue
  makes that watchdog unnecessary by giving the workflow a durable trigger.
- Related to the `merge_group`-traversal index-shift bug class (#2079/#2043)
  only insofar as both manifest as a stuck queue head; the root causes are
  independent (this is purely a CI trigger-reliability fix).
