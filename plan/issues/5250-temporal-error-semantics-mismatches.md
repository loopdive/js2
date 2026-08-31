---
id: 5250
title: "Compiled Temporal throws the wrong error where node's polyfill matches spec: PlainYearMonth.until missing-args RangeError (spec: TypeError) and non-ISO yearOfWeek RangeError (spec: undefined)"
status: ready
sprint: current
priority: medium
horizon: s
goal: error-model
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5250 — Temporal error-semantics mismatches vs the same polyfill in node

## Problem

Two small families where the COMPILED `@js-temporal/polyfill@0.5.1` diverges
from the SAME pinned polyfill running natively in node — so the defect is
ours, by measurement (dev-5248b probed both against node during #5248 triage):

1. **`Temporal.PlainYearMonth.prototype.until()` with missing arguments**
   throws **RangeError** compiled; node throws
   `TypeError: Either month or monthCode are required`. Test262
   `…/PlainYearMonth/prototype/until/arguments-missing-throws` asserts
   TypeError.
2. **`yearOfWeek`/week-of-year on non-ISO calendars** throws
   `RangeError: Invalid ISO date` compiled; node returns **`undefined`** for
   every non-ISO calendar (`intl402/…/yearOfWeek/non-iso-week-of-year`).

Both surfaced as "regressions" in PR #5375's 838-row sample — they were
wrong-reason passes before the provider existed (a bogus object's method call
happened to satisfy `assert.throws`), and are now honest failures.

## Direction

Likely one root each: (1) an error-construction path where the compiled
polyfill's argument-shape check falls into a range-check branch — probe which
check misfires (plausibly the same undefined-vs-missing-property distinction
as the #5221/#5243 record-nulling family); (2) a calendar-dispatch path where
the non-ISO branch is not taken compiled, so the ISO validator runs instead.

## Acceptance criteria

1. Base-failing reductions for both (compiled vs node on the pinned
   polyfill); fixed so compiled matches node.
2. The two named test262 rows pass with the provider linked
   (`JS2WASM_TEST262_TEMPORAL` lane); no provider-family regressions; gates
   green.

## Notes

- Filed from PR #5375's regression-triage table (dev-5248b).
- Id reserved with a degraded open-PR scan; manually checked against open PR
  head branches 2026-08-31.
