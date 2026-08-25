---
id: 4290
title: "codegen: widen heterogeneous class-instance array carriers"
status: done
sprint: 78
created: 2026-08-09
updated: 2026-08-18
completed: 2026-08-09
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: arrays, classes
goal: dogfood
related: [1244, 4288]
assignee: "ttraenkler/npm-compat-goal"
loc-budget-allow:
  - src/codegen/literals.ts
oracle-ratchet-allow:
  - src/codegen/literals.ts
func-budget-allow:
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/literals.ts::exactConstructedClassNames
  - src/codegen/literals.ts::classExtendsCarrier
  - src/codegen/literals.ts::isCommonClassCarrier
---

# codegen: widen heterogeneous class-instance array carriers

## Problem

After #4288 resolves Hono's imported router constructors to their exact classes,
`new Hono()` advances to a second null dereference. The literal
`[new RegExpRouter(), new TrieRouter()]` chooses the first instance's concrete
Wasm struct as its array element type. The second, unrelated instance is
guard-cast to that struct, becomes null, and `ref.as_non_null` traps during the
Hono initializer.

An unannotated array whose statically known reference elements have different
concrete Wasm types needs the universal reference carrier. Preserve homogeneous
class arrays and explicit common-supertype array contexts.

## Acceptance criteria

- [x] A reduced multi-module regression traps before the fix and returns `42`
      afterward while reading both class instances.
- [x] Hono constructs its heterogeneous router list and advances beyond this
      initializer trap.
- [x] Homogeneous and contextually typed class-array tests remain green.

## Result

Unannotated arrays of unrelated exact class constructions now use the lossless
externref carrier unless all classes share the selected class as a real base.
The reduction preserves both instance values and returns `42`; Hono constructs
its `RegExpRouter`/`TrieRouter` list and proceeds to the separate imported-base
heritage problem in #4291.
