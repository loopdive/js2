---
id: 2548
slug: agents-stop-self-enqueue
title: Dev agents stop self-enqueuing PRs — merge path owned by auto-enqueue (App token) + merge_group + auto-park
status: done
sprint: Backlog
assignee: ttraenkler/sd3
completed: 2026-06-20
feasibility: easy
---

## Problem

Dev agents were self-enqueuing their PRs (GraphQL `enqueuePullRequest` /
`gh pr merge --auto`). This caused two concrete failures on 2026-06-20:

1. **Wrong merge identity.** Agents enqueue via the shared `gh` auth, which is a
   personal PAT (`ttraenkler`). Merges should be attributed to the App/bot, not
   a human contributor.
2. **Cancellation churn (~3.5h on 2026-06-20).** A dev re-enqueuing its own PR on
   a poll loop changes merge-queue membership. Any membership change makes GitHub
   rebuild the merge group, which **cancels the in-flight `merge_group` run** for
   the current head. Symptom: "failed" runs showing 30 success / 0 failure jobs
   (= cancelled, not failed); `quality` passes every cycle; main never advances.
   See memory `project_merge_queue_requeue_cancels_run`.

## Decision (stakeholder, 2026-06-20)

Remove dev agents from the enqueue loop entirely. The merge path is owned by:

1. **`auto-enqueue.yml`** — uses the GitHub **App token** (correct bot identity),
   sweeps every open, non-draft, mergeable PR on each CI completion + a ~10-min
   cron, and enqueues green PRs. Drafts and PRs labelled `hold`/`do-not-merge`/`wip`
   are skipped.
2. **`merge_group` required checks** — the regression gate (`scripts/diff-test262.ts`,
   #1943) re-validates against the merged state and is the hard block.
3. **`auto-park` (#2547)** — labels any PR that fails the `merge_group` re-run as
   `hold` so it can't re-churn; the author fixes and removes the label.

No agent in the enqueue loop ⇒ no membership-churn cancellations, and merges
carry the bot identity.

## New dev terminal flow

push PR → confirm required CI is GREEN → **STOP**. The dev does NOT call
`enqueuePullRequest`, does NOT `gh pr merge --auto`, and does NOT re-queue on
drift. `auto-enqueue` takes green PRs; `auto-park` holds failures; the dev's job
ends at green CI and it claims the next task. ESCALATE to tech lead remains for
genuine judgment calls (regression-gate failures the dev can't fix), but the
outcome is never "enqueue".

## Changes

- `.claude/skills/dev-self-merge.md` — removed the `enqueuePullRequest` enqueue
  step and the drift re-queue instruction; the skill is now an informational
  regression self-check whose outcome is "leave green (auto-enqueue takes it)"
  or "ESCALATE", never "enqueue". Noted that the `merge_group` regression gate +
  `auto-park` now own regression-catching.
- `.claude/agents/developer.md` — dev-loop terminal step no longer enqueues or
  `gh pr merge --auto`s; it leaves the PR green and claims the next task.
