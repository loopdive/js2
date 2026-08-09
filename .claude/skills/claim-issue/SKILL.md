---
name: claim-issue
description: Atomically claim an issue for a developer (human or agent) via the cross-developer lock ref, so two devs never pick up the same task. Syncs with origin first, refuses if already claimed or already done on main, and pushes the claim immediately without touching main or triggering CI.
---

# /claim-issue — atomic cross-developer issue claim (#2168)

With several developers (humans + agents, possibly across forks) on the project,
the in-memory TaskList is invisible to other devs. Before starting work on an
issue you MUST take a **git-backed lock** so nobody else grabs the same task.

The lock lives on a dedicated orphan ref — `refs/heads/issue-assignments` on
`origin` — holding one `<id>.json` per claimed issue. Pushing there does **not**
move `main`, so it never rebuilds queued merge groups (#1951) and never triggers
CI. The first `git push` wins; a concurrent claimant gets a non-fast-forward
rejection, re-fetches, and re-evaluates.

## Claim before you start

```bash
# Humans:
node scripts/claim-issue.mjs <id> <your-name>

# Dev agents — use your github-account-prefixed name:
node scripts/claim-issue.mjs <id> ttraenkler/<agent-name> --branch issue-<id>-<slug>
# (or set CLAIM_GITHUB_ACCOUNT=ttraenkler and pass just <agent-name>)
```

The script does the sync-and-check for you, in this order:
1. `git fetch origin` (the assignment ref **and** `main`).
2. Refuse (exit **4**) if the issue is already `done`/`wont-fix` on `origin/main`.
3. Refuse (exit **3**) if it's already claimed by someone else — STOP and pick
   another issue. (Pass `--force` only to deliberately steal, e.g. reclaiming a
   suspended branch.)
4. Otherwise write `<id>.json` and push to the ref immediately.

**Interpret the exit code, don't just read the text:**
- `0` — you own it. Proceed: create your worktree, set the issue's `status:
  in-progress` + `assignee:` in your branch (lazy reflection onto `main` lands
  with your PR), implement.
- `3` — taken. Pick the next candidate.
- `4` — already closed on main. Skip; flag the tech lead to reconcile the queue.
- `5` — push kept getting rejected (heavy contention). Just re-run.

## Inspect / release / complete

```bash
node scripts/claim-issue.mjs --list                 # all live claims (id, assignee, branch)
node scripts/claim-issue.mjs --check <id>           # is #<id> free? (exit 0 free / 3 taken)
node scripts/claim-issue.mjs --release <id> <name>  # abandon/suspend — frees it for others
node scripts/claim-issue.mjs --complete <id>        # mark done when your PR merges
```

Always `--release` when you suspend or abandon a branch so the issue doesn't
stay locked. `--complete` is optional bookkeeping (the merged PR's `status: done`
on `main` is the real signal); use it to keep `--list` clean.

## Why a separate ref instead of committing to main

Committing the claim to `main` would satisfy "everyone sees it", but **any** push
to `main` — even with `[skip ci]` — rebuilds every queued merge group (full
114-job validation per queued PR, ~10 min latency each; see #1951). The orphan
ref gives the same cross-developer visibility with zero CI and zero queue churn.
The issue file's `assignee` on `main` is updated lazily inside the issue's own PR.
