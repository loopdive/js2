---
id: 2164
title: "Standalone Date conformance residual (~234 tests)"
status: done
completed: 2026-06-18
sprint: 63
created: 2026-06-15
updated: 2026-06-18
assignee: ttraenkler/cs-2164
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: date
goal: standalone-mode
parent: 1343
---

# Standalone Date conformance residual

## Problem

Date prototype formatters landed in #1343 (`done`, sprint 50). The
host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows **234
tests pass in host mode but fail standalone**, attributed to Date semantics
— currently **untracked**.

## Evidence

- Gap category: `built-ins/Date` 235; `(none)`-leak compile errors (219)
  dominate — standalone codegen gaps in Date construction/formatting/coercion.

## Acceptance criteria

- Standalone pass count for `built-ins/Date` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1343. Part of sprint-62 standalone catch-up (rank 10 by gap
impact).

---

## Slice 1 (2026-06-16) — `Date.now()` / `new Date()` no-arg host-import leak

**Landed.** Triage showed most Date functionality already works standalone
(explicit-timestamp ctor, getTime, UTC components, setters, toISOString,
multi-arg ctor, NaN, Date.UTC). The dominant *foundational* failure: `Date.now()`
and `new Date()` (no args) emitted the `env::__date_now` host import
**unconditionally** in non-WASI mode — under `--target standalone` (no JS host,
no WASI clock) that import is unsatisfiable, so every module calling `Date.now()`
or `new Date()` (commonly in test setup) failed to instantiate, taking unrelated
Date assertions down with it.

**Fix** (`expressions/calls.ts` Date.now/performance.now; `expressions/new-super.ts`
`new Date()`): pure standalone has no wall-clock source, so emit the Unix epoch
(`f64.const 0` / `i64.const 0`) directly — deterministic, no import leak, module
instantiates. WASI still uses its clock; host mode unchanged (gated on
`ctx.standalone === true`). Test: `tests/issue-2164.test.ts` — Date.now()/new
Date()/performance.now() instantiate, mixed setup+explicit-timestamp works,
explicit dates unaffected (5/5). Host date-basic equiv unchanged (12/12).

## Slice 3 (2026-06-17) — standalone `toISOString()` / `toJSON()` pure-Wasm formatter

**Landed.** The Date string formatters delegate to the `__date_format(ts, mode)`
host import. In standalone / nativeStrings mode there is no JS host, so the
`ctx.nativeStrings` branch (`expressions/builtins.ts`) emitted a hard-coded
placeholder `"1970-01-01T00:00:00.000Z"` for `toISOString`/`toJSON` — every
non-epoch call returned the wrong string. Instance getters/setters
(`getUTC*`, `setUTC*`, `getTime`, `valueOf`) were already correct standalone;
the formatters were the gap.

**Fix:** new pure-Wasm helper `__date_iso_string(ts: i64) -> ref $NativeString`
(`ensureDateIsoStringHelper`, builtins.ts) builds the ECMA-262 §21.4.4.36 Date
Time String Format directly from the millisecond timestamp:
- floor-divides `ts` into `days` + `msOfDay`, reuses `__date_civil_from_days`
  for the calendar fields, and fills a 27-element i16 array via a write cursor;
- handles the §21.4.1.18 extended ±YYYYYY year form for years <0 or >9999
  (4-digit `YYYY` otherwise);
- returns a `$NativeString(len, off=0, data)`.
The `toISOString`/`toJSON` nativeStrings branch now calls it. Per spec,
`toISOString` throws **RangeError** "Invalid time value" on an Invalid Date
(new `emitThrowRangeError` helper, helpers.ts) and `toJSON` returns **null**.
Host mode (`__date_format` path) is untouched.

Test: `tests/issue-2164-iso.test.ts` (13/13) — exact-string conformance vs host
JS for epoch, arbitrary, sub-second ms, mid-day h/m/s/ms, extended +6-digit
year, the 9999↔10000 4-digit/extended boundary; plus toJSON-null, toISOString
RangeError-on-invalid, pre-epoch (1969), ms round-trip. Existing `issue-1638`
(host formatters) + `issue-1343-negative-year` suites unchanged.

