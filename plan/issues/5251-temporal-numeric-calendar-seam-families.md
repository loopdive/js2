---
id: 5251
title: "Temporal residual numeric/calendar seam families: 'invalid number value' (43), HebrewHelper illegal cast (29), JSBI toNumber seam (11), year/eraYear-required (10) — sampled census"
status: in-review
sprint: current
priority: medium
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
assignee: ttraenkler/dev-5251
created: 2026-08-31
# 2026-09-06 — two value-fidelity fixes, both in the god-files that own the
# read paths they break. A. the typed destructuring arm must not treat "field
# not on the struct" as "property absent" for a CLASS instance
# (destructuring-params.ts); B. the Phase-3 numeric narrowing must carry the
# undefined sentinel so an ABSENT property stops reading as NaN-the-number
# (property-access-dispatch.ts + the inverse coercion arm in
# type-coercion.ts). Each fix is a guarded early-exit at the exact decision
# site plus the measurement that justifies it; moving them to a new module
# would separate the rule from the branch it corrects.
loc-budget-allow:
  - src/codegen/destructuring-params.ts
  - src/codegen/type-coercion.ts
  - src/codegen/property-access-dispatch.ts
  # Restated from the predecessor branches this PR is stacked on (#5250's
  # `_resolveHostField` fix, #3527's IR wave), so the grants are not stranded
  # if CI scores this change-set against a base where those issue files read
  # as unmodified.
  - src/runtime.ts
  - src/ir/from-ast.ts
func-budget-allow:
  - src/codegen/destructuring-params.ts::destructureParamObject
  - src/codegen/type-coercion.ts::coerceType
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/ir/from-ast.ts::lowerExpr
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

**Update 2026-09-05 (post PR #5639 measurement).** With #5352's dispatch fix,
the 123-row #5249 family now fails in the polyfill's OWN guards with wrong
VALUES — no Wasm trap anywhere in the 123:

| rows | reason |
| --- | --- |
| 66 | `RangeError: Invalid ISO date` in `HelperBase_getCalendarParts` (21 carry a `NaN` year) |
| 45 | `RangeError: infinity is out of range` in `BalanceISODate` |
| 3 | `RangeError: value out of range` in `RejectToRange` |
| 3 | `eraYear.valueOf` never fetched (observable ordering) |

This IS the `invalid number value` family, now ~111 rows and the single
blocker. **First step: re-measure after #5250 lands** — its root cause
(`0fce2ef0e9`, a numeric `__sget` shape-miss reads as `0` instead of absent)
is exactly the kind of seam that turns a missing `year` into `0`/`NaN`
arithmetic. Only then probe what remains, per the sequence below.


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

## Result (2026-09-06, dev-5251 — branch `issue-5251-temporal-value-seam`)

Stacked on #5250 (`__sget` numeric shape-miss) and #5352 (open-receiver static
bind). All numbers below are runs I executed on this branch, with a **fresh
provider cache directory per compiler revision** (`JS2WASM_TEMPORAL_CACHE` —
the cache keys on polyfill source + options, not on the compiler, so a shared
directory silently serves a stale provider).

### Base on the stacked branch — #5250 did NOT move these rows

`family-123.txt` (the 123-row #5249 calendar list), before any change of mine:
**1 pass / 122 fail**, identical shape to the PR #5639 measurement (66
`Invalid ISO date`, 45 `infinity is out of range`, 3 `value out of range`,
3 `Invalid monthCode: M13`, 3 `eraYear.valueOf`, 1 Intl receiver). So the
#5250 `_resolveHostField` fix, while real, is not the root of this family.

### First wrong value — the probe chain

Probing through the linked provider with a patched polyfill source (each patch
one string replacement, provider rebuilt cold), the property-bag path is the
only one that breaks:

| call | result |
| --- | --- |
| `PlainDate.from("2021-07-06[u-ca=ethiopic]")` (string) | **ok** |
| `PlainDate.from({year, monthCode, day, calendar:"ethiopic"})` | `Invalid ISO date: 0NaN-12-01` |
| same with `calendar:"gregory"` | `infinity is out of range` |
| same with no `calendar` (ISO) | **ok** |

Walking inward: `calendarToIsoDate` RECEIVES correct values
(`year=1997/number`, `monthCode=M12`, `day=1`) and `adjustCalendarDate`
RETURNS correct values (`era=ethioaa, eraYear=1997, month=12`). The first
wrong value is one frame later, in `GregorianBaseHelper.estimateIsoDate`:

```
estimateIsoDate(e){ const t=this.adjustCalendarDate(e), {year:n,…}=t, {anchorEra:i}=this;
                    return St(n + i.isoEpoch.year - …, …) }
```

