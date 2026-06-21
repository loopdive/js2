---
name: feedback-auto-ff-workspace-main
description: Always auto fast-forward local /workspace main to origin/main whenever origin is ahead (PR merged / someone pushed)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

Always keep local `/workspace` `main` fast-forwarded to `origin/main` — auto-ff it whenever origin is ahead (a PR merged, or another session/the parallel team pushed). Don't let `/workspace` rot behind `main`.

**Why:** the statusline and sprint/issue counts read the local `/workspace` checkout. Agents work in worktrees, so `/workspace` never advances on its own and silently rots behind `main` — which produced a stale "14/67" sprint reading when the real count was 53/82. Keeping it current keeps every local-tree-derived number honest.

**How to apply:**
- Mechanism: `bash scripts/sync-workspace-main.sh` (idempotent — no-op when clean+current, refuses a dirty tree). Wired as a harness hook (settings.json) so it fires automatically, not just when I remember.
- In-session, the merge-wave monitor fires on every origin advance — ff-sync `/workspace` on those events too.
- As of 2026-06-16 (commit 47fd05c73) the sync's dirty-check **EXCLUDES `.claude/memory/`** (live team memory that's almost always dirty), so the auto-ff hook fires reliably despite memory edits — this was the fix for the hook refusing on every run. It still refuses if anything **outside** `.claude/memory/` is dirty (clean/commit that first); a manual `git merge --ff-only origin/main` also works through a dirty memory tree. Relates to [[feedback_always_cd_workspace]].
