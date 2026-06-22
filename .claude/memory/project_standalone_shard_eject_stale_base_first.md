---
name: project_standalone_shard_eject_stale_base_first
description: "A merge_group eject on \"test262 standalone shard N\" — check branch staleness vs origin/main FIRST; a stale base fails the raised standalone floor even with correct code"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

When a PR ejects from the merge_group on a **"test262 standalone shard N"**
failure (+ "merge shard reports"), the FIRST thing to check is how many commits
the branch is **behind origin/main** — not the diff.

Why: the standalone-floor/per-shard regression gate is raised by every push to
main (`promote-baseline`). The merge_group tests the **speculative merge** of the
branch onto *current* main. A branch based on an old main (e.g. 49 commits
behind) is missing later standalone-improving PRs + baseline syncs, so its
speculative-merged standalone pass count can fall below the **raised** floor —
ejecting even when the branch's own change is correct. PR-level checks
green-SKIP the heavy standalone shards, so this only ever surfaces in the
merge_group. See [[project_standalone_floor_only_on_merge_group]].

Diagnostic order:
1. `git rev-list --count HEAD..origin/main` — if large, the eject is likely
   stale-base drift. `git merge origin/main` (clean), re-validate, re-push.
2. Only if still failing post-merge: bisect the actual flipped standalone test
   (run the shard's `runTest262Chunk(N-1, 57)` with `TEST262_TARGET=standalone`)
   and look for a real code regression.

Confirm the change itself is sound with a fast targeted standalone sweep
(`WebAssembly.validate` + value + zero host-import-leak) rather than a full
chunk run — full chunk56 standalone is slow (10+ min) and rarely needed.

Merge-queue SHAs are speculative + GC'd fast, so the exact failing test from a
GC'd merge_group run is usually unrecoverable — reproduce locally instead.
NEVER `git stash` in a worktree to A/B-test (shared stash stack clobbers
concurrent agents); use a separate pristine `git worktree add <p> origin/main`.
