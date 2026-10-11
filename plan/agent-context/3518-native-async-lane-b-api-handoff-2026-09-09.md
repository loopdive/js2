# Lane B delay/combinator and timer-publication implementation proposal

Frozen read-only source: `a024d9c048b620bef2c4a95f89f09f23de44c938`,
`/private/tmp/js2-3518-native-async-integration-20260909`.
This document is the only new worker-owned file. No production changes, claim,
compiler execution, tests, hooks, or publication were performed for this task.
The shared declaration specification is authoritative; Hilbert's seven-file
implementation in the separate resource-declarations tree was NOT inspected or
used as an issued dependency. API names proposed below do not exist at a024.

## 1. Implementable unit and precise boundary

Implement the two existing canonical native callable contracts together with
the actual timer publication that makes the callback executable:

- `irRuntimeFuncRef(IR_NATIVE_PROMISE_DELAY_FN)`: logical `(f64,f64)->Promise`,
  physical `(f64,f64)->externref`.
- `irRuntimeFuncRef(IR_ASYNC_PROMISE_ALL_NATIVE_FN)`: logical nullable externref
  vector -> externref; physical `(ref_null sharedExternrefVector)->externref`.
- Timer service: `irImportFuncRef("env", "__timer_set_timeout")`, physical
  `(externref callback, externref delay)->externref`, import intent
  `{type:"timer_set",mode:"timeout"}`. Import authorization must come from the
  selected timers capability/provider, not the spelling or signature alone.
- `async.native.clock-zero` remains the exact positive-zero projection: NO
  function, import, closure, or physical slot. It is not the timer service.

Use `NATIVE_ASYNC_CALLABLE_DECLARATIONS`, provider mismatch/policy checks and
canonical binding keys from `ir/runtime/native-async-callables.ts`; do not copy
their six-entry catalog. Parent reconciles actual call occurrences and source
ownership and seals the single ABI before module creation. Delay/all supplement
bindings implement existing entries, not new aliases inferred from helper names.

Suggested implementation remains the spec's four files: resources/
`native-delay-combinator.ts`, `native-timer-publication.ts`, and their two new
tests. The expansions/decisions in section 7 must be resolved before claiming
that those four files can complete the dependency closure.

## 2. Exact closure requests and captures

Parent must supply ONE ordered closure request population shared with Promise,
Lane A, invocation, and all compiler-created carriers. Keep existing request
occurrences/cache hits and the original first root/counter. Do not reserve a
second closure pack to obtain an unrelated root.

Promise prerequisite, from `async-scheduler.ts#ensurePromiseExecutorClosures`:
signature user params `[externref]`, results `[]`, default ordinary allocation;
metadata key `promise:settle`, name `""`, public length `1`, referencing that
earlier signature. Do NOT manufacture `minimumArgumentCount:1`; public metadata
length and observed minimum are separate. Promise owns the five-field metadata
prefix, settle capture field five, and resolve/reject trampolines unchanged.

Lane B adds a signature request with a parent-issued ID, `params:[]`,
`results:[]`, `allocationMode:"host-one-shot"`, and no invented observed minimum.
There is NO delay metadata request. On cache hit retain the exact wrapper binding
and update allocation observations according to the existing closure owner.
Its lifted signature is `(ref canonicalClosureRoot)->void`, not `(externref)->void
and not `(ref delayCapture)->void`. The delay capture is a subtype of this
signature wrapper, with exactly these fields in order:

1. `func:funcref`, immutable.
2. `$arity:i32`, immutable, from `closureArityField()`.
3. `$bag:externref`, mutable, from `closureBagField()`.
4. `promise:ref Promise`, immutable, canonical field index 3.
5. `value:f64`, immutable, canonical field index 4.

Descriptor name `$__ir_promise_delay_timer_cap`; parent is the actual zero-user-
argument wrapper. `closureBagInitInstr()` must be projected and checked to be
`ref.null.extern`, as both existing adapters do. This is a real canonical null
initializer, not permission to substitute null for another dependency.

Combinator state/capture are NOT callable closures and request no closure
metadata or wrapper:

- `$CombinatorState`: immutable `resultPromise:ref Promise`, immutable
  `resultsArr:ref sharedExternrefArray`, immutable `length:i32`, mutable
  `remaining:i32`, in that order; no parent property.
- `$CombinatorElemCaps`: immutable `state:ref CombinatorState`, immutable
  `index:i32`, in that order; no parent property.

Parent/C1 must receive all three actual compiler-created carrier declarations
and issued type tokens. Delay capture has closure inheritance; state/element
captures have none. Absence of source object literals does not remove these
from the complete carrier census. Historical `registerStruct` also publishes
struct name/field bookkeeping; the new aggregate must preserve the relevant
classifier/property observations rather than claim those registries were empty.

## 3. Resource declarations, exact signatures and donor schedule

The following is the concrete donor-preserving population for both demanded
providers: THREE owned struct types and SEVEN owned functions, borrowing all
Promise/vector/closure/value types. This is a static declaration count, not a
measured execution denominator. Preserve the shared race-fulfill helper because
`ensureCombinatorFunctions` actually reserves four functions even for all; this
does not admit a race provider. Removing that slot would require High's explicit
population/order amendment, not silent demand pruning.

Delay donor `ir-native-promise-delay.ts#ensureIrNativePromiseDelayProvider`:

