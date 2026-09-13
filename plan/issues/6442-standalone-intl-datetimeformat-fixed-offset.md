---
id: 6442
title: "standalone: a table-free `Intl.DateTimeFormat` for the Temporal provider — `UTC`, its aliases and `Etc/GMT±N` resolve without ICU, so `RangeError: unknown time zone UTC` (62 of 116 linked ZonedDateTime/prototype failures) stops being the wall"
status: done
assignee: ttraenkler/dev-5383-s9
sprint: current
priority: high
horizon: m
goal: standalone
parent: 5383
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-13
completed: 2026-09-13
loc-budget-allow:
  # 2026-09-13 (#6442) — the mechanism is a NEW module,
  #   `src/standalone-intl-datetimeformat.ts`, deliberately not in the god-file
  #   and not in `temporal-intl-shim.ts`. It is a source-text generator, so its
  #   line count is the line count of the JavaScript it emits: a zone resolver
  #   whose accepted set was measured spelling-by-spelling against ICU, an
  #   exact civil-from-days conversion (the ±8.64e15 ms range does not survive
  #   `Date`, and the two divisions that straddle zero must be done by exact
  #   remainder), an option/locale admission gate, and the three formatter
  #   surfaces. The header is the load-bearing part of the growth: it records
  #   WHY this is source and not codegen (the polyfill sees a LEXICAL `Intl`
  #   from the provider-local shim, so a `src/codegen/` arm would be shadowed
  #   and could not move one row) and WHY `format()` and not `formatToParts()`
  #   (`br` parses a seven-token en-US STRING). A reader without those two
  #   facts rewrites this as a codegen arm and measures nothing.
  - src/standalone-intl-datetimeformat.ts
  # `temporal-intl-shim.ts` NETS DOWN (-18/+15): the five throwing method stubs
  #   and their builder are replaced by one call. The grant is here only in
  #   case the merge preview scores the header rewrite as growth.
  - src/temporal-intl-shim.ts
---

## Problem

Measured in #5383 S8 (PR #5875): with the compiled @js-temporal/polyfill
provider linked into `--target standalone`, the three sampled Temporal families
score 85/360, and the single largest bucket is now
**`RangeError: unknown time zone UTC` — 62 of the 116
`Temporal/ZonedDateTime/prototype/**` failures.** It did not exist before S8;
it is the successor of the RegExp wall that slice removed.

