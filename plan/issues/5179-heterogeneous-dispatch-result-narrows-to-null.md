---
id: 5179
title: "A heterogeneous polymorphic return narrows to null at the consumer, so the property read throws"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: m
feasibility: hard
task_type: bugfix
area: codegen, classes
goal: core-semantics
related: [5178, 1917, 1299]
---

# #5179 — the caller downcasts a polymorphic result to the base's struct and gets `null`

## Problem

Split out of #5178, which fixed the *validity* half of this. When subclass
overrides of one method return differently-shaped object literals, the tag
cascade now widens its result to `externref` and the module validates. The
value, however, does not always survive the trip back to the caller.

Where the caller binds the result to a variable whose TypeScript type is the
**base's** declared return type, the local is emitted with that one struct type
and the value is narrowed with the guarded-downcast idiom (#1917,
`guardedRefCastInstrs` in `src/codegen/type-coercion.ts`):

```wat
any.convert_extern
local.tee $tmp
ref.test (ref 15)                  ;; the FIRST override's struct
(if (result (ref null 15))
  (then local.get $tmp  ref.cast null 15)
  (else ref.null 15))              ;; ← every other subclass's shape
```

A subclass returning any other shape therefore reads as `null`, and the next
property access throws `TypeError: Cannot access property on null or undefined`.

Reduction (JS, `allowJs`), overrides padded past the inlining threshold as in
`tests/issue-5178-virtual-dispatch-result-type.test.ts`:

```js
class HelperBase {
  estimate(seed) { /* … */ return { year: seed, month: 1, day: 1 }; }
  describe(seed) { const u = this.estimate(seed); return u.year; }
}
class PersianHelper extends HelperBase {
  estimate(seed) { /* … */ return { year: seed + 2, monthCode: 3 }; }
}
```

`p.describe(2)` answers a thrown `TypeError`; node answers the number. Writing
it as `this.estimate(seed).year` instead answers `NaN` — same cause, the read
lands on a struct the narrowing rejected.

## Not a regression

Before #5178 these programs emitted a module the engine refused outright, so
nothing about this shape ever ran. It also does not affect the
`@js-temporal/polyfill` lane that motivated #5178: there the receiving local is
already an `externref` (it is reassigned from `addDaysIso`), so nothing narrows
and the bundle validates and keeps its values.

## Why it is not in #5178

The narrowing is systemic and consumer-side: the local's Wasm type comes from
`resolveWasmType` over the TypeScript type at the declaration, not from the
initializer expression's actual `ValType`. `guardedRefCastInstrs` is shared by
~10 coercion sites, so changing "wrong runtime struct → null" globally is a
much larger blast radius than one dispatch emitter.

## Sketch

The honest fix is to let a declaration adopt the initializer's actual value type
when the initializer is dynamically typed — i.e. when the emitter returns
`externref`/`anyref` for an expression whose TS type is a concrete struct, keep
the local `externref` rather than narrowing. That has to be scoped carefully:
the same coercion is what makes ordinary host-boundary values usable as structs,
and blanket-widening would cost the struct fast path everywhere.

## Acceptance

* The reduction above answers the same number as node.
* No new failures in `class-*`, `issue-1299`, `issue-1917`-adjacent coercion
  tests, or the equivalence suite.
