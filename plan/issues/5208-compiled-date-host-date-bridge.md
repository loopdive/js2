---
id: 5208
title: A compiled Date is a plain {timestamp} object to the host — Intl.DateTimeFormat.formatToParts(new Date(e)) throws Invalid time value
status: done
sprint: current
priority: medium
horizon: m
goal: standalone-gap
reasoning_effort: max
requested_by: ttraenkler/fable-lead
created: 2026-08-29
assignee: ttraenkler/dev-5208
completed: 2026-09-06
# 2026-09-06 (#5208): the whole fix is one host-boundary marshaller plus its
# three call sites (the measured extern-class method-argument crossing and
# JSON's two walks). The VIEW itself lives in `runtime/date-host-method.ts`,
# which already owns the carrier protocol — `runtime.ts` keeps only a 7-line
# adapter binding what that module cannot see (struct classification, the #5225
# cross-module decoder selection, the reverse identity map). That placement is
# what keeps the host-import-policy `runtimeTsLines` ratchet green with NO
# baseline bump; an earlier draft that put the view in `runtime.ts` breached it.
# Most of the added lines in `date-host-method.ts` are the rationale comment:
# WHY the host view is identity-CACHED and yet RE-SYNCED per crossing — the one
# non-obvious property, and the thing a future reader would otherwise
# "simplify" into a regression (mint-per-crossing breaks reference identity;
# snapshot-once goes stale against the MUTABLE `$__Date` field).
loc-budget-allow:
  - src/runtime.ts
  - src/runtime/date-host-method.ts
  - src/runtime/init-marshal-registry.ts
  - src/codegen/init-marshal-helpers.ts
# 2026-09-06 (#5208): `resolveImport` grows by the Date arm at the measured
# `invokeMethod` crossing (+21 incl. #5355's share); `_wasmToPlain` +12 and
# `_serializeJSONProperty` +8. Each is a guarded early conversion inside the
# function that owns that boundary — hoisting them out would mean re-deriving
# the boundary's own context at a second site.
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/runtime.ts::_serializeJSONProperty
  - src/runtime.ts::_wasmToPlain
  - src/runtime/date-host-method.ts::tryCallWasmDateHostMethod
# 2026-09-06 (#5208): restated from the stacked predecessors so the allowances
# are not STRANDED when CI diffs this PR against the merge preview rather than
# against its stack base. #5355 (PR #5657) and #5251 are both in this branch's
# history; their grants are reproduced verbatim in scope, not widened.
#   #5355: src/codegen/extern-declarations.ts (+36, one extern-class entry),
#          src/codegen/expressions/new-super.ts, src/runtime.ts,
#          extern-declarations.ts::registerBuiltinExternClasses,
#          runtime.ts::resolveImport
#   #5251: src/codegen/property-access-dispatch.ts, src/codegen/type-coercion.ts,
#          src/runtime.ts, property-access-dispatch.ts::finalizeStructAndDynamicMemberGet,
#          type-coercion.ts::coerceType
---

# #5208 — compiled `Date` ↔ host `Date` bridging

## Problem

A compiled `Date` is a plain compiled object carrying a `timestamp` field,
not a host `Date`:

- `Object.prototype.toString.call(new Date(0))` → `[object Object]`
- `JSON.stringify({d: new Date(0)})` → `{"d":{"timestamp":null}}`
- `new Intl.DateTimeFormat().formatToParts(new Date(e))` →
  `RangeError: Invalid time value`, while `formatToParts(0)` works.

The Temporal polyfill's `getCalendarParts` uses exactly the
`formatToParts(new Date(e))` shape, so this sits on the #4628 path behind
#5207 (it is NOT the current front blocker — file order only).

## Direction

When a compiled `Date` crosses to the host (host-call arguments, `Intl`
methods, `JSON.stringify`, `Object.prototype.toString`), marshal it to a
real host `Date` built from the `timestamp` field (or teach `_wrapForHost`
a Date-carrier case). Measure which crossing points the polyfill actually
uses; don't widen speculatively. Keep the compiled-side representation
unchanged (standalone lane depends on it).

## Implementation Plan (Fable, 2026-09-06)

**Why now.** With #5352/#5250/#5251/#5355 landed or in flight, this is the
single blocker for **66 of the 123** #5249 Temporal calendar rows (measured by
dev-5355, PR #5657): the polyfill's `getCalendarParts` calls
`formatToParts(new Date(e))`; the bridged `Intl.DateTimeFormat` now works for
`formatToParts(0)` but throws `RangeError: Invalid time value` for the
compiled `Date`, and the polyfill's `catch` rewrites that into
`Invalid ISO date`. Per-calendar: islamic-civil 13, coptic 13, islamic-tbla 9,
ethiopic 8, islamic-umalqura 7, ethioaa 7, buddhist 6, other 3.

