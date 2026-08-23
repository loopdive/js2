---
id: 4648
title: "js-host: asyncHelpers harness self-tests — 6 failures (asyncTest/throwsAsync family)"
status: in-progress
assignee: ttraenkler/senior-dev
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/index.ts
  - src/codegen/registry/imports.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/closures.ts
func-budget-allow:
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/closures.ts::compileArrowAsClosure
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/assignment.ts::compilePropertyAssignment
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
sprint: current
created: 2026-08-23
updated: 2026-08-23
priority: high
horizon: l
feasibility: hard
task_type: bug
area: codegen
goal: test262-conformance
lane: B
trap-growth-allow:
  count: 16
  reason: "Stale-baseline reclassification carried from merged PR #4794 (realm shim #4634): createRealm().global became a narrowed forwarding object, so 16 cross-realm tests that were ALREADY failing (all baseline fail) null-deref instead of failing an assertion. The js2wasm-baselines JSONL has not re-promoted since, so every queued PR sees the same +15/16 null_deref growth it did not cause. Named per #3596; failure-flavour reclassification only — no baseline-pass test traps."
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
  - src/codegen/fn-global-shadow.ts
  - src/codegen/async-closure-promise.ts
  - src/codegen/closures.ts
  - src/codegen/typeof-delete.ts
  - src/codegen/registry/imports.ts
---

# js-host: asyncHelpers harness self-tests — 6 failures

Goal context: 100% of `test262/test/harness/` self-tests in BOTH lanes. The
js-host lane sits at 102/116 (measured 2026-08-23 on branch
`claude/harness-standalone-green`, `.tmp/run-harness-all-host.mts`). This issue
owns the 6-test asyncHelpers bucket:

| test | js-host error |
| --- | --- |
| `asyncHelpers-asyncTest-rejects-non-callable.js` | `compareArray(doneValues, [true×6])` got `[false×6]` — $DONE never called back with rejection verdicts |
| `asyncHelpers-asyncTest-returns-undefined.js` | `Test262:AsyncTestFailure:TypeError: Cannot convert object to primitive value` |
| `asyncHelpers-asyncTest-then-rejects.js` | `Test262:AsyncTestFailure:Test262Error: [object Object]` |
| `asyncHelpers-throwsAsync-custom-typeerror.js` | `Throws an instance of the matching custom TypeError` |
| `asyncHelpers-throwsAsync-func-never-settles.js` | `async completion marker not observed` |
| `asyncHelpers-throwsAsync-native.js` | `Expected a Error to be thrown asynchronously but …` |

## Implementation Plan (initial — deepen before implementing)

1. **Measure first.** Re-run the 6 with a js-host single-file runner
   (`.tmp/one-host.mts`, `F=test/harness/<f> npx tsx .tmp/one-host.mts`) and
   capture full errors + minimal repros in `.tmp/`.
