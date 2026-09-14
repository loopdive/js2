# Next connected IR program seam: canonical ABI authority

2026-09-07. Native Astra High sidecar specification for issue 3518, IR-only
default and direct frontend retirement. Proposed implementation is a bounded
Astra Low native continuation, with parent composition and shepherding. This
document creates no assignment and releases no claim.

## Decision and measured scope

Extract the existing `ProgramAbiMap` implementation into
`src/ir/program/abi.ts`, with a structural inventory input and a pure binding-key
leaf. Keep the old import path as a compatibility boundary, including its
name-based `LegacyAbiAdapter`. This moves a working program authority used by
preparation validation and accepted emission, not a second planner or an unused
interface. It removes that authority's frontend/type-graph dependencies without
editing the held producer, codec, consumer, scheduler, or F0/N1 files.

Source SHA: `57aa0d73025526812d06a3863d63552929618288`, read in
`/private/tmp/js2-3518-ir-foundation-checkpoint-20260907`. The checkout contains
parent-owned F0 and documentation/policy edits. The two existing implementation
files proposed below are clean against this SHA; their Git content hashes are:

- `src/ir/program-abi.ts`: `c2d4da617b20e65de6cb6d3236a7bb1dd071a435`.
- `src/ir/abi-bindings.ts`: `13d96a8d4adf4868f9faa3790ca9a8b746a5b5bc`.

The root checkout remains at `e4c3e3cf040129a98efb90e07a2fe025cbcade96`
with extensive user changes. It supplied memories only for architectural
decisions; it is not the implementation baseline. No remote freshness, PR
status, or writer validation was independently verified here. D0 PR 5733,
F0 typecheck and N1/Boyle delivery status are parent-provided handoff facts.
Parent must pin the composed D0/F0/N1 revision before implementation validation.

Standalone WasmGC is the only new integration/acceptance target. Existing
host/linear contracts and code remain compatible. No new host/linear runtime,
provider, allocator, or public dispatch work is included.

## Why this seam, based on actual consumers

At the pinned source:

- `compiler/ir-program-driver.ts:runIrProgramDriver` calls
  `prepareWholeIrProgram`, `acceptPreparedIrProgram`, then
  `emitAcceptedIrProgram`. This is an internal production implementation; it
  explicitly does not yet replace public compiler dispatch.
- `ir/program-preparation.ts` validates its completed semantic program with
  `assertPreparedIrProgram`. `ir/program-validation.ts:204` reconstructs a
  `ProgramAbiMap` from the original inventory/derived units, plans every ABI
  entry, and seals it. Codec validation reaches the same validator.
- `ir/program-consumer.ts:347` uses the same class after reserving physical
  objects: plan, seal, bind reserved function/global indices, finish binding,
  then lower bodies. Extracted code therefore remains on real prepared
  validation AND emission paths with no P/C source changes.
- Public `compiler.ts:runPipeline` still calls `generateModule` or
  `generateMultiModule`. `codegen/index.ts:5140,10516` creates
  `ProgramAbiSession`; its `program-abi-session.ts:3196` constructs the same
  map. This establishes current public reachability under the existing
  inventory-enabled configuration, not public IR-only cutover.
- `ir/prepare.ts:130` reads full terminal records through `abi.inventory`.
  `codegen/multi-prepared-program.ts:1693` requires exact inventory object
  identity. A projected/copied inventory or narrowed old public type would
  break existing consumers. Preserve both, as specified below.

`ProgramAbiMap` currently imports `identity.ts` for the inventory and brands,
and `abi-bindings.ts` for one source-global provenance key. The first reaches
ts-api, source inventory and diagnostic/selector types. The second reaches
`nodes.ts`, then async/runtime contracts and further mixed modules through
type imports. Erasure of those imports does not remove architectural coupling.
Its actual algorithm reads only the structural fields listed below.

A whole consumer/lowerer move is not the next bounded step:
`program-consumer.ts` still imports `CodegenContext`, physical-import/type
registries, both emitters and `createEmptyModule`; `wasmgc-emitter.ts` imports
`lower.ts`, which selects that emitter and reaches mixed node/runtime modules.
`program.ts` also mixes data with validation, legacy candidate machinery,
`LinearOptions`, old Wasm module data and source-bearing startup types. Removing
all these edges requires coordinated P/C splits, not a namespace relocation.
This ABI seam has a small closed dependency graph and no such source writers.

## Exact write map: implementation owner, seven files

