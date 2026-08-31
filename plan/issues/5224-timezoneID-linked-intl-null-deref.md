---
id: 5224
title: "Temporal.Now.timeZoneId() traps with a null deref only through the linked provider — the residual is the host Intl path it reaches, not the value crossing"
status: ready
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5224 — linked-lane `timeZoneId()` null deref via the Intl path

## Problem

`Temporal.Now.timeZoneId()` answers `"string"` when the polyfill is compiled
as a single module, but throws `RuntimeError: dereferencing a null pointer`
through the #4628 compile-once linked provider — and this SURVIVES the #5222
module-aware un-marshal fix (PR #5324), so it is not the value-crossing
defect. dev-5222's diagnosis: the residual is in what `timeZoneId` *reaches*
— the host `Intl.DateTimeFormat().resolvedOptions()` path (cf. #5206's Intl
materialization) — behaving differently inside a linked provider module.

Recorded as a `knownGap` in `tests/dogfood/temporal-global-harness.mjs`.

## Direction

Reduce with a non-Temporal linked package whose provider function calls
`new Intl.DateTimeFormat().resolvedOptions().timeZone` — establish whether
any host-global call (#3087/#5206 materialization) inside a linked provider
module misroutes, or whether it is resolvedOptions-specific. Fix at the
general site.

## Acceptance criteria

1. `Temporal.Now.timeZoneId()` returns a string through the provider; the
   non-Temporal linked reduction too; new tests/issue-5224-*.test.ts failing
   on base (provider lane) with single-module control passing; flip the
   harness knownGap.
2. No regressions in issue-5222/5206/4628 test files + linker family runs.
   Gates green.

## Notes

- Found by dev-5222 validating PR #5324. Related: #5221 (single-module null
  deref, different root), #5206 (Intl host global).
- Id reserved with a degraded PR scan; manually checked against open PR
  head branches 2026-08-30.
