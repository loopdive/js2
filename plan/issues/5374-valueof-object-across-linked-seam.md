---
id: 5374
title: "A consumer object with `valueOf` handed to a linked provider coerces to 0 / no throw — `valueOf` is never called across the seam (`toPrimitiveObserver` rows; `infinity-throws-rangeerror` ×3)"
status: ready
sprint: current
priority: high
horizon: s
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
---

# #5374 — ToNumber on a consumer-minted `{ valueOf() {…} }` inside the provider

## Problem

Measured through the test262 runner, provider linked
(`.tmp/probe-5365/{valueof-consumer,valueof-seam,pym-observer}.js` in the
dev-5364 worktree, 2026-09-06):

| where the coercion runs | expression | compiled | node |
| --- | --- | --- | --- |
| consumer only | `Number({ valueOf(){ return 7 } })`, `+o`, `o*1`, via `function(x){return Number(x)}` | 7 | 7 |
| consumer only | observer `{valueOf(){calls.push(…); return Infinity}}` | `Infinity`, calls=`valueOf` | same |
| **provider** | `Temporal.PlainDate.from({ year: 2000, month: obs, day: 1 })` | `RangeError: Cannot convert a number less than one to a positive integer`, **calls = []** | month 3 |
| **provider** | `PlainDate.from({ year:2000, month:1, day: { valueOf(){ return Infinity } } })` | same RangeError (read as 0), no valueOf call | RangeError `invalid number value` |
| **provider** | `Duration.from({ hours: { valueOf(){ return 2 } } })` | `hours === 0` | 2 |
| **provider** | `PlainYearMonth.from({ era:"ad", month:5, calendar:"gregory", eraYear: obj })` (obj = `TemporalHelpers.toPrimitiveObserver(calls, Infinity, "eraYear")`) | no throw, calls = [] | RangeError |

So the consumer's own coercion is correct, and the plain-number half of the
same rows is correct (`eraYear: Infinity` → `RangeError: invalid number value`,
as node). What fails is: a consumer-minted object whose `valueOf` is a compiled
closure, read by the PROVIDER through the #5225 cross-module decoder, then
coerced with the provider's `ToNumber`. The value arrives as `0` (or an
"absent" that the polyfill's `ToIntegerWithTruncation` reads as 0), and the
closure is never invoked.

This is exactly the second half of every `TemporalHelpers.toPrimitiveObserver`
row and the whole of the 3 `infinity-throws-rangeerror` rows on the 123-row
list (`PlainDateTime/prototype/since`, `PlainMonthDay/prototype/toPlainDate`,
`PlainYearMonth/from`) — the node control passes all three. Beyond that list
the helper is used by `checkStringOptionWrongType`, `checkRoundingIncrement…`
and the `*-wrong-type` / `*-non-integer` families across every Temporal type,
so the bucket is wide.

## Implementation Plan (Fable, 2026-09-06)

**Step 1 — which coercion runs, and what it sees.** Reduce with the two-lane
template of `tests/issue-5225-consumer-literal-seam.test.ts`: provider
`export function num(o) { return Number(o.v); }`, `plus(o) { return +o.v; }`,
`trunc(o) { return Math.trunc(Number(o.v)); }`, `direct(x) { return Number(x); }`;
consumer passes `{ v: { valueOf() { return 7; } } }` and the bare observer.
Expected 7 in both lanes. Then instrument the provider-side path in
`src/runtime.ts`: the ToPrimitive helpers (L3620–3700 — `tryMethod("valueOf")`,
the `methodNames` order, the `__call_fn_0` / `__call_@@toPrimitive` arms at
~L3486) and whichever `_decoderExportsFor` (#5225, ~L6178) call sits in front
of them. Hypotheses, most likely first:

1. The provider's ToPrimitive resolves `valueOf` through the PROVIDER's own
   exports (`callbackState.getExports()`), which cannot name a consumer closure
   → treated as "no valueOf" → `+{}`-style NaN → the polyfill's
   `ToIntegerWithTruncation` maps a non-number to 0. Fix: route the closure
   lookup and the `__call_fn_0` invocation through `_decoderExportsFor(obj,
   exports)` the way #5225 did for field reads.
2. The consumer literal is decoded field-wise into a plain host object whose
   `valueOf` slot is a raw closure struct (not callable) → `typeof !== "function"`
   → skipped. Fix: wrap via `_wrapWasmClosure` with the OWNING module's state
   before the primitive lookup.

State which one with the instrumented log line in the PR.

**Step 2 — fix at the seam, not in the polyfill.** Whatever Step 1 says, the
fix belongs in the runtime's ToPrimitive / closure-call path with the owning
module's exports; no new host import, no change to consumer-only coercion (keep
the consumer table byte-identical).

**Step 3 — `toString` and `Symbol.toPrimitive` too.** The same lookup serves
`hint: "string"` (`toString` first) and `@@toPrimitive`; cover both in the
test — the string-option `checkStringOptionWrongType` rows depend on the
`toString` arm.

**Step 4 — tests.** `tests/issue-5374-valueof-across-seam.test.ts`: the
provider/consumer reduction above for `valueOf`, `toString`,
`Symbol.toPrimitive`, an `Infinity`-returning `valueOf` that must reach a
provider-side `if (!Number.isFinite(n)) throw new RangeError(...)`, and the
call-order observer (`calls` must contain `valueOf` exactly once). Base-failing
on the linked lane, green on the single-module control.

**Step 5 — measure.** The 3 `infinity-throws-rangeerror` rows + the 123-row
list (batch, post-#5364 driver, fresh cache) — 0 pass→fail; and a bounded
sample of `built-ins/Temporal/**/argument-object-tostring.js` /
`*-wrong-type.js` / `*-non-integer.js` (`find test262/test/built-ins/Temporal
-name "*wrong-type*"` ≈ 400 rows) base vs fix, per row.

**Order-preservation constraint.** Single-module ToPrimitive is unchanged; the
extra decoder lookup is on the miss path only (the `enabled` boolean of the
#5225 registry short-circuits it when no linked project is live).

## Acceptance criteria

1. Step 1 answered with the log line.
2. Reduction green in both lanes for `valueOf` / `toString` / `@@toPrimitive`
   and the observer call order.
3. 3 `infinity-throws-rangeerror` rows pass; samples measured, 0 pass→fail,
   counts stated with artifacts.

## Notes

- Found while planning the next Temporal slice after #5364. Independent of
  #5373 (Array-subclass dispatch) — the two can run in parallel.
- Id reserved via `claim-issue --allocate --allow-unscanned` (no `gh` in this
  container); open PRs hand-checked 2026-09-06 — highest in-flight issue file
  is #5364.