No glob ownership. A single native Low implementation owner may write only:

1. NEW `src/ir/program/abi-inventory.ts`. Define `ProgramAbiInventory` as the
   readonly structural interface below. Imports only canonical identity brands
   from F0's `shared/contracts/ir-identity.ts`. It is an input view, not another
   inventory producer, serialization format, ownership registry, or proof.
2. NEW `src/ir/program/abi.ts`. Move the existing canonical ABI types,
   `ProgramAbiInvariantError`, `ProgramAbiMap`, and their private algorithmic
   helpers from `ir/program-abi.ts`. Import the derived-ID constructor directly
   from F0's `shared/contracts/identity-values.ts`; identity brands directly
   from its contract; inventory from item 1; source-global key from item 3.
   Make the map generic as below. Keep every existing error code, lifecycle
   check and index-space rule. Exclude `LegacyAbiAdapter`, its namespace type,
   `legacyKey` and `intentLegacyNamespace`. The adapter's tiny namespace
   classification stays local to the old file; it is not authority.
3. NEW `src/ir/core/binding-key-primitives.ts`. Move exactly `requireNonEmpty`,
   `requireBindingId`, `requireSourceGlobalCapability` and `keyPart` from
   `abi-bindings.ts`, exporting them for its compatibility use. They import
   only the F0 binding brand. Add `irSourceGlobalBindingKey(bindingId,
   capability?)`, using these same checks and the exact existing source-key
   grammar. No IR nodes, DOM implementation, capability selection or AST.
   `requireString`, reference factories and type/import/runtime binding-key
   branches remain in the old module. These validation helpers remain internal
   compiler APIs; this is not a new public package surface.
4. `src/ir/program-abi.ts`. Replace the moved implementation with explicit
   imports/re-exports and the typed constructor specialization below. Retain
   the existing `LegacyAbiAdapter` algorithm here, including internal Wasm
   naming, its maps, legacy namespace/key helpers and exact errors. Keep its
   public `abi` field typed to the original full-inventory specialization.
   Do not move this adapter into the clean program folder or import it there.
5. `src/ir/abi-bindings.ts`. Import the four moved primitives. Route the
   `source` arm of `irGlobalBindingKey` through `irSourceGlobalBindingKey`;
   keep validation order, exact strings and all other arms/factories intact.
   The generic function's existing binding-ID check can remain before the
   switch; primitive revalidation on the source arm changes no accepted
   primitive value. Do not add capabilities or relax domain validation.
6. NEW `tests/issue-3518-program-abi-seam.test.ts`. Compatibility, lifecycle,
   structural-input, provenance, source-key and production integration controls.
7. NEW `tests/issue-3518-program-abi-seam-boundary.test.ts`. Fresh-process clean
   imports and static D0 fixture controls, with nonempty visited populations.

The two existing source writes are disjoint from F0's nine files, N1's ten,
Boyle's two, and the recorded held P/C/B implementation sets. They remain
subject to parent reconciliation with historical canonical-ABI claims; clean
working-tree status is not evidence of unclaimed ownership. No edits to
`identity.ts`, `nodes.ts`, `value-references.ts`, `program.ts`, preparation,
validation, codec, physical planner, consumer or writer test files are needed.

## Exact write map: parent gate/integration owner, three files

These changes follow Boyle's completed gate delivery; no simultaneous writer
touches its checkout or file. Reuse its checker, do not implement a second one.

1. `scripts/compiler-boundaries.json`: classify the three real new modules and
   both old modules accurately; activate the bounded core/program entries with
   minimum counts 1 and 2 respectively, recording the activation rationale and
   still-unmigrated nodes/prepared-schema debt. Preserve D0/F0/N1 provenance,
   thirteen overrides, all previously activated roots, and held evidence.
   The planned `core/nodes.ts` and `program/index.ts` destinations remain
   explicit future obligations; do not silently present this subset as their
   completed extraction. Full-separation mode must still fail.
2. `scripts/audit-legacy-reachability.mjs`: extend the accepted moved-symbol
   coverage to this extraction, using the already-delivered rooted mechanism.
   Preserve N1/Boyle controls. Explicitly handle constructor/class-method
   reachability through the old constructor specialization if that syntax is
   not already resolved; unresolved resolution is a failure, not liveness.
3. NEW `tests/issue-3518-program-abi-seam-reachability.test.ts`: same production
   auditor, old/new qualified mappings, real consumer and removal controls.

