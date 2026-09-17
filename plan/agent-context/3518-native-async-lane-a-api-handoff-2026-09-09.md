# Lane A implementation handoff — static proposal, not an issued resource API

## Composed dependency API update

Read-only source: `/private/tmp/js2-3518-native-async-integration-20260909`.
The previously absent closure and argument-vector packs are now present. Supersedes
the availability warning below; does NOT resolve their preallocation declaration gap.

Exact resource imports from `backend/wasmgc/resources`:

- `native-closures.ts`: NativeClosureRequirements, NativeClosureReservations,
  NativeClosureMetadataBinding, reserveNativeClosureResources,
  requireNativeClosureReservations.
- `native-argument-vectors.ts`: NativeArgumentVectorDependencies,
  NativeArgumentVectorReservations, reserveNativeArgumentVectorResources,
  fillNativeArgumentVectorResources.
- `native-promises.ts`: NativePromiseReservationDependencies,
  NativePromiseReservations, NativePromiseFillDependencies.

Closure reservation input is NOT an empty registry or signature-only array:
`{key, startingClosureCounter, requests, referenceTypes}`. `referenceTypes` is an
ordered array of actual same-ledger TypeReservation prerequisites covering every
concrete ref/ref_null parameter/result exactly (unused/duplicate prerequisites fail).
Requests preserve interleaving and cache-hit occurrences:

```ts
type ClosureRequest =
  | { kind: "signature"; id: string; params: readonly ValType[];
      results: readonly ValType[]; allocationMode: "support" | "ordinary" | "host-one-shot";
      minimumArgumentCount?: number }
  | { kind: "metadata"; id: string; signatureId: string;
      key: string; name: string; length: number };
```

Use the actual exported request types, not a second implementation of this union.
Metadata references an EARLIER signature request. Resulting pack carries `root`,
`signatures: {id,binding}[]`, `metadata: {id,binding}[]`, resultingClosureCounter,
and ordered registrations. Cache hits retain exact binding identity. Wrapper binding
has type, liftedFuncTypeIndex, liftedSelfTypeIndex and info; metadata binding adds
signature and `{key,name,length,id}`. Pack has no trampoline/fill API. Requiring it
authenticates exact issued pack, transaction, original request sequence and prerequisite
tokens, during reservation or after freeze. Do not substitute raw closure-root tokens.

Promise reservation dependencies are exactly:
`{vectors: NativeVectorTypeReservations, exceptionTag: TagReservation|TagImportReservation,
closures: NativeClosureReservations, settleMetadataRequestId: string}`.
The pack must have exactly one requested metadata binding whose key is promise:settle,
name empty, public length 1, signature params [externref], result void, exact signature
membership in the issued closure pack, and lifted self matching its root. Promise owns
settleCapture and resolve/reject closure bodies; Lane A must not duplicate them.

Argument vectors reserve with `{key}` and dependencies
`{vectorBase: TypeReservation, earlyArgumentArray?: TypeReservation}`. Early backing is
adopted by exact token identity after canonical descriptor checks, never reallocated
or replaced by a numeric index. Result pack: vectorBase,array,carrier,layout,newVector,
push. It registers new before push and fills both once; no freeze/seal. The current
API has no exported require/completion accessor: Lane A should consume these through
the parent-authenticated dependency aggregate, not invent another authority.

Frame dependencies should now explicitly contain the actual `promises`, `closures`,
`vectors`, `argumentVectors`, exception tag and issued value pack. Callable conversion
bindings still come from the parent's complete ABI reconciliation. The frame must not
accept a `{promiseTypeIdx, enqueueIdx, ...}` object as admission. Physical numbers are
derived from authenticated reservations only when invoking canonical body builders.

Actual Promise pack provides types.arguments/functions/callbackSignature/promise/
callback/captures/settleCapture; functions.grow/enqueue/drain/fulfill/reject/
identityFulfill/identityReject/resolveValue/peel/classifier/lookupThen/thenableJob/
resolveClosure/rejectClosure. It does NOT expose markRejectionHandled or a pending
creation function. Therefore native-await's mark-rejection binding and frame-entry's
canonical pending construction/closure-bag initialization remain explicit join work;
do not invent an exported pack field or pass -1 to pretend required tracking is absent.

Promise fill still requires complete owner/selected-owner/derived/carrier inventory,
AnyValue layout, real open-object getter and accessor getter, number box/unbox/isNumber
and undefined; resolution needs newTypeError, two exact string bindings, argument-vector
new/push, applyClosure, thenDispatch, bagHas, externGet and typeofFunction. Hooks and
unhandled-rejection config are explicit discriminated unions. Supplying issued closure
and argument-vector packs alone does not complete Promise execution dependencies.

### Preallocation amendment needed before ABI seal

