---
id: 3571
title: "standalone: builtin objects not reified as values (was: Function.prototype.call/apply/bind uncurryThis — MECHANISM REFUTED, see 2026-08-01 section)"
status: ready
created: 2026-07-24
updated: 2026-08-01
assignee: ttraenkler/sendev-p3-uncurry
priority: medium
feasibility: hard
model: fable
task_type: conformance
area: codegen
language_feature: function-dispatch
goal: standalone
sprint: current
horizon: m
parent: 2860
related: [2773, 2984, 2744, 2175, 3976, 3642, 3603]
# (2026-08-01) Priority high -> medium and horizon l -> m: the uncurryThis seam
# is measured at 1.7% of the 1,810-file routing population it was scheduled on
# (0% on a stratified sample of this issue's OWN signature). The corrected
# standalone scope is "builtin objects are not reified as inspectable values",
# bounded at 217 files. The dominant cause in that population is #3976.
---

# standalone: `Function.prototype.call`/`apply`/`bind` on builtin methods (uncurryThis / propertyHelper blocker)

## Problem

Under `--target standalone`, invoking a builtin prototype method that has been
**reified as a value and re-dispatched via `Function.prototype.call` / `.apply`
/ `.bind`** fails. The dominant real-world trigger is the test262 harness
`propertyHelper.js`, which builds the "uncurryThis" idiom at include-time:

```js
var __hasOwnProperty     = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
var __propertyIsEnumerable = Function.prototype.call.bind(Object.prototype.propertyIsEnumerable);
```

Calling `__hasOwnProperty(obj, name)` — i.e. `Object.prototype.hasOwnProperty.call(obj, name)`
via the doubly-bound `Function.prototype.call` — throws
`TypeError: Cannot convert undefined or null to object` (the bound builtin
method loses its explicit receiver). A second sub-mode returns a falsy value
instead of throwing, surfacing as `Test262Error: obj should have an own
property <X>`.

This is **shared function-dispatch / method-as-value substrate**, NOT specific
to any one builtin. It surfaces most visibly in every `verifyProperty`
descriptor test (`propertyHelper.js` is included by ~all of them), so it caps
the standalone pass rate across **every** builtin lane at once.

## Measured evidence (2026-07-24, current main fa2b189, `--target standalone`)

Measured over the Map/Set/WeakMap/WeakSet/Symbol lane (933 test262 files via
the real runner). **109 of 217 failures** in this lane trace to this single
path (error: `Cannot convert undefined or null to object` /
`Cannot access property on null or undefined`):

| family  | tests in cluster |
| ------- | ---------------- |
| Symbol  | 39               |
| Map     | 23               |
| Set     | 23               |
| WeakMap | 8                |
| WeakSet | 6                |
| MapIter | 5                |
| SetIter | 5                |
| **sum** | **109**          |

Spot-checked one `convert-null` file per family (incl. `Symbol/species/basic.js`,
`Set/prototype/add/add.js`, `Symbol/match/prop-desc.js`): all route through
`propertyHelper.js` → `verifyProperty` → the uncurryThis path. No buried
lane-specific slice — this is genuinely one shared cause. The same lane's
descriptor tests that DON'T hit this path already pass (native Map/Set wiring
landed in #1103).

## Root-cause isolation (primary evidence)

Direct repro under `target: "standalone"` (compiler bundle; note the ad-hoc
harness is imperfect for pass/fail but faithful for the throw):

- `const u = Function.prototype.call.bind(Object.prototype.hasOwnProperty)` —
  **creating** the bound fn succeeds (`typeof u === "function"`).
- `u({a:1}, "a")` — **throws** (`Cannot convert undefined or null to object`),
  even on a plain object — so it is not proto-object-model-specific.
- `u = Function.prototype.call.bind(userFn); u(recv, arg)` — also throws.
- By contrast `userFn.bind(recv)(arg)` **works** — plain `.bind` is fine; the
  break is `.call`/`.apply` (and `call.bind`) threading an explicit receiver
  into a reified/bound method.

