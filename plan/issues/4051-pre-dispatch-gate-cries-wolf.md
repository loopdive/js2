---
id: 4051
title: "`pre-dispatch-gate.mjs` cries wolf — it raises a BLOCKER on any cross-reference without checking whether the referencing claim is still live"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
---
# `pre-dispatch-gate.mjs` cries wolf — it raises a BLOCKER on any cross-reference without checking whether the referencing claim is still live

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

**Found 2026-07-26 by `opus-loop-d` while claiming task #21; corroborated by the lead on two more issues the same hour.** A gate that cries wolf gets ignored, and this one is the primary defence against cross-lane duplicate work — so its false-positive rate is load-bearing.

## Two distinct false-positive classes, both measured

**1. Referencing issue is closed / released.** `pre-dispatch-gate.mjs 739` returns STOP because **#2860** references #739. But #2860's claim is `status: released`, and the reference is only a **row in a tracker table** — not an active overlap. The gate treats *any* cross-reference from a non-`done` issue as live contention.

**2. Claim exists but the branch is long dead.** The gate reports `ACTIVE overlap` from the claim ref alone, without asking when the work last moved:

| issue | claim status | claimed | **last commit on branch** | reality |
|---|---|---|---|---|
| #2552 | in-progress | 2026-06-21 | **2026-06-21** | abandoned (5 weeks) |
| #2200 | in-progress | 2026-06-20 | **2026-06-20** | abandoned (5 weeks) |
| #2726 | in-progress | 2026-07-25 22:42 | **2026-07-26 01:55** | **genuinely live** |

The gate reports all three identically. Only the third is a real conflict — and it is the one that matters, because starting there duplicates active work.

## Why this is worth fixing rather than tolerating

The gate exists because two lanes independently re-implemented #3310/#3311/#3341/#3308. It only works if people act on its verdict. Right now a dispatcher must hand-verify every BLOCKER by reading claim files and `git ls-remote` timestamps — which is exactly the manual discipline that does not hold under time pressure. **A gate with a high false-positive rate is worse than no gate, because it trains people to override it.**

## What to do

- **Check claim liveness, not just claim existence.** Resolve the claimed branch and read its last-commit date; report `ACTIVE` vs `STALE (last commit N days ago)` distinctly. Consider a threshold (e.g. >7 days with no commit ⇒ STALE, adopt rather than route).
- **Skip references from claims whose status is `released` / `done`**, and from tracker-table rows where the reference is not a dependency claim.
- **Distinguish the verdicts in the output**: `BLOCKER (live)` vs `ADOPT (abandoned claim)` vs `CAUTION`. The correct action differs — route away vs take it over — and today both print the same word.
- Keep the existing **REMAINING BLIND SPOT** notice: a lane that has started but not yet claimed or pushed leaves no trace. That is honest and should survive.

## Related
Also seen: the gate's own note that **PR numbers and issue ids share one sequence**, so `git log --grep="#N"` matches `Merge pull request #N` and reads as "already merged" — the gate already handles this (`IGNORED n grep hit(s)`), and that handling is the model for the fix here: **classify the hit, don't just count it.**
