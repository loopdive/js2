---
id: 3603
title: "verifyProperty is vacuous on BOTH lanes — two distinct root causes (standalone: object literals have no runtime own-property table; host: uncurried __push is a silent no-op)"
status: in-progress
sprint: current
created: 2026-07-25
updated: 2026-07-25
assignee: ttraenkler/opus-loop-a
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/runtime.ts::<anonymous>#76
regressions-allow:
  count: 1065
  reason: "#3603 S1 host verifyProperty de-inflation. Authoritative merge_group run 30179758665 measured 1023 stable non-timeout wasm-change regressions. Ceiling = 1023 measured + 17 observed ct_flake conversion bound + 25 ORACLE_REBASE_DRIFT_TOLERANCE; traps were flat. Gross fixes are reported separately below and are not netted into this ceiling."
priority: high
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen, runtime, test262-harness
goal: standalone-mode
related: [2984, 2896, 2860, 3592, 1472, 2177]
origin: "senior-dev root-cause investigation, TaskList task #11 (2026-07-25)"
---

# #3603 — `verifyProperty` is vacuous on BOTH lanes (two distinct root causes)

## STAKEHOLDER RULING

> **STAKEHOLDER RULING (2026-07-26, project lead, via tech lead):** APPROVED —
> land the host-lane de-inflation. Converting ~989 vacuously-passing host tests
> into honest failures is authorized, accepting that the published host
> conformance number decreases. Rationale: the assertion machinery could not
> report failures, so the passes were fictional; a smaller true number is
> preferred to a larger partly-fictional one. Same ruling as #3468 F1 for the
> standalone lane. Conditional on: (a) a broader fires-once sweep confirming the
> flips are honest, (b) every exposed failure cohort-routed to a tracker, (c) the
> allowance sized to the measured delta plus a documented margin, (d) gross-fixed
> and honest-regressions reported separately, never a net.

**The four conditions are binding — the ruling does not survive skipping them.**

| condition                                                  | status                                                                       |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| (a) broader fires-once sweep                               | **DONE** — see below                                                         |
| (b) every exposed failure cohort-routed                    | **DONE** — #3646, #3647 (table below); corpus completeness re-checked at (c) |
| (c) allowance = measured delta + documented margin         | **DONE** — 1,065 = 1,023 measured + 17 timeout bound + 25 drift              |
| (d) gross-fixed / honest-regressions separate, never a net | **DONE** — 23 stable improvements / 1,023 honest regressions                 |

### Authoritative merge-group measurement (conditions c/d)

The first full merge-group run is the landing measurement:
[run 30179758665](https://github.com/loopdive/js2/actions/runs/30179758665),
group SHA `07e140b398ec5191b11bc91361d6bf01d1ce5b7c`. It measured the
runtime fix at oracle v11; the later v12 commit changes only the result stamp
and activates rebase mode, so it does not change these per-test verdicts.

Report the two directions separately:

- **Honest regressions / de-inflations: 1,023** stable, non-timeout,
  wasm-changing pass→other transitions. Before the host-canary quarantine the
  raw count was 1,049; 26 known-noise paths were excluded.
- **Gross fixed: 23** stable other→pass improvements. Before quarantine the raw
  count was 28; 5 known-noise paths were excluded.

The stable fine-gate net was −1,000, but that subtraction is context only and
is deliberately not the allowance basis. The two dominant regression buckets
were the expected property-helper descriptor cohorts:
`test/language/statements/class/elements` (374) and
`test/language/expressions/class/elements` (356), routed through #3646/#3647.
The exact error distribution is likewise descriptor-check shaped (682 raw
non-timeout transitions alone reported
`obj['m'] descriptor should not be enumerable`). There was no uncatchable-trap
growth: `null_deref 159→159`, `illegal_cast 75→75`, `oob 60→60`,
`unreachable 3→3`.

The allowance is therefore the measured 1,023 plus two named bounds:

```
1,023 measured non-timeout wasm-change regressions
   17 observed ct_flake pass→compile_timeout conversions
   25 ORACLE_REBASE_DRIFT_TOLERANCE
──────
1,065 declared ceiling
```

### ORACLE_VERSION 11 → 12 — sanctioned, and load-bearing

> **TECH-LEAD SANCTION (2026-07-26):** bump `ORACLE_VERSION` 11 → 12 with a
> history entry, on the user's standing ruling to land this de-inflation. The
> bump is the **mechanism** by which an approved de-inflation lands, not a
> separate policy choice — exact #3468 F1 precedent (v9 → v10 +
> `regressions-allow 3675`). Refusing it would not preserve a stricter gate; it
> would make the approved landing **impossible, and silently so.**

Three independent reasons it is substantively correct:

1. this change **alters verdicts** (vacuous pass → honest fail) — the project
   rule is bump-or-the-queue-wedges;
2. #3468 F1 precedent, same recipe, same reason;
3. it is the **only** thing that makes `rebaseMode` true, and `diff-test262.ts`
   reads the #3303 `regressions-allow` ceiling lazily **inside**
   `if (rebaseMode)`.

**Reason 3 is why this was nearly a silent failure.** The chain:

```
well-formed regressions-allow declaration
  → nothing demands an ORACLE bump (see blind spot below)
  → rebaseMode false
  → allowance NEVER CONSULTED
  → park that looks EXACTLY like "ceiling too small"
```

We would have resized the ceiling, parked again, resized again, and never
touched the cause. Found only by going after the reader's own output line
(`=== regressions-allow (#3303): excused N of M declared … ===`) rather than
trusting a red/green outcome.

#### Gate blind spot (flagged, tracker queued — NOT folded into #3649)

`scripts/check-verdict-oracle-bump.mjs` watches exactly five files:
`scripts/negative-verdict.mjs`, `scripts/test262-worker.mjs`,
`tests/test262-shared.ts`, `tests/test262-vitest.test.ts`,
`tests/test262-runner.ts`. The `src/runtime/` tree is **not among them**, so a
runtime-layer change can flip verdicts corpus-wide without the gate demanding a
bump. Running it on this very PR prints the proof:

```
check-verdict-oracle-bump (#3003): diff vs origin/main; ORACLE_VERSION 11 → 12.
  ✓ no verdict-logic files changed.
```

This PR is the existence proof. It is a **different** gate from #3649's — #3649
is _"which contexts read an allowance"_, this is _"which file changes demand a
bump"_ — so it gets its own tracker rather than being folded in.

#### What the bump buys, and what it does not

- **Supersedes**, up to the declared ceiling: the rebase drift tolerance and the
  per-bucket concentration limit.
- **Does NOT supersede** the #3189 trap ratchet. Non-issue here: measured trap
  growth is **zero**. The v10 `^Test262Error` → `assertion_fail` rule already
  binds the newly-created assertion text ahead of the trap regexes — verified
  against the real classifier including adversarial messages that embed trap
  vocabulary _inside_ assertion text (`…value should be out of bounds`,
  `obj['illegal cast']…`), all binning `assertion_fail`, with genuine-trap
  controls still binning as traps. `illegal_cast` baseline independently
  re-derived at **75**.

#### Baseline provenance (per #3648)

| field                  | value                                      |
| ---------------------- | ------------------------------------------ |
| baselines-repo commit  | `5e377fb812f09607ab57ded00790e1a2c9368f7d` |
| committed              | 2026-07-25T22:46:54Z                       |
| jsonl entries / `pass` | 47,852 / **31,053**                        |
| `illegal_cast`         | **75**                                     |