### Remaining slices (issue stays open)

- **Negative-year calendar getters** (`getUTCFullYear()` etc.) are wrong for
  pre-year-0 timestamps standalone (`__date_civil_from_days` negative-`days`
  gap, pre-existing) — so `toISOString` of a negative *year* is also off. The
  formatter itself is correct given a correct year; this is upstream of Slice 3.
- Real current-time semantics standalone are intentionally NOT provided (no
  clock source); only the instantiate-blocking leak is fixed (Slice 1).
- `Date.parse(str)` / `new Date(str)` standalone parsing landed in Slice 2
  below (PR #1633).

---

## Slice 2 (2026-06-17) — pure-Wasm `Date.parse(str)` / `new Date(str)`

**Landed.** `Date.parse` was a NaN stub and `new Date("…")` coerced the string
to f64 (→ NaN), so neither parsed a date string in ANY mode — fatal standalone
(no host fallback).

**Fix.** New module `src/codegen/date-parse-native.ts` emits a WasmGC-native
parser `__date_parse (externref) -> f64` for the ECMAScript Date Time String
Format (§21.4.1.32): `YYYY[-MM[-DD]]` date forms, `THH:mm[:ss[.sss]]` time,
`Z`/`±HH:mm` timezone, and `±YYYYYY` expanded years. It flattens the string via
`__str_flatten` and scans code units (same foundation as
`parse-number-native.ts`), validates field ranges, and composes the time value
through the existing `__date_days_from_civil` helper. Returns NaN on any parse
failure or out-of-range field. A no-timezone date-time form is treated as UTC
(standalone has no timezone database — matches slice 1's deterministic-clock
decision); date-only forms are UTC per spec.

Wired at `expressions/calls.ts` (`Date.parse`) and `expressions/new-super.ts`
(`new Date(str)` when the arg is statically string-typed).

**Gating.** Native parse is enabled for `--target standalone` / `--target wasi`
only. Those carry the `nativeStrings` WasmGC string backend so the helper links
cleanly. In JS-host mode, lazily wiring the helper mid-body trips the
late-import index-shift class (#2043: "heap type index out of range"), so host
mode keeps the prior NaN stub — **no regression** (host `Date.parse` was always
a NaN stub). Follow-up: register `__date_parse` up-front (like `parseInt` in
`index.ts`) to extend native parsing to host mode.

**Validation.** `tests/issue-2164.test.ts` +15 cases (ISO full/date-only/
year-only, ms component, ±TZ offsets, no-TZ-as-UTC, leap day, expanded ±years,
invalid month/day/hour, garbage → NaN, `new Date(str)` round-trips through UTC
getters) — 21/21 green. Verified against Node `Date.parse` across 18 formats
(18/18 under `TZ=UTC`; the 2 no-TZ cases differ from a Berlin-TZ Node only by
the host TZ offset, which is the intended UTC-for-local standalone behavior).
Host-mode Date code no longer compile-errors. tsc + biome lint + prettier +
stack-balance gates clean.

---

## Slice 4 (2026-06-18, sdev-proxy3) — pure-Wasm non-ISO string formatters

**Landed.** The remaining Date string formatters — `toString`, `toUTCString` /
`toGMTString`, `toDateString`, `toTimeString`, and `toLocaleString` /
`toLocaleDateString` / `toLocaleTimeString` — delegated to the `__date_format`
host import. In standalone / nativeStrings mode the `ctx.nativeStrings` branch
(`expressions/builtins.ts`) emitted ONE hard-coded placeholder
(`"Thu Jan 01 1970 00:00:00 GMT+0000"`) for **all** of them, ignoring both the
timestamp and the requested format — so every call returned the same wrong
string. (Slice 3 had fixed only `toISOString`/`toJSON`.)

**Fix:** new pure-Wasm helper `__date_format_string(ts: i64, mode: i32) -> ref
$NativeString` (`ensureDateFormatStringHelper`, builtins.ts), modelled on Slice
3's `__date_iso_string`. It floor-divides the timestamp into days + msOfDay,
reuses `__date_civil_from_days` for the calendar fields, computes the weekday as
`((days % 7) + 4 + 7) % 7` (epoch day 0 = Thursday), and writes each ECMA-262
§21.4.4 format into an i16 buffer via a write cursor, dispatching on `mode`:

| mode | method | format |
|------|--------|--------|
| 1 | toUTCString/toGMTString | `WkDay, DD Mon YYYY HH:mm:ss GMT` (§21.4.4.43) |
| 2/6 | toString/toLocaleString | `WkDay Mon DD YYYY HH:mm:ss GMT+0000 (Coordinated Universal Time)` |
| 3/7 | toDateString/toLocaleDateString | `WkDay Mon DD YYYY` (§21.4.4.35) |
| 4 | toTimeString | `HH:mm:ss GMT+0000 (Coordinated Universal Time)` |
| 8 | toLocaleTimeString | `HH:mm:ss` |

Standalone has no timezone DB, so every format renders in **UTC** (consistent
with Slice 1's deterministic-clock and Slice 2's UTC-for-local decisions). Year
uses the §21.4.1.18 extended ±6-digit form for years <0/>9999, else 4 digits.
An Invalid Date receiver (i64-MIN sentinel) yields the literal `"Invalid Date"`
for every format. Host mode (`__date_format`) is untouched.

**Validation.** `tests/issue-2164-formatters.test.ts` (10/10) asserts exact
strings vs Node's `TZ=UTC` output for epoch / 2023 / pre-epoch (negative day &
year) / end-of-day, across all formatters, the toGMTString alias, the weekday
computation (incl. a Sunday and negative timestamps), and the Invalid-Date
literal. Existing #2164 / #2164-iso / #1638 Date suites: 44/44 unchanged. tsc +
prettier + coercion-sites + any-box gates clean. The pre-existing
`date-native.test.ts > Date.now() returns a number` failure (a test-harness
`__date_now` import-provision issue) is unrelated and fails identically on main.

**Still open after Slice 4:** the negative-year calendar-getter gap noted under
Slice 3 (`__date_civil_from_days` for very negative days) and `getTimezoneOffset`
already returns 0 standalone (correct for UTC). The big formatter placeholder —
the dominant standalone Date string gap — is now closed.

---

## Slice 5 (2026-06-18, sdev-proxy3) — Date.parse RFC2822 / `toString` forms

**Landed.** The pure-Wasm `__date_parse` (date-parse-native.ts) handled only the
ECMAScript Date-Time-String (ISO) grammar, so `Date.parse` of an RFC2822 /
`toString`-shaped string returned NaN standalone — e.g. the round-trip of the
#1682 formatters: `Date.parse(d.toUTCString())` / `Date.parse(d.toString())` /
`Date.parse(d.toDateString())` all NaN'd.

**Fix:** the scanner now dispatches on the first char. A leading **letter**
routes to a new RFC2822 arm that parses an optional weekday (`Www[,]`), then
either `DD Mon YYYY` (toUTCString) or `Mon DD YYYY` (toString/toDateString),
then an optional `HH:mm:ss`, then an optional timezone (`GMT`/`UTC`/`Z` or
`±HHMM`). It fills the **same** field locals as the ISO arm, so the shared
range-validate + compose tail handles either. New primitives: a branch-free
case-insensitive 3-letter month-name matcher (12-way if-chain on lowercased
chars via `select`), a weekday/month disambiguator (a leading 3-letter token is
a weekday only when followed by `,` or ` `+letter — so `Nov 14` is a month, not
a weekday), and space/`GMT`-skipping loops. All forms parse as **UTC**
(standalone has no TZ DB), matching the formatter/clock decisions of slices 1–4.

**Notable bug fixed in dev:** the month-name lowercaser first used an `if`
with `blockType val i32` whose `then` arm did `i32.add` against the pre-`if`
operand — but a value-result `if` arm has no implicit access to the stack below
its frame, so this was an invalid-Wasm `i32.add need 2 got 1`. Rewrote it
branch-free with `select(c+32, c, isUpper)`.

**Validation.** `tests/issue-2164-date-parse-rfc2822.test.ts` (9/9): toUTCString
/ toString / toDateString / month-first-no-weekday forms, all 12 month names,
±HHMM offsets, garbage→NaN (no trap), ISO no-regression, and the round-trip of
the #1682 formatters (to the second for toUTCString/toString since they carry no
ms — exactly like V8; to the day for toDateString). 44/44 existing #2164 /
#2164-iso / #2164-formatters suites unchanged. tsc + prettier + coercion-sites +
any-box gates clean. No host-import leak.

