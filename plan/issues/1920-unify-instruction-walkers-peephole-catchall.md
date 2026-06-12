---
id: 1920
title: "One instruction walker — peephole misses catchAll bodies; ≥4 divergent recursive walkers"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: compiler-internals
goal: correctness
---
# #1920 — Unify instruction walkers; fix peephole catchAll gap

## Problem

≥4 hand-rolled recursive instruction walkers exist in the WasmGC backend with
**divergent child coverage**:

- `peephole.ts:76-95` — handles `catches` but **not `catchAll`**, so bodies
  built by e.g. `wrapAsyncCallInTryCatch` (`expressions.ts:336+`) are never
  peephole-optimized. (Bug, not just smell.)
- `stack-balance.ts:54-96` (`eliminateDeadCode`) — handles catchAll correctly;
  the two walkers diverged.
- `late-imports.ts:151-171`, `context/locals.ts:192-201` — their own copies.
- `src/codegen/walk-instructions.ts` exists **precisely for this** and has
  only 2 consumers.

Also cheap peephole wins identified while reviewing:
- ~23 sites materialize NaN as `f64.const 0; f64.const 0; f64.div`
  (`array-methods.ts:5801-5803`) when `{op:"f64.const", value: NaN}` is
  directly encodable and already used at `type-coercion.ts:2786` — 3→1
  instructions; the peephole can also normalize existing occurrences.
- No `local.set N; local.get N → local.tee N` fusion.

## Proposed approach

1. Make `walkInstructions`/`walkChildren` (`walk-instructions.ts`) the single
   traversal: enumerate child-buffer fields (`then`/`else`/`body`/`catches`/
   `catchAll`/`tryBody`…) in ONE place with an exhaustiveness check against
   the `Instr` union.
2. Port peephole, stack-balance DCE, late-imports, and locals scanning onto it.
3. Fix the catchAll gap (regression test: async call wrapped in try/catch,
   assert `ref.cast`+`ref.as_non_null` pair is collapsed inside the handler).
4. Add the NaN-const normalization and set/get→tee fusion patterns; replace
   the 23 div-NaN emission sites with the direct const.

## Acceptance criteria

- One walker; the four local recursions are gone.
- catchAll regression test passes; binary-size spot-check shows the NaN and
  tee savings on a closure-heavy example.
- Equivalence + test262 CI green.

## Source

Compiler quality review 2026-06. Related: #957 (peephole corpus), #1530.