Recorded as a **proxy** for what the gate reads, not the artifact itself — the
baseline can move between fetch and gate-read (#3648). **One measurement, no
confirmation re-run**: a re-run can legitimately return a different verdict with
nothing changed, so re-running to confirm a disliked result would be measuring
the baseline's motion, not the PR.

> **Units warning — do not repeat this subtraction.** `30,517 / 43,099` is the
> _scoped_ landing-page figure (`benchmarks/results/test262-current.json`,
> `include_proposals: 0`). `30,927` and `31,053` are _unscoped_ jsonl pass
> counts over ~47,850 entries. Subtracting across them yields a phantom −410;
> like-for-like the baseline moved **+126**.

### Fires-once sweep (condition a)

**Question:** does the S1 write-back ever touch an array other than
`propertyHelper.js`'s `failures`? Any such firing would be over-application and
would get narrowed.

**Method.** `JS2WASM_DEBUG_3603=1` logs every reconcile that actually mutates a
vec. 51 tests: **3 known-firing positive controls + 48 sampled** across
`Array/prototype`, `Object/defineProperty`, `Object/getOwnPropertyDescriptor`,
`RegExp/prototype`, `String/prototype`, and both
`language/{expressions,statements}/class/elements`.

**Result — 6 firings, all identical in shape:**

```
[3603FIRE] vecLen=0 mirrorLen=0->1 keep=0 ["obj['m'] descriptor should not be enumerable"]
```

|                                           |                               count |
| ----------------------------------------- | ----------------------------------: |
| firings from the 3 positive controls      |                               **3** |
| firings from the 48 sampled tests         | 3 (all `statements/class/elements`) |
| firings on a **non-`failures`** array     |                               **0** |
| firings with `vecLen != 0` or `keep != 0` |                               **0** |

Every firing is a fresh `var failures = []` growing 0 → 1 with a propertyHelper
failure message. **The over-application hypothesis (wrong vec / double replay /
stale registration) is refuted for this sample** — each of those would appear
here as an extra or differently-shaped firing.

> **Two earlier runs of this sweep returned a false `0 firings` and were VOIDED.**
> `ab.mts` arms A2/B install an _instrumented_ `propertyHelper.js` in which the
> five `__push(failures, …)` sites become `__vpPush`, so `__push` is never
> called and genuinely-failing tests return `pass`. The swap is worktree-safe
> but **not self-safe**. Caught only because the second run embedded in-run
> positive controls and they failed to fire. The sweep now **pre-flight-aborts**
> unless `test262/harness` is a symlink _and_ `propertyHelper.js` carries zero
> instrumentation markers. See `plan/probes/3603/NOTES.txt`.

**Denominator discipline:** this is 51 tests across 6 areas, not 989. It
establishes that the write-back is narrowly scoped; it does **not** by itself
prove all corpus flips are honest. That comes from the `merge_group` bucketing
at (c), combined with the S1-applied-vs-reverted attribution control (which used
no harness at all and is the load-bearing evidence).

### Cohort routing (condition b)

Every failure cohort exposed by S1 is routed to a tracker. These are defects S1
**exposed, not caused** — both reproduce on stock `upstream/main` with S1
reverted, measured without the test262 harness:

| cohort                                                                                                                               | tracker   | evidence                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------- |
| `getOwnPropertyDescriptor(C.prototype,'m')` returns **null** when the class has computed-name fields, while `hasOwnProperty` is true | **#3646** | `.tmp/3603/attribution.mts` — identical S1-applied vs S1-reverted |
| `propertyIsEnumerable(C.prototype,'m')` returns **true** while `gOPD().enumerable` is false — 5 reflective routes agree, it dissents | **#3647** | `.tmp/3603/enum-check.mts` — identical S1-applied vs S1-reverted  |

Either defect alone makes `verifyProperty`'s enumerable check fire **correctly**.
The authoritative merge-group measurement above confirmed that the two dominant
clusters are the class-element descriptor/enumerability cohorts routed through
#3646/#3647; no new trap cohort appeared.

> **This issue is a ROOT CAUSE + MEASUREMENT deliverable.** No compiler change
> is proposed here. Everything below is measured on `origin/main` @
> `ab69ad9d20ceec` with local-vs-local A/B; nothing is extrapolated from a
> cluster label. Denominators are given for every number.

## TL;DR

`verifyProperty(obj, name, desc)` from test262's `propertyHelper.js` fails to
verify anything on **both** the standalone lane **and** the JS-host lane — for
**two completely different reasons**:

| lane           | do the four descriptor-field checks RUN? | is a detected mismatch REPORTED? | net effect  |
| -------------- | ---------------------------------------- | -------------------------------- | ----------- |
| **standalone** | **NO** — all four guards are false       | (never reached)                  | silent pass |
| **host**       | yes                                      | **NO** — `__push` is a no-op     | silent pass |

The handed-down lead ("`__push`/`__join` swallow the terminal assert") is
**CORRECT — for the host lane** and **REFUTED for standalone**, where `__push`
is never reached at all. The two must not be conflated: fixing either one alone
leaves the other lane vacuous, and fixing the standalone one _first_ turns the
host-lane defect into a live Wasm **trap** rather than a silent pass.

## Symptom (A/B wrong-expectation control, `tests/test262-runner.ts` verdicts)

Each row feeds `verifyProperty` a deliberately WRONG expectation. A correct
implementation must FAIL every one of them.

| probe (`.tmp/vp/probe.mts`)                                       | expect | host       | standalone  |
| ----------------------------------------------------------------- | ------ | ---------- | ----------- |
| `verifyProperty(Math.abs,"name",{value:"abs",…})` — **correct**   | pass   | pass       | pass        |
| `…{value:"SHOULD_NOT_MATCH",…}`                                   | fail   | (see note) | **pass** ✗  |
| `…{value:"abs", writable:TRUE,…}`                                 | fail   | (see note) | **pass** ✗  |
| `…{value:"abs", enumerable:TRUE,…}`                               | fail   | (see note) | **pass** ✗  |
| `…{value:"abs", …, configurable:FALSE}`                           | fail   | (see note) | **pass** ✗  |
| `verifyProperty(Math.abs,"no_such_prop_zz",{value:1})`            | fail   | fail       | fail ✓ (a1) |
| `var o={a:1}; verifyProperty(o,"a",{value:1,…})` — **correct**    | pass   | pass       | **fail** ✗  |
| `var o={a:1}; verifyProperty(o,"a",{value:42,…})`                 | fail   | **pass** ✗ | fail        |
| `var o={a:1}; verifyProperty(o,"a",{value:1,writable:FALSE,…})`   | fail   | **pass** ✗ | fail        |
| `var o={a:1}; verifyProperty(o,"a",{value:1,…,enumerable:FALSE})` | fail   | **pass** ✗ | fail        |
| `var o={a:1}; verifyProperty(o,"a",{value:1,…,configurable:F})`   | fail   | **pass** ✗ | fail        |
| `var o={a:1}; verifyProperty(o,"a",{value:42})` (value-only)      | fail   | **pass** ✗ | fail        |
| `assert(false,"sanity")`                                          | fail   | fail ✓     | fail ✓      |
| `assert.sameValue(1,2,"sanity")`                                  | fail   | fail ✓     | fail ✓      |

> **note** — the four `Math.abs`/`"name"` host rows report `fail` in that run,
> but the failure is `"obj should have an own property name"`, i.e. the **a1
> gate**, not the descriptor check. That is a _probe artifact_: on the host lane
> `Math` is the real host object, `verifyProperty` without `{restore:true}` is
> destructive (`isConfigurable` does `delete obj[name]`), and the earlier
> _correct_ case in the same process permanently deleted `Math.abs.name`. The
> five `{a:1}` rows use a fresh literal per case and are the clean host
> evidence. Do not read the `Math.abs` host column as a working host lane.

Standalone: **vacuous past the a1 gate** exactly as reported. Host: vacuous
whenever the a1 gate is reachable, i.e. the far more common case.

## Root cause A — standalone: object literals have NO runtime own-property table

### The predicate

`src/codegen/object-runtime.ts:2630-2677`, `emitHasOwn` (the wasm-native
`__hasOwnProperty` / `__object_hasOwn`):

```
if (__builtinfn_get_meta(obj, key) != null) return 1;   // #2896 builtin-fn arm
any = any.convert_extern(obj)
if (!ref.test $Object) return 0;                        // ← NOT an $Object → false, silently
e = __obj_find(cast<$Object>(any), key)
return e != null
```

A receiver that is not an `$Object` answers **false** — it does not throw, it
does not fall back. A plain object literal lowers to a **typed WasmGC struct**,
not an `$Object`, so every runtime own-property query on it reports _zero own
properties_. This is the "plain object literal → false → lowers to a typed
struct" row already documented in the header of
`src/codegen/builtin-ctor-own-props.ts` (#2984); that issue closed the
_builtin-ctor carrier_ row and left this one open.

### Why that makes `verifyProperty` vacuous

Every one of the four checks in `verifyProperty` is guarded by an own-property
query **on `desc`**, and `desc` is a plain object literal at essentially every
call site (see census: 6,308 / 6,470):

```js
if (__hasOwnProperty(desc, 'value'))        { …push failure… }   // false
if (__hasOwnProperty(desc, 'enumerable') …) { …push failure… }   // false
if (__hasOwnProperty(desc, 'writable') …)   { …push failure… }   // false
if (__hasOwnProperty(desc, 'configurable')…){ …push failure… }   // false
if (failures.length) { assert(false, __join(failures, '; ')); }  // failures === []
return true;
```

All four guards are false ⇒ `failures` stays empty ⇒ **`verifyProperty` returns
`true` for any expectation whatsoever.**

The a1 gate (`assert(__hasOwnProperty(obj, name), …)`) survives only because in
the _passing_ population `obj` is typically a builtin function value, which the
`__builtinfn_get_meta` arm answers correctly. When `obj` is itself a plain
object literal the a1 gate is false and a **correct** descriptor FAILS — the
"opposite symptom" noted in `plan/agent-context/dev-floor-truth.md`. Same root
cause, both directions.

### It is not `hasOwnProperty`-specific — the whole runtime MOP is blind

`.tmp/vp/inner3.mts`, standalone, all queries made through **untyped**
(`any`-param) helpers so nothing is folded at compile time. Counts are own
properties found; the object has exactly one (`a`), or for the builtins the
named key:

| construction of the receiver          | `hasOwnProperty` | `gOPD` | `getOwnPropertyNames` | `Object.keys` | `for-in` |
| ------------------------------------- | ---------------- | ------ | --------------------- | ------------- | -------- |
| `{a:1}` literal                       | **false**        | undef  | **0**                 | **0**         | **0**    |
| `{}` then `o.a = 1` (static key)      | **false**        | undef  | **0**                 | **0**         | **0**    |
| `{}` then `o["a"] = 1` (computed key) | true             | ok     | 1                     | 1             | 1        |
| `{}` then `Object.defineProperty(…)`  | **false**        | undef  | **0**                 | **0**         | **0**    |
| `new Object()` then `o.a = 1`         | true             | ok     | 1                     | 1             | 1        |
| `Object.create(null)` then `o.a = 1`  | true             | ok     | 1                     | 1             | 1        |
| `JSON.parse('{"a":1}')`               | true             | ok     | 1                     | 1             | 1        |
| `{...{a:1}}` (spread)                 | true             | ok     | 1                     | 1             | 1        |
| `Object.assign({}, {a:1})`            | **false**        | THREW  | **0**                 | **0**         | **0**    |
| literal passed through an any-param   | **false**        | undef  | **0**                 | **0**         | **0**    |
| `Math` (namespace), key `"abs"`       | **false**        | undef  | **0**                 | **0**         | **0**    |
| `Math.abs` (builtin fn), key `"name"` | true             | ok     | THREW                 | 0             | 0        |

Three things fall out of this table:

1. **The hole is the OBJECT-LITERAL representation, not one predicate.**
   `hasOwnProperty`, `getOwnPropertyDescriptor`, `getOwnPropertyNames`,
   `Object.keys` and `for-in` all report "no own properties" together.
2. **A promotion path to `$Object` already exists.** A single **computed-key**
   write (`o["a"] = 1`) flips the same object into a fully queryable `$Object`;
   so do `new Object()`, `Object.create`, `JSON.parse` and spread. Only the
   literal / static-key-assignment path stays a blind typed struct.
3. **`Object.defineProperty` does NOT promote** (row 4). That is a second,
   independently reportable defect: on standalone you cannot even opt into a
   queryable object by defining a property on it.

> **Trap for the next agent — do not use `Object.keys(desc)` as a yardstick.**
> Measured on a _directly named module global_ `Object.keys(DESC).length === 4`
> (compile-time fold, correct); measured on the **same object** through an
> `any` parameter it is **0**. A detector that compares "checks performed"
> against `Object.keys(desc).length` therefore computes `0 < 0 === false` and
> **never fires** — a null result that looks like a clean bill of health. This
> was caught before the sample run, not after.

## Root cause B — host: the uncurried `__push` is a silent no-op

`propertyHelper.js` accumulates failures through the uncurryThis idiom
`var __push = Function.prototype.call.bind(Array.prototype.push);`. Measured
through `runTest262File` (so the host lane gets its real import object) —
`.tmp/vp/uncurry.mts`:

| probe                                                       | host                      | standalone                 |
| ----------------------------------------------------------- | ------------------------- | -------------------------- |
| `var a=[]; __push(a,"x"); a.length === 1`                   | **fail** (`«0»` vs `«1»`) | **fail** (null-deref trap) |
| `var a=[]; __push(a,"x"); a[0] === "boom"`                  | **fail** (`«undefined»`)  | **fail** (null-deref trap) |
| `var a=[]; __push(a,"x"); __join(a,";") === "boom"`         | **fail** (`«""»`)         | **fail** (null-deref trap) |
| `var a=[]; a.push("x"); a.length === 1` (native control)    | pass ✓                    | pass ✓                     |
| `__join(["a","b"],";") === "a;b"`                           | pass ✓                    | **fail** (null-deref trap) |
| `__hasOwnProperty({a:1},"a") === true`                      | pass ✓                    | **fail**                   |
| `__hasOwnProperty({value:1,…},"value") === true`            | pass ✓                    | **fail**                   |
| `Object.prototype.hasOwnProperty.call(o,"a")` via any-param | pass ✓                    | **fail**                   |
| `Object.keys(o).length` via any-param                       | pass ✓                    | **fail**                   |
| `for (k in o)` count via any-param                          | pass ✓                    | **fail**                   |

Three independent observations (`.length`, `[0]`, `__join`) agree that the
uncurried push **genuinely does not append** on the host lane — it is not a
stale-length artifact, and the native `arr.push` control passes. So on the host
lane `verifyProperty` runs its checks, detects the mismatch, `__push`es the
message into a black hole, sees `failures.length === 0`, and returns `true`.

On standalone the same two helpers **trap** (`RuntimeError: dereferencing a null
pointer`) rather than no-op. They are currently unreachable there because root
cause A short-circuits first — **so root cause A is masking root cause B on
standalone.** Repairing A without B converts every honest standalone flip into
an invalid-Wasm trap: the exact failure class that blocked the #3592 arity
widening.

## Census — the exposed population (EXACT, not sampled)

`.tmp/vp/census.mjs` over all 53,273 `.js` files under `test262/test`:

| quantity                                                                   | count     |
| -------------------------------------------------------------------------- | --------- |
| non-`_FIXTURE` files with `includes: [propertyHelper.js]`                  | **5,206** |
| files calling `verifyProperty(`                                            | **5,067** |
| files calling `verifyPrimordial(Callable)?Property(` (aliases)             | 8         |
| files calling `verifyCallableProperty(`                                    | 0         |
| files using ONLY the deprecated `verifyWritable`/… helpers                 | 166       |
| **`verifyProperty` call sites**                                            | **6,470** |
| …whose `desc` argument is an object literal                                | 6,310     |
| …object literal WITH ≥1 checkable field (`value`/`writable`/`enum`/`conf`) | **6,308** |
| …object literal that is `{}` (detector's only static false-positive)       | 2         |
| …object literal with only `get`/`set`                                      | 0         |
| …`desc` is literally `undefined` (early-returns before any check)          | 25        |
| …`desc` is an identifier / other expression                                | 135       |
| files with ≥1 checkable-field object-literal call site                     | **4,984** |

**97.5 % of `verifyProperty` call sites (6,308 / 6,470) pass a plain object
literal carrying at least one checkable field** — i.e. the exposed population is
essentially the whole population, and the detector's static false-positive
surface is **2 call sites out of 6,470**.

> **`5,067` is an UPPER BOUND on the exposed file count, not an exact one — do
> not scale off it.** The census matches `\bverifyProperty\s*\(` textually, and
> the arm-B survivors proved two distinct contamination sources: (a) **comment-only
> matches** — `// TODO: Convert to verifyProperty() format.` matches the regex
> (2 of the 3 survivors); and (b) **calls that never execute** — e.g.
> `built-ins/WeakRef/prototype/constructor.js` guards its call behind
> `if (WeakRef.prototype.hasOwnProperty('constructor'))`, which is itself false
> on standalone _for root cause A_. The effective-rate figure below (158 / 158 of
> _executed_ calls) is unaffected by this, because it is derived from actual
> execution, not from the census. Scaling 5,067 as if it were exact is precisely
> the over-count failure mode the project's MEASURE-NEVER-EXTRAPOLATE rule exists
> to prevent.

## Measurement — local-vs-local A/B with a calibrated vacuity detector

**Method.** Same runner, same sample, same process kind; the ONLY difference is
the harness. Arm A = stock upstream `propertyHelper.js`. Arm B = the same file
with two detectors spliced in:

- `__vpChecks === 0` → **NO_CHECKS**: not one descriptor-field check ran
  (standalone's failure mode).
- `__vpFailMsg !== ""` → **SWALLOWED**: a check ran, found a mismatch, and the
  `__push`/`__join` accumulate-and-report path lost it (host's failure mode).
  The five `__push(failures, …)` sites are rewritten to set a plain module
  variable, bypassing both broken helpers.

Neither detector queries `desc` at runtime (see the trap note above). The
instrumented harness is written into a **private copy** of this worktree's
`test262/harness` (the worktree normally symlinks the shared tree), so no other
agent's run is perturbed, and the symlink is restored on every exit path.
**Nothing is committed to compiler or runner code.**

### Calibration (mandatory before any number is reported)

| control                                                   | lane       | arm A | arm B    | verdict                       |
| --------------------------------------------------------- | ---------- | ----- | -------- | ----------------------------- |
| `verifyProperty(Math.abs,"name",{CORRECT})`               | standalone | pass  | **fail** | positive control FIRES ✓      |
| `verifyProperty(Math.abs,"name",{CORRECT})`               | host       | pass  | pass     | negative control silent ✓     |
| `var o={a:1}; verifyProperty(o,"a",{value:42,…})` (WRONG) | host       | pass  | **fail** | host positive control FIRES ✓ |

The detector is proven to fire on a known-vacuous pass and proven not to fire on
a genuinely-checking pass. A third control (`{}` + `Object.defineProperty`,
correct descriptor) fires SWALLOWED on the host lane — that is **not** a clean
negative control (that construction path is itself suspect, see the
`Object.defineProperty` row of the boundary table) and it is excluded from the
calibration; it is recorded here as a separate observation.

### Result — standalone lane

Sample: **600** files drawn uniformly (mulberry32, seed `20260725`) from the
5,067-file `verifyProperty` population.

| arm A status  | n       |
| ------------- | ------- |
| pass          | **161** |
| fail          | 381     |
| skip          | 53      |
| compile_error | 5       |

Arm B was then run over exactly those **161 passing** files (same runner, same
order, only the harness differs):

| arm B status  | n       |
| ------------- | ------- |
| **fail**      | **158** |
| pass          | 3       |
| compile_error | 0       |

**158 of 161 previously-passing files (98.1 %) flip to fail under the vacuity
detector.** Zero compile errors, so the instrumentation did not break the build.

The three survivors execute **no `verifyProperty` call at all** — verified by
reading them:

| file                                                                 | why it survives                                                                                                                        |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `built-ins/Object/prototype/propertyIsEnumerable/S15.2.4.7_A2_T2.js` | `verifyProperty()` appears only in a `// TODO:` comment (census regex false positive)                                                  |
| `built-ins/Object/prototype/toLocaleString/S15.2.4.3_A8.js`          | same — comment-only mention                                                                                                            |
| `built-ins/WeakRef/prototype/constructor.js`                         | the call is inside `if (WeakRef.prototype.hasOwnProperty('constructor'))`, which is itself false on standalone for the same root cause |

So **every sampled standalone `verifyProperty` pass that actually executes a
`verifyProperty` call is vacuous: 158 / 158.**

Only 5 of the 158 render the detector's message (`…NO_CHECKS`) — all of them
async tests, whose failure surfaces through the `Test262:AsyncTestFailure`
channel; the other 153 collapse onto the opaque
`uncaught Wasm-GC exception (non-stringifiable payload)` label (#2862). **Every
message that IS legible says `NO_CHECKS`; not one says `SWALLOWED`** — which is
exactly root cause A and confirms `__push` is never reached on standalone.

### Attribution control (arm A2) — the flips ARE the detector

"The instrumented harness fails 158 tests" is not by itself evidence that the
detector fired; the instrumentation could simply have broken something. So a
third arm was run over the same 161 files: **arm A2 = every structural edit of
arm B (the `__vpChecks` counter, `__vpPush` replacing all five
`__push(failures, …)` sites, the module-level `__vpFailMsg`) with the two
detector `throw`s REMOVED.**

| arm                                    | pass    | fail    |
| -------------------------------------- | ------- | ------- |
| A — stock harness                      | **161** | 0       |
| A2 — instrumented structure, no throws | **161** | 0       |
| B — instrumented structure + detectors | 3       | **158** |

Arm A2 reproduces arm A exactly (161 / 161). The 158 flips are therefore
attributable **solely to the detector firing**, not to the instrumentation
perturbing compilation or behaviour.

> **Do NOT scale 158/161 to the 1,190-pass figure or to any corpus number.**
> This is a 600-file uniform sample of the 5,067-file population, reported as
> `158 vacuous / 161 sampled-passing`. The memory rule on cluster-label
> over-counting (100–600×) applies to this agent's own numbers too. A
> full-corpus number requires a full-corpus run.

### Result — host lane: mechanism CONFIRMED, magnitude **NOT MEASURED**

The host lane's failure mode is confirmed three ways — the five `{a:1}`
wrong-expectation rows in the symptom table all report `pass`; the three
independent `__push` observations (`.length`, `[0]`, `__join`) all miss the
pushed element while the native `arr.push` control passes; and the calibrated
detector fires `VACUOUS_VERIFYPROPERTY_SWALLOWED` on the host positive control.

**The corpus magnitude on the host lane is reported below only if it was
measured; it is never estimated.** The detector is already calibrated for the
host lane (the `posthost` control above), so completing it is three commands:

```bash
VP_LANE=host npx tsx plan/probes/3603/ab.mts armA 600 20260725
VP_LANE=host npx tsx plan/probes/3603/ab.mts armA2   # attribution control
VP_LANE=host npx tsx plan/probes/3603/ab.mts armB
```

**There is deliberately NO host magnitude number anywhere in this issue — do not
substitute a guess for it, and do not treat any partial run as one.** An arm-A
host run was started and abandoned at ~350/600 for two independent reasons, both
disqualifying: (a) the box was at load ~19 on 8 cores with 13 foreign sweep
processes, 2.4× the concurrency ceiling; and (b) the branch was committed to
twice while it was in flight, so its provenance would have been "started on
`a727b1b9`, finished on `476cd651`", which cannot be reported alongside the
standalone numbers' clean single-SHA provenance. **No partial output was kept.**
Arm A alone would not have yielded a vacuity count in any case — that needs all
three arms (A, A2, B) in one clean window.

The relevant point for planning is qualitative and already established: **the
host lane is affected too, so this is a lane-parity item, not a standalone-only
one.** The headline conformance figure is inflated over the `verifyProperty`
population by an amount that must be measured before it is quoted. Note this
specifically corrects the assumption that the public host number was untouched
by the vacuity work: that was true of the **arity** bug (host received the
equivalent fix at #2623 P-7) but is **not** true of `verifyProperty`.

## Measured NON-findings (do not re-derive)

- **`transformVerifyPropertyCalls` in `tests/test262-runner.ts:1410` is NOT the
  cause.** That legacy source-rewrite (which converts `verifyProperty(…{value:X}…)`
  into `assert_sameValue` and _strips_ descriptor-only calls) belongs to the
  retired rewritten-harness path. `runTest262File` and `scripts/test262-worker.mjs`
  both go through `assembleOriginalHarness` / `originalHarness: true` and compile
  the **untouched upstream `propertyHelper.js`**. The vacuity is a compiler
  defect, not a runner transform.
- **It is not the `__apply_closure` arity bug (#3592 RC2).** Already refuted by
  the previous session with the widening ON and OFF; re-confirmed here by
  mechanism — the guards are false before any harness call arity is reached.
- **It is not string-specific**, and `assert(false, …)` was never vacuous.

## Tractable next slice (recommended split)

The full fix is `horizon: xl` and must NOT be attempted as one PR. Ordered so
that no step makes the tree worse:

1. **S1 — `uncurryThis` repair, host + standalone** (`horizon: m`, do this
   FIRST). Make `Function.prototype.call.bind(F)` produce a callable that
   actually forwards `(thisArg, …args)` to `F`: host lane currently no-ops for
   `Array.prototype.push`, standalone lane traps for both `push` and `join`.
   This is independently valuable (it un-vacuums the _host_ lane's
   `verifyProperty` on its own), it is a prerequisite for S2 not producing
   traps, and it has a clean unit test surface — the ten rows of the root-cause-B
   table are the acceptance criteria.

   **S1 is also the only slice that can prove itself today.** The host lane's
   vacuity is entirely S1's fault, and the detector in `plan/probes/3603/ab.mts`
   is _already calibrated for the host lane_ (the `posthost` control) — so S1
   lands with a real before/after vacuity count from the same harness, measured
   in one clean window. S2 has no such measurement available until S1 is in,
   because until then every standalone flip is a trap rather than a verdict. So
   the ordering is not merely "S2 is risky first"; it is "S1 is the slice that
   can be measured first."

2. **S2 — promote object literals to a runtime-queryable representation on
   standalone** (`horizon: l`/`xl`). The promotion machinery already exists —
   a computed-key write produces a real `$Object`. The slice is to trigger it
   when a typed-struct object escapes into an `any`/untyped context (the
   `verifyProperty(obj, name, desc)` situation), or to give the typed-struct
   representation an own-key table that `__obj_find` can consult. Start with the
   narrow, high-leverage case: **an object literal passed as an argument to a
   function with an untyped parameter.**
3. **S3 — `Object.defineProperty` must promote too** (`horizon: s`/`m`). Row 4
   of the boundary table; small and self-contained.
4. **S4 — re-measure and land the honest floor.** Expect the standalone floor to
   go **DOWN**: the arm-B number below is the size of the correction. Follow the
   landing recipe in `.claude/memory/reference_f1_honest_floor_deinflation_landing_recipe.md`.

**Expect genuine flips, not a pass-preserving cleanup.** `__builtinfn_gopd`
already returns a wrong `value` for `Math.abs.name` (measured: the descriptor is
non-undefined and `writable === false` is correct, but `value === "abs"` is
**false**), so the `name`/`length` family will flip to honest FAIL once the
guards start firing.

**Both lanes are affected, so this is a lane-parity item, not a standalone-only
one.** The host lane's `verifyProperty` population is 5,067 files; its vacuity
inflates the headline conformance number by an amount nobody has measured yet.
Quantifying that (arm A + arm B on the host lane, same method) is the natural
companion slice and is cheap now that the detector is calibrated.

## S1 LANDED — implementation notes (2026-07-25, `opus-loop-a`)

> Slice 1 of the recommended split (host lane / root cause B) is implemented.
> **Root cause A (standalone) is deliberately untouched** — see the re-measure
> note below before starting it.

### The mechanism was NOT `bind`, and not `uncurryThis`

The handed-down lead named `Function.prototype.call.bind(F)` as the suspect.
Traced through the import bridge (`.tmp` probe wrapping every entry in
`buildImports(...).env`), the `bind` is innocent and the defect is **one layer
lower**. Two independent dispatch shapes fail identically:

| source                            | bridge call                                       | before |
| --------------------------------- | ------------------------------------------------- | ------ |
| `Array.prototype.push.call(a, x)` | `__extern_method_call(push, "call", [mirror, x])` | no-op  |
| `__push(a, x)` (uncurryThis)      | `__call_function(boundCall, null, [mirror, x])`   | no-op  |
| `a.push(x)` (native)              | (compiled `__vec_push`)                           | works  |

In **both** failing rows the vec argument arrives as `mirror` — the JS array
`__make_iterable`'s `convertToJS` materialises from the vec. That mirror is a
**read mirror**: `convertToJS` _refreshes it FROM the vec_ on every crossing
(#3368, so array identity survives `any` slots). The host push therefore
appends to an array the Wasm side never consults, and the next crossing
overwrites it. `__vec_push` returned `1` (the correct new length) in the trace
while `a.length` still read `0` — the two sides were looking at different
objects.

So the fix does **not** belong in `bind`, in `.call`, or in `propertyHelper.js`.
It belongs at the **host-call boundary**, and it fixes the whole family
(`push`/`pop`/`shift`/`unshift`/`splice` through `.call`/`.apply`/uncurried) at
once, not just `__push`.

### What landed

`src/runtime/vec-mirror-writeback.ts` (new subsystem module) +
14 lines of wiring in `src/runtime.ts`:

1. `registerVecMirror(arr, vec)` in `__make_iterable`'s vec arm — records
   mirror → vec.
2. `snapshotVecMirrors` / `reconcileVecMirrors` **bracket** the two host-call
   bridges (`__extern_method_call`'s primary `fn.apply`, and
   `__call_function`'s `Reflect.apply`). If the callee changed a mirror's
   **length**, the change is replayed onto the vec: pop back to the longest
   common prefix, then push the mirror's tail — using only `__vec_pop` /
   `__vec_push`, which are already emitted unconditionally alongside
   `__vec_mut_supported`.

**Runtime-only. Zero codegen bytes change** — so no late-import funcIdx
shifting, no stack-balance risk, no `addUnionImports` interaction. That was a
deliberate design constraint given this issue's `feasibility: hard` /
regression-prone framing.

### Not the same issue as #3571 — do not conflate them

**#3571** ("standalone: `Function.prototype.call`/`apply`/`bind` on builtin
methods") names the _same idiom_ and cites the _same trigger_
(`propertyHelper.js`'s uncurryThis), so the pre-dispatch gate flags them as
overlapping. They are **different defects on different lanes**:

|                    | #3603 S1 (this)                                           | #3571                       |
| ------------------ | --------------------------------------------------------- | --------------------------- |
| lane               | JS host                                                   | `--target standalone`       |
| what breaks        | the mutation is dropped — the vec mirror is a read mirror | the _dispatch itself_ fails |
| layer              | host runtime bridge                                       | codegen                     |
| `bind` implicated? | **no** — plain `.call` fails identically                  | yes                         |

S1 changes **no codegen** and cannot fix #3571; #3571 will not fix S1. Both are
real. The right sequence is still host-first: standalone's `__push`/`__join`
currently _trap_ rather than no-op, and repairing standalone MOP queries before
the host lane converts honest flips into invalid-Wasm traps.

### Deliberate non-goals (documented at the helper, not oversights)

- **Length-PRESERVING in-place edits stay silent no-ops**: `sort`, `reverse`,
  `fill`, `copyWithin`, and a bare `arr[i] = x` through the host. Detecting one
  needs an element-by-element compare on _every_ host crossing (O(n) even when
  nothing changed); replaying one needs `__vec_set_elem`, which is only emitted
  when a module imports `Object.defineProperty`. Unchanged from before.
- **Re-entrant Wasm mutation wins**: if the vec's own length also moved during
  the call, the two edits cannot be ordered, so reconciliation is skipped
  rather than guessed at.
- `_wrapVecForHost`'s `set()` trap (`src/runtime.ts`) is still a documented
  no-op. That is a _third_ silent-no-op site in the same family; it was not in
  S1's path and is not touched.

### Evidence

`tests/issue-3603-vec-mirror-writeback.test.ts` — 15 tests, all host lane by
construction (`buildImports` + real import object). **Verified by reverting the
diff**: 9 rows fail without the change —

- the issue's three independent `__push` observations (`.length` → `0`,
  `[0]` → `undefined`, `__join` → `""`),
- the literal `propertyHelper` accumulate-and-report epilogue (returned `""`,
  i.e. the `if (failures.length)` branch was never taken — _this is the
  vacuity itself_),
- `pop`/`shift`/`unshift`/`splice`/multi-push/numeric-vec via `.call`.

Four control rows pass **before and after** and are there to isolate the
defect, not to pad coverage: native `a.push(x)`, `__join` on a literal, the
uncurried `hasOwnProperty` (a _read_, hence never broken), and a non-mutating
`slice.call`.

### Reach — measured by the authoritative merge-group

The merge-group run recorded above measured **1,023 stable, non-timeout
wasm-change regressions** and **23 stable improvements**. Those are reported
separately rather than extrapolated or collapsed into a net. This supersedes
the earlier pre-merge statement that S1's corpus reach was unmeasured.

### S2 (standalone / root cause A) re-measure — MECHANISM half done, REACH half still stale

**Why a re-measure was needed.** The standalone numbers in this issue were
taken on `ab69ad9d2` (2026-07-24 23:00). **#3592's arity de-vacuification
landed at `bbe94d090` (2026-07-25 16:56) — ~18 h later** — and #3468
(standalone F1 / honest floor) merged at `f1195c1d7`. Both are _standalone
vacuity fixes_, so the standalone arm's reach could have been partly or wholly
resolved out from under the measurement. Acting on a measurement taken against
a base that has since moved is the exact trap this project keeps hitting.

**Mechanism: re-measured on current `main`, and it STILL REPRODUCES.**

- Base: `upstream/main` @ `b9632af3f`. Verified by
  `git merge-base --is-ancestor`: **`bbe94d090` (#3592) IS an ancestor**
  (`declaredArity` is present in `src/codegen/closure-exports.ts`), and
  **`f1195c1d7` (#3468 F1) IS an ancestor**. So both standalone vacuity fixes
  are in the tree that was measured.
- Probe: `plan/probes/3603/inner3.mts` (the committed fix-boundary table),
  standalone lane, re-run unmodified.
- Result: **bit-identical to the table in this issue.** Object literal,
  `{}` + static-key assign, `Object.defineProperty`, a literal passed through
  an `any` parameter, and the `Math` namespace all still report **zero own
  properties** across all five MOP queries (`hasOwnProperty`, `gOPD`,
  `getOwnPropertyNames`, `Object.keys`, `for-in`). The promoting shapes
  (computed-key write, `new Object()`, `Object.create(null)`, `JSON.parse`,
  spread) all still answer correctly, and `Object.assign({}, {a:1})` is still
  false with `gOPD` still THROWing.

So **root cause A is a live defect on current `main`, not an artifact of the
stale base** — #3592 and #3468 did not touch it. S2 remains real work.

**REACH: re-measured 2026-07-26 — supersedes the stale `158 / 161`.**

Full three-arm A/B re-run in one clean window on one SHA (`5388f95d2`; only
delta vs `upstream/main` is the HOST-lane write-back + tests/docs, and the
`__make_iterable` path it touches is gated `!ctx.standalone`, so it is inert on
this lane). Same 600-file uniform sample, same seed `20260725`, standalone lane:

| arm                                      | n   | result                                |
| ---------------------------------------- | --- | ------------------------------------- |
| **A** — stock harness                    | 600 | pass **156**, fail 387, skip 53, CE 4 |
| **A2** — instrumented, detectors REMOVED | 156 | pass **156** (0 fail)                 |
| **B** — instrumented + detectors         | 156 | fail **152**, pass 4                  |

**152 / 156 sampled standalone passes (97.4 %) are vacuous.**

Arm A2 reproduces arm A **exactly** (156/156), so the 152 flips are
attributable **solely to the detector firing**, not to the instrumentation
perturbing compilation. That is the attribution control, and it passed.

Comparison to the superseded figure — **for stability, not to be combined**:

|                       | old (`ab69ad9d2`) | new (`5388f95d2`) |
| --------------------- | ----------------- | ----------------- |
| arm A passes (of 600) | 161               | 156               |
| arm B vacuous         | 158               | 152               |
| rate                  | 98.1 %            | 97.4 %            |

So the reach is **essentially unchanged** — #3592 and #3468 did not reduce it.
Root cause A gates the same population it did before. **Quote `152 / 156`, with
its denominator; the old `158 / 161` is superseded. Do not scale either to the
corpus** — this is a 600-file sample of the 5,067-file `verifyProperty`
population, and a full-corpus number requires a full-corpus run.

> The two halves remain independent: "the mechanism still reproduces" says
> nothing about how many tests it gates. A cluster sharing one root cause is a
> population, not a delta. Here both halves were measured separately and both
> came back live.

## Reproduction

Every script that produced a number above is committed at
**`plan/probes/3603/`** (with `plan/probes/3603/NOTES.txt` giving the run order
and the safety notes) and the raw per-file verdicts at
**`plan/probes/3603/results/`**. `plan/` is outside the `format:check` / `lint`
globs (`src/ tests/ scripts/`) so nothing there is executed or checked by CI.

- `census.mjs` — the exact static census (no compiler involved).
- `probe.mts` — the A/B wrong-expectation control through `runTest262File`.
- `inner.mts` / `inner2.mts` — fine-grained numeric observation channel into the
  compiled harness (one observation per exported call).
- `inner3.mts` — the fix-boundary table (object construction shapes).
- `uncurry.mts` — the two-lane `uncurryThis` check.
- `ab.mts` — the calibrated A/B vacuity measurement (`calibrate` / `armA` /
  `armA2` / `armB`).

`ab.mts` swaps **this worktree's** `test262/harness` symlink for a private real
copy while it runs and restores the symlink on every exit path, so a concurrent
agent's test262 run is never perturbed. **No committed compiler or runner code
is touched, and there is no committed force-disable switch.**

### Observation-channel gotchas (cost real time; documented so they don't again)

1. **`export` is required.** A plain top-level `function probeQ()` is not
   auto-exported; the accessor silently reads back `NaN`/undefined and looks
   like a harness bug.
2. **A `number` JSDoc annotation is required** on the exported accessor's
   parameter (`/** @param {number} i */`), or the compile fails with
   "implicit 'any' type".
3. **Do not compare an untyped export parameter against a numeric literal
   directly.** `p(i)` with `if (i === 0)` never matches on standalone (the boxed
   `any` strict-eq path); coerce first — `var j = i + 0;` — then branch on `j`.
   Without this every observation reports "branch not taken" and the whole probe
   reads as a total failure.
4. **A Wasm trap is not catchable by the compiled `try/catch`.** It surfaces at
   the JS boundary as `RuntimeError`, so it must be caught around the _accessor
   call_, not only inside the probe body.
5. **The host lane needs a real import object** (`buildImports` + sandbox);
   `WebAssembly.instantiate(binary, {})` only works for standalone, where
   `result.imports` is `[]`. Use `runTest262File` for host-lane probes.
6. **`verifyProperty` is destructive** (`isConfigurable` does `delete
obj[name]`, `isWritable` writes) and the host lane shares real host builtins
   across in-process runs. Probing `Math.abs` twice in one process without
   `{restore:true}` contaminates the second probe. Use a fresh subject per case.
