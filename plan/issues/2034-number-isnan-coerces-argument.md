---
id: 2034
title: "Number.isNaN/isInteger/isFinite coerce their argument via f64 hint — Number.isNaN('foo') returns true (should be false, no coercion)"
status: done
sprint: 61
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: number-methods
goal: core-semantics
related: [112]
origin: "2026-06-11 spec-conformance sweep (numbers agent): verified on main"
---

# #2034 — type-check predicates behave like the coercing globals

## Problem

```ts
Number.isNaN("foo" as any)   // wasm: true   node: false
```

Per §21.1.2.4, `Number.isNaN` returns false for any non-Number WITHOUT
coercion (that's its whole difference from global `isNaN`, which is
correct in wasm: `isNaN("foo")` → true matches Node).

## Root cause

`src/codegen/expressions/calls.ts:3371-3380` — the `Number.isNaN` inline
lowering compiles the argument with a `{kind: "f64"}` hint, so ToNumber
coercion ("foo" → NaN) runs before the `f64.ne` self-compare. The sibling
lowerings `Number.isInteger` (~3381) and `Number.isFinite` (~3400) use the
identical f64-hint pattern and share the family bug for non-number
arguments (e.g. `Number.isInteger("5" as any)` → true; code-confirmed,
isNaN runtime-verified).

## Fix direction

For statically non-number / any-typed arguments, emit a type-tag check
first (any-box tag ≠ number → false) and only then the numeric predicate;
statically-number arguments keep the current fast path.

## Acceptance criteria

- `Number.isNaN("foo")` false; `Number.isNaN(NaN)` true; global isNaN
  unchanged
- Same for isInteger/isFinite on non-number args

## Dupe check

#112 (done) implemented these inlines and even specified "strict NaN
check (no coercion)" — implementation coerces anyway; not tracked
anywhere. New.

## Sweep note

The rest of the numbers area is clean: 70/71 checks matched Node
bit-for-bit (number→string incl. fractional radix, toFixed/toPrecision,
parseInt/parseFloat/Number, ToInt32/ToUint32/shift/modulo, -0
propagation, Math edge cases).
