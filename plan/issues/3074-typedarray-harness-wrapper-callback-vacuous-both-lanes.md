---
id: 3074
title: "TypedArray harness-wrapper callback never executes → vacuous fail (both lanes; persists after #2939/#2940)"
status: in-progress
assignee: ttraenkler/dev-keystone
sprint: Backlog
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: closures, dynamic-dispatch, typed-arrays, test262-harness
goal: host-independence
related: [2939, 2940, 2903, 2879]
created: 2026-07-06
updated: 2026-07-06
origin: "2026-07-06 /harvest-errors run against baselines @ default run 20260706-034320 (gitHash 2aa204b4) + standalone current.jsonl (6.7.2026)."
---

# #3074 — TypedArray harness-wrapper callback stays vacuous in BOTH lanes

## Summary

The single **largest default-lane failure cluster** and a large standalone
cluster are the same signature:

```
other:vacuous: harness-wrapper callback never executed (##) — no assertion ran
```

- **Default (JS-host) lane: 1,535 records** — 927 `built-ins/TypedArray`,
  553 `built-ins/TypedArrayConstructors`, 46 `built-ins/Atomics`, misc.
- **Standalone lane: 448 records** — TypedArray prototype/ctor tests.

These are test262 files wrapped in the harness helper
`testWithTypedArrayConstructors(function(TA){ … })` /
`testWithBigIntTypedArrayConstructors(function(TA){ … })`. The wrapper's
callback (an `any`-typed closure parameter, invoked as `fn(TA)` inside the
harness) is **never executed**, so no assertion in the body runs and the oracle
correctly reports the test as **vacuous → fail** (the #2940 / de-vacuification
machinery working as intended).

## Why this is filed now (both tracking issues are CLOSED)

- **#2940** (`status: done`) measured this exact cluster on the standalone lane
  and concluded the fix was **blocked on #2939** (dynamic dispatch of an
  `any`-typed closure param must tolerate arity mismatch + coerce arg
  type-kinds). It was closed as a measurement/decision doc, not a fix.
- **#2939** (`status: done`) — the closure-dispatch blocker — has since landed.

**Yet the cluster persists at 1,535 (default) + 448 (standalone).** So either
#2939's fix did not cover the harness-wrapper dispatch path, or a narrower case
landed. Neither closed issue reflects an open feature gap, so these ~1,983
records currently have **no open home**. This issue reopens the work.

Note this is **NOT** a standalone-only / host-import problem: the default
(JS-host) lane shows the *larger* count (1,535), so the harness-wrapper closure
simply is not being invoked regardless of target. This is distinct from #2903
(residual `__make_callback` = host-backed *builtin-method* closures), which is a
separate standalone leak-front.

## Sample files (default lane)

```
built-ins/TypedArray/prototype/fill/fill-values-relative-end.js
built-ins/TypedArray/prototype/filter/callbackfn-return-does-not-change-instance.js
built-ins/TypedArray/prototype/includes/return-abrupt-tointeger-fromindex.js
built-ins/TypedArray/prototype/set/typedarray-arg-offset-tointeger.js
built-ins/TypedArray/prototype/copyWithin/negative-start.js
built-ins/TypedArrayConstructors/ctors/typedarray-arg/proto-from-ctor-realm.js
```

## Suggested investigation

1. Reproduce one file (e.g. `fill/fill-values-relative-end.js`) on current main,
   both `gc` and `standalone` targets, with `trackFallbacks`, and confirm the
   `testWith*TypedArrayConstructors(fn)` closure is entered.
2. Re-verify #2939's dynamic-dispatch fix (`calls-closures.ts`) against the
   specific arity/type shape the harness wrapper uses (`fn(TA)` where `TA` is a
   constructor value passed positionally; the callback declares one param). The
   #2940 measurement noted many wrappers pass a **2-arg** `makeCtorArg` callback
   — check the 2-arg path specifically.
3. If the closure is invoked but the body still no-ops, trace where the
   assertion counter stays at 0 (the vacuity detector keys on
   "no assertion ran").

## Acceptance

- The `vacuous: harness-wrapper callback never executed` signature drops
  materially in BOTH lanes (target: <200 default), i.e. the TypedArray harness
  wrapper actually invokes its callback and the body assertions run.
- No net regression in either lane's pass count.

## Root cause + fix (dev-keystone, 2026-07-07 — VERIFIED EMPIRICALLY)

**Root cause (measured, not spec-derived).** #2939's nested-scope callback
pre-registration in `ensureFuncValueWrappersRegistered`
(`src/codegen/expressions/calls.ts`) was gated on `ctx.standalone`. So the
gc/host (default) lane never registered the harness-wrapper callback as an
inline-dispatch candidate. WAT-verified on current `main`: the higher-order
body's `fn(constructors[i])` compiled to

```
local.get 1; struct.get 2 1; local.get 3; array.get 1  ;; evaluate constructors[i]
drop                                                    ;; DROP the arg
ref.null extern; drop                                   ;; the CALL itself is DROPPED — fn never loaded
```

i.e. `tryEmitInlineDynamicCall` saw ZERO candidates → returned `null` → the
caller's graceful `ref.null.extern` drop ran. The callback body (holding every
assertion) never executed, so the runner's `-262` vacuity gate fired.

Probe result on current `main` (faithful harness wrap, `test()` returns
`1`=executed / `-262`=vacuous): **gc = -262 (VACUOUS), standalone = 1
(EXECUTED)** — the default lane is the broken one (the LARGER cluster, matching
the 1,535 vs 448 harvest counts). The callback DOES compile to a real closure
struct on the gc lane too (`ref.func; struct.new $__fn_wrap_*; extern.convert_any`
— no `__make_callback`), so the runtime value IS a wrapper struct the inline
dispatcher can handle; the only defect was the compile-order candidate gap.

