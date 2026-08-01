---
name: reference_ab_must_state_lane_harness_and_both_commits
description: "Every A/B must state its LANE, its HARNESS, and WHICH TWO COMMITS were diffed — and never report an instrument defect without a positive control first"
metadata:
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-31T06:56:28.583Z
---

# Three confident wrong conclusions in one hour, all comparison-scope errors

Measured 2026-07-31 on PR #3871. Each looked like a substantive finding from the
inside; each was a mis-scoped comparison.

| # | claim | actual cause |
|---|---|---|
| 1 | "`6-a-161` is pre-existing, not my regression" | A/B'd the **standalone** failure; the **host** failure is a different assertion |
| 2 | "my local harness is more permissive than CI" | never ran the **middle commit** — compared stock main vs fix, skipping the head CI actually failed |
| 3 | "baseline over-reports `pass` on rows main fails" | local `origin/main` was **stale** (`a1f72e93` vs real `0694da8f`) — the A/B measured an older main |

All three were **withdrawn**. Nos. 1 and 3 were retracted only after someone asked
for the specific comparison that had never been run.

### Why it must be procedural, not vigilance

**None of the three failed loudly. Each handed back a coherent result that answered
a different question** — which is indistinguishable from an answer to the right one.
Worse, each was *more interesting* than the mundane truth (a baseline defect beats
"your ref was stale"), so the person holding it wanted it to be true.

> You cannot notice your way out of a comparison that looks right, and motivated
> reasoning is strongest exactly when the wrong answer is the interesting one.

That is why the fix is a stated checklist rather than care: **write down the lane,
the harness, and both commit shas before reading the result.**

## The rule

**Every A/B states three things or it states nothing:**

1. **Lane** — host vs standalone. These produce separate merged-report artifacts
   and can fail the *same file* on *different assertions*. `6-a-161` fails host on
   `arr.length` and standalone on `hasOwnProperty`; A/B'ing one says nothing about
   the other.
2. **Harness** — local vs CI. A local pass is not a CI pass until demonstrated.
3. **Which two commits** — naming "before" and "after" is not enough when a third
   commit is the one that actually failed.

## The corollary that actually caught it

**Never report an INSTRUMENT defect without a positive control either.**

The "permissive harness" claim was reported with no check that the harness could
reproduce *any* known CI failure. When the skipped commit was finally run, the
harness reproduced CI's failure **exactly** — same assertion, same values
(`arr.length Expected SameValue(«1», «10»)`) — matching what the shepherd had
independently read out of the CI artifact.

This is the mirror of
[[reference_silent_empty_is_indistinguishable_from_real]]: that rule says don't
trust an empty result without a positive control; this one says **don't distrust
your tool without one either.** A false alarm about your instrument discards good
evidence — here it nearly discounted nine valid FAIL→PASS transitions.

## The HARNESS clause: run the harness's own control, and report it

**`compile()` + `buildImports` silently under-assembles host-lane `Object.*`
statics.** Its own control — `Object.keys({a:1,b:2}).length` — returns **0** on
host (correct on standalone). So *every* host measurement taken through it is
worthless. The authoritative harness is **`runTest262File`** with a test262-shaped
probe; under it the same code is fully correct.

This produced at least **three** confident wrong conclusions in one session,
including a filed-defect report for a bug that does not exist.

> **Unlike the other traps, this one yields a FALSE POSITIVE.** A silent zero or a
> meaningless green leaves you where you started. A bad harness *manufactures a
> finding* — and someone then spends a day fixing a bug that isn't there, working
> from a report that reads as authoritative.

**So: state the control result in the report itself**, not just privately —
harness, lane, and the control that licenses the measurement. "The control passed"
is part of the finding, not a step on the way to it.

**And a retraction must go where the claim lives** (issue file / PR comment), never
only into a message to another agent — agents die, and a phantom defect left on the
books is more expensive than a missing issue.

## Lead with the mechanism, not the sample

Throughout, the case rested on a mechanism (approximate `writable` on **redefine**:
`applyDescriptorFlags` leaves WRITABLE clear when a descriptor merely *omits*
`writable`, so an absent field read as non-writable suppressed a legal write —
ES5 15.4.5.1 step 3.h says absent leaves `[[Writable]]` **true**). The mechanism
explained all three failing groups **without reference to the harness at all**;
the samples corroborated.

**That ordering is why the case survived its evidence being wrong.** Put the
mechanism first whenever the sample and the mechanism both point the same way.

## A structural SYMMETRY tells you two paths disagree — not which one is right

#3878: two functions in one file applied the identical condition, one throwing and
one treating it as a benign no-op. That asymmetry was real, striking, and got called
"the clincher" — the obvious fix being *make the throwing one match the no-op one*.

**Both the issue and the coordinator were wrong, and only a runtime probe caught it.**

1. The compared fields were `expected.repo` (= `GH_REPO`, the **base** repo) against
   the **head** repo, which is fixed at PR creation. **They were never comparable** —
   a category error, not a missing fork-head special case. The real guard is the SHA,
   so the fix is to *delete* the disjunct, not branch around it.
2. The proposed bare no-op would have **traded a red check for a permanent hold**:
   the sibling filters children on **base** repo only, so a fork-head PR can
   legitimately carry the `stack-retarget-pending` label — which is in `HOLD_LABELS`.
   Early-returning would strand it forever, invisibly — *the same bug being fixed*.

> A compelling symmetry between two code paths is evidence about the code's
> **shape**, never about which side is correct. Check where the effects land
> (who applies the label, who reads it) before copying one branch onto the other.

**Runtime confirmation is what converted this**, and it was cheap: call the function
against a live case with the *other* disjunct made false by construction, and see
which one fires. Ask for it whenever a fix rests on reading alone.

Related: a **kill-switch check** must be seen to FAIL — restoring the old condition
had to reproduce the exact production error before the new self-check was trusted.
See [[reference_acceptance_bar_denominator_and_killswitch_attribution]].

## Re-running settled every dispute. Arguing settled none.

Four claims were retracted across two agents and a coordinator in one session —
`6-a-161` as pre-existing, the permissive-harness report, the baseline-over-reports
defect, and the inline-`gOPD` defect plus its scope refinement.

**Every one fell to somebody re-running a measurement. Not one fell to an argument
about the previous answer.** In each case both parties were *right on the evidence
they held when they spoke*, and wrong afterwards — so debating the old result could
never have resolved it.

> When two careful people disagree about a measurement, the disagreement is almost
> never about reasoning. It is about apparatus, version, or lane. **Re-run with the
> scope stated; do not argue the conclusion.**

Corollary for a coordinator: asking "which comparison would settle this?" beats
adjudicating between two accounts. Two of the four retractions happened only
because someone requested a specific comparison that had never been run.

Related: [[feedback_measure_never_extrapolate]] ·
[[feedback_baseline_drift_cross_check]] ·
[[reference_shared_structure_readers_and_mutators]]
