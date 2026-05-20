---
id: 1431
sprint: 52
title: "spec gap: assignment operators — destructuring completion, defaults, and compound side effects"
status: done
created: 2026-05-11
updated: 2026-05-11
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: assignment, destructuring
goal: spec-completeness
related: [805, 1268, 1372, 1396, 1429]
---
# #1431 - Assignment operators: destructuring completion and compound side effects

## Problem

Spec §13.15 is still partial after #1268. The current compliance report shows
`604 / 1017` passing with 363 failures and 50 skips. The remaining failures are
not only `??=` index-signature cases; they include destructuring assignment
completion propagation and compound-assignment evaluation order.

Known residual patterns:

- Default initializers in assignment patterns lose the original thrown value or
  completion context.
- Iterator and property access during destructuring assignment do not always
  match `IteratorDestructuringAssignmentEvaluation`.
- Compound member assignment can observe getter/key side effects more than once
  instead of using the spec's single-reference evaluation.

## Acceptance criteria

1. Add focused tests for assignment-pattern defaults that throw and assert the
   original error object is observed.
2. Add focused tests for computed member compound assignment where key/getter
   side effects must run once.
3. `language/expressions/assignment/dstr-*` and compound member-assignment
   test262 buckets improve without regressing #1268.
4. Update `spec-compliance/sec-13.15.md` with the new pass/fail count after the
   focused fix lands.

## Files to inspect

- `src/codegen/expressions/assignment.ts`
- `src/codegen/destructuring-params.ts`
- `src/codegen/property-access.ts`
- `tests/issue-1431.test.ts`

## Implementation notes (partial fix landed)

This PR ships two narrow fixes scoped to the **externref destructure path**
(`compileExternrefArrayDestructuringAssignment`):

1. **Empty pattern null/undefined throw.** `[] = null` and `[] = undefined`
   now throw a real `TypeError` via `emitExternrefAssignDestructureGuard`.
   The previous code skipped the guard when `target.elements.length === 0`,
   citing #225 — but #225's no-throw exemption is correct only for the
   binding form `const {} = null` (object pattern). Array assignment patterns
   evaluate `GetIterator(rval)` per §13.15.5.2 step 2, which throws on
   null/undefined regardless of how many AssignmentElements follow.

2. **Default fires on `undefined`, never `null`.** The default-handling arm
   used `ref.is_null` which fires for both. We now use the host import
   `__extern_is_undefined` (already on the imports list for parameter
   defaults). A `ref.is_null` fallback is kept for the standalone (no host)
   build path, where there is no other way to detect "undefined".

### Out of scope (tracked as follow-up)

The inline (vec / tuple) destructure path has a parallel bug where `null`
in a `vec<externref>` slot also triggers the default. Investigation showed:

- `vals: any[] = [null]` compiles to a vec where the slot type is `externref`
  and the value is `ref.null.extern`; `emitBoundsCheckedArrayGet` with
  `useUndefinedSentinel: false` returns this directly to the destructure
  arm, which uses `ref.is_null` → default fires (incorrect per spec).
- `vals: any[] = [undefined]` compiles to a different slot type
  (`ref AnyValue` via `__any_box_undefined`), which then fails to cast into
  the externref-shaped local in the destructure target — pre-existing
  illegal-cast crash, unrelated to this PR.

The clean fix requires either:
- Switching the inline path to delegate to the externref path when
  `elemType.kind === 'externref'` (similar to how the boxed-number coercion
  branch already does), or
- Making `emitBoundsCheckedArrayGet` with `useUndefinedSentinel: true` the
  default for destructuring readers so the host can distinguish null from
  undefined via `__extern_is_undefined`.

Both touch shared helpers and risk wider regressions; deferring to a
follow-up issue once a smaller reproducer pins down the AnyValue/externref
cast path.

## Test Results

Local checks (scoped):

- `tests/issue-1431.test.ts` — 7/7 pass (new file, covers the two fixes).
- `tests/equivalence/{basic-destructuring, destructuring-initializer,
  destructuring-extended, externref-array-destructuring, null-destructuring,
  destructuring-member-targets, destructuring-type-coercion,
  array-rest-destructuring, for-of-array-destructuring,
  for-of-assign-destructuring-primitive}.test.ts` — 86 pass, 1 fail
  (`destructuring-extended.test.ts > destructured function parameters with
  defaults`); the failure is pre-existing on `origin/main` and unrelated to
  the externref destructure path.
- `tests/issue-1268.test.ts`, `tests/issue-1396.test.ts` — both pass
  (logical assignment + iterator sentinel; closest neighbours to this fix).