These existing reservation APIs accept physical ValTypes/TypeReservations and perform
type/signature registration; they cannot be invoked to discover declarations before
the module exists. High/parent must approve producer-owned symbolic declaration APIs
for closures/argument-vectors/Promise and frame resources, with reference type keys and
the SAME ordered request population, counters, metadata cache hits and signature
interleaving. Reconcile symbolic declarations to issued pack registrations after
reservation. Never add ABI entries after allocation or fabricate reference tokens for
preflight. This is an API dependency, not permission to change P transport/schema.

Additional tests: stale/interleaved closure requests, unused/foreign reference types,
metadata-before-signature, noncanonical settle request, foreign/copied pack, matching
numeric index with wrong token, metadata signature/root mismatch, early-array adoption
vs duplicate reservation, missing argument-vector fill, whole-population missing carrier,
and producer recipe vs actual reservation order mismatch before freeze. Preserve the
existing closure/argument-vector/Promise tests rather than reimplementing their builders.

Read the complete parent `3518-native-async-consumer-implementation-spec-2026-09-09.md`,
including recorded C release in §5. Inspected current parent consumer tree read-only.
No production implementation, fresh population recount, tests, claim, or writer
authorization is asserted by this handoff. P ABI/schema/codec changes are excluded.
Old frames, paused e042 files, and all frozen execution/preservation files remain untouched.

## Ownership

Future isolated writer: `src/ir/program/native-async-requirements.ts`,
`src/backend/wasmgc/async/prepared-frame.ts`,
`src/backend/wasmgc/resources/native-async-frames.ts`,
`src/runtime/wasmgc/async/frame-entry.ts`, and the two spec-named requirements/frame tests.
Parent retains checked authentication, physical plan, supplemental ABI, aggregate,
consumer dispatch and complete program execution tests. This proposal needs interface
agreement before consumers import it; dependency pack types cannot be invented while
the reviewed closure/argument-vector prerequisites are absent from this checkout.

## Pure requirements input and exact canonical imports

Proposed exported `NativeAsyncRequirementsInput` fields:

- `anchor: string` — parent-selected structural entry anchor, never a final index.
- `functions: readonly IrFunction[]` from `ir/core/nodes.ts`.
- `selectedFunctions: readonly PreparedIrFunction[]` from `ir/runtime/contracts/prepared.ts`.
- `derivedUnits: readonly ProgramAbiDerivedUnitRecord[]` from `ir/program/abi.ts`.
- `abiEntries: readonly PreparedIrAbiEntry[]` from `ir/program/prepared-contracts.ts`.
- `manifest: FrozenRuntimeManifest` from `ir/runtime/contracts/manifest.ts`.
- `policy: RuntimeManifestPolicy` from `runtime/contracts/provider-policy.ts`.
- `allocations: AllocRegistrySnapshot` from `ir/analysis/contracts/allocations.ts`.
- `backend`, `target`: their exact RuntimeManifestPolicy property types.
- `configuration: NativePromiseConfiguration` from `ir/program/native-promise-resources.ts`
  (`hooks: disabled|dispatch`, `unhandledRejections: disabled|track`), plus the
  parent-resolved service/formatter/output configuration once the respective lanes
  freeze it. Do not guess missing configuration or reread process.env.

Use explicit manifest provider population; do not accept an unrelated parallel
provider list without exact reconciliation. Full program/current selected-projection
authentication remains in parent. Pure derivation checks local shape, complete census,
canonical references and selected attachment currency; it does not mint acceptance.

Operations:

```ts
deriveNativeAsyncRequirements(input: NativeAsyncRequirementsInput): NativeAsyncRequirements;
assertNativeAsyncRequirementsCurrent(input: NativeAsyncRequirementsInput, requirements: NativeAsyncRequirements): void;
```

Requirements should have a discriminated availability result containing the complete
census in both cases: `availability: {kind:"available"} | {kind:"unavailable", gaps: readonly NativeAsyncGap[]}`.
Each gap carries ownerUnitId, region, optional state/instruction coordinate and detail;
parent resolves original source location through existing ownership inventory. Never
return fewer owners, states, calls or providers as a successful partial plan.

The exact materialized fields proposed for `NativeAsyncRequirements`:

- anchor/configuration/backend/target and exact selected manifest reference;
- ordered `owners` and `selectedOwners`, each containing unitId plus ordered buffers
  and every call occurrence (including empty owners);
- occurrence `{ownerUnitId, region, rootIndex, stateId?, path, ordinal, instruction, bindingKey}`;
  path is ordered instruction/child-buffer coordinate pairs, not a visited-object set;