1. Complete/import-authenticate timer, exception tag, native values, and Promise
   prerequisites. Donor ensures async runtime before requesting delay wrapper.
2. Request/reuse zero-argument host-one-shot wrapper and lifted signature.
3. Reserve delay capture type above.
4. Reserve `__ir_promise_delay_timer_callback` with that exact lifted signature.
   Locals are `buildNativePromiseDelayCallbackLocals()` (empty); body is
   `buildNativePromiseDelayCallbackBody` with capture, boxNumber, resolveValue.
5. Explicitly intern `(f64,f64)->externref`, historical name
   `$__ir_promise_delay_native_type`; reserve the canonical delay provider.
   Use both canonical provider builders, preserving `$promise` then `$reason`
   locals at indices 2/3 and callback arity zero.
6. Record the timer-publication demand only after exact provider ownership.

All donor `promise-combinators.ts#ensureCombinatorFunctions`, followed by
`ir-native-async-runtime.ts#ensureIrNativePromiseAllProvider`:

1. Borrow already-reserved Promise runtime and exact shared externref vector and
   array. Never allocate another backing array or infer it from a display name.
2. Reserve state, then element-capture type, with the fields above.
3. Explicitly intern reaction `(externref,externref)->externref` (normally the
   existing microtask signature), then subscribe
   `(externref,externref,i32,funcref,funcref)->void`, both unnamed donor calls.
4. Reserve function slots in EXACT order: `__combinator_subscribe`,
   `__combinator_all_fulfill`, `__combinator_race_fulfill`, `__combinator_reject`.
   All three reactions use the shared reaction signature; subscribe uses its
   own. Use canonical buildSubscribeLocals/Body, buildAllFulfillLocals/Body,
   buildSettleWrapperLocals with buildRaceFulfillBody and buildRejectBody.
5. Explicitly intern `(ref_null sharedExternrefVector)->externref`; reserve the
   canonical all provider after the four helpers. Its five locals follow param0:
   result Promise at1, results array at2, state at3, n:i32 at4, i:i32 at5.
   Preserve donor local names `__comb_result_0`, `__comb_arr_1`, `__comb_state_2`,
   `__comb_n_3`, `__comb_i_4`. Supply `{argVecLocal:0,resultLocal:1,arrLocal:2,
   stateLocal:3,nLocal:4,iLocal:5}` to buildNativePromiseCombinatorVectorBody;
   `emptyResult:{kind:"fulfill-vector"}`, no dynamic-iterable opts; append return.

There are four explicit signature-intern operations in these B recipes beyond
the borrowed closure request's interning; preserve them even on cache hits.
Implicit reservation interning is not a new distinct type count. Parent must
freeze the inter-producer operation schedule, not sort declarations by space.

## 4. Required issued dependencies and proposed API surface

Propose `declareNativeDelayCombinatorResources(requirements, symbolicDeps)`
returning a NativeResourceRecipe plus role keys and exact source-demand/
configuration associations; `reserveNativeDelayCombinatorResources(tx,
requirements,deps,expectedPlan)`; `nativeDelayCombinatorReservationInventory(tx,
pack,expectedPlan)`; and `fillNativeDelayCombinatorResources(tx,pack,fillDeps)`.
These names are proposals only. Use the shared same-recipe preflight/execution
helpers after Hilbert's implementation is frozen and composed.

Requirements must retain parent-authenticated selected delay/all occurrences,
provider contracts, order, resolved tracking policy, request ID for the delay
wrapper, and exact shared-vector layout association. No scalar index admission.
Symbolic dependencies refer to the same producer keys; real dependencies are:

