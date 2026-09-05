---
id: 5251
title: "Temporal residual numeric/calendar seam families: 'invalid number value' (43), HebrewHelper illegal cast (29), JSBI toNumber seam (11), year/eraYear-required (10) — sampled census"
status: ready
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5251 — Temporal residual numeric/calendar seam families (sampled census)

## Problem

After the #5248 runner wiring (PR #5375), dev-5248b's 838-row sample census
leaves four mid-size failure families beyond #5249 (adjustCalendarDate trap)
and the already-filed #5221/#5243 (destructure-null, 74) and #5223-adjacent
`invalid receiver` (51) families:

| sampled rows | error shape | first suspicion |
| --- | --- | --- |
| 43 | `invalid number value` | a numeric coercion at a provider seam produces a value the polyfill's own validator rejects (NaN/undefined where an integer is expected) |
| 29 → 120 | `HebrewHelper` illegal cast | **SUPERSEDED by #5352** (2026-09-05): measured on all 123 #5249 rows, every non-Hebrew calendar is statically bound into `HebrewHelper_maximumMonthLength` — a dispatch defect, not a seam one |
| 11 | JSBI `toNumber` seam | the compiled polyfill's BigInt shim (`jsbi@4.3.0`) mis-converts at a linked-module boundary |
| 10 | `year/eraYear is required` | era/eraYear property reads return undefined on objects that carry them — likely the #5225 decoder-provenance family's write/read twin (#5246 covers write paths) |

| 3 | `RangeError: Invalid monthCode: M13 in ti()` | (added 2026-09-05, PR #5577 measurement) 13-month calendars (Ethiopic/Coptic) — a month-code seam; probe after #5352 lands, it may be the same static-bind route |

## Bounds

- **Sample census only** (838 rows, not proportional to the full ~1,589-row
  bucket) — counts order the work, they are not bucket-wide claims.
- The four families may collapse into fewer roots (all four smell like
  provider-seam value/type fidelity, the #5225/#5243/#5246 lineage). Probe
  before splitting: a fix PR should re-measure the sampled bucket and report
  which families moved.

## Implementation Plan (Fable, 2026-09-05)

Blocked on #5352 for the calendar rows. Sequence: (1) after #5352 lands,
re-run the #5249 `family-123.txt` list and the 838-row census sample; (2) for
each surviving family write ONE 3-line compiled probe with node-on-polyfill as
control; (3) `invalid number value` — capture the exact value crossing the
seam (`typeof`, `Number.isInteger`) at the provider boundary, expect an
externref-boxed f64 read back as NaN/undefined; (4) JSBI `toNumber` — check
`jsbi@4.3.0`'s `toNumber` on a linked-module BigInt (i64 vs boxed) crossing;
(5) `year/eraYear is required` — read-path twin of #5246, verify the
`__struct_field_names` provenance from the MINTING module. Each family: fix
with base-failing test, or attribute to a filed issue with the probe.

## Direction

Start with one probe per family (3-line compiled repro against the linked
provider, node-on-polyfill as control, per the #5226/#5248 method). If a
family reduces to an already-filed issue, note it there and drop it here.

## Acceptance criteria

1. Each family either (a) reduced + fixed with a base-failing test, or
   (b) attributed to an existing filed issue with the probe as evidence.
2. Sampled-bucket re-measurement reporting per-family deltas; no
   provider-family regressions; gates green.

## Notes

- Filed from PR #5375's residual worklist (dev-5248b census).
- Id reserved with a degraded open-PR scan; manually checked against open PR
  head branches 2026-08-31.
