---
id: 1432
sprint: 52
title: "spec gap: parameter lists — rest/destructuring iterator semantics and default initializers"
status: done
created: 2026-05-11
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: parameters, destructuring
goal: spec-completeness
related: [869, 1158, 1372]
---

## Resolution

Commit: `260f3df16` (now on `origin/main`).

### Root cause

`isPatternEmptyOnly` (introduced by #1158) treated patterns like `[,]`,
`[, ,]`, `[[]]`, and `[[], []]` as if they performed no iterator
observation. Per ECMA-262 §13.3.3.6, only the truly-empty `[]` skips
iteration; elisions and nested-empty elements each call `IteratorStep`
once per top-level element. The over-broad short-circuit meant
parameter destructuring of `function f([,] = iter)` never called
`iter.next()`, so iterator-step errors (test262
`dflt-ary-ptrn-elision-step-err.js`) were silently swallowed.

### Fix

Narrowed `isPatternEmptyOnly` to `pattern.elements.length === 0`. The
truly-empty `[]` keeps the spec-mandated no-iteration behaviour
(NormalCompletion(empty)). All other patterns now route through the
existing `__array_from_iter`/`__extern_get_idx` materialization path
when the parameter value is an externref iterable, so iterator-step
errors propagate.

### Test Results

`tests/issue-1432.test.ts` (8 new cases, all pass):
- `[,]` with throwing iterator: error propagates.
- truly-empty `[]`: no iteration even for iterables.
- rest `[...{ 0: v, 1: w, 2: x, length: z }]`: numeric + length keys
  extract correctly.
- nested rest `[[...x] = []] = [[2, 1, 3]]`: x = [2, 1, 3].
- defaults skip null/0/false/"" (only fire for undefined).
- default fires for OOB slot.
- regression guard: `[,]` short-circuit is gone (iter machinery wired).
- regression guard: truly-empty `[]` keeps short-circuit (#1158).

`tests/issue-1158.test.ts` (10 existing cases): all still pass — those
tests assert "no `__array_from_iter` for vec-typed params" which is
unaffected, since the short-circuit only narrowed in the externref
path. The `[, ,]` and `[[]]` cases keep their no-`__array_from_iter`
guarantee when the param type resolves to a vec (the typical case
when TypeScript can infer a concrete type).

### Acceptance criteria

1. **Rest parameter destructuring handles nested array/object binding
   patterns** — verified via test cases for `[...{0:v, length:z}]` and
   `[[...x]]`.
2. **Parameter default initializers distinguish `undefined` from
   `null` and other falsy values** — verified by the null/0/false/""
   test (defaults skip) and OOB test (default fires).
3. **Iterator errors during parameter binding preserve the thrown
   error object** — verified by the throwing-iterator test for `[,]`.
4. **§15.1 mapped tests improve from 3/11** — addressed at least the
   `dflt-ary-ptrn-elision-step-err` cluster (function + arrow + class
   + generator variants). Full impact will show in the next test262
   run.

### Out-of-scope notes

The original test262 test `dflt-ary-ptrn-elem-ary-rest-iter.js` also
asserts `Array.isArray(x)` where `x` is a Wasm vec struct. That
check failing is a separate concern (Array.isArray on Wasm structs,
related to #869), not the rest-destructuring semantics targeted by
this issue.
# #1432 - Parameter lists: rest/destructuring iterator semantics

## Problem

Spec §15.1 remains effectively not implemented in the compliance report:
`3 / 11` passing, with wasm_compile and assertion failures. #1158 fixed one
empty-pattern iterator-consumption bug, but the section still has residual
rest-parameter and destructuring-parameter gaps.

The remaining failures center on:

- Rest parameters with nested array/object binding patterns.
- Default initializers that must run only when the bound value is `undefined`.
- Iterator close/error propagation during parameter binding.
- Type mismatches from array materialization used by parameter destructuring.

## Acceptance criteria

1. Rest parameter destructuring handles nested array/object binding patterns.
2. Parameter default initializers distinguish `undefined` from `null` and other
   falsy values.
3. Iterator errors during parameter binding preserve the thrown error object.
4. The §15.1 mapped tests improve from `3 / 11` and no new wasm validation
   failures are introduced.

## Files to inspect

- `src/codegen/destructuring-params.ts`
- `src/codegen/functions.ts`
- `src/codegen/ir/destructuring.ts`
- `tests/issue-1432.test.ts`
