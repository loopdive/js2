---
id: 4239
title: "test262-sharded dispatch runs: the regression gate diffs against a config-mismatched baseline and prints thousands of phantom regressions"
status: ready
created: 2026-08-08
updated: 2026-08-08
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: ci
language_feature: n/a
goal: dogfood
related: [3927, 3448, 3467, 2947]
origin: "2026-08-08 flag-ON conformance measurement (#3927/#4157): the layout_emit dispatch pair's gate output was proven flag-independent by an OFF control reproducing it nearly line-for-line"
---

# #4239 — dispatch-run regression gate reads as garbage and nobody warned the reader

## Problem

A `workflow_dispatch` run of `test262-sharded.yml` on a branch runs the
regression gate against a fetched committed baseline whose CONFIG does not
match the dispatch run's. On 2026-08-08 the `layout_emit` measurement pair
(runs 31261617785 ON / 31262874434 OFF, branch `ci-layout-emit-dispatch-lane`,
code = main `cb240e024` + workflow edit only) both produced gate outputs of
the shape: **4,934 regressions / 7,558 improvements**, Temporal buckets with
"baseline absent" rows, `null_deref` category +989 — on a run whose only
delta vs main was a flag that is PROVABLY inert on the gc lane (unit-pinned
byte-identity), and reproduced nearly line-for-line on the flag-OFF control
(4,929/7,554, null_deref 1560 vs 1561).

An inert flag cannot move gc-lane results; therefore the entire diff is an
instrument artifact of the baseline comparison, not signal. Both dispatch
runs' inputs were identical GitHub defaults (proposals ON, pool 4), so the
mismatch axis is NOT the obvious `include_proposals` input; it was not
identified — candidate axes: the merge-base baseline selection for a branch
ref (#3448/#3467 logic on a non-main ref), eval-provider tier, or scope rows
the baseline carries that a dispatch run does not. Identifying the axis is
part of this issue.

## Why it matters

Anyone reading a dispatch run's red "check for test262 regressions" without
this context will diagnose thousands of phantom regressions from scratch —
the 2026-08-08 measurement nearly did, and only the memory-documented
"CONTENT-CURRENT ≠ baseline matches candidate config" rule triggered the
control dispatch that exposed it. The correct instrument for dispatch pairs
is artifact-vs-artifact (same workflow, same branch, same inputs); the gate
as currently wired ADDS negative information on such runs.

## Acceptance

- [ ] The mismatch axis for branch-dispatch runs is identified and named in
      this file.
- [ ] The regression gate either (a) skips with an explicit "dispatch run on
      a non-main ref — baseline comparison not meaningful, use
      artifact-vs-artifact" annotation, or (b) selects a config-matched
      baseline; silence or a plain red are both unacceptable (a detector
      must be able to say "I don't know").
- [ ] Measurement-lane dispatches (`ir_first`, `layout_emit`) get the
      annotation regardless, since their flags are the measurement.
