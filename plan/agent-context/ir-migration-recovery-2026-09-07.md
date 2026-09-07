# IR migration recovery and implementation assignments — 2026-09-07

Architect: Codex GPT-6 Astra High. Implementation: Astra Low only. This is a
specification and read-only recovery census, not an implementation or an
authorization to overwrite another owner's checkout. No PR hold is removed.

Contract freeze: the coordinator read this complete plan and authorized
dispatch of P and N on 2026-09-07. The P/C wire interface and disjoint ownership
below are frozen for that dispatch. Substantive amendments require an explicit
dated review update and notice to affected owners; do not silently edit the
contract while implementers work. C has explicitly approved the v2
persisted-input policy. This freeze does not waive a measured implementation
blocker.

## Ground truth and preserved work

Canonical upstream main was read through GitHub as
`9feb7bf8fc0f8fddccf87235c7664651eb338e92` (2026-09-07 18:16:31Z), and its
source objects were inspected locally. The verified assignment ledger is
`df46c34148149f67c1247a204a2c9977aeed4687`: 2,125 records, 803 held claims.
These are ownership records, not proof of process liveness. No claim was
released or replaced during this census.
The later documentation publication base is verified upstream
`79b0e7c4dc47949fb9708a9ca45d0e7e5bade2ae`; the source census and D measurements
below retain their actual earlier provenance and were not rerun on that base.

The visible Claude IR worktree
`/Users/thomas/Code/js2/.claude/worktrees/ir-migration-progress-f3a7f7` is at
`ef5b5d335b1019a5174015eaba485f8b9aad08cb`, with `.codex/config.toml` modified
and `.agents/` untracked. It contains no observed dirty source implementation.
This stale checkout is not evidence that recent remote Claude work was lost.

The shared `/Users/thomas/Code/js2` checkout is at the old August 16 commit
`e4c3e3cf040129a98efb90e07a2fe025cbcade96`, not canonical main. It has extensive
staged and unstaged work. In particular, seven staged IR files contain
218 additions / 14 deletions relative to that old HEAD: `from-ast.ts`,
`lower.ts`, `passes/inline-small.ts`, `passes/monomorphize.ts`,
`property-key-fold.ts`, `select.ts`, and `verify.ts`. Preserve all of it.
The untracked `plan/agent-context/opus-ir-1.md` and `opus-ir-2.md` describe
August 16 work, not a new September implementation assignment. Issues 4070
(exhaustiveness) and 4513 (computed object keys) are already done on current
main despite still-held ledger claims. Do not replay the old staged patch or
clear its claims simply because those issue statuses are done.

The recent recoverable Claude contribution is package C, not the stale
worktree: `5dd03b8e23` introduced codec/consumer, `999a6a4235` internal physical
setup, and `fdeb628d80` private immutable acceptance/emission authority. Their
commit records identify Claude Fable 5.1 Default. Those mechanisms are present
on current main, together with the canonical runtime callable declaration
work (`5c9fd95dba`) and A's internal driver. C's branch/repair worktree is
preserved; another historical PR merge is not a missing source prerequisite.
Ancestry checks against `9feb7bf8fc` returned true for all three cited Claude
commits, C repair `3427cb15ae`, A `3cb4a28992`, and the retained upstream
Claude W1-G, R2-F1, W1-C, R4-M1 and F3-S1/S2/S3 branch tips (12/12 checks).
Their still-held claims must not be mistaken for 12 missing implementations.

At the start of this census the IR checkpoints were B PR 5716 at
`bc83d0359dbd7673edda8be18550cb7639ca0be7` and D PR 5717 at
`6753f6d3c3d6ad2590151beb11e58cdeb514846a`, both held. A's worktree
`/Users/thomas/.codex/worktrees/c897/js2` at `3cb4a28992` had no dirty scoped
source/tests/docs and no source commits absent from the inspected main.
B's `/private/tmp/js2-3527-b-forward-20260907` has real uncommitted changes in
the engine, types and runtime test; `resumeValue()` is already present there.
Do not dispatch a second writer for those files.
During this census B committed the resume-value seam, reporting 17/17 tests.
The architect subsequently verified PR 5716's remote head through GitHub as
`3b3fc22630dfe10e07774662ec58025e5e40d89c`. Those tests were not independently
rerun by the architect; preserve the writer and inspect its current head
before integration.

