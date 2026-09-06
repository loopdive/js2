---
id: 5316
title: "ES2015 standalone proxy — r4: §10.5 descriptor-model invariants, Reflect.set receiver, [[Construct]] NewTarget forwarding"
status: in-progress
sprint: current
created: 2026-09-04
updated: 2026-09-04
priority: high
horizon: xl
feasibility: hard
model: opus
reasoning_effort: medium
task_type: conformance
area: codegen, runtime
language_feature: proxy, reflect
es_edition: ES2015
goal: standalone-mode
requested_by: claude.ai@loopdive.com/fable-es6
related: [5196, 5140, 1355, 2046, 3371, 4444]
loc-budget-allow:
  # 2026-09-04 r4 plan: the §10.5 descriptor-model validators are NEW emitted
  # natives (one per trap, ~40-120 lines each of instruction building) and go
  # in the new module object-runtime-proxy-invariants.ts; the receiver-
  # threaded [[Set]] goes in the new object-runtime-ordinary-set.ts; the
  # existing files grow by dispatch wiring only.
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime-proxy-invariants.ts
  - src/codegen/object-runtime-ordinary-set.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime.ts
  - src/codegen/reflect-target-guard.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/native-construct.ts
  - src/codegen/index.ts
  # 2026-09-05 r5 step 2: the `Object.getOwnPropertyDescriptor` literal-key
  # fold's else arm (reached only when its own guarded `ref.test` has FAILED)
  # stops answering a flat `undefined` and routes to the dynamic
  # `__getOwnPropertyDescriptor` native instead, so a `$Proxy` receiver reaches
  # its trap. The emitted arm is five instructions; the rest of the growth is
  # the comment recording WHY a miss is not `undefined` here — the next reader
  # of this arm has to know that the guard failing is the interesting case, not
  # the boring one. The arm has to live at the fold, which is in this file.
  - src/codegen/expressions/call-builtin-static.ts
  # 2026-09-05 r5 step 1: the fourth `__integrity_bag` arm (#4194 instance
  # expando carrier). Ten instructions plus the comment that records why ENSURE
  # is right here while `carrier-bag-visibility.ts` refuses to ensure.
  - src/codegen/object-integrity-carrier.ts
func-budget-allow:
  # 2026-09-04 r4 step 1: `registerProxyInvariantValidators` is ONE function
  # only in the TypeScript sense — its body is seven independent
  # `registerNative` calls, one per §10.5 trap, each an instruction-building
  # block that shares nothing but the local emitter helpers (isAbsent /
  # hasField / truthyField / loadTargetDesc) declared above them. Splitting it
  # would mean re-threading those 13 baked funcIdx + the shared
  # `throwInvariant` factory through seven signatures, which buys no
  # comprehension and multiplies the double-remap hazard the module header
  # documents. `ensureProxyRuntime` grows only by the registration call, the
  # `validateTrapResult` splice helper and the per-arm wiring.
  - src/codegen/object-runtime-proxy-invariants.ts::registerProxyInvariantValidators
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  # 2026-09-05 r5 step 2: see the LOC rationale above — the else arm of the
  # gopd literal-key fold is inside this one dispatcher function, and moving it
  # out would mean re-threading `gopdTmp`, `propLiteral`, `fctx` and the
  # late-import flush order (which is load-bearing: the else arm must resolve
  # AFTER the then arm's imports) through a new signature for five instructions.
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  # 2026-09-05 r5 step 3: `in` stops folding a positive answer when the receiver
  # is a directly-bound `new Proxy(...)`. Two lines of logic (the route
  # predicate and its place in the existing `has` cascade + runtime-route
  # disjunction); the rest is the comment recording why `isDirectProxyBinding`
  # and not the wider `tracesToProxyValue`, whose aliases the documented
  # widening defect nulls. Both lines have to sit inside this cascade.
  - src/codegen/binary-ops-in.ts::compileInOperator
  # 2026-09-05 r5 step 6: `ensureObjectRuntime` grows by ONE call plus the
  # comment explaining its position — `registerOrdinarySetWithReceiver` must run
  # after every native it reads (`__getOwnPropertyDescriptor`,
  # `__getPrototypeOf`, `__extern_get/set/has`, the `__call_accessor_set`
  # driver), which is only true at the end of this function, and appending there
  # shifts no existing funcIdx. The §10.1.9.2 body itself is a new module.
  - src/codegen/object-runtime.ts::ensureObjectRuntime
coercion-sites-allow:
  # 2026-09-04 r4 step 1: the two hits are `__is_truthy` and the `__host_eq`
  # fallback arm of `ensureExternStrictEqHelper`. Neither hand-rolls a
  # coercion matrix — §10.5 states its invariants literally in terms of
  # ToBoolean (`If <trapResult> is true`) and SameValue (`SameValue(V,
  # targetDesc.[[Value]])`), and these are the same two helpers the #5140
  # target-independent half already calls for exactly those two spec
  # operations. The preferred `__object_is` is used when present; `__host_eq`
  # is only the last fallback, mirroring `buildOwnKeysDispatch`.
  - src/codegen/object-runtime-proxy-invariants.ts
  # 2026-09-05 r5 steps 5-6: three `__is_truthy` uses, all of them a spec step
  # that literally says ToBoolean, and none of them a hand-rolled matrix:
  #   • §20.1.2.19 step 3 and §20.1.2.21 step 4 — "if status is false, throw a
  #     TypeError" over a Proxy trap's booleanish result (call-builtin-static);
  #   • §10.1.9.2 steps 3.a / 3.d.ii — "if ownDesc.[[Writable]] is false, return
  #     false" over a descriptor field (object-runtime-ordinary-set).
  # `__is_truthy` IS the shared engine's ToBoolean; the alternative here would
  # be reference truthiness, which the #5140 half already established is wrong
  # for a trap result.
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/object-runtime-ordinary-set.ts
  # 2026-09-06 review r1 F2: one more `__is_truthy`, in the `$Proxy` front
  # guard this round adds to `__reflect_set`. §26.1.13 step 3 is
  # `target.[[Set]](key, V, target)` and §10.5.9 returns the trap's booleanish
  # result, so the guard has to ToBoolean it exactly as the sibling
  # `__extern_has` and `__delete_property` guards in this same file already do
  # (they are 2 of the 6 pre-existing hits). Same helper, same spec operation,
  # no new matrix.
  - src/codegen/object-runtime-proxy.ts
---

## Problem

After #5196 r3 (PR #5576, merged 2026-09-04), the ES2015 standalone census
(baseline promoted from that merge, 10,131 / 11,704) still has **134 non-pass
rows in `built-ins/Proxy` + `built-ins/Reflect`**: 112 `fail`, 22
`compile_error`. Three mechanisms account for 75 of them, and all three live
in the proxy runtime (`src/codegen/object-runtime-proxy.ts` and the modules the
r2 plan reserved beside it):

