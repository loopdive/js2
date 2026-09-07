---
id: 5376
title: "An accessor-backed `get valueOf()` written INLINE as an object-literal field coerces to 0 with the getter never run (the `toPrimitiveObserver` / `infinity-throws-rangeerror` attribution below was MEASURED FALSE — see `## Measurement`)"
status: done
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/dev-5374
created: 2026-09-06
completed: 2026-09-06
assignee: ttraenkler/dev-5376
loc-budget-allow:
  # 2026-09-06 (#5376) — +7 lines in the anon-struct field-typing loop of
  # `ensureStructForType`: the guard that widens a field whose VALUE is an
  # accessor-bearing object literal to externref. The field-typing loop is the
  # only place that decides the field's ValType, and #1589A's twin guard (empty
  # object literal, same null-drop) already lives there; splitting the decision
  # across two files would make the two guards silently divergable. The
  # predicate itself was moved OUT to `src/codegen/accessor-value-field.ts`
  # (new, 41 lines) precisely to keep this to the 5-line call site + comment.
  - src/codegen/index.ts
func-budget-allow:
  # 2026-09-06 (#5376) — the same +6 lines, seen by the per-function gate.
  # `ensureStructForType`'s field-typing loop is where a field's ValType is
  # decided; #1589A's twin null-drop guard is already inside it, so the accessor
  # guard belongs beside it rather than in a second place that could drift. The
  # predicate is already extracted (`src/codegen/accessor-value-field.ts`), so
  # what remains here is the call site and the reason it exists.
  - src/codegen/index.ts::ensureStructForType
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

> **Superseded by `## Measurement` below.** Everything in this section is the
> lane's pre-fix *inference* about Temporal impact, and the post-fix measurement
> disproves it: `toPrimitiveObserver` mints its object inside a FUNCTION and the
> test hands it over as an identifier, which never had this defect; and all
> three `infinity-throws-rangeerror` rows fail at their FIRST assertion, on a
> raw `eraYear: Infinity` with a `gregory` calendar, before the observer is
> constructed. Kept, struck through in spirit, because the wrong inference is
> the interesting part of the record.


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

## Implementation Plan (Fable, 2026-09-06)

1. **Localise where the accessor is lost.** Rows b/d (direct coercion fires the
   getter) vs f/e (object read out of a field → 0) vs g (method-shorthand
   survives the field read) say the field read hands the ToPrimitive walker an
   object whose ACCESSOR entry is not where the walker looks. Instrument: how
   the inner literal is lowered (accessor table / sidecar / data field); what
   `o.v` returns through `__extern_get` → `__sget_v`; which arm of
   `_toPrimitive` / `_hostToPrimitive` runs and what each probe answers. Quote
   the log line in the PR.
2. **Fix at the walker or at the read, whichever step 1 names** — most likely
   the walker's `__sget_valueOf` probe reading an empty physical slot for an
   accessor-backed member. Keep the data-field / method-shorthand path
   byte-identical; consumer-only direct coercion (rows b/d) must not change.
3. **Both lanes**: single-module AND linked provider; the linked lane goes
   through #5374's `_crossModuleCallbackState` substitution.
4. **Tests**: rows a–g plus `get toString()` and `get [Symbol.toPrimitive]()`,
   the observer call order (`calls` = `g,c` exactly), base-failing on f/e.
5. **Measure**: the 3 `infinity-throws-rangeerror` rows, then a bounded
   `toPrimitiveObserver`-dependent sample, base vs fix per row, 0 pass→fail.

## What step 1 found — the accessor is lost at the STORE, not at the walker

Not a ToPrimitive defect at all. `o.v` is **`null`**, and `Number(null)` is `0`
— which is why the getter never runs and why nothing throws.

The compiled `mk()` for `const o = { v: { get valueOf() { return () => 3 } } }`
(WAT, base):