The cause is in the provider-local `Intl` shim (`src/temporal-intl-shim.ts`,
#5383 S2c). Every member of that shim is a refusal, so the polyfill's zone
resolver falls into its own `catch` and answers `undefined`:

```js
function hr(e) {
  …
  try { n = ht(e).resolvedOptions().timeZone } catch { return }   // ← refusal lands here
  …
}
ct = Intl.DateTimeFormat;
function ht(e) { … new ct("en-us", { timeZone: Ao(e), hour12:!1, era:"short",
  year:"numeric", month:"numeric", day:"numeric",
  hour:"numeric", minute:"numeric", second:"numeric" }) … }
```

and every caller of `hr` then throws `unknown time zone <name>`.

#5355's bound — "there is no ICU in pure Wasm" — is about the CLDR/tzdata
tables. **`UTC` and the fixed-offset `Etc/GMT±N` zones need no tables at all.**
That gap is this issue.

## Implementation Plan

Written from a census of the linked bundle (`.tmp/s9/bundle.js`, 157,546 B),
not from the spec. Two census findings changed the route that was proposed:

1. **This cannot be a `src/codegen/` change.** The polyfill never sees the
   compiler's `Intl`: the S2c shim declares a module-scoped `const Intl = {…}`
   in the provider's own compilation unit, so every one of the bundle's 24
   `Intl.` reads resolves to that **lexical** binding. An arm in
   `new-intl-host-bridge.ts` would be shadowed and could not move a row.
   (Standalone *user* code is a separate, still-open gap: the `Intl` global
   itself is absent — #5206.) So the implementation is JavaScript SOURCE,
   emitted by a new module and prepended with the shim.
2. **The load-bearing surface is `format()`, not `formatToParts()`.** The
   offset path is `Fn → lr → ur → br → ht(tz).format(epochMs)`, and `br` parses
   the result with `split(/[^\w]+/)` into exactly seven word tokens — month,
   day, year, era, hour, minute, second — inverting the era itself
   (`o = 1 - o` when the era token starts with `B`). `formatToParts` is read
   only by the non-ISO calendar path, which still refuses. The contract is the
   en-US string `M/D/Y AD, HH:MM:SS`.

Steps:

- New `src/standalone-intl-datetimeformat.ts` exporting
  `standaloneIntlDateTimeFormatSource(className, refusalMessage)`; classified
  in `scripts/compiler-boundaries.json` alongside its sibling.
- `temporal-intl-shim.ts` keeps the `Intl` object literal (and keeps
  `DurationFormat` / `supportedValuesOf` `undefined` — every use of those is
  behind `?.`, and `hr` falls through to `ht()` when `supportedValuesOf` is
  absent, which is also what Node does: its `supportedValuesOf("timeZone")`
  list contains no `Etc/*` or `UTC` entry at all).
- Accept exactly the zones that need no tables, refuse everything else with the
  same catchable `RangeError` as today.
- Accept exactly two option shapes — the ICU default (bare `y/m/d`, what
  `Uo()` builds to read the system zone) and a full date plus `hh:mm[:ss]`
  (what `ht()` builds) — because the en-US pattern differs for every partial
  field set and a shape this cannot reproduce EXACTLY must refuse rather than
  answer approximately.
- Range: compute the civil date from the epoch day with Hinnant's
  `civil_from_days`, not `Date`, and do the two divisions that straddle zero by
  exact remainder — `Math.floor(ms / 86400000)` is not reliable at 8.64e15
  (the rounding error of the quotient exceeds the distance to the next
  integer), while `%` on exactly-representable doubles is exact.

Acceptance: the reduction below flips, the three linked families do not lose a
row, and every `gc` artifact is byte-identical.

## Resolution

### What was built

`src/standalone-intl-datetimeformat.ts` — the generated class answers:

| surface | behaviour |
| --- | --- |
| `new Intl.DateTimeFormat(locale, options)` | accepts `undefined` / `"en"` / `"en-US"` (case-insensitive) and the two option shapes above; anything else throws the #5355 refusal |
| `timeZone` | `UTC` · `Etc/UTC` · `GMT` · `Etc/GMT` · `GMT0` · `GMT±0` · `Greenwich` · `Zulu` · `Universal` (each with or without the `Etc/` prefix) → **`UTC`**; `Etc/GMT+1…+12` and `Etc/GMT-1…-14` → themselves, offset **sign-inverted** (POSIX: `Etc/GMT+1` is UTC−1) |
| `format(epochMs)` | `M/D/Y[ AD|BC][, HH:MM[:SS]]`, zero-padded time, unpadded date, year `1-y` under `BC` |
| `formatToParts(epochMs)` | the same fields as a parts array, literals included |
| `resolvedOptions()` | the full ICU record, in ICU's property order |
| `formatRange` / `formatRangeToParts` | still refuse |
| everything else (tzdata zones, offset strings, other locales/options) | still refuses — `hr`'s `try/catch` reads that as "unknown time zone", which is the truth |

**Offset strings (`+01:00`, `+0100`, `+01`) are deliberately NOT accepted**,
even though ICU accepts them: measured, the polyfill's `Rt` resolves an offset
string to `offsetMinutes` *before* `hr` is ever called, so no path reaches
`Intl` with one. Adding them would be untested surface.

### The differential oracle (the check that made this cheap)

`.tmp/s9/oracle.mts` evaluates the GENERATED shim source in Node — plain JS, no
compiler in the loop — and compares `resolvedOptions().timeZone` and
`format(ms)` against the real ICU implementation for **44 zone spellings ×
4,022 epoch values = 176,968 pairs**, including both ±8.64e15 extremes, the
out-of-range values either side of them, `NaN`, the BC boundary
(`0000-01-01`, `-0001-01-01`), and 4,000 deterministic pseudo-random epochs
across the whole legal range.

**0 mismatches.** `resolvedOptions()` and `formatToParts(0)` are byte-identical
to ICU's for both admitted shapes. A zone that genuinely needs tzdata is the
only permitted divergence (ICU answers, this refuses) and is counted as such.

### The reduction — linked, host-free standalone, before/after

`.tmp/s9/reduce.mjs`. Base measured by file-copy revert of
`src/temporal-intl-shim.ts` (`.tmp/s9/base-temporal-intl-shim.ts`) with its own
provider cache, so both sides built their own artifact (base
`c969db6f0bd2f326`, 3,278,970 B; S9 `dc43b7a43e0bd370`, 3,312,078 B — **zero
imports on both**). Verdicts: `1` = the exact value Node's polyfill answers,
`2` = a different value, `0` = threw `unknown time zone`, `-2` = threw
something else.

| probe | base | S9 |
| --- | --- | --- |
| `new Temporal.ZonedDateTime(0n,"UTC")` → `.offset` | 0 | **1** (`+00:00`) |
| same → `.hour` | 0 | **1** (`0`) |
| same → `.timeZoneId` | 0 | **1** (`UTC`) |
| `Temporal.Now.timeZoneId()` | −2 | **1** (`UTC`) |
| `ZonedDateTime.from("…[Etc/GMT-1]")` → `.offset` | 0 | 2 |
| same → `.hour` | 0 | 2 |
| `ZonedDateTime.from("…[+01:00]")` → `.offset` | 2 | 2 |
| **control:** `new Temporal.PlainDate(2024,3,5).toString()` | 2 | 2 |

Four rows flip to the exact value; two more stop being "unknown time zone" and
join the **pre-existing** `from()` bucket. That bucket is not this slice's and
is not a regression: the control row — a `PlainDate`, no time zone anywhere —
answers `2` on **both** sides, and a direct read shows why:
`new Temporal.PlainDate(…).toString()` returns the string
`"function () { [native code] }"` and `ZonedDateTime.from(…).toString()`
returns `"[object Object]"` on both trees. That is #5408 / the #5406-class
boundary defect the S8 findings already attribute, plus #2984's
path-dependent member read; the zone resolution in front of it is fixed.

### Notes / follow-ups

- **`Etc/GMT±N` has no transition early-out.** `wr`/`vr`
  (`getNamedTimeZone{Next,Previous}Transition`) early-out only on the literal
  string `"UTC"`, so a transition query on `Etc/GMT-1` walks the whole epoch
  range in 14-day steps (~7 M `format()` calls). This is upstream polyfill
  behaviour, identical on Node with real ICU, and affects only
  `getTimeZoneTransition` rows for non-UTC fixed zones.
- **The 21-row `canonicalizeCalendarEra` PlainDate bucket is adjacent but not
  this.** It routes through `new Intl.DateTimeFormat("en-US-u-ca-<id>", …)`,
  which this refuses at the locale gate on purpose: answering it needs era
  data, and `getCalendarParts` also wants `relatedYear` / `eraYear` parts.
  `gregory` alone might be answerable table-free; it needs its own census.
- Standalone **user** `Intl.DateTimeFormat` is untouched — the `Intl` global
  does not exist in standalone at all (#5206), and
  `src/codegen/expressions/new-intl-host-bridge.ts`'s refusal is unchanged.
