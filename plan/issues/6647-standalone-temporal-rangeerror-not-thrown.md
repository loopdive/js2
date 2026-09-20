---
id: 6647
title: "standalone Temporal: five `Expected a RangeError … no exception thrown` rows — two mechanisms, neither a codegen call-shape defect"
status: in-progress
assignee: ttraenkler/sendev-s69
sprint: current
priority: high
horizon: m
goal: standalone
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-09-20
---

## Problem

Five red rows in the standalone Temporal lane share one symptom —
`Test262Error: Expected a RangeError to be thrown but no exception was thrown
at all`:

| row | first failing assertion |
| --- | --- |
| `Duration/compare/relativeto-propertybag-invalid-offset-string.js` | offset `"+00:0000"` |
| `Duration/compare/relativeto-string-invalid.js` | `"2025-01-01T00:00:00+00:0000"` |
| `Duration/compare/throws-when-target-zoned-date-time-outside-valid-limits.js` | `new Temporal.ZonedDateTime(864n * 10n ** 19n, "UTC")` |
| `PlainDateTime/from/argument-string-invalid.js` | `"2025-01-01T00:00:00+00:0000"` |
| `ZonedDateTime/prototype/add/overflow-adding-months-to-max-year.js` | `new Temporal.ZonedDateTime(-(864n * 10n ** 19n), "UTC")` |

All five reproduce on the branch base `ce58705b68` (S68 head) against a fresh
`cacheHit=false` `--target both` provider
(`JS2WASM_TEMPORAL_CACHE=…/.test262-cache/s69-1`).

## Finding — the brief's two hypotheses are both WRONG, and the five rows split two-and-three

Neither hypothesis (a) "the provider throws but the exception is swallowed at
the link boundary / in `assert.throws`'s callback path" nor (b) "a value
crosses the seam wrongly" survives measurement.

Hypothesis (a) is dead: exception propagation through a closure passed to a
helper, through an `assert.throws`-shaped call, and through `assert.throws`
itself is **clean** (`.tmp/s69/probes/l3.js`) — `v6=THREW`, `v7=OK`, `v8=OK`,
`v9=THREW`, `v10=THREW` for a plain `throw`, a Temporal-originated `RangeError`
and an `assert.throws` wrapper alike.

### Mechanism A — the polyfill itself does not reject `+00:0000` (3 rows). NOT a js2wasm defect.

`@js-temporal/polyfill`'s offset grammar is

```js
_o = new RegExp(`^${/([+-])([01][0-9]|2[0-3])(?::?([0-5][0-9])(?::?([0-5][0-9])(?:[.,](\d{1,9}))?)?)?/.source}$`)
```

