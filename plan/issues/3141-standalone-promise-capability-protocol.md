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

## WIP state (fable-finally, 2026-07-11 — branch `issue-3141-standalone-promise-capability`, stacked on merged #2883)

**Working end-to-end in TYPED replicas** (probes in `.tmp/probe-3141*.mts` on
the branch worktree): capability record + executor (void-2-arg wrapper
subtype) + null-validation TypeError + identity `C.resolve` (module-scan
binding) + all-element one-shot aggregation + race direct-capability arms.
Landed plumbing:

- `src/codegen/promise-capability.ts` — the runtime + call-site emitter.
- calls.ts detection (`Promise.<all|race>.call(C, iter)`, unwraps as/paren)
  gated on the `C.resolve = <fnexpr>` module scan (`findStaticResolveAssignment`).
- **Pre-body registration is LOAD-BEARING**: declarations.ts scan flag
  (`ctx.moduleHasReflectiveCapabilityCombinator`) + collect-finalize
  `ensurePromiseCapabilityRuntime` — the dynamic-call cascade
  (`tryEmitInlineDynamicCall`) enumerates closure shapes known at ITS
  emission, so the executor's 2-arg-void wrapper arm must exist before user
  bodies compile (measured: nested `executor(resolve, reject)` call silently
  no-ops otherwise).
- **`__apply_closure` is method-ABI-only** (illegal cast on plain closures) —
  all 1-arg applications route through the RESERVED `__pcap_call1`, FILLED at
  finalize (`fillPromiseCapabilityCall1`, hooked in index.ts next to
  `fillApplyClosure`) by delegating to the raw-pushed `__call_fn_1` (located
  by NAME SCAN — the closure-call exports have no funcMap entries).
- `next` is PEELED (`__promise_peel_value`) before the vararg-then dispatch
  (module-global elements arrive `$AnyValue`-boxed; substrate pulled via
  `ensurePromiseSettleFunctions`).

**BLOCKER (bisected precisely, matrix probe `.tmp/probe-3141v.mts`)**: an
UNTYPED object-literal thenable — plain-JS `var p1 = { then: function(f, r)
{…} }`, i.e. every real test262 file — is NOT matched by
`__call_m_then_vararg`'s closed-struct arm: the fill picked a struct type
(`(struct (mut externref))`) that p1's actual construction never uses, so
dispatch falls to the `__extern_method_call` HOST arm → silent no-invoke
(and, with `Test262Error.thrower` registered, a downstream
`__call_fn_1`-string-param illegal cast when the machinery's
IfAbruptRejectPromise applies thrower to a non-string reason). With
`var p1: any = {...}` the SAME module works fully (ret 11 / 1111 probes). Next
step: root-cause how an untyped literal with a function-expression member
registers vs what `fillClosedMethodDispatch` enumerates (closed-method-
dispatch.ts) — compare the `p1: any` lowering (works) with the untyped one
(misses). Secondary (after that): the `__call_fn_N` string-param arm hard-cast
(`ref.cast (ref null $AnyString)` unguarded — thrower applied with an Error
reason traps; guard standalone-only).

Measured cluster (69 files): pass 0→2 (species-get-error all/race), 0 host-free
yet — the untyped-literal dispatch gap holds back the ~15-25 semantic wins the
typed replicas prove out.

## Acceptance

- Measured fail→pass flips in the 69-cluster (standalone lane, runTest262File),
  zero regressions across `built-ins/Promise` (652-file sweep, both metrics).
- `prove-emit-identity` byte-identical on unrelated modules (gc/host lane and
  standalone modules without the reflective shape).
- Stacked on PR #2883 (issue-2903-native-finally) — enqueue only after it
  lands; re-merge if it changes.
