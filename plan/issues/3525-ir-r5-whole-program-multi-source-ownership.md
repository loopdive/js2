---
id: 3525
title: "IR-only R5: whole-program single- and multi-source Prepared ownership"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-08-26
assignee: ttraenkler/codex
branch: codex/3525-m0-program-container-plan
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
depends_on: [3520, 3521, 3522, 3523]
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
  - src/ir/integration.ts
  - src/codegen/context/types.ts
  - src/codegen/declarations.ts
  - src/codegen/index.ts
  - src/compiler.ts
  - tests/issue-3525-ir-whole-program-multi-source.test.ts
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
