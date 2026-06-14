---
id: 2021
title: "array literal [new Subclass(), new Base()] traps 'dereferencing a null pointer' — element type taken from first element, contextual annotation ignored"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-13
completed: 2026-06-13
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

## Resolution (2026-06-13)

Fixed in `compileArrayLiteral` (`src/codegen/literals.ts`, the real-first-
element branch). After deriving `elemWasm` from the first element's type, when
it resolves to a struct ref (`ref`/`ref_null`) and a contextual `Array<T>` /
`ReadonlyArray<T>` annotation is present whose element type also resolves to a
(different) struct ref, the literal now **prefers the annotation's element
type** — the declared common supertype that holds every element. TS has already
verified each element is assignable to `T`, so widening to it is sound. Base-
first ordering was already correct (element 0 IS the supertype); this fixes the
subclass-first ordering. Primitive/mixed/null/sibling-subclass paths are
untouched (the new branch is gated on `elemWasm` being a struct ref AND a
ref-typed contextual annotation differing from the first element's type).

## Test Results

`tests/issue-2021.test.ts` — 7/7 pass (`assertEquivalent`, wasm vs Node):
- repro `[new Circle(), new Shape()]` → length 2 (was trap);
- base-first ordering unchanged; polymorphic `for (const s of a) s.area()` → 12;
- ancestor field read via base method; 3-level hierarchy subclass-first;
- no-annotation sibling subclasses (unchanged); homogeneous `Circle[]` unchanged.

Class/array/destructuring equivalence suites (`ir-slice4-classes`,
`array-of-structs`, `anon-struct`, `self-referencing-struct`,
`destructuring-initializer`) — 27 tests, all green. IR fallback budget gate OK.
`biome lint`, `tsc --noEmit`, `prettier --check` clean.
