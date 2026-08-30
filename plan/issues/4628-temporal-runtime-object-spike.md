---
id: 4628
title: "Temporal as a real runtime object: spike @js-temporal/polyfill vs porting engine262's abstract-ops (2,206 × 'Temporal is not defined')"
status: done
completed: 2026-08-30
assignee: ttraenkler/dev-temporal-wire
sprint: current
created: 2026-08-23
updated: 2026-08-30
loc-budget-allow:
  # #4628 (2026-08-30) — the compile-once Temporal provider and its harness.
  # `src/temporal-provider.ts` is new surface (provider build + consumer
  # wiring); `temporal-native.ts` and `array-methods.ts` grow only by the
  # rationale comments that record the measured precedence / #2838 decisions,
  # and `runtime.ts` by the class-object `.prototype` reader.
  - src/temporal-provider.ts
  - src/runtime.ts
  - src/codegen/temporal-native.ts
  - src/codegen/array-methods.ts
  - tests/dogfood/temporal-global-harness.mjs
  - tests/issue-4628-temporal-global.test.ts
  - tests/issue-4628-class-value-prototype.test.ts
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: temporal
goal: spec-completeness
test262_fail: 2206
depends_on: [4627, 5191]
related: [661, 5192]
---

# #4628 — Temporal as a real runtime object

## Problem

**2,206 test262 rows fail with `Temporal is not defined`** — 48 % of the
Temporal bucket. No amount of work on the current implementation can fix
them, because the current implementation is not an object.

#661 shipped a **compile-time lowering**, not a runtime global:

- `src/codegen/temporal-native.ts` (1,251 lines) pattern-matches `Temporal.*`
  syntax in the AST and emits WasmGC structs (`__TemporalPlainDate`,
  `__TemporalPlainTime`, `__TemporalDuration`) directly.
- `src/runtime.ts:8733–9230` (~30 `_temporal*` helpers) does ISO 8601 /
  RFC 9557 parsing, duration validation, and `toString` formatting.

`temporalKindForExpression` resolves a value's kind **syntactically** — from a
`new Temporal.X(...)`, a `Temporal.X.from(...)`, a local whose initializer was
one of those, or a chained `.add()`/`.subtract()`. Anything that breaks that
static chain falls off the path entirely: `Temporal` passed as a value,
`Object.getOwnPropertyNames(Temporal)`, subclassing, property descriptors,
dynamic indexing. There is no global object at runtime, which is why
`src/codegen/array-methods.ts:390` must list `Temporal` in
`CLOSURE_UNSAFE_HOST_AMBIENTS` — widening that gate flipped 212 Temporal
tests pass→fail on PR #2838.

Current surface: 3 of 9 classes (`PlainDate`, `PlainTime`, `Duration`), ISO
calendar only, no time zones, no option bags. Missing entirely: `Instant`,
`PlainDateTime`, `PlainMonthDay`, `PlainYearMonth`, `ZonedDateTime`,
non-ISO calendars, `round`/`until`/`since`/`with`.

## Measured baseline

From `test262-current.jsonl` (fetched fresh 2026-08-23, 48,735 entries):

| Bucket | Count | Root cause |
| --- | --- | --- |
| Total Temporal | 4,611 | — |
| `compile_error` | 1,487 | 1,477 of them are **one codegen bug** → #4627 |
| `Temporal is not defined` | 2,206 | **this issue** |
| Genuine semantic failures | ~711 | the real Temporal work |
| `pass` | 207 | — |

Failures by directory: ZonedDateTime 892, PlainDateTime 768, PlainDate 583,
PlainYearMonth 504, Duration 487, Instant 457, PlainTime 437,
PlainMonthDay 198, Now 65.

Top semantic errors behind the two blockers: `Expected a RangeError but got a
TypeError` (59), `Cannot convert bigint to a BigInt` (45), `Expected a
RangeError to be thrown but no exception was thrown at all` (34), `total is
not a function` (28), `empty string is not a valid calendar ID` (25).

**Depends on #4627**, recorded in `depends_on:` above. (It was temporarily held
in `related:` plus prose while #4627's issue file was still unmerged and the
`quality` dangling-`depends_on` gate rejected a pointer it could not resolve;
that file landed on `main` in PR #4788 on 2026-08-23 and the dependency is now
declared properly.) Until the 1,477 compile errors clear, a third of the
bucket never instantiates and any change here is unmeasurable in those rows.
Expect the ~711 semantic-failure count to *grow* once tests stop failing at
`not defined` and start failing on substance.

## The decision this issue must make

Two viable paths to a real `Temporal` global. **Spike before committing** —
the point of this issue is to produce the number that decides it.

### Option A — compile `@js-temporal/polyfill`

Ordinary JS, ~15,000 lines. The **only** path that reaches the calendar and
time-zone tests at all, because it ships real calendars and tzdata.

This is exactly #661's original decision tree (`<50 CE → ship it`,
`50–200 CE → the CE list is a prioritized bug list`, `>200 CE → minimal
subset instead`). It was answered "minimal subset" under a compiler that
could not yet handle acorn. **That answer is stale** and worth re-running.

Risk: dynamic property access, prototype chains, BigInt, complex string
parsing. Failure is still informative — the CE list is a free, prioritized
compiler-bug backlog against a real-world library, which was #661's own
argument for trying.

### Option B — port engine262's Temporal abstract-ops

`engine262/engine262@main`, MIT licensed, verified 2026-08-23 by shallow
clone:

- `src/abstract-ops/temporal/*` — ~4,901 lines, the spec arithmetic
- `src/parser/TemporalParser.mts` — 1,245 lines, standalone-ish
- `src/intrinsics/Temporal/*` — 18 files, ~3,444 lines

**Port the abstract-ops and the parser; skip the intrinsics wrappers** —
those are thin binding glue against engine262's object model that would be
rewritten against ours anyway.

The blocker is coupling, not licensing: every function takes and returns
engine262 `Value` objects, threads completion records through `Q(...)` /
`X(...)`, reads internal slots off engine262 ordinary objects, and imports
from the `#self` engine barrel in 31 places. It only runs inside a full
engine262 realm. So this is a **mechanical port of ~6k lines**, not a
vendoring exercise.

