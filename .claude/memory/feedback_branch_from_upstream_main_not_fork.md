---
name: feedback_branch_from_upstream_main_not_fork
description: "Branch ALL work from upstream/main (loopdive/js2wasm), never the fork origin/main — the fork is ~1188 commits behind, causing CONFLICTING PRs, CI that never triggers, and silent duplicate work"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

The fork `origin/main` (ttraenkler/js2) was **~1188 commits behind** upstream
`loopdive/js2wasm` (2026-06-21). PRs target upstream, so a branch cut from
`origin/main` has a stale base → the PR shows CONFLICTING/DIRTY, the required
`pull_request` CI workflows never trigger (only `cla-check` runs), and — worst —
the bug may already be fixed upstream, so the whole slice is silent duplicate
work.

**Concrete cost (my sprint-64 session):** I cut 6 PRs from `origin/main`. When I
finally `git fetch upstream` + probed each bug against `upstream/main`, FOUR of
six were already fixed upstream (Object.create descriptors, objlit data+accessor,
tagged-template, builtin-subclass __get_undefined/__tag_user_class) — only
DisposableStack.prototype (#1815b) and Number.toLocaleString (#1806) still
reproduced. Every PR had also been silently un-CI'd the whole time.

**Why:** CLAUDE.md still says "branch from origin/main", but that guidance is
**stale** until the fork is synced. The fork doesn't auto-track upstream.

**How to apply:**
- `git remote -v` confirms `upstream = loopdive/js2wasm`. Always `git fetch upstream`
  first.
- Branch from `upstream/main`: `git worktree add <wt> -b <branch> upstream/main`.
- **Probe the bug against `upstream/main` BEFORE writing any fix** (mirrors
  [[project_2203_already_landed_duplicate]] and
  [[project_sprint64_parallel_session_dup_prs]]) — the upstream team may have
  already landed it.
- Existing stale-fork PR branches: recreate from `upstream/main` and
  `--force-with-lease` push (force-push on your OWN PR branch is fine; never on
  public main).
- Resolve plan/*.md conflicts with `--theirs` (upstream); re-apply only your src
  edit.