**Fix.** De-gate the pre-registration to run on BOTH lanes (keeping the
all-externref param + externref/void-return restriction that prevents the
over-arity numeric-param invalid-Wasm CE). Safe because: (a) the affected tests
are ALL currently vacuous FAILS, so dispatch can only move them fail→pass or
stay fail (never pass→fail); (b) a callback that instead flows through the
`__make_callback` host path only pre-registers a wrapper TYPE (the struct.new
stays lazy at the value site), whose extra dispatch arm never `ref.test`-matches
a JS-function externref → falls through to the same drop as before.

Verified (both lanes now EXECUTE): 1-arg + 2-arg harness shapes, arity tolerance
(extra arg ignored), and genuine arg-correctness (sum of real per-iteration args
= 100, not a body-runs-but-drops-args false positive). `tests/issue-3074.test.ts`
(4 tests). Zero regressions in the existing closure/dispatch suite (identical
7-fail/24-pass pre-existing count on `main` and branch).

## Corrected scope — any[]-element dispatch (#3083) is a SEPARATE follow-up

This PR fixes the **HOF-callback-invoke** site (`fn(...)` where `fn` is an
`any`-typed parameter) — the ~1487-file TypedArray harness cluster, the keystone.

It does **not** cover the **any[]-element-call** site
(`validators[i](x)` where `validators` is `any[]`/`any` — the #3083 matchAll
cluster, ~13 files). Root cause of THAT gap, verified: `arr[i](args)` routes to
`compileCallableElementAccessCall`, which derives the wrapper struct from the
element type's **static call signatures**. A **typed** `CB[]` element HAS
signatures → dispatches correctly on both lanes (probe: returns 55). An
`any[]`/`any` element has **no call signatures** → the function returns
`undefined` → the drop-everything fallback. Unlike the identifier-callee path,
the element-access path has **no runtime-`ref.test` dispatch fallback**
(`tryEmitInlineDynamicCall` is only reached from the identifier-callee branch,
gated on `isKnownVariable`).

Closing #3083 needs a **bounded but distinct** change: a runtime-`ref.test`
dispatch fallback in the element-access branch (mirroring
`tryEmitInlineDynamicCall`) plus candidate pre-registration for array-literal
element callbacks. It is deliberately NOT bundled here — the element-access
call path is extremely hot, so adding a new dispatcher there carries a broad
regression surface that would jeopardize the clean, high-value keystone win for
only ~13 additional files. It is NOT #2773 substrate (that is about dynamic
value READS returning NaN/null; this is dispatch), so it belongs to #3083's
domain as a follow-up dispatch-shim generalization.

## Measured value + downstream gaps (VERIFY-FIRST — corrects the ~1800 estimate)

Measured on real test262 via `runTest262File` (gc/host lane), branch vs current
`main`:

- **Zero regressions.** 113 currently-passing gc-lane callback tests (two
  samples, non-harness): **0 pass→nonpass flips, 0 changes**. 24-file
  TypedArray/fill+copyWithin + 30-file BigInt-TA harness samples: **0
  pass→fail**. The fix is regression-safe against the current baseline.

- **The keystone is the dispatch ENABLER + honest-classifier, not (yet) a large
  pass-count jump.** The affected harness tests are already scored
  `fail vacuous:true` in the default baseline, and after the fix they EXECUTE
  and **honest-fail on a downstream gap** rather than pass. So the immediate
  merge_group pass-count delta is modest; the durable win is (a) the general
  gc-lane HOF-callback dispatch is now correct (a real compiler bug, benefits
  any compiled higher-order code, not just TypedArray), and (b) ~1487 dishonest
  vacuous scores become honest.

Downstream gaps that gate the harness cluster's vacuous→**pass** realization
(each a separate follow-up; the keystone is a prerequisite for all of them —
without dispatch, none of these bodies run at all):

1. **Dynamic `new TA(...)` on the gc/host lane.** Once the callback dispatches,
   its body does `new TA(...)` where `TA` is an `any`-typed constructor value →
   `No dependency provided for extern class "TA"` (the compiler treats a runtime
   constructor value as a host extern class needing an import). This is the
   dominant honest-fail after the fix (dynamic-constructor gap, #1679 area /
   the "No dependency for extern class" class #812/#814). Standalone hits the
   analogous native-construct gap.
2. **Runner shim faithfulness — non-BigInt `testWithTypedArrayConstructors`
   passes only 1 arg** (`fn(ctor)`), but the REAL test262 harness
   (`testWithAllTypedArrayConstructors`) calls `f(constructor, boundArgFactory)`
   — **2 args**. Many callbacks declare `function(TA, makeCtorArg)` (2 params,
   void); called with 1 arg they are OVER-ARITY VOID candidates, which
   `tryEmitInlineDynamicCall` intentionally SKIPS (#1837 — a void over-arity pad
   makes a stack-invalid `call_ref`), so they stay vacuous even after the
   de-gate (measured: 8/12 non-CE `fill/*.js` still vacuous). Making the
   non-BigInt shim pass a `boundArgFactory` passthrough (mirroring the existing
   BigInt shim) matches the real harness and lets the 2-param callbacks
   dispatch. Deliberately NOT bundled here — it is coupled to the honest-baseline
   rework (#3086/dev-honest is measuring against the current shim), and the
   value is still gated on gap (1). A clean follow-up once the honest baseline
   lands.
3. **BigInt TypedArray i64 codegen CE** (`Binary emit error: RangeError: offset
   is out of bounds`) — ~22/30 sampled BigInt-TA files; pre-existing, unrelated
   to dispatch.
