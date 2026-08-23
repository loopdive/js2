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

## Validation (all runs executed on this branch)

| run | before | after |
| --- | --- | --- |
| harness category, js-host (`.tmp/run-harness-all-host.mts`) | 102/116 | **108/116** |
| harness category, standalone (`.tmp/run-harness-all.mts`) | 110/116 | 110/116 |
| 60-test js-host sample (`.tmp/run-host-list.mts`) | 59/60 | 59/60 |
| `await` + `async-function` + `async-arrow-function`, js-host (156 files) | 131/156 | 131/156, identical failure list |

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
