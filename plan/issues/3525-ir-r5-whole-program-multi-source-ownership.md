---
id: 3525
title: "IR-only R5: whole-program single- and multi-source Prepared ownership"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-09-05
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
  - tests/issue-3525-multi-prepared-module-init.test.ts
  - tests/issue-3525-ir-whole-program-multi-source.test.ts
loc-budget-allow:
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/codegen/multi-prepared-program.ts
  - src/ir/integration.ts
  - src/ir/prepared-component-dependencies.ts
func-budget-allow:
  - src/codegen/declarations.ts::compileDeclarations
  - src/ir/integration.ts::compileIrPathFunctions
---

# #3525 — IR-only R5: whole-program single- and multi-source Prepared ownership

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
