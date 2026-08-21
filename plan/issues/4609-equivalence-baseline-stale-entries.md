---
id: 4609
title: "Ratchet the equivalence baseline: 12 entries pass on current main but are still listed as known failures"
status: ready
sprint: current
created: 2026-08-21
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: hardening
area: tests
language_feature: compiler-internals
goal: core-semantics
related: [4121]
origin: "#4121 slice 2 (PR #4720) full-capture equivalence A/B: 12 baseline entries passed with the slice ON and OFF — stale vs current main, deliberately not ratcheted in that PR"
# id 4609 reserved via claim-issue.mjs --allocate --allow-unscanned on
# 2026-08-21 (gh CLI offline in this container; pr_scan=degraded). MCP
# open-PR scan at reservation: open PRs were 4725 (introduces the issue file
# for id 4605) and none near 4609.
---

# #4609 — 12 stale known-failure entries in the equivalence baseline

## Problem

PR #4720's full-capture equivalence A/B (8 shards per leg, sets diffed by
test id) found **12 baseline known-failure entries that now pass** on
current main with the slice on AND off — i.e. they were fixed by earlier
work and the baseline never caught up: `issue-1197` ×1,
`math-pow-test262-pattern` ×1, `spec/coercion-arithmetic-add` ×8,
`symbol-basic` ×2. Recorded baseline count at that run: 36 known failures,
24 actually failing.

A stale known-failure entry is a masked regression channel: if one of these
12 breaks again, the suite reports it as "known" and stays green.

## Implementation Plan (Fable, 2026-08-21)

1. Re-measure on current main first (the 12 came from a branch base a few
   merges back): run the equivalence suite sharded (8 shards — NEVER
   unsharded on a 16GB box, it OOMs), collect the failing set, and diff
   against the baseline's known-failure list. The stale set is
   (baseline − failing); expect ≈ the 12 above but trust the measurement.
2. Remove exactly the measured stale entries from the baseline file
   (locate it via the equivalence-gate script; do not hand-edit anything
   the gate regenerates).
3. Re-run the gate to prove green with the tightened baseline, and
   deliberately re-break one removed entry in a scratch build to prove the
   gate now fails loudly on it (mutation proof, #4070 method — record the
   counterfactual here, then restore).

## Acceptance criteria

- [ ] Measured stale set recorded here (expected ≈12; the actual list is
      what the run says).
- [ ] Baseline tightened by exactly that set; equivalence gate green.
- [ ] Mutation proof recorded: one removed entry re-broken → gate fails.
- [ ] No other baseline entries touched.
