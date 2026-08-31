---
id: 5225
title: "Consumer-module object literals are opaque to a linked provider — Temporal.PlainDate.from({year,month,day}) throws 'year is required' while string and host-object forms work"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-30
---

# #5225 — provider seam: consumer struct opaque to provider module

## Problem

Through the #4628 compile-once linked provider,
`Temporal.PlainDate.from("2020-03-04")` and `.from(<host object>)` both work
(after #5221/PR #5334), but `.from({ year: 2020, month: 3, day: 4 })` — an
object literal built **in the consumer module** — throws
`RangeError: year is required`. The consumer's WasmGC struct crosses the #2527
linker seam as an opaque value the provider module cannot read properties
from, so the polyfill's field extraction sees no `year`.

This is the inbound twin of #5222 (PR #5324): #5222 made provider→consumer
values module-aware at the exit boundary; this is consumer→provider — a value
minted by module A, read by module B's `__extern_get`-equivalent path.

## Direction

Reduce with a non-Temporal linked pair: provider function
`f(o) { return o.x }`, consumer passes `{ x: 7 }`. Likely the same
module-aware mirror machinery from #5324 needs to run on the **argument**
path: when a consumer value enters a registered linked provider, wrap it as a
host mirror against the consumer's exports instead of handing over the raw
struct.

## Acceptance criteria

1. Non-Temporal reduction: provider reads consumer-literal properties
   correctly; new `tests/issue-5225-*.test.ts` failing on base (linked lane),
   single-module control passing on base.
2. `Temporal.PlainDate.from({year,month,day})` works through the provider;
   flip the corresponding knownGap/reported row in
   `tests/dogfood/temporal-global-harness.mjs` / issue-4628 tests.
3. No regressions: issue-5222/4628 test files + #2527 linker family. Gates
   green.

## Notes

- Found by dev-5221 validating PR #5334 (its PR body reports this defect
  explicitly rather than claiming it fixed). Same family as #5222.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-30.
