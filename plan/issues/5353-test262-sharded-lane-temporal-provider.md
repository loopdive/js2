---
id: 5353
title: "Wire the SHARDED test262 CI lane to the compile-once Temporal provider so the published conformance number includes Temporal"
status: ready
sprint: current
priority: medium
horizon: m
goal: dogfood
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-05
---

# #5353 — Temporal provider in the sharded CI lane

## Problem

#5248 (PR #5375) wired the IN-PROCESS test262 runner to the provider; the
sampled Temporal bucket went 81 → 262 pass. It deliberately left the SHARDED
CI lane (`scripts/test262-worker.mjs`, `test262-sharded.yml`) unwired, so the
published number (`benchmarks/results/test262-current.json`, ~35,497 today)
does not include a single Temporal gain, and no merge-group regression gate
sees Temporal rows. Two blockers were named:
1. the compiler bundle the shards run does not re-export
   `buildTemporalProvider`;
2. the cold provider build (~52–65 s) exceeds the vitest fork pool's 30 s
   kill, so a SHARD cannot build it — the shard PARENT must pre-warm the cache.

## Implementation Plan (Fable, 2026-09-05)

1. **Bundle export.** Add `buildTemporalProvider` (and whatever
   `scripts/test262-import-object.mjs`'s `linkedModules` path needs) to the
   compiler bundle's public surface; confirm `dist/` carries it.
2. **Pre-warm in the shard parent.** In `test262-sharded.yml` (and the local
   `test:262` path), build the provider ONCE before the fork pool starts —
   `JS2WASM_TEMPORAL_CACHE` pointed at a workspace dir — so every shard hits
   `cacheHit=true` (~1 s). Cache the artifact across CI runs keyed on
   compiler ABI + polyfill source (the existing content-addressed key).
3. **Worker wiring.** `scripts/test262-worker.mjs` passes `linkedModules` to
   `instantiateTest262Module` under the same path-OR-`features:` gate the
   in-process runner uses; default ON in CI, `JS2WASM_TEST262_TEMPORAL=0`
   opt-out kept.
4. **Baseline validator parity.** `scripts/validate-test262-baseline.ts`
   currently defaults the provider OFF to avoid phantom drift; once the
   sharded baseline is produced WITH the provider, flip its default to match
   (same PR, or the validator strands PRs UNSTABLE — #3878/#3904).
5. **Land order + measurement.** This PR's merge group will show the Temporal
   bucket's flips against the current baseline: expect large gains and the
   10 wrong-reason-pass regressions #5375 triaged. Cite that triage; do NOT
   add an accepted-regressions mechanism. Report the new published number.

## Acceptance criteria

1. Merge-group shards run Temporal rows with the provider; `Temporal is not
   defined` = 0 in the merged report.
2. Published conformance number moves; the delta is stated with the #5375
   triage cited for the known 10.
3. Per-shard cost measured (instantiate ms) and stated; no shard timeouts.

## Notes

- Filed from #5248's "Not done" bounds (PR #5375). Lane A (CI/infra).
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.
