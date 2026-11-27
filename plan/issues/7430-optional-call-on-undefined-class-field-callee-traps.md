---
id: 7430
title: "`o?.f?.()` traps when the class field `f` holds `undefined` instead of short-circuiting"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7395, 7374, 2049]
---

# #7430 — `o?.f?.()` with an undefined class-field callee throws

## Problem

Found by RV7336 while reviewing #7395. Measured on the #7395 head 4f7b1a8d2f and on #7374's head bdeedb9f89 (same
answers on both), gc and standalone alike:

| program (`main()` returns 1 when the answer matches node) | node | we answer |
| --- | --- | --- |
| `class O { f: (() => number) \| undefined = undefined }`, `o?.f?.() === undefined` | 1 | throws (`WebAssembly.Exception`) |
| the same with `f = () => 7`, `o?.f?.() === 7` | 1 | 1 |
| object literal `{ f?: () => number }` holding `{}`, `o?.f?.() === undefined` | 1 | 1 |
| `o` itself `undefined`, `o?.f?.() === undefined` | 1 | 1 |

Only the class-field (struct) callee fails. The second `?.` must short-circuit when the field reads `undefined`.

## Cause (to confirm)

The closure-field fallback of `compileOptionalCallExpression` (`compileCallablePropertyCall`,
`src/codegen/expressions/calls-optional.ts`, #2049) extracts the struct field and calls it. It handles the
receiver's `?.` (the held receiver), but not the callee's own `?.`: an undefined field is still called, and the call
traps.

## Acceptance criteria

- `o?.f?.(args)` on a class-field callee holding `undefined` answers `undefined` without evaluating `args`, on gc
  and standalone.
- A defined callee is called exactly once, with the receiver as `this`.
- Pinned by a test covering undefined and defined callees, with and without arguments that have side effects.
