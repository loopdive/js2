---
id: 1946
title: "Closure devirtualization — statically-known callees pay ~15-instruction dynamic dispatch that Binaryen cannot remove"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: performance
area: codegen
language_feature: closures
goal: performance
---
# #1946 — Closure devirtualization for singleton callees

## Problem

A closure bound once to a known function is compiled as fully dynamic
dispatch (verified by compiling and disassembling a probe during the
2026-06 review):

- `const inc = () => counter++` stores the closure as **externref**
  (`extern.convert_any` at creation, `src/codegen/closures.ts:3673`).
- Every call does `any.convert_extern` → `ref.test` → guarded `ref.cast` →
  two null-check/throw blocks → `struct.get` funcref → second `ref.test` →
  `call_ref`, plus writes to `__argc`/`__extras_argv` globals
  (`src/codegen/expressions/calls-closures.ts:56-81, 132-152`) — **~15
  instructions of dynamic dispatch to a callee that is a statically-known
  arrow in the same function**.
- **Binaryen -O3 provably cannot repair it**: the externref round-trip
  launders the type, and the `__call_fn_*` exports pin escape — the
  optimized binary still does per-iteration `ref.test` + `call_ref` +
  throws.

This poisons every callback-style API: `map`/`filter`/`forEach` lowering,
scheduler-style code — the exact workloads where the honest benchmark suite
shows JS winning.

## Proposed approach

1. **Singleton-callee analysis per binding**: a closure-typed binding whose
   value set is one known function literal (single assignment, no
   reassignment, not passed somewhere that loses identity) compiles calls
   as direct `call $__closure_N_impl(env, args…)`.
2. Keep the local typed `(ref $__closure_N_struct)` instead of externref for
   closure values that don't cross a host/`any` boundary; box to externref
   only at true escape points (depends on / overlaps #1947's boundary
   discipline — this issue can land for the strictly-local case first).
3. Mutable-capture refcells: when the cell is assigned `struct.new` in the
   same scope and provably non-null, skip the per-access null-or-NaN branch
   (`sample` probe showed null checks on a cell created two instructions
   earlier).
4. Measure on the callback-shaped benchmarks (`array/map`-style + the
   react-scheduler bench), not the landing-page micros.

## Acceptance criteria

- Probe loop calling a same-function arrow shows direct `call` (no
  `ref.test`) in WAT (pattern test).
- Equivalence suite green incl. reassigned-closure and escaping-closure
  cases (must keep dynamic path).
- Benchmark delta reported on ≥2 callback-heavy workloads.

## Source

Compiler quality review 2026-06. Related: #1947 (ref typing), #1948.
