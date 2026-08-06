---
name: reference_long_single_process_sweep_overcounts_failures
description: A long SINGLE-PROCESS test262 sweep poisons its own later results — 15 of 19 apparent regressions evaporated on a solo re-run. This is NOT the contention flake; it happens in a fully serial run. Never size a bucket from one long sweep.
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T04:23:28.545Z
---

Measured 2026-08-02 by the `H-crashes` agent while running the regression
control for PR #4007.

## The observation

A seeded 500-file regression sample over baseline-`pass` goal-scope files came
back **481 pass / 11 fail / 8 error**. Re-running the **19 non-passes solo**:
**15 passed.** Only 4 were real, and those 4 fail identically with the fix
reverted — i.e. **0 attributable regressions**, against an apparent 19.

**~79 % of the apparent regressions were artifacts of the sweep itself.**

## Why it is not the flake you already know about

This was a **fully serial, single-process** sweep — not the 4-way-contention
flake. Running many files in one process **poisons later results**: 8 of the 15
false failures shared one compiler-internal signature,

```
Invalid value used as weak map key
```

which only appears **deep into a long run**. State accumulated across files in
the shared process is the mechanism, and it is adjacent to the known hazard that
test262's own harness mutates realm intrinsics
([[reference_verifyproperty_vacuous_both_lanes_two_root_causes]] and the
`verifyProperty` destructiveness now filed as an issue).

## The rule

- **Never size a bucket, or declare a regression, from one long single-process
  sweep.** The failure count is inflated, and inflated in a direction that looks
  like your change broke things.
- **Re-run every apparent non-pass SOLO before believing it.** That single step
  turned 19 regressions into 4.
- Then apply the usual attribution control: revert the change and confirm the
  survivors fail identically ([[reference_acceptance_bar_denominator_and_killswitch_attribution]]).
- This cuts **both** ways — a long sweep can also mask a real failure behind an
  earlier file's corruption. Solo re-runs are the discriminator in both
  directions.

## Why this keeps being expensive

The inflated number is *plausible*, arrives with file paths attached, and points
at the work you just did. It is the same family as
[[reference_silent_empty_is_indistinguishable_from_real]]: the artifact is
indistinguishable from the real finding **unless you run the control**.

Related: [[feedback_measure_never_extrapolate]],
[[feedback_regression_analysis]],
[[reference_broken_instrument_can_still_give_right_answer]].
