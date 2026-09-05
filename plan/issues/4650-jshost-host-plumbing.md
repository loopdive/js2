---
id: 4650
title: "js-host: host-plumbing harness self-tests — fnGlobalObject, detachArrayBuffer, testTypedArray"
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
trap-growth-allow:
  count: 16
  reason: "Stale-baseline reclassification carried from merged PR #4794 (realm shim #4634): createRealm().global became a narrowed forwarding object, so 16 cross-realm tests that were ALREADY failing (all baseline fail) null-deref instead of failing an assertion. The js2wasm-baselines JSONL has not re-promoted since, so every queued PR sees the same +15/16 null_deref growth it did not cause. Named per #3596; failure-flavour reclassification only - no baseline-pass test traps."
  tests:
    - test/built-ins/AsyncFunction/proto-from-ctor-realm.js
    - test/built-ins/AsyncGeneratorFunction/proto-from-ctor-realm-prototype.js
    - test/built-ins/AsyncGeneratorFunction/proto-from-ctor-realm.js
    - test/built-ins/Function/internals/Call/class-ctor-realm.js
    - test/built-ins/Function/internals/Construct/derived-return-val-realm.js
    - test/built-ins/Function/internals/Construct/derived-this-uninitialized-realm.js
    - test/built-ins/GeneratorFunction/proto-from-ctor-realm-prototype.js
    - test/built-ins/GeneratorFunction/proto-from-ctor-realm.js
    - test/built-ins/Proxy/apply/arguments-realm.js
    - test/built-ins/Proxy/construct/arguments-realm.js
    - test/language/eval-code/indirect/realm.js
    - test/language/expressions/async-generator/eval-body-proto-realm.js
    - test/language/expressions/generators/eval-body-proto-realm.js
    - test/language/expressions/tagged-template/cache-realm.js
    - test/language/types/reference/get-value-prop-base-primitive-realm.js
    - test/language/types/reference/put-value-prop-base-primitive-realm.js
files:
  - src/codegen/expressions/undeclared-callee.ts
  - src/codegen/expressions/dynamic-function-ctor-value.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/property-access-dispatch.ts
  - src/runtime/dynamic-function-import.ts
  - src/runtime.ts
# (#4650) Gate allowances. The implementation bodies were extracted into three
# NEW modules (undeclared-callee.ts, dynamic-function-ctor-value.ts,
# runtime/dynamic-function-import.ts), so call-identifier.ts and runtime.ts
# SHRANK. What remains is irreducible:
#  - calls.ts / compileCallExpression: a new arm in an ordered dispatch chain,
#    where the arm's POSITION is the semantics (after the constant
#    compile-away, before the generic any-callee dispatch). +9 LOC, all of it
#    the guarded delegation + its ordering note.
#  - src/runtime.ts::<anonymous>#89: a pure RENUMBERING artifact, not growth.
#    Extracting the __extern_new_function arm removed three block-bodied arrows
#    ahead of it, so a pre-existing 390-line anonymous function moved from
#    ordinal #92 to #89. Verified by A/B: `collectFunctionSizes` reports exactly
#    one >300-LOC anonymous unit in runtime.ts on both the base and the branch,
#    both 390 lines.
loc-budget-allow:
  - src/codegen/expressions/calls.ts
func-budget-allow:
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/runtime.ts::<anonymous>#89
---

# js-host: host-plumbing harness self-tests — 3 failures

Goal context: 100% of `test262/test/harness/` in BOTH lanes; js-host is at
102/116 (2026-08-23, branch `claude/harness-standalone-green`,
`.tmp/run-harness-all-host.mts`). This issue owns three unrelated singles that
all touch host/global plumbing:

| test | js-host error |
| --- | --- |
| `fnGlobalObject.js` | `TypeError: null is not a function in __module_init` — the include's `Function("return this;")()` (string-body Function constructor) compiles to a null callee. Also requires `fnGlobalObject() === this` at top level (global `this` identity) |
| `detachArrayBuffer.js` | Expected ReferenceError NOT thrown — the test (no includes!) calls bare `$DETACHBUFFER(ab)` and REQUIRES a ReferenceError because the identifier is undeclared. Either the runner/shim leaks a `$DETACHBUFFER` definition into js-host tests, or the compiler fails to throw ReferenceError for an undeclared identifier call |
| `testTypedArray.js` | `callCounts[name]` is `undefined`, expected `8` — the harness counts constructor invocations in an object keyed by ctor name across `testWithTypedArrayConstructors`; computed-string-key accumulation (`callCounts[name] = (callCounts[name] ?? 0) + 1`-shape) or the ctor `.name` read is broken |

## Implementation Plan (initial — deepen before implementing)

