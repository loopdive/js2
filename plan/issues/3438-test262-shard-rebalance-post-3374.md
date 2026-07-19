---
id: 3438
title: Rebalance test262 CI shards from post-#3374 timings (weight-map refresh)
status: done
assignee: ttraenkler/sendev-shards
completed: 2026-07-18
sprint: current
priority: high
horizon: m
feasibility: hard
supersedes: 1953
---

# Rebalance test262 CI shards from post-#3374 timings

## Problem (measured)

In a recent full run (115 shard jobs) the per-shard wall-clock spread was:

- slowest **15.9 min** (JS-host shards, e.g. shard 38 / 55 / 41)
- median **7.1 min**
- fastest **0.9 min** (standalone shards)

The `merge_group` cannot finish until the slowest shard does, so that ~16 min
tail sets the compute floor for every merged PR. JS-host shards are the heavy
ones; standalone shards are light — but they are **separate matrix lanes**
(`target: js-host` vs `target: standalone`), each with its own weight map, so
the 0.9-vs-15.9 spread is partly cross-lane and each lane must be balanced
*internally*.

## Mechanism (how sharding actually works)

Shard assignment is a **deterministic greedy LPT (longest-processing-time)
bin-packing**, `assignBalancedChunk` in `tests/test262-shared.ts`:

1. Every test's weight = `slowTestDurationMs.get(relPath) ?? DEFAULT_TEST_WEIGHT_MS`
   (250 ms default), loaded from `tests/test262-slow-tests.json` (js-host / `gc`
   target) or `tests/test262-slow-tests-standalone.json` (standalone target).
2. All tests are sorted descending by weight, then each is placed into the
   currently-lightest of the 57 bins.
3. Bin `chunkIndex` becomes shard `chunkIndex+1`'s test list.

Because LPT over ~48 k tiny items is near-optimal, **any residual imbalance is
driven by the weight map being wrong, not by the algorithm.** The committed maps
were generated **2026-06-11**, and — critically — **#3374/#3433
(`test262-prelude-compile-cache`, merged `d611d0e19`, 2026-07-18 18:24 UTC)**
changed the per-test cost model: it caches the harness-prelude compile, cutting
per-test `compile_ms` by 2.6–3.8×. Pre-#3374 `compile_ms` was dominated by a
near-*constant* prelude-recompile term (every test recompiles the same
prelude), so LPT was effectively balancing test *count*, not variable cost.
Post-#3374 the constant term is gone and the variable per-test cost dominates —
so the old count-balanced assignment is now imbalanced.

Fix: regenerate both weight maps from **post-#3374** CI-measured per-test
`compile_ms + exec_ms`, so LPT balances against the true post-#3374 cost model.

## Why post-#3374 timings, and where they come from

`scripts/refresh-slow-tests.mjs --threshold 0` builds the `{relPath: ms}` map
from a full-corpus per-test JSONL (`compile_ms + exec_ms`), keyed on the
`TEST262_TARGET`. The only authoritative post-#3374 full-corpus JSONL is the
**promote-baseline** output of a `push:main` (or heavy `merge_group`) run whose
head includes #3374 — i.e. `benchmarks/results/test262-current.jsonl` (host) and
`.../test262-standalone-results.jsonl` (standalone), as republished to
`loopdive/js2wasm-baselines` (`test262-current.jsonl` /
`test262-standalone-current.jsonl`). The published baseline at task start
(`097368aae`, 17:42 UTC) predated #3374 (18:24 UTC); the post-#3374 push run
`29655803360` on `d611d0e19` was still finishing. This weight refresh must
consume the post-#3374 baseline, NOT the stale pre-#3374 map.

Timings are measured under the SAME `COMPILER_POOL_SIZE=4` sharded-CI contention
the real shards run under, so relative weights match real wall-time contribution.

## Approach

1. Fetch the fresh **post-#3374** baseline JSONL (host + standalone).
2. `node scripts/refresh-slow-tests.mjs --threshold 0` for both targets
   (`gc` → `tests/test262-slow-tests.json`, `standalone` →
   `tests/test262-slow-tests-standalone.json`). `--threshold 0` keeps full
   coverage so no test falls back to the 250 ms default (the #1953 skew).
3. Simulate the LPT bin-packing over both regenerated maps and confirm the
   projected per-lane max-bin approaches the median (target: no bin > ~1.5×
   the lane median).
4. Keep the 57×2 matrix shape and `COMPILER_POOL_SIZE=4` unchanged.

The path filter in `test262-sharded.yml` already lists
`tests/test262-slow-tests*.json`, so this refresh is validated by the full
matrix even though it cannot change individual test results.

## Notes / decisions

### Data source

Post-#3374 timings came from the `push:main` `test262-sharded` run
**29655803360** on `d611d0e19` (#3374). All 114 shard jobs succeeded (only the
downstream `promote merged report to main baseline` job failed, so no baseline
was published — hence the maps were regenerated directly from the 114 shard
artifacts). Host = merge of 57 `test262-js-host-shard-*` JSONLs (48 088 tests);
standalone = merge of 57 `test262-standalone-shard-*` JSONLs (48 088 tests).
Measured under the real shard env (`COMPILER_POOL_SIZE=4`), so relative weights
match real per-shard wall-time contribution.

### Before / after projection (LPT sim scored against post-#3374 real cost)

The weight map only governs **test-execution cost** (compile+exec); it does NOT
model the fixed per-shard CI overhead (checkout + `pnpm install` + compiler
bundle build ≈ 3–4 min) that dominates the wall-clock tail. Scoring each LPT
assignment against the post-#3374 per-test `compile_ms+exec_ms`:

| lane       | metric                     | BEFORE (Jun-11 map) | AFTER (post-#3374 map) |
| ---------- | -------------------------- | ------------------- | ---------------------- |
| js-host    | per-bin real-cost SUM max  | 24.66 m             | 22.46 m (−8.9%)        |
| js-host    | max / median               | 1.10                | 1.00                   |
| js-host    | max / min                  | 1.2                 | 1.0                    |
| standalone | per-bin real-cost SUM max  | 13.08 m             | 12.66 m (−3.2%)        |
| standalone | max / median               | 1.03                | 1.00                   |

(Per-bin SUM ≈ 4× the per-shard test-execution wall time at pool-4.)

### Honest read of the "15.9 min tail"

The reported 15.9-vs-7.1-min spread is NOT reproduced when the *current*
assignment is scored against post-#3374 cost — it already balances to
max/median ≈ 1.10 (host) / 1.03 (standalone). LPT over ~48 k fine-grained tests
is inherently robust, so the assignment was never badly skewed against real
cost. The observed 15.9-min tail is dominated by (a) fixed per-shard CI setup
overhead and (b) the cited measurement predating #3374's prelude-compile-cache.
**Weight rebalancing is therefore a corrective/hygiene win, not a 16→6
transformation:** it perfects the balance to 1.00 (−8.9% on the slowest host
shard's *execution* cost, eliminating the worst-case outlier bins) and — more
durably — re-anchors the maps to the current post-#3374 cost model after a
2-month drift, so future assignments stay balanced. Cutting the fixed-overhead
tail (cache the compiler bundle build / slim the checkout) is a **separate
lever** tracked outside this issue.

### Parameters kept unchanged

57×2 matrix shape and `COMPILER_POOL_SIZE=4` are unchanged (per the
baseline-compatibility contract #3425 — the pool size must match
refresh-baseline.yml so merge groups reproduce the published baseline).
`--threshold 0` keeps full-coverage maps so no test falls back to the 250 ms
default (the original #1953 skew).

status: done pending merge.
