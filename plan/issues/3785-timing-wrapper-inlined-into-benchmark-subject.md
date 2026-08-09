---
id: 3785
title: "#3777 root cause: V8 tiers up the harness's own `timeIt` wrapper and INLINES the benchmark into it, so the hot loop runs as the wrapper's mid-tier code — 15x on Node 26, while the subject reports `optimized` throughout"
status: done
completed: 2026-07-29
sprint: 77
created: 2026-07-29
updated: 2026-07-30
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: tooling
goal: performance
depends_on: []
related: [3724, 3726, 3730, 3732, 3759, 3769, 3777, 3781]
---

# #3785 — the timing wrapper became part of the thing being timed

Closes #3777.

## The measurement

Same source, same tier-verified subject, one run each:

| measured via                                     | Node 22 | Node 26     |
| ------------------------------------------------ | ------- | ----------- |
| plain top-level script                           | 470 µs  | 368 µs      |
| **`scripts/no-jit-bench-child.mjs`** (the chart) | 473 µs  | **5616 µs** |

Per-round instrumentation of the real child on Node 26 localises it exactly:

```
calibrated iters=810 (implies ~370us/call)   fn=41  timeIt=65
warmup 0: 373.6us                            fn=41  timeIt=65
warmup 1: 367.0us                            fn=41  timeIt=65
round 0:  369.3us                            fn=41  timeIt=2097217   <- marked for opt
round 1: 5625.6us                            fn=41  timeIt=25        <- Maglev
round 2: 5662.7us                            fn=41  timeIt=25
...
```

Everything is fast — calibration, both warmups, **and measured round 0**. The
cliff lands on round 1, and it lands on `timeIt`'s status, not the subject's.

## Root cause

`timeIt(fn, iters)` is the harness's own timing wrapper. By round 1 it has been
called enough times (2 warmup + 1 measured) for V8 to tier it up. On Node 26 it
becomes **Maglev** (`25` = `isFunction | OPTIMIZED | MAGLEVVED`) and **inlines
`fn` into itself**. From that point the 1M-iteration loop executes as _Maglev_
code belonging to the wrapper — while `bench_loop`'s own TurboFan code object
(`41` = `isFunction | OPTIMIZED | TURBOFANNED`) sits there, correct and unused.

So the subject was optimized the whole time. It just wasn't what ran.

**This is why #3759's tier assertion could not catch it.** That guard
interrogates the SUBJECT — `%GetOptimizationStatus(fn)` — and the subject was
never the problem. A guard pointed at the wrong function is indistinguishable
from no guard.

Node 22 is unaffected because Maglev is default-**off** there; Node 26 has it
default-**on**, and CI runs Node 26.

## Correcting the record on #3769 and #3781

- **#3769 added `--no-maglev`.** Its stated reason was wrong: it claimed
  `bench_loop` was tiering to Maglev. It was not — status 41 is TurboFan, and
  #3781 was right that the hardcoded bit table had misdecoded it. But the
  **flag was load-bearing**, for a reason nobody had identified: it stops
  **`timeIt`** from being Maglev-compiled.
- **#3781 removed `--no-maglev`** on the grounds that it was "inert — identical
  status and timing." The status half was right. The **timing half was wrong**:
  that check was run against a top-level probe, not through the harness, so it
  never reached round 1 where the cliff is. Verified here, same child, Node 26:

  |                    | rounds                                                           |
  | ------------------ | ---------------------------------------------------------------- |
  | with `--no-maglev` | 372.9 370.0 372.8 368.2 368.9 385.5 373.1 369.1 366.8            |
  | without            | 373.6 367.0 **5625.6 5662.7 5641.5 5629.9 5600.3 5610.6 5587.3** |

The lesson is narrow and worth keeping: _a flag proven inert by one measurement
path is not proven inert._ The probe has to exercise the protocol that exhibits
the bug.

## Fix — pin the scaffolding, not the engine

