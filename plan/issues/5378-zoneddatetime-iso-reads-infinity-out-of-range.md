---
id: 5378
title: "Every linked-Temporal `ZonedDateTime` field read (`year`, `month`, `day`, `daysInMonth`, `toPlainDate()`) throws `RangeError: infinity is out of range` — even ISO calendar, UTC — while `epochMilliseconds` reads correctly (the epoch→ISO-parts path hands `BalanceISODate` a non-finite)"
status: done
completed: 2026-09-07
sprint: current
priority: high
horizon: m
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-07
# 2026-09-07 — growth grants, measured by the LOC/func gates on the merged
# tree (this branch stacks on #5377's PR #5699, so its grants are RESTATED
# below: the gate reads the change-set's own issue files, and a grant that
# lives only in a file this PR does not modify is a stranded grant).
#
# `src/codegen/property-access-dispatch.ts` (+64): the `accessTypeAdmitsUndefined`
# helper (+21 with its doc block) and the third arm of the `accessWasm`
# family, whose comment records the measured `@js-temporal/polyfill` chain and
# the four-line no-Temporal repro. The arm HAS to sit next to
# `foreignReturnReceiver` / `openObjectReceiver`: all three answer the same
# question (is the checker's type a sound carrier for this read?) at the one
# point where `accessWasm` is decided, and the #5251 branding downstream is
# guarded on the answer being externref. A separate module cannot sit between
# a local `const` and its own initializer.
#
# `src/codegen/typeof-delete.ts` (+9): one `undefSentinel` arm on the bare
# `typeof x` value path, which hand-rolled `__box_number` where the
# `typeof x === "…"` path two hundred lines below already calls `coerceType`.
# The fix is to call the same helper; it lands where the hand-rolled box was.
#
# `src/runtime.ts` (+25 for THIS issue on top of #5377's +187): the
# `DateTimeFormat` member of the existing `webInitArgIndex` options-dictionary
# arm plus the comment recording the measured Intl chain. One expression, in
# the `resolveImport` closure that physically contains the extern-class
# constructor bridge.
#
# `src/codegen/class-bodies.ts`: inherited from #5377 verbatim, no growth from
# this issue.
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
  - src/codegen/typeof-delete.ts
  - src/runtime.ts
  - src/codegen/class-bodies.ts
# `finalizeStructAndDynamicMemberGet` is the function that decides `accessWasm`;
# `compileTypeofExpression` is the one holding the hand-rolled box. The
# `runtime.ts` / `class-bodies.ts` entries are #5377's, restated for the same
# stranded-grant reason as above.
func-budget-allow:
  - src/codegen/property-access-dispatch.ts::finalizeStructAndDynamicMemberGet
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/runtime.ts::resolveImport
  - src/runtime.ts::<anonymous>#95
  - src/codegen/class-bodies.ts::compileClassBodiesInner
---

# #5378 — ZonedDateTime field reads die in `BalanceISODate` on a non-finite operand

## Problem

