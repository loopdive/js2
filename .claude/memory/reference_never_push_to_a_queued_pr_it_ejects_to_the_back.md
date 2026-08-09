---
name: reference_never_push_to_a_queued_pr_it_ejects_to_the_back
description: Pushing ANYTHING to a PR already in the merge queue ejects it; auto-enqueue re-adds it at the BACK. A queued PR never needs a manual main merge.
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-28T13:17:50.499Z
  modified: 2026-08-01T08:46:35.441Z
---

**Once a PR is IN the merge queue, do not push to its branch — not even a
harmless `git merge origin/main`.** The push ejects it from the queue, and
`auto-enqueue` re-adds it at the **BACK**, behind everything that has since
entered.

## ⚠️ THE QUIET FORM IS WORSE: a successful-looking merge that OMITS the push

**Measured 2026-07-31 on PR #3901.** The push did **not** eject it. The queue
merged **the SHA it had enqueued** and silently discarded the two later commits —
then reported **MERGED**.

```
merge commit parents: [ f2746c57 (main), 40081c79 ]   <- the PRE-push head
gh pr view → headRefOid: b4bb5a24                     <- the branch tip, NOT what merged
```

So `MERGED` was true, `headRefOid` matched the branch, every status was green — and
two commits (a real bug fix plus its write-up) were **not on main**.

> **A green `MERGED` plus a matching `headRefOid` is NOT evidence your last commit
> landed.** The branch tip and the merged content are different facts.

**The only sound check is reading the merged bytes**, with a **positive control** at
the PR head so you know the query itself works:

```bash
gh api "repos/O/R/contents/<path>?ref=<merge-sha>"   # what actually landed
gh api "repos/O/R/contents/<path>?ref=<pr-head>"     # control: proves the query finds it
```

Without the control the natural conclusion is "the API is caching" — and you move on.

### ⚠️ RECURRED 2026-08-01 on PR #3939 — with a NEW, more convincing false tell

Two issue files were pushed to a PR **already in the queue**. The queue merged the SHA
it had enqueued (`a4e6512c`, 01:28:27Z); the later commits were never in it.

```
gh api repos/O/R/pulls/3939/files      → lists BOTH files as "added"
gh pr view 3939                        → MERGED
gh api repos/O/R/commits?path=<file>&sha=main  → length 0   <- the truth
```

> **`pulls/N/files` is computed from the PR's CURRENT HEAD, not from what merged.**
> On a PR whose tail commits were dropped it shows exactly the files you expect to
> find, which is *more* convincing than the head-SHA tell and just as wrong.

**The only sound query is `commits?path=<file>&sha=main` (or `merge-base --is-ancestor`)
— ask main what it has, never ask the PR what it contains.** Run it against a file you
know landed as a positive control; here the sibling issue file returned 1 and the two
lost ones returned 0 in the same call.

Cost: the follow-up issues were invisible for hours. A later agent, correctly refusing
to guess an id, found the number occupied by **another lane's** issue — which had been
committed 94 seconds *after* our reservation of that id and landed anyway. **The claim
ref is advisory, not a lock.**

**So the consequence of pushing to a queued PR is not merely a delay.** It can be
**work silently absent from a merge that reports success** — the same failure family
as every other trap that session, arriving through the merge queue.

**A queued PR does not need a manual main merge.** The queue builds each entry
against main's tip by design. `CLEAN | MERGEABLE` while queued is the healthy
state — do NOT "helpfully" refresh it.

**This directly contradicts the normal remedy**, which is why it bites: for an
UNQUEUED PR, `git merge origin/main` + push is the correct fix for `BEHIND` and
for re-triggering checks. The instruction flips the moment the PR is queued.
**Check queue membership BEFORE advising or performing a push.** (2026-07-26: the
lead told a shepherd to merge-and-push a PR that was by then queued at position 6;
obeying would have dropped it behind the very PR it was supposed to land ahead of.
The shepherd refused and was right.)

**Why the ordering can matter enormously:** this repo's queue is configured
`maximumEntriesToBuild: 1`, `maximumEntriesToMerge: 1` — **one entry per merge
group, one push to main per PR, no batching.** So a PR carrying a CI/gate FIX can
never protect a PR ahead of it in the queue; each earlier entry gets its own push
validated against main's code as it stands *without* the fix. Sequencing is
load-bearing, not cosmetic.

**If a queued PR genuinely must change**, accept that it goes to the back, and say
so explicitly when recommending it.

## ⚠ Ejection is NOT guaranteed — the in-flight merge group can win the race

**Measured 2026-07-28 on PR #3715, and this is the DANGEROUS direction.**
A push to a queued PR does **not** reliably eject it. If a merge group is
already in flight, it can complete and merge the **OLD head**, silently
discarding the push:

| event | time (UTC) | on main? |
|---|---|---|
| queued head `479e439af` | committed 12:05:26Z | **YES — merged** |
| fix pushed `1a72a06a1` | committed **13:04:00Z** | **NO** |
| queue merged #3715 | **13:07:22Z** | (landed the old head) |

The push landed **three minutes before** the merge and was still left behind.

**Why this is worse than ejection.** Ejection is loud and self-correcting — you
go to the back and your fix lands eventually. This failure is silent: you push a
correction, reasonably believe it is in, and the **uncorrected** version merges
to main. On #3715 that put an unwanted repo-wide `.nvmrc` Node-25 pin onto main
after the removal had already been pushed.

**Rules:**

- The "don't push to a queued PR" advice above still stands — but treat the
  outcome as **undefined**, not as "it will be ejected". You may get ejection,
  or you may get your push silently dropped.
- **After any push near a queue merge, verify by ancestry which head actually
  landed** — `git merge-base --is-ancestor <your-sha> upstream/main`. Do not
  infer it from the PR showing MERGED.
- If your commit lost the race, **fix forward with a follow-up PR** (public main
  is append-only — never rewrite). That is what #3729 does for #3715.
---

## Catch-up merge when the author's WORKTREE IS LIVE — use the API, not a push

In this swarm the author's worktree is usually still checked out at the PR tip, so
a pushed merge commit lands **under a live working tree**. Verified real, not
theoretical (2026-07-31, #3876).

```bash
gh api -X PUT repos/<owner>/<repo>/pulls/<N>/update-branch \
  -f expected_head_sha=<current head sha>
```

Creates the merge **server-side**, touches no tree, and `expected_head_sha` pins it
so a concurrent push can't be clobbered. The author confirmed a clean fast-forward
with nothing to push afterwards.

**Standard move for "PR needs a catch-up merge but its author may be live."**
Queue-membership check still applies first — this is for UNQUEUED PRs.

## Landing a CI gate fix does NOT retroactively unstick the PRs it was written for

A completed check is **pinned to its head commit**. Fixing the helper changes
nothing already-red: every PR red at the moment of the fix keeps a stale failure
for a cause that no longer exists, stays `UNSTABLE`, and is **skipped by
`auto-enqueue` indefinitely** — until something emits a fresh event on it.

> Land the gate fix, look at an unchanged backlog, conclude the fix failed. That is
> the trap. **A `synchronize` is what re-evaluates**, and `update-branch` above is
> how to emit one safely.

Corollary for acceptance demos: a fix's own PR often **cannot test itself** when the
workflow checks the helper out from the **default branch** rather than the PR head —
so a red check on the fix PR may carry no information at all. Demonstrate on a fresh
PR, or on a real stranded one after a `synchronize`.

See [[reference_autoenqueue_grace0_races_mergestate_recompute]] and
[[reference_workflow_touching_prs_never_autoenqueue]].
