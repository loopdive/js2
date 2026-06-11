---
id: 1952
title: "CI: cancel in-flight test262 merge_group runs whose queue ref is gone (obsolete group sweeper)"
status: done
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: medium
feasibility: easy
reasoning_effort: low
sprint: 61
area: ci
---
## Problem

When the merge queue rebuilds a group (main advanced, a PR ahead was dequeued),
the old `gh-readonly-queue/main/pr-N-<sha>` ref dies — but its in-flight
test262-sharded run keeps burning to completion. The workflow's
`cancel-in-progress` cannot help: the concurrency group key includes the ref,
and a rebuilt group is a *different* ref, so nothing ever cancels the orphan.

Observed 2026-06-10: two obsoleted full-matrix runs for PR #1283 (runs
27310142420, 27310300685) ran to green for refs that no longer existed —
~6 runner-hours wasted in one churn event.

## Fix (implemented by this issue's PR)

New workflow `merge-group-sweeper.yml`:

- Triggers: `push` to main (the moment churn happens) + 15-min schedule +
  dispatch. Permissions: `actions: write`.
- Lists `queued`/`in_progress` runs of test262-sharded.yml with
  `event=merge_group`; for each, checks whether `head_branch` still exists via
  the branches API. 404 → the group is dead → cancel the run.
- Never cancels a run whose ref still exists (live groups are untouched), and
  treats any API error as "ref exists" (fail-safe: don't cancel).

## Acceptance criteria

- After a push to main with k PRs queued, the orphaned merge_group runs are
  cancelled within ~1 min instead of running 4–12 min to completion.
- No live merge_group run (existing queue ref) is ever cancelled.
