---
name: feedback-lead-shepherds-prs
description: When no dedicated PR-shepherd is staffed, the tech lead runs the PR sweep itself each loop (enqueue every green PR); held/failing PRs go to the TOP of the tasklist for the next dev; each agent ACTIVELY enqueues its own PR the moment required checks are green — auto-enqueue is only a backstop.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

The **primary** queue owner is a dedicated standing PR-shepherd (see [[feedback_dedicated_pr_shepherd]]). **When no shepherd is staffed, the tech lead runs the sweep itself** — sweep the open PRs every loop, enqueue every green (CLEAN, non-hold, non-draft) PR into the merge queue one-shot, and drive them to merged. The auto-enqueue cron is a BACKSTOP only, not the primary.

**Why:** PRs strand un-enqueued whenever the queue has no active owner — agents wait on CI/watchers that end before checks settle, and the sparse ~30-min auto-enqueue cron leaves green PRs idle. So the queue always needs a live owner (shepherd, or lead as fallback), AND the authoring agent must self-enqueue its own PR.

**How to apply:**
- Each loop: `gh pr list --state open` → enqueue every CLEAN, non-`hold`, non-draft PR not already in the queue (one-shot GraphQL `enqueuePullRequest`, user PAT). NEVER re-enqueue (loop hazard = re-adding the PR already in the in-flight group; a tail append is safe — see [[project_merge_queue_requeue_cancels_run]], re-verified 2026-08-02).
- Held (`hold` label) or CI-failing / BEHIND / DIRTY PRs → add a high-priority `[CI-FIX]` task at the TOP of the tasklist for the next dev to rebase/fix + re-enqueue.
- Every dev/senior-dev ACTIVELY enqueues its own PR the moment the 3 required checks are green — don't wait for the full matrix or the backstop. See [[feedback_dev_self_serve_tasklist]].
- Codified in CLAUDE.md (Tech lead discipline / Merge protocol) + .claude/skills/dev-self-merge/SKILL.md + the developer/senior-developer agent defs.
