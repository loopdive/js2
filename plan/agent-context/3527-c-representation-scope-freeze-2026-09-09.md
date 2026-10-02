# C representation and scope freeze — historical decision

Issue #3527, **IR-only R7: AST-free async suspension plans and canonical Promise
ABI**. Recorded September 9 and recovered for publication October 2, 2026,
from the architect task after its temporary checkout was removed. The original
freeze was uncommitted. This preserves that decision; it is not a new dispatch,
a current ownership ledger, or an instruction to pause later work.

The [later native async takeover plan](3518-native-async-takeover-2026-09-15.md)
and [subsequent issue evidence](../issues/3527-ir-r7-ast-free-async-plan.md)
postdate this record. The historical host-work hold and missing dependency
status below must not be read as current implementation status.

## Evidence available at the decision

C's integration design and selected records were read in a checkout at
`9feb7bf8fc0f8fddccf87235c7664651eb338e92`; P's saved resource producer was
read in a checkout at `6037ac8bcf07be4f71839cea33cf8c90ecc87f94`. Both included
uncommitted drafts. Those reads established representation, not published
dependency delivery, passing composition or the absence of C defects.

The [canonical-entry repair](3527-canonical-entry-abi-repair-2026-09-07.md)
and [recovery plan](ir-migration-recovery-2026-09-07.md) already specified
the ABI distinction and resource ownership. P's draft contained the symbolic
record below. C was not to reconstruct missing producer data locally.

## Callable representation

For an async owner with numeric fulfillment, `IrFunction.resultTypes` and
semantic Promise fulfillment remain f64. Its single original source entry's
ABI intent and callable contract return one externref Promise carrier with
canonical Promise semantics. Every ordinary/imported/aliased/startup call to
that owner returns that carrier; the await successor separately receives f64.

Apply the caller rule before attachments exist and preserve it through final
preparation/optimization. Async void/no-await owners still return a Promise;
ordinary functions retain their supported callable contract. Native WasmGC
may construct a native Promise and expose its canonical opaque carrier;
externref does not authorize JS-host Promise semantics on standalone. Linear
physical async representation was unavailable at this decision.

P owns source/declaration/codec correction. C keeps exact signature checks:
no body-result retagging, synthetic successful fixture repair, weakened checks,
or entry signature inferred from an emitted helper. Contradictory snapshots
fail validation. Dependency delivery requires producer-created, codec-replayed
evidence at a pinned composition.

## Symbolic resource associations

The existing `prepared-async-resources-v1` record uses `ownerUnitId`,
`entryBindingId`, `frameTypeBindingId`, and helpers
`resume: {role: "resume", bindingId}`,
`fulfillStep: {role: "fulfill-step", bindingId}`,
`rejectStep: {role: "reject-step", bindingId}`.

P owns `preparedIrAsyncResourceIdentities(ownerUnitId, projection)` and matching
authoritative ABI declarations. The saved factory uses
`async-resources-v1:<backend>:<target>:<role>` for projection-specific support
roles, `irUnitCallableBindingId(ownerUnitId)` for the entry, and support
type/function references for the frame/helpers. C validates exact owner, role,
projection, signature and layout. Display names, discovery order and indices
cannot establish ownership.

Prepare projections against the final frozen semantic graph, collect the
complete declaration union, then seal the ABI/program. Replay revalidates all
associations and capabilities. Missing declarations yield a located unsupported
result before allocation; contradictory/donor declarations fail validation.
Helpers are physical support resources, not fabricated semantic units or
additional source-entry bindings.

Preserve ordered parameter/spill/result mappings; spillFields excludes
parameter fields. The saved record's `runtimeKind: "host-wasmgc"` describes
host contracts, not an approved native frame layout. Native unavailability
was to remain explicit pending a separately approved native contract/map.

## Callback publication authority

P serializes callback role (`fulfill`/`reject`) and `targetBindingId` only.
C maps them explicitly to declared fulfill-step/reject-step targets and owns
numeric IDs after acceptance, in one module-local publication domain. Reserve
the complete export namespace including user aliases. The host adapter reads
`__cb_<id>`; callback IDs are never function indices. Allocate collision-free
nonnegative IDs in deterministic owner/role order; reject duplicates and
exhaustion rather than overwrite a user export.

A process-local receipt binds module/domain identity, semantic owner, role,
BindingId, exact Wasm function object, callback ID, export name and exact export
object. A private receipt registry may authenticate module membership. Resolve
current indices through accepted object/handle authority in the correct space;
check the exact export still points to the exact target with the reserved
signature. Numeric equality is a final consistency check, not authority.

Foreign-domain, replaced-target/export, duplicate-name, wrong-role/signature
and revoked/stale receipts fail. Publication requires the complete sealed
resource census and successful installation; failure invalidates emission
authority and publishes no emitted program. Receipts, callback IDs, allocator
objects and module identities never serialize as authority. This host contract
does not add `__cb_` exports or host wrapping capabilities to standalone.

## Historical ownership and resumption boundary

C's preserved five-file scope at the decision was:

- `src/ir/program-physical-plan.ts`
- `src/ir/program-consumer.ts`
- `src/ir/program-async-physical.ts`
- `src/codegen/prepared-async-resource-materializer.ts`
- `tests/issue-3527-prepared-program-async.test.ts`

P schema/ABI/source files, B's frame engine and the runtime provider catalogue
were excluded. The coordinator owned claims, published dependency SHAs,
composition and validation scheduling. Under the September 7 standalone-only
priority, this freeze did not resume the paused host draft. Standalone C work
required frontend-free backend and physical reservation prerequisites; no whole
mixed-module move was authorized.

The September 9 review made no source edits, claim changes, dispatch or tests.
Recovery preserves its contract without changing later approved scopes or
claiming that the migration is complete.
