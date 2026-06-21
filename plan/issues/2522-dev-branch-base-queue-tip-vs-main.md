---
id: 2522
title: "dev branch base: origin/main + merge-before-enqueue, predecessor-stacking for known deps"
status: done
priority: medium
completed: 2026-06-20
feasibility: medium
reasoning_effort: medium
task_type: process
area: dev-workflow
goal: dev-velocity
sprint: 64
related: [2519]
---

# #2522 — What should new dev work branch from?

## Question (stakeholder, 2026-06-20)

> When dispatching work we should not base it on current `main` but on the
> commit at the end of the merge queue?

i.e. when a dev opens a new branch, base it on the speculative end-state of the
merge queue (`main + PR1 + PR2 + … + PRN`) rather than on `origin/main`, to
reduce drift and conflicts by the time the new work is finished and enqueued.

## Analysis

**The principle is sound — it is exactly what the merge queue already does
internally.** Speculative stacking tests PR B against `main + A` (the queue
tip), not against bare main. So "work against where main *will* be" is the right
instinct for catching conflicts early.

**The trap when applied to dev-branch dispatch: the queue tip is speculative,
and PRs eject.** If a dev branches from `main + A + B` and works for an hour,
then PR A fails CI / conflicts and never lands, the dev's branch now carries A's
commits that are not on main. At enqueue their PR diff either re-introduces A or
conflicts, and the only fix is to rebase off A — exactly the history-rewriting
the project forbids ("Never rebase"; public main append-only). So basing
*long-lived* work on the queue tip is optimal when everything lands and poisoned
when anything ejects; expected value depends entirely on the queue's eject rate.

**We already get the safe ~90% of this via "merge `origin/main` before
enqueue."** That existing step rebases the work onto future-main *at the moment
it matters* (just before entering the queue) — but only incorporating PRs that
**actually landed**, never speculative ones. Branching-from-tip's only marginal
gain is discovering conflicts *earlier* (during dev) — but against a state that
might not materialize, so a conflict resolved against A is wasted/wrong if A
ejects. Merge-before-enqueue is strictly safer for the same conflict-avoidance
goal.

**The genuinely-right form of the idea: explicit predecessor-stacking for KNOWN
dependencies.** When a new task is known to depend on / heavily overlap a
specific in-flight PR, branch from **that PR's real branch** (durable, not an
ephemeral `gh-readonly-queue/main/pr-N-<sha>` ref), treat it as a stacked PR,
and enqueue it after the predecessor lands. This is dependency-driven and
durable — the good version of "base on the queue," scoped to where the
dependency is actually known.

## Caveat tied to #2519 (serial-queue switch, 2026-06-20)

To stop runner starvation during the merge-queue wedge, `max_entries_to_build`
was set to **1** (serial) — which turns **off the queue's own speculation**. So
two queued PRs that textually/semantically conflict are no longer pre-tested
against each other; the conflict surfaces only when the second reaches the head
(it ejects there; the author resolves against real merged main).

If inter-PR conflicts turn out to be common, the higher-leverage fix is
**re-enabling queue speculation** (`max_entries_to_build > 1`) once runner
capacity allows — which the #2519 slim-down helps with by removing the per-PR
114-job test262 runs that were oversubscribing the 120-runner pool. That is a
better lever than changing what devs branch from.

## Decision (implemented in this issue)

1. **Independent work (the common case): branch from `origin/main`, then merge
   `origin/main` again right before enqueue.** Keep tasks small so drift is
   bounded. Do **not** branch from a `gh-readonly-queue` tip — it is speculative
   and ejects.
2. **Known dependency on an in-flight PR: explicit predecessor-stacking.** Branch
   from the predecessor PR's real branch, treat the new branch as a stacked PR,
   and enqueue it only after the predecessor lands. Re-merge the predecessor's
   branch if it changes.
3. **Inter-PR conflict rate is a queue-speculation lever, not a dev-base lever.**
   Revisit `max_entries_to_build > 1` once #2519's slim-down has freed enough
   runner capacity to raise it without starvation.

## Acceptance criteria

- [x] Decision recorded in `CLAUDE.md` (worktree-creation rule, "Branch base"
      bullet) and `.claude/agents/developer.md` (Implement step 4): branch base
      for independent work + the explicit predecessor-stacking pattern for known
      dependencies.
- [x] Follow-up note that raising `max_entries_to_build` above 1 is the lever for
      inter-PR conflict rate (depends on #2519 runner-capacity outcome) — noted
      in both the CLAUDE.md bullet and the Decision section above.
