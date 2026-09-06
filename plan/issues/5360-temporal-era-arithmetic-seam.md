---
id: 5360
title: "A `= undefined` parameter default discards the argument (slot + typeof/String folds) — surfaced as `eraName must be string or undefined` on 5 of the 123 Temporal calendar rows; the `Unsupported era name` / `not matched by any era` buckets are a polyfill version gap, not a compiler defect"
status: done
completed: 2026-09-06
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
# 2026-09-06 (#5360) — the `= undefined` parameter fix lands in four lanes plus
# one shared helper. The four god-files are the SIGNATURE/BODY pair sites for
# the object-literal-method, arrow/function-expression, `typeof` and `String()`
# lowerings; the widening MUST be applied at each pair or the emitted call is
# invalid Wasm (see widenUndefinedDefaultParamSlot's doc comment). The helper
# itself lives in destructuring-params.ts next to `isNullOrUndefinedLiteral`,
# which it reuses.
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/literals.ts
  - src/codegen/closures.ts
  - src/codegen/destructuring-params.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/literals.ts::compileObjectLiteralForStruct
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/codegen/typeof-delete.ts::compileTypeofComparison
# INHERITED grants, restated for the reader (NOT re-granted here — the gate
# already resolves them from the stacked branches' own issue files, which this
# PR carries): src/runtime.ts, src/runtime/date-host-method.ts,
# src/runtime/init-marshal-registry.ts, src/codegen/init-marshal-helpers.ts,
# src/codegen/expressions/new-super.ts, src/codegen/extern-declarations.ts,
# src/codegen/index.ts, src/codegen/property-access-dispatch.ts,
# src/codegen/type-coercion.ts — from #5208, #5354, #5355 and #5251.
# `plan/audit/host-import-policy-baseline.json` maximumRuntimeTsLines is bumped
# 19185 -> 19313 to the MEASURED value; that growth is entirely those branches'
# runtime.ts, none of it this change-set's.
---

# #5360 — era arithmetic seam (newly visible after #5354)

## Problem

