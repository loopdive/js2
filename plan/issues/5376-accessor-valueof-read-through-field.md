---
id: 5376
title: "An accessor-backed `get valueOf()` read through a field coerces to 0 with the getter never run — this is the shape `TemporalHelpers.toPrimitiveObserver` mints (the `infinity-throws-rangeerror` ×3 and every observer row)"
status: ready
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/dev-5374
created: 2026-09-06
---

# #5376 — ToPrimitive misses an ACCESSOR-backed coercion method once the object is read out of a field

## Problem

Split out of #5374 while measuring it. #5374 fixed the *linked-seam* half —
a consumer-minted object whose `valueOf` is a compiled closure now coerces
correctly inside a linked provider. This is the other half, and it is **not a
seam defect**: it fails identically in the plain single-module lane, so no
cross-module fix can reach it.

Measured 2026-09-06 on a single `compile()` of one source file (no linking, no
Temporal), reading the probe values back through the module's exports:

| # | source | compiled | node |
| --- | --- | --- | --- |
| a | `({ get v() { return 3 } }).v` | 3 | 3 |
| b | `Number({ get valueOf() { return () => 3 } })` | 3 | 3 |
| d | `Number({ get valueOf() { calls.push("g"); return () => { calls.push("c"); return 3 } } })` | `3`, calls `g,c` | same |
| **f** | `f(o)` where `f(o){return Number(o.v)}` and `o = { v: { get valueOf() { return () => 3 } } }` | **0**, getter never run | 3 |
| **e** | same as f, with the `calls` observer | **0**, calls **empty** | `3`, calls `g,c` |
| g | same as f but `v: { valueOf() { return 3 } }` (method shorthand) | 3 | 3 |

So coercing the object **directly** fires the getter (rows b/d), and a
**method-shorthand** `valueOf` survives the field read (row g). Only the
combination — accessor-backed method, object obtained by reading a field —
loses it, and it loses it silently as `0`, not as a throw.

## Why it matters

`TemporalHelpers.toPrimitiveObserver` (test262 `harness/temporalHelpers.js`
~L1101) mints exactly that shape:

```js
toPrimitiveObserver(calls, primitiveValue, propertyName) {
  return {
    get valueOf() { calls.push(`get ${propertyName}.valueOf`); return function () { … }; },
    get toString() { … },
  };
}
```

and every caller hands it to a Temporal entry point as a **property of an
options / property bag** — `PlainYearMonth.from({ …, eraYear: observer })` —
so the polyfill reads it out of a field before coercing. The polyfill's
`ToIntegerWithTruncation` maps the resulting non-number to 0, which surfaces as
`RangeError: Cannot convert a number less than one to a positive integer` with
the observer's `calls` array EMPTY.

Measured through the test262 runner with the provider linked, on the #5374
branch (i.e. with the seam fix already in):

| expression | before #5374 | with #5374 | node |
| --- | --- | --- | --- |
| `Duration.from({hours:{valueOf(){return 2}}}).hours` | 0 | **2** | 2 |
| `PlainDate.from({year:2000,month:{valueOf(){return 3}},day:1}).month` | RangeError "…less than one…" | **3** | 3 |
| `PlainDate.from({…,day:{valueOf(){return Infinity}}})` | RangeError "…less than one…" | **RangeError `invalid number value`** | same |
| `PlainDate.from({year:2000,month:<accessor observer>,day:1})` | RangeError "…less than one…" | **unchanged** | month 3 |

The last row is this issue. It is why the 3
`intl402/Temporal/**/infinity-throws-rangeerror.js` rows did NOT flip on #5374
(measured base vs fix, 417 rows, 0 status changes in either direction) — they
all go through `toPrimitiveObserver`.

## Scope

Beyond the 3 infinity rows, `toPrimitiveObserver` backs
`checkStringOptionWrongType` and `checkRoundingIncrement…` across every
Temporal type, so the affected family is wide. The bound is not yet measured —
counting it is part of this issue, not an input to it.

## First thing to check

Rows b/d vs f/g localise it: the accessor must be recorded somewhere that the
FIELD READ does not carry. Compare what `{ get valueOf() {…} }` puts in the
object's sidecar / accessor table against what survives `o.v` (`__extern_get`
→ `__sget_v`) — most likely the read hands back a raw struct whose accessor
table entry is not consulted by the ToPrimitive walker's `__sget_valueOf`
probe, which finds an empty physical slot and reads it as absent.

## Acceptance criteria

1. Rows e and f above answer 3 (and the observer's `calls` records `g,c`) in
   the single-module lane, and identically through a linked provider.
2. The 3 `intl402/Temporal/**/infinity-throws-rangeerror.js` rows pass.
3. A bounded `toPrimitiveObserver`-dependent sample measured base vs fix per
   row, 0 pass→fail, counts stated with artifacts.

## Notes

- Id reserved via `claim-issue --allocate --allow-unscanned` (no `gh` in this
  container) — `pr_scan=degraded`, so re-check for a collision before merge.
