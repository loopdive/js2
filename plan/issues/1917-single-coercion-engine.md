---
id: 1917
title: "One coercion engine — four divergent coercion matrices disagree about lossiness"
status: ready
sprint: 61
model: fable
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: correctness
---
# #1917 — One coercion engine

## Problem

Four independently-maintained type-coercion matrices coexist in the WasmGC
backend, and they **disagree semantically**:

- `coerceType` (`src/codegen/type-coercion.ts:980`, ~1,100 lines for one function)
- `coercionInstrs` (`type-coercion.ts:2695-2903`)
- `callArgCoercionInstrs` (`src/codegen/stack-balance.ts:1179-1310`)
- `fixBranchType` (`stack-balance.ts:678-764`), plus `fixLocalSetCoercion`

Observed divergence:
- externref→f64: `callArgCoercionInstrs` calls `__unbox_number` (correct);
  `fixBranchType` emits lossy `drop; f64.const 0` (`stack-balance.ts:724-728`).
- ref→f64: `coercionInstrs` pushes `f64.const NaN` (line 2786);
  `fixBranchType` pushes `0` (lines 737-742).

So the runtime value a coercion produces depends on *which syntactic context
triggered it* — call argument vs branch result vs local.set. Additionally,
the guarded-ref-cast idiom (tee tmp → ref.test → if/then cast / else null) is
copy-pasted ≥6 times within type-coercion.ts alone (1026-1048, 1067-1089,
2820-2834, 2843-2857, 2865-2878, 2885-2898).

## Proposed approach

1. Extract a single `coercionPlan(from: ValType, to: ValType, ctx) →
   { instrs: Instr[] } | { needsTemp: ... } | { lossy: true, instrs }` table
   in `type-coercion.ts`.
2. Consume it from all four call sites; delete the local matrices.
3. `lossy` arms emit a located diagnostic (ties into #1918's strict mode) —
   a lossy coercion in a branch fixup is an emitter bug being masked, and
   should be visible.
4. Extract one `guardedRefCast(toTypeIdx)` helper for the 6+ copies.
5. Add table-driven unit tests: for every (from, to) pair, all consumers
   produce identical instruction sequences.

## Acceptance criteria

- One coercion table; `callArgCoercionInstrs`/`fixBranchType` delegate to it.
- The externref→f64 and ref→f64 divergences are gone (branch context unboxes
  / NaNs identically to call-arg context), with a regression test for each.
- Equivalence + test262 CI green.

## Source

Compiler quality review 2026-06. Related: #1918 (fixup ratchet), #1858
(fail-loud umbrella).

## Amendment (2026-06-11, analysis program)

Two corpus-driven changes to this spec (full detail:
plan/log/analysis-2026-06/03-coercion-engine-spec.md and
05-structure-review.md §2a):

1. **The engine API must carry a `staticJsType?` hint.** The June corpus
   proved that dispatching on Wasm ValType alone mis-classifies values —
   the #2072 investigation showed booleans (i32) boxing as numbers,
   undefined/null (externref) as strings, native strings (eqref) as
   objects. A ValType-only engine reproduces that disease. Every entry
   point (`emitToString`, `emitToPrimitive`, `emitLooseEq`, …) takes the
   source expression's static TS classification when resolvable.
2. **The site inventory is larger than this issue assumed.** Report 03
   catalogued 37 sites: 13 ToString (the §7.1.17 matrix hand-rolled 7× —
   incl. template spans string-ops.ts:272-285, join elemToStr
   array-methods.ts:4543, standalone emitArrayJoin :4487+,
   $__any_to_string native-strings.ts:5417), 11 ToNumber/ToPrimitive,
   8 equality, 5 ToBoolean (incl. buildTruthyCheck, #2085). Migration
   order and the per-site bug map live in report 03 §3.

Sequencing: Step 0 (ValType table) is dependency-safe now; Steps 1+ land
AFTER the type-aware boxing P0 (#2072/#2080) so the engine consumes
correct tags. Drift gate: #2108.
