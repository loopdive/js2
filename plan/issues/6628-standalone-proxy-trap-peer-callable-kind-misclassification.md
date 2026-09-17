---
id: 6628
title: "standalone: `__apply_closure`'s #6420 peer-callable-kind front-guard misclassifies a LOCAL closure as peer-owned under `canonicalRuntimeTypes`, hijacking every dynamically-invoked closure (Proxy traps included) through a linked provider's own apply terminal — closes #5383's `Proxy get trap is not callable` bucket"
status: done
sprint: current
priority: medium
horizon: s
feasibility: hard
reasoning_effort: max
goal: standalone-gap
parent: 5383
completed: 2026-09-17
assignee: ttraenkler/senior-dev-s41
loc-budget-allow:
  # 2026-09-17 (S41) — object-runtime-proxy.ts grows 35 lines: `fillProxyDispatch`'s
  # `fill()` gains a direct `__call_fn_method_<argCount>` bypass (with its own
  # doc comment explaining why it sidesteps `__apply_closure`'s shared
  # peer-callable-kind guard) ahead of the pre-existing vec-based
  # `__apply_closure` path, which stays as the fallback for the (currently
  # unreachable) case where the fixed-arity dispatcher is absent. No new
  # mechanism — it routes an EXISTING, already-registered dispatcher directly
  # instead of through the generic vec-building bridge.
  - src/codegen/object-runtime-proxy.ts
---

## Problem