`i` is `undefined`, so `n + i.isoEpoch.year` is NaN (ethiopic/coptic) or
Infinity (gregory/japanese/roc). Reading the SAME property every other way
works — measured in one throw at that exact line:

```
direct=ethioaa  computed=ethioaa  viaFn=ethioaa  reflect=ethioaa
spread=ethioaa  inOp=true  hasOwn=true          destr=undefined
```

and it is not specific to `anchorEra`: in that method `{id}`, `{eras}`,
`{hasEra}`, `{calendarType}` ALL destructure to `undefined`/`false` while
`{year,month,day} = t` (an object literal) destructures correctly.

**Root cause A — `src/codegen/destructuring-params.ts`,
`destructureParamObject`, the typed-struct arm.** Every `Helper` class lowers
to `(type $HelperBase (sub (struct (field $__tag i32) (field $__shape_brand …))))`
— no data fields at all, all instance state in the sidecar. The typed arm
reads with `struct.get` and, for a property the struct does not declare, binds
`undefined` via `emitAbsentStructPropertyBinding` (#5221) on the inference
"not a declared field ⇒ absent property". That is sound for a closed object
literal and unsound for a class instance. The externref arm of the same
function has had the equivalent check since #1016; the fix applies it to the
arm that already holds a typed struct ref.

**Root cause B — `src/codegen/property-access-dispatch.ts`, the Phase-3
narrowing (#1269), + the missing inverse arm in `src/codegen/type-coercion.ts`.**
Surfaced only after A: `.until()` / `.since()` on gregory/roc/japanese then
died in `ToIntegerWithTruncation` with `RangeError: invalid number value`. The
NaN comes from the polyfill's options reader
`Ft(e){ let t = e.roundingIncrement; if (t === undefined) return 1; … }` —
measured at that line, an ABSENT `roundingIncrement` read back as
`raw=NaN type=number undef=false`. Phase 3 narrows a DYNAMIC property read to
`f64` when every struct candidate's field is `f64`; the dispatcher terminal
honestly answers `undefined` for an absent property, f64 cannot hold it, and
the unbox turned it into NaN-the-number. Fixed by branding the narrowed f64
`undefSentinel: true` and adding the inverse of the sentinel-aware BOXING arm
that already existed (#2864/#2979).

Both reduce to single-module repros with no Temporal in them — see
`tests/issue-5251-temporal-value-seam.test.ts` (10 tests, each verified to fail
on base via a file-copy A/B of the three touched sources):

```js
// A (base: "undefined|x")
class B { constructor(x){ const k = "a"; this[k] = x; }
          m(){ const {a} = this; return String(a && a.code) + "|" + String(this.a && this.a.code); } }
// B (base: typeof "number", value NaN)
function mk(){ return { inc: 5 }; }             // arms the narrowing
function read(o){ const t = o.inc; return typeof t; }
read({});                                        // must be "undefined"
```

### Measured effect

`family-123.txt`, same list, same cache discipline:

| run | pass | fail |
| --- | --- | --- |
| stacked base | 1 | 122 |
| + fix A | 4 | 119 |
| + fix A and B | 4 | 119 |

**0 rows regressed at either step.** The pass count understates it: **112 of
the 123 rows advanced to a later failure**. Bucket movement:

| reason | base | after |
| --- | --- | --- |
| `infinity is out of range` (calendar path) | 45 | 0 |
| `Invalid ISO date` with a `NaN` year | 21 | 0 |
| `invalid number value` | 0 (masked) → 17 after A | 0 |
| `Invalid ISO date` (real ISO date, Intl throws) | 45 | 66 |
| `instanceof` assertion failures (rows that now RUN) | 0 | 32 |
| `infinity is out of range` (ZonedDateTime path) | 0 | 9 |

Direct comparison against node-on-polyfill (same pinned bundle) after the fix:
`PlainDate.from({…, calendar})` matches node exactly for gregory, japanese and
roc, and `.until()`/`.since()` return `P1Y` / `P1Y` / `P366D` / `P1Y` —
byte-identical to the node control.

### Residual families — attributed, not fixed, each with its bound

1. **66 rows — `Intl.DateTimeFormat` is a shell (#5206).** `getCalendarParts`
   wraps `formatToParts` in a `catch` that rethrows `Invalid ISO date`, which
   hid the real error. Unwrapped, it is
   `TypeError: invalid receiver: method called with the wrong type of this-object`.
   Measured from the CONSUMER, with no polyfill involved:

   ```
   typeofDTF=function   fIsNull=false   fIsUndef=true   typeofF=object
   fmt=undefined        parts=undefined  (plain "en-US" too)
   ```

   `new Intl.DateTimeFormat(...)` yields a value that is `=== undefined` while
   `typeof` says "object", and its methods return `undefined`. **Bound:** only
   the calendars whose `isoToCalendarDate` is pure arithmetic
   (`SameMonthDayAsGregorianBaseHelper` — gregory, japanese, roc) can ever pass
   without real Intl. buddhist, indian, ethiopic and coptic need genuine
   `formatToParts` with a non-Gregorian calendar, i.e. ICU data. Not a seam
   defect and not fixable here.
   Side note for whoever picks up #5206: this container's node ALSO fails
   ethiopic/coptic (`Era aa (ISO year 1997) was not matched by any era`), so
   those rows have an environment ceiling independent of js2.

2. **32 rows — `instanceof` against a linked-provider class is always false.**
   New defect, no issue filed yet; needs one. Measured in the consumer against
   the fixed build, node control in brackets:

   ```
   d.toString()                      = 1997-12-01[u-ca=gregory]  [same]
   d instanceof Temporal.PlainDate   = false                     [true]
   d.constructor.name                = undefined                 ["PlainDate"]
   getPrototypeOf(d) === PlainDate.prototype = false             [true]
   new Temporal.PlainDate(1997,12,1) instanceof Temporal.PlainDate = false [true]
   ```

   It fails for instances the consumer constructs ITSELF, so it is the class
   VALUE's prototype identity crossing the module boundary, not a `from()`
   path. `TemporalHelpers.assertPlainDate` opens with an `instanceof`, which is
   why exactly this many rows stop there. Adjacent to #5237 / #5239 / #5242
   (cross-module class members / `Object.create` prototype / class-value
   construct bridge) but distinct from all three. **Bound:** every
   `TemporalHelpers.assert*` row in the bucket is blocked on it, regardless of
   calendar correctness.

3. **9 rows — `infinity is out of range`, ZonedDateTime only.** All nine are
   `intl402/Temporal/ZonedDateTime/**`; the PlainDate/PlainDateTime/YearMonth
   twins of the same tests now get past it. Not probed — a separate lane
   (timezone/epoch-ns), and it appeared only once A unblocked these rows.

4. **3 rows — `Invalid monthCode: M13`** (Ethiopic/Coptic 13-month) and
   **3 rows `value out of range`**: unchanged by this PR and downstream of (1),
   since those calendars cannot get correct parts without Intl.

### Reported, not fixed (in-scope but deliberately left)

- A DIRECT `typeof o.inc` on an absent narrowed-numeric property still answers
  `"number"`. Binding the read to a local first (`const t = o.inc; typeof t`)
  is correct after this PR. `typeof <member-access>` takes its own read route
  which the Phase-3 branding does not reach. The polyfill's failing shape is
  the local-binding one, so this does not block any measured row; it is
  asserted-as-known in the test file rather than left silent.

## Suspended / follow-up worklist

- File an issue for residual (2) — cross-module `instanceof` / prototype
  identity for provider-exported classes. It is the single largest remaining
  blocker after Intl for this bucket (32 of 123 rows).
- Residual (3) (ZonedDateTime `infinity`) needs its own probe.

### Verification runs

- `node scripts/equivalence-gate.mjs` — **24 failing, 1718 passing, 24
  known-failures in baseline, no new regressions** (exit 0). Re-run on a
  stable tree: an earlier attempt overlapped a file-copy A/B revert and was
  killed rather than reported.
- Collateral for the property-read change, base-vs-fix **per row** on the same
  113 rows (`built-ins/Reflect/{get,has,ownKeys,getOwnPropertyDescriptor}` +
  `built-ins/JSON/stringify`): 75 pass / 38 fail on BOTH sides, **0 flips, 0
  reason changes**. Not strictly required (this PR touches no `src/runtime.ts`
  read path) but run because fix B sits on the general property-read route.
- Suites, one vitest process each, all green: `issue-5250-sget-numeric-shape-miss`,
  `issue-5352-open-receiver-static-bind`,
  `issue-5249-open-receiver-descendant-dispatch`, the nine provider suites
  (5221, 5225, 5226, 5237, 5239, 5241, 5242, 5244, 5248),
  `issue-4628-temporal-global`, and `issue-5251-temporal-value-seam` (10/10).
- Gates run bare (never piped): typecheck, lint, loc-budget (also with
  `LOC_GATE_BASE=$(git rev-parse origin/main)`), func-budget (same),
  coercion-sites, oracle-ratchet, dead-exports, host-import-policy,
  `update-issues.mjs --check`.
