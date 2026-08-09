---
id: 3437
title: "CI speed gate: enforce test262 harness compile-time budget so a harness switch can never silently tank CI"
status: done
completed: 2026-07-24
task_type: ci
sprint: 76
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

## Resolution (2026-07-24)

Shipped a deterministic, load-independent, PRE-MERGE budget gate.

**The proxy (load-independent).** Rather than wall-clock (the flaky, post-merge
#1942 guard), the gate measures a DETERMINISTIC proxy for source-scan compile
WORK: the number of shared-`forEachChild` traversal-helper invocations
(`src/ts-api.ts`) while compiling a FIXED, self-contained representative
harness-shaped assembly. That count is a pure function of the AST + the scans
performed — no wall-clock, no runner load, no parallelism — so it is
reproducible bit-for-bit and safe to gate in the pre-merge `quality` job. An
opt-in meter (`enableForEachChildMeter`/`readForEachChildCalls`) keeps it zero
behavioural effect and near-zero cost off the gate path.

**Coverage of the #3433 class.** The `symbolBindsAsyncFunction` async-assign
scan (the exact O(call-sites × file-size) walk #3433 memoized) used
`ts.forEachChild` directly; it was migrated to the shared helper so the gate
counts it. Verified: temporarily de-memoizing that scan explodes the fixture
count **98,089 → 1,120,948** (11.4×), far past the +15% ceiling, and the gate
FAILS — proving it catches the regression class. The per-file source-scan
predicates (`src/codegen/source-scan-predicates.ts`) already flow through the
shared helper.

**Deliverables.**
- `scripts/check-harness-compile-budget.ts` — gate; `--update` reseeds (like the
  LOC/IR ratchets); `--json`; a vacuity floor fails if the meter/fixture breaks.
- `scripts/harness-compile-budget.json` — budget set from post-#3433 main
  (`forEachChildCalls: 98089`, `marginPct: 15`).
- `src/ts-api.ts` — opt-in traversal meter.
- `src/codegen/expressions.ts` — async-assign scan migrated to the shared helper.
- `.github/workflows/ci.yml` — wired as a required `quality` step.
- `package.json` — `check:harness-compile-budget`.
- `tests/issue-3437-harness-compile-budget.test.ts` — pure verdict + fixture
  determinism + end-to-end "current main is within budget" (acceptance #4).

**Scope caveat (follow-up).** `ts.forEachChild` is a getter-only export (not
monkey-patchable), so DIRECT `ts.forEachChild` call sites are not counted — the
meter covers the shared-helper traversal class. New per-file scans should use the
shared helper; broadening coverage to the remaining direct sites is a follow-up.

## Notes

- This is the "check if it is fast enough" gate requested alongside the
  oracle-v8 harness switch — it makes the rigorous-harness setup safe to keep
  as the default by guaranteeing it stays fast.
- Depends on #3433 (PR #3374) landing first (sets the fast baseline).
- Do **not** revert the v8 harness to regain speed — #3433 already restores
  it with full rigor; this issue prevents the regression from recurring.