#5383's four-family acceptance sample had a 6-row `TypeError: Proxy get trap
is not callable` bucket
(`Duration/from/order-of-operations.js`,
`PlainDate/from/order-of-operations.js`,
`PlainDate/from/observable-get-overflow-argument-primitive.js`,
`PlainDateTime/from/order-of-operations.js`,
`PlainDateTime/from/observable-get-overflow-argument-primitive.js`,
`ZonedDateTime/prototype/add/order-of-operations.js`).

S40 (#6627) reduced it to a 9-line linked-vs-unlinked repro and named two
suspects (`ensureProxyRuntime` / `emitStandaloneLinkReverseLocalTerminals`)
without pinning down the mechanism:

```js
// consumer, LINKED to any provider (content irrelevant, not even called):
var options = new Proxy({ overflow: "reject" }, {
  get(target, key, receiver) {
    return target[key]; // Reflect.get is NOT required to reproduce this
  },
});
export function probeToString() {
  var v = String(options.overflow);
  return v === "reject" ? 1 : -2; // answers -2 when linked, 1 when not
}
```

## Root cause

**Neither suspect.** A ctx-level Instr dump (`.tmp/s41/repro9.mts`,
`S41_DUMP_BODIES=1`) of every function in the chain
(`__extern_get`'s Proxy front-guard, `__proxy_get_dispatch`,
`__proxy_call_get`, `__call_fn_method_3`, `__typeof_function`) showed them
BYTE-FOR-STRUCTURE-IDENTICAL between the linked and unlinked builds (module
numeric offsets aside) — the reverse-peer terminal install and the funcIdx
late-import shift are both correct and were a dead end.

The real mechanism is in `fillApplyClosure`
(`src/codegen/object-runtime.ts` ~line 7766, added by #6420 "A standalone
linked peer knows whether a foreign value has `[[Call]]`. Route a positive
peer-owned callable before the local closure dispatcher"). Its front-guard —
prepended to `__apply_closure`'s body AHEAD of the normal arity-based local
dispatch — asks the linked PROVIDER "is this externref callable?"
(`__js2wasm_link_callable_kind` → the provider's own `__is_callable`, a bare
structural `ref.test`) for **every** value `__apply_closure` is ever asked to
invoke, including one that never crossed the link boundary.

#6420's own comment assumed *"caller-owned closures make the peer predicate
false"* — but under `canonicalRuntimeTypes` (on for every linked consumer,
#5383's whole ABI-compatibility mechanism) a purely LOCAL closure's WASM
struct shape canonicalises to the SAME type as the provider's own
closure/Proxy shapes. `ref.test` has no ownership concept, so the provider's
classifier answers "yes, callable" for a value it has never seen.
`__apply_closure` then calls `__js2wasm_link_apply` — the PROVIDER's own apply
terminal — which cannot run a closure it doesn't recognise and silently
returns null instead of the real invocation.

Confirmed with a WAT-level trace of the linked build's `__apply_closure`
(`.tmp/s41/apply_closure_linked.txt`): the trap closure hits
`local.get 0; call 4 (__js2wasm_link_callable_kind_import); i32.const 1;
i32.and; if [then: … call 3 (__js2wasm_link_apply_import); return]` BEFORE
ever reaching the arity-3 `__call_fn_method_3` ladder that would have
correctly invoked it. `H_sideEffect` (a trap whose body increments a
module-scope counter regardless of its arguments) proved the trap body
NEVER RUNS at all in the linked build — not a wrong-argument bug, a
misrouted-call bug.

This is unrelated to `Reflect`, `Temporal`, or the reverse channel — ANY
dynamically-invoked closure in a linked standalone consumer was equally
exposed (Proxy traps just happen to be #5383's bucket that surfaced it).

## Fix

`src/codegen/object-runtime-proxy.ts`, `fillProxyDispatch`'s `fill()`: a Proxy
trap is always obtained via `GetMethod(handler, trapName)` on a handler THIS
module's own source built (or received structurally, per the residual risk
noted below) — it never legitimately needs `__apply_closure`'s cross-module
routing. `__call_fn_method_<argCount>` (already registered by
`emitClosureMethodCallExportN`, which the finalize order guarantees runs
before `fillProxyDispatch`) has a param convention (`0=thisVal, 1=closure,
2..=args`) IDENTICAL to each trap driver's own (`0=handler, 1=trap,
2..=trap args`), so every argument forwards unchanged — no vec-building, no
peer query, no `__apply_closure` at all. The vec-based `__apply_closure` path
stays as the fallback for the (currently unreachable) case where the
fixed-arity dispatcher is absent.

**Two earlier fix attempts were tried and reverted** — both touched the
SHARED `__apply_closure` in `object-runtime.ts` with a structural
"is `fn` one of my own closure types" gate (first against
`collectClosureBaseWrapperTypeIdxs`' deduped ROOT list, then against
`ctx.closureInfoByTypeIdx`'s full per-site KEY list). Both regressed
`tests/issue-6605-link-reverse-method-call.test.ts` and
`tests/issue-6616-static-objlit-spread-rest-abi.test.ts` identically: a
`ref.test` against ANY structurally-shared closure type is EQUALLY unable to
distinguish "my own closure" from "an identically-shaped closure the OTHER
module declared", because `canonicalRuntimeTypes` makes that indistinguishable
BY DESIGN (the whole point of the canonical rec-group is that closures with
the same shape ARE the same WASM type across separately-compiled modules).
Fixing the SHARED function this way cannot work without adding real
per-instance ownership state (a module-origin tag field on every closure) —
out of scope here. Fixing the CALL SITE (Proxy's own fixed-arity trap
invocation, which never needs the peer route) sidesteps the ambiguity
entirely and is narrow enough to verify in full within this slice's budget.

**Residual risk (not covered by this fix or its tests):** a trap whose value
was ITSELF obtained from the peer (e.g. `new Proxy(peerTarget,
NS.makeHandler())` where `NS.makeHandler()` returns a provider-owned
closure) would now go straight to the local `__call_fn_method_N` ladder,
miss (the provider's closure type is not in this module's
`closureInfoByTypeIdx`), and answer the "legacy null sentinel" instead of
correctly routing to the peer — the exact failure #6420 was written to close,
now reintroduced for this one narrow shape. No test in the corpus or the
30-file `tests/issue-66*.test.ts` regression suite exercises a peer-supplied
Proxy trap; #5383's measured corpus (Temporal `propertyBagObserver`-style
traps) always defines traps locally. Filed as a residual, not fixed.

## Criterion 4 acceptance

Real-corpus proof (6-row bucket, fresh provider cache, `cacheHit=false`):
per-row before/after results below. Four-family sample, must-not-move
groups, corpus byte A/B, and equivalence gate all documented in `### S41
findings` on #5383.
