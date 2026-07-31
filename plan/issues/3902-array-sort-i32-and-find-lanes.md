---
id: 3902
title: "perf: array/sort-i32 host-call takes 774 ms (1,586× JS) and has no gc-native lane at all; array/find's gc-native lane is disabled by a stale skip"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: critical
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: array-methods
goal: performance
sprint: current
horizon: l
es_edition: multi
related: [3903, 3898, 3512]
---

# #3902 — `array/sort-i32` is the worst number on the perf page; `array/find` has no fast lane

## Status: open

## Problem A — `array/sort-i32`: 774 ms, and no gc-native lane

From `benchmarks/results/latest.json` (2026-07-31):

| strategy    | avgMs per `run()` | vs JS      |
| ----------- | ----------------- | ---------- |
| `js`        | 0.487969          | 1×         |
| `host-call` | **773.937268**    | **1,586×** |
| `gc-native` | **absent**        | lane fails |

This is by a wide margin the worst entry on
`https://js2.loopdive.com/benchmarks/performance.html` — three-quarters of a
second to sort 10,000 integers, against 0.49 ms in JS. It is also the only
benchmark where a whole strategy silently vanishes from the chart.

The benchmark (`benchmarks/suites/arrays.ts:105-117`):

```ts
export function run(): number {
  const arr: number[] = [];
  for (let i = 0; i < 10000; i = i + 1) arr.push((i * 37 + 13) % 10000);
  arr.sort();
  return arr[0];
}
```

Two separate things to establish:

1. **Why is host-call 774 ms?** 10,000 elements is ~130,000 comparisons for an
   O(n log n) sort. 774 ms ÷ 130,000 = **~6 µs per comparison**, which is far
   beyond even a host round-trip per compare. Either the sort is O(n²)
   (~50,000,000 comparisons → ~15 ns each, which *is* consistent with a host
   boundary crossing per compare), or each comparison boxes both operands
   through `externref`. **Check the algorithm first** — the numbers point at
   an insertion/bubble sort more than at boxing.
2. **Why does the gc-native lane not exist?** The harness silently downgrades a
   failing strategy to "skipped" (`benchmarks/harness.ts:168-177`, and again
   at calibration and mid-loop). The stderr line is printed but not recorded,
   so the public chart just shows one fewer bar. Reproduce with
   `npx tsx benchmarks/run.ts --suite arrays --filter sort-i32` and capture the
   actual message.

Also note a **semantic mismatch** between the two lanes, which must be fixed
or documented either way: the JS baseline calls `arr.sort((a, b) => a - b)`
(numeric compare) while the Wasm source calls bare `arr.sort()` (spec default
= **lexicographic string** compare). These are different algorithms producing
different results. If our `sort()` is doing the spec-correct string conversion
of 10,000 numbers, that alone could explain a large constant factor — and it
means the benchmark is not comparing like with like. Fix the benchmark to use
the same comparator on both sides, then re-measure before optimising.

## Problem B — `array/find` has its fast lane switched off by a stale comment

`benchmarks/suites/arrays.ts:231`:

```ts
skip: ["gc-native"], // find with undefined check may not work in fast mode
```

"may not work" is a guess, not a finding. The consequence is that `array/find`
publishes only a `host-call` bar (0.442203 ms vs JS 0.223464 ms = **1.98×
slower**), and the lane that would likely win is never run. Every other array
benchmark's gc-native lane beats JS by 1.7-2.8×, so there is a good chance
this bar is misleading purely because of a two-year-old TODO.

**Task**: remove the skip, run it, and find out. If it genuinely fails,
replace the comment with the actual error and file a real issue for it. If it
works, delete the skip and publish the number.

## Scope

1. Fix the sort comparator mismatch in `benchmarks/suites/arrays.ts` (both
   lanes use the same comparison).
2. Reproduce and report the gc-native `sort-i32` failure; fix it if it is in
   scope, otherwise file a precise follow-up.
3. Establish whether `sort` is O(n²) and/or boxing per comparison. Fix the
   dominant cost. A monomorphic numeric sort over an `(array f64)` /
   `(array i32)` should not need to leave Wasm at all.
4. Un-skip `array/find` gc-native; publish or explain.
5. **Harness**: a strategy that fails should not disappear silently. Record
   the failure in the results JSON (e.g. `{strategy, status: "failed", error}`)
   so the page can render "lane failed" instead of omitting the bar. A missing
   bar currently reads as "not applicable", which is not what happened.

## Acceptance criteria

1. `array/sort-i32` host-call improves by **≥50×** against the current
   773.94 ms (target ≤15 ms), measured with
   `npx tsx benchmarks/run.ts --suite arrays --filter sort-i32`.
2. `array/sort-i32` has a **working gc-native lane** that beats the JS
   baseline, or the issue documents precisely why it cannot and links a
   follow-up.
3. `array/find` has a working gc-native lane, or the stale comment is replaced
   with the real error and a linked issue.
4. Failed strategies appear in `benchmarks/results/latest.json` with an error
   string rather than being omitted.
5. No equivalence-test regressions; no test262 regressions in
   `built-ins/Array/prototype/sort` or `.../find`.

## Non-goals

- The general `host-call` string-boundary cost (#3903).
- Rewriting `sort` as a self-hosted timsort — that is the separate
  self-hosted-stdlib track. Fix the measured dominant cost here.
