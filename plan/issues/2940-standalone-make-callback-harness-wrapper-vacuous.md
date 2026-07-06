---
id: 2940
title: "standalone: __make_callback sole-leak is the harness-wrapper vacuous pass — gated on dynamic-closure-dispatch arity/type tolerance (sub-front 4 of #2903 yields 0)"
status: done
completed: 2026-07-02
sprint: 69
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: closures, dynamic-dispatch, typed-arrays, test262-harness
goal: host-independence
assignee: ttraenkler/dev-f1
related: [2939, 2903, 2879, 2075]
blocked_on: "#2939 (formerly #2923; arity half landed via PR #2441): dynamic dispatch of `fn(...)` on an any-typed closure param must tolerate arity mismatch + coerce arg type-kinds (calls-closures.ts) — otherwise removing the import yields DISHONEST vacuous host-free passes"
created: 2026-07-02
updated: 2026-07-03
origin: "2026-07-02 __make_callback sole-leak-front measurement (dev-callback). origin/main @ 4d5287afc, target standalone, merged report run 28491700781."
---

# #2940 — `env::__make_callback` sole-leak: measured root cause + yield gate

> Formerly drafted as #2921, then #2931, then #2937 on this branch; all three
> ids were concurrently taken on main by parallel sessions (2921 =
> drain-microtasks intrinsic PR #2425; 2931 =
> live-binding-reassigned-function-decl; 2937 =
> acorn-host-object-hash-poison-null-deref-regression). Reallocated to #2940
> to clear the `check:issue-ids:against-main` collision (each hop via
> `claim-issue.mjs --allocate`).

## TL;DR / decision