Continuing held September claim families include A authoritative preparation,
runtime-callable ABI, output/finalizer/startup; B semantic/runtime producers,
prepared frame, IIFE and argument nullability; C backend-consumption/replay;
D application evidence; and the reference-error/value-adapter family. A/B/D
forward owners are recorded continuations, not implicit replacements of the
old claims. The live C implementation is now reserved to task
`01a07d40-3d39-7532-9d3d-0f0c956d8bb8`, under C coordinator
`01a035b2-ddc5-79f3-86af-c53857925523`; its worktree is
`/Users/thomas/.codex/worktrees/e042/js2`. Its current branch was verified as
`codex/3527-c-prepared-async-integration`, based on `9feb7bf8fc`. B's active recovery writer is
`01a07c8d-fecf-76e1-80c9-a811c6227419`.

Dispatch update: P is the resumed Astra Low A task
`01a07bf6-3518-7103-a705-3ef1e980d145`; B and C keep the assignments above.
N's confirmed task is `01a07d4d-64ac-75e1-90c5-345296826880`, worktree
`/Users/thomas/.codex/worktrees/642d/js2`. Parent reports it was interrupted
after automatic review rejected detailed census messages; it is not a live
writer at this record's finalization. Parent will recover its recorded work
through normal authorized read tools. Its initial receipt identified closure
dispatch, unhandled-rejection and optional Promise hooks beyond queue/settle;
the exact extraction scope still needs owner reconciliation. Preserve the
existing held semantic-runtime claim; the current B worker owns only the
engine scope. Parent owns the shared
issue-3527 append and source PR coordination. No implementation ownership or
wire-contract change is introduced by this documentation checkpoint.

## What is actually missing on main

`src/compiler/ir-program-driver.ts:runIrProgramDriver` is an internal
prepare/accept/emit transaction. It explicitly awaits public metadata and
coverage contracts. `src/compiler.ts` still dispatches to `generateModule`,
`generateMultiModule`, `generateLinearModule` and `generateLinearMultiModule`.
`compileToObjectSource` in `src/compiler/output.ts` also uses the old generator.
The internal driver being merged does not constitute public cutover.

`src/ir/program-physical-plan.ts` still refuses every async attachment, every
non-scalar carrier, reference-initialized source globals, runtime/support
callables and general layouts. Scalar functions/imports/globals and limited
startup are the implemented consumer subset. B's physical frame has no real
C caller; eight dead-export failures are the confirmed consequence.

The specific producer prerequisite is visible in `program-preparation.ts`:
ABI entries are frozen before runtime projections are prepared.
`program-runtime-abi.ts` collects instruction targets with runtime bindings;
it does not declare host adapters subsequently introduced by async projection.
`program-abi-contracts.ts` declares async source entries and their Promise
contract, but not the frame type or its three helper roles. Generic backend
legality checks source blocks and signatures, not the complete projected
async-state body/operation set. C must validate that state set explicitly.

## Decision: serialize explicit resource ownership, keep one binding authority

Use an explicit data-only per-projection async resource record. Do not recover
helper roles from display names, callback export spellings, integer indices,
or parsing encoded identity strings. Existing `origin: support` and type
`shapeKey` alone are not a complete role/layout association.

The record names the exact semantic owner, source entry binding, frame type
binding, resume/fulfill-step/reject-step bindings and roles, ordered fields,
parameter/spill value IDs, selected runtime provider/capability bindings,
conversion roles, canonical-undefined policy and callback-publication roles.
Every allocatable callable/type/global named by it must resolve to exactly
one declaration in the existing `program.abi.entries` vector. The new record
describes ownership and requirements; it is not a second allocator or ABI map.

