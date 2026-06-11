---
id: 1955
title: "test262: evaluate COMPILER_POOL_SIZE=4 on the 4-vCPU shard runners"
status: done
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: low
feasibility: easy
reasoning_effort: low
sprint: 61
depends_on: [1953]
area: ci
---
## Result (2026-06-11): measured — KEEPING pool=3

Dispatch run 27324333289 (`compiler_pool_size=4`, main, pre-#1342 maps, so
directly comparable to the pool=3 run 27309868379):

| | pool=3 | pool=4 | Δ |
|---|---|---|---|
| shard p50 | 110s | 107s | −3s |
| shard p90 | 126s | 121s | −5s |
| shard max | 141–153s | 141s | ~−12s |
| corpus `compile_timeout` | 64 | **79** | **+23 %** |

The wall win (−12s max) fails the decision rule's second condition: the
timeout-flake count rose markedly under 4 forks + vitest main on 4 vCPUs.
Those timeouts are excluded from regression gating but pollute the baseline
and every dev-self-merge analysis. Verdict: the default stays **3**; the
dispatch input remains available for re-testing if runners grow.

## Problem / opportunity

#1311 bumped the shard compiler pool from 2 → 3 forks (4-vCPU public-repo
runners), cutting the shard run step ~96s → ~67s with **zero** compile_timeout
flakes on its validation run. One core-equivalent may still be idle: the vitest
main process is mostly I/O-bound dispatch + JSONL writes. Pool=4 could save
another ~10–15s per shard, at the risk of re-introducing the contention-flake
class (#1171/#1589).

## Plan

1. After #1953 (rebalanced shards) lands, dispatch one experimental run:
   `gh workflow run test262-sharded.yml --ref <branch> -f compiler_pool_size=4`
   (note: the `promote-baseline` job FAILS on a non-main ref because the
   `baseline-promote` environment restricts deployment branches to main —
   expected, harmless, ignore it).
2. Compare against the pool=3 baseline run:
   - shard run-step p50 / p90 / max
   - `compile_timeout` count in the merged report and per-shard retry counts
     (`Compile-timeout retries (#1589)` lines)
3. Decision rule: bump the default in test262-sharded.yml (env fallback +
   dispatch input default) only if max shard time drops ≥8s AND
   compile_timeout count stays ≤ pool=3 levels (~0–5). Otherwise document the
   negative result here and close.

The nightly canary (test262-canary.yml) provides the ongoing flip-count watch
if the default is bumped.