Measured by dev-5354 (PR #5661) on the 123-row #5249 Temporal calendar list,
provider linked, after the object-identity fix let `TemporalHelpers.assert*`
get past its opening `instanceof`:

| rows | error (thrown by the polyfill's own guards) |
| --- | --- |
| 10 | `RangeError: Unsupported era name: …` |
| 8 | `TypeError: eraName must be string or undefined …` |

Both come from `GregorianBaseHelper` / `JapaneseHelper` era handling in
`@js-temporal/polyfill@0.5.1`: era records are `{ name, isoEpoch, anchorEpoch,
hasYearZero, … }` held in an array on the helper, matched by `era.name` and
by aliases, and `eraYear`/`era` are read off the property bag the CONSUMER
passes (`{ era: "reiwa", eraYear: 1, month: 1, day: 1, calendar: "japanese" }`).
Same run: `eraYear.valueOf` never fetched (3 rows, observable-order family).
Node on the same pinned polyfill passes these rows.

## Implementation Plan (Fable, 2026-09-06)

1. **Probe the value at the seam, not the guard.** Two 3-line compiled
   repros vs node-on-polyfill: (a) `Temporal.PlainDate.from({era:"reiwa",
   eraYear:1, month:1, day:1, calendar:"japanese"})`; (b) the same with
   `era:"ce"` on `gregory`. Capture, inside the polyfill's era lookup, what
   `era` and `eraYear` actually ARE when they arrive: `typeof`, and whether a
   string survived the record bridge as a string. Suspects, in order:
   - the consumer's property-bag string crossing the #5243 record bridge as
     something other than a JS string (`eraName must be string` is exactly
     that guard firing);
   - an era TABLE entry read through a compiled array/object where a field
     comes back as a comma-joined carrier (dev-5247 saw `817405952,3352`
     reach `BigInt()` in #5245 — an array where a scalar was expected);
   - `era.name` compared by `===` against a bridged string that is a host
     mirror, so identity fails where value equality is meant.
2. Fix at the boundary that loses the type (record bridge / string carrier),
   not in the polyfill; if the string arrives intact and the lookup itself
   mis-compares, that is a codegen string-equality issue — reduce it without
   Temporal.
3. Reduction + base-failing test `tests/issue-5360-*.test.ts` (both lanes).
4. Measure `family-123.txt` provider-linked on a base stacked on PR #5661
   (#5354) — the rows are only reachable there. Report the 18 and the next
   layer; the 3 `eraYear.valueOf` ordering rows may be the same root.

## Acceptance criteria

1. Probe evidence: the first wrong value, where it became wrong.
2. Base-failing reduction; the 18 rows move (state counts); no regressions in
   the provider family; equivalence at baseline.

## Notes

- Filed from dev-5354's next-layer table, 2026-09-06. Stack on
  `issue-5354-linked-class-instanceof` (PR #5661).
- Id reserved via `claim-issue --allocate` with a degraded open-PR scan.

---

## Implementation notes (dev-5360, 2026-09-06)

### The premise was wrong: most of this family is a POLYFILL gap, not a compiler defect

The plan above (and the brief that carried it) says "Node on the same pinned
polyfill passes these rows." **It does not.** Measured, not assumed: the same
123 rows were run under node against the same `@js-temporal/polyfill@0.5.1`
UMD bundle and the same test262 harness, one fresh `vm` context per row
(`.tmp/node-family.mjs` — the rows re-declare a top-level `const calendar`, so
a shared realm cross-contaminates and reads as a failure).

| lane | pass | fail |
| --- | --- | --- |
| node on the pinned polyfill | **45** | 78 |
| compiled, on this branch's stacked base | 13 | 110 |

So the family's reachable ceiling with this polyfill is 45, and the
compiler-attributable gap is **32 rows**, not ~39. Cross-tabulated:

| bucket | rows | node also fails? | verdict |
| --- | --- | --- | --- |
| `Unsupported era name: …` | 10 | **all 10** | polyfill gap |
| `Era am/aa … was not matched by any era` | 21 | **all 21** | polyfill gap |
| `eraName must be string or undefined` | 21 | 16 of 21 | **5 are the compiler's** |

The reason is version skew, and it is easy to confirm: polyfill 0.5.1 predates
the `Intl.Era-monthcode` era-code renaming, so it reports `date.era` as
`"gregory"` / `"japanese"` / `"roc-inverse"`, while the harness's
`CalendarEras` table knows only `bce`/`ce`/`broc`/`reiwa`/…. That is exactly
the shape of the error text — `Unsupported era name: gregory` names a
*calendar id*, which no era table will ever contain. Node prints the identical
message. **These 31 rows cannot be fixed in the compiler at all**; they need a
newer polyfill pin (or a harness-side alias map), and are re-filed as such
rather than left looking like a codegen seam.

The three suspects the plan listed — record-bridge string carrier, comma-joined
array carrier, host-mirror `===` identity — were probed and **all three are
clean** (`.tmp/probe4.mts`: `includes`, `indexOf`, `===`, `==`,
`String(a)===String(b)` and `charCodeAt` all agree between a compiled string
table and a parameter string).

### Root cause of the 5 rows that ARE the compiler's

`typeof eraName` answered **`"number"`**, not a wrong string — so nothing was
losing a string's *contents*; a string was never arriving. It came from the
caller's parameter list:

```js
// test262/harness/temporalHelpers.js
assertPlainDate(date, year, month, monthCode, day, description = "", era = undefined, eraYear = undefined)
```

Under the deliberately-pinned `strictNullChecks: true` (#2748) TypeScript
infers `era` as the **type `undefined`** — from its own default initializer.
That is a statement about TS callers, not about the values a JavaScript caller
passes, and two independent parts of codegen trusted it:

1. **The slot.** `resolveWasmType(undefined)` is a numeric slot ("void → no
   result", `src/checker/type-mapper.ts:80`). The object-literal-method,
   arrow and function-expression lanes therefore gave `era` an i32/f64
   parameter and the argument was coerced away at the call boundary. The
   free-function lane escaped only because call-site inference overrides its
   registered signature — which is why `description = ""` bound correctly in
   the same call and made this look like argument shifting.
2. **The folds.** `typeof x` (`src/codegen/typeof-delete.ts:1348`) and
   `String(x)` (`src/codegen/expressions/call-identifier.ts:~1441`, and again
   in `emitToString`, `src/codegen/coercion-engine.ts:~287`) drop the carrier
   and substitute the constant `"undefined"` whenever the static type carries
   `TypeFlags.Undefined`.

Either half alone leaves the row failing; both were measured separately.

Reduction, no Temporal (`tests/issue-5360-undefined-default-param.test.ts`):

```js
const objLit = { m(a, b = undefined) { return typeof b + ":" + String(b); } };
objLit.m(1, "heisei")   // base: "boolean:0"          node: "string:heisei"
function decl(a, b = undefined) { return typeof b + ":" + String(b); }
decl(1, "heisei")       // base: "undefined:undefined" node: "string:heisei"
```

### Fix

Two narrow helpers in `src/codegen/destructuring-params.ts`, next to the
`isNullOrUndefinedLiteral` they reuse:

- `widenUndefinedDefaultParamSlot(param, wasmType)` — an **un-annotated**
  parameter with a literal `undefined` / `void <num>` / `null` default gets an
  externref slot instead of i32/f64/i64. Applied at the SIGNATURE and BODY
  sites of the object-literal-method lane (`literals.ts` ×3) and the
  arrow/function-expression lane (`closures.ts`). The pairing is load-bearing:
  applying it to one of a pair and not the other emits invalid Wasm, the same
  rule the neighbouring binding-pattern widening documents.
- `paramUndefinedTypeIsDefaultArtifact(ctx, expr)` — suppresses the two
  constant folds for a read of such a parameter. Routed through
  `ctx.oracle.declarationsOf`, not the raw checker: the question is about the
  declaration's *syntax* (annotation present? initializer shape?), not a type,
  so it costs nothing on the oracle ratchet.

Deliberately narrow so the sound folds keep firing: `b: undefined` (a real
annotation), `b = ""`, `b?: T` and rest parameters are all untouched.

### Measured result — 123 rows, provider-linked, same driver both sides

| | base | fix |
| --- | --- | --- |
| pass | 13 | **15** |
| pass → fail | — | **0** |

| bucket | base | fix |
| --- | --- | --- |
| `eraName must be string or undefined` | 21 | **13** |
| `… instanceof` | 23 | 26 |
| `infinity is out of range` | 22 | 22 |
| `was not matched by any era` | 21 | 21 |
| `Unsupported era name` | 10 | 11 |
| `Expected a RangeError to be thrown` | 5 | 5 |
| `Invalid monthCode` | 5 | 5 |

All **5** compiler-attributable `eraName` rows clear the guard: 2 pass outright
(`PlainDate/prototype/add/constrain-day-roc`,
`PlainDateTime/prototype/with/leap-year-japanese`) and 3 advance to a **next
layer** (`… : instanceof` ×2 — the #5354 residual; `monthCode M01 and month 2
must match` ×1). The other 8 that left the bucket are polyfill-limited rows
that now fail one step later.

### The remaining 27 of the 32-row compiler gap (reported, NOT fixed)

Bounded and named so the next lane does not re-derive them:

| rows | bucket | note |
| --- | --- | --- |
| 11 | `… : instanceof` on `since`/`until`/`from` results | `assert(x instanceof Temporal.Duration/PlainMonthDay)` — #5354 residual, a different receiver than the one that fix covered |
| 7 | `RangeError: infinity is out of range` (all `ZonedDateTime`) | a finite quantity reaches the polyfill as `Infinity`; node computes a finite value on the same input |
| 3 | `Expected a RangeError to be thrown but no exception was thrown` | the `infinity-throws-rangeerror` files — same family as the row above, inverted |
| 2 | `Invalid monthCode: M13` (ethioaa) | 13-month calendar |
| 4 | mixed one-offs | see `.tmp/gap-32.txt` |

The 7 + 3 infinity rows look like one root and are the cheapest next slice.

### Also measured, also NOT fixed (bounded)

- `const U = undefined; function f(a, b = U)` — the default is an identifier,
  not the literal, so neither helper fires and the parameter still folds to
  `undefined`. Rarer shape; the harness does not use it. Guarding it would
  need constant-propagation into the initializer, which is a larger change
  than this issue warrants.
- A class method with a `= undefined` default is **not** covered here
  (`class-bodies.ts` was left alone). While probing it I hit a *pre-existing*
  and unrelated compile failure — a module holding both a class method and an
  object-literal method with defaults emits
  `return_call[0] expected type (ref null N), found ref.as_non_null of type
  (ref M)` — which reproduces byte-identically on the unmodified base. Not
  caused by this change; not diagnosed further here.