All other shared scripts, package/CI files and claim records stay outside the
map. Parent copies this draft into the next ready loopdive/js2 PR. Gate edits
and implementation must compose before accepted publication. Required CI and
normal hooks remain parent-owned; inherit fast/priority config unchanged.

## Canonical interface split

The inventory view contains exactly the fields consumed by the map:

```ts
interface ProgramAbiInventory {
  readonly sources: readonly { readonly id: IrSourceId; readonly order: number }[];
  readonly allUnits: readonly {
    readonly id: IrUnitId;
    readonly sourceId: IrSourceId;
    readonly terminalOwnerId: IrUnitId | null;
  }[];
  readonly classes: readonly { readonly id: IrClassId; readonly sourceId: IrSourceId }[];
  readonly terminalUnits: readonly { readonly id: IrUnitId }[];
}

// New canonical implementation; same runtime constructor and state machine.
class ProgramAbiMap<TInventory extends ProgramAbiInventory = ProgramAbiInventory> {
  constructor(readonly inventory: TInventory,
              derivedUnits: readonly ProgramAbiDerivedUnitRecord[] = []) { /* moved */ }
}

// Old mixed compatibility module, never imported by the new implementation.
import { ProgramAbiMap as CanonicalProgramAbiMap } from "./program/abi.js";
import type { IrUnitInventory } from "./identity.js";
export type ProgramAbiMap = CanonicalProgramAbiMap<IrUnitInventory>;
export const ProgramAbiMap = CanonicalProgramAbiMap<IrUnitInventory>;
```

Use TypeScript's constructor instantiation expression, not a subclass, wrapper,
cast to `any`, second error class, or copied registry. The new constructor
accepts rich inventories structurally and retains the identical object.
Its internal source/class maps use the minimal field types. Generic inference
preserves rich fields for callers that import the canonical constructor with
a rich input. Existing annotated callers keep the old specialization.

The inventory is still supplied by the existing producer. Neither its presence
nor the narrowed interface proves complete source population: that belongs to
the unchanged program-population/validation path. Do not delete terminal
diagnostics, filter support records, invent inventory IDs, or serialize this
view instead of the complete program inventory.

`ProgramAbiPlanEntry`, intents/signatures, derived records and
`ProgramAbiInvariantError` each have one canonical definition in the new file.
Old imports re-export exactly those values/types. Keep all invariant-code
members, including ones consumed by legacy session code. Do not rename codes
or alter instanceof behavior. `LegacyAbiAdapter` stays outside this graph.

The source-global key remains `source|<length>:<bindingId>` without capability,
and appends `|capability|3:dom` when present. Length is JavaScript string length;
do not substitute UTF-8 byte counts or parse IDs to recover ownership. The
existing global-domain prefix checks and optional-capability errors remain.
The full `IrGlobalBinding` union stays canonical in `value-references.ts`;
the new helper takes its two primitive source fields, not a duplicated union.

## Forbidden edges and authority limits

Transitive runtime AND type-only closure of the three new modules may contain
only each other and F0 shared contracts/identity values. No external runtime
packages are needed. Deny frontend, checker, ts-api/TypeScript, compiler,
codegen/context, codegen-linear, legacy adapters, old `identity.ts`, old
`abi-bindings.ts`, old `program-abi.ts`, `program.ts`, nodes, outcomes, selector,
physical allocators and runtime-provider implementations. Include type queries,
barrels, aliases, symlinks, dynamic imports and unresolved/nonliteral edges in
the check; runtime loader evidence alone cannot certify erased imports.

Allowed direction is old callers/adapters -> new canonical implementation.
No callback injected by a frontend/context may substitute for the removed
imports. The implementation receives structural records only.

The ABI map validates planned identity and already-assigned final indices. It
does not reserve Wasm objects, authenticate module-owned receipts, allocate
exception tags, prove installed body contents, issue backend acceptance tokens,
or become an additional physical allocator. Its historical three index spaces
remain function/global/type; tags remain C's separate typed requirement.

## Semantics and provenance invariants

Preserve insertion-independent structural ordering; immutable planned entry
copies and signature arrays; unique binding/order/export identity; exact alias
targets and contracts; capability/provider pairs; source/class membership;
derived ID reconstruction from parent/role/ordinal; source and terminal-owner
agreement; cycle detection; seal-before-bind; no alias/slotless allocation;
per-space collision rejection; complete required-binding coverage; final-index
immutability after completion; and the existing idempotent seal behavior.

