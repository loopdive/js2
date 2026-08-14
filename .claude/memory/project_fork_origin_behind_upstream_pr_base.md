---
name: project_fork_origin_behind_upstream_pr_base
description: "js2 fork origin/main lags upstream/main by ~1000+ commits; triage issues against upstream, not origin/main or local frontmatter"
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

In the js2 (ttraenkler/js2) dev setup, the **fork's `origin/main` is ~1000–1165
commits BEHIND `upstream/main` (loopdive/js2wasm)**, the real PR base. Merged PRs land
on upstream; the fork mirror lags badly. Consequences:

- Issue **frontmatter `status`/`assignee` lags merged code** — an issue can read
  `status: in-progress` / look "free" locally while its dev-tractable work is
  already merged on upstream. (#2200 Phase 1 was merged via PR #1764 on upstream
  but absent from the fork; it kept getting re-dispatched as "free, highest
  impact.")
- **Triage and worktrees must branch from `upstream/main`**, not `origin/main`.
  `git fetch upstream && git worktree add <wt> -b <branch> upstream/main`.
  Probe repros against an upstream worktree to get ground truth.
- **Verify done-ness on upstream**: `git show upstream/main:plan/issues/<file>`
  for frontmatter (look for `phaseN: done`, `phaseN_rework: <id>`), and
  `git show upstream/main:src/...` + grep for the fix symbol.
- Open PRs **drift to BEHIND/DIRTY vs upstream** as upstream advances under them —
  merge `upstream/main` (NOT `origin/main`) into the branch to resolve.

Before claiming any "free" issue, probe it against upstream/main first; the local
view systematically over-reports remaining work. See [[feedback_reground_spec_against_current_main]].
