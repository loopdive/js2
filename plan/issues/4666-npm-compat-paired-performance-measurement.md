---
id: 4666
title: "npm-compat: make relative-speed history use order-balanced paired measurements"
status: done
created: 2026-08-24
updated: 2026-08-24
priority: high
feasibility: easy
reasoning_effort: high
task_type: bug
area: npm-compat, benchmarks
goal: performance
sprint: current
horizon: s
assignee: ttraenkler/codex
related: [3781, 3778, 3780, 4121, 4585, 4604]
files:
  - scripts/lib/npm-compat-perf.mjs
  - tests/issue-4666-npm-perf-pairing.test.ts
  - plan/issues/4666-npm-compat-paired-performance-measurement.md
origin: "The npm-compat history appeared to show simultaneous Acorn, Cookie, and clsx regressions even though their emitted artifact shapes had not changed."
---

# #4666 — make npm-compat relative-speed history order-balanced and paired

## Problem

The npm-compat harness records nine Wasm and Node samples, but every round runs
Wasm first and Node second. It then reports `median(nodeSamples) /
median(wasmSamples)`. The two medians can come from different rounds, and
scheduler, CPU-frequency, or thermal drift always encounters the lanes in the
same order. A noisy host can therefore move the chart without any emitted-code
change.

## Regression audit

The newest published point (`2026-08-24T09:30:34Z`, source `3c0abc9f`) was
compared with the immediately preceding point (`2026-08-24T08:43:17Z`, source
`1278e2ef`):

| package | previous Wasm / Node / ratio | newest Wasm / Node / ratio | artifact evidence |
| --- | ---: | ---: | --- |
| Acorn | 82.841 ms / 10.476 ms / 0.1265 | 63.446 ms / 8.185 ms / 0.1290 | 2,230,518 B, 0 imports, 26 IR functions in both |
| Cookie | 2.215 us / 0.539 us / 0.2433 | 3.285 us / 0.784 us / 0.2387 | 65,428 B, 0 imports, 0 IR functions in both |
| clsx | 0.3226 us / 0.0574 us / 0.1779 | 0.3303 us / 0.0517 us / 0.1565 | 45,437 B, 0 imports, 0 IR functions in both |

Acorn's absolute Wasm time improved by 23%. Cookie's Wasm and Node times moved
together while the ratio stayed within 2%. Only clsx's ratio moved visibly,
mostly because Node changed by 10% while Wasm changed by 2.4%. All three newest
ratios remain inside their recent history bands.

A same-host exact-revision control reproduced the noise. The old clsx revision
measured ratios `0.1522` and `0.1376`; the unchanged current artifact measured
`0.1478`, `0.1575`, `0.1407`, and `0.1455`. Every run emitted the same recorded
45,437-byte, zero-import, zero-IR artifact shape, and the old/current ranges
fully overlap. There is no reproducible compiler regression to patch.

## Fix

- Alternate Wasm-first and Node-first order in warm-up and measured rounds for
  both JS-host and standalone placements.
- Compute the headline ratio as the median of the per-round paired ratios.
  Continue reporting the independent Wasm and Node medians as absolute times.
- Publish the raw paired ratios plus explicit `measurementOrder` and
  `ratioEstimator` metadata so future audits do not have to infer the method.

Three separate processes measuring the unchanged clsx artifact with the new
method reported `0.1461`, `0.1502`, and `0.1537`. Absolute times still moved
from 0.190 to 0.237 us/op under machine load, but the relative-speed span fell
from 11.9% in the last three old-method runs to 5.2%.

GitHub-hosted runners remain heterogeneous machines, so this does not pretend
that cross-host performance is deterministic. It removes the avoidable
within-run order bias and ensures that each displayed relative-speed sample is
an actual same-round comparison.

## Acceptance criteria

- [x] JS-host and standalone measured rounds alternate Wasm-first and
      Node-first order.
- [x] The reported speed factor is the median of paired per-round ratios, not
      a quotient of independently selected medians.
- [x] Raw paired ratios and estimator/order metadata are retained in each lane.
- [x] Deterministic focused tests pin the order and estimator.
- [x] Focused npm-compat tests, typecheck, issue gate, and formatting pass.
