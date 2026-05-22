---
id: 820k
title: "Object.* receiver TypeError on null/undefined (ToObject step) (~39 fails)"
status: ready
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bug
area: builtins
goal: async-model
parent: 820
es_edition: ES2017
language_feature: object-builtins
test262_fail: 39
created: 2026-05-21
---

# #820k — Object.* receiver ToObject TypeError

## Problem

~39 test262 failures across `built-ins/Object/*` where the entry point
fails to throw `TypeError` for null/undefined receivers (or non-object
arguments where the spec requires ToObject coercion). Currently we either
null-deref or silently coerce.

Coordinate with #1129 (ToObject §7.1.18) which closed the primitive
auto-boxing path; this is the entry-point Object.* receiver-validation
residual.

## Sample failing tests
- `test/built-ins/Object/S15.2.1.1_A2_T11.js`
- `test/built-ins/Object/entries/getter-removing-future-key.js`
- `test/built-ins/Object/S15.2.1.1_A1_T1.js`

## Suspected source

- `src/codegen/builtins/object.ts` — entry points for `Object.entries`,
  `Object.keys`, `Object.values`, `Object.assign`, etc. — missing
  RequireObjectCoercible step before ToObject.

## Spec reference

- ECMAScript §7.1.18 ToObject
- §7.2.1 RequireObjectCoercible
- §20.1 Object Constructor (per-method receiver validation)

## Acceptance criteria

- [ ] At least 30 of the ~39 tests flip to `pass`.
- [ ] Object.* throws `TypeError` (not `null deref`) on null/undefined
      receiver/argument where spec requires.
- [ ] No regressions in already-passing Object.* tests.

## Notes

- Likely a small, mechanical fix once #1129 lands. Consider sequencing
  after #1129.
