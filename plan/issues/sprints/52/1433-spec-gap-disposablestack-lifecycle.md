---
id: 1433
sprint: 52
title: "spec gap: DisposableStack and AsyncDisposableStack lifecycle semantics"
status: in-review
created: 2026-05-11
updated: 2026-05-11
priority: medium
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime
language_feature: explicit-resource-management
goal: spec-completeness
related: [1020, 1036, 1037, 1413]
---
# #1433 - DisposableStack and AsyncDisposableStack lifecycle semantics

## Problem

Spec §27.6 still shows `75 / 165` passing with 90 failures. Existing issues
covered narrower null-trap, TDZ, and `SuppressedError` construction slices, but
there is no open tracker for the remaining stack lifecycle behavior.

The missing surface includes:

- `DisposableStack.prototype.use`, `adopt`, `defer`, `move`, and `dispose`.
- `AsyncDisposableStack` async disposal ordering and rejection handling.
- The disposed/moved state checks and required TypeError paths.
- Suppression chains when both the body and disposer throw.

## Acceptance criteria

1. `DisposableStack` disposal order is LIFO and exactly-once.
2. `move()` transfers stack entries and marks the original stack disposed.
3. `AsyncDisposableStack` awaits async disposers in spec order.
4. Suppressed errors preserve primary and suppressed values.
5. §27.6 pass-rate improves materially and all new helpers work in standalone
   mode without relying on host-only mutable JS state where avoidable.

## Files to inspect

- `src/codegen/builtins.ts`
- `src/codegen/runtime-builtins.ts`
- `src/runtime.ts`
- `tests/issue-1433.test.ts`
