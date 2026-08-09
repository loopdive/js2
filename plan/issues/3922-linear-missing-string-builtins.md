---
id: 3922
title: "linear backend: 7 String builtins unimplemented — repeat, replace, toLowerCase/toUpperCase, substring, trim, endsWith, includes (blocks 7 benchmarks)"
status: ready
created: 2026-07-31
updated: 2026-08-09
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen-linear
language_feature: string-methods
goal: performance
sprint: current
horizon: l
es_edition: multi
related: [3908, 3904, 3923]
loc-budget-allow:
  - src/codegen-linear/index.ts
---

# #3922 — linear lane: missing String builtins

## Status: open — from #3908's 26-lane inventory

## Problem

Seven `String.prototype` methods are unimplemented in the linear-memory
backend. Each fails at **compile** time with `Unsupported method call`, so the
benchmark's linear lane never produces a bar.

| method | benchmarks blocked |
| --- | --- |
| `repeat` | `string/concat-long`, `string/indexOf`, `string/includes` |
| `replace` | `string/replace` |
| `toLowerCase` / `toUpperCase` | `string/case-convert` |
| `substring` | `string/substring` |
| `trim` | `string/trim` |
| `endsWith` | `string/startsWith-endsWith` |
| `includes` + `endsWith` | `mixed/text-search` |

These are **missing features, not miscompiles** — the backend correctly reports
it cannot lower them. That makes this a scoping question (how much of the
String surface should the linear lane carry?) rather than a bug hunt.

## Context

Per `docs/architecture/codegen-axes.md` the linear backend is **not** superseded
by WasmGC — the two are alternatives chosen by target, and both stay. So these
gaps are real, not dead code. But the lane's value is WASI/linear targets, so
prioritise by what those targets actually need rather than by benchmark count.

## Scope

1. Decide the intended String surface for the linear lane and record it. If
   some of these are deliberately out of scope, say so and close that portion
   rather than leaving the benchmarks silently absent.
2. Implement what is in scope. `repeat` unblocks three benchmarks on its own
   and is the cheapest win.
3. Cross-reference #3899's i32-kernel work — the WasmGC lane's scan kernels
   (`__str_region_eq`, `__str_ws_start`/`__str_ws_end`) may inform the linear
   equivalents, though the storage model differs.

## Repeat slice — 2026-08-09

The first scoped slice adds a source-gated, host-free linear-memory
`String.prototype.repeat` kernel. It keeps the count as `f64` through
`ToIntegerOrInfinity`, copies the UTF-8 payload into one allocation, and rejects
negative, positive-infinity, and implementation-size overflow counts before
allocation. Valid counts, including `NaN`, negative zero, negative fractions
that truncate to negative zero, fractional positives, zero, one, empty strings,
and non-ASCII strings, are differentially checked against Node/V8.

The linear backend still has no catchable JS exception representation
(#1838/#1937), so the RangeError cases use a deterministic native trap. This is
an explicit limitation of the slice, not a claim that a Wasm trap is a complete
ECMAScript `RangeError` implementation.

The exact `string/concat-long` benchmark now compiles with zero imports. Its
first invocation still exhausts the 16 MiB arena because repeated immutable
concatenation allocates quadratic intermediates, the same mechanism tracked by
#3935. Once intra-call concatenation is fixed, the repeated benchmark harness
still depends on #3924's between-call arena reclamation.

## Acceptance criteria

1. Each method is implemented or explicitly scoped out with a reason.
2. Benchmarks whose only blocker was a listed method produce a linear bar.
3. Equivalence coverage for whatever lands.

## Provenance

`issue-3908-linear-validation`'s inventory: of 26 previously-absent linear
lanes, 4 are deliberate `dom/*` skips and **22 are real failures** — 16 compile
errors (this issue and #3923) and 5 runtime traps (#3924, #3935). The gap was
structurally invisible until #3904 made failed lanes record themselves instead
of vanishing.