1. **Measure the crossing points the polyfill actually hits** (do not widen
   speculatively). Instrument `_wrapForHost` (or whichever marshaller hands a
   compiled struct to a host call) with a temporary env-gated log keyed on the
   compiled `Date` struct type, run `family-123.txt` provider-linked, and list
   the host call sites that receive one: expect `Intl_DateTimeFormat_formatToParts`
   (extern-class method arg) and possibly `resolvedOptions`/`Date.UTC`
   round-trips. That list is the scope.
2. **Marshal at the host boundary, keep the compiled representation.** In the
   extern-class method-argument path (the `Intl_<Class>_<method>` externref-in
   bridge, `src/codegen/extern-declarations.ts` / the runtime side in
   `src/runtime.ts`), when an argument is a compiled `Date` struct (recognise by
   struct type / `__tag`, not by duck-typing `timestamp`), build
   `new Date(timestamp)` on the host side and pass that. Cache nothing; a
   `Date` is a value. The compiled side stays `{timestamp}` — the standalone
   lane depends on it (#1343 date-native).
3. **The two other repros in Problem** (`Object.prototype.toString` tag,
   `JSON.stringify`) are the same marshalling class — fix them in the same
   boundary if the crossing goes through the same code; otherwise leave them
   with a stated bound. Do not add a Date-specific `toJSON` in compiled code.
4. **Reduction + test** `tests/issue-5208-*.test.ts`: the three Problem repros
   plus `formatToParts(new Date(0))` in single-module AND linked lanes, at
   init and after init; base-failing.
5. **Measure** `family-123.txt` provider-linked, FRESH cache dir per compiler
   revision, on a base that includes #5355 (branch `issue-5355-intl-datetimeformat-bridge`
   / PR #5657 — stack on it and say "Land order: after PR #5657"): report
   pass/fail and per-calendar attribution; expect the 66 to move, and state
   the next layer.

Suites: `tests/date-native*`, `issue-1343*`, `issue-5180*` family, the 9
provider suites + 5250/5251/5355, `issue-4628-temporal-global`; equivalence
at 24/1718; `host-import-policy` green.

## Acceptance criteria

1. Reduced repros above pass on the host lane (toString tag, JSON, and
   formatToParts), at init and after init; new tests/issue-5208-*.test.ts
   failing on base.
2. Temporal harness measured before/after on the full stack; record where
   init stops.
3. No regressions in date-native / issue-1343 / issue-5180-family scoped
   runs (name them). Gates green.

## Notes

- Found by dev-5206 while validating PR #5271 (see its "also noted"
  section). Behind #5207 in the blocker order.
- Id #5208 reserved with a degraded PR scan; manually verified against
  open PR head branches 2026-08-29. `check:issue-ids:against-main`
  arbitrates.

## Implementation notes (dev-5208, 2026-09-06)

