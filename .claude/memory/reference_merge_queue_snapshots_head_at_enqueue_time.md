---
name: reference_merge_queue_snapshots_head_at_enqueue_time
description: "The merge queue snapshots a PR's head at ENQUEUE time — a later push is not rejected, it is SILENTLY ABSENT from the merged SHA, while gh pr view still shows it as the head of a MERGED PR"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T07:22:42.890Z
---

**Measured 2026-08-01 — the same mechanism bit twice in one hour, in opposite
directions.**

The merge queue takes the PR's head **at enqueue time**. Anything pushed after
that is **not rejected and not conflicted — it is simply not in the merged SHA.**
And `gh pr view` afterwards still shows your later commit as the head of a
**MERGED** PR, which reads as landed.

| case | what was pushed late | outcome |
|---|---|---|
| #3982 | `status: done` flip on issue #3991 | **lost** — issue sat `in-progress` on a merged PR |
| #3990 | a stale-snapshot commit from another worktree | **saved main** — the "revert" never merged |

Same behaviour, opposite luck.

## The rule

> **Anything that must land has to be in the FIRST push, before enqueue.**

This is sharper than *"never push to a queued PR"* (which is about ejection).

## ⚠ `BEHIND` IS NOT A "NOT QUEUED" SIGNAL — third instance, 2026-08-02

An agent checked `mergeStateStatus` before pushing, saw **`BEHIND`**, and reasoned
*"not queued ⇒ safe to push."* **Wrong.** The PR had already been captured by the
queue at an earlier SHA; the later push landed on the branch and was simply not
in what the queue merged.

PR #4011, verified on main rather than inferred:

```
git rev-parse c078883af^2  → 4e49df476    (the branch-side parent that MERGED)
gh pr view 4011 --json headRefOid → 126b226cf   (the head that did NOT)
issue 4083 → its file ABSENT from main
issue 4081 → its file still `status: ready` on main
(paths spelled out as "issue NNNN" deliberately: the #1616 issue-link gate
resolves any `plan/issues/NNNN-` shaped path, so prose ASSERTING a file is
missing is indistinguishable, to the gate, from a dangling link to it)
```

**No status string reliably means "not queued".** The only safe reading is: once
CI has gone green, assume the PR may be enqueued at any instant. To check
membership directly, use `isInMergeQueue` — not `mergeStateStatus`:

```bash
gh api graphql -f query='{repository(owner:"O",name:"R"){pullRequest(number:N){isInMergeQueue state mergeStateStatus}}}'
```

## The second, more general rule this produced

> **Verify a PR's CONTENT on main after it merges. A merged PR does not imply
> your last commit merged.**

`gh pr view` showing `MERGED` with your commit as `headRefOid` is consistent with
that commit never having landed. Check the files:
`git ls-tree upstream/main <path>` / `git show upstream/main:<file>`.

**Why it was not merely untidy here:** the un-merged commit was the one closing
#4081, so #4081 sat on main `ready`, unassigned, with no open PR — **dispatchable
for ~40 minutes** while the mechanism it describes was already fixed and merged.
Any agent pulling it would have re-implemented landed work. A partial merge is a
duplicate-dispatch hazard, not a cosmetic one.
Here the push is accepted, the branch moves, CI may even run — and the content
still never reaches `main`.

Particularly bites the documented `status: done`-in-the-impl-PR pattern: that
flip only works if it is in the SHA the queue actually merged. Put it in the
first commit.

## The check

```bash
git merge-base --is-ancestor <sha> upstream/main   # the ONLY honest answer
```

Never `gh pr view --json headRefOid` — a merged PR happily reports a head that
was never merged. Also never a merge-commit *title*, and never the PR's own
metadata. Confirm with a content grep for something the change adds.

### ⚠ `headRefOid` is stale on OPEN PRs too (third stale-field instance, 2026-08-02)

`gh pr view --json headRefOid` returned a head one push old while
`gh api repos/<o>/<r>/pulls/<N> --jq '.head.sha'` (REST) was correct. For any
**check-runs-on-SHA predicate this is the nastiest form**: every check found
for the stale SHA is genuinely real, so the verdict is confidently wrong with
no anomaly to notice. Source head SHAs from REST, never from the GraphQL
`headRefOid` field. Same family as the stale `mergeStateStatus` sample and the
lock-blocked local tracking refs — three distinct stale reads in one day (four
counting `origin` resolving to the fork); the generalisation is: **GitHub
PR-view fields are cached samples, not live state. For anything load-bearing,
read the specific REST resource.**

Two refinements from the same day, worth keeping verbatim:

- **Why "sanity-check the value" cannot catch this class:** each stale source
  returns a value that was *true at some point*, so nothing looks anomalous.
  The fix has to be structural at the call site (choose the authoritative
  source), not a validation layered on the cached one.
- **The fact is safe to automate; the cause is not.** `contexts present on
  prior head <sha>: yes/no` carries no inferential risk; "dropped synchronize"
  is a verdict that can be confidently wrong. Detectors should emit observed
  facts plus a discriminator for the operator, and assert no cause.

## Companion trap: the TWO-DOT diff false alarm

`git diff <main> <branch-head>` reports **"main has files this branch does not
YET have"** as `D` deletions. On 2026-08-01 that produced an urgent escalation
claiming a queued PR was reverting a just-merged fix and deleting nine issue
files. **The branch had deleted nothing — it predated the fix.** Against its own
merge base it recorded exactly one change.

Both the reporting agent and the lead ran the flawed check before acting, and a
dequeue was attempted on that evidence. Use:

```bash
git diff --name-status $(git merge-base <head> upstream/main) <head>   # three-dot semantics
```

**Urgency is exactly when the cheap discriminator gets skipped.** Run it first.

Related: [[reference_never_push_to_a_queued_pr_it_ejects_to_the_back]],
[[reference_silent_empty_is_indistinguishable_from_real]],
[[reference_unstable_failed_vs_unfinished_before_rerunning]].

## Three levels of merge verification — text on main still does not prove it WORKS

Added 2026-08-02. The rule above ("verify content on main, not `mergedAt`") is
the second of three levels, and an agent went to the third unprompted:

| level | check | what it rules out | what it still misses |
| --- | --- | --- | --- |
| 1 | `gh pr view` → `MERGED` / `mergedAt` | nothing | **a PR that merged only its FIRST commit** — `headRefOid` still shows the later one |
| 2 | `git show upstream/main:<file>` / `ls-tree` | the partial-merge case | a landed diff that **does not do what it claims** |
| 3 | **run the behaviour against main HEAD** | both | — |

Level 3 in practice (verifying #4085's `JSON.stringify` fix after merge):

```
array [10,20,30]    standalone=1 ✓     obj holding array   standalone=1 ✓
array nested        standalone=1 ✓     array of string     standalone=1 ✓
plain object        standalone=1 ✓     class instance      standalone=0  <- deferred, as shipped
```

…plus re-running the **guards from the previous PR** on main to confirm the
deliberate non-scope is still non-scope: `Object.keys(new Date(0))` → 0 (no
leak), `gOPN(/re/)` → 7 (the pre-existing leak, correctly still present).

**Why level 3 matters here specifically:** the same PR had a *reverted* arm. Its
diff text on main could look correct while the revert failed to apply, and only
executing the shapes distinguishes "the revert landed" from "the revert's text
landed". Level 2 confirms presence; only level 3 confirms **scope** — that what
shipped is exactly what was intended, nothing more and nothing less.

Cheap heuristic: **level 2 for docs, level 3 for anything that changes
behaviour** — especially anything containing a deliberate revert, a deferral, or
a partial fix.