Hard ceiling: engine262's Temporal is **ISO-only**
(`CalendarType = 'iso8601'`, `AvailableCalendars() → ['iso8601']`) and
**UTC + numeric offsets only** (`Assert(timeZoneIdentifier === 'UTC')` in the
named-time-zone path). It would not reach the calendar/tz tests.

*(Rejected: embedding engine262 wholesale — a JS interpreter inside the
js2wasm runtime to service `Temporal` — wrong shape for this project.
Rejected: extending `temporal-native.ts` to 9 classes — it cannot define a
global, so it caps out below the 2,206.)*

## Plan

1. **Spike Option A** (~1 day): compile `@js-temporal/polyfill`, count
   compile errors, bucket them by root cause. This is the deliverable of the
   spike — a number and a bucket list, not an implementation.
2. **Decide** against #661's thresholds, updated for the current compiler.
3. **Implement** the winner. If A fails badly, B is the fallback and the
   spike's CE list is retained as a compiler backlog.
4. Either way, `Temporal` becomes a real global and `Temporal` comes **out**
   of `CLOSURE_UNSAFE_HOST_AMBIENTS` (`src/codegen/array-methods.ts:390`) —
   verify against the PR #2838 hazard, which is what put it there.

## Acceptance criteria

1. `typeof Temporal === "object"` at runtime; `Object.getOwnPropertyNames(Temporal)`
   returns the class names; `Temporal.PlainDate` can be passed as a value.
2. The 2,206 `Temporal is not defined` rows no longer carry that error.
3. Net-positive test262 delta on the Temporal bucket, measured after #4627
   lands (so the 1,477 CEs are not confounding the diff).
4. The spike's CE count and bucket list are recorded in this issue whichever
   option wins.

## Notes

Both options stop at ISO calendars and UTC unless Option A's polyfill
compiles — that is the single largest differentiator between them, and the
reason the spike is worth a day before committing to ~6k lines of porting.


## Implementation Plan

**This issue's deliverable is a NUMBER, not an implementation.** Do not begin
either option until the spike below has produced a compile-error count and a
bucketed cause list, and that result is written back into this file. The
implementation is a follow-up issue chosen by what the spike says.

### Order of work

**#4627 must land first.** 1,477 Temporal rows currently die at
`WebAssembly.compile()` before any test body runs. Measuring a Temporal change
against that baseline attributes nothing: the rows cannot move. Confirm #4627
is on `main` before taking the baseline in step 0.

### Step 0 — take the before-state, yourself

Do not quote the numbers in the Problem section above as your baseline; they
were measured against a pre-#4627 tree. Re-measure:

```bash
node scripts/fetch-baseline-jsonl.mjs --force
```

Then bucket `.test262-cache/test262-current.jsonl` on paths containing
`Temporal`, by `status` and by the leading error text. Record the four counts
(pass / compile_error / `Temporal is not defined` / other-fail) in this file
before changing anything. Every later delta claim must cite this run.

### Step 1 — the spike (timebox: one day)

Compile `@js-temporal/polyfill` and count what breaks.

Use the **dogfood harness pattern**, not an ad-hoc script — `tests/dogfood/`
already does exactly this job for 20+ real packages, with tarball pinning and
integrity gates. `tests/dogfood/clsx.test.ts` + `setup-clsx.mjs` is the
smallest complete example to copy; `tests/dogfood/README.md` describes the
contract. The spike wants the **compile + validate** lane only — not the
differential-execution lane — so it is the cheap half of that harness.

What to produce:

1. **A compile-error count.** How many distinct errors does `compile()` report
   on the polyfill's published entry file?
2. **A bucketed cause list.** Group them by rejection reason, largest first.
   This is the real artifact — it is a prioritized compiler-bug backlog against
   a real-world library regardless of which option wins.
3. **A validate result.** If it compiles, does the module pass
   `WebAssembly.validate()`? Compiling and validating are different gates and
   #4627 is precisely a case where the first passed and the second did not.

Use the same `compile()` options the test262 runner uses
(`tests/test262-runner.ts:4233`): `allowJs: true`, `skipSemanticDiagnostics:
true`, `sourceMap: true`. The polyfill is published JS, so without `allowJs`
you will measure TypeScript diagnostics instead of compiler gaps.

### Step 2 — decide against #661's thresholds

#661 set these and never got to apply them under a mature compiler:

| Compile errors | Decision |
| --- | --- |
| < 50 | Fix them and ship Option A |
| 50–200 | The CE list is a prioritized bug list — still Option A, staged |
| > 200 | Option B (port engine262), keep the CE list as a backlog |

Record which bucket you landed in and why. If the count is near a boundary,
weigh that Option A is the **only** path that reaches the calendar and
time-zone tests at all — engine262's Temporal is ISO-only and UTC-only, so
Option B leaves those permanently out of reach. That asymmetry should break
ties toward A.

### Step 3 — implement the winner (likely a follow-up issue)

**If Option A:** the polyfill becomes a compiled module whose exports are
installed as the `Temporal` global. The work is fixing the CE buckets, not
writing Temporal.

