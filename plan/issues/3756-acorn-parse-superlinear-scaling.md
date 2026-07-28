---
id: 3756
title: "Compiled acorn's parse() scales super-linearly with input size — 14x slower than native at 4.9KB, 424x at 313KB"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen, runtime
language_feature: n/a
goal: performance-optimization
origin: "scripts/generate-npm-compat-report.mjs (#3757) head-to-head perf measurement — compiled acorn parsing its own 226KB dist/acorn.mjs took ~6.7s vs native's ~17ms (≈400x). Isolated with a clean scaling benchmark, independent of acorn's specific source, to rule out a one-off input artifact."
related: [1710, 3729, 3757]
---

# #3756 — acorn `parse()` super-linear scaling

## Repro — scaling table (independent of acorn's own source content)

A single fixed 98-byte snippet (`function foo(a,b){...} var x = {...};`),
repeated N times and parsed as one `sourceType: "script"` unit (sloppy
mode, so `foo`/`x` redeclaration across repeats is legal — this isolates
pure scanning/parsing cost, not a semantic-error path):

| reps | bytes | compiled-acorn | native acorn | ratio |
| ---: | ---: | ---: | ---: | ---: |
| 50 | 4,900 | 618.6ms | 43.73ms | **14.1x** |
| 200 | 19,600 | 1,361.6ms | 21.23ms | **64.1x** |
| 800 | 78,400 | 5,087.7ms | 33.97ms | **149.8x** |
| 3,200 | 313,600 | 24,558.2ms | 57.95ms | **423.8x** |

Native acorn's time stays roughly flat/near-linear (as expected — a
real parser scanning proportionally more text). Compiled acorn's ratio
to native **keeps growing with input size** rather than settling at a
constant multiplier: 4x more input (200→800 reps) gives roughly 3.7x
more compiled-acorn time, and 4x again (800→3200) gives ~4.8x more time
— consistently at or above linear-with-input growth, on top of an
already-large constant-factor gap. This is NOT simply "wasm has more
per-call overhead than a JIT" (that would show a roughly CONSTANT ratio
across input sizes) — the ratio itself grows with N, which points at a
genuinely super-linear (worse than O(n)) operation somewhere in the
compiled path, not just a slow-but-linear interpreter.

Real-world confirmation: parsing acorn's own actual 226KB
`dist/acorn.mjs` (not the synthetic repeated-snippet benchmark) takes
**~6.7 seconds** compiled vs **~17ms** native — a ≈400x gap, consistent
with the scaling table's high end.

## What's already known (related, but NOT the same finding)

`plan/issues/3739` / the loopdive/js2#3715 PR (fnctor field typing,
already-landed) measured a **constant** ~9.5x slowdown on a narrower
"tokenizer axis" microbenchmark (`this.<field>` string access via
`charCodeAt` in a loop) and root-caused it to `externref`-boxed string
fields on fnctor structs forcing a guard/cast/flatten sequence per
access. That fix targeted a CONSTANT per-access overhead. This issue's
finding is different in kind: the overhead here isn't constant — it
grows with input size, meaning there's very likely a genuinely
super-linear operation (a candidate: repeated string concatenation or
array growth that isn't amortized — e.g. an O(n) copy on every append
instead of geometric-growth doubling, which native V8 always does for
strings/arrays but a naive Wasm-side implementation might not) somewhere
in real parsing's hot path (token buffer growth, AST node accumulation,
or string building) that the narrow microbenchmark never exercised
because it never grew a data structure across many iterations.

## Scope

- [ ] Profile a compiled acorn parse of a large input (the 313KB
      synthetic benchmark above, or acorn's own dist file) to find WHERE
      time is actually going — GC/allocation counts, hot function(s) by
      sample count. `J2W_DIAG_*` env vars / WAT dump tooling
      (`emitWatOnlyFunctions`, #3743) may help isolate the hot path.
  - [ ] Check specifically for non-amortized growth: does any compiled
      string-building or array-push path do an O(n) copy per operation
      instead of geometric/doubling growth? Acorn's tokenizer
      incrementally builds an AST node array and does string
      slicing/concatenation for identifiers/literals — a natural place
      for this class of bug.
  - [ ] Check GC pressure: does compiled acorn allocate dramatically more
      structs per token/node than necessary (e.g. re-boxing already-boxed
      values, redundant intermediate allocations) in a way that scales
      with total allocation count rather than input size directly?
- [ ] Fix the super-linear operation(s) so the compiled/native ratio
      stays roughly CONSTANT as input size grows (closing the remaining
      gap to something like the already-understood ~9.5x tokenizer-axis
      constant-factor cost is the realistic near-term target, not
      necessarily parity).
- [ ] Regression test/benchmark pinning the scaling table above (or a
      similar synthetic repeated-snippet benchmark) so a future
      regression shows up as a ratio that grows with N again, not just a
      single-point timing number.

## Acceptance criteria

- [ ] The repeated-snippet scaling benchmark's ratio stays within a
      similar range (not growing) from 4.9KB to 313KB input.
- [ ] Parsing acorn's own `dist/acorn.mjs` (226KB) compiled is
      meaningfully faster than the current ~6.7s (order-of-magnitude
      improvement expected once the super-linear factor is fixed, even
      before closing the remaining constant-factor gap).
- [ ] `tests/dogfood/README.md` / the npm-compat website page (#3757)
      updated with a note once this lands and the numbers improve.
