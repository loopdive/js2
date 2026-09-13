# Native closure root and settlement metadata — frozen High scope

High spec relayed from Huygens on 2026-09-08. Grounding: closure/argument-vector
census at edfb6f4b6bf884cc69eceddb8713eab04370b2c9. Parent authorizes published
base bfe31c8bd96d748e867562e3e9b78343b72d1877 for a new isolated checkout;
worker must verify the base and obtain the exact disjoint assignment claim.
Reuse Euclid, not a new task. Preserve the frozen argument-vector checkout.

## Exactly seven writer files

- src/codegen/closures/closure-header-layout.ts
- src/codegen/closures/funcref-wrapper-types.ts
- src/codegen/builtin-fn-meta.ts
- src/runtime/wasmgc/values/closure-layouts.ts (new)
- src/backend/wasmgc/resources/native-closures.ts (new)
- tests/issue-3518-native-closure-resources.test.ts (new)
- tests/fixtures/issue-3518-native-closure-donors.json (new)

No object-runtime, ObjVec, Promise capture/trampoline/settlement/scheduler,
scanner/flatten, module-reservations, program consumer/physical-plan, policy,
settings or budget baseline edits. Parent owns boundary activation and joins.
No host/linear implementation or new global identity/completion registry.
The approved assertTypeReservation ledger amendment is a pending dependency
in the parent argument-vector integration; use that API, but do not copy or
edit the ledger. Composed validation follows parent dependency integration.

## Canonical movement

Move all eleven closure-header exports with exact compatibility forwards:
CLOSURE_FUNC_FIELD_IDX=0, CLOSURE_ARITY_FIELD_IDX=1, CLOSURE_BAG_FIELD_IDX=2,
CLOSURE_CAPTURE_FIELD_BASE=3, INSTANCE_BAG_FIELD="$bag", closureArityField,
closureBagField, closureBagInitInstr, hasClosureHeaderPrefix,
isCanonicalClosureHeader, closureSubtypeFieldCount. Preserve predicates;
structural predicates are not ownership proofs.

Canonical ClosureAllocationMode remains "support" | "ordinary" |
"host-one-shot". BFN_STATE_FIELD_IDX=3 and BFN_ID_FIELD_IDX=4 retain old
reexports. Add pure factories createSignatureWrapperType(name, superTypeIdx),
createBuiltinFunctionMetadataType(typeIndex, signatureWrapperTypeIndex),
buildBuiltinClosureValueInstrs(typeIndex, functionHandle, arity, isMetadata).
Use current model/handle types, never CodegenContext or callback escapes.

Header fields: immutable func:funcref, immutable $arity:i32, mutable
$bag:externref. Metadata adds mutable bfnstate:i32, immutable bfnid:i32.
Builtin value order: ref.func, arity, null bag, optional state=0 and metadata
TYPE INDEX, struct.new. No capture fields. Static-method metadata catalogs
remain in their current owner, not duplicated.

Existing getOrCreateFuncRefWrapperTypes, ensureBuiltinFnMetaType and
pushBuiltinFnClosureValueInstrs call canonical producers at exactly their
original allocation/publication points. Retain rest/constructible/other paths.

## Backend contract

reserveNativeClosureResources(tx, requirements)
requireNativeClosureReservations(tx, pack)

Own actual type/function-signature reservations, not trampoline bodies; no
dummy fill API. Requirements carry module key, starting closure counter,
ordered signature requests (unique identity, complete physical user params
and results, allocation mode, observed minimum arguments), ordered settlement
metadata requests referring to genuine signature requests, and SAME-ledger
TypeReservations for every concrete reference type. Authenticate all external
types with assertTypeReservation before any allocation. Resource requirements
are not proof of complete public-source population.

Private issued-pack provenance binds exact transaction and snapshots request
sequence. Output: one root token, ordered request/wrapper bindings preserving
cache aliases, lifted function-type identities, settlement metadata token and
key/name/length/ID record, resulting counter, ordered registration records.
Use the existing physical ledger, not a new allocator or completion registry.

## Ordering and identity

First actual signature establishes OPEN root: no universal pre-root or
settle-first sorting. Preserve signature cache identity/order. Cache miss:
counter, struct append, root assignment if absent, lifted function-type intern,
closureInfoByTypeIdx, wrapper cache. Lifted self always uses ROOT.

Cache hits still update minimum arity and allocation mode. Ordinary clears
hostOneShotOnly; support does not. Preserve observeMinimumArgumentCount sync
across both wrapper caches, closureInfoByTypeIdx AND closureMap, whose records
may be copied rather than aliased.

Metadata order: append, copy/register closure info, publish name/length, key
cache. Repeated promise:settle reuses one entry. Settle signature is
[externref] -> [], name "", length 1. bfnid is metadata TYPE index, never
capture index. Existing native-promises owns capture subtype/field5, actual
resolve/reject trampolines, forward cycle and fresh values. Do not duplicate
capture or register its closureInfo. Parent joins root/settle metadata later.
Resolve must assimilate via resolve-value, not direct fulfill.

## Required evidence

Pin exact current donors and all moved/retained bodies, nested initializers,
docs/order. Inverse reconstructs COMPLETE donors from live canonical/adapters
allowing only enumerated import/forward/factory changes. Fixed original
receipts; no runtime Git or reseeded hashes.

Positive-first mutations: missing/renamed imports; retained declaration
reorder/change; header/field mutability/order; metadata ID; root-self change;
duplicate root; dropped cache-hit updates; premature publication.

Reservation probes: first-signature permutations; cache hit/miss/counter
order; every allocation mode and minimum arity; repeated settle reuse;
distinct metadata IDs; foreign/copied packs/types and stale descriptors reject
before allocation changes; no accidental Promise capture registration.

Real generated closure-value execution uses genuine functions/declarations
and typed invocation, checking arity, null bag, state, ID independently.
Manufactured callers do not prove public provenance. Preserve existing source
controls issue-4241-carrier-bag-slot, issue-2896,
issue-2963-builtin-reification, issue-5197-promise-generic-capability. Pair
supported source bytes/WAT/type order/outcomes when parent grants execution;
report unsupported cases rather than substitute counters.

Canonical runtime/backend has no legacy facade or upward type-only edges.
Parent activates exact roots and deletion/forbidden-edge controls without
relaxing allowedEdges. Freeze seven files with hashes/manifest and honest
unrun status. Heavy tests require parent grant; static work can proceed now.

This supplies real root/metadata dependencies and retains real legacy callers;
it does not complete dispatcher/object inventories, captures/frame execution,
full-family physical acceptance, public IR-only cutover, or direct retirement.
The fixed ABI30 and missing planningSealed witness obligations are unchanged.
