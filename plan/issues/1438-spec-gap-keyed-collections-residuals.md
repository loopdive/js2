---
id: 1438
title: "spec gap: Map, WeakMap, and WeakSet residual collection semantics"
status: done
completed: 2026-06-12
created: 2026-05-11
updated: 2026-05-11
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: keyed-collections
goal: spec-completeness
sprint: 52
related: [837, 859, 1103, 1351]
---
# #1438 - Map, WeakMap, and WeakSet residual collection semantics

## Problem

Spec §24.1, §24.3, and §24.4 have no focused open tracker in the compliance
summary despite residual failures:

- Map: `177 / 215` passing, 38 failures.
- WeakMap: `110 / 141` passing, 31 failures.
- WeakSet: `76 / 85` passing, 9 failures.

Existing issues covered broad Wasm-native collection representation and older
Map `forEach` problems, but the report still needs a current issue for the
remaining spec gaps.

## Acceptance criteria

1. Map `forEach` callback `thisArg`, mutation-during-iteration, and callback
   error propagation match test262.
2. WeakMap/WeakSet reject invalid keys with the required TypeError behavior.
3. WeakMap/WeakSet constructor iterable handling closes iterators on abrupt
   completion.
4. Proposal-only methods are either implemented or intentionally filtered with a
   report-visible reason.
5. §24.1, §24.3, and §24.4 pass-rates improve and all remaining residuals point
   to narrower follow-ups.

## Files to inspect

- `src/codegen/builtins.ts`
- `src/runtime.ts`
- `tests/issue-1438.test.ts`
