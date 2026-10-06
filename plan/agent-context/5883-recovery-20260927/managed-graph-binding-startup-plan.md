# Managed DomainV1 graph binding and startup implementation

Accepted source-only implementation plan for the next 5883 checkpoint. Basis:
recovery 55d1c3731bb1c5b219d12709e90b42e12dbf0a4e and published lifecycle
0f858. No production edits, execution, activation or retirement authorization.
PR6195 remains held pending coherent managed-graph replacement. Its original
25-case source/evidence and quality failure remain preserved. The redundant
adapter enrollment API is withdrawn: the graph construction owner retains actual
instances and invokes the original setInstance only after graph binding.

## Shared ABI

Add immutable planning types in src/ir/program/vector-domain-plan.ts:

```ts
interface VectorBindingSlotPlan {
  slot: number;
  supplierNode: string; // graph instance occurrence, not artifact hash
  allocationRole: string;
  layoutBinding: string;
  semanticKind: VectorSemanticKind;
  storageKind: VectorStorageKind;
}
interface VectorGraphNodePlan {
  nodeId: string;
  slots: readonly VectorBindingSlotPlan[];
  initialization: "provider" | "root-caller";
}
interface VectorGraphBindingPlan {
  abi: "js2.vector-binding.v1";
  nodes: readonly VectorGraphNodePlan[];
  providerInitializationOrder: readonly string[];
  rootNode: string;
}
```

The verified artifact manifest supplies per-node domain roles, bootstrap roles
and startup policy. The graph plan resolves these to instance occurrences.
Canonical slot ordering/digest participates in compilation/cache identity.
Initially every receiver reserves slots for every domain allocation role in the
closed graph, including itself and root. This covers forward, transitive and
reverse-callback supply without guessing value flow. No source admission change.
Two instances of identical bytes are distinct suppliers. Different graph plans
cannot silently reuse an incompatible cached artifact.

## Mendel: exact physical resources

New native-vector-bindings.ts beside native-vector-domains.ts, using the existing
PhysicalModuleReservations owner:

- Immutable capsule with domain: ref DomainV1 and validator: typed
  (externref, externref) -> i32 function reference.
- One immutable externref projection per supplier domain, initialized from its
  exact domain-global and validator reservations; declare validator ref.func.
- One private nullable capsule global per receiver slot and one completion global.
- installVectorBinding(i32 slot, externref capsule) -> ().
- finishVectorBindings() -> ().

Installer preflights range, completion state, vacant slot, capsule type and planned
domain metadata before writing. It never invokes validator, services, source code,
export preparation or initialization. Duplicate installation rejects, including
an identical reinstall. Completion verifies all slots before setting its flag.
The externref envelope avoids depending on JavaScript typed-GC/function-parameter
exposure; native typed function references stay inside the capsule.

Expose exact reservation tokens to the linker plan, not names or booleans.
Capsule shape is defensive consistency, not authentication. The managed
constructor supplies provenance. No duplicate descriptor/property authority.
At dispatch compare resident domain identity with the bound capsule's domain,
then use that capsule's typed validator; never invoke an untrusted candidate's
validator to authenticate itself.

## Russell: actual construction and lifecycle

Implement a private graph owner in linked-provider-runtime.ts, extracting new
machinery into linked-provider-construction.ts as appropriate. It retains:

- Verified artifact and exact Module constructed from its bytes.
- Exact Instance the owner itself constructs from that Module.
- Per-instance original setInstance closure/import-adapter identity.
- Actual immutable capsule globals and bootstrap exports.
- Graph/node/slot-plan identity and construction state.

The owner invokes the captured trusted construction primitive. No adoption API
accepts a caller-claimed Module/Instance pair, copied exports or adapter token.

1. Verify complete graph and startup policies.
2. Construct providers in dependency order, then root, with no user starts.
3. Read raw binding exports via genuine-instance intrinsic, without setInstance.
4. Preflight every supplier/receiver association.
5. Install all slots, including root-to-provider reverse bindings.
6. Complete binding in every node.
7. Release each provider's original setInstance -> initializer sequence, retaining
   existing surrounding decoder/projection ordering.
8. Wire root using its original setter and decoder registration.
9. Return bound root; root initializer remains explicitly caller-owned.

Binding failure poisons the attempt. No reuse or rollback claim for already-written
slots. Initialization exceptions propagate at their existing ownership boundary.
setInstance still performs prepare-view -> publish -> drain, with its original
throw/reentrancy behavior. No preparation or bridge-authority side effects during
private retention. No new public runtime enrollment API.

## Genuine Wasm start: compile-time ownership, not post-instantiation deferral

