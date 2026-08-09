---
id: 3886
title: "LANDMINE: the retarget job rejects fork-head stacked children — unreachable only while every parent is fork-head"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: n/a
goal: n/a
sprint: Backlog
horizon: s
es_edition: n/a
related: [3878]
---

# #3886 — `retarget` rejects fork-head stacked children (dormant)

## Status: dormant landmine, NOT a live failure

Nothing is broken today. This is filed so that whoever trips it **recognises**
it instead of re-deriving it from scratch — which took a live runtime probe the
first time (#3878).

## The defect

`scripts/retarget-stacked-pr-children.mjs` carries the **same category error**
that #3878 fixed in `releasePendingAfterSynchronize`, in four more places on the
`retarget` path. Each compares a pull request's head **repository** against
`expected.repo` — which is `GH_REPO`, the **base** repository:

- `assertExactChildBase` — **`:291`**
- post-PATCH re-verification — **`:381`**, **`:383`**
- post-PATCH confirmation — **`:392`**, **`:394`**

A pull request's head repository is fixed at creation and is the **fork** for
every PR this team opens. So each of these rejects a fork-head **child** during
retarget, for a reason that has nothing to do with the invariant being checked.

Note `isImmediateOpenChildByRef` (`:127`) filters candidate children on their
**base** repository only — it does *not* constrain the head repo. So a fork-head
child is genuinely selectable, then rejected downstream. That asymmetry is the
bug's shape.

## TRIGGER CONDITION — what would make these live

These sites are unreachable **only** because `retargetImmediateChildren` returns
a benign no-op at **`:305`** when the **parent's** head is a fork:

```
#N: head repository ttraenkler/js2 is not loopdive/js2; no children
```

Every PR this team opens is fork-head (CLAUDE.md merge protocol pushes branches
to `fork`), so that early return always fires and the four sites below are never
reached.

**It goes live the moment a stacked PR has a NON-fork-head parent** — i.e. a
parent branch pushed to `loopdive/js2` directly rather than to the fork. Then
`:305` no longer short-circuits, child selection proceeds, and any fork-head
child is rejected at `:291` with:

```
#N: head repository ttraenkler/js2 is not loopdive/js2
```

That is a plausible configuration, not an exotic one: a maintainer pushing a
stack base to upstream while contributors stack fork branches on it.

## Why this was NOT folded into #3878

#3878 was a critical CI fix unblocking every PR the team opens; widening it
would have enlarged the blast radius of an urgent change for a dormant defect.

More importantly, **this one is not a typo — it needs a semantics decision.**
`releasePendingAfterSynchronize`'s comparison was meaningless and could simply be
deleted (the head repo is fixed at creation, so it can never indicate a change).
Here the question is genuinely open: **should the stacked-PR retarget machinery
operate on fork-head children at all?**

- If **yes**: drop the head-repo comparisons, and confirm the PATCH/update-branch
  calls behave correctly against a cross-repository head.
- If **no**: exclude fork-head children in `isImmediateOpenChildByRef` at
  **selection** time, so they are never candidates — rather than selecting them
  and throwing downstream, which is what produces the confusing error today.

Answer that before editing. The wrong choice silently changes which PRs the
stack automation manages.

## Cautionary note carried from #3878

The tempting fix there — "make it a benign no-op like its sibling at `:305`" —
would have **regressed**: a fork-head PR can legitimately carry
`stack-retarget-pending`, which is in `HOLD_LABELS`, so an early return would
strand the label and trade a red check for a permanent invisible hold. Check
**where the effects land** (who applies a label, who reads it) before copying one
branch's treatment onto another. A structural symmetry between two code paths is
evidence about the code's *shape*, never about which side is *correct*.

## Acceptance criteria

- [ ] A decision is recorded on whether fork-head children are in scope for
      stacked retargeting.
- [ ] Whichever way it goes, a fork-head child no longer produces a
      head-repository rejection at `:291`/`:381`/`:383`/`:392`/`:394`.
- [ ] A test covers a stack whose **parent** head is NOT a fork (the trigger
      condition), since that is what makes these sites reachable at all.

## Notes

Found 2026-07-31 while fixing #3878; verified unreachable today by reading the
`:305` early return, and confirmed live on PR #3876 that the identical
comparison was what made `release-pending` throw. Id reserved via
`scripts/claim-issue.mjs --allocate`.