The mechanism (why the receiver is dropped) is **hedged** — it needs a
Fable-tier look at the funcref-wrapper / method-as-value dispatch. This is the
same family dev-std-6 flagged as "Array.prototype.map not callable as a value"
and is Fable-gated (cf. #2773 value-rep, #2984, #2744).

## Acceptance criteria

- `Function.prototype.call(thisArg, ...args)` / `.apply(thisArg, argsArray)` on
  a reified builtin prototype method dispatches with the explicit receiver.
- `Function.prototype.call.bind(builtinMethod)` (uncurryThis) produces a
  function that, when invoked, threads its first arg as the method receiver.
- `propertyHelper.js`'s `__hasOwnProperty` / `__propertyIsEnumerable` work
  under standalone → the ~109-test descriptor cluster (this lane) plus the
  cross-lane equivalents flip toward host parity.

## Notes

- SUBSTRATE / fable-tier — do NOT harvest as a dev slice.
- High leverage: this is a cross-cutting standalone lever alongside #2773 /
  #2984 / #2744, registered by the coordinator for the Fable session.
- Discovered while measuring the Map/Set/WeakMap/WeakSet/Symbol standalone lane
  (2026-07-24). Contained slices in that lane (WeakMap/WeakSet iterable ctor,
  Symbol.matchAll whitelist, Set host-leak wiring) are being harvested
  separately.

---

## S1 baseline re-measurement (opus-loop-c, 2026-07-26) — and a CORRECTION

This issue **is #3603's slice S1**, which #3603 states must land FIRST: it
un-vacuums the host lane's `verifyProperty` on its own, it is the prerequisite
for S2 not producing traps, and it is *the only slice that can prove itself
today* (the detector in `plan/probes/3603/ab.mts` is already calibrated for the
host lane). Claimed on that basis, not as a parallel effort.

Baseline re-run of the calibrated harness `plan/probes/3603/uncurry.mts` on
`upstream/main` (it does NOT touch the shared `test262/harness` symlink — only
`ab.mts` does — so it is safe to run alongside other lanes):

| case                              | host     | standalone      |
| --------------------------------- | -------- | --------------- |
| `uncurried-push-works`            | **fail** | **fail** (trap) |
| `uncurried-join-works`            | pass     | **fail** (trap) |
| `uncurried-hasown-objlit`         | pass     | **fail**        |
| `uncurried-hasown-desc-shape`     | pass     | **fail**        |
| `failure-accumulation-end-to-end` | **fail** | **fail** (trap) |
| `runtime-hasown-via-any-param`    | pass     | **fail**        |
| `runtime-keys-via-any-param`      | pass     | **fail**        |
| `runtime-forin-via-any-param`     | pass     | **fail**        |
| `push-then-join-discriminator`    | **fail** | **fail** (trap) |
| `push-then-index0-discriminator`  | **fail** | **fail** (trap) |
| `native-push-control` (CONTROL)   | **pass** | **pass**        |

Host **4/10 fail**, standalone **10/10 fail** (5 as uncatchable traps). The
positive control passes on both lanes, so the harness is live and these are
real failures, not probe artifacts.

### CORRECTION to this issue's stated root cause

The problem statement above says the bound builtin method "loses its explicit
receiver". **That is refuted on the host lane by this table.** If the receiver
were dropped, `__hasOwnProperty(o, "a")` would fail — it **passes** on host. So
does `__join`. On host, *only* the `__push` family fails:

- `uncurried-push-works`, `failure-accumulation-end-to-end`,
  `push-then-join-discriminator`, `push-then-index0-discriminator` — all four
  are the same defect, and all four **mutate** the receiver.
- `__join` and `__hasOwnProperty` only **read** it, and both work.

So the host-lane defect is **receiver mutation not being observed by the
caller** — a value-vs-reference/identity problem — **not** receiver dropping.
That is a different fix from the one this issue's text implies, and it must be
confirmed before implementing. The receiver-dropping description may still hold
for the **standalone** lane, where even the read-only cases fail; the two lanes
must be diagnosed separately rather than assumed to share a cause.

**Do not implement against the original hypothesis without re-deriving it from
this table.** The 109-test cluster figure above was measured on the standalone
Map/Set/Symbol lane and is not evidence for the host mechanism.

### Ordering / cross-lane note

- #3603 (S2+) is claimed by another lane and depends on S1 landing first.
  Coordinate before changing anything `propertyHelper.js` runs through: S1
  changes what the harness *can do* while #3603 changes what it *asserts*, and
  a moving harness would make both sets of numbers unpublishable.
- **#3642** (instance member value-read of a builtin method is `null` on BOTH
  lanes) is a separate, newly-filed cross-lane defect in the same substrate.
  It is plausibly upstream of the standalone half of this issue — check it
  before designing the standalone fix.