Retain the original inventory object and record references just as today;
do not introduce a new freeze/snapshot policy while extracting. Private maps,
sealed/complete flags, order maps, derived registration, and all mutation sites
move together. Legacy name ambiguity/naming behavior remains unchanged.

Source and binding IDs, source locations, original terminal denominator,
derived provenance, semantic/runtime owner joins, projection policy, ABI
entry order and wire bytes do not change. No schema bump belongs to this move.
The pinned source is v1; P's preserved v2 physical-callable/type and mandatory
async-resource design remains authoritative for its later integration. Do not
adopt v2 partially, downgrade its records, clone authenticated runtime owners,
or modify P/C drafts to accommodate this extraction.

## Focused acceptance for the implementation, not tests run by this sidecar

Parent schedules the ordinary serial validation slot. No full local Test262
campaign or new host/linear acceptance work is prescribed.

1. Typecheck and explicit compatibility assertions: old/new map constructor
   identity, same error constructor/instanceof, original inventory identity,
   rich `terminalUnits.kind` type through old imports, and structural-only
   input through new imports. Exercise `PreparedIrCandidateProgramBuilder`
   and existing multi-program inventory-identity control; no cast hides a
   lost terminal field. Use distinct source/class/unit/binding brand controls.
2. Keep relevant existing `issue-3520-program-abi.test.ts`,
   `issue-3520-program-abi-unitless-class-order.test.ts`,
   `issue-3520-global-type-binding.test.ts` and
   `issue-3520-callable-provider-abi.test.ts` controls intact. New focused cases
   cover same-name owners, unrelated-owner insertion, aliases, derived owners,
   seal/bind/finish lifecycle, signature and provider tampering, wrong global
   domain/capability and exact key strings. Missing required bindings and
   wrong index space must fail with unchanged codes. No new capability support.
3. Real standalone WasmGC program via `analyzeMultiSource` ->
   `prepareWholeIrProgram` -> existing codec -> existing acceptance/emission:
   scalar exported functions, an alias, mutable numeric global/startup and
   explicit returned values. Use the currently supported producer fixtures
   as the baseline; a pre-existing unsupported graph is retained as refusal
   evidence, not admitted by weakening this seam. Include at least one
   nonempty successfully emitted real source program, so refusals cannot
   satisfy acceptance. Record preparation/body counts, exports and execution.
   Compare base/candidate exact encoded program bytes, ABI entries, emitted
   module bytes and values for identical inputs/config. Record both SHAs;
   permanent CI assertions must not need historical Git objects.
4. Instrument the canonical map methods in a separate test process (restore
   instrumentation on exit) to prove the real validator calls plan/seal and
   accepted emitter calls bind/finish. Assert old/new constructor identity
   separately. Test-only calls are not public reachability evidence.
5. Fresh process importing only new ABI/core modules must pass a resolved-path
   loader barrier denying the forbidden closure. Build a nonempty data-only
   ABI fixture there and exercise its lifecycle. Inject a known forbidden
   runtime import and require failure. D0 must independently reject an injected
   type-only import to `identity.ts` and a barrel through the old ABI module.
   This proves only the extracted authority is frontend-free; the existing
   whole-program codec/consumer closure is still incomplete architectural debt.
6. Rooted production evidence: public compile -> generator ->
   ProgramAbiSession -> canonical map is distinguished from internal prepared
   driver -> validation/emission -> canonical map. Only public APIs are public
   roots; do not silently promote the internal driver or new exports to roots.
   Preserve full-production and legacy-dispatch-cut reports separately. Removing
   the real call fails; old re-export, constructor alias, renamed implementation
   and test import alone cannot certify liveness. A missing constructor/method
   edge is unknown/failure. Map all moved map methods/error constructor and the
   four key primitives by old/new qualified names; helpers and the source-key
   builder need actual caller paths. Do not reduce existing symbol denominators.

Full program replay purity, donor acceptance/token/body controls and the held
B ten-function evidence remain outstanding in their original gates. This seam
must not report those obligations settled by its smaller fresh-process test.

## Decisions already settled; remaining dispatch dependencies

No speculative user choice is needed: retain one canonical ABI, generic rich
inventory compatibility, three index spaces, P/C wire design, standalone-only
new implementation and exact original corpus. Parent needs only operational
ownership reconciliation and a pinned composed base. If the constructor
specialization exposes a type incompatibility, the implementer returns the
exact consuming type/site; never widen into P/C edits or replace inventory
with a projection. If rooted analysis cannot resolve the specialization, parent
finishes that narrow resolution/control in its mapped auditor before accepting
the move. Neither condition authorizes a new architecture session.

