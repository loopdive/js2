---
id: 3878
title: "`release-pending` fails on EVERY fork-head PR, making every team PR strand un-enqueued"
status: done
created: 2026-07-31
completed: 2026-07-31
priority: critical
feasibility: easy
horizon: s
task_type: bugfix
area: ci
goal: ci-hardening
sprint: 78
related: [2786, 3800]
---

# #3878 — a non-required check silently blocks every PR this team opens

## The mechanism (two correct behaviours composing into a stall)

1. **`release-pending`** (`.github/workflows/passive-stack-retarget.yml`) fails at
   `releasePendingAfterSynchronize` (`scripts/retarget-stacked-pr-children.mjs:495`)
   on `repoFullName(pr.head) !== expected.repo` — head is `ttraenkler/js2`, expected
   is `loopdive/js2`. **That condition is true for every fork-head PR**, and this
   team pushes branches to the fork by policy (see CLAUDE.md merge protocol).
2. A red check — even a **non-required** one — drives `mergeStateStatus` to
   **`UNSTABLE`** rather than `CLEAN`.
3. `auto-enqueue.yml` enqueues only `ENQUEUEABLE = new Set(["CLEAN", "HAS_HOOKS"])`
   (`scripts/enqueue-green-prs.mjs:114`). **`UNSTABLE` is deliberately excluded.**

**Net: a PR with all 7 required checks green and one informational check red is
never picked up by any automation — including the ~30-minute cron, which applies
the same filter.** It strands until a human or shepherd manually enqueues it.

## Measured, 2026-07-31

**Six PRs** needed a manual `enqueuePullRequest` in one session — #3859, #3864,
#3865, #3866, #3868, #3869 — all with every required check green, all `UNSTABLE` on
`release-pending` alone.

**The control: #3867 reached `CLEAN` and self-enqueued normally.** That is what
proves the enqueue path itself is healthy and this one helper is the entire problem.
Do not inflate the merged count when citing this — the control is the argument.

## Why this is `critical` despite being cosmetic-looking

`release-pending` is **not** in the required-checks list (`docs/ci-policy.md` §7), so
it is correctly not gating merge on the merits. But it gates merge _in practice_, via
`mergeStateStatus`, for **every PR this team opens**. That is a standing tax on all
throughput, not a one-off — and it is invisible, because the PR looks green.

## ROOT CAUSE — pinned to the line, with its own counterexample in the same file

`scripts/retarget-stacked-pr-children.mjs:495`, in `releasePendingAfterSynchronize`:

```js
if (repoFullName(pr.head) !== expected.repo || sha(pr.head) !== expected.headSha) {
  throw new Error(`#${expected.number}: synchronized pull request head changed`);
```

`expected.repo` is `GH_REPO` = `loopdive/js2`. For **any** fork-head PR,
`pr.head.repo.full_name` is `ttraenkler/js2`, so the **first disjunct is always
true** — it throws regardless of the sha, which matched fine.

**The error message is actively misleading**: it reports "head changed" when what
actually happened is "head repo is a fork". That is why this read as a mysterious
per-PR fault for weeks rather than a systematic one.

Verified identical on **#3868** (job 91053206478) and **#3871** (run 30600487933):
`retarget-stacked-pr-children: #N: synchronized pull request head changed` → exit 1.

### The clincher — its own sibling already handles this correctly

`retargetImmediateChildren` at **line 305** treats the identical condition as a
**benign no-op**: _"head repository ttraenkler/js2 is not loopdive/js2; no children"_,
conclusion **success**. That is the `retarget` job that passed on #3863.

**Two functions in one file, same check, opposite verdicts.**

## Fix

**Make line 495 match line 305's treatment — a fork head is a no-op, not an error.**
A few lines, and it removes the manual-enqueue tax from every PR this team opens.

Alternative if that is somehow unsafe: mark the job `continue-on-error: true` so a
non-required check cannot drive `mergeStateStatus`.

**Not recommended:** teaching `auto-enqueue` to accept `UNSTABLE`-with-all-required-green.
That weakens the enqueue gate globally to work around one broken helper.

## Acceptance

- A fork-head PR with all required checks green reaches `CLEAN` and is enqueued by
  `auto-enqueue.yml` with no manual intervention.