Use canonical `irSupportFuncRef(ownerUnitId, role, displayName)` for helper
identities and `createIrBindingId`/the existing type-ref factories for frame
types. Roles are fixed enums with a version and projection discriminator, not
arbitrary user labels. Two source-qualified same-named owners get distinct
records; adding an unrelated async owner cannot renumber existing binding IDs.
Do not manufacture three source terminals or abuse `ir-async-state` provenance
for physical frame helpers. The original entry remains the source receipt.

Physical signatures must be symbolic. Add a small shared representation for
scalar carriers and `{ bindingId, nullable }` type references, with struct/
array field descriptions using those references. Never encode an allocator
`typeIdx`, `-1` placeholder, fake externref signature or native-only layout in
semantic IR to make a physical callable fit an existing type arm.

Where the existing `PreparedIrAbiContract` cannot express those physical
support types/signatures, extend it with narrowly discriminated physical
callable/type declarations. Their ProgramAbi intents remain required callable
or type slots, with canonical signature/shape keys derived from the symbolic
descriptor. They do not use `intent.kind: support`, whose slot policy is none.
Source callable/global contracts stay unchanged. C's planner must explicitly
reject unsupported new variants until their materializer is present.

### Exact P/C wire interface to implement

Put the following exported types and pure constructors in P's new
`program-async-resources.ts`; these names are the integration contract:

- `PreparedIrPhysicalValueType`: either a scalar carrier kind, or a symbolic
  reference `{ kind: "binding-ref", bindingId: IrBindingId, nullable: boolean }`.
  The scalar case cannot carry a `typeIdx`. Canonical physical signature keys
  are derived by `preparedIrPhysicalSignature` from these exact descriptors.
- `PreparedIrAsyncResourceRecord`: schema `prepared-async-resources-v1`,
  `ownerUnitId`, `entryBindingId`, `frameTypeBindingId`, and a fixed `helpers`
  object containing `resume`, `fulfillStep`, `rejectStep`. Each helper value
  carries its fixed role and binding ID. Include explicit ordered parameter/
  spill-to-field mappings and result-field role, runtime kind/provider IDs,
  capability-role-to-binding rows, conversion descriptors, undefined policy
  and callback-role-to-target-binding rows. Do not infer any of these from a
  function name. Actual frame fields/signatures reside in the ABI contracts;
  validate this record's mappings against them.
- `PreparedIrAsyncResourceRequirement`: a discriminated declared record or a
  located unavailable requirement for a projection whose physical provider
  contract is not implemented yet. Unavailable rows retain the original owner,
  canonical requirement ID and reason. The pure producer/validator must
  recompute that availability; a caller cannot downgrade a malformed declared
  record into unavailable to escape validation. Such a row is never accepted
  for emission and never removes its semantic owner from the population.

Add mandatory `asyncResources: readonly PreparedIrAsyncResourceRequirement[]`
to `PreparedIrProgramRuntimeProjection`. There is exactly one row per projected
async owner and no row for a non-async or foreign owner. A synchronous projection
uses an empty array. Freeze it with that projection. This explicit association
is the decision requested by C; decoding an ID string is not its substitute.

Extend `PreparedIrAbiContract` with `physical-callable` and `physical-type`
variants. The first host slice admits only owner-qualified support references
for the three physical helpers; its params/results use the symbolic value
descriptors. `physical-type` carries the canonical type ref and an ordered
struct descriptor with field type and mutability. Use existing required
callable/type ProgramAbi intents with canonical signature/shape keys. A helper
has exactly one `intent.unitId` owner and no alias to a source entry. Host
capability imports use the existing callable/import contract and canonical
catalogue signatures, not the physical-support variant. Native additional
descriptor forms belong to the N/P followup, not unchecked arbitrary objects.

Bump the program wire schema to `prepared-ir-program-v2` for these mandatory
records and new contract variants. Keep the codec's explicit version refusal
for v1 input; do not silently turn an old async snapshot into v2 by injecting
empty requirements. Rebuild fixtures through the actual v2 producer and retain
a v1 negative compatibility control. No migration is needed for source callers,
which regenerate the prepared program. C reviews this wire decision before P
merges, because its replay entrypoints own persisted-input behavior.

