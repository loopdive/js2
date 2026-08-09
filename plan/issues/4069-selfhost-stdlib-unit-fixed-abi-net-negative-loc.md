---
id: 4069
title: "Self-host a type-restricted / pure / fixed-ABI stdlib unit through our own IR driver — immediate net-negative LOC"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: n/a
goal: dogfood
---
# Self-host a type-restricted / pure / fixed-ABI stdlib unit through our own IR driver — immediate net-negative LOC

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Immediate bloat-reduction lever, parallel to the allowlist-widen −60k track. Convert a hand-emitted Wasm builtin to TS source compiled through our own IR driver (src/codegen/stdlib-selfhost.ts). PROVEN: timsort landed −404 (#2919/#3159), object-runtime −145 (#2920/#3160). Per reference_selfhost_netnegative_needs_full_elemkind_dialect: only nets negative if the TS dialect covers ALL elem-kinds the unit touches — so convert TYPE-RESTRICTED + PURE + FIXED-ABI units FIRST (Math.* helpers are the called-out next candidate; avoid generic element-type-polymorphic inline emitters). Pick one such unit, convert it, measure the −LOC delta, validate the self-host driver output byte-equivalence + equivalence suite + merge_group. Report the −LOC won. Standard worktree/PR flow; shepherds enqueue green PRs.
