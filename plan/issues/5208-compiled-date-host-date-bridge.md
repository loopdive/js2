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

## Implementation Plan (Fable, 2026-09-06)

**Why now.** With #5352/#5250/#5251/#5355 landed or in flight, this is the
single blocker for **66 of the 123** #5249 Temporal calendar rows (measured by
dev-5355, PR #5657): the polyfill's `getCalendarParts` calls
`formatToParts(new Date(e))`; the bridged `Intl.DateTimeFormat` now works for
`formatToParts(0)` but throws `RangeError: Invalid time value` for the
compiled `Date`, and the polyfill's `catch` rewrites that into
`Invalid ISO date`. Per-calendar: islamic-civil 13, coptic 13, islamic-tbla 9,
ethiopic 8, islamic-umalqura 7, ethioaa 7, buddhist 6, other 3.

1. **Measure the crossing points the polyfill actually hits** (do not widen
   speculatively). Instrument `_wrapForHost` (or whichever marshaller hands a
   compiled struct to a host call) with a temporary env-gated log keyed on the
   compiled `Date` struct type, run `family-123.txt` provider-linked, and list
   the host call sites that receive one: expect `Intl_DateTimeFormat_formatToParts`
   (extern-class method arg) and possibly `resolvedOptions`/`Date.UTC`
   round-trips. That list is the scope.
2. **Marshal at the host boundary, keep the compiled representation.** In the
   extern-class method-argument path (the `Intl_<Class>_<method>` externref-in
   bridge, `src/codegen/extern-declarations.ts` / the runtime side in
   `src/runtime.ts`), when an argument is a compiled `Date` struct (recognise by
   struct type / `__tag`, not by duck-typing `timestamp`), build
   `new Date(timestamp)` on the host side and pass that. Cache nothing; a
   `Date` is a value. The compiled side stays `{timestamp}` — the standalone
   lane depends on it (#1343 date-native).
3. **The two other repros in Problem** (`Object.prototype.toString` tag,
   `JSON.stringify`) are the same marshalling class — fix them in the same
   boundary if the crossing goes through the same code; otherwise leave them
   with a stated bound. Do not add a Date-specific `toJSON` in compiled code.
4. **Reduction + test** `tests/issue-5208-*.test.ts`: the three Problem repros
   plus `formatToParts(new Date(0))` in single-module AND linked lanes, at
   init and after init; base-failing.
5. **Measure** `family-123.txt` provider-linked, FRESH cache dir per compiler
   revision, on a base that includes #5355 (branch `issue-5355-intl-datetimeformat-bridge`
   / PR #5657 — stack on it and say "Land order: after PR #5657"): report
   pass/fail and per-calendar attribution; expect the 66 to move, and state
   the next layer.

Suites: `tests/date-native*`, `issue-1343*`, `issue-5180*` family, the 9
provider suites + 5250/5251/5355, `issue-4628-temporal-global`; equivalence
at 24/1718; `host-import-policy` green.

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
