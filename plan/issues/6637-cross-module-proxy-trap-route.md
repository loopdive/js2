---
id: 6637
title: "Standalone link: cross-module Proxy trap dispatch is broken, not just misclassified"
status: blocked
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
owner: sendev-s52b
---

# #6637 — cross-module Proxy trap dispatch (S52b, #5383 stack)

## Origin

Dispatched as the S52b slice of #5383 (standalone Temporal). S52's static
diagnosis said: a PROVIDER classifying a CONSUMER-owned Proxy trap closure via
`__typeof_function` has no local `ref.test` arm for a base-wrapper shape it
never compiled locally, so `object-runtime-proxy.ts`'s trap-callable guards
(~142-158 `trapCallableGuard`, ~434-441 the GET-specific inline guard) throw
`TypeError: Proxy get trap is not callable` even for a real, callable trap.
The prescribed fix: add a reverse-peer channel (mirroring #6600/#6605's
provider→consumer read/call hops) so the PROVIDER can ask the CONSUMER "is
this externref callable" as a classification fallback.

## What was implemented (this branch, WIP)

`src/codegen/standalone-link-reverse-peer.ts`:

- Two new reverse-peer terminals, following the exact pattern of the existing
  `get`/`keys`/`has`/`methodCall` (#6600/#6605) terminals:
  - `localCallableKind` / `reverseCallableKind` — `(externref) -> i32`. The
    CONSUMER-side terminal is a bare delegate to the CONSUMER's own
    `__typeof_function`; the PROVIDER-side hop is the usual
    reentrancy-guarded `call_ref` through an installed funcref global, miss =
    `i32.const 0`.
  - `localApply` / `reverseApply` — `(fn, thisArg, argsVec) -> externref`.
    The CONSUMER-side terminal is a bare delegate to `__apply_closure`
    (matching `fillProxyDispatch`'s own in-module trap-invoke convention,
    deliberately NOT `localMethodCall`'s `__current_this`-swap convention,
    which is for a different call shape). **Not yet wired into any caller** —
    see "What's still open" below; may turn out to be unnecessary if
    `__call_fn_method_N`'s cross-module `ref.cast` already works once
    classification succeeds (closures canonicalize structurally under
    `canonicalRuntimeTypes`, confirmed by #6628's own comment and by
    `passProxyIdentity`/`readPlainBag` below).
  - Both terminals are OPTIONAL at the `install(...)` call site (a consumer
    module with no local `__typeof_function`/`__apply_closure` passes
    `ref.null` for the missing slot) — the base 5-terminal channel is
    unaffected either way.
- `install`'s wasm signature grew from 5 to 7 externref-funcref params
  (get/keys/has/isNull/methodCall/callableKind/apply). Every call site
  (provider `reserveStandaloneLinkReversePeer`, consumer
  `emitStandaloneLinkReverseLocalTerminals` + `finalizeStandaloneLinkReversePeer`)
  updated in lockstep.

`src/codegen/typeof-natives-finalize.ts`:

- `fillStandaloneTypeofClosureArms` now reads
  `ctx.funcMap.get(LINK_REVERSE_PEER.reverseCallableKind)` and, when defined,
  splices a fallback `ref.test`-equivalent arm into `__typeof_function`'s
  chained-arm body (`callableI32Arms`) — call the reverse hop, return
  `onMatch` if truthy. No masking needed (unlike the forward
  `boundaryCallableKindIdx` arm, which is a 2-bit mask): the reverse hop
  answers a plain boolean, since it delegates to the consumer's own
  `__typeof_function`.
- Early-return guard extended to keep the finalize pass alive when only
  `reverseCallableKindIdx` is defined (every other classifier arm absent).

**Verified wired correctly** by decompiling the actual compiled provider
binary (`wasm-dis -all`, not wabt per project convention) for the #6637 repro
harness below: `__typeof_function`'s body ends with

```wat
(if (call $__js2wasm_link_reverse_callable_kind (local.get $0))
 (then (return (i32.const 1))))
(i32.const 0)
```

— reached only after the local closure/proxy-carrier/builtin-brand arms all
miss, exactly as designed. `npm run -s typecheck` is clean with these
changes.

## Runtime confirmation — and the critical finding that invalidates S52's diagnosis

Repro harness: `compileProject` a provider package
(`export const NS = Object.freeze({ readOverflow(o){return o.overflow} })`,
`--target standalone --hostBridge off`), then `compileMulti` a consumer that
links it (`canonicalRuntimeTypes: true`) and calls `NS.readOverflow(options)`
with various `options` shapes. (Harness copied from
`tests/issue-6605-link-reverse-method-call.test.ts`'s `linkedPair` pattern;
kept as `.tmp/s52b/repro.test.ts`, not committed — gitignored probe
convention.)

| call | base tree | this branch |
| --- | --- | --- |
| `NS.readPlain({overflow:1})` (plain bag, no Proxy) | `1` (correct) | `1` (correct) — control, unaffected |
| `NS.identity(new Proxy({overflow:1}, {}))` (pass through, never touched) | `1` (correct) | `1` (correct) — control, unaffected |
| `NS.readOverflow(new Proxy({overflow:1}, {get(t,k,r){return t[k]}}))` (real get trap) | **THREW** (`WebAssembly.Exception`) | **STILL THREW** — my fix does not change this |
| `NS.readOverflow(new Proxy({overflow:1}, {}))` (**empty handler, no get trap at all**) | **THREW** | **STILL THREW** |
| `NS.hasOverflow(...)` — `"overflow" in new Proxy({overflow:1}, {})` (empty handler) | *(not tested on base)* | **did NOT throw — returned `0` (should be `1`, target has the key)** |
| `NS.isExt(...)` — `Object.isExtensible(new Proxy({overflow:1}, {}))` (empty handler) | *(not tested on base)* | **did NOT throw — returned `0` (should be `1`, default-extensible)** |

**The empty-handler GET case is the load-bearing result.** An empty `{}`
handler has NO `get` trap at all — GetMethod(handler, "get") is spec'd to
answer `undefined`, and `[[Get]]` should forward straight to the target
(§10.5.10 step 6b). There is no closure to classify, so a missing
classification arm cannot be the cause. A **single-module** control
(`new Proxy({overflow:1}, {})` compiled and run in ONE module, no link
boundary at all — `tests/probe-6637-single.test.ts`, also gitignored)
confirms this reads correctly (`1`, no throw) when there is no cross-module
boundary. So the defect is specific to the link boundary, but it is **not**
the classification-arm gap S52 diagnosed — that gap can only matter when a
real trap closure exists to misclassify, and here there is none.

**HAS and isExtensible on the same empty-handler Proxy make it worse, not
better: they don't throw, they silently return the wrong answer** (`0`
instead of `1` for both). So cross-module Proxy dispatch is broken across at
least three independent traps (get/has/isExtensible), in two different failure
modes (throw vs. silent wrong value), on a proxy whose handler defines *no
traps at all* and should be behaviorally transparent.

