---
id: 6668
title: "standalone: dynamic `new K(…)` pads an omitted externref argument with null, not undefined — defaults never fire (Temporal `value out of range: 1 <= 0 <= 31`, 308 rows)"
status: done
completed: 2026-09-23
assignee: ttraenkler/temporal-A
sprint: current
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: standalone
parent: 5383
related: [5383, 5244, 5380, 6615]
requested_by: ttraenkler/temporal-A
created: 2026-09-23
---

# #6668 — dynamic construct pads a missing externref argument with `null`

## Problem

Standalone Temporal run on main 9b1ba0d19f (polyfill linked,
`test262-standalone-results-20260923-174702.jsonl`): 308 rows fail with
`RangeError: value out of range: 1 <= 0 <= N` (N = 28..31).

Reduction: the polyfill's

```js
class PlainYearMonth { constructor(e, t, n = "iso8601", r = 1) { … RejectISODate(y, m, ToIntegerWithTruncation(r)) } }
```

constructed through the linked provider as `new Temporal.PlainYearMonth(2000, 5)`
received `r = null` instead of `undefined`. The default never ran,
`ToIntegerWithTruncation(null)` is `0`, and `RejectISODate` rejected day 0.
Every `PlainYearMonth` reached through a dynamic construct hit this, which is
why so many unrelated-looking rows (`PlainDate/from/calendar-temporal-object.js`
builds a `PlainYearMonth` inside `TemporalHelpers`) share one message.

Single-module repro (no Temporal):

```js
class Two { constructor(e, r = 1) { this.v = r; } }
function mk(K) { return new K(2000); }
mk(Two).v   // standalone: 0 (null → +null), JS: 1
```

## Root cause

`src/codegen/standalone-class-construct.ts`, `buildTrampolineBody`: the
`__class_construct_<Name>` trampoline pads every argument index `>= argc` with
`defaultValueInstrs(want)`. For an `externref` formal that is `ref.null.extern`,
which the standalone value model reads as JS `null`. The callee's externref
default check is `__extern_is_undefined` (deliberately NOT `ref.is_null`, so an
explicit `null` does not fire the default, #1025), so the default is skipped.
The `__argc` publish only drives the `f64`/`i32` default prologue
(`paramDefaultNeedsArgc`), not the externref one.

The method-dispatch twin (`closed-method-dispatch.ts`, host-dynamic arm) already
pads a missing externref formal with `undefined`; the construct trampoline did not.

## Fix

Pad a missing `externref` formal with the canonical standalone `undefined`
(the reserved `$undefined` singleton, `global.get; extern.convert_any`). Only an
already-reserved singleton is used — the trampoline is minted at finalize, where
reserving a global is unsafe; a module without one keeps the old zero pad.
Typed formals (`f64`/`i32`/refs) keep their zero pad; their defaults stay driven
by `__argc`.

## Witness

`tests/issue-6668-standalone-construct-missing-arg-undefined.test.ts` — dynamic
construct with omitted numeric/string defaults, a non-defaulted omitted formal
observing `undefined`, and an explicit `null` staying `null`.

## Measured (2026-09-23)

Cluster list: the 308 `value out of range: 1 <= 0 <= N` rows from the
standalone Temporal run on main 9b1ba0d19f
(`test262-standalone-results-20260923-174702.jsonl`, 0 / 308 pass there; two
rows re-checked on this branch's base d05f0e8368 before the edit — both fail
with the same message). After the fix, `run-test262-paths.mts --standalone
--isolate`, fresh provider build: **299 / 308 pass**. The 9 left:

| rows | reason |
| ---- | ------ |
| 6 | fail identically when the SAME linked polyfill runs natively in Node (polyfill ⇄ test262 version skew, not compiler): `PlainYearMonth/prototype/{add,subtract}/overflow.js` (`1 <= 31 <= 28`), `…/{add,subtract}/subtract-from-last-representable-month.js`, `…/{add,subtract}/options-read-before-algorithmic-validation.js` |
| 2 | `PlainYearMonth/prototype/{since,until}/roundingincrement-wrong-type.js` — `ToNumber(1n)` throws RangeError instead of TypeError; a separate 13-row cluster in the same run |
| 1 | `PlainYearMonth/prototype/toLocaleString/return-string.js` — `Intl.DateTimeFormat` is unavailable under standalone by design |

Witness A/B (file-copy revert of `standalone-class-construct.ts`): base 2 fail /
2 pass, branch 4 pass (the string-default and explicit-null cases are guards).
Neighbouring suites (`issue-5244`, `6612`, `6615`, `6619`, `5377`, `4288`,
`2158`, `5383`): no new failures; the fix additionally turns green
`#6619 … an omitted argument still runs the default` and `#5383 S2g R14 … fewer
than declared (the default runs)`. Four failures in those files pre-exist on
base (three `#6619` Symbol/BigInt rows, `#5383 S3 … every shard cell downloads
the provider directory`).
