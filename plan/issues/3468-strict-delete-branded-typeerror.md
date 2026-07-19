---
id: 3468
title: "Strict delete must throw a branded TypeError in the original harness"
status: done
created: 2026-07-19
updated: 2026-07-19
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen, test262
language_feature: strict-mode, delete, exceptions
goal: test262-conformance
related: [2703, 3370, 3434]
---

# #3468 — strict delete must throw a branded TypeError

## Problem

Strict deletion of a non-configurable property was lowered to a bare string
payload such as `"TypeError: Cannot delete non-configurable property in strict
mode"`. The synthetic Test262 runner accepted any thrown value, but the literal
upstream `propertyHelper.js` checks `error instanceof TypeError`. Consequently,
three Object descriptor tests passed the old project runner and failed the
original harness.

## Resolution

Route strict-delete and deleted-super errors through the shared dual-mode JS
error builder. JS-host runs now throw real TypeError/ReferenceError instances;
standalone and WASI use the corresponding native error structs. No Test262
source or harness helper is changed.

## Acceptance criteria

- Strict deletion of a non-configurable property throws a branded TypeError.
- Sloppy delete continues to return `false` without throwing.
- The three original-harness Object descriptor regressions pass in both their
  primary and strict variants.
- Deleted-super continues to throw ReferenceError.

## Validation

- `pnpm exec vitest run tests/issue-3468.test.ts --reporter=dot`
- `pnpm run typecheck`
