---
id: 4589
title: "Cut one exact multi-source scalar leaf over to Prepared IR"
status: done
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
priority: critical
feasibility: medium
reasoning_effort: high
task_type: refactor
area: compiler, codegen, ir
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
parent: 3525
depends_on: [2138, 3520, 4579, 4583, 4588]
related: [3090, 3518, 3520, 3525, 3792, 4579, 4583, 4588]
assignee: ttraenkler/codex
files:
  - src/codegen/index.ts
  - src/codegen/multi-prepared-scalar-leaf.ts
  - tests/issue-2138-multi-module-ir-overlay.test.ts
  - tests/issue-4589-multi-prepared-scalar-leaf.test.ts
  - plan/issues/4589-multi-source-scalar-leaf-cutover.md
---

# #4589 — cut one exact multi-source scalar leaf over to Prepared IR

## Problem

The bounded #2138 multi-source overlay already patches `entryPure` through IR,
but only after the direct compiler has emitted its body. That leaves two
physical AST-codegen entries (`compileFunctionBody` and `compileStatement`) for
a source-local scalar singleton whose exact source UnitId and Program ABI
callable are already available before the body loop.

Multi-source declaration collection, import aliasing, module-init ordering, and
callback reservation are graph-wide. The cutover therefore cannot reuse the
single-source early route blindly or prepare the same owner again in the late
overlay.

## Scope

- Prepare at most one graph-wide eligible, named, top-level numeric scalar
  `FunctionDeclaration`, and only when it belongs to the standalone entry
  source.
- Require the exact UnitId terminal/claim, fully annotated f64 Program ABI,
  source callable allocation, singleton local call component, collision-free
  flat registry, and one-entry Prepared skip projection with a nonempty
  `preparedComponentId`.
- Exclude cross-file/import/module-storage/callable/closure/class/support,
  CommonJS, collision, fast, WASI, IR-first-disabled, and late-provider edges
  before requesting a direct-body skip.
- Carry candidate-source plans, the Prepared report/completed set, and the
  correlated skipped UnitId into the ordinary late overlay. Complete and
  consume that report exactly once.
- Keep the route default-on with
  `JS2WASM_MULTI_PREPARED_SCALAR_LEAF_CUTOVER=0` as the bounded one-release
  control. `JS2WASM_IR_FIRST=0` and `disableIrFirst` retain their wider opt-out
  contracts.

## Non-goals

- Multi-source module-init preparation or generic multi-owner inversion.
- Cross-file call-component, class, closure, derived-support, CJS, fast, or
  WASI ownership.
- Removing `compileDeclarations`, changing `ModuleInitMode`, or treating one
  scalar leaf as evidence that direct codegen is globally deletable.

## Acceptance criteria

- [x] Default standalone compilation bypasses poisoned direct emission for the
      exact `entryPure` leaf; the route switch restores the two direct entries.
- [x] Kill-switch on/off binary, WAT, and runtime behavior are exact.
- [x] The canonical #2138 standalone audit moves from 14 to 12 total physical
      rows and from 12 to 10 non-`compileDeclarations` roots; the exact multiset
      difference is only `entryPure`'s function-body and statement rows.
- [x] Exact UnitId-attributed rows move from 11 to 9. The dependency discovery
      `compileModuleInitBody` row is intentionally source-attributed without a
      UnitId, so it is not misreported as a twelfth UnitId row.
- [x] `compileMulti` and `compileProject` both exercise a real two-source
      type-only dependency graph, with one `entryPure` IR emission and no
      direct `entryPure` row.
- [x] Graph ambiguity and representative callable/support predicates withdraw
      before skip; post-certification Program ABI drift fails closed.
- [x] Default GC, fast, WASI, and IR-first-disabled controls retain direct
      ownership.

## Measured checkpoint

The canonical #2138 standalone artifact remains byte-identical with the route
enabled and disabled: binary SHA-256
`6facf9cc597fc8b9b3070723139d5d91d88dfaf11868644e15d6eb606eb96bef`
and WAT SHA-256
`ebb3d4b26b057ac3798e423678c46f425da34c3b0a466cd7b7c2bc70f2fb5c74`.
Both modes report `irCompiledFuncs: ["entryPure"]` and leave
`irFirstSkipped` undefined. Every physical row other than the two
`entryPure` entries is unchanged.

## Completion evidence

- `tests/issue-4589-multi-prepared-scalar-leaf.test.ts`: 15/15 passed.
- `tests/issue-2138-multi-module-ir-overlay.test.ts`: 6/6 passed.
- `pnpm run typecheck`: passed.
- LOC and function budget gates: passed without allowances.
