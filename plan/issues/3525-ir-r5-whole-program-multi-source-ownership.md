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
  - tests/issue-3525-prepared-pipeline-presentation.test.ts
  - tests/issue-3525-multi-prepared-module-init.test.ts
  - tests/issue-3525-ir-whole-program-multi-source.test.ts
loc-budget-allow:
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
