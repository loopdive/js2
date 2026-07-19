---
id: 3437
title: "CI speed gate: enforce test262 harness compile-time budget so a harness switch can never silently tank CI"
status: ready
sprint: current
priority: high
horizon: m
related: [3433, 1942, 3267, 3370]
---

## Problem

The oracle-v8 switch (making the upstream test262 harness authoritative,
#3267/#3370) prepended the real ~6–18 KB harness prelude to every one of
~43k tests. This exploded per-compile cost (host shards ~2 min → ~13.6 min)
because of a quadratic compile-time bug the large assemblies exposed
(`symbolBindsAsyncFunction` walking the whole source per call-site). The
slowdown was **invisible until it hit the merge queue**, where each
`merge_group` validation ballooned to ~30–90 min and the queue effectively
crawled — the recovery-PR drain on 2026-07-18 paid this tax on every single
merge.

#3433 (PR #3374) fixes the *current* slowness (memoize the per-file scans →
2.6–3.8× faster, byte-identical output). But nothing **gates** a future
harness change from silently reintroducing the same regression. The existing
"Compile-time regression guard (#1942)" is load-flaky (it measures wall-clock
compile time under runner load, thresholds 25 pass→compile_timeout / +20%
aggregate) and lives in the post-merge `merge shard reports` job — it fires
too late and too noisily to prevent a slow harness from landing.

## Goal

A **deterministic, pre-merge** compile-time budget gate for the test262
harness path, so any change that materially slows harness compilation fails
CI *before* it reaches the merge queue — never again discovered only by a
crawling queue.

## Acceptance criteria

- A CI check that measures test262 **compile work** (not wall-clock — use a
  load-independent proxy: node count walked / instructions retired / a fixed
  micro-benchmark of assembling + compiling a representative propertyHelper
  assembly) against a committed budget, and **fails the PR** when the budget
  is exceeded by more than a small margin.
- Deterministic enough to run pre-merge (in the PR `quality` gate), not just
  post-merge — no dependence on runner load (the #1942 flakiness root cause,
  see memory `reference_compile_time_guard_1942_flake_skips_promote`).
- Budget is refreshable via an explicit `--update` flow (like the LOC/IR
  ratchets) when a slowdown is intentional and justified.
- Validates that #3433 (PR #3374) brought the harness back under budget; the
  committed baseline is set from post-#3433 main.

## Notes

- This is the "check if it is fast enough" gate requested alongside the
  oracle-v8 harness switch — it makes the rigorous-harness setup safe to keep
  as the default by guaranteeing it stays fast.
- Depends on #3433 (PR #3374) landing first (sets the fast baseline).
- Do **not** revert the v8 harness to regain speed — #3433 already restores
  it with full rigor; this issue prevents the regression from recurring.
