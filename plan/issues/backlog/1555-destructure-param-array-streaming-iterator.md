---
id: 1555
title: "refactor: destructureParamArray — streaming IteratorStep-per-element instead of __array_from_iter materialisation"
status: ready
created: 2026-05-20
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor
area: codegen
language_feature: destructuring, iterators
goal: spec-completeness
parent: 1542
related: [1432, 1450, 1454, 1550, 1542]
---

# #1555 — Streaming iterator destructuring (replace `__array_from_iter` materialisation)

## Problem

`destructureParamArray` in `src/codegen/statements.ts` (and its callers in
`src/codegen/class-bodies.ts`) materialises the entire iterator into an array
via `__array_from_iter` before binding elements. This violates the ECMAScript
spec for patterns with elisions, rest elements, or early defaults:

**Repro (from senior-dev investigation of #1542, 2026-05-20):**
```ts
let first = 0; let second = 0;
function* g(): any { first += 1; yield; second += 1; }
class C { method([,] = g()): void {} }
// Spec §13.3.3.6 + §12.14.5.3: first=1, second=0 (one IteratorStep per Elision)
// Current main:                 first=1, second=1  (generator fully exhausted)
```

The `isPatternEmptyOnly` guard (narrowed in #1432 to length-0 patterns only)
does not protect elision-only patterns like `[,]`, so `__array_from_iter` still
runs and exhausts stateful iterators prematurely.

## Root cause

- `__array_from_iter` fully consumes the iterator into a JS array before any
  element binding begins.
- Spec §13.3.3.6 requires one `IteratorStep` call per binding element in
  order, with early termination when the iterator is exhausted — elisions
  consume one step each, rest consumes remaining.
- A streaming approach emits: `IteratorStep` → `IteratorValue` → bind, in
  element order. Elisions: `IteratorStep` only (no value consumed). Rest:
  loop until `IteratorStep` returns done.

## Scope

This is architecturally invasive — `destructureParamArray` is called from:
- `src/codegen/statements.ts` (function/arrow params, let/const/var destructuring)
- `src/codegen/class-bodies.ts` (method params ~line 1222)
- `src/codegen/expressions.ts` (assignment destructuring)

Estimated ~1300 LoC of pipeline + multiple call sites. Needs careful per-call-site
validation against existing test262 coverage.

## Diagnosis artifacts

`tests/issue-1542-repro.test.ts` contains 5 regression tests (3 pass / 2 fail
on current main). These become the acceptance test for this refactor.

## Implementation approach (needs architect spec)

1. Replace `__array_from_iter` call with a fresh `IteratorRecord` local
2. For each element in the pattern (in order):
   - Elision: emit `call $IteratorStep`, drop result
   - Binding: emit `call $IteratorStep` + `call $IteratorValue` (or use done sentinel)
   - Default: if done or undefined, evaluate initializer
   - Rest: loop `IteratorStep` collecting into array until done
3. After all elements: emit `IteratorClose` if iterator not exhausted
4. Gate the new path behind `ctx.streamingDestructure` flag initially; once
   validated, remove the materialisation path entirely

## Notes

- The architect spec for #1542 was incorrect — it pointed at `coerceType`
  externref→vec which already exists in main. The real fix is here.
- The "Cannot destructure null/undefined" error seen in test262 baseline may
  be a separate issue triggered by harness preamble shape; needs re-investigation
  with `pnpm run test:262` filtered to `language/statements/class/*dstr*`.

## Acceptance criteria

- `tests/issue-1542-repro.test.ts` 5/5 passing
- `pnpm run test:262` filtered to array-destructuring paths shows net improvement
- No regression on existing equivalence tests
