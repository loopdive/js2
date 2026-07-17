---
id: 2185
title: "mutually-recursive const-arrow pair traps with runtime `illegal cast` (forward-reference closure boxing)"
status: ready
sprint: Backlog
created: 2026-06-17
updated: 2026-06-17
priority: medium
feasibility: hard
model: fable
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: closures
goal: compilable
related: [2118, 897, 1312, 1314, 1178]
origin: "2026-06-17 — split out of #2118 (self-recursion fixed there); mutual case is a distinct forward-reference defect"
---

# #2185 — mutual const-arrow recursion: `illegal cast` at construction

## Problem

A pair of mutually-recursive const/let arrows traps at runtime with
`illegal cast` (the trap is in the *outer* function at closure-construction
time, not inside either arrow):

```ts
export function test(): number {
  const a = (n: number): number => n === 0 ? 0 : b(n - 1);
  const b = (n: number): number => a(n);
  return a(3);
}
```

Expected `0`. Self-recursion (`const f = (n) => ... f(n-1)`) was fixed in
#2118; this mutual/forward-reference case was explicitly split out.

## Root cause (analysis from #2118)

`a`'s closure (`__closure_0`) references `b`, which is **declared after** `a`.
At the moment `a` is constructed, `b`'s outer slot is an uninitialized
`externref`, and `b` is written-in-outer (TDZ) so the capture is **force-boxed
as a `__ref_cell_externref`**. The construction prologue for `a` boxes the
(undefined) `b` and immediately `ref.cast`s it toward a closure-struct type.
Later, when `const b = (...)` runs, `b`'s closure struct is stored *directly*
into the `__boxed_b` slot rather than into the externref ref-cell that `a`
holds — so there are **two conflicting representations of "the box for b"**:
`a` reads `b` through a `__ref_cell_externref`, but the outer scope wrote a raw
closure struct. The mismatched `ref.cast` traps `illegal cast`.

(Verified: capture analysis records `b` as `{kind: externref}, mutable=true,
boxed=false` inside `a`; the outer assignment path overwrites the box with the
closure struct.)

## Fix direction

The peer bindings in a mutual-recursion cycle must be **hoisted and typed
against a shared wrapper supertype before either closure is constructed**, so
that:
- the ref-cell that `a` captures for `b` and the slot the outer scope writes
  `b` into are the *same* cell with a *consistent* value type, and
- call sites cast the captured peer to the shared `__fn_wrap_N` supertype
  (which every peer closure subtypes), never to a sibling's concrete struct.

This is the architect-level "recursive closure environment typing" noted in
#2118's Fix direction. Likely touches: capture force-boxing in
`compileArrowAsClosure`, the variable-init boxing/assignment path in
`src/codegen/statements/variables.ts`, and `compileClosureCall` cast targets.

## Acceptance criteria

- `const a = (n)=>n===0?0:b(n-1); const b = (n)=>a(n); a(3)` returns `0`
- Deeper cycles (3+ mutually-recursive arrows) validate and run
- #2118 self-recursion tests remain green; named-funcexpr fast path unregressed

## Test

Extend `tests/issue-2118.test.ts` (or a new `tests/issue-2185.test.ts`) with
the mutual pair and a 3-cycle case.