Parent's 55d1 startup audit fixes the implementation choice: reuse the existing
deferTopLevelInit policy, not a new compiler option. declarations.ts:6641 installs
start under !ctx.wasi && !exportModuleInit; its deferred __module_init path already
owns exact prepared aliases/reconciliation. ir/program-consumer.ts:895
fillStartupAdapter already selects wasm-start versus deferred-export.
codegen/index.ts:7345 applyModuleInitGuard currently prepends initialization to
every exported function except the exact initFn. Extend that actual owner with
authenticated bootstrap-allocation exemption; do not bypass it by spelling.
Verified artifact evidence must check the selected policy and actual emitted
startup, not trust the option alone. Startup implementation remains parent-owned
pending assignment; Mendel and Russell must not independently edit these seams.

A Wasm start executes inside instantiation. Runtime cannot postpone it afterward.
Managed graph artifacts must select deferred user initialization BEFORE emission.
Preserve initializer body/order; change its owning invocation point. Do not strip
start from emitted bytes afterward.

Coherent startup selection covers:

- codegen/declarations.ts: legacy startFuncIdx vs deferred export selection.
- codegen/multi-prepared-program.ts: prepared adapter selection/reconciliation.
- ir/program-consumer.ts: fillStartupAdapter.
- codegen/index.ts: WASI entry/init guards.
- Corresponding Program ABI startup planning and census inputs.

Origin/domain/capsule constant initialization happens at instantiation. Any
necessary executable bootstrap is explicitly classified and proved non-user-
calling; it cannot conceal user initialization. Manifest policy and actual artifact
must agree. Old incompatible cached artifacts require recompilation, not trusting
a metadata flag. Changed construction timing requires paired imported-global,
start-effect and exception-order controls; neutrality is not assumed.

## Authenticated bootstrap role

Implementation ownership refinement: native-vector-bindings.ts owns both proof
issuance and classification, backed by its actual private binding-packet map and
private proof WeakMap. No separately exported generic createProof(fn, writeList),
arbitrary function set, caller boolean or structural certificate is accepted.
A guard-facing module may thin-reexport the classifier/types only. The physical
owner must not import the backend. Parent first implements only the narrow
PhysicalModuleReservations.assertOwnsModule(module) primitive and controls.
Preparation derives exact function/type/global roles from the genuine packet;
classification revalidates same module, current completed function/body/locals
and the actual closed builder grammar. Parent guard integration waits the actual
builders and correct fill ordering. Ordinary initialization prefixes must be
assembled before once-only physical fill; no post-seal guard mutation or relaxed
owner snapshots. Physical completion checks currently validate whole-owner state,
so legacy mutation cannot be silently combined with a sealed transaction.

Reserve installer/completion with allocator-owned physical roles. Init guards
exempt exactly those function allocations, not names/prefixes/all helpers.
Their transitive bodies have no initializer or callback edge. Ordinary user
exports retain original guards, including same-named functions. Completion is
not semantic readiness. Reserve all roles before freeze and retain ordinary
relocation, declarations and instruction ownership.

## Native, static bundle and explicit caller handoff

Native separate instances: trusted embedder constructs every node without user
starts, then a Wasm driver importing actual capsule globals/bootstrap functions.
Driver installs all slots, completes all nodes, then invokes provider initializers.
No JavaScript callback imports are introduced.

Static bundle: equivalent driver with actual edges retained through
package-bundler.ts merge/DCE. Replace the existing deferred-provider rejection
only when this driver is implemented. Component starts cannot run user code ahead
of binding. Root init stays caller-deferred or under the existing _start policy,
never both. Full native/static coverage is mandatory, not a host-only waiver.

JavaScript: migrate instantiateLinkedProject and scripts/test262-import-object.mjs
plus worker coordination to managed construction. Preserve runDeferredInit and
worker-owned exception classification. The raw cached result.importObject API
cannot prove an independently constructed root's origin: preserve its old behavior
while dormant and explicitly migrate all relevant callers before activation.
Do not introduce latest-root state or exempt its programs from acceptance.

## Actionable source partitions

1. Mendel: slot-plan data, capsule/installer/completion resources and builders,
   structural and real-Wasm controls; no active carrier migration yet.
2. Russell: private managed constructor, original setters, exact graph associations,
   binding and caller handoff; no adapter enrollment API.
3. Startup owner jointly with Russell: legacy/prepared/IR deferred startup policy
   and authenticated physical bootstrap-role exemption.
4. Native/link owner: actual driver and bundler retention. Required implementation,
   not a future acceptance exemption.
5. Parent: coherent union with DomainV1 producers/consumers and semantic services.

These may be reviewed separately; none individually authorizes activation.

## Required controls and remaining gates

Real start-time user callbacks; wrong Module/Instance association; identical bytes
in distinct instances; shared/cached imports; transplanted capsules; missing,
duplicate, reversed and post-completion slots; partial binding failure; reentrant
initialization; prepare/drain/init throws; root deferred init exactly once; forged
bootstrap roles and same-named user functions; native DCE retention and zero new
host imports. Preserve all four original array blockers and every foreign control.

Binding completion authenticates planned providers only. Portable semantic values,
symbols/descriptors/exception transport, private-slot exclusion, validator/service
correctness and full producer/mutator closure remain activation prerequisites.
Old compiler retirement still requires complete IR equivalence.
