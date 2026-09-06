---
id: 5355
title: "`Intl.DateTimeFormat` is a shell — the constructor yields a value that is `=== undefined` with typeof 'object'; format()/formatToParts() return undefined (66 of 123 Temporal calendar rows)"
status: done
sprint: current
priority: high
horizon: l
goal: standalone-gap
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
assignee: ttraenkler/dev-5355
completed: 2026-09-06
# 2026-09-06 (#5355): the fix is ONE extern-class registration, and it has to
# live in the registry that owns "which extern classes exist" — the same block
# that already registers its two siblings `Intl.ListFormat` and
# `Intl.NumberFormat`. 36 of the lines are the rationale comment (why the typed
# spelling missed, and why this one entry is host-lane-gated when the siblings
# are not); the table itself is 12. Splitting one sibling entry out of a
# sibling list into a new module would make the list harder to read, not easier.
loc-budget-allow:
  - src/codegen/extern-declarations.ts
  - src/codegen/expressions/new-super.ts
  - src/runtime.ts
# 2026-09-06 (#5355): `compileNewExpression` grows by the 8-line dispatch hookup
# only — the standalone-refusal LOGIC lives in the new
# `src/codegen/expressions/new-intl-host-bridge.ts`. The arm must sit at this
# exact point (immediately before the terminal `reportError`) so it can only
# fire where every other arm declined, so it cannot be lifted out of the
# function. `registerBuiltinExternClasses` and `resolveImport` are the sibling
# lists described above.
func-budget-allow:
  - src/codegen/extern-declarations.ts::registerBuiltinExternClasses
  - src/codegen/expressions/new-super.ts::compileNewExpression
  - src/runtime.ts::resolveImport
---

# #5355 — `Intl.DateTimeFormat` exists but does nothing

## Problem

#5206 provided the `Intl` global (its title: "Intl is not provided at all")
and is `status: done`. What landed is a SHELL. Measured by dev-5250 and
dev-5251 from a compiled consumer with no Temporal involved:

```
typeof Intl                                                    "object"
typeof Intl.DateTimeFormat                                     "function"
new Intl.DateTimeFormat("en-US").resolvedOptions()             undefined   (node: object)
new Intl.DateTimeFormat("en-US",{timeZone:"UTC"}).format(d)    undefined   (node: "1/1/2024")
new Intl.DateTimeFormat("en-US",{timeZone:"UTC"}).formatToParts(d)
      → single-module: RuntimeError: dereferencing a null pointer (a Wasm trap)
      → linked lane: `TypeError: invalid receiver`
```