```wat
(type $__anon_0 (struct (field $valueOf (mut eqref))))
(type $__anon_1 (struct (field $v (mut (ref null 6)))))   ;; 6 = $__anon_0
(func $mk
  call 1                    ;; __new_plain_object  -> externref (HOST object)
  local.tee 1
  ... __defineProperty_accessor "valueOf" ...
  local.get 1
  any.convert_extern
  local.tee 3
  ref.test (ref 6)          ;; host object is NOT a $__anon_0 -> 0
  (if (result (ref null 6))
    (then local.get 3 ref.cast null (ref null 6))
    (else ref.null 6))      ;; <<< the accessor object is DROPPED here
  struct.new 7)
```

Two representations disagree. `compileObjectLiteralWithAccessors`
(`src/codegen/literals.ts`, #1239) builds any accessor-bearing literal as a HOST
externref so V8 sees real accessor descriptors — but TypeScript types the
enclosing property from the getter's RETURN type, so the anon-struct field
typing in `ensureStructForType` (`src/codegen/index.ts`) picks
`(ref null $__anon_0)` for `v`. The guarded store's `ref.test` can never succeed
for a host object, and its `else` arm writes `ref.null`.

Corroborating probes (single module, base):

| probe | result |
| --- | --- |
| `return o.v` (accessor value) to host | **THREW `dereferencing a null pointer`** |
| `return o.v` (method-shorthand value) | struct, `__struct_field_names` → `valueOf` |
| `__sget_valueOf(o)` on the accessor object read out of `o` | `null` |
| outer literal given its OWN accessor (`{ get w(){}, v: {get valueOf(){}} }`) | **3** — host path all the way, nothing to drop |

That last row is the proof that the walker was never the problem: the identical
`Number(o.v)` on the identical accessor object answers 3 as soon as the value
survives the store.

## Fix

`src/codegen/index.ts`, the anon-struct field-typing loop in
`ensureStructForType`: widen the field to `externref` when the property's VALUE
is an accessor-bearing object literal (predicate:
`src/codegen/accessor-value-field.ts`). This is exactly the treatment **#1589A**
already gives an EMPTY object literal in the same loop, for the same reason and
with the same three-line comment about `ref.test` failing and `ref.null` being
stored — the accessor case is that bug one step further along.

Method-shorthand values keep their struct field type byte-for-byte; the
direct-coercion rows b/d never reach this code.

## Measurement (2026-09-06/07, resumed lane)

Base = this branch with the `ensureStructForType` hunk reverted (`src/runtime.ts`
keeps #5374, so the only variable is #5376). Fix = the branch as committed. Both
sides through `tests/test262-runner.ts` (driver `.tmp/bucket-run.mts`, one TSV row
per test so a flip inside an already-failing row is visible), `JS2WASM_TEST262_TEMPORAL=1`,
a FRESH `JS2WASM_TEMPORAL_CACHE` per side (both logged `cacheHit=false`: base
`built in 47032ms`, fix `built in 53808ms` — the provider was cold-built against
each compiler, not reused).

Row set = 170: the 3 named `intl402/**/infinity-throws-rangeerror.js` rows plus the
bounded sample `grep -rl "toPrimitiveObserver\|checkStringOptionWrongType\|checkRoundingIncrement"
test262/test/built-ins/Temporal | head -400`, which yields **167** files (the `head -400`
cap never binds). Never the full bucket.

| side | rows | pass | fail | artifact |
| --- | --- | --- | --- | --- |
| base | 170 | 1 | 169 | `.tmp/base170.tsv` (md5 `fbf36f04a57ed7d92254dabe312c19ed`) |
| fix | 170 | 1 | 169 | `.tmp/fix170.tsv` (same md5 — the two files are BYTE-IDENTICAL, reason strings included) |

**0 pass→fail. 0 fail→pass.** The single pass on both sides is
`built-ins/Temporal/PlainTime/from/observable-get-overflow-argument-string-invalid.js`.

### Acceptance criteria — outcome

1. **Met.** Rows e and f answer `3` / `3:g,c` in all three lanes
   (single module, two modules in one unit, separately linked provider);
   `tests/issue-5376-accessor-valueof-field-read.test.ts`. On base the same file
   fails in all three lanes with exactly `fieldReadValueOf: 0` and
   `observerCallOrder: "0:"` — measured by reverting only `src/codegen/index.ts`.
2. **NOT met, and the criterion's premise is false.** The 3 rows fail identically
   before and after. They fail at their FIRST assertion — L15 / L15 / L14 —
   which is `assert.throws(RangeError, () => …from({ ...base, eraYear: Infinity }))`
   with `era: "ad"` and `calendar: "gregory"`, i.e. a raw `Infinity`, no observer
   in sight. The observer lines (L18–L20) are never reached. Attribution error:
   the issue read `toPrimitiveObserver` in the file and assumed it was the blocker.
3. **Met** — table above.

### Why the observer family was never this bug

`toPrimitiveObserver` builds its object inside a function and RETURNS it; the test
binds it to `const obj` and writes `{ ...base, eraYear: obj }`. The property's value
is therefore an identifier, not an inline object literal. Measured on base
(`.tmp/probe-5376b.mts`, single module, host lane):

| shape | base | fix |
| --- | --- | --- |
| `num({ v: { get valueOf() { return () => 3 } } })` (inline literal) | **0** | **3** |
| `num({ v: mk() })` where `mk()` returns the accessor object | 3 | 3 |
| `const t = mk(); num({ v: t })` | 3 | 3 |
| `const t = mk(); Number(t)` | 3 | 3 |
| `const t = mk(); num({ ...base, v: t })` | 3 | 3 |

Only the INLINE-literal store was broken, and only it is fixed. The store site is
where the field's ValType is decided from the initializer's own syntax; a value
arriving from a call already has a widened slot.

### Residual, measured, NOT this issue

An accessor-backed `valueOf` handed to the **linked Temporal provider** still
coerces wrong. Probe `.tmp/probe262/observer.js` — a one-row test262-shaped file
using the real `TemporalHelpers.toPrimitiveObserver` through
`Temporal.PlainDate.from({ year: 2000, month: obj, day: 1 })` — answers
`RangeError: Cannot convert a number less than one to a positive integer`
**identically on base and on fix**. Method-shorthand `valueOf` through the same
seam answers 3 (recorded on #5374). So the seam has an ACCESSOR-specific
ToPrimitive gap that #5374 did not cover and #5376 cannot reach. Bound:
unmeasured beyond this one probe — it needs its own issue and its own base-vs-fix
row count.

## Reported, not fixed

`objectLiteralForcesHostPath` has other arms that build a host externref and so
hit the identical null-drop when nested as a property VALUE: a runtime computed
key, `[Symbol.dispose]`/`[Symbol.asyncDispose]`, an empty-string key, a
colon-form `__proto__`, and (via `objectLiteralSpreadTakesHostPath`) a
spread-containing literal in a non-specific context. Only the accessor arm is
fixed here, because only it was measured. Bound: unmeasured — each needs its own
base-vs-fix row count before the predicate is widened.

## Gates run (2026-09-06/07)

typecheck · lint · `check:loc-budget` (also with `LOC_GATE_BASE=origin/main`) ·
`check:func-budget` · `check:coercion-sites` · `check:oracle-ratchet` ·
`check:dead-exports` · `check:host-import-policy` — all OK. `equivalence-gate`:
**22 failing / 1720 passing** against a 24-known-failure baseline, no new
regressions (two unrelated `optional-direct-closure-call` baseline rows now pass;
left un-ratcheted, that is a main-side ratchet, not this change's).

Provider suites (#5221 #5225 #5226 #5237 #5239 #5241 #5242 #5244 #5248 #5250
#5251 #5352 #5355 #5374 #4628-temporal-global): 15 files, 91 tests, all pass.
ToPrimitive suites (#1917 #2175 #2358 #2638 #2679 #2891 #3481 #4429 #5102 #5342):
30 files, 355 pass / 8 skipped / **4 fail**. The 4 are standalone-lane and
**pre-existing**: re-run with only `src/codegen/index.ts` reverted to base, the
same 4 fail (`#2358` string-element join, `#4429` ×2 `this`-binding, `#5102`
getter-abrupt control).

`src/runtime.ts` is 19334 lines after merging main (main 19321 + #5374's +13);
`plan/audit/host-import-policy-baseline.json` `maximumRuntimeTsLines` set to that
measured value, and the host-import-policy gate re-run green against it.
