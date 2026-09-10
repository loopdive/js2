# Frozen Lane B delay/combinator and timer-publication delta

2026-09-09, Astra High. Read-only specification; no implementation/claim/test grant.
Inspected parent HEAD `66e339b7b697330bbed5692eb0de4188b1193caa`, canonical resource
and donor files there, published staged closures `7482ce3` via git, and both Lane B
handoff/integration-decisions documents at `cf6ac354d8d305864baf2646e5fe632860ec7c3c`.
The old a024 missing-declaration/atomic-closure assumptions are superseded.
Parent must compose the actual published closure commit before implementation,
and its pending E1 merge must not be overwritten. E2 remains a separate owner.

## 1. Decisions and implementation order

Tables/elements/export aliases are typed publication obligations BESIDE the one
ProgramAbiMap. No table becomes a fake function/type slot. Existing ledger APIs
are sufficient. Pure timer constants move to runtime/contracts/timer-capability.ts
with exact compatibility reexports. One staged closure owner reserves all metadata
before the Promise pause, then resumes signature-only suffixes after Promise.

Implement canonical donor-used factories and timer contracts/publication planning
first, in parallel with parent selected-import/export-plan acceptance. Resource
reservation/fill then consumes those exact APIs. Full execution additionally
requires genuine C1/C2 invocation/classification and active tracking when selected.
Those APIs are not currently present; this document does not assert otherwise.
No fake fill, callback-specific dispatcher or null-returning stand-in closes them.

## 2. Disjoint write partitions (claims/handoffs required)

Writer B1, canonical factories and real old callers:
- NEW src/runtime/wasmgc/promise/delay-combinator-layouts.ts
- src/codegen/ir-native-promise-delay.ts
- src/codegen/promise-combinators.ts
- src/codegen/ir-native-async-runtime.ts
- NEW tests/issue-3518-delay-combinator-layout-ownership.test.ts

Writer B2, pure timer contract plus real old publication caller:
- NEW src/runtime/contracts/timer-capability.ts
- src/timer-capability-contract.ts (exact one-way compatibility reexports)
- src/codegen/closure-exports.ts (only timer publication family-planning factoring)
- NEW tests/issue-3518-timer-publication-contract.test.ts

After B1/B2 API pins, writer B3:
- NEW src/backend/wasmgc/resources/native-delay-combinator.ts
- NEW src/backend/wasmgc/resources/native-timer-publication.ts
- NEW tests/issue-3518-native-delay-combinator-resources.test.ts
- NEW tests/issue-3518-native-timer-publication.test.ts

Parent exclusively owns new checked program-level admission records/integration,
program-physical-plan.ts, program-consumer.ts, native-async-program.ts, complete
ABI/declaration/export schedule, policy activation and full-family tests. Parent
also coordinates any exact producer-authentication accessor additions; B3 cannot
invent accessors on native-values/native-promises or edit their owners implicitly.
No P transport/codec or preserved e042 C-file writes follow from this scope.
Tracking owner and C1/C2 are separately claimed dependencies, not B1/B2 scope.

## 3. B1 canonical factory signatures

Use reference-parameterized factories, shared by physical recipes and old adapters;
do not duplicate layout tables. These are NEW exports, not existing APIs:

```ts
export function createNativeDelayCaptureShape<R>(
  wrapper: R, promise: R,
): { readonly name: "$__ir_promise_delay_timer_cap";
     readonly parent: R; readonly fields: readonly NativeDelayCaptureField<R>[] };
export function createNativeCombinatorStateShape<R>(
  promise: R, resultsArray: R,
): { readonly name: "$CombinatorState"; readonly fields: readonly NativeCombinatorStateField<R>[] };
export function createNativeCombinatorElementShape<R>(
  state: R,
): { readonly name: "$CombinatorElemCaps"; readonly fields: readonly NativeCombinatorElementField<R>[] };
export function buildNativeAllProviderLocals(
  promiseType: TypeHandle, arrayType: TypeHandle, stateType: TypeHandle,
  placement: { readonly parameterCount: number; readonly firstLocalOrdinal: number;
               readonly argVecLocal: number },
): { readonly locals: readonly LocalDef[];
     readonly slots: NativePromiseCombinatorVectorLocals };
```

The three field types are closed unions preserving exact names, scalar/ref kinds,
mutability and ordered tuples, with reference leaves R. No unknown/any field or
physical index in a symbolic recipe. R denotes a full reference value: use the
existing canonical generic closure-field factories for arity/bag, never their
numeric fallback. Preserve missing parent on state/element (not parent:undefined).
If that existing factory signature needs adaptation, choose a local projection
that preserves every field; no global model rewrite.