Measured through the test262 runner, provider linked, 2026-09-06/07
(`probe-5365/zdt-*` rows in the dev-5364 worktree; re-confirmed after #5373 and
#5377 by dev-5377's direct probe):

```js
const d = Temporal.ZonedDateTime.from({ year: 2024, month: 1, day: 1, hour: 12, minute: 34, timeZone: "UTC" });
d.epochMilliseconds        // 1704112440000  (correct — the JSBI divide/toNumber path works)
d.year                     // RangeError: infinity is out of range
d.month / d.day / d.hour   // same
d.daysInMonth, d.dayOfYear // same
d.offsetNanoseconds        // NaN
d.toPlainDate()            // same RangeError
Temporal.ZonedDateTime.from("2024-01-01T12:34[UTC][u-ca=gregory]").year   // same
```

Nothing exotic is involved — ISO calendar, UTC — and the same fields read
correctly on `PlainDateTime`. The throw sites are the polyfill's
`BalanceISOYearMonth` / `BalanceISODate`:

```js
function Cr(e,t){ let n=e,r=t; if(!Number.isFinite(n)||!Number.isFinite(r)) throw new RangeError("infinity is out of range"); … }   // BalanceISOYearMonth
function Or(e,t,n){ … if(!Number.isFinite(i)) throw new RangeError("infinity is out of range"); ({year:r,month:o}=Cr(r,o)); … }   // BalanceISODate
```

so a `year`/`month`/`day` operand reaching them is `NaN`/`±Infinity`. For a
ZonedDateTime those operands come from `GetISODateTimeFor(timeZone, epochNs)`
→ `GetISOPartsFromEpoch(epochNs)` (divmod by 1e6 → `new Date(ms)` →
`getUTC{FullYear,Month,Date,Hours,…}`) plus the time-zone offset
(`offsetNanoseconds` reads `NaN`, which is the same symptom one step earlier).
`epochMilliseconds` takes the divmod-and-`toNumber` half of that path and is
correct, so the non-finite is minted between the divmod and the `Date`
getters — most likely in the compiled `new Date(ms)` / `getUTC*` inside the
provider (a compiled `Date`, see #5208 for the compiled-Date ↔ host-Date
boundary) or in `GetNamedTimeZoneOffsetNanoseconds("UTC", …)`.

Blast radius: every `built-ins/Temporal/ZonedDateTime/**` row that reads a
calendar/time field (hundreds), the 22 `infinity is out of range` rows of the
123-row list, and the `intl402/Temporal/ZonedDateTime/**` calendar rows behind
them.

## Implementation Plan (Fable, 2026-09-07)

**Step 1 — localise the non-finite, from the consumer side, no polyfill
edits.** Through `tests/test262-runner.ts` as synthetic rows (the runner's
compile options are the ones that matter — a bare `compile()` probe decodes
literals differently), provider linked, fresh cache, log each of:
1. `Temporal.Instant.from("2024-01-01T12:34:00Z").epochMilliseconds` and
   `.toZonedDateTimeISO("UTC").epochMilliseconds` — expected 1704112440000.
2. `.toZonedDateTimeISO("UTC").offsetNanoseconds` — expected 0; reads `NaN`
   today. This isolates `GetOffsetNanosecondsFor("UTC", epochNs)`.
3. `.toZonedDateTimeISO("UTC").year` — the `GetISOPartsFromEpoch` half.
4. `Temporal.Instant.from(...).toString()` (uses the same epoch→ISO parts
   path with offset 0) — if this works and 3 does not, the offset is the
   culprit, not the parts.
5. Consumer-only controls of the primitives the path uses, compiled with the
   same options: `new Date(1704112440000).getUTCFullYear()`, `Math.floor(x/1e6)`
   on a large number, `Number(bigint)`; then the SAME primitives inside a
   throwaway linked provider (`tests/issue-5225-consumer-literal-seam.test.ts`
   two-lane template) — `export function parts(ms) { const d = new Date(ms);
   return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; }`. #5208's
   bridge marshals a compiled Date at the extern-class ARGUMENT and JSON
   boundaries; a `Date` minted and consumed inside the provider is a different
   route.
State which of 1–5 first goes non-finite, with the value.

**Step 2 — fix the primitive, not the polyfill.** Expected shapes, by Step-1
answer:
- offset `NaN` → `GetNamedTimeZoneOffsetNanoseconds` uses
  `Intl.DateTimeFormat(…, {timeZone}).formatToParts(date)` (#5355 bridge) or a
  `Date` getter; find which value is `undefined`/`NaN` through the seam.
- parts non-finite → the provider-internal `Date` (`new Date(ms)` in a linked
  module, `getUTC*` on it): #5208 covered host-boundary marshalling; the
  in-module getters may be reading a struct field that was never set when the
  Date was constructed from a number that arrived as `f64` via a JSBI
  `toNumber` result (check the `undefSentinel` branding from #5251 — a NaN
  sentinel read as "absent" or vice versa).
- divmod → `JSBI` arithmetic through the #5377 identity path — if `Number(x)`
  on a JSBI still hits `__toPrimitive`, the digit array stringifies.
One fix, in `src/runtime.ts` / the relevant codegen, gated as narrowly as the
answer allows; consumer-only behaviour byte-identical.

**Step 3 — tests.** `tests/issue-5378-zoneddatetime-iso-reads.test.ts`: the
Step-1 ladder as assertions in the linked lane (base-failing on the first
non-finite step), plus the consumer-only controls green on both sides.

**Step 4 — measure.** Direct probe: `ZonedDateTime.from({…ISO…, timeZone:"UTC"}).year === 2024`
and `.toPlainDate().toString() === "2024-01-01"`. Then
`built-ins/Temporal/ZonedDateTime/prototype/{year,month,day,daysInMonth,offsetNanoseconds,toPlainDate}/**`
(~250 rows) and the 123-row family, base vs fix per row, fresh cache per
revision, 0 pass→fail. Never the full bucket.

**Order-preservation constraints.** `epochMilliseconds` and `PlainDateTime`
reads are correct today and must not change; the #5208 boundary marshalling
tests (`tests/issue-5208-*`) are the guard.

## Acceptance criteria

1. Step 1 answered with the first non-finite value and where it was minted.
2. ISO/UTC `ZonedDateTime.year/month/day/daysInMonth/offsetNanoseconds/toPlainDate()`
   correct through the linked provider.
3. ~250-row ZonedDateTime sample + 123-row family measured, 0 pass→fail,
   counts with artifacts.

## Notes

- Filed after #5373/#5377 landed the dispatch and identity fixes without
  moving this family; supersedes the "ISO `ZonedDateTime.year` still reads
  `infinity is out of range`" residual of #5377 and the 22-row bound of #5373.
- Id reserved via `claim-issue --allocate --allow-unscanned` (no `gh` in this
  container); open PRs hand-checked 2026-09-07 — highest in-flight issue file
  is #5377 (PR #5699).
