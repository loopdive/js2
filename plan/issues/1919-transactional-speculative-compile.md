---
id: 1919
title: "Transactional speculative-compile API — 23 probe/rollback sites leak locals, imports, and types"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
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
