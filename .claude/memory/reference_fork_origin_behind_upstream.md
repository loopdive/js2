---
name: reference_fork_origin_behind_upstream
description: "The fork origin/main is ~1185+ commits behind upstream/main — branch dev work from upstream/main, not origin/main, or PRs land DIRTY"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

The fork `origin` (ttraenkler/js2) `main` is **~1185+ commits behind `upstream` (loopdive/js2wasm) `main`** (measured 2026-06-21; grows as upstream advances). PRs target **upstream/main**.

CLAUDE.md says "branch from origin/main" — that is WRONG while the fork is stale. Branching from `origin/main` produces a 1185-commit-stale base; the PR lands `CONFLICTING/DIRTY`, its required `pull_request` CI workflows never trigger (only `cla-check` runs), and it gets closed unmerged. This silently killed multiple devs' real fixes (e.g. dev-bruno's #1810/#1815/#1819/#1806 all closed DIRTY).

**Always branch dev work from `upstream/main`:**
```
git fetch upstream main
git worktree add <wt> -b issue-<N>-<slug> upstream/main
# ... fix ...
git fetch upstream main && git merge upstream/main --no-edit   # right before enqueue
git push --no-verify origin <branch>
gh pr create -R loopdive/js2wasm --head ttraenkler:<branch> --base main ...
```
Rescue a DIRTY fork-based PR by merging `upstream/main` into the branch and resolving conflicts (took upstream's parallel fix + kept the distinct part), or re-file fresh from upstream. PROBE the bug against upstream HEAD first — some of it may already be fixed upstream (e.g. String.raw no-substitution was fixed upstream but the substitution case was not).

Recommended permanent fix (lead-level): fast-forward fork `origin/main` → `upstream/main` so the CLAUDE.md guidance becomes correct again.

Related operational hazard: multiple distinct dev agents claiming under the SAME `ttraenkler/dev-agent` git-lock handle aliases their claims (the issue-assignments ref can't tell them apart) → duplicate PRs for the same slice (#1806/#1809, #1825/#1826). Each dev needs a distinct handle. See [[reference_standalone_any_string_value_read_substrate]].