- `derivedUnits`, complete provider/callable demands, required dependency roles;
- `frames: readonly NativeAsyncFrameRequirement[]` in selected-owner order;
- availability as above. Preserve borrowed source identities; do not recursively freeze
  the caller's objects or clone away identity-based layout associations.

Each frame requirement carries exact selected owner, `entry: IrFuncRef` canonically
constructed with `irUnitFuncRef({ unitId: owner.unitId, name: owner.name })`, selected `plan: IrAsyncPlan`, and
`runtime: CurrentPreparedIrAsyncRuntime`; params/values/spills/handlers are retained
with exact IDs/types and order. Reconcile semantic vs selected data structurally,
but call `assertPreparedIrAsyncRuntimeCurrent(owner.unitId, owner.name,
owner.asyncPlan, owner.asyncRuntime)` using the SELECTED owner's own plan.

Runtime attachment import owner: `ir/runtime/async-attachment.ts`, not `ir/async-plan.ts`.
Comparison owner: `ir/program/data.ts` (`preparedIrDataMismatch`). Call identity owner:
`ir/core/callable-bindings.ts` (`irCallableBindingKey`, `irUnitFuncRef`). Logical types:
`ir/core/types.ts`; state/handler/spill contracts: `ir/core/async-plan.ts`.
Reuse all six `NATIVE_ASYNC_CALLABLE_DECLARATIONS` from
`ir/runtime/native-async-callables.ts`; clock has no slot. No inferred name authority.

## Frame reservation / detached output contract

Proposed named types, to finalize against composed issued dependency packs:

```ts
interface NativeAsyncFrameReservation {
  readonly ownerUnitId: IrUnitId;
  readonly requirement: NativeAsyncFrameRequirement;
  readonly frame: TypeReservation;
  readonly resume: FunctionReservation;
  readonly fulfillStep: FunctionReservation;
  readonly rejectStep: FunctionReservation;
}
interface NativeAsyncFramesReservations {
  readonly owners: readonly NativeAsyncFrameReservation[];
}
interface NativeAsyncDetachedBody {
  readonly locals: readonly LocalDef[];
  readonly body: readonly Instr[];
}
interface NativeAsyncFrameEmission {
  readonly reservation: NativeAsyncFrameReservation;
  readonly entry: NativeAsyncDetachedBody;
  readonly resume: NativeAsyncDetachedBody;
  readonly fulfillStep: NativeAsyncDetachedBody;
  readonly rejectStep: NativeAsyncDetachedBody;
}
```

`reserveNativeAsyncFrames(tx, requirements, dependencies)` returns the ordered pack;
entry is the EXISTING selected prepared owner slot, never a fourth supplemental helper.
`emitPreparedNativeAsyncFrame(requirement, reservation, bindings)` returns detached
four-output bodies with exact reservation association. `fillNativeAsyncFrames(tx,
pack, emissions, entries)` installs each once, with `entries` a complete ordered
owner/FunctionReservation population supplied by parent, not arbitrary lookup callbacks.
No independent freeze/seal; parent reserves everything before freeze, binds, then fills.

Preallocation declarations must be producer-authored using existing
`NativeResourceRecipe` / `NativeStringValueDeclaration` structural type mechanism
(historical names do not authorize another allocator). Keys are owner-qualified
structural identities; entry ABI is params -> externref; resume is non-null frame ->
void; steps are (externref caps, externref value) -> externref. Intern signature/type
schedule must follow donor order, not simply count equality. Calls use FuncHandle;
type/global/tag references use their actual ledger spaces.

Dependencies must be real issued Promise/vector/value/closure packs and exact
ABI bindings; before finalizing their TS wrapper, compose reviewed sibling packs.
Required native data: Promise type and callback type; queue enqueue; mark-rejection-
handled; fulfill/reject; pending capability/closure bag initialization contract;
canonical undefined; number box/unbox; vector layouts and exact fromExtern conversions;
exception tag; every selected state call binding and native string result conversion.
Missing any demand is an explicit unavailable preflight outcome. Raw numeric handles
alone, `finalized:true`, missing provider arrays or empty callbacks do not authenticate.

## Fixed layout and donor mapping

`codegen/ir-async-frame.ts:61–133` provides frame layout: fields 0 state:i32 mutable,
1 sent:externref mutable, 2 mode:i32 mutable, 3 abrupt:externref mutable,
4 error:externref mutable; params start at 5 in plan order and are immutable;
spills follow, mutable, excluding ALL parameter value IDs; last field is mutable
non-null native Promise result. Keep value-ID -> param/spill/local maps separate.
Mode next=0, throw=2. No source-visible object-field registration for private frames.

`preparedCfg` in that donor (194–384) maps:

- body: `runtime.states[i].body`, NEVER semantic body;
- updates: selected plan.states[i].updates in order, after body;
- resume: SENT field -> exact conversion -> destination value local;
- restore set: ordered union of incoming suspend.live values for target state,
  filtered to physical spills (parameter IDs excluded), no global all-spills restore;
