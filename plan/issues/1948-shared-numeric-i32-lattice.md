---
id: 1948
title: "Shared numeric lattice — replace three duplicated syntactic i32-safety matchers; stop i32↔f64 ping-pong"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
---
# #1948 — Shared numeric i32 lattice

## Problem

i32-ness is decided by at least three **duplicated syntactic pattern
matchers**, each intentionally narrower than the next:

- `isI32SafeExprForArray` "mirrors `isI32SafeExpr` in function-body.ts but
  is intentionally narrower" (`src/codegen/array-element-typing.ts:30-31`).
- `function-body.ts:387` (`isI32SafeExpr`) — loop-var promotion.
- The linear-uint8 / string-builder / reduce-fusion passes each re-implement
  their own capture/escape + integer-safety scans.

Consequence, verified by -O3 disassembly during the 2026-06 review: one step
off the recognized patterns falls to the generic f64 path — `pts[i - 1]`
with a known-i32 `i` compiles as `f64.convert_i32_s` → `f64.sub 1` →
`i32.trunc_sat_f64_s` and **survives Binaryen -O3** (value-range recovery
needs semantics Binaryen doesn't have); `i < n` re-truncates the
loop-invariant `n` every iteration. This pattern is endemic in numeric code
— precisely the workloads a Wasm compiler should win.

## Proposed approach

1. One `numericFacts(node): { kind: i32|u32|f64, range?: [lo,hi] }` module —
   a small forward lattice over expressions (literals, annotated vars,
   loop-var promotion results, array lengths, index arithmetic ±k, bitwise
   ops), consulted via the type facade (#1930) or directly pre-facade.
2. Replace the three matchers with calls into it; their current behaviors
   become test fixtures (no regression in what's already recognized).
3. Extend index-expression lowering (`property-access.ts` element access)
   to consume facts: `arr[i - 1]` with i32 `i` and known-nonnegative range
   emits `i32.sub` directly.
4. Loop-invariant comparisons: hoist the `i32.trunc`/convert of invariant
   bounds out of the loop (cheap local-caching at emission; full LICM is
   #1925's territory).
5. Measure: the review probe (`pts[i-1]` loop) plus `benchmarks` numeric
   suite.

## Acceptance criteria

- Probe shows pure-i32 index arithmetic in WAT (pattern test).
- The two "mirror" matchers are deleted; one module, ≥3 consumers.
- Equivalence + test262 green; numeric benchmark delta reported.

## Source

Compiler quality review 2026-06. Related: #1930 (TypeOracle), #1126
(signedness), #1925.