Branch `issue-5208-compiled-date-host-bridge`, stacked on
`issue-5355-intl-datetimeformat-bridge` (PR #5657) + `docs-5352-5353` +
`origin/main`. **Land order: after PR #5657.**

### 1. Measurement first — where a compiled Date actually crosses

`_wrapForHost` is the single choke point every compiled-struct→host marshal
funnels through (the typed extern-class path and `__extern_method_call`'s
`wrapHostValue` both end there), so a temporary env-gated stack-capturing probe
was placed in it and the 123-row family run provider-linked.

Result — **exactly one site** in the whole `@js-temporal/polyfill`:

| host site | compiled caller | distinct stacks |
| --- | --- | --- |
| `invokeMethod` (extern-class method **argument** marshaller, `src/runtime.ts`) | `HelperBase_getCalendarParts` → `isoToCalendarDate` → `calendarToIsoDate` | 11 |
| same | `ChineseBaseHelper_getMonthList` → `adjustCalendarDate` | 1 |

No `__extern_method_call`, no extern-class constructor / `__extern_get` /
`__extern_set`, no `_wasmToPlain`. That list is the scope; the fix does **not**
touch `_wrapForHost` itself.

Two independent controls fell out of the same measurement and are pinned as
tests: `Object.prototype.toString.call(new Date(0))` already answered
`[object Date]` on this base (nothing to fix), and the **fully dynamic**
spelling `(Intl as any).DateTimeFormat` + `f.format(new Date(0))` already
answered `1/1/1970` — it lowers to a different marshaller. That is why the fix
stayed on the typed path rather than being applied to both.

### 2. Root cause

- `src/codegen/expressions/builtins.ts:197` / `src/codegen/index.ts:12904` —
  a compiled `Date` is `$__Date`, `(struct (field (mut i64)))`, one timestamp.
- `src/runtime.ts` `invokeMethod`, the `hasStructArg` arm — a WasmGC-struct
  argument was marshalled as `_maybeWrapCallableUnknownArity(...) ?? _wrapForHost(...)`,
  i.e. a data **proxy**. `Intl.DateTimeFormat.prototype.formatToParts` runs
  ToNumber on its argument; a proxy gives NaN; V8 throws
  `RangeError: Invalid time value`. The polyfill's own `catch` rewrites that
  into `Invalid ISO date`.
- `src/runtime.ts` `_wasmToPlain` / `_serializeJSONProperty` — `JSON.stringify`
  never reaches `_wrapForHost`; both JSON walks read the carrier's *fields*, so
  `{d: new Date(0)}` serialised as `{"d":{"timestamp":null}}`.

### 3. Fix

`wasmDateHostView` in `src/runtime/date-host-method.ts` materialises the carrier
as a real host `Date`. Classification is the module's own `ref.test $__Date`
published as `__\0js2_is_date` (`emitDateHostBridge`) — **not** a duck-type on a
`timestamp` field, because WasmGC canonicalises structurally identical types and
a field-shape test cannot separate a Date from any other one-i64 carrier
(dev-5354's #5354 note). The compiled representation is unchanged; the
standalone lane (#1343 date-native) keeps `{timestamp}`.

The host view is **identity-cached AND re-synced** on every crossing. Neither
obvious option is correct on its own: minting per crossing breaks reference
identity (the generic marshaller caches its view per struct), and snapshotting
once — the shape `_nativeErrorToHost` uses, where name/message are immutable —
goes stale against `$__Date`'s **mutable** field. Both properties have tests.

`runtime.ts` keeps only a 7-line adapter (`_marshalWasmDateForHost`) binding the
three things the carrier module cannot see: struct classification, the #5225
cross-module DECODER selection, and the reverse identity map. Placing the view
itself in `date-host-method.ts` also keeps the `host-import-policy`
`runtimeTsLines` ratchet green with **no baseline bump** (19149 ≤ 19185); an
earlier draft that put it in `runtime.ts` breached it by 4 lines.

JSON is fixed at the same *class* of boundary by converting the carrier
**before** §25.5.2.4 step 2 in both walks, so the spec's own step finds the real
`Date.prototype.toJSON`. No Date-specific `toJSON` is synthesised in compiled
code (per the plan's step 3).

**Init window.** The two Date bridge exports joined the #5193 init-marshal
registry (`INIT_MARSHAL_HELPERS` / `INIT_MARSHAL_HELPER_NAMES`, append-only
wire ids 6 and 7) with a third trigger, `ownsDateCarrier`. Both the classifier
and the reader are EXPORTS, and the wasm `start` section runs before
`instance.exports` exists — so a `new Date(...)` formatted at module top level
could not even be *recognised* as a Date. Neither existing trigger fires for it:
the crossing is a TYPED extern-class method, not a host construct bridge (#5193)
and not `__extern_method_call` (#5209).

### 4. Measurement — 123-row Temporal family, provider-linked

Fresh `JS2WASM_TEMPORAL_CACHE` per revision. Base = `ae9414f9a8` (this branch's
merge of #5657 + docs + main), fix = `f1ac707acd`.

| | base | fix |
| --- | ---: | ---: |
| pass | 4 | **13** |
| fail | 119 | 110 |

Net **+9** (10 fail→pass, 1 pass→fail).

Base rows blocked by this defect: **68** — 67 `Invalid ISO date` + 1
`Invalid time value` (the `ChineseBaseHelper` crossing). dev-5355 measured 66;
the extra two are the Chinese row and one further `Invalid ISO date` row.
Per calendar (base → still failing after):
islamic-civil 13→11, coptic 13→13, islamic-tbla 9→8, ethiopic 8→8,
islamic-umalqura 7→4, ethioaa 7→6, buddhist 6→5, unattributed 5→3.

**67 of the 68 moved past the Date defect** (10 to pass, 57 to a *different*
error). The next layers, by row count:

| next layer | rows | what it is |
| --- | ---: | --- |
| `RangeError: Era am/aa (ISO year N) was not matched by any era` in `GregorianBaseHelper_completeEraYear` | 21 | coptic 13 + ethiopic 8. The host now returns real era parts; the polyfill's era table does not match them. **This is the new front blocker for those two calendars.** |
| `Test262Error: …: instanceof` | 22 | `assert.throws(RangeError, …)` where the thrown value is not `instanceof RangeError` across the module seam — the #5226 provider-error-identity family. |
| `RangeError: infinity is out of range` | 10 | arithmetic, unrelated to marshalling. |
| `RangeError: Invalid monthCode: M13` | 2 | leap-month handling (ethioaa). |
| still a Date error | 1 | `ZonedDateTime/from/extreme-dates.js` at `-271827-09-23`, which is **outside the JS `Date` range** (min `-271821-04-20`), so `new Date(ms)` is genuinely invalid there. Not a marshalling failure — a real bound of routing calendar arithmetic through host ICU. |

**One row regressed, 1 pass→fail:**
`intl402/Temporal/PlainDateTime/from/islamic.js`. It passed on base **for the
wrong reason** — the test wants a `RangeError` for the non-canonical calendar id
`islamic`, and base happened to throw one (`Invalid ISO date`) from the defect
being fixed. With `formatToParts` working, Node's ICU accepts `islamic` in the
`Intl.DateTimeFormat` constructor and the polyfill's guard never fires; it now
reports `fallback for calendar ID 'islamic' only supported in
Intl.DateTimeFormat constructor, not Temporal`. Accidental pass lost against 10
real gains; the underlying question is calendar-id canonicalisation, not
marshalling.

### 5. Reported, not fixed (with bounds)

- **`JSON.stringify` answers `undefined` for ANY value during module init.**
  The plain-object control (`JSON.stringify({d: 1})` at init) fails identically,
  so this is not the Date defect. Pinned by a test in
  `tests/issue-5208-compiled-date-host-bridge.test.ts` so it cannot later be
  mistaken for one. (`formatToParts` at init IS fixed — its blocker was the
  #5193 export window, closed here for the Date bridge exports.)
- **`tests/date-native.test.ts > "Date.now() returns a number"` fails with
  `LinkError: … "__date_now": function import requires a callable`.**
  Verified PRE-EXISTING on the stack base by an A/B file-copy revert of
  `src/codegen/init-marshal-helpers.ts` — fails identically without any of this
  PR's changes. Not touched here.
- The dynamic `__extern_method_call` argument path is deliberately **not**
  changed: it was measured working for a compiled Date on base, and the
  polyfill never takes it.

### 6. Verification

- `tests/issue-5208-compiled-date-host-bridge.test.ts` — 14 assertions,
  single-module and linked lanes, at init and after init. On base: 11 failed /
  2 passed of the 13 then present.
- Suites (one vitest process each, all green): `date-native` (1 pre-existing
  failure above), `issue-1343-{date-setters,negative-year,timeclip}`,
  `issue-5180-builtin-carrier-field-growth`,
  `issue-5355-intl-datetimeformat-bridge`, `issue-5250-sget-numeric-shape-miss`,
  `issue-5251-temporal-value-seam`, `issue-4628-temporal-global`,
  `issue-4628-class-value-prototype`, and the nine provider suites
  (5221/5225/5226/5237/5239/5241/5242/5244/5248).
- Gates run bare: loc-budget (also `LOC_GATE_BASE=origin/main`), func-budget,
  coercion-sites, oracle-ratchet, dead-exports, host-import-policy, typecheck,
  lint. No `scripts/*-baseline.json` touched;
  `plan/audit/host-import-policy-baseline.json` NOT bumped.
- `node scripts/equivalence-gate.mjs` — **24 failing, 1718 passing**, 24
  known-failures in baseline, "No new equivalence regressions".
- **Collateral, per-row base vs fix** (the marshalling change touches
  `_wasmToPlain` / `_serializeJSONProperty`, so both corpora were run twice with
  an A/B file-copy revert of all four changed sources):

  | corpus | rows | base | fix | status flips | error-string changes |
  | --- | ---: | --- | --- | ---: | ---: |
  | `built-ins/JSON` + `built-ins/Reflect` | 219 | 141 pass / 78 fail | 141 / 78 | **0** | **0** |
  | `built-ins/Date` | 594 | 542 pass / 52 fail | 542 / 52 | **0** | **0** |

  Zero rows changed status AND zero changed their error string — the stronger of
  the two checks, since a count-neutral swap would pass the first and fail the
  second.
