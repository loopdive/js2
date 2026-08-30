---
id: 5219
title: An omitted optional argument is lowered to null, not undefined — n.sort() reaches Array.prototype.sort as sort(null) and throws
status: ready
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5219 — omitted optional argument crosses as `null`

## Problem

Calling `n.sort()` (no comparator) on an `any` receiver reaches native
`Array.prototype.sort` as `sort(null)`, which throws
"The comparison function must be either a function or undefined: null".
The omitted-argument lowering emits `null` where the spec (and the host
API) require `undefined` / absent.

Found by dev-5211 (PR #5314); pre-existing; pinned there by a
`known-unfixed` test row in tests/issue-5211-invoke-method-callable-arg.test.ts
so the eventual fix is noticed.

## Direction

Likely general beyond `.sort` — measure which call-lowering paths pad
missing optional arguments with a null externref instead of an undefined
sentinel, and fix at the lowering/coercion site, not per-method. Verify
`fn(undefined)` vs `fn()` distinction where observable (e.g. default
parameters see undefined for both).

## Acceptance criteria

1. `n.sort()` on an `any` receiver works host-lane; the #5211
   known-unfixed row flips to passing (update it). Add coverage for a
   user function with a default parameter called with the arg omitted.
2. No regressions in call-lowering scoped runs + equivalence gate (name
   them). Gates green.

## Notes

- Id reserved with a degraded PR scan; manually checked against open PR
  head branches 2026-08-30.
