---
name: reference_git_checkout_dash_b_silently_does_not_switch
description: "In these worktrees `git checkout -B <new> <start>` and `git switch -c <new> <start>` CREATE the branch but leave HEAD where it was — silently. A following `reset --hard` then lands on the wrong branch. Use two-step: git branch, then git switch."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T07:23:31.318Z
---

Measured 2026-08-02, and it **nearly destroyed a PR branch**.

## The behaviour

```bash
git checkout -B <new> <start-point>     # creates <new>, HEAD DOES NOT MOVE
git switch   -c <new> <start-point>     # same
```

Both report success. Neither switches. The agent believed it was on a fresh
branch, ran `git reset --hard upstream/main`, and **reset the PR branch it was
still standing on**. Recovered only because the commits were already pushed to
the fork.

## Use the two-step form

```bash
git branch <new> <start-point>
git switch <new>
git branch --show-current      # ALWAYS verify — do not trust the exit code
```

Confirmed working in the same session where the one-step form failed.

## Why it is easy to miss

Exit status is **0**. There is no warning. The only tell is `git branch
--show-current`, which nobody runs after a command that "obviously" switched.
Combined with a destructive follow-up (`reset --hard`, `clean -fd`), a silent
no-switch is a branch-loss event rather than an inconvenience.

**Suspect a stale `.git/config.lock` as a contributing cause**: the one-step
forms write upstream-tracking config, and with a stale lock that write fails
(`error: could not lock config file .git/config: File exists` /
`unable to write upstream branch configuration`). In one observed case the
branch was created and the checkout aborted partway. The two-step form does not
need that config write, which is likely why it survives. See the stale-ref-lock
problem in the same repo (22 locks, all 0 bytes, oldest 3 days).

## The general rule

**Always `git branch --show-current` before any destructive git command.** The
pre-commit checklist already says to run `pwd && git branch --show-current`
before `git add`/`commit`; this extends it to `reset`, `clean` and `checkout .`
— which are the ones that cannot be undone from the reflog if the branch itself
was the thing reset.

Related: [[reference_git_corrupt_loose_object_refetch]],
[[feedback_no_git_stash_in_worktree]],
[[reference_merge_queue_snapshots_head_at_enqueue_time]].
