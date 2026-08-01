---
name: feedback_draft_pr_until_final
description: "Keep a PR DRAFT only while genuinely iterating; a completed Codex PR must be READY/non-draft and must never be handed off as a draft"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

Open/keep a PR as **DRAFT** only while it is genuinely unfinished or a known follow-up push is still required. As soon as a coherent Codex change is complete, mark it **"Ready for review"**. **Never leave or hand off completed Codex work as a draft.**

**Why:** the auto-enqueue backstop merges a PR the moment its checks go green — but "green" fires mid-work, not at "done". A green non-draft PR gets queued, which LOCKS the branch (you can't push to a queued PR), so later commits can't land and the queue merges the stale half. This stranded CPR-2 on 2026-05-30 (#963 merged at the CPR-1-only SHA; for-of+param got left behind). Drafts are never auto-enqueued, so draft-until-final turns the "green" check-state signal into an explicit author "ready" decision — the real fix.

**How to apply:** (1) open cross-slice / multi-commit / still-iterating PRs as draft; (2) the moment the diff is complete and merged-with-current-main, convert it to ready before handoff; (3) for cross-dependent PRs (one must land before another updates), keep the dependent draft only until its prerequisite lands and the dependent diff is finalized. Auto-enqueue (`.github/workflows/auto-enqueue.yml`, `scripts/enqueue-green-prs.mjs`) is **RE-ENABLED** (2026-05-30, on user instruction) — **draft-until-final is the guardrail that makes it safe**: only non-draft mergeable PRs are swept, so keeping a PR draft until its diff is final keeps the "green ⇒ enqueue ⇒ branch locked" race from ever triggering mid-iteration. Drafts and PRs labelled `hold`/`do-not-merge`/`wip` are never auto-enqueued. If the merge_group queue stalls (it did intermittently this session), the tech-lead admin-merges the final PR directly (dequeue via GraphQL `dequeuePullRequest`, then `GATE_BYPASS=1 gh pr merge --merge --admin`) — but that's the exception, not the default. Relates to [[feedback_serialize_cherry_picks]].