Delay fields: func:funcref immutable, closureArityField(), closureBagField(),
promise:nonnull Promise immutable at3, value:f64 immutable at4. Parent is zeroarg
wrapper. State fields: resultPromise:nonnull Promise, resultsArr:nonnull shared
externref array, length:i32 immutable, remaining:i32 mutable. Element fields:
state:nonnull state, index:i32, both immutable. Keep names and legacy registry
observations: registerStruct calls remain where they were, not a replacement
layout push that loses field/classifier bookkeeping.

All-provider locals preserve names generated from the actual starting local
ordinal: __comb_result_N, __comb_arr_N+1, __comb_state_N+2, __comb_n_N+3,
__comb_i_N+4; actual parameter count is one. For dedicated provider N=0 these
occupy indices1..5; argVecLocal=0. Absolute result/array/state/n/i slots are
parameterCount + firstLocalOrdinal + 0..4; argVecLocal is the supplied existing
input slot. Compatibility adapters pass their actual counts and input slot, not
the dedicated provider constants. Preserve each original allocLocal/localMap
effect while consuming these same descriptors and checking returned slots.
Append-return remains exactly once in the
dedicated provider adapter/resource body; preserve its try/finally currentFunc
restoration and thrown-object identity. Existing eight body/local builders are
reused, including shared race support, never reimplemented.

## 4. Complete B declaration and reservation schedule

Parent retains selected canonical delay/all calls, every owner/view/state/nested
occurrence and provider authentication using existing six callable declarations.
Delay logical(f64,f64)->Promise realizes physical(f64,f64)->externref; all uses
nullable shared externref vector -> externref. Clock-zero remains positive zero,
with NO physical function/import/slot. Names/signatures alone are not selection.

Use declareNativeDelayCombinatorResources(requirements,symbolicDependencies) as
the single pure recipe consumed by reserveNativeDelayCombinatorResources
(tx,requirements,dependencies,expectedPlan). Export ordered inventory, fill and
completed accessors following existing producer patterns. The exact requirements
record retains parent selected program/projection identity, source occurrences,
provider/binding objects, delaySignatureRequestId, resolved tracking selection and
symbolic dependency keys. Parent checked admission must issue this association;
descriptive structural equality is not sufficient currentness authority.

Full-family recipe: THREE structs, SEVEN functions. Delay capture then callback
using already-interned lifted root signature; named intern of delay provider
`$__ir_promise_delay_native_type`, then delay function. All: state then element;
unnamed reaction intern (externref,externref)->externref; unnamed subscribe intern
(externref,externref,i32,funcref,funcref)->void; functions subscribe, all_fulfill,
race_fulfill, reject in that order; unnamed all-provider intern then all function.
Pin four explicit interning operations beyond closure request interning and the
actual implicit calls performed by function reservation. No duplicate intern
guess, space sorting or removal of race helper (which does not admit Promise.race).

Global schedule: selected imports first; prerequisite values/vectors; one full
closure plan, metadata-complete prefix; actual Promise resources; samepack resume
for the host-one-shot zeroarg delay request; B recipe. Subsequent producers follow
the parent accepted schedule. Use nativeClosureReservationStepEnd to split the
same canonical recipe, not a second independently reconstructed prefix plan.
The published API rejects metadata left after a cut, even cache-hit metadata.
Real late metadata requires a new design; never move it earlier to fit this API.
Request settle ordinary(externref)->void, metadata promise:settle/name empty/
length1; do NOT infer observed minimum1. Delay has no metadata and no invented
minimum. Cache hits preserve exact root/binding/info and host-one-shot observation.

## 5. Dependency records and honest authentication stops

B reservation borrows exact issued closures/full declaration plan, Promise pack/
declaration plan, shared vector pack/externref layout, value pack/issued plan,
selected timer service import and exception tag. Fields are actual tokens, not
indices: Promise promise/callback/reaction-signature/enqueue/fulfill/reject/
resolveValue; value boxNumber; vector and its original backing array; closure
zeroarg wrapper/lifted-root signature. Record all THREE B carrier types for C1/C2.

Use existing owner inventory APIs where present. nativePromiseReservationInventory
authenticates reservation ownership, not complete Promise fill. NativeValueReservations
has no public completed-owner accessor in the inspected source. Parent must add
a bounded accessor in that existing private owner if its aggregate cannot already
authenticate exact pack/plan and completed fills. A token with matching signature
is NOT that accessor. No B helper may claim completion from nativePromise's fields
or use a user-supplied validation callback. Parent supplies/retains checked issued
environment through a named checked program module; its implementation must call
real producer ownership/currentness checks, not just brand an arbitrary record.

