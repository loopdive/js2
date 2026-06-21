---
id: 1926
title: "Remove backend ValType/typeIdx from IrType — unions and boxing must be backend-symbolic"
status: ready
sprint: 64
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

## Disposition (PO true-up 2026-06-21, sprint-64, origin/main d0bf058bc) — CONFIRMED OPEN (pure refactor, no functional repro)

Verified the structural premise still holds in `src/ir/nodes.ts`:
`union.members: ValType[]` (~L60/216), `boxed.inner: ValType` (L216), and the
`typeIdx`-comparison branch in `irTypeEquals` (L338) all still embed
backend-concrete indices in `IrType`. No functional repro (this is an
IR-serialization/backend-agnosticism refactor — acceptance is byte-identical
WasmGC output + a JSON round-trip, not a test262 row).

**Stays `status: ready`. BACKLOG candidate for a conformance sprint** — no
test262 movement, broad IR-wide blast radius. De-prioritise out of the active
sprint-64 dispatch queue. See #1927 disposition for the cluster recommendation.
