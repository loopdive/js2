---
id: 1930
title: "TypeOracle — one type-query boundary between the TS checker and codegen (unblocks TS7, kills suppression heuristics)"
status: ready
sprint: 61
model: fable
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: compiler
language_feature: compiler-internals
goal: maintainability
---
# #1930 — TypeOracle: one type-query boundary

## Problem

There is no abstraction between the TypeScript checker and codegen:

- **~397 `getTypeAtLocation` call sites** across 20+ codegen files thread a
  live `ts.TypeChecker` and raw `ts.Type` objects everywhere. The only
  firewalls are the small `ValType` mapper (`checker/type-mapper.ts:38`) and
  the partial IR `TypeMap`.
- This **forecloses the project's own TS7 plan**: typescript-native-preview
  has no JS-API TypeChecker; the shim already throws under `--ts7`
  (`src/ts-api.ts:114-131`, #1029). Migration today would be a rewrite.
- Type knowledge is fragmented across **four** uncoordinated mechanisms: the
  TS checker, the IR lattice (`ir/propagate.ts:220`), `shape-inference.ts`,
  and import-resolver's syntactic `any` stubs.
- The `number|null` → bare `f64` lowering spawned ~300 lines of heuristics
  (`compiler.ts:98-391`) that *suppress the checker's own correct
  diagnostics*, recognizing only direct `!== null` if-guards — suppression
  is inconsistent, and `compiler.ts:387-390` reaches into the unsupported
  internal `isTypeAssignableTo` API.

## Proposed approach

Architect spec first; then mechanical migration:

1. Define `TypeOracle` — the closed set of queries codegen actually needs
   (survey the 397 sites; expect ~15 query kinds: valTypeOf(node),
   isNullable, callSignatureOf, elementTypeOf, propertyTypeOf, …) returning
   **compiler-owned types** (ValType/IrType-level), never `ts.Type`.
2. Implement `TsCheckerOracle` (today's behavior) behind it; migrate codegen
   sites file-by-file with a grep ratchet on `getTypeAtLocation`
   (same mechanics as the #1095 cast budget).
3. Fold nullable-primitive handling into the lowering (branded externref or
   (i32-flag, f64) pair — coordinate with #1852's per-backend value
   representation), then delete the suppression heuristics in
   `compiler.ts:98-391`.
4. Later backends: TS7 LSP-based oracle; IR TypeMap as a refinement layer.

## Acceptance criteria

- Ratchet file counts direct checker access in `src/codegen/`; CI fails on
  growth; trend to zero.
- The suppression-heuristic block is deleted; `number|null` programs compile
  with correct semantics (tests).
- A `--ts7` smoke path can construct the oracle without `createProgram`.

## Source

Compiler quality review 2026-06. Related: #1029 (TS7), #1852, #1948 (numeric
lattice consumes the oracle). Needs `/architect-spec`.
