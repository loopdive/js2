---
id: 6628
title: "standalone: `__apply_closure`'s #6420 peer-callable-kind front-guard misclassifies a LOCAL closure as peer-owned under `canonicalRuntimeTypes`, hijacking a purely local Proxy trap invocation through a linked provider's own apply terminal — real, independently-verified fix, but does NOT close #5383's `Proxy get trap is not callable` bucket (a second, deeper cross-module mechanism blocks it)"
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

`src/codegen/object-runtime-proxy.ts`, `fillProxyDispatch`'s `fill()`: when
the module dispatching the trap is the SAME module that constructed the
`new Proxy(...)` — S41's own target repro's shape, and the common single-module
case — the trap is always obtained via `GetMethod(handler, trapName)` on a
LOCALLY-built handler and never legitimately needs `__apply_closure`'s
cross-module routing. `__call_fn_method_<argCount>` (already registered by
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

**This does NOT close #5383's target bucket — confirmed by a SECOND, DEEPER
mechanism, present identically on base and fix.** The real corpus row is not
"a consumer builds and reads its own local Proxy" (my repro's shape) — it is
`Temporal.PlainDate.from("2021-05-17", options)`, where the CONSUMER builds
`options = TemporalHelpers.propertyBagObserver(...)` (a Proxy) and hands it
to the PROVIDER, which then reads `options.overflow` **from inside its own
compiled module**. The trap closure the PROVIDER's own `__proxy_get_dispatch`
finds in `$ptraps.$get` is genuinely, unavoidably the CONSUMER's — it was
built by whichever module executed `new Proxy(...)`, never the module doing
the later read. `fillProxyDispatch`'s direct-dispatch fix (this issue) is
therefore WRONG for that direction: it always tries the local
`__call_fn_method_N` ladder first, but here the trap can NEVER be local to
the provider, so it should always have gone through `__apply_closure`'s peer
route.

Built and ran a minimal reduction of exactly this shape
(`.tmp/s41/crossmodule.mts`: a provider with `readOverflow(o) { return
o.overflow; }`, a consumer building a local Proxy and passing it to
`NS.readOverflow(options)`) against BOTH the base tree and this fix — **both
throw an uncaught `WebAssembly.Exception` identically**, proving this
specific failure mode was already broken before this fix and is unaffected
by it (not a new regression, but also not what this fix closes). The
`__apply_closure` peer-callable-kind bridge (#6420) is therefore load-bearing
for the FORWARD direction (provider invoking a consumer-supplied trap) even
though it is WRONG for the backward direction (a module invoking its own
local trap) — the SAME structural-typing ambiguity noted above (canonical
types make "mine" vs "theirs" undecidable by `ref.test`) applies to BOTH
directions and there is no single front-guard that gets both right. A correct
general fix needs real per-instance ownership (a module-origin tag on every
closure struct, set at `struct.new` time) — out of scope for this slice.

**Net effect of this fix**: real, independently-verified, does not regress
anything measured (150/150 existing tests, equivalence gate unchanged,
four-family sample unchanged 433/480 — see below), but does not move #5383's
6-row bucket, whose actual blocker is this second, deeper cross-module
mechanism. Filed as the next slice's starting point below.

## Criterion 4 acceptance (S41, measured)

- **6-row bucket** (fresh provider cache, `cacheHit=false`, rebuilt bundle):
  all 6 rows answer `TypeError: Proxy get trap is not callable` identically
  before and after — UNCHANGED. Bucket not closed by this fix (see above).
- **Four-family sample** (first 120 files × 4 families, `--target
  standalone`, fresh cache): PlainDate 112/120, Duration 105/120,
  PlainDateTime 113/120, ZDT 103/120 = **433/480**, matching the S40b base
  measurement EXACTLY, per-family and in total. 0 movement.
- **Corpus byte A/B** (42 files × {gc, standalone}, `tests/fixtures` +
  `website/playground/examples`): 84/84 rows kept `status: "ok"` — 0
  CE/status flips. 6 `standalone`-target rows changed SHA (bytes, not
  behavior): `benchmarks.ts`, `benchmarks/helpers.ts`, `js/async.ts`,
  `eslint-shims/debug.ts`, `ir-retirement/class-closure.ts`,
  `ir-retirement/entry.ts` — NONE of these six contain the literal text
  `Proxy`; the byte delta comes from `ensureProxyRuntime` being invoked
  UNCONDITIONALLY inside `ensureObjectRuntime` (not gated on the source
  actually constructing a `Proxy`) — every standalone module that reaches the
  object runtime bakes in the (now slightly smaller, direct-dispatch) Proxy
  trap-invoke drivers as dead code. Expected, benign, no behavior change.
- **Equivalence gate**: `22 failing, 1720 passing, 22 known-failures` —
  unchanged from the pre-fix baseline.
- **Must-not-move groups A/B/C/D** (S39b's 2,004-row definitions): NOT run in
  this slice — time-budget cutoff. Flagged as an open verification gap for
  whoever picks up the cross-module trap-invocation mechanism next; the
  four-family sample and the 150-test regression suite are the strongest
  signal collected so far that this fix is contained.
