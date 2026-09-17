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
## S41b: must-not-move battery completed (2026-09-17)

Branch `issue-5383-standalone-temporal-s41b`, based on S41's `d9d43e634d`
(measurement + docs only, no `src/` changes). Closes the "NOT run this slice"
gap immediately above and adds a new group E covering Proxy/Reflect directly,
since #6628 touches `object-runtime-proxy.ts`'s Proxy dispatch.

Base = file-copy revert of `src/codegen/object-runtime-proxy.ts` to
`ef08f7a8f0` (S40b's tip, pre-#6628) on the same tree; fix = the file as
merged by S41 (`680f8190fd`). All runs `--target standalone`.

### Groups A–D (S39b/S40b's 2,004-row definitions), unlinked

| Group | Files | Base pass/fail/CE | Fix pass/fail/CE | Per-file diff |
| ----- | ----: | ------------------ | ------------------ | -------------- |
| A (Object/keys, expr/object, Reflect/get+has) | 1,250 | 1125 / 89 / 36 | 1125 / 89 / 36 | 0 lines |
| B (Object/entries+values+getOwnPropertyNames, for-in) | 205 | 179 / 26 / 0 | 179 / 26 / 0 | 0 lines |
| C (Object/Reflect.getPrototypeOf, Function/prototype×100, class subclass×100, class expr×100) | 249 | 196 / 53 / 0 | 196 / 53 / 0 | 0 lines |
| D (TypedArray/TypedArrayConstructors/DataView, 100/subfamily) | 300 | 219 / 58 / 23 | 219 / 58 / 23 | 0 lines |

All four groups: **0 pass→fail, 0 fail→pass** — exact per-file match (`diff` of
sorted `file\tstatus` TSVs on both base and fix returns 0 lines for every
group). The must-not-move bucket predicted by S40b/S41 reproduces exactly
(1125/179/196/219 pass counts, matching the task brief's expected floor).

### PlainDate re-confirmation (120 files, fresh `JS2WASM_TEMPORAL_CACHE` per
state, `cacheHit=false` at prewarm, `cacheHit=true` on the immediately
following in-process reuse of that same fresh build)

Base 112/120, fix 112/120 — 0 per-file diff. Matches S41's four-family
433/480 aggregate (this slice re-ran only PlainDate as the cheap
reconfirmation the brief asked for; Duration/PlainDateTime/ZonedDateTime were
NOT re-run).

### Group E (new this slice): `test/built-ins/Proxy` (first 200) +
`test/built-ins/Reflect` (first 100), standalone, unlinked AND linked

**Unlinked** (ordinary `runTest262File`, no forced Temporal link): base
235/58/7 (pass/fail/CE), fix 235/58/7 — 0 diff, 300/300 files identical.

**Linked**: no existing harness knob forces a Temporal link onto a
Proxy/Reflect file that doesn't declare the `Temporal` feature (no `src/`
change permitted this slice to add one). Built a docs-only `.tmp/s41b/`
script instead: for each file, copy it to a shadow path with a
`features: [Temporal]` line inserted as the FIRST line inside its
`/*--- ... ---*/` block (`parseMeta`'s regex takes the first match, so this
reliably flips `test262NeedsTemporalGlobal` to true without touching
`test262/` or any shared file) and run the shadow copy through the SAME
production `runTest262File` → `compileWithTemporalGlobal` path every
Temporal-tagged corpus row already takes. This puts the file through a real
linked provider (content irrelevant — matches the S40/S41 9-line repro's
"consumer, linked to any provider, not even called").

| State | Pass | Fail | CE | Total |
| ----- | ---: | ---: | -: | ----: |
| base  | 220  | 72   | 8  | 300   |
| fix   | 228  | 64   | 8  | 300   |

**0 pass→fail. 8 fail→pass**, all in the `apply`/`has`/`get`/
`getOwnPropertyDescriptor`/`getPrototypeOf`/`isExtensible`/`deleteProperty`
`call-parameters.js`/`call-in.js`/`call-with.js` family — tests that assert
the trap is invoked with the correct `this`/context, i.e. exactly the
ENGINE-TRIGGERED trap dispatch sites `fillProxyDispatch` routes through
`__call_fn_method_<N>` directly under this fix. Verified two of the eight by
hand (`Proxy/apply/call-parameters.js`, `Proxy/has/call-in.js`): both throw
`Test262Error: trap context is not the handler object` under base-linked and
pass under fix-linked. The remaining ~64 linked failures (both states) are
tests that invoke the trap MANUALLY via `Function.prototype.apply`/`.call()`
in the test's own harness code — those calls go through the general,
unfixed `__apply_closure` peer-callable-kind guard (#6420), not
`fillProxyDispatch`, so they fail identically on base and fix, exactly as
#6628's write-up predicts for the "does NOT close the bucket" direction.

### PlainDate/equivalence gate cross-check

`npm run -s test:equivalence:gate`: `22 failing, 1720 passing, 22
known-failures in baseline` — unchanged, run at fix state after all group
runs completed.

### Verdict on Criterion 4 for this slice

Complete. Every group S41 flagged as "NOT run" (A/B/C/D) now has a measured,
0-pass→fail, exact per-file match. Group E (new, mandatory for this slice
because the fix is inside Proxy dispatch) also shows 0 pass→fail in both its
unlinked and linked variants, with the 8 linked-mode improvements fully
explained by the fix's own mechanism. No regression found anywhere in this
battery; #6628's fix is now measured-contained across group A–E plus the
family sample and the equivalence gate.