`collectPreparedIrAsyncResources` consumes the final frozen semantic population
and actual provisional runtime projections, returning per-projection records
plus the exact additional ABI declaration vector. It has no filesystem,
allocator or module argument. `validatePreparedIrAsyncResources` reconstructs
expected roles/membership from the same semantic/runtime policy facts and
compares records and ABI contracts structurally and by identity. Codec replay
invokes that validation after structural decoding and before reauthentication.
The two functions are used by real preparation/validation, not only tests.

P and C must integrate their contract changes before the combined typecheck:
C's existing exhaustive physical-contract handling needs explicit treatment
of the two new variants. C owns that consumer change; P must not reach into
`program-physical-plan.ts` to make its branch green. An early C recognition
arm may retain Unsupported until reservation is complete, but is part of the
real integration change, not a separate refusal-only deliverable.

The exception tag remains an explicit accepted physical requirement using
C's typed tag reservation; it must never be bound into the function/global/
type index spaces, which are the three spaces ProgramAbiMap currently exposes.
Its bound handle must be authenticated against the accepted tag policy and
exact reserved tag object. Broadening ProgramAbiMap to tag space is separate
scope, not a prerequisite hidden in this slice.

## Ready assignment P — producer/schema prerequisite (Astra Low)

The coordinator should assign one new or resumed producer writer under A's
ownership. This is ready now and is the first missing source slice. B and C
must not implement it independently. The coordinator is authorized to assign
it as part of taking over the migration; retain the old held claim and record
the exact continuation rather than force-releasing it.

Exclusive source scope:

- New `src/ir/program-async-resources.ts`: the serialized record types,
  symbolic physical type/signature forms, canonical role factories, demand
  collection and pure validation. No codegen, checker or allocator imports.
- `src/ir/program-preparation.ts`: collect all requested projection resources
  before the final ABI seal and emit one complete prepared program.
- `src/ir/program-abi-contracts.ts`: add the declared imports and physical
  helper/type contracts to the single authoritative vector; preserve source
  alias and source callable behavior.
- `src/ir/program.ts`, `src/ir/program-validation.ts`,
  `src/ir/program-codec.ts`: bounded schema/validation/replay additions for
  these records and physical contracts. This temporarily assigns these three
  files to P, with C review; C's implementation remains in its five-file scope.
- New `tests/issue-3527-program-async-resources.test.ts` and narrowly necessary
  updates to existing codec fixtures when the schema changes.

Do not change `nodes.ts`, `ProgramAbiMap`, the runtime provider catalogue,
`runtime-program-producers.ts`, semantic async splitting, codegen or public
driver in P without identifying a concrete additional dependency first.
The existing declaration collector is read-only in this initial slice;
collect async projection bindings in the new module instead of pretending
they were ordinary source runtime-call instructions.

### Required preparation order

1. Prepare the entire source population, semantic async transformation and
   optimization exactly as today. Freeze the final semantic graph, inventory,
   derived provenance, startup and allocations once, before authenticating
   attachments. The final graph must not be cloned after attachment issuance.
2. Prepare every requested runtime projection against that same frozen graph
   using provisional draft ABI lookup where the existing producer requires
   one. Such drafts are not accepted programs and confer no emission right.
   Collect resource declarations from the actual selected canonical capability
   records and current runtime plans, not a new parallel provider selector.
3. Build and validate the union of declarations, retaining each projection's
   exact membership. Deduplicate identical shared bindings; reject conflicting
   provider provenance or signatures. Projection-specific private frame types
   use distinct canonical IDs when their layouts differ. Do not force both
   WasmGC and linear layouts into one declaration or ignore extra declarations
   belonging to another selected projection during acceptance.
4. Seal the final authoritative ABI and resource records; freeze the already
   authenticated projections without cloning their semantic owners. Reconcile
   all references against the completed vector, then issue the PreparedIrProgram
   and its observation once. Failure before this point publishes no program.

The invariant is declaration completeness before the program/ABI seal, not
an artificial ban on examining projection requests before that seal. Do not
re-run source lowering to discover physical needs and do not run a scheduler
builder during this phase. The first P slice may fully describe host frames
and explicitly mark native materialization unavailable; it must retain the
original program and all native semantic owners rather than drop them.