Before B fill, actual Promise resolution must be filled with C1/C2: AnyValue,
open-object/accessor and full carriers; TypeError, then/self-resolution strings,
ObjVec new/push, applyClosure, thenDispatch, bagHas, externGet, typeofFunction,
real value boxing and any selected hooks. No missing-category empty census.
Thenable capture-once, poisoned getter and self-resolution semantics remain.
Do not claim this issuer/complete accessor exists until its source is integrated.

Tracking public contract is exactly discriminated:

```ts
type NativeRejectionTrackingSelection =
  | { readonly kind: "disabled" }
  | { readonly kind: "active"; readonly ownerKey: string };
type NativeRejectionTrackingBinding<ActiveIssuedOwner> =
  | { readonly kind: "disabled" }
  | { readonly kind: "active"; readonly owner: ActiveIssuedOwner };
```

ActiveIssuedOwner is the future actual tracking producer's issued type, not an
object/unknown placeholder to ship. It must authenticate head/node and genuine
markRejectionHandled(eqref)->void; current Promise track deps have only head/node.
Parent selects disabled ONLY from explicit resolved policy. Disabled maps to the
existing combinator builder's undefined branch; active missing owner is a located
unavailable failure. Frame/await must use this SAME selection; no -1 sentinel in
new resource contracts, no missing-hook fallback, no fake no-op. Legacy adapters
can translate their existing sentinel at their unchanged compatibility boundary.
Active extraction from ensureUnhandledRejectionTracking is separately scoped.

## 6. Timer constants and canonical alias algorithm

Move all nine exact constants from timer-capability-contract.ts into
runtime/contracts/timer-capability.ts; old module explicitly reexports all nine.
Runtime/backend import the new canonical owner. No duplicate values/new names.
Also export pure planStandaloneTimerCallbackExports(occupiedNames), returning
ordered {family,name} rows, where family is dispatch|manifest|marker|bindings.
Factor the old timer publishFamily algorithm into this one function and make the
legacy caller consume it without moving its tables/element/global mutations.
Do not factor unrelated closure-host-bridge publication in the same change.

For each family in dispatch,manifest,marker,bindings order: add logical alias only
if free; scan complete occupied names for physical base plus dollars-only suffix;
take maximum suffix length m (initial -1); emit every free suffix0..m+1 ascending;
update occupancy between families. Preserve holes/collisions and terminal alias.
No collisions yields eight aliases, NOT a fixed planned count for all modules.
Constants include actual NULs in logical names; retain $t0/$tm/$tt/$tu bases and
magic0x5a400001. A same-name user function is never dispatcher authority.

## 7. Typed publication obligations, separate from function ABI slots

Define in native-timer-publication.ts (new types, not existing interfaces):

```ts
type TimerFamily = "dispatch" | "manifest" | "marker" | "bindings";
interface PlannedNativeExport {
  readonly name: string;
  readonly target: { readonly space: "function" | "global" | "table" | "memory" | "tag";
                     readonly resourceKey: string };
}
interface NativeTimerPublicationPlan {
  readonly key: string;
  readonly dispatcherKey: string;
  readonly predecessors: readonly PlannedNativeExport[];
  readonly bindingsTableKey: string;
  readonly markerTableKey: string;
  readonly manifestGlobalKey: string;
  readonly elementKey: string;
  readonly exports: readonly { readonly key: string; readonly name: string; readonly family: TimerFamily }[];
}
declare function declareNativeTimerPublication(
  key: string, predecessors: readonly PlannedNativeExport[], dispatcherKey: string,
): NativeTimerPublicationPlan;
```

Full ordered predecessor occupancy includes user exports, aliases, startup,
stdout/other resource publications scheduled before timer. It is not merely a
Set<string>: retain exact target resource identity plus order. Parent reconciles
each target to actual same-ledger tokens after freeze, compares actual module
export objects/desc to these bindings immediately before timer publication and
retains that module/export-array identity. No arbitrary caller-supplied smaller
occupancy list or borrowed genuine exports from a different module qualifies.
Freeze descriptive plan before allocation, retain it in AcceptanceRecord alongside
the same ABI; manifest global uses a real global ABI entry if aggregate requires
it, while tables/element/publications remain typed non-ABI obligations. Complete
physical ownership census must include them even though ABI has no table slot.

Resource APIs: reserveNativeTimerPublication(tx,acceptedPlan,checkedDependencies),
nativeTimerPublicationReservationInventory, fillNativeTimerPublication,
requireCompletedNativeTimerPublication. Exact dependencies retain selected timer
service, real issued C2 dispatcher and complete predecessor publication bindings.
Parent checked issuer is new work, NOT a pre-existing authority. Resource owner
records all actual table/global tokens plus actual element/export objects from
ledger calls; no registry cloning. Inventory before fill includes pending typed
obligations explicitly, not fabricated element/export objects or completion.