2. **Check the standalone twin work (#4630) for shared roots.** The standalone
   fixes for `asyncTest-returns-undefined`/`then-rejects`/`then-resolves` were:
   (a) `globalThis.$DONE = …` must shadow the top-level `$DONE` function for
   bare reads/calls — implemented in `src/codegen/fn-global-shadow.ts` but
   **gated `ctx.standalone || ctx.wasi`**, so the js-host lane never gets the
   override-slot machinery. If the js-host failure has the same shape (harness
   reassigns `$DONE` via `globalThis`, compiled code keeps calling the static
   binding), widening the gate is the first candidate — BUT js-host bare-call
   lowering differs (host closures, `__call_fn_method_*`), so verify the write
   path actually lands on the same object the read path consults before
   widening. (b) The catch-clause param-inference withdrawal in
   `param-return-inference.ts` is NOT standalone-gated — already active.
3. `asyncTest-rejects-non-callable`: the test calls `asyncTest(<non-callable>)`
   ×6 and expects each returned promise to REJECT and `$DONE` to observe it.
   `[false×6]` means the rejection path never fires — likely the harness's
   `Promise.resolve(...).then(...)` chain around a non-callable, or
   `typeof !== "function"` guard, misbehaves under js-host lowering.
4. `throwsAsync-*`: `assert.throwsAsync` builds an async arrow that awaits
   `innerFn()` inside try/catch and inspects the error's constructor identity.
   Custom-typeerror failing while the standalone twin passes suggests js-host
   error-object identity (`err.constructor === TypeError`) or the
   `instanceof`/`.name` read through the any channel diverges.
5. **Never regress the throwsAsync-* baseline-pass set** — the standalone twin
   (#4630) proved param-inference changes cascade there; keep
   `.tmp/run-harness-all-host.mts` (full category, js-host) as the gate, plus
   `.tmp/host-sample.txt` via `.tmp/run-host-list.mts` (59/60 expected — the
   AsyncDisposableStack failure is pre-existing).

## Acceptance criteria

- All 6 tests above pass in js-host mode (`.tmp/run-harness-all-host.mts`
  reports them green; category ≥ 108/116).
- No regression in the js-host 60-test sample (59/60) or the standalone
  category (113/116 on the stacked base).
- Any codegen change states its lane gating explicitly (standalone-only vs
  both) with one sentence of justification in the code comment.

## Progress (2026-08-23, branch `claude/4648-jshost-async`)

**5 of the 6 pass. Harness self-test category, js-host lane: 102 → 108 / 116**
(`.tmp/run-harness-all-host.mts`; the 6th flip is `verifyProperty-desc-is-not-object`,
which the typeof fix below also repaired). No test in the category regressed.

The six failures were NOT one bug. Four independent root causes, in the order
they were found:

### 1. The #4630 shadow mechanism was lane-gated (3 tests)

`scanGlobalThisFnShadows` returned early unless `standalone || wasi`, so on the
JS-host lane `globalThis.$DONE = fn` never minted an override slot and the
harness's own bare `$DONE(error)` kept calling the statically compiled
declaration. §16.1.7 aliasing is a language rule, not a representation detail —
the scan now runs on every lane. Three lane-specific pieces were needed to make
it work on the host:

- **WRITE arm** (`assignment.ts`): the standalone arm reads the value back off
  the native `globalThis` singleton via `__extern_get`; there is no host
  counterpart. The host arm tees the assignment expression's own result (already
  the stored value, on top of the stack) into the slot.
- **CALL arm** (`call-identifier.ts`): the standalone arm packs the arguments
  into an `$ObjVec` for `__apply_closure`, and `ensureObjVecBuilders` pulls in
  the native object runtime — which, in host mode (wasm:js-string, not native
  strings), aborts the compile the moment a string-family selfhost builtin is
  emitted (`__str_trimStart needs string.len … not in native-strings mode`,
  plus a cascading `absoluteFuncIndex: unresolved call target`). The host arm
  uses the fixed-arity `__host_fnctor_method_call_N` driver instead: it
  dispatches a WasmGC closure through `__call_fn_method_N` and falls back to the
  `__extern_call_raw_callable_N` import for a genuine JS callable, so a HOST
  function assigned to `globalThis.<name>` works too. Arity > 8 keeps the static
  lowering (the driver surface is capped at 8, as on the `this.m(...)` fast path).

### 2. The slot index went stale on the host lane (same 3 tests)

`fnShadowSlot` caches an ABSOLUTE global index. On the host lane every string
literal becomes an imported `string_constants` global, and one added after the
slot was minted shifts the entire module-global range — so `global.set <slot>`
landed on an unrelated global (measured: it overwrote the `var realDone = $DONE`
module global, and the later `realDone()` trapped "dereferencing a null
pointer"). Standalone never saw this because native strings are not import
globals. This is the FIFTH instance of the documented cached-global-index
hazard; `shiftFnShadowSlots` is now called from `fixupModuleGlobalIndices`
alongside `newTargetGlobalIdx` / `holeGlobalIdx` / `sharedEmptyVecGlobals`.

### 3. The shadow arm's STATIC fallback re-read the host global (same 3 tests)

A `globalThis.<name> =` write also puts `<name>` in `ctx.sloppyImplicitGlobals`,
so the static (pre-override) arm compiled to `emitImplicitGlobalRead` — i.e. it
read the value back OFF the host global object and got a host-WRAPPED callable.
Storing that in a variable (`var realDone = $DONE`) made the later `realDone()`
miss the closure-struct `ref.test` and trap on a null `struct.get`. Inside the
static arm (host lane only) the read now falls through to the funcref-as-value
lowering, which is what §16.1.7 says the binding's initial value is.

### 4. `typeof` folded from a JSDoc param type (2 tests)

`asyncHelpers.js` documents `@param {Function} testFunc`, and with `allowJs` the
checker treats that as the param's type — so `typeof testFunc !== "function"`
const-folded to `false`, `asyncTest(null)` skipped the harness's own guard, and
`$DONE` received a TypeError instead of the expected Test262Error. #4394 already
built the unsound-fold guard for exactly this, but gated it standalone/wasi. The
unsoundness is a property of the SOURCE (JSDoc is not enforced at runtime), not
of the backend — ungated.

### 5. An await-free async closure had no async contract (1 test + the residual)

An async function with no `await` is declined by the frame engine and compiled
as the legacy synchronous pass-through; that is only correct because the CALL
SITE repairs it (`isAsyncCallExpression` → `Promise_resolve` + a try/catch that
turns a synchronous throw into `Promise_reject`). The repair is STATIC, so when
the closure escapes as a value and is invoked through a dynamic callee — exactly
`assert.throwsAsync(Error, async function () { throw new Error(); })` — nothing
repairs it: `res = func()` threw synchronously and `res` was not a thenable.

`src/codegen/async-closure-promise.ts` gives the CLOSURE the contract instead. A
wrapper calls the raw body in a try/catch and returns
`Promise_resolve(value)` / `Promise_reject(reason)`. Both materialization paths
are covered, and each keeps the raw body reachable for the sites that already
repair themselves:

- `compileArrowAsClosure` — the struct's funcref points at the wrapper;
  `funcMap[<closure>]` still names the raw body, so devirtualized DIRECT calls
  are untouched.
- `compileArrowAsCallback` — the wrapper is exported under `__cb_<id>` (the name
  the host bridge dispatches on) and the raw body stays private. **This is the
  path that mattered**: an async function ARGUMENT to a property-held callee
  (`assert.throwsAsync(...)`) is classified as a host callback, not a closure —
  fixing only the closure path left the harness tests failing.

Host lane only; `JS2WASM_ASYNC_CLOSURE_PROMISE=0` restores the previous
lowering.

**Correction (PR #4801 round 3): the wrapper is RESERVED during compilation and
FILLED AT FINALIZE.** The merge_group caught six pass→compile_error regressions
on the `__cb` path — AsyncDisposableStack `adopt`/`use`, `Function.prototype.
toString/proxy-async-function`, `Object.prototype.toString/symbol-tag-non-str-
proxy-function`, `__proto__-permitted-dup` — all reading

```
Compiling function #N:"__cb_0__async_body__async_promise" failed:
type error in fallthru[0] (expected externref, got i32)
```

The shape was right; the **indices were stale**. The wrapper body bakes three
callees (the raw body, `Promise_resolve`, `Promise_reject`), and every one of
those indices moves when a later late import is inserted. Dumping the emitted
WAT showed the wrapper calling `isNegativeZero` / `__box_number` /
`isPrimitive` — three unrelated functions — which is why the fallthru type was
`i32`. Small modules (the harness category) never shifted after the wrapper was
emitted, so the bug was invisible there.

The fix is the discipline the codebase already uses for exactly this hazard
(`accessor-driver.ts`, `host-fnctor-method-driver.ts`): `reserveAsyncClosure
PromiseWrapper` mints a stable handle with an `unreachable` placeholder while
compiling, and `fillAsyncClosurePromiseWrappers` — called at finalize next to
`fillHostFnctorMethodDrivers`, on BOTH the single- and multi-source paths —
writes the body, resolving every callee **by name** from `funcMap` (which the
import-shift fixup keeps in step, unlike a baked index).

Two guards came out of the same investigation and are kept:

- the wrapper is only reserved when the body's settled result is `externref` or
  void. `resolveWasmTypeForClosureReturn` lowers a `Promise<boolean>`-ish
  signature to a raw `i32`, and boxing that would have to guess boolean vs
  number — a wrong guess is a silent `true` → `1`. Declining keeps main's
  lowering. **Known gap:** an await-free async callback whose result lowers to a
  scalar still reaches the host unwrapped.
- if the reserve refuses, the raw body is renamed back to `__cb_<id>` and
  re-exported, so the decline path is exactly the pre-#4648 module.

**Round 2 (kept): the CLOSURE path was withdrawn — only the host-callback
bridge is wrapped.** The first cut wrapped `compileArrowAsClosure`
too and produced an **INVALID module** on three equivalence tests
(`issue-3205-property-call-wrapper-root` "async arrow closure stored in a
`() => void` class field", `promise-chains` "async arrow function",
`async-function` "#1730 module-const-arrow dispatch"):

```
WebAssembly.Module(): Compiling function #16:"__closure_4__async_promise" failed:
type error in fallthru[0] (expected externref, got (ref null 7))
```

Forcing `closureReturnType = externref` fixes the wrapper's signature, but the
LIFTED BODY keeps whatever result `compileLiftedClosureBody` settled on — a
covariant / repaired typed ref for a closure stored in a `() => void` field,
which is precisely the sibling-wrapper-struct machinery #3205 exists to pick
between. So `call <body>` fell through as `(ref null N)` where the wrapper
promised `externref`. Making that path correct means teaching the wrapper the
body's real (possibly repaired) result type AND keeping the #3205 wrapper-root
sibling selection consistent with the forced `externref` — for **zero measured
gain**: re-measured after the withdrawal, the harness category is still 108/116,
i.e. every flip came from the `__cb_<id>` bridge. The closure path is now
byte-identical to main again. This was NOT a stale equivalence expectation —
the emitted module genuinely failed `WebAssembly.validate`.

## Validation (all runs executed on this branch)

| run | before | after |
| --- | --- | --- |
| harness category, js-host (`.tmp/run-harness-all-host.mts`) | 102/116 | **108/116** |
| harness category, standalone (`.tmp/run-harness-all.mts`) | 110/116 | 110/116 |
| 60-test js-host sample (`.tmp/run-host-list.mts`) | 59/60 | 59/60 |
| `await` + `async-function` + `async-arrow-function`, js-host (156 files) | 131/156 | 131/156, identical failure list |
| full unsharded `equivalence-gate` (post-merge head, round 2) | 24 known-failures | **24 failing / 1661 passing — no new regressions** |
| the 6 merge_group compile_error files, `WebAssembly.validate` (round 3) | 6 INVALID | **6 valid** |
| 300 async-USING js-host compilations, `WebAssembly.validate` (round 3) | — | **valid 261 / INVALID 0** / 39 pre-existing compile-error — byte-for-byte identical with `JS2WASM_ASYNC_CLOSURE_PROMISE=0`, so the wrapper adds no invalid module |

The standalone base was re-measured on this branch's base commit for the two
non-environment failures (`asyncHelpers-asyncTest-return-not-thenable`,
`deepEqual-primitives-bigint`) — both fail on the base too, so they are
pre-existing, not regressions. The other four standalone failures in this
container are `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not
built`, i.e. environmental; that is why the number reads 110 here rather than
the 112 quoted in the task.

## Residual — `asyncHelpers-throwsAsync-custom-typeerror` (still failing)

Now fails LATER, at `assert.throwsAsync did not reject a collision of
constructor names`: the two `throwsAsync` calls that must REJECT resolve
instead, because `thrown.constructor` answers the INTRINSIC `TypeError` rather
than the test's local `function TypeError() {}`.

This is a FIFTH, independent root cause, and it is not in the asyncHelpers path
at all — it is the interaction of an intrinsic-name shadow with a
**frame-driven** async body. Minimal discriminator (js-host lane, both under
`asyncTest`):

```js
// (a) outer async body WITHOUT any await  → e.constructor === TypeError  (CORRECT)
asyncTest(async function () {
  function TypeError() {}
  var e = new TypeError();
  throw new Test262Error("" + (e.constructor === intrinsic));   // false
});

// (b) outer async body WITH an await      → e.constructor === intrinsic  (WRONG)
asyncTest(async function () {
  function TypeError() {}
  var e = new TypeError();
  await Promise.reject(e).then(null, function () {});
  // e.constructor === intrinsic  →  true
});
```

Note `e instanceof intrinsic` is FALSE in (b): the CONSTRUCTION is correct (the
shadow guard `errorCtorNameIsUserShadowed` fires), it is the `.constructor`
READ inside a driven async body that resolves the wrong carrier. Worth its own
issue — the fix belongs to the `.constructor` carrier precedence
(`error-ctor-carrier.ts` / the driven-body local spill), not to asyncHelpers.

## Permanent repro

`test262/test/harness/asyncHelpers-asyncTest-rejects-non-callable.js` (js-host
lane, `tests/test262-runner.ts` `runTest262File(..., undefined)`).