### Exact host descriptor contract

Entry keeps the owner's prepared Promise ABI. Resume takes a nonnull symbolic
reference to the owner frame and returns nothing. Each step takes
`(externref, externref) -> externref`, matching the real callback ABI.
Frame fields are state i32, sent externref, mode i32, abrupt externref, error
externref; then parameters in declared order; then uniquely mapped mutable
spills; then the result carrier. Host result carrier is externref. Native
will use its declared Promise reference, not an assumed host shape.

Record all selected host create/resolve/react/wrap/fulfill/reject capabilities,
the caught-exception service, number/vector conversion helpers and canonical
undefined when needed. If a needed role lacks a canonical catalogue/service
contract, expose that exact missing prerequisite; do not relabel a test helper
or arbitrary `env` import as a certified capability. C validates exact
signatures and state operation coverage, not just presence in an array.

For callbacks, P records role and target binding only. C owns numeric IDs
after acceptance. The real host adapter resolves `exports["__cb_" + id]`.
C creates one module-local callback allocation/publication domain shared by
all accepted callback producers. Plan its complete export namespace, including
user aliases, before assigning IDs; choose unused nonnegative integer IDs in
deterministic owner/role order, reserving both names and exact target bindings.
Reject conflicting publication and counter exhaustion. Do not use function
indices, overwrite a user `__cb_0` export, or serialize process-local IDs as
authority. Authenticate each resulting ID/name/target-object receipt.

### P validation and codec controls

Use a versioned wire change if adding mandatory shape or discriminants changes
the persisted contract. C reviews the codec version and migration policy
before merging P. Reject unsupported old snapshots explicitly or use a
documented migration that preserves all ownership; never silently supply
missing async requirements or claim an old snapshot was fully declared.
No function callbacks, WeakMaps, allocator objects or final indices serialize.

Required tests: a real `prepareWholeIrProgram` two-await owner produces one
complete record and four callable identities; same-named owners from two files
stay distinct; helper IDs survive unrelated owner insertion; imported callers
retain Promise ABI; every required capability/conversion/undefined dependency
is in the ABI before seal. Verify decode/re-encode in a fresh process and
reauthentication against the final semantic graph. Remove or duplicate each
helper role, swap donor frame/type/provider IDs, change a helper signature,
mutate field/value correspondence or supply an unselected capability: reject
before consumer allocation. Keep synchronous scalar replay controls green.

P is complete when C receives an actual producer-created, codec-round-tripped
program with the required records. A synthetic record constructor test alone
does not close P. If P is reviewed before the C materializer is ready, its
consumer outcome remains a precise Unsupported; source bodies are not deleted
and no empty success is allowed.

## Continuing assignments B and C — real host integration

B's recovery writer keeps exclusive ownership of the frame engine/types and
its two tests, plus `src/codegen/prepared-async-frame-adapter.ts` as agreed with
C. Finish/test the existing dirty `resumeValue()` change, then translate
validated state values and operations using P's descriptors and C's injected
read-only bound resources. No source or runtime builder enters this adapter.
B can work in parallel with P on that agreed structural contract, but cannot
claim integrated success until C consumes it. Do not make a second B branch.

C owns `src/ir/program-physical-plan.ts`, `src/ir/program-consumer.ts`, new
`src/ir/program-async-physical.ts`, new
`src/codegen/prepared-async-resource-materializer.ts`, and
`tests/issue-3527-prepared-program-async.test.ts`. It can now implement pure
validation and reservation against the agreed P contract in parallel, then
compose after P. Do not spend the next PR merely renaming the blanket refusal.

C validates every projected state form, value type, conversion, live/restore
set and role before allocating, even if generic backend legality passed.
After consuming the token, reserve complete frame/runtime/import/type/tag/
callback closure, bind all identities, freeze indices, inject resources into
B, install exactly four validated detached outputs and reconcile their actual
objects. Only the entry earns the source-owner receipt; helpers have their
own physical-role receipts. Failure aborts the transaction without fallback.

