---
id: 3881
title: "A wedged PR merge ref silently suppresses every pull_request-triggered workflow"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: critical
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ci-pipeline
language_feature: n/a
goal: n/a
sprint: current
horizon: s
es_edition: n/a
related: [3878]
---

# #3881 — A wedged PR merge ref silently suppresses every `pull_request`-triggered workflow

## Problem

A PR can enter a state where GitHub stops rebuilding `refs/pull/<N>/merge`. When
that happens **every `pull_request`-triggered workflow silently stops
dispatching** — no failure, no queued run, no notification. Only
`pull_request_target` workflows keep running, because they check out the base
ref and never need the merge ref.

The failure is dangerous precisely because it is *quiet*. The PR looks alive:
`CLA Check` and `Retarget stacked PR children` keep reporting, so a casual
`gh pr checks` glance shows recent activity. But `CI`, `Quality`,
`Test262 Sharded`, `equivalence-gate`, `linear-tests`, `Refresh Benchmarks`,
`Cross-backend parity` and `native-messaging smoke` are simply absent. An agent
waiting on CI waits forever for runs that were never created.

Observed live on **#3871** (`issue-3872-writable-strict-throw`) on 2026-07-31.

## This is NOT #3878

Keep the two apart; conflating them corrupts both diagnoses.

| | #3878 | #3881 (this) |
|---|---|---|
| Defect | `release-pending` throws on fork-head PRs (`retarget-stacked-pr-children.mjs:495`) | GitHub stops rebuilding `refs/pull/N/merge` |
| Blast radius | Every PR the team opens | One PR at a time |
| Effect | Cosmetically red → `UNSTABLE` → `auto-enqueue` skips it | **All `pull_request` CI stops dispatching** |
| Severity | Merge-time tax, work still validated | Work is never validated at all |

## Reproduction / detection method

Use the **branch-scoped** query. It carries **no SHA**, so it is structurally
immune to the truncated-SHA trap recorded in
`reference_dropped_synchronize_only_cla_check_repush` (an
`actions/runs?head_sha=<short-sha>` query silently returns 0 runs and once faked
a repo-wide "CI is not dispatching" outage here):

```bash
gh api "repos/loopdive/js2/actions/runs?branch=<branch>&per_page=30" \
  --jq '.workflow_runs[] | "\(.created_at) \(.name) \(.event) \(.status)/\(.conclusion) \(.head_sha[0:8])"'
```

Healthy heads show `pull_request` runs (`CI`, `Test262 Sharded`, …). A wedged
head shows **only** `pull_request_target` runs (`CLA Check`, `Retarget …`).

On #3871 the break point was unambiguous — one healthy head, then three
consecutive wedged pushes:

```
beae6456  02:39:45  CI / Test262 Sharded / Refresh Benchmarks /
                    Cross-backend parity / native-messaging smoke  (pull_request)   <- healthy
bd347223  02:48:56  CLA Check, Retarget                           (pull_request_target only)
d44b8a8a  03:01:15  CLA Check, Retarget                           (pull_request_target only)
6e4f4367  03:10:06  CLA Check, Retarget                           (pull_request_target only)
```

Confirm the mechanism directly by inspecting the merge ref's parentage:

```bash
git ls-remote origin 'refs/pull/<N>/*'
git fetch origin refs/pull/<N>/merge
git rev-list --parents -n 1 <merge-sha>
```

On #3871 this returned `3e93318 94424ac beae6456` — i.e. the merge ref still
merged the **02:39 head** into a **long-superseded base**, three pushes stale.

## `mergeable: false` is simply WRONG in this state — do not chase conflicts

GitHub reported `mergeable: false` / `mergeable_state: "dirty"` throughout. There
was **no conflict against any relevant base**. Verified both directions with a
read-only merge that touches no working tree:

```bash
git merge-tree --write-tree --name-only origin/main <head>     # exit 0, no conflicted paths
git merge-tree --write-tree --name-only 94424ac    <head>     # exit 0, no conflicted paths
```

Clean against **current main** *and* against **the stale base GitHub was stuck
on**. So the attractive theory — "it's stuck on an old base where it genuinely
conflicts" — is false, and was tested explicitly. Anyone who trusts the `DIRTY`
flag here will burn time hunting a conflict that does not exist. `merge-tree` is
the authority, and it is safe to run against a branch another agent has checked
out because it never writes to the working tree.

## Remedy

1. **Merge `origin/main` into the branch and push a MERGE COMMIT.** This is the
   primary fix — cheap, preserves review history, no PR churn. On #3871 it
   rebuilt the merge ref immediately and all 8 workflows dispatched.

   The precise rule, which cost several pushes to learn:

   > **Pushes of new *work* commits do NOT rebuild a wedged merge ref.
   > A *merge* commit DOES.**

   Three new-work pushes (`bd347223`, `d44b8a8`, `6e4f4367`) failed to clear it;
   one `git merge origin/main` cleared it at once. A merge commit changes the
   merge-base relationship the ref is derived from, whereas a new commit on a
   stale base leaves GitHub believing its cached answer still holds.

2. **Fallback only if (1) fails: close and reopen the PR.** Forces a full
   recomputation of mergeability and the merge ref and re-dispatches workflows.
   It touches nothing on disk, so it is safe even when another agent holds the
   branch — but it churns the PR, so it is second choice.

**Ownership matters for step 1.** Pushing a merge commit writes to the branch,
so it must be done by the **branch owner**. A non-owner pushing to a branch that
is checked out in another agent's live worktree is the shared-worktree clobber
hazard (there was a near-miss on this exact branch the same night; the only
signal was the `+` prefix in `git branch -a`). If you are not the owner,
message them — do not push.

## Adjacent hazard, hit three times in one session

`git fetch origin main` repeatedly left `refs/remotes/origin/main` **stale**,
which produced confidently wrong merge results. Always use the explicit
refspec and verify:

```bash
git fetch origin '+refs/heads/main:refs/remotes/origin/main'
git rev-parse origin/main
gh api repos/loopdive/js2/commits/main --jq .sha   # must match
```

Had the stale ref been merged on #3871, the merge ref would likely have stayed
wedged and the remedy would have been blamed for not working.

## Acceptance criteria

- [ ] A documented detection recipe exists (the branch-scoped, SHA-free query)
      that a shepherd can run per sweep to spot a PR whose `pull_request`
      workflows have stopped dispatching.
- [ ] Ideally automated: the PR-queue sweep flags any open PR whose newest head
      has `pull_request_target` runs but **zero** `pull_request` runs, since
      such a PR is silently un-validated and will never go green on its own.
- [ ] The merge-commit-vs-work-commit rule is recorded where agents will read it
      before reaching for close/reopen.

## Notes

Filed by the PR shepherd on 2026-07-31 after #3871 sat with no CI across three
pushes. Id reserved via `scripts/claim-issue.mjs --allocate` (returned 3881, not
the hand-picked 3882 — the allocator is authoritative because it scans
`origin/main` ∪ open-PR issue files ∪ the `issue-assignments` ref).
