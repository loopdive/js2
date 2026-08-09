---
id: 3001
title: "Remove (or ratchet) the TEMPORARY #2940 vacuous-reclassification gate excusal once the standalone baseline promotes to new-policy"
status: blocked
sprint: Backlog
priority: high
feasibility: easy
task_type: chore
area: ci/test-infra
language_feature: test262-gate
goal: merge-queue-health
related: [3004, 2940, 2463, 3003, 1897, 1668]
blocked_on: "#3004 lands → next push-to-main promote-baseline banks the new-policy standalone baseline (~1496 vacuous rows). Only then does the excusal become inert and safe to remove."
created: 2026-07-02
updated: 2026-07-02
origin: "2026-07-02 — reserved as the removal follow-up for the TEMPORARY excusal added in #3004 to unwedge the merge queue."
---

## Problem

#3004 added a **TEMPORARY, DEFAULT-ON** excusal in `scripts/diff-test262.ts`:
`isVacuousReclassification` pass→fail flips are dropped from the gated regression
count **unconditionally** (no CLI flag, no workflow change — mirroring the #2167
`isStaleAsyncArgsFlake` exclusion). It had to be default-on, not a YAML flag,
because `merge_group` runs the base-branch YAML against the merged-tree script,
so a new flag added only in #3004's YAML would not fire in its own `merge_group`
and the fix would deadlock (see #3004's "self-land invariant"). It bridges the
wedge caused by #2463's vacuity scorer rescoring ~1438 vacuous passes → `fail`
without bumping `oracle_version`, diffed against a stale old-policy standalone
baseline.

Once #3004 lands and the next push-to-main `promote-baseline` regenerates the
standalone baseline at new-policy (banking the ~1496 vacuous rows), the exclusion
excuses **zero** transitions — it becomes inert, then a **MASK**: a real codegen
break flipping a true-pass → "callback never executed" (vacuous) fail would be
silently forgiven.

## Acceptance

When the standalone baseline (`loopdive/js2wasm-baselines:test262-standalone-current.jsonl`)
is confirmed new-policy (its rows carry `vacuous: true` for the harness-wrapper
class; `Excused vacuous reclassifications: 0` on a fresh merge_group), do ONE of:

1. **Remove** the default-on exclusion: delete the `isExcusedVacuous` term from
   the `noiseFiltered`/`excusedVacuous` filters and the
   `isVacuousResult`/`isVacuousReclassification`/`vacuousReclassification`
   plumbing from `scripts/diff-test262.ts` (and update/remove
   `tests/issue-3004.test.ts`; drop the `ci.yml` test step). No workflow guard
   change is needed (there is no flag). **or**
2. **Ratchet** — if the vacuity class warrants permanent tracking, convert the
   excusal into a `vacuous-count-may-not-grow` gate (fail when the NEW-side
   vacuous count exceeds the baseline's), so a genuine true-pass→vacuous break is
   caught while pure baseline drift is not.

Prefer (1) unless #3003 (permanent `oracle_version`-bump prevention) determines
the class needs a standing ratchet. Coordinate with #3003 so the two don't
double-cover.

## Verification

- `Excused vacuous reclassifications: 0` on the current merge_group standalone
  diff (proves the excusal is already inert before removal).
- After removal: a synthetic true-pass → vacuous-fail must TRIP the #1897 guard
  (no longer excused).
