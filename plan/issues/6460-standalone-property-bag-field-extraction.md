---
id: 6460
title: "standalone: property-bag FIELD EXTRACTION inside the Temporal provider — `PlainDate.from({year, month, day})` reads its own fields as `NaN`/`undefined`, so `canonicalizeCalendarEra` gets a non-string calendar and `year is required` fires"
status: in-progress
assignee: ttraenkler/dev-5383-s12
sprint: current
priority: high
horizon: m
goal: standalone
parent: 5383
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-13
---

## Problem

S11 (#6457) closed the `K.prototype`-on-a-dynamic-class hole and moved the
standalone linked-Temporal family to 170/360. The largest attributed residual is
NOT a member-read shape: every harness-shape reduction answers a correct string,
but `Temporal.PlainDate.from({year, month, day})` sees its own property-bag
fields as `NaN` / `undefined`.

Post-S11 attributed counts (from #6457's table):

| Bucket | Rows |
| --- | --- |
| PlainDate `calendar must be string in canonicalizeCalendarEra` | 21 |
| PlainDate `year is required` | 7 |
| Duration `Cannot access property on null or undefined at 164:22` (spread args into a linked ctor) | 9 |
| ZonedDateTime `required property 'timeZone' missing` | 7 |

The suspected construct is the polyfill's `PrepareCalendarFields` /
`ToIntegerWithTruncation` path: a computed-key read `bag[name]` where `name`
comes from a **sorted array of field names** on an **`any`** receiver, followed
by `ToNumber`-style coercion, plus `undefined` vs missing-key discrimination.

This issue is the S12 slice: census the field-extraction bucket with real
reductions, then fix the single root cause with the largest attributed row
count.

## Implementation Plan

(written before coding — see `## Attribution` below for the measured table that
drives which cause is fixed)

1. Reduce 4 PlainDate rows and 3 Duration rows to <=10-line standalone programs.
2. Dump the linked polyfill bundle (`linkPolyfillSource(setupTemporalPolyfill()).source`)
   and locate the exact construct around `PrepareCalendarFields` /
   `ToIntegerWithTruncation` / `GetOption`.
3. Identify the standalone lowering site that answers wrongly; write the
   attribution table into this file.
4. Fix the largest attributed root cause in a NEW module under `src/codegen/`,
   classified in `scripts/compiler-boundaries.json`. No new host imports.
   Resolve-or-reserve for late-minted funcs (`mintDefinedFunc`); rollbacks only
   via `snapshotSpeculative` / `rollbackSpeculative`. The `gc` lane must stay
   byte-identical.
5. Validate: reduction table before/after (base by file-copy revert), the three
   linked families (120 rows each), a must-not-move standalone sample, byte A/B,
   full gate chain, new vitest witness that fails on the base tree.

## Attribution

(filled in during S12)