**Scope boundary (documented):** a bare `DD Mon YYYY` (day-first, NO weekday,
e.g. `"14 Nov 2023"`) starts with a digit, so it routes to the ISO scanner and
returns NaN. None of our formatters emit that form; it is a lenient V8 extra.
Covering it would require the ISO scanner to detect a month-name mid-stream —
deferred. The dominant value (round-tripping the formatters + RFC2822 GMT
strings) is delivered.

---

## Slice 6 (2026-06-18, cs-2164) — negative-year calendar fields + closes the issue

**Landed — closes #2164.** The remaining slice flagged under Slices 3/4: the
negative-year calendar getters. `__date_civil_from_days` returns
`packed = year*10000 + month*100 + day` with month/day always positive, but for
years < 0 the whole packed value is negative. Every decode site used Wasm
`i64.div_s` / `i64.rem_s` (truncate toward zero), which corrupted both the year
(off by one) *and* the month/day (returned **negative**) for any pre-year-0
timestamp. e.g. `new Date(Date.UTC(-1,0,1))` returned `getUTCFullYear()=0`,
`getUTCMonth()=-99`, `getUTCDate()=-99` standalone (should be -1 / 0 / 1). This
hit the three calendar getters, the `setUTC*` component readback, and both the
`__date_iso_string` and `__date_format_string` pure-Wasm helpers (so the string
formatters were wrong too). The bug existed in **both** modes for the getters
(calendar getters are computed natively regardless of host).