- issued NativePromiseReservations: Promise/callback types; enqueue, fulfill,
  reject, resolveValue; callback-signature association for reaction parity;
- issued NativeClosureReservations plus exact delay signature-request ID;
- issued shared vector pack and its externref layout/array token identity;
- issued native value pack and real boxNumber binding (used for both ms/value);
- exact same-ledger timer CallableReservation and selected import provenance;
- exact exception-tag reservation used by the Promise aggregate;
- canonical bag-initializer projection, not an arbitrary initializer callback;
- explicit `{kind:"disabled"}` rejection tracking or authenticated tracking
  owner including real markRejectionHandled callable `(eqref)->void` and its
  head/node association. No -1 sentinel and no fake no-op function.

Combinator canonical API permits undefined markRejectionHandled only for the
explicit disabled branch. Its legacy adapter derives that from inactive tracking
(non-WASI); this does NOT resolve Lane A's separate required-mark contract.
High must reconcile Lane A with this explicit configuration, or assign the real
tracking extraction. Promise fill's current track dependency exposes head/node
but no mark function. Never claim it exists on NativePromiseReservations.

Authenticating reservations is not proof Promise is filled. C1/C2 must provide
the real resolveValue closure: TypeError, then/self-resolution literals, ObjVec
new/push, applyClosure, thenDispatch, bagHas, externGet, typeofFunction, AnyValue,
open-object/accessor readers and complete carriers; real hooks/tracking when
selected. Pending fake bodies do not close B execution. Borrow ObjVec through
that complete aggregate, not as a replacement for all's shared result vector.

Before first allocation: require issued packs/request IDs, expected declaration
association, exact signatures/layouts and complete demanded dependency census.
Before fill/inventory/completion: reauthenticate via producer private owners,
resolve actual coordinates only in the ledger's appropriate phase, fill once,
and retain exact tokens and alias identity. No second ABI or ownership registry
for already-issued external packs. Missing dependencies give located unavailable
preflight; do not shrink the plan to a successful subset.

## 5. Timer publication: exact donor obligations and phase split

`closure-exports.ts#publishStandaloneTimerCallbackDispatch` obtains the actual
compiler-owned directCall0 dispatcher function object, then its owned handle.
It NEVER selects `__call_fn_0` from user exports by name. Lane C2 must issue this
dispatcher `(externref closure)->externref`, covering all eligible closure shapes
including delay's capture and the correct lifted-root self type. B only borrows
it; a callback-specific fake dispatcher or arbitrary JS callback is not parity.
The generic donor also owns argc/extras globals and result boxing: do not hide
those dependencies by emitting a signature-only dispatcher.

Exact legacy append/publication order:

1. Bindings table `{elementType:"funcref",min:1,max:1}`.
2. Marker table `{elementType:"funcref",min:0,max:0}`.
3. Active element: bindings table, offset `[i32.const 0]`, exact dispatcher.
4. Immutable i32 manifest global, name constant
   STANDALONE_TIMER_CALLBACK_MANIFEST_EXPORT, initializer MAGIC `0x5a400001`.
5. Publish families in order: dispatcher, manifest, marker, bindings.
6. Mark that issued publication complete only after all obligations succeed.

Constants are the single existing owner `timer-capability-contract.ts`:
logical dispatch `__\0js2_timer_callback_dispatch_0`, manifest
`__\0js2_timer_callback_manifest`, marker `__\0js2_timer_callback_marker`, bindings
`__\0js2_timer_callback_bindings`; physical bases `$t0`, `$tm`, `$tt`, `$tu`.
Use imported constants, not copies. The NULs here describe the actual string
escape, not permission to export backslash-zero text.

For EACH family, recompute occupied names including earlier publications. Add
the logical alias only if free. Inspect every occupied name starting with the
physical base whose remainder is only `$`; let m be the maximum remainder
length, initially -1. Emit EVERY free name with suffix length 0 through m+1,
ascending. Preserve occupied exports, fill holes, and append a final genuine
alias beyond collisions. Do not merely choose the first free suffix. With no
collisions this yields eight aliases total. Collision population is input-
dependent and must be planned exactly before allocation, not guessed as eight.

Ledger mapping: reserveTable twice then reserveGlobal during reservation;
after freeze, defineElement with real table/callable tokens, fillGlobal with
MAGIC, then defineExport for the preplanned families. This necessarily defers
element creation relative to legacy global append: defineElement only permits
filling. High should explicitly approve preserving per-space order and the
donor's publication operation order across that reserve/fill split; do not
pretend the legacy mixed append sequence can execute unchanged with this ledger.
No new ledger allocator is required.

