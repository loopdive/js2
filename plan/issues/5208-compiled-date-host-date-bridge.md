---
id: 5208
title: A compiled Date is a plain {timestamp} object to the host — Intl.DateTimeFormat.formatToParts(new Date(e)) throws Invalid time value
status: ready
sprint: current
priority: medium
horizon: m
goal: standalone-gap
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
---

# #5208 — compiled `Date` ↔ host `Date` bridging

## Problem

A compiled `Date` is a plain compiled object carrying a `timestamp` field,
not a host `Date`:

- `Object.prototype.toString.call(new Date(0))` → `[object Object]`
- `JSON.stringify({d: new Date(0)})` → `{"d":{"timestamp":null}}`
- `new Intl.DateTimeFormat().formatToParts(new Date(e))` →
  `RangeError: Invalid time value`, while `formatToParts(0)` works.

The Temporal polyfill's `getCalendarParts` uses exactly the
`formatToParts(new Date(e))` shape, so this sits on the #4628 path behind
#5207 (it is NOT the current front blocker — file order only).

## Direction

When a compiled `Date` crosses to the host (host-call arguments, `Intl`
methods, `JSON.stringify`, `Object.prototype.toString`), marshal it to a
real host `Date` built from the `timestamp` field (or teach `_wrapForHost`
a Date-carrier case). Measure which crossing points the polyfill actually
uses; don't widen speculatively. Keep the compiled-side representation
unchanged (standalone lane depends on it).

## Acceptance criteria

1. Reduced repros above pass on the host lane (toString tag, JSON, and
   formatToParts), at init and after init; new tests/issue-5208-*.test.ts
   failing on base.
2. Temporal harness measured before/after on the full stack; record where
   init stops.
3. No regressions in date-native / issue-1343 / issue-5180-family scoped
   runs (name them). Gates green.

## Notes

- Found by dev-5206 while validating PR #5271 (see its "also noted"
  section). Behind #5207 in the blocker order.
- Id #5208 reserved with a degraded PR scan; manually verified against
  open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.
