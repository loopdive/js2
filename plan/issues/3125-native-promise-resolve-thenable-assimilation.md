---
id: 3125
title: "Native Promise resolve must assimilate user thenables / poisoned then / self-resolution (§27.2.1.3.2)"
status: done
completed: 2026-07-10
assignee: ttraenkler/fable-thenable
sprint: current
created: 2026-07-10
updated: 2026-07-10
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
model: fable
task_type: bug
area: codegen, runtime
language_feature: async
goal: standalone-mode
related: [2980, 3035, 2959, 2867, 2906, 2978]
origin: "#2980 carrier-widen tradeoff doc (plan/log/2980-carrier-widen-tradeoff.md §'The blocking residual'): 'native-resolve thenable assimilation — 7 promise-then-all regs … The native resolve path does not assimilate user thenables / self-resolution per §27.2.1.3.2. Does not block its bucket but is real spec noncompliance — should be filed as its own S/M issue.'"
---

# #3125 — native Promise resolve: thenable assimilation per §27.2.1.3.2

## Problem (reproduced 2026-07-10 on main@b6691942bd8, standalone + `JS2WASM_ASYNC_CARRIER_WIDEN=1`)

The native `$Promise` resolve path (`__promise_resolve_value` in
`src/codegen/async-scheduler.ts`) implements only two of the
§27.2.1.3.2 Promise Resolve Functions steps: native-`$Promise` adoption and
direct fulfil. Missing:

1. **Step 6 — SameValue(resolution, promise)** → reject with TypeError.
2. **Steps 8–9 — Get(resolution, "then") abrupt** (poisoned getter) → reject
   with the thrown value.
3. **Steps 10–14 — callable `then`** → enqueue PromiseResolveThenableJob that
   calls `then.call(resolution, resolveFn, rejectFn)` as a **job** (never
   inline), with a throw-before-settle rejecting the promise.

Additionally `Promise.resolve(x)` (`emitStandalonePromiseResolve`) does not
route through resolve-value at all — it mints an already-FULFILLED
`$Promise{value: x}` even when `x` is a thenable or a native promise
(spec §27.2.4.7 PromiseResolve: a native promise must be returned unchanged;
anything else goes through the resolve function).

Measured on the widen arm (off-arm/host all pass — widen-caused regressions):

| test (built-ins/Promise) | widen-standalone before |
| --- | --- |
| resolve/resolve-thenable.js | fail ("returned 2") |
| resolve/resolve-poisoned-then.js | fail (fulfils instead of rejecting) |
| prototype/then/resolve-settled-fulfilled-self.js | fail ("Cannot read properties of null (reading 'then')") |
| prototype/then/resolve-settled-rejected-self.js | fail (same) |
| prototype/then/resolve-settled-fulfilled-poisoned-then.js | fail |
| prototype/then/resolve-settled-rejected-poisoned-then.js | fail |

(`resolve-self.js` is a separate CE — `Promise.resolve` static property value
read — out of scope. `resolve-prms-cstm-then.js` fails on BOTH arms — custom
`then` on a genuine promise receiver, `.then` Get semantics — out of scope.)

## Root cause

- `emitStandalonePromiseResolve` = `struct.new $Promise{FULFILLED, x, null}` —
  a user thenable becomes the fulfilment VALUE, so downstream handlers receive
  the raw thenable object ("returned 2" assert mismatches).
- `buildPromiseResolveValueBody` adopts only `ref.test $Promise` values; a
  self-resolution (`handler returns its own chained promise`) prepends an
  identity reaction onto the promise's OWN callback list → never settles.
- No Get("then") ever runs → a poisoned getter never throws → wrongly fulfils.

## Fix (this PR)

All inside the native-promise substrate (standalone/wasi only — gc/host lanes
never emit these helpers, byte-identical there):