Propose a pure `declareNativeTimerPublication(occupiedExportPlan,dispatcherKey)`
and an issued reserve/inventory/fill pack retaining planned table/global/element/
export obligations and borrowed dispatcher. It must authenticate against the
parent's complete accepted export plan, including existing aliases and startup/
other publication names. At fill compare current occupancy to that planned
predecessor state, not to a mutable user-supplied set. Token-owned inventory must
include both tables, the global, actual element and all actual export objects.

The existing runtime bridge's readAuthority requires logical marker presence,
terminal physical aliases, exact fixed-size funcref tables, immutable i32 magic,
and sameExportedFunction(dispatch,bindings.get(0)) (JSC identity rule). It binds
authority only via the trusted setInstance path, then associates final export
views. After dispatch it calls real `__drain_microtasks`, with reentrancy guard.
Thus parent must also publish the issued queue drain under that exact runtime
entry; timer aliases alone do not schedule reactions to completion. Use the
existing timer capability adapter and explicit embedder binding validation;
do not rely on its unresolved-callback warning/drop or ambient-service fallback
as successful native acceptance. No host Promise implementation is introduced.

## 6. Semantic and acceptance obligations, not new execution claims

Delay: create one pending Promise, capture the grounded f64 without truncation,
box timeout and value with real number boxing, resolveValue at callback time,
drop its result. Tagged timer registration exception rejects with its actual
payload; foreign exception rejects with canonical donor null boundary sentinel.
Return that same Promise rather than synchronously throw. Do not replace this
specific foreign-exception sentinel with fabricated error conversion.

All: read vector logical length, not backing capacity; allocate results of that
length; initialize remaining before subscriptions; visit every input in order.
Non-Promise input gets a fresh pending Promise and real resolveValue (including
thenable jobs and poisoned-getter rejection). Already-settled inputs enqueue;
pending inputs attach real callback nodes; mark handled when tracking is active.
Each fulfill stores by original index then decrements remaining; zero settles
with the results vector. Reject is one-shot first rejection. Empty all fulfills
immediately, whereas observing it via await is still asynchronous.

Eager-error behavior is a composition obligation: parallel source launches all
delay calls before/all during pending-vector construction and does not stop on
an already rejected returned Promise. Sequential source awaits and does not
start iteration three after registration failure. B cannot prove this with
provider-only counts. Parent's unchanged 5-owner/16-prepared-function consumer
test must observe starts, reverse completion, 70, 3e9, both empty timings, exact
stdout, and one canonical-undefined fulfillment of main.

Required focused controls: canonical donor body/locals receipts, real binary and
runtime bridge without positive-path patching, captured-then/poisoned getter,
self-resolution dependencies, pending/settled inputs, overcapacity vector,
multiple/fresh instances, duplicate fill, foreign/copied/stale packs and wrong
closure root/request/layout, missing timer and altered service provenance,
declaration/intern reorder, missing race-support slot, changed capture fields,
resolveValue-to-fulfill mutant, store/decrement reorder, empty timing mutation.
Publication controls must include occupied logical labels, gapped/dense physical
suffixes, wrong dispatcher/table element, wrong magic/mutable global, malformed
table limits, missing aliases, cross-instance borrowed genuine exports, missing
drain and post-plan occupancy mutation. Positive controls precede mutants.

## 7. Explicit missing interfaces and ownership decisions

1. Compose Hilbert's reviewed declare/instantiate/expected-plan/inventory APIs
   for closures, ObjVec and Promise. At a024 none of those new APIs exists; use
   only the frozen shared spec while drafting. No imports from his live tree.
2. Global closure schedule: current reserveNativeClosureResources is one atomic
   request loop with fresh local root/cache and no append/resume API. Legacy
   delay requests its wrapper AFTER async runtime allocation. A single up-front
   closure pack moves that wrapper before Promise resources. High must either
   approve that cross-producer ordering change explicitly or design staged
   reservation under the SAME issued closure owner/root/cache. A second pack is
   not an acceptable solution. Do not silently change Hilbert's frozen scope.
3. Timer tables/publications: current NativeResourceRecipe declares only type,
   global, function; ProgramAbiSlotSpace is also only those three. Propose
   acceptance-time, typed publication obligations alongside the one ABI (tables
   do not pretend to be function slots), with exact same-ledger reconciliation.
   High must specify that contract, or authorize canonical schema/ABI expansion.
   It is not solved by the shared spec's keyed signature-intern amendment.