The detailed existing execution/tamper/census plan is
`/private/tmp/js2-3527-resource-contract-spec/.tmp/3527-production-integration-spec.md`.
Its earlier wait-for-C-queue-source wording is superseded: C's code is already
on current main. Its proposed missing `resumeValue` operation is now actual
dirty B work and must be preserved. Its old statement that schema scope awaits
assignment is resolved by the exclusive P assignment above, subject to C's
review of that exact contract.

## Ready assignment N — native async physical closure (Astra Low)

In parallel with P/B/C, assign one runtime/provider writer to the dependency
closure extraction. Do not turn C's source-free consumer into a caller of
`async-scheduler.ts` or `shared.ts`. Initially own new
`src/codegen/prepared-native-async-runtime.ts`, new
`src/codegen/prepared-async-value-boundary.ts`, and focused
`tests/issue-3527-prepared-native-resource-closure.test.ts`. Proposed eventual
compatibility edits to `async-scheduler.ts`, `ir-async-runtime-adapters.ts` and
`native-promise-number-boundary.ts` need explicit ownership coordination with
the existing runtime claim family; the writer must publish its exact transitive
file list before extracting beyond the two new files.

The inspected `ensureAsyncDriveRuntime` calls `ensureMicrotaskQueue` and
`ensurePromiseSettleFunctions`; it returns Promise and reaction types,
fulfill/reject, enqueue, drain and optional mark-handled functions. Follow
those builders to their actual recursive types, queue globals, closure
bridges, error/unhandled-rejection policy, numeric boxing and canonical
undefined. Inventory is only the first step: the deliverable is a real pure
physical builder consuming typed symbolic reservations, integrated back into
its owning runtime caller and available to C. No new unconnected helper PR.

Direction is legacy provider → pure leaf, and C materializer → pure leaf;
the leaf never imports the legacy provider. Preserve existing types, ordering,
thenable/error semantics and initialization/drain ownership. C admits the
native projection only after P declares its complete resources and N can
materialize all of them before sealing. Reuse the native semantic provider
for both standalone and JS-environment native-first placement; keep the JS
value/callback boundary separate from semantic Promise implementation.

## Non-scalar and linear dependency sequence

The 288-line Claude proposal in PR 5725, issue 5385 **Merge JS-host and
standalone modes: one native semantic core, host semantics only as opt-in
accelerators**, was read completely at `888152ccaf`. It is a proposal, not
authorization here to flip defaults, delete host semantics or alter corpus
exclusions. Its separation of semantic providers from environment/value
interop is compatible with this design. Keep the bounded host integration
as a current-profile compatibility proof; run N in parallel so it does not
become an expanded host-only architecture. Do not block all existing-profile
integration on the unrelated full native-first parity census. No target
default, host-policy classification or accelerator API changes belong here.

After P provides the descriptor vocabulary, split materialization by physical
backend rather than cloning source preparation:

1. C's WasmGC planner/materializer gains declared strings, vector/data
   carriers, reference global initializers and callable/closure shapes in
   explicit families. Each family must close its helper/global/type/conversion
   dependencies before admitting any owning function. Classes additionally
   need constructor/method identity and field layout contracts; the D class
   fixture currently executes NaN, so mere compilation is insufficient.
2. A separate Low linear writer owns new `src/codegen-linear/prepared-program-
   resources.ts` and tests, initially reads C's consumer/planner without
   editing them, and integrates through one C-reviewed backend dispatch.
   It must materialize declared memory, allocator policy, data segments,
   pointer carriers, string/array helpers and startup. The existing
   `src/ir/backend/linear-emitter.ts` is an instruction emitter, not proof
   those resources are available. Do not feed WasmGC frame types to linear.
3. Native async WasmGC support does not prove linear async support. Preserve
   a located Unsupported until a linear continuation/runtime plan exists;
   assign its representation slice from the measured unsupported population.
   The full migration cannot close with those original programs omitted.

C retains the shared `program-physical-plan.ts`/consumer merge point. Backend
writers submit disjoint leaf changes and contract proposals; they do not
simultaneously rewrite that file. This phase depends on resource descriptors,
not on public API migration, so it can proceed before final cutover.