- `release-pending` either passes or does not run for fork-head PRs.

## FIX LANDED — the guard was a category error, not a missing no-op

The head **repository** is fixed at PR creation, so comparing it against
`expected.repo` (= `GH_REPO`, the **base** repo) is unconditionally true for
forks and says nothing about whether the head moved. The genuine race guard is
the **SHA**, supplied by the workflow from the event payload. The fix compares
only that:

```js
if (sha(pr.head) !== expected.headSha) {
```

The base check above it is different and correctly still compares repositories —
a PR's base _must_ live in this repository.

### Runtime confirmation (not inferred)

Confirmed live against open fork-head PR **#3876** by calling
`releasePendingAfterSynchronize` with `expected.headSha` set **equal to the PR's
real current head SHA**, which makes the SHA disjunct false _by construction_:

```
head.repo = ttraenkler/js2   head.sha = 3307a8b1…
before fix -> THREW: #3876: synchronized pull request head changed
after fix  -> no throw: { number: 3876, released: false }
              "stack-retarget-pending is already absent; nothing to release"
```

So the head-repo disjunct was provably the one firing, and the error message was
reporting a change that had not happened.

### Why NOT a bare no-op (the tempting fix, which would have regressed)

`isImmediateOpenChildByRef` filters children on their **base** repository only,
so a fork-head PR _can_ legitimately acquire `stack-retarget-pending`. Making a
fork head return early would strand that label — and `stack-retarget-pending` is
in `HOLD_LABELS`, so it blocks `auto-enqueue` permanently. That trades a red
check for a permanent hold. The fix releases the label correctly instead.

### Test

