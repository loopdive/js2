# First bounded dispatch: boundary inventory, then identity foundations

This dispatch specification implements the first prerequisite of
`ir-standalone-wasmgc-layering-plan-2026-09-07.md` for issue #3518,
**IR-only default and direct front-end retirement**. It authorizes no source
changes by itself. The coordinator dispatches after claim reconciliation.
Host/linear implementation stays deferred; P/C dirty work stays in place.

Dispatch update: the coordinator approved D0 and assigned the existing worker
task `01a07c8d-fecf-76e1-80c9-a811c6227419` as Astra Low in a new isolated
worktree at the pinned base, with the three-file scope and a distinct slice
claim. The coordinator subsequently approved parallel F0 implementation and
assigned P its exact nine-file extraction in a new isolated checkout at the
same pinned base, under a new F0-only slice. The historical related claims
were explicitly reconciled and retained, as recorded below. Publication still
requires composition onto accepted D0 and validation. This records the
coordinator's dispatch, not a new assignment or claim mutation by the architect.

## Common base and excluded work

Use pinned source base `6037ac8bcf07be4f71839cea33cf8c90ecc87f94` for D's
three-file checker implementation. This is the existing P/combined-validation
base, not a claim that it is latest main. The coordinator may later integrate
that commit forward onto verified main, with a new inventory/check report.
Do not silently use the ambient checkout or a moving branch name as evidence.

Verified locally: queue commit `f735ed9720c0b1dd22d717655ebd441f53613899`
has exactly `6037ac8bcf` as its parent. The shared upstream/main ref inspected
at `07c19331dc6df77cd9669d23d8f7a4aa27d002df` has merge-base `6037ac8bcf`
with it; that earlier read did not prove N landed. The coordinator subsequently
verified PR 5727 merged at `396e690a85a9103d3f3d125b0f478c4cc99bf0c8`
on 2026-09-07 at 20:16:12Z. Its earlier host Test262 diagnostic for
BigIntTypedArray `ctorlengthreturns-object.js` (expected 4, got 0) remains
historical red evidence, not a current merge blocker. Neither the merge nor
this update proves the original failure's cause. D0/F0 keep their pinned base;
later native extraction must be re-grounded on verified main. No host backend
repair is prescribed here.

Also exclude B's held `0b513df...`, P/C dirty snapshots and the composed CPB
tree from D's source baseline. Keep those checkpoints and hashes available,
not discarded or copied wholesale into the gate branch. D's new test fixtures
must not pretend the held implementations have landed.

F0 implementation may proceed concurrently with D0 from the same pinned source
base. After D0, the coordinator records its accepted commit as the common
boundary baseline and composes F0 onto it before publication. P's existing
dirty branch is preserved; integrate approved generic P work and the boundary
baseline by reviewed forward changes, never by resetting the dirty checkout.

## Dispatch D0: exactly three files, no source moves

Resume the existing D owner or record its continuation; do not create another
overlapping gate writer. D owns only:

1. New `scripts/check-compiler-boundaries.mjs`.
2. New `scripts/compiler-boundaries.json`.
3. New `tests/issue-3518-compiler-boundaries.test.ts`.

The coordinator owns package.json/CI wiring and existing reachability-gate
changes. D may read those tools but does not modify them. D0 does not move
implementation files, change baselines to forgive violations, or declare the
new architecture present before any destination folder contains real code.

### Configuration and classification contract

Use a versioned configuration with source root, module extensions, layer
definitions, exact source-file classifications, allowed layer edges, external
package policy, activation requirements, and old/new path/symbol mappings.
Do not embed absolute developer checkout paths in the committed policy.

Enumerate all implementation/type modules under src (including declaration
files and supported JS/TS variants), not merely future destination folders.
Every discovered file needs exactly one classification; duplicate, unknown,
unreadable or deleted-but-still-classified files fail inventory validation.
Scan tracked and present untracked source modules, and report both counts so
P/C integration cannot silently omit newly created files. Exclude generated
outputs/assets only by explicit nonmodule policy, with counts and rationale.

The classification has two distinct axes:

- Current state: `unmigrated`, `clean`, or `compatibility-adapter`.
- Concern/destination: foundation, Wasm model/physical/emit, TS frontend,
  IR core/analysis/pass/runtime/program, WasmGC backend, generated native
  runtime, standalone platform, compiler, legacy host, legacy linear, or
  `mixed-needs-split` with an owner and recorded next boundary.

