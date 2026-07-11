---
id: 3141
title: "standalone: native PromiseCapability protocol for reflective combinator calls — the 69-file 'resolve or reject function is not callable' cluster"
status: in-progress
assignee: ttraenkler/fable-finally
sprint: current
created: 2026-07-11
updated: 2026-07-11
priority: high
feasibility: hard
reasoning_effort: max
horizon: l
task_type: feature
area: codegen
language_feature: promises
goal: host-independence
related: [2903, 2671, 2976, 3137, 2867]
origin: "fable-harvest1 post-flip then-chain harvest intel (Rock B); measured 69 standalone-lane fails on issue-2903-native-finally branch, 2026-07-11."
loc-budget-allow:
  - src/codegen/expressions/calls.ts
---

# #3141 — standalone native PromiseCapability protocol (§27.2.1.5 / §25.6.4.1.1)

## The cluster (measured 2026-07-11, branch issue-2903-native-finally)

**69 standalone-lane fails**, all `built-ins/Promise/{all,allSettled,any,race}`,
all the same error signature "Promise resolve or reject function is not
callable", all this shape:

```js
function Constructor(executor) {              // custom capability constructor
  function resolve(values) { /* asserts */ }
  executor(resolve, Test262Error.thrower);
}
Constructor.resolve = function(v) { return v; };   // identity — elements stay raw
var p1 = { then(onFulfilled, onRejected) { onFulfilled("expectedValue"); } };
Promise.all.call(Constructor, [p1]);
```

This is #2671's standalone twin (the HOST lane got two slices already: +6
executor-function files, +28 element-function files — see #2671 progress
notes). The host-lane fix (marshal wasm closures host-callable through
`__call_function`) is structurally unavailable standalone — there is no host.

**Key insight: the entire observable flow is USER-SPACE.** With a custom `C`,
NO real promise is ever minted: `Construct(C, «executor»)` runs user code,
`C.resolve(elem)` is a user identity, `Invoke(nextPromise, "then", …)` calls a
user thenable's method. The combinator machinery reduces to the pure
capability/iteration protocol — compile it away natively and it works with no
carrier dependency at all.

## Where the shape dies today (verified on-branch)

`Promise.all` as a value materializes via property-access.ts
(`materializeBuiltinStaticClosure`-family) as `__builtin_static_Promise_all`
with a `genericThrowBody` refusal ("Promise.all is not yet implemented in
--target standalone"); the `.call(C, iter)` then dispatches through
`__call_m_call_2` → catchable TypeError. Under the leak-satisfied runner the
tests fail with the V8-side capability error instead (executor closures cross
as opaque structs). Both lanes fail; standalone scored 0/69.

## Design (native lowering, new module `src/codegen/promise-capability.ts`)

**Interception**: compile-time syntactic detection in calls.ts, BEFORE the
generic `.call` dispatch: `CallExpression` whose callee is
`PropertyAccess(.call)` on `PropertyAccess(Promise.<all|allSettled|any|race>)`,
≥1 argument. Gate: `isStandalonePromiseActive(ctx)`. (Reflective-value
indirections `const f = Promise.all; f.call(…)` stay refused — none in the
cluster.)

**NewPromiseCapability(C)** (§27.2.1.5):
1. capability struct `$__promise_capability { resolve (mut externref), reject
   (mut externref), promise (mut externref) }`.
2. executor = module-singleton closure: a canonical 2-arg funcref-wrapper
   SUBTYPE capturing the capability struct (the `$__promise_settle_cap`
   pattern, async-scheduler.ts `ensurePromiseExecutorClosures`) so the user's
   `executor(resolve, reject)` call takes the generic closure-call path.
   Body: if capability.resolve or .reject already set → throw TypeError
   (§27.2.1.5.1 steps 1-2); else store both args.
3. `Construct(C, «executor»)` ≈ `__apply_closure(CVal, null, [executorVal])`
   (object-runtime generic application; C compiled as a value). Result →
   capability.promise. (Plain-function `this` semantics are unobservable in
   the cluster — every test drives through the executor.)
4. Post-construct validation: `__is_closure(capability.resolve) &&
   __is_closure(capability.reject)` else throw native TypeError **"Promise
   resolve or reject function is not callable"** — the `capability-*-throws-*`
   / `S25.4.4.1_A4.1_T1` tests assert exactly this synchronous TypeError.

**PerformPromiseAll/AllSettled/Any/Race** (§25.6.4.1.1 family):
- Normalize the iterable arg to a vec (`__combinator_to_vec`, #2919/#2922 —
  already handles array literals / typed vecs / Set/Map / user iterables).
- Aggregation state: values externref-array + remaining cell + capability.
- Per element i:
  - `nextPromise = __apply_closure(Get(C, "resolve"), CVal, [elem])` — the
    runtime Get honours the `invoke-resolve-*` observable-lookup tests; probe
    whether `__extern_get` (native object-runtime get) resolves fnctor statics
    on a function trampoline value — #2976 documents the capturing-inner-fn
    variant where the static lands on a dead instance (accept those ~10 as
    still-failing, filed).
  - `Invoke(nextPromise, "then", «onFulfilled_i, onRejected_i»)` via
    `reserveClosedMethodDispatchVararg(ctx, "then")` + objvec (the thenable
    substrate's exact pattern).
- Element functions per combinator (fresh per element where spec'd —
  `new-resolve-function.js` asserts freshness; race passes capability.resolve
  DIRECTLY — `same-resolve-function.js` asserts identity):
  - all: resolveElement (one-shot, store, remaining-- → 0 ⇒
    `__apply_closure(capability.resolve, null, [valuesVec])`), reject =
    capability.reject.
  - race: capability.resolve / capability.reject (no wrappers).
  - allSettled: per-element status-object fulfil AND reject wrappers (compose
    with #3137's status-object builders where practical).
  - any: first fulfil resolves; reject collects → AggregateError (#3137's
    `__combinator_new_aggregate_error`).
- `values` delivered as the standard vec struct (user `Array.isArray(values)`,
  `.length`, `[0]` all work on vecs).

## Phasing + realistic yield

- **Phase A**: capability record + executor + validation + PerformPromiseAll
  for `all` → measure `all/` (19 cluster files there).
- **Phase B**: race / allSettled / any element functions → measure the 69.
- Out of scope (documented residuals): the ~18 element-function ATTRIBUTE
  reflection tests (`resolve-element-function-{length,name,extensible,
  property-order,prototype,nonconstructor}` — need function-object property
  reflection on native closures; some may pass via the builtin-fn-meta
  subtype pattern if the element closures reuse it — stretch); the ~10 #2976
  capturing-inner-resolve variants; `species-get-error` (species lookup).
  Realistic semantic subset: ~25-40 of 69.

## Acceptance

- Measured fail→pass flips in the 69-cluster (standalone lane, runTest262File),
  zero regressions across `built-ins/Promise` (652-file sweep, both metrics).
- `prove-emit-identity` byte-identical on unrelated modules (gc/host lane and
  standalone modules without the reflective shape).
- Stacked on PR #2883 (issue-2903-native-finally) — enqueue only after it
  lands; re-merge if it changes.
