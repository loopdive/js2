---
id: 1926
title: "Remove backend ValType/typeIdx from IrType — unions and boxing must be backend-symbolic"
status: ready
sprint: 65
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
language_feature: compiler-internals
goal: maintainability
---
# #1926 — Remove ValType/typeIdx from IrType

## Problem

The IR's type system embeds backend Wasm types, contradicting the
symbolic-ref premise that makes the IR backend-agnostic:

- `union.members: ValType[]` and `boxed.inner: ValType`
  (`src/ir/nodes.ts:211-216`) — and `ValType` includes
  `ref { typeIdx: number }`, a **module-relative concrete type index**,
  which `irTypeEquals` happily compares (`nodes.ts:335-341`). An IrType can
  smuggle exactly the raw indices the symbolic-ref design
  (`nodes.ts:22-28`) exists to eliminate.
- This pins the IR to one module instance and one backend: it blocks IR
  serialization/caching, and blocks the linear backend from adopting
  IR-driven unions (the `BackendEmitter` aggregate group, #1851/#1852).
- The resolver-deferred kinds (`string`, `object`, `closure`, `class`,
  `extern` — `nodes.ts:88-114`) already demonstrate the right pattern:
  structural shape in the IR, concrete layout decided at lowering.

## Proposed approach

1. `union.members: IrType[]`; `boxed.inner: IrType`.
2. Where a concrete reference is genuinely needed pre-lowering, introduce a
   symbolic `IrTypeRef` (interned shape key), resolved to `ValType` by the
   backend resolver at lowering — same mechanism the string/object kinds use.
3. Mechanical migration of `irTypeEquals`, propagate.ts's
   `lowerTypeToIrType`, the union passes (`passes/tagged-union-types.ts`),
   and lowering sites; behavior-identical for WasmGC (assert byte-identical
   output on the playground corpus, the #1713 method).
4. Follow-up unlocked (not in scope): aligning `propagate.ts`'s separate
   `LatticeType` with IrType so the two type systems stop diverging.

## Acceptance criteria

- `git grep 'typeIdx' src/ir/nodes.ts` shows no IrType-reachable concrete
  indices; `IrType` is serializable (JSON round-trip test).
- WasmGC output byte-identical on the corpus; equivalence + test262 green.

## Source

Compiler quality review 2026-06. Related: #1851 (legalization boundary),
#1852 (per-backend value representation), #1714.
