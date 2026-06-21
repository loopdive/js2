---
id: 2561
title: "docs(workflow): dev-self-enqueue-once + auto-enqueue backstop (revert Option 1)"
status: done
sprint: Backlog
assignee: ttraenkler/dev-docs
completed: 2026-06-20
---

# docs(workflow): dev-self-enqueue-once + auto-enqueue backstop

## Problem

The merge workflow had drifted to an "agents-never-enqueue" model (Option 1),
relying on the `auto-enqueue.yml` cron as the *primary* enqueuer. That cron is
deliberately sparse (~30 min) and only fires on a CI-completion event, so green
PRs sat un-enqueued for long idle stretches all session — the tech lead had to
hand-enqueue everything.

The churn that originally motivated Option 1 came specifically from agents
**looping** re-enqueues (re-adding a PR on every drift / ejection / CI failure),
which cancelled in-flight merge groups. It did **not** come from one-shot
enqueues.

## Decision (user)

Revert Option 1. New model:

- **Devs self-enqueue EXACTLY ONCE** when their PR's required checks are all
  green, via the GraphQL `enqueuePullRequest` mutation (user PAT — NOT
  `gh pr merge --auto`, which silently no-ops on an already-green `CLEAN` PR;
  NOT `GITHUB_TOKEN`, which suppresses the `merge_group` event). Then **stand
  down** — mark the task completed and move on.
- **NEVER re-enqueue** on drift / ejection / CI failure. The auto-enqueue
  backstop owns ALL re-adds (or escalate to the tech lead). Re-enqueue LOOPS
  were the sole cause of the original merge-queue cancellation churn.
- **Auto-enqueue is the BACKSTOP, not the primary** — it runs on every
  CI-completion + every ~30 min and re-adds any open, non-draft, mergeable PR
  that strands. The back-off fix #2560 (merged) makes it reliable as a
  backstop, so one-shot-enqueue-then-stand-down is safe.

## Security boundary

Dev-self-enqueue is for **internal / trusted dev agents only**. External
contributor PRs still require auto-enqueue's author-trust gate (or a deliberate
maintainer enqueue) plus a green `cla-check` — no regression there.

## Changes

Updated, consistently:

1. `.claude/skills/dev-self-merge.md` — terminal step = enqueue ONCE when green,
   verify queued, mark completed, stand down; added the EXACTLY-ONCE / never-re-enqueue
   rule and rewrote the "If the queue rejects your PR" section to hand re-adds to
   the backstop instead of looping.
2. `.claude/agents/developer.md` — flipped the fire-and-forget protocol and the
   merge-step CI-completion table to "enqueue once when green → stand down";
   replaced the wrong `gh pr merge --auto` instruction with the GraphQL mutation.
3. `.claude/agents/senior-developer.md` — added an explicit pointer to the
   enqueue-exactly-once rule.
4. `CLAUDE.md` — merge-protocol + dispatch sections describe the new model
   (dev enqueues once when green; auto-enqueue = backstop; cite #2560 and the
   30-min-cron-too-sparse-for-primary rationale).

Docs-only change; no `src/**` changes.
