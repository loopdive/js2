---
name: reference_precommit_hook_exceeds_tool_timeout_leaves_stash_debris
description: "The pre-commit hook runs lint-staged (~10 min under load) but the Bash tool times out at 2 min — lint-staged has already taken a `git stash` backup, so every timed-out commit leaves debris on the SHARED stash stack. Background all commits here."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T06:58:52.462Z
---

**Measured 2026-08-01 — hit by two agents independently in one session.**

`pre-commit` runs `lint-staged`, which executes prettier + biome + the issue's
full test file + four gates. Under load that is **~10 minutes**. The Bash tool
times out at **2 minutes**. So a foreground commit here is a coin flip, and
losing it is not free:

**`lint-staged` takes a `git stash` as its automatic backup before running.**
When the tool timeout kills the hook mid-run, that stash is orphaned. Observed:
`stash@{0}` and `stash@{1}` both `lint-staged automatic backup`, from at least
two different agents.

**Why this compounds:** `refs/stash` is a **single shared stack across every
worktree of the repo** (it lives in the common `.git` dir). So debris
accumulates from every agent, and `git stash pop` takes whatever is on top —
very likely someone else's. That has already destroyed real work here (546
lines of `native-strings-rewrite.ts`, 240 of `src/runtime.ts`, recoverable only
as dangling commits).

**Rules:**

- **Always background the commit** (`run_in_background: true`) and poll. Never
  run `git commit` in the foreground on this repo.
- **Never `pop` / `drop` / `clear` the stash**, including entries that look
  stale or "obviously" yours. Attribute first: a stash message
  `WIP on worktree-agent-<id>` identifies the owner; `lint-staged automatic
  backup` does **not**, so those are unattributable from the message alone.
- **After a timed-out commit, check `git status` and `git log -1` before
  retrying** — the commit may have actually landed despite the timeout being
  reported.
- For A/B revert cycles use **file copies**, never stash:
  ```bash
  cp src/foo.ts .tmp/new.ts
  git show HEAD:src/foo.ts > .tmp/base.ts
  ```

Recovery if someone already popped blind: `git fsck --unreachable | grep commit`,
then `git log -1 --format=%s <sha>` on each; restore with
`git checkout <sha> -- <paths>` and pin via `git update-ref` before GC.

Related: [[reference_silent_empty_is_indistinguishable_from_real]] (a timed-out
command reporting failure is not evidence the work did not happen).
