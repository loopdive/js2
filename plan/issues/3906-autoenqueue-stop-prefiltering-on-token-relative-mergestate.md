---
id: 3906
title: "auto-enqueue: stop pre-filtering on a token-relative mergeStateStatus — attempt the enqueue and let GitHub adjudicate"
status: ready
sprint: current
created: 2026-07-31
updated: 2026-07-31
priority: medium
horizon: s
feasibility: medium
task_type: ci
area: ci, merge-queue
goal: release-pipeline
related: [3584, 2786, 3456, 1758, 2547]
origin: "Option G, split out of #3584. #3584 landed the visibility half (option C); this is the half that could actually fix the class, and it is NOT safe to ship without the experiment below."
---

# #3906 — attempt the enqueue instead of trusting the enqueuer's own `mergeStateStatus`

## Why this is separate from #3584

#3584 landed **option C**: a permanently-`BLOCKED` PR is now surfaced with a distinct
warning line and a `needs-manual-enqueue` label instead of one more indistinguishable
`skip (BLOCKED)`. That makes the stall **visible**. It does **not** fix it — such a PR
still sits until a human enqueues it once.

This issue is the candidate fix for the class. It was deliberately **not** bundled with
#3584, for two reasons stated up front so nobody re-litigates them casually:

1. **Its premise is untested.** See the experiment below. It is one API call, and until
   somebody runs it this is a hypothesis, not a plan.
2. **Its half-success mode is worse than the status quo.** See the hazard below.

## The idea

`scripts/enqueue-green-prs.mjs` gates on

```js
const ENQUEUEABLE = new Set(["CLEAN", "HAS_HOOKS"]);
```

But `mergeStateStatus` is computed **relative to the querying token** — `BLOCKED` means
"_you_ cannot merge this", not "this PR is not ready". So the sweep's primary gate is a
**token-relative pre-filter**, while its _substantive_ gate (guard 3 in the file header:
every visible check must be `pass`/`skipping`, re-verified on the exact head immediately
before enqueue) is token-independent and strictly stronger than `CLEAN`.

The proposal: for the narrow, explicitly-detected case

- `mergeStateStatus === "BLOCKED"`, **and**
- zero failing visible checks, **and**
- zero pending visible checks, **and**
- green for ≥ `STALL_MINUTES` (i.e. `classifyBlockedSkip()` already returns
  `suspected: true`), **and**
- the author-trust gate (#2549/#2550) passes,

skip the `ENQUEUEABLE` pre-filter and **attempt `enqueuePullRequest` anyway**, letting
GitHub adjudicate. `classifyBlockedSkip()` from #3584 already computes exactly this
predicate and is unit-tested — this issue is mostly about what to do with its `true`.

**Why it could work at all:** the merge itself is performed by
`github-merge-queue[bot]`, not by the enqueuer. Once a PR is _in_ the queue, the app
token's permissions are no longer in the path. Confirmed on #3884: a PAT enqueue of a
fork-head, workflow-touching PR produced a `merge_group` run that passed and merged
normally.

## THE EXPERIMENT — run this before writing any code

**Question: does the GraphQL `enqueuePullRequest` mutation succeed for a token that
cannot itself merge the PR?** Everything here depends on the answer and nothing else
does.

1. Open a scratch PR that is **fork-head** (`ttraenkler:`) and touches
   `.github/workflows/**` (a comment-only edit to a `workflow_dispatch`-only stub is
   enough). Let CI go fully green.
2. Confirm the app token reads it as `BLOCKED`: the next `auto-enqueue` run should log
   `#N skip (BLOCKED — SUSPECTED PERMANENT (...))` (the #3584 line).
3. From a `workflow_dispatch` job that mints the **same app token** the workflow uses
   (`actions/create-github-app-token@v3` with `ENQUEUE_APP_ID` /
   `ENQUEUE_APP_PRIVATE_KEY`), fire **one** `enqueuePullRequest` mutation at it.
4. Record which of these happened:
   - **mutation rejected** → option G is dead. Close this issue; #3584's visibility is
     all that is available without a credential/permission change, and the decision
     reduces to A vs B.
   - **mutation accepted and the `merge_group` run passes and merges** → G fixes the
     class with **no permission widening and no new credential**. Implement it.
   - **mutation accepted but the `merge_group` run fails or never fires** → the hazard
     below is real; do **not** implement G.

**Check the queue before firing** (`mergeQueue.entries`) and fire **exactly once** —
never in a loop.

## The hazard — why a half-success is worse than today

The merge queue is **serial** (`max_entries_to_build: 1`). If the mutation is accepted
but the merged state cannot actually land:

1. a doomed `merge_group` run occupies the serial head and burns the full shard matrix;
2. it fails, and `auto-park` (#2547) labels the PR `hold`;
3. **a `hold`-labelled PR is skipped by `auto-enqueue` permanently** — so the PR is now
   _more_ stuck than it was before, and the queue lost a head slot.

That is the "never poke the serial queue" hazard (#1758,
`project_merge_queue_requeue_cancels_run`) reached from a new direction. It is the
whole reason this is an experiment first and a patch second.

## Acceptance

1. The experiment above is run **once** and its outcome recorded in this file —
   including a negative result, which closes the issue as `wont-fix` and is a complete
   answer.
2. If the mutation succeeds: the narrow bypass is implemented behind
   `classifyBlockedSkip()`, with the enqueue failure path logging loudly and falling
   back to #3584's `needs-manual-enqueue` label (so a rejection degrades to today's
   behaviour rather than silence).
3. No re-enqueue loop is introduced under any outcome.

## Notes

- Do **not** widen the app installation's permissions as part of this issue. Option A in
  #3584 was declined because its justification rests on a mechanism nobody has measured;
  that reasoning is unchanged here.
- The failing population (measured 2026-07-31, #3584): PRs that are **both** fork-head
  **and** touching `.github/workflows/**`. Fork-head alone and workflow-touching alone
  each auto-enqueue fine. Why that conjunction fails is **not** established.
