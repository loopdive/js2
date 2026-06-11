---
id: 1851
title: "Make BackendEmitter an explicit legalization boundary + extract a declared type-converter; add a backend-neutral mid-level"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-10
priority: medium
feasibility: hard
reasoning_effort: high
model: fable
task_type: refactor
area: ir
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [1713, 1714, 1715, 1185, 1168]
---
# #1851 — BackendEmitter as an explicit legalization boundary

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R4** (P2).

## Problem

The `BackendEmitter` trait (`src/ir/backend/emitter.ts`, with `wasmgc-`,
`linear-`, and `bytecode-emitter`) is the right seam, and the "vec" group
already routes through it to multiple backends (#1713/#1714/#1715). But the
backend boundary is still partly a hand-rolled lowering rather than an
explicit *legalization* step:

- `lower.ts` still emits `struct.new`/`struct.get`/`ref.cast` **inline** for
  the aggregate/closure/ref-coercion groups (tracked under #1713's migration
  order) — these are legalization leaks below the trait.
- `type-coercion.ts` is, in effect, our type-legalizer (externref boxing,
  i32↔f64, null/undefined-in-f64-context), but it isn't modeled as a
  *declared* type-converter consulted by the boundary.
- There is no single backend-neutral, Wasm-shaped mid-level (calls/locals/
  structured control resolved, object representation still abstract) where
  shared folding/peephole can run **once** before the GC-struct vs
  linear-load/store split.

## Recommendation

Model each backend as a **legality declaration + lowering-pattern set**
(which ops/types are legal; how illegal ones are rewritten) rather than an
imperative switch. "Is lowering finished?" becomes the checkable predicate
"only legal ops remain" (pairs with the per-backend legality check in
#1850/R1). Keep all lowering state **in the IR**, inspectable at every step —
not in opaque side tables.

## Acceptance criteria

- [ ] `type-coercion.ts` logic is reachable as a **declared type-converter**
      (`IrType` → backend value type) the boundary consults, with one home
      per backend.
- [ ] A **backend-neutral mid-level** exists above the struct-vs-linear
      split; shared fold/peephole (see #1853-adjacent / R8 via #1167a) runs
      there once for all backends.
- [ ] The remaining inline `struct.new`/`struct.get`/`ref.cast` in `lower.ts`
      (aggregate/closure/ref-coercion groups) route through the trait
      (continues #1713's migration order).
- [ ] No behavior change: equivalence + test262 green; cross-backend
      differential test (#1854) passes for the migrated groups.