Decompiling the provider's `__proxy_get_dispatch` (WAT, `wasm-dis -all`)
shows the traps struct (`$__ProxyTraps`, 13 externref fields, one per trap
name) is **structurally identical** between provider and consumer compiles
(confirmed by diffing both modules' WAT type sections) — so this is not a
struct-layout/field-index mismatch of the kind #6600/#6605 fixed for object
literals. The `$Proxy` struct's 7-field shape (`ptag`/`ptarget`/`phandler`/
`ptraps`/`revoked`/`callable`/`constructible`) also matches field-for-field.
Something about how the trap slot (or the receiver forwarding path for
HAS/isExtensible) is read/interpreted across the link boundary is still
wrong, and it is **not confined to trap classification** — it reaches into
receiver/target forwarding for traps that were never even defined.

## What's still open

This needs a fresh diagnosis pass, not a continuation of the classification
fix already on this branch:

1. Why does an **absent** get trap on a cross-module Proxy reach the
   "trap present, not callable" throw at all, when the traps-struct field
   read is structurally sound? Candidates not yet ruled out: (a) the
   PROVIDER's local `TRAP_GET` field-index constant may not agree with
   whatever order `ensureProxyRuntime`'s struct-type builder used when
   `$__ProxyTraps` was reserved in a module that has no `new Proxy` of its
   own (registration-order dependent field indices, rather than a fixed
   enum — not yet confirmed either way by reading `object-runtime-proxy.ts`'s
   struct-builder code); (b) the CONSUMER's Proxy constructor may store
   something other than `ref.null.extern` for an absent trap when it knows
   the Proxy will cross a link boundary (unlikely, no such branch was found,
   but not exhaustively ruled out); (c) `any.convert_extern`/`ref.cast` at
   the `$Proxy` boundary crossing may not preserve the SAME struct instance
   identity the reverse channel needs.
2. Why do HAS/isExtensible answer **wrong but non-throwing** instead of
   either the correct value or a consistent throw — same underlying defect
   with a different dispatch shape, or a second, independent defect?
3. Whether the `localApply`/`reverseApply` terminal added on this branch is
   needed at all once (1) is fixed, given `__call_fn_method_N`'s direct
   cross-module `ref.cast` already appears to work for closures per #6628's
   own canonicalization comment (confirmed indirectly here: `identity()`
   passes a Proxy through untouched with no error, and #6605's own witness
   suite already proves cross-module closure invocation works for methods).
4. Re-run the original 10 sample-row list (`Duration/from/order-of-operations.js`
   etc.) against a real fix once (1)-(2) are resolved — they were not
   attempted this session, since the minimal repro above already shows the
   underlying mechanism does not work yet.

## Recommendation

Escalate for a fresh diagnosis of `__proxy_get_dispatch`/`__proxy_call_has`/
`__proxy_isExtensible_dispatch` (or whichever functions those lower to)
against a cross-module `$Proxy`+`$__ProxyTraps` pair, ideally with the
ability to read back raw struct field values (not just types) from both
sides — something this session could not do without a native-strings-aware
JS host to decode thrown values. The `localCallableKind`/`reverseCallableKind`
terminal on this branch is real, typechecked, and correctly wired, but it
does not unblock the 10 sample rows by itself; do not merge it as a
standalone fix without the deeper Proxy-dispatch defect also being
addressed, or re-scope it as a component of a larger Proxy cross-module fix.

## Implementation notes / commits

- `src/codegen/standalone-link-reverse-peer.ts` — two new terminals
  (callableKind, apply), `install` signature grown 5→7 params, all call
  sites updated.
- `src/codegen/typeof-natives-finalize.ts` — `__typeof_function` reverse
  fallback arm.
- No test file committed (gitignored `tests/probe-*.test.ts` /
  `.tmp/s52b/*` convention) — repro steps above are reproducible from the
  harness pattern in `tests/issue-6605-link-reverse-method-call.test.ts`.