Three cases in `--self-check` (run by the workflow's own "Self-check exact stack
guards" step): a plain fork-head PR reaches the benign no-op; a fork-head PR
holding the pending label **releases** it; a moved head on a fork **still
throws**, so the fix cannot be mistaken for "skip the check for forks".

**Validated non-vacuous by kill-switch**: with the old condition restored the
self-check fails with the exact production error,
`#41: synchronized pull request head changed`.

## ACCEPTANCE — demonstrated end-to-end, both clauses, on real PRs

Two independent demonstrations after the fix landed on `main` (`880cabb4`), both
observed **read-only** — nothing was manually enqueued, because the whole claim
is unaided pickup:

| PR        | kind                                | `release-pending`                       | outcome                          |
| --------- | ----------------------------------- | --------------------------------------- | -------------------------------- |
| **#3876** | genuinely stranded for hours        | **pass** (7s) after one `synchronize`   | `CLEAN` → auto-enqueued → merged |
| **#3879** | brand-new fork-head PR              | **does not run** (no `synchronize` yet) | `CLEAN` → auto-enqueued → merged |
| #3880     | brand-new fork-head PR (incidental) | **pass**                                | `CLEAN` → auto-enqueued → merged |

The two clauses of the acceptance criterion were satisfied **one each**:
#3876 proves _"`release-pending` passes"_; #3879 proves _"or does not run for
fork-head PRs"_. `auto-enqueue.yml` picked all three up within ~2 minutes of
`CLEAN` — the responsive `workflow_run` path, not the 30-minute cron.

## Landing this fix did NOT unstick the PRs it was written to unstick

**The single most expensive thing to not know about a CI gate fix:**

> **A completed check is pinned to its head commit.** Fixing the _helper_ changes
> nothing already red. Every PR that was red at the moment of the fix keeps a
> stale failure for a cause that no longer exists, stays `UNSTABLE`, and is
> skipped by `auto-enqueue` **indefinitely** — until something emits a fresh
> event on it.

The failure mode this prevents is precise: land the fix, look at an unchanged
backlog, conclude the fix didn't work.

**Remedy — a `synchronize` is what re-evaluates.** The way to emit one without
touching a working tree is the server-side branch update:

```bash
gh api --method PUT repos/loopdive/js2/pulls/<N>/update-branch \
  -f expected_head_sha=<current-head>
```

**Prefer this over `git push` in this repo**: branch authors keep their worktrees
checked out by default, and pushing a merge commit into a branch that is live in
another agent's worktree is the shared-worktree clobber hazard. The API creates
the merge commit remotely and touches no tree; `expected_head_sha` is what makes
it safe against a concurrent push. Used exactly this way on #3876, whose branch
was checked out live at the pinned tip.

## `BLOCKED` vs `UNSTABLE` — the same class of confusion

- **`BLOCKED`** — a **required** check has not reported success yet. Ordinary
  in-flight state (or a genuine required-check failure).
- **`UNSTABLE`** — **all required checks green**, a **non-required** one red.
  This is the state this issue was about, and the one `auto-enqueue` skips
  (`ENQUEUEABLE = {CLEAN, HAS_HOOKS}`).

**Count `fail`-conclusion checks rather than eyeballing the list.** A _pending_
required check reads as `BLOCKED` exactly like a _failing_ one, and mistaking
the two sends a false `[CI-FIX]` task to a PR owner who has nothing to fix — a
wasted context switch for another agent. #3880 was `BLOCKED` purely because
`quality` was still running; it had zero failing checks and merged unaided.

## THE CLASS IS NOT CLOSED — this issue fixed one instance of it

**Read the title as "one check that stranded PRs", not "the stranding is fixed".**
The mechanism documented above — _a red **non-required** check drives
`mergeStateStatus` to `UNSTABLE`, and `auto-enqueue` skips `UNSTABLE`_ — was never
specific to `release-pending`. **Any** red non-required check does it, forever, on
a PR whose every required check is green.

Second instance, measured 2026-07-31, hours after this issue was marked `done`:
**`test262 PR stub — detect relevance`**, on PRs **#3901** and **#3904**.

| PR    | `test262 PR stub`    | note                                              |
| ----- | -------------------- | ------------------------------------------------- |
| #3895 | **pass, 39 s**       | merged normally                                   |
| #3897 | **pass, 39 s**       | merged normally                                   |
| #3901 | **cancelled, 5m0s**  | `##[error]The operation was canceled` in Checkout |
| #3904 | **cancelled, 5m0s**  | `quality` **passed** — so not a quality cascade   |
| #3900 | **cancelled, 4m58s** | independently hit by the PR-queue shepherd        |

39 s versus a 5-minute cancellation is a **hard timeout**, not a slow fetch. The
step is `git fetch --prune ... +refs/heads/*:... +refs/tags/*:...` — a full-ref,
full-tag fetch of a repo whose ref count was measured as pathological in #3880
(47.8 s connectivity check across 6,680 refs). **Plausibly one root cause behind
both issues, on opposite sides of the wire.**

#3904 sat at `UNSTABLE` with every required check green or designed-skipping, and
would have stranded indefinitely.

### Remedy, demonstrated rather than argued

`gh run rerun <run-id> -R loopdive/js2 --failed` took **#3904 `UNSTABLE` → `CLEAN`
at 15:30:23Z**, confirmed by two independent observers. No code change needed.

### Why this was easy to miss twice

The dev protocol said _"all required checks green ⇒ stand down"_. That is
**precisely** the stranding condition: it is satisfied while the PR is `UNSTABLE`.
An agent following the protocol correctly would stand down on a PR that no
automation will ever pick up. Fixed in the same PR as this note (`CLAUDE.md`,
`.claude/agents/developer.md`, `.claude/skills/dev-self-merge/SKILL.md` now all
require `mergeStateStatus == CLEAN`), which also removed a contradiction in
`developer.md` where the stand-down bullet told devs to `enqueuePullRequest` two
lines below "You do NOT enqueue".

**A first instance being fixed is not evidence the class is closed.** The two
instances share no code — only the `UNSTABLE` gate.

## Known sibling, deliberately OUT of scope

The `retarget` job has the same category error in three more places —
`assertExactChildBase` (`:291`) and the post-PATCH re-verification (`:381`,
`:383`, `:392`, `:394`) all reject a fork-head **child**. It is unreached today
because `retargetImmediateChildren` no-ops at `:305` when the _parent_ head is a
fork, which it always is for this team. Fixing it means deciding the intended
stacked-PR semantics for fork-head children — a design question, not a typo — so
it is left for a follow-up rather than widening a critical CI fix.
