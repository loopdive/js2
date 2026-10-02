# PR5883 Promise dependency-cycle repair

Parent plan; Sol-6.1 Medium D implements in this isolated checkout, not the
frozen queued branch. HEAD e946127595242f2b186c184ce3c2aa25ddbe7c8a, pending
merge9c6d0b1e6bcfeec689afcddf70bf55f21fb12412. Source/scripts match failed
queue treecda603a664d1dc115b327da64e26c9e30d3569c3 before repairs.

Unchanged checker measurements: base697 SCC members/codegen->ir295, merge699/296.
The two added members are promise-combinator-observable-protocol and
promise-observable-combinators. The net extra edge is their two imports of
ir/try-table replacing the old combined owner's one. No threshold or workflow
changes are authorized. This directly unblocks the existing landing sequence.

## Cut actual backwards dependencies

Keep both implementation bodies and public signatures. Retain only leaf runtime
imports: context/locals allocLocal, func-space mint/push, closure-classifier
buildClosureRefTestArms. Import closureBagInitInstr from its actual leaf owner
closures/closure-header-layout, and buildTargetTaggedTry from the existing
wasm/physical/exception-control owner, not the IR re-export. All context/types
and dependency-signature imports are type-only.

Replace every remaining value import into the compiler cycle with explicit
readonly per-context service records, interfaces defined in these two owners.
Install records inside existing context/create-context.ts, with declarations
in context/types.ts. Do not add a new cyclic provider module, global registry,
dynamic loader, require/import fallback, or hide a value import from the checker.

Services preserve exact existing signatures for ensureCombinatorFunctions,
ensureAsyncDriveRuntime, ensurePromiseExecutorClosures, ensureObjectRuntime,
ensureObjVecBuilders, reserveApplyClosure, ensureBuiltinFnMetaType,
getOrCreateFuncRefWrapperTypes, ensureStandaloneBuiltinStaticMethodClosure,
emitBuiltinConstructorIdentity, reserveCarrierBagVisibility,
promiseProtoThenMayBeReplaced, aggregateSettleFuncIdx,
buildPromiseSettleClosureInstrs, emitWasiErrorConstructor,
stringConstantExternrefInstrs, addStringConstantGlobal, ensureExnTag and the
pending-state value. Protocol additionally needs getArrTypeIdxFromVec and the
two legacy combinator entrypoints. The separate owner may retain resolveF64VecArg
from the now-acyclic protocol owner. Do not merge their independent pipelines.

Context creation installs forwarding callbacks only: no ensures, allocation,
registration, generated instructions, or captured function handles/resources.
Call current imported functions when the callback executes, not snapshots taken
at context construction, preserving existing post-creation spies. Keep pending
state access lazy if necessary to avoid new initialization-order reads. Missing
injected services must fail explicitly; never silently choose legacy behavior.

C's independent producer/copy audit found both production entrypoints use
createCodegenContext and no replacement-context route. Forward every callback's
actual arguments, including its ctx argument; do not capture the constructor's
context instead. Installation tests measure added service-installation effects
against existing constructor behavior, not a false assertion that the whole
constructor allocates nothing. Existing baseline type registration remains.

## Preserve behavior at each call site

Replace calls in place, without moving their evaluation. Preserve resource
registration order, repeated scheduler ensures, nullable-cache handling,
literal arguments before Get(resolve), vector reads/boxing at consumption time,
prototype replacement checks, aggregate settlement, live handle lookup and
detached-body tracking. Preserve the shared __promiseObservableCombinators cache
names, protocol nullable fallback and separate pipeline's explicit unavailable
error. Legacy emitter bodies and runtime fixture programs stay unchanged.

Only existing diagnostic-only issue-5883-observable-cache-unavailable fixture
setup may gain explicit services because it deliberately fabricates a partial
context. Preserve its fault injections and exact expected error. No global
fallback for partial contexts. Audit other context producers/copies/consumers
before widening scope; return evidence if any cannot receive these fields safely.

## Validation and acceptance

Add controls proving per-context isolation, no new ensures/allocations during
service installation, late spy visibility and missing-service refusal. Use
positive controls; do not call successful source analysis runtime equivalence.
Run the unchanged gate and inspect full SCC membership/all directory metrics:
both new modules must actually leave the SCC. Expected codegen->ir294 is a
hypothesis, not a measured result. Baseline remains unchanged.

