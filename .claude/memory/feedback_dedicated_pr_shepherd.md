---
name: feedback-dedicated-pr-shepherd
description: "Always keep a dedicated PR-queue shepherd as a standing team role; don't let the tech-lead hand-shepherd the merge queue ad-hoc"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

Always staff a **dedicated PR-queue shepherd** as a permanent part of the team (alongside devs / PO / architect), every sprint and session — not an ad-hoc tech-lead duty.

Its job: keep the GitHub merge queue draining to `main` — enqueue stranded CLEAN PRs (GraphQL `enqueuePullRequest`, never `gh pr merge --auto` which no-ops on already-green PRs), `update-branch` BEHIND PRs past the standalone guard fix, triage/park or close DIRTY PRs (draft/close to stop monitor thrash), reconcile merged PRs → TaskList + issue `status: done`, and escalate only genuine CI failures.

**Why:** PR shepherding is continuous, easily-dropped work. When the tech-lead does it ad-hoc it both causes churn and gets neglected when the lead is busy orchestrating (a 9-PR backlog stranded with an empty queue on 2026-05-29; recurring DIRTY echoes burned loop cycles in sprint 62). A dedicated shepherd makes drainage reliable and frees the lead.

**How to apply:** Spawn a PR-shepherd teammate at session/sprint start as a standing role. In sessions that **cannot** spawn persistent teammates (background jobs limited to synchronous subagents), the persistent layer is the queue-shepherd **Monitor** + `.github/workflows/auto-enqueue.yml` backstop (`scripts/enqueue-green-prs.mjs`, every 10 min) — and spawn the dedicated agent at the next interactive opportunity. Record the role in `plan/method/team-setup.md`. Related: [[feedback_no_ci_wait]] (CI monitoring is not dev work), [[feedback_reduce_notification_noise]].