---

## RESULT — the HOST arm of this issue is DONE, closed by #3635

Same calibrated harness (`plan/probes/3603/uncurry.mts`), **unchanged**, re-run
against `upstream/main` **merged with `issue-3603-s1-uncurry-this`** (PR #3635,
`src/runtime/vec-mirror-writeback.ts` + 14 wiring lines, zero codegen bytes):

| case                              | host BEFORE | host AFTER | standalone (both) |
| --------------------------------- | ----------- | ---------- | ----------------- |
| `uncurried-push-works`            | fail        | **pass**   | fail (trap)       |
| `uncurried-join-works`            | pass        | pass       | fail (trap)       |
| `uncurried-hasown-objlit`         | pass        | pass       | fail              |
| `uncurried-hasown-desc-shape`     | pass        | pass       | fail              |
| `failure-accumulation-end-to-end` | fail        | **pass**   | fail (trap)       |
| `runtime-hasown-via-any-param`    | pass        | pass       | fail              |
| `runtime-keys-via-any-param`      | pass        | pass       | fail              |
| `runtime-forin-via-any-param`     | pass        | pass       | fail              |
| `push-then-join-discriminator`    | fail        | **pass**   | fail (trap)       |
| `push-then-index0-discriminator`  | fail        | **pass**   | fail (trap)       |
| `native-push-control` (CONTROL)   | pass        | pass       | pass              |

**Host 4/10 → 0/10. Control still green on both lanes. Standalone unchanged at
10/10 fail, 5 of them uncatchable traps.**

So #3635 covers the host arm **including the uncurried spelling** — the
falsifiable alternative (that it fixed only the direct `.call` spelling and left
`__push` broken) is refuted. This is a **second, independent harness** agreeing
with #3635's own tests, reached from the opposite direction:

- I derived the mechanism from a **behavioural split** — the 4 failing host
  cases all MUTATE the receiver (`__push`), the 2 passing ones
  (`__hasOwnProperty`, `__join`) only READ it, and native `a.push(x)` passes.
