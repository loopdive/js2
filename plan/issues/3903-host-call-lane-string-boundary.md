---
id: 3903
title: "perf: the host-call lane pays 24-1,700× the gc-native lane on every string benchmark — per-call host-boundary cost, not per-character cost"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: hard
reasoning_effort: max
task_type: optimization
area: codegen
language_feature: string-methods
goal: performance
sprint: current
horizon: xl
es_edition: multi
related: [3899, 3900, 3901, 3902, 1947]
---

# #3903 — the `host-call` lane's string boundary cost is not a constant, it is a catastrophe

## Status: open

## Problem

`host-call` is the **default** compilation mode (no `--fast`): JS host imports,
`externref` values. Some boundary cost is expected and by design. What the
2026-07-31 numbers show is not a boundary cost — it is a per-call cliff.
`avgMs` per `run()` from `benchmarks/results/latest.json`:

| Benchmark                    | gc-native | host-call   | host-call / gc-native |
| ---------------------------- | --------- | ----------- | --------------------- |
| `array/sort-i32`             | (absent)  | 773.937268  | — (1,586× JS)         |
| `mixed/csv-parse`            | 0.800980  | 20.807877   | **26×**               |
| `string/split`               | 0.873729  | 15.048745   | **17×**               |
| `mixed/text-search`          | 1.198539  | 14.832836   | **12×**               |
| `string/startsWith-endsWith` | 1.374452  | 7.234811    | **5.3×**              |
| `string/substring`           | 0.052122  | 3.533728    | **68×**               |
| `string/trim`                | 0.492126  | 3.301557    | **6.7×**              |
| `string/indexOf`             | 0.014947  | 0.365823    | **24×**               |
| `string/includes`            | 0.013537  | 0.370781    | **27×**               |
| `mixed/matrix-multiply`      | 0.151250  | 1.367787    | **9.0×**              |

Two observations that should drive the investigation:

1. **The multiplier tracks call count, not data size.** `string/substring`
   does 10,000 tiny calls and is **68×** off; `string/startsWith-endsWith`
   does 20,000 trivial calls and is only 5.3× off; `string/indexOf` does 1,000
   calls over a 10 KB haystack and is 24× off. The cost is dominated by
   *crossing*, not by the work on either side. At `substring`'s 10,000 calls
   in 3.53 ms that is **~353 ns per call** — two orders of magnitude more than
   a bare `externref` import call should cost.
2. **`mixed/matrix-multiply` is 9× off with no strings involved at all**
   (0.151 ms gc-native vs 1.368 ms host-call). So this is not purely a string
   problem — the host lane's *numeric array* path pays too. That makes
   "encoding cost" an insufficient explanation on its own.

## Hypotheses to test (in order of expected payoff)

1. **Re-encoding the receiver on every call.** If each `s.indexOf(x)` converts
   the whole WasmGC/`externref` string to a JS string (or vice versa) per
   call, cost scales with string length × call count. Test: hold call count
   fixed and vary string length; if time scales with length, this is it.
2. **Boxing every argument and the return value.** `substring(5, 20)` should
   pass two immediates; if each goes through `__box_number` and the result
   comes back as a boxed `externref` that is immediately unboxed, that is
   fixed overhead per call — which matches the "tracks call count" signal.
3. **Import call not being inlined / trampolined.** Check whether calls go
   through a generic dispatch shim rather than a direct import index, and
   whether Binaryen can see through it.
4. **Identity/sidecar bookkeeping per crossing.** There is known prior art
   here on receiver identity being lost across the boundary; check whether a
   per-call map lookup or sidecar allocation happens.

Measure before fixing. Build a microbenchmark that isolates *one* host call in
a loop with a fixed tiny string, and get the absolute per-call cost. 353 ns is
the number to explain; anything under ~20 ns/call would be defensible.

## Why this matters beyond the chart

`host-call` is the default mode. Everything that does not opt into `--fast`
lands here, and #1947 (end-to-end GC-ref typing — stop laundering through
`externref` inside the module, convert only at the host boundary) is the
strategic fix this issue should feed. Treat this as the measurement that either
justifies or re-scopes #1947.

## Scope

This is deliberately an **investigate-then-fix** issue, and it is `horizon: xl`.
Do not try to land all of it in one PR.

1. Build the isolated per-call microbenchmark and publish the absolute
   per-crossing cost for: a no-arg call, a call with two numeric immediates, a
   call returning a string, and a call on a 10 KB receiver.
2. Identify which of the four hypotheses dominates. Write it down in this issue
   **before** writing a fix — that finding is the deliverable even if the fix
   slips.
3. Land the highest-payoff fix that does not require the full #1947 rework.
4. If the remainder genuinely requires #1947, say so explicitly and re-scope
   #1947 with these numbers attached.

## Acceptance criteria

1. A published per-crossing cost breakdown (the four shapes above) in this
   issue.
2. A named dominant cause, with the evidence that identified it.
3. `string/substring` host-call improves by **≥5×** against the current
   3.534 ms, **or** the issue documents why the remaining cost is structural
   and blocks on #1947.
4. `mixed/csv-parse` host-call improves by **≥3×** against 20.808 ms.
5. No equivalence-test or test262 regressions. The host lane is the default
   mode — correctness here is not negotiable for a perf win.

## Non-goals

- gc-native kernel costs (#3899, #3900, #3901) — different lane, different
  bottleneck.
- The `array/sort-i32` algorithm itself (#3902), though its 774 ms is very
  likely dominated by this same per-crossing cost and the two issues should
  compare notes.
