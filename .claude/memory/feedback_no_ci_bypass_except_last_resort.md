---
name: feedback-no-ci-bypass-except-last-resort
description: "Don't bypass CI tests (admin-merge) to unblock — it's a last resort only after everything else is exhausted"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

Bypassing the CI tests (e.g. `gh pr merge --admin` to skip the test262 / quality
gate) is **usually a bad idea** and is **only an option once everything else is
exhausted**. Stated by the user 2026-06-20 during the merge-queue saga, right as
a run that could finally complete surfaced a real signal — vindicating NOT
admin-merging the stuck PRs.

**Why:** the gate exists to catch real regressions. The 3 stuck PRs' runs had
all been *cancellations* (looked like failures but were churn — see
[[project_merge_queue_requeue_cancels_run.md]]), so they were never actually
validated. Admin-merging "clean" PRs that never completed a run would have
landed them unvalidated — possibly regressing test262 on main.

**How to apply:** exhaust the real fixes first — stop the churn source (agents /
queue-unstick), let a run complete, fix any genuine regression it finds, OR
renumber/rebase. `--admin --merge` stays reserved for workflow-only / hotfix
bypass (per docs/ci-policy.md), not for routing around a red feature-PR gate.
When tempted to admin-merge to "just unblock", that's the signal to find the
actual blocker instead.