An original mixed module is not classified as clean merely because its name
contains IR/runtime. If its concern has not been resolved, say mixed-needs-split;
this is explicit remaining debt, not successful architectural classification.
No catch-all `src/** is allowed legacy` rule may hide new files or new edges.
Exact per-file inventory and reported debt are required even while it is large.

Future layers are `planned` until a dispatch activates them. A planned empty
directory counts as absent/pending, never as a passing clean layer. Activation
requires named real entry modules and an explicit minimum nonzero module
population; clean activation cannot be undone just to conceal a violation.
The first foundation split below activates three concrete modules. Until then,
the repository's architecture is incomplete even if its inventory is valid.

Support two explicit operating modes:

- Default complete-separation check: fail when any required layer is absent,
  any source module is unclassified/mixed/unmigrated, or a forbidden/unknown
  edge exists. It must not return green on the initial unmigrated repository.
- `--mode inventory`: validate complete source coverage, resolution and policy,
  enforce every activated clean boundary, and enumerate existing unmigrated
  violations/debt. It may exit successfully for a valid bootstrap inventory,
  but output `architectureComplete: false` and a distinct inventory-valid
  status. The coordinator may wire this explicitly during staged migration;
  its result must never be labeled full separation or retirement acceptance.

Print mode, source revision, dirty-content fingerprint, policy hash, module
counts by state/layer, resolved edge counts by syntax/type, unresolved edges,
planned-empty layers, activated roots, forbidden edges and architectureComplete.
Missing config or missing src is an error, not an empty scan or seed operation.
No automatic `--update` makes a failing edge permitted.

### Real resolver and syntax coverage

Parse files using the repository's installed TypeScript parser and resolve
module specifiers using the actual tsconfig/compiler resolution options. Handle
relative `.js` imports resolving to `.ts`, extensionless/directory resolution
when supported, tsconfig aliases, package exports and real paths. Traverse
static imports, import/export type, export-from/export-star, side-effect
imports, literal dynamic import, require and import-equals. Follow barrels
and report both the direct edge and a concrete forbidden transitive path.

Classify built-in/external packages explicitly by layer. TS parser/checker
packages and ts-api wrappers are frontend-only for production code. The checker
tool itself may use the parser; its analysis dependencies are not application
dependencies. A failed external or local resolution must remain visible.

Nonliteral dynamic loading is not proof of no dependency. In clean layers,
report it as an unsupported/unknown edge and fail. In unmigrated modules,
inventory may enumerate it as outstanding debt, but must not claim the graph
is complete; default complete-separation fails. Detect declarations/type-import
expressions as well as runtime syntax. Do not grant a clean-zone exemption
just because TypeScript erases an import at runtime.

### Positive and negative controls

Tests create small actual fixture trees/configs, invoke the same checker and
inspect JSON plus exit status. Required controls:

- A nonempty valid layered fixture, proving files/edges/roots were visited.
- Direct forbidden edge, type-only import, import type expression, alias,
  relative path escape, export-star barrel and literal dynamic back edge.
- require/import-equals where configured; nonliteral import/require producing
  unknown/failure, not zero discovered dependencies.
- Missing module, missing config/src, unclassified extra source file,
  duplicate/stale classification, unreadable input and symlink to forbidden
  code. The test must distinguish a controlled unreadable error from a platform
  that cannot reproduce it, rather than silently count a skipped probe as pass.
- Empty future zones: inventory explicitly incomplete; default check fails.
  Activated root removed/renamed out of scan: failure, not a lower denominator.
- A type-only frontend edge from a clean foundation must fail even when a
  runtime import test would load nothing. A barrel cannot launder that edge.
- Gate evidence/path move controls described below, showing renamed held
  symbols remain unresolved until production integration is demonstrated.

D runs only its focused checker tests and an inventory report on the pinned
real source tree, with raw report preserved. It records exact counts rather
than promising all source edges resolved from a summary. The coordinator
schedules broader checks and CI integration. D0's successful delivery is a
working detector and honest inventory, not a separated compiler.

## Dispatch F0: parallel extraction, publication after accepted D0

P is the assigned owner because its pending work consumes these identity
contracts. The coordinator reports that ownership reconciliation is complete
and P received the F0-only assignment in a new isolated checkout at the pinned
base. Do not relocate any of P's twelve dirty files or C's five files. No changes
to their pending program-source/schema/consumer are needed to land this
foundation: existing old import paths remain compatible.

