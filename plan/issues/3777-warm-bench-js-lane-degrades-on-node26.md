---
id: 3777
title: "warm-chart JS lane runs ~15x slower through the benchmark harness than the same source at top level — Node 26 only, and it degrades DURING the measured rounds"
status: done
completed: 2026-07-29
sprint: 77
created: 2026-07-28
updated: 2026-07-30
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: tooling
goal: performance
depends_on: []
related: [3724, 3726, 3730, 3732, 3759, 3769, 3781, 3785]
---

# #3777 — warm-chart JS lane degrades ~15x on Node 26, inside the harness only

## Summary

The landing-page "warm speed" chart's **JS baseline is inflated on CI**, which
flatters every wasm:js ratio it publishes. The function is genuinely
TurboFan-optimized (verified — see below), so this is **not** the tiering
problem #3759/#3769 chased. It is specific to the harness path _and_ to
Node 26.

Same source, same engine, tier verified in both cases:

| measured via                                     | Node 22 | Node 26     |
| ------------------------------------------------ | ------- | ----------- |
| plain top-level script                           | 310 µs  | 349 µs      |
| **`scripts/no-jit-bench-child.mjs`** (the chart) | 323 µs  | **5107 µs** |

Node 22 shows no gap. Node 26 shows ~15x. CI runs Node 26, which is why the
published `loop.ts` JS figure has been ~5290 µs while the same source measured
~350 µs anywhere else.

## It is not the tier, and not the factory

- **Not the tier.** `%GetOptimizationStatus` reports the calibrated
  optimized signature both before and after the measured rounds. (The earlier
  "maglev" reading in #3769 was a decoding bug — bit positions shift between
  V8 releases; see that PR's revert note.)
- **Not `new Function`.** Loading through the factory and optimizing _inside_
  it (what the harness does) vs. returning a plain function and optimizing it
  from the caller's scope both measure ~338 µs on Node 26 in isolation.

## The real tell: it degrades mid-measurement

`calibrate(fn)` derives its iteration count by running the function for 100 ms.
On the failing runs it returns `iters = 882`, which back-solves to roughly
**340 µs per call** — i.e. _calibration saw the fast function_. The measured
rounds that follow then report **5107 µs per call** for the same function in
the same process.

So the function starts fast and becomes slow partway through. The harness makes
~10,000 calls in total (80 warm-ups + ~294 during calibrate + 11 rounds × 882),
against ~90 in a direct probe — so the trigger is plausibly call-count or
duration dependent, and a short probe cannot reproduce it.

## Why it matters

The chart's whole purpose is an honest wasm-vs-JS ratio. An inflated JS
baseline biases every row in wasm's favour, and it is invisible without
cross-checking against a second measurement path. It also means any
wasm-vs-JS conclusion drawn from the published chart on Node 26 — including
recent `loop.ts` and `array.ts` comparisons — should be re-derived once this
is fixed.

## Suggested investigation

1. Log `%GetOptimizationStatus` per measured round (not just before/after) to
   find the exact round where it changes, and whether a deopt/re-opt cycle is
   visible.
2. Try `--trace-deopt` / `--trace-opt` on the child under Node 26 to name the
   deopt reason.
3. Bisect the harness protocol: does it reproduce with fewer rounds? With
   `calibrate` skipped and a fixed `iters`? With the warm-up loop removed?
   That isolates whether it is call-count, wall-time, or protocol-shape driven.
4. Check whether the wasm lane has the analogue (its variance is ~0.02%, which
   suggests not, but it should be confirmed rather than assumed).

## Acceptance criteria

- [x] The harness and a plain top-level script agree within noise on Node 26
      for the same source, as they already do on Node 22. (369.8 µs vs 368.4 µs;
      drift ratio 1.01x.)
- [x] Root cause named, not worked around: V8 tiers up the harness's own
      `timeIt` wrapper and INLINES the subject into it, so the hot loop runs as
      the wrapper's Maglev code while the subject's TurboFan code goes unused.
- [x] The published chart's JS column is re-derived and the ratios restated —
      `loop.ts` JS is ~370 µs, not ~5290 µs, which makes wasm 1.09x SLOWER
      there rather than far ahead. See #3785.

## RESOLVED 2026-07-29 — see #3785

Fixed by pinning the measurement scaffolding out of the optimizing tiers
(`%NeverOptimizeFunction` on `timeIt`/`calibrate`) plus a calibration-vs-median
drift guard, in `scripts/no-jit-bench-child.mjs`.

Two corrections this investigation forced, recorded in #3785 in full:

- **It was never a deopt.** Hypothesis 1 below ("find the exact round where it
  changes, and whether a deopt/re-opt cycle is visible") was the right
  experiment and it returned a negative: the subject's status is a constant `41`
  (`optimized|turbofanned`) for every single round. The status that moves is
  `timeIt`'s.
- **#3781's removal of `--no-maglev` was wrong.** That flag was load-bearing
  after all — not for the reason #3769 gave, but because it prevents `timeIt`
  from being Maglev-compiled. #3781 called it inert on the basis of a top-level
  probe, which never reaches the round-1 cliff.

Item 4 below (does the wasm lane have the analogue?) is answered by the fix
rather than by measurement: the pin is lane-agnostic, so the wasm lane is
protected whether or not it was ever affected.

## Provenance

Found while fixing #3769's incorrect maglev diagnosis. A real Node 26 was
downloaded to this sandbox to reproduce CI's engine directly; every number
above is measured on both runtimes side by side rather than inferred.