**Fix** (`expressions/builtins.ts`): two shared emitters, `emitPackedYear` /
`emitPackedMmdd`, decode the packed value with **floor** semantics —
`year = floor(packed/10000)`; `mmdd = packed - year*10000` (guaranteed in
[101, 1231]); `month = mmdd/100`, `day = mmdd%100`. Applied at all five decode
sites (3 calendar getters, the `setUTC*` readback, the ISO helper, the
format-string helper; the latter two overwrite `$packed` with the positive
`mmdd` so their existing trunc-based month/day extraction works unchanged).

**Also fixed** (same slice): the human-readable formatters (`toString` /
`toUTCString` / `toDateString`) rendered out-of-[0,9999] years as the fixed ISO
±6-digit form (`-000001`). Per V8 / ECMA-262 §21.4.4.41.1/§21.4.4.43, those use
a sign-prefixed, **minimum-4-digit** decimal (`-0001`, `0099`, natural width for
≥10000, no `+`); only `toISOString` (§21.4.1.18) uses the ±6-digit extended
form. `writeYear` (format-string helper) now emits the min-4 form. This matches
the host/runtime `_formatDate` behaviour already tested by #1343 Slice 5 — both
paths now agree.

**Validation.** New `tests/issue-2164-negative-year.test.ts` (42/42): the three
calendar getters for years -1 / -100 / -271821 (near the §21.4.1.1 minimum),
positive-year no-regression, `setUTCMonth` readback on a year -5 date, and exact
string conformance (Node `TZ=UTC` output) for all five formatters across epoch,
negative years, sub-1000 (`0099`), the 9999↔10000 boundary, and 275760 (near
max) — covering the ISO `+010000`/`+275760` extended form vs the human-readable
natural-width form. Existing #2164 / #2164-iso / #2164-formatters / #2164-rfc2822
/ #1638 / #1343-negative-year suites: 69/69 unchanged. tsc + prettier + biome +
stack-balance + coercion-sites + any-box gates clean. No host-import leak.

With negative-year calendar fields correct, the standalone Date string +
component surface reaches host parity for the full §21.4.1.1 year range; the
issue is **done**.