Exactly nine implementation/test files are authorized by that dispatch:

1. New `src/shared/contracts/source-origin.ts`: move
   CompilerSourceProducer, CompilerSourceOrigin and CompilerSourceOriginSpan
   definitions out of position-map. No runtime mapping class or AST type.
2. New `src/shared/contracts/ir-identity.ts`: move the four unique-symbol
   brands and IrSourceId/IrUnitId/IrClassId/IrBindingId, IrLexicalOwnerId,
   IrFunctionIdentity, IrSyntheticUnitRole, CreateDerivedIrUnitIdInput and
   CreateIrBindingIdInput out of identity.ts. It imports only source-origin.
   Preserve each brand's single declaration; duplicate brand definitions are
   not interchangeable and are forbidden.
3. New `src/shared/contracts/identity-values.ts`: move the actual four pure
   implementations from ir/identity-values.ts (identity component encoding,
   canonical number, derived unit ID and binding ID constructors). Import
   their argument/result types from the new pure identity contract.
4. `src/position-map.ts`: import/re-export those exact source-origin types;
   retain SourceEdit and PositionMap implementation in place.
5. `src/ir/identity.ts`: import/re-export the extracted shared types, retaining
   AST inventory, source/class helpers and unextracted records in place.
6. `src/ir/identity-values.ts`: become a one-way compatibility re-export of
   the moved pure implementations. No new implementation or reverse import.
7. `src/ir/nodes.ts`: redirect its existing identity-type import for the moved
   brands/IrFunctionIdentity to shared/contracts/ir-identity.
8. `src/ir/value-references.ts`: redirect its existing IrBindingId/IrUnitId
   type import to the same pure module.
9. New `tests/issue-3518-identity-foundation-boundary.test.ts`: exact serialized
   identity outputs, old/new export compatibility and real consumer coverage.

This is extraction, not `git mv` of all identity.ts. IrUnitInventory and
terminal/source records stay where they are for now: terminal records reference
IrPreparationFailure, whose current outcomes module imports selector/module
binding types. Moving that whole record graph into shared would reintroduce
frontend dependencies. Split that diagnostics/inventory closure in a later
explicit map. Likewise do not move all WasmModule/types or allocator registries
in this first change. Those are C's later physical-boundary prerequisites.

D/coordinator updates only the D0 manifest to map these nine paths, activate
the three shared modules and require their complete clean closure. This is
a coordinated configuration edit, not additional source ownership for P.
All existing imports through compatibility paths must resolve to the same
brand and the same factory implementation. New foundation files must not
import old identity.ts, position-map implementation, nodes or outcomes.

F0 tests must exercise actual existing identity construction/prepared-ABI
consumers through the compatibility path and compare exact strings/serialized
IDs with the prior base. Include negative ordinal and cross-brand type
controls, real nonempty foundation closure, and a forbidden type-only import
back to identity.ts that the boundary checker rejects. Run affected tests and
typecheck in the coordinator's scheduled slot. Do not claim P/C is fully
source-free from this small extraction; their other edges remain listed debt.

### Coordinator-confirmed sequencing and claim reconciliation

On 2026-09-07, the coordinator confirmed approval of the architect's parallel
implementation decision and explicit reconciliation of these historical
same-owner scopes, both assigned to
`ttraenkler/astra-ir-program-a-20260905`:

- `3518/ir-source-positions`, branch `codex/44-ir-source-positions-20260906`:
  F0 owns only the specified source-origin type extraction and compatibility
  imports in position-map; its runtime mapping behavior stays intact.
- `3518/authoritative-preparation`, branch
  `codex/3518-whole-program-a-20260905`: F0's identity foundation extraction
  is separate from the paused producer/ABI edits; existing import paths,
  unique brands and serialized IDs stay compatible.

Both historical claims remain held; reconciliation does not force-release,
overwrite or transfer them. The coordinator verified that F0's five existing
files were clean in the shared root, P and C checkouts, then assigned the new
F0-only slice to P. This is coordinator-reported dispatch evidence; this
document does not claim a fresh ledger read or invent a new slice identifier.
The earlier upstream-only ledger snapshot at
`a3030e440c771ce34d494af09f2c6184e4c0af7c` predates this assignment.

