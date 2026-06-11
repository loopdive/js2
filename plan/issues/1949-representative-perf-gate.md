---
id: 1949
title: "Representative perf gate — 4 overfitted micros at 50% tolerance gate nothing; the honest suite is ungated"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: n/a
goal: performance
---
# #1949 — Representative, tighter perf gate

## Problem

- The gated benchmark set is the **4 landing-page micros**
  (fib/loop/string/array, `playground-benchmark-sidebar.json`) at
  `--max-relative-regression 0.50 --max-wasm-slowdown 0.40`
  (`.github/workflows/benchmark-refresh.yml:84-86`) — a 49% slowdown
  merges silently.
- The set is overfitted: `array-reduce-fusion.ts:8` literally says "Targets
  the 'array-sum' benchmark pattern"; `bench_loop` is exactly the peephole
  #1197 shape. Optimization work is incentivized toward 4 shapes.
- The **honest internal suite is ungated**: `benchmarks/results/latest.md`
  shows string/split 4.9× slower than JS (gc-native), csv-parse 2.9×,
  case-convert 115×; app-shaped benches (pako, react-scheduler,
  threejs-math) exist but feed nothing.
- On push to main the gate is informational-only and the auto-commit is
  disabled, so the baseline can drift indefinitely.

## Proposed approach

1. Add to the gated set: pako, react-scheduler, threejs-math + 2-3
   string-heavy workloads (split/csv-parse) from the existing internal
   suite — they already run under `benchmarks/run.ts`; this is wiring, not
   new benchmarks.
2. Tighten thresholds to ~15% relative regression (calibrate against
   run-to-run variance first — record 5 runs' spread, set threshold ≥3σ).
3. Track gc-native and host-call strategies separately (their regressions
   have different causes).
4. Decide the baseline-refresh story for main (the #491 merge-queue
   auto-commit problem): refresh via the same promote-on-push pattern
   test262 uses (push to the baselines repo or a [skip ci] commit), so
   drift is bounded.

## Acceptance criteria

- ≥8 gated workloads including ≥2 string-heavy and ≥2 app-shaped.
- Threshold justified by measured variance in the PR description.
- A synthetic 20% string-path regression trips the gate (dry run).

## Source

Compiler quality review 2026-06. Related: #1216, #1863, #1895.
