---
id: 4645
title: "Compile time goes superlinear past ~100 KB — 157 KB module does not terminate in 45 min"
status: ready
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, performance
goal: dogfood
related: [4628, 4644]
---

# #4645 — Compile time goes superlinear past ~100 KB

## Problem

Compiling a single large module stops terminating. Measured on the linked
`@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0` bundle during the #4628 spike, on
prefixes cut at top-level statement boundaries (every prefix compiles with
**zero** errors — this is purely a time curve, not a correctness cliff):

| Input size | Compile time |
| --- | --- |
| 39 KB | 9.1 s |
| 49 KB | 8.4 s |
| 60 KB | 10.1 s |
| 69 KB | 11.7 s |
| 83 KB | 18.2 s |
| 106 KB | 52.6 s |
| ~138 KB | **killed at 38 min** |
| 157 KB | **killed at 45 min** |

The same 342 top-level statements, compiled as 14 separate slices, sum to
**~24 s**. So the work itself is cheap; something is superlinear in
whole-module size.

## Where the time goes

`JS2WASM_COMPILE_PROFILE=stream` on the 157 KB run:

- `module-init-pass1` — 3.50 s
- `module-init-pass2` — 1.77 s
- heap ~297 MB at that point
- then **no phase marker closes for the remaining ~44 minutes**
- steady 100 % of one core, RSS flat at ~600 MB

Flat RSS with pinned CPU rules out a memory blowup or GC thrash — it is
CPU-bound in per-function codegen, after module-init. The profiler's markers
are too coarse past module-init to narrow it further, which is itself worth
fixing: **the profile cannot currently attribute 98 % of a pathological
compile.**

## Suggested approach

1. **Get attribution first.** Add per-function (or at least per-phase) markers
   to the post-module-init codegen path in `src/compile-profile.ts` so the
   44-minute window resolves into something. Without this, any fix is guessed.
   A cheaper interim: attach a sampling profiler (`node --cpu-prof`) to the
   106 KB case — 52.6 s is long enough to sample and short enough to finish.
2. **Suspect anything keyed by a whole-module collection** that is rescanned
   per function — a linear scan inside a per-function loop is the classic
   shape for "fine in slices, quadratic whole". The slice-vs-whole gap
   (~24 s vs ≥45 min for identical statements) points hard at cross-function
   state rather than at any single function's complexity.
3. **Set a regression floor** once fixed, so this cannot silently return.

## Why this matters

- **Blocks Option A in #4628** — compiling `@js-temporal/polyfill` as the
  runtime `Temporal` implementation requires compiling the whole bundle, which
  currently does not finish.
- **Blocks dogfooding generally.** 157 KB is not a large JavaScript module by
  modern standards. The `tests/dogfood/` catalog compiles real npm packages,
  and the UMD lane of the polyfill (242 KB) was not even attempted because it
  is further past the cliff.
- Per `tests/dogfood/README.md`, a compile timeout is an unverified workload,
  never a pass — so this converts silently into missing coverage rather than
  into a visible failure.

## Reproduce

```bash
DOGFOOD_TEMPORAL_POLYFILL=1 node node_modules/vitest/dist/cli.js run \
  tests/dogfood/temporal-polyfill.test.ts
```

Harness from #4628 / PR #4789. It compiles both whole-bundle and sliced lanes;
the whole-bundle lane is the one that hangs. Prefix cutting at statement
boundaries is how the curve above was produced — reuse it to bisect the cliff.

## Acceptance criteria

1. The 157 KB linked bundle compiles to completion, with the time recorded.
2. The scaling curve above is re-measured and is no longer superlinear — state
   the new numbers against the old ones.
3. Whatever the root cause, the profiler can attribute it: a repeat of this
   investigation should not start with "no phase closes for 44 minutes".
4. A guard so the cliff cannot silently return.

## Notes

Do not treat "it finished in 40 minutes instead of 45" as fixed. The target is
the shape of the curve, not one data point — the sliced ~24 s is the evidence
that near-linear is achievable.