- #3635 derived it from **mirror identity** — the vec argument arrives as the
  `__make_iterable` mirror, a real JS array that `convertToJS` refreshes FROM
  the vec on every crossing (#3368), so the host appends to an array the Wasm
  side never consults.

Those are the same defect. Read-only crossings never needed the write-back,
which is exactly why they were never broken. Convergence from two harnesses is
much stronger evidence than either alone.

### SCOPE LIMIT on "host arm done" — read this before citing 0/10

`uncurry.mts` exercises `push` (length-CHANGING), `join` and `hasOwnProperty`
(read-only). It does **not** exercise **length-PRESERVING** mutations —
`sort` / `reverse` / `fill` / `copyWithin`, or a bare `arr[i] = x` — through the
uncurried/reflective spellings. #3635's author states those remain **silent
no-ops by design** in that slice.

So the honest claim is **"host 0/10 for the spellings this harness covers"**,
NOT "every host reflective-mutation spelling now works". A follow-up harness
covering length-preserving mutation is needed before the host arm can be called
closed outright. Recorded because 0/10 is exactly the kind of round number that
gets quoted without its denominator.

### What remains: the STANDALONE arm only

**Do not re-implement the host arm.** The remaining work is standalone, where
all 10 rows still fail and the mechanism may genuinely differ (5 rows trap
rather than returning a wrong value).

### Success metric — corrected, and this matters

The original plan assumed uncurryThis vacuity was what gates `verifyProperty` on
standalone. **It is not** — that is the HOST mechanism. #3603's detector
separates `NO_CHECKS` (no descriptor check ran) from `SWALLOWED` (a check ran,
the report was lost), and on standalone **every legible message said
`NO_CHECKS`; none said `SWALLOWED`**. The four descriptor guards are already
false before `__push` is ever reached, because they are `__hasOwnProperty(desc, …)`
queries against a plain object literal — #3603's root cause A.

⇒ **Fixing this issue's standalone arm will NOT un-vacuum `verifyProperty` on
standalone.** Measure **trap / dispatch-failure reduction** instead. If you
measure verifyProperty flips you will get ≈0 and wrongly conclude a correct fix
did nothing. It also means this issue and #3603 S2 cannot double-attribute rows
— different gates entirely.

The 109-test cluster figure earlier in this issue was measured on the standalone
Map/Set/Symbol lane and is **not** evidence for the host mechanism.

### Method note worth keeping

A cluster sharing a failure signature is a **population to be enumerated, never
a forecast to be multiplied**. In every instance seen on 2026-07-25/26 the
signature was a property of **where** the failure surfaced — a frame
(`__module_init`, an `assert.throws` callback) or a message string — never of
**what** was wrong. Ask what VARIES inside the cluster before counting it; for
#3638's 43-row bucket that was ten different builtins, visible in about two
minutes of reading the file list, and it turned a "43-row defect" into a 16-row
one plus nine unrelated causes.

---

# MECHANISM CORRECTED — the standalone arm is NOT a receiver drop (sendev-p3-uncurry, 2026-08-01)

> **The "P3 uncurryThis / propertyHelper seam" was scheduled as an XL target on
> the figure "1,810 standalone-only failures route through `propertyHelper.js`".
> Measured causally, the uncurryThis idiom is worth 1.7 % of that. The headline
> diagnosis below — that `Function.prototype.call.bind` drops the explicit
> receiver — is REFUTED for the standalone arm by 32/40 on a stratified sample of
> this issue's OWN documented signature.**
>
> Everything here is measured with controls. **Do not re-derive it by reading.**

## Instrument calibration (do this before trusting any number here)

Standalone official rows **43,106 / 25,460 pass (59.1 %)** — exact match to
baseline run `20260801-010858`. The propertyHelper population reproduces to the
row: **1,494 pass / 1,810 fail-and-host-pass**.

(My static include-scan finds **5,206** files vs the earlier 4,898. The gap is
**743 files with no official standalone row**, reported rather than dropped. The
two load-bearing numbers match exactly.)

## Attribution instrument — a harness-level kill switch

The four uncurried captures on `propertyHelper.js:29-32` are replaced in a
**private per-worktree harness copy** (symlink restored on every exit path).
`assembleOriginalHarness` caches sources in a module-private `Map`, so an
in-process switch is impossible ⇒ **one arm per process**. Cross-process
comparability was therefore an assumption, so it was **measured**: **arm A run
twice gave 36/36 identical rows.**

| arm    | what it does                                      | verdict                                                                                                                                                      |
| ------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1** | drop only the `call.bind` layer, keep `.call`     | **INSTRUMENT INVALID** — broke all 6 positive controls                                                                                                       |
| **B2** | remove ALL reflective dispatch from the captures  | valid — controls 6/6 in both arms                                                                                                                            |

**B1 is reported despite being discarded**, because it teaches something:
`Array.prototype.push.call(...)` is a **deliberate codegen refusal**
(`src/codegen/array-prototype-borrow.ts:1144`, #1888 Slice 3/4). The stock
uncurried spelling **evades that refusal syntactically**; rewriting it to the
literal `.call` form makes it visible and the compile fails.

B2's controls are load-bearing rather than decorative: `verifyProperty` asserts
`__hasOwnProperty(obj,name)` is **true**, so a green control proves the
*replacement itself* works and is not vacuously passing.

## Result

| sample                                                              | n       | fail→pass       | pass→fail | controls     |
| ------------------------------------------------------------------- | ------- | --------------- | --------- | ------------ |
| random, seeded, from the 1,810                                      | **120** | **2 (1.7 %)**   | 0         | 6/6 both arms |
| stratified — the 217 files carrying THIS issue's documented signature | **40**  | **0 (0 %)**     | 0         | 6/6 both arms |

95 % CI on 2/120 ≈ 0.2–5.9 % ⇒ projected **~30 files of 1,810 (CI ~4–107)**.
95 % upper bound on the stratified 0/40 ≈ 8.8 %.

## WHY it is zero — the mislabel, located

A probe arm labels **where** the throw originates. This is decidable from the
harness's own structure: `verifyProperty` reaches line 48
`__getOwnPropertyDescriptor(obj, name)` **before** line 64's uncurried
`__hasOwnProperty(obj, name)` — and line 27 captures gOPD **directly**
(`var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor`), i.e. **not
via uncurryThis at all**.

On the 40 files carrying this issue's own signature (controls 6/6 valid):

| n         | origin                                                     |
| --------- | ---------------------------------------------------------- |
| **32/40** | `obj` is **ALREADY nullish when `verifyProperty` is entered** |
| 4         | threw at harness line 62                                    |
| 3         | threw earlier still, before the probe                      |
| 1         | threw at harness line 61                                    |

**80 % never reach the uncurried captures.** The receiver is not *dropped* by
`Function.prototype.call.bind` — it is *missing before the call is made*, because
the builtin under test (`Number`, `Date`, `TypedArray.prototype.keys`, …) is
**not reified as a value** in the standalone lane.

⇒ **This is a missing VALUE, not a receiver DROP.** That relabel is the point:
the wrong mechanism is why this issue's 109-test cluster figure never converted,
and leaving it in place guarantees the next lane repeats the work.

## Corrected scope for this issue

- **The standalone arm is "builtin objects are not reified as inspectable
  values"** — bounded at **217 files** (12 % of the 1,810), of which ~80 % show
  the nullish-receiver origin above. Size it by sampling, not by the 217.
- The **`__bindfn` invalid-Wasm cluster** (25 files here, 28 corpus-wide) is a
  **compile-time** sub-mode and stays separate — see `compileFunctionBind`'s
  standalone arm, `src/codegen/expressions/calls.ts:2249-2300`. A synthetic
  `Function.prototype.call.bind(...)` does **not** reproduce it.
- The **host arm remains DONE via #3635**, with the denominator caveat recorded
  above (the `uncurry.mts` harness does not cover length-preserving mutation).
  Nothing measured here contradicts the S1 analysis in `66ab19f84`; it is
  carried forward in this branch rather than left to rot.
- **The dominant cause in this population is NOT this issue** — it is
  **#3976** (class elements not installed as own properties): 826 of the 1,810,
  ~28× this issue's measured lever.

## Method note — what actually generalises

**A routing bound is not a causal bound.** "1,810 files *include* the harness
that reports the failure" proves the files pass *through* the shape; it says
nothing about whether the shape is *why* they fail. The distance between the two
here was **1,810 vs ~30 — a factor of ~60**. The cheap instrument that settles it
is a **kill switch on the suspected mechanism plus positive controls that
exercise the replacement**, and it cost ~40 minutes against an XL estimate.