Restoring `--no-maglev` would work. It is the wrong instrument: it treats one
tier's symptom, needs a startup flag on every lane, and configures the JS lane
onto a tier setup no real browser has — while the chart's whole claim is
"this is what optimized JS does."

Instead, `scripts/no-jit-bench-child.mjs`:

1. **`neverOptimize(timeIt, calibrate)`** — `%NeverOptimizeFunction` on the
   measurement scaffolding, before it is ever called. The wrapper can no longer
   be tiered up, so it can no longer inline the subject; the subject runs its
   own code. Fixes the mechanism, covers the wasm lane and any future tier for
   free, and needs no flag. Best-effort behind `new Function` + try/catch, since
   the COLD lane runs `--jitless` without `--allow-natives-syntax` (where there
   is no tier to opt out of anyway).
2. **A calibration-vs-median drift guard.** Calibration is an _independent_
   measurement path — it calls `fn` directly, never through `timeIt` — so the
   two disagreeing is evidence the wrapper is interfering, whatever the cause.
   Threshold 4x: ordinary CI variance runs under 2x, the bug is 12–15x. Skipped
   when `iters` hits its floor of 10, where the clamp breaks the arithmetic.

The drift guard is the part that generalises. #3777's own notes already
contained the decisive clue — _"`calibrate` saw the fast function"_ — but
nothing compared the two numbers, so it stayed an observation instead of a
failure.

## Validation

**The fix, both runtimes, warm JS lane:**

|         | median   | calibration | drift |
| ------- | -------- | ----------- | ----- |
| Node 22 | 489.3 µs | 482.8 µs    | 1.01x |
| Node 26 | 369.8 µs | 366.6 µs    | 1.01x |

Node 26 now agrees with its top-level figure (369.8 vs 368.4) — the 15x is gone.

**Positive control — the guard must be able to fail.** Same fixed child with
only the `neverOptimize` call commented out:

```
Error: measurement instability for 'bench_loop': calibration implied ~445.7us/call
but the measured median is 5596.4us/call (12.6x). ... the timing wrapper is
affecting what is being measured (see #3777)
exit=1
```

**Cold lane unaffected** (`--jitless`, no natives syntax, no `--expect-tier`):
Node 22 drift 1.04x, Node 26 drift 1.07x. `neverOptimize` no-ops silently.

**Full generator** runs clean end-to-end under Node 26 — the actual CI engine —
covering the wasm lane, exit 0:

| benchmark   | wasm      | js        | honest ratio          |
| ----------- | --------- | --------- | --------------------- |
| `fib.ts`    | 3984.9 µs | 9992.6 µs | wasm 2.51x faster     |
| `loop.ts`   | 404.2 µs  | 369.8 µs  | **wasm 1.09x SLOWER** |
| `string.ts` | 5.7 µs    | 5.5 µs    | parity                |
| `array.ts`  | 46.6 µs   | 65.8 µs   | wasm 1.41x faster     |

`loop.ts` is the headline correction: with the JS baseline no longer inflated,
wasm is **slightly behind** JS there, not far ahead. (Sandbox hardware, so the
absolute values are not CI's — the point is the ratio's sign and order of
magnitude, which the inflated baseline had inverted.)

These regenerated `playground-benchmark-sidebar.json` files are deliberately
**not** committed here: they are this machine's numbers, and
`benchmark-refresh.yml` owns that artifact on `main`.

## Consequence for the published chart

The JS baseline has been inflated on every Node 26 refresh, so **every
wasm:js ratio the landing page has shown was flattering wasm**. Those ratios
should be re-read from the first refresh after this lands, not carried over.
Specifically: `loop.ts`'s real Node 26 JS figure is ~368 µs, not ~5290 µs.

This does not touch the wasm-side gains from #3740/#3741 and #3775/#3734 —
those were measured on a fixed harness on one machine and stand on their own.
It changes the _denominator_ they were compared against.
