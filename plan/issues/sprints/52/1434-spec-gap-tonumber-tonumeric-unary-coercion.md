---
id: 1434
sprint: 52
title: "spec gap: ToNumber/ToNumeric coercion and unary operator edge cases"
status: done
created: 2026-05-11
updated: 2026-05-20
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: coercion, unary-operators
goal: spec-completeness
related: [1319, 1379, 1408, 1416, 1423, 1424]
---
# #1434 - ToNumber/ToNumeric coercion and unary operator edge cases

## Problem

Spec §7.1.4 and §13.5 are partial in the compliance report. The mapped unary
operator bucket is `180 / 302` passing with 104 failures and 18 skips.

The failures are spread across shared coercion behavior:

- `ToNumber` through `valueOf` / `toString` / `Symbol.toPrimitive`.
- Symbol conversion must throw TypeError in numeric and string contexts.
- BigInt and Number paths must not silently coerce across types.
- Unary `+`, unary `-`, bitwise-not, `typeof`, `void`, and `delete` need the
  same `ToNumeric` and ReferenceError propagation as the spec algorithms.

## Acceptance criteria

1. Centralize the runtime/codegen path used by unary operators on the same
   `ToNumber` / `ToNumeric` helpers used by global `isNaN` and `isFinite`.
2. Symbol numeric conversion throws TypeError without stringifying the symbol.
3. BigInt/Number mixed numeric paths preserve spec errors.
4. `language/expressions/unary/*` and the §7.1.4 mapped tests improve without
   regressing #1379.

## Files to inspect

- `src/codegen/unary-update.ts`
- `src/codegen/coercion.ts`
- `src/runtime.ts`
- `tests/issue-1434.test.ts`
