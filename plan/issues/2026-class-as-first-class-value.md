---
id: 2026
title: "classes are not first-class values: new K() on a parameter throws 'No dependency provided for extern class', .constructor identity broken"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen
language_feature: classes
goal: core-semantics
related: [1395, 1116, 1721, 1992]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2026 — no runtime constructor-object identity

## Problem

```ts
const C = class { v = 3; m(): number { return this.v * 2; } };
function make(K: any): any { return new K(); }
make(C).m()
// wasm: THROW: No dependency provided for extern class "K"   node: 6
```

Also: `new A().constructor === A` → 0 (node: true); `A instanceof
Function` → false (filed separately as #1992). Direct `new C()` on a class
expression works.

## Root cause

`src/codegen/expressions/new-super.ts:1534` (`compileNewExpression`) — a
constructee that isn't a statically known class falls through to the
extern-class import intent, which `src/runtime.ts:4584` rejects; class
identifiers have no runtime constructor-object representation.

## Fix direction

Give each class a runtime constructor descriptor (struct with class-id +
ctor funcref); `new <dynamic>` dispatches through it when the static path
misses. Same descriptor backs `.constructor` identity and
`new.target === C` (#2023) — consider one architect spec for the family.

## Acceptance criteria

- Repro returns 6; `.constructor === A` true
- Statically-resolved `new` unchanged (no perf regression)

## Dupe check

#1395 (static descriptor, done), #1116b (JS-side ctor bridge, done), #1721
(subclass Function/Object, done). Class-through-variable `new` not filed.
New.
