---
id: 4073
title: "`enqueue-green-prs` skips a PR with \"awaiting auto-park hold\" when a merge_group ejection produces no hold label (premise corrected: the cron recovers it)"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
---
# `enqueue-green-prs` skips a PR with "awaiting auto-park hold" when a merge_group ejection produces no hold label (premise corrected: the cron recovers it)

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

⚠️ PREMISE CORRECTED 2026-07-28 — the original "wedges a PR FOREVER" claim is FALSIFIED by the timeline. The cron DID recover it. Filed on the evidence available at the time; the fuller record is below.

**Measured timeline for PR #3729** (from the issue timeline API):

| time (UTC) | event | actor |
|---|---|---|
| 13:35:29 | removed_from_merge_queue | github-merge-queue[bot] |
| **14:07:02** | **added_to_merge_queue** | **js2-merge-queue-bot[bot]** ← the ~30-min cron DID re-add it |
| 14:15:52 | removed_from_merge_queue | github-merge-queue[bot] |
| 14:22:12 | added_to_merge_queue | ttraenkler (PAT) |
| 14:28:38 | **merged** | ttraenkler |

So the `enqueue-green-prs` "awaiting auto-park hold" skip is **not permanent** — the cron backstop re-added the PR ~32 minutes after the ejection. The PR was not stranded forever; it was delayed.

**The finding that SURVIVES, and is still worth fixing:** the sweep logs `merge_group-failure — awaiting auto-park hold` and skips, waiting for a label that `auto-park` never applied (the PR's labels were empty throughout). That is a genuinely wrong internal state — the enqueuer is waiting on a condition that will never become true, and only recovers because a separate cron path ignores that state. Relying on one automation to paper over another's bad assumption is fragile: if the cron path is ever gated on the same skip logic, it becomes a real permanent wedge.

**Reduced scope:** make the enqueuer verify the `hold` actually exists rather than inferring "a hold is coming" from a failure record, or bound the wait explicitly. Still needs a positive control proving the recovery path fires. Priority is lower than originally filed — this is a latent trap and a ~30-minute delay, not a permanent stall.

Trigger was the `cla-check` status-POST failure — see the separate task, whose premise also needed correcting (intermittent, not deterministic).
