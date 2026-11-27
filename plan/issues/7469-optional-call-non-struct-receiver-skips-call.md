---
id: 7469
title: "`o?.f?.()` on a non-struct receiver returns the default value instead of calling (legacy)"
status: ready
sprint: Backlog
created: 2026-11-26
updated: 2026-11-26
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7430]
---

# #7469: `o?.f?.()` skips the call on a non-struct receiver

## Problem

PR #7425 ([#7430](https://js2wasm.loopdive.com/dashboard/issue.html?slug=7430-optional-call-on-undefined-class-field-callee-traps)) fixed `o?.f?.()` when `o` is a struct receiver.

When the receiver is not a struct, for example an externref or dynamic object, the legacy path in `src/codegen/expressions/calls-optional.ts` returns the call's default value without calling `f`, even when `f` is a function. Node calls it.

The defect is pre-existing; #7430 left this path unchanged.

## Acceptance criteria

- A pin test shows `o?.f?.()` on a non-struct receiver matching node on gc, standalone and wasi, for each of these cases:
  - `f` defined (the call happens, with `this === o`);
  - `f` undefined;
  - `o` nullish.

  The test fails on main.
- The fix reuses `compileOptionalPropertyValueCall`, as #7430 did, and adds no new call path.
- Bytes are unchanged for programs without the construct.
