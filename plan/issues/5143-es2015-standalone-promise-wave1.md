---
id: 5143
title: "ES2015 standalone: promise conformance wave 1"
status: in-review
sprint: current
created: 2026-08-28
updated: 2026-08-29
priority: high
horizon: l
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
loc-budget-allow:
  - src/runtime.ts
  - src/codegen/promise-combinators.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/promise-executor.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/expressions/promise-subclass.ts
  - src/codegen/standalone-subclass-ctors.ts
  - src/codegen/builtin-static-gopd.ts
  - src/codegen/builtin-value-read.ts
  - src/codegen/builtin-fn-meta.ts
  - src/codegen/then-thenable-miss.ts
  - src/codegen/property-access.ts
  - src/codegen/native-proto.ts
  - src/codegen/class-bodies.ts
  # (pass 2, 2026-08-29) §27.2.3.1 NewTarget/IsCallable guards. The BULK of the
  # new code lives in the new subsystem module src/codegen/promise-newtarget.ts,
  # exactly as the gate asks; what remains in the two god-files is the minimum
  # that cannot move — the dispatch-ladder entry in calls.ts (+14) and the
  # non-callable-executor guard that has to sit ahead of the native
  # `new Promise` arms in new-builtin-globals.ts (+19).
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/expressions/calls.ts
func-budget-allow:
  # (pass 2, 2026-08-29) Same two insertions seen at function granularity: a
  # guard arm inside the `new Promise` claim, and one entry on the call-dispatch
  # ladder. Both are order-sensitive — they must precede the native lowerings /
  # the generic identifier terminal — so neither can be hoisted out of its
  # enclosing function.
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/expressions/calls.ts::compileCallExpression
---

# #5143 — ES2015 standalone: promise conformance wave 1

The `loc-budget-allow` grant above is deliberate growth allowance for this
change-set (combinator element-pipeline restructure, NewPromiseCapability
generalization, function-object metadata for synthesized promise functions,
Promise object-model installs), rationale dated 2026-08-28 in this file.

## Problem

