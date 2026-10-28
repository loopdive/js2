---
id: 7185
title: "Module-scope for-in / for-of pattern heads store into a __module_init local, not the module global"
status: ready
sprint: current
created: 2026-10-28
updated: 2026-10-28
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: ir-full-coverage
parent: 4495
related: [4495]
---

# #7185 — Module-scope for-in / for-of pattern heads write a local, not the module global

Residual B of [#4495](4495-string-slot-widening-dynamic-assignment.md). It is the same on `origin/main`.

## Problem

At module scope, a for-in identifier head and a for-of destructuring-pattern
head store into a function-local of `__module_init` instead of into the
module global. #4495 now widens the global correctly (`__mod_k`
f64 → externref); the value just never reaches it. Any read through the
global, such as from a function, sees the initializer:

| Program (module scope, both lanes) | node | head |
| --- | --- | --- |
| `var k=0; for (k in id({a:1})); ''+k` | `a` | wrong |
| `var k=0; for (k in id({a:1})); function g(){return k} ''+g()` | `a` | wrong |
| `var a='s'; for ([a] of id([[1]])); function g(){return a} ''+g()` | `1` | wrong |

- The for-in head goes through `forInIdentifierHeadLocal` (`statements/loops.ts`).
- The for-of pattern head allocates `(local $a externref)` in `__module_init`.
- The function-scope cells are right for the direct read.

## Implementation Plan (sketch)

- **Where.** In `statements/loops.ts`, resolve the head target through
  `resolveModuleAwareIdentifierWriteTarget` / `currentSourceModuleGlobalIndex`.
  That is the resolution destructuring assignment already uses (`assignment.ts`).
  Do not allocate a fresh local.
- **Reuse.** Use the shared write-target resolver; do not add a module-global
  special case in the loop lowering.
- **Acceptance.**
  - Each row is right on 4/4 cells.
  - Byte identity holds for loops whose head is a function local.
  - **Quality:** the head store has one code path for both scopes.
