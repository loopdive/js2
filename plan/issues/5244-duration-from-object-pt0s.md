---
id: 5244
title: "Temporal.Duration.from({days: 1}) answers 'PT0S' — object-form Duration construction loses every field, single-module"
status: ready
sprint: current
priority: medium
horizon: s
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-08-31
---

# #5244 — `Duration.from(object)` drops all fields

## Problem

`Temporal.Duration.from({days: 1}).toString()` answers `"PT0S"` (a zero
duration) instead of `"P1D"`, single-module, measured by dev-5242b on both
sides of PR #5354 (pre-existing, unchanged by the constructor bridge).
`new Temporal.Duration(0, 0, 0, 1)` answers `"P1D"` correctly, so the loss is
in the `.from(object)` field-extraction path — likely the same
absent-property / destructuring family as #5221 defect 1 or the #5243 bridge
argument marshalling, but with a silent zero instead of a throw.

## Direction

Probe after #5243 lands — it may be the same defect (the fields object
arriving null/opaque and every read defaulting to 0). If it survives #5243,
reduce inside the polyfill's `ToTemporalDuration` field reads and fix at the
general site.

## Acceptance criteria

1. `Temporal.Duration.from({days: 1}).toString()` → `"P1D"`; several field
   combinations covered; test failing on base.
2. No regressions in the issue-5221…5243 family. Gates green.

## Notes

- Found by dev-5242b (PR #5354), recorded so it is not rediscovered as a
  regression. Re-triage against #5243 first.
- Id reserved with a degraded PR scan; manually checked against open PR head
  branches 2026-08-31.

## Re-triage against #5243 — DONE, and the answer is "not the same defect"

Measured 2026-08-31 by the #5243 lane on a tree carrying **both** #5243's
`buildRecordFromExternref` and #5242's `__argc` constructor-bridge fix
(single-module lane, fresh `JS2WASM_TEMPORAL_CACHE`):

| row | result |
| --- | --- |
| `Temporal.Duration.from({days:1})` | `"PT0S"` — **unchanged** by either fix |
| `Temporal.PlainDate.from("2020-03-04").add("P1D")` | `"2020-03-05"` — fixed |
| `new Temporal.Duration(0,0,0,1)` | `"P1D"` — control, always correct |

So the Direction section's first hypothesis is **retired**: this is not the
#5243 null-argument defect, and not the constructor path either.

**Where it actually is.** The polyfill's `sn(e)` (ToTemporalDuration) object
branch is a computed-key copy into a statically-shaped record:

```js
const n = { years: 0, months: 0, …, nanoseconds: 0 };
let r = kt(e);
for (let i = 0; i < st.length; i++) { const t = st[i], o = r[t]; if (o !== undefined) n[t] = o; }
return new Duration(n.years, …, n.nanoseconds);
```

That shape was reduced in isolation — computed-key READ (`r[k]`) plus
computed-key WRITE (`n[k] = o`) into a three-field record, with a static-write
control and a read-only control — and it answers **correctly** (`"0/0/1"`,
`"0/1"`, `"1"`). So the generic computed-key machinery is fine and
member-set dispatch is **not** the place to look. The loss is in `kt(e)` (the
ToObject/copy of the user's object) or in `st` (the key list), i.e. upstream of
the copy loop.

Full context, and the separate class-value construct latch that is NOT this
row, are in
`plan/issues/5243-dynamic-method-bridge-object-arg-null.md` under
"Reported, NOT fixed".
