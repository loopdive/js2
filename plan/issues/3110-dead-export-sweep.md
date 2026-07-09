---
id: 3110
title: "Dead-code sweep: 128 exported symbols referenced nowhere else in src/tests/scripts"
status: done
sprint: Backlog
created: 2026-07-09
updated: 2026-07-09
completed: 2026-07-09
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

## Implementation notes (done 2026-07-09)

Re-verified the audit snapshot mechanically with a **node-based** cross-reference
scanner (not `grep`: `src/runtime-eval.ts` carries a NUL byte at offset 19327, so
`grep -I` silently returns empty for it — a false-dead hazard; node `readFileSync`
is reliable). The scanner counts word-boundary references for every named `src`
export across all `.ts` in `src`+`tests`+`scripts`, excluding the defining file.

Results on current main (283 exports with 0 external refs):

- **34 fully-dead** (declared, referenced nowhere including their own file).
- **249 internal-only** (used within their own file → demote-`export`-→-private,
  ~0 LOC; larger review) — left as a follow-up batch.
- **0 star-reexport-guarded** (no candidate is re-exposed via an `export *`
  chain from a public entrypoint `index/runtime/optimize/cli.ts`).

**This PR deletes 32 of the 34 fully-dead declarations** across 20 files
(**−823 LOC, 0 insertions**), via the TypeScript AST (exact node spans incl.
leading JSDoc), not fragile brace-matching. The 2 excluded are
`defaultEvalShim`/`defaultNewFunctionShim` in `runtime-eval.ts` — skipped because
the NUL byte makes automated AST edits on that file unsafe (documented for a
separate manual pass; the NUL byte itself is a pre-existing anomaly worth a
follow-up).

Biggest removals: `ensureEncodeIntoHelper` (native-strings.ts, −446 — a genuine
orphan: `TextEncoder.encodeInto` is served by a different live path and this
helper had **zero call sites even historically**), the object-ops descriptor
helpers `computeDescriptorFlags`/`emitDefinePropertyFlagCheck` (−227), plus dead
type/interface/const declarations (regex `CharClass`/`VmMatch`, IR `IrSymRef`/
`isIr*Ref`, `NATIVE_PROTO_FIELD_*`, `_Unused`/`_UnusedVal`, etc.).

Safety — all three gates green:

- `tsc --noEmit` clean (0 errors) — proves nothing referenced the deleted symbols.
- `prove-emit-identity check` → **IDENTICAL** (all 39 (file,target) emits
  byte-match the pre-deletion baseline) — deleting dead code did not change
  emitted Wasm.
- Biome lint clean; no orphaned-private lint errors.
- A/B control: `tests/issue-1780.test.ts` (encodeInto) fails the same 8 tests on
  clean `origin/main` as with the deletion — a pre-existing failure, unaffected
  by this change (confirms `ensureEncodeIntoHelper` was truly dead).

AC status: (1) partially — this PR removes the 32 fully-dead; the 249 demote-only
candidates are documented above as a follow-up (they need `export`→private, not
deletion, and yield ~0 LOC). (2) `tsc --noEmit` clean; targeted vitest green
(defineProperty, regex), encodeInto A/B neutral; test262 unaffected (emit
identical). (3) residual dead-export count recorded above (251 = 249 demote-only
+ 2 NUL-file-skipped).
