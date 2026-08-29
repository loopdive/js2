---
id: 5140
title: "ES2015 standalone: proxy conformance wave 1"
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
  - src/codegen/declarations.ts
  - src/codegen/module-init-collection.ts
  - src/codegen/binary-ops-in.ts
  - src/codegen/analysis/proxy-binding-escape.ts
  - src/codegen/function-prototype-callable.ts
  - src/runtime.ts
  - src/codegen/object-runtime-proxy.ts
  - src/codegen/object-runtime.ts
  - src/codegen/object-runtime-descriptors.ts
  - src/codegen/object-runtime-prototype.ts
  - src/codegen/expressions/call-namespace-static.ts
  - src/codegen/inherited-set-gate.ts
  - src/codegen/binary-ops-in.ts
  - src/codegen/reflect-construct-native.ts
  - src/stdlib/object-runtime.ts
coercion-sites-allow:
  - src/codegen/object-runtime-proxy.ts
func-budget-allow:
  - src/codegen/object-runtime-proxy.ts::ensureProxyRuntime
  - src/codegen/expressions/call-namespace-static.ts::compileNamespaceStaticCall
  - src/codegen/binary-ops-in.ts::compileInOperator
  - src/codegen/declarations.ts::collectDeclarations
---

# #5140 — ES2015 standalone: proxy conformance wave 1

## Problem

