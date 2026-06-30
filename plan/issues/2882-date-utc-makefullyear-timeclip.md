---
id: 2882
title: "Date.UTC: MakeFullYear, MakeDay month-overflow, non-finite/TimeClip → NaN"
status: done
completed: 2026-06-30
sprint: current
priority: medium
horizon: m
area: codegen
language_feature: Date.UTC
feasibility: medium
assignee: ttraenkler/explore1
---

## Problem

`Date.UTC(...)` (ECMA-262 §21.4.3.4) was lowered with an old, incomplete code
path in `src/codegen/expressions/calls.ts` (the `method === "UTC"` block). It:

1. **Defaulted a missing year to 1970** instead of producing `NaN`.
   `Date.UTC()` must be `NaN` (step 1: `y = ToNumber(undefined) = NaN`).
2. **Skipped MakeFullYear** (§21.4.1.27): a year in `0..99` must map to
   `1900 + y`. `Date.UTC(0, 0)` was year 0, not year 1900.
3. **Did no MakeDay month normalization** (§21.4.1.12): `ym = yr + floor(m/12)`,
   `mn = m modulo 12`. `days_from_civil` only accepts a 1..12 civil month, so a
   large month overflow (`Date.UTC(2016, 144)`) and large negative month
   (`Date.UTC(2016, -13)`) produced wrong timestamps.
4. **Applied neither non-finite propagation nor TimeClip** (§21.4.1.14): a
   `NaN`/`±Infinity` component, or a `|t| > 8.64e15` result, must be `NaN`.
   `i64.trunc_sat_f64_s` silently clamped `NaN`/`±Inf` to `0`/`i64::MAX`.

The sibling `new Date(y, m, …)` constructor in `new-super.ts` already had the
correct non-finite + MakeFullYear + TimeClip logic (#1343); `Date.UTC` simply
hadn't been brought up to the same standard.

### test262 cluster (verified against current `origin/main`, fresh single-file)

`built-ins/Date/UTC` — 8 failing, all one root cause (the items above):
`no-arg`, `nans`, `infinity-make-day`, `infinity-make-time`, `year-offset`,
`time-clip`, `overflow-make-day`, and `fp-evaluation-order`.

## Fix

Rewrote the `method === "UTC"` block to mirror the proven constructor path:

- `args.length === 0` ⇒ emit `f64.const NaN` and return.
- Accumulate a non-finite flag (`v !== v` OR `|v| > 8.64e15`) for every
  **present** component (a missing arg uses a finite default, no contribution).
- Apply MakeFullYear to the year (`0 ≤ yr ≤ 99 ⇒ yr += 1900`).
- Normalize the month with a Euclidean floor-div/mod by 12 (i64 `div_s`/`rem_s`
  truncate toward zero, so a negative remainder borrows: `q -= 1; r += 12`),
  roll `q` into the year, feed `r + 1` as the civil month.
- TimeClip: if the non-finite flag is set, or `|ts| > 8.64e15`, return `NaN`;
  otherwise `f64.convert_i64_s(ts)`.

The change is a single per-call-site lowering in `calls.ts`; it emits code only
where a `Date.UTC(...)` call exists, so it cannot affect any other module.

## Result

`built-ins/Date/UTC`: 9/17 → **16/17** pass (+7). Fresh single-file Date-dir
regression sweep: **0 regressions** attributable to this change (the only
non-UTC flips don't call `Date.UTC` and are baseline-vs-main drift).

`fp-evaluation-order` remains failing: it asserts the exact IEEE-754 rounding
of MakeTime/MakeDate done in the Number (f64) domain for pathologically huge
components; our i64 accumulation can't reproduce it. Out of scope here.

### Known follow-up

`new Date(y, m, …)` has the same missing MakeDay month-normalization
(`new Date(2016, 144)` is off by the un-normalized civil month). Not test262
covered today; left for a focused constructor-parity change to avoid touching a
currently-passing path in this PR.

## Tests

`tests/issue-2882.test.ts` — MakeFullYear, month/day overflow (positive +
negative), non-finite propagation, TimeClip boundaries (`±8.64e15` valid,
beyond ⇒ NaN), plus regression controls for ordinary timestamps.

Spec: ECMA-262 §21.4.3.4 (Date.UTC), §21.4.1.12 (MakeDay), §21.4.1.27
(MakeFullYear), §21.4.1.14 (TimeClip).
