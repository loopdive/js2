---
id: 3525
title: "IR-only R5: whole-program single- and multi-source Prepared ownership"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-10-05
assignee: ttraenkler/codex
branch: codex/3525-m1a3-same-spelling-callables
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, compiler, modules
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r5
model: gpt-5.6-sol
parent: 3518
depends_on: [3520, 3521, 3522, 3523, 4260]
required_by: [3527, 3528]
related: [1277, 1983, 2138, 2771, 2930, 2931, 3142, 3214, 3493, 3495, 3505, 3518, 4589, 4590, 4591]
origin: "#3518 R5 — replace per-source M0 overlays with one whole-program preparation owner"
files:
  - src/index.ts
  - src/checker/index.ts
  - src/ir/program.ts
  - src/ir/prepare.ts
  - src/ir/program-abi.ts
  - src/ir/module-bindings.ts
  - src/ir/imported-functions.ts
  - src/ir/module-init.ts
  - src/ir/module-init-plan.ts
  - src/ir/integration.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/ir-program-callable-context.ts
  - src/codegen/legacy-body-audit.ts
  - src/codegen/multi-prepared-body-skips.ts
  - src/codegen/multi-prepared-callable-orchestration.ts
  - src/codegen/multi-prepared-module-init.ts
  - src/codegen/multi-prepared-program.ts
  - src/codegen/program-abi-module-init-planning.ts
  - src/compiler.ts
  - src/compiler/ir-program-presentation.ts
  - tests/issue-3525-recursive-source-map-offsets.test.ts
  - tests/issue-3525-prepared-wit-presentation.test.ts
  - src/wit-generator.ts
  - tests/issue-3525-prepared-pipeline-presentation.test.ts
  - tests/issue-3525-prepared-mixed-presentation.test.ts
  - tests/issue-3525-multi-prepared-module-init.test.ts
  - tests/issue-3525-ir-whole-program-multi-source.test.ts
  - src/ir/program-consumer.ts
  - tests/issue-3525-emitted-physical-plan-observation.test.ts
  - tests/issue-3518-program-codec-replay.test.ts
loc-budget-allow:
  # Recursive recorder plus actual root-cycle guard: 2245 -> 2246 LOC (+1).
  # Exact 1fd01721 source; no function/total/baseline grant.
  - src/emit/binary.ts
  # Prepared WIT joins and requested-only authentication: 1443 -> 1552 LOC (+109).
  # Astra independently reviewed exact 62074d12; no function/total/baseline grant.
  - src/compiler/ir-program-presentation.ts
  # Internal prepared-presentation checkpoint only: 1976 -> 2097 LOC (+121),
  # compiler 0244548a; private finalizer/context/entry and explicit artifact projection.
  # All source/ABI/resource joins remain in the new leaf; no total/baseline grant.
  - src/compiler.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/multi-prepared-program.ts
  - src/ir/integration.ts
  - src/ir/prepared-component-dependencies.ts
  # Authenticated emitted-plan observation only: 1489 -> 1501 LOC (+12).
  # Exact retained frozen plan, unchanged completion guard; materialize 299 <= 300.
  # No function, total, or shared-baseline allowance.
  - src/ir/program-consumer.ts
  # Finite Boolean boundary only: runtime 20194 -> 20227 LOC (+33).
  # Explicit Boolean metadata, ToBoolean arguments/omissions, strict 0/1 decode,
  # and own export metadata lookup; no public compiler dispatch or baseline change.
  - src/runtime.ts
func-budget-allow:
  - src/codegen/declarations.ts::compileDeclarations
  - src/codegen/index.ts::generateMultiModule
  - src/ir/integration.ts::compileIrPathFunctions
  - src/codegen/multi-prepared-module-init-batch.ts::planMultiPreparedModuleInitBatch
---

# #3525 — IR-only R5: whole-program single- and multi-source Prepared ownership

## Execution amendment — 2026-09-05

After the current initializer repair is integrated, follow package A of the
approved [whole-program cutover plan](3518-ir-only-default-and-direct-frontend-retirement.md#current-execution-plan--whole-program-cutover-2026-09-05).
R2/R5 have one shared integration owner. Reuse the ordered initializer census,
atomic preparation, source-qualified bindings, and existing class/storage
interfaces to prepare the complete mixed callable/initializer graph before
emission. Resolve the actual P2B prerequisites; do not remove its refusals before
the corresponding contracts are proved or add another fixture-specific overlay.
The existing seven-unit mixed application is the first checkpoint, with an
independent mixed application checking generality. P2A publication alone does
not satisfy it. Existing claims and the complete R5 acceptance remain binding.

## Objective

Make single-source and `compileMultiSource` use the same whole-program
preparation owner. Exactly one `ProgramAbiMap`, `PreparedIrProgram`, unit
ledger, module-binding graph, and ordered module-init plan are built across all
input sources before either direct or IR body emission begins.

R5 removes the M0 model in which every source is planned independently after
all direct bodies already exist. Cross-file imports, exports, re-exports,
default/namespace imports, global-script declarations, same-name declarations,
classes, closures, and module initialization must resolve by R1 structural
identity. Fast and ordinary multi-source modes may differ in representation,
but not in front-end ownership or source-unit accounting.

## M2 landing checkpoint — one source-qualified module initializer (2026-08-27)

The next bounded landing moves one executable multi-source module initializer
behind exact Prepared ownership. It is intentionally narrower than the full R5
module graph contract so it can land independently and preserve a fail-closed
boundary while the remaining syntax and graph cases stay on the direct route.

- The production gate is exactly
  `JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER=1`; every other value preserves
  the existing path.
- Eligibility requires exactly one source with source-local executable module
  initialization and no unresolved or cross-source value aliases in that
  body. A resolver-backed second plan must also prove every module storage and
  value-flow representation before reservation. All other sources must
  contribute an empty init plan.
- The owner preallocates and reserves the exact source-qualified module-init
  unit in `ProgramAbiModuleInitCallableRegistry` before body emission. The
  contributor source records the Prepared unit outcome; empty sources record
  no synthetic ownership.
- Every direct module-init pass is suppressed while this route owns the unit.
  One frozen Prepared body is registered, checked again before startup
  finalization, and wrapped once as either the start function or deferred host
  export adapter.
- The acceptance test proves dependency-first and entry-contributor ordering,
  one and two contributor rejection, the all-empty case, cross-source imported
  read rejection, deferred-host TDZ behavior, exact ABI reservation, zero
  direct roots, body-identity and duplicate-adapter fail-closed seams, and a
  disabled-gate direct-path poison control. A boolean-to-number module-value
  mismatch proves unsupported representations reject before reservation and
  retain the direct fallback.

This checkpoint does not yet admit multiple executable source initializers,
cross-source value reads, re-export evaluation, cycles/SCCs, or arbitrary
module-init syntax. Those remain adjacent gates for the later whole-program
module graph owner; they must not be inferred from this exact-unit cutover.

## Current evidence

The current multi-source route is a post-legacy, per-source patch loop:

- `src/compiler.ts:1489-1620` builds one `MultiTypedAST`, but
  `src/compiler.ts:1014-1017` deliberately omits IR-first skip evidence for
  multi-source because M0 still compiles twice.
- `src/index.ts:676-755` exposes three public entry routes (`compileMulti`,
  `compileFiles`, and `compileProject`) that converge on multi-source compiler
  entries. `src/checker/index.ts:1058-1232` owns dependency-first graph/order;
  that order must become explicit Prepared-program input rather than be
  rediscovered by codegen.
- `src/codegen/index.ts:5072-5314` creates one legacy `CodegenContext`, then
  compiles declarations and direct bodies for every source at `:5249-5252`.
  The comment at `:5257-5268` says all direct bodies already exist and disables
  fast-mode overlay because its ABI differs.
- Only afterward, `src/codegen/index.ts:5269-5314` loops source-by-source,
  calls `planIrOverlay(..., { resolveModuleBindings: false })`, applies a local
  safe selection, prepares that source, and patches its slots. There is no
  program-owned preparation transaction.
- `collectMultiIrFunctionNameCollisions` at `src/codegen/index.ts:2301-2318`
  treats a flat function spelling as identity. `collectMultiImportAliasNames`
  (`:2320-2343`), `collectMultiImportedFunctionNames` (`:2346-2390`), and
  `collectMultiCrossFileFunctionNames` (`:2402-2464`) conservatively suppress
  aliases, default/namespace imports, checker edges, and global-script names.
- `makeMultiIrSafeSelection` at `src/codegen/index.ts:2569-2621` drops blocked
  weak components through flat `ctx.funcMap` keys and explicitly clears class
  members and module init. Nested runtime declarations, generic aliases,
  callable boundaries, and occupied synthetic names are rejection gates rather
  than modeled program edges.
- `src/ir/imported-functions.ts:61-223` can follow checker symbols across the
  realm, but only admits a unique declaration and unique flat canonical name.
  Valid same-name functions therefore become ambiguous before R1 identities
  can disambiguate them.
- `src/ir/integration.ts:3100-3119` documents that the synthesized closure
  registry restarts on every source in M0, forcing generated-name collision
  avoidance instead of one program-owned synthetic-unit registry.
- `src/codegen/index.ts:4988-5065` copies default/named aliases between flat
  maps and treats namespace imports as an explicit no-op. Re-exports with a
  module specifier are skipped by `src/codegen/declarations.ts:930-955`.
- Every multi-source `compileDeclarations` call rebuilds the progressively
  larger accumulated module-init state (`src/codegen/declarations.ts:2150-2229`
  and `:2351-2360`) and appends another `__module_init` (`:2366-2441`); only the
  newest export replaces the older one. One runtime invocation therefore does
  not prove one serialized semantic body.

The multi tests prove useful behavior but not ownership. In particular,
`tests/issue-2138-multi-module-ir-overlay.test.ts` proves an overlay can patch a
bounded population after direct compilation; it does not prove one program was
prepared before emission.

## Whole-program contract

`prepareIrProgram` (or the repository-equivalent entry point) accepts the
ordered source set and entry source exactly once. It must produce:

1. One R1 `ProgramAbiMap` containing every source/import/export/global/class/
   callable/synthetic binding, with explicit alias edges and stable structural
   IDs. Semantic evaluation order is recorded separately from canonical ID/map
   order.
2. One R2 `PreparedIrProgram` whose components may cross file boundaries and
   whose terminal outcomes cover the complete R0 census.
3. One R4 ordered module graph/init plan. Each source's instantiation and
   evaluation entries remain identifiable, while exactly one semantic init
   body is serialized and startup invokes it exactly once in dependency order,
   stable within-SCC order, and caller order for disconnected roots.
4. One program-owned closure, helper, literal, type, and runtime-intent
   registry. No per-source reset, generated-name probe, or late merge is
   permitted after preparation freezes.
5. A source-qualified export surface. Default, named, namespace, renamed, and
   re-export aliases resolve to canonical binding IDs; public names remain the
   requested module interface, not internal identity.

Single-source compilation must call this same entry with a one-element source
set. Maintaining a separate single-source semantic planner would leave two
front-ends and make R8 backend convergence unprovable.

## M0 implementation lock — whole-program census and coordinator (2026-08-26)

This section supersedes the generic M0 wording below for the next bounded
implementation PR. It is grounded on current `origin/main` at
`d86ebfb89fd20fb328cdf5206b5a296681134c78` and deliberately does **not** call
the present structural candidate API production-ready.

### Current-main facts that constrain M0

`generateMultiModule` already creates one `IrUnitInventory`, one
`IrPlanningIdentityContext`, and one `ProgramAbiSession` over the complete
`MultiTypedAST`. The missing owner is the route lifecycle around those shared
objects:

- `planEarlyMultiIrOverlay` independently invokes the scalar, array,
  function-value, and Fibonacci-pair route planners, merges their mutable
  `Map<SourceFile, EarlyMultiPreparedScalarLeafState>` results, and rejects
  overlap only at the source-file level.
- The direct-body loop consumes that map once per source. The later
  `compileMultiIrOverlaySource` loop consumes it again and otherwise creates a
  fresh per-source plan with `resolveModuleBindings: false` after direct bodies
  exist. There is no immutable program object proving which exact terminal
  units were reserved before the body boundary and which remained unreserved.
- The already-landed standalone cutovers are real Prepared routes: #4589
  scalar leaf, #4590 function-value benchmark leaf, #4591 Fibonacci pair, and
  #3518 numeric array leaf. They must become registrations in one owner rather
  than four precedents for more route-specific maps.
- `src/ir/program.ts` and `src/ir/prepare.ts` explicitly label their
  `PreparedIrProgram` records `unvalidated-candidate`, set
  `reconciliation: "pending-production-wiring"`, and accept only
  `top-level-function` terminals. Production uses that API nowhere outside
  `tests/issue-3521-prepared-ir-program.test.ts`. M0 must not populate it with
  invented direct candidates for classes/module init or present it as the
  production ownership proof.
- `ProgramAbiSession` is the production ABI transaction. Its per-component
  scopes seal genuine Prepared dependencies, while the one final `publish`
  reconciles the complete inventory. M0 must bind to that exact session and
  inventory, not build a second `ProgramAbiMap` or a test-only shadow ABI.

The bounded checkpoint is therefore a behavior-preserving program census and
coordinator. It moves the existing pre-body routes under one exact owner and
creates the lifecycle seam that M1 can widen. It does not pre-plan late routes
whose lowering still depends on legacy-populated registries, and it does not
claim the final R5 acceptance criteria early.

### Exact production shape

Add `src/codegen/multi-prepared-program.ts` with a single stateful construction
owner and immutable snapshots. Names may vary only to fit repository style;
the following semantics are fixed:

```ts
type MultiPreparedProgramState =
  | "collecting"
  | "body-boundary-sealed"
  | "routes-complete"
  | "complete"
  | "failed";

interface MultiPreparedProgramSourceCensus {
  sourceId: IrSourceId;
  sourceKey: string;
  canonicalOrder: number;
  semanticOrder: number;
  kind: IrSourceKind;
  terminalUnitIds: readonly IrUnitId[];
}

interface MultiPreparedProgramReservation {
  unitId: IrUnitId;
  sourceId: IrSourceId;
  routeKind: "scalar" | "array" | "function-value" | "fibonacci-pair";
  preparedComponentId: string;
  preparedBeforeDirectBodies: true;
}

interface MultiPreparedProgramBodyPlan<Plan> {
  schema: "multi-prepared-program-body-plan-v1";
  entrySourceId: IrSourceId;
  canonicalSourceIds: readonly IrSourceId[];
  semanticSourceIds: readonly IrSourceId[];
  expectedBodySourceIds: readonly IrSourceId[];
  expectedOverlaySourceIds: readonly IrSourceId[];
  terminalUnitIds: readonly IrUnitId[];
  sources: readonly MultiPreparedProgramSourceCensus[];
  reservations: readonly MultiPreparedProgramReservation[];
  unreservedTerminalUnitIds: readonly IrUnitId[];
}
```

The construction owner is created exactly once immediately after the shared
identity context, ABI session, and `CodegenContext` are created. It receives
the exact `MultiTypedAST`, identity context, and ABI session by object identity.
It must fail closed unless:

1. the ABI session inventory is the identity context inventory;
2. every `MultiTypedAST.sourceFiles` object resolves to exactly one inventory
   source and every inventory source resolves back to exactly one AST object;
3. the entry file resolves to the one source whose kind is `entry`;
4. canonical source order is exactly `inventory.sources[].order`, while the
   separate semantic order is exactly `MultiTypedAST.sourceFiles` order; and
5. every terminal record belongs to one known source and occurs exactly once in
   both the whole denominator and its source-local denominator.

After declaration allocation and the existing four early-route planners run,
the owner seals one `MultiPreparedProgramBodyPlan`. The route planners remain
the eligibility/lowering authorities for this checkpoint; they return their
current states to the owner rather than directly to both body loops. Sealing
must validate every stored state and reservation by exact object/identity join:

- the source-file key is the exact object owned by the identity context;
- each plan carries that same identity context/inventory;
- each route declaration maps to its exact terminal `IrUnitId` and source;
- scalar, array, and function-value routes reserve their one receipt unit;
  Fibonacci reserves both the recursive and wrapper units under the one exact
  prepared component ID;
- every receipt is `kind: "prepared"`, every reserved unit is terminal and
  top-level-function, and no unit/source/component is registered twice;
- all route Prepared reports, completed/skip projections, allocated function
  objects, and component IDs remain the exact objects already proved by the
  route-specific validators; and
- every terminal not reserved by an early route is listed once as
  `unreservedTerminalUnitIds`. “Unreserved” describes the pre-body boundary;
  it is not an invented claim that the unit will necessarily direct-emit or
  cannot later receive the existing overlay.

The frozen body plan, not the original mutable map, is then the only value
consumed by both phases:

1. the direct-body loop calls the coordinator's phase-checked
   `stateForBodySource(sf)` and preserves the existing
   skip/preserve/module-init behavior exactly;
2. the late overlay loop calls `stateForOverlaySource(sf)`, reuses the early
   `plan` where one exists, and preserves the current late per-source planning
   fallback only for an unplanned source; and
3. the owner records exact source visits for both phases. The expected body
   sequence is always the semantic source sequence. The expected overlay
   sequence is that same sequence only when the existing
   `options.experimentalIR && !ctx.fast` loop is enabled, and is explicitly
   empty otherwise; `trackIrOutcomes` alone must not manufacture an overlay
   visit.

The final audit is exposed only on `GeneratedCodegenModule` as internal
codegen evidence (the public `CompileResult` need not grow in M0). It contains
the body plan plus exact body-loop and overlay-loop source ID sequences and an
`abiSessionBound: true` proof. After the late loop the owner seals its route
visits as `routes-complete`; after `ProgramAbiSession.publish`, clean
compilations pass that exact publication to `complete`, which asserts
`publication.abi.inventory === identityContext.inventory` and creates the
audit. The coordinator never seals or publishes ABI itself.

All arrays/maps exposed by the body plan or audit must be defensively owned and
runtime read-only. The existing route state remains private to the coordinator:
its one required `skippedFunctionUnitIds` correlation mutation is permitted
only during the body accessor/consumer pair, and the late accessor returns that
same exact state afterward. The census never exposes the mutable state map.
AST, route, Wasm function, report, and ABI objects may be referenced for
identity validation but must not be cloned, replaced, or otherwise mutated.
Repeated sealing/completion is allowed only as an idempotent read of the same
result; any other post-seal mutation fails with a stable invariant code.

### Required code movement and deletion

The implementation PR owns only:

- new `src/codegen/multi-prepared-program.ts`;
- the narrow orchestration edits in `src/codegen/index.ts` needed to construct,
  seal, consume, complete, and expose the program audit; and
- new `tests/issue-3525-multi-prepared-program-census.test.ts` plus focused
  updates to an existing route test only if an exact integration assertion
  belongs beside its fixture.

Do not edit `src/ir/program.ts`, `src/ir/prepare.ts`, `src/ir/program-abi.ts`,
the four route selectors/lowerers, `src/codegen/declarations.ts`, or public
compiler/index APIs in M0. If the coordinator cannot consume a route without
changing its eligibility or lowering contract, stop and amend this plan rather
than widening ownership opportunistically.

Delete the hand-merged `scalarStates`/`arrayStates`/`functionValueStates`
plumbing from `planEarlyMultiIrOverlay` as it becomes coordinator-owned. Do not
add another route-kind switch in `generateMultiModule`; route enumeration and
reservation extraction belong in the new owner. No LOC-budget allowance,
function-budget allowance, baseline change, or size-regression exception is
authorized. Run `pnpm run check:loc-budget` immediately before committing.

### Mutation and integration proof

The new focused test must exercise the owner directly with table-driven
mutations and through real `generateMultiModule` fixtures.

Direct mutations must reject, with stable codes:

1. missing/duplicate/foreign source object or source ID;
2. missing/duplicate/reordered canonical source record;
3. missing/duplicate/foreign entry source;
4. missing/duplicate terminal in either whole or source-local denominator;
5. terminal attached to the wrong source;
6. route stored under the wrong source object;
7. unknown, non-terminal, cross-source, or duplicate reserved unit;
8. duplicate prepared component ID across distinct components;
9. Fibonacci with only one member, distinct component IDs, or reversed
   receipt ownership;
10. stale identity context, plan, declaration, receipt, Prepared report,
    skip projection, or allocated function object;
11. missing/duplicate/out-of-order body or overlay source visit;
12. completion before both visit censuses, mutation after seal, and a different
    second seal/completion input; and
13. an ABI publication whose inventory is not the construction inventory.

Positive structural controls must prove two sources may contain the same
display-name function while retaining distinct source/unit IDs, and that
reordering a test-only `Map` insertion does not change the canonical snapshot.
Semantic source-order reversal is represented separately and must never rewrite
canonical identities.

Real standalone integration controls must cover all four current early routes:

- #4589 exact scalar leaf: one scalar reservation;
- #4590 benchmark loop: one function-value reservation with its existing
  support receipt unchanged;
- #4591 Fibonacci: two reserved terminals, one component ID;
- #3518 benchmark numeric array leaf: one array reservation (including its optional
  function-value support receipt without manufacturing another terminal);
- each route’s existing kill switch: identical source/terminal census, zero
  corresponding early reservation, and unchanged late/direct behavior; and
- a non-candidate multi-source fixture: complete denominator, no reservation,
  and exact source visits.

For every lane, retain the existing direct-body poison, Prepared outcome,
Program ABI object/slot, raw and optimized body, surface, runtime, and no-growth
assertions from the route-specific suites. M0 adds ownership evidence; it may
not weaken or replace those oracles. An injected coordinator failure must occur
before the first direct body, while a clean lane must remain artifact- and
runtime-equivalent to current main.

### Validation and checkpoint boundary

Before commit and push, with the strict finite/nonnegative one-minute load gate
`load < logicalCores - 2`:

1. run TypeScript validation and the new #3525 test;
2. run #4589, #4590, #4591, and the #3518 benchmark-array cutover together;
3. run #2138 multi-module overlay plus the multi-file/equivalence suites named
   below;
4. run the IR fallback/neutrality and issue-integrity gates;
5. run `pnpm run check:loc-budget` immediately before the signed commit; and
6. allow the complete precommit and prepush hooks to run without bypass.

M0 is complete only when one integrated program owner supplies both body loops,
the exact source/terminal/reservation census is published, all mutations fail
closed, all prior route evidence remains green, and the old hand-merged map
plumbing is deleted. It does **not** complete #3525: M1 must move cross-file
binding/call components into pre-body preparation; M2 must move classes,
closures, globals, and ordered module init; final R5 must converge the
single-source entry and delete the late per-source overlay and flat-name gates.

## M1A implementation lock — structural callable graph and standalone cross-source components (2026-08-26)

This section is the next bounded implementation checkpoint after M0. It is
grounded on current `main` at `b8ed99107a3c6ba11585bd7544e30ef21b1e3bf7`
and on the reviewed M0 coordinator shape. The implementation branch must base
on the merged M0 implementation, #4260's atomic Prepared publication support,
and #4755's direct-fallback TDZ prerequisite. It must not copy this plan's
current line numbers into code or silently adapt around an unmerged dependency.

M1A makes one real retirement step: eligible cross-source top-level function
components are selected, typed, lowered, and sealed before the first direct
body in ordinary standalone mode. It removes flat-name authority for that
population. It does **not** complete all of M1: fast-mode carrier convergence,
function values, mutable callable bindings, classes, globals, and module init
remain later milestones and must stay explicitly accounted as typed
Unsupported/direct-owned units.

### Current-main facts that constrain M1A

The exact structural pieces already exist but are joined too late or projected
back to names:

- `src/ir/imported-functions.ts` can resolve a named/default import to an exact
  target `IrUnitId`, and its tests already prove same-labelled declarations
  remain distinct. Production immediately projects that result through
  `legacyProjection`, so a valid same-name target becomes unavailable.
- `planIrOverlay` passes imported-source evidence to selection and imported
  call planning only under `jsHostExterns`. Standalone therefore cannot even
  form the exact call edge despite needing no host import for a source unit.
- `makeMultiIrSafeSelection` then blocks every standalone/WASI cross-file
  caller and validates targets through `ctx.funcMap`, occupied function names,
  and `WasmFunction.name`. `prepareMultiIrImportedLowering` repeats the same
  name lookup for function-value support.
- `registerImportBindingAliases` copies `funcMap`, `closureMap`,
  `moduleGlobals`, optional/rest metadata, and live-binding membership from a
  target spelling to a local spelling. That pass remains necessary for direct
  fallback, but it cannot be semantic evidence for an IR component: it is
  last-wins, namespace imports are a no-op, and two source functions with the
  same display name cannot both be authoritative.
- `ProgramAbiSourceCallableRegistry` already observes allocator objects by
  exact source `IrUnitId`, while `ProgramAbiMap` has the low-level mechanics
  for a non-allocating callable alias (`slotPolicy: "alias"`, `aliasOf`, no
  locator/final index, and exact signature equality). The session does **not**
  yet have an honest internal-module-callable alias intent: support aliases use
  the `support` ID/origin family, source origins require a unit, and import
  origins describe host/provider callables. M1A must add a bounded provenance
  rather than force an internal alias through raw `ensurePlan` or mislabel it
  as a public `export`/platform `import`.
- `prepareIrBodies` and `compileIrPathFunctions` currently accept one source
  and one name-keyed override projection. Sequentially preparing two sources
  would allow the first to publish before the second fails. M1A therefore
  depends on #4260 and must introduce a genuine cross-source staging entry,
  not patch-and-rollback or a loop of independent per-source transactions.
- The reviewed M0 `MultiPreparedProgramOwner` owns the complete source and
  terminal census, but it is not a plug-in extension point yet: its private
  state is keyed by `SourceFile`, `sealBodyBoundary()` rejects a second route
  for a source as `duplicate-route-source`, and the body accessor returns one
  `EarlyMultiPreparedScalarLeafState`. A cross-source component can contain
  multiple units in one source and can overlap a source that also contains an
  existing scalar/array/function-value route. M1A must refactor this into a
  unit-keyed reservation/component ledger plus one per-source composite body
  consumer; it may not add a fifth mutually-exclusive source map.
- #4260's reviewed batch can cover multiple terminal IDs in one scope and
  atomically consumes its staged Program ABI plus callable-import/provider,
  class-layout, and export-alias registry writes. It does not yet stage live
  allocator body replacement, IR outcomes/terminal evidence, or M0
  reservation/skip receipts. `prepareIrBodies` remains single-source and
  `compileIrPathFunctions` still mutates allocator bodies/locators after its
  pending-patch pass. M1A therefore must extend that authenticated batch (or
  add one enclosing commit primitive); merely sealing ABI and then patching
  bodies is not component atomicity.

### 1. Build one IR-owned callable binding graph

Add `src/ir/program-callable-bindings.ts`. This module is the only new
TypeScript-checker owner for program-wide callable imports/exports. It may
import IR identity, callable-reference, planning-identity, type/oracle, and
TypeScript AST modules. It must not import `src/codegen`, Wasm allocator/layout
types, `CodegenContext`, `funcMap`, or a backend target.

Build exactly one frozen `IrProgramCallableBindingGraph` from the complete
ordered source set, checker/oracle, and the M0 `IrPlanningIdentityContext`
before any declaration or body emission. The public shape must carry at least:

```ts
interface IrProgramCallableBindingRecord {
  bindingId: IrBindingId;
  sourceId: IrSourceId;
  declarationOrdinal: number;
  kind: "source" | "import-alias" | "export-alias";
  localName: string;
  targetBindingId: IrBindingId;
  canonicalBindingId: IrBindingId;
  targetUnitId: IrUnitId;
}

interface IrProgramCallableUse {
  sourceId: IrSourceId;
  ownerUnitId: IrUnitId;
  node: ts.CallExpression;
  bindingId: IrBindingId;
  canonicalBindingId: IrBindingId;
  targetUnitId: IrUnitId;
}

interface IrProgramCallableBindingGraph {
  schema: "ir-program-callable-binding-graph-v1";
  sourceIds: readonly IrSourceId[];
  records: readonly IrProgramCallableBindingRecord[];
  uses: readonly IrProgramCallableUse[];
  resolveCall(call: ts.CallExpression, ownerUnitId: IrUnitId):
    | IrProgramCallableUse
    | undefined;
}
```

Names and additional private indices may vary, but the semantics may not:

1. A source function's canonical binding is
   `irUnitCallableBindingId(targetUnitId)`. Its display name is diagnostic and
   never participates in lookup, equality, ordering, or component closure.
2. Internal import/export aliases use source-owned `IrBindingId`s in the
   `callable` domain with distinct roles such as
   `module-import-callable` and `module-export-callable`, plus a stable
   top-level declaration/binding ordinal. They are callable aliases, not final
   public-Wasm `export` intents.
3. Record named imports, renamed imports, default imports, named/default local
   exports, anonymous default function declarations, `export { x as y } from`,
   chained re-exports, and unambiguous `export *` edges. A legal alias chain may
   cross multiple sources and resolves to one canonical source callable.
4. Record a statically named `ns.member(...)` use of
   `import * as ns` by the exact exported binding reached through the namespace.
   Do not manufacture a runtime namespace-object representation. Element
   access, optional/dynamic property access, namespace value escape, and
   ambiguous star collisions remain Unsupported.
5. Use checker/oracle symbol identity only to join exact AST declarations.
   Every published source, declaration, target unit, and owner unit must join
   back to the same M0 identity context object in both directions. A cloned AST
   node, declaration outside the active source population, declaration-file or
   linked-package target, overload/merge set, missing body, or mutable/reassigned
   source function is not an alias to a source callable.
6. Preserve legal export cycles when they resolve to a unique canonical source
   callable. Reject an alias cycle with no canonical target, duplicate binding
   ID/order, two different canonical targets for one local/export binding, a
   missing target, or a wrong-source/unit join with a typed planning invariant.
   An ordinary language ambiguity/capability gap is an Unsupported graph row,
   not last-wins resolution and not an invariant.
7. Canonical records are ordered by inventory source order and exact syntactic
   binding order. Reordering caller `Map` insertion or a test-only internal map
   must not alter IDs or the canonical snapshot. Semantic source evaluation
   order remains the separate M0 sequence.

Refactor `src/ir/imported-functions.ts` to delegate its identity-aware factory
to this graph or become a thin compatibility projection. New production
selection/lowering may not call
`projectIrIdentityImportedFunctionResolverToLegacy`. Keep the legacy factory
only for still-direct routes and existing API compatibility until their
callers are deleted; mark it as a one-way compatibility boundary.

### 2. Feed selection from structural uses in every source backend

Change the selector/imported-call contract to consume exact
`IrProgramCallableUse` evidence. The TypeScript/checker decision remains above
codegen; the backend receives a frozen use with source, owner, alias, canonical
binding, and target unit IDs.

- Pass source-callable evidence independently of `jsHostExterns`. Host ambient
  imports remain a separate backend-capability resolver and retain their
  existing host-only gate.
- Extend direct-call certification to identifier calls and the bounded static
  namespace member form above. Certification must prove that the call node is
  inside the exact owner declaration and that the owner/target occur in the
  active graph exactly once.
- Build target parameter/result types from the target unit's exact IR type
  projection. Reconcile them with the already-allocated source callable's
  `ProgramAbi` type contract before component admission. Do not read optional,
  rest, `arguments`, or callable metadata from a target name. Either add
  unit-keyed source-callable metadata beside the graph or classify those
  families Unsupported for M1A.
- `IrImportedCallLoweringPlan.target` remains an `irUnitFuncRef` to the
  canonical `targetUnitId`; its compatibility name may be any stable diagnostic
  label and cannot redirect resolution.
- Remove `legacyProjection === "unambiguous"`, `ctx.funcMap.get(name)`,
  occupied-name counts, prefix probes, and `WasmFunction.name` from M1A
  admission. Retain those checks only in the untouched late/direct compatibility
  routes until their own deletion proof.

The M1A callable family is deliberately bounded to direct, fixed-target calls
between bodyful top-level functions. Function values/callbacks, `.call`/`.apply`,
mutable function bindings, overload sets, generics, async/generator bodies,
class or module-init owners, runtime-eval boundaries, and late provider
requests remain typed Unsupported. Do not broaden them by weakening existing
selector or ABI checks.

### 3. Form whole-program components before direct bodies

Add `src/codegen/multi-prepared-callable-components.ts` as the backend adapter
for the frozen IR graph. It may inspect allocator objects and `ProgramAbi`
contracts, but it must not query the checker or rediscover aliases.

After declarations and source callable slots are allocated, but before the
first direct body:

1. Plan every source through the exact M1A structural resolver. Keep these
   `IrOverlayPlan`s in the `MultiPreparedProgramOwner`; do not recreate them in
   the late overlay loop.
2. Build a program graph keyed only by `IrUnitId`: local direct-call edges plus
   the cross-source `IrProgramCallableUse` edges. Compute deterministic weak
   components with a stable unit-ID order. Component IDs derive from the exact
   sorted unit population/route role, never a display name or map insertion
   order.
3. A component is eligible only when every included unit is a selected terminal
   top-level function with an exact claim, override, allocated source-callable
   object, Program ABI contract, and complete incoming/outgoing callable edge
   accounting. A direct/unowned caller or unsupported callee withdraws the
   whole component unless the existing exact outside-caller ABI certificate
   proves the boundary unchanged.
4. Reconcile the caller's call plan, target override, allocator `FuncTypeDef`,
   and canonical Program ABI callable signature field-for-field, including
   indexed ref types and semantic brands. A mismatch is one typed Unsupported
   component before mutation; never coerce one side or adopt a name-selected
   signature.
5. Add an idempotent targeted `ProgramAbiSourceCallableRegistry.planUnits()`-
   style API for the exact component units. It tracks a per-unit planned set;
   it must not trip the existing global `planRetained()` latch, close further
   observations, or seal unrelated retained callables. The final
   `planRetained()` plans only the remaining observed units and then closes the
   registry.
6. Add a bounded `module-alias` provenance/intent (or an equally explicit
   discriminant) to `ProgramAbiSession`, with a dedicated planner and staged
   descriptor. Materialize every internal import/export alias record needed by
   the component through that API as a non-allocating callable alias. Each
   alias carries its source, structural order, canonical callable contract,
   and `aliasOf`; exact source/ID/order joins are validated, and no alias owns a
   locator or final index. Include the exact alias bindings in the component
   scope/borrowed-binding evidence. Do not reuse support, host import, or public
   export provenance.

Refactor M0's single-route-per-source state into a v2 unit-keyed reservation
and component ledger. The four existing route states become bounded
contributors/adapters to this ledger, preserving their exact receipts,
currentness checks, and route-specific audit evidence. It must support multiple
reservations in one source and existing route reservations beside a
cross-source component. Add `cross-source-callable` to the route kind and
publish, for every source, the exact requested skip projection and component
IDs. Unit ID, not source object or legacy name, is the uniqueness key. A unit
cannot belong to two routes/components; two sources may legitimately reserve
same-labelled units.

Replace the route-specific body wrapper with one
`compileMultiPreparedProgramDeclarations`-style consumer. It combines the
already-proved route projections for one source, calls `compileDeclarations`
once, and correlates every returned skipped name back to the exact source-local
requested unit projection. It must reject missing, duplicate, foreign, or
cross-component skips. The existing four M0 routes retain byte-identical
receipts and behavior.

### 4. Stage and publish a cross-source component atomically

Do not call the existing single-source `prepareIrBodies` independently for
each source. Extract or add a whole-component entry below it that accepts:

- the exact component unit IDs and source partitions;
- per-unit claims and type overrides;
- each exact source AST and its structural lowering plans;
- the frozen callable graph/alias binding IDs; and
- one #4260 Prepared transaction extended with the component publication
  fields below, or one authenticated outer commit owner that contains it.

Lower all member bodies into detached staging artifacts. Extend the #4260 batch
or wrap it in one authenticated commit primitive that stages prevalidated
allocator body/locator compare-and-swap writes, IR outcomes, terminal evidence,
and M0 component/reservation/skip publication alongside its Program ABI and
registry writes. The live allocator objects, Program ABI publication,
provider/import registries, terminal ledger, and body-skip projection remain
unchanged until every member has built and the whole component has passed
source/unit/signature/call-edge validation. Validate every possible failure
before the commit boundary; after the first live write, the commit sequence
must contain no throwable computation or fallible lookup. Then publish all
bodies, ABI aliases/borrowed bindings, terminal evidence, and skip receipts once
under one `preparedComponentId`.

If any member is Unsupported, abort the staging owner and publish an exact
component failure for every member: no staged body or ABI alias becomes live,
no unit is reserved/skipped, and the later body loop direct-emits each member
exactly once. An Invariant is fatal and likewise publishes no prefix. Never
implement atomicity with sequential patching plus rollback, ABI-first sealing
followed by live body writes, body cloning after publication, or
catch-and-continue around a partially sealed scope. The candidate-only
`PreparedIrEmissionTransaction` in `src/ir/program.ts` is evidence, not a
production substitute for this commit primitive.

Keep the shared integration implementation out of another god file. Prefer a
new `src/ir/program-component-integration.ts` plus a narrow adapter in
`src/ir/integration.ts`; the latter must not grow past its current LOC ratchet.
Likewise, extract from `multi-prepared-program.ts` if adding M1A would push it
over its file budget. No IR module may import codegen to reach the transaction;
pass an interface/callback owned below the IR boundary.

After a committed component, the late overlay loop consumes the exact stored
plans only for audit/report completion and must not rebuild or repatch those
units. After an aborted component, it must not make a second preparation
attempt. Exactly one pre-body decision and exactly one body emitter exist per
terminal.

### 5. Bounded rollout and deletions

Gate the new route with
`JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER`. M1A initially enabled it
by default for ordinary standalone multi-source compilation with
`experimentalIR: true`, native strings, no WASI, and non-fast ABI. M1A.1 rolls
aggregate commitment back to explicit `1` until generic/dedicated-owner
composition is certified. The frozen callable graph and selection preplanning
remain active for the established #3214 imported-HOF lane, while the disabled
lane creates zero M1A reservations.

For units admitted through M1A, delete/bypass these authorities:

- the standalone `conservativeCrossFileCallers` rejection;
- flat collision/import-alias/cross-file-name suppressors;
- `multiIrTargetHasExactRegistryEntry` name lookup; and
- `registerImportBindingAliases` as evidence for selection, target ABI, or IR
  lowering.

Do not yet delete the compatibility helpers globally. Direct fallback, fast,
WASI, classes, globals, module init, function values, and the old late overlay
still use them. Add reachability counters or explicit route assertions so M1A
tests prove the structural route did not consult them; final deletion belongs
to M1B/M2 once their remaining population reaches zero.

Fast mode remains outside M1A because its direct `number` carrier is i32 while
the current IR overlay is f64. Host and WASI are controls, not alternate
planners. M1B must make the frozen program signature mode-aware and feed fast
and ordinary backends from the same graph before the parent M1 checkbox can
close.

### Mutation and integration proof

Add `tests/issue-3525-multi-prepared-callable-bindings.test.ts` and update the
standalone/collision assertions in
`tests/issue-2138-multi-module-ir-overlay.test.ts` only after the new evidence
is available.

The direct graph harness must fail closed with stable codes for:

1. missing, duplicate, foreign, cloned, or reordered source records;
2. missing/duplicate source callable, alias binding ID, declaration ordinal,
   owner unit, target unit, or canonical binding;
3. named/default/namespace/re-export alias attached to the wrong source or AST
   node;
4. two canonical targets for one alias, ambiguous star export, dangling alias,
   and an alias cycle without a canonical source callable;
5. overload/merge, declaration-file, linked-package, missing-body, mutable, or
   reassigned target incorrectly admitted as a source callable;
6. use node outside its exact owner, dynamic namespace member, namespace value
   escape, and a use whose checker symbol disagrees with its graph record;
7. wrong target signature/Program ABI alias contract, alias with a locator,
   alias that owns a slot, and alias attached to a foreign prepared scope; and
8. internal map/source insertion reversal changing canonical records or the
   component/evidence digest.

The component harness must reject missing/duplicate/cross-source-wrong unit
membership, incomplete incoming/outgoing edge closure, two component IDs for
one unit, partial source skip correlation, a late second attempt, and a
different second completion input. Inject first/middle/last member lowering,
ABI-alias, provider, and publication failures; every case must retain zero live
prefix and one complete typed component outcome.

Real standalone A/B fixtures must prove:

1. named, renamed, default-named, anonymous-default, namespace-member,
   `export { x as y } from`, chained re-export, and unambiguous `export *`
   calls all prepare before direct bodies and return exact disabled-lane values;
2. two providers exporting same-named functions plus same-named local callers
   retain distinct source/unit/binding IDs, both IR-emit, and dispatch to the
   correct provider without a flat-name collision gate;
3. forward cross-file chains and a legal call SCC share deterministic component
   IDs and compile once; reversing caller input/internal map order preserves
   structural identities while retaining semantic source order;
4. every Prepared member records `directBodyEmissions=0` and
   `irBodyEmissions=1`; poisoning the direct body and legacy alias-copy lookup
   cannot affect the enabled fixture;
5. an injected signature or lowering withdrawal aborts the whole component,
   records no reservation, and every member direct-emits once with runtime,
   surface, and artifact parity after #4755;
6. the cutover-disabled lane has the same source/terminal/callable graph,
   zero `cross-source-callable` reservations, no IR-first skip, and exact current
   direct behavior;
7. standalone retains zero host imports, exact public exports, identical
   module-init behavior, and no new runtime provider; and
8. host, fast, WASI, single-source, existing M0 scalar/array/function-value/
   Fibonacci routes, and non-callable multi-source fixtures remain exact
   controls with no accidental M1A reservation.

Compare raw and optimized functions, Program ABI entries/final indices,
terminal outcomes, prepared component IDs, body-route audit, import/provider
manifest, public surface, runtime values, binary validity, and repeated-run
determinism. Binary equality is required for controls and disabled lanes; the
enabled route may differ only where direct bodies are genuinely absent.

Run the new suite with #2138, #2930, #2931, #3214 imported HOF/callable ABI,
#3520 imported-target/Program-ABI tests, #4530 import-alias arguments behavior,
the four M0 early-route suites, multi-file/equivalence, closed/bare imports,
standalone relative imports, and #4755/#4260 fallback/transaction suites.

### Validation and checkpoint boundary

Before commit and push, sample the one-minute load and require it to be finite,
non-negative, and strictly less than `logical cores - 2`. Then:

1. run focused mutation/integration suites and both TypeScript 7 and 5 checks;
2. run formatting, IR layering/dialect, dead exports, fallback/oracle/coercion,
   function-size, optimization-preservation, and issue-integrity ratchets;
3. run `pnpm run check:loc-budget` immediately before the signed commit;
4. run the complete precommit and prepush hooks without bypass; and
5. leave no `node_modules` link in the worktree after push.

No LOC/function/layering/baseline allowance is authorized. New graph/component
logic belongs in bounded modules; shrink `index.ts`, `integration.ts`, and any
M0 file that would otherwise regrow. Do not widen a Test262 baseline or relock
an unrelated binary hash to make the branch green.

M1A is complete only when the enabled standalone fixtures publish a frozen
callable graph, atomically reserve every cross-source component before direct
bodies, bypass flat-name authority, and prove zero direct emissions without
weakening fallback. The parent #3525/M1 milestone remains open until M1B makes
fast/ordinary ownership converge and retires the residual callable/name
compatibility path.

## M1A.1 implementation lock — unit-keyed direct-body consumption (2026-08-27)

The merged M1A owner reserves cross-source components by exact `IrUnitId`, but
its final handoff to `compileDeclarations` projects those reservations back to
bare `skipBodies` / `preserveBodies` names. The owner then reconstructs skipped
unit IDs from the returned name list. Per-source `funcMap` rebinding currently
keeps that compatible, but the skip decision itself still trusts the flat-name
authority that R5 is required to retire.

M1A.1 threads the already-frozen source-local unit projections through
`multi-prepared-program.ts` and `multi-prepared-body-skips.ts` into a dedicated
top-level function-body routing record in `declarations.ts`. For each bodyful
function declaration, `compileDeclarations` resolves the exact unit from the
shared `IrPlanningIdentityContext`; its unit membership is authoritative for
skip and preserve. The legacy name sets remain a temporary slot-locator and
compatibility assertion only: disagreement between name and unit projections
is an invariant before direct body emission, never permission to guess or
fallback. Observed skipped units flow back directly to the program owner; no
name-to-unit reconstruction is permitted.

Making the M1A runtime test non-vacuous exposed two earlier implementation
defects that this checkpoint also closes. The orchestration union-find did not
join a caller whose stable unit ID sorted after its callee, so the asserted
route could silently remain the ordinary late overlay. Once joined, final IR
optimization could erase the connecting call before dependency sealing and
split the already-certified aggregate into per-terminal prepared scopes.
`atomicComponent` now preserves the caller-certified terminal denominator as
one deterministic dependency/seal component even when the final IR edge has
disappeared. The body-reservation census and direct-body poison make the
cross-source prepared route, rather than merely any IR emission, mandatory in
the focused runtime proof. If no aggregate commits, attempted units remain
withdrawn while untouched graph units may continue through the established
late overlay; this preserves the #3214 imported-HOF invariant without allowing
IR-after-direct emission.

Aggregate commitment is explicit opt-in at this checkpoint. Candidate
preplanning remains default-on because it supplies the frozen callable graph
used by the #3214 imported-HOF lane, but only an exact `1` may reserve and
publish a cross-source callable component. Generic commitment also refuses a
graph once an established scalar, array, string, function-value, or Fibonacci
Prepared owner has reserved any unit. A graph with runtime module-init
population disables callable preplanning before dedicated-route selection and
stays on its established ownership path.

Focused acceptance requires every admitted component unit to have zero
`compileFunctionBody` / `compileStatement` audit rows, one `terminal-ir`
disposition, a unique source-qualified unit ID, and correct runtime dispatch.
A direct decision test supplies the same legacy spelling with a foreign unit ID
and must fail invariantly rather than authorize the skip. The cutover-disabled
control retains the same terminal denominator and direct behavior. Existing
scalar, array, string, function-value, and Fibonacci routes must also correlate
their exact unit projections through the shared consumer. Same-spelled
cross-source component admission is still blocked by M1A's conservative flat
collision filter and remains a later R5 deletion step. This checkpoint removes
flat-name authority only at the body-skip boundary; it does not enable
fast/WASI/host components, compose the generic lane with an already-reserved
dedicated Prepared route, delete the late overlay, or complete M1B/M2/R5.

## M1A.2 implementation lock — default-on bounded callable components (2026-08-27)

M1A.1 proves that an exact, source-qualified cross-source callable component
can reserve all of its terminal units before direct bodies, publish one sealed
Prepared component, and correlate every skipped body back by `IrUnitId`.
Production still requires the exact environment value
`JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER=1` to commit that component.
With the variable unset, the compiler builds the same whole-program graph but
withdraws the candidate units from the late overlay and leaves their direct
bodies authoritative. That exact-`1` promotion gate is now the next direct
AST-to-Wasm reachability edge in the bounded M1A lane.

M1A.2 makes commitment default-on whenever the existing M1A eligibility proof
holds. It consolidates graph use and component commitment under the one
default-on gate already interpreted by `explicitlyDisabledEnv`: only `0` or
`false` restores the pre-cutover direct route. The redundant
`irProgramCallableComponentCutoverEnabled` context bit is deleted so graph
selection and component ownership cannot silently disagree. A source with any
module-init population still disables the route before planning, and the
existing standalone/native-string/non-WASI/non-fast/multi-source conditions,
dedicated-owner exclusion, callable-boundary exclusion, class exclusion, and
exact dependency/seal checks remain unchanged.

The default-on proof uses the same two-terminal fixture as M1A.1 with no
cutover environment variable. Poisoning both `add` and `run` direct bodies must
still compile and run through one Prepared component, with exactly two unique
unit IDs, two `terminal-ir` dispositions, and zero matching legacy audit rows.
The `=0` mutation is the positive direct-route control: with the same poison it
must fail at both direct bodies and report the exact legacy entries; without
poison it must preserve runtime behavior. Existing imported-HOF (#3214),
scalar, array, string, function-value, Fibonacci, module-init, fast, host, and
WASI controls must remain unchanged. This promotion widens production
ownership only to components already accepted by M1A.1; it does not relax
same-spelling collision filters, compose with dedicated owners, admit classes
or module init, or delete the per-source late overlay.

Landing evidence is the focused #3525 suite, adjacent #3214 and dedicated-route
suites, `check:ir-fallbacks`, typecheck, formatting/lint/ratchets, and full CI.
The kill-switch A/B is load-bearing: a green default compile without the direct
poison and exact disabled-route failure is not evidence that the component
owned either terminal. Because `check:ir-only` currently exercises five
single-source entries, it is supporting evidence rather than the authority for
this multi-source promotion. The executed checkpoint denominator must also
include `issue-3525-multi-prepared-program-census`,
`issue-2138-multi-module-ir-overlay`, `equivalence/multi-file-compilation`, and
`multi-file`, with compile throws, `success:false`, fatal `result.errors`, and
missing body-route audits treated as failures. Assertions must join actual
legacy body rows and Prepared component membership by `IrUnitId`; the owner's
post-route `irOutcomes` projection is not sufficient by itself.

## M1A.3 implementation lock — retire the same-spelling component exclusion (2026-08-30)

This is a Sol-authored bounded continuation of M1A.2, grounded on the
2026-08-30 protected-main tip
`b6adee3156e9642ed221174a69e6f6f1a381484f` and the branch sync checkpoint
`d281f8445f84bfaf5c6bbe5ee1fb54b5dcda898e`. It removes the
remaining name-based *admission* vetoes for the already-structural callable
component route. It does not change the callable graph, add a new alias
resolver, widen route eligibility, compose with a dedicated Prepared owner, or
move any direct fallback body.

### Current authority trace

The first residual is in
`src/codegen/multi-prepared-callable-orchestration.ts`:
`collectMultiIrFunctionNameCollisions(...)` builds a program-wide set and
`collidingFunctionNames.has(claim.legacyName)` rejects an otherwise exact
candidate. A second, earlier name gate remains in
`makeMultiIrSafeSelection(...)`: a colliding source-local provider is exempt
only when `hasMultiIrProgramCallableBoundary(...)` sees that exact unit on a
cross-source use. In the required graph, `run` calls the imported `call`
functions, while each `call` reaches its same-source `same` provider. The
providers therefore fail that early name/occupied-slot gate and source-local
weak closure withdraws their callers before aggregate candidate construction.
Adding artificial entry-to-provider calls would merely bypass this gate and is
forbidden; it does not prove the required route.

A third legacy-name veto remains in
`src/ir/ast-lowering-plans.ts`: after the resolver has already joined a direct
call to its exact retained `targetUnitId`, source, declaration, binding, and
signature, `collectIrDirectCallLoweringPlansByIdentity(...)` still rejects
solely because `resolved.legacyProjection !== "unambiguous"`. The exact joins
that follow that check are the structural authority; the global projection
remains ambiguous by design for untouched legacy consumers. The attempted
component census is also currently written too late, inside aggregate lowering
after validation and alias planning. A declined member can therefore disappear
before the route records the whole structural component, and the later overlay
filter cannot prove that it withdrew every sibling. Those vetoes and that late
census are no longer authorities on this route:

- after this checkpoint, `makeMultiIrSafeSelection(...)` treats only exact
  membership in the authenticated preflight component census as the
  cross-source certificate; the current local-use-owner shortcut is not
  authority;
- the identity imported-function resolver publishes `targetUnitId` even when
  its legacy flat projection is ambiguous, while only untouched direct/legacy
  consumers discard the ambiguous projection;
- selector and imported-call planning consume the frozen structural graph and
  retain exact owner/target `IrUnitId`s;
- `prepareMultiPreparedCallableGroup` gives every component unit a unique
  synthetic integration name derived from the deterministic group/unit order,
  rewrites local and imported call references from their exact unit targets,
  and reconciles artifact/terminal evidence back to the unit-keyed maps; and
- post-publication currentness joins `irUnitFuncMap` and
  `ProgramAbiSourceCallableRegistry` by unit. `WasmFunction.name` remains only
  a compatibility/currentness assertion on the exact object, never a lookup.

### Preflight component and attempted-census authority

Run `planExistingRoutes(...)` and Prepared module-init planning first, with
their existing callbacks and bytes unchanged. Only when module init is absent,
and only when `owner.existingRouteUnitIds` is empty, derive immutable aggregate
callable components from the already-frozen program binding graph and planning
identity. Any established dedicated reservation suppresses the entire aggregate
attempted census, including disjoint callable candidates; M1A.3 does not compose
the two owner families. Publish
their complete attempted census immediately before the callable route invokes
its first `safeSelection(...)`; the census is not visible to any earlier
dedicated planner. An explicitly disabled, host, fast, WASI, single-source,
module-init-bearing, or dedicated-route-bearing lane publishes no attempted
callable census and retains its current routing:

1. authenticate every endpoint as an exact external-module top-level function
   with matching source, declaration, binding use, self-owned terminal, and
   target unit;
2. treat exact cross-source graph-use endpoints as anchors, expand them through
   the same per-source undirected local-call closure used by the blocked-owner
   fixed point, then union across the authenticated cross-source edges;
3. retain only components containing an exact cross-source edge and at least
   two sources; do not pull in an unrelated local same-spelled component or an
   unrelated third declaration; and
4. sort components and members by the frozen terminal-inventory order, publish
   the complete union immediately as
   `ctx.irProgramCallableAttemptedUnitIds`, and never add to it later.

`hasMultiIrProgramCallableBoundary(...)` then means exact membership in this
preflight census, with the same external-module/terminal/source joins. Its old
`use.ownerUnitId === unitId` shortcut is not sufficient because source-local
uses also appear in the graph. `isMultiIrProgramCallableCall(...)` must retain
its exact AST-site/import-plan proof and additionally require both resolved
owner and target in the same preflight component. These are the two existing
predicates consumed by `makeMultiIrSafeSelection(...)`, so `src/codegen/index.ts`
remains byte-for-byte read-only while the flat collision/occupied-name/funcMap
bundle is bypassed only for the exact aggregate population.

Aggregate planning consumes those precomputed components; it may not regroup a
filtered candidate subset. A component prepares only when every structural
member survives safe selection and `ownerIsEligible(...)`. Existing-route,
validation, signature, alias-planning, or integration decline leaves the
component's prepared set empty while its complete attempted set remains
published. Assert `prepared ⊆ attempted` before owner registration.
`removeMultiIrAttemptedCallableUnits(...)` removes every attempted identity
from the later ordinary overlay, re-runs source-local blocked-component closure,
and throws an Invariant if closure finds a non-attempted neighbor—the preflight
census then under-approximated the component. Direct legacy bodies remain
authoritative for a declined component; no late partial IR patch is permitted.

### Late-sealed alias, body, and owner publication

The existing aggregate route has a separate failure-atomicity defect that this
promotion makes reachable and therefore must repair in the same checkpoint.
`planAggregateModuleCallableAliases(...)` currently calls the live
`planProgramAbiModuleCallableAlias(...)` before integration. Even if those
aliases are moved into the ordinary Prepared descriptor batch, the current
scope seals and publishes that batch before resolver construction, lowering,
type-index parity withdrawal, terminal-census mutation, and pending-patch
validation. A post-seal failure can therefore retain live module aliases while
every component body falls back. The later
`MultiPreparedProgramOwner.registerCallableComponents(...)` validation is a
second fallible publication boundary and can likewise strand installed bodies
without their exact owner reservation. Neither state satisfies the signed M1A
atomic contract.

Use one late-sealed, one-shot aggregate transaction instead:

1. Replace live module-alias planning with an opaque
   `PreparedModuleCallableAliasDescriptor`. It is derived from the exact frozen
   graph and ordered terminal denominator. It authenticates each canonical live
   source root with `ProgramAbiSession.currentCallableSignature(rootBindingId)`
   and the root allocator's current `FuncTypeDef`; a missing or mismatched root
   contract rejects, and frozen `draft.intent.signature` is never currentness
   evidence. It then builds source -> export -> import chains target-first in a
   descriptor-local provisional overlay: every later hop reads the preceding
   root/provisional callable contract from that overlay and must equal the
   canonical root. Initial scope staging exposes the same chain through the
   claimed overlay lookup, and final `prepareSeal()` repeats it against the
   freshly rebased composite overlay. It produces provisional alias drafts,
   structural-reference keys, and callable contracts, with no allocator locator
   or registry write. Its foreign/forged/replay-resistant lifecycle is exactly
   `fresh -> claimed-by-one-exact-scope -> consumed`: initial stage claims but
   does not consume it; abort, failed final prepare/seal, or successful commit
   consumes it exactly once. User-visible re-stage/replay is fatal.
2. Add `module-callable-aliases` to the existing Prepared Program-ABI batch.
   Its exact alias binding set participates in staged binding closure; an
   otherwise empty structural-request set is legal for this alias-only case.
   The live immediate module-alias planner is deleted so aggregate code has no
   bypass around the descriptor. Initial staging retains the claimed descriptor
   and provisional request rather than consuming either.
3. For the exact `atomicComponent` aggregate lane, derive one complete
   dependency component and begin/stage its Program-ABI scope, but leave the
   scope open. Expose its deterministic component ID and overlay ABI to the
   lower resolver without publishing the batch. Timer/module-init splitting or
   a dependency that cannot be represented and resolved against the open
   overlay declines the whole callable component before any live write. Other
   Prepared lanes retain their present immediate/deferred sealing lifecycle.
   Extend `PreparedProgramAbiScopeLookup` with the exact locator/current-index/
   current-callable-contract operations already required by
   `src/ir/prepared-callable-resolution.ts`, and thread that lookup into
   `makeResolver(...)`. Unit refs keep their exact allocator-slot resolver;
   support/global/type/import refs resolve against the claimed overlay, never
   by querying only the live session. The lookup must reject a locator or
   structural key outside its overlay and must not publish while resolving. A
   provisional module alias authenticates with its own in-overlay structural
   key before canonical-target resolution; the alias ID/key and canonical root
   ID/key must resolve the same current function index, while a crossed or
   foreign key remains fatal.
4. Lower every exact top-level terminal into detached pending patches while
   the scope remains open. Before commit, prove one patch per expected terminal
   and no foreign, duplicate, derived, or missing artifact; exact allocator
   object/type/name/export currentness; exact callable and alias closure;
   complete counted receipts, compiled-artifact rows, terminal evidence, and
   final report census; and all aggregate test mutations, including dropped
   terminal evidence. Resolver, lowering, parity, census, or currentness
   failure aborts the open scope and consumes its descriptor. It leaves bodies,
   aliases, reservations, requested skips, telemetry, and terminal outcomes
   unchanged.
5. Add an aggregate-only
   `compilePreparedProgramComponent(...)` entry in
   `src/ir/prepared-component-publication.ts` whose explicit result is
   `{ report: IrIntegrationReport; pendingReceipt?: PendingPreparedProgramComponentReceipt }`.
   The ordinary `compileIrPathFunctions(...): IrIntegrationReport` API and
   `src/ir/integration-report.ts` remain unchanged. A successful aggregate
   result carries the pending receipt rather than installing live bodies; the
   opaque receipt owns the open scope, detached and prevalidated patches,
   component ID/population, exact report/evidence, and one-shot currentness/
   abort hooks. An Unsupported or failed aggregate returns no receipt, aborts
   its claimed scope/descriptor immediately, and remains direct-owned.
6. After every group has been attempted,
   `MultiPreparedProgramOwner.stageCallableComponents(...)` validates all
   successful receipts against a shadow state and returns one opaque staged
   publication handle. It performs every currently fallible
   `registerCallableComponents(...)` and callable portion of
   `sealBodyBoundary()` check—source/unit/declaration/component identity,
   existing-route/module-init/duplicate exclusion, reservation rows,
   per-source skip names and unit IDs, body plan, prepared-unit set, telemetry,
   and terminal-outcome prefixes—without mutating the owner or `ctx`.
7. `sealBodyBoundary()` may expose the handle's private staged skip projection
   only to the owner's body consumer; it does not publish callable components,
   prepared IDs, reservation rows, telemetry, terminal outcomes, or IR bodies.
   Each source-body visit records its exact skipped unit receipt in that same
   handle. Failed groups were never staged and therefore direct-emit normally.
8. At the end of the final expected body-source visit, preflight the complete
   body-visit/skip census, allocator/type currentness, report evidence,
   unchanged telemetry/outcome target arrays and prefixes, alias descriptors,
   and every open scope. All test mutations run before this point. A mismatch
   is fatal because a direct body may already have been intentionally skipped,
   but still aborts every open token and publishes zero aliases, patches,
   owner rows, committed skip receipts, telemetry, or outcomes.
9. Split the session seal internally into a side-effect-free `prepareSeal()`
   and a session-owned `commitPreparedScopes(...)`. The latter accepts every
   pending successful scope, validates cross-scope terminal/unit/class
   ownership plus exclusive/provisional binding and session/registry write-key
   disjointness and currentness before the first write, then consumes and
   publishes the batches/scopes together. Identical immutable committed entry,
   runtime, support, or import dependencies remain shareable under the existing
   canonical/currentness rules. The ordinary `seal()` path delegates
   through the same primitive with one pending scope; there is no parallel ABI
   model or rollback path. Because initial batch staging snapshots committed
   maps, final `prepareSeal()` must replay the *claimed descriptor parts* over a
   fresh committed/composite planning overlay in canonical scope/part order,
   rebuild all provisional session/registry writes and current contracts, and
   discard the stale initial clone. Disjoint intervening planning—including
   direct-body work—remains legal; an occupied or changed overlapping write key,
   target, locator, or contract rejects before consumption/publication. A
   compilation-global no-intervening-write revision is forbidden.
10. The final commit sequence publishes all prepared scopes, installs the
    prebuilt allocator bodies, and applies the staged owner/body-plan/skip/
    telemetry/outcome writes. After the first live write it performs only
    precomputed object/Map/Set/array assignments: no lookup, validation,
    report-shape assertion, callback that can decline,
    `settlePreparedDerivedCallable(...)`, or recoverable catch is allowed. A
    fault after the first write is a fatal `PreparedProgramAbiCommitError`,
    never component-local continuation or rollback. Overlay planning begins
    only after this final-source commit.
11. Each weak component still owns a separate descriptor/open scope/pending
    receipt. A known precommit failure for A may coexist with a successful B;
    A remains direct and B enters the staged batch. If any staged receipt turns
    stale after its body was intentionally skipped, the whole pending-success
    batch fails fatally and none of its scopes publishes. Once the batch starts
    its first live write, any fault is compilation-fatal rather than permitting
    another component to observe a prefix.

This checkpoint explicitly supersedes the earlier M1A/M1A.1
`preparedBeforeDirectBodies: true` promise **only** for
`routeKind: "cross-source-callable"`. Advance the public body-plan schema to
`multi-prepared-program-body-plan-v2` and make reservations a discriminated
union: existing scalar/array/string/function-value/Fibonacci/module-init routes
retain `preparedBeforeDirectBodies: true` and
`publicationPhase: "before-direct-bodies"`; callable rows instead carry
`stagedBeforeDirectBodies: true`, `committedAfterExactBodySkips: true`, and
`publicationPhase: "after-exact-body-skips"`, with no
`preparedBeforeDirectBodies` field. Before the final-source commit the owner
holds only a private staged boundary/skip plan; it is not returned as the
public body plan and does not appear in audit/context state. If there are no
pending callable receipts, existing routes may finalize the v2 public plan at
the ordinary boundary with their behavior unchanged. The global no-composition
gate above means one program can never require an early public dedicated-route
snapshot plus a later augmented callable snapshot. Update the census,
module-init, and callable tests to prove both discriminants and reject a row
that claims the wrong publication phase.

The detached lowering transaction must be extracted from the already-oversized
integration implementation into a focused
`src/ir/prepared-component-publication.ts`; owner/body/telemetry staging belongs
in `src/codegen/multi-prepared-callable-publication.ts` rather than regrowing
`multi-prepared-program.ts`. `src/codegen/program-abi-session.ts` gains only the
two-phase validation/commit lifecycle above, not rollback or a parallel session
model. Do not solve this with alias deletion, post-failure cleanup, body
rollback, an ABI-first seal, or by turning a post-seal failure into a soft
direct retry.

Accordingly the production and focused-test surface is:

1. remove the collision-helper import, the computed collision set, and the
   `collidingFunctionNames.has(...)` candidate condition/comment from
   `src/codegen/multi-prepared-callable-orchestration.ts`, and make that file
   the single preflight component/attempted-census authority described above;
2. change `src/codegen/multi-prepared-callable-components.ts` to consume the
   immutable precomputed component/census, prepare the module-alias and owner
   publication descriptors, and pass their opaque tokens to the aggregate
   integration entry without any live alias or late attempted-set mutation;
3. remove only the redundant `legacyProjection` ambiguity veto from the exact
   unit-keyed branch of
   `collectIrDirectCallLoweringPlansByIdentity(...)`, retaining its
   target-unit, source, declaration, binding, legacy-name, and signature joins
   in `src/ir/ast-lowering-plans.ts`;
4. add `src/codegen/program-abi-module-callable-alias-planning.ts`, remove the
   live alias planner from `src/codegen/program-abi-planning.ts`, and add the
   opaque alias part to
   `src/codegen/program-abi-prepared-transaction.ts`; bounded extraction into
   `src/codegen/program-abi-prepared-scope-lookup.ts` is authorized when needed
   to keep the transaction facade below the LOC ratchet; the dependency-free
   `src/codegen/program-abi-callable-roles.ts` leaf and the corresponding
   import-only adjustment in `src/codegen/program-abi-provider-planning.ts`
   are authorized so provider evaluation cannot re-enter the aggregate
   transaction graph through the compatibility planner export;
5. add `src/codegen/multi-prepared-callable-publication.ts` and narrow owner
   adapters in `src/codegen/multi-prepared-program.ts` for staged registration,
   body-plan/skip collection, last-source preflight, and the no-throw owner/
   telemetry commit; only opaque transaction interfaces cross into IR through
   `src/codegen/multi-source-ir-integration.ts`;
6. refactor `src/codegen/program-abi-session.ts` so ordinary single-scope seal
   and the aggregate all-scope commit share one side-effect-free prepare phase
   and one prevalidated Map-set-only publisher; the pure aggregate validation
   and write-set planner may live in
   `src/codegen/program-abi-prepared-scope-commit.ts`, leaving the session as a
   thin adapter over its private state;
7. thread each open exact-component scope through
   `src/ir/prepared-component-sealing.ts` and
   `src/ir/compiler-timer-shim-preparation.ts`, and adapt
   `src/ir/integration.ts` through the extracted
   `src/ir/prepared-component-publication.ts` so integration returns detached
   pending receipts and every fallible post-stage path aborts before final seal;
   extend `src/ir/prepared-callable-resolution.ts` to consume the authenticated
   open-scope lookup rather than live-session-only support/global/type state;
8. add the non-vacuous production and failure-atomic regressions to
   `tests/issue-3525-multi-prepared-callable-bindings.test.ts`; and
9. add `tests/issue-3525-prepared-program-abi-aggregate.test.ts` for the new
   alias descriptor, multi-scope commit, forged/duplicate token cleanup, and
   intervening-owner currentness controls, and update
   `tests/issue-3520-lowering-plan-identity.test.ts` so the structural
   collector proves both sides of the boundary: an ambiguous flat projection
   with the exact source-local target succeeds, while a foreign same-spelled
   target still fails on its exact retained-source mismatch; update
   `tests/issue-3525-multi-prepared-program-census.test.ts` and
   `tests/issue-3525-multi-prepared-module-init.test.ts` only for the v2
   publication-phase schema and unchanged existing-route behavior.

The aggregate Program-ABI controls intentionally live in the new #3525 file,
not as edits to `tests/issue-4260-prepared-provider-transaction.test.ts`.
Exact pushed-checkpoint replay on `b545341d02373b` confirms that file already
has two unrelated runtime failures (the GC setter returns `2` instead of `1`,
and the standalone setter binary fails `WebAssembly.validate`) before this
M1A.3 implementation. Leaving the existing file byte-exact prevents those
known baseline defects from hiding or bypassing the changed-root hook while
the six new aggregate controls remain a fully green, non-vacuous gate. The
sixth control distinguishes a genuinely overlapping terminal claim from an
intervening disjoint scope that shares one immutable provider: the former
rejects with the exact duplicate-session-draft ownership diagnostic, while the
latter rebases and commits successfully.

The same detached-checkpoint replay attributes the seven broader route-control
failures to `b545341d02373b`, not to the current M1A.3 bytes: #3214's imported
HOF has the same `===` operand-type build error; #4589 has the same route hash;
#4590 has the same two byte lengths and global index; and #4591 has the same
size ceiling and global index. Current and pushed-checkpoint expected/actual
values match exactly for all seven rows (0 current-slice regressions). Keep
them as explicit upstream/baseline diagnostics, do not relock their hashes,
sizes, or indices in this checkpoint, and rerun after the required main sync.

The first integrated late-publication run exposed one necessary, narrower
consumer adjustment that this lock now authorizes. Because callable terminal
outcomes become public at the final body-source commit (before the unchanged
late overlay audit), `recordObservedIrOutcomes(...)` in
`src/codegen/index.ts` must exclude those exact
`ctx.irProgramCallablePreparedUnitIds` from the `existingOutcomes` input passed
to reconciliation as well as from the already-existing append filter. Without
that input projection, reconciliation diagnoses the intentionally preexisting
committed callable rows as duplicates before the output filter can discard its
redundant rows. The adjustment is limited to that helper and exact unit set;
it does not change selection, lowering, reporting for any unprepared unit, or
the rest of `src/codegen/index.ts`.

The detached-lowering audit also found that the shared integration pipeline
can lazily materialize string/vector/dynamic/exception/runtime helpers,
imports, types, globals, tags, or callable-provider observations before it
creates the aggregate receipt. Those live compatibility writes cannot
participate in M1A.3's rollback-free commit. Until those registries gain
detached allocation, the exact `atomicComponent &&
deferPreparedPublication` entry must perform a read-only preflight before the
first global-preparation helper and admit only allocator-neutral scalar IR:
primitive scalar types, allocation-free numeric/control operations, and exact
unit-bound calls. The same preflight must decline when
`ctx.pendingLateImportShift` is already armed: even a neutral component would
otherwise let callable-provider preregistration flush that earlier live shift
inside the aggregate transaction. Any pending shift, helper-, import-, type-,
global-, tag-, runtime-,
intrinsic-, string-, vector-, dynamic-, exception-, class-, closure-, or
allocation-bearing component returns one typed
`late-preparation-unsupported` failure for every member and remains wholly
direct-owned. Add a `%`/`__fmod` negative control and prove the aggregate
publishes no receipt, alias, body, owner row, reservation, skip, telemetry, or
terminal outcome before that direct fallback.

The allocator-neutral decision must precede AST-to-IR construction, not only
the later global-preparation phase. The build resolver can register vector
types and set codegen feature flags while lowering an array expression, so a
post-build decline is already too late. Add a read-only, default-deny preflight
over the exact selected declarations before `AllocSiteRegistry`, union/vector
resolver, or builder setup mutates `ctx`; admit only the scalar syntax/type
subset the later IR whitelist can lower without helper/type/provider
allocation. Keep the post-build IR whitelist as an independent assertion.
An array/non-neutral mutation must prove unchanged module types, vector maps,
feature flags, imports/providers, and zero prepared publication before direct
fallback; do not implement this with rollback.

That preflight must classify every `Identifier` by its exact declaration and
binding identity. Local variables, parameters, and authenticated unit-bound
call targets may be admitted; a module/global binding may not pass merely
because its syntax is an identifier, since the builder would lower it to a
`global.get` only after allocator setup. Exercise this boundary through a
direct prepared-component harness when the ordinary multi-source route would
be suppressed by module-init population, and prove typed
`late-preparation-unsupported` with the complete live-context snapshot and
publication prefix unchanged.

Likewise, syntax being scalar-looking is not sufficient when lowering needs a
dynamic carrier. Reject a conditional whose two arm types do not normalize to
the same admitted primitive before either arm can be boxed, and reject nullish
coalescing on this lane rather than relying on its post-build non-reference
demotion. Non-vacuous controls must show both forms decline before allocator
site or helper/type creation and leave the complete publication prefix empty.

Final callable currentness must cover the full declaration subtree, not only
the `Block` and top-level `Statement` objects. Snapshot the deterministic
preorder identity of every descendant node for each exact declaration and
compare it immediately before final publication. A nested mutation replacing
a `ReturnStatement.expression` or `BinaryExpression.right` while retaining the
same block/statement identities must fail fatally with a zero publication
prefix. Finally, true `IrInvariantError` failures from prepared overlay lookup
or scope validation remain fatal; only explicit `IrUnsupportedError` may
decline the component to direct ownership. Never relabel an invariant as
`late-preparation-unsupported`.

Apart from the exact `recordObservedIrOutcomes(...)` input projection above,
`src/ir/imported-functions.ts`, the rest of `src/codegen/index.ts`,
declarations, `from-ast.ts`, lowerers/selectors outside the named identity
collector, module init, and unrelated Program-ABI registries are read-only for
this checkpoint.
If the focused regression demonstrates that any other file must change, stop
and amend this plan before editing; do not turn the bounded lifecycle repair
into an opportunistic refactor.

### Positive and negative proof

The positive fixture has three modules and five exact top-level units:

- module A exports `same(value)` and `call(value)`, where `call` invokes A's
  one-argument `same`;
- module B exports another `same(value, delta)` and another `call(value)`,
  where `call` invokes B's two-argument `same`; and
- the entry imports the two `call` bindings under distinct aliases and exports
  `run`, which invokes both.

The entry must not import or call either `same` binding. Its graph has exactly
the two source-local `call -> same` edges and the two cross-source
`run -> callA/callB` edges; any extra entry-to-provider edge invalidates the
test because it bypasses the early admission boundary instead of exercising
the propagated component census.

The deliberately different provider arities make a flat-name or last-wins
target substitution fail ABI reconciliation or runtime parity instead of
accidentally returning the same value. With ordinary standalone,
`nativeStrings: true`, `experimentalIR: true`, and no cutover environment
override, acceptance requires:

- exactly five distinct source-qualified unit IDs reserved and skipped;
- one shared non-null `preparedComponentId` and five `terminal-ir` outcomes;
- two units diagnosed as `same`, two as `call`, and one as `run`, without
  collapsing their unit or source identities;
- exact Program-ABI/allocator object currentness for every unit;
- no matching direct-body audit row; and
- runtime parity with the direct control, including the expected result that
  distinguishes both `same` implementations.

Poisoning direct bodies for `same,call,run` must still compile and run in the
default-on lane. With
`JS2WASM_MULTI_PREPARED_CALLABLE_COMPONENT_CUTOVER=0`, the same poison must
reach the direct route; without poison the disabled lane must retain artifact,
surface, import, and runtime parity. Reversing caller input-map insertion must
preserve the unit set, structural call targets, component membership, and
runtime result; source evaluation order remains the existing ordered-source
authority and is not re-sorted by this test.

Add or retain fail-closed controls for:

- a same legacy spelling paired with a foreign unit ID at the body-routing
  boundary;
- an ambiguous legacy projection whose exact local retained unit/source joins
  succeeds, paired with a same-spelled foreign retained unit that fails on the
  later source-identity join rather than on flat-name ambiguity;
- a cloned/wrong-owner call node or wrong target unit in the structural graph;
- a provider or caller shaped for an established scalar/array/string/function-
  value/Fibonacci route, proving that route's unchanged pre-census selection
  wins and the aggregate attempted census remains wholly absent; pair it with a
  *disjoint* successful dedicated route plus otherwise valid five-unit callable
  candidate and prove the global no-composition gate still leaves every
  callable candidate direct-owned;
- one wrong-arity same-spelled call/target planning shape (typed Unsupported or
  pre-admission direct-only decline, with no Prepared prefix), paired with a
  retained-target or `signaturesByUnitId` mutation that remains a fatal
  exact-identity Invariant with no prefix; and
- one member that cannot be planned or lowered, proving no sibling body,
  reservation, alias, terminal outcome, or skip is committed before the exact
  component decision.

The wrong-arity/unplannable/integration-failure cases must each prove the
complete accounting: attempted is exactly five, prepared is zero, all five
exact unit IDs retain direct legacy entries/dispositions/outcomes, and no
prepared artifact, alias, reservation, terminal-ir outcome, or body skip
survives. Add mutations for a dropped attempted member, a foreign attempted
unit, wrong owner/target, prepared-not-attempted, and an under-covered local
neighbor; all are fatal before publication. A same-spelling local component
with no cross-source anchor and an unrelated third same-spelled unit must stay
outside the attempted census.

The late-publication harness must inject failures at alias staging, scope-seal
preparation, resolver construction, first/middle/last lowering, type-index
parity, final report/terminal census, owner registration, body-plan reservation,
and final source-skip preflight. Mutate a missing, duplicate, or foreign skipped
unit; a wrong or duplicate owner source/unit; an existing outcome unit/key; a
changed compiled-function or outcome-array prefix; a stale allocator; and a
stale second scope in a two-component batch. Every rejection before the first
live write must compare the full snapshot and prove zero new alias draft,
patched body, sealed scope, owner component, reservation, committed skip,
prepared-unit ID, compiled telemetry row, or terminal outcome. Positive proof
must show that none of those fields is public before the final source visit and
all appear together immediately after it.

Add two disjoint callable components and exercise A-fail/B-success and
A-success/B-fail, plus a two-success batch whose second pending scope is made
stale immediately before commit. Known component-local failures retain direct
bodies for only the failed component; the healthy component publishes once.
The stale pending-success batch is fatal after its staged skips, but neither
scope/body/owner prefix may become live. Reverse component and map insertion
order without changing canonical IDs, scope order, or evidence.

The #4260 transaction suite separately proves the opaque module-alias
descriptor and two-phase session primitive: overlay invisibility before
commit; exact abort snapshot; successful target-first canonical
source -> export -> import alias closure;
ordinary one-scope `seal()` equivalence; and forged, foreign, replayed, stale,
wrong-terminal/order/source/target/signature, cycle, duplicate, dropped, and
locator-owning mutations. Cross-scope terminal/unit/class ownership,
terminal-owned or provisional alias binding overlap, and session/registry
write-key overlap must reject before either scope consumes or publishes;
identical immutable committed entry/runtime/support/import dependencies are a
positive shared-dependency control. Apply a type-layout remap after initial
claim and prove final alias comparison uses
`currentCallableSignature(...)` plus the live allocator type, while a frozen
draft signature cannot pass. Add an unrelated ABI/registry plan between stage
and `prepareSeal()` as a successful rebase control, a colliding plan as a
zero-write rejection, and explicit second-stage/second-prepare/second-abort/
post-consumption replay failures. Drop or alter the export hop's provisional
contract independently of the root and import hops; both mutations must reject
against the canonical root before publication.

Treat the pending-scope collection itself as untrusted input. Authentication
must record each recognized scope in caller-owned cleanup state before it
advances to the next iterator element or array property. If iteration or
property access throws after yielding one valid scope, the outer failure path
must abort that scope and make a later commit impossible. Add a throwing
iterator/array-proxy mutation that yields one valid pending scope before the
fault; a forged-token-only mutation does not cover this collection boundary.
No `length` or other caller-controlled collection property may be read before
that protected one-pass authentication; pair the iterator fault with a proxy
whose `length` getter throws but whose explicit iterator yields the valid
scope.
The public `prepareSeal(scopes)` adapter has the same rule: it may not re-read
the caller collection to discover what its first pass prepared. A stateful
iterator that yields and prepares one scope before throwing must still leave
that exact scope aborted even when a second iterator acquisition would throw
again.

An unsupported member may make the component ineligible before integration;
that is acceptable only when every would-be member retains one direct terminal
outcome and the poison/control pair proves no partial Prepared prefix. An
Invariant remains fatal and likewise may not publish a prefix.

### Preserved boundaries and validation

Host, fast, WASI, module-init-bearing, class/closure/function-value, mutable,
async/generator, dedicated-owner, and single-source families remain on their
current routes. The legacy resolver's ambiguous-name projection stays for
those direct consumers. Do not delete `collectMultiIrFunctionNameCollisions`
itself while other callers remain, change synthetic-name compatibility, or
weaken exact signature/component/currentness assertions.

Run the focused #3525 callable-binding suite with the direct-body poison,
`issue-3525-multi-prepared-program-census`, #3214 imported HOF, #2138
multi-module overlay, multi-file equivalence, and the existing dedicated-route
controls. Run TypeScript 7 and 5, Prettier/Biome, `check:ir-fallbacks`, issue
integrity, and the ordinary IR layering/dialect/readiness ratchets. Before
every commit, under a finite non-negative one-minute load strictly below
`logical cores - 2`, run both LOC and function regrowth ratchets immediately
before committing. Let the complete precommit and prepush hooks run without
bypass. No baseline, LOC, function-size, binary-size, or hook exception is
authorized.

The post-sync quality runs moved the existing `forof.string` neutrality
evidence in `src/ir/integration.ts` from line 5146 first to line 5929, then to
its final post-repair line 6001, as a direct consequence of this checkpoint's
bounded integration growth. Regenerating the neutrality evidence with
`check:ir-kind-neutrality -- --update-on-decrease` changes only that evidence
locator and the generated date (2026-08-29 to 2026-08-30) across the two parsed
JSON updates: all 85 kind verdicts and the 55 neutral / 27 JS / 3 unresolved
counts remain unchanged, and no verdict grew. This is an exact
evidence-pointer refresh, not a new neutrality allowance or regression
baseline.

Luna Max owns only the production/test surface explicitly named above on branch
`codex/3525-m1a3-same-spelling-callables`; the plan remains root-owned and no
unlisted file may be edited without a Sol plan amendment. Before the PR leaves
draft, a separate independent Sol—never the Luna implementer—must review the
exact pushed head SHA and confirm the positive matrix, negative mutations,
two-phase zero-prefix proof, unchanged route boundaries, and absence of overlap
with the parallel Claude IR session. Any subsequent push invalidates approval
and requires a fresh exact-SHA Sol review. A mergeable, all-green,
exact-SHA-approved PR is ready; a real blocker keeps it draft.

## M1A.4 implementation lock — anonymous-default alias matrix (2026-08-30)

This Sol-authored continuation is grounded on the independently approved and
queued M1A.3 head `b5ac306abe11bec01195416dec14e14cdbfbd1fa`
(PR #5275) and protected `origin/main`
`c243892c7f3a757bdecf6215626b08586ce72c58`. Develop it only on the separate
stacked branch `codex/3525-m1a4-callable-alias-matrix`; never push or rewrite
the queued parent. After #5275 lands, rebase or merge refreshed main into this
branch under the normal signed workflow and repeat the exact-file collision,
focused, ratchet, hook, and Sol-review evidence before publication.

The parallel Claude lane owns the dirty #3521/#4617 checkout. Open PR #5218
owns `src/codegen/index.ts`, `src/ir/from-ast.ts`, `src/ir/select.ts`, and its
vector/type-planning surface; #5238/#5269 own #3523 files. This checkpoint may
not edit those paths and introduces no second issue or alias resolver.

### Current structural authority and exact missing root

`buildIrProgramCallableBindingGraph(...)` already freezes source,
`import-alias`, and `export-alias` records and resolves the complete checked
fixture in `ALIAS_FILES`: renamed imports, an anonymous default export/default
import, namespace property calls, a chained re-export, `export *`, and a local
same-named shadow. The graph unit test proves exact target `IrUnitId`s and
order independence, but the production callable route is tested only with
named declarations.

The remaining exclusion is not the alias graph. It is the legacy function-name
projection before aggregate selection:

- `planIrCompilationByIdentity(...)` records every unnamed declaration as
  `unnamed`, even when the exact terminal is an anonymous
  `export default function` whose inventory label is the direct compiler's
  canonical `"default"`;
- `planIrOverlayByIdentity(...)` and
  `buildIrExactFunctionClaimIndex(...)` require
  `declaration.name?.text === legacyName`;
- `ownerIsEligible(...)`, callable preflight/currentness, and
  `MultiPreparedProgramOwner.stageCallableComponents(...)` repeat the same
  named-only predicate; and
- preflight currently builds components from already-projected source plans,
  so the missing default root disappears before the immutable attempted census
  can prove its whole alias-connected population.

The direct declaration compiler already registers and compiles an anonymous
default function under `"default"`, and its body-routing seam also carries the
exact declaration `IrUnitId`. Therefore M1A.4 is an authority transfer for one
existing body, not new syntax support and not permission to treat arbitrary
anonymous functions as top-level callables.

### One exact declaration identity

Add one frontend-neutral helper in
`src/ir/top-level-function-identity.ts` that returns the compatibility name for
an exact top-level body-bearing `FunctionDeclaration`:

1. a named declaration returns its identifier text;
2. an unnamed declaration returns `"default"` only when it has both `export`
   and `default` modifiers and its parent is the exact `SourceFile`; and
3. every other anonymous, ambient, nested, bodyless, copied, or malformed node
   returns `undefined`.

Use that helper everywhere this checkpoint crosses the body-skip compatibility
projection: `src/ir/select-identity.ts`,
`src/codegen/ir-overlay-identity.ts`,
`src/codegen/ir-overlay-safety.ts`,
`src/codegen/multi-prepared-callable-orchestration.ts`, and the callable
component validation in `src/codegen/multi-prepared-program.ts`. Do not infer a
default root from display text, export table contents, checker symbol names, or
array position. A named declaration's behavior remains byte-for-byte the same.

Anonymous-default admission is callable-component scoped. Extend the identity
selector with one exact optional predicate supplied by
`programCallableSelectionOptions(...)`; it may admit the default unit only when
`hasMultiIrProgramCallableBoundary(...)` authenticates that unit in the frozen
attempted census and the declaration helper returns `"default"`. With no
census, on single-source/host/fast/WASI/disabled/dedicated lanes, or for an
unanchored anonymous default, the existing `unnamed` outcome remains unchanged.
Do not enable anonymous defaults globally in the ordinary per-source overlay.

### Graph-first attempted census and fresh callable plans

Break the current projection cycle without introducing a second graph:

1. Derive preliminary components from the frozen callable graph's exact source
   records and uses plus the identity inventory, not from
   `functionClaimsByUnitId`. Source-local and cross-source edges both come from
   the same graph. Authenticate source/declaration/unit/terminal/reverse joins,
   require at least one cross-source edge and two sources, retain unanchored
   units outside the component, and preserve terminal-inventory ordering.
2. Publish the complete immutable attempted/component census before planning
   any callable source. Existing dedicated-route planning still runs first;
   if it owns any unit, retain M1A.3's global no-composition return and publish
   no callable census.
3. Re-plan only the component's sources after census publication through a
   callable-specific cache refresh. Earlier exploratory plans used by the
   dedicated-route probe are not authority and may not be reused. Sources
   outside the attempted census keep their existing cached plan. No change to
   `src/codegen/index.ts` is needed: its existing spread of
   `programCallableSelectionOptions(...)` carries the new exact predicate.
4. Require every graph member to appear in the refreshed plan's exact claim and
   safe selection before aggregate preparation. Any missing default, named
   sibling, signature, source, declaration, or call plan declines the whole
   component while the complete attempted census remains visible and the later
   ordinary overlay restores direct ownership for every member.

The compatibility name `"default"` is permitted only after the exact UnitId
and declaration checks above. Body skipping, receipts, currentness snapshots,
Program-ABI roots, outcomes, and route audit continue to join by UnitId. A bare
name set is the final direct-compiler projection, never aggregate ownership.

### Alias publication and positive proof

Promote the existing `ALIAS_FILES` graph fixture unchanged to the production
standalone route. Its exact Prepared component is five units across three
sources:

- `a.ts`: `same` and the anonymous default function;
- `b.ts`: its distinct `same` plus `invoke`; and
- `entry.ts`: `entry`.

The unused `a.ts` function `only` and every alias rooted at it remain outside
the attempted/prepared terminal set. For the five selected roots, derive the
expected alias denominator directly from the frozen graph: every non-source
record whose `targetUnitId` is selected, in target-first source -> export ->
import order. The opaque descriptor and committed Program ABI must contain
exactly those binding IDs, alias kinds, sources, structural keys, targets, and
canonical roots; no alias owns a locator or slot, and every alias resolves the
same final function object/index as its canonical source root.

With the direct-body poison covering `default`, `same`, `invoke`, and `entry`,
the candidate must still compile, publish five terminal-IR outcomes in one
component, leave no direct route-audit entry for those units, exclude `only`,
and execute `entry(5) === 132`, equal to the cutover-disabled direct control.
Reversing source insertion order must preserve graph records/uses, component
ID, reservation order, alias IDs/order, runtime value, and canonical evidence.
Binary equality remains observational rather than an acceptance requirement.

### Fail-closed matrix and preserved boundaries

Extend focused mutations so each of the following produces zero live alias,
body, reservation, committed skip, telemetry, or terminal-outcome prefix:

- attempted census drops/repeats the anonymous default or assigns it to a
  foreign component;
- the default declaration loses `export`, loses `default`, gains a name after
  preflight, is replaced/copied, or changes any nested body node before final
  publication;
- a selected alias is missing, duplicated, points to `only`, crosses source or
  kind, changes structural key/signature/canonical root, or owns a locator;
- refreshed planning omits the default claim or returns a stale pre-census
  plan; and
- the direct body reports a skipped `"default"` name with the wrong/missing
  UnitId.

Reuse the existing census, declaration-currentness, descriptor, aggregate
scope, and body-routing seams where they can prove these mutations
non-vacuously. Add only a narrow named seam when no existing mutation can reach
the production check; unknown seam values fail closed. Do not weaken the
existing mutable/value-escaped/optional/dynamic/overloaded declines.

Named-only M1A.3, two disjoint callable components, helper-bearing controls,
and the dedicated-route no-composition control must remain exact. Host, fast,
WASI, module-init-bearing, single-source, class/closure/function-value,
async/generator, mutable, and unanchored/default-only programs publish no new
attempted census and retain their current route/outcome counts. Do not compose
with an existing Prepared owner, widen arbitrary function expressions, delete
legacy alias copying, or change public export semantics in this slice.

### Authorized surface and validation

The authorized implementation surface is:

- new `src/ir/top-level-function-identity.ts`;
- `src/ir/select-identity.ts`;
- `src/codegen/ir-overlay-identity.ts`;
- `src/codegen/ir-overlay-safety.ts`;
- `src/codegen/multi-prepared-callable-orchestration.ts`;
- the callable-component validation only in
  `src/codegen/multi-prepared-program.ts`; and
- `tests/issue-3525-multi-prepared-callable-bindings.test.ts`.

The plan file remains root-owned. Any need to edit `src/codegen/index.ts`,
`src/ir/from-ast.ts`, `src/ir/select.ts`, Program-ABI transaction modules, or a
new production path is a stop-and-amend condition for Sol, not implied scope.

Run the focused #3525 callable-binding and prepared Program-ABI aggregate
suites, M1A.3's route controls, #3214 imported HOF, #2138 multi-module overlay,
and multi-file equivalence. Run TypeScript 7 and 5, Prettier/Biome,
`check:ir-fallbacks`, issue integrity, IR layering/dialect/readiness, and the
ordinary oracle/dead-export/coercion ratchets. Immediately before every commit,
under a finite non-negative one-minute load strictly below
`logical cores - 2`, run both LOC and function regrowth ratchets. Let complete
precommit and prepush hooks run without bypass; no baseline, LOC, function,
binary-size, or hook exception is authorized.

Luna Max may implement only this surface. Before the stacked PR leaves draft,
a separate independent Sol must review the exact pushed SHA and return
**APPROVE** for the graph-first denominator, anonymous-default scoping, exact
alias closure, zero-prefix mutation matrix, parent ancestry, and non-overlap
with the parallel Claude lane. Any later push invalidates approval. A mergeable,
all-green, exact-SHA-approved PR is ready; a real dependency or failed gate
keeps it draft.

### M1A.4a landing correction — named-default alias census first

Static implementation review found two prerequisites that the M1A.4 lock had
incorrectly treated as already available. The structural propagation and
selector paths still require a name-bearing declaration, while the aggregate
lowerer dispatches a namespace property call before consulting its certified
imported-call plan. A temporary rename of the checker-owned AST, a detached
hybrid declaration whose children retain another parent, or a temporary
rewrite of a property-access call is not an authorized identity adapter.
Deleting a cached source plan and rebuilding it after census publication is
also not safe: exploratory planning may already have appended public
post-claim diagnostics, so cache invalidation does not roll back every
observable effect.

The pure propagation seam belongs to `src/ir/propagate.ts`, which the parallel
#3521/Claude lane has reserved for its linked-parser pre-claim repair. The pure
namespace-call seam belongs to `src/ir/from-ast.ts`, currently owned by open PR
#5218. Do not edit either file, coordinate around its owner with a second
implementation, or land any live-AST projection. Full anonymous-default and
namespace-call M1A.4 remains required after those owners land and Sol refreshes
the plan against their exact main ancestors.

The immediately dispatchable checkpoint is therefore M1A.4a: transfer the
attempted callable denominator from source-plan projection to the frozen
binding graph for a completely named alias matrix. Use a new focused fixture,
leaving `ALIAS_FILES` unchanged as the graph-only anonymous-default/namespace
oracle:

- `a.ts` exports `same`, unanchored `only`, a **named**
  `export default function defaultFn`, and `same as renamed`;
- `b.ts` default-imports `defaultFn`, imports `same as localSame` and
  `renamed as reexported`, re-exports `renamed as chained`, performs
  `export *`, declares its distinct `same`, and declares `invoke` whose body is
  `localSame(value) + defaultFn(value) + reexported(value)`;
- `entry.ts` imports `invoke as call`, `chained`, and `same as entrySame`, then
  returns `call(value) + chained(value) + entrySame(value)`.

For input `5`, both direct and candidate builds return exactly `127`. The exact
Prepared component remains five units across three sources: `a.same`,
`a.defaultFn`, `b.same`, `b.invoke`, and `entry.entry`. `a.only` remains outside
the attempted, reserved, skipped, and outcome populations. Reverse source
insertion order must preserve the graph records/uses, component ID, terminal
order, alias descriptor order, route audit, and runtime value.

Derive preliminary connected components only from the frozen graph's exact
source records and call uses, authenticated against source/declaration/unit/
terminal/reverse joins. Use the same graph for source-local and cross-source
edges, require at least one cross-source edge and two sources, discard groups
without an exact cross-source anchor, exclude unanchored units, and sort the
surviving group by terminal-inventory order. Dedicated-route planning retains
M1A.3 precedence: any existing Prepared route publishes no callable census and
cannot compose with this checkpoint.

Publish the immutable attempted/component census before accepting any callable
candidate. Because every M1A.4a declaration is named, reuse the existing
name-invariant cached overlay plans; do not delete or rebuild a source plan and
do not add a post-census propagation/selector exception. Reconcile every graph
member against its exact cached claim, safe selection, declaration, terminal,
source, and call plan. A missing or unsafe member declines the whole original
component; it never regroups the surviving subset or shrinks the attempted
denominator.

For the selected five roots, freeze the exact non-source alias records already
represented by the graph, in target-first source -> export -> import order.
Prove binding ID, kind, source, structural key, target UnitId, canonical root,
and final function identity/index equality. No alias owns a locator or slot.
This checkpoint covers the named default import, renamed import, chained
re-export, `export *`, and same-name shadow. It deliberately contains no
namespace property invocation; namespace records/uses remain asserted in the
unchanged graph-only `ALIAS_FILES` tests until the pure lowerer seam lands.

The direct-body poison names `defaultFn`, `same`, `invoke`, and `entry`. The
candidate must publish one five-terminal component, five terminal IR outcomes,
zero direct route-audit entries for those units, and no `only` evidence.
Mutations must fail with zero live alias, body, reservation, committed-skip,
telemetry, or terminal-outcome prefix when the graph-first census drops,
duplicates, or foreign-assigns a selected unit; includes `only`; loses a
source/cross-source edge; or when a selected alias is missing, duplicated,
retargeted, changes kind/source/structural key/canonical root, or owns a
locator. Preserve the named-only M1A.3, disjoint-component, helper-bearing,
dedicated-route, host/fast/WASI/disabled/single-source, and unanchored controls.

M1A.4a implementation ownership is reduced to:

- this issue record;
- `src/codegen/multi-prepared-callable-orchestration.ts`; and
- `tests/issue-3525-multi-prepared-callable-bindings.test.ts`.

Remove every current exploratory change from
`src/ir/top-level-function-identity.ts`, `src/ir/select-identity.ts`,
`src/codegen/ir-overlay-identity.ts`, `src/codegen/ir-overlay-safety.ts`, and
the callable validator in `src/codegen/multi-prepared-program.ts`. The new
identity helper must not exist in the M1A.4a diff. No source-plan cache refresh,
live/detached AST projection, selector widening, propagation widening, or
namespace-call rewrite is part of this checkpoint.

Run the focused callable-binding and prepared Program-ABI aggregate suites,
M1A.3 route controls, #3214 imported HOF, #2138 multi-module overlay, and
multi-file equivalence. Run TypeScript 7 and 5, Prettier/Biome,
`check:ir-fallbacks`, issue integrity, IR layering/dialect/readiness, and the
ordinary oracle/dead-export/coercion ratchets. Run LOC and function regrowth
ratchets immediately before every commit under the strict finite,
non-negative, one-minute load gate below `logical cores - 2`; keep every
precommit and prepush hook enabled. The stacked PR remains draft until an
independent Sol approves its exact pushed SHA; any later push invalidates that
approval.

#### M1A.4a selector-compatible default-alias fixture amendment

The first focused run established that the current selector rejects the
modifier form `export default function defaultFn` as `non-export-modifier`
before the graph-first callable census can consume its cached claim. Do not
widen the selector for this checkpoint. Express the same named default binding
through the already-supported declaration-plus-alias form in `a.ts`:

```ts
function defaultFn(value: number): number { return value + 2; }
export { defaultFn as default };
```

Keep every other fixture edge and oracle unchanged. The default import in
`b.ts` must still resolve through an exact non-source export/import alias chain
to the `a.defaultFn` source record, and the five-unit component, runtime value
`127`, alias order, reverse-source stability, zero-prefix mutations, and
exclusion of `a.only` remain mandatory. This syntax adjustment is not
permission for selector/propagation changes, AST projection, cache rebuild, or
additional production-file ownership.

#### M1A.4a Sol review correction — two-way call evidence and mutation boundary

The first independent Sol review found two real completeness gaps. A source
record may enter the graph-first member set only while its exact declaration
still has a body; reassert that fact during preflight and final currentness so a
bodyless/removed body cannot contaminate the attempted denominator. Reconcile
call evidence in both directions before preparation: every selected graph-local
use must appear in its owner's exact cached `localCallees`, and every selected
cross-source use must have an `importedCalls` row at the identical call node
with the same owner and target unit and the same graph binding/canonical join.
The existing plan-to-graph scan remains necessary and is not a substitute.

Add non-vacuous zero-prefix mutations for removing a staged body, hiding one
selected local call plan, hiding one selected imported call plan, and adding
the exact unanchored `a.only` unit to the public attempted projection. Preserve
the existing drop, foreign, source-local-neighbor under-coverage, declaration
subtree, publication, and stale-scope mutations. Reverse-source validation must
compare the exact ordered reservation/unit/component projections, not Sets.
For each published alias, prove the final index and allocator object equal the
canonical root and that its locator lookup aliases the root rather than owning
an independent locator.

The broader raw graph/alias-corruption list in the preceding lock is corrected
for this two-file landing surface. `IrProgramCallableBindingGraph` records and
uses are already frozen by the checker-owned builder, while alias structural
keys, locator sharing, and opaque descriptor lifecycle are constructed and
validated inside `program-abi-module-callable-alias-planning.ts`. Injecting
missing/duplicate/retarget/kind/source/key/canonical-root/locator corruption
non-vacuously would require editing that Program-ABI owner (or the checker graph
builder), which is not authorized here and is being exercised by the inherited
`issue-3525-prepared-program-abi-aggregate` and Program-ABI alias invariant
tests. Do not add a vacuous orchestration switch that rejects every replacement
object by identity. Carry those low-level mutation additions to the next
checkpoint that owns the alias planner. M1A.4a must instead keep those suites as
controls and land only the body/call-plan/public-census mutations above.

## M2 implementation lock — single-contributor multi-source module init (2026-08-27)

The first bounded multi-source module-init owner is a single-contributor lane.
The program has more than one source, exactly one source has an executable
module-init plan, and every other source has an empty plan. The contributor
keeps its existing source-qualified module-init `IrUnitId`; this checkpoint
does not mint an aggregate program unit. `MultiPreparedProgramOwner` owns its
reservation, preparation receipt, exact body skip, telemetry, and final
startup wiring. An accepted build must execute with zero direct
`compileModuleInitBody` roots.

The initial rollout is opt-in only when
`JS2WASM_MULTI_PREPARED_MODULE_INIT_CUTOVER=1`. Unset, `0`, `false`, and every
other value preserve the current route. Eligibility reuses the existing R4
exact lexical module-init selector without widening it and additionally
requires all of the following:

- experimental IR, IR-first, multi-source, non-fast, and non-WASI execution on
  an already-supported host or native-first standalone invocation lane;
- one immutable module-init plan for every source, with exactly one executable
  plan and no gaps, static effects, live-function seeds, top-level throws, or
  fabricated empty-source terminal outcomes;
- an exact contributor unit from
  `identityContext.moduleInitUnitIdBySourceFile`, with matching terminal kind,
  source, canonical/semantic order, declaration order, TDZ cells, binding IDs,
  and export targets;
- no cross-source read, write, call, capture, callable-component dependency,
  closure, class, static initializer, reassigned live function, or late
  import/helper/type-registry mutation; and
- one exact preallocated `[] -> []` ABI callable resolved with
  `functionForUnit()` and `handleForUnit()`, never `firstFunction()` or
  `firstHandle()`.

The source-plan vector and body-visit vector remain in `multiAst.sourceFiles`
semantic order. Canonical order is recorded independently and may not be used
to reorder execution. Empty sources participate in the plan census but have no
reservation, body skip, direct module-init root, or synthetic IR outcome. Two
executable source plans, all-empty plans, and every unsupported effect reject
the capability before reservation and retain current direct behavior.

Implementation adds `src/codegen/multi-prepared-module-init.ts` as an adapter
over the existing module-init planner, verifier, and IR lowering. It freezes
the source-local plans, selects the contributor, rejects cross-source effects,
preallocates the exact ABI slot, and prepares the body atomically before the
owner seals its body boundary. It must not introduce a second semantic planner.

`src/codegen/multi-prepared-program.ts` gains a distinct `module-init` route,
reservation, registration receipt, exact skip assertion, and startup
finalization contract. Module init is not represented as a callable component.
`src/codegen/multi-prepared-body-skips.ts` and
`src/codegen/declarations.ts` carry a source-local exact-unit handoff and a
prepared module-init mode that runs neither direct pass, allocates no second
callable, preserves the prepared body, and records the contributor skip.
Missing, duplicate, late, source-mismatched, or unit-mismatched handoffs are
fatal invariants after reservation; direct fallback is forbidden once a body
has been skipped.

Preparation reuses `lowerFunctionAstToIr` with `moduleInitUnit: true`, the exact
owner unit, contributor-local module bindings, exact global IDs,
`atomicComponent: true`, `sealPreparedComponents: true`, and only the
contributor as an integration source. The integration report must contain one
exact prepared terminal and no errors before any skip is installed. Typed
`Unsupported` before reservation is recoverable; partial state, changed ABI or
body evidence, a post-seal direct root, or a duplicate startup adapter is an
`IrInvariantError`.

`planMultiPreparedProgramEarlyRoutes()` performs this transaction after the
complete declaration/import/global/ABI census and before the first source body
visit. Finalization attaches exactly one deferred `__module_init` export or one
start function from the exact retained handle and may repair shifted indices,
but may not rebuild the body. The existing rule that disables M1A callable
components whenever module-init population exists remains load-bearing; the
two Prepared ownership systems do not compose in this checkpoint.

Acceptance lives in a new
`tests/issue-3525-multi-prepared-module-init.test.ts` and proves both contributor
directions, all-empty and two-executable rejection, TDZ/export behavior,
runtime A/B parity, exact source/unit/order/ABI mutation failures, and callable
component disjointness. `JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY=1` must
succeed only for an accepted Prepared route; the disabled route with the same
poison must expose direct reachability. Evidence reports total, empty, and
executable source plans; Prepared reservations; direct roots; IR and legacy
module-init outcomes; and callable-component reservations. Adjacent #3523,
#2138, #3505, #3525 census, multi-file, equivalence, typecheck,
`check:ir-fallbacks`, issue integrity, and LOC-budget gates remain required.

## M0.1 repair lock — telemetry-only owner lifecycle (2026-08-28)

Current `main` creates the shared identity context, `ProgramAbiSession`, and
`MultiPreparedProgramOwner` when either `experimentalIR` or
`trackIrOutcomes` is enabled. `makeIrPlanningAuthority`, however, is absent in
the telemetry-only lane (`experimentalIR: false, trackIrOutcomes: true`), so
`planMultiPreparedProgramRoutes` returns without sealing the owner. The first
body visit then fails with
`multi-prepared-program:completion-order: owner is collecting, expected
body-boundary-sealed`. This is a production lifecycle defect in the M0 owner,
not a reason to weaken the #4590 benchmark-loop test or to make telemetry an IR
selection authority.

The repair must remain outside `src/codegen/index.ts`, which is concurrently
owned by the in-flight Deno integration PR. Exact production implementation
ownership is limited to:

- `src/codegen/multi-prepared-program.ts`;
- `tests/issue-3525-multi-prepared-program-census.test.ts`; and
- this issue record.

The mandatory changed-root lane also exposed obsolete current-`main` physical
pins in the otherwise-green #4590 and #4591 suites. This checkpoint may carry
only their separately documented pin maintenance in the two owning issue files
and tests; those validation-only edits must not weaken or dynamically derive
any semantic, body, artifact, Program ABI, or runtime expectation.

`createMultiPreparedProgramOwner` must immediately seal the ordinary no-route
body boundary only for the exact telemetry-only mode:
`trackIrOutcomes === true && experimentalIR !== true`. The resulting frozen
body plan must contain the complete source/terminal denominator, semantic body
visit sequence, zero reservations, every terminal in
`unreservedTerminalUnitIds`, and an empty overlay visit sequence. It must then
accept each direct body visit exactly once, seal `routes-complete`, bind the
exact `ProgramAbiSession.publish()` result, and publish the ordinary M0 audit.
It must not run a route planner, create a Prepared component, skip a direct
body, visit an overlay, or synthesize an IR outcome.

All other modes retain their existing lifecycle:

- `experimentalIR: true` remains collecting until the existing route
  orchestration plans candidates and seals the boundary, including fast,
  disabled, Unsupported, and zero-reservation cases;
- neither option enabled still creates no identity/session/owner; and
- repeated or late planning/registration against the telemetry-only sealed
  owner fails closed through the existing state machine rather than reopening
  collection.

The focused production regression must compile a real multi-source fixture
with `experimentalIR: false, trackIrOutcomes: true` and prove: no fatal
completion-order error; exact body-source census; zero overlay visits and
reservations; all units unreserved; direct-only outcomes/legacy body evidence;
and artifact, imports, public surface, and runtime parity with the same direct
compile without telemetry. A direct-body poison is the non-vacuity control: it
must reach the named direct body and report that poison, never stop first in
owner lifecycle validation. A companion `experimentalIR: true` control must
still require normal route planning and must not be pre-sealed by the factory.
Direct owner mutations must reject a body visit before sealing, a second or
out-of-order visit, a late route/component/module-init registration, and
publication before `routes-complete` with the existing stable invariant codes.

No baseline, binary-size, LOC, function-size, or hook exception is authorized.
Before the signed commit and push, sample the finite, non-negative one-minute
load and require it to be strictly below `logical cores - 2`; run the focused
#3525 census and #4590 benchmark-loop suites, TypeScript 7 and 5 checks, IR
fallback/layering/dialect/optimization gates, then the LOC and function
ratchets immediately before committing. Let the complete precommit and
prepush hooks run without bypass. Open the PR ready only after the branch is
mergeable; otherwise keep it draft until the exact blocker is removed.

### M0.1 implementation checkpoint

`createMultiPreparedProgramOwner` now constructs the ordinary owner and seals
its no-route body boundary immediately only for
`trackIrOutcomes: true, experimentalIR: false`. The production regression
proves the frozen two-source/two-terminal denominator, zero reservations and
overlays, all terminals unreserved, exact direct `inc`/`run` body-route rows,
empty requested IR outcomes, byte/WAT/import/export/runtime parity with the
untracked direct compile, and the exact direct-body poison failure. Separate
factory and state-machine mutations prove that the ordinary IR route remains
collecting and that pre-seal visits, repeated visits, late route/callable/
module-init registration, and early publication still fail closed.

On refreshed `main` at `48abcb949c9d1b539cb58472256e4545cacd9dc8`, the
focused census is 17/17 passing with exact empty error lists on both clean
production controls. The complete #4590 benchmark-loop suite is restored to
21/21 after preserving its exact semantics and maintaining only the measured
raw binary delta (28 rather than 35 bytes) and direct trampoline/cache slots
(290/136 rather than 252/129). The adjacent #4591 Fibonacci-pair suite is
restored to 27/27 after maintaining only its direct cache slot from 135 to 136;
its direct trampoline remains 291. The exact pin rationale and unchanged
authority assertions live in the respective #4590 and #4591 issue records.

## Ownership and resolution invariants

- Build the whole source census, module graph, ABI, signatures, classes,
  globals, module-init entries, and support intents before any source body is
  emitted. No source may become prepared because an earlier source's legacy
  emitter populated a map.
- Keep canonical structural identity/order distinct from observable module
  evaluation ordinals. Reordering internal maps or side-effect-free disconnected
  units may not perturb IDs; side-effectful disconnected roots retain caller
  order, while cycles use explicit stable SCC/TDZ order.
- Resolve imports and re-exports through checker identity plus `IrBindingId`,
  never by copying entries between `funcMap`, `closureMap`, or
  `moduleGlobals`. Namespace access is a typed module binding, not a string
  alias scan.
- Two files may declare the same display name, two script files may contribute
  globals, and a local declaration may resemble a synthetic helper name. They
  remain distinct unless the language binding graph intentionally aliases
  them.
- Component preparation is whole-program. A cross-file call/signature failure
  yields one typed pre-emission `Unsupported` component under hybrid policy or
  an `Invariant`; it cannot leave half the component patched and half direct.
- Every source body has exactly one terminal outcome and one emitter. Prepared
  units record `directBodyEmissions=0, irBodyEmissions=1`; temporary hybrid
  Unsupported units record `1,0`. Fast mode obeys the same ledger.
- A post-freeze missing binding, slot, helper, import, type, module-init entry,
  or backend adapter is an `Invariant`. It never restarts preparation for one
  source or demotes a previously emitted unit.

## Bounded landing sequence

### M0 — parity census and one program container

- Introduce the ordered source/module graph and build a single
  `ProgramAbiMap`/`PreparedIrProgram` beside current output without changing
  routing.
- Reconcile per-source and whole-program counts, identities, aliases, ordered
  module-init entries, and support registries. Add test seams for omission,
  duplicate ownership, source-order reversal, and ambiguous display names.

### M1 — cross-file free-function and binding ownership

- Prepare call components across source boundaries and resolve named/default/
  renamed/namespace imports and re-exports through canonical binding IDs.
- Feed ordinary and fast multi-source lowering from the same frozen program.
  Temporary Unsupported components direct-emit once only after preparation.
- Remove the cross-file/import/name collision suppressors only when the census
  proves those exact units are Prepared or typed Unsupported and emitted once.

### M2 — classes, closures, globals, and ordered module init

- Extend R3/R4 ownership across files, including inheritance, closures,
  reassigned function/global live bindings, global scripts, static effects, and
  entry/dependency initialization order.
- Consolidate program-wide synthetic/helper/type registries and startup wiring.
- Replace the progressively rebuilt per-source `__module_init` functions with
  one program-owned planned/emitted init body, not merely one surviving export.
- Remove the per-source overlay loop and M0 `resolveModuleBindings: false`
  escape only after zero direct emissions are recorded for every Prepared
  multi-source body.

## File ownership and locks

One implementing agent owns `src/index.ts`, `src/checker/index.ts`,
`src/codegen/index.ts`, `src/codegen/declarations.ts`, `src/compiler.ts`,
`src/ir/integration.ts`, `src/ir/imported-functions.ts`,
`src/ir/module-bindings.ts`, and the R1–R4 program, ABI, preparation, and
module-init modules for the landing. These files encode one whole-program
transaction and may not be split among parallel writers.

Coordinate with #3527 before changing cross-file async call/delegation ABI and
with #3528 before exposing backend consumers. Runtime-family provider changes
belong to #3526. Do not edit direct handler implementations merely to widen
M0; R5 changes ownership and resolution.

## Anti-vacuity tests

`tests/issue-3525-ir-whole-program-multi-source.test.ts` must prove:

1. The same fixture compiled through single-source and one-file multi-source
   creates the same serialized program/ABI identities and emitter counts.
2. Two files export same-named functions/classes/globals; renamed, default,
   namespace, `export *`, and chained `export { default as x } from` aliases
   call the correct declaration without collision suppression or last-wins.
3. Forward and cyclic cross-file calls prepare as one component. Reordering
   internal maps or side-effect-free disconnected units preserves canonical
   IDs/provider order; dependency, stable SCC, TDZ, and caller-root evaluation
   order remain explicit. An injected signature error terminates the whole
   component before body emission.
4. Global-script declarations, reassigned function bindings, and imports that
   share display names remain distinct/live. Export aliases observe the same
   canonical storage after reassignment.
5. Cross-file inheritance, static effects, closures, and module initializers
   serialize one init body and execute once in semantic order across host,
   deferred host, standalone, and WASI-relevant configurations.
6. Fast and ordinary multi-source modes consume the same Prepared unit set and
   `ProgramAbiMap`; each Prepared source body records direct=0/IR=1.
7. Poisoning the old per-source `planIrOverlay`, collision collectors, or
   `compileDeclarations` body route does not affect a fully Prepared fixture;
   restoring any route fails the zero-direct/reachability gate.
8. Missing alias, duplicate slot, late helper/import/type request, unaccounted
   source, or second module-init invocation raises the stable R0 Invariant.
9. `compileMulti`, `compileFiles`, `compileProject`, and the internal record
   route all produce the same canonical program for equivalent inputs.

Run the new test with `tests/issue-2138-multi-module-ir-overlay.test.ts`,
`tests/equivalence/multi-file-compilation.test.ts`, `tests/multi-file.test.ts`,
`tests/issue-2930.test.ts`, `tests/issue-2931.test.ts`,
`tests/issue-1277.test.ts`, `tests/bare-specifier.test.ts`,
`tests/closed-imports.test.ts`, `tests/issue-2771-relative-import-standalone-wasi.test.ts`,
`tests/issue-3214-imported-hof.test.ts`,
`tests/issue-3493-compile-multi-globalthis-property-representation.test.ts`,
`tests/issue-3495-compile-multi-globalthis-array-index-reads.test.ts`, and
`tests/issue-3505-host-compilemulti-harness-callable-init.test.ts`.

## Acceptance criteria

- [ ] Single- and multi-source compilation invoke one whole-program preparation
      entry and consume the same `PreparedIrProgram` schema.
- [ ] Exactly one `ProgramAbiMap`, terminal-outcome ledger, ordered module-init
      plan, and support registry cover all sources before body emission.
- [ ] Named/default/namespace/renamed imports, exports/re-exports, global
      scripts, same-name declarations, cross-file calls/classes/closures, and
      live bindings resolve by structural identity.
- [ ] Ordinary and fast multi-source modes emit every Prepared source body once
      through IR and no direct body; typed hybrid Unsupported bodies emit direct
      once only after the whole-program ownership decision.
- [ ] The per-source M0 overlay loop, `resolveModuleBindings: false`, flat-name
      collision/import suppressors, and per-source synthetic registry are
      absent after their reachability/ledger proofs pass.
- [ ] Module initialization and startup preserve dependency/source order and
      exactly-once behavior across host, deferred host, standalone, and WASI.
- [ ] The R0 IR-only gate includes multi-source denominators, compile errors,
      fatal result errors, late support requests, and direct/IR emitter counts;
      no compile failure is caught or skipped.
- [ ] Multi-file/equivalence/cross-backend/fast/standalone/WASI suites,
      typecheck, format, validity, and merge-group Test262 are net-non-negative.

## Deletion boundary

R5 deletes only the multi-source planning/overlay/collision gates made
unreachable by the whole-program owner. It retains direct body implementations
for typed hybrid Unsupported units until R9 and does not delete runtime
providers. General AST→Wasm handler deletion remains #3090/R10 after R9.

## Out of scope

- Changing package/module resolution policy or adding a new loader.
- Treating global-script merging as permission for accidental flat-name
  collisions.
- Implementing async semantics (#3527), runtime-family contracts (#3526), or a
  separate linear multi-source front-end (#3528).
- Keeping a second one-file semantic planner for convenience.

## Risks and mitigations

- **Evaluation-order drift:** merging source plans can reorder side effects.
  Preserve dependency, within-SCC, TDZ, and disconnected-root caller ordinals
  separately from canonical structural ordering, and compare event traces.
- **Alias/cycle ambiguity:** name copying can appear correct on acyclic named
  imports. Resolve canonical binding IDs and test default/namespace/re-export
  cycles with same-name declarations.
- **Fast ABI divergence:** fast mode can tempt a second preparation path. Keep
  representation conversion below the shared Prepared boundary.
- **Late registry mutation:** program-wide helpers can shift indices after an
  earlier source emitted. Freeze all intents first and make every late request
  fatal.
- **False zero:** deleting collision suppressors can lower the counted
  denominator. Reconcile source census, outcomes, and emitter counts by
  `IrUnitId` before and after every deletion.

## Implementation Plan — 2026-09-05 — M2-P1 ordered initializer census before routing

**Planning base:** `5da655f286fcd569203cd2012b23dc21bf1c626d`. Astra planning,
Luna `max` implementation; proposed slice claim
`3525:m2-p1-ordered-init-census`, reserved by the lead before dispatch. This is
an independent production prerequisite. R5 remains in progress and none of
its full acceptance checkboxes becomes complete from this phase alone.

### Current blocker and bounded result

M0 already coordinates all sources, M1A already stages exact cross-source
callable components, and M2 already owns one executable initializer. The
remaining problem is composition, not absence of these foundations.
`planMultiPreparedModuleInit` (`src/codegen/multi-prepared-module-init.ts:163`)
builds source initialization plans only after its optional M2 admission gate;
`planMultiPreparedProgramEarlyRoutes:1270` separately rescans executable syntax
to disable callable cutover. `MultiPreparedProgramOwner:694` sees detailed
initialization evidence only after M2 has emitted its selected body. Most
graphs therefore reach routing without one retained ordered semantic plan of
all their initializers, although `IrModuleInitPlan` already provides the
single-source immutable vocabulary (`src/ir/module-init-plan.ts:91`).

Build and retain that whole-program plan once, before any early route can
prepare or emit a body. Make both M2 and the owner consume it by exact source
and unit identity. This moves semantic state to the whole-program preparation
boundary and removes duplicate route-dependent discovery; it does not admit
new initialization syntax or require an allocator change.

Mixed callable/initializer emission is the next dependent phase and remains
unimplemented here. It needs R2's prepared callable-boundary/support contract,
detached initializer preparation, and one publication transaction. The current
M2+callable refusals (`multi-prepared-program.ts:580`, `:701`), M2's singleton
restriction, and `ProgramAbiModuleInitCallableRegistry`'s singleton prepared
reservation (`program-abi-module-init-planning.ts:265`) must remain until that
transaction is designed and verified. The per-source overlay and its unresolved
module-binding route also remain; this census is not a `PreparedIrProgram` or
a proof of successful IR emission.

### Changes and independent write scope

1. Add `src/codegen/multi-prepared-module-init-census.ts`. Produce a defensively
   immutable collection from the exact existing identity inventory and
   `multiAst.sourceFiles`, using `buildIrModuleInitPlan` for every source,
   including empty, type-only, unsupported and multiple-contributor sources.
   Retain each full semantic plan: bindings/TDZ, live seeds, evaluations,
   exports, invocation policy and explicit gaps. Keep canonical source order
   separate from the existing semantic source order; never sort evaluation
   order by a name, path or binding ID. Preserve within-source evaluation
   ordinals and the input graph's dependency/SCC order. No new module loader or
   independent topological sort belongs here.
2. Bind the collection to the same session/inventory as
   `MultiPreparedProgramOwner` (`multi-prepared-program.ts:442`). Initialize
   its pure semantic census before `planExistingRoutes`, with required
   currentness checks for duplicate/missing/foreign sources, the reverse
   `SourceId` join, `UnitId` ownership, source order and changed source syntax.
   Owner construction is early enough for semantic planning; legacy queue
   parity is a separate observation after declaration collection. Do not mint
   an empty census when a required source or checker observation is unavailable.
3. Move M2's legacy-queue reconciliation (`multi-prepared-module-init.ts:175–200`)
   to one explicit boundary before route planning, after all sources have run
   declaration collection. Attach its per-source observation to the retained
   semantic plan, without rebuilding that plan. Preserve exact node provenance
   when partitioning static entries/module statements. A name-only live-seed
   join that cannot distinguish sources is unavailable evidence, not an empty
   success. Semantic plan gaps or unavailable parity remain visible and keep
   the existing route ineligible; they are not a reason to fail previously
   supported direct compilation. Contradictory or stale identity evidence is
   an invariant.
4. In `planMultiPreparedProgramEarlyRoutes:1242`, require the finalized census
   before `owner.planExistingRoutes`; use its executable population for the
   existing callable/init policy decision. In `planMultiPreparedModuleInit`,
   consume that same collection and reconciled observations instead of the
   local `sourceFiles.map(buildIrModuleInitPlan)` and a second source census.
   The unchanged M2 shape/target/selection gates select a contributor from the
   complete population; rejected sources are never removed from it. Validate
   M2's exact selected unit against the census before reserving its slot.
5. In `sealBodyBoundary:789` and `registerPreparedModuleInit:694`, require the
   same retained authority. Expose a versioned data projection of the complete
   ordered census in the body-plan audit, including graphs where M2 is off or
   declined. Keep semantic planning, parity and successful ownership as
   distinct facts. Snapshot the full plan rather than only contributor counts;
   any schema change must update its existing validators and tests together.
   Recheck currentness before source-body routing and final audit publication.

Own the new census module, `multi-prepared-module-init.ts`,
`multi-prepared-callable-orchestration.ts` **only its early-route orchestration**,
and `multi-prepared-program.ts` **only census lifecycle/body-plan consumers**.
Use the existing shared `module-init-plan.ts` producer unchanged where possible.
No R2 integration/lowering/source-callable-registry edits, no R1 computed-method
or identity changes, no R4 W2-B storage admission, no registry reservation or
startup behavior change, and no callable-component eligibility widening.
Keep additional helpers outside the large orchestration/owner methods.

### Validation and stop conditions

- Freeze a complete census with M2 enabled and disabled. Cover no executable
  sources, one and multiple contributors, type-only sources, dependency and
  entry contributors, re-export chains, same-spelled bindings in different
  sources, import cycles, and differing canonical versus semantic order.
  Source membership comes from the inventory, not the selector. Demonstrate
  that M2's existing admitted fixtures consume this authority and retain their
  exact direct `0` / IR `1` receipts; other graphs preserve their measured
  routing and runtime values. No population gain is asserted in advance.
- Mutation tests must reject omitted/duplicated/reordered sources, foreign
  inventory or unit, changed AST initializer after planning, changed queue
  observation after reconciliation, and a forged M2 contributor. Exercise
  unavailable parity with a real nonempty population. Assert no source-body
  emission or ABI reservation happened before a failed pre-route check.
- Run `pnpm typecheck` and
  `VITEST_MAX_FORKS=1 node node_modules/vitest/dist/cli.js run` with the new
  `tests/issue-3525-ordered-module-init-census.test.ts`,
  `tests/issue-3525-multi-prepared-program-census.test.ts`,
  `tests/issue-3525-multi-prepared-module-init.test.ts`,
  `tests/issue-3525-multi-prepared-callable-bindings.test.ts`,
  `tests/issue-3525-prepared-program-abi-aggregate.test.ts`, and
  `tests/issue-3521-r2-withdrawal-multi-source.test.ts`. Run both
  `node --import tsx scripts/check-ir-only.ts --json --policy=hybrid` and
  `node --import tsx scripts/check-ir-only.ts --json --policy=ir-only`,
  `node --import tsx scripts/check-ir-fallbacks.ts`, normal
  layering/format/size gates, and same-config multi-source equivalence checks.
  Record SHAs/options, actual source/unit denominators and runtime/event order;
  the small IR-only corpus cannot demonstrate R5 completion.
- If moving parity exposes declaration queues that are not complete at the
  proposed boundary, retain the early semantic plan and move the parity
  observation to the last point before any route emits; report the exact
  producer and consumer. Do not fix that ordering by planning after a body,
  silently omitting a source, or enabling mixed emission. Any need to modify
  the shared R2 preparation transaction is a dependent follow-up requiring
  coordination with its owner.

## M2-P1 implementation record — 2026-09-05

Implementation was based on `4946cf70fe82def4bb4ec3e55092153b90b9506b`.
The branch first merged current `origin/main` at
`33a532e9344667c01d497d2228a3662cea73901a` in signed merge commit
`96a4cca5b99eb8`; the implementation checkpoint is
`cd4f40fc5e80a55e98c6c855e33cf6d16bd987aa`. The final review corrections are
in the follow-up signed commit on this branch. Before publication, the branch
also merged the subsequently advanced `origin/main` at `6d601f91a51993eaa7586299a3f3bde07b49f367`
in signed merge commit `c9b573ea84840f`.

`MultiPreparedProgramOwner` now builds one immutable census for every AST
source before early routing. The fixture has four sources, four retained
source plans, two semantic evaluation entries and one executable source/unit;
empty, type-only, re-export and entry sources remain represented. Canonical
inventory order and semantic AST order are both recorded. The post-declaration
queue observation is attached once to those retained plans, and M2/body-plan
consumers use the same source and unit identities. The body-plan projection
retains the complete census when M2 is disabled or declined.

Review probes added explicit currentness controls for all observed ownership
boundaries. An unchanged source is accepted; mutating the same numeric literal
node (`40` to `41`) or replacing its initializer is rejected. A separately
rebuilt census with the same inventory but changed target (`wasi`) or defer
policy is rejected. The owner's original census is accepted with its own
context/session and rejected when observed through distinct context and ABI
session objects, even when inventory and AST objects are shared. The ordinary
owner-derived queue reconciliation remains accepted. These failures happen
before routing and reservation.

Validation at the merged candidate:

- The six required focused files pass: 93 tests passed in one Vitest fork with
  `VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`.
- `pnpm run typecheck` passes with TypeScript 7. TypeScript 5 retains the exact
  base residual in `src/linked-provider-runtime.ts:41,44`: `WebAssembly.Tag`
  is absent from the installed TypeScript 5 declarations; the archived base
  produces the same two errors.
- The enabled/disabled A/B compile uses two successful compilations in each
  lane and returns runtime value `42` in both. Enabled mode records two module
  init outcomes (one non-executable entry and one emitted dependency), two
  direct legacy rows, direct module-init `0` and IR module-init `1`. Disabled
  mode records two outcomes, three direct legacy rows, and no IR module-init;
  successful denominator is `2/2` in both lanes.
- `check-ir-only` passes in both `hybrid` and `ir-only` policy: each single-host
  and standalone lane has 5/5 entries, 41 terminal units, 38 emitted IR
  bodies, 3 non-executable rows, 0 unsupported, 0 invariants and 0 legacy
  bodies. Unit kinds are 26 functions, 5 module-init units and 10 class-member
  units.
- IR layering, dialect, kind-neutrality, optimization-retirement, function
  budget and adoption checks pass. The LOC budget uses this issue's existing
  allowance for `src/codegen/multi-prepared-program.ts`; no baseline file was
  changed.
- The same-config multi-source and equivalence suites pass for
  `tests/equivalence/multi-file-compilation.test.ts` and `tests/multi-file.test.ts`.
  The two unrelated #2138 failures (global-script callable preflight and the
  partial IR-first string result) reproduce unchanged from the exact base
  archive; all other tests in those four-file runs pass.

This is a structural M2-P1 prerequisite only. It reports no population gain,
does not change provider/ABI/runtime contracts, and leaves R5 and mixed
callable/initializer emission open.

## Implementation Plan — 2026-09-05 — M2-P2 atomic initializer ownership and mixed-graph prerequisites

**Source base:** PR5598 at `2c18cd7a6fb4d38a477f63a9b625e2907d265c29`.
The M2-P1 record above is copied unchanged from that exact revision. Astra
planning; Luna `max` implementation. Dispatch **P2A**, proposed claim
`3525:m2-p2a-atomic-init-batch`, after the lead reserves it and integrates P1.
The lead's claim audit at `ede1a327229e8bdd2cafb25eb18d2b5d02627dfe`
found no P2 claim; P1 is still owned. Recheck at dispatch. R5 stays open.

### Source findings and bounded result

P1 supplies the retained, authenticated whole-source semantic/parity census
(`multi-prepared-module-init-census.ts:396,502,594`). The next barrier is the
transaction: `planMultiPreparedModuleInit` (`multi-prepared-module-init.ts:154`)
selects one contributor and calls `prepareIrBodies`, which already seals and
installs that body's IR. Mapping this function over sources would publish a
successful prefix before another contributor could fail.

Existing detached machinery is reusable but not initializer-ready:
`compilePreparedProgramComponent` (`ir/integration.ts:5648`) returns an opaque
pending receipt, and `ProgramAbiSession.commitPreparedScopes` supports one
batch commit. Its source preflight (`:1797`), final-IR allocator check (`:1691`),
and receipt publisher (`:2730`) presently require source functions and reject
module-init artifacts. The receipt's currentness check also consults only
`programAbiSourceCallables`. Removing those tests without supplying their
initializer equivalents would discard the proof of safe detached emission.

**P2A's delivered behavior:** any finite number of executable contributors
whose existing initializer semantics and complete support requirements can be
prepared receives one atomic owner decision, one IR body per exact source
initializer, and one graph startup adapter. Every source remains in the census,
including sources with no executable initializer. There is no contributor-count,
filename, declaration-spelling, or fixture-signature admission rule. This phase
removes the singleton publication barrier; it does not widen the R4 storage
language or enable mixed callable/initializer ownership.

Source-qualified physical storage and mixed dependency discovery are separate,
real prerequisites, not consequences of R2-B1:

- `program-callable-bindings.ts:764` scans calls rooted in source functions;
  it does not retain initializer-owned calls. Callable preflight then expects
  every use owner to have a source-function record.
- `module-bindings.ts:889` requires a variable declaration in the use's own
  SourceFile. Imported-global reads are not an existing exact binding route.
- `ProgramAbiGlobalRegistry` retains declaration observations, but
  `registerModuleGlobal`/`registerModuleTdzGlobal`
  (`module-global-registration.ts:147,207`) reuse bare-name compatibility
  slots. Separate module declarations must not be certified as aliases merely
  because those observations point to the same allocator object.

The lead's `experimentalIR: true, trackIrOutcomes: true` probes make the
storage risk concrete:
two contributing modules respectively initialize `10; += 1` and `20; += 2`,
and entry computes `readA() * 100 + readB()`. On P1 source tree
`63758cc2958a40e51859a13236d16bb8ddaa2160`, host GC and standalone both return
`1122` with distinct private names and silently return `2222` with both named
`value`. Both lanes reproduce both results on pre-P1 commit
`6d601f91a51993eaa7586299a3f3bde07b49f367`, source tree
`9142845c1aa6b845d6efd1f25f62e5ab3062b298`. All eight isolated compilations
succeed without diagnostics: two source versions × two targets × unique/same
private names, each three sources/two contributors, using the same `compileMulti`
harness/options. Unique-name controls return the expected `1122`; same-name
controls return the wrong `2222` in both versions and targets. The defect
therefore predates P1 in both lanes. These are direct initializer controls,
not P2 results. Their legacy body row describes an aggregate pass;
an unmarked second source is not evidence that its initializer did not run.

Keep the full acceptance above unchecked. P2A's source bodies plus one graph
adapter are also an intermediate representation, not completion of the final
single program-init-body/consolidated-registry requirement. The production
`PreparedIrProgram` reconciliation in `ir/program.ts` remains a separate open
handoff; a successful owner audit does not fill it in by assertion.

### P2A producer, preparation and publication order

1. **Freeze eligibility before a route emits.** In
   `planMultiPreparedProgramEarlyRoutes` (`multi-prepared-callable-orchestration.ts:1243`),
   consume P1's observed census, cache every resolved source plan, and classify
   the entire initializer population before calling any preparing early route.
   Use the existing `preparedExactLexicalModuleInit` result
   (`index.ts:4311`) and explicit plan gaps; do not rebuild semantic plans or
   discover contributors from selector survivors. The batch is all contributors
   or none. Keep existing mixed/dedicated-route exclusions until P2B supplies
   their joint transaction. A typed preclaim decline resumes existing routing
   with no initializer reservation, body, alias, outcome or skip prefix.
2. **Separate description from materialization.** Add a small
   `codegen/multi-prepared-module-init-batch.ts` coordinator. Its private batch
   input retains the exact context/session/inventory/census, ordered
   `(SourceFile, SourceId, UnitId, population, lowering plan)` entries, full
   selection evidence and invocation intent. Describe value/TDZ globals by
   checker declaration and `IrBindingId`, their allocator objects, carrier
   types/mutability and storage-owner UnitId. A TDZ flag not yet allocated must
   have an explicit allocation intent tied to its exact declaration; its
   absence cannot mean no TDZ requirement. Split the existing
   `resolveModuleBindingGlobal` handoff (`ir/integration.ts:5735`) so this
   description does not call `planProgramAbiGlobal` or an `ensure*` helper.
   A missing observation or an unproven shared physical slot is a visible
   preclaim capability gap; a changed/contradictory previously retained join
   is an invariant. Do not repair storage producers in this slice.
3. **Build every initializer once before lowering any.** Extract a reusable
   preparation boundary from `compileIrPathFunctions`: the module-init build
   loop (`integration.ts:3667`), common final-IR passes, runtime/support
   preparation (`:1410`, `:4579` onward), and detached lowering remain one
   implementation. Supply a vector of exact initializer inputs, not one
   representative SourceFile with every body's statements appended to it.
   Each `lowerFunctionAstToIr(..., moduleInitUnit: true)` uses its own original
   population, source bindings and UnitId. Keep resulting IR artifacts and
   diagnostics; never compile a source again to recover a later dependency.
   Compatibility labels may be unique private projections, but neither the
   repeated `<module-init>` label nor `funcMap` chooses an owner.
4. **Complete the resource census before reservation.** For the full built IR
   vector, derive all runtime/provider/type/string/exception/global demands,
   export/startup intents and source `[] -> []` signatures using the existing
   manifest/support producers. An AST builder callback that materializes a
   resource must become a planned request or a lookup of described evidence;
   it may not mutate shared context and then report Unsupported. Validate
   target availability, complete dependencies and storage/ABI parity before
   accepting the batch. This is a prerequisite of detached initializer
   lowering, not permission to delete the allocator-neutral checks. Replace
   those checks for this route with an authenticated complete resource receipt
   and an independent final-IR demand reconciliation. A missing provider keeps
   its explicit gap and owner; an empty manifest is valid only after a complete
   demand scan. Reuse R6 contracts rather than adding a second provider table.
5. **Reserve the complete accepted batch.** Extend
   `ProgramAbiModuleInitCallableRegistry.reservePreparedExactUnit`
   (`program-abi-module-init-planning.ts:265`) with an exact batch reservation;
   preserve the single-source API as a checked one-element adapter. Reserve one
   allocator slot per executable UnitId and one structurally identified
   compiler support slot for the graph adapter. Split
   `preallocateModuleInitCallable` (`declarations.ts:5191`) so source-slot
   reservation does not install a deferred export for each contributor. Plan
   all value/TDZ ABI locators and materialize the already-described resources
   before the first Wasm body is lowered. Complete dependency closure and open
   the pending scopes through `prepareDependencyCompletePreparedComponents`
   (`prepared-component-sealing.ts:504`); every initializer storage owner must
   be in the certified batch. Keep its derived component partition, including
   multiple independent scopes, instead of forcing all terminals into one
   artificial component to fit today's single-receipt API. Do not use the
   final retained-global sweep as
   an early substitute for this exact source-owned plan.
6. **Lower into detached patches, then commit once.** Extend the existing
   `PendingPreparedProgramComponentReceipt` path with initializer allocator
   lookup through `programAbiModuleInitCallables`, exact kind/source/unit joins,
   one own-body patch per terminal and unchanged `[] -> []` slots. The batch
   producer returns one authenticated receipt per derived scope, partitioning
   retained patches by exact component/terminal identity; it does not rebuild
   or relower bodies per receipt. Keep source
   initializer tail-return removal and the no-early-return invariant
   (`integration.ts:5359`); no tail-call rewrite may skip startup epilogues.
   Prepare all scopes/tokens, the graph-adapter body, publication arrays and
   owner state before any live body/ABI/alias write. Recheck P1 currentness,
   resource demand, source order, allocator identity, signatures and every
   detached patch. Commit all pending scopes in one call; publication then
   consists only of precomputed assignments. No per-contributor commit loop.
7. **Preserve the existing pre-body publication phase for P2A.** Once every
   initializer and the adapter has passed that batch check, publish before
   ordinary declaration-body visits, as the current M2 route does. This avoids
   leaving detached bodies outside normal index-fixup ownership while direct
   sources can still request unrelated support. Replace the owner's singleton
   preparation, reservation and skipped-source fields with exact maps/vectors
   (`multi-prepared-program.ts:776,1011,1231`). Every source uses prepared init
   mode; only contributors receive exact skip handoffs. Empty sources must not
   run the final legacy `full` initializer pass. Verify each actual skip and
   terminal emission count after its source visit, and exclude these units from
   the late overlay. Any mismatch after acceptance/publication is fatal, never
   a direct retry. Do not falsely label these skips as observed before the
   declaration consumer has run.
8. **Construct one startup adapter from the frozen order.** Its body calls
   each contributor's exact `[] -> []` handle once in P1 semantic order; within
   each body retain original evaluation ordinals. Canonical inventory order is
   never execution order. Preplan any init-flag/marshal/dispatch support and
   place it around this graph adapter, not around each source body. Update
   `finalizeMultiPreparedModuleInitStartup` (`index.ts:7063`) and the module-init
   registry's `planRetained`/invocation audit to use that exact graph handle and
   authenticate the full call sequence. Finalization attaches the one planned
   Wasm start or deferred export and checks construction; it must not discover
   helper requirements or rewrite contributor bodies. Preserve exception
   propagation and the existing deferred invocation contract; do not invent a
   new per-source idempotence policy. WASI/fast remain measured controls until
   their graph-adapter contracts are separately implemented.

The adapter uses ordinary `call` instructions to the exact contributor handles
in semantic order, with any preplanned init-flag prologue and epilogue outside
that sequence. Its compiler-support binding and detached body assignment
participate in the same batch. It has no fabricated source terminal or extra
source IR-emission credit.

Preclaim Unsupported is recoverable only while preparation is side-effect-free
or an existing authenticated transaction can abort all of its unpublished
state. Once accepted resource/slot materialization begins, an unexpected gap,
allocator change, failed lower or stale receipt is an invariant and terminates
compilation. Do not claim rollback by truncating shared arrays/maps, reusing a
partly sealed session, or retrying direct after a source skip. Abort all still
pending scopes on failure; never convert a commit failure into Unsupported.

### P2B dependency contract — mixed graphs remain unimplemented by P2A

The follow-up must feed a joint immutable graph from the same P1 census,
callable binding graph and exact module-binding uses before preparing any
component. Extend `collectCallableGraphUses` to cover each initializer's exact
evaluation population while excluding nested callable bodies; retain
initializer-to-callable calls by owner/target UnitId and canonical alias ID.
Add a checker-owned imported-global resolver with an explicit import/re-export
chain, canonical source binding and declaration. Namespace/default/renamed
uses must reference that identity, not copy compatibility maps. Supply exact
source-qualified value/TDZ allocation and per-source direct compatibility
views before accepting same-spelled declarations. This work requires its own
storage-owner coordination; P2A must not borrow the active R4 storage claims.

Derive components from both calls and storage dependencies. A callable reading
an initializer's global depends on that storage owner; it does not mean that
calling the function invokes initialization again. Initialization order edges
also constrain the graph adapter. Reconcile the final IR against the complete
attempted population and preplan support for every component and initializer
together; no survivor regrouping, earlier component publication, or body-first
provider discovery. Deferred/within-cycle reads keep TDZ checks unless an
owner-qualified execution-order proof permits omission. In particular a
function reachable from an initializer is not automatically post-Wasm-start.

R2-B1's current interface is
`ProgramAbiSourceCallableRegistry.issuePreparedCallableBoundary(unitId, signature)`
and `PreparedCallableBoundaryCandidate.certify`, with final `assertCurrent` and
`assertSupportCurrent` checks (`ir/prepared-callable-boundary.ts`). It certifies
the actual final IR signature/support in an open scope; a candidate is not yet
a contract. Consume this interface for callable boundary dependencies and
recheck it before batch publication. R2-B1 does not supply imported globals,
initializer call edges, or general detached provider allocation. Coordinate
the shared integration extraction with its author and use its merged API.

Only after these prerequisites pass may P2B remove the executable-init callable
disable, the owner composition refusal, and source-has-init callable rejection
(`multi-prepared-callable-orchestration.ts:363,1276`;
`multi-prepared-program.ts:663,784`). Replace the competing publication owners
with one batch over all callable components and init patches. Reuse M1A's exact
source-body skip ledger and `prepareCommit`/`commitPreparedScopes` protocol;
freeze the complete resource census before keeping that mixed batch pending
across direct visits. The final write must publish all bodies, aliases, startup
state and outcome rows together. P2A does not certify this transition.

### Validation, ownership and dispatch brief

Own this issue, the new batch coordinator and the proposed extracted helper
`src/ir/prepared-module-init-integration.ts` if extraction is necessary;
`multi-prepared-module-init.ts`, the early-route function in
`multi-prepared-callable-orchestration.ts`, init-specific lifecycle/audit parts
of `multi-prepared-program.ts`, `program-abi-module-init-planning.ts`, and only
the named preparation/publication seams in `ir/integration.ts`,
`declarations.ts`, `index.ts` and `prepared-component-publication.ts`.
Keep the P1 census producer, `module-init-plan.ts`, R2 admission/lowering
contracts, module-binding storage producers, callable graph producer and
module-callable alias planner unchanged in P2A. New test ownership:
`tests/issue-3525-atomic-module-init-batch.test.ts`; update the superseded
two-contributor refusal in the existing M2 test only when the new positive
case and its exact receipts pass. No concurrent writers in these transaction
seams. Active `3523:w2b` and `3523:r4m1` remain outside this claim.

- First measure exact P1 and candidate SHAs/options. Cover multiple contributor
  counts, dependency and entry contributors, empty/type-only/re-export sources,
  and arbitrary renamed inputs. Prove complete source/unit denominators, one
  prepare and IR emission per executable init, zero direct init roots, exact
  per-source skips and one ordered graph adapter. For all-empty input, verify
  no adapter/reservation while retaining every genuine inventory terminal and
  its applicable non-executable outcome; fabricate no terminal for an absent
  unit. Do not infer an outcome denominator from contributor count.
- Execute enabled/disabled host and native-first standalone binaries, normal
  and deferred startup, and compare exported values, thrown values and
  invocation behavior. Use the existing direct runtime as an A/B control and
  explicit expected results. Independent source-local arithmetic alone cannot
  prove observable inter-source effect order: inspect the exact adapter call
  sequence for P2A and retain an order-sensitive mixed/imported-read fixture
  as a non-admitted runtime control. P2B must turn that same control into a
  prepared positive with noncommuting effects, initializer-to-callable calls,
  callable-to-init global reads, forward/cyclic TDZ and a live value updated
  through the exporting source. Check same-spelling functions and globals
  across files, re-export/namespace aliases and both contributor directions.
  P2A must expose missing/shared storage evidence before reservation; matching
  a wrong direct result is not evidence that source identity is correct.
- With `JS2WASM_TEST_POISON_DIRECT_MODULE_INIT_BODY=1`, admitted multi-init
  graphs must compile and execute; disabling the cutover must hit the actual
  direct emitter poison. Use exact-unit direct-function poison for the mixed
  callable positive in P2B, with a known reachable disabled control. Assert
  no late per-source IR recompile of an already prepared initializer.
- Inject a late contributor's preclaim Unsupported and missing resource,
  then stale/foreign inventory, source reorder/omission/duplication, altered
  AST or parity, value/TDZ alias retarget, duplicate slot, changed signature,
  changed detached body, missing terminal patch, aborted last scope, duplicate
  skip and missing/reordered/duplicate startup call. Distinguish the ordinary
  preclaim decline from fatal contradictory evidence. On every prepublication
  failure assert no published body/ABI/alias/outcome/startup prefix, including
  an earlier valid contributor. Exercise at least two pending scopes when
  testing scope-batch atomicity; one scope cannot prove that property.
- Required commands: `pnpm typecheck`; then
  `VITEST_MAX_FORKS=1 node node_modules/vitest/dist/cli.js run` over the new test,
  `tests/issue-3525-multi-prepared-module-init.test.ts`,
  `tests/issue-3525-ordered-module-init-census.test.ts`,
  `tests/issue-3525-multi-prepared-program-census.test.ts`,
  `tests/issue-3525-multi-prepared-callable-bindings.test.ts`,
  `tests/issue-3525-prepared-program-abi-aggregate.test.ts`,
  `tests/issue-3523-ir-module-init-compile-once.test.ts`, and
  `tests/issue-3521-r2-withdrawal-multi-source.test.ts`. Run multi-file/equivalence
  and startup controls named above,
  `tests/issue-3521-prepared-callable-boundary.test.ts` after R2-B1 integration,
  both `node --import tsx scripts/check-ir-only.ts --json --policy=hybrid` and
  `--policy=ir-only`, `node --import tsx scripts/check-ir-fallbacks.ts`, and the
  normal format/layering/dialect/size/issue-integrity and merge-group Test262
  gates. Record base residuals with exact controls; do not weaken baselines or
  claim a corpus/population gain without measuring it.

**Luna dispatch:** implement P2A's all-contributor prepare/commit and exact
graph adapter. Stop for a revised prerequisite if a build callback cannot
describe its resource without mutating shared state, an admitted initializer
needs another source body to run first, or correct startup needs a late
unplanned provider. Do not replace that missing proof with more names, counts
or a new storage allowlist. Return measured runtime/receipt evidence and list
P2B plus the full R5 acceptance as unfinished.
## M2-P2A implementation record — 2026-09-05

P2A is implemented on `codex/3525-m2-p2a-luna-20260905` with signed
implementation commit `2d8e449da3b2787b9b4080c9b99b8aeb4f556d73` and current-main
merge `dc9ef587fa376da90467d5a473de45516e2b3a6f` (current `origin/main`
`39e4a13b94273dc9074e5b45e9a4cec661605ef0`). The Luna Max implementation
adds one source-qualified batch coordinator that preclaims storage and TDZ
declaration evidence, materializes existing declaration preparation, builds
the complete initializer vector once, captures the final allocator/resource
census, reserves exact ordered units and one flat graph adapter, then commits
all detached component scopes and bodies together. Registration, currentness,
resource, body, terminal and adapter failures abort all pending receipts before
publication. Existing singleton M2, disabled cutover, ordinary deferred
initialization, and mixed callable/init admission remain outside this slice.

The post-review transaction repair retains the complete raw receipt vector
through exact partition validation and revokes every receipt when a late
partition, report, resource, or owner check fails. Only a fully typed
resolver-stage `late-preparation-unsupported` outcome may decline the
aggregate route; lower, verify, patch, and other post-promise failures remain
fatal and cannot retry direct module-init emission. The test-only revocation
audit counts a receipt only after both its post-abort `assertCurrent` and
claim capabilities reject, rather than counting `abort()` callback returns.
The focused malformed-partition control observed two real pending receipts and
aborted both (`attempted: 2, aborted: 2`), while the tagged-union injection
control remained fatal with no direct-init fallback or published prefix.

The positive two-contributor production control has two executable source
plans, two IR body emissions, zero direct module-init roots, two resource
artifact IDs matching the contributor UnitIds, and one ordered adapter. Its
compiled production result returns `111` on both exported calls. An owned clone
of the generated Wasm module adds a separate i32 trace global only in the test
copy: normal startup records `12`, an explicit second adapter invocation
records `1212`, reversed blocks record `21`, and duplicated blocks record
`1122`. The deferred clone starts at `0` and records `12` then `1212` across two
explicit calls. This observes order and per-invocation execution without
instrumenting production code.

The negative controls retain both source storage gaps for string-valued
contributors, reject the non-scalar `[seed, 2][0]` late-resource candidate
before P2A reservation, and reject both dropped-terminal and pending-body
mutations with an empty binary and no published initializer prefix. The
preexisting cross-source storage measurement remains explicit: distinct
private names return the expected `1122`, while same private `value` spelling
returns `2222` in both pre-P1 and P1 lanes; P2A refuses that unproved alias and
does not claim the storage defect as a gain.

Validation on the merged candidate:

- `pnpm run typecheck` — pass.
- The required single-fork suite over the eight P2A/M2/R2 files — 8 files,
  121 tests passed, including the late-partition receipt-revocation and
  tagged-union fatal-routing controls.
- `pnpm run check:ir-fallbacks`, `check:ir-layering`, `check:ir-dialect`,
  `check:ir-kind-neutrality`, `check:ir-optimization-retirement`,
  `check:ir-adoption`, `check:issues`, and `check:issue-spec-coverage` — pass.
- `node --import tsx scripts/check-ir-only.ts --json --policy=hybrid` and
  `--policy=ir-only` — both ready: 5 entries, 41 terminal units, 38 emitted,
  3 non-executable, and 0 legacy body emissions per lane.

P2B still owns mixed callable/init graphs, imported-global and re-export
storage proofs, and noncommuting initializer-to-callable effects. Full R5
acceptance and merge-group CI remain open; no full local Test262 run is claimed
by this landing.

## Astra High lane A — public prepared-program driver (2026-09-07)

This is an **owner continuation**, under the ownership and pinned-source
snapshot in [the epic's September 7 specification](3518-ir-only-default-and-direct-frontend-retirement.md).
The recorded A owner is `ttraenkler/astra-ir-program-a-20260905`; its liveness
and newest output-split commits remain unverified. Resume that work or obtain
a scope handoff. Implementation model: **Astra Low**. Do not rebuild the
preparation driver already carried by package C's stack.

### Verified trigger and desired behavior

On upstream `b3133d1d4da1151d82ef45b58db9566565097c57`,
`src/compiler.ts::runPipeline` chooses legacy generators at `:1089–1104`.
`src/compiler/output.ts::compileToObjectSource` separately calls
`generateModule(ast)` at `:355`. A normal source compile and an object compile
can therefore select different frontend policy even for identical options.
The public `compileToObject` wrapper in `src/index.ts:1289` reaches that second
root. A switch in only `runPipeline` cannot complete the migration.

Desired production sequence: input normalization and source validation → one
whole-program preparation → backend acceptance → one emission → shared output
finalization. Keep parsing and original-source diagnostics on the frontend
side. No backend is allowed to discover missing source bodies by calling the
legacy generator, and no failure path retries through direct compilation.

### Exclusive file ownership and API design

A owns `src/compiler.ts`, `src/compiler/output.ts`, `src/index.ts`, new or
recovered `src/compiler/ir-program-driver.ts`, new or recovered
`src/compiler/ir-program-result.ts`, and new
`tests/issue-3525-public-prepared-driver.test.ts`. If the recovered owner
already split finalization/presentation into other files, use those files and
record the exact substitution before editing; do not create duplicate output
implementations. B's async engine, C's codec/consumer, host export marshalling,
linker emission, and source-preparation producers are read-only in this slice.

1. Define one internal synchronous driver over the complete analyzed source
   graph, canonical entry source, checker/oracle, normalized target profile,
   and output policy. Async APIs may await resolution/optimization, but
   synchronous compile and object output cannot acquire an async-only semantic
   preparation dependency. Reuse A's existing `prepareWholeIrProgram` from
   `src/ir/program-preparation.ts` once the dependency is available.
2. The driver returns an explicit discriminated result: emitted module with
   authentic ownership/diagnostic evidence, or a located preparation/acceptance
   refusal. Invariant exceptions remain fatal. No result variant contains a
   retry callback, direct candidate or AST-taking backend closure. Catching an
   arbitrary exception must not convert it to preclaim Unsupported.
3. Call C's `acceptPreparedIrProgram` and `emitAcceptedIrProgram` exactly as
   their recovered definitions require. Freeze target/runtime options before
   acceptance. Do not manufacture acceptance receipts or plan materialization
   in the wrapper. `emitAcceptedIrProgram` receives only C's accepted token.
4. Separate module generation from binary/WAT/object/presentation finalization.
   Feed the emitted module to the same established binary optimizer,
   source-map, import helper, DTS, string-pool, export metadata and linker
   paths that consume it today. Inventory every `mod` field read below
   `runPipeline`'s generation block and by `compileToObjectSource` before
   moving code; missing metadata must be a named contract gap, never silently
   filled with an empty object. Preserve diagnostics and target options.
5. Use the same driver for single, multi, files and object outputs; preserve
   module evaluation order from the prepared startup plan. Sync/async API
   wrappers may differ in I/O, not in source identity or semantic ownership.
   Source IDs are minted once for the graph and remain unchanged through
   finalization. Export names remain labels over binding IDs.
6. Integrate the production call-site replacement only when coverage and
   runtime dependencies pass the epic's final bar. Before that, publish
   internal driver/finalizer checkpoints with explicit incomplete status;
   do not add an optional `wholeProgramIR` mode or catch-and-direct fallback.
   The eventual cutover removes direct imports from compiler orchestration
   and routes all target profiles through preparation. Flag retirement in
   #4522 remains owner-coordinated; disabling an optimization must never
   select another frontend.

### Required acceptance and negative controls

Run the following cases through public `compile`, `compileFiles`,
`compileMulti`, `compileToObject`, `compileToWat` and `compileProject` wrappers
in `src/index.ts`, using each real signature. Also exercise the synchronous
`compileSourceSync` entry in `src/compiler.ts` used by runtime eval; there is
no public `compileSync` export. Never substitute a private generator for a
public-route test. Include CLI/selfhost wrappers in the final closure audit.

- One numeric function returns a nonconstant result; two sources with aliased
  calls and equal helper names preserve distinct results; an exported live
  global updates after startup; type-only/ambient sources preserve the census
  without invented executable bodies. Ordinary and `fast: true` use the same
  semantic ownership on gc and standalone. Linear/WASI report exact current
  capability rather than producing a reduced module.
- Object output is linked and executed, not merely nonempty. Check public
  function/global export binding and startup behavior, and preserve relocation
  index spaces. Missing C object/WASI capability is a dependency, not permission
  to route object output through `generateModule` again.
- Poison the four legacy generators before calling each public entry on the
  candidate. Accepted cases still execute. The same test on the captured base
  must hit poison for at least the direct namespace/object control; otherwise
  it has not proved the detector is attached.
- Inject a preparation Unsupported, a producer invariant, acceptance failure,
  and emission failure independently. Each gives no artifact/exports; only
  the actual Unsupported keeps that classification; none enters a direct
  generator. A late failure cannot publish a partially filled module.
- Same-name modules and a source function named `__module_init` cannot receive
  each other's diagnostics, startup slot or exports. Reordering input map
  insertion alone must not alter module dependency order or unit ownership.
- Preserve target-specific result metadata and source-map locations on the
  ordinary positive control. Remove the shared-driver call from object output
  only: its poison test must fail again. Restore it and rerun the focused test.

Use C's existing scalar two-source fixture as an initial dependency control;
add the D application graph when runtime materialization becomes available.
Run focused tests, typecheck, IR layering/dialect/kind checks, equivalence and
required output/linker tests. Record exact base/candidate source hashes and
per-entry phase/ownership evidence. Do not report full migration from scalar
success while C still refuses async, reference layouts, linear plans or WASI.

**Astra Low lane A prompt:** Continue A's recovered public driver/output work
in its isolated worktree after ownership confirmation. You are not alone in
the repository: preserve all peer changes and use only the file set above.
First capture existing public-route results and metadata, then implement the
shared driver and finalizers against the real A preparation and C consumer.
Publish a non-draft checkpoint with exact moved call sites and poison/runtime
controls. Do not add a public alternative compiler mode, edit package C, or
silently narrow supported behavior. Hand back any missing provider/layout or
source producer as a located failing fixture to its existing owner.


## Internal prepared output implementation and ownership release — 2026-10-04

Root resumes the historical A/output interface within this sole IR session. All old branches and held claims remain preserved. This bounded continuation writes only the three paths below and this issue; A/C producers, driver, providers, public routing and legacy retirement remain consume-only. Canonical claim effects are authenticated in the integration receipt; no forced transfer was used. Root owns compiler.ts and integration, Sol GPT-6.1 Medium owns the new presentation leaf, and a separate Sol GPT-6.1 Medium owns the new execution test suite. Astra High wrote the hard implementation specification below. Existing open compiler PR option/diagnostic hunks stay intact; PR6341 allocation-owner insertion after C ABI and before widening is absent in the current base and remains a future preservation obligation.

Base is exact650cb1b0; its PR6475 main delivery is still unverified. This private source increment can be developed now, but publication must integrate freshly verified main and preserve the queued head. Legacy remains until full IR path parity. The benchmark quiet window ended at actual driver exit1, with four of eight reports and143 of240 pairs retained: no performance acceptance, automatic retry, or threshold change.

<!-- Astra source executable-numeric-bridge-amendment.md SHA256 a5ec87eab43d15240cf055a69ec2716eb3341639b615750892a795bdbe199099 -->


### Required executable R5 checkpoint — genuine numeric prepared program to finalized binary (2026-10-04)

This strengthens the earlier14316-byte contract: merely narrowing context and returning gaps for every input is **not** the delivered checkpoint. The released implementation must finalize and execute the existing real numeric and two-source prepared fixtures. Missing families remain explicit gaps; neither public routing nor C/provider implementation is opened by this bounded internal path. Held A/output/routing acknowledgement remains a source-release prerequisite.

#### Smallest productive path and source association

Keep proposed ownership `src/compiler.ts`, NEW `src/compiler/ir-program-presentation.ts`, and NEW `tests/issue-3525-prepared-pipeline-presentation.test.ts`; current driver/result, C consumer/provider and object/linker files remain consume-only. The new internal compiler entry is not exported from `src/index.ts` and introduces no public option. It receives the existing complete analyzed input, captures frontend presentation/normalized options once, invokes the actual `runIrProgramDriver` once, joins that returned program/emission to the local capture, and calls the existing finalizer once. Do not accept a caller-supplied emitted result or `metadataComplete` flag at this entry. A private synchronous transaction closure associates capture, exact driver options, result and module; there is no separately reusable approval token or second registry. Before observers can run, snapshot data-only target/output options just as the driver already does. Never clone or substitute the authentic program/emission.

The first accepted domain is real synchronous numeric function programs at wasmgc/host with ordinary ABI, sourceMap false and no requested optimization/C header or object output. Use the existing fixture in `tests/issue-3525-public-prepared-driver.test.ts:15` (`calculate(value:number) => value*3+2`) and its actual two-source callable dependency at108–123. This domain is defined by authentic source/ABI/resource conditions, not fixture filenames or special-cased source hashes. Additional targets/families must prove their own complete contracts; their present rejection is an internal `presentation-unsupported`/named-gap result before output artifacts, not a false language Unsupported or successful empty CompileResult. Preserve preparation/acceptance Unsupported and invariant exceptions exactly as the driver already returns/throws them.

Capture per-function source filename/declaration span, parameter/result numeric classification and async/modifier facts from the original analyzed source graph/checker once. Match to `program.inventory.sources[].originalFileName` and terminal declarationStart/declarationEnd, using exact source identity to obtain the real unit ID. Join the ABI callable's `plan.intent.unitId` (or exact canonical alias target when admitted) and `contract`, then each ABI export contract's target binding, then the actual `emittedProgramBindingIndex(emission, bindingId)` function-space result. Check the actual physical export name/index and signature, including arity, against that join. Never identify a unit by display name alone or infer an ID by splitting text. Reject missing/ambiguous source spans, unmatched exports, wrong slot space or contradictory primitive signatures. Original source AST may remain local for DTS/WIT rendering; it never reaches C, physical body lowering, the prepared packet or its codec.

#### Existing facts sufficient for the numeric positive path

- **Boundary signature absence is real semantics.** `src/codegen/declarations.ts:384–443::recordExportSignature` returns without recording a signature when every param/result is `other`. It does not create all-other rows. For this checkpoint, use the frontend checker's actual numeric declaration classification and the corresponding primitive prepared callable contracts to prove that exact case for every physical function export. Preserve `module.exportSignatures === undefined` when that is the established legacy result; do not manufacture `{}` or all-other entries. A string/dynamic/promise/typed-array/aggregate source classification must refuse this narrow path even if a physical representation happens to resemble a number. No call into the legacy codegen context or generation algorithm is needed for this finite numeric proof.
- **Async zero has a producer.** Require captured declarations to be synchronous, genuine ABI callable contracts to have no promise contract, and actual prepared IR/runtime support to contain no async demand for admitted exports/bodies. These checks justify the existing empty `module.asyncFunctions` only for this complete input. A matching empty Set alone does not. Do not allocate a replacement Set or erase discovered runtime work. DTS is generated from the original entry AST and the genuine module.
- **Startup false has a complete source.** Examine all actual `program.startup` rows (`program/startup.ts`): retain source population/order, and require no executable evaluation, live initializer seed or unresolved gap, with the corresponding invocation policy. Cross-check genuine emission support/startup receipts and absence of a physical startup function/export for this admitted zero-demand case. Empty source/declaration rows remain in the inventory; do not remove them. This proves the existing `hasTopLevelStatements === true` expression returns false legitimately. Any live initializer takes an explicit startup-gap result for this first cut. `hasMain` still comes from the actual function export.
- **Imports and provider absence are observed, not filled.** Use the selected genuine runtime projection/declarations plus completed C emission to establish no live external import/capability/string-boundary resource demand. Inspect the actual module imports (all kinds), string pool/literal and extern/JSX metadata, resources and support receipts. Numeric intra-program calls are joined through ABI slots, not treated as host imports. Require an actual zero-import module for this first cut; never clear imports/maps or pass an empty synthetic manifest. Then the unchanged import/capability/adapter helper builders run on that genuine module and derive their own empty results. Existing `reserveString` remains the real string-pool producer for broader future inputs.
- **Options are one transaction.** Resolve public target profile once and retain actual driver backend/target/moduleName/shared-tag/utf8/sourceMap values; no later mutable caller bag chooses a different profile. The host numeric path requests no C ABI, source maps or optimization, so missing C header/maps are explicit request semantics. `emitWatOutput` remains the real resolved flag; WAT false suppresses only WAT. For the first required positive, WIT is unrequested; a later WIT positive can use the existing entry AST renderer without changing C.
- **Physical mutations must be absent, not handwaved.** C ABI is not requested. Prove admitted actual physical types/signatures/locals/globals/imports do not require the finalizer's nondefaultable-ref widening. Capture complete physical state before finalization and independently prove that numeric finalization leaves the authentic function/ABI/resource population unchanged, while still running the unchanged finalizer order. Do not treat pre-mutation receipts as validation of a changed physical program. A real widening demand refuses this initial domain; a broader producer repair belongs to C, as the historical plan specifies.

Together these conditions allow a genuine nonempty numeric module to reach binary emission, optional WAT, DTS, actual import/capability/adapter helper building and normal engine validation without any C/provider changes. This is a source-grounded implementation feasibility statement, **not** a newly executed result. If the actual authentic fixture reveals an unaccounted field or resource, hand back its exact field/producer and raw failure; do not weaken checks or convert the checkpoint into an all-refusal delivery.

#### Artifacts and telemetry are distinct products

Current driver returns exact program/emission but does not supply the legacy public `FailureTelemetry`/route-audit population. The internal checkpoint must return real binary/output artifacts plus those exact program/emission references and the independently verified binding/demand joins. It must explicitly leave public route telemetry unavailable; do not publish `EMPTY_FAILURE_TELEMETRY`, a copied legacy audit, guessed zero direct counters or fabricated original outcomes as successful prepared evidence.

A narrow implementation option is to allow the existing private finalizer's telemetry parameter to be `Partial<FailureTelemetry> | undefined`: legacy callers continue to supply the identical real telemetry; internal output uses undefined and returns a typed artifact projection with the six legacy telemetry keys absent. JavaScript spreading undefined is empty, so no fabricated bag is required. Preserve failure helper default behavior and all existing finalizer diagnostics/order. The internal result type must clearly distinguish this artifact checkpoint from a complete public compile result/retirement certificate. Real emittedUnitIds and program IDs remain available as genuine receipt evidence; test-only legacy-generator poison/call counts independently prove nonentry on these cases. Root can instead choose an equally small artifact/telemetry split if it proves the legacy whole-body behavior unchanged; no separate output compiler or generic reporting framework.

#### Required executable acceptance, beyond refusal controls

1. Actual scalar bridge binary instantiates with the required real imports and returns23 for7 and35 for11. Actual two-source main returns42; add a nonconstant cross-source argument control and source-qualified same-spelling negative join so name-only matching cannot pass. Require nonzero binary/function populations, exact original/derived emitted-unit census and real module identity. No body interpreter or mocked emitted packet.
2. Capture independent ordinary legacy results for the same fixtures as equality oracles, and compare public-facing artifacts relevant to this domain: actual exports/values, DTS bytes, adapter/helper manifests and boundary absence, imports, string pool, startup flags and validation result. Binary byte identity is not presumed between different emitters; preserve actual semantic/metadata equality and report any byte difference honestly. Poison all four legacy generator entries only on the new bridge arm, with a healthy legacy arm proving the poison detector attaches.
3. Paired zero-demand controls prove why numeric undefined signatures/empty async/import/startup state are legitimate. Contradict one real source classification, ABI binding, actual export index, source span, runtime import, startup evaluation or option association at a time; require the specific gap/failure and no final artifact. Use production-private seams only as existing test mocks permit; do not add a public producer bypass.
4. Prepare/accept/emit exactly once; same source capture and options survive an observer mutating the original caller bag. Each output finalization is one-shot within the transaction. Preserve real Unsupported, invariant and backend error channels; no fallbacks or partial successful artifacts. Actual binary engine-validation failure retains the existing finalizer's failed-result semantics and bytes and is never counted as bridge success.
5. Run focused ordinary new and existing driver/public-output tests after implementation release, including known source-map/object failures with accurate baseline attribution. Collect actual names/counts; no runtime denominator is asserted by this spec. The old private-phase publisher repair is an independent public-certification dependency, not a blocker to this genuine artifact test, which uses real C identities/receipts and actual executed output rather than trusting events.

This is a required useful increment toward the real IR path. A successful internal numeric checkpoint still does not satisfy complete frontend parity, full target coverage, public routing, C ABI/provider metadata or legacy retirement. The held source scopes and unchanged6837 measurement criteria remain intact.

<!-- Astra source dual-host-startup-dispatch-amendment.md SHA256 0c69fdc951a73bf97fbc2195e2d4195730a058a95e04397f67d776a165e9f9be -->


### R5 dispatch contract — two genuine host outputs and observable startup (2026-10-04)

This is an append-only refinement of executable checkpoint a5ec87ea. It specifies three disjoint writer paths and startup obligations; it does not open A, C, providers, public routing, legacy retirement or a multi-backend framework. Source facts below are from immutable 650cb1b0a08df7976662c721e0da884b109fbfe0. No new compiler or runtime execution was performed for this amendment. Existing6837 measurement remains separate and its exclusive CPU window remains in force.

**Resolved dual-backend boundary.** Follow the integration owner's latest bounded instruction: the required internal artifact entry handles one resolved backend per call. Run it on the identical genuine source graph for wasmgc:host and linear:host, with matching frozen source census, options and semantic outputs. Each call invokes the existing `runIrProgramDriver` once; these are two genuine preparations, and tests must not assert or report reference identity between them. Separately retain an actual shared-packet positive using the existing COMMON_SUBSET producer pattern in `issue-3518-program-codec-replay.test.ts`: one authentic preparation with both runtime policies, then two real C acceptances/emissions of that exact program. Assert same program/ABI/IR identity there and execute both outputs. This separate witness does not pretend the new artifact entry already reuses one packet across calls. A future reusable presentation-capture join for dual artifact emission remains explicit work; no driver API mutation is needed for this checkpoint. Do not call runIrProgramDriver twice and label that one preparation.

#### Fixed interface and file-disjoint dispatch

1. **Root only: `src/compiler.ts`.** Own the existing finalizer signature/context projection and the new internal exported function `runPreparedIrPipelinePresentation(input: PipelineInput): PreparedIrPipelinePresentationResult`. This is an internal module export for compiler composition/testing, not a `src/index.ts` export or public option. Keep PipelineInput's existing field meanings and existing public/legacy routes unchanged. Introduce the erased internal alias `PipelineOutputContext = Pick<PipelineInput, "errors" | "options" | "entryAst" | "diagnosticAnchor" | "sourcesContent"> & { readonly codegenOptions: Pick<CodegenOptions, "link"> }` for the finalizer. Link collection identity is preserved, not recomputed. Legacy calls remain structurally assignable and delegate to the original whole finalizer, in its original order. Root owns resolving the actual target profile and constructing existing PreparedIrBackendOptions, projecting the complete analyzed source/checker input into IrWholeProgramPreparationInput, and calling the new leaf. Original frontend diagnostics cannot be bypassed by treating an arbitrary bag as validated: the internal input precondition and real ordinary fixtures must retain the same analyzed graph and pre-generation diagnostics; no public success is issued for erroneous input.
2. **Sol source only: NEW `src/compiler/ir-program-presentation.ts`.** Export the erased types `IrProgramPresentationRequest`, `IrProgramPresentationResult`, `PreparedIrPipelinePresentationResult`, and the function `prepareIrProgramPresentation(request: IrProgramPresentationRequest): IrProgramPresentationResult`. The request has exactly `preparation: IrWholeProgramPreparationInput`, `backendOptions: PreparedIrBackendOptions`, and `output: PipelineOutputContext` (type-only import from compiler.ts). It has no callback, emitted module/program argument, authority token, completion boolean, fixture ID or test hook. Root is its production caller. Check that output entry/checker/source identities are those of preparation, and that resolved backend/host/options/defer semantics agree; contradictory association is a located presentation gap. Capture frontend primitive boundary/declaration/resource facts and data-only options once before calling the real driver, retain the same authentic AST/checker for rendering, then join returned genuine inventory, ABI/export slots and physical evidence to that capture. No legacy body generator, second preparation or user-supplied emitted result is allowed. Runtime imports flow compiler→leaf→existing driver/C facts; leaf→compiler is erased only, preventing a new value cycle.
3. **Sol tests only: NEW `tests/issue-3525-prepared-pipeline-presentation.test.ts`.** Consume these exact exports and genuine analyzer/preparation/C APIs. Do not add production injection seams, import a sibling worktree, edit original tests, or independently change either writer's source. Use existing Vitest module spies only for refusal/legacy nonentry witnesses, with real successful unmocked output first. Root alone integrates the three files and records final claims/source pins.

The leaf result is a finite discriminated union:
- `{kind:"prepared-presentation", program, emission, output, startup}` with genuine exact returned PreparedIrProgram/EmittedPreparedIrProgram references, captured PipelineOutputContext, and the startup disposition below;
- existing driver `{kind:"unsupported", phase:"preparation"|"acceptance", failure}` unchanged, preserving the original located failure object;
- `{kind:"presentation-unsupported", gaps}` where each nonempty gap records a stable field/code/detail and its actual source/unit/binding association where available. This is not a fabricated language Unsupported. Invariants and emission exceptions retain original throws and causes.

Root calls the original finalizer once only for `prepared-presentation`. The internal entry's result is `{kind:"artifacts", program, emission, startup, artifacts}` on actual finalizer success, `{kind:"output-failed", errors}` on actual failed finalization, or the unchanged unsupported/presentation-unsupported arms. `artifacts` is an explicit Pick of existing CompileResult output fields actually produced, excluding legacy route/fallback telemetry; do not spread a whole legacy-shaped result and fill missing counters. Retain the original diagnostic objects, warning/error severity, and real failed-result semantics; any emitted bytes retained on failure are diagnostic evidence, not a successful artifact. Root may use the prior minimal optional telemetry parameter, leaving legacy callers' real telemetry identical. There is no test-only alternative finalizer or completion shortcut.

Freeze these discriminants before parallel code dispatch. Exact imported existing types, rather than copied structural replacements, own program/emission/backend types. Runtime startup records contain no AST and no mutable approval Map. Do not grow this contract into generic pass/plugin scheduling.

#### Startup: actual producer and the missing presentation join

`program/startup.ts` records source ID, unit ID, executable evaluations, bindings/seeds, gaps and invocation policy. `program-physical-plan.ts::planPhysicalStartup` derives the actual ordered executable unit population and adapter kind; `program-consumer.ts::fillStartupAdapter` emits their ordered calls. C reserves the adapter under the identity `physical:startup-adapter`; its display name is not authority. `module-reservations.ts::defineStart` validates a real zero-argument/zero-result callable and sets its physical index. `emittedStartupAdapterIndex` must be used only after genuine emission authentication (including actual completed support receipts); undefined alone is not an authenticity check.

The concrete missing bridge join is **authenticated prepared startup units/policy plus actual C adapter index → output startup disposition/hasTopLevelStatements**. C does not assign the legacy presentation field `module.hasTopLevelStatements`. Do not mutate C's physical program or infer this flag from an export spelling. Root's finalizer output context may gain one internal optional `preparedStartup` value produced by the leaf; the returned hasTopLevelStatements uses that authenticated boolean only for the new internal route, otherwise the existing `mod.hasTopLevelStatements === true` expression remains unchanged. Physical functions, exports, start index, globals and C receipts must remain exact before/after finalization.

Use the finite disposition `{kind:"none", hasTopLevelStatements:false}` for independently proved zero demand; `{kind:"wasm-start", hasTopLevelStatements:true, adapterIndex, unitIds}` when exact actual start index matches the authenticated adapter and ordered program units; or `{kind:"deferred-export", hasTopLevelStatements:true, adapterIndex, unitIds, exportName:"__module_init"}` when that actual export index equals the adapter, module.startFuncIdx is absent and real policy is deferred. A nonempty unresolved startup gap cannot yield any success arm. No expression `exports.__module_init != null` may replace these joins.

A user function named `__module_init` can coexist with automatic Wasm start. It must retain its own different function index/body and must never be invoked as the adapter by output code. Conversely the current physical planner refuses a deferred startup export collision with a program export of that name: retain that exact located refusal, without dropping/renaming the user export or adapter.

#### Required observable, non-idempotent startup proof

The existing `answer=42` and dependency-order examples alone cannot detect duplicate startup because declarations can reseed their storage. The new suite must have a real scalar state witness that distinguishes zero, one and two evaluations on BOTH host backends. Start with this genuine source candidate (not a special-cased eligibility rule):

```ts
export var visits: number = (visits > 0 ? visits : 0) + 1;
export function read(): number { return visits; }
```

It reads the prior global before writing its initialized value. First complete evaluation must yield1 and deliberate second evaluation must yield2. Actual preparation, emission, engine validation and calls decide acceptance; this spec does not claim this previously unexecuted candidate is already supported. Do not substitute `var visits;` plus assignments: `from-ast.ts:3559` explicitly rejects a declaration without an initializer. Do not replace the witness with an initializer that always assigns0/1/42, inject a handcrafted IR/global, patch emitted Wasm, or weaken the second-evaluation expectation.

For each backend, prepare and emit the deferred variant with actual deferTopLevelInit=true: before invoking the authenticated exported adapter, independently read the initial state; then call the real adapter once and require1, and deliberately call it again in a fresh negative/control experiment and require2. Use a separately instantiated module for every independent scenario. This proves the witness is non-idempotent, not that C makes its adapter idempotent (it does not). For automatic startup, the matching source with defer=false must expose read()==1 immediately after instantiation and remain1 through helper setInstance/wiring; it must not be manually initialized a second time.

Add an automatic-start variant with the genuine user function `export function __module_init(): number { visits = visits * 10 + 7; return visits; }`. Before explicitly calling that user API read()==1; the deliberate user call returns17 and read()==17. Test the distinct physical user and adapter indices. If output code calls the user function merely because of its name, the pre-call expectation fails. The deferred collision form must preserve the existing planner refusal.

The source candidate's self-read/global binding route is a genuine admission question. If A cannot lower it, preserve the precise refusal/field and the actual module-init plan/IR evidence. The bounded missing producer is then a supported self-reading var-initializer/global-binding startup witness (not permission to edit from-ast, A or C under this claim). Productive no-startup numeric artifacts still must execute; however **startup acceptance stays incomplete and this entire requested startup checkpoint must not be reported complete**. Root must decide any separately scoped producer follow-up using that concrete failure. An all-refusal metadata framework is not an alternative delivery.

#### Generated helpers, manual startup and limitations

`compiler/output.ts::generateImportsHelper` calls instantiateWasm and then setInstance; it does not call __module_init. `runtime/instance-lifecycle-adapter.ts::setInstance` wires exports and drains deferred operations, also without that call. Therefore the automatic-start positive must exercise the actual generated helper path as well as direct native instantiation; it must not pretend the helper performs deferred startup. For deferred artifacts, the internal disposition explicitly requires the caller to wire imports then invoke the authenticated adapter once. The test owns that explicit call and proves its count using the non-idempotent state, not a fake counter. No new public helper or provider behavior is claimed.

The import runtime currently catches a failed native-builtins instantiation and retries with polyfills. Throwing/effectful startup could therefore be attempted twice; this is a static pre-existing limitation, not a newly measured defect. The narrow nonthrowing scalar witness must succeed without relying on that fallback. Preserve actual thrown-start errors as an explicit unproved family; do not alter runtime retry logic here. Existing linked-provider initExport and public manual harnesses still use names; their broad reconciliation is not implied by this internal output transaction. `CompileResult.hasTopLevelStatements` means actual executable top-level work, not “manual call required”; adapter mode provides the latter distinction.

#### Acceptance and release sequencing

Require real binary execution for calculate(7)=23/calculate(11)=35, two-source main42 and a nonconstant cross-source/loop control under both host backends; exact source/census association and real primitive export boundary/async/import zero-demand witnesses; original legacy semantic/artifact controls; the separate shared-packet A+C positive; and the non-idempotent startup/user-name/refusal controls above. Preserve literal expected values and existing source-qualified join/poison/refusal/error controls. Full names/counts are collected only after implementation; none are guessed here. Distinguish static feasibility, runtime assertions and artifacts actually returned. No full-target, public-route, fullIR-parity or efficiency claim follows from this checkpoint.

Root handles canonical ownership. Request fresh bounded keys `3525:internal-presentation-bridge-source`, `3525:internal-presentation-bridge-tests`, and `3525:internal-presentation-finalizer-context` (exact spelling is proposed, not a claimed effect), respectively for the new leaf, new suite, and the compiler.ts subsection above. Root records narrow same-session continuation of the historical A/output planning interface while retaining the old branches and claim records; this is not another user-approval prerequisite. Existing authoritative-preparation, driver-output-planning, production-routing and C/provider source scopes remain consume-only. Historical private-observation-origin repair is separately owned, not bundled here. The one known PR6341 finalizer overlap is its future stampAllocationOwners insertion after C ABI/before widening; it is absent650 and must neither be inserted gratuitously nor erased when eventually integrating fresh main. Other compiler option/early-error hunks are excluded.

Root may release source/test writers after it reads this exact contract, authenticates claim effects and the original benchmark has actually terminated. Root integrates their three disjoint paths; no duplicate edits to compiler.ts, old tests, driver or C. This supersedes the earlier single-writer3-path allocation and blanket historical-A acknowledgement wording only. All earlier substantive source/metadata/invariant safeguards, public-cutover holds and unchanged benchmark criteria remain in force.


### Prepared output checkpoint — measured evidence (2026-10-04)

This bounded internal checkpoint keeps public legacy routes in place. The actual
whole-program producer and authenticated consumer emit before the original
output finalizer runs; no arbitrary module, caller callback, forged receipt or
invented legacy telemetry enters the transaction. Sol GPT-6.1 Medium implemented
the separate presentation leaf and new tests; Astra High reviewed the contracts;
Codex GPT-6.1 Sol High integrates and delivers. Canonical scoped claims are
`3518:output-finalizer-context-20261004`,
`3525:prepared-presentation-internal-20261004` and
`3525:prepared-presentation-tests-20261004`. Existing historical claims remain.

The full new suite passed **44/44**, ordinary Node 24.4.1 execution with zero
pending/todo tests and empty unhandled-error channels, actual child exit 0.
Both host backends execute numeric single-/multi-source fixtures, genuine
same-packet projections and non-idempotent automatic/deferred initialization.
Deferred startup is observed as 0 → 1 → 2; automatic startup is 1. The actual
user export named `__module_init` remains separate from the constructed adapter.
Both actual generated helpers execute independently. Linear artifact comparisons
are exact; WasmGC legacy symbol-bookkeeping strings produce an explicitly tested
pool/manifest/helper difference. All remaining compared fields are exact. This
is field-qualified compatibility, **not** a claim of full artifact parity.
Four post-emission corruptions fail at the authentic completed physical
reservation guard; they do not claim later leaf-gap coverage. Engine validation
retains failed bytes and asserts actual line/column/no-file diagnostics.

Initial new-suite attempts remain recorded: 12/42 (fixture source-content keys
mismatched analyzed filenames), then 36/44 (eight exact oracle mismatches). Their
raw failures were preserved; neither production gates nor existing fixtures were
weakened. Final test SHA-256 is
`8db9925b90b3422dfb052205dfedddb7b409a0d79cb2821eaf98d87b644c5e60`;
ordinary runtime audit SHA-256 is
`6a89cb47a2fb2c7b9475a0f2ee5baa171d432a85c07179ec7393314159fbbc1b`.

Existing ordinary suites: public prepared driver 16/16, shared pipeline 10/10,
safe mode 14/14, validation-by-default 7/7 and emitted-binary validation 5/5.
The six-row multi-finalizer suite remains 4 passed / 2 failed. All six ordered
rows and full failure texts match clean commit
`650cb1b0a08df7976662c721e0da884b109fbfe0`, allowing only absolute worktree
path replacement. The thenable host-drain and exnref failures are measured
baseline failures, **not** passing coverage. Baseline-comparison SHA-256 is
`fa9c7ca5188926e4d74940e66063b67f595703ffa1028367192369d7c0317e96`.
Early-error tests initially failed twice because this fresh worktree lacked
harness files. Only pinned Test262 `assert.js` and `sta.js` Git blobs were added
as resources; full rerun passed 13/13. This supplies that fixture's bounded
resource closure, not a full local corpus or conformance proof.

Root full typecheck, scoped lint/format and oracle ratchet passed. The native LOC
gate passed using this issue's finite +121 compiler glue grant; no baseline or
global threshold changed. Source leaf SHA-256 is
`9587f036bcef0f09f175b8a1b8d3aa1ebd82272849caa71988209f3373fdd135`;
compiler source SHA-256 is
`0244548a33020e60db74c3d5be145bdaf805e48eac2e28b1a5641cc7d7824e46`.

This is not whole R5 acceptance or legacy retirement. Broader runtime providers,
carrier/layout coverage, public route ownership/observations, full options and
targets, optimization/performance equality and protected main delivery remain
separate requirements. Existing PR 6475, “refactor(ir): give linear layout
contracts and backend legality canonical owners”, remains a dependency until its
exact content and merge-group evidence are verified on main.


## Measured coverage update — private prepared presentation checkpoint (2026-10-05)

These additional isolated diagnostics preserve the existing 44/44 host-checkpoint scope. They neither change acceptance criteria nor certify public routing, full artifact parity, performance, or legacy retirement. Compiler `0244548a33020e60db74c3d5be145bdaf805e48eac2e28b1a5641cc7d7824e46` and presentation leaf `9587f036bcef0f09f175b8a1b8d3aa1ebd82272849caa71988209f3373fdd135` remained unchanged.

Six fresh scalar admission probes completed with recorder exit 0 on Node 24.4.1. WasmGC/host and linear/host produced real artifacts; each original generated helper instantiated its own binary in a successful child and returned 23 and 35 for inputs 7 and 11. WasmGC/standalone and WasmGC/WASI returned `presentation-unsupported`, `backend/option-association`, before deeper provider processing. Requested linear/standalone and linear/WASI cannot be expressed through this entry's existing target options: both resolved to WasmGC and returned the same early refusal. They supply no linear non-host runtime evidence. Thus six requests represent four distinct selectable backend/target pairs, with two productive host transactions. The saved recorder's `freshPreparations: 6` label means six fresh analyzed inputs/entry calls, not six completed real driver preparations; four requests stop before that driver.

The original retained D fixture was extracted unchanged from `tests/issue-3518-program-codec-replay.test.ts:611`: three source files, fixture JSON SHA-256 `236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb`. Separate genuine WasmGC preparation produced seven terminal units: three module initializers and four functions (`initial`, `readPhase`, `compute`, `run`). Both host presentation calls refused the async declaration in `entry.ts` with `declaration/non-numeric-boundary` before invoking their driver. Separate genuine linear preparation refused `body-shape-rejected`: `promise.capability.create` has no linear adapter, located at `entry.ts:16:3`, declaration range 460–675. This later producer result is an independent observation, not the presentation refusal's path. No mixed-program emission, finalization, or runtime parity was measured. The two accompanying scalar controls executed real emitted Wasm and returned 23/35 on both backends.

The D recorder's original exit 1 from BigInt JSON serialization remains preserved. Its corrected serialization-only recorder completed with exit 0; all 1,955 saved custody entries matched before/after. The six-target probe's seven saved source/toolchain entries likewise matched. The independent audit rehashed all 33 six-target raw artifacts and all 22 D custody-index artifacts without rerunning either probe.

The existing requirements remain open: the retained mixed application and independent mixed application checkpoint; complete multi-source/async/live-binding/class/closure coverage; productive standalone/WASI startup and providers; expressible and tested backend/target combinations; complete public IR routing and terminal-unit accounting; full conformance/error-channel gates; and measured optimization non-regression. These observations locate current stopping points without replacing working legacy behavior or counting typed refusals as complete migration. The private numeric host checkpoint can be assessed on its own existing evidence; it does not satisfy those broader requirements.

Evidence: six-target review SHA-256 `e00bbaaa5c6956014576117c9db8b3c1fff574fb196aaabde49e6f0b525e879b`, raw results `835eaac38428f5e02eb9aaa0ab323b1517f692a465d623ac6f7d1eaa7caf0100`; retained-D review `d2c6619af579c0fb9f38256f8eae42b6f615748ce2a20391bdd1093c6ceb9aee`, raw results `a3272f9d79a8d94d6d79662f1a97476d9bbab964da9c4d358e049d08b5f418b0`. This appendix is evidence only; no new implementation scope, ownership grant, gate change, or retirement permission is introduced.

Additional primitive-domain diagnostics completed with recorder exit 0 and unchanged source/toolchain custody (review SHA-256 `900c6b2f1a832f131ac5245cd4c6fb3c3c88e9404e3d48a15ab472c2d215f141`). Six fresh admission probes comprise two repeated numeric positive controls, two genuine `finish(value: number): void` host transactions, and two `negate(value: boolean): boolean` host requests. Both original generated void helpers instantiated their own binary and returned JavaScript `undefined` for arguments 1 and -1; both runtime children exited 0 with empty stderr. This establishes those void-return observations, not internal branch coverage. Both boolean requests stopped at `entry.ts` declaration/non-numeric-boundary before emission. All four productive transactions used real emitted artifacts; no boolean wrapper or widening workaround was introduced. These scratch observations add no rows to the frozen 44-test acceptance denominator and do not establish a complete primitive domain.

A final independent private-pipeline diagnostic completed six transactions (scalar, numeric for-loop, and recursive factorial on each host backend) with recorder exit 0. Twelve real exported calls matched: scalar 7/11 produced 23/35; summation 7/11 produced 28/66; factorial 5/7 produced 120/5040. Each transaction finalized a real artifact without errors and recorded the ordered observer phases prepared, accepted, emission-started, emitted. These are observed lifecycle events, not independent API-call counters. The 1,954-entry saved custody vector remained exact; nine indexed evidence artifacts were independently rehashed. Review SHA-256 `28aa146d25032d242dd72121f89fbf322f755d1d4801b77e834767eee4e50b51`, raw results `285e1eecee7f239bf9b32e605addca4f12a7762cb17bc43510d9acdf83346d80`. This six-transaction/twelve-call denominator remains separate from the 44-test suite and supplies neither performance evidence nor general recursion, loop, mixed-async, or full IR parity coverage.


Delivery preparation: signed checkpoint `75308922465e52880270fb1ec7e231aee61342b4` completed normal hooks with all 18 selected suites passing (2,690/2,690). Five committed paths retain their reviewed bytes. The hook uses its existing ignored-unhandled-error flag; independent ordinary 44/44 evidence remains separate. Canonical main `27b18d375f0c446fcd5662056a35261db9881f7b` was read freshly for composition; all 33 incoming paths are preserved exactly. PR publication and protected delivery of this checkpoint remain pending.


## Implementation Plan — repair private presentation inventory classification before allocation composition

Architect: Codex GPT-6 Astra High, 2026-10-05. This is the bounded repair for the actual PR6481 quality job111554847774 failure, not an IR retirement or source-algorithm change. The raw job log reports only `unclassified-module` and `unclassified-target` for `src/compiler/ir-program-presentation.ts` at lines476–479. The actual command is unchanged `node --max-old-space-size=2048 scripts/check-compiler-boundaries.mjs --mode inventory --base HEAD^1`. Root handles the normal merge of canonical f41a11059ccc7f646ae907d6b992b7dc50509938; its reported six benchmark-mirror paths remain intact. The failed job stays recorded and does not become a pass until the repaired exact head is verified.

### Truthful minimal policy delta

The leaf imports the genuine frontend wrapper `src/ts-api.ts`, the compiler driver, compiler/index types and physical emitted-program support. It combines AST declaration capture with prepared-program output association. It is not a compatibility facade, pure IR analysis, or nonmodule. The current schema allows only states `unmigrated`, `clean`, `compatibility-adapter`; there is no `frontend-boundary` state. The compiler layer is planned, with root `src/compiler` and entry `src/compiler/ir-program-driver.ts`. The frontend-ts layer is active and would incorrectly enforce this leaf's complete closure as clean. Therefore append precisely this row, using the existing migration-debt mechanism:

```json
{
  "path": "src/compiler/ir-program-presentation.ts",
  "state": "unmigrated",
  "layer": "mixed-needs-split",
  "destination": "compiler",
  "owner": "3525-prepared-presentation",
  "nextBoundary": "Separate AST declaration capture and finalizer presentation from prepared-program output association before compiler-layer activation."
}
```

Append at `files[1824]`, after the existing clean backend-legality row; 1824→1825 file rows. Preserve the complete old file prefix, all 104 activation records, 12 moves, every layer/root/entry/minimum, allowedEdges, frontendWrapper=`src/ts-api.ts`, nonModules, resolver options, evidence and external package/asset policy. No activation, move, root addition, compiler clean certification, or new edge permission is justified. The row's owner is this finite issue's presentation boundary, not an assertion of broader source custody.

The unchanged scanner validates the row's destination/owner/nextBoundary (`buildPolicyIndex`, lines145–153), resolves and classifies actual imports, retains every forbidden edge, and still forbids clean/active origins from reaching debt (`enforced`/`forbidden`, lines487–492). Its frontend-wrapper restriction at559 is unchanged. Existing mixed compiler neighbors are similarly recorded debt. This fixes complete inventory, not architecture completeness: new retained debt/forbidden paths are reported and inspected, not silently called IR-clean. Any unexpected enforced clean-origin violation is a genuine blocker; do not add permissions to hide it.

### Authenticated predecessor and finite reciprocal receipt

Preparation input is immutable5a633bf93ec0e7b9d2992334d00f1279c7bd2c25: policy583986/SHA0cbff25993c92150c6c7cd45934b25552b315266833adc84301f49287d3982ee; policy helper356816/SHAf195d0c432429bfb43c3f8a65617c886ef176e24fa81c2c6539845575fc01a54; D1 lowering-analysis receipt13393/SHA72db51a0e892a4fa8a2d9762042eacc8d88609ccd0ae1ac80f9f548852e04f9b; current C1 manifest349785/SHA464789d00ab368042da0ed874b9e44d5311ef5dc054002d1ec02ac888397abcb. Root must confirm these exact relevant streams after the normal main merge before releasing final receipt values. The preparation commit is not relabelled delivered main.

Root owns new `tests/helpers/ir-runtime-program-policy-presentation-classification.json`. Freeze exact schema/kind, explicit preparation provenance, complete helper prefix pin, D1 predecessor receipt path/fullpin, top-level key order, complete before/current source SHA/byte/blob pins and ordered semantic profiles (including files, layers, allowedEdges, activationHistory and moves count/digest), final-row index/literal/previous neighbor and one complete raw UTF8 edit. Whole before/current profile equality to D1 receipt.current is mandatory. This is a fixed row-classification proof, not a generic policy upgrade facility.

The architect's unformatted provisional row-only projection is 584358 bytes/SHAb1693461855cc60546bb29bee370c02ad3cf21e17e539d521c8f2b6598b0e411; one tail-region span begins at UTF8 byte583862, replacing 118 bytes with 490. This is a static recipe proposal only. Root runs the actual pinned formatter with the real repository stdin filepath and `--ignore-path /dev/null`, saves its output/terminal, then derives and independently verifies the final full inverse/replay from those exact formatted bytes. If formatting adds unrelated changes, isolate/justify them before release; do not widen the recipe silently. No before data or historical source hash is repinned.

Do NOT pin the numeric leaf's entire27514/9587 body in this classification receipt. The already-reviewed Boolean leaf29833/9eba legitimately changes its algorithm while its classification remains the same migration debt. This receipt asserts only an exact policy row and preserves the immutable policy predecessor; actual inventory discovers the live module/import graph. A source-body pin here would assert an unrelated immutable implementation contract and create a false Boolean failure. Normal source review, compiler tests and actual native inventory retain responsibility for implementation/edges. Do not add a separate executable proof helper or a new C1 source domain merely to classify this row.

### New outer APIs and helper ownership

One writer owns only an append to `tests/helpers/ir-runtime-program-policy-evolution.ts` and new `tests/issue-3525-presentation-classification-policy.test.ts`. Preserve the entire356816-byte predecessor helper exactly. Add the explicitly named APIs:

- `capturePresentationClassificationPredecessorPolicy(value: unknown): MutableIrRuntimeProgramPolicy`;
- `capturePresentationClassificationPredecessorPolicySource(raw: string): string`.

These return the authentic D1 current policy, suitable as the unchanged input to the existing lowering-analysis inverse. Reuse established pure capture/freeze/digest support without editing any old API. Descriptor/own-data validation for semantic input and primitive-string refusal for raw input happen before any I/O/coercion. Each healthy invocation freshly reads the exact fixed new receipt, actual complete predecessor helper prefix, and old D1 receipt, then executes the unchanged fresh C1 authority authentication. The authenticated current C1 instrument must include the new full policy-helper bytes, so the new suffix itself is covered before an accepted result; it is not self-approved by a module cache. Preserve the concrete read order and prove it in new controls. No global cache, captured approval, fallback, recursive historical chain, or hash-selected epoch is allowed.

Require exact fixed receipt object/schema/fullpin, complete old receipt.current equality, full current raw/semantic profiles, one unique added row at1824 with exact key order and predecessor neighbor, and unchanged every other ordered field. Semantic inverse removes only that row; replay inserts it back at that position. Raw inverse/replay uses validated safe-integer/nonoverlap/range UTF8 byte coordinates and exact span text, including surrounding separator. Authenticate the complete output raw pin and cross-check semantic/raw inverses. Wrong path/state/layer/destination/owner/nextBoundary, reorder/duplicate/missing rows, altered history/moves/roots/edges, and semantic-equivalent whitespace must refuse. Count/hash moves using the actual fixed12 profile; do not import stale7 literals or change historical7 checks.

The new suite must use root-supplied literal profiles and one independently computed row-only inverse/replay, not expected outputs obtained from the helper under test. Require both genuine positives and their authentic full predecessor source/data pins; paired primitive/accessor/symbol/hidden-field priorities against missing new receipt; genuine before-domain refusal; valid-JSON full row-content/order/neighbor/history/edge faults; raw same-length/span/whitespace faults; and fresh physical missing/corrupt receipt, predecessor receipt and helper-file tests, healthy before/after with byte/mode/inode/device restoration, persistent backup/lock and unswallowed operation/restoration errors. Reuse the reviewed restoration pattern. A mutated helper may fail the earlier complete-prefix or C1 fullpin guard; assert the genuine first guard rather than pretending to reach a later one. Collect the actual new denominator before bodies; no number is claimed by this plan.

### Exact caller adaptations and priority preservation

The second writer owns exactly the following existing14 files, independently from the helper/test writer. The first13 contain19 D1 initial operands:15 raw and4 semantic. Add only the required import and new outer projection immediately before the unchanged `captureLoweringAnalysisPredecessorPolicy[Source]` initial operand. The final file needs the special application preparation described below.

```
tests/issue-3518-canonical-3c6-inventory-successor.test.ts
tests/issue-3518-canonical-489d-inventory-successor.test.ts
tests/issue-3518-current-main-inventory-successor.test.ts
tests/issue-3518-nested-stackification-policy-evolution.test.ts
tests/issue-3518-number-prerequisite-policy-evolution.test.ts
tests/issue-3518-program-data-contract-boundary.test.ts
tests/issue-3518-program-validator-policy-evolution.test.ts
tests/issue-3518-runtime-data-contract-seam.test.ts
tests/issue-3518-runtime-program-policy-evolution.test.ts
tests/issue-3518-semantic-provider-boundary.test.ts
tests/issue-3518-validation-policy-evolution.test.ts
tests/issue-3518-wasmgc-helper-policy-evolution.test.ts
tests/issue-3518-well-known-symbol-policy-evolution.test.ts
tests/issue-3518-lowering-analysis-preservation.test.ts
```

In the D1 preservation suite, keep its47 registrations/full direct API/error/primitive/descriptor controls. Its `applicationInput` at692 freshly reads the new policy, proves the outer projection BEFORE any fault, then checks the unchanged authentic D1 current pin. Leave `normalApplication` old raw/semantic calls727–728 and direct hostile-input calls848/870 unchanged. Preload child807 receives the per-action proved operand as literal data prepared before fault; it still imports and invokes the original normal application under the actual changed/missing implementation condition. Never call the new outer capture inside that corrupted-helper child: doing so would intercept the old guard and destroy its proof. Preserve healthy-before/after, missing-helper witness, actual zero getter/coercion and both child channels. No canned policy bytes or helper-body precheck replaces the actual application.

The six delivered hostile-factory preparations in the old wasmgc suite stay exact. All original names/order, assertion operands, full APIs, mutants and fault bodies remain unchanged except explicitly reviewed initial setup/preload data preparation. Produce complete14-file byte inverses/replays and AST registration/assertion comparisons against the authentic selected predecessor. The currently frozen allocation14-reader packet1c78f2c remains a separate original5a preparation: use its reviewed mechanical shape if helpful, not its outer API or policy epoch. Do not overwrite that work or claim its static checks validate this new classification packet.

### Root C1 assembly, Boolean dependency and allocation sequencing

Root alone owns policy/new receipt, current-source binding test, manifest and anchor, issue/handoff and integration. For the numeric PR repair, keep the numeric real type closure/H1/H2 exactly current; do not inadvertently include pending Boolean APIs or C1 overrides. Exactly five of the12 current instrument paths change from caller/helper edits: policy helper, program-data-contract-boundary, runtime-program-policy, well-known-symbol and Number. Their five complete original-to-current recipes must be rebuilt from authentic historical originals; the other five recipe objects and seven instrument pins remain exact. Independently reconstruct/replay/invert ALL10 full recipes against current frozen files, preserving every old before pin, 11 immutable authorities, seven artifacts, resolver/config/bases/declaration meanings and read domains. Bind the final manifest SHA, anchor and unique external current-source scalar last. Preserve all current292 numeric C1 registrations; do not replace them with stale278 content or opportunistically copy Boolean306 content.

The pending signed Boolean71ecd796772814f6bb37c4b5fda214d109852ce3 remains preserved. After this corrected numeric dependency is selected, root composes its already-reviewed types/H1/H2/14 new current-source controls onto the corrected manifest rather than copying the stale Boolean full C1 trio over the repair. Boolean changes the actual types closure/H1/H2 pins; it does not undo the new five policy/caller pins or historical recipes. Run appropriate final Boolean C1 evidence on the resulting exact epoch; previous1297 is correctly attributed to the older Boolean manifest44a7 and is not final composed acceptance.

Allocation classification comes after this repaired presentation row. If no intervening metadata changes occur, its root remains index13, but its added row shifts1824→1825 (total1826); predecessor neighbor becomes the new presentation debt row and its helper prefix/predecessor receipt become this exact new classification epoch. Its prepared599118e3 receipt and allocation helper/14-reader drafts remain private prior-epoch artifacts. Rebuild their fixed successor from the root-authenticated final predecessor, not by changing a broad accepted digest set. This fixes the dependency ordering before expensive final C1 work, without losing source3/typed controls or partial benchmark evidence. No allocation performance retry is included.

### Required acceptance and release limits

Freeze the complete correction vector first. Before normal hooks, execute actual inventory with the same immutable-first-parent semantics as CI, save full nonempty modules/edges/debt and require both original unclassified diagnostics absent while retaining all debt/forbidden evidence. Require no new unknown/unresolved or enforced clean-origin violations; explain actual changes from resolved formerly-unclassified edges, never accept a tally alone. Run unchanged layering/cycle/native type/lint/format/LOC/function checks appropriate to metadata and helper changes. No scanner flag, baseline ceiling, ignore entry, timeout, clean-edge rule or workflow is weakened.

Run the new fixed policy suite and the entire affected old caller population with collection/runtime name reconciliation, error/RPC audit and full input custody in isolated physical copies or exclusive sequence. Existing predecessor evidence is2254 old13 callers plus47 D1 preservation and292 numeric current-source controls; verify those names/counts against the selected current sources before claiming actual new totals. The new suite's actual count is separate. Complete old immutable/inverse contracts must remain admitted, not merely the new positive row. Root may partition file-disjoint physical checkouts to avoid serial waits, but must preserve complete pins and exact final epoch attribution. The old numeric44 remains finite source acceptance; policy repair adds no compiler semantics or runtime performance claim. Finish ordinary normal hooks, exact-head quality/required checks and protected delivery on existing PR6481; no duplicate PR or legacy retirement.


## PR6481 inventory repair integration checkpoint (2026-10-05)

The original quality job111554847774 failed unchanged compiler inventory on the new presentation leaf. The failure is preserved. Root merged canonical f41a11059ccc7f646ae907d6b992b7dc50509938 without conflicts; its six benchmark/mirror changes remain staged. This scoped correction records the leaf as unmigrated mixed compiler debt, not clean IR, and does not change the reviewed compiler/presentation algorithm or public legacy entry points.

The actual pinned formatter accepted the exact one-row policy584358/b169346 and fixed receipt4227/dd0273b. Native inventory exited0 on the CI command:1825 modules,12 leaf incident edges,13 retained unenforced leaf forbidden reasons,13388 retained forbidden rows,4 predecessor-identical dynamic unknowns,0 unresolved or enforced transitive violations. Inventory is valid; architecture and graph completeness remain false. Native source typecheck, IR layering, import cycles, LOC/function budgets and oracle ratchet each exited0.

Sol6.1Medium supplied an append preserving the complete356816/f195 predecessor helper (freeze49101c), a new classification suite (45 static controls, actual collection/runtime still pending here), and14 reader adaptations (freeze8d949). The complete14-file inverses/replays and original registration/assertion ASTs are preserved, including the original47 physical-fault controls. AstraHigh independently reviewed the minimal debt row, fixed receipt,14 readers and actual inventory. Root's bounded assembly defects were corrected before execution; the unsuccessful scaffolds and reviews remain recorded.

The exact final numeric C1 manifest is364386/a42e073b066a92eb867e7794b2dca8101b8c70d0c766a27fce206e3ddedf667b. All10 complete original-to-current recipes reconstruct and replay; exactly five current policy/caller recipes and five instrument pins change. Seven other instrument pins, five other recipes,11 immutable authorities, seven artifacts and resolver/bases/declaration meanings stay exact. The actual unique TypeScript external scalar is decoded and bound to the manifest and anchor; the rest of its292-case suite is byte-exact. All three candidate files passed the real formatter before installation, and captured bytes/identity/modes were rechecked. Runtime and normal hook results must be read from the actual exact-epoch receipts, not inferred from this static checkpoint.

Existing PR6481 is the delivery target; no duplicate PR or retirement is authorized by this repair. Signed Boolean71ecd796772814f6bb37c4b5fda214d109852ce3 and all original6837 source/proof/reader preparations are preserved. Their old runtime/benchmark receipts are not acceptance for this composed epoch. Boolean must retain the five new policy/caller C1 pins when composed; allocation follows the new classification row. Neither pending work nor queue submission counts as a verified main merge.


The additional strict14-test typing profile exited1 with41 existing-body diagnostics. Authentic git archive5a under the identical profile reproduces every message/code/column/order, with only the reviewed inserted source-line mapping; both failures and complete attribution3a02d8 are preserved. Native production typecheck and new helper/test focused typing exit0. No casts, exclusions or old-body repairs were added. Astra final static review80a8fb4f independently authenticates the entire helper prefix, all10 historical Git originals, exact5 C1 changes and unique external binding; it approves ordinary runtime, not publication or retirement. Separate ordinary14-reader2301 and new45-control executors were launched once in regular private worktrees on exact a42e073b. Results remain pending in this pre-hook record.

## Implementation plan — preserve the canonical ArrayBuffer classification after the prepared-presentation classification (2026-10-05)

This is a bounded successor to the existing classification repair, not a replacement of its historical contract. Root remains the sole integrator and publisher. No source algorithm, ES2015 behavior, gate ceiling, policy permission, public compiler route, or legacy-retirement condition changes in this proof adaptation. The two classifications must coexist in the actual working policy. Projecting an authenticated operand for historical tests must never remove the canonical row from the physical current policy.

### Authentic predecessors and the observed conflict

The signed local classification commit is `d304a35aa9a318906bb7c5459a1cf9359f50e227`, with parents `5a633bf93ec0e7b9d2992334d00f1279c7bd2c25` and `f41a11059ccc7f646ae907d6b992b7dc50509938`. Its normal 17-suite/2,682 result and all old strict results remain evidence for that packet only. The remote automatic merge `3b4bc52137bbf8f7b86f9e659453f34b7ce29ad0` has parents 5a and `90ce6955bfe75b43779f8dfb458642473ef41ef2`; fresh canonical main `844398d2c773e631b8ca8e54141a53e11dd685d4` has parents 90ce and `1bf312fe4bc541f979d123f9d3a81019cd91dd7c`. These exact local objects were read with lazy fetching disabled. Root must preserve the remote ancestry by normal integration, not force-push over the automatic merge.

The saved f41-to-844 comparison contains 28 paths. Besides report mirrors and issue records, it includes `scripts/compiler-boundaries.json`, `scripts/loc-budget-baseline.json`, `scripts/test262-worker.mjs`, `scripts/lib/native-eval-boundary-observation.mjs` and its test, `src/codegen/expressions/arraybuffer-isview-static-decision.ts`, `src/codegen/expressions/call-namespace-static.ts`, and the two `tests/issue-5150-{dataview-subclass-isview,isview-static-decision}.test.ts` files. Preserve these incoming changes exactly; they are not this lane's source ownership. The 28 is that comparison's denominator, not a claim that main contains the unpublished numeric branch. A main-versus-5a comparison additionally sees the numeric branch's five own paths; root must retain them through the merge.

Authentic 5a policy is 583986 bytes/SHA256 `0cbff25993c92150c6c7cd45934b25552b315266833adc84301f49287d3982ee`. Both actual 844 and remote 3b4 policy blobs are 584340 bytes/SHA256 `172cbb5c10a980cf4d1ddd70a24195a5f4c5536e3888e50da96a05e16d272189`, Git blob `546d0403813cfb67389fac728dd3e4a40c090bb0`. Their only policy change is a 354-byte insertion at UTF-8 offset 190010, adding `files[445]` between array-constructor-carrier.ts and assignment.ts:

```json
{
  "path": "src/codegen/expressions/arraybuffer-isview-static-decision.ts",
  "state": "unmigrated",
  "layer": "mixed-needs-split",
  "destination": "backend-wasmgc",
  "owner": "3518-coordinator",
  "nextBoundary": "Separate legacy class-metadata static decisions from frontend classification and backend lowering."
}
```

The current classification predecessor remains 584358 bytes/SHA256 `b1693461855cc60546bb29bee370c02ad3cf21e17e539d521c8f2b6598b0e411`. Applying exactly the authentic 354-byte insertion to that full stream yields the scratch combined proposal 584712 bytes/SHA256 `c71c9f9a61cebf84bff0f75f26fcd271265e53c83a66f59ed416e1cbc1675209`, Git blob `2a85037d2b4ffa2dd93aff1fa4080581e48a8c88`. Root must independently run the real-path formatter and authenticate its final bytes before freezing the receipt. This is a proposed composition, not installed or tested acceptance.

The combined files population is 1826. The main row is index445; the unchanged presentation row moves from index1824 to1825. All other old rows keep relative order and exact values/key order. Activation history104, moves12, roots, layer entries/minimums, allowed edges, schema, evidence and all other policy fields stay exactly equal to classification predecessor. Its old tail coordinate583862 would shift to584216 in the combined stream, which is precisely why the old fixed classification receipt must not be rewritten. Instead prove and remove the new interior insertion before invoking the unchanged old contract.

### Fixed root-authored receipt and append-only local proof

Root owns `scripts/compiler-boundaries.json` and NEW `tests/helpers/ir-runtime-program-policy-arraybuffer-isview-main.json`. Freeze an explicit schema1/kind `fixed-arraybuffer-isview-main-policy-evolution` packet before either writer implements literals. Record distinct provenance for authenticated main844/remote3b4 source row and the local signed d304 classification predecessor; do not label d304 or the combined proposal as canonical main. Preserve all authentic older receipts.

The packet contains fixed ordered top-level keys; whole before/current source bytes/SHA256/Git blob; complete JS-serialized data/files/layers/allowedEdges/activationHistory/moves fingerprints and populations; exact row/key order/index445, both neighbor rows, and the unchanged presentation-row identity/old/new ordinal. Its single UTF-8 raw span is `beforeOffset=afterOffset=190010`, empty before string, and the exact authenticated 354-byte insertion as after string. Empty before is deliberate insertion, not permission for arbitrary zero-length regions: require exactly one fixed span, finite safe-integer coordinates, range/order/population and full source pins, plus exact fixed nonempty after text. Independently prove deletion recovers all584358 predecessor bytes and replay recovers all584712 proposed bytes. Also remove the main row semantically and compare the entire ordered predecessor object; reinsert and compare the entire current object. Raw and semantic routes must agree on that predecessor. Do not replace supplied input with a healthy snapshot.

Pin the complete predecessor helper prefix369345/SHA256 `3ccadadfcceb0134ba97816c4fa6dedada6248c183b37f9ad339e765c608730f` at `tests/helpers/ir-runtime-program-policy-evolution.ts`, and the unchanged classification receipt4227/SHA256 `dd0273b99eb2f96ed66e033bec6a4365b65137359d3a9b7fc2e3b0e7b4b80dee` at `tests/helpers/ir-runtime-program-policy-presentation-classification.json`. Its `current` full profile must equal the new receipt's `before` profile including moves12. Root supplies all final expected pins independently; writers do not derive expected constants from the file being tested.

One helper writer owns ONLY an appended suffix of `tests/helpers/ir-runtime-program-policy-evolution.ts` and NEW `tests/issue-3525-arraybuffer-isview-main-policy.test.ts`. New APIs are `captureArrayBufferIsViewMainPredecessorPolicy(value: unknown)` and `captureArrayBufferIsViewMainPredecessorPolicySource(raw: string)`, returning only the independently proved classification-current predecessor. Preserve every old helper byte/API. Semantic descriptor capture/refusal and primitive raw refusal precede all I/O; no getters/coercions, symbols, hidden fields, nonplain objects or fake array records enter proof processing. Each call freshly reads and authenticates new receipt, exact old helper prefix, old classification receipt/profile, then invokes the existing fresh C1 authority authentication. No cross-call cache, digest-selected exception, recursive call to the older classification capture, or additional C1 domain/read permission. This local outer step is composed by callers with the unchanged older captures. Its order must be independently tested, not inferred from success.

There is no new full source-body pin for either debt module: these rows classify architectural debt, not immutable implementation ownership. Preserve genuine main source imports/module presence through the real inventory and actual final source custody. The incoming helper and call-namespace body are canonical integration inputs, not embedded algorithms or new historical source recipes in the policy receipt.

### Disjoint reader owner: 15 files, bounded initial operands

A second writer owns exactly these existing files:

- tests/issue-3518-canonical-3c6-inventory-successor.test.ts
- tests/issue-3518-canonical-489d-inventory-successor.test.ts
- tests/issue-3518-current-main-inventory-successor.test.ts
- tests/issue-3518-nested-stackification-policy-evolution.test.ts
- tests/issue-3518-number-prerequisite-policy-evolution.test.ts
- tests/issue-3518-program-data-contract-boundary.test.ts
- tests/issue-3518-program-validator-policy-evolution.test.ts
- tests/issue-3518-runtime-data-contract-seam.test.ts
- tests/issue-3518-runtime-program-policy-evolution.test.ts
- tests/issue-3518-semantic-provider-boundary.test.ts
- tests/issue-3518-validation-policy-evolution.test.ts
- tests/issue-3518-wasmgc-helper-policy-evolution.test.ts
- tests/issue-3518-well-known-symbol-policy-evolution.test.ts
- tests/issue-3518-lowering-analysis-preservation.test.ts
- tests/issue-3525-presentation-classification-policy.test.ts

The first13 retain their 19 regular initial operands (15 raw,4 semantic). Add only imports and a fresh new outer capture immediately around the initial actual current input, inside the existing classification predecessor capture. Thus actual current -> main-row predecessor -> classification predecessor -> D1 and the older exact chain. Preserve direct historical API calls, all mutant actions/assertions, error channels, registration names/order and old expected receipts.

The special47 suite retains its current `applicationInput` preparation (around line693): compose the new raw capture before the existing classification raw capture, then retain the old D1 input pin. Perform this outer projection per action BEFORE any helper/receipt physical fault. Preload children receive the already proved literal through existing JSON serialization; do not run the new outer proof or reread physical current policy inside the child. Child normal H2/policy APIs and implementation guards remain the actual target, with healthy missing-authority counterwitnesses preserved.

The classification45 suite needs ONE initial `raw()` route change (currently line132): return `captureArrayBufferIsViewMainPredecessorPolicySource(readFileSync(actualPolicy,"utf8"))`. `policy()` remains parsing raw(). Keep its entire old expected b169/4227 tables, every old direct API and assertion unchanged. Crucially lines571 and588 already acquire `text=raw()` before missing/corrupt receipt/helper faults; preserve that sequencing. The 45 tests must still reach the OLD classification guard, not fail earlier in the new wrapper. Do not wrap individual mutant calls or replace the tested APIs. New initial projection imports/body must be removable to recover the entire prior file exactly after the same formatter.

Freeze complete per-file UTF-8 inverse/replay recipes relative to signed d304 files, not relative to an unpublished allocation or Boolean snapshot. Independently compare AST registrations and assertion-call arguments, and collect actual ordered names after integration. Original denominator remains2301+45=2346 across these15 files; it is an expectation until new-epoch execution. No old test renaming/dropping/replacement.

### Root-only C1 assembly and ownership

Root owns policy/receipt, final issue/handoff, the C1 manifest `tests/helpers/ir-c1-authority.json`, anchor `tests/helpers/ir-c1-authority-root.ts`, and the unique external `independentFreeze` initializer in `tests/issue-3518-c1-current-source.test.ts`. Writers cannot change H1/H2 or source/current type/resolver domains in this row-only step.

Use authenticated local classification manifest364386/SHA256 `a42e073b066a92eb867e7794b2dca8101b8c70d0c766a27fce206e3ddedf667b` as the predecessor; retain its actual schema, bases and provenance meanings. Exactly five current instrument pins AND five complete historical-original-to-current recipes change: the policy helper and `issue-3518-program-data-contract-boundary`, `issue-3518-runtime-program-policy-evolution`, `issue-3518-well-known-symbol-policy-evolution`, `issue-3518-number-prerequisite-policy-evolution` tests. The other seven current pins, other five recipe objects, every original before pin,11 immutable authorities,7 artifacts, all resolver/config/linearOptions/declaration fields remain exact. No currentBase bump merely to resemble fresh main.

Recover each of all10 full historical originals from authenticated old current instrument bytes and its old complete recipe; verify old original full pins/Git blobs and old replay. Then compose the five reviewed incremental edits to actual final current bytes, derive five complete original-to-final UTF-8 recipes and independently prove all10 inverses/replays against frozen final12 streams. Do not append an unchecked local recipe to an old raw coordinate system. Source maps, recipes and policy coordinates are byte coordinates, not JS character counts. Preserve boundaries, zero/nonempty populations, span order/ranges and all unchanged recipe objects. The new classification45 reader is outside the C1 instrument domain; no domain expansion follows from adding its initial projection.

Use mandatory independent freeze digest, stable O_NOFOLLOW regular-file captures, mode checks and a single captured byte map for both derivation loops. Bind writer freezes and root fixed packet. Build/format the trio in scratch using real intended file paths, assert second formatting is byte-stable, parse exactly one TS AST independentFreeze initializer, replace only its scalar and independently recover all outside bytes. Bind complete decoded manifest plus actual anchor source/pin. Recheck all frozen inputs before root's exclusive three-file installation; this is not a multi-file filesystem transaction. Tests receive only a coherent installed epoch.

### Meaningful acceptance and sequencing

New finite tests must prove actual combined healthy raw/semantic inputs, independent full profiles/row neighbors/ordered key arrays and reciprocal bytes; original classification-input reconstruction; refusal for either row missing/changed/duplicated/reordered, wrong neighbor or shifted coordinate, unrelated old-row/history/move/edge/root/schema mutation, whitespace and same-length-byte raw changes, malformed/raw boxed input, semantic getter/symbol/hidden/prototype traps before I/O. Pair every priority test with a healthy input that demonstrably reaches the missing authority. Exercise all three local authorities (new receipt, old helper prefix, old classification receipt) missing and byte-corrupt after a healthy capture, then restored healthy capture, for raw and semantic APIs. Use persistent backup/lock, exact intended-fault identity before restoration, and preserve both operation and restoration errors. Do not claim an internal span guard was reached when the full raw pin rejected first. Freeze actual registrations before runtime; do not invent an executed new-suite count in advance.

After exact root assembly, perform new-suite ordinary execution and the preserved15-reader ordinary cohort with original names, actual collection/child exits and complete raw/JSON error-channel audits. Run the affected numeric four C1 files with actual expected populations292 current-source,298 runtime-program-relocation,631 historical-runtime-reconstruction,62 program-validator-relocation (1283 total only after execution); the different runtime-program-c1-relocation43 is not a substitute. Retain original numeric44 and genuine incoming5150 suites plus native-eval observation tests through appropriate unchanged normal gates. Run real inventory on final integrated main source: both new rows remain debt, with no extra permissions, omissions or false clean claim. Run native type/lint/format/layer/cycle/LOC/function/oracle/coercion and unchanged commit/push hooks against the actual merged base, including the incoming LOC and worker changes. No bypass, ignore flag, test deletion, baseline relaxation or discarded ordinary errors. Root may parallelize disjoint physical checkouts; it must not mix custody vectors between epochs.

The completed A14 audit now independently verifies all2301 original ordinary tests: 28 collection/body children exit0, all historical ordered names and all raw/JSON channels, every2484-path before/after/final vector, and every raw artifact hash in aggregate1501d1acca8dd2cf2386d8780dd81c1e696d1a7e29a982acae122631c2adb0f9. Own receipt71313/SHA256 `44a8e0895cdcbbaa85f91ebdeec38f41bc9cbb05bc88ace85a8d34fab963277a`. The prior1283 C1 and45 successor results remain genuine old a42 evidence. They are not future merged-main acceptance. Supplemental41 strict type errors retain exact authenticated predecessor attribution, not a type-pass label.

Parallel release is limited to the helper+newtest writer and the15-reader writer after root freezes the actual packet and records exact paths/claims. Root integrates authenticated main/remote ancestry and all28 incoming changes, owns all authority assembly, then publishes only after actual final gates. Pending Boolean71ecd remains preserved: later compose its H1/H2/types closure and14 controls onto this latest policy/C1 epoch while retaining all five newly rebuilt recipes. Pending6837 remains preserved: its later allocation row would now append at1826 for1827 total (root index13 unchanged if roots remain exact), and it needs this new successor as its immediate predecessor, not the old b169/3cca or5a packet. Any additional canonical policy change requires a fresh finite reconciliation, not a permitted-hash set. No benchmark rerun, performance acceptance or retirement is authorized by this amendment.


### Main reconciliation: verified intermediate results (2026-10-05)

Root preserved remote auto-refresh 3b4bc52137bbf8f7b86f9e659453f34b7ce29ad0 and canonical main844398d2c773e631b8ca8e54141a53e11dd685d4 in a successful staged normal octopus merge from signed d304. Nothing in this record is a new delivery to main. Existing ready PR6481 temporarily carries a verified hold so branch auto-refresh and queue admission cannot race the final reviewed packet. Release the hold only after exact validated head publication; no duplicate PR, draft or force-push.

The new fixed receipt5270/2d28278754fb99c4e6e7b51336ad9d37bd4a98fbbd952f9ddcb11208e9aba23c and combined policy584712/c71c9f9a61cebf84bff0f75f26fcd271265e53c83a66f59ed416e1cbc1675209 pass independent full-profile and reciprocal-byte review. All15 reader edits are frozen d5c1811e107549800fdafbf2c5f5dfe45873c779f157a4874d7d132dddd6403c and independently reviewed with assertions/registration identities preserved. The root assembler now derives anchor/test from its single already-authenticated predecessor byte map, fixing an independent review finding concerning late scratch-baseline rereads. Final authority assembly and current-epoch ordinary execution remain pending at this record's time.

Incoming ES5150 tests passed40/40 ordinary cases with zero failures/pending cases and empty stderr. Native eval observation passed11/11 node:test cases, zero failed/skipped/cancelled/todo and empty stderr. Production native TypeScript7, IR layering, import cycles, source LOC/function budgets and oracle checks exited0. Budget/oracle comparisons use actual canonical844, preserving its own source fixes and baseline. Native inventory exited0 and reports valid inventory with incomplete architecture: both classifications remain debt, without additional permissions or retirement credit.

A fresh positive coercion scan on the actual integrated source exited0 and measured148 vocabulary files/566 sites; all7197 full byte/hash/mode/inode/device custody records remained exact. The initial measurement parser wrongly expected a src/ verbose prefix and refused after preserving raw output/custody; that failure remains recorded. A corrected parser with the unchanged native gate independently recorded a new actual exit and positive population. No scanner or ceiling changed. Two authenticated regular assert.js/sta.js resources are supplied to each isolated checkout from pinned corpusb363f29d3c43c626dc852744ad64a0b48a003693; this is no full corpus/conformance claim.

Astra High independently reviews. Sol6.1 Medium owns the separately claimed helper/new-proof and15-reader worktrees. Root alone assembles authorities and publishes. The2346 reader and1283 C1 populations remain expectations until their final coherent-epoch ordinary runs. The old d304 results retain their original scope. Boolean71ecd and issue6837 prepared work remain intact without refresh, performance or retirement claims.


## Bounded delivery repair — decode coercion gate file URLs (2026-10-05)

The actual standard pre-push package route is `pnpm run check:coercion-sites`, resolving to `node scripts/check-coercion-sites.mjs`. The authentic16986-byte script SHA420e43e295e1641d64a16307e201828b16456e621771d661530e4444892ae96d derives five filesystem paths with URL.pathname. In this repository path, Node produces `/Volumes/Archiv%20Mini/...`; passing that encoded spelling to filesystem/Git operations makes both source roots unreadable. The existing scanner catches missing roots, and fallback catches missing baseline, permitting empty-versus-empty output. This is a path construction defect, not permission to lower gate requirements.

The saved three-row path-resolution probe in `3525-isview-policy-proof-20261005/.tmp/presentation-classification/root-normal-review/path-resolution-probe.json` distinguishes physical relative, alias-cwd relative, and absolute alias entry. Alias cwd/PWD plus preserve-symlinks-main still resolves the standard relative entry to the encoded physical URL. The special absolute alias entry works but is not the unchanged package/hook invocation; its earlier148-file/566-use positive scan cannot make an empty normal hook scan valid.

### Sole implementation ownership and exact change

SolB owns ONLY `scripts/check-coercion-sites.mjs` in the isolated proof worktree. Add `fileURLToPath` from `node:url` and apply it directly to each existing `new URL(..., import.meta.url)` for REPO_ROOT, two ROOTS entries, SRC_ROOT and BASELINE_PATH (five conversions at original lines94–102). Keep REPO_ROOT's existing trailing slash trim. Use the standard URL conversion API rather than decodeURIComponent, cwd/PWD fallback, string replacement, or a new root override. No exported framework or unrelated portability rewrite.

Require a complete inverse restoring original16986 bytes after removing the import and reversing only the five replacements. Vocabulary/patterns, sanctioned files, traversal/missing-root behavior, default change-scope resolution, changed paths, per-token netting, base-blob reads, allowances, baseline comparison/writer modes, messages and exit branches remain byte-exact. This repair makes the existing path-based gate operate on the intended filesystem; it does not separately redesign fail-closed behavior for genuinely absent roots. No package/hook/baseline/ceiling/allowance changes and no production compiler/runtime changes.

### Meaningful bounded validation and source custody

Record actual child argv/exit/stdout/stderr, Node version, script pin, relevant source/config/baseline pins and selected base. Run the unchanged default package command from the physical spaced checkout, plus its verbose equivalent. Require positive real vocabulary-bearing source population, matching the independently recorded148-file/566-use profile when source bytes match; a legitimate zero *changed codegen* count is distinct from an empty overall scan. State actual base and compare full per-file/per-token observations with the same-source previously valid absolute-alias reference. Root's later ordinary pre-push invocation must itself be positive; special diagnostic routing does not replace it.

In disposable private scratch fixtures, execute the unchanged candidate script body through relative paths in a plain directory and a directory containing spaces, non-ASCII text and a literal percent character. Supply real minimal codegen and codegen-linear files, a real matching committed-style baseline JSON and the unchanged change-scope module. Use explicit read-only `--all --verbose` to isolate path/baseline access without creating a Git repository or altering any real baseline. Require equal nonzero exact per-file/per-token counts and exit0 in both fixtures, including nested filenames; increment one genuine unsanctioned token in the scratch fixture and require the same nonzero growth and exit1 in both. This paired refusal witnesses that BASELINE_PATH was actually read rather than accidentally treated as empty. Retain raw outputs; no mocked filesystem and no `--update`/`--update-on-decrease`. These are instrument controls, not compiler tests or full runtime parity evidence. A Windows claim requires actual Windows evidence and is not part of this checkpoint.

### Authority and integration scope

The saved final C1 candidate379836/f02eee675a6b5a061c96987ab77e073e4abdb13b30f37aa29aa2eed37779da93 contains no `scripts/check-coercion-sites.mjs` reference in its12 instrument pins,10 recipes,11 immutable authorities,7 artifacts or resolver/config fields. This script is an external gate/dependency input, not a new C1 authority: no C1 recipe, receipt, schema, baseline or reader adaptation is warranted. Root owns the eventual coherent integration and updated source/tool dependency vectors. Existing completed strict reader/C1 tests remain evidence for their earlier full vector; do not relabel those old vectors with a new script hash. Byte-exact preservation of all guarded source/test/authority paths plus this isolated gate-only change does not require repeating the hours-long unchanged C1/reader cohort. Run the native gate controls and required ordinary commit/pre-push hooks for the final commit, preserving earlier empty-scan observations as failed coverage evidence.

Root's normal commit and A's reader runtime are currently active in separate worktrees: no edits to their tracked inputs, staging, issue or authorities while active. Root applies this plan/update only after its protected window closes. SolB freezes script and control evidence for independent review; root alone decides integration/publication. Existing PR6481 hold, full IR equality, Boolean follow-on, allocation benchmark acceptance and legacy retention remain unchanged.


### Actual completion and bounded delivery fix (2026-10-05)

The signed integrated checkpoint is 9ad6e5ce6ab13dd8d5db59a7a1ca91ac07f1b542, with authentic d304, fork-refresh 3b4bc521 and canonical-main 844398d2 parents. All 50 before/after bytes and modes and committed blobs match; tracked state is clean and cryptographic SSH verification succeeds for Thomas. Normal hooks completed 20 suites with 2,778 reported passes and exit 0. The inherited ignored-unhandled-error option remains explicitly qualified; raw channels contain no failure/RPC/unhandled markers. Independent root review: 0b3e5f62d9e55a5f4d249b569b333ade00f08d6cec03d0dd013073e1d871b867.

The separate ordinary caller cohort completed 15 suites with 2,346 registered/passed, zero failed/pending, ordinary error handling and no reported errors. All 2,502 declared inputs restored after every actual collection/body; ordered names and duplicates match. Aggregate: 631afaa3835435f72058c55864627239ab26936dad79b61b0a1d885654acccf6. These inputs match the quiet integrated root byte/hash/mode before the operational fix; inodes are not equated across worktrees. New policy 56 and four C1 suites 292/298/631/62 also completed ordinarily, with independently reviewed receipts already recorded. These test populations establish integration evidence, not additional language/program coverage.

The native relative coercion gate had a concrete spaced-path defect: URL.pathname retained encoded spaces. The scoped correction adds one node:url import and five fileURLToPath conversions only. Native standard relative pnpm and verbose runs now exit 0 and positively observe 148 files/566 sites, matching the authenticated earlier alias scan. Plain and space/Unicode/percent fixtures pass positives and refuse new growth. Predicates, baselines, allowances, thresholds, hooks and package scripts remain unchanged; full old bytes reconstruct exactly. Sol implementation receipt: 15923896db466860bba675e8fadc80610b8ccd8cdd922fe8f43a76e36f9145; Astra review: ab01179b88f853706a8224c8d19acfd81891ff19e52b95073ec63654cf6e7a6b. The old checker is in the strict caller input vector: the later checker/document changes form an explicit separate operational epoch, not a claim those bodies ran revised checker bytes. No runtime authority reseal or unchanged-body repetition is justified by this CLI-only fix.

A purposeful fresh canonical-main comparison still reports 844398d2 with zero changed paths (review 950fa0a9f271a9f6dc8b9331ff986ce8124b193c7edd3f526360eb12baf4afb1). Publication endpoints still require a fresh read. The existing ready PR6481 remains temporarily held; no new push/queue/main delivery is asserted by this record. Root retains normal hooks and protected exact-head admission.

Delivery takes priority: finish this existing PR before refreshing downstream Boolean/performance work. Subsequent progress should be additional real complete IR programs, demonstrated equivalence and verified main merges. Public legacy codegen remains as comparison until the entire IR path is tested and equal. Focused typing retains 41 exactly baseline-attributed diagnostics, strict graph closure remains OPEN, and mixed/non-host/full-artifact/performance parity and retirement remain unproven.

Final independent ordinary-reader review: cce0d4ae89de1ff2f463df646372d4aaa0e2471d62ecab3cd7528f286457333d. Independent quiet-root applicability verifies all 2,502 same byte/hash/mode inputs, zero missing/differences: 6eb0ff43114650ca58983a15d5e67d21ba889ee787e4cb830d0d60a7dc7b511e.

The final publication read found canonical main 159c15c727c6dedef41a4dab2d535bb0b2d0f00b. Authenticated complete REST/local-tree comparison changes only six generated npm-compat reports/mirrors, with zero overlap in the frozen 2,502 runtime readset (independent review 1e47812e8dfdab0c4ccbefa8061b779d8da19a93d4c15ebd61a9884e295fd853). Three missing unique report blobs were recovered from canonical GitHub blob objects and verified by Git object hash, byte length and JSON parse. They are retained through an ordinary merge; source, tests, policy, hooks, package/config and the approved URL-path fix remain unchanged. This records report provenance, not new program/conformance coverage. The prior ordinary runtime evidence retains its explicit tested epoch; normal hooks and exact-head protected publication remain required.




## Delivery correction — Linux preload child script transport (proposed 2026-10-05)

This is a test-transport correction for existing PR6481, not a compiler, policy, or acceptance change. Implement only after root records this exact plan in the integration issue and releases an isolated writer. Root owns integration/publication; the writer owns only `tests/issue-3518-lowering-analysis-preservation.test.ts`. Other worktrees and the preserved Boolean/allocation increments remain untouched.

### Observed failure and exact input

The published5cf55 test is37729 bytes/SHAa41019ab812b74be6db0597a87a0ca34ea408e695d90c9c7e856b4f65de54f75. Saved Linux quality log `.tmp/presentation-classification/main-isview/publication/resumed-delivery-20261005/quality-log.stdout` is369936 bytes/SHAde309b6d0d92f770b50b4c544cfa95d3be7d33cbeb2073905c22dacd54c11ab9. Lines2233–2244 identify the policy-semantic and policy-raw fresh-preload tests and `spawnSync /opt/hostedtoolcache/node/25.9.0/x64/bin/node E2BIG`. The child never reaches its proof under that refusal; existing Darwin passes cannot establish Linux acceptance. Preserve the failed job and all earlier body evidence. Do not print the giant embedded spawn arguments.

`applicationInput` (line693 onward) first projects the current policy through the new main/classification predecessors and authenticates the unchanged583986-byte D1 policy input. The application preload script embeds this entire string using JSON.stringify. The one `invoke` at line817 sends that script as a single `--eval` argument; Linux refuses that argument transport. The assertion at child.error correctly exposes the infrastructure failure and must remain.

### Exact authorized edit

In the application preload `invoke` only (within `it.each(applicationEntries)` at lines799–837), change:

```ts
spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
  cwd: root,
  encoding: "utf8",
});
```

to:

```ts
spawnSync(process.execPath, ["--import", "tsx", "--input-type=module"], {
  cwd: root,
  encoding: "utf8",
  input: script,
});
```

The same script bytes now enter the child's standard input. Keep process.execPath, tsx import, ESM mode, cwd, encoding and default process/error behavior. Module URLs remain the existing absolute URLs; no temporary script path or extra execution seam is necessary. Do not change the script text, its input interpolation, normal application imports, policy producers, guard messages, script error catch/exit code, or expected outputs. Do not change the earlier independent component preload invocation at line624, which does not embed this policy. No platform conditional, shell, environment workaround, maxBuffer/heap/timeout increase, catch-and-ignore, skip, retry or threshold change.

All three application entries remain (`h2`, `policy-semantic`, `policy-raw`), each executing healthy-before, corrupt, healthy-after: nine actual child phases. Keep the healthy direct invocation before/after, prefault applicationInput capture, real inert implementation corruption/restoration and all error/signal/status/stdout/stderr/JSON assertions. In particular, corrupt status1 and exact implementation-guard stderr must come from the real normal application, not an E2BIG child.error. No registration or assertion expression changes are allowed.

### Authority impact and reciprocal proof

Read-only census found no reference to this test path, its a41019ab full hash, or37729 size anywhere in tests/helpers, scripts, or .github. Current `ir-c1-authority.json`379836/f02eee675a6b5a061c96987ab77e073e4abdb13b30f37aa29aa2eed37779da93 contains12 current instruments,10 recipes,11 immutable authorities and7 artifacts; this test is not a pinned member. Policy helper383161/21d795c773be21bbcd3eab1bee12c78d987a778d0a6a7ef52ccf7d9cec0f93de likewise does not reference it. Consequently no C1 manifest/anchor/external scalar, source receipt, policy receipt, helper pin, historical inverse, or source body is to be repinned. Preserve all those bytes. The test's own expected source/implementation/policy pins remain unchanged.

Freeze the new test and a complete reciprocal edit recipe. Removing only this argv/options change must recover the entire authentic37729-byte predecessor; prove forward replay as well. Compare registration arguments and all assertion calls with the predecessor, and compare generated-script expressions byte-for-byte. Actual expected collection stays47; do not count nine subprocess phases as nine additional test registrations. Update root's final candidate custody to the new test hash separately from old2346 proof: that old cohort genuinely ran the old transport.

### Required bounded checks and delivery

1. Scoped formatter/linter and meaningful native focused type check using the existing configuration. Preserve any failed diagnostics and compare with the identical predecessor/profile if needed; no casts/config loosening. Full inverse and registration/assertion/script preservation are static proofs, not runtime acceptance.
2. Run the complete unchanged47-test suite once in an isolated exclusive physical-fault checkout after root release. Actual collection and ordinary JSON names/order/counts, all statuses, raw channels, child errors/signals/exit codes, and complete before/after authority custody must agree. The existing three preload rows already supply healthy/corrupt/restored child controls; no synthetic replacement test is needed.
3. Linux confirmation is necessary for the observed Linux failure: the existing hosted quality check on the corrected exact head must execute and pass these rows using the same large real policy. A local Darwin47 pass is useful but insufficient to call the Linux blocker resolved. A separately available isolated Linux execution of the same full suite may add earlier evidence, but no new infrastructure/workflow change is required. Retain the actual Linux Node/runtime identity and transport/error observations; do not infer success from syntax or a tiny stdin smoke test.
4. Root uses the normal unmodified commit/pre-push/PR checks and protected admission. No blanket rerun or reseal of unchanged authority cohorts is justified solely by this transport edit; normal hooks still select whatever the repository requires. Preserve prior strict2346/C11283/new56 proofs with their real old-test epoch and the fresh47 proof separately. Existing CI failure remains recorded until superseded by actual corrected-head Linux results.

This correction grants no broader IR language coverage, artifact equality, performance, public routing, or legacy retirement credit.


### Linux transport correction — implementation and local acceptance (2026-10-05)

Canonical claim3525:linux-child-stdin-20261005 is effect-verified for ttraenkler/codex-linux-child-stdin-20261005 on its isolated branch; existing presentation integration owner remains intact. The only test change is the final application child invocation: unchanged script enters stdin, retaining Node/tsx/ESM, cwd, encoding, every assertion and all three healthy/corrupt/restored application sequences. Earlier component invocation is unchanged. Candidate37736/SHA256 b478056168abb9b18f6c3162ebc658c2cce75711d1b2aed2c1b6857a34df176d/Gitblob ebbf9855a48221e89f9857695f22fa86e04e3f9a/mode100644; complete inverse reproduces original37729/a41019ab812b74be6db0597a87a0ca34ea408e695d90c9c7e856b4f65de54f75. No production, helper, policy, manifest or receipt change/reseal.

Actual ordinary Node24.4.1 local collection/body exit0:47 ordered registrations,47passed,0failed/pending/todo; no ignored error option and no RPC/unhandled/error channel. All three application-preload tests pass, including nine asserted subprocess phases. Complete7656-input custody restored before/everyafter/final. Sol receipt e1dc1f9e4ab734a777f977d83430b3856a1937e9ba6d094f728b0b8377344b84; independent Astra source/whole-inverse/names/channels/custody review be73630f3e54d55e8fe533c5c33f6a07c9c112dd5c887f4aa1ac2da1419fb606. Focused strict native TS7 check of this single test with existing compiler settings and only rootDir/include/noEmit profile changes exits0, no diagnostics, full custody exact; receipt3f320034285469f807e7d99815a720ccecda611d02a978f72e083faca5e44374. Initial unavailable pnpmexec tsgo exit254 is preserved separately, never called a typing result; the successful command used the repository-pinned node node_modules/typescript7/lib/tsc.js.

Important actual CI correction: the green issue-tests-changed job111595583435 is advisory only. Its actual full47 suite and required quality job111595157076 BOTH exited1 with45passed/2failed, same Node25.9.0/Vitest3.2.7 preview72d667a1eb5af5810d79244afbc51d5be215ce66, same policy-semantic/raw E2BIG before child module loading. TEST_OUTCOME was failure. Green advisory metadata is not a positive test control; original logs/refusals are retained. Source authenticates the583986-byte input before embedding;583163 is expected captured predecessor output, not the embedded input. CI error rendering truncates spawnargs; complete actual CI argv size/hash is unknown. No additional cache/source discrepancy was found.

This is local acceptance and an exact reviewed transport correction, not yet Linux delivery evidence. Existing corrected-head Linux quality must genuinely pass before protected admission; normal hooks/prepush remain required. Older2346/56/1283 proof epochs stay separately qualified. No broader language/equivalence/performance/legacy-retirement credit. Existing ready PR6481 temporarily held during integration; remove after exact correctedhead publication and verify actual requiredCI then exact protectedqueue/main.


## Measured Linear early-return repair release — 2026-10-05

Root explicitly releases isolated implementation of the concrete current-checkpoint blocker measured in the unchanged four-source/five-function numeric application: prepared linear acceptance refuses solver.ts block8 early.return, while independent native, both legacy backends and prepared WasmGC agree. This is a scoped capability blocker repair; the published PR6481 commit2a27 remains immutable while required CI runs. Root owns integration. No downstream Boolean/6837 refresh, public route change, legacy retirement, new PR, commit or push is authorized by this release.

Sol6.1 Medium source owner writes only `src/ir/analysis/backend-legality.ts` (one explicit early.return core-control allowlist case); independent Sol6.1 Medium test owner writes only NEW `tests/issue-3525-prepared-linear-early-return.test.ts`. Canonical slice claims `3525:linear-early-return-source-20261005` and `3525:linear-early-return-tests-20261005` coordinate these owners. Both isolated worktrees start at exact2a27. Astra High specifies the finite current-source preservation layer from measured read/pin dataflow; root integrates proofs and current authority serially. Existing emitter/lowerer/verifier bodies and all existing tests remain unchanged. Preserve the original application and failures, test real nested/value/void/caller/operand semantics and verifier arity/type refusals. Original source-only app reports and independent audit remain consume-only.

Detailed reviewed plan SHA256 `035052ced084eff64afc8cad72d152f4df8c701d539b62395e737674447fd0d0`, copied to `.tmp/early-return/implementation-plan.md`. Historical proof pins must be reconstructed by exact inverse/replay; source and semantic success before coherent proof integration do not constitute full authority acceptance or delivery. Required normal hooks, fresh exact-head CI/queue and main-content verification remain mandatory before release.


### Single integration owner for the measured return repair

Verified canonical claim `3525:linear-early-return-proof-integration-20261005`, owner `ttraenkler/codex-linear-early-return-proof-integration-20261005`, isolated branch `codex/3525-linear-early-return-integration-20261005` at2a27. Root imported the exact source candidate (21387 bytes/cdd60287d9c98f700eca41f351f02ac609f3e9fdd43a25e28d7951f16f0c1a37), checked full inverse/replay of the sole25-byte insertion at8250 to the original21362/e6bd source. Source and tests are file-disjoint; finite current-source proof assembly remains root-owned and serial. Astra is specifying the measured historical component/current-reader dataflow before helper or authority changes. No proofs have yet been updated, and no full authority/CI/main acceptance is claimed. CurrentPR6481 stays untouched.

## Implementation plan — exact early.return owner evolution through the D1 proof (2026-10-05)

This is the finite proof integration for the separately released Linear `early.return` repair, not a public compiler cutover or a Boolean/allocation refresh. Root owns integration and final assembly. The source writer owns only `src/ir/analysis/backend-legality.ts`; the semantic writer owns only `tests/issue-3525-prepared-linear-early-return.test.ts`. The following proof edits require this plan and a root release before implementation.

### Measured source and the actual dependency

The physical candidate is 21387 bytes, SHA-256 `cdd60287d9c98f700eca41f351f02ac609f3e9fdd43a25e28d7951f16f0c1a37`, Git blob `157777ff1c14c6cf5f0e4241c4e361843d694f5b`, mode 0644. It is exactly the old 21362-byte owner (`e6bdc35fbf47fc26581c24cbecb08f27a4d590a7006d005031b6a309db26b506`, blob `34a1399bdd963163f2155f0de0933d085dbc4f25`) with the 25 UTF-8 bytes `    case "early.return":\n` inserted at byte 8250. Independent whole inverse and replay were performed during this specification. There are no other source changes.

The source writer reports native TypeScript and the unchanged 28 owner cases passing, plus the original four-module/five-function/eight-case application: all four prepared/legacy host routes, each with direct and actual helper calls, give 64 Object.is matches to the native oracle. The original Linear acceptance refusal remains saved. This is the source writer's measured finite result (`.tmp/early-return/final-review.json`, SHA `f7ce99a9209e8acb57c12905877cab2552be65c5e6339e55473c6170597da3d1`); it is not yet a passing integrated historical-proof epoch.

The old D1 component pins the owner at e6bd; `loweringAnalysisRead` also independently pins e6bd; H2 calls the component using the genuine authority reader. Changing only a C1 scalar cannot make these proofs valid. Conversely, replacing a supplied mutant with a healthy file would invalidate the guards. Existing default-reader controls must continue to exercise genuinely installed current source, including healthy/missing/restored receipt behavior.

### 1. Append one current entry to the existing source component

Owner: one proof writer, `tests/helpers/ir-lowering-analysis-relocation.ts` only for this stage. Preserve its **entire original 17637-byte prefix** (`4378d72f5b51148fa345f2544f1c43df12d4a967b369ef0be95d99c6f16c7ba4`) and both existing exports byte-for-byte. Append:

`captureCurrentLoweringLegalityPredecessor(rawCurrent: string, readAuthority?: AuthorityReader): string`.

This entry validates the primitive supplied adapter argument and reader in the same order as the existing operation, then calls the unchanged `captureLoweringLegalityPredecessor` using a local path-specific reader. The delegated operation must still read the original source receipt, adapter, then canonical owner, exactly once in the existing order. For every path except the canonical owner, forward the actual caller reader result unchanged. For the owner only:

1. Read that actual current string once; require primitive UTF-8 and the **single cdd60287 full bytes/SHA/blob pin** above.
2. Check the exact inserted bytes at byte 8250, remove only them, and authenticate the entire e6bd predecessor by bytes/SHA/blob.
3. Insert the same bytes back at the same coordinate and require whole-current equality.
4. Return this authenticated historical string only to the old D1 pair proof. Never return it as a production source, resolver input, or claimed current observation.

Use a closed exact path branch, no selectable versions, optional acceptance of e6bd as current, arbitrary transform callbacks, source caches, fallback, or new authority file. Old receipt `ir-lowering-analysis-relocation.json` remains exactly 111423/dc8241d36da5b2fe29abe12ed6ee348fc456ef22939c61aabe05d09daad92134. Its original source inputs, 129 inverse/140 forward pieces, historical donors and algorithms remain unchanged. The original APIs still prove their original epoch when given an explicitly historical reader. The new current entry is the sole production-proof bridge for the evolved owner. The unchanged supplied adapter equality test remains operative.

No self-referential module hash is embedded inside this component. Root freezes its appended final bytes first; callers authenticate that independently fixed complete implementation before trusting the new export.

### 2. Two actual callers and the historical policy-prefix consequence

Owner: proof integrator, after the component freeze; serialize these dependencies with root's pin authoring.

* `tests/helpers/ir-c1-current-source.ts`: change the legality import/call at the current line 776 to the new entry; update the external complete component bytes/SHA/blob pin from the actual frozen component. Keep its fresh implementation read and pin **before** the imported call. Pass the actual supplied authority reader, not a healthy replacement. Population adapter strings remain current and must still equal the independently read physical adapter. Only the historical population receives the authenticated 26410-byte old donor. The real current planner remains in real resolution. No change to H1, the 47 population paths, nine extra closure paths, 13 resolver requests, 57 resolver observations, or the existing authority-read vector: projection adds no read.
* `tests/helpers/ir-runtime-program-policy-evolution.ts`: change the D1 legality import/call to the new entry. In `loweringAnalysisRead`, preserve mode/regular-file checks and exact path domain; only the canonical-owner branch authenticates the **actual cdd pin** instead of immediately applying the old source-input pin. Return the actual current bytes; the component performs the historical inverse. All other branches remain exact. Keep the literal historical `loweringAnalysisExpected`, D1 policy receipt, source receipt and its sourceInputs unchanged. In implementation authentication, authenticate the new full component with a root-fixed independent pin, and additionally check its first 17637 bytes against the unchanged historical `componentImplementation` record. Existing mode checks and first C1 authentication stay in place. Do not pretend the historical receipt now contains the new component pin.

These necessary policy edits lie after the historical 331953-byte prefix, which must remain exact. They do change the currently raw prefixes authenticated by classification (356816) and ArrayBuffer.isView-main (369345). Therefore change only those two prefix-read operands to finite inverse projections. Root authors two fixed, ordered UTF-8 edit tables from authentic complete old/current helper bytes: each table reconstructs its entire original prefix, checks the original literal prefix pin, and replays to the complete captured current prefix. Validate integers, nonoverlap, coordinates, exact before/after fragment bytes, bounds, and complete unchanged gaps. Each call reads the actual helper freshly once. Keep the exact original prefix failure diagnostic and the surrounding receipt → prefix → predecessor receipt → C1 order.

Put the projection functions/tables in a new suffix **after all pre-existing helper code**; the table definitions must be outside both projected prefixes. The only edits inside those prefixes are the enumerated D1 integration edits and fixed prefix-projection call expressions. Thus the tables do not contain themselves and require no self-hash cycle. Use two named fixed operations, not an arbitrary caller-selectable receipt or digest set. Root independently proves both full prefixes and the full helper reverse/replay before accepting this code. Classification and isView receipts, full policy JSON, histories/moves/rows and all earlier prefix contracts remain byte-exact; no policy successor row is required for an existing owner path.

### 3. Default-reader, independent fixture, and application controls

Owner: proof-test writer, disjoint from the three helper files. Exact existing paths:

* `tests/issue-3518-lowering-analysis-preservation.test.ts` (current 37736/b4780561...). Update the external implementation pin after root freeze and route the backend-legality operation through the new **real** current entry. Its existing default reader healthy/missing/restored controls remain real calls with no supplied reader, on actual cdd installed source. Preserve all original 47 registrations and assertions apart from explicit pin/operation/fixture epoch adaptations; add controls rather than silently delete failures. Keep the earlier independent component subprocess and the later Linux-safe application subprocess transport unchanged: the latter sends its script through stdin, not `--eval`.
* Maintain separate current-fixture and historical-recipe pin ledgers. The real fixture copies/pins cdd owner bytes. The independent donor oracle applies the fixed 25-byte inverse itself, checks e6bd, then executes the unchanged original receipt pieces; it must not obtain expected donors by invoking the component under test. Its forward oracle replays the D1 receipt to e6bd and then the exact insertion to cdd. Other three source pins and all original piece populations remain unchanged. Explicitly prove the old component API on the independently reconstructed historical fixture, its refusal of raw cdd under the old contract, and new current default success. Never temporarily substitute a historical file in the production checkout merely to make a default call pass.
* Retain all real source/receipt/helper mutations, persistent backup/lock, expected fault identity, both operation/restoration errors, and paired healthy restoration. Existing cached six and fresh-process three application cases must exercise normal H2/policy calls with the **new complete component guard**, not a test-local proxy. Priority controls must still prove missing receipt with a healthy helper, then combined helper/receipt faults stopping at the implementation guard. Supplied adapter mutants with healthy physical source continue to refuse.
* `tests/issue-3525-presentation-classification-policy.test.ts` and `tests/issue-3525-arraybuffer-isview-main-policy.test.ts`: their physical-fault harnesses currently authenticate raw `subarray(0,356816)` and `subarray(0,369345)` before mutation. Adapt precisely that pre-fault authentication: independently fixed current whole-helper pin plus independently checked exact prefix inverse to the unchanged expected historical pin. Do not use the production projector to manufacture the oracle. Root provides reviewed reciprocal fragments. All original 45 and 56 registrations, real mutation actions, receipt tables, guard error assertions, healthy/refusal/restoration and backup machinery stay unchanged. The operational helper has changed; do not just shorten/skip the fixture authentication.
* `tests/issue-3518-c1-current-source.test.ts`: retain every original 292 case, existing complete read vector and two-channel negatives. Add finite controls recording that the owner authority read is exactly cdd while returned historical donor remains 26410/6a64764b; new current owner missing/corrupt/old-e6 substitution and same-size unrelated edit refuse with healthy restoration. Preserve the current adapter observation and actual planner/native resolver assertions. Verify old e6 never enters current population or resolver observations. Since the canonical owner is outside the fixed 47 population, assert its real authority observation directly; do not fabricate a new population entry.

Required new component negatives: wrong/missing/extra insertion, wrong coordinate with the same text elsewhere, old owner supplied as current, a one-byte mutation outside the span, nonprimitive owner result, supplied adapter mismatch, and repeated healthy→fault→healthy capture without caching. Full-pin refusals are labelled as full-pin coverage; do not falsely claim unreachable internal span branches were exercised. Whole inverse/replay and independent fixture controls prove the fixed span mathematics. Primitive raw arguments/getters must refuse before authority I/O, with real missing-authority counterwitnesses for the normal accepted primitive path.

### 4. Root-only C1 assembly and exact permitted scope

The authenticated starting manifest is 379836/f02eee675a6b5a061c96987ab77e073e4abdb13b30f37aa29aa2eed37779da93. Root must capture actual predecessor/current bytes once with regular-file/mode/identity checks, not reuse an unverified old branch. Only **two of 12 current instrument pins** change: H2 (`ir-c1-current-source.ts`) and the policy helper. Only **one of ten historical instrument recipes** changes: policy helper, whose authentic full historical origin remains 93405/e243101b31f29b2b4aa2637fdd3f9c814a5b6bada558ce565d3d3c132e71892f. Rebuild that full-original-to-final recipe; preserve its beforePin and all nine other complete recipe objects. Independently invert and replay all ten against captured final streams. Preserve other ten instrument pins, all 11 immutable authorities, seven artifacts, historical/current-base meanings, population/config/type closure and resolver/declaration contracts.

The component and the four edited test files above are not C1 current instruments; component trust is the explicit fresh full pin in H2, policy helper and preservation test. No C1 domain expansion is needed. Root binds manifest → anchor → the unique decoded external `independentFreeze` scalar last, preserving all bytes outside that scalar after formatter normalization and the original declaration contract. No blind replacement of historical full source pins or recipes, no addition of accepted alternative hashes.

Finite proof write set: the three helpers; four named existing test files; C1 manifest and anchor; plus root's unique scalar within the already-listed current-source test. No historical JSON receipt, compiler-boundaries policy, H1, initial-policy caller set, production routing, driver, emitter, verifier or inliner edits. New semantic test/source remain separately owned. Root serializes helper freezes, external pin literals, prefix projections, test fixture pins and final C1 assembly; workers must not select their own expected authoritative values.

### 5. Acceptance and release boundaries

Before bodies, require source/focused test TypeScript, lint and real-path formatter checks, exact prefix/source inverses, explicit planned registration delta, and independent C1 recipe/binding review. Then run the adapted preservation suite (all old 47 plus observed new cases), unchanged 45/56 policy suites, and current-source suite (all old 292 plus observed new cases) with clean raw and JSON channels and full before/after custody, using isolated exclusive physical fault windows. Run the three unchanged relocation suites (298/631/62) once for the final assembled epoch; no earlier epoch receives future pass credit. The normal repository gates/hooks remain required and may cover further unchanged policy consumers; de-duplicate only when exact final bytes, actual ordinary channels and required cohort provenance are demonstrably identical, never from counts alone.

Retain the measured 28 owner regressions, original 64-observation complete application and the independent new semantic suite; report each actual denominator separately. Public delivery still requires root's exact-head/main reconciliation, normal publication and required Linux CI. Existing PR6481, legacy compilation, Boolean71ecd and 6837 remain preserved; no automatic benchmark retry, global parity, retirement or broader backend/profile claim follows from this repair.


### Root release for reviewed finite proof integration

The measured source candidate and semantic tests are complete. Existing preservation suite on the untouched historical component records2passed/45failed solely at old-source pins; these failures are preserved. Root releases the exact finite proof implementation above in disjoint files: component-only Sol writer on its own separately claimed branch, four existing-test adaptation Sol writer, root-owned H2/policy and final C1 authority assembly. Component freeze precedes external pins; fixed historical prefixes/receipts and supplied-mutant guards remain mandatory. No publication or currentPR6481 mutation follows from this release. Root current-source proof claim serializes authoritative pins and merges all completed candidates.

### Early-return proof integration and parallel validation — 2026-10-05

Root integrated the exact 25-byte Linear allowlist insertion with the new current-source proof entry. The original historical receipts, prefix authorities, source inputs, current population/resolver domains, and legacy compiler routing remain unchanged. The component's original 17637-byte prefix is exact. The two policy prefixes independently reconstruct and replay their original bytes; their tests use independent fixed-fragment oracles. Root assembled the final C1 manifest at 387432 bytes / `695d419af972b2df9f2459c2b724fff46ba5d1c5fc314a9526f3d7855271d5fa`, changing only two of twelve instrument pins and one of ten historical recipes. Astra independently reconstructed all ten historical Git originals and checked complete inverse/replay, the 194-byte anchor, and the single actual TypeScript scalar binding. C1 review: `0ffa3e62cad978853ad117726c02b07b1753a6d5eca00edfe5bceff5d82d3601`.

Actual strict ordinary execution on isolated final-epoch copies: preservation **57/57**, presentation classification **45/45**, and ArrayBuffer.isView **56/56**. All six collection/body children exited 0, ordered names matched, error channels were clear, and every before/after plus final 7657-file declared custody vector matched. The original source-only historical-proof result **2 passing / 45 failing** remains preserved separately. Root additionally reran the durable semantic suite on the assembled epoch: **16/16**, actual ordinary child 83121 exit 0, 33.6345 seconds, exact 7652-file custody and clean ordinary channels. All eight native gates exited 0: source typecheck, full lint, oracle/coercion/LOC/function ratchets, layering, and preservation-mode dead-exports. The latter still reports an open graph and does not certify retirement.

Producer routing: Astra High specified and independently reviewed hard proof changes; Sol 6.1 Medium implemented the source/component and semantic/proof tests; root Sol 6.1 High owns final helper pins, C1 assembly, integration, and delivery. Each writer has an isolated branch and canonical slice claim. The component claim's first attempt was automatically rejected because it reused the source branch; no writes occurred, and a separate component branch was created and claimed successfully.

The current-source and three unchanged relocation cohorts are still pending final ordinary execution. Local runtime is supplied Node 24.4.1 / Vitest 3.2.4; these are not CI 3.2.7 results. Existing PR 6481, “feat(ir): finalize authentic prepared programs through the compiler pipeline,” remains at `2a27c614bfc282d11656092d18de13b97808e41c`: the fresh resumed snapshot shows OPEN/unmerged, base `159c15c727c6dedef41a4dab2d535bb0b2d0f00b`, and quality job 111706995831 still running. This repair is uncommitted/unpublished; no main delivery, full language parity, optimization parity, or legacy retirement is claimed. Downstream Boolean and modular-analysis work remain preserved and unrefreshed.

### Subsequent ordinary proof milestones — 2026-10-05

The final C1 current-source cohort passed **297/297** (actual child 90211 exit 0, 48.6753 seconds), preserving the exact original 292 ordered registrations and adding five owner controls. Runtime relocation passed **298/298** (child 90314 exit 0, 79.3686 seconds). Both restored their entire 2490-input declared custody vectors with clean ordinary error channels. Astra independently reviewed the completed C1 run (`9b291ed2f232cecc679cc3462fcbd6ade45d41fcaab90f80491dc6ebd260c3a4`). Historical reconstruction and validator relocation remain running/pending as normal commit hooks begin in the separate integration worktree. Final outcomes belong to the checkpoint handoff; no main merge or retirement is claimed.

### Completed early-return proof and delivered predecessor — 2026-10-05

The ordinary final-epoch suites passed 1462/1462 distinct tests:16 semantic,57 lowering preservation,45 presentation policy,56 ArrayBuffer.isView policy,297 current-source,298 runtime relocation,631 historical reconstruction,62 validator relocation. Every child exited0; ordinary error channels were clear and declared custody restored. Architecture reviews completed independently. The unchanged numerical application produced64 exact native-oracle observations on both prepared/legacy backends and genuine generated helpers. The earlier2-pass/45-refusal source-pin run remains saved. These are finite checkpoint results, not complete IR coverage.

Existing PR6481 delivered exact head2a27 through merge da6f744c5ce32123ab425c10819b5e1f29f12807. Main358d47aadd9314942c01f80754d23e5f6847265e contains all source/test/authority bytes unchanged; its12 subsequent report/LOC-baseline deltas are retained. Independent ancestry/full-tree receipt SHA84b730607e72e4f79f0a870396660aa1400b5738fdb9bd6dfb2335353024ed8f. Protected group and raw harness outcomes are recorded separately:102 genuine shard jobs succeeded, but verdict populations are not all-pass claims; equivalence retained22 known failures, and each120-case differential lane retained116 matches,2 mismatches and2 runtime errors with explicit harness exit1. Cancelled advisory jobs and their aggregate exit1 are preserved. No blanket all-green or full parity claim. Early-return publication, new exact-head CI and its own main delivery remain separate requirements. Legacy/public routing remains unchanged.

### Implementation plan: genuine mixed WasmGC host presentation

Astra High supplied the following bounded plan (draft SHA051f785038a56c821d00c1d8af7ad0e1226f184d9af4c0df17c5a1f2485fe2c8). It is recorded now for ownership and review; source implementation is not released before the prepared predecessor is delivered and authenticated.


Status: specification only. No implementation, refreshed branch, claim or runtime is released. Record this plan now; implementation remains held until the numeric presentation/early-return dependency is delivered and the actual current predecessor is authenticated. Update **“IR-only R5: whole-program single- and multi-source Prepared ownership”**, `plan/issues/3525-ir-r5-whole-program-multi-source-ownership.md`. Preserve the existing issue prefix. Related contracts are R6 semantic runtime, R7 AST-free async/Promise ABI and R8 shared Linear; this cut does not close those epics.

## Concrete problem and productive endpoint

At pinned PR `2a27c614bfc282d11656092d18de13b97808e41c`, `src/compiler/ir-program-presentation.ts:252–291,651–663` refuses async declarations before the real driver. Its later numeric-only resource/signature checks also reject genuine async demand. This is not a missing WasmGC scheduler: the pinned former-main comparator `159c15c7` and PR have identical codec/replay tests asserting WasmGC acceptance/emission/execution of ORIGINAL_MIXED. Current host frame planner, resource owner and Promise-job scheduler already exist.

Produce real finalized binary, helper and declarations through the existing private `runPreparedIrPipelinePresentation` for that unchanged three-source program. Admit a structural family: synchronous numeric companions and numeric-parameter async callables whose authentic prepared contract is the supported host Promise ABI. Do not recognize filenames, fixture digest, function names or a fabricated “complete” flag as eligibility. Include a second independently written multi-source async application to prevent fixture-specific admission. Existing numeric and subsequently integrated marked-Boolean contracts must survive unchanged.

## Exact source work

**Leaf writer: `src/compiler/ir-program-presentation.ts` only.** Start from the delivered, reconciled current leaf, not an overwrite with the old9587 or prepared Boolean9eba snapshot.

1. `capturePresentation`: retain the one analyzed source/checker capture, options snapshot and full source-content census. Capture the async modifier, exact declaration extent and checker-authenticated promised result using the existing genuine Promise identity/type contract; a thenable, textually named fake Promise, generator or unsupported parameter/result must not become an async export by name. Retain independently captured source facts, then join them to prepared unit/source identities. Do not ask the frontend to lower a body again. Optional/default/rest or other still-unproved signatures retain explicit located refusals.
2. `joinDeclarations`/`checkAbiExports`: retain total original-owner coverage and sourceId→original filename→start/end correspondence. Async source return `Promise<number>` is not a numeric physical return: join the authentic callable `contract.promise` to the current `asyncPlan.abi`/runtime attachment and the genuine physical `externref` result. Validate parameter/result kinds and brands, binding IDs, aliased exports and emitted slot identity. The existing frame planner validates exact Promise signature at `program/prepared-async-frame-plan.ts:334–338`; consume that provenance rather than inventing a second ABI. When live function imports exist, physical function-space indices include them: map through the authenticated emitted binding and import count, not `mod.functions[slot.index]` as if imported functions were zero. Keep reverse physical export census and the exact constructed startup adapter exemption.
3. `checkResourceDemand`: replace only the blanket async/provider-zero requirement with a finite join over the selected `wasmgc:host` prepared runtime manifest, actual support function receipts, source async attachments, support batches and emitted imports/resources. All observed demand must belong to the selected frozen plan; foreign/extra/missing provider, helper, carrier or owner is refused. Keep unsupported resource families explicit. Do not remove all import/string/extern checks en masse, make an empty resource bag, or infer authority from an export name. Consume `emittedSupportFunctionReceipts` and genuine C reservations before trusting presentation metadata. The same packet/emission objects from the single real driver transaction must reach finalization; no caller-supplied driver result or generic injection seam.
4. Preserve `joinStartup`: original module dependency/source order, real globals, exact executable startup inventory and adapter index. Async invocation and module initialization are different lifecycles; producing a Promise must not rerun module init. Use genuine emitted `asyncFunctions`/boundary metadata for final artifact rendering; if current C output omits a required map, report the exact missing field/producer rather than filling it from a guessed name.

**Root integration: `src/compiler.ts` private transaction/finalizer subsection only if the real mixed module needs it.** `finalizePipelineModule` always applies reference-nullability widening. It does not perform numeric widening. The old numeric leaf refuses widening demand, so simply admitting refs would silently cross its receipt boundary. Before release, identify whether the genuine mixed module changes under the existing finalizer. If widening is a no-op, prove exact module/receipt preservation. If it is not, explicitly record the deterministic permitted ref→ref_null projection and independently prove its exact post-state without changing function/export indices, opcode order, globals, import population, ABI ownership or startup; keep original emission receipts as pre-finalizer evidence. Do not re-certify a mutated module under an old C receipt or blindly repin it. Any required root-only check is local to this private transaction; public routing, C emission, driver and runtime algorithms stay consume-only. A missing producer beyond these scopes is a named dependency, not permission for the leaf writer to expand ownership.

`src/compiler/output.ts` and runtime wrapping remain consume-only initially. Existing genuine host async exports already return native Promises in the codec witness. Verify the generated helper passes them correctly before proposing any wrapper change. Never wrap an already genuine Promise in a substitute scheduler or add unnecessary imports. Existing declaration rendering uses `mod.asyncFunctions` and `Promise<T>`; verify actual produced fields rather than requiring byte identity with unrelated legacy bookkeeping.

## Independent semantic test writer

Own only new `tests/issue-3525-prepared-pipeline-mixed-wasmgc.test.ts` after root checks that the path is free. Use the real analyzed frontend and the existing private entry; use original-call observation/spies only, not a fake packet, acceptance result or emitter.

- Preserve **ORIGINAL_MIXED** from `tests/issue-3518-program-codec-replay.test.ts:611–617`, digest `236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb`. Its three sources and seven original terminal owners must remain unchanged. The current witness has14 prepared emitted IDs, including seven prepared runtime bodies; extra physical continuation helpers are a separate population. Assert complete identities and ownership, not just these totals.
- Real outputs: `initial()===212`; seeds0,7,-3 settle to `4*seed+212`; independently executed native phases are `[1,2,3,3]` around the actual awaits. Exercise both the finalized binary with genuine imports and the **generated imports helper**. Observe actual Promise identity/type, no synchronous completion, repeated calls and meaningful interleaving without replacing the original sequential phase oracle. Compare a real legacy artifact against the same source/native oracle, retaining honest metadata differences rather than normalizing them away.
- Second independent program: different modules/call graph and at least two awaits, numeric computation and observable state. Include genuine fulfillment and a genuine rejection fixture supported by the existing producer/runtime. Derive expected value/error and timing independently from native source execution. A source throw must reject the returned Promise rather than throw synchronously or resolve undefined. Preserve error identity where the boundary promises identity, otherwise exact specified payload/shape; do not claim an unsupported throw carrier is already supported. If the original provider policy omits a required number-box intent, retain that located refusal and specify the real policy dependency—no broad fallback.
- Authentic association: one capture/driver preparation per artifact transaction, emitted packet identity reaches finalization, exact source/ABI/runtime/support ownership and physical pre/post state. Positive-first faults for stale/foreign unit or runtime, wrong Promise ABI/carrier, changed physical return signature, extra/missing support/import/export, altered startup index, resource mutation and caller option mutation. Count earlier genuine C refusal as earlier-guard evidence, not as a leaf-branch test.
- Keep a real scalar positive and preserved numeric/Boolean tests. Keep original Linear request refusing its genuine missing `promise.capability.create` adapter; that is not this cut’s failure to fix. Keep nonhost, source-map, C-ABI and optimization refusals unless separately specified; no option workaround or fixture simplification.

## Boundaries, dependencies and release

Only WasmGC host is the added productive family. Linear async needs a real carrier/provider/frame/resource contract, not an allowlist change. Standalone/WASI async, generators, arbitrary nonnumeric data and full public routing remain open. Do not add a new policy switch, dynamic plugin registry, cache, permissive hash set, fake receipt, new legacy fallback or retirement step.

Proposed file-disjoint lanes after root release: (1) Sol6.1 Medium leaf writer, sole presentation leaf; (2) Sol6.1 Medium test writer, sole new test; (3) root sole shared compiler/finalizer and source-policy/C1 integration. Reuse already prepared Boolean code rather than parallel-editing its six files; select and authenticate dependency order first. No currently protected source ownership is presumed free. Runtime/output changes, if actually necessary, require a separate exact owner/contract before implementation rather than overlapping these lanes.

Acceptance is productive unchanged ORIGINAL_MIXED plus an independent program, genuine binary/helper/native and legacy observations, exact ownership/physical controls and unchanged existing checkpoints. Then normal current-epoch type/lint/format/authority checks and protected delivery. Source assertions are not a fresh measured pass; no test count in this draft is promised. Local success is not full IR equality, cross-target support or performance acceptance. Legacy remains until the full3518 acceptance is actually discharged.


## Root release: independent completed-emission plan observation — 2026-10-05

The previous goal turn delivered verified early-return PR6488 and completed/published readyBoolean PR6490 exactd6ec2b21b3e5461ddd8f87c23e41bfae745739b3 with1574 ordinary passing cases. Its requiredCI is separate and its published branch stays untouched. This consumer-only seam is independent of those six Boolean production files and three current-type proofs; it moves toward authentic mixed-program presentation without waiting for or refreshing that PR. No new presentation, finalizer, provider or retirement scope is released here.

Selected delivered main predecessor is f7ab45d2fe5bb0d4243c28c02ba98f495804f8cf. Its consumer is whole-byte identical to c3e3 used by the following Astra specification. Canonical claims are3525:mixed-emission-observation-{source,tests,integration}-20261005, owners ttraenkler/codex-emission-plan-{source,tests,integration}-20261005, branches codex/3525-emission-plan-{source,tests,integration}-20261005. Root reserves separate isolated worktrees for each, reads the canonical assignment book and verifies writes by effect. Earlier Claude C incrementfdeb628d and the former exception replay branch are both ancestors of delivered f7ab; both prior scopes are clean. Those historical held claims remain preserved, not force-stolen or released. The user has explicitly identified this as the sole current IR session.

Root now grants the four finite consumer edits specified below ONLY in src/ir/program-consumer.ts to the Sol6.1 Medium source writer. Independent Sol6.1 Medium test writer owns only NEW tests/issue-3525-emitted-physical-plan-observation.test.ts and ONE added explicit sorted emittedPhysicalSetupPlan literal in the existing codec test API whitelist; every other existing assertion/body/source remains exact. Root owns issue/log, any actual required small LOC allowance, final coherent packet and publication. Astra High checks the hard contract and genuine evidence. No plan rebuild, broad helper/driver schema, source preparation, runtime/provider/backend algorithm, global budget threshold or historical authority change is authorized.

Crucial corrected failure control: a reservation failure permanently poisons its private ledger. A mutated body/census must refuse; restoring exact physical data does not heal that same capability. Assert continued same-token refusal after restoration plus a fresh genuine producer/accept/emission healthy counterwitness. Do not weaken the ledger to make a restored-token test pass. Getter authenticates provenance and existing completed-function guards, not all mutable module exports/imports/finalizer state.

Source freeze/inverse and exact API agreement precede final body release. Meaningful positive tests obtain genuine prepared programs from the real frontend/preparation owner; scalar programs cover bothhostbackends and the exact existing ORIGINAL_MIXED fixture covers WasmGC host async callbacks. No fake plan/injected driver result, synthetic acceptance or filename-based eligibility. Compare the accepted plan reference to the emitted observation, deep freezing/repeatedreads/distincttransactions, forged/cloned/incomplete refusals and permanent-poison body/census controls. Keep original one-shot acceptance and mixedLinear unsupported behavior. Full current codec/completion and relevant native gates run unchanged; repeat or broaden only for actual new failures. No automatic C1 reseal is indicated by the inspected dependency domain. Measure actual formatted LOC/function growth before any own-issue allowance; do not borrow otherissuegrants. Normal signedhooks/prepush/requiredCI/protectedmain remain mandatory.

The following dated implementation plans retain historical source/Boolean-ready observations. This release supersedes their earlier “not yet released” status only for the finite consumer seam and its explicit tests; productive mixed presentation and full parity/performance/legacy retirement remain incomplete.



## Mixed WasmGC presentation: authenticated completed-plan observation (2026-10-05)

This is an implementation-plan addendum to **IR-only R5: whole-program single- and multi-source Prepared ownership**. It refines the existing mixed WasmGC presentation plan; it does not release C implementation, change public routing, retire legacy, or certify full equality. The root integrator must explicitly grant the finite consumer edit before its writer starts. The delivered comparison base is `c3e3fab33d9ef4747f2a502ab1a8c46d8b224ea1`; the prepared-checkpoint repair is present through merge `b6324ee6d148e2e175bc469fdba899830bd32582`. Source pins and Boolean composition checks accompany this appendix in `source-and-composition-review.json`.

### Concrete interface constraint — source-derived, not a new measured failure

At this base, `src/ir/program-consumer.ts:190–198` retains completed reservations, function/support receipts, startup index and final ABI indices. It does not retain the physical setup plan. The authentic accepted token can reveal that plan through `acceptedPhysicalSetupPlan` (420–425), but `src/compiler/ir-program-driver.ts` deliberately returns the real prepared program and emission, not that token. The presentation leaf therefore cannot authenticate the consumer-created async callback export population from its present result alone.

This is a source-derived observation gap, not evidence that the current WasmGC consumer fails mixed async acceptance. No new callback runtime observation receipt was executed. The unchanged ORIGINAL_MIXED fixture already contains a static WasmGC host acceptance/emission witness; its original three-source digest is `236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb`. Its historical presentation refusal occurred before the driver. The separate Linear `promise.capability.create` adapter gap remains separate.

`program/async-frame-setup.ts` joins authentic primary and supplemental ABI entries. `prepared-async-frame-plan.ts:580–609` constructs callback aliases with owner/unit identity and target binding; `program-physical-plan.ts:1005–1018` adds their actual exports. Generated `__cb_*` names are labels, not proof of ownership. The existing source-export-only reverse census must not be replaced with a name-prefix exemption, an arbitrary caller snapshot, a second preparation, or a second physical-plan computation.

### Smallest authorized C seam

Proposed exact API:

```ts
export function emittedPhysicalSetupPlan(emitted: EmittedPreparedIrProgram): PhysicalSetupPlan;
```

A separately granted consumer writer owns only `src/ir/program-consumer.ts`:

1. Add one readonly `physical: PhysicalSetupPlan` field to the private `EmissionObservation` (190). The type is already imported.
2. Pass the existing `plan` reference into `recordEmissionObservation` (761) from the completed `materializePhysicalProgram` call (1480), and retain that reference in the frozen observation. It must be precisely the deep-frozen object acceptance derived and emission used, not a clone or reconstructed approximation. Record it only at the existing successful completion point.
3. Add the getter beside existing emission accessors. It must reject a forged or unrelated emission using the existing private WeakMap and `invalid-transaction-capability` invariant. Reuse the existing completed-function reservation/census authentication of `emittedSupportFunctionReceipts`; do not duplicate or relax that implementation. Return the retained plan reference after those checks. It is acceptable for the leaf to use this getter instead of an otherwise redundant separate support-authentication call, while retaining all required support ownership checks.
4. Preserve existing getter identities/semantics, accepted-token one-shot behavior, ABI finalization, source-free emission, and reservation lifetimes. No `PreparedIrProgram`/driver-result schema change, callback registry, public injection seam, pass manager, runtime cache or capability exposure is needed.

The getter authenticates provenance and the existing completed-function reservation state. It must not claim to certify every later mutable module field. The plan is immutable; the module remains subject to explicit physical import/export/type/global/startup and finalizer checks. Do not expose `PhysicalModuleReservations`, reservation tokens, resolver maps or the private observation record. Do not return an optional empty plan on failure.

### Presentation joins that consume the seam

The leaf owner changes only `src/compiler/ir-program-presentation.ts`, after the getter contract is frozen. Keep one genuine driver transaction per artifact. Associate the returned plan with that exact emitted result; no caller-supplied accepted result or boolean “complete” flag.

- Capture genuine ambient `Promise<T>` source results with the existing producer's ambient-symbol/type-argument rules (`program-source.ts:254–265`), not spelling alone. Authenticate all original source/unit/binding associations and the actual selected WasmGC host projection. Keep the exact ORIGINAL_MIXED source and seven original terminal owners; distinguish its fourteen emitted unit IDs from additional physical continuation functions.
- Use the same-plan `asyncFrames.frames`, supplemental `entries`, physical `exports`, `functions` and startup records to authenticate every extra callback export. Join alias binding → target binding → actual emitted final index. Use `emittedProgramBindingIndex` only as the saved final-index observation it actually is; it does not authenticate later module mutation. Every physical export must be consumed once by a source, authenticated callback, or genuine startup-adapter join. Reject missing, extra, duplicated, wrong-space, wrong-target or wrong-signature exports. User exports beginning `__cb_`/`__module_init` must remain distinct from constructed bindings.
- Keep absolute function indices in ABI/exports. When looking up a defined body in `module.functions`, subtract the authenticated function-import count and check bounds. Imported function indices must instead resolve to the corresponding authenticated import descriptor. Do not apply a zero-import shortcut or subtract all imports indiscriminately. Join actual provider/import descriptors and types to this plan; an unexpected provider family remains a typed unsupported result, not an ignored descriptor.
- Admit the genuine host async ABI contract and physical externref Promise carrier. Do not synthesize `mod.asyncFunctions`, invent Promise imports or wrap an already genuine Promise with a newly constructed one merely to make assertions pass. The current C plan uses host Promise scheduling; existing generated helper/runtime behavior must be inspected and executed as-is.
- Root owns the existing `compiler.ts` private finalizer seam. Preserve startup selection by constructed adapter identity, exact once-only execution and the existing helper/manual versus wasm-start semantics. Before the finalizer, capture the genuine module layout needed for independent comparison. After finalization, prove the complete permitted ref→ref_null transformation, including nested type/block/global/import positions; retain all unrelated bytes/structure. `widenNonDefaultableTypes` is reference-nullability widening, not numeric widening. Do not label the pre-finalization reservation receipt as a post-widening certificate or replan around a changed module.
- Source maps, C ABI and optimization requests retain their current refusal contract unless separately implemented and tested. Linear async, non-host targets and other output families are not silently accepted by this seam. A genuine missing required producer field must be named before expanding scope; do not substitute empty metadata bags.

### File-disjoint packages and ownership

- **Consumer seam writer (new explicit root grant):** only `src/ir/program-consumer.ts`, the four bounded edits above. No source-preparation/provider/backend planner changes. Freeze the patch, full before/current pins and inverse before leaf integration.
- **Presentation writer:** only `src/compiler/ir-program-presentation.ts`; authentic async/source/plan/physical joins and productive internal output transaction. This file overlaps the active Boolean source continuation: root must first choose and authenticate the composed Boolean predecessor, then transfer exclusive ownership. Do not overwrite the Boolean marked-slot contract or use its old leaf as a current base.
- **Independent semantic test writer:** only new `tests/issue-3525-prepared-pipeline-mixed-wasmgc.test.ts`. Use real producers/consumer/output/helper behavior. Root separately owns any necessary `compiler.ts` finalizer changes, issue frontmatter, authority composition and final assembly. No two writers share those files.

These are dispatch boundaries, not new claims or implementation release. Root may prepare tests against the agreed API while the consumer writer works, but bodies require the coherent frozen production packet. Implementation remains conditional on explicit ownership release and current predecessor authentication; already delivered PR6488 does not itself grant C ownership.

### Required meaningful controls

Getter tests must obtain accepted/emitted objects from genuine existing preparation: strict reference equality between `acceptedPhysicalSetupPlan(accepted)` and the new getter after emission; deep-frozen plan data; cross-emission distinction; repeated read without new planning; forged/spread-cloned emission refusal; incomplete or foreign emission refusal; real completed-function/body/census mutation refusal with healthy and restored counterwitnesses. Use original-call observation/spies only for provenance, not forged plans or injected success values. Keep one-shot acceptance tests unchanged. Module export/import mutations need the presentation's own joins; do not claim the getter alone detects them.

Productive tests retain the complete original mixed program and independent native/legacy observations, execute the actual final binary through its actual generated helper, and await real fulfillment/results, rejection/exception identity, ordering and interleaving. Preserve the existing initial/seed expectations and phase sequence; add a distinct mixed fixture with a real rejecting async operation and handler observation. Assert actual Promise behavior, not merely thenability or emitted-unit counts. A second program's authentic plan must not be accepted for the first program's result.

Counterexamples must exercise callback binding/name collision, additional or absent callback export, wrong target/index/type, nonzero imported-function offset, carrier mismatch, forged Promise annotation, unexpected resource family, startup adapter confusion and unrelated finalizer mutation. If the genuine consumer's existing guard refuses a mutation first, assert that real first guard and retain a separate healthy witness; do not manufacture local-join coverage. Keep the numeric/void and composed Boolean host contracts as regression controls. Full IR parity, arbitrary untyped Boolean identity, Linear async, all profiles and retirement remain open.

### Actual reader and budget consequences

The pinned current `tests/helpers/ir-c1-authority.json` contains no `program-consumer` path literal. Searches of `scripts` and `tests/helpers` identify the truthful compiler-boundaries row, the existing `ir-layering-baseline.json` count, replay API imports and explicit source-measurement helpers; they do not establish a direct fixed C1 consumer-body pin. Thus this consumer-only seam does not justify a blanket C1 reseal. Run ordinary native dependency/layering gates on the final patch and inspect any actual failure before changing metadata.

`tests/helpers/ir-whole-program-replay.ts` already consumes the accepted-plan API; `scripts/ir-whole-program-replay.mjs` consumes completed support/startup observations. Preserve those APIs. `physical-completion-source-parity.mjs` and `semantic-provider-source-receipts.mjs` measure candidate/historical source arms: retain authentic historical source and old evidence, record new candidate pins for a new measurement, and never repin the historical arm to make it pass. Existing fixed original-instrument text remains historical.

At c3e3, `program-consumer.ts` is **1,489 newline-counted lines** (1,437 nonempty). `check-loc-budget.mjs` uses newline count and a 1,500 threshold; even this small seam may cross it. Record the actual formatted delta, and if it crosses, root adds a narrowly justified `src/ir/program-consumer.ts` allowance in the PR's own issue3525 frontmatter. Do not change the LOC baseline or borrow another issue's grant. `materializePhysicalProgram` currently spans lines1192–1489 inclusive (298); the added plan argument can bring it to299, but formatter output must be measured against the300 function threshold. No function allowance is presently justified. `recordEmissionObservation` and the new getter remain small; avoid moving unrelated logic merely to game these counts. These are source-derived budget risks, not executed gate results.

### Boolean proof composition: bounded current result

The held Boolean proof freeze `1d9ab3096dab415e9e02df862bb1f6fdfcdae927e1176598559652c88cdcefe6` was independently checked against actual c3e3 Git blobs. All three complete UTF-8 inverses and forward replays match: H1 `2a6d7d09…`, H2 `73cca8b2…`, current-source test `3f7978a9…`. H2 retains the delivered early-return bridge and external component pin `253eda01462fad0ab84a940965a083eaf80b0ca8a3e10a4ca012fbafaaf30e99`. Its new types inverse authenticates supplied current `types.ts`, reconstructs historical bytes for the historical population, and preserves the current observation; it is not a physical-healthy replacement for supplied mutants.

No new composability blocker was found in that finite static delta. Current C1 test expectation is297 preserved registrations plus14 Boolean additions =311, not325; this is a planned/AST count, not runtime acceptance. Root must bind the final selected H1/H2/types current pins and external scalar last while retaining all current historical recipes and early-return controls. Never copy the old Boolean trio over the delivered695d authority. Mixed consumer access is file-disjoint from those three proof files, but the presentation leaf and final integration ownership remain serialized as stated above.


## Same-plan completed-emission observation: finite dispatch clarification

For issue3525, **IR-only R5: whole-program single- and multi-source Prepared ownership**, this scratch addendum refines the already recorded mixed-interface plan. Source reference: delivered `f7ab45d2fe5bb0d4243c28c02ba98f495804f8cf`. Root must record the grant and claims before implementation. Only the observation seam and its tests are proposed here; no mixed presentation/compiler/finalizer implementation, Boolean refresh, public flip or legacy retirement is released.

### Dependency and exact source package

`src/ir/program-consumer.ts` is byte-identical at f7ab and c3e3. The seam depends on the existing C consumer and physical reservation ledger, not on the unpublished Boolean union/runtime/presentation patch. It is file-disjoint from Boolean's six production and three proof files. Current consumer imports `PhysicalSetupPlan` already; no new import edge, producer/driver return schema or physical planner implementation is needed.

**Source writer owns only `src/ir/program-consumer.ts`.** Retain the exact existing accepted `plan` reference in the private completed `EmissionObservation`, passing it from `materializePhysicalProgram`'s existing successful `recordEmissionObservation` call. Expose only:

```ts
export function emittedPhysicalSetupPlan(emitted: EmittedPreparedIrProgram): PhysicalSetupPlan;
```

Get the private WeakMap record, reject non-consumer/forged objects with the existing `invalid-transaction-capability` invariant, invoke the existing completed reservation/census guard used by `emittedSupportFunctionReceipts`, and return the retained plan. Reuse that guard; do not duplicate or modify `PhysicalModuleReservations`. No reflection-based admission, fallback plan, caller-supplied snapshot, re-planning, exposed token/map, cache or descriptor relaxation. An authentic emission of a different program may return its own authentic plan; do not invent an expected-program parameter merely to reject it. Later presentation code must associate the exact emission/plan pair.

The getter's authentication includes what the existing reservation verifier actually checks: dense array identities/order/populations, owned descriptors/types, completed body/local identity and content, global fill and registered publications. It is not a claim to validate arbitrary mutable metadata or a post-finalizer certificate. Keep `emittedProgramBindingIndex`'s existing weaker observation contract unchanged. No `program.ts`, `program-physical-plan.ts`, driver, preparation or runtime edit belongs to this package.

### Independent test package and exact whitelist update

**Test writer owns only new `tests/issue-3525-emitted-physical-plan-observation.test.ts` and one literal in `tests/issue-3518-program-codec-replay.test.ts`.** At f7ab lines521–529 the codec test explicitly compares the complete sorted consumer export namespace. Add exactly `"emittedPhysicalSetupPlan",` between `"emitAcceptedIrProgram",` and `"emittedProgramBindingIndex",`. Preserve every prior expected name, array order, test registration, assertion, private-transition absence check and exact accepted→emission-started→emitted phase check. Whole-file inverse by removing this one inserted line must recover the authentic predecessor. Do not replace the whitelist with subset matching or filter namespace names.

New tests must create genuine source analysis and `prepareWholeIrProgram` input, then call actual `acceptPreparedIrProgram` and `emitAcceptedIrProgram`. Use a scalar real source on WasmGC/host and Linear/host, not only a synthetic codec fixture. Capture `acceptedPhysicalSetupPlan(accepted)` before emission and assert the getter returns that identical deeply frozen object after emission and on repeated reads. Execute a nonconstant scalar export from the genuine binary as a healthy witness. Observe actual phases with the existing subscription API; getter reads must add no phases, mint no acceptance and allow no second emission. Preserve authentic source/module/input snapshots around read-only getter calls.

Also use the original three-source ORIGINAL_MIXED fixture and its existing digest `236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb` to prove a nonempty genuine WasmGC host async plan is reachable through the new getter. Require strict same-plan identity, actual async frames/entries and supplemental callback exports, real binding-index joins, and frozen nested values. Keep seven source terminal owners, fourteen emitted unit IDs and extra physical callbacks as different populations. The unchanged existing codec suite already exercises mixed binary/Promise phases; run it whole after the single whitelist edit. Do not relabel this seam as productive mixed *presentation* acceptance, since that leaf remains unchanged.

Capability controls: undefined/null/primitives (through explicit test casts), a plain shaped object, a spread-cloned authentic emission, a Proxy wrapping that emission and an accepted token passed as an emission must refuse without trusting their `module` fields. Assert a getter-bomb on a forged object is not invoked. Genuine emitted A and B must each return their own accepted plan; wrong association is detected by strict test identity, not a new generic API parameter. Frozen-plan mutation attempts must throw and leave the authentic plan and binary unchanged.

### Important correction: reservation failure is terminal

`src/wasm/physical/module-reservations.ts:393–395` sets `#state = "failed"` when `#fail` throws. `assertCompletedReservation` at877–885 requires filling/sealed state and invokes `#verifyLayout`; the layout verifier at461–512 detects original body/local identity and deep function content as well as other reserved structures.

Therefore a negative control must NOT expect the same emission to become valid merely after restoring a body. For each independent live-object mutation use: genuine healthy getter → one exact body replacement or nested constant mutation (or function population mutation) → authentic reservation refusal → finally restore the exact original object references/content → **same poisoned emission still refuses** → a fresh genuine prepare/accept/emit transaction succeeds. Preserve the original error channel and exact mutation/restoration evidence. Use separate transactions for independent mutations so a previous poisoned ledger cannot masquerade as coverage of the next mutation. No physical filesystem mutation or private-token access is needed.

A cloned equivalent body is still an invalid replacement because identity is part of the receipt. A same-object nested value edit tests the deep snapshot. Restoration must put back the original body/locals/array references, not deserialize an equivalent clone. The fresh healthy counterwitness establishes working admission after each negative; it does not rehabilitate a failed ledger. This clarification supersedes any earlier shorthand suggesting restored same-token acceptance.

### Exact proof and budget consequences

The existing exhaustive consumer export whitelist above is the concrete required old-test adaptation. The pinned C1 manifest `tests/helpers/ir-c1-authority.json` contains neither `program-consumer` nor `program-codec-replay` as a literal current authority/instrument path. The bounded source reader census identifies truthful compiler-boundaries/layering records and replay/source-measurement helpers, not a direct fixed C1 consumer-body pin requiring a new historical inverse. Do not blindly reseal C1 or any old receipt. Existing measurement helpers must retain historical inputs; any future candidate measurement records its actual new source pins. Final native gates may reveal a concrete dependency consequence, but that is not permission for a preemptive baseline change.

The consumer is 1,489 newline-counted LOC at the exact base. The existing materialize function is298 lines (1192–1489); adding the plan argument alone should leave it under the300 function threshold, but measure final formatted output. A new getter may push the file beyond the1,500 LOC threshold. Root owns a narrowly explained consumer-file allowance in this PR's own issue3525 if the actual formatted count requires it; do not change global thresholds/LOC baseline or borrow the Boolean runtime+33 grant. No function growth grant is presently established.

Acceptance: exact full source/whitelist inverses; new meaningful suite plus entire original codec suite, strict ordinary collections/results/names/error channels and complete declared custody; focused/native typecheck, format/lint and unchanged native dependency/budget gates. Never infer performance equality from one small getter or static call order. No benchmark run is part of this seam. Root integrates and publishes only this bounded change after independent review; mixed presentation remains a later separately released consumer of the API.

### Completed-emission observation — current local evidence (2026-10-05)

The independent implementation adds only retained `physical` evidence to the
existing private successful-emission record and the authenticated
`emittedPhysicalSetupPlan` accessor. It returns the exact already-frozen plan
used by emission and reuses the unchanged function completion/census guard.
No planner, reservation capability, emission algorithm, public compiler route,
codec schema or legacy retirement policy changes.

Source is 68,649 bytes / SHA256
`adaff12179a3882c2590d95a08a7c9cf4484986c76d3cd9c08aec724afc95c38`;
five bounded insertions recover the complete delivered source in reverse.
Measured 1,489 → 1,501 lines (+12) is granted only by this touched issue;
`materializePhysicalProgram` is 299 lines and needs no function allowance.
The codec test changes one sorted export-whitelist literal only, with the
entire old 45,438-byte file recovered by exact inverse. The new test is
15,464 bytes / SHA256
`dac856583f14b3da790e579939fadf84ea50ea144dc3c104257f0479a9fe3188`.

Three concurrent ordinary cohorts on the installed CI-compatible Node 25.9.0
passed **211 distinct cases**: 20 new observation cases, all 27 original codec
cases, and 149 original module-reservation plus 15 completion controls. Each
real collection and ordinary child exited zero; ordered registrations matched,
all 7,653 declared source/test/script/hook input records remained exact across
both children, and raw RPC/unhandled/timeout channels were clear. These are
local Node 25.9.0 / Vitest 3.2.4 observations, not a CI or main-delivery receipt.
The original mixed source digest, three sources, seven terminals, 14 physical
units, async callback alias/target/index/export joins, scalar values on both
host backends, and permanent poisoning after body/census tampering are pinned.
Fresh genuine transactions are the healthy counterwitness; restoration cannot
revive a failed transaction. Mixed Linear retains its genuine located refusal.

Preserve the initial failed arms: 19/20 new tests on Node 24.4.1 found an
incorrect nested callback-row identity expectation. Existing deep-copy freezing
copies nested row occurrences; the single correction selects exactly one row
by binding ID and compares its complete structure, preserving strict root plan
identity and all ownership/index checks. The initial 26/27 codec arm failed on
the original mixed WasmGC opcode with Node 24.4.1's default disabled exnref.
The repository's CI composite selects Node 25; the already installed 25.9.0
has that capability enabled by default. Only local executable selection changed;
no enabling flag, test expectation, workflow, configuration, or gate was relaxed.
Old and new counts are not pooled. Static rejected harness versions and the
actual failed child/output/result/custody records are retained in the handoff.

Astra independently approved the exact source inverse and corrected test
structure; Sol 6.1 Medium implemented the separate source and test packets.
Root integration remains the single publication/queue owner. Normal native
gates, signed hooks, ready PR publication, protected admission and verified main
content remain pending at this local checkpoint. Productive mixed presentation,
full target/language equality, performance parity and legacy retirement stay open.

Native source and preservation gates subsequently completed with actual child
exit zero: TS7, scoped formatting/lint, oracle ratchet, coercion (148 files /
566 sites), LOC/function budgets, dead exports, IR fallbacks, issues and
optimization retirement. The first tsx IR-fallback launch failed before the
predicate on a sandbox IPC socket; an authorized same-command infrastructure
retry passed, with its original failure retained. Preservation witnesses do
not certify closure: graph OPEN, strict closure FAIL and retirement NOT
CERTIFIED remain. Normal signed hook/publication/main delivery evidence follows.


## Delivered early-return predecessor and parallel Boolean continuation — 2026-10-05

PR6488, “fix(ir): admit prepared Linear early returns,” delivered exact45929e486493e6c873adfbffe6e1ab7e35ba5266 through protected merge b6324ee6d148e2e175bc469fdba899830bd32582 (parents00ce95f0+45929). Fresh canonical main c3e3fab33d9ef4747f2a502ab1a8c46d8b224ea1 contains all12 source/proof/issue paths byte-identically; later tree differences are report/mirror/LOC baseline artifacts. Content receipt SHA2566c7d834edeebf9d7c9bd710f61954e5c51f28091dafed1b5528fe4aff9076a36. Exact-head quality111778045511 completed successfully. Protected-group/raw harness qualifications are recorded separately; this finite delivery is not complete IR equality.

Root releases the preserved Boolean71ecd796772814f6bb37c4b5fda214d109852ce3 transport/composition onto delivered c3e3. Six production predecessors equal authentic current main. Keep the delivered early.return owner/bridge, all ten reciprocal recipes, immutable historical authorities, original297 current-source registrations and legacy/public routing. Canonical issue-assignments continuation claims effect-verified source/proof/integration (keys3525:prepared-boolean-main-{source,proof,integration}-20261005; owners ttraenkler/codex-boolean-main-{source,proof,integration}-20261005; branches codex/3525-boolean-main-{source,proof,integration}-20261005). Isolated source/proof lanes run Sol6.1 Medium; root integrates. Preserved old worktrees/claims remain intact without competing dispatch.

Source owns six src paths (adapter-manifest.ts, boundary-policy.ts, compiler/ir-program-presentation.ts, compiler/output.ts, ir/types.ts, runtime.ts) and the unchanged new54-case Boolean presentation suite. Proof owns only ir-c1-historical-authority.ts, ir-c1-current-source.ts and issue-3518-c1-current-source.test.ts. Root alone assembles authority JSON, root anchor and external scalar, issues/logs and publication. Physical-fault bodies require a coherent frozen packet. No performance benchmark, new source family, compiler public flip or legacy retirement release.

Correction: the preserved Boolean suffix adds14 registrations, not28 inferred from an obsolete278 base; old306 was292+14. Delivered297+14=311 is planning arithmetic until actual list/body validation. Preserve earlier mistaken scratch receipts with this explicit correction. Imported plans/evidence below belong to the earlier Boolean epoch; its54/306/44 and legacy388 measurements are not current acceptance. Runtime+33 is the identical finite reviewed patch allowance; existing compiler+121 remains unchanged. Erased-JavaScript and legacy non-Boolean identity/coercion gaps remain open. Final current-epoch tests, normal hooks and protected delivery are required.


### Finite Boolean runtime growth allowance (2026-10-05)

The independently measured Boolean boundary patch changes `src/runtime.ts` from 20,194 to 20,227 newline-counted LOC (+33) against the exact 650 checkpoint. The growth adds the explicit Boolean signature member, own-only metadata lookup, ToBoolean argument adaptation before object unwrapping, omitted required Boolean arguments as false, marked user `__*` export adaptation, and strict canonical 0/1 result decoding. ToBoolean must not invoke user coercion hooks. Existing numeric/void behavior and unmarked internal helper passthrough remain covered separately. This is a finite reviewed per-change issue allowance; the existing compiler +121 allowance remains unchanged, and no global LOC/function threshold or baseline is altered.

The full new Boolean suite has 54 ordinary passing controls under both host backends. Those controls do not establish arbitrary untyped JavaScript identity, complete erased-JS equivalence, complete legacy artifact parity, IR retirement, or a public compiler route switch. The old numeric 44-row checkpoint is separate. Current C1 preservation and final composed publication remain root-owned pending steps.


## Reviewed implementation plan — finite Boolean presentation increment



## Implementation Plan — explicit Boolean export boundary for the private R5 host checkpoint (2026-10-05)

This is a bounded next increment, not a public compiler-route switch or legacy retirement. Implementation requires root's fresh file/claim reconciliation and recorded dispatch. The current 44-case numeric/void/startup checkpoint, its historical failures, and its artifacts remain evidence of that earlier scope. Both WasmGC/host and linear/host are mandatory here; standalone/WASI, mixed async, full primitive coverage and full IR parity remain open.

### Actual problem and reusable producer

The genuine primitive probe (`900c6b2f1a832f131ac5245cd4c6fb3c3c88e9404e3d48a15ab472c2d215f141`) refused `negate(value: boolean): boolean` at presentation declaration capture before invoking A/C. The separate unchanged producer/driver/C probe (`03c062b570a604404fd0efb6b04eb38a7ffe724bfe4427f1479e2e0578d4df28`) actually accepted and emitted the original analyzed Boolean function on BOTH hosts: one source unit, semantic callable parameters/results `{kind:"val",val:{kind:"i32",boolean:true}}`, physical signature with the same brand, and `i32.eqz`. Raw Wasm 0→1 and 1→0 passed; those JavaScript results are numbers, not Boolean helper acceptance. Two independent scalar controls returned 23/35. The latter recorder exited 0, its 1,954-entry custody vector was exact, and all nine evidence-index files were independently rehashed. No Boolean presentation/helper runtime success is claimed yet.

Source facts: `program-source.ts:162–177` produces the Boolean brand; `program/abi-signatures.ts:9–51` includes complete semantic data in ABI keys; `program-consumer.ts:796–831` and `backend/wasmgc/resources/native-vectors.ts:179–183` preserve primitive carriers; `backend/wasm-constants.ts:23` emits Boolean constants as i32 0/1. `boolean-brand.ts` explicitly says absent brand is unknown. A/C/driver changes are not required for this measured fixture and are outside this increment.

The missing consumer contract is real: `ir/types.ts:139` has no Boolean export boundary kind; `runtime.ts:19750–19756` repeats that closed union; `wrapExports` passes primitives through. Removing the presentation refusal alone would expose numeric 0/1 and raw Wasm argument coercions. `compiler/output.ts:447–507` is a reference-nullability widening pass only: it does NOT widen i32 to f64. Do not change its flags, replace physical signatures or manufacture externref boxes/imports to bypass the missing adapter.

### Exact implementation and file-disjoint ownership

1. **Presentation writer (Sol 6.1 Medium): only `src/compiler/ir-program-presentation.ts`.** Extend the existing capture/ABI/export join and produce the finite metadata below. Current authoritative leaf is 27,514 bytes / `9587f036bcef0f09f175b8a1b8d3aa1ebd82272849caa71988209f3373fdd135`.
2. **Root-owned shared boundary dependency: only `src/ir/types.ts`, `src/boundary-policy.ts`, `src/runtime.ts`, `src/adapter-manifest.ts`.** These are necessary consumer/schema changes, not permissions implied by the existing leaf claim. Root obtains exact narrow claims/current PR overlap evidence before writes and may route this disjoint package to another native writer. No changes to legacy codegen metadata producers, compiler finalizer, C, A, runtime providers, physical-reservation machinery or generated-helper template are authorized.
3. **Independent semantic test writer (Sol 6.1 Medium): only NEW `tests/issue-3525-prepared-pipeline-boolean-presentation.test.ts`.** Consume the frozen producer/leaf/shared-consumer contract; do not edit the existing 44-case suite, existing legacy tests, test gates or source. Root integrates the packages and owns issue updates/publication. No code is dispatched by this spec.

The prior plan's leaf/test-only split is insufficient by itself: the four shared files are the precise next consumer dependency. If their claims cannot be reconciled, preserve the actual gap and hold the Boolean increment; do not substitute numeric results, test wrappers or a linear-only success.

### Presentation producer obligations

- In `capturePresentation` (~253–303), add exact `BooleanLike` classification for function parameter/result slots, retaining number and void rules. Keep the analyzed source/file/checker/declaration-interval joins and complete terminal census. Boolean globals are not admitted by this function-export increment: the existing numeric global rule and all startup/resource guards remain. Object `Boolean`, any/unknown, mixed number/Boolean, nullable/optional/rest carriers lacking the exact supported contract remain typed refusals at their actual first guard. No source-name or fixture whitelist.
- In `checkAbiExports` (~355–486), compare **every source callable slot**, not only arity: a captured Boolean requires an authentic `val` i32 with `boolean:true`, no structural type reference and no conflicting symbol/int32 brand. The source number/void mappings retain their existing accepted domain and must not be reclassified Boolean because they share i32 storage. The physical export must retain the exact bound index, full arity, carrier kind and Boolean brand. An unbranded i32 is not a Boolean witness; f64/externref/reference/Promise carriers cannot be accepted by coercion.
- Build a local null-prototype map from actual export ABI joins, keyed by the real external name. Add a row ONLY when at least one slot is Boolean. Its complete positional params/result use `"boolean"` for proved Boolean slots and existing `"other"` for number/void slots. Do not add all-other rows for pure numeric exports. Aliases may each get a row only through their authentic target/declaration join; retain reverse physical-export census, uniqueness, global and constructed-startup distinctions.
- `checkResourceDemand` must still reject any pre-existing `mod.exportSignatures` from the emitted packet. A caller/observer-provided map is not producer authority. Assemble the new map privately, run all source, ABI, physical, runtime-demand, startup and export-census checks, and install the deeply frozen map on `emission.module.exportSignatures` ONLY after every check succeeds. Leave that property absent for pure numeric/void programs. Do not mutate the physical module to create wrappers or new functions/types/imports. The metadata field is outside `PhysicalModuleStorage`/its reservation population vector (`wasm/physical/module-reservations.ts:25–42,142–159`); this is not permission to alter any authenticated physical field. Prove all physical receipt checks still succeed after metadata attachment.
- The unchanged finalizer already forwards `mod.exportSignatures` consistently into boundary policies, adapter manifest, original helper and CompileResult (`compiler.ts:1377–1433`). Reuse that path, with the original helper text generated normally. Do not return a second independently fabricated metadata bag or postprocess helper source. Keep source/options snapshotting, primitive-before-driver refusals, one real driver transaction, real C failure channels and current output-option restrictions.

### Shared runtime boundary semantics

Add `"boolean"` to `ExportBoundaryKind` and `WrapExportsSignature`; classify it as `primitive-value` in BOTH the policy builder and validator. The manifest remains the existing v1 data structure with the new explicit slot kind, passed through its ordinary validation. No decoder fallback for an older runtime that lacks this kind; new artifacts require the matching runtime package. Existing metadata/artifacts without Boolean rows must remain identical.

Use a narrow, explicit typed boundary: Boolean slots accept primitive `true`/`false` only. Before calling Wasm, reject every non-Boolean value with TypeError identifying export/argument position; encode false→0 and true→1. Do not call Boolean(value), Number(value), valueOf, Symbol.toPrimitive, or use Wasm truncation as admission. This is a checked declared-Boolean boundary, not a claim of arbitrary untyped JavaScript-call parity. Wider JavaScript coercion semantics are not silently inferred from TypeScript annotations and remain outside this checkpoint. Missing arguments in required Boolean slots must fail as undefined; argument-vector validation must iterate declared Boolean positions, not merely supplied args.

For a Boolean result, require the actual wire result to be exactly numeric 0 or 1 (reject -0 as a noncanonical forged wire witness); decode to primitive false/true before the existing primitive passthrough. Do not use generic truthiness to conceal malformed 2/-1/NaN/undefined/reference results. All unmarked numeric/void results and other existing boundary kinds retain their current behavior. Boolean conversion applies regardless of object `marshal` preference; `marshal:false` remains an object-handle policy, not a bypass for primitive contract checking.

Two concrete name-safety details are necessary, not a generic framework:
- `wrapExports` currently skips every `__*` function before looking at its signature (~19960). Read an OWN signature row first. A specifically marked Boolean user export must receive its Boolean adapter even when named `__negate` or `__module_init`; genuine unmarked internal helpers and the constructed startup adapter retain their old exact passthrough. Never infer Boolean status from the name.
- `adapter-manifest.ts:frozenClone` (~88–97) currently copies with `clone[key] = ...`, which loses an own `__proto__` signature key to the prototype setter. Preserve own data properties using an explicit data-property definition (same ordinary object prototype and enumerable JSON shape for old inputs), then freeze as before. No inherited-key lookup or user-name whitelist. Verify exact own `__proto__`/`constructor` metadata survives clone, serialization and original-helper consumption without prototype changes. If the producer cannot prepare a particular source spelling, report that real producer refusal separately; the manifest clone unit witness still must prove the key-preservation contract.

### Required meaningful acceptance (counts measured after collection)

- BOTH hosts: real analyzed `negate(flag:boolean):boolean`, identity, Boolean constants, numeric comparison returning Boolean, and mixed number/Boolean slots. Original generated helper must be imported and executed against its own emitted binary, with strict `typeof result === "boolean"` and true/false truth tables. Also execute raw Wasm 0/1 controls and assert the actual branded i32 ABI/type vectors. Preserve original helper; only the established package-resolution adaptation for isolated tests is allowed.
- Numeric/void positive controls retain exact results/types and absent all-other signature metadata. Existing 44-case suite remains unchanged and reruns ordinarily. Existing same-name/startup tests retain semantics; new `__negate` and user `__module_init` controls distinguish ordinary exports from actual constructed adapter identity.
- Negative argument table: numeric 0/1/2/-1/NaN, strings, null/undefined/missing, bigint, Symbol, boxed Boolean and object with throwing/counting coercion hooks. Require TypeError before actual function invocation and zero coercion-hook calls. Use a genuine numeric side-effect/count witness or narrowly original-call spy to prove no invocation; do not substitute a passing fake Boolean implementation for whole-pipeline positives.
- Unsupported source/ABI/physical controls: non-Boolean carrier, missing/conflicting Boolean brand, incorrect arity, wrong external name/index, nonnumeric source and injected pre-existing metadata. Each must pair with a healthy real producer path. Authentic earlier C invariant failures stay their actual channel; do not count them as reaching a later leaf-specific guard. Invalid wire-result unit controls cover 2/-1/-0/NaN/undefined/reference without converting them to false/true.
- Independently compare the complete accepted physical module before/after presentation and after finalization (types/functions/bodies/imports/globals/exports/start/data/all index spaces). Exclude ONLY the explicitly expected exportSignatures presentation field when comparing whole-module objects; do not normalize physical fields. Actual emitted binary bytes and genuine support/reservation receipts remain unchanged by metadata attachment/finalization. Do this separately for each backend; do not claim identical prepared-object identity across two driver calls.
- Check consistency of returned signatures, policies, frozen manifest and the literal serialized into the original helper. Tampered/missing Boolean policy and mismatched signature positions refuse; no broad policy-validation relaxation. Prove old non-Boolean manifest JSON and primitive/object wrapper controls unchanged, including `tests/issue-1700.test.ts` and `tests/cli-imports-helper-export-metadata.test.ts` as relevant fixed regressions.
- Run focused new suite, unchanged 44 suite, native type/lint/format, relevant existing runtime/manifest regressions, normal repository gates/hooks and required CI with exact counts/errors/custody. Static claims are not runtime acceptance. No time/heap/concurrency/cap, baseline, source-receipt or historical proof relaxation. If a required shared file is an actual fixed proof input, root must derive its finite preservation consequence from the real dependency before integration; this plan gives no blanket reseal permission.

This productive extension closes only the observed synchronous Boolean function boundary on both host backends. It neither cures retained D's async provider gap nor changes the six-target probe's non-host option refusals. Public routing, all source families/profiles and legacy retirement remain explicitly open.


### Governing correction — Boolean argument semantics and actual helper serialization (2026-10-05)

This correction supersedes the strict primitive-only argument paragraph and its TypeError table in the preceding Boolean plan (`b9ff8003fccca81ba61de25d494bf6998b3393bfbcab48852261c9c431a5abbc`). That proposed stricter input contract had no basis in the existing helper and MUST NOT be implemented. The earlier plan remains historical; its physical provenance, both-host requirement, no public cutover, exact Boolean-brand checks, genuine-helper tests and source-owner limits remain except for the precise additional output-template dependency below. No implementation has been performed by this architect.

**What the existing source actually guarantees.** `runtime.ts:19976–20007` forwards primitive arguments unchanged except for specifically tagged existing boundary kinds; `runtime.ts:20027` returns primitive results unchanged. There is no Boolean input TypeError rule. Raw i32 calls therefore use the engine's numeric conversion, not a host Boolean adapter. `docs/playground-ast-explorer.md:82–90` explicitly records booleans marshalled as numeric 0/1 as an existing discrepancy. The release-note statement about rendering true/false concerns console.log, not exported-call marshalling. `tests/issue-1700.test.ts` establishes explicit per-kind marshalling, including under marshal:false, but establishes no strict Boolean-only input policy. Existing native Boolean box/unbox contracts concern other carrier/provider operations and cannot authorize changing this exported-call contract. No new runtime comparison of legacy Boolean helpers was executed in this read-only correction; the source observations and existing raw-wire probe are distinguished from that missing measurement.

**New marked-slot behavior, without stricter caller admission.** The new explicit `"boolean"` metadata is a Boolean *materialization* boundary. Encode its parameter with JavaScript ToBoolean, using the language conditional `arg ? 1 : 0`, not a replaceable global Boolean()/Number() call and not engine ToInt32. Do not reject values merely because typeof is not boolean. Missing/undefined/null/false/+0/-0/NaN/empty string/0n encode zero; true, nonzero numbers (including Infinity), nonempty strings, nonzero bigint, Symbol and objects encode one. Objects—including boxed false and objects with throwing valueOf/toString/Symbol.toPrimitive—are truthy without calling those hooks. Iterate declared marked positions so omitted arguments are encoded as false; preserve original ordering, unmarked values and extra arguments. Leave every existing unmarked legacy signature/slot unchanged. The existing strict canonical i32 result check (only +0/1, then false/true) remains a producer-wire integrity guard, not a new caller restriction.

This is a deliberate source-Boolean boundary extension, not a false statement that the old raw Wasm helper already performed ToBoolean. For a logical source function such as negate, tests compare to the actual JavaScript source operation on the complete input table. Numeric coercion counterexamples include the truthy string `"not-a-number"`, 2**32 and a truthy object whose numeric conversion throws: ToBoolean must not inherit the old raw i32 behavior. Measure and preserve the actual old-helper outputs/errors for these counterexamples separately; do not force a legacy mismatch into an equality assertion or discard it as noise. Valid primitive true/false inputs must retain source behavior, with JS Boolean outputs replacing the explicitly known numeric representation discrepancy.

A static Boolean annotation is not a theorem about arbitrary untyped JavaScript calls. In particular `(flag:boolean)=>flag` called from JavaScript with an object would return that object in erased JavaScript, whereas a concrete i32 Boolean materialization cannot preserve arbitrary identity. Likewise a default parameter can distinguish omitted/undefined from false before a Boolean operation. The increment MUST NOT claim full erased-JavaScript parity for such untyped/default/optional cases or reinterpret this missing producer capability as retirement permission. Preserve the broader requirement and report a concrete gap if admission reaches those source forms; do not add a public mode or broaden A/C ownership here. Exact primitive Boolean identity positives remain required. Source optional/default/rest or union contracts are supported only when the existing genuine preparation/capture proves their semantics; merely converting missing input to false does not authorize admitting default-initializer behavior. Do not fabricate a fake bool return wrapper or flatten arbitrary values inside Wasm.

**`__proto__` must survive both stages.** SolB's independent read agrees that there are two separate losses: `adapter-manifest.ts:frozenClone` assigns own keys onto `{}` (prototype setter), and `compiler/output.ts:207–222` inserts JSON text as a JavaScript object literal (`const adapterManifest = ${manifestJson};`). Repairing the first does not repair the second. Add `src/compiler/output.ts::generateImportsHelper` to the root-owned boundary package. For manifests with an OWN `__proto__` key in the finite exportSignatures or exportBoundaries dictionaries, serialize the whole manifest as `JSON.parse(<JSON-string-literal of manifestJson>)`; generate that argument with JSON.stringify(manifestJson), never manual escaping/eval or token replacement. JSON.parse creates the key as an own property rather than an object-literal prototype setter. For ordinary manifests without these dictionary keys, retain the current helper source bytes. Tests must execute the ORIGINAL generated special-name helper, not patch it after generation or count a JSON-only clone test as executable evidence.

Retain explicit own-data-property copying in frozenClone with its existing ordinary prototype, and own signature lookup in wrapExports. `validateExportBoundaryPolicies` must also resolve an OWN policy for an own signature key, so `constructor` or `__proto__` cannot be satisfied by an inherited property. A specifically marked Boolean user function beginning `__` is adapted; unmarked genuine internal functions and the authentic startup adapter remain passthrough. Preserve both data identity and prototypes of every relevant record; no global prototype writes, name whitelist, output normalization, or broad serializer framework. The new tests include own __proto__, constructor and ordinary __negate metadata; actual source preparation refusals, if any, remain separately reported rather than bypassed by synthetic source ownership.

**Final exact production partition.** Presentation Sol owns only `src/compiler/ir-program-presentation.ts`; independent test Sol owns only NEW `tests/issue-3525-prepared-pipeline-boolean-presentation.test.ts`. Root, after exact fresh claims/overlap reconciliation, owns or separately delegates the five-file shared boundary package: `src/ir/types.ts`, `src/boundary-policy.ts`, `src/runtime.ts`, `src/adapter-manifest.ts`, and only `generateImportsHelper` in `src/compiler/output.ts`. `compiler.ts`, A preparation, C consumer, IR driver, native providers, physical reservations, legacy metadata producers and all old tests remain consume-only. Root can run those three responsibilities in parallel once this contract is recorded and the producer/schema interfaces are agreed. No compiler algorithm or reference-nullability pass change is required. Suggested distinct claim scopes are prepared-boolean-presentation, prepared-boolean-boundary-consumers and prepared-boolean-presentation-tests under the existing 3525 parent; root chooses/claims the canonical keys, not this reviewer.

**Corrected tests and completion condition.** Replace the old non-Boolean-argument TypeError table with the ToBoolean table above on both original generated helpers and both host backends. Assert exact true/false results, typeof boolean and zero coercion-hook calls. Missing arguments are positive false-input cases for required simple parameters, not expected errors. Add valid primitive Boolean identity, Boolean result from numeric comparison, mixed numeric/Boolean positions and numeric/void unchanged controls. Retain negative source/ABI/brand/physical/malformed-result controls and exact full binary/physical-receipt parity before/after metadata attachment. Inherit all actual old C refusal channels and distinguish their guard reach. Verify special-name manifest own keys through clone, serialization, executed helper, and policy validation; tampered/inherited-only policy must refuse. The unchanged 44 suite and relevant runtime/manifest regressions remain mandatory, with measured new counts and actual normal gates/hooks. Keep legacy raw-helper differences, wider untyped-JS limitations, mixed async/non-host gaps and performance obligations explicit. No source capability is declared complete from two healthy Boolean values.

Finalizer correction is settled by actual source: `compiler/output.ts:widenNonDefaultableTypes` changes only `ref` to `ref_null`; it neither widens numeric exports nor converts Boolean i32 to f64. This increment must preserve the original branded i32 parameter/result and raw Wasm binary; there is no permitted widening override.


**Actual legacy comparison now available; no full-equality shortcut.** The completed independent legacy matrix (`abb132e71a212a0deba80646ad9e9f2c19d7b3c068db2a54c5105e8d0bd63e6b`) contains ten compiled fixture/backend pairs, ten successful native helper children and 388 invocation observations, including 20 intentionally caught throwing-coercion observations. This reviewer independently rehashed all 79 indexed artifacts, checked the seven-entry custody equality, and compared every bare/helper row after removing ONLY its arm label: all ten pairs agree. WasmGC Boolean echo exposes i32 numeric conversion (undefined/NaN→0, 2→2); legacy linear echo exposes f64 (undefined/NaN→NaN, 2→2). valueOf and Symbol.toPrimitive:number hooks really execute; throwing hooks retain their real error. Original user __boolean and own __proto__ exports are genuinely callable. None of these legacy artifacts supplied Boolean exportSignatures. The observed legacy linear f64 carrier is NOT permission to change the genuine prepared producer's independently measured branded i32 carrier or override a widening flag.

Record three separate oracles in the implementation handback: (1) original legacy helper behavior above, (2) actual erased JavaScript source behavior, and (3) the new explicitly marked Boolean ABI materialization. For truth-valued operations such as negate/comparison, the new ToBoolean boundary must match the JavaScript operation on the complete truthiness table without user coercion hooks. For identity, only the true/false domain is an equality positive: untyped `echo(2)` or `echo(object)` returns its original argument in erased JavaScript and cannot be called equal to a Boolean wire result. Preserve such mismatches as full-goal gaps, not passed rows, normalized output, newly forbidden caller input, or retirement permission. This finite internal extension and the public legacy route remain distinct; no full acceptance requirement is narrowed.




## Implementation Plan — Boolean boundary current C1 type epoch (2026-10-05)

This is the finite preservation companion to the marked-Boolean boundary plan, not permission to change historical authority or broaden the public compiler route. Root owns claim reconciliation/integration. No implementation, collection, runtime, or resolver experiment was performed by this specification. The existing numeric checkpoint remains unchanged.

### Actual dependency and existing mechanism

Read-only source checkpoint: `src/ir/types.ts` is 7744 bytes, SHA256 `d82e92ee276dd9a57bd69d9dee16410d24225a028bd9dca53bc406f69b9623ac`, Git blob `f7717d7c70bb57bd73d799a1d26d1825aa0a41e8`. It is BOTH an immutable dependency in `ir-runtime-program-relocation.json` and a current type-closure input. Therefore merely updating a closure pin is insufficient: H2's earlier dependency loop would still reject the new source.

H1 (`tests/helpers/ir-c1-historical-authority.ts`, predecessorClosureInputs around416–514, current override map515–539) already separates immutable predecessor pins from exact current closure pins. H2 (`tests/helpers/ir-c1-current-source.ts`, canonicalInputEpochs around74–335 and beforeCanonicalCurrentInput336–378) already proves complete UTF8 inverse and forward replay for fixed current instructions/package/lock changes. This existing mechanism supports the narrow new union edit; it does NOT automatically authorize arbitrary semantic successors. This recorded plan authorizes exactly the new ExportBoundaryKind member, with final formatted bytes frozen by root before constants are supplied. No generic epoch registry, fallback, extra reader module, new policy receipt, or stored complete algorithm copy is needed.

The current manifest is 349785 bytes/SHA256 `464789d00ab368042da0ed874b9e44d5311ef5dc054002d1ec02ac888397abcb`; H1 42899/`5b88203cd0c080798d112f7e260ef11ad739d65a6098b6ef5a72689eeb4d0758`, H2 39037/`87bc9a28c4aa6c6510da2aab5bb55b81b7119654982639e594feae4ed0dc2f07`. Authenticate the actual integration predecessor again before assembly; these are observed source-checkpoint inputs, not a claim that a future canonical head has already been delivered.

### Exact writer partition and H2 data flow

Production schema writer owns only the already approved `src/ir/types.ts` union change within its shared-boundary partition. Root separately claims the preservation slice under existing3525: H1, H2, `tests/issue-3518-c1-current-source.test.ts`, manifest `tests/helpers/ir-c1-authority.json`, anchor `tests/helpers/ir-c1-authority-root.ts`. No other caller, immutable JSON, policy helper, policy receipt, policy inventory, or historical fixture is an authorized edit here. A separate preservation writer may own H1/H2 and current-source test; root alone owns manifest/anchor and last external scalar. Do not overlap the Boolean runtime/leaf/test writers.

1. Freeze the final formatted union source. Its entire inverse must recover the authentic 7744-byte file and forward replay must recover every candidate byte. Encode only the exact reviewed union declaration fragment, UTF8 byte offsets and full before/current size/SHA256/Gitblob. A formatted multiline union may require a larger declaration span; imports, other declarations and algorithm bodies remain exact. Do not derive expected pins from a caller or pick an epoch from the incoming digest.
2. H1 retains the entire predecessorClosureInputs literal, all old pins and prior overrides unchanged. Add exactly one current override for `src/ir/types.ts` in the existing fixed current map. Do not edit historical/currentBase semantics, predecessor topology or historical receipts.
3. H2 appends one fixed types.ts record to canonicalInputEpochs. Existing epoch records and inverse/replay algorithm stay byte-exact. In captureC1CurrentPopulation's receipt.current/dependencies loop (around767), add one named types.ts branch: pass the actual already-read population operand through beforeCanonicalCurrentInput, then pass the proved predecessor to the unchanged assertRuntimeProgramRelocationSource against the immutable record. Retain that proved predecessor in a per-call local only. Reject stale predecessor, nonprimitive or any other current bytes; never replace a supplied mutant with a healthy filesystem copy.
4. Keep `current` unchanged. Its genuine new types.ts text is reused in `closure`, pinned against H1's new current pin, parsed for actual imports and supplied to the existing real TypeScript resolver. Do not replace it with the predecessor or a synthetic type declaration. `observedCurrentPins` must show the new source. Only AFTER live contract/resolver success, set the named types.ts entry in the detached historicalPopulation to the proved old text before unchanged reconstructRuntimeProgramRelocationPopulation. A missing per-call predecessor fails closed. All other entries and substitution branches remain exact.
5. No new physical read is needed: this source is already in the freshly read population and reused by closure. Preserve all actual channel counts/order:47 population calls, nine extra closure/config paths, existing63 authority-call vector,12 closure records,13 native resolver requests and57 observations. The saved manifest has types.ts only as a fileExists observation at zero-based23, with no types.ts readFile pin. Therefore NO resolver observation pin edit is expected. Measure the real complete transcript after integration; any different operation/location/target or count is a new discrepancy to explain, not a permit to update expected data until green.

### Root assembly and immutable boundaries

The manifest structural allowlist is TWO currentInstruments pin objects (H1/H2) and ONE linearOptions.closureInputs types.ts pin. All12 ordered instrument paths remain; the other10 pins stay exact. NONE of the ten instrumentEdits changes: those recipes cover instruments at index2 onward, not H1/H2. Preserve all ten full recipe objects, original beforePins,92 spans, all11 immutable authorities, seven artifacts, population,13 request objects,57 observation objects, configs/options, bases and1633-byte LinearOptions declaration. Independently verify every old recipe still inverses/replays against captured unchanged current files, rather than accepting the assembler's own report.

Root binds the new manifest digest in the existing anchor and ONLY the unique independentFreeze initializer in current-source test after its reviewed test edits. Preserve outside bytes through complete scalar inverse and verify the decoded independent object covers actual pins. Use real-path formatter stdin/checks; ignored .tmp checks are not evidence. No authority hash cycle or historical repin. The source schema edit changes no module path, layer, allowed edge, dependency route or policy row: `scripts/compiler-boundaries.json` (observed583986/0cbff259...) and the existing lowering-analysis policy inverse/history stay exact. Do not add a policy successor merely because C1 reads policy helpers.

### Independent controls and acceptance

Preserve all existing292 current-source registrations/order/assertions, with ONE necessary named branch added to the existing historicalPopulation equality test (around567): independent fixed old types.ts fullpin and independently pinned new observed source. Keep the direct historical guard unchanged: current Boolean source passed directly to the old relocation assertion must still refuse, while the proved historical population reconstructs original donors exactly. Do not change the generic changed-live-dependency tests to skip types.ts.

Append a separate finite describe block (do not enlarge old it.each arrays/names) with independently literal union span and fullpins: healthy current inverse/replay; stale old source refusal; missing/duplicate Boolean member; same-size content and shifted-fragment mutations; mutation outside the union; population nonprimitive object with zero coercion; supplied population mutant with healthy authority; actual fresh source corruption and missing-file refusal with exact restoration followed by healthy acceptance. Use the existing established physical restoration harness and paired healthy/missing witnesses. Add an actual resolver-source witness that observes/parses the new Boolean union while retaining the real resolver operation order/target proof, not a fake source host returning historical types. Warm second-call mutation must refuse; per-call fresh reads remain mandatory. Existing helper/anchor mutation controls continue to authenticate changed executable H1/H2 bytes.

Collect the complete final current-source suite and exact old292 ordered subset before execution; report the actual added count. Run it ordinary/unfiltered with stdout,stderr,results,collection and full restoration custody. Also run unchanged `issue-3518-runtime-program-relocation.test.ts` and `issue-3518-historical-runtime-reconstruction.test.ts` for old operand reconstruction, and unchanged `issue-3518-program-validator-relocation.test.ts` for neighboring substitutions. Exercise existing H1 authority consumers (`issue-3518-runtime-program-policy-evolution.test.ts`, `issue-3518-well-known-symbol-policy-evolution.test.ts`, `issue-3518-number-prerequisite-policy-evolution.test.ts`) through their ordinary complete suites/normal required gates; do not replace acceptance by focused diagnostic cases. Reuse a completed exact-final-epoch required hook run where it supplies the same test population, clearly distinguish its runner/error semantics from separate ordinary evidence. No guessed total, old-epoch credit, weakened timeout or ignored RPC/unhandled channel. New Boolean generated-helper runtime acceptance is separate from source-preservation acceptance and cannot substitute for it.

This finite companion permits measured current semantic evolution while the historical contract remains demonstrably unchanged. It does not certify all-profile/mixed-program equality, legacy retirement, or module-analysis performance.


## Finite Boolean implementation evidence — 2026-10-05

The six production files implement the reviewed explicit Boolean boundary. The independent new ordinary suite passed 54/54 with both real host backends and original generated helpers. Metadata joins authentic source/logical ABI/physical branded-i32 slots; ToBoolean does not invoke coercion hooks, canonical result decoding is strict, own special export names are retained, and unmarked numeric/void behavior remains. This is distinct from the earlier 44-test numeric checkpoint and does not retroactively expand its scope.

The C1 current-type extension preserves all 292 existing registrations and adds 14, with real supplied-current source, historical inverse and resolver proofs. All four ordinary validation suites passed: current-source 306/306; unchanged runtime-program relocation 298/298; historical reconstruction 631/631; validator relocation 62/62. All four child exits were 0 with no ordinary RPC/unhandled/timeout errors; complete ordered registrations and 2,462 custody entries were exact, and all five modified C1 files were restored. Historical execution took 807.790 seconds and included a one-second read-only stack sample; this is correctness evidence, not a performance claim. Runtime review SHA-256: 7544084e29659341209606c710fff1362e25712dcda72d89b6abed02f4c9a9ff.

Actual integration starts at signed numeric/main composition 5a633bf93ec0e7b9d2992334d00f1279c7bd2c25. All seven portable production/test paths and five restored C1 paths retain independently reviewed bytes. Numeric compiler and numeric test remain exact. Native full typecheck, uncapped lint (6,822 files), seven-file source/test formatting and subsequent five-file C1 formatting passed. Final composed preservation gates, normal signed hooks, exact published head and protected delivery remain required.

Legacy public routing and existing failures stay intact. Earlier ten legacy fixture/backend pairs and 388 invocations expose numeric carrier/coercion and untyped identity differences. The new finite boundary does not establish arbitrary erased-JavaScript identity, all legacy artifact equality, mixed async/non-host coverage, complete IR migration or retirement. Optional/default/rest/Boolean globals and unsupported carrier/resource paths remain located gaps. The +33 runtime allowance is reviewed for the exact current change, not an enforced numeric cap or permission for unrelated future growth; global thresholds/baselines and historical assertions remain unchanged.



## Mixed WasmGC presentation: authenticated completed-plan observation (2026-10-05)

This is an implementation-plan addendum to **IR-only R5: whole-program single- and multi-source Prepared ownership**. It refines the existing mixed WasmGC presentation plan; it does not release C implementation, change public routing, retire legacy, or certify full equality. The root integrator must explicitly grant the finite consumer edit before its writer starts. The delivered comparison base is `c3e3fab33d9ef4747f2a502ab1a8c46d8b224ea1`; the prepared-checkpoint repair is present through merge `b6324ee6d148e2e175bc469fdba899830bd32582`. Source pins and Boolean composition checks accompany this appendix in `source-and-composition-review.json`.

### Concrete interface constraint — source-derived, not a new measured failure

At this base, `src/ir/program-consumer.ts:190–198` retains completed reservations, function/support receipts, startup index and final ABI indices. It does not retain the physical setup plan. The authentic accepted token can reveal that plan through `acceptedPhysicalSetupPlan` (420–425), but `src/compiler/ir-program-driver.ts` deliberately returns the real prepared program and emission, not that token. The presentation leaf therefore cannot authenticate the consumer-created async callback export population from its present result alone.

This is a source-derived observation gap, not evidence that the current WasmGC consumer fails mixed async acceptance. No new callback runtime observation receipt was executed. The unchanged ORIGINAL_MIXED fixture already contains a static WasmGC host acceptance/emission witness; its original three-source digest is `236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb`. Its historical presentation refusal occurred before the driver. The separate Linear `promise.capability.create` adapter gap remains separate.

`program/async-frame-setup.ts` joins authentic primary and supplemental ABI entries. `prepared-async-frame-plan.ts:580–609` constructs callback aliases with owner/unit identity and target binding; `program-physical-plan.ts:1005–1018` adds their actual exports. Generated `__cb_*` names are labels, not proof of ownership. The existing source-export-only reverse census must not be replaced with a name-prefix exemption, an arbitrary caller snapshot, a second preparation, or a second physical-plan computation.

### Smallest authorized C seam

Proposed exact API:

```ts
export function emittedPhysicalSetupPlan(emitted: EmittedPreparedIrProgram): PhysicalSetupPlan;
```

A separately granted consumer writer owns only `src/ir/program-consumer.ts`:

1. Add one readonly `physical: PhysicalSetupPlan` field to the private `EmissionObservation` (190). The type is already imported.
2. Pass the existing `plan` reference into `recordEmissionObservation` (761) from the completed `materializePhysicalProgram` call (1480), and retain that reference in the frozen observation. It must be precisely the deep-frozen object acceptance derived and emission used, not a clone or reconstructed approximation. Record it only at the existing successful completion point.
3. Add the getter beside existing emission accessors. It must reject a forged or unrelated emission using the existing private WeakMap and `invalid-transaction-capability` invariant. Reuse the existing completed-function reservation/census authentication of `emittedSupportFunctionReceipts`; do not duplicate or relax that implementation. Return the retained plan reference after those checks. It is acceptable for the leaf to use this getter instead of an otherwise redundant separate support-authentication call, while retaining all required support ownership checks.
4. Preserve existing getter identities/semantics, accepted-token one-shot behavior, ABI finalization, source-free emission, and reservation lifetimes. No `PreparedIrProgram`/driver-result schema change, callback registry, public injection seam, pass manager, runtime cache or capability exposure is needed.

The getter authenticates provenance and the existing completed-function reservation state. It must not claim to certify every later mutable module field. The plan is immutable; the module remains subject to explicit physical import/export/type/global/startup and finalizer checks. Do not expose `PhysicalModuleReservations`, reservation tokens, resolver maps or the private observation record. Do not return an optional empty plan on failure.

### Presentation joins that consume the seam

The leaf owner changes only `src/compiler/ir-program-presentation.ts`, after the getter contract is frozen. Keep one genuine driver transaction per artifact. Associate the returned plan with that exact emitted result; no caller-supplied accepted result or boolean “complete” flag.

- Capture genuine ambient `Promise<T>` source results with the existing producer's ambient-symbol/type-argument rules (`program-source.ts:254–265`), not spelling alone. Authenticate all original source/unit/binding associations and the actual selected WasmGC host projection. Keep the exact ORIGINAL_MIXED source and seven original terminal owners; distinguish its fourteen emitted unit IDs from additional physical continuation functions.
- Use the same-plan `asyncFrames.frames`, supplemental `entries`, physical `exports`, `functions` and startup records to authenticate every extra callback export. Join alias binding → target binding → actual emitted final index. Use `emittedProgramBindingIndex` only as the saved final-index observation it actually is; it does not authenticate later module mutation. Every physical export must be consumed once by a source, authenticated callback, or genuine startup-adapter join. Reject missing, extra, duplicated, wrong-space, wrong-target or wrong-signature exports. User exports beginning `__cb_`/`__module_init` must remain distinct from constructed bindings.
- Keep absolute function indices in ABI/exports. When looking up a defined body in `module.functions`, subtract the authenticated function-import count and check bounds. Imported function indices must instead resolve to the corresponding authenticated import descriptor. Do not apply a zero-import shortcut or subtract all imports indiscriminately. Join actual provider/import descriptors and types to this plan; an unexpected provider family remains a typed unsupported result, not an ignored descriptor.
- Admit the genuine host async ABI contract and physical externref Promise carrier. Do not synthesize `mod.asyncFunctions`, invent Promise imports or wrap an already genuine Promise with a newly constructed one merely to make assertions pass. The current C plan uses host Promise scheduling; existing generated helper/runtime behavior must be inspected and executed as-is.
- Root owns the existing `compiler.ts` private finalizer seam. Preserve startup selection by constructed adapter identity, exact once-only execution and the existing helper/manual versus wasm-start semantics. Before the finalizer, capture the genuine module layout needed for independent comparison. After finalization, prove the complete permitted ref→ref_null transformation, including nested type/block/global/import positions; retain all unrelated bytes/structure. `widenNonDefaultableTypes` is reference-nullability widening, not numeric widening. Do not label the pre-finalization reservation receipt as a post-widening certificate or replan around a changed module.
- Source maps, C ABI and optimization requests retain their current refusal contract unless separately implemented and tested. Linear async, non-host targets and other output families are not silently accepted by this seam. A genuine missing required producer field must be named before expanding scope; do not substitute empty metadata bags.

### File-disjoint packages and ownership

- **Consumer seam writer (new explicit root grant):** only `src/ir/program-consumer.ts`, the four bounded edits above. No source-preparation/provider/backend planner changes. Freeze the patch, full before/current pins and inverse before leaf integration.
- **Presentation writer:** only `src/compiler/ir-program-presentation.ts`; authentic async/source/plan/physical joins and productive internal output transaction. This file overlaps the active Boolean source continuation: root must first choose and authenticate the composed Boolean predecessor, then transfer exclusive ownership. Do not overwrite the Boolean marked-slot contract or use its old leaf as a current base.
- **Independent semantic test writer:** only new `tests/issue-3525-prepared-pipeline-mixed-wasmgc.test.ts`. Use real producers/consumer/output/helper behavior. Root separately owns any necessary `compiler.ts` finalizer changes, issue frontmatter, authority composition and final assembly. No two writers share those files.

These are dispatch boundaries, not new claims or implementation release. Root may prepare tests against the agreed API while the consumer writer works, but bodies require the coherent frozen production packet. Implementation remains conditional on explicit ownership release and current predecessor authentication; already delivered PR6488 does not itself grant C ownership.

### Required meaningful controls

Getter tests must obtain accepted/emitted objects from genuine existing preparation: strict reference equality between `acceptedPhysicalSetupPlan(accepted)` and the new getter after emission; deep-frozen plan data; cross-emission distinction; repeated read without new planning; forged/spread-cloned emission refusal; incomplete or foreign emission refusal; real completed-function/body/census mutation refusal with healthy and restored counterwitnesses. Use original-call observation/spies only for provenance, not forged plans or injected success values. Keep one-shot acceptance tests unchanged. Module export/import mutations need the presentation's own joins; do not claim the getter alone detects them.

Productive tests retain the complete original mixed program and independent native/legacy observations, execute the actual final binary through its actual generated helper, and await real fulfillment/results, rejection/exception identity, ordering and interleaving. Preserve the existing initial/seed expectations and phase sequence; add a distinct mixed fixture with a real rejecting async operation and handler observation. Assert actual Promise behavior, not merely thenability or emitted-unit counts. A second program's authentic plan must not be accepted for the first program's result.

Counterexamples must exercise callback binding/name collision, additional or absent callback export, wrong target/index/type, nonzero imported-function offset, carrier mismatch, forged Promise annotation, unexpected resource family, startup adapter confusion and unrelated finalizer mutation. If the genuine consumer's existing guard refuses a mutation first, assert that real first guard and retain a separate healthy witness; do not manufacture local-join coverage. Keep the numeric/void and composed Boolean host contracts as regression controls. Full IR parity, arbitrary untyped Boolean identity, Linear async, all profiles and retirement remain open.

### Actual reader and budget consequences

The pinned current `tests/helpers/ir-c1-authority.json` contains no `program-consumer` path literal. Searches of `scripts` and `tests/helpers` identify the truthful compiler-boundaries row, the existing `ir-layering-baseline.json` count, replay API imports and explicit source-measurement helpers; they do not establish a direct fixed C1 consumer-body pin. Thus this consumer-only seam does not justify a blanket C1 reseal. Run ordinary native dependency/layering gates on the final patch and inspect any actual failure before changing metadata.

`tests/helpers/ir-whole-program-replay.ts` already consumes the accepted-plan API; `scripts/ir-whole-program-replay.mjs` consumes completed support/startup observations. Preserve those APIs. `physical-completion-source-parity.mjs` and `semantic-provider-source-receipts.mjs` measure candidate/historical source arms: retain authentic historical source and old evidence, record new candidate pins for a new measurement, and never repin the historical arm to make it pass. Existing fixed original-instrument text remains historical.

At c3e3, `program-consumer.ts` is **1,489 newline-counted lines** (1,437 nonempty). `check-loc-budget.mjs` uses newline count and a 1,500 threshold; even this small seam may cross it. Record the actual formatted delta, and if it crosses, root adds a narrowly justified `src/ir/program-consumer.ts` allowance in the PR's own issue3525 frontmatter. Do not change the LOC baseline or borrow another issue's grant. `materializePhysicalProgram` currently spans lines1192–1489 inclusive (298); the added plan argument can bring it to299, but formatter output must be measured against the300 function threshold. No function allowance is presently justified. `recordEmissionObservation` and the new getter remain small; avoid moving unrelated logic merely to game these counts. These are source-derived budget risks, not executed gate results.

### Boolean proof composition: bounded current result

The held Boolean proof freeze `1d9ab3096dab415e9e02df862bb1f6fdfcdae927e1176598559652c88cdcefe6` was independently checked against actual c3e3 Git blobs. All three complete UTF-8 inverses and forward replays match: H1 `2a6d7d09…`, H2 `73cca8b2…`, current-source test `3f7978a9…`. H2 retains the delivered early-return bridge and external component pin `253eda01462fad0ab84a940965a083eaf80b0ca8a3e10a4ca012fbafaaf30e99`. Its new types inverse authenticates supplied current `types.ts`, reconstructs historical bytes for the historical population, and preserves the current observation; it is not a physical-healthy replacement for supplied mutants.

No new composability blocker was found in that finite static delta. Current C1 test expectation is297 preserved registrations plus14 Boolean additions =311, not325; this is a planned/AST count, not runtime acceptance. Root must bind the final selected H1/H2/types current pins and external scalar last while retaining all current historical recipes and early-return controls. Never copy the old Boolean trio over the delivered695d authority. Mixed consumer access is file-disjoint from those three proof files, but the presentation leaf and final integration ownership remain serialized as stated above.


### Current composed Boolean execution evidence and local hook parallelism

Actual coherent manifest15df36672c658dd96fd3e35a5ab0a538a6d1183eea1c2d618ee4e282d7cc97d0 passes ordinary current-source311/311, preserving every delivered297 ordered name plus14 Boolean controls; child42244exit0/54.5039seconds, all7653 declared inputs restored and strict error channels empty. Independent Astra review7efa776593dd8605bbbb0822a01a33cd1d8f8e4de649bc59f88109ce3fe4d7fc. The six strict suites pass54Boolean+44numeric+16early-return+57lowering+45classification+56isView=272/272, all actual direct children0 and original ordered names exact; all7660 body custody entries restored. Preparatory collection7642 is separately qualified. Independent Astra reviewd20ffdb1fa39389f5039aca64f9ed322a7e0c9015097313949d79d4046a937ab.

Nine native gates genuinely exit0 (typing, lint, format, oracle, coercion, LOC, functions, preservation inventory, IR layering); whole-tree coercion supplemental148files566sites/exit0. Preservation inventory keeps graphOPEN/strictclosureFAIL/retirementNOTcertified. Reviewf10d1eb7988155a331c42d9bff134f9489ca3aa532185a3b19f2672f5f135871. Separate runtime-relocation298/298 child0/83.7099seconds is measured; historical631 and validator62 are still pending here and receive no pass credit.

Root releases normal unmodified signed commit hooks on the immutable12-file packet in the separate integration checkout while the additional historical/validator lane continues in its isolated source checkout. No source/proof inputs change during either physical-fault window, no ignored-error option is added, and no repository hook/check/protection is bypassed or weakened. Local commit work is reversible; fork publication requires the remaining ordinary lane's actual terminal success and independent review as well as the normal hook/pre-push checks. Final results and the exact published head belong in the delivery handoff/PR. These finite results do not establish full erased-JavaScript/legacy equality, all IR coverage, mixed async/performance parity or retirement.


### Completed final-epoch ordinary evidence — 2026-10-05

The remaining original cohorts are now actually complete: runtime298/298 child42393exit0/83.709898seconds; historical631/631 child42811exit0/818.462477seconds; validator62/62 child45234exit0/3.005814seconds. All six collection/body children and outer16981 exit0, exact genuine original ordered names/duplicates and every individual passed row retained, no pending/todo/unhandled/RPC/timeout channel, complete full before/after/final custody equal. All12 coherent source/proof/test files restored byte/mode exact. Source receipt SHA2566f9a090eb66c9410a8af03a03ebebace44bfbfb87e40ba7f13293308b3712f31.

Together with independent current-source311 and semantic272, this is1574 distinct ordinary registered passing tests on the final composed epoch, not1574 new behaviors or full IR parity. Source/authority pin15df remains unchanged. Normal signed source commit299f858587f35ebb1b3152ae48e22113ff16e009 has parentc3e3 and exact14 scoped paths; all12 source/proof pins match. Its normal hooks genuinely selected311+54=365 passes and exited0/82.4826seconds; counts overlap the strict evidence. Independent signed-commit/hook reviewa42a37d8a9f2a7fd7e0587fc7b82a74dc20a9329e0d63b4d99abf465b35b8030 and cryptographic public SSH signer verification0. Inherited normal hook ignored-unhandled behavior remains qualified; separate strict ordinary runs added no such option. Final evidence documentation runs normal hooks again without extra source changes.

Fork publication/readyPR and exact-head protectedCI/main delivery remain separate requirements. Legacy388 erased-JavaScript identity/coercion gaps, mixed/nonhost/artifact/performance coverage and full IR acceptance remain open; public legacy compilation is retained.

### Root delivery repair release (2026-10-05)

Current exact merge-bot head8a79439ecbd1104a7ddd80aa1582ae5b4f17a773 is preserved.
Source claim3525:boolean-host-budget-source-20261005 owns only src/runtime.ts;
root claim3525:boolean-host-budget-integration-20261005 owns issue/integration.
Both canonical claims verified; no cap, baseline, gate or public route change.
Sol 6.1 Medium implementation; Astra High independent spec/review.



## Implementation amendment — Boolean runtime type deduplication for the unchanged host-import cap

This bounded repair belongs to **IR R5 whole-program multi-source ownership**, `plan/issues/3525-ir-r5-whole-program-multi-source-ownership.md`. PR6490 remains subject to its actual required checks. The observation-seam source/test packet is separate and unchanged.

### Actual blocker and legitimate reduction

Authenticated Boolean commit `299f858587f35ebb1b3152ae48e22113ff16e009` has `src/runtime.ts` at 20,227 newline-counted lines. Authentic `f7ab45d2fe5bb0d4243c28c02ba98f495804f8cf` has 20,194. The unchanged `plan/audit/host-import-policy-baseline.json` permits 20,220; `scripts/check-host-import-policy.ts` counts `source.split(/\r?\n/).length - 1` and refuses at line 376. Boolean added 33 lines: 19 from the duplicated signature union expansion and 14 net runtime implementation lines. The aggregate excess is seven; it is not an isolated seven-line behavior defect. Existing issue LOC grants do not alter this independent gate.

Deduplicate the identical param/result union into one private erased TypeScript alias. This removes repeated type declarations rather than deleting blank lines, increasing the cap, or moving executable behavior merely to evade the counter. There is no need for a new module, an extra runtime call, a prepared-scalar adapter, or a new dependency/classification row.

### Exact writer ownership and implementation

Root has released `3525:boolean-host-budget-source-20261005` to the isolated source branch `codex/3525-boolean-host-budget-source-20261005`; its sole tracked source file is `src/runtime.ts`. Root exclusively owns `3525:boolean-host-budget-integration-20261005`, issue recording, composition, gates, commit and publication. Preserve peers and all existing Boolean behavior. No additional shared runtime ownership is implied.

At current `WrapExportsSignature` (approximately line 19749), retain its exported interface name, documentation, the mutable parameter array, result property and both property comments. Replace only the two repeated unions with `params: WrapExportsBoundaryKind[]` and `result: WrapExportsBoundaryKind`. Declare a non-exported `type WrapExportsBoundaryKind` nearby, preferably immediately after the interface so the existing public JSDoc remains attached to its original declaration. Its exact nine members, in existing order, are `boolean`, `uint8array`, `typed-array`, `string`, `symbol`, `promise`, `dynamic`, `aggregate`, `other`. No optionality, readonly, generics, assertion, imported IR type, widened string type or value export. `ExportBoundaryKind` in `src/ir/types.ts` is a different domain and must not replace this runtime union.

The current interface occupies 25 lines. A conventional formatter layout with the six-line interface, a separating blank line and ten-line private alias is expected to reduce eight lines to 20,219. This is a planning calculation, **not a measured formatted candidate**. The implementer must run the repository-pinned formatter and report the actual final count using the gate's exact counter; acceptance is at most 20,220 with no unrelated deletion. If formatter output does not meet the unchanged cap, stop and report the exact result before broadening scope.

Do not change any executable wrapper branch: own-signature and boundary-policy property access; explicitly Boolean-marked user `__*` selection; ToBoolean conversion before marshalling with no coercion hooks; missing Boolean arguments becoming false; strict result 0/1 and rejection of -0/noncanonical results; and all unmarked legacy forwarding remain exact. Do not move or alter the public generated-helper protocol, runtime adapters, resolver switch, providers, physical receipt or Boolean source/ABI joins.

### Required proof and narrowly relevant checks

1. Authenticate the actual source predecessor against the published Boolean runtime `11d3d065a6b364481ad662c09ed58034ce2fc70972a1f17c5c60543f5f8dcf60` (1,024,984 bytes). Save original and final full bytes, explicit replacement ranges, exact inverse/replay, and modes. Only the interface type operands and the new private alias may differ; all executable source remains byte-exact. Preserve actual failed CI evidence.
2. Using the same pinned TypeScript version, identical compiler options and authenticated original/candidate, emit JavaScript to separate scratch outputs and compare complete nonempty outputs byte-for-byte, including comments. No regex removal, minification or normalization may manufacture equality. Also compare runtime value-export names. If comment placement changes emitted bytes, adjust only alias placement, preserving original comments; do not waive the promised exact emitted-JS proof. Full native typecheck must pass. Declaration/type checks must retain both-way assignability of the old and new public signature shapes and reject an unlisted member, without creating new production API.
3. Run pinned formatter and scoped lint on the real source path. Record actual `runtimeTsLines` and run the unchanged `pnpm check:host-import-policy` with its real nonempty native probes, imports, compatibility floor and all five migration counters; preserve original cap/baseline/checker/package/workflow bytes. A smaller source file alone is not a gate result.
4. Execute the existing 54-case `tests/issue-3525-prepared-pipeline-boolean-presentation.test.ts` on the integrated candidate, checking genuine generated helpers, both host backends, own special names, ToBoolean/missing/hook cases, strict carrier refusals and unchanged unmarked slots. Root also requires the current 311-case `tests/issue-3518-c1-current-source.test.ts` on the coherent unchanged Boolean authority packet. Capture actual collection/body exits, full ordered names/statuses and raw error channels, full before/after custody and runtime version. These counts are expected prior identities until actually executed. No historical pass is relabeled as candidate execution.
5. Complete normal exact-head commit/prepush and required CI gates. The failed required quality check must be replaced by actual corrected-head success; advisory job color is not a body result. No gate flags, cap/baseline/allowance changes, test exclusions or automatic retry loops. Exact JavaScript equivalence supports avoiding a redundant full unchanged 1,574-case proof replay; it does not claim those bodies ran against the new source bytes.

### Authority and dependency boundaries

A literal search of the actual Boolean C1 authority and relevant proof helpers finds no `src/runtime.ts` source authority pin. The C1 Boolean type closure is `src/ir/types.ts`, which stays byte-exact; all 12 instrument pins, ten original reconstruction recipes, immutable authorities and artifacts, manifest/anchor and independent test scalar remain untouched. This alias creates no runtime import, current resolver dependency or source-body receipt change. Therefore no C1 reseal, policy evolution, classification row or whole-source hash allowance is justified. Source-wide execution custody records must honestly bind the new runtime bytes. Root must verify this bounded conclusion against the final selected integration base before publication, not rewrite any authority based on a missing grep result alone.

The existing runtime +33 issue grant is an authorization ceiling, not a measured final delta; do not add or enlarge it. Root may record the measured smaller final delta without deleting historical evidence. No performance equivalence, full legacy Boolean parity, nonhost support, mixed presentation release or legacy retirement follows from this repair.


### Boolean host-import cap repair — measured local validation

The private `WrapExportsBoundaryKind` alias removes only the duplicated parameter/result type union. The public interface, nine accepted kinds, mutable parameter array, documentation and all executable wrapper behavior remain unchanged. The formatted runtime now has **20,219 lines**, below the unchanged **20,220** host-import cap (previous failing source: 20,227; original main: 20,194). This is structural type deduplication, with no cap/baseline/grant/gate increase.

The complete original declaration replacement inverses and replays exactly. TypeScript 5.9.3 single-file emission under identical repository-derived options produced byte-identical JavaScript including comments: 1,116,523 bytes, SHA256 `3f574e41b21e936bc58f3b1fc8c9b35c7e9d4d08546d5336b1c439c5eb740e3e`. Full native typecheck, bidirectional signature/mutable-array/invalid-kind type controls, scoped lint/format and the real host-import gate passed. The host gate observed 33 native probes, 426 imports, zero native legacy-semantic/unknown imports, 23 compatibility legacy-semantic imports, and migration metrics 20,219/7,897/15/952/1,194.

Fresh strict Node 25.9.0/Vitest3.2.4 execution passed **54 Boolean cases and 311 C1 cases: 365 distinct cases**. All actual ordered prior collection names matched, all four direct collection/body children exited0, every row passed without pending/skipped/todo or raw RPC/unhandled errors, and all 7,653 declared custody records were exact after each child. Runtime SHA256 `80340d6815a2b29ba7608c9e58478861cdb72d2d793fd4148127c8b6459fedb0`; existing C1/type/receipt authorities were not resealed. Independent actual review: `c2536a1a9cbde9a195f412d1d51d4db8998fc7fefb2a5685049c7fa02cf587e1`.

These are local candidate results. Native quality partitions, normal signed commit/prepush and corrected-head required CI/protected delivery must be recorded by their actual terminal receipts. Do not add their counts to 365 as new semantic coverage or transfer historical 991/1,574 passes to this source epoch. The original required-quality cap failure remains preserved; no performance, complete IR/legacy parity, nonhost capability or retirement claim is made.


### Remaining local required quality checks on the cap repair

The other applicable quality partitions completed on the frozen candidate: fourteen source/ratchet predicates, eight issue/context predicates and six compiler predicates passed. Required guards passed 261/261 across 21 files. The four configured test families passed host-import allowlist 13/13, regression excusal 57/57, allocation provenance 17/17 and benchmark-staleness 6/6. These are separate gate populations, not added Boolean coverage. IR readiness observed five entries and 41 terminal units per lane; the pinned standalone cutover completed five sources/47 units; dogfood emitted-binary validation observed six packages and 20 subpaths. Hybrid readiness does not authorize legacy retirement.

Initial local infrastructure failures remain in the raw receipts: two scanner scripts cannot decode the space-containing checkout pathname and passed unchanged through a verified space-free symlink with Node preserving only its script pathname; four tsx entrypoints and the simulated Git-merge integrity gate initially failed before their predicates under sandbox permissions, then passed the same commands with authorized permissions. Three regression-excusal fixture cases initially failed to sign their temporary Git commits; all 57 passed unchanged with the actual configured SSH agent. No signing disable, source/test/gate/policy change, new allowance or hidden retry was used. The guard suite's vacuity warning is its deliberate negative control.

All original 7,653 declared input records remained exact. The normal dogfood command added 1,396 ignored extraction/report artifacts; these outputs are retained and separately recorded, and the original whole-directory equality assertion failure is preserved rather than reported as restoration. Later test bodies verified all 9,049 then-present records. Dead-export preservation passed while architecture closure and retirement remain open; zero changed-codegen oracle/coercion scope is not whole-source semantic evidence. Required remote CI and protected main delivery remain pending.


## Mixed presentation continuation — measured prerequisites and conditional implementation plan (2026-10-05)

The Boolean delivery PR6490 has all six exact-head required checks successful and is in the protected merge queue; it is not yet counted as delivered. Its actual queue commit is bc50d14f5c2cb17b39126fb7302322b6d78e511a, parents96f59e07999c4d17fdb7d84360885cae8441aa71 and ca769dd0ca807ba1db2a36b079cfabcd5b08b212. All14 published candidate paths are byte-exact in that queue commit. Keep the queued source branch unchanged. The signed observation seam bf2ff7ffd3b1c50abb017b841cb675c0d54b763d remains preserved and unpublished; transport it only after actual Boolean main delivery and fresh-base inspection.

Two native diagnostics on the retained original mixed fixture (bf2ff, genuine source digest236fa7d9…) ground the next task. The module has seven terminals, fourteen emitted IDs, eighteen defined functions and nine function imports. The shared finalizer changes exactly types[14].params[0] and functions[5].locals[1].type from ref to ref_null, typeIdx13 unchanged; the old C reservation getter refuses afterward. This is not a no-op transformation. A separate unchanged-source native JavaScript oracle, using real TypeScript CommonJS emission and native async/Math evaluation, matched seventeen of seventeen IR runs over signed-zero, fractional, 32/53-bit boundary, NaN and infinity inputs. Both sides returned real Promises and matched immediate/final phase state and initial212. These are finite diagnostics of one retained fixture, not full mixed presentation, all-backend parity, performance equality or main delivery.

The following Astra High plan is recorded before any source implementation. Its original staged addendum hash is68f2c96a805ec7a258eb8689fcee6e051af6192fea13033a535a6ca33c26489e. Runtime/producer/backend/reservation/C1 files remain consume-only. Preserve scalar/Boolean paths and keep legacy/public routing in place. Root will verify delivered predecessors, exact contracts and narrow canonical claims before releasing the presentation leaf, root-only compiler handoff and independent test writer. No implementation, additional budget grant or new public capability is authorized merely by this conditional record.

## Conditional mixed WasmGC presentation: exact finalizer handoff

This addendum refines the existing issue3525 mixed-program plan. It grants no implementation or publication authority. Use actual delivered Boolean main plus the independently integrated emitted-plan seam as the selected predecessor; ca769 and bf2ff are the inspected pending inputs. No runtime.ts, producer, backend, reservation-ledger, policy, or C1 change is authorized by this proposal.

### Concrete evidence and decision

The existing source capture rejects async declarations before the real driver; that does not demonstrate a missing WasmGC async consumer. The retained ORIGINAL_MIXED fixture digest is 236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb. Root's completed native diagnostic on bf2ff (not the Boolean-composed packet) observed seven source terminals, fourteen emitted IDs, eighteen defined physical functions and nine function imports. The unchanged widening pass changes two actual reference sites: types[14].params[0] and functions[5].locals[1].type, both typeIdx13. Binary size stays 1936 but hashes change 671aa821be5570296afb765aaf37158f8f3277d694454984c4ed4603af7f3bab → cbbc0740a05ed16a930618c09eb968692f96a745331adfb548782d9e1c3bf343. The original completed-reservation getter then refuses altered reserved type definition/signature. This is actual transformation evidence, not productive helper/runtime parity.

The same-plan getter is sufficient for pre-finalizer authority. Do not extend C to accept mutated signatures, refresh its snapshots, restore/retry poisoned capabilities, or call the old getter after widening and reinterpret its refusal. Keep the existing permanent-poison behavior. Prefer a separately owned output-module projection, not mutation followed by returning a stale C capability. The private transaction authenticates the genuine emission once, creates a compiler-owned detached module graph, finalizes that graph, proves its exact allowed ref-nullability delta, and re-authenticates the ORIGINAL emission unchanged. The copy is never an EmittedPreparedIrProgram and has no C reservation capabilities. It is authorized only as output derived from this exact authentic emission through the private one-shot presentation witness. Existing result.program/result.emission identities and reusable observation semantics remain intact. Add only a phase-qualified finalization receipt describing the derived output; no new CompileResult/public route field is required.

A faithful private module-data copy is feasible from the actual WasmModule contract (types.ts:26–134): plain module records/arrays, maps/sets, numeric stable handles, byte arrays, source positions and presentation metadata, with no declared executable callbacks. Do not use JSON serialization or assume structuredClone preserves null prototypes, own '__proto__' keys, property presence and descriptors. The small private graph copier must explicitly preserve supported data shapes, own data keys/prototypes, map/set order and key relationships, aliases/cycles and Uint8Array bytes through a memo table. In particular platformCapabilityImportProvenance must key the COPIED imports, not original import records; exportSignatures must keep its null prototype and own dangerous-name entries. Refuse any genuinely unsupported data shape rather than silently dropping it. The complete pre-copy and original-emission snapshot proves that no original mutable arrays/records/buffers are shared with the output graph. No duplicated compiler algorithm or physical allocator is copied, and numeric handles retain identical values. The copy costs one module traversal and storage allocation per internal output transaction; no performance parity claim is made. Public legacy compilation continues using its current path.

This replaces the preceding scratch same-module phase-consumption proposal. The existing C post-widen refusal remains a valuable negative test on a separate authentic emission deliberately mutated by the test. It is not the intended success behavior of the productive pipeline. No reservation snapshot refresh, mutate-and-recertify API, restore-and-retry, or C implementation extension is needed.

### Three file-disjoint writers

1. **Presentation writer — src/compiler/ir-program-presentation.ts only.** Preserve the delivered Boolean joins and scalar behavior. Extend capture/checkAbiExports/checkResourceDemand/joinStartup and the physical export census only for the genuine selected wasmgc:host async projection. Capture source once; join source location/unit identity to actual callable contract.promise and its result/carrier, selected runtime/support owners and the exact emittedPhysicalSetupPlan object. Do not rely solely on checker/type-mapper.ts:isPromiseType: its symbol.name test is insufficient against a source-local lookalike. Inspect the resolved type target's declaration origin in the actual checker program, require the genuine Promise generic/argument and matching genuine producer promise contract; aliases to that actual type are legal. Keep independent forged/local-Promise negative controls. Existing unsupported resource families remain explicit, not silently zeroed.

   Join asyncFrames.entries and each callback's aliasOf/intent/targetBindingId to its actual absolute function index, physical export descriptor and signature. Same root plan object is mandatory; nested rows are compared by unique identity key and full structure because the plan freezes/clones data. Compare complete planned/observed import and export populations, including provider/carrier and exception-tag ownership; names alone never authorize a helper. For defined-function lookup subtract the actual function-import count from the authenticated absolute index (nine in this fixture, never a constant). Correct the same assumption in startup adapter lookup and source function lookup; startup/global index spaces retain their own import counts. Preserve stable handles and use the existing layout resolver for instruction operands. No recreation of a physical plan is allowed.

   Source Promise metadata must flow through the existing exportSignatures→boundary policy→adapter manifest→generated helper path, preserving marked Boolean entries. Do not synthesize helper text, Promise stubs, empty inventories or a new runtime adapter. Use the existing runtime Promise normalization and exception translation; unsupported actual carriers fail before artifact publication. User '__' names are not blanket internal authority. If an original helper genuinely fails a required user-name or Promise contract, report that concrete runtime dependency rather than silently banning names or editing runtime.ts in this lane.

   Own internal finalization witness construction/checking in this same leaf to avoid adding a generic framework. Expose only narrow internal operations consumed by compiler.ts: beginPreparedPresentationFinalization(prepared) and completePreparedPresentationFinalization(token). Use a module-private WeakMap brand; no caller-supplied expected snapshot, callback, complete flag or permitted-hash set. Begin requires the actual successful presentation object, authenticates its exact emission/plan immediately, then captures a detached complete physical/presentation snapshot, constructs the separate output module, and enumerates the exact permitted widening slots on that copy. The returned internal token exposes only that output module to compiler.ts; its provenance/snapshots remain private. Token is one-shot, tied to this module/program/emission; completion failure permanently consumes/refuses that token. Numeric/Boolean no-op transactions are covered by the same exact comparison. Completion also verifies the original module unchanged and calls its existing emittedPhysicalSetupPlan/emittedSupportFunctionReceipts guards successfully; original program/emission identity is preserved in the result.

2. **Root finalizer writer — src/compiler.ts only.** The private runPreparedIrPipelinePresentation entry creates the witness immediately before calling its existing finalizer and supplies the token-owned output module instead of prepared.emission.module. No caller may supply a replacement output module or emitted packet. Add a narrowly typed optional internal token parameter to that private finalizer; legacy callers supply none and keep identical behavior. Immediately after the existing widenNonDefaultableTypes(mod) at line1250, complete the witness BEFORE import manifests, binary/WAT/helper emission. Do not accept an injected arbitrary verification callback. A mismatch preserves a genuine invariant/failure channel and produces no successful artifacts. The C ABI/source-map/optimizer restrictions of the private entry remain; no public-route flip. Return the detached phase-qualified finalization receipt in the internal result, not legacy CompileResult fields or telemetry. It reports observed changed slots in the derived output, not the fixture's constant two as an admission whitelist. Return prepared.program and prepared.emission unchanged; do not replace emission.module with the output copy. Source/ABI/runtime/presentation checks finish before begin; no observer or asynchronous gap may intervene between authentication, mutation and verification.

3. **Test writer — NEW tests/issue-3525-prepared-mixed-presentation.test.ts only.** Import the normal internal entry, genuine producer and original generated helper. Preserve the entire pinned ORIGINAL_MIXED three-file fixture, plus a distinct authentic async rejection/exception fixture. Run actual Node25 default engine with both prepared and legacy final artifacts plus native-source oracles; observe returned Promise, fulfillment/rejection value, immediate/intermediate/final phase ordering, multiple arguments/invocations, module initialization and actual helper setup/setInstance lifecycle. Check seven terminals/fourteen emitted IDs separately from eighteen defined functions/nine function imports, without generalizing those counts to other sources. Do not claim a test passed before execution. Linear's genuine missing promise.capability.create adapter remains a separate refusal, not an implemented backend.

### Exact allowed mutation and verification rules

Enumerate from the authenticated actual pre-state the positions visited by compiler/output.ts:widenNonDefaultableTypes and widenBlockTypesInBody: function type params/results; struct field types; array element types; nested rec/sub definitions; function local types; val blockType.type in recursively visited then/else/body/catches/catchAll instruction bodies; global types; global-import desc.type. Only ref→ref_null with the SAME typeIdx at those positions is allowed. Existing ref_null and scalar values remain exact. Do not widen every arbitrary object whose kind is ref, omit nested bodies, or normalize observed post-state back to an expected hash.

Capture all other module keys, own-field presence, array order/census, map/set entries, data bytes, numeric values (including -0/NaN), bigint and shared-object relationships faithfully. Maps/sets/import-provenance objects must not collapse to empty JSON objects. Across original→copy preserve graph relationships via a bijective object mapping rather than requiring cross-graph identity. Across copy-before→copy-after preserve all unaffected array/record identities; only exact ValType replacements made by the existing pass may acquire the expected replacement value. The original graph must retain its exact identities and content throughout. Complete comparison includes type indices/brands, locals, every instruction/opcode/immediate, function order/handles, imports and their signatures/provenance, globals/init, tables/memories/tags/elements/data, exports/start, canonical rec-group, strings and presentation metadata. A snapshot must be detached from mutable payloads while retaining identity witnesses; a shallow copy is insufficient. Build expected allowed slots from the pre-state, compare post-state against that independently, and consume the token before returning. No production full-body copies or hash-selected authority.

Positive-first controls must demonstrate genuine authentication before each fault: forged/stale/different-emission token; double complete; old emission mutated before begin; unexpected scalar/typeIdx/local/body/callback/import/export/start/data change; omitted required widening or extra widening outside the enumerated positions; unchanged no-op numeric/Boolean; nested structured control/type positions; permanent token refusal after failure/restoration and an independent fresh healthy transaction. Retain C's separate restore-does-not-heal poison tests. A separate direct-mutation test must preserve the old C getter refusal/poison after widening an original emission. Successful pipeline tests must instead prove the original getter STILL succeeds, original module bytes/structure are unchanged, output-copy widening and resulting binary differ exactly as specified, and no original mutable record is aliased into the output. Assert complete callback target/signature joins remain, not just helper names or successful instantiation.

### Scope and release consequences

The source-grounded required extension is a privately derived output module with presentation/finalizer provenance, not a change to program-consumer or PhysicalModuleReservations. Actual ca769 production callers: only compiler.ts defines/calls this internal route; three test files consume it (prepared-pipeline-presentation, prepared-pipeline-boolean-presentation, prepared-linear-early-return). Preserve their result.program/result.emission identity expectations and add the new field without removing existing discriminants. No src/index public export is added. Existing source proof/C1 pins do not cover these three proposed paths; preserve all current authority files unless an actual later dependency inspection proves otherwise. Root owns exact claims, final issue append, integration and measured native budgets; no inherited LOC allowance silently authorizes growth. Freeze the internal begin/complete/result type contract between the leaf and root before parallel writes. First transport/revalidate the seam on actual delivered Boolean main; then release these three claims. No implementation is launched by this scratch addendum. Full IR equality, arbitrary untyped Boolean identity, nonhost profiles, Linear async, performance and legacy retirement remain open.


## Delivered Boolean predecessor and current seam composition — 2026-10-05

Boolean PR6490 was protected-queue merged at16:29:40Z as30400e90a21d3c90e92149f253e1d77c33cb13b2. Exact published headca769dd0ca807ba1db2a36b079cfabcd5b08b212 and that merge are ancestors of canonicalmain081a9a1b7df6495921f62b49d1327ddba5af3513; all14 changed paths are whole-byte identical. Final group30400 itself uses base4895c89e24bca892da69b1d40726fea2c8de598e plusca769. Earlier groupbc50 was superseded, not delivered, and its observations stay separate. Genuine final CI37339120635, sharded37339120655, differential37339120675 and CLA37339120582 completed successfully; raw per-job census is independently recorded separately. Green workflow color never certifies complete language or performance parity.

Root now owns canonical3525:emission-plan-main-integration-20261005, owner ttraenkler/codex-emission-plan-main-integration-20261005 and same-namedcodex branch from081a. Three exact signedbf2ff source/test blobs transport without source conflicts. Complete Boolean issue is preserved by inverse-verified three seam insertions, followed by the exact newer16800-byte conditional appendix. Existing optimizer, npm budget/performance/report and baseline changes on main are retained untouched. Old signed seam and its uncommitted issue appendix remain preserved.

Independent composition review confirms Boolean C1 does not pin this consumer or these two seam tests. Manifest15df3667/current anchor/helpers/historical recipes remain unchanged; no reseal or baseline grant. Current composed validation population is20 observation +27 codec +54 Boolean +311 currentC1 =412 planned ordinary cases, with strict ordered collection and per-case/error/custody checks; execution evidence is recorded after completion rather than inferred from historical211. Native type, scoped format/lint, LOC/function, layering/cycles/compiler inventory, dead exports, issues and retirement gates use081a. Original sandbox tsxIPC failure is retained and the same IR-fallback command succeeds with authorized execution infrastructure. Its retry accidentally inherited the old LOC environment variable, which that fixed-baseline script never reads; no verdict input changed. No hook bypass, runtime behavior, public route, schema or retirement change.

The following Astra refinement remains conditional: only the retained-plan getter and tests are currently being delivered. Productive mixed presentation needs a separately claimed/released implementation and actual predecessor revalidation.

## Conditional mixed presentation refinement: preserve the fast path

This is a precise amendment to mixed-finalizer-addendum-v2.md (68f2c96a), not another source release. The root's next-mixed-evidence receipt records that v2 was appended to the prepared issue with its original signed prefix preserved. Apply this amendment after it when root records the final conditional plan. Three writers remain file-disjoint: Sol leaf src/compiler/ir-program-presentation.ts; root private transaction/finalizer subsection in src/compiler.ts; Sol NEW tests/issue-3525-prepared-mixed-presentation.test.ts. All consumer/backend/producer/runtime implementations remain consume-only. Actual predecessor delivery and root claims are prerequisites.

1. **Leave the existing scalar/Boolean route unchanged.** Retain its exact capture/ABI/resource/startup checks and direct finalizer call. Do not add a copy, full-module snapshot, witness allocation or result field to every existing private output. The new branch is selected only after genuine source capture and authenticated selected wasmgc:host runtime/physical plan establish the admitted mixed/async demand. A mixed failure is a typed refusal/invariant, never a fallback to the old path. Ordinary numeric functions inside a mixed program use the existing slot rules; they do not select a separate driver transaction. One capture and one real driver call remain mandatory per artifact.

2. **Confine output copying to the new mixed/ref-demand branch.** Its compiler-owned module copy is separate from the original emitted module; original program/emission objects remain returned unchanged and successfully observable after output. Copying the actual instruction DATA, function/local/type records and other mutable module DATA is required to avoid finalizer mutation reaching the original. The v2 phrase “no production full-body copies” forbids duplicated compiler/lowering/emitter algorithm source, NOT those necessary instruction-data copies. No repeated lowering, second consumer emission, alternative plan or generic plugin/heap framework is introduced.

   Implement the private copy only for the finite WasmModule data forms: primitives with Object.is semantics, own plain/null-prototype data records, arrays, Map, Set and Uint8Array. Preserve own-key presence, null prototypes/dangerous names, shared-record relationships via a memo table, map keys pointing at copied imports, stable numeric function handles and byte contents. Reject unsupported executable/accessor/prototype shapes rather than dropping them. A memo table suffices; no generalized object serialization, persistence format or registry. Only the mixed route pays the traversal/storage cost, and no efficiency/parity measurement is claimed. The original graph must share no mutable instruction/type/local/resource/metadata data with the output graph; immutable primitive values may of course be shared.

3. **Freeze the branch-local handoff.** The leaf's beginPreparedPresentationFinalization(actualPreparedMixed) returns a privately branded, one-shot token with its owned outputModule. Root calls the unchanged private finalizer on that module and supplies the token via the new internal optional parameter. Immediately after the existing widenNonDefaultableTypes and before import manifests/binary/helper publication, completePreparedPresentationFinalization verifies the exact allowed output-copy transformation, unchanged original graph and fresh successful original C guards. Return the mixed-only finalization receipt alongside the existing program/emission/artifacts; the old scalar/Boolean object shape need not change. No caller-supplied snapshot, module replacement, callback or C transaction is accepted. Failure permanently consumes this private token; C's independent permanent-poison semantics stay unchanged. Widening is structural ref→ref_null at the existing pass's full set of positions, never a literal list of the observed two fixture paths. All other output bytes/data/index relationships stay exact. The new result refinement is internal and additive; no src/index export or legacy CompileResult change.

### Minimal joined authority, not a new planner

- **Source→producer:** exact captured source/declaration span/unit and actual checker-resolved Promise generic/argument, joined to the genuine prepared callable promise contract and selected async attachment. Keep ordinary number/void/Boolean classification intact. A local type merely named Promise is not a witness. Do not repeat the source planner: C already authenticates current async attachment, state graph and callable mappings. Match those returned owners instead of re-deriving async control flow. Unsupported result/carrier/handler families remain explicit; this initial output bridge does not manufacture producer support.
- **Producer→provider:** use exactly one selected wasmgc:host runtime projection and the exact emittedPhysicalSetupPlan. Each frame.owner must join a prepared function/async attachment and its primary/auxiliary binding IDs. The frame's imports carry capability, bindingId, referenceKey, module, field, params/results; join these to the same plan importedFunctions, emitted binding coordinates and actual physical import descriptor/signature. Account for the complete population in both directions. Keep exception tag/global/support ownership separate. The observed fixture has capabilities async.callback.wrap, async.exception.caught, async.promise.capability.create/react/resolve/settle.fulfill/settle.reject, number.box and number.unbox: observations are not an import-name allowlist or permission to invent resources.
- **Provider→callback:** every frame callback entry has a unique ID/full row in asyncFrames.entries, alias/intent/externalName and targetBindingId consistent with the actual emitted binding. Resolve actual absolute function coordinates and actual signature; subtract actual function imports only when indexing defined bodies (observed nine, not fixed). Check source exports, callback exports and startup exports as distinct authorized populations; reject missing/duplicate/extra/colliding rows. Preserve the same root plan reference, while allowing documented deep-cloned nested entry rows to compare structurally. Startup adapter and global lookups must use their correct spaces/import offsets too.
- **Presentation→original helper:** attach authenticated source Promise boundary metadata to the existing exportSignatures path and let the existing finalizer create policies, adapter manifest and original importsHelper. No Promise shim, generated-helper text patch, runtime edit or blanket '__' exemption. Actual native host Promise externref carriers do not become fabricated native-Wasm Promise objects. Test what the original helper really returns. If this encounters a concrete missing runtime contract, report it before broadening ownership.

### Evidence and exact controls

Root's saved bf2ff diagnostic ran the original unchanged three files as transpiled CommonJS in one native VM realm and compared real IR replay. All 17/17 numeric seeds matched by Object.is, including -0, fractions, signed/unsigned 32-bit boundaries, large numbers, NaN and infinities; initial212, real Promises and immediate1/final3 phase observations match in every raw row. Do not repeat speculative numeric-conversion defects or rewrite the fixture to avoid them. This is not generated-presentation-helper coverage or intermediate phase2 sampling. Preserve the three-file digest236fa7d9 and all raw probes.

Keep a genuine positive before each negative: stale/foreign plan or emission; forged Promise type/contract; wrong frame owner/carrier/import signature or missing/extra provider; callback alias target/index/signature/collision; substituted startup adapter; copy retaining a mutable original alias or losing null-proto/keyed-import provenance; missing/extra widening, wrong typeIdx/brand/opcode/immediate/data byte; repeated/forged/failed-restored finalizer token. Prove original C getter still succeeds after successful copied finalization. Separately retain direct mutation→C refusal→restoration still poisoned on a fresh test-owned original. Never count an earlier genuine C rejection as coverage of a later leaf check.

Productive acceptance is the unchanged original mixed fixture through the normal private entry, ORIGINAL generated helper, native-source oracle and legacy output; fulfillment/rejection and actual phase/order observations, plus a separate genuine producer-supported throw/rejection fixture (no new catch/handler lowering). Record true unsupported outcomes if the producer rejects that second fixture; do not fake a fulfilled Promise or call rejection covered by synchronous throw. Preserve numeric/Boolean regression suites unchanged and demonstrate they do not enter the new copy branch. Linear promise.capability.create, nonhost outputs, public cutover and full parity remain separate open work. No new tests, benchmark, source edits or remote reads were run for this review.


### Current composed evidence and final delivered predecessor audit

On exact081a main composition, ordinary Node25.9/Vitest3.2.4 passed412/412 distinct cases: observation20, codec27, Boolean54 and currentC1311. Collection11.433s/exit0 and ordinary80.662s/exit0 bind exact previous ordered names and each actual passing assertion;7656 complete source/test/script/hook/config custody records are unchanged, RPC/unhandled/timeout error channels absent. Historical211 and hook repeats are separate populations. Native12 predicates have positive outcomes with the recorded infrastructure retry; Astra reviewed three signed source/test blobs,33 unchanged C1-domain files and exact whole-issue inverse.

Independent final30400 merge-group audit binds genuineCI37339120635 and sharded37339120655,102 actual successful shards20host82standalone. Each lane has48735 unique rows: host39594pass/8699fail/317compile_error/11compile_timeout/114skip; standalone42053pass/4533fail/2016compile_error/19compile_timeout/114skip. Final regression gate reports0pass regressions and preserves1fail→compile_timeout. Reports are bound to actual30400, not supersededbc50. Configured guard261 and four-family93 populations are separate. Full IR closure/equality/retirement remain uncertified; these results certify only this delivery/composition step.


## Root implementation release: private mixed WasmGC presentation — 2026-10-05

The user asks maximum native parallelization. Reviewed retained-plan dependency is now published as ready PR6493 atc6d0afef99adda5453474f230f9bd2db6f29f574, with412 strict passing cases, normal signed commit/prepush and exact fork ref. This release permits isolated implementation above that immutable head while required CI runs. It supersedes the earlier requirement to wait for that dependency's main merge before local development ONLY; integration/publication of the dependent change remains dependency-first after actual main revalidation. No queued-head mutation, public route, legacy retirement or equality claim follows.

Canonical disjoint claims3525:mixed-presentation-{source,tests,integration}-20261005 are held and verified by effect, owners ttraenkler/codex-mixed-presentation-{source,tests,integration}-20261005 and same-namecodex branches in separate worktrees. Sol6.1 Medium source owns ONLY src/compiler/ir-program-presentation.ts; Sol6.1 Medium tests owns ONLY NEW tests/issue-3525-prepared-mixed-presentation.test.ts. Root owns ONLY the private prepared transaction/finalizer subsections of src/compiler.ts plus this issue/integration. Astra High reviews the hard contract and implementation independently. No backend/consumer/runtime/provider/producer/source fixture changes authorized.

Implementation follows the saved v2 and efficient refinement above. Exact integration API: prepared-presentation result carries optional requiresDetachedFinalization:true only on genuinely admitted mixed/ref-demand WasmGC host output. Existing scalar/Boolean shape and direct module finalization stay unchanged. Leaf exports beginPreparedPresentationFinalization(actualPreparedResult) returning an authenticated one-shot token with readonly outputModule; completePreparedPresentationFinalization(token) returns a frozen phase-qualified receipt after exact allowed ref→ref_null transformation and original emission integrity checks. Leaf privately authenticates prepared results; forged/cloned/stale inputs refuse. Root begins ONLY if the optional demand flag exists, passes owned output module into the unchanged shared finalizer, and passes a private optional holder containing token/receipt. Immediately after widenNonDefaultableTypes and BEFORE manifests/binary/WAT/helper, root sets holder.receipt=complete(token). Successful mixed private pipeline result carries the receipt additively; old numeric/Boolean result shape does not change. No arbitrary injected callbacks/snapshots or C recertification.

Source-to-Promise/frame/provider/callback/import/export/startup joins must be complete and bidirectional against actual prepared/emitted plan. Necessary detached instruction DATA copying preserves aliases/map-key-import provenance/own dangerous keys/null prototypes; no copied compiler algorithm or full-heap framework. Only mixed branch pays copy/witness work. Original fixture/negative evidence preserved. Original mixed must execute through normal private output and ORIGINAL helper against native source and legacy output, with real Promises/fulfillment and actual order. Separate rejection fixture only receives coverage when genuinely admitted producer output executes rejection. Scalar/Boolean unchanged suites plus actual independent fault controls protect boundaries. Any real uncovered provider/representation limitation returns located unsupported; do not workaround or change producer ownership. Actual source/file/function budget needs are measured by root after formatting, never global allowance or borrowed issue grants.


### Current mixed implementation proof dependency review

Astra positively enumerated all current C1 domains for the two production owners: neither compiler.ts nor compiler/ir-program-presentation.ts is an instrument/body authority/artifact/current-or-dependency population/12-path closure/config/13-request57-observation resolver input. Three presentation-path hits authenticate policy-row recipe literals only. All ten actual immutable instrument inverses/replays pass atc6d. Receipt b0d28cbbdc9244b6324c35efc7695bb282570776282792d784c5494dedf2413e. No authority/reseal/test-proof edit is warranted; fresh311 is still required against the final production packet. Root compiler private bridge reviewed cdd9eaf4, final10-edit inverse recovers exactc6d source; successful mixed output with missing completedreceipt refuses invariant before returned artifacts. Leaf/test development continues independently; no composed runtime result yet.


### Finite async declaration metadata consequence

The actual C emission leaves module.asyncFunctions empty, while the unchanged shared Dts generator uses that metadata to preserve its established Promise wrapping for async declarations, particularly missing/aliased source annotations. Root explicitly permits the leaf to populate exact source-owned entry/export async names ONLY after actual captured AsyncKeyword declarations join genuine prepared owner/frame/Promise ABI and every resource/callback check succeeds. Before adding this metadata, existing nonempty/unowned asyncFunctions metadata still refuses. Add it before the authentic prepared-result snapshot/begin, just like existing joined exportSignatures; original prepared program remains unchanged, and original post-presentation emission metadata must remain unchanged during copied finalization. Do not infer async ownership from a string name, arbitrary Promise-return function or old helper convention. No shared renderer/runtime/provider/C change; compare actual private and legacy Dts artifacts while preserving any existing legacy imprecision. This is a finite presentation ownership consequence, not a generic metadata allowance.


### Mixed presentation: actual regression findings and bounded test repair

The coherent frozen production packet (compiler80e76833, leaf85119b7a) passes strict TS7 and both function/LOC budgets. Measured compiler growth is2097→2119 (+22), covered by this issue's own compiler allowance; total source growth+710, leaf1443LOC remains below1500. No global cap or baseline change.

The first ordinary four-file run registered135 genuine cases:133passed,2failed,0pending; new mixed21 yielded20/1, existing presentation44 yielded43/1, Boolean54 and Linear early-return16 passed unchanged. Full7657 declared input custody and ordered names match; failures are retained in the test lane's full-attempt1 raw artifacts. The new callback test incorrectly expected separately reserved frame auxiliaries in the primary plan.functions table; its repair retains the unique actual frame auxiliary, complete signature and real defined TypeDef/alias/index joins. This is an oracle correction, not a source fix.

The existing44 test pinned an old async refusal. The exact original calculate source now genuinely returns artifacts. Root explicitly extends its owned test scope ONLY to that case in tests/issue-3525-prepared-pipeline-presentation.test.ts: preserve the source, replace the stale refusal with one real producer/accept/emission transaction, zero legacy-generator calls, healthy original completed-plan guard, exact source-owned async metadata and completed detached-finalization receipt. Execute its ORIGINAL generated helper in a child, require real Promises and compare three fulfilled numerical values. Retain first failure; do not skip, weaken unrelated assertions or label the earlier refusal as current behavior. The separate genuine Linear limitation and unsupported97-byte rejection fixture remain open.

Actual original mixed graph inspection found no original ref_null matching the widened typeIdx13; the repaired cross-original alias guard has static review but no populated genuine runtime counterexample for that shape. The original provenance map and data segments are empty. No invented nonempty map/byte/nullable or rejection coverage is credited. Existing legacy public routing and retirement remain unchanged.


### Completed emitted-plan dependency and pre-main mixed validation

PR6493 “feat(ir): expose authenticated completed emission plans” delivered exactc6d0afef99adda5453474f230f9bd2db6f29f574 through actual merge-group/main merge05ffced74ea6e7949c525f0493a5f573afa54317. Astra independently verified head/merge ancestry and all four content blobs at timestamp-qualified mainc2190146ec0fff6d806c6e02449d75f84db16f8d. Delivery receipt5d712d6be313aa5af3c34dd53941e61fc4803620a4d95b81928eea705ac03260 authenticates all102 actual completion artifacts/checkout/Run-shard success and48735 exact rows per lane. Host39594pass/8700fail/317compile-error/10compile-timeout/114skip; standalone42053pass/4533fail/2016compile-error/19compile-timeout/114skip. Known differential116/2/2 with actualexit1 twice and22 equivalence failures remain qualified. Green delivery gates do not erase those original failures or certify parity/retirement.

Final current-root mixed cohort passes135/135: mixed21, existing presentation44 with the single reviewed stale async case repair, Boolean54 and Linear early-return16. Collection child18132/12.973s and ordinary child18209/100.225s exit0, exactordered arrays/all7657 custody records/no skips/todos/ordinary errors. Independent current C1+codec+emitted-plan cohort passes358/358 (311+27+20), collection18158/11.025s and ordinary18217/67.394s exit0; all7657 records/ordered arrays unchanged. The first proof recorder mistakenly included a separate43-case suite absent from its immutable expected-contract list, and stopped after successful collection with KeyError before any bodies; raw401 collection is retained and receives no runtime credit. The correct358 run uses unchanged prior contracts and no proof reseal.

Canonical main was separately fetched by root at0989df521c40d0feb83efa11b903536f9bd818ab, newer than the delivery audit's c219. Exactc6 head is its ancestor;21 changed upstream paths include an independent issue6840 fs fix (two codegen files and regression test) plus reports and the LOC baseline. Root will preserve that work by a clean normal merge after the bounded mixed commit, then perform fresh composed validation; pre-main493 results alone do not establish the final main composition.


Independent Astra review aaf1e5f51d321ef92d9ee4b613683c5a375f5180515c7ddda401e97ee21b680a approves the exact pre-main493 packet after reading every actual row/error channel and all full input custody records. This is two disjoint cohorts, not one493-child run or newer-main acceptance. Native14 predicates all have actual successful children; the original tsx IPC EPERM and supplemental wrapper custody assertion remain preserved/qualified. Complete collector/architecture/dead-export/retirement coverage is still open despite passing configured scoped predicates. Final changed-test format/lint and source-only TS7 pass with complete7658 custody; tests need their separately released focused strict native project because the normal source tsconfig excludes tests.


### Final canonical-main composition — actual execution, 2026-10-05

Normal signed Thomas/Codex commit889a9c6fdfe362f90917802095b118042be6eacf completed181.226s/exit0 with no hook bypass, all five reviewed file hashes unchanged and valid ED25519 Git signature. The configured changed-root hook ran eight genuine suites (311+27+20+21+54+44+2+14); its existing ignored-unhandled flag is preserved, with no corresponding raw ordinary warnings. This configured hook population differs from the independently strict pre-main493 population and is not pooled with it.

A clean normal merge of canonical0989 is staged as MERGE_HEAD0989; every one of its21 changed upstream blobs is exact, including the fs fixes/regressions, reports and LOC baseline. Separate newly provisioned proof/native worktrees consume the identical four approved production/test blobs on exact0989. Root-to-proof7658 and root-to-native7672 byte/hash/mode comparisons are exact; inode/device identity is checked inside each checkout, not falsely equated across checkouts.

The composed strict ordinary run registers and passes496/496: mixed21, existing presentation44, Boolean54, Linear early-return16, current C1 311, codec27, emission observation20, and all three independent upstream fs regression cases. Collection22967/17.798s and ordinary23385/158.513s exit0; exact eight full ordered name arrays, no skips/todos/ordinary errors, all7658 declared custody rows restored byte/hash/mode/inode/device exact, all21 upstream blobs/modes and four donor pins unchanged. Actual receipt3da88c53483a0089c5e2af75d96859c852400a03f2c403754960f77a7e7f5d13. The selected declared-input vector excludes pnpm-lock.yaml; separate genuine setup/Gitbaseline and during-to-after content/identity supplements bind the unchanged lock. A pre-child lock inode capture is absent and is not invented. Current root/proof/native locks all equal canonical Gitblob03fbaf3f914c0dcd1ebbda6a1d2bce86491d0e3a.

Final-main18 distinct native predicates are accepted against explicit0989 (14 configured gates, source TS7, focused strict BOTH changed-test TS7, LOC and function budgets). First17/18 child0 and the original tsx IPC EPERM before the fallback gate are retained; the authorized exact-same-command escalation child23559/9.326s exits0. All7672 declared custody rows, including the real fallback website corpus, remain exact before/after. Verbose coercion positively enumerates148files/566sites with0 changed codegen at canonical0989. LOC source+710/compiler+22 uses this issue alone, no cap/global-baseline edits. Native receipt819d148fea7a62e2da2a2290d364a47814d7b0232154d1b236be47f113eec2dd; independent audit9d43898038a06ca88ea12c14a1303491bf8283df2cfa39de40ad131959841556. Configured preservation checks do not certify full architecture: inventory1826 valid but graph incomplete, moved-runtime/dead-export strict closure FAIL and retirement NOT CERTIFIED remain explicit.

Astra positively enumerated all88 C1 domain paths at0989: immutable bodies/authority/artifacts/instruments/recipes/resolver requests/closure remain blob+mode exact; no reseal or proof adaptation is justified. Receipt482b4664eac8f3762088360df20bd4d48ab4d2242ef60592725a3565971a074a. First failed tests/infrastructure arms and unsupported resource/rejection/alias populations remain preserved. This finite private mixed-host increment does not establish full IR coverage, all-backend/artifact/performance equality or permission to retire legacy. Publication/protected CI/exact main delivery of this new increment are still separate.

Independent final Astra review63fcf49d29a25af048dafd8aa248b15814003bc856fbfea38b567712cae69b7c approves normal attributed merge commit/publication of the finite composed packet after direct root7658/21upstream verification. It certifies neither remote CI/main delivery of the new increment nor complete IR/performance/retirement.

## Implementation Plan — bounded zero-suspension async conditional rejection (2026-10-05)

This is a **specification release only** for **IR-only R5: whole-program single- and multi-source Prepared ownership**. The docs slice is `3525:zero-suspension-async-plan-20261005`, owned by `ttraenkler/codex-astra-zero-suspension-async-plan-20261005`, in its isolated branch based on published `0917270afc0e3d3fba2d9fbf904cb8a5560914b7`. PR6497 and its production/test/authority packet remain unchanged. No producer, frontend, consumer, provider, runtime or test implementation is released by this appendix. Root must resolve and claim the narrow production subsection before dispatch; actual delivery of the presentation dependency precedes its serialized expectation update/publication.

### Preserved source and measured first guard

The entire original source is 97 UTF-8 bytes, SHA256 `94b33355141949ce931730767308505fb55744cd3fc79c5b68724b94101db9c5`:

```ts
export async function reject(value:number):Promise<number>{if(value<0)throw null;return value+1;}
```

The saved genuine probe7 and the existing mixed suite preserve `unsupported`, phase `preparation`, code `body-shape-rejected`, stage `build`, detail `async-plan producer cannot represent the complete body of reject`, `entry.ts` line1/column1/declaration0..97. There is no emitted artifact or executed rejection for that source. The first measured guard is `prepareWholeProgramAsyncFunctions`, `src/ir/runtime-program-producers.ts:76–86`, after `prepareSuspendingIrFunction` returns null. This is a correct fail-closed refusal for an unrepresented family, not an established scheduler defect.

`src/ir/async-prepare-ir.ts:646–658` dispatches exact sequential-loop, final-main, single-await and straight-line suspending producers. `src/ir/async-linear-prepare.ts:63–85` refuses structured branch/throw instructions and `:489` separately requires at least one await. Removing the zero-await check or deleting throw/branch exclusions would not represent the complete body and is not this change.

The required new behavior is productive: genuine preparation, acceptance, emission and detached presentation of this unmodified source, fulfilling with `value + 1` on the ordinary branch and returning a real Promise rejected with **exactly null** on the negative branch. It must not throw synchronously to its caller or introduce a synthetic await.

### Required authentic observation before implementation release

Capture the genuine typed function entering the existing async producer through an original-call observation, together with source/declaration identity and the complete IR/value/type/terminator/slot population. Forward to the unchanged producer and retain its null result and the normal located failure. Do not replace producer output, construct a successful Prepared packet, suppress the failure, or mutate its body. Save nonempty raw data, exact source/config/native pins and terminal/error channels.

At this appendix's recording time this capture is **not available**. The first scratch probe used `mergeConfig`; installed Vite concatenated include arrays and expanded discovery before any producer capture. The corrected explicit include-only scratch config is prepared but unlaunched pending closure of the original run. No IR shape, test success or performance inference is granted by either configuration. Consequently the structural matcher and helper-lowering proof below remain conditional on the authentic capture; source dispatch is **NOT READY** yet. Record the measured capture as an append-only addendum, not a rewrite of this limitation.

The observation must distinguish a nested `if.stmt` representation from a multi-block CFG, identify the actual null carrier and any coercion node, and verify the normal-return value's dominance. The exact source has no await, but that fact alone cannot establish the full typed-IR shape. If its real representation differs from the proposed closed single-block helper form, report the concrete discrepancy before changing ownership or scope.

### Smallest source change after the observation and ownership gates

Prefer one existing classified source file: `src/ir/async-prepare-ir.ts`. Add a private, bounded producer beside the existing helper builders and add one call in `prepareSuspendingIrFunction`. Leave all prior producer arms in their existing order; the new arm must not steal already admitted suspending families. No new compiler module or policy row is needed for this preferred cut. `runtime-program-producers.ts`, `async-linear-prepare.ts`, the frontend, plan verifier, frame adapter/engine, physical planner, consumer and runtime remain unchanged.

The matcher is IR-only and structural. Once confirmed by the capture, admit the exact finite numeric conditional-null-throw/normal-numeric-return shape, with real parameter/result types, complete block and nested-buffer census, actual operands/definitions and original terminator. Do not match the function name `reject`, filename, literal value IDs or a source-text hash. Alpha-renamed declarations and SSA identities must not alter ownership. Keep constants/operators/carriers at the reviewed closed shape; do not silently broaden to arbitrary zero-await bodies, loops, callbacks, catches/finally, multiple branches, non-null throws, generators or unsupported value domains. Reject added, missing or unaccounted instructions. Existing type/IR verifiers continue to enforce definition, dominance, nullability and result contracts; this matcher must not substitute for them.

For the admitted body:

1. Create one ordinary derived helper using the existing `createDerivedIrUnitId({parentId: fn.unitId, role: "ir-async-state", ordinal: 0})` and `irUnitFuncRef` patterns. It retains the authentic numeric parameters, complete original instruction data and normal-return terminator, with its actual slots/valueCount if permitted by the closed captured shape. Set its own structural unit identity, `funcKind: "regular"`, `exported: false`; do not copy an async attachment/plan into it. Do not rebuild the conditional algorithm from AST or hand-emit a special result. The caller's immutable input must remain unchanged.
2. Produce one canonical async state whose body is a symbolic call to that helper with the original parameter value IDs and a fresh, noncolliding result value. The state terminator is `resolve` of that typed result; no `suspend`, resume binding, live spill or handler is introduced. Use `createIrAsyncPlan`, `canonicalPromiseAbi`, an exhaustive plan value table, empty spills/handlers and the established runtime-intent contract. The outer async owner remains the original owner/export and uses the established empty/unreachable body plus attached plan pattern. Derive new IDs from actual input bounds; never assume a fixed fixture allocation.
3. Return helper/provenance through the existing `PreparedSingleAwaitIrFunction` shape. The unchanged whole-program producer must check parent/role/ordinal identity, uniqueness, source association and complete population. Let existing number-bridge detection, runtime preparation and ABI closure process the real f64 fulfillment; do not invent a callable or physical index, manually attach runtime capabilities, bypass population checks or seal a second program.
4. Retain the original throw **inside the ordinary helper**. Do not translate it into an explicit async-plan `reject` terminator: the schema can describe that terminator, but the current physical adapter's switch does not implement it. Do not change C to make that alternative work in this slice.

### Existing exception-to-Promise mechanism to reuse, and what still needs proof

The following chain is source-established at published091; it is not new rejection execution evidence:

- `src/ir/from-ast.ts:15850` lowers throw operands to the actual externref carrier. `src/ir/lower-generic.ts:2769` loads that operand and emits a throw using the resolver's exception tag. Preserve the actual captured null/coercion sequence instead of replacing it with an assumed null representation.
- `src/ir/program-physical-plan.ts:1338,1384` requires exception support for async frames and deep throw/try demand. `src/ir/program-consumer.ts:1218,1387,1431` reserves the tag, exposes its actual index to ordinary lowering and supplies that same reservation to the prepared frame. No late tag/import registration is permitted.
- `src/backend/wasmgc/async/prepared-async-frame-adapter.ts` accepts authenticated state constants/calls and a `resolve` terminator; it joins helper binding/signature and index through the accepted plan. Its terminator switch at ~225–263 supports suspend/resolve/goto/branch, **not explicit reject**. Its empty-handler restriction stays intact.
- `src/runtime/wasmgc/async/prepared-async-frame-engine.ts:309–322` wraps actual state dispatch and helper calls in the reserved tagged catch (payload externref) plus host catch-all, then passes the unchanged reason to the accepted reject capability. At ~341–370 entry creates and stores the Promise before calling resume and returns that Promise afterward. Thus a helper throw can settle rejection instead of escaping synchronously; normal resolve uses the same existing result capability.

The hard readiness check is that the authentic captured helper is accepted with complete exception support by these unchanged paths. The source trace makes that design plausible and identifies all necessary joins; it does not prove a fabricated plan accepted or the null rejection observed. If genuine helper acceptance loses its exception dependency or carrier, return its exact located first failure and identify the smallest owner/file/invariant. Do not fix the provider, consumer, ABI, frontend or runtime without a new explicit scope decision. Async body evaluation is synchronous until return/throw, while Promise reactions run later; “always-async” must not be misread as permission to defer all body evaluation by adding a scheduler turn.

### File ownership and serialized integration

- **Astra hard spec:** this issue appendix and own scratch only, existing docs claim.
- **Sol6.1 Medium source writer, only after root's production claim/release:** `src/ir/async-prepare-ir.ts` private matcher/producer and dispatcher subsection. The current file is 942 physical lines; measure formatted final file/functions and ordinary gates, with no speculative allowance or borrowed grant. A dedicated new production leaf is not preauthorized because it would add inventory/ownership consequences.
- **Sol6.1 Medium independent test writer:** new `tests/issue-3525-prepared-zero-suspension-rejection.test.ts`, once root claims that exact path. Do not edit the producer or existing mixed suite.
- **Root sole integrator:** issue scope, any justified frontmatter adjustment, final coherent packet, and the single old97-refusal case in `tests/issue-3525-prepared-mixed-presentation.test.ts` only after dependency delivery and productive proof. Preserve its original source and historical failed/refused evidence; change the stale expectation to meaningful Promise/null behavior rather than deleting/skipping it. All other assertions and original mixed fixture remain.

Canonical snapshot `.tmp/mixed-presentation/next-claims.stdout` in the mixed integration worktree has `ref_read: ok`, tip `4fab1594716f4092a4546d894634194e7a4e2003`, and still holds `3518:authoritative-preparation` and `3518:driver-output-planning` for `ttraenkler/astra-ir-program-a-20260905` on their historical branches. The new docs claim does not release those production holdings. Root must reconcile the narrow producer subsection explicitly; no blanket takeover, stale-claim inference or separate user-approval requirement is invented here.

### Meaningful acceptance and retained limits

Use the exact97 source through native JavaScript, genuine legacy output and the new private prepared path with **original generated helpers**, on supported Node25 defaults. For `-1`/`-Infinity`, require an actual Promise, no synchronous throw, one rejection reaction with `Object.is(reason, null)`. For `-0`, `0`, `2`, `NaN`, `Infinity`, require native-equivalent fulfilled results using `Object.is`. Register handlers immediately, observe caller-before/caller-after/reaction order and repeated alternating calls on the same instance, with an independent fresh healthy instance. Do not add an unhandled-rejection suppression or normalize reasons/results. Actual Promise checks must work across VM realms.

Tie source/declaration0..97 to the real owner, derived helper provenance, Promise ABI, accepted plan and emission; verify one genuine prepare/accept/emit path and healthy original emitted-plan observation after detached finalization. Existing capability mutation/poison tests can supply their unchanged regression coverage; new tests must target new state/value/owner/derived-binding defects rather than merely reproduce implementation predicates. Paired genuine healthy witnesses precede negative controls. A genuine cloned/malformed plan that is refused by an earlier verifier does not cover a later consumer branch.

The independent test proposal is `.tmp/zero-suspension-test-plan/acceptance-matrix.json` in the main-proof worktree, SHA256 `b032380cfd89f6ec3e3c9ee5d585ab633c2eb9a40ee96414ee62aa8acee54428`. Its separate counted-argument/caller fixture is **not yet known to be admitted** (notably the nonasync Promise-return caller); it must not silently enlarge this scope. External argument evaluation is a smaller observable once/order control and must not be credited as internal operand-lowering coverage. Preserve the exact97 source in every case; any auxiliary source gets its own identity and actual first outcome.

Classify near-miss non-null throw, await, catch/finally, extra branch and generator examples from actual existing outcomes; do not decree them all unsupported if some already work. Retain the original mixed productive fixture, numeric/void/Boolean fast paths, early-return semantics and Linear's independent missing `promise.capability.create` adapter. No arbitrary erased-JavaScript coercion/identity, nonhost, complete rejection-family, performance or retirement claim follows from this primitive host slice.

### C1 and validation boundary

The current C1 authority is unchanged at this plan base. Complete manifest inspection finds **no occurrence** of `src/ir/async-prepare-ir.ts` or `src/ir/async-linear-prepare.ts` in any pin, recipe, population, closure, resolver or embedded text. `runtime-program-producers.ts` occurs only inside a retained historical policy string, not as a source-body pin. Source/claim proof is saved in `.tmp/zero-suspension-spec/source-and-claims-review.json`, SHA256 `42ed68973ef7974086a4c6195d9f2954f324ce9871f69ff2fcb659de68f6be8e`. Therefore this proposed existing-file change does not justify a C1 reseal or replacement historical input. If the final file set changes, repeat the finite actual-domain intersection before authorizing proof edits.

After a coherent candidate exists, run its full new suite and the relevant existing mixed/presentation/codec/observation/Boolean/early-return and current C1 controls with genuine collection, ordered rows, direct exits, raw error channels and full source/config custody. Reuse same-epoch required evidence honestly where it supplies the same population; do not predeclare totals or repeat the unchanged historical991 solely from this no-pin-intersection finding. Complete applicable native and normal signed commit/pre-push/protected checks. This appendix records no runtime success, no implementation launch and no change to the full IR goal or legacy retention boundary.


### Measured prerequisite correction — genuine three-block rejection owner (2026-10-05)

This addendum preserves the preceding plan and replaces its conditional single-block shape assumption with the actual typed IR. It advances architectural readiness only: **the bounded producer design is ready for root's narrow ownership/release decision; no producer implementation or productive rejection execution has occurred.** Root still owns reconciliation of the held authoritative-preparation/driver-output-planning slices, and dependency delivery remains separate. The earlier NOTREADY conclusion correctly described the then-missing capture; it must not be reused as a claim that capture remains missing now.

The corrected explicit-include probe genuinely collected one case (child32686, exit0) and ran that one case (child32713, exit0, 7.820586s), under Node25.9.0/Vitest3.2.4. Its spies called each original producer/preparer exactly once, captured the typed function before the original transform, and retained that transform's `null` and the real `body-shape-rejected` preparation failure at entry.ts:1:1/declaration0..97. No accepted packet was injected. The exact97 source remains SHA256 `94b33355141949ce931730767308505fb55744cd3fc79c5b68724b94101db9c5`.

Raw evidence is in the main-native worktree `3525-mixed-presentation-main-native-20261005/.tmp/zero-suspension-producer-probe/prepared-include-only/`; the parent `review.json` is 19106 bytes, SHA256 `5549d7cab79a500cb8017b0414a5311ef58b857fca399eead96fd000c94e33df`. Independent review checked all 56 saved artifact pins, the single collected/actual name, passed status and empty failure messages, actual child exits and full stdout/stderr, and byte-equal 7672-row before/after-collection/after-body custody vectors. This proves the observation and original refusal, not new helper acceptance or Promise rejection behavior. Full-depth inspection establishes data shape, not exhaustive alias identity.

The superseded broad-discovery attempt is retained: `mergeConfig` concatenated test includes, produced no typed-owner capture, and had an unknown discovered population. After the user's explicit stop authorization, only the verified owned processes31240/31243 were terminated; child/outer exit143 and restored custody are preserved. Neither its elapsed work nor its unknown test population receives semantic credit.

#### Exact closed matcher and helper correction

The authentic owner has one f64 parameter, one f64 result, `funcKind: async`, exported true, valueCount6, no asyncPlan, no slots, and exactly three blocks. All block argument/type arrays and both branch argument arrays are empty:

1. Entry block: f64 constant0, `f64.lt(parameter, zero)` producing the explicitly Boolean-branded i32, then `br_if` of that exact result to two distinct terminal blocks.
2. True arm: actual `const null` whose constant carrier **and** result type are `val:externref`, then `throw` of that exact value with null result/resultType, then `unreachable`.
3. False arm: f64 constant1, `f64.add(parameter, one)` with f64 result, then return of that exact result.

Implement a private final fallback in `src/ir/async-prepare-ir.ts` (dispatcher ~646–658), after all existing families have declined. Match this complete finite topology and exact opcode/type/use relationships. Preserve existing dispatch order and all existing arms. Resolve actual branch targets against the function's block array and verify valid/distinct target indices and corresponding block IDs; do not match by names, source digest, incidental SSA IDs, or unit ID spelling. The proof may accept alpha-renamed value IDs satisfying unique definitions, valid valueCount and dominance/use relationships. Reject extra instructions, extra blocks/edges, branch arguments, slots/captures, pre-existing asyncPlan or unproved carrier/type/terminator variants in this new fallback. Existing families can still accept their own supported forms; this is not a global new rejection gate. Keep constants0/1 and the observed comparison/addition form closed for this increment; broad numeric-expression, arbitrary throw-value, await, catch/finally, loop or generator coverage is not inferred.

Create the already-planned ordinary derived helper with **all three original blocks and their complete instructions/terminators preserved**, rather than flattening them, rebuilding AST code, inserting an await, or fabricating an async `reject` terminator. Preserve original parameter/result types and values, valueCount and source-owned metadata through the established derived-function convention; change only the derived unit/name, regular function kind and non-exported status. Use `createDerivedIrUnitId(parent, ir-async-state, ordinal0)` and authentic producer provenance. The outer owner retains its source identity and existing async-plan replacement convention. Its single state calls this genuine helper with the authentic parameter and resolves the returned f64 using the established canonical Promise ABI and number bridge; allocate a fresh state result without colliding with any actual value IDs, and bind the complete state value table. Retain the existing runtime intents/features, empty spill/handler contract, and owner/derived-unit population checks.

The same original helper executes either the throw or return path. There is no second evaluation, synthetic null conversion, extra scheduling turn, late tag registration, or caller-supplied success packet. The exact source has a pure parameter/comparison/constant path; it does not establish a general once-only side-effectful operand lowering family. Preserve that distinction in tests.

#### Source-established lowering and rejection joins

The three-block helper is supported by existing source, without a backend or lowerer edit: `src/ir/lower-generic.ts:3520–3601` emits an empty-result structured if from `br_if`, requires empty edge arguments, lowers each actual target block, restores per-branch materialization state, and handles return/unreachable. The function tail adds the existing polymorphic unreachable when needed. At ~2769 the ordinary throw loads the already-externref null and uses `ensureExnTag`/`emitThrow`; no boxing assumption is needed for the observed carrier.

The existing physical-plan/consumer reservation chain described above binds that exception tag to both ordinary helper emission and the prepared frame. The frame adapter accepts the authentic helper call and resolve state, including its real binding/signature/index; explicit async-plan `reject` remains unsupported and is not emitted. `prepared-async-frame-engine.ts:309–322` executes the helper within its real tagged catch and passes the unchanged externref reason to the existing rejection capability. Its entry creates/stores the Promise before calling resume and returns that same Promise. Normal return takes the existing f64-to-Promise number bridge. These source joins justify implementing the finite producer; **they do not substitute for actual deep verification, C acceptance/emission or null-rejection observation on the new candidate**. If any join fails after implementation, retain the genuine located failure and return to root; no implicit provider, C, frontend or runtime expansion is authorized.

#### Narrow dispatch proposal and acceptance boundary

Root can now reconcile/release precisely one producer subsection in `src/ir/async-prepare-ir.ts` to a Sol6.1 Medium writer, and independently claim only the new `tests/issue-3525-prepared-zero-suspension-rejection.test.ts` for a second Sol6.1 Medium writer. Root alone owns the eventual single existing97-refusal expectation update and issue/integration changes. The current docs claim authorizes this appendix only. No additional source file, allowance, new production module or blanket held-slice takeover is implied. Both production tasks must preserve peers' edits and await root's explicit canonical scope decision.

The prior acceptance matrix remains required: unchanged97 source/native/legacy/prepared original helpers; actual cross-realm Promise; no synchronous throw; exact null rejection for negative inputs; native-equivalent f64 fulfillment including NaN/infinities/signed zero; immediate handlers, caller-before-reaction ordering and alternating fresh/retained-instance health. Add structural controls for wrong branch target/use, changed null carrier, extra effects or branch arguments, invalid result/parameter type, and malformed derived provenance, each paired with the genuine newly admitted witness. State which real verifier/producer/consumer rejects each negative; an earlier refusal cannot be claimed as coverage of a later guard. Any source variant already supported by another family retains its actual behavior. The auxiliary counted-argument/nonasync Promise-return caller is still not known admitted and must not silently widen implementation scope.

Implementation evidence must show original typed owner → authentic derived helper and one-state plan → actual acceptance/emission → private finalization → original helper Promise result/reason. Inspect complete helper CFG/ABI/tag joins and preserve source inventory/derived ownership; do not assert acceptance from a test count or source inspection. Maintain original mixed, scalar/Boolean, early-return and separate Linear no-adapter controls. No predicted test denominator, general rejection-family support, performance equivalence or retirement permission follows.

The finite C1 finding is unchanged: the sole proposed production file has no occurrence in the current authority, so no pin/recipe/authority reseal is justified. All historical inputs and current guards remain. Producer source pins captured by the probe match the reviewed0989/091 versions; the architectural correction changes no source bytes. Applicable native/ordinary/normal publication gates remain required on the actual coherent candidate, with no automatic replay of unrelated historical suites solely because this plan became ready.


### Root's finite producer continuation and independent test release (2026-10-05)

Root has now explicitly released local implementation of the measured three-block family under the user's sole-IR-session and maximum-parallel-work authorization. This supersedes only the preceding requirement to await root's narrow production release; it does not release broader preparation, provider, consumer, frontend, runtime or driver work.

- Source claim `3525:zero-suspension-producer-20261005`, owner `ttraenkler/codex-zero-suspension-producer-20261005`, isolated branch `codex/3525-zero-suspension-producer-20261005`: **only** the new final fallback and dispatcher subsection in `src/ir/async-prepare-ir.ts`, following the measured CFG specification above. Existing families, public signatures and other files remain outside that writer's scope.
- Independent test claim `3525:zero-suspension-tests-20261005`, owner `ttraenkler/codex-zero-suspension-tests-20261005`, isolated branch `codex/3525-zero-suspension-tests-20261005`: **only** new `tests/issue-3525-prepared-zero-suspension-rejection.test.ts`. Root reported both new canonical claim effects verified and released the Sol6.1 Medium writers. This architect records that root authorization; the earlier claim snapshot is not retroactively presented as containing these later records.
- Root alone serializes the old97-refusal expectation update, integration and publication after actual predecessor delivery. The queued PR6497 candidate remains immutable; no current queue observation is delivery evidence. Independent review will use the actual frozen producer/test patch, meaningful controls and recorded runtime outcomes, not this release as acceptance proof.

Fresh saved canonical snapshot `3525-mixed-presentation-integration-20261005/.tmp/mixed-presentation/next-claims-fresh.stdout` reads `ref_read: ok`, tip `3396d912cc3dc61476ff118575f0c11213f97160`, 2722 records/883 held. It preserves `3518:authoritative-preparation` and `3518:driver-output-planning` for `ttraenkler/astra-ir-program-a-20260905`, and `3518:semantic-runtime-producers` for `ttraenkler/astra-ir-producers-b-20260905`, all in progress on their historical branches. Root's decision is a narrow continuation/rescope for this exact subsection, not abandonment, forced release, blanket takeover or an inference that those held records disappeared.

The read-only ownership report in the main-native worktree `.tmp/zero-suspension-producer-probe/ownership-review.json` is 9804 bytes, SHA256 `f8016eb7a1ffe314a8d5b306f41be3084f55d7f3be938545f00511b273a4f059`. Its local `18eb24e9` claim view remains explicitly cached; the fresh root snapshot above supplies the later held-record observation. Published091's five changed paths are the issue, compiler.ts, presentation leaf, mixed test and existing pipeline presentation test. Neither the released producer file nor new test overlaps those five paths. Conceptual preparation/semantic-producer ownership overlap is expressly resolved by root's narrow decision; driver/output files remain untouched. This file-disjoint development does not assert independence from the queued predecessor's behavior or waive main-delivery sequencing.

No C1 input change, reseal, allowance, predicted passing denominator, benchmark credit or legacy-retirement permission is granted here. Architectural review remains confined to the frozen new fallback's whole-input match, real derived ownership, unchanged helper CFG/tag/Promise joins and paired genuine controls.


### First coherent rejection run — genuine legacy discrepancy, bounded acceptance correction (2026-10-05)

The frozen producer `fca4ba2a058cb07b40ce8149f1514a7e291da60f5cdceea495525bb88a986f07` passed independent structural review of its two complete reciprocal edits and 39 saved evidence pins. The initial new regression suite `308ff49e0c3b2a9f38158170cbdd1ff779da22fab6af95700a0ac7c54432661d` then actually ran six cases: **five passed, one failed**, direct child40073 exit1. Full 7671-row before/after custody is exact. This is not a successful full-suite result. Its raw evidence remains in the zero-suspension tests worktree `.tmp/zero-suspension-tests/joined-attempt1/`; `attempt1-reviewed-receipt.json` SHA256 `8ef39d7117610cc8493285425fd757c7d23e87ba0cb936b2930c1687e54a5cb3` binds the actual rows, errors and six raw artifact pins, independently checked here.

The failed row reached the native observation and completed the prepared ORIGINAL generated-helper comparison at line186 before failing at the separate legacy-helper comparison at line190. Native and private prepared paths had matched the unchanged97-source nine-call/ordering observation; this first recorder retains that through source order and the completed await assertion, not an independent saved prepared-child result. The public legacy compile succeeded, but its ORIGINAL generated helper synchronously threw on the first negative input (-1). The first observation harness discarded the caught reason, so the thrown value and all later legacy outcomes are **unknown in this attempt**. Do not call this a harness false failure, infer that the reason was null, or transfer the earlier source smoke's results to this legacy arm. The remaining five producer/provenance/detached-emission/legacy-generator-poison/near-miss/Linear-control rows passed as actually recorded.

Architectural assessment: the proposed finite split is valid because the combined all-three-runtime comparison was a new, unlanded assertion whose presumed legacy behavior is now disproved. The required native↔private prepared Promise/rejection/order test remains fully enforced on the exact source and original generated helper. The legacy behavior is an actual counterexample against the larger parity goal, not a reason to modify this producer or expand into public legacy code. Preserve the original failing source/test/receipt and record that **legacy rejection parity remains OPEN**. No existing established gate may be weakened, skipped or reinterpreted as passed, and no permanent passed test may require legacy to remain broken.

For the corrected new suite, name the productive row accurately as native↔private IR semantics. Keep all exact-null rejection, real cross-realm Promise, no synchronous escape, special-number fulfillment, ordering, repetition and genuine provenance assertions. The legacy compile and DTS comparison may remain a separate artifact-only assertion if actually executed and true; the failed first run stopped before DTS equality and therefore provides no DTS-equality credit. Artifact equality must not stand in for legacy runtime equality. A separately authorized seven-outcome legacy diagnostic may capture synchronous throws versus genuine Promise settlements, exact observable reasons and healthy positive branches using the unchanged source/helper. Preserve each outcome, including failures, without aborting the record on its first discrepancy or normalizing values. Add a positive-only legacy comparison only where those actual observations support it, and label its denominator and excluded failing branches explicitly; it cannot discharge the open rejection criterion.

This correction changes the finite checkpoint's acceptance claim, not the full migration goal. The producer remains eligible for coherent testing/integration after the corrected new suite and applicable regressions pass. Public legacy repair, full parity and retirement remain unapproved and incomplete. Root alone owns the serialized old97-refusal expectation change after predecessor delivery. No source, C1 authority, runtime gate, fixture source or publication was changed by this architectural review.


### Subsequent seven-outcome legacy diagnostic — observed carrier mismatch (2026-10-05)

A separate completed diagnostic now resolves the preceding attempt's unknown legacy outcomes without rewriting that historical record. The unchanged97 source was compiled through the actual public legacy route and invoked through its ORIGINAL generated helper. Observer child40496 exited0; helper child40518 status0. All seven ordered raw outcomes and complete 7671-row before/after custody (including the lockfile) were retained; independent review checked all 19 raw artifact pins and the actual rows/terminals. Diagnostic success means observations were recorded successfully, **not that legacy met async semantics**.

| Input | Actual legacy helper outcome | Genuine Promise |
| --- | --- | --- |
| -1 | Synchronously throws direct JavaScript null | No |
| -Infinity | Synchronously throws direct JavaScript null | No |
| -0 | Raw number 1 | No |
| 0 | Raw number 1 | No |
| 2 | Raw number 3 | No |
| NaN | Raw number NaN | No |
| +Infinity | Raw number +Infinity | No |

The two caught reasons satisfy exact null identity and are not WebAssembly.Exception instances. All five normal returns have JavaScript `typeof` number; zero of seven invocations returned a genuine Promise. Meanwhile the actual generated declaration says `Promise<number>` and export-signature metadata says `promise`. Thus even the positive branches have a Promise-carrier mismatch; matching numeric payloads alone cannot establish native↔legacy runtime parity. Preserve this discrepancy as OPEN, including both rejection timing and fulfillment carrier, without requiring legacy to stay broken in a passed test.

Evidence: zero-suspension tests worktree `.tmp/zero-suspension-tests/legacy-diagnostic/review.json`, 8114 bytes, SHA256 `976bc695ebbe779b005dee353953bae46ca1b745bb9b8439cec0034489d12f7b`; original helper, instantiated binary, exact source, observation script, raw rows and child outputs remain beside it. The initial `308ff49e` test and 5/6 failed run are preserved separately. Native↔prepared nine-call/order comparison completed within that initially failed row; this diagnostic adds no new prepared-suite passing credit. The root-authorized correction of the new unlanded comparison retains native↔prepared runtime assertions and limits legacy comparisons to actually checked compilation/declaration metadata. A fresh complete corrected suite remains required. No public legacy fix, producer defect, complete equality, retirement or delivery follows from these diagnostic rows.


### Implementation Plan — authenticated current SourceOrigin epoch after delivered dependency composition (2026-10-05)

This is a measured integration blocker caused by incoming canonical main, not a change in the zero-suspension producer's pin domain. The earlier finding that the sole proposed `src/ir/async-prepare-ir.ts` change has no C1 authority intersection remains true. Actual composition with main `baf9e72c6b753fb1b3cc2f970c4dc7ee3e101f64` introduces a separately pinned SourceOrigin type extension from upstream ListFormat work. The current full-pin guard correctly refuses it. No guard, historic fixture or expected-failure assertion is to be relaxed.

The first composed507 ordinary run actually ended child46057 exit1: 377 passed/130 failed, with 196 non-C1 cases passing and C1 181 passed/130 failed. The independent runtime reviewer reports124 failures explicitly naming the SourceOrigin pin; six diagnostic-priority failures have truncated actual full-pin messages and must not be assigned a missing pathname by inference. Preserve the original complete result and failed first attempt. Receipt `.tmp/zero-suspension-integration/validation/full507-reviewed-receipt.json` in the integration worktree, SHA256 `43e092b2dfde11d3a67a8a963db749bbc260e9010a6044a0a8e57851e8706552`, is the separate actual runtime review; this architectural section does not reclassify its failed cases as passes.

#### Complete immutable source-domain comparison

Against authentic local Git objects0917270→baf9e72, the current manifest contains100 distinct short repository path spellings after including its three root configuration files. Exactly88 are existing files on both trees; twelve are directory or deliberately absent resolver probes. Enumerating all88 modes/blobs finds exactly one changed file and no mode changes: `src/shared/contracts/source-origin.ts`. The other27 incoming changed paths do not intersect that actual88-file domain. This comparison reads committed objects, never a physical fault-test checkout. Own evidence is `.tmp/zero-suspension-spec/source-origin-epoch/domain-comparison.json` plus saved authentic source streams and baseline manifest.

The changed source has one exact UTF8 replacement at offset261:

- Old span32 bytes: `  | "iterator-statics-prelude";\n`.
- Current span62 bytes: `  | "iterator-statics-prelude"\n  | "intl-listformat-prelude";\n`.
- Historical full source689 bytes, SHA256 `cc8e05036afdaca04c3e7055ad22f82c57f6e2e31b7e49a69e9081823c2eacde`, Git blob `7d9e62164db0594b761ea88eac9a07ac2d142f73`.
- Actual main full source719 bytes, SHA256 `cb199a6040c361256dc244d4e4e8183490524a0ee9505920a660e34eea3cc9b4`, Git blob `d6d98de15c656d3ecb32653b447b31486d3b9f05`, mode100644.

Whole source inversion and forward replay are exact. This adds one legitimate `CompilerSourceProducer` union member and leaves both origin interfaces unchanged. The current manifest occurrence is `linearOptions.closureInputs[8]`; resolver request10 and observation32 retain the same path. SourceOrigin is an **extra closure authority input**, not a member of the46 historical population. Keep actual719 bytes in the closure and real type resolver. Do not inject its predecessor into `historicalPopulation`, manufacture a population row, or assert it is in `observedCurrentPins` (that array records the captured population, not extra closure inputs).

#### Narrow implementation ownership and read/validation sequence

After root's explicit fresh canonical claim and closed physical fault window, a proof writer may own only:

1. `tests/helpers/ir-c1-historical-authority.ts` (H1): retain the complete `predecessorClosureInputs` record with its old689-byte pin. Extend the existing fixed-current `closureInputs` mapping (~515) for this exact path to the authenticated719-byte main pin. No permitted hash set, alternative accepted predecessor, dynamic source pin or changed resolver domain. All11 immutable authorities, seven artifacts, historical bases, historical population, declaration contract and other closure/config records stay exact.
2. `tests/helpers/ir-c1-current-source.ts` (H2): append a single SourceOrigin record to the existing `canonicalInputEpochs` table (~75–357), with the above full old/current pins and exact offset261 replacement. Reuse unchanged `beforeCanonicalCurrentInput` algorithm: authenticate primitive actual current source, validate span membership, reconstruct full historical bytes, authenticate old pin, replay all bytes and authenticate current again. Invoke it for SourceOrigin in the closure-validation loop (~821–845), after the existing full current closure pin and before real resolution. Keep the captured current string in `closure`; discard the reconstructed predecessor after proof because this input is not historical population. Existing current package/instructions/Boolean/layout/early-return transformations retain their exact inputs/order. No fresh healthy source may replace an injected operand, no reread/cache may hide a mutation, and no new exported API is needed.
3. `tests/issue-3518-c1-current-source.test.ts`: append independent fixed SourceOrigin controls and preserve all311 original registration bodies/names/order. Root alone owns the existing `independentFreeze` scalar update at final assembly; the writer must not self-certify its own helper or manifest. Existing LinearOptions declaration, resolver operation counts and path tables remain unchanged.

Root alone owns `tests/helpers/ir-c1-authority.json`, `tests/helpers/ir-c1-authority-root.ts`, and the unique external test scalar, plus issue/integration changes. This is a five-path proof consequence with the test divided into append-only controls versus root scalar. No producer, upstream SourceOrigin source, historical L0 artifact, policy receipt, prior source recipe or runtime body edit is authorized by this plan. Preserve all previous held ownership records; root's new narrow continuation claim is distinct.

#### Concrete assembly and authentic factory validation

There is an existing task-local data assembler: `3525-boolean-main-integration-20261005/.tmp/boolean-main-resume/assemble-authority.mjs`. Its real mechanism hashes physical H1/H2, replaces one closure pin, requires exactly nine permitted scalar differences, preserves every recipe/authority/artifact, then builds anchor and external assertion root. **Do not execute that old script unchanged:** it is fixed to predecessor695d and the Boolean closure path. Root must save a new reviewed task-local adaptation against actual current `15df36672c658dd96fd3e35a5ab0a538a6d1183eea1c2d618ee4e282d7cc97d0`, using closure index8/SourceOrigin and the newly frozen H1/H2, with the exact command and exit recorded in its assembly receipt. No checked-in general generator or imaginary one-command reseal is claimed.

Capture current baseline trio, all12 instrument streams and both authentic SourceOrigin Git streams once, with regular-file/mode and stable-identity checks; derive output in scratch before install. Exactly nine manifest scalar leaves may change: bytes/SHA256/Gitblob for H1, H2 and closureInputs[8]. All10 historical instrument recipes and the other10 instrument pins must remain byte/deep-equal, as must all11 immutable authorities, seven artifacts, historical population, declaration, config and resolver requests/observations. Independently execute full original reconstruction and forward replay for all10 unchanged recipes against the captured actual instrument bytes; equality of recipe objects alone is insufficient.

Use native pinned formatting with real repository filepath for scratch candidates. Authenticate whole formatted streams before deriving the manifest hash, then anchor bytes/pin, then the actual TypeScript AST unique string scalar. Decode and compare the entire independentFreeze object: manifest hash, complete anchor source and pin, unchanged declaration pin. Prove every test byte outside that scalar equals the proof writer's frozen candidate. Recapture full input bytes/modes/identity immediately before root's controlled install; no observer may treat a partially installed trio as an accepted epoch.

The actual existing factories are `captureC1HistoricalAuthority`, `captureC1CurrentPopulation` and `reconstructC1CurrentSources`; the full current-source suite invokes them with real readers and resolver IO. After assembly, use the repository's existing strict ordinary collection/body harness for that exact test file, retaining actual argv, direct exit, ordered names, raw channels, complete vectors and selected frozen epoch. This factory execution is required evidence: the new manifest must not be accepted merely because its JSON seal recomputes. No runtime test or assembly is executed by this architect spec.

#### Required meaningful controls and integration acceptance

A new independently written literal oracle must reverse/replay the actual SourceOrigin719 bytes to689 without calling H2's projector, compare full pins, and verify the real TypeScript resolver read retains the current union including the new member exactly once. The existing fixed thirteen resolution requests/fifty-seven filesystem observations and actual LinearOptions declaration/type proof remain; no old contract is broadened. Keep a fresh healthy capture before and after each negative.

Required cases cover stale historical689 supplied as current, missing/duplicate/renamed union member, unrelated source-byte mutation and primitive/boxed-string refusal before resolver activity. Test the actual authority-reader path because this source is not on the population channel; ensure an injected mutant is not replaced by a second healthy authority read. Successive captures must observe a warm mutation afresh. Use the established persistent-backup physical harness restricted to this one exact SourceOrigin path for actual missing/mutated-file refusal plus full restoration; do not read that guarded file concurrently from another lane. Assert the actual first failing guard and preserve earlier-error priority, without claiming a later branch ran.

The new fixed record needs malformed span/current-pin/old-pin controls only where a legitimate existing input seam exercises them; do not export a test-only capability or weaken the fixed manifest parser to make private branches injectable. Existing type/resolver/physical controls supply their genuine unchanged coverage. Test control names/counts are established by actual collection, not predicted totals.

Once this coherent epoch passes the current-source suite and its new controls, run the composed affected cohort against actual baf+producer+old-case update, with the former507 failure retained and a new denominator from actual collection. Root decides reuse of unchanged same-epoch cohorts from their declared inputs; no automatic historical991 replay or credit is inferred. Full normal gates remain required. These are current-proof repairs for an upstream legitimate union extension, not permission to retire legacy, claim full IR equality, erase the legacy async counterexample, or alter protected publication criteria.


### Root delivery and coherent integration state (2026-10-05)

PR6497 delivered exact0917270 via protected merge08952b0e, verified mainbaf9e72. Allfive final blobs/modes, both ancestry links and102 actual20host/82standalone execution/upload artifacts were authenticated; compiler composition preserves upstream ListFormat and the private finalization change. Six actual required merge-group contexts succeeded. Each lane has48735 unique verdict rows; host39594pass/8699fail/317compile_error/11timeout/114skip and standalone42054pass/4533fail/2016compile_error/18timeout/114skip. Regression baseline reports0pass→other, not complete semantics. Equivalence1748passes/22knownfailures and differential116matches/2mismatches/2runtime-errors with both actualexecutionexit1 remain explicit. Delivery receiptc6515eab26ac4adb0713153df2557fc43dd3f679eb1be33c5f2138642ebb4bd3. Only the three narrow mixed-presentation source/tests/integration claims were marked complete and verified on canonicalissue-assignments; parentR5/fullIR goal remains open.

The separate zero-suspension integration checkout merged actualmainbaf without committing; MERGE_HEADbaf is preserved. All28 incoming main paths match their exact blobs and modes, including ListFormat, extern declarations, SourceOrigin, classifier, reports and baselines. The producerfca4 and newtest368a remain exact. Root replaced exactly one obsolete97-source refusal case after dependency main verification, preserving the entire originalsource/digest and allother20cases: it now executes the ORIGINAL generatedhelper in a freshchild, requires two actualPromises, exactnull rejection and fulfillment3, and keeps the original acceptedemission healthy. Old mixed-test snapshot and full singlehunk remain in scratch; final mixedtest1a1ba683c39ff8999fbd37fdfb565b0386ae805b042d4dc80f24bf48efe2c434. Full507 firstcomposition is FAILED377/130 and retained;196nonC1casespass. Both modifiedtests typecheck. Refreshedmain17nativepredicates passed with originalIPCrefusal/samecommandretry retained; inventory1827, vocabulary148files/566sites, changedcodegen0 vsbaf. These successes do not certify currentC1 epoch, architectureclosure, fullparity or retirement.

Canonical newproofroot claim3525:zero-suspension-c1-main-epoch-20261005 plus file-disjoint3525:c1-source-origin-proof-20261005 and3525:c1-source-origin-tests-20261005 are verified. HistoricalA/B/current/historical-source holds are preserved. Sol6.1Medium owns H1/H2 helper proof in separate current-main worktree; another Sol6.1Medium owns append-only current-source controls in another. Rootalone owns manifest/anchor and external independentFreeze, final assembly and signed publication. All ten oldrecipes, historical46,11authorities/sevenartifacts and upstreamSourceOrigin719 remain immutable. No fixture replacement, guard bypass or publiclegacyfix is authorized by this epochrepair.


#### SourceOrigin observation correction and frozen helper review (2026-10-05)

The previous instruction to verify an “actual TypeScript resolver read” of SourceOrigin needs this precise correction. In the existing thirteen-request/fifty-seven-observation contract, request10 targets SourceOrigin but observation32 is **only `fileExists: true`**. There is no SourceOrigin `readFile` observation. H2's authority reader captures and authenticates its actual719-byte closure text once; the unchanged resolver subsequently observes existence. Tests must separately assert those two real facts. Do not claim a nonexistent C1 readFile callback or add one to the fixed domain. An independently constructed genuine TypeScript type-program may verify the current union member exactly once using the captured current text and its own declared read trace, clearly labeled as an additional witness rather than the existing C1 resolver trace.

The frozen H1/H2 implementation matches the bounded plan: H1 only maps the current SourceOrigin pin while retaining historical689; H2 adds the fixed canonical-input record and invokes the unchanged inverse/replay proof in the existing closure loop. It leaves current719 in closure, discards the proved predecessor, and does not alter historicalPopulation or observedCurrentPins. Full inverse/forward reconstruction against authentic baf Git originals is exact for H1's one span and H2's two spans; all other bytes remain unchanged. Primitive source and full current pin precede projection, the existing reader supplies the actual operand, and no healthy replacement/reread/cache was added.

Source freeze `3525-c1-source-origin-proof-20261005/.tmp/source-origin-proof/freeze.json`, SHA256 `c9a99b25f42e04966e47d38a9b2e6ab0a8c00d70f8c3aa6d503d4ee4884a73af`: H143568/`bde41448286e6c75affdd3575fe6483e52b9a1bda0c39f6fef48533d63f754f7`; H240958/`168d61a9472e91edc1d7a3ec1c80ad02c04d28f2faa693bc387040f56e2c236d`. These exact helpers are structurally approved for root's nine-scalar assembly and coherent testing. No productive factory, assembled-current epoch or regression success is claimed before those executions. Existing historical pins, all ten recipes and fixed resolver contract remain mandatory.


### Coherent SourceOrigin proof assembly and current-root test attempt (2026-10-05)

Astra independently approved the frozen H1/H2 source proof and the append-only thirteen controls; all original 311 C1 case bodies and names remain. Root prepared a task-local assembly against manifest 15df3667, with exactly nine scalar leaf changes and full inversion/replay of all ten unchanged historical instrument recipes. Candidate manifest is beb8cc55ab519aba4135338c854db06b48b78328bad7f9048e1c061098269328. The unique TypeScript AST independentFreeze scalar updates only manifest/anchor authority; every other test byte equals the independently frozen writer candidate. Productive factory acceptance and the composed ordinary test cohort remain unmeasured at this entry. Preserve the failed first 377-pass/130-fail attempt and public legacy zero-suspension counterexample. No legacy retirement or full IR equality is asserted.


### Coherent SourceOrigin runtime accepted; refreshed-main publication integration pending (2026-10-05)

The ordinary cohort actually collected ten files and 520 ordered cases, then passed all 520 with child54238 exit0 (158.3317s), no failures/pending/todo/JSON errors or RPC/unhandled/timeout channels. All 507 prior names/order remain; only the thirteen independently reviewed C1 controls are added. Full 7,680-file vectors including lock/config stayed byte/mode/identity exact. Independent reviewer receipt `1b79b81fcb822fc446e0cc101e2773cab13ed06c3f568baafefa6e072c5be4c2` is stored in the test writer worktree `.tmp/c1-source-origin-tests/coherent520-independent-review/final-review.json`. All28 incomingbaf files still match their authenticated Git blobs. The earlier 377/130 failed run remains preserved.

The native-coherent run completed all seventeen normal gates successfully. A scratch invocation of absent `tsgo` exited254; repository TypeScript7 `node node_modules/typescript7/lib/tsc.js --noEmit --project ... --listFiles` independently ended55627 exit0 across2,003 actual compiler files, including all three changed tests, with exact custody. No compiler or test failure was suppressed. Initial coherent520 scratch stopped at the required-runtime assertion before any collection/body child; the actual accepted epoch uses existing Node25.9.0 and a separate retained directory.

A purposeful fresh publication-base read found canonical mainadcd56f6c7c69e3cc2dff3fcd566006a38a23413 afterbaf. Its actual ten incoming paths concern npm compatibility reports, the bounded native-first runner and its regression/issue6851. Originalbaf acceptance is not automatically current-head evidence: root will commit the completed pendingbaf composition normally, integrate exactadcd and validate its measured changed dependency domain before publication. No new IR scope, public cutover, retirement or main delivery credit is asserted.


### Latest-main integration and publishable checkpoint (2026-10-05)

Signed checkpoint e113d147ec60a3060d6e7dfa0ecc2380a4f59046 contains the fully checkedbaf composition and this increment; Thomas author, Codex coauthor, exact model trailers and SSH signature were verified. Full normal hooks passed all four selected root files (356 cases) and ratchets, without bypass. Canonicalmainadcd56f6c7c69e3cc2dff3fcd566006a38a23413 then merged cleanly. All ten incoming main files match their authenticated Git blobs/modes; all nine feature files remained exacte113 before this documentation append. The independent full100-path C1 domain comparison is identical acrossbaf/adcd; no reseal is indicated. Receipt `da303031b354048a5b6c44a2034206b908d8794ec599308eacaa837c8061c741` records actual18 immutable before/current streams and complete dependency review.

The targeted postmerge ordinary cohort actually collected and passed13/13 across the new bounded-child regression, existing standalone independence and existing native-first evidence tests; raw error channels are clean and its complete fresh custody is exact. The immutable6/4/3 test name contracts were derived independently from real TypeScript AST declarations before body execution. Scoped lint passed. Preserve the earlier520/520baf-based IR evidence as scoped to that exact dependency epoch; the postmerge full custody is separately captured, not falsely equated across the changed scripts/new test. Current-main delivery of this successor, full CI and merge-group conformance remain pending. Root continues through normal merge hooks, fork publication and the protected queue; parent migration and legacy equality remain open.


## Implementation Plan — prepared WIT fidelity, capture-first phase (2026-10-05)

### Authority, ownership and release boundary

Root verified the sole planning claim `3525:prepared-wit-fidelity-plan-20261005`, owner `ttraenkler/codex-3525-prepared-wit-plan-20261005`, on the isolated same-named branch. This plan is appended to the complete525491-byte copied issue prefix, SHA256 `9879de10fe05a6948283ba7c475dcdaecbada4f7144ddf31979e36eac06abc3c`. That prefix includes pending PR6501 documentation and preserves its historical qualifications; it is NOT evidence that6501 source or delivery exists in this worktree. Source HEAD for this phase is canonical `4d42eec28e0aafbf242bb37150ca5ecac02136f0`. No earlier pending source/proof packet may be silently overlaid as its authority.

The authenticated decision brief is `.tmp/prepared-wit-plan/capture-decision.md`, SHA256 `984ba56f35b128294205f4fe59e7b4e610a833e2e3204068f844993cde16630d`. This release covers the hard plan and a root-assigned genuine finite capture only. Production leaf/renderer/compiler changes and durable-test implementation remain NOT RELEASED until the actual evidence establishes admission, defect and ownership. Root owns integration and canonical claims. No public default change, direct-generator fallback, source admission expansion, legacy retirement, performance claim or Component Model canonical-ABI claim follows.

### Existing path and source-grounded defect hypothesis

`src/compiler/ir-program-presentation.ts:277` rejects source maps, C ABI and optimization; it does not reject requested WIT. `runPreparedIrPipelinePresentation` in `src/compiler.ts:1138` already reaches the shared finalizer, whose WIT step at1401–1413 calls `generateWit(entryAst, {imports:mod.imports, types:mod.types, capabilities:capabilityRequirements, ...namingOptions})`. The actual code spreads naming options before the three authoritative module fields, so caller naming data cannot replace those fields. This is existing routing, not a missing enable flag.

The unresolved contract is completeness and accuracy. `src/wit-generator.ts:111–121` collects only direct exported function declarations. `functionToWit:418–440` consults annotation nodes, drops unmapped parameters, and conflates unsupported or absent return annotation with void. `export function twice(value: number) { return value * 2; }` is therefore a concrete inferred-number counterexample candidate: the checker and prepared ABI should describe f64→f64 while the current renderer predicts an absent WIT result. This remains a static prediction until the genuine prepared pipeline is observed. Alias/reexport omissions, normalized-name collisions and unsupported members must likewise be measured, not assumed to be admitted.

### Concrete finite capture matrix

Capture each source population separately on WasmGC-host and linear-host, paired with `wit:true` and WIT unrequested. Record an earlier refusal as its actual outcome; do not remove unsupported source constructs to manufacture a positive. The following literal subjects are probe inputs, not fixed production matchers or predicted passing counts:

| Population | Entry/source subject | Question and required evidence |
| --- | --- | --- |
| Direct annotated numeric | `export function twice(value: number): number { return value * 2; }` | Healthy comparison for full arity/result and physical f64 signature. |
| Inferred numeric result | `export function twice(value: number) { return value * 2; }` | Actual requested WIT result versus checker/ABI and same-source runtime. |
| Inferred/default parameter | `export function step(value = 2) { return value + 1; }` | Actual producer admission and default/omitted-call behavior; never assume this shares the explicit-parameter contract. |
| Boolean | `export function negate(value: boolean): boolean { return !value; }` | Logical bool versus branded physical i32, original helper true/false semantics. |
| Void | `export function finish(value: number): void { if (value < 0) return; }` | Genuine zero result, distinct from an unsupported mapping. |
| Local export alias | `function twice(value: number): number { return value * 2; } export { twice as doubled };` | Public external alias→source target→physical export census, or authentic first refusal. |
| Cross-source reexport | donor `export function twice(value: number): number { return value * 2; }`; entry `export { twice as doubled } from "./math";` | Source-qualified owner and external label without requiring a direct entry declaration. |
| Same-spelling donors | two modules each exporting `value(x: number): number` with different arithmetic; entry reexports as distinct `left` and `right` | No name-based donor conflation; actual ABI identity and outputs. |
| WIT name collision | `export function fooBar(x: number): number { return x; } export function foo_bar(x: number): number { return x + 1; }` | Measure actual identifier normalization and collision handling; do not assert a guessed collision result. |
| Exported numeric global | `export const marker = 1; export function inc(x: number): number { return x + 1; }` | Entire public population includes the global; output must not silently omit an unsupported public member. |
| Promise/runtime resources | unchanged genuine ORIGINAL_MIXED fixture, digest236fa7d9 and original three sources | Actual existing admission, callback/startup provenance, imports/capabilities and requested WIT handling; preserve any first backend refusal. |

For a healthy direct case, also request custom `packageName` and `worldName`, preserving raw option values and captured snapshots. Any invalid-name/keyword probe must retain the original request and actual renderer behavior. Do not turn absent resource population into a fabricated positive; identify it explicitly. Additional malformed callable types outside current source admission are not necessary to demonstrate a downstream WIT guard.

### Authentic instrumentation and evidence

Use real analyzeMultiSource→PipelineInput→private prepared entry, borrowing the existing non-registering setup pattern. Do not import a test module that registers unrelated suites. The isolated scratch Vitest configuration must replace include with the one intended observer file, not concatenate it via mergeConfig. Collect the intended observer before running bodies. All spies delegate to original implementations; no manufactured Prepared program, C token, physical module, adapter or renderer result is allowed.

Retain exact source text/hashes, source inventory, checker-derived logical parameter/results, unit and binding IDs, full original return/refusal, actual preparation/acceptance/emission events and emitted-plan receipt. For each public callable join export contract.externalName/targetId→callable source owner→emittedProgramBindingIndex→import-adjusted defined function→complete TypeDef. Preserve logical Boolean brand and zero-result void. Capture actual WIT text, errors, default/custom naming, module imports/types/capability requirements, binaries and original helper text. Prove the complete export population rather than a selected successful declaration.

For admitted subjects, instantiate the actual binary and execute the ORIGINAL generated helper against same-source native observations. Preserve Object.is numerical/special-value semantics, Boolean and void behavior, default arguments and actual Promise ordering where the source demands it. Legacy renderer text is a diagnostic comparison only: it can share the same defect and cannot be the sole expected-WIT oracle. These executions establish core-Wasm/JS behavior, not component canonical ABI. Capture source/module custody and original C-receipt health; failure of a prior C guard is not WIT-guard coverage. Save complete child exits, ordered observations, stdout/stderr and full declared input vectors; no green inference from successful compile or nonempty text alone.

### Conditional implementation boundary after capture

The intended leaf owner is only `src/compiler/ir-program-presentation.ts`: construct a frozen complete prepared WIT export view after existing source/ABI/physical joins, using inferred checker types and binding identity. The renderer owner is only `src/wit-generator.ts`: consume this strict prepared view through existing legitimate formatting while leaving legacy `generateWit(ast,...)` and public routing unchanged. A separate owner writes only proposed new `tests/issue-3525-prepared-wit-presentation.test.ts`. Root serializes the small `src/compiler.ts` handoff and this issue. These are prospective scopes, not active source claims.

The complete first contract covers every genuinely admitted public callable whose whole logical signature maps to number/Boolean/void, including inferred signatures and aliases/reexports actually supported by the producer. All params/results/exports must join exactly. Generated callbacks/startup exports are distinguished by authentic ABI/plan provenance, never a name-prefix whitelist. Unsupported public globals, Promise/carriers, source members or capabilities must produce a typed source-located requested-WIT presentation gap, not truncated successful artifacts. WIT-unrequested behavior and scalar/Boolean/mixed preparation remain unchanged. No synthetic AST, independently invented capability map or caller-injected trusted view is permitted.

Before source release, answer from actual capture: which aliases/reexports are admitted, which plan entries prove internal/generated ownership, which nonempty import/capability populations occur, exact inferred-type and naming failures, and where capability/view preflight can return the existing located presentation gap before publication. Then record precise helper/API names, mutation/receipt sequencing and concrete negative/healthy controls in a further append. Check actual final selected C1 source-domain intersections before claiming no proof consequence; never reseal merely because source changed. Root must preserve pending6501 SourceOrigin/provenance history and all6837 production/performance requirements. This phase is READY for measured capture and NOT READY for production implementation.


### Measured scalar defect and independent strict-renderer implementation phase

The first completed genuine requested-WIT scalar records now establish the defect on BOTH host backends. Independent receipt `.tmp/c1-source-origin-tests/prepared-wit-review/scalar-first-pair-review.json` in `3525-c1-source-origin-tests-20261005` is14289 bytes, SHA256 `3e3bef76f39ff31fde4253846dfcd5a7a069733ef8a474d10ab836093b172cab`. Annotated and inferred source checker signatures are number→number; real source/target ABI and physical signatures are f64→f64, with the actual export/target bound to function0. Annotated WIT correctly includes `-> f64`; inferred WIT omits the result on both WasmGC and linear. Four completed records each execute five values through native, ORIGINAL generated helper and raw binary:60 actual value observations agree on4,-0,NaN,+Infinity,-Infinity. This is a WIT fidelity defect despite correct numerical execution. Root separately inspected all eight paired requested/unrequested transactions and saved captureWT `.tmp/prepared-wit-capture/first-numeric-pair-root.json`. Neither fact asserts the full capture observer has completed, nor counts unfinished alias/global/Promise cases as passing.

Root has verified separate renderer/source/integration claims and now releases the PURE STRICT RENDERER phase independently. Its sole production file is `src/wit-generator.ts`; the renderer writer must not edit the leaf, compiler, public exports/defaults, runtime, producer, existing tests, policy or C1 authorities. Root records exact claim owner/branch at dispatch. The leaf's complete population and compiler handoff release still await the remaining capture facts and their next plan append. This measured phase supersedes the preceding production hold only for that narrowly claimed renderer implementation; no other production authorization is implied.

#### Frozen shared data and result API

Add these readonly exported types and `renderPreparedWit` to the existing renderer file. Reuse existing Import/TypeDef and PlatformCapabilityRequirement imports; use type-only IrUnitId/IrBindingId from the existing shared identity contract. These are descriptive data, NOT independently authenticating capabilities. Only the later private compiler handoff may obtain a trusted view through the leaf's authentic presentation accessor.

```ts
export interface PreparedWitExport {
  readonly externalName: string;
  readonly params: readonly {
    readonly sourceName: string;
    readonly kind: "number" | "boolean";
  }[];
  readonly result: "number" | "boolean" | null;
  readonly sourceFile: string;
  readonly unitId: IrUnitId;
  readonly bindingId: IrBindingId;
}
export interface PreparedWitView {
  readonly entryFile: string;
  readonly exports: readonly PreparedWitExport[];
}
export interface PreparedWitRenderOptions {
  readonly packageName?: string;
  readonly worldName?: string;
  readonly imports: readonly Import[];
  readonly types: readonly TypeDef[];
  readonly capabilities: readonly PlatformCapabilityRequirement[];
}
export interface PreparedWitGap {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
  readonly sourceFile?: string;
  readonly unitId?: IrUnitId;
  readonly bindingId?: IrBindingId;
}
export type PreparedWitRenderResult =
  | { readonly kind: "wit"; readonly text: string }
  | { readonly kind: "unsupported"; readonly gaps: readonly PreparedWitGap[] };
export function renderPreparedWit(
  view: PreparedWitView,
  options: PreparedWitRenderOptions,
): PreparedWitRenderResult;
```

`result:null` is exclusively authenticated logical void; it must never stand for missing/unmapped data. Preserve full params and all exports in their supplied authentic order. Source logical number renders f64, Boolean bool, void no result. Never inspect an AST or run type inference in this new function. Reuse existing default package derivation, source identifier normalization/keyword escape and output formatting where correct. Do not alter the ordinary `generateWit` behavior, including its current legacy limitations; whole original body behavior and existing callers remain unchanged. No source names/constants/fixture hashes appear in production admission.

The strict first contract requires the actual imports and actual capabilities arrays to be empty; it validates those supplied arrays and refuses nonempty populations rather than ignoring them or replacing them with []. Types are the actual module types and may be nonempty; they are not a second export authority. Render no unused source interface/record declaration. A nonempty capability/import population is `field:"wit.resources", code:"unmapped-wit-resources"`, associated with entryFile. Future resource expansion requires authentic ownership/representation, not a silent subset or best-effort resource string. This restriction affects requested strict prepared WIT only, not source admission or existing no-WIT/legacy output.

Validate the whole input and all names before producing text. A malformed runtime export view, invalid kind, missing result or duplicate external identity is `field:"wit.exports", code:"invalid-wit-export"`; never skip the malformed member. Invalid names use `code:"invalid-wit-name"`; normalized collisions use `code:"wit-name-collision"`. Use the relevant `wit.packageName`, `wit.worldName`, `wit.exports` or `wit.params` field. Preserve sourceFile/unitId/bindingId from the relevant row, and entryFile for option/resource gaps. Freeze returned gap arrays/rows and the result. No fallback to legacy rendering, generic exception for ordinary unsupported naming, callback dispatch, mutation of view/options/module arrays or invented empty success is allowed. Pure renderer tests with malformed data test only this function, not genuine C/provenance coverage.

#### Naming grammar and completeness

Root's authoritative reference is [the Bytecode Alliance WIT language reference](https://component-model.bytecodealliance.org/design/wit.html), identifier section lines76–90 and package section394–400 in the saved read. WIT identifiers use ASCII kebab words separated by single hyphens: the first word does not start with a digit, subsequent words may, and each word is all lowercase or all uppercase. Percent escaping handles keywords. Package names are namespace:name with optional valid semantic version. This grammar is supplied by root's reference read; it was not newly fetched by this author.

Preserve the existing source-name normalizer (`toWitIdentifier`) and default package helper, then validate the final identifier and collision population. Do not silently suffix public exports to hide collisions. Check parameter collisions within each function; export collisions across the whole view. Percent escape is lexical escaping, not a distinct underlying identifier. Custom world/package options must be validated as requested, including valid uppercase words, valid escaped keywords and supported semver prerelease/build forms; do not reject all versions, require all names lowercase, silently repair invalid raw options or guess a permissive injection-prone regex. No new dependency is released. Empty/invalid names, illegal separators and control/injection characters return typed gaps. The renderer must preserve legal default/custom output strings exactly and produce the same existing scalar text for healthy annotated input. Source/alias admission is a later leaf concern; renderer consumes all supplied rows uniformly rather than special-casing direct declarations.

#### Later private handoff contract, not yet this writer's scope

The requested-only leaf ledger will bind actual frozen presentation identity, original module/physical plan, complete module observation and frozen logical view after existing joins/metadata. No-WIT calls add no new snapshot/view work. An accessor must reject forged/cross-transaction/stale inputs through genuine guards and permanently invalidate observed mutations. The compiler constructs a private holder from that real presentation, never trusts a caller-created PipelineOutputContext view. Unsupported public globals/Promise source mappings become located requested-WIT gaps before detached begin; no plain finalization receipt authorizes an arbitrary copied module.

The finalizer will use its actual module imports/inventory and compute capability requirements ONCE before requested-WIT rendering, then reuse that exact object for normal adapter/explanation output. Naming/resource preflight occurs before final binary/WAT/DTS/helper artifact production, and its gaps return through the holder as `presentation-unsupported`. Genuine earlier C lowering/emission needed for source/ABI joins is not forbidden or counted as final artifact publication. A successful requested-WIT path missing preflighted text is an invariant failure; no hidden AST fallback. Public legacy and no-WIT timing/behavior stay unchanged. Full compiler/leaf implementation awaits measured remaining populations and explicit root release.

Current4d renderer is677 newlines/20673bytes, leaf1443/59011, compiler2125/99396. Existing issue allowance covers compiler, not leaf/renderer. Measure real formatted candidate/native LOC and function gates; no blanket grant, cosmetic line deletion or baseline change. Root's current/pending C1 domain inspections found no wit-generator/compiler current source pin; the leaf occurrence was historical inventory text only. No reseal is authorized by this renderer phase. Required evidence includes real focused native typing, scoped lint/format and independent frozen review; genuine pipeline behavior awaits coherent leaf/compiler integration. Preserve all prior failures and full parent migration/performance/retirement requirements.


### Completed capture population and implementable leaf/compiler contract

The full immutable4d capture is now complete: captureWT `.tmp/prepared-wit-capture/final-matrix.json`,600640 bytes, SHA256 `ca303a9f99f88c6d308950acdd777eb64765cc9510f85d8fdd86188795704a05`. Direct child83746 exited0 after68.760277s,46 discovery assertions/rows, with7659 declared input records exact and empty stderr/no suspicious channels. This is a successful observation run, NOT46 WIT-fidelity passes. It records36 artifact transactions (19 requested WIT,17 unrequested),10 preparation refusals,36 native/original-helper equal artifact transactions and72 child records. Primitive raw-binary values are separate from logical Boolean adapter semantics. Local Node25.9/Vitest3.2.4 is recorded; inherited configuration typing limitation TS7016 remains qualified. Earlier scratch attempts are retained, not retroactively certified.

| Actual population | Captured result and required implementation behavior |
| --- | --- |
| Annotated/inferred numeric, both hosts | Both genuinely admit and execute correctly; inferred WIT omits f64 result. Repair using checker-derived logical signature, never annotation presence. |
| Boolean, both hosts | Genuine prepared helper contract is admitted; preserve bool text and source/ABI/physical Boolean-brand joins. Raw numeric wire observations alone are not logical Boolean parity. |
| Local aliases/cross-source reexports/same-spelling donors, both hosts | Genuinely admit with real exports, but current WIT worlds are empty. Include their complete authenticated external alias population and source-qualified targets. |
| fooBar/foo_bar, both hosts | Genuine artifacts contain duplicate normalized foo-bar WIT declarations. Requested strict WIT must refuse with a collision gap; WIT-unrequested behavior remains unchanged. |
| Exported numeric global, both hosts | Genuinely admits; current WIT omits marker. Requested scalar WIT must give a located public-global mapping gap, never hide the global. The recorder's global type field is null; do not pretend that field supplied primitive-callable proof. |
| ORIGINAL_MIXED, WasmGC | Genuinely admits; native/original helper Promise result240 and phase1→3 agree. Current WIT renders a promise record and internal imports without a validated logical Promise contract. Requested scalar WIT refuses its Promise/resources before detached begin; no-WIT mixed remains healthy. Checker recorder kind other is not a primitive-Promise type proof. |
| ORIGINAL_MIXED, linear | Actual earlier preparation refusal: promise.capability.create missing linear adapter. Preserve this separate gap; no WIT mapping or backend expansion. |
| Default inferred parameter, both hosts/request modes | Earlier preparation type-resolution-unsupported/unresolved parameter contract. Preserve exact fixture/refusal and do not expand producer scope. |
| Original void-with-local, both hosts/request modes | Earlier preparation body-shape-rejected/unsupported tail FirstStatement. Preserve fixture/refusal. A separately root-authorized genuine explicit-return void probe may establish a positive later; it must not replace these records or be pooled into46. |

The renderer API frozen in the preceding phase remains unchanged. Root may now dispatch the narrowly claimed leaf implementation and compiler handoff against these measured populations; no producer/runtime/C/provider repair is needed or released. Prospective durable test file remains `tests/issue-3525-prepared-wit-presentation.test.ts`, independently owned. The conditional logical void branch is part of a complete scalar signature representation but has no positive credit from the original refused void capture; additional genuine evidence is still required.

#### Leaf owner — src/compiler/ir-program-presentation.ts only

Reuse capturePresentation, DeclarationCapture, joinDeclarations and checkAbiExports. Add ordered source parameter names to captures only when requested WIT needs them, preserving ordinary no-WIT capture/route behavior. The existing checker-derived params/results already establish number/Boolean/Promise/void classifications. Parameter annotation nodes are not an authority. Use actual source parameter names; do not manufacture an empty name vector or omit a positional parameter. A destructured/unmappable parameter is a typed WIT mapping gap if it reaches this domain, not a synthesized healthy declaration.

While the current checkAbiExports loop authenticates each `contract.kind === "export"`, collect each successfully joined source callable under its externalName. Use the existing alias-chain resolution and exact target/callable unit, actual emittedProgramBindingIndex, function import offset, real export descriptor and complete physical TypeDef. Fill every PreparedWitExport field from these real joins, including sourceFile/unitId and export bindingId. Preserve all distinct aliases of one owner and both same-spelling donor owners; never index the view by function spelling. Deep-freeze the view/rows/params after complete checks. Public globals and logical Promise signatures add `field:"wit.exports", code:"unmapped-wit-export"` with actual source/binding/unit association where available, before any successful view is registered. No-WIT mode does not acquire these new refusals.

The full physical-export reverse census remains unchanged. Callback/startup exclusions use existing authenticated plan/startup relationships only; names are not ownership evidence. The strict view must account for every public ABI export exactly once. Do not silently leave an entry out because the renderer cannot map it. Final requested-WIT admission requires actual zero imports and zero capabilities; mixed/ref-demand paths without that contract fail closed. Empty arrays are observed, never substituted.

Add `preparedPresentationWitView(presentation, module): PreparedWitView`. Its private requested-only WeakMap is keyed by the exact frozen successful presentation and stores original module identity, exact emitted physical plan identity, frozen view, and observeModuleData snapshot captured after existing source-owned export/async metadata installation. No-WIT calls allocate no new WIT ledger, view or snapshot. Check WeakMap membership before examining caller properties; require the supplied module to be the exact stored presentation.emission.module. Verify the snapshot and the genuine emittedPhysicalSetupPlan/emittedSupportFunctionReceipts guards before returning the stored view. Any observed mutation or genuine C failure invalidates that WIT ledger permanently; restoring bytes does not revive it, and only a new genuine healthy transaction is a counterwitness. Do not catch invariant failures into a mapping gap or reset C's existing poison.

A copied or forged presentation, another transaction's module or an arbitrary detached output is not authenticated. No plain structural finalization receipt grants authority. Requested Promise/global gaps finish before beginPreparedPresentationFinalization; the first strict scalar output requires the original module and no actual ref-demand transformation. No-WIT mixed detached finalization and its original receipt contract remain unchanged. Existing source snapshot machinery may be reused; no generic data/copy framework or new production module is justified.

#### Root compiler owner — src/compiler.ts only

Add a private optional holder constructed only inside runPreparedIrPipelinePresentation from its actual successful requested-WIT presentation. It carries that authentic presentation and later text or typed gaps. It is not a public trusted field in PipelineOutputContext, not a user callback and not a caller-supplied view. Ordinary public/legacy and no-WIT callers pass no holder.

Keep existing widening and native-first import classification order. For the admitted requested scalar path, widening must not alter the original module; immediately afterward revalidate via preparedPresentationWitView(actualPresentation, actualFinalizerModule). Use existing buildImportManifest/buildHostImportInventory results; compute buildCapabilityRequirements once for this requested-WIT branch from the real module/inventory/target. Pass that exact result and the actual module imports/types to renderPreparedWit. Reuse the same capabilityRequirements object in later capability diagnostics, explanation and adapter manifest. No independent empty-capability authority or second build is allowed. Legacy/no-WIT paths retain their late construction timing.

Call renderPreparedWit before final emitBinary/emitWat/DTS/helper production. On `{kind:"unsupported",gaps}`, populate the private holder and immediately stop finalizer artifact production. The private entry checks holder.gaps first and returns the original located presentation-unsupported variant, rather than exposing failed or partial artifacts. A successful requested-WIT path with no preflighted text is an invariant error. At the old late WIT branch use the strict text only for this holder; legacy callers continue the unchanged AST generateWit route. Exceptions remain genuine invariants; ordinary invalid names and unsupported mappings return typed gaps, not swallowed exceptions.

The zero-call assertion is specifically FINAL artifact encoding/rendering/helper publication after a preflight refusal. Source capture, genuine C lowering/emission and ABI joins may already have occurred. An observer's emitted phase or a diagnostic binary snapshot is not proof the finalizer encoder ran. Use original-call spies on real finalizer dependencies and retain genuine first-failure behavior.

#### Independent durable acceptance and integration limits

Preserve all46 capture inputs/results and earlier errors. The new suite must repair the measured inferred/alias/reexport cases across both hosts with full census/type assertions, original binary/helper/native execution, legal default/custom naming and requested/unrequested pairing. Collision/global/Promise requested refusals must be named and located; unrequested controls remain productive. Preserve default/old-void/linear Promise preparation refusals exactly without counting them as WIT checks. Add genuine admitted void evidence separately if available. Test complete params/results including no empty-result substitution; custom naming grammar includes valid uppercase words, escaped keywords and valid semver, plus illegal separators/control/injection inputs. No snapshots normalized to ignore missing exports are allowed.

Authority negatives use genuine presentations and distinct fresh transactions: forged identity, cross-module substitution, actual mutable metadata corruption, source/ABI/physical mismatch, mutation→restore permanent refusal, and a fresh healthy counterpart. Assert the real first guard; an earlier C invariant is not a local WIT guard result. Pure renderer invalid-data/resource cases remain labelled renderer-only when no genuinely admitted resource population exists. Capture finalizer call counts precisely on naming/mapping failure, freeze request naming before use, and prove original-module health and no-WIT allocation/behavior remain unchanged. Expected registration/pass counts are not invented before collection/body execution.

Renderer/leaf/root compiler/new-test ownership is file-disjoint from6501 producer/SourceOrigin proof and6837 production bundle; shared issue3525 and final source integration stay root-serialized. Revalidate actual selected main/dependency pins before publication, preserve pending6501 documentation history and all historical fixtures. Native source typing, focused real test typing, lint/format, actual LOC/function and existing affected prepared/WIT tests remain required. Measure any necessary leaf/renderer allowance on the actual frozen candidate; no broad grant or baseline rewrite. Full parent IR migration, output families outside this contract, legacy equality, Component Model canonical ABI and performance remain OPEN.


#### Final population and implementation dispatch clarifications

Root received independent full46 acceptance receipt `.tmp/c1-source-origin-tests/prepared-wit-review/full46-review.json`,63015 bytes, SHA256 `acba469d23d9394d52627da01ae45adf829cb7e4148c28009fe94c4b704aa94d`. It verifies46 ordered discovery rows,36 artifact transactions/10 preparation refusals,34 primitive and2 mixed-GC transactions,72 native/helper children,164 native+164 helper+158 raw observations and exact7659 custody. Boolean raw0/1 values deliberately differ from logical adapter booleans; those observations must not be pooled as identical scalar representations. Full async microtask/rejection ordering was NOT measured by this capture. The reported mixed result/phase milestones do not establish that broader ordering contract. Root also retained a separate eight-transaction numeric requested/unrequested120-observation verification; overlapping captures are not additional independent compiled populations.

An authentic zero-public-export census may render a valid empty world. Do not add a nonempty-export floor that rejects a genuinely prepared startup/internal-function graph with no public ABI exports. The forbidden empty success is an invented or silently omitted census. Test any zero-export claim with actual checker/ABI/physical/startup ownership, not a fabricated view presented as a prepared transaction. A user function named __module_init is still a user export when its ABI/source joins say so. Only the actual authenticated startup adapter relationship excludes a generated export; no prefix/name whitelist. Genuine numeric parameters fooBar/foo_bar may similarly expose a local normalized parameter collision and must not be silently renamed.

The separate auxiliary void observer initially established real preparation/ABI/physical admission for eight variants, then failed in its scratch native/helper launcher because its own children directory was missing. That ENOENT is retained and supplies no productive void-runtime credit. Root authorized only the scratch-directory repair and same observer rerun; the original refused void-with-local input stays unchanged and the additional rows never become part of46. This uncertainty does not block implementation of the already-measured inferred/alias contract or the renderer's explicit null-void representation. The source writer must wait until the capture worktree's active custody window ends before editing its owned leaf. No production producer changes are authorized.

The frozen renderer types/renderPreparedWit contract and preparedPresentationWitView accessor signature above are final for root's claimed dispatch. Leaf writer owns only ir-program-presentation.ts, renderer writer only wit-generator.ts, independent test writer only the new prepared-WIT suite, and root compiler handoff/issue integration is serialized. Root has already dispatched the renderer. No broader source/resource/migration release, public default change or claim override is implied. Implementation is reviewable now; future code and actual strict runtime/native gates, not this plan, determine acceptance.


#### Auxiliary void completion and explicit durable-test release

The preceding auxiliary uncertainty is now historical. Root and the capture owner report the unchanged auxiliary observer's repaired-directory second body completed: PID85616, exit0,22.820s, eight separate variants and16 native/helper child statuses0, with all7659 declared custody records exact. The immutable report is captureWT `.tmp/prepared-wit-capture/aux-final-report.json`,196010 bytes, SHA256 `e0ff70cda3281148a651ba4eb11bf5deb80a10892ef44bf10c4dcf759cc646fd`. Both `export function finish(value:number):void{return;}` and `export function finish():void{}` genuinely prepare on both hosts, requested/unrequested; checker void, ABI empty results and physical empty results agree, and actual native/original-helper/raw calls return undefined. Requested WIT is respectively finish(value:f64) and finish() with no result. Preserve the first ENOENT attempt and the original refused void-with-local fixture. These eight rows remain separate from the unchanged46 discovery matrix. This recorded evidence is root/owner-reported completion, not a new architect runtime execution.

Root confirms the capture physical window is closed. The leaf writer may now implement only its previously specified source file. Root additionally explicitly releases the independently claimed durable writer to NEW `tests/issue-3525-prepared-wit-presentation.test.ts` in `codex-3525-prepared-wit-tests-20261005`, subject to root's canonical claim effect verification. Its finite coverage is the measured inferred/annotated number, Boolean, admitted void, aliases/reexports, complete export and parameter census, normalized collisions, typed unsupported populations and genuine authority mutation/restoration contracts above. Preserve baseline failure artifacts and distinguish pure-renderer tests from actual prepared transactions; no fabricated AST/program/helper or producer expansion is authorized. The renderer API, requested-only leaf authentication and private compiler preflight contracts remain exactly frozen. Root owns compiler integration and any later measured budget adjustment. No publication, legacy cutover, full parity, Component ABI or performance acceptance is conferred by this dispatch.


### 2026-10-05 — prepared scalar WIT integrated candidate (delivery pending)

The privately selected prepared path now renders requested WIT from a complete authenticated source/checker/ABI/physical export view. Inferred numeric returns, local aliases, cross-source reexports, same-spelling donors, Boolean carriers, and separately admitted void signatures retain their logical public contracts. A genuine zero-public-export world is allowed; user `__module_init` remains public. Requested public globals, Promise signatures and internal runtime resources refuse with located typed gaps; unrequested behavior keeps the existing path. Final naming/resource validation runs before final binary/WAT/DTS/helper publication. The actual capability requirements are built once and reused. The public legacy AST WIT route, producer, backend scope and optimization/performance gates remain unchanged.

The source leaf is frozen at 63150 bytes/SHA256 `62074d12423b536045ef78289bd3c312b4320f7c621d406325abf0cc719c7562`. Astra's independent full inverse/replay approves only its measured native LOC allowance 1443→1552 (+109); the exact file is listed under loc-budget-allow above. No function, total budget, baseline or gate adjustment. Root compiler is 101227 bytes/SHA256 `2bed832f9d426f346c2ddba5ae1a0e5c51ea3523967ed09f0a7f2c42a9d5effd`; final strict renderer is 29831 bytes/SHA256 `290fb38dea41607829b1d7589acf2d36faa7381be4360576a80c79a8482240dd`. Independent compiler/renderer receipt `96b8ead5e96280bcf8353bd0e8b05d859670c11b5fbc1e6551b9c3d0a056bad1` proves complete inverse/replay and exact original legacy renderer prefix after removing only the new erased type import. Static approval supplies no runtime credit.

Root found the initial new renderer's keyword set omitted async/map and its default filename handling omitted some keyword escapes. The repair uses a prepared-only keyword set/normalizer; old legacy bytes stay exact. Bare custom keywords refuse, escaped names succeed, and actual source export `map(async:number)` plus keyword entry filenames are pinned in the genuine suite. Grammar authority: [Component Model WIT keywords](https://github.com/WebAssembly/component-model/blob/main/design/mvp/WIT.md#keywords) and [WIT identifiers/packages](https://component-model.bytecodealliance.org/design/wit.html). The renderer-only before/after observations remain explicitly separate from real prepared coverage.

The independently owned new test file is 40147 bytes/SHA256 `df4dbdf72bc3cfeb6c1dca5477364e23fed1c3b9ba3ac5a9842d63f4e6dd5471`. Final repaired native TS7, scoped Biome lint and Prettier each exit0 before actual registration. Actual collection67→body67/67, no fail/pending/todo, exit0 in42.160s, complete14868 byte/mode/device/inode/time custody identical. Its22 retained original-helper/native directories have44 actual successful child statuses, null signals and empty stderr. The original generated helper bytes are executed unchanged through the repository runtime. Numeric special values, Boolean logical versus raw-wire qualification, void, complete alias/source census, genuine C poison, foreign module identity, mutation→restore permanent refusal, no final encoder/begin on typed gaps, empty public population and the unchanged original mixed app are covered. Earlier source admission refusals and pure renderer-only invalid-data cases remain separate. Full async ordering is not claimed. The complete source/checker/ABI/physical census belongs to a separate genuine admission transaction; finalized artifacts are independently checked for actual WIT signatures/runtime values, not falsely described as the same transaction.

All failed observations stay preserved in worktree scratch: original46 discovery matrix (not46 fidelity passes), auxiliary void ENOENT before its same-observer repair, actual baseline6 WIT counterexamples, first61-case suite57pass/4 test-oracle failures, strengthened final67-case suite60pass/7 local snapshot/comparison instrument failures. The earlier second67/67 is its own distinct epoch; final repaired67/67 is the accepted suite. No production source weakening was used to fix those test instruments. Root's first coercion invocation used a nonexistent script name and failed; the correct existing check-coercion-sites gate then actually exited0.

Root transport proved all14862 tracked source/test inputs identical to the accepted worker epoch, excluding only this serialized issue documentation; all three production hashes and test hash match, and dependency links resolve to the same installed tree. In the root integration worktree, actual strict collection/body for the four existing affected files is128/128 with zero pending/todo, exit0, and all14865 custody records identical: mixed21, Boolean54, prepared presentation44, legacy WIT9. Whole native TS7 and the five LOC/function/coercion/oracle/dead-export gates pass on the candidate; normal commit/push hooks and protected queue admission remain necessary publication steps, not already claimed evidence.

Astra High specified/reviewed this hard slice; Codex GPT-6.1 Sol Medium produced the leaf, initial renderer and durable tests; Codex GPT-6.1 Sol High owns the compiler integration, prepared-only keyword repair, issue serialization and delivery. File-disjoint canonical claims 3525:prepared-wit-{fidelity-plan,fidelity-capture,source,renderer,integration,tests}-20261005 remain held for their actual named owners until verified delivery. Fresh canonical main was4d42eec28e0aafbf242bb37150ca5ecac02136f0 at the pre-publication read; the integration claim remains owned by ttraenkler/codex-3525-prepared-wit-integration-20261005. Pending6501/6503 documentation/evidence is preserved, and neither is silently counted as delivered. This candidate has no PR/main delivery evidence yet. Parent3525/3518, SourceMaps instruction provenance, unsupported WIT resources/canonical ABI, full equality, performance and retirement remain OPEN.

Final durable-test delta review: independent Sol Medium receipt `50a4fc021465071288a206652c0eb5ba049285e9a370c27ea6284eaf62e4b9de` approves the exact40147-byte test after local snapshots/comparisons were repaired. All substantive source census, runtime and failure guards stay intact. Structural restore inspection is a rendered-data comparison, not an exhaustive prototype/alias proof; genuine authority poison checks remain separate. No additional runtime execution is attributed to this reviewer.

### Zero-suspension delivery refresh against actual main2300 (2026-10-06)

Existing ready PR6501 became DIRTY as current canonical main advanced to `2300b9743e246c0ac668c913d7620be3c3896a80`. Root merges this exact Git object into published `04bf8998abc8256634b9d20dcaef795a69b160fa`, preserving existing scoped claims and the same PR. The sole conflict is this issue's empty ours appendix versus the incoming main WIT plan/evidence. Both parents' complete ordered issue lines are preserved, including the new WIT frontmatter fields and scoped budget. All54 incoming non-issue paths are byte-exact to main; all8 own source/test/proof feature paths remain byte-exact to the published head. ES2015, Redux and WIT changes are retained. Full content receipt is `.tmp/zero-suspension-integration/main-refresh-2300/merge-content.json`; the first contiguous-whole-old-issue assumption failed because legitimate frontmatter insertions interrupt it, then the independently measured ordered-line verification passed for BOTH parents. No test or gate was edited in that correction.

The actual current-merged-root ten-file cohort collected and passed520/520, direct child exit0, zero pending/failure/error signatures, with its full declared custody unchanged. TypeScript7, LOC/function budgets, oracle ratchet, coercion-sites, dead exports and issue integrity each returned actual0 on this candidate. These are freshly measured current-root results, distinct from the older baf/adcd runs; normal hooks, protected CI/queue and final main delivery still follow. This update does not retire legacy, widen the numerical async matcher, enable source maps or complete the broad migration.
## Implementation Plan — source maps, independently releasable recursive recorder prerequisite (2026-10-05)

This append belongs to **IR-only R5: whole-program single- and multi-source Prepared ownership**. Source authority is canonical `4d42eec28e0aafbf242bb37150ca5ecac02136f0`. The preceding issue text was imported from pending WIT PR6505 solely to preserve documentation history; it is not delivered source authority. This is a prerequisite implementation specification, not full Prepared source-map support, a production release, a passing-test report, or permission to remove the private `sourceMap` refusal. Root must verify narrow implementation/test ownership before dispatch. All broader migration, equality, performance and retirement criteria remain open.

### Established source and limits

The static origin-flow inventory at `codex-3525-source-map-origins-20261005/.tmp/source-map-origins/inventory.json` is 18504 bytes, SHA256 `4cbb8bff82c2c3413e8f16078b48f0688f61bbb5b74960601f6cb647b6a3b906`, and binds thirty actual canonical source files. `src/emit/binary.ts:689` records only instructions directly in `WasmFunction.body`; nested `encodeInstrArray` at 1080 calls the non-recording encoder. Nested `block`, `loop`, `if`, `try` and `try_table` bodies therefore lose otherwise-present `sourcePos`. Map emission already bypasses the instruction-array byte cache at lines 565–579. Do not change that predicate or claim a new cache optimization.

Initial runtime observations are still being independently completed: one genuine public default-IR multi-source WasmGC map has ten byte-boundary-matched top-level entries; single-source maps can be empty, and displayed filenames can miss `sourcesContent` keys. These observations do not certify complete public maps, nested mappings, or legacy-only behavior. Public `compile` defaults to experimental IR. The full capture and explicitly disabled-IR reference will be recorded separately, retaining all scratch instrumentation failures.

### Sole recorder implementation owner and interface

One source writer owns **only `src/emit/binary.ts`**. An independent test writer may own **only new `tests/issue-3525-recursive-source-map-offsets.test.ts`**. They do not edit the IR schema, producer, lowerer, `SourcePos`, map JSON format, source catalog, compiler finalizer, private presentation guard or existing source-map tests. Root owns any later integration. No new module, policy row, source budget allowance or C1 reseal is implied.

Retain exported `encodeInstr(instr, enc)` compatibility; a private optional recording context may be threaded through the existing single encoding implementation and `encodeInstrArray`. If the exported function acquires an optional internal parameter, do not expose caller-supplied source authority or a new public compiler option. Prefer a two-argument exported wrapper and private implementation if needed. The recorder receives the actual encoder position immediately before each real `Instr` opcode and the existing `sourcePos` on that object. Traverse every existing structured-body arm through this same implementation; do not create a second opcode serializer or estimate byte sizes from op names. Existing tag/function/local validation must still execute in both modes.

The map-enabled function encoder collects per-function relative offsets and adjusts them exactly once by the actual body-size ULEB prefix and the actual code-section prefix. It must not scan and re-adjust another function's entries or retain collector state across functions/emissions. Preserve local-group bytes, code count, body terminator and all instruction bytes. A shared nested array or shared instruction object used twice produces two mapping occurrences at different emitted offsets; object identity is not a mapping deduplication key. Nested traversal must use the current real body encoder, not a cached child buffer with offsets starting at zero. Keep no-map cache lifetime, local-frame checks and cyclic-DAG refusal intact.

This phase records existing source-bearing **Instr objects** only. Encoder-created `else`/`end`/catch markers and implicit fallback `unreachable` have no new invented source positions. The later full-origin contract must explicitly classify those boundaries and unmapped ranges; recorder completion alone does not meet that contract. Map-mode bytes before the optional URL custom section must equal ordinary emission bytes for the same module, and source positions must not mutate modules or instructions.

### Decisive recorder verification

The new suite must independently parse the actual code section and function-body length/local vectors and decode relevant instructions, not derive its expected offsets by invoking the recorder being tested. Cover real nested `block`/`loop`/both `if` branches, `try` catches/catch-all and `try_table` where the existing encoder supports them; distinguish pure encoding acceptance from engine support. Include unpositioned parents with positioned grandchildren, positioned parents/children, repeated shared nested arrays in two sites and two functions, multiple locals and body/section sizes crossing ULEB boundaries, prefixed and variable-length immediates, and sequential map/no-map calls. Bind each mapped offset to the exact emitted opcode bytes and supplied file/line/column, assert complete ordered multiplicity, and prove no header/local/immediate is falsely recorded. Preserve old top-level positions as a prefix/subsequence as appropriate, not a count-only claim.

For modules valid on the selected engine, instantiate actual ordinary/map binaries and compare behavior. Synthetic Wasm module tests prove the encoder contract only; they are not genuine Prepared-program coverage. Run existing binary/source-map/DAG/index-guard tests as required by changed-root selection, focused native type/lint/format and native budget checks. A deliberate wrong nested offset/missing branch in a test-local expected artifact must be detected by the independent verifier; do not patch production to manufacture a passing witness. Preserve all initial failures and actual runtime/engine qualifications. Public maps gaining valid nested rows is an intentional correctness change, not byte-identical JSON compatibility; ordinary binary/no-map behavior remains unchanged.

### Release boundary

This small recorder task can be independently claimed and implemented while full-origin capture/schema design proceeds. It must not lift `sourceMap` refusal, claim original-source fidelity, publish empty success for unknown provenance, or claim Prepared source-map completion. Full support additionally requires authentic source text/identity, instruction and terminator provenance, transform/codec preservation, both backend transports, generated-code classification, final emission coverage and C1 successor evidence for any actually guarded source schema edits. Those dependencies remain mandatory below and are not waived by landing this prerequisite.

## Implementation Plan — complete Prepared instruction source maps (2026-10-05; staged contract)

### Objective, authority and measured boundary

This implements requested source maps for the whole currently admitted Prepared-program domain, rather than a declaration-only map, a numeric fixture special case, or an unconditional relaxation of the private output guard. It preserves the same genuine source/checker preparation, runtime/provider admission, accepted program, complete emission plan and private artifact route. Previously unsupported producers/providers remain unsupported; source maps do not grant new language/backend capabilities. Public compatibility generation remains available until the parent migration's complete tested equality and performance requirements are met. No public-default switch, legacy retirement, Binaryen optimization release, C ABI release, or performance waiver is included.

All source analysis in this plan is rooted at canonical `4d42eec28e0aafbf242bb37150ca5ecac02136f0`; imported PR6505 issue text is documentation history, not current source. Root must select an actually delivered integration predecessor before shared compiler/presentation changes and compose its WIT preflight rather than overwrite it. The preceding recursive-recorder prerequisite can proceed independently under its narrower contract.

Static evidence establishes three separate losses: most typed instructions never receive an AST position; generic lowering and both Wasm emitters do not transport existing sites; binary recording ignores nested bodies. `CompilerSourceOrigin` in `src/shared/contracts/source-origin.ts` describes semantic generated-producer roles and spans, not user debugging positions. It is not a substitute for the new instruction source catalog. Exact source inventory evidence is the thirty-pin `4cbb8bff…` receipt cited above. Completed runtime capture findings and their limits are appended separately; neither old public empty maps nor normalized-name/null-content defects are acceptable fidelity oracles.

### Completed baseline capture: exact populations and non-equivalence

The genuine capture receipt is `codex-3525-source-map-capture-20261005/.tmp/source-map-capture/final-review.json`, 339651 bytes, SHA256 `bf3574475767a25e646c7be305f1c501eb662b77818feab3c68a151096f5da59`. The planner authenticated this complete receipt and directly read all eight requested-map records across default and explicit-legacy routes. It is discovery evidence, not a source-map fidelity test pass:

- Initial observer: ten registered rows, four passed and six failed because of the scratch `compile` import. This is retained instrumentation failure, not production failure credit.
- Corrected default observer: ten rows, eight passed and two failed because newly written malformed-source expectations were false. The eight ordinary paired cases contain six public artifact results/two actual multi-Linear compile refusals, four private no-map artifact results and four private requested-map typed `unproved-output-option` refusals.
- Separate explicit `experimentalIR:false` observer: eight rows passed as observations, with six public artifact results/two multi-Linear compile refusals. Its retained registration names still say public-default/private; the actual options and each record's `publicRoute` establish this route, and no private phase was rerun here.
- Separate raw characterization: both malformed-source map flags return public success despite actual TS1109, and original generated-helper calls catch `ReferenceError`. A process exit zero is not semantic success. These two rows are not added to an IR map acceptance count.

The three nonempty maps contain 25 actual mapped segments in total: ten default multi-WasmGC, ten explicit-legacy multi-WasmGC, five explicit-legacy single-WasmGC. All were independently matched to actual top-level opcode boundaries/bytes and exact source coordinates. This proves neither nested coverage nor all-instruction fidelity. Default single-source maps are empty on both hosts; explicit legacy single Linear is also empty. Both multi-WasmGC maps list `left.ts`, `right.ts`, `entry.ts` with all-null source contents although original input keys are `./left.ts`, `./right.ts`, `./entry.ts`. Do not silently repair the captured JSON or copy this defect into expected output. Multi-Linear public paths genuinely refuse unknown `left`/`right` calls at the retained source locations. Multi-WasmGC public helper and binary do not expose the requested donor export; calculated calls can match while the complete public runtime observation does not. All four private no-map transactions match their native calls. These are distinct existing public behavior limitations, not reasons to simplify fixtures or require Prepared code to reproduce wrong results.

Each list/body capture has 7666 declared input records equal across its window (1829 source, 5450 test, 371 script files, four hooks, lock included); raw malformed characterization has 7664 records. Thirty-two actual runtime children exit zero with empty stderr, but caught throw observations remain failures of the affected semantic comparison. The raw URL observer included the encoded string-length prefix; the final receipt independently parses the actual custom-section string and verifies `capture-source-map.wasm.map` on all six successful requested-map binaries. Preserve both the original observation and this correction. No names fidelity, complete transformed-source coverage, performance or public/Prepared equality is established.

### Fixed data contract: no source objects or invented origin authority

The schema owner extends the **existing `site` field**, which `passes/gvn-core.ts:103` already excludes from semantic value numbering. Do not introduce a parallel instruction `origin` field into the semantic key. Preserve every old no-map instruction shape and old diagnostic site literal. The explicit requested-mode contract is:

- `IrSiteId` remains compatible with `{ line, column }` diagnostic sites. Add an origin-bearing source variant with source ID, donor unit ID, analyzed half-open UTF-16 span, original half-open UTF-16 span, and optional bounded inline-call-site chain. Source variants carry the existing one-based diagnostic line/zero-based column, checked against the analyzed source. The map encoder receives separately derived zero-based original coordinates. Do not silently change the diagnostic convention.
- A generated variant carries a finite producing phase/role, actual owner or runtime-support binding, and optional genuine source cause. It may omit line/column (`line?: never; column?: never` in that variant); do not invent `0:0` for generated code. Existing optional diagnostic readers, including `runtime/intrinsic-preparation.ts:847–848`, must remain type-correct and retain their existing diagnostic fallback. Generated spans never become user mapping rows merely because they have a source cause.
- `TypedIrProgramInput` and `PreparedIrProgram` gain an **optional** `sourceMap` plain-data payload with an explicit inner version, proposed `prepared-ir-source-map-v1`. It contains a source-ID-keyed ordered catalog and complete origin-capture facts. Each source record binds the actual inventory source ID/source key, original input filename, emitted unique source name, original text, analyzed text and ordered frontend edit-stage evidence. Original/analyzed text are retained only when requested. An identity stage is represented explicitly; arbitrary `SourceFile`, checker, `PositionMap`, methods or callbacks cannot enter the frozen program or codec.
- Retain outer `prepared-ir-program-v1` compatibility when the optional payload is absent. Extend exact-field admission and codec reconstruction deliberately; an absent payload is omitted, not an own `undefined` property. If codec format/versioning cannot preserve old no-map bytes, stop for root review rather than silently invalidate every old packet.
- `sourceMap` presence requires origin coverage of **every live instruction, nested instruction and terminator**, not merely instructions with a `site`. Old diagnostic-only sites are insufficient. Every source span is a safe integer interval in the corresponding actual source text; donor and owner relations must join the inventory/derived-unit graph. Runtime-generated bodies join actual runtime support/ABI plans. Unsupported provenance is a located preparation/acceptance refusal, never an empty-success map.

Catalog identity is based on the existing inventory source IDs and normalized source keys, not basename matching or string replacement of `./`. Emit one deterministic unique source name per authenticated source ID; bind exact original text to that name at the finalizer. Preserve distinct same-spelling declarations and distinct donor files. Duplicate identities or conflicting text/name associations fail. Empty source files still belong in the source catalog even when they emit no user instructions; `sources` may include only actually referenced files, with one-to-one exact `sourcesContent`, while the private completeness proof retains the full catalog.

The catalog is trustworthy because the source/checker frontend captures it on the genuine preparation path and the actual private pipeline binds it to its source input. A plain codec digest is an identity aid, not proof that arbitrary replacement text produced a body. Decoder checks establish consistency and complete preservation of persisted data; external replay fidelity tests must compare with the independently retained authentic source/catalog/origin snapshot. Do not claim semantic source authentication for an arbitrary attacker-reencoded text/body pair without an external authoritative source binding.

### Frozen interface responsibilities before writer dispatch

Use these named internal seams (names may be changed once by root before dispatch, never independently by different writers): `capturePreparedSourceMapInput` belongs to the genuine source/checker preparation owner and returns the owned plain-data catalog; `assertPreparedSourceMap` belongs to program validation and checks complete IR/terminator/catalog consistency; `withSourceSite` is the builder/lowering scoped operation with restoration on both success and throw; `observePreparedSourceMapOutput` is the private presentation accessor that validates the genuine prepared/emitted pair and actual module before returning a readonly finalizer view. The accessor is requested-only and follows existing completed C receipt authentication, actual source inventory and complete physical census; a structural object copy is not an authentic presentation. It must not accept arbitrary supplied catalog/module arguments as replacements for the held authority.

The finalizer view contains the exact catalog/name-to-original-text association, the actual output module identity and its complete map-origin observation; it contains no AST, compiler callback, alternate instruction bodies or mutable allocation handle. For a mixed detached output, ownership derives from the actual one-shot begin/complete token and the unchanged original C module; revalidate the detached map observation after its permitted widening before encoding. Root alone joins this view into its private finalizer holder. Missing, forged, altered or foreign-module views refuse; no requested source map can fall back to the shared legacy source-content dictionary or a user-provided view. No view, snapshot or accessor call is created on the no-map path.

### Frontend capture and rewritten-source precision

The frontend owner modifies `src/ir/builder.ts` (constructor, scoped site context, `pushInstr:1448`, terminator setters), `src/ir/from-ast.ts` (actual `lowerExpr:4332`, statement/control lowering and function preparation), `src/ir/program-source.ts`, `src/ir/program-preparation.ts`, and `src/ir/program-prepare-ir.ts`. Root's driver forwards the explicit requested map mode into this capture; backend options alone currently do not do so.

Use a scoped origin context around actual checked AST nodes, restored with `finally`. A nested operand keeps its own smaller source span when lowering returns to an enclosing expression. Branch tests, loop conditions, assignments, calls, returns, throws and emitted control terminators receive their actual responsible node spans. Builder-generated coercions/materialization inherit the causal expression only when that attribution is true; compiler-only scaffolding is explicitly generated. A missing scope is an error in requested mode, not a fallback to the containing function declaration. Original implicit function returns are generated and distinguishable from explicit user `return`.

The source catalog must handle genuine preprocessing. `PositionMap.toInputOffset` clamps an offset inside a replacement to the original span start; that diagnostic convenience is not instruction-accurate source mapping. Root/frontend together add an immutable requested-only projection of the actual preprocessing stages: exact before/after text, validated ordered nonoverlapping edits and replacement bytes/lengths, plus genuine producer classifications. Validate each full forward replay and the composition order against the actual analyzed `SourceFile`. Unchanged regions map exactly to original spans. Generated insertions/replacements are explicitly generated or attributed to an actual responsible original expression span where the producer establishes that relation; an arbitrary anchor must not be called an exact token location. A span crossing incompatible edit regions cannot be silently shortened. Existing `CompilerSourceOrigin` can identify the responsible producer, but never supplies missing file/line coordinates. If a currently admitted preprocessing family has no faithful transformation witness, that family remains a documented source-map prerequisite to full completion; do not advertise the whole contract as done after identity-text fixtures pass.

Keep no-map calls on their current path: no original-text catalog, edit snapshots, origin tables, source-map validation walks or map-specific instruction copies. Existing diagnostic sites and allocation metadata remain as before. Small conditional dispatch is not a measured performance claim; record any actual cost when benchmarking is authorized.

### Program validation, transforms, codec and runtime-generated functions

Schema owner changes `src/ir/core/nodes.ts`, `src/ir/program/input-contracts.ts`, `src/ir/program/prepared-contracts.ts`, `src/ir/program/input.ts`, `src/ir/program/validation.ts`, `src/ir/program-codec.ts`, and the explicit projections in `captureTypedIrProgramInput`/`prepareTypedIrProgram`/codec reauthentication. For the new source-map payload, the existing plain-data admission plus its explicit shape validator must reject accessors, symbols, hidden unexpected keys, invalid maps/arrays, cycles and undefined optional fields before trusting origins; preserve the separate existing branded recursive-class-shape domain elsewhere in the program. Preserve existing body/allocation/ABI/runtime guard order unless an explicit new failure priority is specified and tested.

Transform owner modifies only measured provenance-dropping sites in `src/ir/passes/{constant-fold,gvn-core,dead-code,simplify-cfg,inline-small,monomorphize,tagged-unions}.ts`, `src/ir/async-prepare-ir.ts`, and `src/ir/async-linear-prepare.ts` as actually needed. Root serializes any overlap with a pending zero-suspension producer change. The program middle-end scheduler remains unchanged semantically. The origin rule is explicit:

1. A preserved/cloned instruction retains its immutable origin. Renumbering SSA IDs does not renumber source identities. Inlining retains donor positions and records the genuine call-site chain; it must not relabel the whole callee as the caller.
2. Constant folding records the actual replaced expression as the primary position; eliminated operands have no fabricated emitted positions. If an operation combines multiple causal sites, retain their bounded deterministic provenance in the prepared proof, with one explicit primary site for standard V3 output. Do not promise multiple independently emitted rows for eliminated instructions.
3. GVN keys and optimization decisions are unchanged by position data. A reused value keeps its real definition origin; new local loads/materialization at use sites are attributed according to the actual consuming use. Poison/GVN and allocation controls must still detect semantic defects. No origin-keyed dominance or analysis cache is introduced.
4. CFG cleanup, tail duplication and loop/branch restructuring preserve donor/user causes and explicitly classify synthesized control. Shared data may be reused only while immutable; no mutation of a shared instruction's site to suit one use.
5. Async lowering retains source spans for await, fulfillment, rejection, throw and source-owned helper bodies. State switches, frame slots, capability construction, scheduling, exception adaptation, startup and support callbacks are generated under their actual source/runtime owner. Do not label all callback instructions with the async declaration line. Pure runtime helpers with no user expression remain unmapped.

Validate complete source-map provenance at typed admission, after the optimization/async stage that can introduce or remove instructions, after codec reconstruction, and at backend admission. Verification walks are requested-only. Whole-program encode/decode/re-encode tests compare source catalog, complete nested instruction/terminator origins, derived ownership, ABI/runtime data and all existing invariants; old no-map canonical bytes remain exact. New fields must not disappear at `program-codec.ts:433`'s explicit object reconstruction. Codecs must refuse malformed source IDs/ranges, inconsistent text/coordinates, missing coverage and invalid derived ownership; authentic old no-map data remains accepted with maps disabled and is explicitly insufficient for map-enabled emission.

### Backend transport and physical coverage before sealing

Lowering owner modifies `src/ir/lower-generic.ts` at `emitValue`, `emitInstrTree:1184`, `emitBlockBody:3480`, terminator/structured lowering; `src/ir/backend/emitter.ts` and `lower-contracts.ts` for a minimal optional context; `src/ir/backend/wasm-lowering.ts`; and both `src/ir/backend/wasmgc-emitter.ts` and `src/ir/backend/linear-emitter.ts`. Use an optional source-map sink/context supported by the Wasm emitters, without requiring unrelated bytecode backends to manufacture positions. Do not use a dynamic proxy over emitter methods or duplicate the generic lowering algorithm.

A lowering scope is pushed for the actual IR instruction/terminator and restored around recursive operand emission. Every new physical opcode is attributed while created, including local gets/sets/tees, drops, coercions and structured expansions. Nested child instructions keep their own origins. An array shared by two emitted occurrences is immutable; repeated source positions are legitimate and receive separate binary offsets. No post-hoc flat walk assigning every op the enclosing declaration position is permitted.

For the full phase, extend the physical `Instr.sourcePos` contract minimally to distinguish three states: existing/source `{file,line,column}`; **explicit `null` for a proven generated/unmapped opcode**; absent for unproved provenance. Old legacy/no-map objects may continue to omit it. Only the authenticated lowering/runtime materializer supplies explicit null from a validated generated origin or genuine support-plan role; never convert all absent values to null in a finalizer. A requested full-map coverage walk requires every real instruction to be source-bearing or explicitly generated and verifies source positions against the bound catalog. This field is added before C completes its body/plan receipts, not patched onto an emitted sealed module afterward. `wasm/model/instructions.ts` is a real C1 closure dependency and requires the finite successor below.

`src/ir/program-consumer.ts` and the actual generated-body materializers own coverage for startup, frame/scheduler/callback and support functions not traversing generic lowering. Use existing ABI/derived/runtime plans to assign generated ownership and transport source-bearing helper instructions; do not infer generatedness from `__` names. Source-written `__module_init` is still user code if that is what the genuine ABI identifies. Reject an unclassified helper body rather than emit misleading mappings. Before changing generated-body files, enumerate actual writers/readers from the accepted plan; freeze that finite file set for root's claim review.

The ordinary C module remains unchanged after presentation. Mixed finalization uses its already-authorized detached module and the existing exact nullability-widening contract; source-map metadata must survive the copy without aliases to mutable original data. Receipt checking must include positions in the observed data and refuse changed/missing positions or catalog, not widen the allowed mutation set. No stale C capability is relabeled as authentic after finalization.

### Recursive offsets, unmapped ranges and final artifacts

Build on the preceding recursive-recorder prerequisite; do not duplicate its serializer. In the full phase, `src/emit/binary.ts` records actual source-bearing opcode starts and generated/unmapped boundaries, including serializer-created `else`, catch markers, `end`, implicit `unreachable`, and function end, as generated/unmapped boundaries; source-bearing explicit IR control opcodes retain their own genuine source cause. Do not invent an AST token for a serializer delimiter. Header/local-vector bytes and immediates are not separate user instructions. A generated boundary must stop a prior mapped segment from bleeding into unrelated code; the standard V3 representation is a one-field generated-column segment. Extend `SourceMapEntry`/`src/emit/sourcemap.ts` with explicit null source positions for that purpose while retaining four-field mapped segments. A public legacy object with absent metadata must not be silently recertified as fully classified; compatibility behavior and strict Prepared completeness are separate.

Offsets are actual absolute byte offsets in the emitted Wasm module, encoded as generated-column deltas on the Wasm mapping line, not instruction numbers or textual WAT lines. Validate safe integer ordered offsets inside the correct code/body boundaries, valid source indexes and zero-based source coordinates, signed VLQ limits, multiplicity and exact source text. Use actual section/body ULEB lengths; no estimates. Repeated instruction objects get entries per occurrence. Keep map-disabled cache/bytes/index validation unchanged. Custom sourceMappingURL is appended after the code section, so existing offsets remain valid; prove this by parsing the final delivered bytes and checking the actual custom-section payload.

Root owns `src/compiler.ts`, `src/compiler/ir-program-driver.ts`, and `src/compiler/ir-program-presentation.ts`. The private requested-only handoff must bind the genuine prepared program's catalog, accepted/emitted plan, actual output module and any mixed-finalization receipt; no caller-supplied map view or module substitution. The exact option/backend sourceMap intent must agree. Split the current combined guard so only the completed map contract is enabled; C ABI/unsupported optimization refusals remain. Source text/content/name preflight runs before publication of binary/WAT/helper/DTS/map artifacts, using the same finalizer authority and any delivered WIT preflight. Actual binary encoding necessarily occurs to determine offsets; an invalid map may fail after internal encoding but must return no successful artifacts. Do not claim zero internal C emission on such refusal.

Use the authenticated catalog for `sourcesContent`, not `input.sourcesContent` looked up by an unrelated displayed filename. The entire map must be valid and non-vacuous where genuine user instructions survive. A program genuinely containing only generated/startup code may have no user rows only after the complete typed/physical census proves that fact; empty success is not the fallback for unknown positions. Validate requested default/custom URL and actual absence when maps are disabled. The optional V3 `names` array may remain empty when no authentic symbol-name mapping is implemented; do not claim names fidelity from location coverage. Preserve helper/runtime/ABI bytes and behavior except intentional custom section/map data. No promise of byte-identical legacy JSON is made where the legacy map was wrong.

### Finite C1 successor: actual current inputs, historical proof retained

Independent literal-path census is saved at `.tmp/source-map-plan/c1-intersections.json`, SHA256 `8524f42b1d400a225c820d304dd05fae2b08e35cb75d9cad87da80627da06923`. It binds the current4d manifest `387432/15df36672c658dd96fd3e35a5ab0a538a6d1183eea1c2d618ee4e282d7cc97d0`. This is an exact manifest census, not a claim to have exhausted all imported historical-component authority reads.

These source edits have real authority impact. Current4d `tests/helpers/ir-c1-authority.json` includes `src/ir/program.ts` at `population.currentPaths[0]`; `src/ir/core/nodes.ts` at `dependencyPaths[6]`; `src/ir/program/input-contracts.ts` and `prepared-contracts.ts` at dependency indices 26 and 27. `src/wasm/model/instructions.ts` occurs in `linearOptions.closureInputs[6]`, resolver request 9 and observation 29. Facades and other actual touched contracts can add intersections; re-enumerate exact paths from the final candidate and every consumed fixed receipt, rather than guess from this minimum. The absence of compiler/encoder/producer literals from this manifest does not excuse checking imported relocation authorities.

Root alone owns a separately claimed finite C1 successor after source freeze: `tests/helpers/ir-c1-historical-authority.ts` (H1), `tests/helpers/ir-c1-current-source.ts` (H2), `tests/helpers/ir-c1-authority.json`, `tests/helpers/ir-c1-authority-root.ts`, and `tests/issue-3518-c1-current-source.test.ts`, plus any genuinely required current-component finite append identified by actual readers. Check the existing exact historical authority path in the selected predecessor before dispatch; do not create a substitute root file based on this prose. Preserve every historical immutable authority, old relocation receipt, original population and authentic reconstruction recipe. H2's current path at lines 790–821 authenticates full source pins before historical substitution; H1/linear closure also contains hard fixed pins. Simply changing a manifest hash cannot make these proofs truthful.

For each actually changed guarded source, record authentic predecessor/current whole bytes, modes and hashes and an exact bounded ordered UTF-8 inverse/forward recipe. The current reader consumes the supplied operand, authenticates that current whole pin, applies only the fixed inverse, verifies the entire old pin, and replays to the identical current string before invoking the unchanged historical proof. A supplied mutant is never replaced with independently read healthy contents. Real current types remain in the current TypeScript closure/resolver; reconstruction is only for historical proof. Descriptor/primitive and fresh-authority-first ordering, missing/corrupt file diagnostics, permanent poison and restoration counterwitnesses remain intact. No hash sets, broad repins, cached reads or arbitrary snapshots.

Root computes actual closure and resolver deltas from real native TypeScript resolution and preserves all unrelated observations; a fileExists event is not a readFile event, and an extra authority read is not an observed population row. New imports are admitted only with their real finite current closure proof. Assemble changed current instrument pins and full recipes from authentic originals, preserve all unchanged recipes/authorities/artifacts byte-for-byte, format/check scratch candidates and bind anchor/external scalar last. Actual full current-source healthy/fault tests must pass on the final coherent epoch; old passing counts do not transfer. Historical suite selection follows the concrete changed reader graph and mandatory hooks, not an automatic blanket rerun nor an assumption that no historic suite can be affected.

### Ownership and dependency DAG

Root first records exact claims and frozen API before source dispatch. Maximum useful parallelism is staged:

1. **Recorder prerequisite:** sole `emit/binary.ts` source writer plus new independent recursive-offset test, no schema dependency. It may land as prerequisite only.
2. **Schema/frontend producer writer:** sole owner of core site schema, typed/prepared contracts, input/copy/validation/codec, builder/from-ast/program source preparation and requested-only frontend projection. Root owns compiler preprocessing projection and option handoff, coordinated by exact plain-data API. No pass/lowerer/encoder edits by this writer.
3. **Transform/lowering writer:** starts against frozen schema; sole owner of measured pass/async provenance repairs, backend context and both Wasm emitters, C generated-body attribution. Root serializes overlap with actual upstream async work and freezes the finite generated-body file list. No compiler/codec or renderer edits.
4. **Output integration writer/root:** after recorder and physical schema freeze, owns the full-phase encoder null/unmapped integration, `emit/sourcemap.ts`, private compiler/presentation/WIT coexistence, and C1 successor. This serializes same-file encoder/schema integration rather than letting two writers overwrite it. Independent test writer owns a new whole-program map suite and separately named pure codec/offset suites; it does not manufacture expected compiler packets.

The DAG is source catalog/site schema → authentic capture → pass/codec validation → lowered physical coverage → C/presentation binding → final recursive offsets/V3/content/URL. Recorder unit work and independent genuine baseline capture can precede schema. Integration cannot expose private maps until the entire chain and current-source proof are coherent. No new framework, plugin registry or duplicated compiler algorithm is needed. Existing files may exceed native budgets after real implementation; root measures actual whole-file/function growth and records a bounded issue grant if justified, never a pre-granted blanket allowance or baseline change.

### Required decisive evidence and fail-closed controls

Keep pure mapping/codec/offset test populations separate from genuine Prepared source programs. Use authentic source/checker factories, both backend policies and real original generated helpers; no manually authored IR to claim source correctness. Preserve the original mixed fixture, all scalar/Boolean/early-return cases, current unsupported contracts and actual public/reference failures. Test maps on/off with identical source and explicit controls, assert complete ordered capture/preparation/acceptance/emission/finalization identity and unchanged runtime values/effects/order. Native JavaScript and actual emitted binary/helper outcomes are the semantic oracle; public legacy/default-IR maps are separately characterized, never copied as expected when empty/wrong.

The genuine map suite covers distinct expressions on one line; multiline arithmetic/calls; if/else, loops and early exits; nested structured bodies; throws/async source sites and generated runtime helpers; multi-source same-spelling donors, aliases/reexports, inlined and monomorphized bodies; startup/source-written special-looking names; optimized-away instructions and generated coercions. Include actual preprocessing with original-vs-analyzed text, Unicode/CRLF, leading `./` and normalized paths, empty files and transformed source spans. Each fixture must first genuinely admit on the intended backend; an earlier producer refusal is retained as a different denominator, not a passing map negative. Cover GVN off/on and the existing typed control seam without inferring allocation coverage from a no-allocation program. Later Binaryen optimization and currently absent providers remain outside admission.

Independently parse emitted code sections and structured instructions and reconstruct absolute map deltas; compare every declared source-bearing physical opcode with the authentic origin ledger and exact source slice/coordinates, and every generated range with a one-field reset boundary. Inspect actual `sourcesContent`, source-name census and URL custom section. Prove nonempty coverage floors from the authentic user-instruction census, not a hardcoded test total. Engine instantiation and real helper/native equality are required in addition to decoding maps; a syntactically valid map alone is insufficient.

Negative cases mutate one aspect of an authentic captured/replayed candidate: missing or wrong donor source; conflicting original text; span outside bounds; false original/analyzed coordinate; lost nested/terminator origin; invalid inline ancestry; forged generated classification; omitted or altered physical position; detached module/source catalog substitution; corrupted codec payload; source contents/name mismatch; duplicate/wrong/offset-into-immediate map entries; incorrect body/section prefix adjustment and URL. Require the intended validator to be reached after a fresh healthy witness, assert its specific refusal, and restore the genuine source/module for an actual healthy counterwitness. Do not let an earlier stale C1 pin or missing provider masquerade as map validation. Existing C module mutation guards and mixed finalization poison must retain genuine refusal after restoration where permanent poison is contractual; a fresh genuine transaction supplies the recovery witness.

No-map controls verify no catalog construction, no source-map coverage traversal, old codec shape and exact binary bytes (apart from independently authorized upstream source changes), with unchanged public/legacy routing. Pure replay consistency is not source/checker reexecution. Runtime and map correctness do not establish performance parity: retain the parent measured-performance gate and record requested-map overhead separately only when an authorized complete controlled measurement exists.

### Readiness decision

The recorder prerequisite is implementation-ready under its own narrow claims and tests. The full map contract is architecturally specified here, but root must review/freeze the schema and frontend projection API, resolve the finite source-file claims and C1 successor ownership, and choose the actual delivered WIT/async predecessor before dispatching the shared producer/lowerer/finalizer packages. No source implementation is released by this planning append itself. Completion means a truthful whole admitted-program map path with complete origin/offset/content evidence, not that a declaration map or one positive fixture works. Full IR migration, legacy equality/retirement and performance acceptance remain open.

### Recorder prerequisite amendment — count the function-root edge for controlled no-map cycle refusal (2026-10-06)

This is a bounded correction to the preceding recorder implementation contract, based on a genuine baseline counterexample. It does not weaken the independent test or expand full Prepared-map admission. Root owns the source release; this architectural review approves precisely the additional cache-count initialization below within the existing sole `src/emit/binary.ts` ownership.

The held new test `tests/issue-3525-recursive-source-map-offsets.test.ts` (14433 bytes, SHA256 `73c062f55a5a0b7250bc905bf07830a9844cb662fcd93a73098e899eb97bb178`) creates a real root body array whose `block.body` is that same array and calls each original emitter. Its original canonical4d thirteen-row baseline has five passes/eight failures, including controlled-cycle expectations receiving stack overflow in **both** map and no-map modes. Six other failures are genuine nested-map observations. These are retained original failures, not future acceptance credit. Root also reports the existing forty-test affected cohort as 35 passes/five failures on both the original and b2d recorder candidate with identical failed names; missing producer sites/content remain open full-plan work, not a passing forty-test cohort.

Independent source inspection confirms the no-map cause in `makeInstrArrayEmitCache` (canonical4d line 1021): `parentCounts` starts empty. The root's physical incoming edge from its owning function is omitted. A self-edge increments the root only to one, so it is not in `cache.shared` and `encodeInstrArray` bypasses the existing `cache.encoding` active-recursion guard. A reachable non-root cycle has an entry edge plus a cycle edge at an entry node and therefore can reach that guard; the root is the missing case.

**Exact permitted source change:** immediately after constructing `parentCounts`, add `parentCounts.set(root, 1);` to account for the genuine function-to-body edge. Keep traversal, shared threshold (`count > 1`), `remainingUses`, byte cache, active encoding guard, index/local-frame checks, exported two-argument serializer and all map recorder logic otherwise unchanged. Do not add a second no-map graph walk, cache every array, catch `RangeError` as success, alter tests to accept stack overflow, or suppress cycle errors. A short comment explaining the owning-function edge is permitted; no semantic predicates or unrelated cleanup are included.

For any acyclic graph reachable from this root, no descendant can point back to root. Its new count remains one and it is excluded from `shared` and `remainingUses`; all child counts and cache lifetimes remain identical. With a back-edge to root, its count is at least two, so the first root encoding enters the existing active guard and a recursive visit produces the established controlled `cyclic instruction-array graph` error. The existing `finally` paths restore cache/recording state after refusal. This is a source-grounded correctness argument, not an executed test or performance result. Counting one additional Map entry does not justify a zero-cost or speed claim.

This amendment explicitly supersedes only the previous claim that the **entire cache-construction region** must remain byte-identical. The no-map array cache branch, serializer and all successful-graph behavior remain required unchanged; whole candidate inverse/replay must now include the one bounded root-edge addition. Preserve old 129e and b2d source freezes, their reviews and the original stack-overflow evidence. Source writer freezes a new exact pin and independently measured native checks; root then runs the unchanged thirteen-row suite against that candidate, retaining individual results, decoded-offset controls, both cycle modes and fresh healthy recovery. Confirm ordinary/map binary equality and shared-DAG occurrence behavior on valid modules. Existing forty-row failures remain explicitly qualified unless separately repaired under the full plan; no blanket green or Prepared-map completion follows from this guard fix.

The prior 611960-byte issue (`354add0d94bc634f854ada34cee80403c67f14a9ae85cb75162c182356d8efec`) remains an exact prefix. No source, test, baseline, C1 authority, index or public routing change is made by this append. Full-schema source release still requires root's exact typed API and generated-body/C1 ownership decisions.


### 2026-10-06 — recursive recorder integrated candidate and independent parser follow-up

The final recorder source is71681 bytes/SHA256 `1fd01721148342f52926cf20bdc6473a6bee6ceea2ca8461178a32a0895641ed`; the frozen test is14433/SHA256 `73c062f55a5a0b7250bc905bf07830a9844cb662fcd93a73098e899eb97bb178`. Root independently proves the b2d predecessor differs by exactly `parentCounts.set(root, 1)` and copies the measured+1 native LOC allowance into this issue for src/emit/binary.ts only (2245→2246). No function/total/baseline grant, cosmetic line removal or gate adjustment. Astra's bounded root-edge amendment records the actual old cache flaw; the ordinary opcode serializer and valid-DAG traversal/cache lifetime remain preserved.

The independent unchanged new13 encoder cases actually collect13 and execute13/13, exit0, no failed/pending/todo, empty stderr and complete7669 input custody exact. They independently parse actual section/body/local/LEB/opcode bytes, assert every expected occurrence and position, repeated aliases across functions, immediate/prefixed offsets, structured/try arms, actual engine-valid ordinary/map execution, guard restoration and controlled cycles in both modes. These are synthetic encoder-unit fixtures, NOT Prepared source-fidelity proof. Original4d13-case baseline5pass/8fail remains unchanged (six missing nested mappings and both uncontrolled root cycles); the test-list fullName separator instrumentation exception is retained and independently reconciled to actual ancestorTitles/title without a body rerun. Final test receipt40469/SHA256 `4f593f8e553e97a20c6d8260c3702abe932c10a1516d8c0086825870a053cbb3` binds raw channels, static checks and custody. Root transport compared all14863 tracked source/test bytes, exact source/issue and installed dependency realpath to that actual accepted worker epoch.

The separately run original five-file affected cohort is40 actual cases:35passed/5failed, exit1, exact14865 custody. Candidate b2d is identically35/5 with the same five names and first failure messages; this is non-regression evidence, not a green gate. Four existing public source-map assertions fail from empty maps/content, and one raw instantiation assertion omits required imports. All raw baseline/candidate failures remain preserved; existing tests and assertions are untouched. The final root-edge source epoch still requires its appropriate normal checks and any newly justified affected verification before publication. These known original public-map failures are covered by the full source-map plan, not made passing by this recorder prerequisite.

The separately captured parser recovery defect has been filed as [6864](6864-reject-recovered-empty-parenthesized-expressions.md). Plain public compile accepts the original malformed return-parenthesis source with globally tolerated TS1109 warning and later helper ReferenceError. Sol's independent triage establishes a precise missing-inner-expression early-error gap, with no selected permissive caller option. Its ready implementation plan preserves global/type/prelude policies and exact original reproducer. No parser code is edited here and no new syntax pass is claimed. Canonical allocation first safely refused an invalid URL-as-remote refspec; the failed attempt is retained. Root added the normal named canonical upstream, fetched its actual main and allocated6864 with verified registry/open-PR scan; no issue-ID reuse or GitHub issue creation.

Astra High full origin/schema/pass/codec/lowering/generated-boundary/C1 plan remains mandatory. Its corrected two actual file paths and root-cycle amendment preserve every previous prefix/index/freeze. Full SourceMaps cannot be enabled until the whole chain and genuine source/backend/replay evidence is coherent. No private sourceMap guard lift, public default switch, C ABI/provider expansion, optimization waiver, performance assertion or legacy retirement is included. Only an actual protected main merge counts this recorder as delivered; claims remain held while normal publication is pending.

Final one-line root-edge source epoch has now actually executed the same40 affected cases:35/5, terminal1, with identical original failed names/first messages and all14865 custody records exact. The observation harness summary inherited the stale b2d label from an earlier setup receipt; its original summary is retained. Actual before/after physical source records authenticate71681/1fd017. Root's derived final-source-binding receipt records that instrumentation qualification without a body rerun or false green claim. Whole native TS7 also exits0 on the integrated source/test epoch. Normal signed hooks/protected queue remain the next delivery steps.

## Recorder delivery refresh against delivered WIT main (2026-10-06)

Fresh canonical main `2ecddde5bd388bfd120e7bc2b16ea1f9c028cde7` delivers PR6505 “render prepared WIT from authenticated exports.” The exact41ad head is an ancestor, and compiler.ts, the prepared-presentation leaf, wit-generator.ts and its durable test are byte-identical on that main. Existing recorder PR6507 is refreshed by a normal merge of this exact main into its signed f0 head. The only conflict comprises three issue-file insertions against empty main sides; resolving them preserves the prior621351-byte issue exactly before this new record. Both WIT and recorder histories and the narrow binary +1 allowance remain intact; all inherited main source/test changes are preserved.

The merged candidate executes an independently collected six-file cohort: recorder13, new prepared WIT67, mixed21, Boolean54, prepared presentation44 and legacy WIT9, totaling208/208 actual passed, zero failures/pending/todo, bodyexit0. All14,873 recorded inputs are identical before collection/body and after completion. Binary remains71681/SHA1fd01721; delivered WIT renderer remains29831/SHA290fb38d. Whole native TS7 and the five LOC/function/coercion/oracle/dead-export gates pass against the exact current-main base. This is current-root scoped evidence; it is neither full Test262 conformance nor full SourceMap parity. The earlier existing40case characterization35/5 and its original failures remain preserved, not relabeled green.

Normal signed commit/push hooks and exact-head protected merge admission are still required after this record. A published/queued recorder is not delivered until actual main ancestry/content is verified; dependent parser PR6509 remains held until then. No private SourceMap guard lift, schema admission, benchmark waiver, default switch or legacy retirement is included.


## Zero-suspension delivery refresh onto recorded main76e (2026-10-06)

Existing PR6501 had no failed or pending head checks at26b3e89ddd0f5daef3987d885dc0454d48c55934, but a genuine append/append conflict with freshly verified main76e559f46687617b8e103560818fbea2a9eadc46. Root merges that exact main and preserves both parents complete ordered issue lines, all9 incoming non-issue leaves including delivered recorder binary/tests, and all8 own feature/proof/test leaves. No source repair, fixture alteration, old failure removal, or gate change. Recorder PR6507 delivery is verified at7e11e5d5ff916e9e48897d3daa695c51ccf5881b with90a source ancestry and exact binary/test bytes and modes; only its two narrow claims completed.

The composed eleven-file native collection and body run retain all520 original registrations plus13 recorder cases:533/533 with zero failures, pending/todo/result errors or ordinary error signatures; full7692-input custody exact before/list/body. Current-root TypeScript and LOC/function/oracle/coercion/dead-export/issues checks exit0. Full normal commit and pre-push hooks remain required. Evidence .tmp/zero-suspension-integration/main-refresh-76e contains original conflict, both-parent resolution proof, exact17 source leaves, ordered per-file corpus, direct child receipts and native gate logs. Protected exact-head admission and actual main delivery remain pending; this cohort is not full conformance, full async/Linear coverage, or legacy parity. Preserve the genuine seven-input legacy diagnostic failures and all earlier epochs.
