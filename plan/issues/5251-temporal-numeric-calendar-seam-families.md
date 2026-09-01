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
| 29 | `HebrewHelper` illegal cast (`ref.cast` failure) | non-ISO calendar helper subclass object crosses a seam and loses its concrete struct type |
| 11 | JSBI `toNumber` seam | the compiled polyfill's BigInt shim (`jsbi@4.3.0`) mis-converts at a linked-module boundary |
| 10 | `year/eraYear is required` | era/eraYear property reads return undefined on objects that carry them — likely the #5225 decoder-provenance family's write/read twin (#5246 covers write paths) |

## Bounds

- **Sample census only** (838 rows, not proportional to the full ~1,589-row
  bucket) — counts order the work, they are not bucket-wide claims.
- The four families may collapse into fewer roots (all four smell like
  provider-seam value/type fidelity, the #5225/#5243/#5246 lineage). Probe
  before splitting: a fix PR should re-measure the sampled bucket and report
  which families moved.

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
