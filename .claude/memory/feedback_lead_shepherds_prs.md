---
name: feedback-lead-shepherds-prs
description: Tech lead ALWAYS shepherds open PRs to the merge queue + merged each loop; held/failing PRs go to the TOP of the tasklist for the next dev to fix; each agent ACTIVELY enqueues its own PR the moment the required checks are green — auto-enqueue is only a backstop.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

User directive (2026-06-22): As tech lead, ALWAYS shepherd the open PRs — sweep them every loop, enqueue every green (CLEAN, non-hold, non-draft) PR into the merge queue one-shot, and drive them to merged. The auto-enqueue cron is a BACKSTOP only, not the primary.

**Why:** PRs were stranding un-enqueued — agents waited on CI/watchers that ended before checks settled, and the sparse ~30-min auto-enqueue cron left green PRs idle. The lead AND the authoring agent must both actively enqueue.

**How to apply:**
- Each loop: `gh pr list --state open` → enqueue every CLEAN, non-`hold`, non-draft PR not already in the queue (one-shot GraphQL `enqueuePullRequest`, user PAT). NEVER re-enqueue (loop hazard, see [[project_merge_queue_requeue_cancels_run]]).
- Held (`hold` label) or CI-failing / BEHIND / DIRTY PRs → add a high-priority `[CI-FIX]` task at the TOP of the tasklist for the next dev to rebase/fix + re-enqueue.
- Every dev/senior-dev ACTIVELY enqueues its own PR the moment the 3 required checks are green — don't wait for the full matrix or the backstop. See [[feedback_dev_self_serve_tasklist]].
- Codified in CLAUDE.md (Tech lead discipline / Merge protocol) + .claude/skills/dev-self-merge.md + the developer/senior-developer agent defs.
