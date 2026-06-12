---
id: 2021
title: "array literal [new Subclass(), new Base()] traps 'dereferencing a null pointer' — element type taken from first element, contextual annotation ignored"
status: ready
sprint: 63
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: arrays
goal: core-semantics
related: [786, 1021]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2021 — subclass-first array literal can't hold ancestor elements

## Problem

```ts
class Shape { area(): number { return 0; } }
class Circle extends Shape { r = 2; area(): number { return 3 * this.r * this.r; } }
const a: Shape[] = [new Circle(), new Shape()];
a.length
// wasm: trap "dereferencing a null pointer"   node: 2
```

`[new Shape(), new Circle()]` (base first) passes; sibling subclasses
work. Specifically subclass-first + ancestor-later.

## Root cause

`src/codegen/literals.ts:2436-2437` — element kind is taken from the
*first* element's type (`Circle`), ignoring the contextual `Shape[]`
annotation for ref kinds; later base-class elements can't satisfy
`(ref $Circle)` and end up null. (The null-literal/object-element
promotions at 2444-2465 don't cover ref-vs-ref supertype mixes.)

## Fix direction

Prefer the contextual type annotation's element type when present;
otherwise compute the least common ancestor of element ref types.

## Acceptance criteria

- Repro works; polymorphic `for (const s of a) s.area()` dispatches
  correctly; base-first arrays unchanged

## Dupe check

#786/#1021 handled number+object and null mixes in this function; no issue
for subclass/superclass unification. New.