The next larger architectural join remains source preparation -> pure complete
program preparation, followed by C's standalone reservation/emission boundary.
Its required split is already established: AST/checker source input outside
`ir/program`; pure semantic graph/inventory/ABI/runtime requirements inside;
module-owned physical reservations and acceptance authority inside
`backend/wasmgc/program`. Existing P schema/preparation/codec and C
planner/consumer owners retain those non-overlapping implementation slices.
This proposal does not reopen their host materializer or assign their files.

## What this advances, and what it does not

This is the first bounded extraction of the working whole-program ABI state
machine into the designated IR program directory. The same production
validators and emitter still execute it through downward compatibility imports;
it can also be constructed from typed records without loading source/context
modules. That removes a concrete dependency blocking the later complete pure
program and standalone backend joins. The binding-key primitive is included
because its real provenance check is reachable, not to inflate folder counts.

No direct body is hidden, deleted, demoted or credited as migrated. Public
dispatch remains legacy; an internal prepared route is not a public cutover;
physical/backend and remaining IR-core separation stay open. All eleven issue
3518 criteria remain: original population and one preparation, shared semantic
snapshot/ABI, lossless versioned replay, typed located failures, policy-switch
retirement, direct-handler unreachability/deletion, optimization preservation,
complete conformance accounting and final merged gates. Host/linear rows remain
preserved and deferred, never removed to reduce those denominators. P/C/B/D
evidence and drafts remain available for subsequent standalone adaptation.

## Inspected sources and operating context

Root read-only context: `.claude/memory/MEMORY.md`, `project_team_setup.md`,
`feedback_native_multi_agent_worktrees.md`,
`feedback_reground_spec_against_current_main.md`,
`reference_shared_structure_readers_and_mutators.md`, and
`plan/method/team-setup.md`. Current user instructions supersede older model,
team, publication and test-routing preferences in those memories.

Checkpoint plans read: `ir-standalone-wasmgc-layering-plan-2026-09-07.md`,
`3518-first-boundary-dispatch-2026-09-07.md`,
`3518-native-wasm-foundation-next-dispatch-2026-09-07.md`,
`ir-migration-recovery-2026-09-07.md`; issue 3518 rules and all eleven acceptance
criteria. Selective source reads/import inspection:

- `src/ir/{program-abi,abi-bindings,identity,identity-values,value-references,
  capability-provenance,nodes,async-plan,outcomes,alloc-registry,intrinsics,
  string-runtime,fnctor-abi,module-init-plan,program,program-source,
  program-preparation,program-validation,program-consumer,program-physical-plan,
  program-codec,program-middleend,prepared-component-dependencies,prepare,
  callable-bindings,lower}.ts`.
- `src/ir/backend/wasmgc-emitter.ts`, `src/compiler/ir-program-driver.ts`,
  `src/compiler.ts`, `src/index.ts`, `src/codegen/index.ts`,
  `src/codegen/program-abi-session.ts`, `src/codegen/multi-prepared-program.ts`.
- `tests/issue-3520-program-abi.test.ts`,
  `tests/issue-3518-program-codec-replay.test.ts`; focused test filename census;
  parent-dirty `scripts/compiler-boundaries.json` activation structure.

Only this new draft was written. No source writes, tests, commits, pushes,
claim mutations, new agents, sessions or global configuration changes occurred.

## Coordinator dispatch update — 2026-09-08

The coordinator read and accepted this implementation design and resumed
Maxwell's existing native Astra Low context, not a separate app task. Its new
isolated checkout is `/private/tmp/js2-3518-program-abi-seam-20260908`, branch
`codex/3518-program-abi-seam-20260908`, pinned initially to
`d71fab8b9565ad3a2bb567ed82f22e8750e804a4`. Both original source hashes above
were independently reconfirmed. That base contains F0; N1 changes none of the
seven implementation files. Parent must still compose N1 before final acceptance.

The worker reconciles the authoritative claims before writing and retains its
original N1 draft. It owns only the seven listed implementation/test files;
parent owns shared gate/policy changes, documentation, serial verification and
publication. The [user-approved preservation/closure distinction](./3518-open-import-preservation-contract-2026-09-08.md)
also applies to subsequent extraction evidence; it does not change the ABI
semantics, source population or full retirement requirements. Dispatch is not
an implementation or validation completion claim.