Preserve/rerun previous92 checkpoint rows, original fixtures/negative controls,
canonical typecheck and normal hooks, plus new service-boundary controls.
Source preservation may require an authenticated new inverse receipt; never
change old fixture authority or replace original failures. Return exact impacted
reader paths before implementing such a successor. Preserve broader unresolved
401-population and full-IR holds. No legacy retirement or full-equivalence claim.

Authorized production scope: the two Promise owners and context types/creation.
Tests: additive service controls and bounded unavailable-context setup only.
No agent execution/formatting/staging/commit/push/requeue. Parent owns serialized
validation, integration and protected queue publication after independent review.

## Independent-review amendment: non-circular construction control

C found that comparing two calls to the repaired constructor cannot detect new
eager allocations shared by both calls. Preserve all seven test identities and
production bytes. Replace only that control's self-baseline with independently
established expectations from unchanged queue tree cda603a. Parent owns baseline
execution; the implementer may inspect its original constructor and dependencies
to identify expected existing registration, but must not invent measured counts.
Install fail-on-call spies for every newly forwarded service provider during
construction, including object runtime, wrapper/metadata registration, static
builtin closures, carrier visibility, string/global/exception-tag registration,
legacy combinators and settlement helpers. Do not forbid legitimate existing
native-string/vector type registration. Include a positive control proving the
guard fails when a forbidden provider is invoked, then clear that invocation
before testing real construction. For existing allocation/type counts, either
use parent-measured unchanged-tree values with provenance or leave that numeric
claim pending. Do not compare the candidate to itself as an independent baseline.

## Canonical typecheck correction

Run34492 reports exactly two TS2322 diagnostics: both lazy pendingState getters
infer number, while the original constant/service contract requires literal0.
Annotate each getter return type as typeof PROMISE_STATE_PENDING, retaining the
same lazy return expression. No interface widening, numeric cast, literal copy,
eager value or runtime behavior change is authorized. Parent repeats canonical
and affected service/protocol tests after review; original failure is retained.

## Function-budget blocker: bounded record constructors

Normal gate run99279 passes LOC but rejects createCodegenContext565>514, +51.
Do not grant an allowance or edit any baseline. Move the two new service-record
object literals into two small private, typed record-constructor functions in
the same create-context.ts module. Each returns a fresh record with exactly the
current forwarding callbacks and lazy typed getter. createCodegenContext calls
each constructor exactly once. Return types reference the existing interfaces
with type-only imports. No helper module, global cached record, captured context,
provider call at construction or changed invocation behavior. This preserves
per-context isolation and introduces no new runtime import edge. Parent reruns
function budget, unchanged cycle gate, canonical,99rows and constructor-state
comparison after independent review and formatting. This changes the plan's
inline installation detail, not its service boundary or preservation contract.

The split removes49 lines, but gate54309 still measures516>514 because the
two installation properties are new. Do not compress statements or remove
comments to game the metric. Extract the existing cohesive linked-package/
linked-namespace initialization into a private helper in the same module,
returning both linkedPackageBindings and linkedNamespaces. Preserve the original
nullish default, iteration/order/deduplication and original caller-options map
identity. Destructure its result at the same position before context construction.
This is the only additional existing constructor logic authorized to move.
Add controls for absent options, explicit bindings identity, explicit links,
binding-derived namespaces and duplicate/order handling, compared with the exact
original expressions. Parent validation must finish before this source changes.

## Publication-base allowance provenance

The normal local LOC pass used merge-base and inadvertently borrowed an incoming
issue6651 allowance. Explicit actual-main1a160821 comparison rejects context/types
4929>4925, exactly the two type-only imports and two readonly service fields
required by this plan. Record this intentional interface-only +4-line wiring in
this change-set's own issue3518 loc-budget-allow, with its reason visible in the
diff, as required by the existing gate policy. Do not borrow unrelated grants,
compress interface declarations, move arbitrary fields or alter a shared baseline.
This narrowly scoped LOC declaration does not grant a function-size allowance:
createCodegenContext must pass its unchanged cap after the cohesive extractions.
