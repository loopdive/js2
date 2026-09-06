---
id: 5374
title: "A consumer object with `valueOf` handed to a linked provider coerces to 0 / no throw — `valueOf` is never called across the seam (`toPrimitiveObserver` rows; `infinity-throws-rangeerror` ×3)"
status: done
completed: 2026-09-06
sprint: current
priority: high
horizon: s
goal: core-semantics
reasoning_effort: high
requested_by: ttraenkler/fable-lead
created: 2026-09-06
# 2026-09-06 (#5374): +13 lines in src/runtime.ts — one `_crossModuleCallbackState`
# redirect at the top of each of the two ToPrimitive walkers (`_toPrimitive`,
# `_hostToPrimitive`) plus the comment that says why the redirect is at the top
# and not at each of the ~10 probe sites. The walkers live in runtime.ts because
# every arm they dispatch is a wasm EXPORT lookup; moving them out would move the
# whole #1090/#1319/#3481 dispatch ladder, which is not this issue's slice.
loc-budget-allow:
  - src/runtime.ts
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

## Implementation Notes (dev-5374, 2026-09-06)

**Step 1 — hypothesis 1 holds, and the log line says so.** Instrumented the
`"[object Object]"` bottom-out of `_hostToPrimitive` on the reduction, with the
provider linked:

```
[5374] hint=number localNames="<no-helper>" ownerFound=true ownerNames="valueOf"
       localSgetValueOf=<no-export> ownerSgetValueOf=object/struct
       localCallFnM0=undefined  ownerCallFnM0=function
```

The provider's own `callbackState.getExports()` has neither
`__struct_field_names` nor `__sget_valueOf` nor `__call_fn_method_0` for a
consumer-minted struct; the #5225 registry names the owner immediately and the
owner's exports serve all three. So the walker was not failing to CALL the
closure — it never found one, concluded "no coercion method", and returned the
`"[object Object]"` sentinel, which `Number()` turns into NaN and the polyfill's
`ToIntegerWithTruncation` turns into 0. Hypothesis 2 (a raw non-callable closure
struct in the slot) is ruled out by the same line: with the owner's exports the
slot reads `object/struct` and dispatches.

**Step 2 — the fix.** One `callbackState = _crossModuleCallbackState(raw,
callbackState)` at the top of each of the two ToPrimitive walkers,
`_toPrimitive` and `_hostToPrimitive` in `src/runtime.ts`. At the TOP rather
than at each of the ~10 probe sites, because the arms must agree on a module: a
`__sget_` from one module against a `__call_fn_*` from another is a wrong
answer, not a missed optimisation (the #5225 file makes the same argument for
the field-read path). Miss path only — the registry short-circuits on its
`enabled` boolean below two live modules, and returns the state unchanged when
the local exports already decode the receiver.

**Steps 3-4 — tests.** `tests/issue-5374-valueof-across-seam.test.ts`, two
lanes over one shared provider/consumer source pair. On base the linked lane
answers 9 of 9 probes wrong (`NaN` / `"[object Object]"`, observer `calls`
empty) and the single-module control is green; after, both are green. The
`pFinite` probe carries the coerced value in its RangeError message on purpose:
base reaches the same `!Number.isFinite` throw with `NaN`, so a bare "did it
throw RangeError?" assertion passes on base and proves nothing.

**Step 5 — measurement.** 417 unique rows = the 3 `infinity-throws-rangeerror`
rows ∪ the 123-row family list ∪ 294 `built-ins/Temporal/**` `*wrong-type*` /
`*non-integer*` rows. Driver `bucket-run.mts` through the runner's own
`runTest262File`, `JS2WASM_TEST262_TEMPORAL=1`, a FRESH `JS2WASM_TEMPORAL_CACHE`
per compiler revision (both runs report `cacheHit=false`, cold builds 44.6 s
base / 46.0 s fix). Base first.

| run | pass | fail |
| --- | --- | --- |
| base (`origin/main`) | 163 | 254 |
| fix | 163 | 254 |

Per-row join of the two TSVs: **0 rows changed status in either direction** —
0 pass→fail, and 0 fail→pass. The 123-row family is 13 pass / 110 fail on both
sides; the 3 `infinity-throws-rangeerror` rows fail on both.

**So acceptance criterion 3's first clause is NOT met, and the reason is a
different defect.** All three of those rows, and every other
`TemporalHelpers.toPrimitiveObserver` row, coerce an object whose `valueOf` is
an **accessor** (`get valueOf() { return function () {…} }`), read out of a
property bag. Measured in the plain single-module lane, with no linking and no
Temporal: `f(o)` where `f(o){return Number(o.v)}` and
`o = {v:{get valueOf(){return () => 3}}}` answers **0** with the getter never
run, while the same object coerced DIRECTLY answers 3, and the same field read
with a method-shorthand `valueOf` answers 3. That is seam-independent, so this
issue's fix cannot reach it; filed as **#5376**.

What this issue's fix DOES move, measured through the linked provider on the
issue's own reported rows (probe `.tmp/probe-temporal.js`):

| row | base | fix | node |
| --- | --- | --- | --- |
| `Duration.from({hours:{valueOf(){return 2}}}).hours` | `0`, valueOf not called | `2`, `valueOf` called once | `2` |
| `PlainDate.from({year:2000,month:{valueOf(){return 3}},day:1}).month` | RangeError "…less than one…" | `3`, `valueOf` called once | `3` |
| `PlainDate.from({…,day:{valueOf(){return Infinity}}})` | RangeError "…less than one…" | RangeError `invalid number value` | RangeError `invalid number value` |
| same with the ACCESSOR observer | RangeError "…less than one…" | unchanged (→ #5376) | month `3` |

**Residual 2, also not fixed:** an object literal whose ONLY member is a
computed `[Symbol.toPrimitive]` key. `__struct_field_names` answers `null` for
that shape in its own module too, and that CSV is the #5225 registry's sole
ownership oracle, so no module claims the struct and there is nothing to
redirect to. Adding any ordinary field makes it nameable and it works — the
test's `pToPrim*` probes carry a `tag: 1` for exactly that reason. Bound: only
literals with no non-symbol member; classes and any literal with a data field
are covered. Not filed separately — it is a property of the #5225 oracle, and
widening that oracle (e.g. to `__is_data_struct`, which DOES answer 1 here) is a
`ref.test`-ambiguity question that belongs with #5225, not here.

**Gates run:** typecheck, lint, `check:loc-budget` (also with
`LOC_GATE_BASE=origin/main`), `check:func-budget`, `check:coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:host-import-policy`,
`node scripts/equivalence-gate.mjs` (22 failing / 1720 passing vs the 24 / 1718
baseline, no new regressions), the 18 provider suites and the ToPrimitive
suites nearest the change.

## Notes

- Found while planning the next Temporal slice after #5364. Independent of
  #5373 (Array-subclass dispatch) — the two can run in parallel.
- Id reserved via `claim-issue --allocate --allow-unscanned` (no `gh` in this
  container); open PRs hand-checked 2026-09-06 — highest in-flight issue file
  is #5364.