## Assignment A-public — metadata and actual public cutover

Use the existing A forward owner or record a continuation. Its disjoint first
scope is `src/compiler/ir-program-driver.ts`,
`src/compiler/ir-program-result.ts`, new
`src/compiler/ir-program-public-metadata.ts`, and focused public-result tests.
The actual integration phase owns `src/compiler.ts`, `src/compiler/output.ts`
and the relevant `src/index.ts` wrappers exclusively; do not combine those
edits with P's schema/producer files in a second overlapping writer.

Collect and freeze public metadata from the original analyzed graph: exported
names and aliases, declared signatures and Promise ABI, live global exports,
source locations/maps, adapter/linked-provider metadata, initialization order
and explicit startup identity, output/target/allocator choices and diagnostics.
Join it to emitted objects by canonical binding IDs and final typed indices.
Never infer absent metadata from an empty module property or recover identities
by display name. Preserve a user function named `__module_init` independently
of the compiler's startup adapter. Ordinary imports/reexports and mutable live
bindings must round-trip through the same transaction.

Only after complete preparation and backend acceptance may one route publish
CompileResult/WAT/object output. Rewrite the real generator dispatch at
`compiler.ts` and the object path; do not add another unused public wrapper.
For a supported original program there is one preparation and one selected
emission. For a genuine unsupported program, expose the original typed located
refusal with no partial artifact. Never catch an invariant and retry legacy.

Keep a separate small frontend owner for the observed `compileFiles` ESM
`require` failure if it remains on a fresh minimal main reproduction. Its
scope is `src/checker/index.ts:analyzeFiles` plus its focused ESM test, not a
global Node shim or a D gate exception. This is a ready diagnosis slice, but
no repair is prescribed solely from the old report's stack.

## D evidence and final frontend retirement

D's retained `public-report-merged-main.json` was parsed, not summarized from
its filename. It records head `cdd1035494df1a1cd734a13b5c8e866ecf203bd2`,
gate hash `aaf698d54e6210d7f6aa3525df9bef7e0d625d4d75fe5071e328c504e03ecc5d`,
corpus hash `c42a1ab11113481f6a43c566cdd0c5be2bea750cf3249a9743670aee81c0a39b`:
49 expected/accounted/observed entries, 39 compiled, 84 runtime calls with
63 matches, zero entries with prepared-phase observations, and 280 reported
failures. It is historical evidence, not a fresh run of `9feb7bf8fc`.

Observed failures include missing graph reexports/live values, standalone
scalar certification drift, class/closure NaN results, the compileFiles ESM
error, and missing WAT/object observation/execution adapters. The successful
two-await result does not repair the graph's missing exports. These rows
remain in the original population, including all six scalar profiles and
all public APIs. Do not replace it with an async-only proof corpus.

D remains the exclusive gate/fixture writer. Refresh against each real
integration commit, keep hashes and exact denominators, test source-terminal
and physical-helper receipt bijections, and require fresh-process decoded
replay with no forbidden frontend/legacy emitter modules. Instrumentation
failure is unknown/failure, never zero usage. Detector tests and CI-green
checkpoint commits are not production migration receipts. WAT/object need
real adapters and linked/executed results, not exemptions.

Final deletion follows measured disappearance of all public legacy callers
and all resource/provider dependencies, on both WasmGC and linear backends and
their supported environments. The source parser/type checker may remain in
the source-to-IR frontend; the requirement is that accepted-program emission
and replay do not load or call them. Remove direct AST body emitters,
fallback/demotion/overlay routes and selector recovery only after the original
population is represented and executes through the prepared path. Delete
unused compatibility code in owned slices with removal controls, not by raw
line-count targets or the separate host-semantic proposal's heuristic list.

First ready work is P, continuing B, C against the P contract, N's real closure
extraction, and A-public metadata preparation. Backend carrier implementation
and public dispatch follow those exact prerequisites. Full completion still
requires every original public population, backend/resource family, runtime
oracle, replay, receipt and deletion check; no checkpoint here closes it.
