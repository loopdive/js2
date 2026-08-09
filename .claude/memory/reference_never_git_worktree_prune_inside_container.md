---
name: reference_never_git_worktree_prune_inside_container
description: "NEVER run `git worktree prune` (or trust `prunable`) from inside the /workspace container — it deletes the HOST session's live worktree registrations"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-30T21:55:54.785Z
---

# `git worktree prune` inside the container silently kills the host session's worktrees

The js2 repo is **shared between two environments**:

- **container** — sees it at `/workspace`
- **host (macOS)** — sees the SAME repo at `/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm`,
  and creates worktrees at `/private/tmp/js2-*`

They share one `.git`, therefore **one worktree registry**.

## The trap

From inside the container, `/private/tmp/js2-*` does not exist. So
`git worktree list` marks every host worktree **`prunable`**, and
`git worktree prune` deletes their `.git/worktrees/<name>` metadata — while the
host session is actively working in them. Verified 2026-07-30: pruned ~25
registrations, including `js2-3836-control` sitting at the then-current main tip
(minutes old) and `js2-3836-repair`, whose branch advanced
`b96b016 → 0fc0989` **between two of my own commands** — i.e. live.

`prunable` does NOT mean stale. It means "not visible from where I'm standing."

## Recovery — must run ON THE HOST

`git worktree repair` from inside the container CANNOT fix host worktrees (their
`.git` files reference the host gitdir path, unresolvable from here). On the host:

```bash
cd "/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm"
git worktree repair /private/tmp/js2-*        # re-registers by path
```

## The 283 orphans are the same bug, already fired

`/workspace/.claude/worktrees/` held 283 directories with only 3–4 surviving
metadata entries. `git status` inside them fails with *"not a git repository"*.
That is the accumulated residue of this same cross-environment prune — not
ordinary staleness. Deleting them is **not** obviously safe cleanup: check
whether the host still has them registered first.

## Rule

- Do **not** run `git worktree prune` from the container. Ever.
- Do **not** treat `prunable` as a delete signal in this repo.
- Worktree cleanup for this repo is a **host-side** operation.
- Committed work is never lost either way (objects/refs live in the shared
  `.git`); what dies is the registration + any uncommitted working-tree edits.

See [[feedback_check_before_cleanup]], [[feedback_no_nuclear_option]].