1. **`__promise_resolve_value` rewrite** (async-scheduler.ts):
   - `$Promise` arm: `inner ref.eq promise` → `__promise_reject(promise,
     __new_TypeError("Cannot resolve a promise with itself"))` (step 6);
     otherwise the existing adoption dispatch unchanged.
   - non-`$Promise` arm: `try { has = __promise_has_callable_then(value) }
     catch → reject(promise, thrown)` (steps 8–9, the poisoned getter throws
     inside the predicate's `$Object` Get arm);
     `has` → `__microtask_enqueue(__promise_thenable_job,
     $__then_caps{null, promise}, value)` (step 14 — the then CALL is a job);
     else → existing `__promise_fulfill` (step 11 fast path).
2. **`__promise_thenable_job(caps, thenable)`** (new, ensure-time body):
   materialises `resolveFn`/`rejectFn` as the SAME `$__promise_settle_cap`
   capturing closures `new Promise(executor)` uses (#2959 — subtype of the
   canonical `(externref)->()` wrapper, so compiled user code calls them
   natively), then invokes `__call_m_then_vararg(thenable, [resolveFn,
   rejectFn])` — the #2151/#3117 vararg dispatcher, which covers closed-struct
   methods of ANY declared arity, closure-valued fields (via
   `__apply_closure`), and open `$Object` receivers (via
   `__extern_method_call`) with `this` threaded. A throw rejects the promise
   (one-shot settle guard makes post-settle throws no-ops per step 15).
3. **`__promise_has_callable_then(value) -> i32`** (new; reserve at ensure,
   fill at finalize in closed-method-dispatch.ts — same #1719 pattern as the
   dispatcher itself, arms guaranteed consistent with what the vararg
   dispatcher can call): closed-struct `S_then` method arms ∪ closed-struct
   externref-field `then`-holding-closure arms ∪ `$Object`
   `__extern_get(value,"then")`-is-closure arm (this Get RUNS accessors, so a
   poisoned getter throws here). Closure test = `buildClosureRefTestArms`
   (#2175 single shared classifier).
4. **`emitStandalonePromiseResolve` rewrite**: `x` is `ref.test $Promise` →
   pass through unchanged (§27.2.4.7 step 2); else mint PENDING `$Promise` +
   `__promise_resolve_value(p, x)`. Plain values still settle synchronously
   (fulfil path), so non-thenable behaviour is observably unchanged.
5. `ensurePromiseExecutorClosures` moves from promise-executor.ts to
   async-scheduler.ts (promise-executor re-imports it) so the job can mint the
   settle-cap closures without an eval-time import cycle.

## Known residuals (accepted, documented)

- **Double Get of `then`**: the predicate Gets `then` at resolve time (per
  spec) and the vararg dispatcher's `$Object` arm re-Gets it at job time.
  Observable only for accessor-`then` thenables with side-effecting getters
  that do not throw (the poisoned case throws at resolve time — correct).
- **`then` that is a builtin function value** (e.g. `{then: Math.floor}`)
  classifies non-callable → fulfils. Vanishingly rare.
- The resolve-function `alreadyResolved` flag is still approximated by the
  one-shot settle guard (pre-existing): `resolve(slowThenable); resolve(v)`
  lets `v` win instead of the thenable's eventual value.

## Implementation notes (what actually landed, and WHY it differs from the plan)

1. **The Get must see through THREE object representations** (per-file drilling,
   not the plan's single `$Object` assumption):
   - closed-struct `then` FIELD (`{ then: function(){} }` — the dominant
     test262 shape) → `collectFieldEntries` arms + closure classifier;
   - closed-struct ACCESSOR via the #1888 S5c per-(struct,prop) module GLOBAL
     (`Object.defineProperty` on a closed-struct target) → new predicate arms
     over `ctx.structAccessorClosure`, ordered BEFORE the field arms (the
     define pre-shapes a runtime-null `then` field that would shadow them);
   - open `$Object` → `__extern_get` (drives the S5b `$PropEntry` accessor —
     the poisoned getter's throw propagates out of the predicate).
2. **`__promise_peel_value`**: an `any`-carried resolution can arrive as a
   `$AnyValue` box; every `ref.test` classification (including the `$Promise`
   adopt test) runs on the PEELED value, while fulfil/reject still deliver the
   ORIGINAL (identity preserved). Reserve-at-ensure / fill-at-finalize like the
   predicate.
3. **defineProperty mirror (object-ops.ts)**: the runtime
   `__defineProperty_accessor` silently no-ops on a closed-struct receiver
   (`ref.test $Object` miss) — the INLINE `Object.defineProperty({}, 'then',
   {get})` test262 pattern lost its accessor entirely (even plain reads).
   The accessor closures now ALSO mirror into the S5c globals when the
   receiver's COMPILED wasm type identifies a closed struct
   (`ctx.typeIdxToStructName` — the TS-type resolution misses inline
   anonymous literals).
4. **The job calls `__call_m_then_vararg`** (#2151/#3117) — closed-struct
   methods of ANY declared arity, closure fields via `__apply_closure`, open
   `$Object` via `__extern_method_call`, `this` threaded — with
   `[resolveFn, rejectFn]` built from the #2959 `$__promise_settle_cap`
   closures (`ensurePromiseExecutorClosures` moved to async-scheduler.ts;
   promise-executor.ts re-imports it — the reverse import is an eval-time
   cycle).

## Test results (2026-07-10, worktree @ origin/main b6691942bd8)

Target files, widen arm (`JS2WASM_ASYNC_CARRIER_WIDEN=1`, standalone):

| file | before | after |
| --- | --- | --- |
| resolve/resolve-thenable.js | fail | **pass** |
| resolve/resolve-poisoned-then.js | fail | **pass** |
| then/resolve-settled-fulfilled-poisoned-then.js | fail | **pass** |
| then/resolve-settled-rejected-poisoned-then.js | fail | **pass** |
| then/resolve-settled-{fulfilled,rejected}-self.js | fail | fail — blocked by **#3128** (assignment lost when the RHS closure captures the assigned var; `p2` is null before `.then` semantics matter). The step-6 self-resolution reject itself is verified via the executor shape (`cap(p)` → TypeError reject) in tests/issue-3125.test.ts. |

Guards: `resolve-non-thenable` / `resolve-non-obj` /
`resolve-settled-*-{thenable,non-thenable,non-obj}` / `rxn-handler-*` stay
pass. (`resolve-self.js` = unrelated CE; `resolve-prms-cstm-then.js` fails
BOTH arms — custom `then` Get on a genuine promise receiver, out of scope.)

- **Full #2980 A/B re-measure** (262-file corpus, scripts/measure): TOTAL
  **+18** (async-function +3, for-await +4, async-gen 0, promise-then-all +10,
  await-expr +1), zero new regressions — the −4 in-bucket residuals are the
  identical pre-existing 07-09 set. FLIP verdict unchanged (rule 1 holds).
- **prove-emit-identity**: 38/39 (file,target) byte-identical incl. ALL gc and
  all non-widen standalone; the single drift is `js/async.ts::wasi` — the
  intended fix lane.
- vitest: tests/issue-3125.test.ts (8, WASI zero-import) +
  tests/issue-3125-widen.test.ts (4, widened standalone) all pass;
  issue-1326/1326c/2867{,-gap4}/2671-executor/2671-capability/async-await/
  2865/2895/2906/2623/28 batches match main (the 3 issue-2867-gap2 wasi-shim
  failures and 2 issue-2865 NaN failures reproduce identically on main —
  pre-existing).

## Known residuals (accepted, documented)

- **Double Get of `then`**: the predicate Gets `then` at resolve time (per
  spec) and the vararg dispatcher's `$Object` arm re-Gets it at job time.
  Observable only for accessor-`then` thenables with side-effecting,
  non-throwing getters.
- **`then` that is a builtin function value** (e.g. `{then: Math.floor}`)
  classifies non-callable → fulfils. Vanishingly rare.
- A **closed-struct accessor `then` returning a callable** classifies as a
  thenable (getter runs in the predicate — poisoned throw works) but the
  vararg dispatcher has no struct-accessor arm, so the job's `then` call
  misses → promise stays pending. No known test262 hit (the poisoned cases
  throw at Get; data-`then` cases dispatch fine).
- The resolve-function `alreadyResolved` flag is still approximated by the
  one-shot settle guard (pre-existing): `resolve(slowThenable); resolve(v)`
  lets `v` win instead of the thenable's eventual value.
- WASI-lane `Object.defineProperty` accessor lifts still route through the
  host `__make_getter_callback` (pre-existing, standalone-gated S5b/S5c) —
  the poisoned coverage therefore lives on the widened-standalone lane
  (tests/issue-3125-widen.test.ts).