The polyfill's `getCalendarParts` wraps `formatToParts` in
`try { … } catch { throw new RangeError("Invalid ISO date: …") }`, which is
where the reported error is minted. **66 of the 123 #5249 calendar rows** end
here after the dispatch/value layers were cleared (PRs for #5352/#5250/#5251).

Bound (dev-5251): only calendars whose `isoToCalendarDate` is pure arithmetic
(gregory, japanese, roc) can pass without real ICU; buddhist, indian, ethiopic
and coptic need `formatToParts` to return real calendar parts.

## Implementation Plan (Fable, 2026-09-06)

1. **Decide the capability shape** (this is the design call, do it first and
   write it down): the JS-host lane can forward `Intl.DateTimeFormat` to the
   HOST's real `Intl` through an externref bridge — construction, `format`,
   `formatToParts`, `resolvedOptions` as host-mirror calls with the receiver
   kept as an opaque externref. That is the #679/#682 dual-backend pattern:
   host fast path now, a standalone fallback declared out of scope with its
   bound (no ICU in pure Wasm). Do not attempt ICU in Wasm here.
2. **Find why the constructor answers `undefined`**: the #5206 implementation
   exists — read its issue file and PR; find the branch that yields a value
   `=== undefined` but `typeof "object"` (a boxed-null externref? a
   `ref.null.extern` default from a missing host import?). The
   single-module null-deref trap vs the linked `invalid receiver` says the two
   lanes take different paths; unify on the host bridge.
3. **Reduction** covering the four calls above, both lanes; base-failing.
4. **Measure** `family-123.txt` provider-linked; expect the 66 to move (the
   ICU-needing calendars only if the host bridge carries real parts — say
   which did and which did not).

## Acceptance criteria

1. `new Intl.DateTimeFormat(...)` is an object; `format`/`formatToParts`/
   `resolvedOptions` return node-equivalent values on the JS-host lane.
2. Standalone: a clear thrown `TypeError`/unsupported, never a trap, with the
   bound recorded.
3. 123-row re-measurement with counts.

## Notes

- Follow-up to #5206 (done: the global exists; this: it must work).
- Filed from dev-5250/dev-5251 measurements, 2026-09-06.
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.

## Implementation notes (2026-09-06, ttraenkler/dev-5355)

### 1. The design call — host mirror, standalone refuses

**Decided: forward to the host's real `Intl` through the existing extern-class
bridge; declare standalone out of scope with its bound.** This is the #679/#682
dual-backend shape (host fast path now, standalone stated rather than faked).

The shape was not invented for this issue. `extern-declarations.ts` already
registers `Intl.ListFormat` and `Intl.NumberFormat` exactly this way —
`importPrefix: "Intl_<Class>"`, `namespacePath: ["Intl"]`, an externref
constructor and an externref-in/externref-out method table — with the host
constructor bound in `builtinCtors` (`src/runtime.ts`). The receiver stays an
opaque host externref for its whole life; nothing is unwrapped or re-wrapped.
So `DateTimeFormat` is one more sibling entry, not a new mechanism. **The bridge
generalises to `Collator`, `PluralRules`, `RelativeTimeFormat`,
`DurationFormat`, `Segmenter` and `DisplayNames` unchanged** — see Follow-ups.

**Standalone is refused, not shimmed.** There is no ICU in pure Wasm: real
calendar and time-zone formatting needs the CLDR/tzdata tables, so a compiled
shim would have to carry them. #5206 reached the same conclusion for the
namespace. What is new here is that the refusal is now *explicit*: a catchable
`TypeError` naming the bound, instead of the silent `undefined` + later trap.

**Difference from the siblings, deliberate:** `ListFormat`/`NumberFormat` are
registered unconditionally and still emit `Intl_*` imports into a `--target
standalone` binary with a host-import-leak warning (they predate the #2961
ratchet). A NEW host import must not add to that, so `DateTimeFormat` is gated
`!ctx.standalone && !ctx.wasi && !ctx.nativeStrings`. Retro-fitting the siblings
is a separate decision and is not made here.

### 2. Root cause of the `undefined`-typed-`object`

`src/codegen/expressions/new-super.ts:6032` — `compileNewExpression` takes the
constructed class name from the checker's type symbol, which for
`new Intl.DateTimeFormat(...)` is the interface symbol **`DateTimeFormat`**, and
every downstream arm keys off it. `ctx.externClasses` had no such entry, so the
expression fell through all of them to the terminal
`reportError(… "Unsupported new expression for class: DateTimeFormat")` at
**`new-super.ts:7312`** and the caller's recovery emitted `undefined`.

Neither a boxed null nor a `ref.null.extern` default, and **not** a
value-representation defect. The `typeof "object"` half is a *static* answer:
`typeof` on a typed expression is constant-folded from the declared TS type,
which says `Intl.DateTimeFormat`. So the paradox is one true statement about the
type next to one true statement about the value.

Instrumented proof (base, this tree, 2026-09-06): a per-`return` trace inside
`compileNewExpression` fires only at line 7313; the compiled module for
`new Intl.DateTimeFormat("en-US")` imports `__typeof`, `__get_undefined`,
`__extern_to_string_default`, `__extern_is_undefined`, `__concat_6` — **no
constructor import of any kind**.

**Why the two lanes reported differently, and why unification was not the fix.**
Both lanes produced the same `undefined`; they only differ in who notices. The
single-module lane calls the method through compiled dispatch and dereferences
the null receiver (Wasm trap); the linked lane hands the receiver to a host
method that checks its brand (`TypeError: invalid receiver`). Making the receiver
REAL removes both; there was nothing to unify.

**Second symptom from the same miss:** the method lookup
(`findExternInfoForMember`) matches by member NAME across registered extern
classes, so `.format(...)` on the missing class resolved to `ListFormat.format`
and the module imported `Intl_ListFormat_format` for a `DateTimeFormat` call.
A regression test pins that.

**Why `(Intl as any).DateTimeFormat` already worked** (and is kept as a control):
the `any` spelling never reaches this code — it lowers to
`__extern_get`/`__construct_closure` on the #5206 host-global path. The defect
was only ever in the TYPED spelling, which is what ordinary TypeScript and the
minified polyfill both emit.

### 3. Measured, before/after, both lanes

Single-module JS-host lane (`compile` + `buildImports`):

| probe | base | with fix | node |
| --- | --- | --- | --- |
| `typeof f` / `f === undefined` | `object` / `true` | `object` / `false` | `object` / `false` |
| `.resolvedOptions().timeZone\|.calendar` | `undefined\|undefined` | `UTC\|gregory` | same |
| `.format(0)` | `undefined` | `1/1/1970` | same |
| `.formatToParts(0)` | **trap**: dereferencing a null pointer | 5 real parts | same |
| ethiopic `formatToParts(0)` | (unreachable) | `month=4;day=23;year=1962;era=AM` | same |
| `.formatRange(0, 86400000)` | (unreachable) | `1/1/1970 – 1/2/1970` | same |
| `Intl_ListFormat_format` imported? | **yes** | no | — |

Linked/multi-module lane (`compileMulti`, constructor in another module):
base `true\|undefined\|undefined` → fix `false\|1/1/1970\|5`.

Standalone (`--target standalone`, zero imports asserted): base — the
constructor silently answered `undefined`, and the first method call trapped;
fix — a catchable `TypeError` at construction. Neither lane gains any `Intl_*`
import (asserted for `standalone` and `wasi`).

### 4. The 123-row re-measurement — the 66 did NOT move, and here is why

Provider-linked, `JS2WASM_TEST262_TEMPORAL=1`, fresh `JS2WASM_TEMPORAL_CACHE`
per side, run here on `main + #5251 (PR #5648) + this fix`, 2026-09-06:

| | base | with fix |
| --- | --- | --- |
| pass | 4 | 4 |
| fail | 119 | 119 |
| rows ending in `getCalendarParts` | **66** | **66** |
| status flips | — | **0** |

The 66 reproduce exactly as reported. **They do not move, and the reason is a
different, already-filed gap: #5208 (a compiled `Date` is not a host `Date`).**

The one row that DID change its error is the proof that the bridge is live on
this lane and that #5208 is what is behind it:

```
intl402/Temporal/PlainDate/from/calendar-invalid-era.js
  base: TypeError: invalid receiver … in DateTimeFormatImpl_formatToParts
  fix:  RangeError: Invalid time value … in ChineseBaseHelper_getMonthList
```

The receiver problem is gone; the next thing the same call hits is the host
rejecting a compiled `Date`. Directly confirmed on the single-module lane WITH
this fix: `formatToParts(0)` returns real parts, `formatToParts(new Date(0))`
throws `RangeError: Invalid time value`. The polyfill's `getCalendarParts` passes
`new Date(...)`, and its `catch` rewrites that into the
`RangeError: Invalid ISO date: …` these 66 rows report. The other 85 reason
diffs between the two runs are source-line numbers only.

Per-calendar attribution of the 66 (all still failing, all on #5208):
islamic-civil 13 · coptic 13 · islamic-tbla 9 · ethiopic 8 · islamic-umalqura 7
· ethioaa 7 · buddhist 6 · 3 non-calendar-named rows.

**So the bound in the Problem section needs one correction.** It said the
ICU-needing calendars would pass "if the host bridge carries real parts". The
bridge does carry real parts — measured above, ethiopic included — but the
polyfill cannot hand it a date it will accept until #5208 lands. **This issue is
necessary but not sufficient for the 66; #5208 is the remaining blocker.**

### Follow-ups (bounds stated)

- **#5208 (already filed) gates the 66.** Nothing else in this family moves
  until a compiled `Date` marshals to a host `Date`.
- **Other `Intl.*` constructors are the same one-entry change**, deliberately
  not made here: `Collator`, `PluralRules`, `RelativeTimeFormat`, `Segmenter`,
  `DisplayNames`, `DurationFormat` (the polyfill reads the last one). Each is a
  ~12-line table plus a `builtinCtors` line; no new mechanism. `DurationFormat`
  additionally needs an existence guard — it is not in every host.
- **The pre-#2961 sibling leak** (`ListFormat`/`NumberFormat` emitting `Intl_*`
  imports into standalone with a warning) is untouched. Closing it means giving
  them the same host-lane gate + refusal arm, which changes their standalone
  behaviour from "works with a warning" to "throws" — a deliberate decision, not
  a drive-by.