1. **fnGlobalObject**: check how `Function(...)` (called AS function, string
   body) lowers in js-host. If a host-eval import exists (js-host has host
   `eval`), route `Function(bodyString)` through it; otherwise a minimal
   special-case for the harness idiom `Function("return this;")()` → the
   native globalThis object is acceptable ONLY if implemented as a general
   `Function` ctor arm, not a source-text match. Then verify `gO === this`
   (top-level `this` must be the same identity as `globalThis` in js-host
   sloppy/script mode).
2. **detachArrayBuffer**: ROOT CAUSE FOUND (lead, 2026-08-23): the runner
   leaks the shim. `tests/test262-runner.ts:2962` sets
   `needsDetachBuffer = /\$DETACHBUFFER\b/.test(body)` — regex on the body,
   NOT gated on `includes.includes("detachArrayBuffer.js")` — and injects a
   `$DETACHBUFFER` function (#1515 shim, ~L2093). This self-test deliberately
   has NO includes and requires the identifier to be UNDECLARED. Fix: gate the
   injection on the include being requested (every real consumer declares
   `includes: [detachArrayBuffer.js]`; mirror the `proxyTrapsHelper` gating
   two blocks below). THEN verify the second half: with no shim, the bare
   `$DETACHBUFFER(ab)` call must produce a CATCHABLE ReferenceError
   (`err.constructor === ReferenceError`) in js-host — check what the
   compiler does with an undeclared identifier call (CE would also fail the
   test; standalone currently PASSES this test, so establish how before
   changing shared assembly — the fix must not flip standalone red).
3. **testTypedArray**: minimal repro of the counting pattern in
   `test262/harness/testTypedArray.js` (read it first): an outer object,
   per-ctor `name` string keys, increments inside a callback invoked by
   `testWithTypedArrayConstructors`. Suspects: `.name` of TypedArray ctors,
   computed member increment on an any-typed object, or property-read of a
   never-written key returning something that breaks `undefined + 1` NaN
   handling in the harness's guard.
4. `wellKnownIntrinsicObjects.js` also fails js-host but is OWNED by #4633
   (standalone twin in flight) — do not touch it here; note findings in
   #4633 instead.

## Acceptance criteria

- The 3 tests pass js-host (`.tmp/run-harness-all-host.mts` green for them).
- Standalone category unchanged (113/116 on the stacked base); js-host sample
  59/60 (`.tmp/run-host-list.mts` + `.tmp/host-sample.txt`).
- No new host imports without a standalone fallback (CLAUDE.md dual-mode
  rule) — anything added to the js-host lane states its standalone story.

## Permanent repro

`test262/test/harness/fnGlobalObject.js`,
`test262/test/harness/detachArrayBuffer.js`,
`test262/test/harness/testTypedArray.js` (js-host lane,
`tests/test262-runner.ts` `runTest262File(..., undefined)`).

## Progress (2026-08-23, senior-dev)

All three flip. **js-host harness: 102/116 → 105/116**, no other test moved
(the remaining 11 are the pre-existing set). **Standalone harness: 112/116
before AND after** — measured on both sides in this worktree by reverting the
four modified `src/` files to the branch point and re-running; the identical
four failures. **js-host 60-sample: 59/60** (only the pre-existing
`AsyncDisposableStack/prototype/adopt/not-a-constructor.js`). **Extra
200-file random js-host sample** (seed 4650, `.tmp/sample200.txt`): 90 → 91,
one flip TO pass (`built-ins/Function/prototype/apply/S15.3.4.3_A7_T1.js`),
zero regressions.

### 1. detachArrayBuffer.js — the lead's root cause did NOT apply on this path

`tests/test262-runner.ts:2962` (`needsDetachBuffer = /\$DETACHBUFFER\b/`) is
real, but it belongs to `buildPreamble`, which feeds **`runSyntheticTest262File`
— the LEGACY transformed runner**. `runTest262File` (the conformance path, and
the one this issue measures) assembles the **literal upstream harness**
(`tests/test262-original-harness.ts`), so no shim is injected and
`$DETACHBUFFER` really is undeclared. `scripts/` contains no `$DETACHBUFFER`
at all, so the CI sharded worker never injects it either; the only callers of
the legacy runner are three unit tests (`issue-2940`, `issue-3086`,
`issue-3188`). **Nothing was gated** — gating it would change no conformance
result and could only disturb those unit tests. No real detach-using test
depends on the regex injection *on the measured path*.

The actual cause: **the JS-host lane had no §6.2.5.5 arm at the call site.**
`compileIdentifierCall`'s ReferenceError arm was `standalone`/`wasi`-only
(which is why standalone passed), so a host-lane call on an undeclared name
fell to the graceful last-resort arm — arguments compiled and dropped, callee
`ref.null.extern`, nothing thrown. Minimal repro (`.tmp/r1.js`): `try {
$NOPE_XYZ(1); } catch (e) {}` never entered the catch; the emitted body was
literally `f64.const 1; drop; ref.null extern; drop`.

Fix: `src/codegen/expressions/undeclared-callee.ts` (new) now owns the rule for
both lanes. The host arm keys on `ctx.oracle.isUnresolvableIdentifier` — no
checker symbol at all — which is **narrower** than the standalone arm's
"no value declaration": an ambient lib binding has a symbol but no value
declaration, and the host lane's late-bound shapes (inline closure candidates,
the `__call_dyn_*` bridge, implicit realm globals) each have their own arm
earlier in the chain and return there.

