---
id: 5294
title: "A module `let` on a reference slot silently drops a primitive assignment and reads back `null`"
status: done
sprint: current
created: 2026-09-03
updated: 2026-09-03
completed: 2026-09-03
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
func-budget-allow:
  - src/codegen/declarations/heterogeneous-scalar-var-widening.ts::referenceSlotReceivesPrimitive
---

## Problem

`moduleGlobalWasmType` commits a top-level binding's Wasm slot from its
**initializer alone**, so `let x = { a: 1 }` becomes
`(global $__mod_x (mut (ref null $obj)))`. A later `x = true` has nowhere to
go, and `coerceType`'s terminal fallback is `drop` + `pushDefaultValue`:

```wat
(func $set
  i32.const 1      ;; the boolean
  drop             ;; ← discarded
  ref.null 1       ;; ← stored instead
  global.set 8
```

The module **validates** — this is a silent wrong answer, not a trap. Every
read after the assignment answers `null`.

This is #4204's defect in the opposite direction. That one widened a
**primitive**-initialized slot that later received a reference
(`var x = 2; x = {}` → `NaN`); this is a **reference**-initialized slot that
later receives a primitive.

## Extent (measured through `compileAndRunUpstreamModule`)

| binding | later assignment | before |
| --- | --- | --- |
| `let x = { a: 1 }` | `x = true` / `5` / `"s"` / `undefined` | **`null`** |
| `let x = [1, 2]` | `x = true` | **`null`** |
| `let x = new C()` | `x = true` | **`null`** |
| `var x = { a: 1 }` | `x = true` | **`null`** |
| `let x = { a: 1 }` | `const v = 7; x = v` | **`null`** |
| `let x = { a: 1 }` | `x = { b: 2 }` | ok |
| `let x = { a: 1 }` | `x = null` | ok |
| `let x = { a: 1 }` | (never reassigned) | ok |
| function-local `let x = { a: 1 }` | `x = true` | ok |

Only the module-global typer pins the slot from the initializer, which is why
the function-local form is unaffected.

## Fix

Extend `heterogeneousWidenedModuleGlobalType` with the mirror predicate,
`referenceSlotReceivesPrimitive`: a mutable, un-annotated, module-scoped
binding whose initializer's static JS tag is `object`, and which some
assignment in its own source file stores a value of a **provably** different
tag into, is typed `externref`.

Deliberately narrower than the primitive side's `assignmentWidens`, which
widens on `mixed` (#4206):

- **`mixed` does not widen here.** An object slot receiving an unconstrainable
  value (`let cache = {}; cache = load()`) is the common shape in real module
  code, it is already lowered correctly, and widening it would be a
  representation change on a hot path bought with no evidence.
- **`null` does not widen.** A nullable reference already carries it, and
  `typeof null` is `"object"`, so the tag comparison excludes it on its own.
- **A `function` initializer does not widen.** Closure-typed globals already
  carry a later primitive correctly.
- **An explicit annotation does not widen** — the same representation-contract
  rule the primitive-side collector applies to its own initializer tag.
- `||=` / `&&=` / `??=` are excluded from the compound-assignment table: they
  store the right operand unchanged, which may well be a reference.

## Measured

- `tests/module-global-reference-slot-widening.test.ts`: 8 cases fail on the
  parent commit and pass with the fix; 4 more are guards for the shapes the
  widening deliberately leaves alone, and pass on both.
