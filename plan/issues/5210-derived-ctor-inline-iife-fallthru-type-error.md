---
id: 5210
title: Wasm validation error when a derived-class constructor field is assigned from an inlined IIFE result — "type error in fallthru[0] (expected externref, got (ref null N))"
status: ready
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5210 — derived-ctor field from inlined IIFE result fails wasm validation

## Problem

In a derived-class constructor, assigning a field from an inlined IIFE's
result fails compilation:

```
Compiling function "G_init" failed: type error in fallthru[0]
(expected externref, got (ref null N))
```

Occurs even when the IIFE simply returns its parameter unchanged — no array
methods involved. Found by dev-5207 during #5207 validation; verified
PRE-EXISTING on pristine origin/main (unmasked, not caused, by PR #5279).

## Direction

The inline-IIFE lowering's result type ((ref null N)) is not coerced to the
externref the field-assignment fallthru expects. Likely a missing
`extern.convert_any` / coerceType call on the inline arm's result when it
flows into a class-field store inside a derived constructor. Reproduce
first (derived class + `this.x = (function(p){ return p; })(arg)` shape),
then locate the arm; keep the fix to the coercion site.

## Acceptance criteria

1. Reduced repro compiles, validates, and runs correctly, host AND
   standalone; new tests/issue-5210-*.test.ts failing (CE) on base.
2. No regressions in issue-5207 tests + inline-IIFE scoped runs (name them).
   Gates green.
3. Not known to be on the #4628 critical path — do not gate Temporal
   measurements on it, but note harness state if run.

## Notes

- Sibling #5209 is the current Temporal front blocker; this one is
  independent (compile-time, not dispatch).
- Id #5210 reserved with a degraded PR scan; manually verified against open
  PR head branches 2026-08-30. `check:issue-ids:against-main` arbitrates.
