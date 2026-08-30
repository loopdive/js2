---
id: 5222
title: "Temporal.Now.* methods are lost across the provider boundary — \"function\" single-module, undefined through the linked provider"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5222 — `Temporal.Now.*` lost across the provider boundary

## Problem

`typeof Temporal.Now.instant` is `"function"` when the polyfill is compiled
as a single module, but `undefined` when reached through the #4628
compile-once linked provider (PR #5318). Linking-specific: `Now`'s methods
do not survive the cross-module value crossing. dev-temporal-wire called
this the strongest next follow-up — `Now` is a plain namespace object of
functions, so whatever drops its members likely affects other
object-of-functions exports crossing module boundaries.

## Acceptance criteria

1. `Temporal.Now.instant()` / `Temporal.Now.plainDateISO()` callable through
   the provider; new tests failing on base (provider lane) with the
   single-module control passing on base.
2. Identify and state the general rule (which value shapes lose members at
   the link boundary) — if broader than Now, file it, don't widen the fix
   silently.
3. No regressions in issue-4628 + package-linker (#2527-family) tests.
   Gates green.

## Notes

- Found by dev-temporal-wire validating PR #5318. Siblings #5221/#5223.
- Id reserved with a degraded PR scan; manually checked against open PR
  head branches 2026-08-30.