All 216 ES2015-bucket "proxy" work-package tests (built-ins/Proxy + built-ins/Reflect)
still fail on the standalone target — re-verified 2026-08-28 on head `86739f05`
(0 of the day-old baseline list already fixed: 193 FAIL + 23 COMPILE_ERROR).
The standalone `$Proxy` runtime (#1100 Phase 1 + #1355 slices A–F) has all 13
trap dispatchers wired but performs **no §10.5 result-invariant checks, no
IsCallable(trap) validation, cannot take a proxy as a proxy target, and the
ordinary MOP (proto-chain get/set/has) never enters a proxy on the chain**.
Closing these clusters is required for the 100% ES2015 standalone goal; the
umbrella design is #1355 (this issue is its "Stage S2/S3" made concrete against
today's head).

The loc-budget-allow grant above is deliberate (rationale dated 2026-08-28,
this issue): post-trap invariant validators, per-operation trap-callability
checks, a receiver parameter on the set dispatch, proxy-aware proto-chain
walks, and the missing standalone Reflect arms are measured growth in the
listed files.

**Target list**: `.tmp/es2015/wp-proxy-current-fails.txt` (216 paths, written
2026-08-28 from a full re-run on head).
**Probe**: `cd /home/user/js2 && npx tsx .tmp/run-standalone.mts --list <file>`
(or individual test262-relative paths as args). Split lists >150 lines; some
tests take up to 20 s.
**Realm caveat**: 34 of the 216 (`*-realm*` + `function-prototype.js`) need the
QuickJS eval provider locally: `bash scripts/quickjs-artifact/build.sh` (~3 min)
first, else the probe reports an environment error ("quickjs provider is not
built") instead of the real failure. Their baseline errors show the SAME root
causes as clusters 1/6/8 below — mostly collateral wins.

## Current failure clusters

Counts are disjoint (each test counted once), sum = 216. Paths are
test262-relative under `built-ins/`.

| # | Cluster | Count | Root cause (file:function) | Sample tests |
|---|---------|-------|----------------------------|--------------|
| 1 | §10.5 post-trap invariant checks missing | 42 | `src/codegen/object-runtime-proxy.ts` — every dispatch builder (`buildDispatch` ~L234, `buildProtoDispatch` ~L378, `buildExt1Dispatch` ~L470, `buildOwnKeysDispatch` ~L564, define/gopd blocks ~L747–975) returns the trap result unvalidated; header L61–67 documents this as deliberate Phase-1 scope. No target-descriptor cross-checks, no trap-result type checks (getPrototypeOf non-object accepted), no extensibility reconciliation. | Proxy/getPrototypeOf/trap-result-neither-object-nor-null-throws-number.js · Proxy/defineProperty/targetdesc-not-compatible-descriptor.js · Proxy/ownKeys/not-extensible-new-keys-throws.js |
| 2 | realm variants (env-gated locally) | 34 | Same defects as clusters 1/6/8 exercised cross-realm; locally masked by the missing QuickJS artifact (see Problem). Baseline errors: "Expected a TypeError … no exception" (invariants), `Reflect.construct` newTarget CEs, error-identity "Thrown value was not an object!". | Proxy/defineProperty/targetdesc-not-compatible-descriptor-realm.js · Proxy/construct/arguments-realm.js · Proxy/ownKeys/trap-is-not-callable-realm.js |
| 3 | proxy-as-target chains rejected at create | 31 | `src/codegen/object-runtime-proxy.ts:__proxy_create` `requireObject` (~L1226): the typeof-classifier OR-chain misfires on a `$Proxy` carrier → false "Cannot create proxy with a non-object as target or handler". **Minimal repro (confirmed by probe): `new Proxy(new Proxy({foo:1},{}),{})` throws at create.** Downstream: `trap-is-*-target-is-proxy` tests also exercise ordinary-op forwarding onto proxy targets (Reflect native arms' `emitNativeReflectTargetGuard`, `call-namespace-static.ts` ~L738, rejects targets it cannot classify → "Reflect.ownKeys called on non-object"). | Proxy/set/trap-is-missing-target-is-proxy.js · Proxy/getOwnPropertyDescriptor/trap-is-null-target-is-proxy.js · Proxy/isExtensible/trap-is-undefined-target-is-proxy.js |
| 4 | standalone Reflect.* semantic gaps | 25 | `src/codegen/expressions/call-namespace-static.ts` `nativeReflectProvider` block (~L798–1540): no `apply` arm (falls to dynamic path → "Reflect.apply is not a function"); `ownKeys` arm (~L995) uses `__getOwnPropertyNames` only — no symbols, wrong integer-first ordering; `setPrototypeOf` arm (~L1253) drops the native result and always pushes true (OrdinarySetPrototypeOf false-cases unrepresented); `getPrototypeOf` returns null where `Object.prototype` is expected (proto model, `src/codegen/object-runtime-prototype.ts`); `return-abrupt-from-property-key`: ToPropertyKey coercion of the key arg never runs before target ops; `Object.getPrototypeOf(Reflect)` is null (namespace carrier, `src/codegen/standalone-global-object-carriers.ts`). | Reflect/apply/call-target.js · Reflect/ownKeys/return-on-corresponding-order.js · Reflect/setPrototypeOf/return-false-if-target-is-not-extensible.js |
| 5 | trap-absent forward + trap-result coercion fidelity | 22 | Trap-absent arm forwards to ordinary ops that are lower-fidelity than the spec op: `[[HasProperty]]` forward misses the proto chain for exotic protos (`"length" in Object.create(Array.prototype)`-shaped targets); ownKeys forward drops symbol + non-enumerable keys; GOPD dispatch **null-derefs** when the trap result / forward is undefined (`RuntimeError: dereferencing a null pointer in __module_init/__closure_N` family); `buildProtoDispatch`/`buildExt1Dispatch` coerce trap results without spec ToBoolean (setPrototypeOf `toboolean-*`, preventExtensions/return-false); abrupt completions thrown inside a trap are swallowed on the booleanish coercion paths (isExtensible/return-is-abrupt, setPrototypeOf/return-abrupt-*). All in `src/codegen/object-runtime-proxy.ts` dispatch builders + their `forwardName` helpers. | Proxy/has/trap-is-undefined.js · Proxy/getOwnPropertyDescriptor/trap-is-undefined.js · Proxy/setPrototypeOf/toboolean-trap-result-false.js |
| 6 | trap-not-callable / create+call validation | 14 | `readTrap` in `__proxy_create` (~L1206) stores whatever `__extern_get(handler, name)` returns; dispatch trap-arms invoke it blind — a non-callable trap silently yields undefined instead of the §7.3.9 GetMethod TypeError (must throw at **operation** time, not create time). `p()` on a proxy whose target is not callable returns undefined instead of TypeError: `__proxy_apply_dispatch` (~L997) never checks the `$Proxy` pcallable field. Symbol-valued target/handler at create not rejected on the compile path taken by the `create-*-throw-symbol` tests. | Proxy/has/trap-is-not-callable.js · Proxy/create-target-is-not-callable.js · Proxy/apply/trap-is-not-callable.js |
| 7 | trap context/receiver threading | 13 | Three confirmed defects: (a) a bare expression statement through a proxy is elided — probe pair: `"attr" in p;` never fires the has trap while `var u = ("attr" in p)` does (suspects: the static-fold path in `src/codegen/binary-ops-in.ts` ~L208–260 and the IR-side claim via `src/codegen/analysis/proxy-binding-escape.ts`); (b) OrdinarySet/[[Has]]/[[Get]] proto-chain walks never enter a proxy on the chain — probe: `Object.create(proxy).attr = 5` skips the set trap (`src/codegen/inherited-set-gate.ts` + the `__extern_set` proto walk in `object-runtime.ts` test only accessor entries, never `ref.test $Proxy`); (c) `__proxy_set_dispatch` hardcodes receiver = the proxy itself (`buildDispatch` trapArm pushes param 0, ~L270) — no receiver parameter exists, so inherited sets and Reflect.set-with-receiver cannot thread the true receiver. | Proxy/has/call-in.js · Proxy/set/call-parameters-prototype.js · Proxy/set/trap-is-missing-receiver-multiple-calls.js |
| 8 | CE: Reflect.construct newTarget residual (#3371) | 12 | Deliberate CE guards in `call-namespace-static.ts` ~L1393–1510: distinct newTarget without statically-resolved `NewTarget.prototype` (11) and non-array-literal argsList (1). #3371 is `status: done`; these are its documented residual scope, hit by the Proxy/construct `trap-is-undefined/null` family. | Proxy/construct/trap-is-undefined.js · Reflect/construct/return-with-newtarget-argument.js · Reflect/construct/arguments-list-is-not-array-like.js |
| 9 | CE: Reflect.set explicit receiver (#2046) | 7 | Deliberate CE at `call-namespace-static.ts` ~L888 — depends on cluster 7(c)'s receiver-threading rework. | Reflect/set/receiver-is-not-object.js · Reflect/set/symbol-property.js |
| 10 | Proxy.revocable revoker fidelity | 6 | `r.revoke()` returns null, not undefined (probe-confirmed): the `__apply_closure` revoker bridge (`object-runtime.ts` ~L7359–7383) does return the undefined sentinel, but the method-call route taken by `r.revoke()` (`__call_fn_method_0` finalize family) nullifies it. Revoker carrier (`__proxy_revoker` struct, `object-runtime-proxy.ts` ~L1379) exposes no `length`/`name` own properties and `isConstructor` misclassifies it. | Proxy/revocable/revoke-returns-undefined.js · Proxy/revocable/revocation-function-length.js |
| 11 | Proxy [[Call]] via .call/.apply/direct | 6 | `p.call(ctx, …)` / `p.apply(…)` on a proxy-over-function dies with "called value is not a function": the member-invoke path (`src/codegen/fnctor-missing-method-dispatch.ts:35`, `src/codegen/resolved-callee-guard.ts:76`) rejects the `$Proxy` carrier before `__apply_closure`'s proxy front-guard (`object-runtime.ts` ~L7307) can route to `__proxy_apply_dispatch`. | Proxy/apply/trap-is-undefined.js · Proxy/apply/call-parameters.js · Proxy/apply/return-abrupt.js |
| 12 | CE misc | 4 | `Reflect.defineProperty`/`Reflect.hasOwnProperty` CE arms (#1472 Phase C, `call-namespace-static.ts` ~L1522–1540); `__get_builtin` dynamic-shape CE (#1472 Phase B); `#1320 values() receiver` CE (Proxy/enumerate — ES2015-only trap, low value). | Reflect/defineProperty/return-abrupt-from-property-key.js · Proxy/getOwnPropertyDescriptor/null-handler.js |

## Implementation Plan

Work the clusters in the order below (count-descending, dependency-adjusted:
step 1's dispatch-arm refactor is shared infrastructure for steps 2–4). Each
step is independently landable; re-run the probe on the cluster's paths after
each.

**Global constraints (what NOT to do):**
- No new host imports without a standalone fallback (dual-mode rule; the
  runner fails any standalone test whose module emits host imports).
- Never edit `tests/test262-runner.ts`, skip lists, or `scripts/*baseline*.json`.
- New codegen needing type info goes through `ctx.oracle`
  (`src/checker/oracle.ts`), never the raw TS checker (oracle-ratchet gate).
- `object-runtime-proxy.ts` reserve-then-fill discipline: trap drivers are
  reserved with placeholder bodies and filled at FINALIZE (`fillProxyDispatch`,
  ~L1900–1935); new drivers must follow the same pattern, and string-constant
  Instr arrays must be built FRESH per use (see the "FRESH array" comments —
  shared arrays get double-remapped by the FINALIZE funcIdx walk).
- Run `check:dead-exports` and the loc/func budget gates before committing
  (chained, per CLAUDE.md).

**Step 1 — Trap callability + `$Proxy`-as-target admission (clusters 6+3 core, ~45 tests with step 2).**
(a) In `__proxy_create`'s `requireObject` (~L1226), test `ref.test $Proxy`
FIRST and short-circuit to "is an object" — a proxy is definitionally an
Object; today one of the typeof classifiers misfires on the `$Proxy` struct
(minimal repro above). (b) In every dispatch builder's trap arm
(`buildDispatch`/`buildProtoDispatch`/`buildExt1Dispatch`/`buildOwnKeysDispatch`
and the define/gopd/apply/construct blocks), before calling the driver:
`__typeof_function(trap)` — if 0 and trap non-null, throw TypeError (reuse the
existing `emitWasiErrorConstructor("TypeError")` + exn-tag pattern already in
this file, e.g. the revoked-guard ~L92–108). This lands the throw at
operation time, matching GetMethod §7.3.9 (the tests construct the proxy
successfully and expect the op to throw — do NOT validate callability in
`__proxy_create`). (c) In `__proxy_apply_dispatch` (~L997), front-guard on the
`$Proxy` pcallable field (already stored at create, ~L1310): 0 → TypeError.
Host-mode analog for messages/behavior: #2616.

**Step 2 — §10.5 post-trap invariant validators (cluster 1, +realm collateral).**
Implement per-operation validators as **self-hosted stdlib functions**
(`src/stdlib/object-runtime.ts` + `emitSelfHostedFunc`,
`src/codegen/stdlib-selfhost.ts` — the #3160/#3161 porffor-model driver;
follow the existing `__object_getOwnPropertyDescriptors` def there as the
template). The needed target-side primitives all exist and are registered
before the proxy runtime: `__getOwnPropertyDescriptor`
(`object-runtime-descriptors.ts:2909`), `__object_isExtensible`
(`object-integrity-carrier.ts:575`), `__getOwnPropertyNames` /
`__getOwnPropertySymbols` (`object-runtime-descriptors.ts:3262`). Write one
validator per op taking `(target, key?, trapResult, …)` and returning the
validated result or throwing TypeError, then call it from the dispatch arm
after the driver returns. Priority inside the cluster (test yield):
getPrototypeOf (result must be Object|null; if target non-extensible must
SameValue target's proto) → defineProperty (targetdesc compatibility,
non-configurable rules) → getOwnPropertyDescriptor (undefined-result rules,
resultdesc vs targetdesc; ALSO fixes the undefined-result null-derefs of
cluster 5) → ownKeys (non-configurable keys present; non-extensible ⇒ exact
key set) → has/set/deleteProperty/isExtensible/preventExtensions (each 2–3
short rules) → get (SameValue for non-configurable non-writable data props,
undefined for get-less accessors). The authoritative per-op rule list is
already written out in #1355's Implementation Plan slices — do not re-derive
it. After this step, build the QuickJS artifact and re-run the 34 realm tests
(cluster 2) — most should flip with zero extra work; file what remains against
the realm-identity gap, do not chase it here.

**Step 3 — Trap-absent forward fidelity + ToBoolean + abrupt propagation (cluster 5).**
In `object-runtime-proxy.ts`: (a) GOPD forward/trap-result undefined must flow
as the undefined singleton, not a null deref (guard before every
`struct.get`/cast on the result path). (b) ownKeys forward: use names ∪
symbols (both helpers exist, see step 2) preserving integer-ascending →
string-insertion → symbol order. (c) `buildProtoDispatch`/`buildExt1Dispatch`:
coerce trap results with the existing `__is_truthy` (spec ToBoolean) instead
of reference truthiness, and let thrown exceptions propagate — audit for any
`try`-style swallowing on the booleanish coercion path (host-mode analog:
#2617). (d) has forward: `__extern_has` must walk the full proto chain
including exotic protos (compare how `__reflect_get_receiver` walks for get).

**Step 4 — Receiver threading + MOP proto-chain proxy entry (clusters 7+9, unlocks 20).**
(a) Add a receiver param to `__proxy_set_dispatch` (and thread it from the
`__extern_set` front-guard: receiver = the original receiver, defaulting to
the proxy). This is the #2046 Reflect.set-receiver prerequisite; then replace
the ~L888 CE with a call into the set dispatch/native set that accepts the
receiver (cluster 9's 7 tests). (b) In the proto-chain walks — the inherited
accessor walk in `src/codegen/inherited-set-gate.ts` (#4504/#4602) and the
`__extern_get`/`__extern_has` chain walks — add a `ref.test $Proxy` arm per
step that routes to the proxy dispatch with the ORIGINAL receiver (probe p8
shape: `Object.create(proxy).attr = 5`). (c) Fix bare-expression-statement
elision: `"k" in p;` and `p.x;` must compile their operand when the receiver
can be a proxy (dynamic externref) — start at `binary-ops-in.ts`'s fold
conditions (~L208 #2617 comment documents the intended behavior) and
`analysis/proxy-binding-escape.ts`; the two-probe pair in cluster 7 is the
regression test.

**Step 5 — Standalone Reflect arms (cluster 4).**
In `call-namespace-static.ts` `nativeReflectProvider` block: (a) add an
`apply` arm: CreateListFromArrayLike over the argsList (length + indexed
`__extern_get_idx`, abrupt on non-object) then invoke via the existing
`__apply_closure` bridge (which already front-guards `$Proxy` and revokers) —
mirror the `construct` arm's arg-vec building. (b) ownKeys: names ∪ symbols
with spec ordering (same helper as step 3b — build it once, in the descriptors
module, call from both). (c) setPrototypeOf: implement OrdinarySetPrototypeOf's
false returns (non-extensible target, cyclic proto, SameValue short-circuit
true) in the native `__object_setPrototypeOf` and STOP dropping its result
(~L1253). (d) ToPropertyKey the key argument eagerly (abrupt completions from
`toString`/`toPrimitive` fire before target-type checks — test list:
`return-abrupt-from-property-key`). (e) `Reflect` namespace carrier: proto =
`Object.prototype`. (f) Retire the #1472 Phase C CE arms for
`Reflect.defineProperty` (route through `__obj_define_from_desc` /
`__defineProperty_value`, both registered in `object-runtime-descriptors.ts`)
— covers most of cluster 12.

**Step 6 — [[Call]] routing + revocable fidelity (clusters 11+10).**
(a) Teach the member-invoke `.call`/`.apply` path
(`fnctor-missing-method-dispatch.ts`, `resolved-callee-guard.ts`) to admit a
`$Proxy` carrier whose pcallable=1 and route to `__proxy_apply_dispatch`
instead of throwing "called value is not a function". (b) `r.revoke()`
undefined return: the revoker bridge in `__apply_closure`
(`object-runtime.ts:7359`) is correct — trace the `__call_fn_method_0`
method-call route the probe takes and return the undefined singleton there
too (or normalize null→undefined at that bridge's return). (c) Revoker
`length`/`name`/property order: reuse whatever mechanism compiled closures use
for `Function.prototype.name`/`length` own-property reads
(`callable-to-string.ts` / closure meta) — if that mechanism is descriptor-only,
synthesizing the two data properties on first GOPD is acceptable.

**Deliberately out of scope (do not start):** cluster 8 (#3371 residual
NewTarget preservation — needs the standalone dynamic-new design, its own
issue), the `#1320 values()` and `__get_builtin` CEs (cluster 12 leftovers,
1 test each), `Proxy/enumerate/*` beyond what falls out (ES2015-only trap
removed in ES2016), and any `with`-statement work (the `*-using-with` tests
pass/fail on the TypeError check, not on `with` itself — if a `with` test
still fails after step 1, leave it).

## Acceptance criteria

- All tests in `.tmp/es2015/wp-proxy-current-fails.txt` pass via
  `npx tsx .tmp/run-standalone.mts --list .tmp/es2015/wp-proxy-current-fails.txt`
  — EXCEPT the explicitly out-of-scope set (cluster 8's 12 CE tests + cluster
  12's 2 leftover CE tests); realm tests (cluster 2) are validated after
  `bash scripts/quickjs-artifact/build.sh`. Partial landings per step are
  fine; each step names its cluster's paths.
- Every test in `.tmp/es2015/wp-proxy-passing-spotcheck.txt` still passes
  (verified 40/40 green on head `86739f05`, 2026-08-28 — the baseline is
  green, keep it that way).
- Ratchet gates pass: `node scripts/check-loc-budget.mjs && node
  scripts/check-func-budget.mjs && node scripts/check-coercion-sites.mjs &&
  npm run -s check:oracle-ratchet && npm run -s check:dead-exports`.
- Equivalence tests pass: `npm test -- tests/equivalence.test.ts`.

## Results (wave 1, 2026-08-29)

Target list `.tmp/es2015/wp-proxy-current-fails.txt` (216 paths), standalone
probe on this branch's base `507ad13e`, 2-way parallel:

| | before | after |
|---|---|---|
| pass | 2 | 51 |
| fail | 191 | 142 |
| compile_error | 23 | 23 |

Both numbers are runs I executed on this worktree (`.tmp/base_*.txt` →
`.tmp/final_*.txt`); no test that passed before fails now (set-diff, 0 entries).
Spotcheck `.tmp/es2015/wp-proxy-passing-spotcheck.txt`: **40/40 before and
after**.

**Ceiling note**: 34 of the 216 are `*-realm*` tests that need the QuickJS eval
artifact, which is not built in this worktree — they cannot pass here at all.

Equivalence: `tests/equivalence/` run in three batches (the whole directory
OOMs vitest on a 4-core box). 12 failures, **all pre-existing** — each
re-measured against the unmodified files via the file-copy A/B and failing
identically: `logical-conditional-identity` (3 × `void`),
`arguments-nested-and-loops` (1), `tdz-reference-error` (6),
`yield-as-expression` (1), `reflect-api` (`Reflect.construct`, 1).

### Fixed

1. **Proxy-as-target/handler admission (cluster 3 core).** Two defects.
   `__proxy_create`'s `requireObject` misclassified a `$Proxy` carrier as a
   primitive (masked with a `ref.test $Proxy` short-circuit), and
   `proxyBindingEscapesToCall` treated `new Proxy(p, h)` as an escaping
   argument, so the binding kept its nominal target struct and the guarded cast
   replaced the live proxy with **null**. Carve-outs added for `new Proxy`,
   `Proxy.revocable`, all of `Reflect.*`, and the `Object.*` meta-object
   statics — every one of which consumes externref carriers.
2. **Trap callability at operation time (cluster 6).** §7.3.9 GetMethod now
   runs in EVERY dispatch builder's trap arm (#4721 had it for `[[Get]]`
   only), plus the §10.5.12 non-callable-target guard on
   `__proxy_apply_dispatch` (new `F_CALLABLE` read).
3. **§10.5 invariants (cluster 1, partial).** getPrototypeOf result must be
   Object|null and must SameValue a non-extensible target's prototype;
   setPrototypeOf's truthy result over a non-extensible target;
   isExtensible SameValue; preventExtensions must actually seal. The
   booleanish trap results now go through `__is_truthy` (spec ToBoolean)
   instead of reference truthiness.
4. **`Object.isExtensible(proxy)` bypassed its trap entirely** — the oracle
   proves a proxy binding is a JS object, so the call picks the
   `__object_isExtensible_obj` twin, which carried no proxy front-guard.
5. **`"k" in p;` / `v instanceof C;` in statement position were DROPPED**
   (cluster 7a). Not a fold problem: `expressionRunsUserCode` did not count
   `in`/`instanceof` as effectful, so the whole statement never reached
   `__module_init` and the `has` trap never ran — a vacuous pass across the
   `Proxy/has/call-*` family. Same collection-gap family as #2992 (`delete`),
   #3592 (`throw`), #3615 (bare property read).
6. **`Reflect.apply` (cluster 4, partial).** Two independent blockers: the name
   collided with `%Function.prototype%.apply` in
   `tryEmitNonCallableNamespaceInvokerThrow`, so every call threw
   "Reflect.apply is not a function"; and standalone had no native arm at all.
   Both fixed — the new arm routes through `__apply_closure` (which reads the
   argumentsList generically and front-guards `$Proxy`), with an
   IsCallable(target) guard built from positive primitive brands.
7. **`p.call(…)` / `p.apply(…)` on a proxy over a callable (cluster 11).**
   Front-guard on `__extern_method_call`, ahead of the property walk that made
   the `$Proxy` carrier look like it owned no `call`: `.call` rebuilds the
   argument vec from `args[1..]`, `.apply` forwards the list carrier as-is.
8. **`new Proxy(t, revokedProxy)` threw at construction** — the trap reads are
   per-operation GetMethod calls, not construction-time reads; the eager reads
   are now suppressed when the handler is a revoked proxy.

### Skipped / still open

- **Cluster 8 (Reflect.construct newTarget, 11 CE)** and **cluster 9
  (Reflect.set explicit receiver, 7 CE)** — deliberately out of scope per the
  plan; both need the receiver-threading rework and the standalone dynamic-new
  design.
- **Cluster 2 (34 realm tests)** — environment-gated, see the ceiling note.
- **Descriptor-model invariants** (defineProperty targetdesc compatibility,
  getOwnPropertyDescriptor resultdesc reconciliation, ownKeys key-set rules,
  has/get/set target-property rules) — ~35 tests, the largest remaining bucket
  ("Expected a TypeError … no exception"). These need the standalone
  descriptor-attribute model, which is the bulk of #1355 slice G. The
  self-hosted-stdlib vehicle the plan proposed does not fit: the IR-claimable
  subset has no `throw`, so a validator cannot signal the TypeError.
- **Cluster 7b — proto-chain proxy entry** (`Object.create(proxy).attr = 5`,
  ~6 tests, the "handler is context" failures): NOT a walk-arm change. The
  `$Object` proto field is typed `ref null $Object` and a `$Proxy` is a
  SIBLING type, so a proxy cannot even be STORED as a prototype today.
  Fixing it means widening that field (or boxing), which is a type-layout
  change well outside this wave. **7c receiver threading**: unstarted.
- **Revoker fidelity (cluster 10)**: `r.revoke()` returns `null` rather than
  `undefined` (the `$undefined` singleton regime, #2106, is still inert); the
  revoker's `length`/`name` own properties are unimplemented.
- `Reflect/apply/call-target.js` still reports `this === null` inside the
  target — `__apply_closure` does not thread an explicit this-value into a
  plain compiled closure.
- `Reflect.getOwnPropertyDescriptor({}, k)` / `Reflect.ownKeys` reject an
  object-LITERAL target ("called on non-object"): the literal compiles to a
  closed typed struct, which `emitNativeReflectTargetGuard` does not admit.
  Pre-existing, unrelated to the Proxy MOP.

## References

- #1355 — umbrella: Proxy pure-Wasm epic; its Stage S2 (invariants) and S3
  (call/construct) map to steps 2 and 6; per-op invariant rule lists live
  there — this issue does not duplicate them.
- #1100 — Phase 1 standalone `$Proxy` dispatch (the code this issue extends).
- #2615/#2616/#2617/#2618 — the host-mode twins of clusters 7(a)/6/5/11;
  reuse their messages and test expectations.
- #2046 — standalone Reflect spec gaps (in-progress; cluster 9 + step 5
  overlap — coordinate, don't fork: land the receiver rework here, reference
  it there).
- #3371 — Reflect.construct newTarget (done; cluster 8 is its documented
  residual, out of scope here).
- #1472 — standalone object/property ops Phase B/C (cluster 12; step 5f
  retires two of its CE arms).
- #4397 — construct trap + native semantic providers; #3031 — apply trap.
- #4504/#4602 — inherited-set gate (step 4b extends its chain walk).
- #3160/#3161 — self-hosted stdlib driver (step 2's implementation vehicle).
- #1466/#1345 — Proxy/Reflect trap-fidelity history (done; background only).