All **164** ES2015-bucket "promise" work-package tests still fail on the
standalone target (re-verified test-by-test on head `86739f05`, 2026-08-28,
via `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-promise-current-fails.txt`;
zero of the day-old baseline rows have been fixed by other landings). The
native standalone `$Promise` carrier (#2867/#2959/#3125) handles the intrinsic
happy path but skips every *observable* spec step of §27.2.4 PerformPromiseAll/
Race and §27.2.1.5 NewPromiseCapability: user thenables in combinator elements
are never assimilated, monkey-patched `Promise.resolve` is never invoked,
custom constructors are only admitted for the empty-array cohort (#4682), and
the synthesized resolve/reject functions are bare closure structs with no
function-object surface. Promises gate `async`/`await` and the whole
ES2015+ async corpus, so this package is load-bearing for the 100% ES2015
standalone goal.

**Target list (authoritative for this issue):**
`.tmp/es2015/wp-promise-current-fails.txt` — 164 paths, regenerated 2026-08-28.
Regression guard: `.tmp/es2015/wp-promise-passing-spotcheck.txt` — 40 paths,
re-verified 40/40 pass on head `86739f05` (with eval providers built, below).

### Local probe prerequisites (do this first)

1. Build the eval providers once per container, or 7 rows misreport as
   `JS2WASM_EVAL_ENGINE=quickjs but the quickjs provider is not built`
   (environment, not compiler — the trap that under-measured #4479/#4619):
   ```bash
   npx tsx scripts/build-runtime-eval-provider.mjs --refusal-only
   npx tsx scripts/build-quickjs-eval-provider.mjs
   ```
   With the providers built those 7 rows show their REAL failures (folded into
   clusters C3/C6 below).
2. Probe: `cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>`
   (split lists >150 lines; some tests legitimately take up to 20 s).
3. **Measurement nuance:** the in-process probe (`runOriginalHarnessVariant`)
   *binds* leaked `env::*` imports via `buildImports`, so a host-import leak
   shows up locally as a V8-flavored runtime error (e.g. V8's own
   "Promise resolve or reject function is not callable" from the host
   `Promise_all` path) — while CI's sharded standalone lane hard-fails the
   same binary as `host_import_leak` (#2961, `standaloneHostImportError`).
   After each fix, verify the compiled module's import list is EMPTY (compile
   with `target: "standalone"` and assert `result.imports.length === 0`; e.g.
   `Promise.race.call(C, [p1, p2])` today still emits `env::Promise_race` +
   `__js_array_new`/`__js_array_push`). Never "fix" a cluster by leaning on a
   host import.

## Current failure clusters

Counts sum to 164. Ordered by count descending.

| # | Cluster | Count | Root cause (file:function) | Sample tests (`built-ins/Promise/`) |
|---|---------|-------|----------------------------|--------------------------------------|
| C1b | Custom-constructor NewPromiseCapability too narrow | 55 | `src/codegen/expressions/call-namespace-static.ts` ~L2190–2245: the #4682/#4727 arms admit ONLY `Promise.{all,race,allSettled,any}.call(C, [])` with an **empty array literal** and C a **function declaration** with exactly 1 externref param. Non-empty iterables, function expressions, classes (incl. `class extends Promise`), and `Promise.resolve/reject.call(C, …)` all fall through to the host `Promise_METHOD` import (leak) or the `builtin-value-read.ts:1570` refusal. `emitStandalonePromiseCustomCapabilityCheck` / `emitStandalonePromiseCustomResolve` (`src/codegen/promise-combinators.ts` L246/L337) validate the capability but never drive the per-element protocol nor return C's constructed instance. | `race/same-resolve-function.js`, `all/call-resolve-element.js`, `race/resolve-throws-iterator-return-null-or-undefined.js`, `all/ctx-ctor.js` |
| C1a | Observable combinator protocol skipped on intrinsic Promise | 43 | `src/codegen/promise-combinators.ts:buildSubscribeBody` (~L735) subscribes directly to the `$Promise` struct: no `Invoke(C,"resolve",v)` per element (monkey-patched `Promise.resolve` never called — `all/invoke-resolve.js` expects 3 calls, observes 0), no observable `Get(nextPromise,"then")` (poisoned/patched `then` unobserved), no IteratorClose on abrupt resolve/then. The drain-then-subscribe shape (whole iterable drained via `__combinator_to_vec` before any subscription) breaks every interleave assertion. | `all/invoke-resolve.js`, `race/invoke-then.js`, `all/invoke-resolve-error-close.js`, `race/invoke-then-get-error-reject.js` |
| C2 | Thenable elements never assimilated | 33 | `src/codegen/promise-combinators.ts:buildSubscribeBody` else-arm (~L746–767) wraps ANY non-`$Promise` element as a synchronously-FULFILLED promise — a user thenable `{then(res, rej){…}}` fulfills with the thenable object itself; its `then` is never invoked. The #3125 substrate (`__promise_resolve_value`, `__promise_has_callable_then`, `__promise_thenable_job` in `src/codegen/async-scheduler.ts` ~L844–905) exists and is simply not used here. Sub-case (6 tests): `buildPromiseResolveValueBody` fast-paths a native `$Promise` resolution value by internal state, skipping the observable `Get(resolution,"then")` — a Promise instance with an OVERRIDDEN `then` is not routed through it. | `race/reject-immed.js`, `race/resolve-thenable.js`, `all/resolve-poisoned-then.js`, `prototype/then/resolve-settled-fulfilled-prms-cstm-then.js` |
| C3 | Synthesized promise functions have no function-object surface | 17 | `src/codegen/promise-executor.ts` + `ensurePromiseExecutorClosures` (`async-scheduler.ts`): executor `resolve`/`reject` (and the capability/element functions) are bare wasm closure structs. `typeof resolve` → `"undefined"` (`exec-args.js`), `Object.prototype.hasOwnProperty.call(fn,…)` → "called on null or undefined", no own `length`/`name` (in length-before-name order), not extensible-answering, `new fn()` doesn't throw, `Object.getPrototypeOf(fn) !== Function.prototype`, `p.then instanceof Function` false. `Promise.resolve.call(NotPromise)` refuses at `builtin-value-read.ts:1570`. | `exec-args.js`, `executor-function-length.js`, `resolve-function-nonconstructor.js`, `resolve-function-prototype.js` |
| C4 | Promise builtin object model gaps | 10 | `Promise[Symbol.species]` computed READ → undefined (gOPD synthesis exists — `builtin-static-gopd.ts` `SPECIES_OWNER_CTORS` ~L379 lists Promise — but the direct read path and the descriptor's get/set fields are missing: `Symbol.species/prop-desc.js` crashes reading `desc.set`); `Promise.prototype[Symbol.toStringTag]` undefined; `Object.getPrototypeOf(Promise.prototype)` → null (native-proto parent unregistered); `verifyProperty(Promise,'all'/'race'/'resolve'/'reject')` own-property descriptors absent; `Promise.prototype.then.length` ≠ 2. | `Symbol.species/symbol-species.js`, `prototype/Symbol.toStringTag.js`, `prototype/proto.js`, `reject/prop-desc.js` |
| C5 | Compile-error bugs | 5 | (a) 2× `CompileError: extern.convert_any[0] expected type anyref, found … externref` — anonymous `class extends Promise` whose constructor conditionally `return {}`; a double extern-conversion on the then-capability/subclass return path (`promise-subclass.ts:194` emits `extern.convert_any`; `class-bodies.ts:3052` comments the exact hazard). (b) 1× `undefined-newtarget.js`: `Promise.call(undefined, …)` → `__get_builtin` CE; correct behavior is a runtime TypeError (mimic the #4732 `WeakSet(...)`-without-new arm in `new-builtin-globals.ts` ~L1711). (c) 2× `get-prototype-abrupt*.js` → the #3371 Reflect.construct NewTarget limitation (existing documented refusal). | `prototype/then/capability-executor-not-callable.js`, `undefined-newtarget.js`, `get-prototype-abrupt.js` |
| C6 | Cross-realm (deferred) | 1 | `$262.createRealm()` — no realm support in standalone. Out of scope for this wave. | `proto-from-ctor-realm.js` |

## Implementation Plan

Steps ordered so partial completion maximizes yield: Step 1 = C1a+C2 (76
tests, one file's element pipeline), Step 2 = C1b (55), Step 3 = C3 (17),
Step 4 = C4 (10), Step 5 = C5 (5). Steps 3–5 are independent of 1–2 and of
each other; within Step 1, 1a alone already flips most of C2.

**Global constraints:** no new host imports without a standalone fallback
(this whole issue is about REMOVING the `Promise_*` leaks); never edit
`tests/test262-runner.ts`, skip lists, or `scripts/*baseline*.json`; any new
codegen type query goes through `ctx.oracle` (`src/checker/oracle.ts`), never
the raw TS checker (oracle-ratchet gate). Everything below is gated on
`isStandalonePromiseActive(ctx)` — the js-host/gc lane must stay
byte-identical (host-mode twins of these bugs are tracked in
`promise-async-capability-residual.md`, blocked, and #4760).

### Step 1 — spec-shaped element pipeline in the native combinators (C1a + C2, 76 tests)

All in `src/codegen/promise-combinators.ts`, composing the existing #3125
substrate; no new runtime concepts.

1a. **Thenable assimilation (33).** In `buildSubscribeBody` (~L735) replace
    the else-arm sync-FULFILLED wrap (~L746–767) with: allocate a fresh
    PENDING `$Promise`; call `__promise_resolve_value(p, input)` (funcIdx via
    `ctx.funcMap.get("__promise_resolve_value")`, registered up-front by
    `ensurePromiseSettleFunctions`, `async-scheduler.ts` ~L844); subscribe to
    `p` exactly as the existing `$Promise` arm does. `__promise_resolve_value`
    already implements §27.2.1.3.2 incl. `__promise_has_callable_then` +
    `__promise_thenable_job` (PromiseResolveThenableJob on the microtask
    ring), so primitives/plain objects still settle immediately
    (`race/resolve-non-obj.js` / `resolve-non-thenable.js` must keep passing)
    and poisoned `then` getters reject.
    Sub-fix for the 6 `*prms-cstm-then*` tests: in
    `buildPromiseResolveValueBody` (`async-scheduler.ts` ~L902), before the
    native-`$Promise` internal fast path, check for an own/overridden `then`
    (`__promise_has_callable_then` on the *object-runtime* property, not the
    builtin method) and route through the thenable job when patched. Keep the
    fast path when nothing is patched — this is perf-sensitive (every `await`).
1b. **Observable `C.resolve` per element (part of 43).** Spec §27.2.4.1.1
    step: `nextPromise = ? Invoke(constructor, "resolve", «nextValue»)`.
    Monkey-patched `Promise.resolve = function(…){…}` writes ARE kept and
    stored on the Promise namespace singleton (`builtin-write-keeps.ts`,
    #4199 arm). Emit: load the current `resolve` member off the namespace
    singleton; if it is a user closure (funcref-wrapper `ref.test`), call it
    with the element (this = Promise, exactly 1 arg — `all/invoke-resolve.js`
    asserts `this`, `arguments.length`, and per-element call count) and
    assimilate its return via 1a; else run the native path. Compile-time
    predicate to keep current codegen when the module provably never writes
    `Promise.resolve`/`Promise.prototype.then` (scan kept top-level writes +
    function-body writes; when in doubt, emit the observable sequence).
1c. **Observable `then` subscription (rest of 43).** After `nextPromise`,
    spec does `Invoke(nextPromise, "then", «resolveFn, rejectFn»)`. When the
    element promise is a native `$Promise` and `then` is unpatched, keep the
    direct struct subscription (current code). Otherwise dispatch through
    `__call_m_then_vararg` with the two capability functions as args — the
    exact pattern `src/codegen/then-thenable-miss.ts` already uses (argvec via
    `ensureObjVecBuilders`, #2151/#3117 dispatcher). An abrupt `Get(then)` or
    call → reject the aggregate capability (`invoke-then-get-error-reject`,
    `invoke-then-error-reject`) and IteratorClose (1d).
1d. **Per-element interleave + IteratorClose.** Restructure the user-iterable
    argument path from drain-then-subscribe (`__combinator_to_vec` first) to
    iterate-and-subscribe in one loop, so `resolve`/`then` are invoked DURING
    iteration (`invoke-resolve-on-values-every-iteration-of-promise.js`
    currently traps `illegal cast`). On abrupt resolve/then: GetMethod
    (iterator, "return"); null/undefined → propagate original completion;
    call it once (`invoke-resolve-error-close.js` counts `return()` calls).
    Array-literal/array-typed arguments (no observable iterator) may keep the
    vec shape.

### Step 2 — generalize NewPromiseCapability + element functions (C1b, 55 tests)

Files: `src/codegen/expressions/call-namespace-static.ts` (~L2100–2245, the
two #4682/#4727 arms), `src/codegen/promise-combinators.ts`
(`ensureCustomCapabilityRuntime` L132, `emitStandalonePromiseCustomCapabilityCheck`
L246, `emitStandalonePromiseCustomResolve` L337). Extend, don't fork — the
capability struct + executor closure are right; what's missing is everything
after validation.

2a. **Widen admission**: non-empty iterables (drive Step 1's element loop
    against the captured capability resolve/reject instead of the intrinsic
    settle helpers); C as function expression and CLASS declaration —
    `class BadPromise { constructor(executor){…} static resolve(){throw …} }`
    currently dies with "[object Object] is not a constructor". For
    `class extends Promise` receivers reuse the singleton chokepoint in
    `src/codegen/expressions/promise-subclass.ts` (its header documents the
    combinator capability path) and `standalone-subclass-ctors.ts`.
2b. **Per-element protocol against custom C**: `nextPromise =
    Get(C,"resolve") + Call(thisC, «value»)` — observable, including
    `Constructor.resolve = function(v){ return v; }` returning a THENABLE
    (`race/same-resolve-function.js`: both thenables' `then` must receive the
    SAME capability-resolve function object — for `race` pass
    `capability.[[Resolve]]` itself, never a per-element wrapper). For `all`,
    pass the index-carrying resolve-ELEMENT function; reject side is always
    `capability.[[Reject]]` (`all/same-reject-function.js`). Abrupt
    `Get(C,"resolve")`/call → IfAbruptRejectPromise + IteratorClose
    (`resolve-throws-iterator-return-*`).
2c. **Result identity**: the combinator returns the object `Construct(C,
    «executor»)` produced — NOT an internal `$Promise` —
    so `instance.constructor === C` and `instance instanceof C` hold
    (`all/ctx-ctor.js`; the current "Cannot convert object to primitive
    value" is `assert.sameValue` strict-equality falling into a ToPrimitive
    lowering on the mismatched reps — returning the real instance sidesteps
    it, but ALSO fix `===` on closure/object refs to be identity, never
    ToPrimitive, if it still reproduces).
2d. **Resolve-element functions as objects** (`call-resolve-element*.js`,
    `resolve-element-function-*.js`): expose the element function to user
    thenables as a first-class callable with spec shape (length 1, name "",
    non-constructor, extensible, length-before-name order — depends on Step
    3's metadata substrate) and once-semantics via the alreadyCalled flag in
    `$CombinatorElemCaps` (`call-resolve-element-after-return.js`,
    `invoke-resolve-get-once-multiple-calls.js`). remainingElementsCount
    semantics: `resolve-before-loop-exit*.js` — the aggregate must not settle
    until the iteration loop completes.
2e. **`.call` spellings of resolve/reject/then**: admit
    `Promise.resolve.call(C[, v])` / `Promise.reject.call(C, r)` (currently
    the `builtin-value-read.ts:1570` refusal — add a call-shape arm BEFORE the
    value-read refusal, routing to `emitStandalonePromiseCustomResolve`), and
    `then`'s SpeciesConstructor path for `p.then()` on a promise whose
    `constructor` is patched/null/poisoned (`prototype/then/ctor-null.js`,
    `ctor-custom.js`, `ctor-poisoned.js`, `ctor-access-count.js`,
    `context-check-on-entry.js`, `prototype/no-promise-state.js`,
    `prototype/catch/this-value-*.js`): observable `Get(p,"constructor")`,
    `Get(C, @@species)`, then NewPromiseCapability(species). Chokepoint:
    the then-lowering in `promise-subclass.ts` / the `.then` receiver bridge
    (#2980, `then-thenable-miss.ts` shows the miss-arm pattern). #4760
    (in_progress) fixed several of these HOST-side and explicitly left
    "standalone native-`$Promise` handoff" rows — this step is that handoff;
    check its table before starting to avoid double work.

### Step 3 — function-object metadata for synthesized promise functions (C3, 17 tests)

The executor `resolve`/`reject` closures (`ensurePromiseExecutorClosures`,
`async-scheduler.ts`), the GetCapabilitiesExecutor closure, and Step 2d's
element functions must answer the standard function-object protocol. Mimic
how the per-(builtin, method) singleton closures answer gOPD
(`builtin-static-gopd.ts` static-method arm) and how `builtin-fn-meta.ts` /
`function-prototype-callable.ts` model builtin function surfaces:

- `typeof fn` → `"function"`: the typeof classifier must `ref.test` the
  funcref-wrapper root for externref-typed values (`exec-args.js`).
- `Object.getPrototypeOf(fn)` → `Function.prototype`; `fn instanceof
  Function` → true (see `src/runtime/fnctor-instanceof.ts` +
  `src/codegen/fnctor-instanceof.ts` glue) — covers `S25.4.5.3_A1.1_T2.js`,
  `prototype/catch/S25.4.5.1_A2.1_T1.js`, `*-function-prototype.js`.
- Own props `length` (1; executor fn: 2) and `name` (`""`), in
  length-before-name insertion order (`*-property-order.js`), configurable
  per spec; `Object.isExtensible(fn)` → true; `Object.prototype.
  hasOwnProperty.call(fn, "name")` must not throw "called on null or
  undefined" (the closure struct currently marshals as null through the
  Object.prototype path — route wrapper structs into the object-runtime view).
- Non-constructor: `new fn()` → TypeError (`*-nonconstructor.js`,
  `executor-function-not-a-constructor.js`).

### Step 4 — Promise builtin object model (C4, 10 tests)

Follow #4746's mechanism (Promise constructor property order — done) for each:

- `Promise[Symbol.species]` direct/computed READ → the species accessor's
  result (Promise itself); complete the gOPD descriptor with `get`
  (named `get [Symbol.species]`) and `set: undefined`
  (`builtin-static-gopd.ts` ~L379 already whitelists Promise —
  the read path and get/set synthesis are the gap).
- `Promise.prototype[Symbol.toStringTag]` = `"Promise"` `{w:false, e:false,
  c:true}` (`object-proto-tostring.ts` brand table / native-proto glue).
- `Object.getPrototypeOf(Promise.prototype)` → `Object.prototype`
  (register the parent in `native-proto.ts` — currently null).
- Own-property descriptors for `Promise.all/race/resolve/reject`
  (`verifyProperty`: `{w:true, e:false, c:true}` + hasOwnProperty + delete
  + redefine round-trip), global own property `Promise` (`promise.js`), and
  `Promise.prototype.then.length === 2` with full descriptor
  (`prototype/then/length.js`).

### Step 5 — compile-error bugs (C5, 5 tests)

- **extern.convert_any double-conversion (2)**: repro
  `npx tsx .tmp/probe-compile-promise.mts built-ins/Promise/prototype/then/capability-executor-not-callable.js`
  (module compiles, `WebAssembly.Module()` rejects). The anonymous
  `class extends Promise` constructor with a conditional `return {}` hits a
  path that applies `extern.convert_any` to an already-externref block —
  audit `promise-subclass.ts:185–195` and the `class-bodies.ts:3052`
  hazard-commented site; emit the conversion only when the producer is
  anyref-typed.
- **`undefined-newtarget.js` (1)**: `Promise.call(undefined, exec)` /
  bare `Promise(exec)` must compile and throw TypeError at runtime
  (§27.2.3.1 step 1 — NewTarget undefined). Mimic the #4732
  callable-without-new TypeError arm (`new-builtin-globals.ts` ~L1711).
- **`get-prototype-abrupt*.js` (2)**: blocked on #3371 (standalone
  Reflect.construct with arbitrary NewTarget). Permitted residual — do NOT
  hack around it here; if #3371's substrate has landed by implementation
  time, wire it, else document.

### What NOT to do

- No new host imports without a standalone fallback; the point of this issue
  is that the standalone lane emits ZERO env imports for every listed test.
- Never edit `tests/test262-runner.ts`, `HANGING_TESTS`/skip lists, or
  `scripts/*baseline*.json` (main is the baselines' sole writer).
- Do not regress the intrinsic fast paths: every observable-protocol emission
  must be gated so an unpatched, intrinsic-receiver module keeps (near-)
  current codegen — `await`-heavy code pays for `buildSubscribeBody` and
  `__promise_resolve_value` on every settle.
- Do not fix host-mode (gc lane) semantics in this PR beyond keeping it
  byte-identical; the host twins are #4760 / `promise-async-capability-residual.md`.

## Acceptance criteria

- [ ] Every test in `.tmp/es2015/wp-promise-current-fails.txt` (164 paths)
      passes via `npx tsx .tmp/run-standalone.mts --list …` on the PR branch,
      EXCEPT up to 3 documented residuals: `get-prototype-abrupt.js`,
      `get-prototype-abrupt-executor-not-callable.js` (#3371),
      `proto-from-ctor-realm.js` (cross-realm). Each residual must be
      re-measured and cited with its blocking issue in the PR.
- [ ] Every test in `.tmp/es2015/wp-promise-passing-spotcheck.txt` (40 paths)
      still passes (40/40 verified on head `86739f05` with providers built —
      build them before measuring, see prerequisites).
- [ ] Compiled modules for the target tests emit no host imports
      (`result.imports.length === 0` under `target: "standalone"`).
- [ ] Ratchet gates pass, chained before commit:
      `node scripts/check-loc-budget.mjs && node scripts/check-func-budget.mjs
      && node scripts/check-coercion-sites.mjs && npm run -s check:oracle-ratchet
      && npm run -s check:dead-exports`.
- [ ] Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## Results (wave 1 pass, 2026-08-28)

Measured on this branch with the eval providers built (see prerequisites), via
`npx tsx .tmp/run-standalone.mts --list …` over the 164-path target list split
into three 60-line chunks.

| | before | after |
|---|---|---|
| `wp-promise-current-fails.txt` (164) — pass | **0** | **12** |
| `wp-promise-current-fails.txt` — fail | 161 | 149 |
| `wp-promise-current-fails.txt` — compile-error | 3 | 3 |
| `wp-promise-passing-spotcheck.txt` (40) — pass | 40 | **40** |

Ratchet gates all green (loc / func / coercion-sites / oracle-ratchet /
dead-exports), run bare and chained. The loc gate reports the single changed
source file `src/codegen/promise-combinators.ts` 1857 → 1879 (+22), granted by
this file's `loc-budget-allow`.

Compiled-module import check: a standalone module doing
`Promise.race([thenable])` + `Promise.all([thenable, 1])` reports
`imports: []` — the assimilation path adds no host import.

**Equivalence-suite note:** `tests/equivalence.test.ts` (the path named in
CLAUDE.md and in this issue's acceptance criteria) does not exist in this tree;
the suite is the `tests/equivalence/` DIRECTORY. The async/promise slice
(`promise-chains`, `async-await`, `equivalence/{async-function,async-iteration,
for-await-of}`) is 39/39 green. A full `tests/equivalence/` run surfaces ~20
failures (TDZ, `void`, `Reflect.construct`, `delete`-sentinel, optional
closure call, …) — all **pre-existing**, confirmed by a base-vs-branch A/B on
`tdz-reference-error` + `optional-direct-closure-call` (8 failed / 3 passed on
both `HEAD`'s `promise-combinators.ts` and this branch's).

### Cluster done — Step 1a, thenable assimilation in combinator elements (C2)

`buildSubscribeBody` (`src/codegen/promise-combinators.ts`) no longer wraps a
non-`$Promise` element in a synchronously-FULFILLED `$Promise`. It now
allocates a fresh PENDING `$Promise` and drives it through the existing #3125
`__promise_resolve_value` substrate, which is §27.2.1.3.2 in full: a user
thenable gets a real PromiseResolveThenableJob on the microtask ring (its
`then` is invoked), a poisoned `then` getter rejects, and a plain value still
fulfils synchronously. Cost is one extra struct + one call per non-promise
element; the native-`$Promise` fast arm is untouched, so `await`-heavy code is
unaffected. The pre-#3125 sync-fulfil shape is kept as a defensive fallback
when the helper is unregistered.

Flipped to PASS (12): `all/reject-deferred`, `all/reject-immed`,
`all/resolve-ignores-late-rejection{,-deferred}`, `race/reject-deferred`,
`race/reject-immed`, `race/resolve-ignores-late-rejection{,-deferred}`,
`race/resolve-non-obj`, `race/resolve-non-thenable`,
`race/resolve-poisoned-then`, `race/resolve-thenable`.

### Clusters SKIPPED in this pass (remain open on this issue)

- **Step 1b/1c/1d — observable `C.resolve` / `then` / per-element interleave
  (C1a, ~43).** **Plan deviation, load-bearing:** the plan states
  "monkey-patched `Promise.resolve = …` writes ARE kept and stored on the
  Promise namespace singleton (`builtin-write-keeps.ts`, #4199 arm)". They are
  **not**. `builtin-write-keeps.ts` keeps namespace writes only for the three
  EMPTY-static-surface carriers `Math`/`JSON`/`Reflect`, and explicitly
  documents that a `<Namespace>.<staticMethod> = fn` write is dropped because
  the call site resolves statically through `BUILTIN_STATIC_METHOD_ARITY`
  (which lists every `Promise` static). So there is no slot for
  `__combinator_subscribe` to read, and Step 1b/1c cannot be built on the
  claimed substrate: a patchable `Promise.resolve` storage slot has to be
  added first. That is its own change, not a sub-step.
- **Step 2 — NewPromiseCapability generalization (C1b, ~26 rows still showing
  the V8-flavoured `Promise resolve or reject function is not callable`
  host-leak signature).** Deep; untouched.
- **Step 3 — function-object metadata for synthesized promise functions
  (C3, ~17).** Untouched; the `Promise.resolve is not yet implemented`
  refusal at `builtin-value-read.ts:1570` still stands.
- **Step 4 — Promise builtin object model (C4, ~10).** Untouched. Note:
  `Promise` IS already in `SPECIES_OWNER_CTORS` and its statics ARE in
  `BUILTIN_STATIC_METHOD_ARITY`, so the gap is narrower than the plan implies:
  the `verifyProperty` rows fail on the own-property/`delete`/redefine
  round-trip and on `Promise.prototype[Symbol.toStringTag]` /
  `getPrototypeOf(Promise.prototype)` / `then.length === 2`, not on the
  descriptor synthesis entry points.
- **Step 5 — compile-error bugs (C5, 5).** The two
  `extern.convert_any[0] expected type anyref, found block of type externref`
  CEs reproduce exactly as described (`prototype/then/capability-executor-{
  not-callable,called-twice}.js`); fixing the double-conversion only makes
  them compile, they would still need Step 2 to pass, so it was not worth
  landing alone. `undefined-newtarget.js` and the two
  `get-prototype-abrupt*.js` (#3371) residuals are unchanged.

## Results (wave 1, pass 2 — 2026-08-29)

Second implementation pass on top of the commit above, same measurement recipe
(eval providers built first; `npx tsx .tmp/run-standalone.mts --list …` over the
164-path list in three 55-line chunks). Both the before and the after column
were run on this box in this session — the "before" is a real re-run of the
target list on the pass-1 tree, not the table above restated.

| | before (pass-1 tree) | after |
|---|---|---|
| `wp-promise-current-fails.txt` (164) — pass | 12 | **17** |
| `wp-promise-current-fails.txt` — fail | 149 | **145** |
| `wp-promise-current-fails.txt` — compile-error | 3 | **2** |
| `wp-promise-passing-spotcheck.txt` (40) — pass | 40 | **40** |

Path-by-path diff of the two runs: five rows moved, all in the right direction,
**zero regressions** —
`executor-not-callable`, `prototype/proto`, `prototype/no-promise-state`,
`prototype/catch/this-value-non-object` (FAIL → PASS) and
`undefined-newtarget` (COMPILE_ERROR → PASS).

All five ratchet gates run bare and chained after the change: loc (with the two
grants added to this file's frontmatter below), func (likewise), coercion-sites,
oracle-ratchet, dead-exports — all green.

### Clusters fixed in pass 2

**C5b — `Promise` called without `new` (1, was a hard compile error).**
`Promise(fn)` fell into the generic builtin-identifier terminal and
`Promise.call(x, fn)` reached the `__get_builtin` dynamic-shape refusal (#1472
Phase B), which is a CE in standalone — so `undefined-newtarget.js` never built.
New arm `tryCompilePromiseCallWithoutNew` (`expressions/new-builtin-globals.ts`,
dispatched from `expressions/calls.ts` beside the #4732 `WeakSet` twin) claims
both spellings, evaluates every argument for its side effects, then throws the
§27.2.3.1-step-1 TypeError. `this` is irrelevant to that step, so
`Promise.call(realPromise, fn)` throws too — which is exactly what the test
asserts.

**C3 (part) — non-callable executor (1).** `new Promise(1)` / `(null)` / `({})`
declined both native lowerings and fell through to the `Promise_new` HOST import,
which in standalone constructs nothing and throws nothing. A guard ahead of the
native arms now emits the §27.2.3.1-step-2 TypeError for an executor the compiler
can prove is both non-callable AND side-effect-free (`isInertNonCallableLiteral`:
primitive literals, `null`, unshadowed `undefined`, EMPTY object/array literal).
Emptiness is load-bearing — `{ a: f() }` is non-callable too, but discarding it
would skip `f()`; those keep the existing runtime-value path.

**C4 (part) — `Object.getPrototypeOf(Promise.prototype)` (1).**
`Promise.prototype` lowers to a `$NativeProto` whose `$parent` field is left null
("chain walk deferred", `native-proto.ts`), so the query silently answered
`null`. Rather than populate `$parent` for every builtin brand — most builtin
prototypes do NOT root at `%Object.prototype%` — the narrow `Function.prototype`
arm in `expressions/object-get-prototype-of.ts` was generalised to a named
two-member set `OBJECT_ROOTED_PROTOTYPE_CTORS = {Function, Promise}`, which is
per-constructor and states the §27.2.3.1 fact for Promise only.

**C1b/C4 (part) — brand checks on `Promise.prototype.{then,catch,finally}` (2).**
`Promise` is now in `BRANDED_PROTO_METHODS` (`builtin-prototype-brand.ts`) for
those three methods, and in `NULLISH_THIS_THROWS`, which gives the direct
spelling and the borrowed nullish spelling their §27.2.5 TypeErrors
(`prototype/catch/this-value-non-object.js`). Added alongside them:
`tryBorrowedPrototypeBrandThisThrow`, the missing third case —
`<Ctor>.prototype.<brandedMethod>.call(<AnyCtor>.prototype, …)`. A builtin
prototype is an ordinary object with no internal slots, so every branded method
rejects it; the arm is generic over the existing table (it also covers the
`Map`/`Set`/`WeakMap`/`WeakSet`/`Date` `does-not-have-*data-internal-slot-*-prototype`
family) and uses the same lib-identity receiver proof as its siblings, so a user
`class Promise {}` is declined rather than mis-claimed.

### Clusters still SKIPPED (unchanged from pass 1, re-measured)

The pass-1 skip list below still holds; nothing in this pass unblocked it. The
two structural blockers are worth restating because they gate ~120 of the
remaining 145 rows:

- **No patchable `Promise.resolve` slot.** Confirmed again against
  `builtin-write-keeps.ts`: `EXPANDO_NAMESPACES` is `{Math, JSON, Reflect}` and a
  `Promise.resolve = fn` write is dropped, because the call site resolves
  statically through `BUILTIN_STATIC_METHOD_ARITY`. Steps 1b/1c/1d (C1a, ~43
  rows, every `invoke-resolve*` / `invoke-then*` / `illegal cast` row) cannot be
  built until that slot exists. That is its own issue, not a sub-step here.
- **Synthesized promise functions are not function objects.** Re-probed directly:
  in `new Promise(function (a, b) { resolve = a; argCount = arguments.length; })`
  the escaped `resolve` reads back as `undefined` and `argCount` as `undefined` —
  the executor's parameters do not escape at all, so C3's `typeof`/`length`/
  `name`/`prototype`/`non-constructor` rows (~15) are downstream of building that
  substrate, not of the metadata tables. Same root cause blocks C1b's
  `resolve-element-function-*` rows.
- **C1b custom-constructor capability (~26 rows)** still shows the V8-flavoured
  `Promise resolve or reject function is not callable` host-leak signature
  (`Promise.all.call(C, iterable)` with a class/function `C`); untouched.
- **C5a** — the two `extern.convert_any[0] expected type anyref, found block of
  type externref` CEs (`prototype/then/capability-executor-{not-callable,
  called-twice}.js`) reproduce; fixing the double-conversion only makes them
  compile, and they would still need Step 2 to pass.
- **Permitted residuals, re-measured and unchanged**: `get-prototype-abrupt.js`
  and `get-prototype-abrupt-executor-not-callable.js` (#3371, standalone
  `Reflect.construct` cannot preserve an arbitrary NewTarget — these are the 2
  remaining compile errors) and `proto-from-ctor-realm.js` (cross-realm, C6).

**Equivalence-suite note (carried forward and re-confirmed):**
`tests/equivalence.test.ts` does not exist in this tree — the suite is the
`tests/equivalence/` DIRECTORY, and running it whole OOMs the vitest worker on
this box, so it was run in chunks.

- The slice that can regress from these changes (promise/async/await/
  for-await-of, plus the Date/Map/Set/WeakMap/WeakSet/prototype-chain/call-apply
  files the new borrowed-brand arm reaches) was run as one batch: **15 files,
  124/124 passing**.
- **217 of the 218** files were run in total. `multi-file-compilation.test.ts`
  OOMs even on its own in this container — an environment limit, not a signal;
  it is the one file left unmeasured.
- **21 tests fail**, in 8 files (`tdz-reference-error` ×6,
  `null-dereference-guards` ×5, `logical-conditional-identity` ×3,
  `optional-direct-closure-call` ×2, `new-non-constructor` ×2,
  `misc-small-patterns`, `reflect-api`, `yield-as-expression`, plus
  `arguments-nested-and-loops`, `array-inline-return`, `delete-sentinel` in the
  first half). **All pre-existing** — verified by an A/B, not by assumption: the
  four changed files were reverted to their `HEAD` contents (and
  `promise-newtarget.ts` moved aside) and those same files were re-run, giving
  the identical 21 failures in the identical tests. `new-non-constructor` is
  worth naming explicitly because it is the closest file to this change-set and
  the one a reviewer should suspect first: it fails identically on the base
  tree.

## References

- **Done substrate this builds on**: #4682 (empty-array custom-capability
  arm), #4727 (custom-ctor Promise.resolve self-resolution), #4735
  (Promise.resolve preserves overridden then — host side), #4736 (thenable
  host fulfillment), #4746 (Promise constructor property order), #2867/#3137
  (native combinators all/race/allSettled/any), #2959 (native
  `new Promise(executor)`), #3125 (thenable-assimilation substrate), #4394
  (`.then` miss arm / `__call_m_then_vararg` pattern), #2980 (then receiver
  bridge), #1326 (microtask ring).
- **In-flight — coordinate, don't duplicate**: #4760 (in_progress;
  `prototype/then` residuals fixed HOST-side with explicit "standalone
  handoff" rows that overlap Step 2e here).
- **Blocked/related counterparts**: `plan/issues/promise-async-capability-residual.md`
  (host-mode NewPromiseCapability residual, blocked on the #2637 executor
  epic — same spec surface, different lane), #4659 (asyncTest un-hidden
  failures, Backlog), #2860 (standalone-gap parent).
- **Gates/limits cited**: #2961 (standalone host-import gate), #3371
  (Reflect.construct NewTarget refusal), #1472 (`__get_builtin` Phase B
  refusal), #4242 (eval-engine providers; the local-probe prerequisite).
- **Sibling wave**: #5141 (ES2015 standalone generators wave 1 — same
  work-package format, same quickjs-env measurement trap documented there).
