---
id: 1919
title: "Transactional speculative-compile API — 23 probe/rollback sites leak locals, imports, and types"
status: done
sprint: 65
created: 2026-06-10
updated: 2026-06-21
completed: 2026-06-21
assignee: sendev-spec-compile
priority: medium
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: correctness
---
# #1919 — Transactional speculative-compile API

## Problem

The probe-compile-and-rollback idiom — speculatively `compileExpression`,
inspect the result type, then truncate `fctx.body.length` to undo — appears
at **23 sites** (`src/codegen/array-methods.ts:2489-2492`,
`property-access.ts:2491`, `string-builder.ts:771-780`,
`statements/loops.ts` ×10, …). Rollback restores **only the body**: locals
allocated during the probe, late imports registered, closure counters,
registered struct types, and `ctx.errors` mutations all leak.

#1847 added `snapshotLocals`/`restoreLocals` (`src/codegen/context/locals.ts:201`)
for exactly this bug class, but only `loops.ts` adopted it (8 call sites);
the other ~15 truncation sites are unguarded. This is a heisenbug factory:
a probe that registers a late import perturbs function indices for the rest
of the module (interacts with #1916).

## Proposed approach

1. Add `withSpeculativeCompile(ctx, fctx, fn)` to `src/codegen/context/`:
   snapshots body length + locals (existing `snapshotLocals`) + `ctx.errors`
   length, and **defers `ensureLateImport` registration** until commit
   (queue-and-flush); rollback discards the queue.
2. Migrate all 23 truncation sites; lint/grep guard (`fctx.body.length =`
   outside the helper fails CI quality job).
3. Where the probe only needs a type, prefer adding a pure
   `inferExpressionWasmType(node)` that never emits — several sites
   (method-dispatch routers) need only that.

## Acceptance criteria

- Zero raw `body.length =` rollbacks outside the helper.
- Late imports registered during a rolled-back probe do not appear in the
  module (regression test).
- Equivalence + test262 CI green.

## Source

Compiler quality review 2026-06. Related: #1847 (snapshotLocals), #1916.

## Implementation notes (sendev-spec-compile, 2026-06-21)

**New module: `src/codegen/context/speculative.ts`.** Exposes
`snapshotSpeculative` / `rollbackSpeculative`, plus two ergonomic wrappers:
`probeCompiledType(ctx, fctx, fn)` (always rolls back — the dominant
"compile-only-to-read-the-type" probe) and `withSpeculativeCompile(ctx, fctx,
fn)` (commit-or-rollback for "try-lower; keep iff the shape matched" sites).

**Why snapshot-and-unwind, NOT the spec's "defer ensureLateImport" idea.** The
proposed-approach §1 (queue-and-flush late imports) is infeasible: the probe's
own `compileExpression` *uses* the funcIdx `ensureLateImport` returns — it bakes
a real `call funcIdx` into the body it emits. Deferring registration would make
the probe emit an invalid index. The probe discards that body anyway; only the
*registration side effect* leaks. So the correct design mirrors #1847's
snapshot/restore: capture the mutable state, let the probe run normally, then
unwind exactly what changed.

**What the snapshot captures (all O(1) except the #1847 locals key-set):**
`fctx.body.length`, the locals snapshot (#1847), `ctx.errors.length`,
`ctx.mod.imports.length`, `numImportFuncs`/`numImportGlobals`, and the
`pendingLateImportShift` reference. Notably it does **not** copy `funcMap` —
rollback derives the names to delete straight off the popped import descriptors
(`ensureLateImport` only appends a name that was absent from funcMap at snapshot
time, by its own early-return contract), so the snapshot stays cheap enough to
wrap the hot `compileExpression` path.

**Two non-obvious correctness hazards I had to handle (both caught by tests):**

1. **Import GLOBALS must NOT be popped.** Registering a JS-host string-constant
   global runs `fixupModuleGlobalIndices`, which *already shifts every
   `global.get` in committed bodies*. Naively decrementing `numImportGlobals`
   would leave those shifted indices out of range ("global index out of range —
   N"). Func-import indices are positional *among funcs* and independent of where
   globals sit in `mod.imports`, so rollback pops only the func-import entries and
   keeps the globals (idempotent/content-addressed — reused by the re-compile or
   inert). This broke `functional-array-methods` chaining tests until fixed.

2. **A mid-probe FLUSH makes the func-import pop unsafe.** Some emit helpers call
   `flushLateImportShifts` eagerly; if a probe flushed, committed func bodies were
   already shifted UP and the shift walker is forward-only (no cheap inverse).
   Rollback detects this (`pendingLateImportShift === null` while func imports were
   added) and *keeps* the imports registered — exactly the pre-#1919 behaviour
   (consistent, just a phantom import), never corrupting indices. The common
   no-flush probe still cleans up fully. So #1919 is strictly ≥ the old behaviour.

Registered Wasm **types** are deliberately left in place: type registration is
idempotent/content-addressed and type indices are never shifted by later import
additions (truncating could desync an earlier still-referenced struct — see
`project_type_index_shift_and_deadelim`). A probe-registered type is reused by
the re-compile or pruned by dead-type elimination.

**Migrated sites (≈20 across 6 files):** `array-methods.ts` (`inferExpressionWasmType`
+ the slow-path receiver probe), `property-access.ts` (`.length` fallback probe),
`string-builder.ts` (presize-bound try-lower), `expressions/calls.ts` (the two
`Array.from` try-lowers), `statements/loops.ts` (all for-of receiver/iterable
probes + the array-shape error exits; the unused `compileForOfIterator` snapshot
was dead and removed), `statements/destructuring.ts` (object/array/string
destructuring value-rollback exits), and the `compileExpression` wrapper
(`expressions.ts`) error-recovery exits.

**Drift gate:** `scripts/check-speculative-rollback-sites.mjs` (wired into the CI
`quality` job as `check:speculative-rollback`) fails on any new raw
`*.body.length = …` assignment under `src/codegen/` outside the helper. The one
legitimate non-probe truncation (a detached `arm` buffer clear in
`property-access.ts`) carries the inline `not-a-probe-rollback (#1919)` opt-out.

**Tests:** `tests/issue-1919-speculative-compile.test.ts` — unit contract
(import/local/error/latch unwind; re-register-after-rollback contiguity;
commit-vs-rollback; throw-then-rollback-and-rethrow; the flush-keeps-import
safety case) + two end-to-end compiles whose probe paths used to risk leaking.

**Validation:** broad-impact change (shared codegen machinery) — a scoped sweep
is not authoritative. Scoped confidence checks: tsc clean, prettier clean, biome
lint (no new errors), all quality sub-gates green (stack-balance, codegen-
fallbacks, any-box, coercion, the new speculative-rollback gate), and 96
equivalence tests + the affected unit suites (array-methods, for-of,
destructuring, string-builder, #1847) all pass. The merge_group full-Test262 run
is the authoritative conformance gate.