— the hour/minute and minute/second separators are **independently optional**
(`:?`), so `+00:0000` matches and `ParseTimeZoneOffsetString` returns instead of
throwing. test262 asserts the *newer* normative rule ("the hour/minute and
minute/second separator or lack thereof needs to match"), which this polyfill
version predates.

Measured under **plain Node, importing the polyfill directly** — no js2wasm in
the path at all (`.tmp/s69/probes/host-truth.mjs`):

| expression | polyfill under Node |
| --- | --- |
| `Temporal.PlainDateTime.from("2025-01-01T00:00:00+00:0000")` | **NO-THROW** `2025-01-01T00:00:00` |
| `Temporal.PlainDateTime.from("2025-01-01T00:00:00+0000:00")` | **NO-THROW** |
| `…from("202501-01T00:00:00")` | THREW RangeError |
| `…from("2025-0101T00:00:00")` | THREW RangeError |
| `…from("2025-01-01T00:0000")` | THREW RangeError |
| `…from("2025-01-01T0000:00")` | THREW RangeError |
| `Duration.compare(d, d, { relativeTo: "2025-01-01T00:00:00+00:0000" })` | **NO-THROW** `0` |
| `Duration.compare(d, d, { relativeTo: { …, offset: "+00:0000" } })` | **NO-THROW** `0` |

The two NO-THROW strings are exactly the two the standalone rows stop on, and
`argument-string-invalid.js` reports the **first** list entry that fails to
throw — `+00:0000` — which is the first of the six separator-mismatch strings.
So the whole gap for those three rows is the polyfill version; the host lane
fails them for the same reason.

**Consequence:** these three rows are only movable by upgrading (or patching)
the vendored polyfill's ISO/offset grammar. They are NOT fixable in codegen and
should not be counted against the standalone lane.

### Mechanism B — standalone BigInt is a branded i64, so the >2^63 epoch-ns limits never trip (2 rows)

`src/codegen/host-bigint-carrier.ts` selects the arbitrary-width JS BigInt
carrier **only** when `environment === "javascript" && semanticProviders ===
"host-assisted"`. On the native-first/standalone lane a `bigint` maps to
`{ kind: "i64", bigint: true }` (`src/checker/type-mapper.ts` ~L50), and
`src/codegen/bigint-format-native.ts` says so in its own header: *"Emit exact
signed-**i64** BigInt formatting"*, buffer `sign + 64 binary digits`.

Both remaining rows build their out-of-range receiver from a BigInt literal
larger than 2^63, so the value silently wraps and lands **inside** the
supported range (`.tmp/s69/probes/l2.js`, `l4.js`):

| expression | standalone | expected |
| --- | --- | --- |
| `String(864n * 10n ** 19n)` | `6923773503929844000` | `8640000000000000000000` |
| `String(10n ** 19n)` | `-8446744073709552000` | `10000000000000000000` |
| `String(8640000000000000000000n)` (literal) | `6923773503929844000` | itself |
| `new Temporal.ZonedDateTime(864n*10n**19n,"UTC").epochNanoseconds` | `6923773503929843712` | `8640000000000000000000` |
| `new Temporal.ZonedDateTime(-(864n*10n**19n),"UTC").epochNanoseconds` | `-6923773503929843712` | `-8640000000000000000000` |

`8.64e21 mod 2^64 = 6.923773503929843712e18` — an exact i64 wrap. The
constructed `ZonedDateTime` is therefore ~219 years from the epoch, not at the
limit, so `Duration.compare(…)` answers `1` and `minYear.add(…)` succeeds.

`overflow-adding-months-to-max-year.js` has a **misleading line attribution**:
the runner reports `L12` (the `maxYear` assertion), but `L12` PASSES —
`.tmp/s69/probes/l4.js` `[c1=THREW][c2=OK]` — and the real failure is `L15`,
the `minYear` assertion, `[c3=NOTHROW][c4!Expected a RangeError…]`. Anyone
debugging from the reported line will chase the wrong assertion.

**Consequence:** these two rows need arbitrary-precision BigInt on the
native-first lane. That is an XL project of its own, not an `m`-horizon splice.

## The larger defect this probing surfaced — `qr()`-shaped functions answer `null` under the linked Temporal provider

While reducing the rows above, a far broader standalone defect fell out. Under
the **linked standalone Temporal provider**, a **function declaration that
returns a freshly-built plain object or array** answers `null` at its call
site, while the same function answers correctly through `.call`/`.apply`, and
the identical source compiled WITHOUT the provider is fine.

`.tmp/s69/probes/l8.js` (with `features: [Temporal]`) vs `l8b.js` (identical
source, feature tag removed):

| shape | with provider | without provider |
| --- | --- | --- |
| `function f(){ return {a:1}; } f()` | **NULL** | object |
| `function f(){ return [1,2]; } f()` | **NULL** | object |
| `function f(){ var o={}; o.a=1; return o; } f()` | **NULL** | object |
| `function f(){ return "s"; } f()` / `return 1` | string / number | same |
| `function f(){ return Object.create(null); } f()` | object | object |
| `function f(){ return new Temporal.PlainDate(2000,1,1); } f()` | object | — |
| `f.call(undefined)` / `f.apply(undefined, [])` | **object** | object |
| `var f = function(){ return {a:1}; }; f()` (expression) | object | object |
| the same declaration **nested** inside another function | object | object |

The call/apply row is what makes this a **call-lowering** defect rather than a
body defect: the function genuinely builds the object; the direct-by-name call
is what answers `null`.

This is almost certainly why `Temporal.PlainDate.prototype.add` is broken for
**every** input: the polyfill's

```js
function qr(e){ … return { date:{years:…,months:…,weeks:…,days:0}, time:t } }
function Wr(e){ const t = qr(e), n = Math.trunc(t.time.sec/86400); … return { ...t.date, days:n } }
```

is exactly that shape, and `Wr` is on the `PlainDate`/`PlainYearMonth`
add/subtract path but **not** on the `ZonedDateTime` one (which uses `Ar`,
whose returns are consumed differently) — matching the measurement that
`zdt.add(dur)` works while `plainDate.add(dur)` does not:

```
[d1!TypeError: Cannot destructure 'null' or 'undefined']   PD.add({days:1})
[d7!TypeError: Cannot destructure 'null' or 'undefined']   PD.add(new Temporal.Duration(0,0,0,1))
[d6=[object Object]]                                        PD.with({day:3})        (control, ok)
```

Measured row cost, `test/built-ins/Temporal/PlainDate/prototype/add/` (first 39
files, `.tmp/s69/pdadd.tsv`): **22 fail / 17 pass**, and 20 of the 22 carry the
identical `TypeError: Cannot destructure 'null' or 'undefined'`.

**Not reproduced** by `canonicalRuntimeTypes: true` alone
(`.tmp/s69/probes/fast.mts` — identical output for `canonical=false|true`), nor
by the small two-module linked fixture (`.tmp/s69/probes/linked1.mts` — all
`object`). So the trigger is something specific to the real Temporal-provider
link, not to linking per se; that is where the next lane should start.

## Residuals (measured, not fixed)

1. Three offset rows — polyfill grammar, needs a polyfill upgrade (Mechanism A).
   Reduced probe: `.tmp/s69/probes/host-truth.mjs` under plain Node.
2. Two epoch-limit rows — need >64-bit BigInt on the native-first lane
   (Mechanism B). Reduced probe: `.tmp/s69/probes/l2.js` rows `bigLit`,
   `zdtMaxEp`, `minEp`.
3. The `qr()`-shaped-return `null` defect above — reduced probe
   `.tmp/s69/probes/l8.js` vs `l8b.js`; ≥22 rows in one directory.
4. The runner's `assert.throws` line attribution reports the FIRST
   `assert.throws(` in the file, not the failing one
   (`overflow-adding-months-to-max-year.js` reports L12; L15 is the failure).

## Acceptance criteria

- The five rows are each attributed to a named mechanism with a reduced probe. ✅
- Any mechanism fixable at `m` horizon is fixed with a witness that fails on
  the true reverted base `ce58705b68`.
- No pass→fail anywhere in the four-family battery or the nine must-not-move
  groups.