### 2. fnGlobalObject.js — three defects stacked

1. `Function("return this;")` **as a plain call** never reached the
   `__extern_new_function` host shim. Only the NewExpression path
   (`new-builtin-globals.ts`) routed a declined compile-away there; the call
   form fell through everything and answered `ref.null.extern`. Proof:
   `var f = Function("return this;"); f === null` was **true**, while
   `Function("return 1;")` (constant, `this`-free → the #2924 compile-away
   applies) was a real closure. The immediate-call form then packed that null
   into `__call_function`, whose host ABI throws
   `String(fn) + " is not a function"` → the reported
   `TypeError: null is not a function`.
   Fix: `src/codegen/expressions/dynamic-function-ctor-value.ts` (new), placed
   after `tryStaticFunctionCtorCall` and before the generic any-callee dispatch.
2. With a function in hand it returned **`undefined`**: the meta-circular
   `createNewFunctionShim` compiles the body with js2wasm as a FREE function, so
   its `this` is `undefined`, not §10.4.3's global object. Fix: route
   `this`-referencing bodies to the host constructor — the same carve-out shape
   `class`-carrying bodies already had (#3058), and the same limitation the
   codegen compile-away declines on (`containsThisKeyword`).
3. The host function's `this` was then the **real** `globalThis`, but the
   module's `this`/`globalThis` is what `__get_globalThis` returns, i.e.
   `globalSandbox ?? globalThis` — the runner always supplies a sandbox, so
   `gO === this` was false. Fix: when the body references `this` and a sandbox
   is in play, wrap the host function so a nullish/host-global receiver is
   redirected to the module's global; an explicit `f.call(obj)` keeps its own
   receiver. `length`/`name` are re-defined onto the wrapper.

   The `__extern_new_function` arm moved out of `resolveImport` into
   `src/runtime/dynamic-function-import.ts`. **Standalone needs none of this**:
   it answers `Function("return this;")` through the runtime-eval (quickjs)
   provider and already passed.

### 3. testTypedArray.js — `.name` of a union-typed receiver

Not the counting, not the computed-key write: **`TA.name` inside the callback
was correct** (`Float64Array`, …); the read that failed was the later
`typedArrayConstructors[i].name`, which answered `""`. So all 72 increments
landed on the single key `""` and `callCounts["Float64Array"]` was `undefined`.

The static `Function.name` fold resolves ONE name from the receiver's type
symbol, which a union does not have; it then falls to the covered-form `""`.
#4433 excluded unions on the host-free lanes only, leaving the host lane with
the identical bug. Minimal repro (`.tmp/t2.js`): `var arr = [Float64Array,
Int8Array]; arr[0].name` → `""` while `arr[0]["name"]` (dynamic read) → correct.
Fix: drop the lane asymmetry in `src/codegen/property-access-dispatch.ts`.

**Residual, deliberately out of scope** (no test in this issue depends on it):
a NON-union builtin-ctor receiver still folds to the TypeScript INTERFACE name.
`var v = Float64Array; v.name` reads **`"Float64ArrayConstructor"`** (while
`v["name"]` reads `"Float64Array"`), because the `Constructor`-suffix strip
fires only when `expr.expression` is the identifier `Float64Array` itself.
Worth its own issue.

### Pre-existing red unit tests at the branch point (NOT caused by this work)

Measured A/B in this worktree (branch src vs the four files reverted to the
branch point): `tests/issue-1450.test.ts` (2 tests — try/catch array and object
destructuring NamedEvaluation) and `tests/issue-2924.test.ts` (1 —
standalone no-arg `new Function()`) fail **identically on both sides**. No
required check runs them, which is exactly the "born red / silently reddened"
gap `ci.yml` warns about. Not touched here.

### Out of scope, as instructed

`wellKnownIntrinsicObjects.js` (js-host) is untouched — owned by #4633. For the
record its js-host failure is `this implementation could not obtain %Array%`,
which differs from the standalone message (`Object.is(Array, intrinsicArray)`
false), so the standalone fix in PR #4800 is unlikely to cover it as-is.
