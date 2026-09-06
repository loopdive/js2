---
id: 5360
title: "Compiled Temporal era arithmetic: `Unsupported era name` / `eraName must be string or undefined` on non-ISO calendars once instanceof stops short-circuiting (18 of 123 rows)"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
---

# #5360 — era arithmetic seam (newly visible after #5354)

## Problem

Measured by dev-5354 (PR #5661) on the 123-row #5249 Temporal calendar list,
provider linked, after the object-identity fix let `TemporalHelpers.assert*`
get past its opening `instanceof`:

| rows | error (thrown by the polyfill's own guards) |
| --- | --- |
| 10 | `RangeError: Unsupported era name: …` |
| 8 | `TypeError: eraName must be string or undefined …` |

Both come from `GregorianBaseHelper` / `JapaneseHelper` era handling in
`@js-temporal/polyfill@0.5.1`: era records are `{ name, isoEpoch, anchorEpoch,
hasYearZero, … }` held in an array on the helper, matched by `era.name` and
by aliases, and `eraYear`/`era` are read off the property bag the CONSUMER
passes (`{ era: "reiwa", eraYear: 1, month: 1, day: 1, calendar: "japanese" }`).
Same run: `eraYear.valueOf` never fetched (3 rows, observable-order family).
Node on the same pinned polyfill passes these rows.

## Implementation Plan (Fable, 2026-09-06)

1. **Probe the value at the seam, not the guard.** Two 3-line compiled
   repros vs node-on-polyfill: (a) `Temporal.PlainDate.from({era:"reiwa",
   eraYear:1, month:1, day:1, calendar:"japanese"})`; (b) the same with
   `era:"ce"` on `gregory`. Capture, inside the polyfill's era lookup, what
   `era` and `eraYear` actually ARE when they arrive: `typeof`, and whether a
   string survived the record bridge as a string. Suspects, in order:
   - the consumer's property-bag string crossing the #5243 record bridge as
     something other than a JS string (`eraName must be string` is exactly
     that guard firing);
   - an era TABLE entry read through a compiled array/object where a field
     comes back as a comma-joined carrier (dev-5247 saw `817405952,3352`
     reach `BigInt()` in #5245 — an array where a scalar was expected);
   - `era.name` compared by `===` against a bridged string that is a host
     mirror, so identity fails where value equality is meant.
2. Fix at the boundary that loses the type (record bridge / string carrier),
   not in the polyfill; if the string arrives intact and the lookup itself
   mis-compares, that is a codegen string-equality issue — reduce it without
   Temporal.
3. Reduction + base-failing test `tests/issue-5360-*.test.ts` (both lanes).
4. Measure `family-123.txt` provider-linked on a base stacked on PR #5661
   (#5354) — the rows are only reachable there. Report the 18 and the next
   layer; the 3 `eraYear.valueOf` ordering rows may be the same root.

## Acceptance criteria

1. Probe evidence: the first wrong value, where it became wrong.
2. Base-failing reduction; the 18 rows move (state counts); no regressions in
   the provider family; equivalence at baseline.

## Notes

- Filed from dev-5354's next-layer table, 2026-09-06. Stack on
  `issue-5354-linked-class-instanceof` (PR #5661).
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.
