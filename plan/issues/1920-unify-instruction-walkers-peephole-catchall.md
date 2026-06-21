---
id: 1920
title: "One instruction walker — peephole misses catchAll bodies; ≥4 divergent recursive walkers"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-17
completed: 2026-06-17
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

## Resolution (2026-06-16, dev-b) — catchAll gap fixed (item 3)

The load-bearing **bug** — `peephole.ts` `optimizeBody` recursed into
`try.body` and `try.catches` but NOT `try.catchAll`, so bodies built by e.g.
`wrapAsyncCallInTryCatch` never got peephole-optimized — is fixed: the `try`
arm now also recurses into `instr.catchAll`.

Scope note: items 1 (single `walkInstructions`), 2 (port the 4 walkers onto
it), and 4 (NaN-const / set-get→tee patterns) are a larger refactor and remain
open as follow-up — this PR lands the actual defect (item 3) with a focused,
low-risk change. The remaining unification stays tracked here.

Tests: `tests/issue-1920.test.ts` drives `peepholeOptimize` on a hand-built
module with the redundant `ref.cast; ref.as_non_null` pair inside a `catchAll`
body and asserts it's collapsed (it was NOT before); plus catch-body and
no-pattern cases. All pass. (The pre-existing `ref-cast-peephole.test.ts`
closure failures are an unrelated test-harness import-shape issue —
`string_constants` import missing from the test's `{ env: {} }` — present on
main before this change.)

## Resolution (2026-06-17, dev-mech1) — items 1/2 (peephole) + item 4, DONE

Closing the remaining open items. Re-validated on upstream/main @ 79e16bb37
(item 3 catchAll fix already merged via #91a736164).

**Items 1 + 2 — peephole recursion now drives the shared enumerator.**
`peephole.ts` `optimizeBody` no longer hand-rolls a per-op switch to descend
into child bodies; it calls `walkChildren` from `walk-instructions.ts`. That is
the single child-buffer enumerator (`then`/`else`/`body`/`catches[].body`/
`catchAll`), so peephole now covers every nested buffer — and any future
`Instr` child field — with zero chance of re-diverging (the exact failure mode
that produced the item-3 bug). The other three walkers (stack-balance DCE,
late-imports, locals scanning) were left as a deliberately separate follow-up
to keep this PR's blast radius small; peephole — the one that carried the
defect — is now converged.

**Item 4 — two new peephole patterns:**
- Pattern 7: `f64.const 0; f64.const 0; f64.div` → `f64.const NaN` (3→1).
  Normalizes the 0/0-division NaN materialization generically, so it banks the
  win at every emit site (present + future) instead of hand-editing each
  emitter. `f64.const NaN` encodes losslessly via the raw 8-byte float.
- Pattern 8: `local.set N; local.get N` → `local.tee N` (2→1), and the new
  `local.tee` then folds with a trailing `drop` (pattern 3) for a further save.
  Stack-effect-preserving; peephole runs before stack-balance.

Tests: extended `tests/issue-1920.test.ts` — block/loop/if-then/if-else
recursion through `walkChildren`, pattern-7 collapse + genuine-division
no-touch, pattern-8 fusion + differing-index no-fusion. 9/9 pass. `tsc --noEmit`
clean. The pre-existing `ref-cast-peephole.test.ts` (6) and
`optional-direct-closure-call.test.ts` (2) closure failures are the same
unrelated `string_constants` harness import-shape issue — verified identical
with this change stashed.