Only implementation overlaps D0. F0 leaves D0's three files untouched and
preserves every P/C draft in its existing checkout. Before publication, compose
F0 onto accepted D0, have D0/coordinator activate the three real foundation
modules in the policy, and pass boundary checks, affected tests and typecheck
in the coordinator's scheduled validation slot. The documentation update runs
no commit hooks while D0 holds that slot. These sequencing changes authorize
no host or linear backend implementation.

## Published-state and independent cloud-evidence handoff

PR 5730 published the initial map at
`d2a695a0fdf37676e874dcda0f214c0acfc7990e` and merged as
`9b0358ec7d373034de6ff524eae286a50aaf2a4e` on 2026-09-07 at 20:48:24Z.
The approved parallel-sequencing and cloud-evidence refinements below follow
that published head in the implementation checkpoint. The coordinator retained
the original drafts and composed D0 on verified upstream main
`95186a4835a1fe7a024172a61be94781c7995670`. Accepted detector commit
`57aa0d73025526812d06a3863d63552929618288` includes the independently resolved
comparison base and inherited-Git-state controls. Its 42/42 detector tests and
typecheck passed in the composed checkout with normal commit hooks; these
results establish the detector checkpoint, not IR-only compiler completion.

The independent cloud audit reports successful repository access and an
unchanged audit checkout at main
`f6e9075d5d12f3d4e3a4f674211190de87af06e6`. It separately inspected the plan
at `61b738d342b75195f658c0ecc4089b76574e0b79`, an earlier PR 5730 head;
its findings are evidence at those revisions, not a review of the later exact
F0 dispatch map or unpublished P/C contents. The architect records the
coordinator's relay here, without claiming an independent local reproduction.

The audit supports keeping the extraction narrow: identity.ts mixes brands
with ts-api/AST helpers, identity-values.ts has a type-only dependency on that
mixed module, and source-origin records share position-map with runtime code.
IrTerminalUnitRecord reaches frontend selector/checker types through
IrPreparationFailure/outcomes; PreparedIrProgram still reaches LinearOptions,
ts-api-dependent module initialization, WasmModule and colocated runtime
validation/transaction behavior. Those inventories and program contracts
remain later splits. The reported 90-line/16-file layering ratchet passes
while excluding six linear edges; it remains debt telemetry, not proof of
complete separation.

The cloud's alternative move/import/test suggestions do not amend F0's nine
files: SourceEdit stays in position-map, identity-values keeps its separately
specified new module, and source-location/program extraction and broader
import/test rewrites are deferred. D0 retains checker/policy ownership.
Cloud-reported main also differs from the inspected plan tree in
`src/codegen/async-scheduler.ts`, adds
`src/codegen/prepared-native-async-runtime.ts`, and changes
`src/runtime/cross-module-struct-owners.ts`. Re-ground the next native map on
actual latest main before dispatch; do not infer that those changes caused or
fixed the historical Test262 failure. No new writer assignment is made here,
and source implementation remains standalone WasmGC only.

## Evidence cannot disappear at the next moves

The coordinator's B CI evidence is ten unresolved functions at held commit
`0b513df989e713eb2eb2b340824e3bd9694291c9`, not eight: engine get/set/constant,
physicalIndex/resources/sameType/preflightPreparedFrame/emitPreparedFrame,
plus adapter sameType/emitPreparedIrAsyncFrame. Preserve symbol identity by
qualified original path, since sameType appears twice.

`audit-legacy-reachability.mjs` currently treats functions outside src/codegen
as survivor roots and filters its dead-function report to codegen paths.
Merely extending one glob when B moves would still be unsound: destination
functions could become automatically live survivor roots. Before B/runtime
moves, coordinator owns a separate exact change to that auditor and CI that
uses actual production entry roots and scans both old/new destination layers.
Tests must prove moved unreferenced functions stay unreferenced. D0 records
the move/evidence manifest but does not silently take over that fourth file.

Held-checkpoint evidence is explicitly external to D0's source base; do not
require its absent files as if they had landed or erase it because they are
absent. At integration/move time, bind the preserved symbol list to the actual
incoming files, maintain its full denominator and require real production
consumer execution to resolve it. No baseline forgiveness, dummy caller or
test-only import settles the finding.

## Dispatch boundary

D0 has been dispatched with the three-file scope and pinned base as recorded
above. F0 has been assigned for parallel implementation after ownership
reconciliation; its publication follows composition onto accepted D0 and the
required validation. P/C host implementation, whole backend relocation, N's next
source implementation and all linear work remain paused until their explicit
subsequent move/implementation maps. No source change has been made here.
