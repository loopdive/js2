---
id: 3901
title: "perf: gc-native split/replace and the csv-parse app benchmark are 2.7-3.4× slower than JS — per-iteration substring-array allocation"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
feasibility: medium
reasoning_effort: high
task_type: optimization
area: codegen
language_feature: string-methods
goal: performance
sprint: current
horizon: l
es_edition: multi
related: [3898, 3899, 747, 1198]
---

# #3901 — gc-native `split`/`replace` and `mixed/csv-parse`: allocation-bound

## Status: open

## Problem

From `benchmarks/results/latest.json` (2026-07-31), `avgMs` per `run()`:

| Benchmark          | js       | gc-native | gap       | host-call | JS baseline valid?   |
| ------------------ | -------- | --------- | --------- | --------- | -------------------- |
| `string/split`     | 0.258050 | 0.873729  | **3.39×** | 15.048745 | ✅ (~26 ns/split)     |
| `string/replace`   | 0.031416 | 0.103029  | **3.28×** | 0.450594  | ✅ (~31 ns/replace)   |
| `mixed/csv-parse`  | 0.301347 | 0.800980  | **2.66×** | 20.807877 | ✅ (~17 µs/1000 rows) |

Unlike `indexOf`/`substring`/`case-convert` (invalidated by #3898's
loop-invariant-hoisting finding), **these three baselines are valid**: their
per-operation costs are 26-31 ns, which is realistic work. V8 cannot hoist
them because each call allocates a fresh observable object — an array of
substrings for `split`, a new string for `replace`.

So these are **confirmed, honest gaps**, and `mixed/csv-parse` is the
app-shaped one: 1000 iterations of splitting an 11-line CSV on `\n` and then
each line on `,`. It is the closest thing on the page to a real workload.

## Why this is a distinct issue from #3899

#3899 covers *scanning* kernels, where the cost is per-character loop
overhead. This issue covers *allocating* kernels, where the cost is dominated
by how many objects we create per call and how they are laid out:

- `split(",")` on `"alpha,bravo,…,hotel"` allocates **1 array + 8 string
  objects** per call, 10,000 times per `run()`.
- `csv-parse` allocates an 11-element array of lines, then a fresh array per
  line, 1000 times per `run()` — roughly **12,000 arrays + 44,000 strings**.

At 26 ns per split in V8 (which has a bump allocator and a generational
nursery), our 88 ns means we are paying ~3× per allocation, or allocating more
than we need to.

## Scope — investigate before optimising

1. **Count the allocations.** Dump the WAT (`/analyze-wat` skill) for the
   `split` benchmark and count `array.new*` / `struct.new*` in the loop. Is it
   the expected 9 per call, or more? A common failure is allocating an
   intermediate buffer per element, or copying the result array to resize it.
2. **Pre-size the result.** We already do dense-array pre-sizing for the
   `const a = []; for … a[i] = …` shape (#1198). `split` knows how many
   separators it found — count first, allocate exactly once, fill. If we are
   currently growing a JS-array-shaped backing store with repeated
   reallocation, that is the whole gap.
3. **Substring sharing.** Each element of a `split` result is a slice of the
   input. Check whether we copy the characters or can share the backing
   `(array i16)` with an offset/length view. Sharing is a large win here but
   has real correctness and memory-retention consequences — if we do not
   already have a slice-view string representation, **do not invent one in
   this issue**; measure how much it would buy and file a follow-up.
4. **`replace` single-match path.** `text.replace("fox", "cat")` with string
   (not regexp) arguments and a single replacement is: one `indexOf`, one
   allocation of `len - 3 + 3`, three copies. Check we are not going through
   the regexp engine or building a rope.
5. **Escape analysis (#747).** In `csv-parse` the inner `cols` array is dead
   after `sum + cols.length`. If escape analysis can prove that, the inner
   split could avoid materialising the array entirely. Check whether it fires
   and, if not, why.

## Acceptance criteria

1. `mixed/csv-parse` gc-native improves by **≥1.8×** against the current
   0.801 ms (target ≤0.45 ms) — this is the primary metric, it is the
   app-shaped benchmark. Measure with
   `npx tsx benchmarks/run.ts --suite mixed --filter csv-parse`.
2. `string/split` gc-native improves by **≥2×** against the current 0.874 ms
   (target ≤0.44 ms).
3. `string/replace` gc-native improves by **≥1.5×**.
4. No equivalence-test regressions; no test262 regressions in
   `built-ins/String/prototype/split` or `.../replace`.
5. The issue records the measured allocation count per `split` call, before
   and after. If the fix was pre-sizing, say so; if the remaining gap is
   character copying that only slice-views would fix, quantify it and file
   the follow-up rather than leaving it implicit.

## Non-goals

- The `host-call` lane's catastrophic 15.0 ms / 20.8 ms on these two (#3903).
  Note the magnitude for context but do not fix it here.
- Regexp-based `replace`/`split` (this benchmark uses string arguments only).
- Introducing a new slice-view string representation — measure and file.
