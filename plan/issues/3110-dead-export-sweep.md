---
id: 3110
title: "Dead-code sweep: 128 exported symbols referenced nowhere else in src/tests/scripts"
status: ready
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
priority: medium
horizon: s
feasibility: easy
model: opus
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [1172, 3102]
---

# #3110 — Dead-export sweep

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured)

A cross-reference scan of all 1,440 named exports in `src/` against every
`.ts` file in `src/`, `tests/`, and `scripts/` (textual name match — i.e.
_over_-counting usage, so the dead list is conservative) finds **128 exported
symbols referenced nowhere outside their defining file**. Top files:

| File                                                                     | dead exports                                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `src/codegen/declarations.ts`                                            | 6                                                                            |
| `src/codegen/native-proto.ts`                                            | 6                                                                            |
| `src/codegen/regexp-standalone.ts`                                       | 6                                                                            |
| `src/codegen/accessor-driver.ts`                                         | 5 (`CALL_ACCESSOR_GET/SET`, `CALL_REVIVER`, `CALL_TO_JSON`, `CALL_REPLACER`) |
| `src/codegen/closures.ts`, `literals.ts`, `object-ops.ts`, `ir/nodes.ts` | 5 each                                                                       |

Sample candidates: `buildDenoEnvDtsForSource` (checker/index.ts),
`compileNestedAwait`/`emitAsyncStateMachineFromIr` (async-cps.ts),
`emitUndefinedSingleton` (any-helpers.ts), `getFunctionOwnLocals`
(binding-info.ts). Plus known-dead fields: `FunctionContext.hoistedFuncs`
(#1172 Slice J, still present).

Dead exports are not just noise — each one keeps its transitive callee graph
alive through treeshake/DCE review and misleads greps during debugging
("who calls this? …nobody").

## Fix

1. Re-verify each candidate mechanically at implementation time (the audit
   list is a snapshot): confirm no reference via `export *` barrels
   (`src/ir/index.ts` has 8 `export *` lines) and no public-API exposure via
   `src/index.ts` / package `exports` (anything re-exported to consumers is
   NOT dead regardless of internal use — skip it).
2. Delete in batches by area: first demote `export` → module-private
   (`tsc --noEmit` then proves in-file usage or none), then delete the truly
   unreferenced along with now-orphaned callees.
3. Include the dead-field sweep (`hoistedFuncs` etc.) as a final commit.

## Safety story

`tsc --noEmit` + full vitest is sufficient: deleting an unreferenced symbol
cannot change emitted Wasm (it was never called). Run
`prove-emit-identity check` once per batch as the free invariant. Anything
that turns out referenced (tsc error) simply stays.

## Estimated LOC delta

≈ **−1,000 to −2,500** (128 symbols plus orphaned private callees; several
are 50+-line functions).

## Acceptance criteria

1. ≤ 20 of the 128 candidates remain exported (each with a written reason —
   public API, test-only fixture, upcoming consumer).
2. `tsc --noEmit` clean; full vitest green; no test262 regression.
3. `knip`/`ts-prune`-style scan (or the audit script) re-run in the PR shows
   the residual count.