Reserve bindings table funcref min=max1, marker min=max0, immutable i32 manifest
global in that order. After freeze and ABI bind/finishBinding: define active
element at offset i32.const0 containing EXACT dispatcher; fill manifest magic;
publish four families in planned order. This approved phase split preserves
per-space/order, not literal legacy mixed append timing. defineElement/defineExport
are filling-only. Complete means all owned obligations satisfied and current in
filling/sealed; no full-module seal required before export. Reject duplicate fill,
occupancy drift, changed dispatcher/tables/element/global and partial completion.
Parent module seal occurs after all publications; no failure rollback claim.

## 8. Selected timer import and C2 dispatcher authority

Timer service is selected timers capability/provider plus actual canonical timeout
import contract: env.__timer_set_timeout, (externref,externref)->externref, intent
{type:timer_set,mode:timeout}. Parent validates canonical registry selection,
permission/provider manifest and genuine source demand. Reuse existing import
binding and ABI intent; no authorization by spelling/signature. Reserve through
reserveFunctionImport before any defined resource closes imports. Retain exact
import object, signature, handle and selected capability record in checked owner;
replay rederives authority rather than serializing a live token. Never late-import
at fill. Clock-zero is not this service.

C2 must issue actual generic directCall0 (externref)->externref, with closure root,
full eligible shape/capture inventory, argc/extras/result-boxing dependencies.
No raw FunctionReservation accepted merely because it matches that signature.
Current native closure producer issues types/metadata, NOT this dispatcher.
No existing exported C2 owner API was found: parent must freeze/implement that
named owner interface before B publication can authenticate it. B tests may test
pure alias planning and donor preservation meanwhile, but cannot label a hand
written dispatcher a genuine whole-runtime positive.

Publish actual owned queue drain as __drain_microtasks in the accepted complete
export schedule. Runtime timer bridge requires genuine dispatcher/bindings
function identity, tables/magic/terminal aliases, trusted setInstance binding and
real drain after callbacks. Explicit embedder capability wiring is required;
warning/drop and ambient timer fallback are not successful native acceptance.

## 9. Semantic, preservation and integration acceptance

B1/B2: exact full original donor inverse with imports/comments/header/order and
all affected local/field construction; live mutations and independent old/new
module/descriptor/registration traces. Check same cache-hit behavior and finally
restoration, no original receipt hash reseeding. Move constants one-way, enforce
canonical route and all nine identities; boundary additions by parent only.

B3 reservations: actual source original/decoded full selected16/33 population;
real Promise prefix/interleave/delay suffix, fresh and cachedzero; exact3types/
7functions/four explicit interns; all carrier registration facts and alias/type
identity. Positive-first wrong plan/source/provider, copied/foreign deps, wrong
root/request/vector backing/metadata, stale configuration, dropped race slot,
reordered interns/capture fields, duplicate fill. Preallocation unchanged module
and pristine-twin ordinal probes. Authenticate content before fill/completion.

Runtime: 70,3e9, timeout/value boxing, tagged vs foreign timer exception behavior;
same returned Promise, resolveValue (not direct fulfill), all logical length vs
capacity, input-order subscription, indexed stores before remaining decrement,
pending/settled/plain/thenable/poisoned-getter/self-resolution, first rejection,
empty immediate fulfillment but async observation. Real binary/runtime bridge;
no patched positive imports or fake C1/C2 fill. Full-family tests preserve eager
parallel registrations vs sequential stop-on-rejection, reverse completion,
empty timing, exact stdout and one undefined main fulfillment, fresh instances,
original/decoded source-free consumer. No subset is full acceptance.

Timer tests: dense/gapped aliases, occupied logical names and foreign same-name
functions, full predecessor target/order drift, real dispatcher/table function
identity, cross-instance exports, wrongmagic/mutability/tablelimits/offset/element,
missing aliases/drain, prefreeze/postseal rejection and partial-failure retention.
Full scheduling/export plan sealed BEFORE allocation; reserve/reconcile -> freeze
-> final ABI binding/finishBinding -> complete fills/publications -> module seal.

## 10. Open facts requiring explicit integration work, not invented APIs

Parent must pin the selected-service checked issuer, complete predecessor-export
binding issuer, C2 directCall0 owner/completion interface, C1/C2 full Promise fill,
and any active tracking owner. Existing native-value/Promise public APIs do not
alone supply those complete-owner proofs. These are real stops for B3 final fill/
publication; B1/B2 executable legacy-used factoring can proceed independently.
Parent must verify active claims for the three legacy adapters and closure-exports
before dispatch. This document grants no overlap release and no asynchronous
consumer refusal removal. E2 and formatter work remain disjoint prerequisites.
