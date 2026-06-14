---
id: 1436
title: "spec gap: global object descriptors and global function coercion/URI semantics"
status: done
completed: 2026-06-12
created: 2026-05-11
updated: 2026-05-11
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: global-object
goal: spec-completeness
sprint: 52
related: [1006, 1066, 1073, 1129, 1319, 1434]
---
# #1436 - Global object descriptors and global function coercion/URI semantics

## Problem

Spec §19 and §19.2 are partial in the compliance report:

- §19 global object: `19 / 29` passing.
- §19.2 global functions: `246 / 322` passing.

The residual failures include `globalThis.eval`, frozen-globalThis behavior,
`isNaN`/`isFinite` ToNumber coercion, and URI encode/decode edge cases.

## Acceptance criteria

1. Global object properties have the expected descriptors and survive
   freeze/seal/preventExtensions checks used by test262.
2. `globalThis.eval` behaves consistently with the supported eval mode and does
   not report unrelated assertion failures.
3. `isNaN` and `isFinite` share the fixed ToNumber path from #1434.
4. `encodeURI`, `decodeURI`, `encodeURIComponent`, and `decodeURIComponent`
   handle UTF-16 surrogate and malformed escape cases per spec.
5. §19 and §19.2 mapped pass-rates improve and remaining unsupported cases are
   explicitly documented.

## Files to inspect

- `src/codegen/builtins.ts`
- `src/codegen/global-object.ts`
- `src/runtime.ts`
- `tests/issue-1436.test.ts`
