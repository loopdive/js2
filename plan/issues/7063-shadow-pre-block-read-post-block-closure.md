---
id: 7063
title: "codegen: a module global read BEFORE a nested block that shadows it with `let`/`const` still reads the block's pre-hoisted slot (0) — `const b = f; { let f = 7 }` gives 0 (node 1); a closure built AFTER the block that reads the module global also returns 0 (#6994 leftovers)"
status: ready
sprint: current
created: 2026-10-18
updated: 2026-10-18
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: scoping, let-const, shadowing
goal: core-semantics
related: [6994, 5271, 1177]
---
# Pre-block read and post-block closure still see the shadow's reserved slot

Two leftovers documented in PR #6696 (#6994).

## Repro (node → wasm, both lanes)

```ts
let f = 1;
export function test(): number { const b = f; { let f = 7; } return b; }   // node 1, wasm 0
```
```ts
let f = 1;
export function test(): number { { let f = 7; } const g = () => f; return g(); }   // node 1, wasm 0
```

## Root cause

- Pre-block read: `hoistLetConstWithTdz` pass 2 (`src/codegen/index.ts` ~15163) still reserves a function-level slot for the nested block's `let f` at function entry; a read of the module global before the block resolves `f` to that never-assigned slot. #6696 fixed the post-block restore (`saveBlockScopedShadows`), not the pre-block resolution.
- Post-block closure: the #1177 by-name rescan in `src/codegen/closures/arrow-phases.ts` resolves the capture by name against `localMap`, which still contains the dead slot; fixing it was out of scope for #6696 because #6697 was editing that file.

## Implementation Plan

1. In pass 2 of `hoistLetConstWithTdz`, do not pre-register a `localMap` entry for a nested-block `let`/`const` whose name is also a module global/function (`ctx.moduleGlobals`, `ctx.capturedGlobals`, `ctx.funcMap`); rely on `preallocateBlockScopedSlots` at block entry (verify it runs for these names). About 20 hoist call sites are affected per #6696's note; audit them with one helper predicate rather than editing each.
2. In `arrow-phases.ts` the by-name capture rescan must consult lexical scope (block-scoped bindings only while inside their block) instead of the flat `localMap`; reuse `blockBindingShadowsNestedDeclaration` / the block-scope stack #6696 introduced.
3. Tests: both repros, both lanes, plus the inverse (module global shadowed by a `var` inside the function) in `tests/equivalence/issue-7063-shadow-pre-block-read.test.ts`.


> Filed from the 2026-10-15 compiler audit follow-ups (surfaced by the #6991–#7001 implementation PRs). Under `plan/method/ir-only-development-freeze.md` a direct-AST semantic fix needs a specific user disposition; IR/shared-runtime work does not.