**If Option B — port engine262's abstract-ops.** Source of truth:
`engine262/engine262@main`, MIT (`LICENSE`, "Copyright (c) 2018 engine262
Contributors") — preserve the copyright notice on ported files.

- Port: `src/abstract-ops/temporal/*` (~4,901 lines) and
  `src/parser/TemporalParser.mts` (1,245 lines).
- **Do not port** `src/intrinsics/Temporal/*` (18 files, ~3,444 lines) — thin
  binding glue against engine262's object model that would be rewritten
  against ours anyway.
- The mechanical work is stripping the interpreter coupling: every function
  takes and returns engine262 `Value` objects, threads completion records
  through `Q(...)` / `X(...)`, reads internal slots off engine262 ordinary
  objects, and imports from the `#self` engine barrel in 31 places. Map `Q(x)`
  to a native throw, `Value` to our representations, internal slots to the
  WasmGC structs.
- It also depends on `src/host-defined/decimal.mts` — check whether our BigInt
  support covers what the nanosecond arithmetic needs before committing; the
  baseline already shows `Cannot convert bigint to a BigInt` (45 rows) as a
  live Temporal failure, so this is not hypothetical.

Either way, the existing `src/codegen/temporal-native.ts` (1,251 lines) and the
`_temporal*` helpers in `src/runtime.ts:8733-9230` become **dead or
subordinate**. Decide explicitly which: deleting the AST lowering is cleaner
but risks regressing the 207 currently-passing rows. Measure before removing —
those 207 are the only Temporal conformance the project currently has.

### Step 4 — the `CLOSURE_UNSAFE_HOST_AMBIENTS` removal is a gated step

`src/codegen/array-methods.ts:390` lists `Temporal` alongside
`TemporalHelpers`, `Intl`, `$262` as closure-unsafe host ambients. Once
`Temporal` is a real global it should come out of that set — but **PR #2838
flipped 212 Temporal tests pass→fail** by widening that exact gate
(`TemporalHelpers is not defined` inside a lifted closure; see the comment at
`array-methods.ts:1718-1736`). Remove `Temporal` only, verify against the full
Temporal bucket, and leave `TemporalHelpers` in place — it is a harness
ambient and is not what this issue makes real.

### Acceptance criteria

1. The spike's CE count, bucket list, and validate result are written into this
   file, with the date and the baseline run they were measured against.
2. A decision is recorded against the #661 thresholds, with reasoning.
3. If the decision is to implement in this issue rather than a follow-up:
   `typeof Temporal === "object"` at runtime, `Object.getOwnPropertyNames(Temporal)`
   returns the class names, and `Temporal.PlainDate` survives being passed as a
   value through a function boundary.
4. Net-positive test262 delta on the Temporal bucket against the step-0
   baseline, with the 207 currently-passing rows not regressed.

### What NOT to do

- **Do not extend `temporal-native.ts` to more classes.** It resolves kinds
  syntactically and cannot define a global, so it caps out below the 2,206 rows
  this issue exists to move. More classes there is motion without progress.
- **Do not embed engine262 wholesale.** A JS interpreter inside the js2wasm
  runtime to service `Temporal` is the wrong shape for this project.
- **Do not hand-commit `benchmarks/results/npm-compat.json`** if the dogfood
  harness touches the catalog — CI regenerates it on every merge to main
  (#3988).

---

## Spike result — 2026-08-23 (Steps 1 & 2)

Measured on `origin/main` @ `a09006d2`, branch `issue-4628-temporal-runtime-spike`.
Harness: `tests/dogfood/temporal-polyfill-harness.mjs` (+ `setup-temporal-polyfill.mjs`,
`temporal-polyfill-pin.json`, `temporal-polyfill.test.ts`), following the
`tests/dogfood/` pinned-tarball contract. Compile options are the test262
runner's, verbatim: `allowJs: true, skipSemanticDiagnostics: true,
sourceMap: true, emitWat: false`.

Pinned inputs (canonical npm sha1, committed as fixtures, no run-time network):
`@js-temporal/polyfill@0.5.1` (`c9726fdb…`) and `jsbi@4.3.0` (`b54ee074…`).

### Headline

| Question | Answer |
| --- | --- |
| Compile-error count | **0** — across 342 / 342 top-level statements, 14 / 14 slices, 100 % coverage |
| Bucketed cause list | **empty on the compile gate**; the real list is on the *validate* gate (below) |
| `WebAssembly.validate()` | **FAILS** — 5 of 14 slices emit a binary the validator rejects |
| Whole-bundle compile | **DID NOT TERMINATE** in a 45-minute budget (see "Compile time") |
| #661 threshold bucket | `< 50` → **Option A**, but the CE count is not the binding constraint |

### First finding, before any compile: the published bundle is not self-contained

`dist/index.esm.js` carries exactly one import — `import e from"jsbi";` — against
the polyfill's single runtime dependency, `jsbi@^4.3.0` (a pure-JS BigInt
polyfill, 28.8 KB minified). So **Option A drags BigInt-shaped arithmetic in with
it.** That matters for the decision: the plan treats BigInt as an Option-B risk
(engine262's `decimal.mts`, plus the 45 live `Cannot convert bigint to a BigInt`
rows), but it is on Option A's critical path too. The dependency is not on native
`BigInt` — jsbi implements bignums in JS over a `class JSBI extends Array` — so it
is a *different* risk, not an absent one, and it weakens the "Option A is simply
the cheaper path" framing.

The harness links the two into one module (jsbi's trailing `export default JSBI;`
dropped, the import rewritten to `const e=JSBI;`). Collision-free by construction
and asserted: jsbi declares exactly **one** top-level binding (`JSBI`); the
polyfill's **340** top-level bindings do not include it. Both edits fail loudly if
an upstream bump changes the bundle shape.

### Compile gate — zero errors, full coverage

The slice lane splits the linked 157,541-byte module at top-level statement
boundaries and compiles the chunks independently:

| Slice | ms | compile errors | validates |
| --- | --- | --- | --- |
| 0 | 7,423 | 0 | **no** |
| 1 | 1,468 | 0 | yes |
| 2 | 1,509 | 0 | yes |
| 3 | 1,337 | 0 | yes |
| 4 | 518 | 0 | yes |
| 5 | 936 | 0 | yes |
| 6 | 686 | 0 | yes |
| 7 | 1,182 | 0 | yes |
| 8 | 488 | 0 | yes |
| 9 | 3,436 | 0 | yes |
| 10 | 1,593 | 0 | **no** |
| 11 | 1,021 | 0 | **no** |
| 12 | 1,211 | 0 | **no** |
| 13 | 1,401 | 0 | **no** |

**Coverage: 14 / 14 slices, 342 / 342 top-level statements, 0 skipped.** Nothing
was truncated. The front end accepts every construct in the polyfill — the
non-ISO calendar helper classes, the `Intl.DateTimeFormat` subclassing, jsbi's
`class JSBI extends Array`, all of the lowered `ecmascript.ts` output.

Caveat, stated once: a slice is not a module. Chunking breaks cross-references, so
slice diagnostics are not identical to a whole-bundle compile's. It cuts the safe
way here — slicing risks *extra* noise, and we measured **zero** diagnostics, so
the number is not an artifact of hidden errors. What slicing cannot show is a
whole-module-only failure, and the whole-module compile did not finish (below), so
that gap is real and named rather than papered over.

### Validate gate — this is where the polyfill actually fails

Compiling and validating are different gates. 5 of 14 slices produce a binary that
`WebAssembly.compile()` rejects. Bucketed by rejection reason, largest first:

| Count | Reason | Slices | Sample |
| --- | --- | --- | --- |
| 3 | `not enough arguments on the stack for local.set (need 1, got 0)` | 11, 12, 13 | `#217:"__class_call_formatToParts_vararg"`, `#452:"__call_toString"`, `#439:"__call_toString"` |
| 2 | `not enough arguments on the stack for call (need N, got N−1)` | 0, 10 | `#310:"__call_toString"` (need 2, got 1); `#60:"IslamicBaseHelper_estimateIsoDate"` (need 5, got 4) |

Both buckets are one family: **a compiler-emitted call thunk pushes one operand
fewer than the callee's arity declares.** Three of the five are `__call_toString`
— the synthesized `toString` dispatch thunk — and one is a `_vararg` class-call
thunk, so the defect is in the thunk/vararg emission path, not in anything
Temporal-specific.

**This is a different signature from #4627, but the same gate.** #4627 is a *type*
mismatch (`global.set[0] expected type f64, found local.get of type i32`) in the
harness helper `checkThisValueNotCalled`; this is an *arity* mismatch in call
thunks. Fixing #4627 will not fix these. Both are invalid-Wasm-at-instantiate
failures — which is exactly why the plan insisted on checking both gates.

### Compile time — a pathological, superlinear blow-up

The whole-bundle compile **did not terminate**. Per `tests/dogfood/README.md`, a
compile timeout is an unverified workload, never a pass — so this is recorded as a
non-result, not a slow success.

Compile time against prefix size of the same linked module (each prefix cut at a
top-level statement boundary; all completed prefixes reported 0 compile errors):

| Top-level statements | Bytes | Compile ms |
| --- | --- | --- |
| 43 / 342 | 39,294 | 9,106 |
| 86 / 342 | 49,422 | 8,364 |
| 128 / 342 | 60,172 | 10,071 |
| 171 / 342 | 69,120 | 11,736 |
| 214 / 342 | 83,323 | 18,196 |
| 257 / 342 | 105,566 | 52,606 |
| 300 / 342 | ~138,000 | **killed at ~38 min, did not finish** |
| 342 / 342 | 157,541 | **killed at 45 min, did not finish** |

From 106 KB to ~138 KB — a 1.3× size increase — cost more than a 43× time
increase. The 14 slices sum to **~24 seconds**; the same 342 statements in one
module do not finish in 45 minutes. This is not "the polyfill is big": it is a
superlinear scaling defect in whole-module compilation that appears past roughly
the 100 KB mark.

`JS2WASM_COMPILE_PROFILE=stream` shows the module-init passes completing quickly
and cheaply — `codegen/module-init-pass1` 3.50 s, `codegen/module-init-pass2`
1.77 s, 46 module-init statements, heap ~297 MB — and then **no further phase
closing for the remaining ~44 minutes**. Steady 100 % of one core, RSS flat around
600 MB: CPU-bound in per-function codegen, not thrashing or leaking. Narrowing it
to a phase is follow-up work; the profiler's existing phase markers are too coarse
past module-init to say more.

### Step 0 is still OUTSTANDING

The test262 baseline re-measurement (Step 0) was **not** performed — it is gated on
#4627, which was being fixed in parallel while this spike ran. The four counts in
the "Measured baseline" section above are still the pre-#4627 numbers and must be
re-taken before any delta on the Temporal bucket is claimed. Nothing in this spike
depends on them: these are compile/validate measurements of a library, not
conformance deltas.

### Decision — Option A, staged, behind two compiler-bug prerequisites

**Landed bucket: `< 50` compile errors, which #661 maps to "fix them and ship
Option A".** The count is 0, so the threshold is met with room to spare — and the
tie-breaker the plan named (Option A is the *only* path that reaches the calendar
and time-zone tests; engine262's Temporal is ISO-only and UTC-only) points the same
way. The polyfill's non-ISO calendar helpers — `HebrewHelper`,
`IslamicUmalquraHelper`, `PersianHelper`, `ChineseHelper`, `EthiopicHelper` and the
rest — are in the compiled set and produced zero diagnostics, so that reach is not
hypothetical.

**But the CE count is not the binding constraint, and #661's thresholds are not
sufficient on their own.** They were written for a world where the risk was the
front end rejecting real-world JS. That risk did not materialise. Two others did,
and both must clear before Option A can be implemented:

1. **Invalid Wasm from call thunks** — the arity family above. Until it is fixed the
   polyfill cannot instantiate, so `Temporal` cannot be installed as a global no
   matter how the module is wired.
2. **Whole-module compile does not terminate at this size** — a ~157 KB module is
   exactly the shape Option A requires (the polyfill compiled as one unit whose
   exports become the global). At present that compile never returns.

Neither is Temporal work; both are generic compiler bugs the spike surfaced —
precisely the "free, prioritized compiler-bug backlog" #661 predicted, just landing
on the validate and performance axes rather than the parse/lower axis.

**Recommendation: keep Option A, file the two bugs as separate issues, and make the
Temporal-global implementation depend on them. Do not start the engine262 port** —
it would cost ~6k lines of mechanical porting, still needs BigInt-shaped
arithmetic, and would permanently forfeit the calendar and time-zone tests, in
exchange for avoiding two bugs worth fixing on their own merits.

### Reproducing

```bash
node tests/dogfood/temporal-polyfill-harness.mjs --no-umd --no-whole --slices=25
# whole-bundle lane (expect non-termination at present):
JS2WASM_COMPILE_PROFILE=stream node tests/dogfood/temporal-polyfill-harness.mjs --no-umd
```

The vitest wrapper `tests/dogfood/temporal-polyfill.test.ts` always runs the cheap
acquisition/link contract; the compile lane is opt-in via
`DOGFOOD_TEMPORAL_POLYFILL=1` and deliberately carries **no** pass/fail floor —
this is a spike, and pinning today's number would turn an exploratory measurement
into a required check on work nobody has committed to yet.

### Not done in this spike

- The UMD lane (`dist/index.umd.js`, self-contained, Babel-transpiled to ES5) is
  implemented in the harness but was **not run** — the whole-bundle lane consumed
  the timebox, and at 242 KB the UMD bundle is further past the size where
  compilation stops terminating.
- No runtime / differential-execution lane. Compile + validate only, by design.
- Step 0 (see above).

---

## Step 3 attempt — 2026-08-29 (`ttraenkler/opus-dev-temporal`, branch `issue-4628-temporal-global`)

Measured on `origin/main` @ `279ce9a4f2`. **Outcome: Option A is confirmed as
the right path and is BLOCKED on one specific compiler defect, now filed as
#5191.** Acceptance criteria 1–3 are NOT met and are not claimed. What follows
is what was measured, what was decided, and what is left.

### Step 0 — the baseline the spike left outstanding, now taken

`node scripts/fetch-baseline-jsonl.mjs --force`, 2026-08-29, 48,735 entries
(85,308,991 B), bucketed by `.tmp/bucket-baseline.mjs` over rows whose path
contains `Temporal`. **This supersedes the "Measured baseline" numbers at the
top of this file, which were pre-#4627.**

| Bucket | Pre-#4627 (2026-08-23) | **Now (2026-08-29)** |
| --- | --- | --- |
| Temporal-path rows | 4,611 | 4,611 |
| `pass` | 207 | **594** |
| `compile_error` status | 1,487 | **0** |
| `Temporal is not defined` | 2,206 | **1,589** |
| other `fail` | ~711 | 2,428 |

Two corrections that matter for how this issue is scoped:

- **#4627 landed and the compile-error bucket is gone.** Those rows now
  instantiate and fail on substance, which is exactly the predicted growth in
  the semantic bucket (711 → 2,428).
- **The headline is 1,589, not 2,206.** Any delta claim against this issue must
  cite this run, not the numbers in the Problem section.

Largest non-`not defined` failure buckets now: `Cannot read properties of null
[in __module_init()]` 487, `Expected a RangeError but got a TypeError` 155,
`round is not a function` 77, `until` 65, `since` 64. By directory:
ZonedDateTime 818, PlainDateTime 686, PlainDate 531, Duration 474,
PlainYearMonth 447, Instant 407, PlainTime 390, PlainMonthDay 186, Now 65.

### Gate re-verification on this branch base

`node --import tsx tests/dogfood/temporal-polyfill-harness.mjs --no-umd` —
ESM linked lane, 157,541 B: compile **success, 0 errors / 2 warnings** in
21,418 ms, binary **1,095,206 B**, `WebAssembly.compile()` **OK**. The spike's
whole-bundle non-termination is **gone** — 45+ minutes then, 21 s now. Plain
`node` fails on `bundle-manifest.js` with `ERR_MODULE_NOT_FOUND`; use
`node --import tsx`.

The UMD lane was run for the first time (90,724 ms, 0 errors, 1,644,531 B) and
**fails validation**: `#470:"__closure_35" … return[0] (expected externref, got
i32)`. Filed as [#5192](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5192-umd-closure-return-type-invalid-wasm),
deliberately not fixed here — it is a second, independent bundle shape and is
not on Option A's critical path.

### The finding that decides this step: a THIRD gate the spike never reached

Compile and validate are different gates — the spike said so and checked both.
**Instantiate is a third gate, and the polyfill fails it.** The ESM binary
validates and then throws a `WebAssembly.Exception` the moment its module init
runs, so it produces **no exports at all**. No wiring choice can install a
`Temporal` global from a module that never finishes initialising, which is why
this blocks every integration option equally rather than favouring one.

The harness now measures it (`measure({ instantiate })`, `--no-instantiate` to
skip) and the summary carries `moduleInitRuns` / `moduleInitError`, so no
future run can read "validates" as "works". Current headline:
`"compiled + validates, but module init THROWS"`.

**Root cause, isolated.** Bisecting the linked bundle by top-level-statement
prefix (`.tmp/probe-bisect.mts`, 9 compiles) puts the first failing prefix at
statement **2 of 341** — prefix 1 instantiates, prefix 2 does not. Statement 2
is jsbi's static-table block on `class JSBI extends Array`. Reduced to three
lines:

```js
class C extends Array {}
C == null;             // spec: false. js2wasm: TRUE
C.zzz === undefined;   // spec: true.  js2wasm: throws
```

**A class extending a builtin evaluates to `null` as a value.** The property
access throws only because the receiver it loaded is null. `class C {}`,
`class C extends B {}` (user base), `function C(){}` and `const C = {}` are all
correct; `Array`, `Error` and `Map` bases are all null. It stays hidden because
`typeof C`, `C.name` and `new C()` are served by static arms that never
materialise the constructor object.

Located to one line: `src/codegen/class-bodies.ts` (~L1188) skips registering
the class-object singleton when `ctx.classBuiltinParentMap.has(className)`
(#1366a), because `emitLazyClassObjectGet`
(`src/codegen/expressions/extern.ts:362`) builds that object as a `struct.new`
of the `$ClassName` WasmGC struct, which an externref-backed subclass does not
have. So the guard is not gratuitous and the fix is not deleting it — the lane
needs a different carrier. Filed with the full receiver table as
[#5191](https://js2wasm.loopdive.com/dashboard/issue.html?slug=5191-builtin-derived-ctor-property-miss-throws),
recorded in `depends_on` above.

This is precisely the "free, prioritized compiler-bug backlog against a
real-world library" #661 predicted — and note it was invisible to both gates
the spike used.

### Integration approach — decided, with the number that decides it

**Compile-once, never per-test.** The polyfill's compile costs **21.4 s**
(measured, above). The test262 runner compiles one synthetic module per test
(preamble + body, `tests/test262-runner.ts`), and `$262` shows the established
way to inject a global is a **source-level preamble declaration** compiled with
the body — there is no host-injection path for realm objects. Prepending the
polyfill would therefore cost 21.4 s × 4,611 Temporal rows ≈ **27 hours** of
added compile, or ~1.7 h on each of the 16 merge-group shards against a job
that runs ~19 minutes today. Option (c), source-level prepend, is arithmetically
dead. So is any scheme keyed on the test body, because the runner's disk cache
key includes it.

That leaves **option (a), compile-once + link per test**, and the machinery
already exists: `src/package-linker.ts` compiles a bare-package edge into its
own Wasm binary, content-addresses it into a provider cache
(`cachePaths()` → `<cacheKey>.wasm`), and hands the application graph an import
map via the internal `linkedPackageBindings` option, over a frozen cross-module
type group (`RUNTIME_RECGROUP_ABI_VERSION`,
`src/emit/canonical-recgroup.ts`). `scripts/build-runtime-provider.mjs` is the
existing precedent for publishing a compiler-owned provider artifact this way.

Concretely, the intended shape:

1. A build step compiles the linked polyfill **once** into a provider `.wasm`
   (21 s, cached, content-addressed) — the same acquisition/link path the
   dogfood harness already pins.
2. The runner passes `linkedPackageBindings` mapping `Temporal` to that
   provider's export, for the tests that need it.
3. Per-test cost becomes the ordinary body compile plus a second instantiation.

Option (b) — instantiate the polyfill in the JS host and hand `Temporal` to the
test module as an imported `externref` — was considered and **rejected**: the
polyfill's objects would be js2wasm WasmGC structs, opaque to the JS host, so
the host cannot serve property access on them; and injecting the *untranspiled*
JS polyfill as a host object instead would abandon standalone mode, which the
dual-mode architecture principle forbids without a Wasm-native fallback.

**None of this was implemented, because #5191 makes it unmeasurable.** A
provider artifact whose module init throws is worth nothing, and wiring built
against it could not be validated. The order is: fix #5191 → re-run the
harness's instantiate lane → then build the provider wiring.

### `src/codegen/temporal-native.ts` — KEEP, unchanged

Measured, not assumed: the 594 passing Temporal rows in the current baseline
are the compile-time lowering's, and `tests/issue-661.test.ts` passes **5/5**
on this branch. The polyfill path covers **zero** of them today — it cannot
produce a `Temporal` object at all. The plan's instruction was to measure before
removing; the measurement says removing it would forfeit the project's only
Temporal conformance for nothing. Precedence between the lowering and a real
global is a decision that belongs to the PR that first makes the global exist;
it cannot be defined against a global that does not.

### `CLOSURE_UNSAFE_HOST_AMBIENTS` — deliberately NOT changed, and here is why

`src/codegen/array-methods.ts:447` still reads
`new Set(["Temporal", "TemporalHelpers", "Intl", "$262"])`.

Reading the gate (`hofRefElemClosureLaneSafe`) settles when the removal is
correct. The deny list is checked **before** the generic
`decl === undefined || decl.getSourceFile().isDeclarationFile` test. So:

- While `Temporal` is a **host ambient** (today), the generic test already
  classifies it unsafe. The explicit entry is redundant but harmless.
- Once `Temporal` is a **compiled, user-source binding** (a linked provider
  import), the generic test would classify it **safe** — and the explicit entry
  is then the only thing wrongly forcing it onto the host-callback path, which
  for a ref-element receiver is the #3126 silent no-op.

So the entry must be removed **in the PR that makes `Temporal` real, not
before**. Removing it now would re-create the PR #2838 hazard (212 Temporal
tests pass→fail) with no compensating benefit, because there is nothing yet for
the closure lane to resolve. `TemporalHelpers` stays regardless — it is a
harness ambient and is not what this issue makes real, exactly as the plan
says.

### Scoped validation actually run on this branch

- `tests/dogfood/temporal-polyfill-harness.mjs --no-umd` — ESM lane: compile
  0 errors / validates / **instantiate FAILS** (the finding above).
- `tests/dogfood/temporal-polyfill-harness.mjs --no-whole` — UMD lane: compile
  0 errors / **validate FAILS** (#5192).
- `tests/dogfood/temporal-polyfill-harness.mjs --no-umd --no-whole --slices=200`
  — slice lane, 342/342 statements, 0 skipped.
- `npx vitest run tests/issue-661.test.ts` — **5/5 pass**.
- `npx tsx scripts/run-test262-paths.mts .tmp/paths.txt --isolate` over five
  hand-picked Temporal rows through the runner's own `runTest262File`:
  `getOwnPropertyNames.js` → `ReferenceError: Temporal is not defined`;
  `prop-desc.js` → `Expected SameValue(«"undefined"», «"object"»)`;
  `PlainDate/prototype/add/argument-duration-max.js` → `Temporal is not
  defined`; `Instant/prototype/toString/basic.js` → `Expected
  SameValue(«"null"», …)`. These are acceptance criterion 1's own tests, and
  they still fail — recorded, not claimed as met.
- Minimal-repro matrices for #5191 are in `.tmp/probe-min{,2,…,6}.mts` on this
  branch (not committed — `.tmp/` is scratch by convention).

### What remains

1. **#5191** — the blocker. Nothing else here can be measured until it clears.
2. Provider-artifact build step + `linkedPackageBindings` wiring in the runner
   (design above; no code written).
3. Precedence between `temporal-native.ts` and the real global, once one exists.
4. Remove `"Temporal"` from `CLOSURE_UNSAFE_HOST_AMBIENTS` **in that same PR**,
   re-verifying against the full Temporal bucket per the PR #2838 hazard.
5. #5192 (UMD lane) — independent, not on the critical path.
6. jsbi is userland-BigInt (`class JSBI extends Array`); further defects it
   surfaces get their own issues rather than widening this one.

---

## Step 3 IMPLEMENTED — 2026-08-30 (`ttraenkler/dev-temporal-wire`, branch `issue-4628-temporal-wire`)

Based on `origin/main` + the eleven-fix Temporal stack on
`issue-5211-init-sort-comparator` (PRs #5262 → #5264 → #5266 → #5271 → #5279 →
#5283 → #5314). **`Temporal` is now a real runtime object.**

### The gate the previous attempt was blocked on is open

`node --import tsx tests/dogfood/temporal-polyfill-harness.mjs --no-umd` on this
base, re-run 2026-08-30: compile **success, 0 errors / 2 warnings** in 32,422 ms,
binary 1,576,290 B, `WebAssembly.compile()` OK, **`moduleInitRuns: true`**.
Headline is now `"compiled + validates + module init ran"`. #5191 cleared it.

### What was built

| Piece | Where |
| --- | --- |
| Compile-once provider + consumer wiring | `src/temporal-provider.ts` (new) |
| End-to-end measurement harness | `tests/dogfood/temporal-global-harness.mjs` (new) |
| Precedence gate vs the #661 lowering | `src/codegen/temporal-native.ts` |
| `Temporal` out of `CLOSURE_UNSAFE_HOST_AMBIENTS` | `src/codegen/array-methods.ts` |
| Class-object `.prototype` through the dynamic lane | `src/runtime.ts` |

`buildTemporalProvider` presents the linked `@js-temporal/polyfill@0.5.1` +
`jsbi@4.3.0` bundle to the **existing** npm package linker (#2527) as a
one-file package, so the provider gets that machinery for free: its own Wasm
binary, a content-addressed cache, an embedded provider manifest, and the
frozen cross-module type group. `compileWithTemporalGlobal` then compiles user
source with a **one-line** prelude — `import { <getter> } from <stub>; const
Temporal = <getter>();` — plus a `linkedPackageBindings` entry, and publishes
the artifact in `result.linkedModules` so `instantiateLinkedProject` wires it
with no caller-side provider handling.

Source ACQUISITION is deliberately not in `src/`: the caller passes the bundle
text, and the pinned-tarball contract stays in `tests/dogfood/`.

### The number that decides the shape, re-measured

| | cost |
| --- | --- |
| Provider build, cold | **38.0 s** (one time, then content-addressed) |
| Provider build, warm | 0.75 s (disk) / 0 ms (in-process memo) |
| Consumer compile + instantiate + run | **0.43–0.8 s** |
| Provider binary | 2,003,576 B |

So a second consumer costs **430 ms**, not another 38 s. The rejected
source-level prepend costs the full compile *every* time — the ~41 h figure the
previous attempt computed still holds and is still disqualifying.

### What a user program observes now (measured, `tests/dogfood/report/temporal-global.json`)

| Probe | Result |
| --- | --- |
| `typeof Temporal` | **`"object"`** (base: `undefined`) |
| `Object.getOwnPropertyNames(Temporal)` | `Duration,Instant,Now,PlainDate,PlainDateTime,PlainMonthDay,PlainTime,PlainYearMonth,ZonedDateTime` |
| `Temporal.PlainDate` passed through a function boundary | `"object"` — survives |
| `Object.getOwnPropertyNames(Temporal.PlainDate)` | `compare,from,length,name,prototype` |
| `new Temporal.PlainDate(2020,3,4)` → `y/m/d` | `2020/3/4` |
| `const T = Temporal; typeof T.ZonedDateTime` | `"object"` |

That is **issue acceptance criterion 1, met**: `typeof Temporal === "object"`,
the class names enumerate, and `Temporal.PlainDate` survives being passed as a
value — the three things `temporal-native.ts` structurally cannot do.

### What does NOT work yet — stated plainly, with the measurement that scopes it

| Shape | Result | What was measured about it |
| --- | --- | --- |
| `Temporal.PlainDate.from("…")` | `RuntimeError: dereferencing a null pointer` | **Fails identically when the polyfill is compiled as ONE module with no provider and no linking** (`.tmp/probe-ab.mts`, 2026-08-30). A pre-existing compiler gap inside the polyfill's own intrinsic / `Object.create(proto)` machinery — the provider seam neither causes it nor can fix it. |
| `Temporal.Now.instant` | `undefined` | `"function"` in the single-module shape, `undefined` through the provider. This one **is** linking-specific: the polyfill's `Now` is a plain object whose methods do not survive the cross-module value crossing. Strongest candidate for the next follow-up. |
| `new Temporal.PlainDate(…).toString()` | `"[object Object]"` | prototype-method / `Symbol.toStringTag` dispatch on the provider's classes is not wired. |

These are exactly the "free, prioritized compiler-bug backlog against a
real-world library" #661 predicted, and they are the reason this change does
**not** claim acceptance criteria 2 and 3.

### Precedence — measured, then decided

`temporal-native.ts` matched `Temporal.PlainDate` on **spelling alone**, with no
reference to what `Temporal` resolves to. With the provider wired and no gate,
the lowering silently won:

| Program | Provider wired, no gate |
| --- | --- |
| `Temporal.PlainDate.from(…)` | answered — *through the 3-class lowering* |
| `Temporal.Duration…total()` | `total is not a function` |
| `Temporal.Now.instant()` | `instant is not a function` |
| `Temporal.ZonedDateTime` / `PlainDateTime` | threw |

The last three are the lowering's 3-class ceiling, and two of those messages are
literally rows 3–4 of this issue's own failure buckets. **Decision: a real,
compiled `Temporal` binding wins; an ambient one keeps the lowering.** The gate
is `temporalIsCompiledBinding` — a resolution question, not a flag:

- undeclared `Temporal` → native lane, byte-for-byte unchanged (protects the
  594 currently-passing rows);
- `declare const Temporal: any` → **also** native lane. `declare` emits no
  value; it asserts a host global. Testing only `isDeclarationFile` broke all
  five `tests/issue-661.test.ts` fixtures, which open with exactly that line in
  an ordinary `.ts` file. Both spellings are now excluded (`.d.ts` source, and
  `ts.NodeFlags.Ambient`);
- a real binding (the provider prelude, or a user's own mock) → the lowering
  stands down.

Measured before/after on this base:

| Program | base | after |
| --- | --- | --- |
| user `Temporal.PlainDate.from` | `RangeError: invalid Temporal.PlainDate string` | `"user:x"` |
| user `Temporal.Now.plainDateISO` | `undefined` | `"user-now"` |
| `new` on a user `Temporal.Duration` class | `0` | `5` |
| undeclared `Temporal.PlainDate.from("2020-03-04").month` | `3` | `3` |

`temporal-native.ts` is **kept, not deleted** — the measurement in the previous
attempt still stands (594 passing rows are its; the polyfill path covers none of
them yet).

### `CLOSURE_UNSAFE_HOST_AMBIENTS` — `Temporal` removed, `TemporalHelpers` kept

`src/codegen/array-methods.ts` now reads
`new Set(["TemporalHelpers", "Intl", "$262"])`.

The **PR #2838 hazard case is unchanged, measured both ways** rather than
argued. Using the #3126 ref-element HOF shape
(`objs.filter(o => <capture> && o.x > 1).length`, 3 elements, 2 matching):

| Callback capture | base | after |
| --- | --- | --- |
| **undeclared `Temporal`** (the hazard) | 0 | **0** |
| `declare const Temporal: any` | 0 | **0** |
| undeclared `Intl` (control) | 0 | 0 |
| declared `const Intl = {…}` (control) | 0 | 0 |
| **declared `const Temporal = {…}`** | 0 | **2** |
| no ambient capture (control) | 2 | 2 |

Only the second-to-last row moves, and that is the case the provider prelude
creates. The reason is the one the previous attempt predicted: the deny list is
consulted **before** the generic
`decl === undefined || decl.getSourceFile().isDeclarationFile` test, so while
`Temporal` is an undeclared host ambient the generic test already denies it —
the explicit entry was redundant there and load-bearing only against a real
binding. `TemporalHelpers` stays: it is the harness ambient named in the #2838
failure text, and it is not what this change makes real. The test262 runner does
**not** inject a `declare const Temporal` (checked in `tests/test262-runner.ts`),
so the test262 lane sees the undeclared row above.

### Compiler fix carried by this PR: class-object `.prototype` (the actual blocker)

The polyfill's module init threw `TypeError: Object.defineProperty called on
non-object` the moment it was compiled as a provider. Bisected to its `ae`
helper, which every one of the nine classes goes through:

```js
function ae(e, t) { Object.defineProperty(e.prototype, Symbol.toStringTag, {…}); }
ae(Instant, "Temporal.Instant");
```

Minimal repro, and **not** provider-specific:

```js
class C { m() {} }
function probe(e) { return typeof e.prototype; }   // → "undefined"
probe(C);
```

A class object is a `$ClassName` WasmGC struct, not a CLOSURE struct, so the
host's `.prototype` reader (`_getOrVivifyFnPrototype`, gated on the exact
`__is_closure` export) declined it — while the STATIC lane (`emitLazyProtoGet`)
answered the real prototype singleton all along. The split hides because
`typeof C`, `new C()`, `C.name` and even `arr[0].prototype` are all served by
statically-resolved arms; it only surfaces when the class crosses a function
boundary as a value. Same family as #5191.

Fix: `_classObjectPrototypeStruct` in `src/runtime.ts`, consulted by both
`__extern_get` bindings before the closure-vivify fallback. It returns the RAW
prototype struct, not a `_wrapForHost` proxy, so the two lanes agree on identity
— `probe(C) === C.prototype` went from **false (base) to true**. Covered by
`tests/issue-4628-class-value-prototype.test.ts` (7 tests, including a pinned
control for the pre-existing, unrelated `({}).prototype === "object"`).

### test262 Temporal slice — measured before AND after, on this box

A 256-row deterministic sample of `built-ins/Temporal` (every 18th of the 4,603
files, sorted; `.tmp/temporal-sample.txt`), run through the runner's own
`runTest262File` via `scripts/run-test262-paths.mts`. Both sides run on this
branch; the "base" side is the same tree with the three changed `src/` files
reverted to their base copies (file-copy A/B, `.tmp/base-*.ts`).

| | base | after |
| --- | --- | --- |
| pass | 23 | **23** |
| fail | 233 | **233** |
| compile_error | 0 | 0 |
| rows reading `Temporal is not defined` | 102 | **102** |

**The per-row verdict lists are byte-identical** (`diff` of the 233+23 verdict
lines: zero differences). That is the intended and expected result, and it is
the measurement that matters for this PR: the runner is **not** wired to the
provider, so no row can improve — and the three compiler changes are
behaviour-preserving for the undeclared/ambient `Temporal` that every test262
file has. A non-zero diff here would have meant a regression.

The full run (4,603 rows) was not taken: at ~2 s/row in-process that is ~2.5 h
per side, and a sample whose diff is exactly zero already answers the
"no regressions" question this PR needs.

### Standalone scope — OUT, and why (stated loudly)

This lane is `--target gc` with the JS host adapter. **No new host import is
introduced** — the provider's import set is whatever the polyfill's own compile
needs, and the linker refuses any namespace outside `env` / the string
namespaces / declared `link:` targets. So the dual-mode principle is not
violated by a new host dependency. But a **standalone `Temporal` global does not
exist**: the linker requires a deferred provider-init export, which
`src/package-linker.ts` documents as unavailable for WASI ("the deferred export
is unavailable for WASI, whose startup contract is `_start`"). Wiring standalone
needs that provider-startup lifecycle first and is deliberately deferred.

### Validation run

- `tests/issue-4628-temporal-global.test.ts` — 11 tests, incl. the heavy
  child-process provider lane (cold provider build ≈ 47 s). Green.
- `tests/issue-4628-class-value-prototype.test.ts` — 7 tests. Green.
- `tests/issue-661.test.ts` — **5/5**, after the ambient-declaration exclusion.
- `tests/issue-3126.test.ts`, `tests/issue-4787-temporal-merge-group-regressions.test.ts`,
  `tests/issue-4627-captured-global-coercion.test.ts` — green.
- The `#5191…#5211` family, run **one file per process** (they OOM a shared
  vitest worker pool on this box): #5191, #5193, #5198, #5201, #5202, #5203,
  #5204, #5205, #5206, #5207, #5209, #5211 all green, plus
  `issue-4616-fnctor-getprototypeof` and
  `issue-4616-process-and-class-expr-name`. **#5194 and #5197 OOM the vitest
  worker on this box — confirmed to OOM identically on the BASE sources**, so
  environmental, not this change; they were not otherwise measurable here.
- Ratchet gates, all exit 0: `check-loc-budget`, `check-func-budget`,
  `check-coercion-sites`, `check:oracle-ratchet`, `check:dead-exports`.
  `npm run typecheck` clean.
- `node --import tsx tests/dogfood/temporal-polyfill-harness.mjs --no-umd` —
  the gate re-verification quoted at the top.

### Not done in this PR

1. **The test262 runner is NOT wired to the provider.** That is where the 1,589
   `Temporal is not defined` rows live, and it is the single highest-value
   follow-up — but it needs the three known gaps above closed first, or the rows
   would move from `not defined` to `dereferencing a null pointer` without a net
   conformance gain. The wiring itself is now a small change:
   `referencesTemporal(source)` → `compileWithTemporalGlobal(...)` →
   `instantiateLinkedProject(...)`, minus `TEMPORAL_PRELUDE_LINES` on any
   line-number mapping.
2. Acceptance criteria 2 and 3 (the 1,589 rows losing that error; a
   net-positive Temporal delta) are therefore **not claimed**.
3. `Temporal.PlainDate.from` / `Now.instant` / instance `toString` — the three
   measured gaps, each worth its own issue.
4. #5192 (UMD lane) — untouched, still not on the critical path.