The 1,364 standalone sole-`__make_callback` passes are **NOT** flippable by
TypedArray HOF native bodies (sub-front 4 of #2903): measured yield **0**. All
601 TypedArray files leak from the test262 **harness wrapper**
(`testWithBigIntTypedArrayConstructors(function(TA){…})`), not any HOF. Adding
the missing runner shim removes the import, but the bodies **stay vacuous** — the
compiler's dynamic dispatch of a closure held in an `any`-typed parameter
(`fn(ctor, factory)` inside the shim) only invokes the closure when the call
arg-count **and** arg type-kinds exactly match the callback's declared params.
So a shim-only change converts an _honestly-flagged_ leaky-pass into a
**dishonest clean (host-free) vacuous pass** — metric goes up but tests nothing.
**Genuine-flip yield with a bounded fix = 0**, below the 200 build-gate →
**blocked**, pending the dynamic-dispatch fix below.

The original import-gate hypothesis (#2405 pattern) is disproven: the import is
_referenced_ (`WebAssembly.instantiate(binary, {})` rejects `Import #0 "env"`),
consistent with merged research #2903.

## Measurement (origin/main @ 4d5287afc, `target: standalone`, run 28491700781)

- Sole-leak set (`status==pass`, `imports==["env::__make_callback"]`): **1,364**;
  total `__make_callback` touches: **5,572**. (Matches the brief.)
- Category: **TypedArray\* 601** (348 TypedArray + 253 TypedArrayConstructors),
  **Temporal 707**, Iterator 18, other 38.
- Of the 601 TypedArray: **601/601** contain the `testWith*Constructors(function…)`
  wrapper; **572** use `testWithBigIntTypedArrayConstructors`; only **~202** even
  call a HOF method; 337 use a 2-arg (`makeCtorArg`) callback.

### Why sub-front 4 yields 0

Live trace (`TypedArray/prototype/every/BigInt/callbackfn-returns-abrupt.js`,
standalone) shows the two `__make_callback` emissions are:

- the `function(TA, makeCtorArg){…}` **wrapper** → `compileArrowAsCallback` from
  `src/codegen/expressions/calls.ts:13393` ("graceful fallback for unknown
  functions": `testWithBigIntTypedArrayConstructors` is unresolved in `funcMap`);
- `assert.throws(T, function(){})` → closed-method dispatch (`calls.ts:11624`).

Neither is a HOF callback; the import is module-scoped, so native HOF bodies
remove **zero** imports.

### Why the wrapper is unresolved (runner shim gap)

`tests/test262-runner.ts` shims `testWithTypedArrayConstructors` but:

1. the gate `needsTestTypedArray` tested `/testWithTypedArrayConstructors/`,
   which does **not** match `testWith`**`BigInt`**`TypedArrayConstructors`;
2. no `testWithBigIntTypedArrayConstructors` shim existed;
3. the shim passed only 1 arg (`fn(ctor)`), so tests declaring
   `function(TA, makeCtorArg)` got `makeCtorArg === undefined`.
   A prototype shim (BigInt wrapper + a passthrough `makeCtorArg`, fixed regex)
   removes the import and instantiates **host-free** — confirmed on samples.

### But it stays VACUOUS — the real blocker

With the shim, the wrapper resolves and the callback goes the closure path (no
`__make_callback`), yet injecting `throw`/`log()` as the wrapper body's first
statement **never fires**. Isolated repro (`.tmp`) pins the compiler gap in the
dynamic dispatch of `fn(...)` where `fn` is an `any`-typed param
(`src/codegen/expressions/calls-closures.ts`, e.g. the exact-arity gate at
L688 `if (info.paramTypes.length !== sigParamCount) continue;` + the per-param
kind check L693–698):

| call                   | callback params     | invoked?                                |
| ---------------------- | ------------------- | --------------------------------------- |
| `fn(x)`                | `(TA)`              | YES                                     |
| `fn(x, y:number)`      | `(TA, m)`           | YES                                     |
| `fn(x)`                | `(TA, m)`           | NO (arity)                              |
| `fn(x, y)`             | `(TA)`              | NO (arity)                              |
| `fn(ctor[i], namedFn)` | `(TA, makeCtorArg)` | NO (arg type-kinds != externref params) |

Real 2-param BigInt tests: 25/25 sampled stay **vacuous** with the shim (the
shim passes a constructor value + a funcref, whose kinds don't match the
callback's `any`/externref params -> dispatch skips). So **genuine-flip yield with
shim alone = 0**, and shipping it would be _harmful_ (dishonest host-free
vacuous passes).

## The real fix (2 parts) — gated, not built

1. **Runner shim** (`tests/test262-runner.ts`): add
   `testWithBigIntTypedArrayConstructors` + a `makeCtorArg` passthrough factory,
   fix the `needsTestTypedArray` regex to `/testWith(?:BigInt)?TypedArrayConstructors/`.
   (Prototype done on this branch; do NOT ship alone.)
2. **Compiler — dynamic closure dispatch of an `any`-typed param**
   (`src/codegen/expressions/calls-closures.ts`): make `fn(...)` invoke the
   matched closure under **JS arity semantics** (pad missing args with
   `undefined`, drop extras) and **coerce args to the closure's param kinds**
   instead of requiring exact arg-count/type-kind match. This is a hot, fragile
   core-dispatch path — scope/verify carefully; it is a _general_ improvement
   (any dynamic `fn(...)` with arity/type mismatch), not TypedArray-specific.
3. Only then does genuine PASS depend on the underlying BigInt
   TypedArray/detached-buffer/species semantics per test — unmeasured, likely
   partial. Corpus OUTPUT-vs-js-host diff required before shipping (a vacuous
   host-free pass must be counted as a fail, not a pass, by the harness).

## Metric-safety caveat (corrects the earlier framing)

"Removing the import can only move the honest metric up" holds **only if the
body actually executes**. With the current compiler it does not — the shim
alone produces host-free _vacuous_ passes, which is a **dishonest** metric gain.
Metric-safety is contingent on part (2) landing.

## Status

Blocked pending the dynamic-dispatch fix (part 2). Genuine-flip yield with a
bounded fix = 0 (< the 200 build-gate). Analysis delivered; claim released;
recommend spinning part (2) as its own scoped codegen issue (broad value beyond
this leak). Import-gate hypothesis disproven; sub-front 4 disproven.

**Re-measured 2026-07-02 (dev-f2, task #16) after PR #2441 (arity fix)
landed: STILL BLOCKED — genuine flips remain 0.** The arity half works at
module top level, but the runner wraps every test body inside
`export function test()`, and a callback function-expression defined in a
nested scope is NOT a dispatch candidate — so the shimmed wrapper compiles
host-free with a dead body (9/9 sampled host-free files VACUOUS by
inject-throw; control on main = honestly leaky). Shim NOT shipped. Full data +
the deferred shim text now live in #2939 ("Re-measurement post PR #2441").
Remaining blocker = #2939 (a) nested-scope candidate registration, then
(b) kind coercion.

---

## Resolution (dev-f1, 2026-07-02) — vacuity scorer (PR1) + dynamic-dispatch fix (PR2)

The metric-safety caveat above is now ENFORCED IN THE RUNNER, and the
dynamic-dispatch fix (part 2 / #2939) is built. Delivered as two sequenced PRs.

### PR1 — runner vacuity scorer (this issue) — the integrity correction

**Mechanism (runner-only, no codegen change):** the preamble adds a
`__harness_cb_expected` sentinel that the `testWith*Constructors` wrappers bump
per callback invocation they attempt; `test()` returns a distinct `-262` when a
would-be-pass had an invoked harness wrapper but ZERO counted asserts (the
callback was dead). That is scored `status: fail` + `vacuous: true` marker so
`host_free_pass` / the standalone floor structurally EXCLUDE it (a dead callback
is not a pass — the durable vacuity rule, now enforced not just documented).
Wired through all three exec paths (`runTest262File`, the compiler-pool worker,
the fixture path) + a `build-test262-report` counter. Chose `fail`+marker over a
new status enum (206 status-consumers → too much blast radius for a one-way-door
change). Also ships the BigInt-TA runner shim (`testWithBigIntTypedArrayConstructors`

- passthrough `makeCtorArg`, fixed `needsTestBigIntTypedArray` regex) so the
  BigInt wrappers are invocable and thus measurable.

**Integrity correction (measured, all 1,612 harness-invoking files, standalone):**
**1,433** tests reclassify pass → vacuous-fail — **1,421** in
`built-ins/TypedArray{,Constructors}` (696 BigInt-variant + 725 non-BigInt) +
**12** in outside-dir harness-invokers (`built-ins/Array/*/callbackfn-resize-arraybuffer.js`).
`host_free_pass` **17,802 → 16,369**. CE rate unchanged (~3.5%, pre-existing
BigInt unsupported-feature CEs — the shim adds none). ZERO non-vacuous pass→fail
collateral (the `__assert_count === 1` guard never flags a test that ran any
real assertion). The committed standalone high-water mark is re-seeded downward
(the floor asserts-then-raises and never auto-lowers, so a deliberate correction
must be committed; post-merge `promote-baseline --update` raises it to the true
CI number). **Re-ground after the 12-PR merge wave:** main's mark rose 17,802 →
18,790 while the PR was parked, so the committed re-seed is **17,357 = 18,790 −
1,433**, with a documented caveat that the −1,433 delta is from base 854ad5729
(re-measurement on the merged tree timed out at budget wind-down; #2470/#2480
plausibly shifted vacuity membership slightly). The #1897 standalone regression
guard bot-parks the merge_group with the vacuity signature; the shepherd
verifies the delta is ALL-vacuous (every flip carries `vacuous: true`, zero
non-vacuous collateral) rather than an exact count, and the tech lead
admin-merges.

### PR2 — dynamic closure-dispatch fix (#2939)

The nested-scope root cause: a callback function-expression defined INSIDE
another function (the runner's `export function test()` wrap) registered its
funcref-wrapper type only lazily at its later-compiled value site, so the
higher-order body's `fn(...)` dispatch saw ZERO candidates and dropped the call.
Fix: `computeClosureWrapperSig` extraction + pre-registering the identical
wrapper type for inner-scope callbacks (restricted to the all-externref harness
shape — which also fixed 5 invalid-Wasm CEs from over-arity numeric-param
candidates). Standalone-gated; gc byte-identical. With PR1's scorer already in
place, PR2's vacuous→executing conversions can only move `host_free_pass` UP
(genuine passes gained; honest fails stay excluded either way).

**Sub-front-4 conclusion stands:** the win was never a HOF-body flip — it was
(a) making the dead callbacks EXECUTE (PR2) and (b) scoring the still-dead ones
honestly (PR1). The final honest `host_free_pass` + gap are reported once both
land.

---

## Re-measurement + park-signature verification (opus-2, 2026-07-02, CI-FIX #2463)

DIRTY resolved: merged `upstream/main` (mark rose 18,790 → 18,812), re-derived
the highwater re-seed **17,379 = 18,812 − 1,433** (same caveat: the −1,433 delta
is from base 854ad5729, not re-measured on the merged tree).

**The "12 non-vacuous regressions" were investigated by direct standalone
re-measurement (`runTest262File(..., "standalone")` over the full 705-file
BigInt-TA baseline-pass corpus). Verdict: this PR introduces ZERO un-excused
non-vacuous standalone regressions.** Every BigInt-TA baseline pass was a LEAKY
pass (705/705, 0 host-free), so any flip to a host-free non-pass is auto-excused
by the #1897 guard's `--exclude-leaky-baseline-regressions`. Full classification
of the 705:

| class                                   | count | disposition                       |
| --------------------------------------- | ----- | --------------------------------- |
| `VACUOUS` (marked `vacuous:true`)       | 698   | intended park signature           |
| leaky-pass → **host-free** non-pass     | 5     | AUTO-EXCUSED (cross-realm, below) |
| still-pass (genuine)                    | 2     | fine                              |
| **leaky-fail, un-excused, non-vacuous** | **0** | ← the only bad class; none        |

The 5 excused flips are the cross-realm OtherTA detached-buffer tests
(`internals/{DefineOwnProperty,Get,GetOwnProperty,HasProperty,Set}/BigInt/…-realm.js`).
Root cause: the `$262.createRealm()` runner stub returns a realm whose `global`
carries no constructors, so once the BigInt wrapper shim makes the callback
dispatch (PR #2441 arity fix on main), `other[TA.name]` is `undefined` and the
callback throws BEFORE any assertion. These genuinely cannot pass standalone
(dynamic realm-property access + `Reflect.construct` + cross-realm are all
unsupported — verified: exposing the constructors on the realm stub does NOT
help, `other[TA.name]` stays undefined and proto-from-ctor hits
`Reflect.construct not supported in standalone`). They flip leaky-vacuous-pass →
honest host-free fail, which is the CORRECT honest classification and is
auto-excused. The task's other buckets reconciled: the "5 proto-from-ctor-realm"
were NOT standalone-baseline-pass (no flip); the "1 async-gen invalid-wasm"
(`ctors-bigint/object-arg/as-generator-iterable-returns.js`, `__closure_3`
compile failure) was ALREADY `compile_error` on the standalone baseline (CE→CE,
no flip). The "No dependency provided for extern class OtherTA" wording is the
HOST-lane message for the same root cause; on host the ≤12 flips sit far below
the #1668 catastrophic threshold (200).

**LEAD verification recipe (admin-merge, intentional-negative):** run
`diff-test262.ts <standalone-baseline> <merged-standalone.jsonl> --exclude-leaky-baseline-regressions`.
Every remaining counted regression must carry `vacuous:true` /
`"vacuous: harness-wrapper callback never executed"`. The excused set is the
handful of leaky-baseline→host-free cross-realm flips (≤5 BigInt-TA + their
non-BigInt siblings). Zero un-excused non-vacuous collateral. `promote-baseline
--update` raises the mark to the true CI number post-merge.

**Follow-ups (separate issues, NOT blocking this PR):** (a) `$262.createRealm()`
single-realm stub cannot model cross-realm constructor access standalone;
(b) `Reflect.construct` unsupported standalone; (c) latent `__closure_3`
invalid-wasm on `as-generator-iterable-returns.js` (pre-existing CE). None are
PR-caused regressions.

## Harvest 2026-07-05 — residual flag (default lane)

Error-harvest against baselines run `20260705-102746` (gitHash `5a965dfa`, =
current upstream/main − 3 commits) finds **1,496 DEFAULT-lane** official
failures still self-citing `#2940` with `"vacuous: harness-wrapper callback
never executed — no assertion ran"` (top default-lane citation by a wide
margin). This issue was scored/closed on the **standalone** lane; the
default-lane vacuous set is a distinct, still-open manifestation. Sample
cluster: `built-ins/TypedArray/prototype/fill/fill-values-relative-end.js`,
`built-ins/Array/prototype/fill/resizable-buffer.js`. Root cause of the
default-lane subset is almost certainly **#1524** (harness `ctors` /
resizable-buffer fixture globals `is not defined` → the assertion callback
throws before running → vacuous fail), not a #2940 codegen regression. Not
reopening #2940; flagging for triage — the fix belongs in #1524 (harness
fixture), which remains `backlog`.

## 2026-07-06 harvest note — cluster PERSISTS, reopened as #3074

`/harvest-errors` (default run 20260706-034320; standalone current 6.7.2026)
finds the `vacuous: harness-wrapper callback never executed` signature STILL at
**1,535 default + 448 standalone** even though the blocker #2939 (any-typed
closure dynamic-dispatch arity/type tolerance) has since landed `done`. So
either #2939 did not cover the harness-wrapper dispatch path or only a narrow
case landed. Tracked forward in **#3074** (both lanes; largest default cluster).
