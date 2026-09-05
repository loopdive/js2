---
id: 4661
title: "IsConstructor bit for compiled closures — Reflect.construct newTarget, and `new arrow()` / `new gen()` must throw"
status: done
sprint: current
created: 2026-08-23
updated: 2026-08-23
completed: 2026-08-23
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
related: [4649, 4626, 4394]
files:
  - src/codegen/closure-exports.ts
  - src/codegen/callback-ctor-bridge.ts
  - src/runtime.ts
loc-budget-allow:
  - src/codegen/closure-exports.ts
  - src/codegen/index.ts
  - src/codegen/closures.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/runtime.ts::resolveImport
  - src/codegen/closures.ts::compileArrowAsClosure
---

# IsConstructor bit for compiled closures

Split out of #4649 (PR #4804), whose agent established the root cause and
rejected the naive repair with measurements. **This is the last failing
harness self-test across both lanes.**

Goal: 100% of `test262/test/harness/` in BOTH lanes. State once the four
in-flight PRs land (#4812, #4811, #4804, #4810): standalone **116/116**,
js-host **115/116** with only `isConstructor.js` left.

## Root cause (established, do not re-derive)

The harness include does:

```js
function isConstructor(f) {
  if (typeof f !== "function") throw new Test262Error(...);
  try { Reflect.construct(function(){}, [], f); } catch (e) { return false; }
  return true;
}
```

`__reflect_construct_newtarget` wraps a wasm-struct `newTarget` with
`_wrapForHost`, which is **not callable**, so V8's IsConstructor(newTarget)
check (§26.1.2 step 3) rejects every compiled function — `isConstructor` answers
`false` for `function(){}` and for `Array`. (`Array` as newTarget passes; the
TARGET argument passes only because it is an inline function EXPRESSION and so
takes #4394's `__make_callback_ctor` constructible bridge.)

**The naive repair is wrong in the other direction.** Routing closure structs
through `_wrapCallableForHost` the way `__construct_closure` already does makes
every closure look constructible, and the compiler has **no runtime notion of
constructibility at all**. Measured on main:

```js
new arrow();   // succeeds — spec §15.2.4 says TypeError
new gen();     // succeeds — spec says TypeError
```

So arrows and generators would start reporting `isConstructor === true` and the
test's three `false` assertions would fail instead. The test asserts BOTH
directions:

```js
assert.sameValue(isConstructor(function(){}), true);
assert.sameValue(isConstructor(function*(){}), false);
assert.sameValue(isConstructor(() => {}), false);
assert.sameValue(isConstructor(Array), true);
assert.sameValue(isConstructor(Array.prototype.map), false);
```

## Implementation Plan

The capability needed is an **IsConstructor bit reachable from an opaque
closure value** at runtime.

1. **Reuse the compile-time predicate.** `callableHasConstructBehavior`
   (`src/codegen/callback-ctor-bridge.ts`) already encodes §15.2.4 correctly
   (ordinary function declarations/expressions and classes are constructible;
   arrows, generators, async functions, methods and accessors are not). Do not
   write a second predicate.
2. **Preferred design (from #4649's sketch): a per-allocation constructible
   flag in the closure wrapper struct**, plus a `__is_ctor_closure` export
   mirroring the existing `__is_closure` (`closure-exports.ts`, bit 17).
   Consumers to update: `__reflect_construct*`, `__construct`,
   `__construct_closure`.
   - The flag is per-ALLOCATION, not per-type — see (3).
3. **Rejected alternative, do not take it:** distinct root wrapper types for
   non-constructible callables. Two closures of the same signature would stop
   being assignable to one slot, which breaks the wrapper-root selection the
   codebase depends on (#3205).
4. **`new arrow()` / `new gen()` must throw a catchable TypeError** once the bit
   exists — that is the same capability seen from the other side, and it is what
   keeps the test's `false` assertions honest. Check how many currently-passing
   test262 tests depend on the present (wrong) permissive behaviour BEFORE
   changing the construct path; if the sweep shows regressions, report them
   rather than widening the PR.
5. Standalone: the test passes there today. Establish WHY before touching shared
   code so the fix cannot flip standalone red.

## Acceptance criteria

- `test262/test/harness/isConstructor.js` passes js-host — **both** the `true`
  and the `false` assertions.
- js-host full harness category reaches **116/116**; standalone stays
  **116/116**.
- js-host 60-sample 59/60 (`AsyncDisposableStack` failure is pre-existing);
  equivalence gate no new regressions beyond the 24 baseline known-failures.
- A broad js-host sweep over `new`-using and `Reflect.construct`-using tests
  shows no regression from making arrows/generators non-constructible.

## Progress (2026-08-23) — FIXED

`test/harness/isConstructor.js` passes js-host. The design the plan asked for
turned out to be **already built and merely lane-gated**, and two of the plan's
"established, do not re-derive" facts do not reproduce on this branch's base.

### The two inherited claims that are FALSE on this base

Measured with `.tmp/p1-ctor.mts` (js-host, on `origin/main` before any edit):

```
ordinary=false  arrow=false  gen=false  Array=true  Amap=false
newArrow=threw  newGen=SUCCEEDED  newOrd=ok
```

| plan claim | measured on this base |
| --- | --- |
| "`isConstructor` answers false for `function(){}` **and for `Array`**" | `Array` answers **true**. Only the compiled-function case is wrong. |
| "`new arrow()` succeeds — spec says TypeError" | `new arrow()` **already throws**. Only `new gen()` still succeeds. |

So the scope was ONE wrong answer, not five, and the feared
"three `false` assertions would fail instead" hazard was already absent: arrows
and generators answer `false` correctly *because* they never get the
constructible representation. Re-measure before inheriting a number.

### Root cause (confirmed, and narrower than written)

`__reflect_construct_newtarget` wraps a wasm-struct `newTarget` with the
non-callable `_wrapForHost`, so V8's §26.1.2 step-3 IsConstructor(newTarget)
rejects it. Confirmed. But the missing capability was **not** missing:

`getOrCreateConstructibleFuncRefWrapperTypes` (#3371,
`closures/funcref-wrapper-types.ts`) already mints a nominally distinct struct
**subtype** `__constructible_fn_wrap_N_struct` — one extra `$__constructible
i32` — for ordinary function declarations/expressions, and registers every such
type in `ctx.constructibleClosureTypeIdxs`. The standalone
`__reflect_is_constructor` (`reflect-construct-native.ts`) answers IsConstructor
from exactly that set.

**That is WHY standalone passes this test and js-host does not** — the question
the plan asked to establish before touching shared code. The mechanism was
gated `noJsHost(ctx) || targetProfile.semanticProviders === "native-first"` at
all four of its derivation sites, so in the js-host lane
`constructibleClosureTypeIdxs` was **empty** (measured: `ctorTypeIdxs = 0`), and
no export over it could have answered anything.

### Design taken

1. **Ungate constructibility.** §15.2.4 constructibility is a property of the
   source function, not of the target profile. Removed the lane conjunct at
   `closures.ts` (function expressions), `funcref-as-closure.ts` ×2
   (declarations, hoisted eager binding) and
   `ordinary-fn-constructibility.ts` (the normalizer).
2. **Deduped the predicate** the plan warned about: the function-expression
   mint site carried an open-coded copy of §15.2.4; it now calls
   `callableHasConstructBehavior` (#4394).
3. **`__is_ctor_closure` export**, bit 17 / `$ch` — a `ref.test` chain over the
   SAME `constructibleClosureTypeIdxs` registry, so the two lanes cannot drift
   to two answers. No new struct field, no new allocation site, no second
   predicate. Emitted BEFORE `emitClosureHasRestExport`, which seals the
   availability manifest.
4. **Runtime `_wrapForHostByConstructibility`** chooses the constructible
   callable proxy vs the plain mirror; `__reflect_construct_newtarget` uses it
   for `newTarget` only. `newTarget` is never invoked there — §26.1.2 only
   classifies it and reads `.prototype` — so no call semantics change.

The rejected alternative stays rejected and was never needed: the registry is
over **subtypes** of the wrapper root, so root assignability (#3205) is intact.

### The trap this change hides (read before adding bit 18)

Publishing bit 17 widens the closure-host-bridge binding table from 17 to 18.
`_isExactFuncrefTable` authenticates that table by **instantiating a hardcoded
probe module whose min/max are literal bytes** (`…, 112, 1, 17, 17`). Bumping
only the codegen table size leaves the probe at 17, authentication fails
silently, and the runtime falls back — degrading `typeof <closure>` from
`"function"` to `"object"` for EVERY compiled closure. Caught by A/B: the first
cut regressed all three `typeof` answers to `notfn` while `isConstructor` still
"worked". A future bit 18 must edit that byte array too
(`runtime.ts::_isExactFuncrefTable`, the `size: 0 | 2 | 18` union and the third
`bytes` arm).

### Deliberately NOT done: `new gen()`

`new gen()` still succeeds where §15.2.4 says TypeError. It is the one residual
of the plan's item 4, and this test does not exercise it (`isConstructor(gen)`
answers `false` via the `newTarget` path, correctly). Making it throw means
gating `__construct_closure`'s `_wrapCallableForHost` on `__is_ctor_closure`
instead of `__is_closure` — a live change to `new`-expression semantics for
every compiled function value, which the plan explicitly said to report rather
than widen into this PR. See the measurement in the table below.

### Measurements (this worktree, base = `origin/main` @ `975143f92`)

Every number below was measured on THIS branch — none inherited. The quickjs
eval provider was rebuilt (`scripts/build-quickjs-eval-provider.mjs`) before
each lane measurement; without it four standalone files fail with "provider is
not built", which is a local artifact, not a lane result.

| run | before | after |
| --- | --- | --- |
| js-host `test/harness/` (`.tmp/run-harness-all-host.mts`) | **111 / 116** | **112 / 116** |
| standalone `test/harness/` (`.tmp/run-harness-all.mts`) | **115 / 116** | **115 / 116** |
| js-host 60-file sample (`.tmp/host-sample.txt`) | 59 / 60 | **59 / 60** |
| `equivalence-gate.mjs`, all 8 shards (`SHARD=n/8`) | 24 known-failures | **8/8 "No new equivalence regressions"** |
| construct-semantics sweep, 1437 files (`.tmp/construct-sweep.txt`) | **862 / 1437** | **881 / 1437** (+19, **0 lost**) |

### Re-measured after the catch-up merge of `origin/main` @ `f6e094cdb`

`#4812` landed while this branch was in validation, so the branch was re-merged
and both categories re-run on the merged tree (quickjs provider rebuilt first):

| lane | merged tree |
| --- | --- |
| standalone `test/harness/` | **116 / 116 — the goal, met** |
| js-host `test/harness/` | **112 / 116** |

The four js-host residuals are `deepEqual-deep`, `verifyProperty-value`,
`asyncHelpers-throwsAsync-custom-typeerror` and `wellKnownIntrinsicObjects` —
all owned by #4804 / #4811 / #4810, none of which had landed. `isConstructor.js`
is no longer among them, so js-host reaches 116/116 when those merge.

### The construct-semantics sweep (+19 / −0)

The sweep is every one of the 849 `Reflect.construct`-using test262 files plus a
deterministic 1-in-18 stride over the 10,651 `new`-using files under
`test/language/`, `built-ins/{Function,Proxy,Reflect,Object}` — 1437 files,
js-host, run before AND after on this branch. Nothing regressed. The 19 gains
are all the same shape, which is itself the confirmation that the fix does what
it claims: a compiled function used as `Reflect.construct`'s **newTarget**, whose
`.prototype` §10.1.13 OrdinaryCreateFromConstructor then reads.

```
+ built-ins/ArrayBuffer/newtarget-prototype-is-not-object.js
+ built-ins/SharedArrayBuffer/newtarget-prototype-is-not-object.js
+ built-ins/Proxy/construct/{call-parameters-new-target,trap-is-null,
                             trap-is-undefined,trap-is-undefined-no-property}.js
+ built-ins/DataView/custom-proto-if-{not-object-fallbacks-to-default-prototype-sab,
                                      object-is-used-sab}.js
+ built-ins/TypedArrayConstructors/**/use-custom-proto-if-object{,-sab}.js  (×10)
+ harness/isConstructor.js
```

Two sweep-method notes for whoever repeats this: a handful of test262 files throw
**asynchronously** out of a disposal/microtask path, which escapes a per-file
`try/catch` and kills the runner process (this run died at 1200/1437 and lost the
whole result, since the original script only wrote its JSON at the end).
`.tmp/sweep.mts` now checkpoints after every file, skips already-recorded files
and installs `uncaughtException`/`unhandledRejection` handlers, with
`.tmp/sweep-loop.sh` restarting it across crashes. Also: the quickjs eval
provider must be rebuilt after the `git checkout origin/main -- src/` that
establishes the before-state, or the base numbers are measured against a stale
adapter.

### Residual: `new gen()` (measured, deliberately not fixed here)

| | base | after |
| --- | --- | --- |
| `new arrow()` | throws ✓ | throws ✓ |
| `new gen()` | **succeeds ✗** (spec: TypeError) | **succeeds ✗** |
| `new ordinaryFn()` | ok ✓ | ok ✓ |

`new arrow()` was ALREADY correct on the base, contrary to the plan. Only
generators are still wrongly constructible. The one-line fix now available is to
gate `__construct_closure`'s `_wrapCallableForHost` on `__is_ctor_closure`
instead of `__is_closure` (`runtime.ts` ~L13990) — the bit this PR adds is
exactly what that needs. It is NOT taken here because it changes `new`-expression
semantics for **every** compiled function value, not just generators: any value
whose constructibility classification is imperfect (synthesized functions with no
owner declaration, class ctors, which take the separate `_classCtorClosures`
path) would start throwing where it now succeeds. That is a second construct-path
change needing its own before/after sweep, and this issue's plan said to report
rather than widen. Recommend a follow-up issue.

The js-host base is **111, not the 115 this issue predicted**: #4804, #4811 and
#4810 had not landed when this branch was cut, so `deepEqual-deep`,
`verifyProperty-value`, `asyncHelpers-throwsAsync-custom-typeerror` and
`wellKnownIntrinsicObjects` still fail on the base. The `+1` is exactly
`isConstructor.js`; the other four failures are byte-identical before and after.
Once those PRs land the category should read 116/116.

The standalone `115/116` residual is `asyncHelpers-asyncTest-return-not-thenable`,
identical before and after — this change does not touch the standalone
`__reflect_is_constructor` path, which is `ctx.standalone`-gated in
`call-namespace-static.ts`.

The equivalence gate is the load-bearing check here, not the harness numbers:
ungating constructibility changes the STRUCT LAYOUT of every ordinary function
value in the js-host lane (a nominal subtype with one extra i32), so the risk is
structural — `ref.cast`, wrapper-root selection, `typeof`, arity reads — not
limited to `new`. All eight shards are clean against the 24-known-failure
baseline.

## Permanent repro

`test262/test/harness/isConstructor.js` (js-host lane,
`tests/test262-runner.ts` `runTest262File(..., undefined)`).
