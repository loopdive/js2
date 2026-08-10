---
id: 4351
title: "A manually dispatched full-matrix test262 run is not comparable to the merge_group-derived baseline — reports thousands of phantom regressions AND improvements"
status: ready
sprint: current
created: 2026-08-10
updated: 2026-08-10
priority: medium
horizon: s
feasibility: medium
task_type: bug
area: ci
goal: test-infrastructure
related: [4141, 4074, 3431, 3467, 4350, 4354]
---

# Manual full-matrix dispatch is not comparable to the stored baseline

Dispatching `test262-sharded.yml` via `workflow_dispatch` on `main` (full shard
matrix, `include_proposals=true`, `force_baseline_refresh=false`) produces a diff
that is **not comparable** to the stored baseline. The failure is loud and reads
convincingly as a real regression.

Observed on run `31397318648` (head `e533765f`):

```
GATE WARN (#3457): regression ratio 62.3% (4789/7689) — net conformance change is +2900
GATE FAIL: trap category "null_deref" grew 571 → 1565 (+994)
GATE FAIL: bucket "test/language/statements/class/elements" has 225 regressions
GATE FAIL: bucket "test/built-ins/Temporal/ZonedDateTime/prototype" has 134 regressions
  null_deref: test/built-ins/Temporal/PlainDate/prototype/until/… (baseline absent)
```

4,789 regressions **and** 7,689 improvements, net **+2900**, spread across
unrelated subtrees, with `(baseline absent)` on entry after entry. That is a
corpus mismatch, not a conformance change in either direction.

It also failed the standalone floor:

```
[standalone-highwater] current pass=29439, mark=29494 (floor=29444, delta=-55)
```

which is equally untrustworthy, being computed from the same mismatched corpus.

## Evidence the baseline is fine and the dispatch is the outlier

Real `merge_group` runs agree with the baseline exactly —
`test262 diff: 48735 baseline → 48735 new tests`. Only the manually dispatched
full-matrix run disagrees.

## Why it matters

`test262-sharded.yml`'s header already warns about this class (#4141 scope
asymmetry, which cost PR #4074 three parked queue attempts). But nothing stops a
maintainer dispatching the workflow, reading `STANDALONE host-free pass floor
breached` plus thousands of regressions, and concluding main has regressed.
Acting on that is expensive: bisecting for a nonexistent regression, reverting
good PRs, or — worst — re-seeding the high-water mark with `--update` to make the
red disappear, which permanently lowers the conformance floor and blinds the gate
that caught it.

One mitigation did work: because the run failed, `promote merged report to main
baseline` **skipped**, so the bad corpus was never promoted.

## Suggested fix

Any of:

1. Have the regression gate / `promote-baseline` detect and refuse a candidate
   whose test-set cardinality differs materially from the baseline's, with an
   explicit "scope asymmetry, not a regression" message.
2. Make the `workflow_dispatch` path produce a merge_group-scoped measurement so
   it is apples-to-apples.
3. At minimum, emit a loud warning whenever `baseline absent` entries exceed a
   small threshold, naming #4141.