1. **§10.5 descriptor-model invariants — 50 rows, all `Test262Error: Expected a
   TypeError to be thrown but no exception was thrown at all`.** #5140 shipped
   the *target-independent* half (getPrototypeOf / setPrototypeOf /
   isExtensible / preventExtensions, expressible with `__object_isExtensible`,
   `__getPrototypeOf`, `__is_truthy` and strict equality — see the comment
   block at `object-runtime-proxy.ts` ~L408 "(#5140) §10.5 post-trap invariant
   validation"). The DESCRIPTOR half — the rules that need the target's own
   property descriptor — was "deferred to #1355 slice G" and never landed: a
   trap may currently report a non-configurable property as absent, define an
   incompatible descriptor, delete a non-configurable key, hide keys from
   `ownKeys`, or return a primitive from `construct`, and the proxy returns the
   trap's answer as-is.

   | trap directory | rows |
   | --- | ---: |
| `built-ins/Proxy/defineProperty` | 14 |
| `built-ins/Proxy/getOwnPropertyDescriptor` | 9 |
| `built-ins/Proxy/construct` | 7 |
| `built-ins/Proxy/ownKeys` | 4 |
| `built-ins/Proxy/deleteProperty` | 3 |
| `built-ins/Proxy/get` | 2 |
| `built-ins/Proxy/has` | 2 |
| `built-ins/Proxy/set` | 2 |
| `built-ins/Proxy/getPrototypeOf` | 1 |
| `built-ins/Proxy/preventExtensions` | 1 |
| `built-ins/Proxy/setPrototypeOf` | 1 |
| `built-ins/Reflect/has` | 1 |
| `built-ins/Reflect/construct` | 1 |
| `built-ins/Reflect/apply` | 1 |
| `built-ins/Reflect/get` | 1 |

2. **`Reflect.set(target, key, value, receiver)` — 15 `compile_error` rows**
   ("Reflect.set with an explicit receiver argument is not yet supported in
   --target standalone (#2046)", refusal at
   `expressions/call-namespace-static.ts` ~L1106). `__reflect_set` writes the
   data-property subset on `target` itself and has no receiver slot. #2046's
   Codex checkpoint PR #5397 (2026-09-01, NOT mergeable, `dirty` against
   main; diff saved at `/home/user/js2/.tmp/wave4/pr5397-2046-reflect-set-receiver.diff`)
   stalled on exactly the piece this lane owns: "the current ordinary-source
   admission cannot soundly exclude Proxy prototypes reached through aliases
   and prototype mutation … keep draft until … coordinated Proxy runtime
   support exists." The receiver-threaded [[Set]] is the r2 plan's
   `object-runtime-ordinary-set.ts` (OrdinarySet with receiver, §10.1.9.2),
   with the proxy's `set` trap as one arm of the same dispatch — so it is
   built HERE, where the proxy runtime is, not in the namespace-static caller.

3. **Proxy [[Construct]] NewTarget forwarding — 10 `compile_error` rows**
   ("standalone Reflect.construct cannot preserve an arbitrary distinct
   NewTarget", refusal at `call-namespace-static.ts` ~L1940). These are the
   rows of #3371's "Proxy carrier slice (rows 20-29)": `Reflect.construct(P,
   args, NT)` on a proxy must call the `construct` trap with `newTarget` (and,
   absent a trap, forward to `Construct(target, args, newTarget)`), then apply
   §10.5.13 step 10 (non-Object result → TypeError). #3371's other 23 rows are
   the separate reflect lane's; this lane owns the proxy arm because it is a
   [[Construct]] dispatch inside `object-runtime-proxy.ts`.

Everything else in the cluster (37 `fail` rows: handler-is-context
descriptors, `ownKeys` result arrays, revocable edge cases, ...) is recorded,
not claimed; measure it in step 0 and leave the list in the report.

### Rows

§10.5 invariants (50):

- `test/built-ins/Proxy/construct/return-not-object-throws-undefined-realm.js`
- `test/built-ins/Proxy/deleteProperty/targetdesc-is-configurable-target-is-not-extensible.js`
- `test/built-ins/Proxy/ownKeys/not-extensible-new-keys-throws.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor-realm.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor-not-configurable-target-realm.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-invalid-descriptor.js`
- `test/built-ins/Proxy/deleteProperty/targetdesc-is-not-configurable.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined.js`
- `test/built-ins/Proxy/getPrototypeOf/instanceof-target-not-extensible-not-same-proto-throws.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-null-realm.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-configurable-writable-desc-not-writable.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-boolean-realm.js`
- `test/built-ins/Proxy/get/accessor-get-is-undefined-throws.js`
- `test/built-ins/Proxy/has/return-false-target-not-extensible.js`
- `test/built-ins/Proxy/has/return-false-targetdesc-not-configurable.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-number-realm.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-undefined-not-configurable-descriptor-realm.js`
- `test/built-ins/Proxy/preventExtensions/trap-is-missing-target-is-proxy.js`
- `test/built-ins/Proxy/ownKeys/not-extensible-missing-keys-throws.js`
- `test/built-ins/Proxy/set/target-property-is-accessor-not-configurable-set-is-undefined.js`
- `test/built-ins/Proxy/construct/trap-is-not-callable-realm.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-string-realm.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/result-is-undefined-targetdesc-is-not-configurable.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-configurable-desc-not-configurable.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined-realm.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-targetdesc-is-configurable.js`
- `test/built-ins/Proxy/set/target-property-is-not-configurable-not-writable-not-equal-to-v.js`
- `test/built-ins/Proxy/get/not-same-value-configurable-false-writable-false-throws.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/trap-is-not-callable-realm.js`
- `test/built-ins/Proxy/setPrototypeOf/trap-is-missing-target-is-proxy.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-not-writable-targetdesc-is-writable.js`
- `test/built-ins/Proxy/defineProperty/null-handler.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-undefined-target-is-not-extensible-realm.js`
- `test/built-ins/Proxy/defineProperty/trap-is-not-callable-realm.js`
- `test/built-ins/Proxy/ownKeys/return-all-non-configurable-keys.js`
- `test/built-ins/Proxy/deleteProperty/trap-is-null-target-is-proxy.js`
- `test/built-ins/Proxy/defineProperty/trap-is-undefined-target-is-proxy.js`
- `test/built-ins/Proxy/construct/return-not-object-throws-symbol-realm.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-undefined-not-configurable-descriptor.js`
- `test/built-ins/Reflect/has/target-is-not-object-throws.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-undefined-target-is-not-extensible.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-targetdesc-is-undefined.js`
- `test/built-ins/Proxy/ownKeys/return-not-list-object-throws-realm.js`
- `test/built-ins/Proxy/getOwnPropertyDescriptor/result-is-undefined-target-is-not-extensible.js`
- `test/built-ins/Reflect/construct/target-is-not-constructor-throws.js`
- `test/built-ins/Reflect/apply/arguments-list-is-not-array-like.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-not-compatible-descriptor-not-configurable-target.js`
- `test/built-ins/Proxy/defineProperty/targetdesc-configurable-desc-not-configurable-realm.js`
- `test/built-ins/Reflect/get/target-is-not-object-throws.js`

`Reflect.set` receiver (15):

- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-in-bounds-receiver-is-not-typed-array.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-not-object.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-valid-index-reflect-set.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-canonical-invalid-index-reflect-set.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-proto.js`
- `test/built-ins/TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-not-typed-array.js`
- `test/built-ins/Reflect/set/return-false-if-target-is-not-writable.js`
- `test/built-ins/Reflect/set/symbol-property.js`
- `test/built-ins/Reflect/set/different-property-descriptors.js`
- `test/built-ins/Reflect/set/set-value-on-accessor-descriptor-with-receiver.js`
- `test/built-ins/Reflect/set/set-value-on-data-descriptor.js`
- `test/built-ins/Reflect/set/receiver-is-not-object.js`
- `test/built-ins/Reflect/set/creates-a-data-descriptor.js`
- `test/language/statements/with/set-mutable-binding-idref-compound-assign-with-proxy-env.js`
- `test/language/statements/with/set-mutable-binding-idref-with-proxy-env.js`

Proxy [[Construct]] NewTarget (10):

- `test/built-ins/Proxy/construct/call-parameters-new-target.js`
- `test/built-ins/Proxy/get-fn-realm.js`
- `test/built-ins/Proxy/construct/trap-is-undefined.js`
- `test/built-ins/Proxy/construct/trap-is-null.js`
- `test/built-ins/Proxy/get-fn-realm-recursive.js`
- `test/built-ins/Proxy/construct/trap-is-null-target-is-proxy.js`
- `test/built-ins/Proxy/construct/trap-is-undefined-proto-from-cross-realm-newtarget.js`
- `test/built-ins/Proxy/construct/trap-is-undefined-target-is-proxy.js`
- `test/built-ins/Proxy/construct/trap-is-missing-target-is-proxy.js`
- `test/built-ins/Proxy/construct/trap-is-undefined-no-property.js`

## Implementation Plan — r4 (2026-09-04, Fable)

**Step 0 — inventory (measured, both trees).** Put the 75 paths above in
`.tmp/5316-rows.txt` and run them `--isolate --standalone` on a
`git archive origin/main` base tree and on the lane worktree; record status +
error per row. Also run the enclosing control corpus — every ES2015 row under
`test/built-ins/Proxy` and `test/built-ins/Reflect` (523 rows; #5196 r3
measured 382 pass on the same corpus before its merge, expect ≈ that plus
this wave's) — and keep the list of currently-passing rows: none may be lost.
Read `object-runtime-proxy.ts` end to end first, then
`object-runtime-descriptors.ts` (the standalone attribute model:
`__getOwnPropertyDescriptor`-family natives, the descriptor struct/record
shape, `IsCompatiblePropertyDescriptor` if it exists — grep
`ValidateAndApplyPropertyDescriptor` / `isCompatible`), and the #5196 r2 plan
section "2026-09-01 r2 residual plan" for the module layout it reserved.

**Step 1 — descriptor-model invariants (§10.5.5–§10.5.13), in a NEW
`object-runtime-proxy-invariants.ts`.** One native per trap, each taking
`(p: $Proxy, key, trapResult…)` and either returning the validated result or
throwing the existing `invariantMsg` TypeError (reuse `throwInvariant` /
`invariantMsg` from the #5140 block — do not mint a second message). Wire each
into the corresponding `build…Dispatch` arm in `object-runtime-proxy.ts`
AFTER the trap call, in spec order (trap result first, then
`target.[[GetOwnProperty]](P)`, then the checks). Spec step lists, which the
implementation must follow literally:

- `getOwnPropertyDescriptor` (§10.5.5 steps 9-17): result must be Object or
  undefined; `targetDesc = target.[[GetOwnProperty]](P)`; undefined result ⇒
  targetDesc must be undefined, or configurable AND target extensible;
  Object result ⇒ `ToPropertyDescriptor`, `CompletePropertyDescriptor`,
  `IsCompatiblePropertyDescriptor(IsExtensible(target), resultDesc,
  targetDesc)` must be true; `resultDesc.[[Configurable]] === false` ⇒
  targetDesc must exist and be non-configurable, and (step 17.b) if resultDesc
  has `[[Writable]] === false` then targetDesc.[[Writable]] must be false.
- `defineProperty` (§10.5.6 steps 9-16): falsy trap result ⇒ return false (no
  throw); `targetDesc = target.[[GetOwnProperty]](P)`; `settingConfigFalse =
  Desc has [[Configurable]] and it is false`; targetDesc undefined ⇒ target
  must be extensible and settingConfigFalse must be false; else
  `IsCompatiblePropertyDescriptor(extensible, Desc, targetDesc)` must hold,
  settingConfigFalse ⇒ targetDesc non-configurable, and (16.b.ii) a data
  targetDesc that is non-configurable and writable with `Desc.[[Writable]] ===
  false` is a TypeError.
- `has` (§10.5.7 step 9): falsy result ⇒ targetDesc, if present, must be
  configurable and target extensible.
- `get` (§10.5.8 step 10): non-configurable non-writable data targetDesc ⇒
  result must `SameValue` the target value; non-configurable accessor with
  undefined [[Get]] ⇒ result must be undefined.
- `set` (§10.5.9 step 9): truthy result over a non-configurable non-writable
  data targetDesc ⇒ value must SameValue; over a non-configurable accessor
  with undefined [[Set]] ⇒ TypeError.
- `deleteProperty` (§10.5.10 steps 11-13): truthy result ⇒ targetDesc must be
  absent or configurable, and (ES2020+, step 13) target must be extensible.
- `ownKeys` (§10.5.11 steps 7-23): `CreateListFromArrayLike(result, «String,
  Symbol»)` — non-key element ⇒ TypeError; duplicates ⇒ TypeError; every
  non-configurable target key must appear; if target is non-extensible every
  target key must appear AND nothing else.
- `construct` (§10.5.13 step 10): non-Object trap result ⇒ TypeError. (The
  NewTarget forwarding itself is step 3.)

The target's own descriptor MUST come from the standalone attribute model
(the same native `Object.getOwnPropertyDescriptor` lowers to), and when the
target is itself a `$Proxy` it must go through that proxy's own
`getOwnPropertyDescriptor` dispatch (recursion, not a field read). Every
emitter is a factory returning a fresh `Instr[]` (the finalize funcIdx walk
double-remaps a shared array — see the #5140 comment). Control probes (node
oracle, compiled standalone, `imports === []`): each invariant with (a) a
plain extensible target, (b) a `Object.preventExtensions` target, (c) a
target with a non-configurable data property, (d) a non-configurable accessor,
(e) a proxy-of-proxy target — and for each, the trap answering both the
compliant and the violating value. 

**Step 2 — receiver-threaded [[Set]] (`Reflect.set` 4-arg), in a NEW
`object-runtime-ordinary-set.ts`.** Implement §10.1.9.2 OrdinarySetWithOwnDescriptor
as a native `__ordinary_set_with_receiver(O, P, V, Receiver)`: walk O's own
descriptor; data ⇒ if non-writable return false; if Receiver is not an Object
return false; `existingDesc = Receiver.[[GetOwnProperty]](P)`: accessor ⇒
false, non-writable ⇒ false, else `Receiver.[[DefineOwnProperty]](P, {[[Value]]:
V})`; absent ⇒ `CreateDataProperty(Receiver, P, V)`; accessor ⇒ setter absent
⇒ false, else `Call(setter, Receiver, «V»)`; own descriptor absent ⇒ recurse
on `O.[[GetPrototypeOf]]()` — and when that parent is a `$Proxy`, dispatch
its `set` trap with the ORIGINAL receiver (this is the arm PR #5397 could not
prove around; here it is one branch of the walk). Then replace the refusal at
`call-namespace-static.ts` ~L1106 with a call to it (the 3-arg form keeps its
current lowering; only the 4-arg form routes here), keeping the existing
Object-target TypeError guard and `ToPropertyKey` order (target guard →
ToPropertyKey → set). The `with`-statement rows in the list reach this
through the proxy-environment path (`language/statements/with/
set-mutable-binding-idref*-with-proxy-env.js`) — measure whether they flip for
free; do not build a `with` arm for them.

**Step 3 — Proxy [[Construct]] NewTarget forwarding.** In
`object-runtime-proxy.ts`'s construct dispatch add a NewTarget parameter: trap
present ⇒ `Call(trap, handler, «target, argArray, newTarget»)` then the step-10
check from step 1; trap absent/undefined/null ⇒ `Construct(target, args,
newTarget)` — which, for a proxy target, recurses, and for an ordinary
constructor must construct with the FORWARDED newTarget (its prototype
selection comes from `newTarget.prototype`). Then in
`call-namespace-static.ts` ~L1930-1950, before the "cannot preserve an
arbitrary distinct NewTarget" refusal, add the arm: when the target value is a
`$Proxy` at runtime (a `ref.test` on the evaluated target — no source-shape
proof needed, this is a runtime dispatch), call the new construct native with
the evaluated newTarget. Non-proxy targets keep the existing behaviour (the
refusal for unresolvable NewTarget stays for them; the reflect lane #3371
owns those). `get-fn-realm*.js` rows expect the realm of the innermost
non-proxy target for the default prototype — with one realm this is
`Object.prototype` of the module; make sure a proxy-of-proxy chain resolves
through to it.

**Order-preservation constraints.** Programs that never construct a
`$Proxy` must be byte-identical to base on every target (`--target
standalone`, host, wasi) — verify with a Proxy-free probe module. The
#5140 half's behaviour and error message do not change. `Reflect.set` with
3 arguments is byte-identical to base.

## Acceptance criteria

- The 75 listed rows: every one `pass` under `--isolate --standalone` on the
  lane tree, or explicitly given up in the report with the mechanism named
  (a given-up row is still a measured row).
- Control corpus (`built-ins/Proxy/**` + `built-ins/Reflect/**` ES2015): zero
  rows lost against the base tree, measured the same way.
- `tests/issue-5316-r4-invariants.test.ts`, `-receiver.test.ts`,
  `-construct-newtarget.test.ts`: kept rows pinned + the node-parity probe
  matrices above; all green at the CI fork heap.
- All gates green bare and against `origin/main`; typecheck; lint.
- Proxy-free programs byte-identical to base on standalone, host and wasi.

## Lane protocol (applies to every step above)

- **Worktree only.** Work in the worktree the workflow gave you; branch from the
  merge-base you were spawned on and `git pull --no-rebase --no-edit origin main`
  before the first source edit. `git merge` is hook-blocked in the repo root;
  `git pull --no-rebase` is not. Link `node_modules` and `test262` DIRECTLY to
  `/home/user/js2/node_modules` and `$(readlink -f /home/user/js2/test262)` (no
  symlink chains through sibling worktrees). Copy
  `/home/user/js2/.test262-cache/quickjs*` into the worktree's `.test262-cache/`
  and run `node scripts/build-quickjs-eval-provider.mjs` there, or every
  eval-dependent row fails fast with "quickjs provider is not built" and hides
  both wins and regressions.
- **Measure, do not predict.** Every row you claim flips is run with
  `npx tsx scripts/run-test262-paths.mts --isolate <list> --standalone` on BOTH
  a `git archive origin/main` base tree and the lane tree; the enclosing control
  corpus named in the plan is re-run the same way and every base-pass row must
  still pass. A `compile_timeout` under load is re-run alone before it counts.
  Name the artifact and the time for every number you write down.
- **The failure family to hunt for is "a working program now throws."** Every
  confirmed regression across the last four waves was a "provable" predicate
  resolving by NAME or by declaration shape without a single-assignment /
  shadowing proof. Decline to base unless the proof holds under reassignment,
  destructuring, loop heads, parameters, `eval`/`with` and shadowing — and
  never let a new arm change the answer of a program that worked on base.
- **Node is the oracle, but the engine differs.** CI runs node 25; this
  container runs node 22 (a node 25 lives at
  `/home/user/js2/.tmp/wrap/node25/cache/_npx/8758e404b5eed2f3/node_modules/node/bin`).
  A pin that asserts node's answer must probe the running engine, not assert a
  fixed value, when the two disagree (sloppy-function own `caller`/`arguments`
  is the known case).
- **Do not touch the other team's territory:** the generator carrier (#2864,
  every `__gen_*`/`__create_generator` row), the promise/microtask carrier
  (#2867), and built-in method reflection (#2175 — `length.js`/`name.js`/
  `prop-desc.js`/`not-a-constructor.js` rows and the
  "`Object.prototype.toString` / `Function.prototype.call` is not yet
  implemented in --target standalone" rows). Leave those rows out of your
  claims and your acceptance list; record them as gated.
- **Gates before every commit, chained:** `node scripts/check-loc-budget.mjs &&
  node scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs
  && npm run -s check:oracle-ratchet && npm run -s check:dead-exports`, then
  again with `LOC_GATE_BASE=$(git rev-parse origin/main)`; plus
  `pnpm run -s check:speculative-rollback` (a raw `fctx.body.length = n`
  rollback outside `context/speculative.ts` fails CI — use
  `withSpeculativeCompile`/`probeCompiledType`), `check:stack-balance`,
  `check:codegen-fallbacks`, `check:any-box-sites`, TS7 typecheck
  (`node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`)
  and `pnpm run -s lint`. Growth grants go in THIS issue's frontmatter
  (`loc-budget-allow` / `func-budget-allow`) with a dated rationale; never edit
  `scripts/*-baseline.json`. New codegen type queries go through `ctx.oracle`.
- **Tests:** `tests/issue-<id>-r4-*.test.ts` pin every kept row through
  `runTest262File(file, "issue-<id>", 60_000, "standalone")` plus node-parity
  probes compiled with `compile(source, { target: "standalone", allowJs: true,
  skipSemanticDiagnostics: true })`, asserting `result.imports` is `[]`. Run
  them at the CI fork heap, single fork:
  `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 npx vitest run tests/issue-<id>*.test.ts
  --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
  --dangerouslyIgnoreUnhandledErrors`.
- **Commits:** author stays the repo's configured identity; subject ends with
  ` ✓`; `SKIP_SLOW_PRECOMMIT=1`; never `--no-verify`; trailers
  `Model: Claude Opus 5 Medium`, `Co-Authored-By: Claude Opus 5
  <noreply@anthropic.com>`. Commit each step separately with the measurement
  in the body. Do NOT push, open a PR, or enqueue — the integrator merges the
  lane branch, validates the combined tree and opens the PR.
- **Report** (your final message): the per-step row table (base → lane, kept /
  given up), the control-corpus result, gate status, the worktree path and head
  sha, and every residual with its mechanism.


## 2026-09-04 r4 implementation (Opus)

**Delivered: step 1 only.** Steps 2 (`Reflect.set` receiver) and 3 (Proxy
[[Construct]] NewTarget forwarding) are **given up** in this pass, with the
mechanism named below — they are untouched, so their 25 rows are byte-for-byte
the refusals the plan describes.

Worktree `/home/user/js2/.claude/worktrees/wf_a9776683-b00-1`, branch
`worktree-wf_a9776683-b00-1`. Base tree for every A/B: `.tmp/base`
(`git archive origin/main`, main at `f9bf876899`), both trees provisioned with
the same `node_modules`/`test262` links, compiler+runtime bundles and a
tree-local quickjs eval adapter. **The quickjs adapter is keyed on the compiler
bundle hash — it must be rebuilt after every source change**, or every `-realm`
row fails "quickjs provider is not built" and hides both wins and regressions
(cost this lane one full 36-row cycle).

### Step 1 — §10.5 descriptor-model invariants

New `src/codegen/object-runtime-proxy-invariants.ts`: seven validator natives,
one per trap, `(target, key, …, trapResult) -> trapResult | throw`, called from
the matching dispatch arm in `object-runtime-proxy.ts` immediately after the
trap driver. The target's own descriptor comes from
`__getOwnPropertyDescriptor`, whose `$Proxy` front-guard gives the
proxy-of-proxy recursion §10.5 requires for free.

Rows, `npx tsx scripts/run-test262-paths.mts --isolate .tmp/step1-rows.txt
--standalone`, base tree vs lane, 2026-09-04/05:

| | base | lane |
| --- | ---: | ---: |
| pass | 0 | **19** |
| fail | 36 | 8 |
| compile_error | 0 | 9 |

Kept (19): the four `getOwnPropertyDescriptor/resultdesc-*` +
`result-is-undefined-targetdesc-is-not-configurable` rows; six
`defineProperty/targetdesc-*` rows; `deleteProperty/targetdesc-is-not-
configurable`; `has/return-false-targetdesc-not-configurable`; both `get/*`
rows; both `set/target-property-*` rows; all three `ownKeys/*` key-set rows.

### The regression this lane found in its own work

The first cut also implemented `IsExtensible(target)` — §10.5.7 step 9.b.ii and
§10.5.10 step 15 — and flipped 21 rows. The control corpus caught it: two rows
that **pass on `origin/main`** started throwing.

- `built-ins/Proxy/deleteProperty/call-parameters.js`
- `built-ins/Proxy/has/return-false-target-prop-exists-using-with.js`

Both have an ordinary extensible object-literal target (`{attr: 1}`). Isolated
by temporarily tagging each validator's TypeError with its own name: the `has`
and `delete` validators were the ones firing, and removing only the
extensibility clause made both rows pass again. Called on the proxy's `ptarget`
from inside the dispatch, `__object_isExtensible` answers *non-extensible* for
a target that never saw `preventExtensions` — a direct `Object.isExtensible` on
the same shapes answers correctly (probed both, `.tmp/probe/ext2.ts`), so the
discrepancy is specific to the dispatch-internal call and was not pinned down
further here. **The clause is declined**, costing exactly two rows
(`has/return-false-target-not-extensible.js`,
`deleteProperty/targetdesc-is-configurable-target-is-not-extensible.js`) and
buying back both regressions. A missed throw is a residual; a wrong throw
breaks a working program.

### Control corpus

Every ES2015 row under `built-ins/Proxy` + `built-ins/Reflect` (464 files),
`--isolate --standalone`, base tree vs lane:

| | base | lane |
| --- | ---: | ---: |
| pass | 312 | **349** |
| fail | 115 | 93 |
| compile_error | 37 | 22 |

**Rows lost (base `pass` → lane non-pass): ZERO.** 37 rows gained. The three
apparent losses in the FIRST lane control run
(`preventExtensions/call-parameters.js`,
`preventExtensions/return-true-target-is-not-extensible.js`, `Proxy/proxy.js`)
were **compile timeouts under 4-lane load** — all three pass when re-run alone
at `COMPILER_POOL_SIZE=1`. A second run was additionally poisoned by the
worktree's `test262` symlink being replaced by an empty submodule stub
mid-flight (223 `ENOENT` rows); restoring the symlink and re-running gave the
table above. Watch for that: an `error`/`ENOENT` bucket is an infrastructure
failure, not a measurement.

### Order preservation — one deviation, measured

A program that touches no MOP helper is **byte-identical** to base on host,
standalone and wasi (`.tmp/probe/plain.ts`). A **Proxy-free** program that uses
`Object.defineProperty`/`getOwnPropertyDescriptor`/`in`/
`Reflect.deleteProperty` is byte-identical on **host** but grows on standalone
(128,970 → 135,186 bytes, +4.8 %) and wasi (102,209 → 107,656, +5.3 %). Cause:
those helpers already carry the `$Proxy` front-guard on `main`, so the proxy
dispatch bodies were already reachable in such a module; the validators join an
already-live set. Avoiding it would mean gating the whole proxy-dispatch
subsystem on an actual `new Proxy` site — a pre-existing property of the
design, not something this slice introduced, and out of scope here.

### Residuals

| rows | mechanism |
| ---: | --- |
| 15 | `Reflect.set` 4-arg — **step 2 not built.** The refusal at `call-namespace-static.ts` ~L1106 stands. The receiver-threaded §10.1.9.2 `OrdinarySet` is a new walk over own-descriptor / prototype / proxy-`set`-trap arms; building it on top of an attribute model that already mis-describes object-literal own properties (see the two regressions above) would have shipped the same false-positive family into every `Reflect.set`. |
| 10 | Proxy [[Construct]] NewTarget — **step 3 not built.** The refusal at ~L1940 stands. The site rewrites `Reflect.construct(T, a, NT)` into a synthesized `new T(...)` AST node and compiles that; inserting a runtime `ref.test $Proxy` arm means evaluating the target once into a local before that rewrite, which double-evaluates the target expression on the non-proxy arm unless the whole site is restructured. |
| 6 | `-realm` rows: cross-realm proxies from `$262.createRealm()` do not reach this runtime's dispatch; several also compile-time out at ~15 s even at `COMPILER_POOL_SIZE=1`. |
| 3 | `getOwnPropertyDescriptor/{result-type-is-not-object-nor-undefined, result-is-undefined-target-is-not-extensible, resultdesc-is-not-configurable-targetdesc-is-configurable}` — the target is an object literal whose own property the standalone attribute model does not describe through the dispatch, so `target.[[GetOwnProperty]]` has nothing to reconcile against. Same root cause as the pre-existing `has/return-false-target-prop-exists.js` failure (verified identical on the base tree). |
| 2 | `has/return-false-target-not-extensible.js`, `deleteProperty/targetdesc-is-configurable-target-is-not-extensible.js` — the declined extensibility clause above. |
| 1 | `defineProperty/null-handler.js` — a revoked proxy is not caught on the `__obj_define_from_desc` path. |
| 2 | `deleteProperty/trap-is-null-target-is-proxy.js`, `defineProperty/trap-is-undefined-target-is-proxy.js` — string/array exotic own properties reached through a proxy chain. |

Not claimed and not touched, per the lane protocol: the generator carrier
(#2864), the promise/microtask carrier (#2867) and built-in method reflection
(#2175).

### Review round 1 (2026-09-05)

Fix-round lane, worktree `/home/user/js2/.claude/worktrees/wf_05fc6ce9-91e-1`,
branch `worktree-wf_05fc6ce9-91e-1` (fresh worktree of
`claude/es6-test262-standalone-g10c7u`, then `git merge worktree-wf_a9776683-b00-1`).
Base tree for every A/B: `.tmp/rev5316/base` (`origin/main` at `f9bf876899`).
One confirmed finding, fixed; one refuted, left as the lane wrote it.

#### F1 — the validators were wired on `--target wasi` too, and broke it (FIXED)

**What went wrong.** `--target wasi` sets `ctx.wasi` and leaves `ctx.standalone`
false, and `ensureProxyRuntime` runs on both. So the §10.5 validators were live
under wasi, where **10 of 10 compliant Proxy probes that work on `origin/main`
and in node threw a TypeError** (`.tmp/rev5316/p/final`, harness
`.tmp/rev5316/p/batch.mts` with `TGT=wasi`):

| probe | node | base wasi | lane wasi (before fix) | fixed wasi |
| --- | ---: | ---: | --- | ---: |
| c09 c13 c14 c27 f01 f02 f06 f07 q12 z06 | 3 2 3 99 1 1 1 1 1 1 | same | **TypeError ×10** | same as node |

**Why — the validators are sound, their inputs are not on wasi.** Measured on
the BASE tree with **Proxy-free** probes (`.tmp/rev5316/p/w5`), i.e. this is a
pre-existing `origin/main` defect, not something r4 introduced. Three of the
primitives the validators consume answer wrongly for an ordinary object literal
under wasi, while standalone answers all three correctly:

| probe | program | node | standalone | **wasi** |
| --- | --- | ---: | ---: | --- |
| `w5/e1` | `Object.isExtensible({a:1,b:2})` | 1 | 1 | **0 (says non-extensible)** |
| `w5/e2` | `Object.getOwnPropertyNames({a:1,b:2}).length` | 2 | 2 | **0 (no own names)** |
| `w5/e3`, `w5/e4` | `Object.getOwnPropertyDescriptor({a:1},"a")` | 1, 1 | 1, 1 | **traps** |

Feed those to a correct §10.5 check and every ordinary target looks
non-extensible with no own properties, so the trap answer "violates" an
invariant that was never violated. This is the same family as the
`IsExtensible` clause the lane already declined for standalone.

**Fix.** `registerProxyInvariantValidators` now returns `null` at the top when
`ctx.wasi`, before any registration or string-constant side effect. Every call
site already handles `null` by keeping the pre-#5316 unvalidated dispatch, so
wasi reverts to base behaviour with no new arm. Standalone is untouched — the
gate is on the target discriminator, and `ctx.wasi` is false there.

**Outcome, measured:**

| pin | result |
| --- | --- |
| 10 wasi probes vs node and base | **10/10 equal** (were 0/10) |
| wasi byte-identity vs base — 5 Proxy-free MOP probes + 1 Proxy program | **6/6 identical sha256** (e.g. `pxy.ts` 106,150 B `ed1042c80008` on both) |
| standalone byte-identity vs the unfixed lane, same 6 programs | **6/6 identical sha256** — the fix cannot move standalone |
| step-1 rows, `run-test262-paths.mts --isolate .tmp/step1-rows.txt --standalone` | **pass 19** — the lane's 19 kept rows, unchanged |
| 464-row control (`built-ins/Proxy` + `built-ins/Reflect`), same command | **pass 348, fail 91, compile_error 25** — vs base 312/115/37 and vs the lane 349/93/22. **Rows lost against base: ZERO** (set-diff of the non-pass lists, not just the totals). The single row below the lane, `Proxy/construct/null-handler-realm.js`, is a **compile timeout at 15.3 s** under load 7 on this box, is non-pass on base too, and **passes when re-run alone at `COMPILER_POOL_SIZE=1`** — the same timeout-under-load artifact the lane documented. |
| `tests/issue-5316-r4-invariants.test.ts`, node 22 and node 25 | 49/49 pass on both — the fix commit message quotes 45/45, a stale pre-pin count; the reviewer re-measured 49/49 on node 22 and node 25 (one vitest `onTaskUpdate` IPC timeout under concurrent load — infrastructure, no failed test) |

**Regression pin added.** Four `wasi probe stays working — …` cases in
`tests/issue-5316-r4-invariants.test.ts` compile the compliant get / ownKeys /
gopd / set shapes at `target: "wasi"` and assert the node value. A/B by file
copy: **4/4 fail with the gate reverted, 4/4 pass with it** — so a future
wiring change that forgets the gate turns them red instead of shipping silently.

**Ownership.** The three wrong answers above are the **wasi attribute model's**,
not r4's; they are unfixed and out of this slice. Until they are, the wasi lane
cannot carry any descriptor-model invariant. Probe file for whoever picks it up:
`.tmp/rev5316/p/w5/{e1,e2,e3,e4}.ts`.

**Re-learned the hard way:** the quickjs eval adapter is keyed on the compiler
bundle hash, so the first step-1 re-run after the source edit reported six
`-realm` rows as "quickjs provider is not built". Rebuild
`scripts/build-quickjs-eval-provider.mjs` after **every** bundle rebuild — the
lane's own note said so and it still cost a cycle.

#### F2 — refuted

No change. The decline note above (the `IsExtensible` clause, two rows) stands
as the lane wrote it.

## Handoff (2026-09-05, session claude/es6-test262-standalone-g10c7u)

**Shipped in this PR:** step 1 (§10.5 descriptor-model invariants, 19 rows) plus
the round-1 wasi gate (`if (ctx.wasi) return null;` at the top of
`registerProxyInvariantValidators`, four load-bearing wasi pins). The fix-round
review found no regression across 40 programs × 3 targets: standalone
byte-identical to the unfixed lane, wasi byte-identical to base, host untouched.
Standalone control (464 rows under `built-ins/Proxy` + `built-ins/Reflect`):
348 pass vs 312 on main, zero rows lost.

**Still open — in priority order:**

1. **The standalone attribute model does not describe object-literal own
   properties through a proxy dispatch.** This one gap blocks 3 gopd rows
   directly, forced the `IsExtensible` clause to be declined (2 rows), and is
   what makes the receiver-threaded `Reflect.set` (step 2, 15 rows) unsafe to
   build — it would inherit the same false-positive family into every
   `Reflect.set` call. Fix this first; the probe files are named in the r4
   residuals above.
2. **Step 2 — `Reflect.set` 4-arg receiver (15 rows)**, after 1. The design
   from PR #5397 (`.tmp/wave4/pr5397-2046-reflect-set-receiver.diff` when that
   scratch dir exists; otherwise the PR itself) is the starting point.
3. **Step 3 — Proxy `[[Construct]]` NewTarget forwarding (10 rows)**, after
   #3371's r1 arm and its refusal gate (see that issue's 2026-09-05 sections):
   the driver route can only install a prototype on the DataView window and the
   ordinary-function struct, so a Proxy NewTarget needs its own carrier.
4. **wasi attribute-model primitives are broken for object literals** — three
   concrete wrong answers measured on main
   (`Object.isExtensible({a:1,b:2}) → false`, `getOwnPropertyNames → 0`,
   `getOwnPropertyDescriptor` traps). Pre-existing, owned by the wasi target,
   not by this issue; the wasi gate stays until it is fixed.

Remaining `-realm` rows (6) and the two exotic-target-is-proxy rows are
documented in the residuals; none is reachable without a cross-realm model.

## Implementation Plan — r5 (2026-09-05, Fable lane; Opus-high implements)

Investigation (read-only, 2026-09-05, scratch `.tmp/w5/attr/`) overturned the
r4 residual's framing: the descriptor helpers DO describe an object literal's
own properties through a proxy dispatch on standalone (measured W/E/C=7,
`instance-props.ts:367-420` already has the closed-struct arm). Two real
defects remain, plus a static fold, plus the unbuilt receiver `Reflect.set`
whose primitives are all measured working on the base tree. Steps in strict
dependency order; step 1 must land before step 2 (probe `v1`: un-folding gopd
without the integrity arm ships a spurious TypeError to every Proxy program).

1. **`__integrity_bag` learns the #4194 instance carrier** —
   `src/codegen/object-integrity-carrier.ts:107` `registerIntegrityBagResolver`:
   append a fourth arm before the `ref.null.extern` terminal at L153, same shape
   as the vec/closure/Error arms: `if (__is_instance_expando_carrier(v)) return
   __closure_bag_ensure(v)`. Both funcIdx are already in `ctx.funcMap`
   (`reserveInstanceProps` at `object-runtime.ts:1325` precedes
   `buildObjectDescriptorHelpers` at L6345) — add instructions to the existing
   body, mint nothing, so no funcIdx shifts. Do not extend the §7.3.15 level walk
   (`decode(localIdx)` at L376-378 is restricted to the direct `$Object` on
   purpose). This fixes `Object.isExtensible/isFrozen/isSealed` and
   `Reflect.isExtensible` on object literals, class instances and `__fnctor_`
   structs (pristine instance: node 1 / base 6 → 1), and makes
   `preventExtensions`/`seal`/`freeze` on them actually record (mutators share
   `integrityBagIdx`, `object-runtime-integrity.ts:114`). Decide explicitly
   whether the predicate path may ENSURE a bag (the vec/closure/Error arms do;
   `carrier-bag-visibility.ts:58-62` states the opposite rule for the visibility
   resolver) — if you keep ENSURE, say why in the arm's comment.
2. **`Object.getOwnPropertyDescriptor` literal-key fold: the `else` arm calls
   the dynamic helper** — `src/codegen/expressions/call-builtin-static.ts:2973-2992`:
   under `ctx.standalone`, replace the `undefined` emit (reached only when the
   guarded `ref.test structTypeIdx` has already FAILED) with
   `local.get gopdTmp; extern.convert_any; <key string const>; call
   __getOwnPropertyDescriptor`, resolved with `ensureLateImport` +
   `flushLateImportShifts` AFTER the then-arm's late imports (mirror the
   `ensureGetUndefined` comment). The then-arm stays byte-identical. The second
   fold arm at L3083-3095 ("property not found in struct → undefined", no
   runtime guard) is a KNOWN residual — leave it, record it.
3. **`in` stops its positive fold on a Proxy-provenance receiver** —
   `src/codegen/binary-ops-in.ts:605`: `const proxyReceiverRoute = (ctx.standalone
   || ctx.wasi) && isDirectProxyBinding(ctx, expr.right)`; `has = proxyReceiverRoute
   ? false : <existing cascade>`, and add `proxyReceiverRoute ||` to the runtime
   route disjunction at L650-663. Use `isDirectProxyBinding`
   (`proxy-value-provenance.ts:108`), NOT `tracesToProxyValue` — the alias
   hazard documented at L120-127 is pre-existing and would turn a correct answer
   into `[]`.
4. **Restore the two §10.5 clauses r4 declined** —
   `src/codegen/object-runtime-proxy-invariants.ts`: in `__proxy_inv_has` (L437)
   append `...notExtensible(0), ...throwIf()` after the configurable check; in
   `__proxy_inv_delete` (L582) replace the L601-604 DECLINED note with the same
   two lines (fresh `Instr[]` per splice — the factories, never a shared array;
   the finalize remap walk has no dedup set). Delete the decline note; it was
   forced by step 1's gap, not by the clauses. Keep the `ctx.wasi` gate at L88 —
   step 1 fixes wasi's `isExtensible` but not its `getOwnPropertyNames` (0) or
   gopd (traps), which are `fillClosedStruct*Arms` being `ctx.standalone`-gated.
5. **`Object.preventExtensions` / `Object.setPrototypeOf` honour a false
   status** — `call-builtin-static.ts:1817-1855` returns the helper's externref
   and never implements §20.1.2.19 step 3 / §20.1.2.22 step 3 "if status is
   false, throw TypeError" (probes `y1`/`y2`: node throws, base returns). Add
   the throw on the standalone arm only where the helper reports a boolean
   status; measure that a Proxy-free `Object.preventExtensions(o)` is
   behaviour-identical (it always succeeds on ordinary objects).
6. **`Reflect.set` with an explicit receiver (§10.1.9.2)** — register
   `__reflect_set_receiver(target, key, value, receiver) -> i32` next to
   `__reflect_set` (`object-runtime.ts:4230`) and replace the refusal at
   `call-namespace-static.ts:1099-1118` with a call to it, keeping the
   `boundaryReflectInterop` arm (L1100-1107) ahead and reusing
   `emitReflectArgumentLocals` + `coerceReflectPropertyKey` so §7.1.19 abrupt
   completions still escape. Body from existing natives: `ownDesc =
   __getOwnPropertyDescriptor(target, key)`; absent ⇒ `parent =
   __getPrototypeOf(target)`, non-null ⇒ recurse on `(parent, key, value,
   receiver)`, null ⇒ default `{W,E,C:true}` data descriptor; data ⇒ `writable`
   falsy ⇒ 0; receiver not an Object (the by-exclusion test at
   `object-runtime-proxy-invariants.ts:163-178` or `emitNativeReflectNonObjectGuard`)
   ⇒ 0; `existing = __getOwnPropertyDescriptor(receiver, key)` accessor or
   non-writable ⇒ 0; present ⇒ `__obj_define_from_desc(receiver, key, {value})`;
   absent ⇒ `__extern_set(receiver, key, value)` (measured W/E/C=true, probe
   `r3`); accessor ⇒ `setter = __extern_get(ownDesc,"set")`, absent ⇒ 0, else
   `__call_accessor_set(receiver, setter, value)` ⇒ 1. The receiver is an explicit
   parameter throughout — no module-global channel. Keep the 3-arg path
   (L1121-1150) and the host 4-arg import (L2170) untouched. Then, as a
   SEPARATE commit, the `ref.test $__ta_dyn_view` arm for §10.4.5.5 in
   `ta-dyn-mop.ts` (`SameValue(O, Receiver)` ⇒ existing `__reflect_set` TA arm at
   L1109; else `!IsValidIntegerIndex` ⇒ 1; else the ordinary walk) — without it
   the 8 TypedArray rows move compile_error → fail. Export the native so the
   super-property lane (#5350 M2) can call it; that lane does not build its own.

Measurement protocol: base = `git archive origin/main` tree with linked
node_modules/test262 and a rebuilt bundle + quickjs eval provider (rebuild both
again after the last src edit); node 22 oracle, node 25 for changed test files;
reuse the investigation harnesses `.tmp/w5/attr/{runwrap2,hash,dump}.mts` and
probes `.tmp/w5/attr/*/` while they exist. Row lists: `.tmp/w5/attr/rows.txt`
(12 target rows), `rows-reg.txt` (9 held rows incl. the two r4 declined over),
and the two controls that were NOT run by the investigation and are required
here: every ES2015 row under `built-ins/Proxy` + `built-ins/Reflect` (464) and
every row under `built-ins/Object/{freeze,seal,preventExtensions,isExtensible,
isFrozen,isSealed}` (~317) — zero rows lost against base by set-diff of non-pass
paths, compile timeouts re-run alone at `COMPILER_POOL_SIZE=1`.

Acceptance: (a) the 6 measured flips (3 gopd rows, `has/return-false-target-
prop-exists`, `has/return-false-target-not-extensible`, `deleteProperty/
targetdesc-is-configurable-target-is-not-extensible`) + the 2 status rows
(`preventExtensions/trap-is-missing-target-is-proxy`, `setPrototypeOf/trap-is-
missing-target-is-proxy`) + 7 `Reflect/set` rows + 8 `TypedArrayConstructors/
internals/Set/*reflect-set*`/receiver rows pass; (b) both controls zero lost;
(c) byte-identical to base on host for every program, and on all targets for a
program that touches no MOP helper and for a Proxy-free program whose only MOP
use is `in`; the gopd then-arm unchanged; (d) pins in
`tests/issue-5316-r4-invariants.test.ts` (or a new r5 file) for each step
including the integrity matrix (pristine/frozen/sealed × literal/class
instance/array/function/Date = node), `v1`, `j1`/`j2`/`z4`, `w4`/`w5`, `r1`-`r5`
and the receiver `Reflect.set` shapes, all asserting `result.imports` `[]`; (e)
gates green bare and with `LOC_GATE_BASE=origin/main`; grants in this
frontmatter. Residuals to record, not fix: the `instanceof` fold
(`identifiers.ts:2913` `compileHostInstanceOf`, 1 row), the string/array-exotic
own properties through a proxy chain (2 rows), `defineProperty/null-handler`
(revoked proxy on the `__obj_define_from_desc` path), the four `Reflect.set`
rows reached through `with`/realm/array-length machinery, and the stale entries
in this issue's 50-row list that already pass (strike them).

## 2026-09-05/06 r5 implementation (Opus-high)

**All six plan steps delivered**, in seven commits (step 5 needed a second one,
found by measuring rather than by reading). One sub-step is DECLINED and named
under "Not built" below.

Worktree `/home/user/js2/.claude/worktrees/wf_2c593ff3-433-1`, branch
`worktree-wf_2c593ff3-433-1` — a fresh worktree at `origin/main` `2257b950ee`,
then `git merge claude/es6-test262-standalone-g10c7u` for the wave-5 plans. Base
tree for every A/B: `.tmp/base` (`git archive origin/main`, same `2257b950ee`),
with the same `node_modules`/`test262` links and its own compiler bundle,
runtime bundle and quickjs eval adapter. Node 22 is the oracle; every value the
pin file asserts was cross-checked on node 25 (v25.9.0).

Probe sources are `.tmp/w5/attr/**` (copied from the investigation, read-only)
plus `.tmp/p/**` (new, for step 6 and the strict-mode question). The A/B harness
`.tmp/ab.mts` compiles the SAME file through both trees and runs node on it, so
every three-column row below is one command.

### Step 1 — `__integrity_bag` learns the #4194 instance carrier

`object-integrity-carrier.ts`, a fourth arm before the `ref.null.extern`
terminal, routing `__is_instance_expando_carrier` to `__closure_bag_ensure`.
ENSURE, like the three arms above it, and the arm's comment says why that is not
in conflict with `carrier-bag-visibility.ts:58-62`: a `gopd`/enumeration query
must not conjure a bag, but here the bag is the ONLY place `[[Extensible]]` can
live, so refusing to mint it is refusing to answer.

| probe | what it asks | node | base | lane |
| --- | --- | ---: | ---: | ---: |
| `x/x1` | pristine `class C{}` instance: extensible/frozen/sealed | 1 | **6** | 1 |
| `x/x2` | frozen class instance | 6 | 6 | 6 |
| `x/x3` `x/x4` | pristine / frozen array | 1, 6 | 1, 6 | 1, 6 |
| `x/x5` `x/x6` | pristine function / Date | 1, 1 | 1, 1 | 1, 1 |
| `w/w3` | frozen object literal | 3 | 3 | 3 |
| `w/w4` | `preventExtensions` on a literal, then a write, then query | 0 | **1** | 0 |
| `w/w5` | `seal` on a literal: sealed / frozen / still-writable | 5 | **7** | 5 |
| `v/v1` | `gopd` through a Proxy whose trap answers `undefined` | 1 | **9** (threw) | 1 |

`v1` is the one that reframes r4. The r4 note read the `has`/`delete`
extensibility false positives as "the dispatch-internal `__object_isExtensible`
call is special". It is not: an object literal lowers to an `__anon_*` closed
struct, which had no `__integrity_bag` arm, so the helper fell through to its
NON-object terminal (`extensible = false`). The source-level call looked right
only because `provenJsObject` picks the `_obj` variant, whose terminal is the
opposite constant. One defect, one fix, and it is what unblocks step 4.

The same four probes move the same way under `--target wasi` (measured
separately): step 1 is target-neutral, and it does NOT re-open the wasi gate on
the §10.5 validators, which stays.

### Step 2 — the `gopd` literal-key fold asks the dynamic native on a guard miss

`call-builtin-static.ts`, the `else` of the guarded `ref.test structTypeIdx`.
The guard FAILING is the interesting case — the commonest receiver that fails it
is a `$Proxy` in front of the shape — so under `ctx.standalone` the arm now calls
`__getOwnPropertyDescriptor`, whose `$Proxy` front guard runs the trap and
recurses for a proxy-of-proxy. The then-arm is untouched and its late imports
still resolve first.

| probe | node | base | lane |
| --- | ---: | ---: | ---: |
| `x/z4` gopd through a Proxy whose trap answers `{value:99,…}` | 99 | **-1** (`undefined`) | 99 |
| `w/w1` gopd on a plain literal (the then-arm) | 7 | 7 | 7 |
| `r/r1` `r/r2` `r/r3` `r/r5` accessor / non-writable / dynamic-write / plain | 7, 2, 15, 7 | same | same |

The SECOND fold arm ("property not found in struct → undefined", no runtime
guard) is left alone and recorded as a residual: it has no failed guard to
reinterpret.

### Step 3 — `in` stops folding a positive answer over a Proxy receiver

`binary-ops-in.ts`. `isDirectProxyBinding`, not `tracesToProxyValue` — the wider
trace accepts aliases the documented widening defect nulls, and routing one of
those would turn a correct answer into a wrong one.

| probe | node | base | lane |
| --- | ---: | ---: | ---: |
| `j/j1` trap-call count × 10 + `("attr" in p)` | 10 | **1** (trap never called) | 10 |
| `w/w2` `in` over a literal and an array index, Proxy-free | 5 | 5 | 5 |

### Step 4 — the two §10.5 extensibility clauses r4 declined, restored

`object-runtime-proxy-invariants.ts`: §10.5.7 step 9.b.ii and §10.5.10 step 13,
each spliced from the `notExtensible`/`throwIf` FACTORIES (the finalize funcIdx
walk has no dedup set). The decline note is deleted and replaced by the
explanation above.

Measured on a 22-row list (`.tmp/step14-rows.txt`) on the lane tree: 15 pass,
including both rows the decline was protecting
(`has/return-false-target-prop-exists-using-with.js`,
`deleteProperty/call-parameters.js`) and both rows it was costing
(`has/return-false-target-not-extensible.js`,
`deleteProperty/targetdesc-is-configurable-target-is-not-extensible.js`).

### Step 5 — a false `[[PreventExtensions]]` / `[[SetPrototypeOf]]` status

Two commits. First, §20.1.2.19 step 3 / §20.1.2.21 step 4 at the CALL SITE:

- `Object.preventExtensions(p)` returned the trap's booleanish externref as if
  it were the object. The check is gated on a runtime `ref.test $Proxy`, NOT on
  truthiness alone — the native helper hands back its ARGUMENT for an ordinary
  receiver, and `Object.preventExtensions(0)` is a legal no-op whose falsy
  return must not become a throw. `seal`/`freeze` are untouched: their helpers
  carry no proxy front guard, so there is no status to honour and their bytes do
  not move.
- `Object.setPrototypeOf(p, v)` already implemented step 4 but asked
  `__object_setPrototypeOf_status`, which has no proxy front guard and answers
  the ORDINARY status (1). The proxy arm reads the result of
  `__object_setPrototypeOf` instead, which DOES carry the guard — so the status
  and the write are the SAME trap call. That is why the check is at the call
  site and not in the status helper: a proxy guard there would run the trap once
  for the status and again for the write, which is observable.

Then a second commit, which the FIRST measurement of step 5 forced:

- §10.5.2 step 7.a and §10.5.4 step 6.a say `return ? target.[[…]]()`. Both
  dispatch arms instead DROPPED the forwarded result and pushed the proxy as a
  truthy success token, reasoning that the ordinary operation always succeeds.
  It does not when the target is ITSELF a Proxy: the front guard sends that case
  to the inner proxy's dispatch, whose trap can answer false, and the token
  overwrote it. Returning the forwarded value is a superset of the old
  behaviour — an ordinary target answers the target object, truthy exactly like
  the token.

| probe | node | base | lane |
| --- | ---: | ---: | ---: |
| `x/y1` `preventExtensions` trap returns false | 9 (threw) | **1** | 9 |
| `x/y2` `setPrototypeOf` trap returns false | 9 (threw) | **1** | 9 |
| `j/j5` `j/j6` `preventExtensions` then `isExtensible`, direct and via a callee | 0, 0 | 0, 0 | 0, 0 |

`built-ins/{Proxy,Object}/{preventExtensions,setPrototypeOf}`, 81 rows,
`--isolate --standalone`, base tree vs lane:

| | base | lane |
| --- | ---: | ---: |
| pass | 70 | **73** |
| fail | 10 | 7 |
| compile_error | 1 | 1 |

**Rows lost: ZERO** (set-diff of the non-pass path lists, not the totals).
Gained: `Proxy/preventExtensions/trap-is-missing-target-is-proxy.js`,
`Proxy/setPrototypeOf/trap-is-missing-target-is-proxy.js`, and
`Object/preventExtensions/throws-when-false.js`.

### Step 6 — `Reflect.set` with an explicit receiver (§10.1.9.2)

New `src/codegen/object-runtime-ordinary-set.ts` registers
`__reflect_set_receiver(target, key, value, receiver) -> i32`; the refusal at
`call-namespace-static.ts` is replaced by a call to it, keeping the
`boundaryReflectInterop` arm ahead, the §26.1.13 Object-target guard, and
`emitReflectArgumentLocals` + `coerceReflectPropertyKey` so a throwing
`toString` still escapes. The 3-argument path and the host 4-argument import are
untouched.

Three decisions worth recording:

- **The prototype hop is an ITERATION, not a self-call.** A native cannot bake
  its own funcIdx at registration time, and §10.1.9.2 recurses only in tail
  position, so a `loop` is exactly equivalent and needs no reserve-then-fill.
- **`IsAccessorDescriptor` is read as PRESENCE of `get`/`set`** (`__extern_has`),
  not as truthiness of `set`. `{get: undefined, set: undefined}` IS an accessor
  descriptor and must refuse; reading `set` and finding `undefined` would
  misclassify it as data and write through.
- **The write is `__extern_set`, not a rebuilt descriptor.** For an absent
  receiver property that is exactly CreateDataProperty (an ordinary dynamic
  write is W/E/C all true — probe `r/r3`), and for a present writable data
  property it preserves the enumerable/configurable attributes a rebuilt
  descriptor would flatten.

Registered LAST in `ensureObjectRuntime` (it reads helpers that are only in
`funcMap` by then; appending at the end shifts no funcIdx), and listed in
`OBJECT_RUNTIME_HELPER_NAMES` so `ensureLateImport` binds the DEFINED native and
adds no `env::` import. On wasi that lookup answers `undefined` and the
pre-#5316 refusal still stands, unchanged.

Every base cell below is the compile error, so `base` is CE throughout:

| probe | what it asks | node | lane |
| --- | --- | ---: | ---: |
| `p/rs1` | the data write lands on the RECEIVER, not the target | 7 | 7 |
| `p/rs2` | the accessor setter's `this` IS the receiver | 3 | 3 |
| `p/rs3` | a non-writable OWN data property refuses | 2 | 2 |
| `p/rs6` | a non-writable INHERITED data property refuses | 2 | 2 |
| `p/rs4` | a primitive receiver refuses | 0 | 0 |
| `p/rs5` | `receiver === target` is the 3-argument shape | 3 | 3 |
| `p/rs7` `p/rs10` `p/rs11` | the whole `set-value-on-data-descriptor` program, three spellings | 31 | 31 |

The 15 listed rows, `--isolate --standalone`: base **15 compile_error**, lane
**7 pass, 8 fail**. Rows lost: ZERO; 7 gained (six `built-ins/Reflect/set/*`
plus `TypedArrayConstructors/internals/Set/key-is-out-of-bounds-receiver-is-not-typed-array.js`).

### Controls

Both required corpora, `--isolate --standalone`, base tree vs lane. A run that
timed out under load was re-run split in halves at `COMPILER_POOL_SIZE=1` and
the halves concatenated; the box carried a 1-minute load average of 17-25 from
other lanes for most of this measurement, so a monolithic 464-row run did not
fit inside a two-hour cap.

**`built-ins/Proxy` + `built-ins/Reflect` — 464 rows**

| | base | lane |
| --- | ---: | ---: |
| pass | 350 | **365** |
| fail | 100 | 92 |
| compile_error | 14 | 7 |

**Rows lost (pass on base → non-pass on lane): ZERO**, by set-diff of the
non-pass path lists. 15 gained:

- `Proxy/deleteProperty/targetdesc-is-configurable-target-is-not-extensible.js`
- `Proxy/getOwnPropertyDescriptor/result-is-undefined-target-is-not-extensible.js`
- `Proxy/getOwnPropertyDescriptor/result-type-is-not-object-nor-undefined.js`
- `Proxy/getOwnPropertyDescriptor/resultdesc-is-not-configurable-targetdesc-is-configurable.js`
- `Proxy/has/return-false-target-not-extensible.js`
- `Proxy/has/return-false-target-not-extensible-using-with.js`
- `Proxy/has/return-false-target-prop-exists.js`
- `Proxy/preventExtensions/trap-is-missing-target-is-proxy.js`
- `Proxy/setPrototypeOf/trap-is-missing-target-is-proxy.js`
- `Reflect/set/{creates-a-data-descriptor, different-property-descriptors,
  receiver-is-not-object, return-false-if-target-is-not-writable,
  set-value-on-accessor-descriptor-with-receiver, symbol-property}.js`

One row changed bucket without changing side:
`Reflect/set/set-value-on-data-descriptor.js`, compile_error → fail (see
residuals).

**`built-ins/Object/{freeze,seal,preventExtensions,isExtensible,isFrozen,isSealed}`
— 317 rows**

| | base | lane |
| --- | ---: | ---: |
| pass | 308 | **309** |
| fail | 7 | 6 |
| compile_error | 2 | 2 |

**Rows lost: ZERO**, same set-diff. One gained
(`Object/preventExtensions/throws-when-false.js`). This corpus is the one that
would have caught a bad step 1 — it is 317 rows of exactly the integrity
predicates and mutators the new `__integrity_bag` arm re-answers, and nothing in
it moved except the row §20.1.2.19 step 3 is about.

**The 12 target rows of `.tmp/w5/attr/rows.txt`: 8 flip, 4 remain** (all four
are named residuals below). **The 9 held rows of `rows-reg.txt` all still
pass** — `deleteProperty/return-true-without-same-target-prop.js` is a STALE
entry: no such file exists in this test262 checkout (the row is now
`targetdesc-is-undefined-return-true.js`).

### Order preservation

`sha256` of the emitted module, base vs lane, per target:

| program | standalone | wasi | host |
| --- | --- | --- | --- |
| `o/plain.ts` — touches no MOP helper | SAME 50,256 B | SAME 50,283 B | SAME 1,270 B |
| `w/w2.ts` — Proxy-free, only MOP use is `in` | SAME 50,541 B | SAME 50,568 B | SAME 1,985 B |
| `o/mop.ts` — defineProperty/gopd/names/in/delete | DIFF 134,803 → 136,317 | DIFF (same 101,678 B) | SAME 3,103 B |
| `p/pxy.ts` — a Proxy program | DIFF 138,530 → 139,915 | DIFF (same 107,135 B) | SAME 7,005 B |
| `x/x1.ts` — a class instance + integrity queries | DIFF 133,670 → 135,215 | DIFF (same 102,328 B) | SAME 1,091 B |

So: **host is byte-identical for every program**, and both programs the
acceptance criteria name as all-target-identical are identical on all three. The
standalone/wasi growth is the new arms in an already-reachable runtime, as in
r4. The wasi modules differ in CONTENT at the SAME length — the forward-arm
change removes two instructions where step 1 adds some.

wasi behaviour was re-measured on the same eight probes: nothing regressed, and
`j/j1` improved to node's answer (the `in` route is `standalone || wasi`).
`p/pxy.ts` throws under wasi on BOTH trees — the pre-existing wasi
attribute-model defect the r4 review documented, untouched here.

### Pins

`tests/issue-5316-r5-attribute-model.test.ts` — 49 cases: the integrity matrix
({pristine, frozen/sealed} × {literal, class instance, array, function, Date}),
the Proxy-facing gopd/`in`/has/delete probes with BOTH the compliant and the
violating trap answer, the two status throws, eight `Reflect.set` receiver
shapes, four wasi probes, and 15 Test262 rows (6 flipped, 9 held). Every
standalone probe asserts `result.imports` is `[]`. **49/49 on node 22 and on
node 25**; `tests/issue-5316-r4-invariants.test.ts` also **49/49 on both**, so
the r4 wasi gate and its §10.5 pins are intact.

Two pins are worth a reader's attention:

- the refused-write probe expects a **TypeError (10)**, not a silent no-op (0).
  A module is STRICT code. Measuring the same source as a sloppy script answers
  0 and would have pinned the wrong thing — caught only because the first run of
  the pin file failed against a probe value taken from a sloppy harness.
- the "preventExtensions on a compliant Proxy" pin deliberately does NOT assert
  `result === proxy`. §20.1.2.19 step 4 returns O and the emitted arm does push
  O, but the standalone `===`/`typeof` folds over THAT CALL'S RESULT misclassify
  it on this tree and on `origin/main` alike (probe `.tmp/p/pe2.ts`: `typeof r`
  is none of object/boolean/undefined on either), so an identity pin there would
  measure that pre-existing fold. It is a residual instead.

### Gates

Green bare AND with `LOC_GATE_BASE=$(git rev-parse origin/main)`:
`check-loc-budget`, `check-func-budget`, `check-coercion-sites`,
`check:oracle-ratchet`, `check:dead-exports`, `check:speculative-rollback`,
`check:stack-balance`, `check:codegen-fallbacks`, `check:any-box-sites`, TS7
`tsc --noEmit -p tsconfig.ts7.json`, `pnpm lint`. Growth grants (LOC, function
and the three `__is_truthy` coercion sites) are in this file's frontmatter with
dated rationales; no `scripts/*-baseline.json` was touched.

### Not built — declined with the mechanism

**The `ref.test $__ta_dyn_view` arm for §10.4.5.5** (the second half of plan
step 6). Without it the six `TypedArrayConstructors/internals/Set/*` rows move
`compile_error` → `fail` (one of them to `pass`), which is a bucket change, not
a lost row. Building it means teaching `ta-dyn-mop.ts` — a finalize-time module
that prepends `ref.test`-guarded arms to five MOP helpers by mode
(`get`/`has`/`set`/`reflect_set`/`delete`) — about a SIXTH mode with a fourth
parameter, and then re-measuring the TypedArray corpus, which is a third control
this pass did not have the wall-clock for (the two required controls alone cost
~5 hours on a box at load 17-25). Declined rather than half-built: a wrong
integer-index arm turns working TypedArray writes into refusals, and that is the
failure family this lane exists to avoid.

### Residuals, each with its mechanism

| rows | mechanism |
| ---: | --- |
| 6 | `TypedArrayConstructors/internals/Set/*` — the §10.4.5.5 arm above. They now reach `__reflect_set_receiver`, which treats the typed array as an ordinary object, so a canonical numeric index is written as a named property. |
| 2 | `language/statements/with/set-mutable-binding-idref*-with-proxy-env.js` — now `compile_error` → `fail` with `RangeError: Maximum call stack size exceeded` in `__extern_set ← __create_descriptor ← __getOwnPropertyDescriptor ← __call_fn_method_2`. A `with (proxy)` environment re-enters the same proxy from inside its own trap; the walk in `__reflect_set_receiver` has no re-entrancy guard. The plan said not to build a `with` arm, and this is why one would be needed. |
| 1 | `Reflect/set/set-value-on-data-descriptor.js` — the only row whose failure is NOT reproducible outside the harness. The same program compiled directly answers node's value exactly in three different spellings (`.tmp/p/{rs7,rs10,rs11}.ts` = 31 = node), including the duplicate-`var` and helper-function shapes; the row's own `assert.sameValue(result, true)` still reports `false`. Not diagnosed further. |
| 1 | `Proxy/getPrototypeOf/instanceof-target-not-extensible-not-same-proto-throws.js` — the `instanceof` fold (`identifiers.ts:2913` `compileHostInstanceOf`), which the plan explicitly scopes out. |
| 2 | `Proxy/deleteProperty/trap-is-null-target-is-proxy.js`, `Proxy/defineProperty/trap-is-undefined-target-is-proxy.js` — string/array exotic own properties reached through a proxy chain. |
| 1 | `Proxy/defineProperty/null-handler.js` — a revoked proxy is not caught on the `__obj_define_from_desc` path. |
| — | A `$Proxy` reached as a PROTOTYPE of the target inside `__reflect_set_receiver` is consulted through its `getOwnPropertyDescriptor` trap, not its §10.5.9 `set` trap. It can UNDER-report such a prototype's refusal; it can never invent one. A proxy as the direct target or as the receiver is unaffected — the front guard puts its own trap in the walk. |
| — | The SECOND `gopd` fold arm ("property not found in struct → undefined", no runtime guard) is unchanged, as the plan directed. |
| — | `Object.preventExtensions(p)` now returns O per §20.1.2.19 step 4, but the standalone `===`/`typeof` folds over that call's result misclassify it on this tree AND on `origin/main`, so the identity is not observable from compiled source. Pre-existing; named here because it is why one pin is a non-throw assertion rather than an identity one. |
| — | `Object/seal/seal-{finalizationregistry,sharedarraybuffer}.js` stay `compile_error` and `Object/{freeze,seal}/proxy-with-defineProperty-handler.js` stay `fail` on both trees — other lanes' territory. |

Not claimed and not touched, per the lane protocol: the generator carrier
(#2864), the promise/microtask carrier (#2867) and built-in method reflection
(#2175).

### Two process notes for the next lane

- **The 464-row control does not fit in a 2-hour cap on a shared box.** Two
  runs were lost to `timeout 7200` before that was understood; splitting the
  list in halves and concatenating the outputs is both faster and failure-safe,
  because `run-test262-paths.mts` writes NOTHING until it finishes — a timeout
  is a total loss of the run.
- **Rebuild the compiler bundle AND the quickjs adapter after the last source
  edit, and do not start a corpus run mid-edit.** One 81-row run was measured
  against a tree whose new module was written but not yet imported, and reported
  `registerOrdinarySetWithReceiver is not defined` as a `compile_error` row.