4. Constants placement: timer-capability-contract.ts is currently mixed compiler
   debt in the boundary policy. A new clean backend cannot import it directly
   without resolving its canonical contract placement. Parent must authorize a
   pure contract move/one-way compatibility re-export and additive boundary
   coverage, or another reviewed placement; never duplicate the constants or
   relax allowed edges. Current four-path B scope does not include that move.
5. Issued timer service/adapter-manifest plan and full export occupancy plan are
   parent integration APIs still missing. Their source/import/provider authority
   must survive replay and be checked before allocation. Timer import belongs
   before all defined funcs/globals/tables; no late import during B fill.
6. C2 must issue authenticated directCall0 plus dependency/capture inventory;
   C1/C2 must complete Promise resolution/classification. B must not edit shared
   closure-exports.ts concurrently or substitute null-returning dispatch.
7. Tracking/mark-handled mismatch with Lane A needs a joint decision as above;
   real active tracking requires ownership of unhandled-rejection donors beyond
   B scope. Disabled is explicit configuration, not a missing-binding fallback.
8. Descriptor/body single ownership: delay capture/state/element descriptors and
   provider local/append-return recipes remain in legacy adapters. If extraction
   must be canonical AND legacy-used, authorize narrow edits to
   codegen/ir-native-promise-delay.ts, ir-native-async-runtime.ts, and
   promise-combinators.ts plus pure runtime layout/local factories, coordinated
   with C1/C2. Do not call those adapters from backend or duplicate algorithms.
   Executable delay/combinator bodies already have canonical owners and need no
   rewrite. No P transport/codec or paused C-file authority follows from this.

## Source receipts (SHA256, raw files at the read pin)

Full specifications read:

- consumer implementation spec: `71c0302fd7b3d52999e873a85d23b1b70ed4f4a2fc9ab5e5fb0f4f4d0f397e35`
- Lane A handoff: `ff89f57ba7243201da20bba63dc0f2a86f4d4a6db6d0a192f7682062fc9cebdc`
- shared declarations spec: `b58f991aa1a5fd5beffd560da79b22f514a25e64f01db291c924d9e665f1150f`

Canonical/donor source receipts:

- runtime/wasmgc/promise/delay-bodies.ts: `c6957917c6b9eabb4147bf75ee55eae003693906a12cab12f9213f2f484243ed`
- runtime/wasmgc/promise/combinator-bodies.ts: `f07897f9a5e4f9febf2ce003c0827753a5aa1c74a890093e61d876eebd5c0f2a`
- timer-capability-contract.ts: `436c5ef08e52023651773d8ea2e1e39394a8bb2462445f40f9dd2c1190dc3b7b`
- codegen/ir-native-promise-delay.ts: `7f099d0e987684c5f8efcd21417a712793ce1ff3eb15be17f9de21a02d87dcbc`
- codegen/ir-native-async-runtime.ts: `2cbdb3afb82ab0b1c10a53dab5a7a92636a9586f37ba582bbd33baa7f3b7b5f7`
- codegen/promise-combinators.ts: `6626de0315531f472c6f1b41a4de1bb6d9a35186a87b3c5d6eddd3b70b476f1c`
- codegen/closure-exports.ts: `d58674648c7067df5aa89fdf4438886079b6bbe8a8e807c72af865ea455a0a24`
- runtime/standalone-timer-callback-bridge.ts: `4f95cd9fa72b964ecfb6d640ed9ffe21cf3a6ab268e8c48aee96f4c7306e5801`
- runtime/timer-capability-adapter.ts: `b6d821fb9437e87a21c03caad2d40da0f55d1a172c57ebd889481da050cc55d8`
- capability-registry.ts: `942bb0400c1c8cf561b4ac714fcb42297bd0a657106908d62865b07825505622`
- backend/wasmgc/resources/native-closures.ts: `892b895457a1909c76d15810cf5b7bb1b326be80c07ba5352ebfd16d94bec325`
- backend/wasmgc/resources/native-promises.ts: `6671c46397b40b736a5a1889b47a4954b7dc46060093d51024e1df3c93730dd4`
- wasm/physical/module-reservations.ts: `462143fec6e6b9c62bb86b869a6c806cf48768c05461fbb37e9056579746bbae`

No fresh test result or source/runtime population recount is asserted here.
