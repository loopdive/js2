---
name: reference_git_init_bare_under_inherited_gitdir_breaks_every_worktree
description: "`git init --bare <path>` with GIT_DIR inherited re-initialises $GIT_DIR instead — with extensions.worktreeConfig it writes core.bare=true to the SHARED config and every worktree in the repo dies"
metadata:
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-31T12:50:17.051Z
---

# A test fixture took the whole repo down for ~4 minutes

**Symptom:** every git command in **every** worktree suddenly fails with
`fatal: this operation must be run in a work tree` — `status`, `add`, `stash`.
Agents unrelated to the cause report it simultaneously.

**Cause chain (2026-07-31):**

1. A test created hermetic fixtures with `git init --bare <path>`.
2. It ran under the **husky pre-commit hook**, which exports **`GIT_DIR`** (and
   `GIT_INDEX_FILE`).
3. **With `GIT_DIR` set, `git init --bare <path>` does not initialise `<path>`** —
   it re-initialises `$GIT_DIR` and writes `core.bare = true` into it.
4. This repo sets **`extensions.worktreeConfig = true`**, so that landed in the
   **shared** `/workspace/.git/config`, not the worktree's `config.worktree`.

**Rule: scrub the git environment before any `git init`/plumbing in a subprocess.**
Clear `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`,
`GIT_OBJECT_DIRECTORY` — and re-add only the one you intend.

**Same latent exposure exists in any script that shells out to git plumbing.**
`claim-issue.mjs` deliberately sets `GIT_INDEX_FILE` for `commit-tree`; invoked
from a hook, an inherited `GIT_INDEX_FILE` would make `read-tree`/`update-index`
**clobber the invoking repo's real index**, and an inherited `GIT_DIR` would aim
cache-repo commands at the wrong repository.

**Diagnosis note:** it is NOT transient and does NOT self-heal. One agent reported
it "self-resolved after a minute" — another agent had fixed it in that minute. If it
recurs with nobody fixing it, waiting does nothing. Check
`git config --file <repo>/.git/config core.bare`; a repo with a working tree,
worktree metadata and reflogs must be `false`.

Related: [[reference_never_git_worktree_prune_inside_container]] — the other way a
single command in one worktree damages every other one.