- suspend: persist exact live spills, set exact resume.state, assimilate/classify,
  subscribe if pending, enqueue step if settled/plain, always return asynchronously;
- goto/branch: exact state targets and nested dispatch branch depths;
- resolve(value): convert to externref and settle, preserving direct identity-resume
  optimization only if its selected body/update obligations are independently empty;
- resolve(void): canonical undefined, not null;
- reject/complete and handlers: schema retained, located refusal before reservation
  unless the adapter explicitly implements/tests them. Do not map default to resolve.

Current donor only emits const/call state instructions; that is NOT enough for the
family's vector/loop/main states. Census all selected instructions before defining
adapter coverage. Reuse ordinary canonical IR lowering primitives where compatible;
do not call legacy lowerPreparedIrAsyncFunction or recreate FunctionContext callbacks.

Existing executable owners (import directly from canonical paths):

- `runtime/wasmgc/async/frame-engine.ts`: buildStepAdapterLocals(stateTypeIdx),
  buildStepAdapterBody({stateTypeIdx,sentField,errorField,modeField,throwMode,resumeFuncIdx},reject),
  buildAsyncFrameStateChain({frameLocal,stateTypeIdx,stateField,states,completed?}),
  buildAsyncFrameDispatch({target,stateTypeIdx,stateField,modeField,nextMode,frameLocal,
  resultPromiseLocal,reasonLocal,handlerLocal?,exnTag,settleRejectIdx,chain,handlers,
  completedStateId?,hostGetCaughtIdx?}). No new handler schema.
- `runtime/wasmgc/async/native-await.ts`: buildNativeAwaitClassification with all
  awaited/promise/frame/suspended locals, Promise/frame types, sent/error fields,
  queue/step/mark-rejection handles and explicit throw-mode instructions;
  buildNativeAwaitSuspendArm(true,suspendedLocal,pendingArm,queuedArm).
  Native lane must pass true; no absent-handle sentinel permitted by pack completion.
- `codegen/async-frame.ts:2654–2753` is entry extraction donor for new frame-entry:
  create pending Promise, initialize fields/params/default spills, save frame, kick
  resume once, return the SAME Promise via extern.convert_any. No late-import/name
  lookup fallback in native ledger adapter. Canonical closure-bag initializer must
  be supplied by composed dependency contract, not a hand-written null surrogate.
- async-frame.ts:2192–2259 supplies pending callback linkage and queued-return order;
  1897 supplies result Promise load; existing dispatch remains the exception owner.

Handlers: IrAsyncHandler is `{id,kind:"catch",entry,parent: id|null}`. Frame engine
also models finally bodies/catchBinding and optional local/spill index (zero valid).
These schemas are not interchangeable. Initially reject any nonempty prepared handler
population without discarding it. General legacy finally support is NOT established.

## Mandatory tests and implementation stops

Requirements: real full original/runtime-variant preparation plus real codec decode;
independently recount 5/22 then16/33, four async owners/five awaits; keep derived/empty
owners. Positive-first mutations: foreign/copied/stale selected attachment, equal-looking
wrong plan identity, absent plan/manifest, wrong owner/state order/target, missing call,
provider substitution, layout association/fromExtern change, spill-param duplication,
incoming live omission, update reorder, handler omission, unavailable dependencies.
Re-derive must catch post-plan mutation; original issued resources cannot serve decoded.

Frame: exact fields/mutability/order, three helpers per async owner plus original entry;
four detached outputs installed once; real binary validation/execution, not function
counts only; selected-vs-semantic body distinguishing fixture; suspend/restore/updates,
goto/branch loops, resolve identity and nonidentity, native undefined, reject routing.
Pending/fulfilled/rejected/plain awaits all asynchronous; queue order and repeated/fresh
instances; 3e9 conversion and nullable/non-null vectors. Scratch locals must be defaultable
without losing logical non-null views: positive construction proof before refinement,
and remove-refinement mutation reproducing actual Wasm validation failure.

Preservation: fixed full donor receipts (including docs/order/initializers/locals), exact
canonical export identities, positive-first body/field/branch/handler mutations; retain
existing frame-engine/native-await tests and historical handler controls independently.
Full timer/fetch/main stdout consumer behaviors are parent acceptance, not fabricated
Lane A dependencies. Fresh backend child must reject frontend/codegen imports.

Stops requiring coordination: missing issued prerequisite pack APIs; unsupported selected
instruction forms; exact semantic non-null spill initialization strategy; any proposed
shared lowerer extraction outside six owned paths; any P transport/schema need. None
authorizes widening allowed edges, losing allocation metadata, or importing paused C census.
