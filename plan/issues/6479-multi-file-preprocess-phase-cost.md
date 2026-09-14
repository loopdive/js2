---
id: 6479
title: "Multi-file compile: timer-shim and cjs-rewrite prepasses cost 9 s on a 1,244-file graph — measure per-file cost and cache by content hash"
status: ready
created: 2026-09-14
updated: 2026-09-14
priority: low
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: perf
area: compiler, multi-file
goal: npm-library-support
sprint: Backlog
es_edition: n/a
related: [3946, 3687, 3672, 4157]
---

# #6479 — multi-file prepass cost on large graphs

## Observed (2026-09-10, `JS2WASM_COMPILE_PROFILE=1`, self-compile via `benchmarks/suites/mixed.ts` → `../harness.js` → `src/index.js`, 1,244 input files)

| phase | self | share |
| --- | --- | --- |
| `timer-shim` | 5.8 s | 53 % |
| `cjs-rewrite` | 3.2 s | 29 % |
| `analyze` | 2.0 s | 18 % |

Both prepasses are per-file source rewrites that run before the checker
sees the graph, and their cost is paid again on every compile of the same
graph. (The run itself then died in TypeScript's JSX parser with a stack
overflow on one of the compiler's own `.tsx` sources — a separate finding,
reproduce with the same command.)

## What to do

1. Instrument the two prepasses with `profilePhase` per file and report the
   top-20 files by cost; establish whether cost is linear in bytes or
   superlinear (the #3433 pattern).
2. Skip the rewrite for files whose source contains no candidate token
   (`setTimeout`/`setInterval`/`queueMicrotask`/… for the timer shim;
   `require(`/`module.exports`/`exports.` for the CJS rewrite) — a cheap
   textual pre-filter like `referencesTemporal` in `src/temporal-provider.ts`.
3. Cache rewrite results by content hash in the existing `packageCacheDir`
   so an unchanged file is never rewritten twice across compiles.

## Acceptance

- Self-compile graph above: prepass time ≤ 25 % of today's on a warm cache,
  and ≤ 50 % cold via the pre-filter alone.
- Output binary byte-identical with and without the cache.
