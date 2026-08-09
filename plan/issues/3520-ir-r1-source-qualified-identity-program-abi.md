---
id: 3520
title: "IR-only R1: source-qualified unit identity and whole-program ABI map"
status: in-progress
assignee: ttraenkler/codex-r1
claimed_by: codex-r1
claimed_at: 2026-07-21T20:23:19Z
branch: codex/3520-c29-function-value-abi
pr: 3799
last_merged_pr: 3798
sprint: current
created: 2026-07-21
updated: 2026-07-30
priority: critical
horizon: l
complexity: L
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen, compiler
language_feature: compiler-internals
es_edition: n/a
goal: ir-full-coverage
lane: ir-retirement-r1
model: gpt-5.6-sol
parent: 3518
depends_on: [3519]
required_by: [3521, 3525]
related: [1983, 2138, 2930, 3142, 3143, 3518, 3529]
origin: "#3518 R1 — replace display-name identity before preparation ownership changes"
files:
  - scripts/check-ir-fallbacks.ts
  - src/ir/identity.ts
  - src/ir/planning-identity.ts
  - src/ir/abi-bindings.ts
  - src/ir/program-abi.ts
  - src/ir/index.ts
  - src/ir/contract.ts
  - src/ir/nodes.ts
  - src/ir/callable-bindings.ts
  - src/ir/outcomes.ts
  - src/ir/builder.ts
  - src/ir/ast-lowering-plans.ts
  - src/ir/from-ast.ts
  - src/ir/imported-functions.ts
  - src/ir/module-bindings.ts
  - src/ir/promise-delay-lowering.ts
  - src/ir/propagate.ts
  - src/ir/type-evidence.ts
  - src/ir/select.ts
  - src/ir/integration.ts
  - src/ir/integration-identity.ts
  - src/ir/integration-report.ts
  - src/ir/lower.ts
  - src/ir/verify.ts
  - src/ir/verify-alloc.ts
  - src/ir/analysis/encoding.ts
  - src/ir/analysis/escape.ts
  - src/ir/analysis/linear-memory-plan.ts
  - src/ir/analysis/ownership.ts
  - src/ir/analysis/stack-alloc.ts
  - src/ir/analysis/string-evidence.ts
  - src/ir/backend/contract.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/backend/porffor/assembler.ts
  - src/ir/backend/porffor/compat.ts
  - src/ir/backend/porffor/integration.ts
  - src/ir/backend/porffor/sink.ts
  - src/ir/backend/porffor/type-converter.ts
  - src/ir/passes/dead-code.ts
  - src/ir/passes/inline-small.ts
  - src/ir/passes/monomorphize.ts
  - src/ir/passes/simplify-cfg.ts
  - src/ir/passes/tagged-union-types.ts
  - src/ir/passes/tagged-unions.ts
  - src/compiler.ts
  - src/compiler/ir-outcome-inventory.ts
  - src/compiler/validation.ts
  - src/import-resolver.ts
  - src/iterator-statics-prelude.ts
  - src/position-map.ts
  - src/process-stdin-prelude.ts
  - src/codegen/class-member-keys.ts
  - src/codegen/class-bodies.ts
  - src/codegen/class-layout-registration.ts
  - src/codegen/context/types.ts
  - src/codegen/context/create-context.ts
  - src/codegen/dead-elimination.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/func-space.ts
  - src/codegen/module-global-registration.ts
  - src/codegen/program-abi-class-callable-planning.ts
  - src/codegen/program-abi-callable-planning.ts
  - src/codegen/program-abi-export-planning.ts
  - src/codegen/program-abi-finalization.ts
  - src/codegen/program-abi-import-planning.ts
  - src/codegen/program-abi-global-planning.ts
  - src/codegen/program-abi-module-init-planning.ts
  - src/codegen/program-abi-source-callable-planning.ts
  - src/codegen/program-abi-planning.ts
  - src/codegen/closure-exports.ts
  - src/codegen/data-struct-host-bridge.ts
  - src/codegen/struct-field-exports.ts
  - src/codegen/program-abi-signatures.ts
  - src/codegen/program-abi-session.ts
  - src/codegen/program-abi-type-planning.ts
  - src/codegen/property-access.ts
  - src/codegen/closed-method-dispatch.ts
  - src/codegen/vec-access-exports.ts
  - src/runtime.ts
  - src/codegen/ir-first-gate.ts
  - src/codegen/ir-class-shapes.ts
  - src/codegen/ir-overlay-identity.ts
  - src/codegen/ir-overlay-finalize.ts
  - src/codegen/ir-overlay-outcomes.ts
  - src/codegen/ir-overlay-safety.ts
  - src/codegen/closures.ts
  - src/codegen/closures/funcref-as-closure.ts
  - src/codegen/closures/method-trampolines.ts
  - src/codegen/index.ts
  - src/emit/binary.ts
  - src/emit/object.ts
  - src/emit/wat.ts
  - src/runtime.ts
  - src/codegen/stdlib-selfhost.ts
  - docs/ir/ir-contract.md
  - docs/ir/ir-module.schema.json
  - benchmarks/allocation-policy-proof.ts
  - tests/helpers/ir-identities.ts
  - tests/issue-3520-class-member-alias-abi.test.ts
  - tests/issue-3520-host-class-callable-abi.test.ts
  - tests/issue-3520-inherited-class-integration-abi.test.ts
  - tests/backend-contract.test.ts
  - tests/issue-3520-function-artifact-identity.test.ts
  - tests/issue-3520-lifted-program-abi.test.ts
  - tests/issue-3520-monomorph-program-abi.test.ts
  - tests/issue-3520-callable-binding.test.ts
  - tests/issue-3520-global-type-binding.test.ts
  - tests/issue-3520-callable-preregistration.test.ts
  - tests/issue-3520-ir-unit-identity.test.ts
  - tests/issue-3520-program-abi.test.ts
  - tests/issue-3520-legacy-unit-projection.test.ts
  - tests/issue-3520-propagation-identity.test.ts
  - tests/issue-3520-context-integration.test.ts
  - tests/issue-3520-imported-target-identity.test.ts
  - tests/issue-3520-lowering-plan-identity.test.ts
  - tests/issue-3520-overlay-selection-identity.test.ts
  - tests/issue-3520-class-shape-identity.test.ts
  - tests/issue-3520-fallback-gate-identity.test.ts
  - tests/issue-3520-integration-population-identity.test.ts
  - tests/issue-3520-integration-report-evidence.test.ts
  - tests/issue-3520-integration-pass-identity.test.ts
  - tests/issue-3520-linear-owner-identity.test.ts
  - tests/issue-3520-module-binding-class-identity.test.ts
  - tests/issue-3520-outcome-correlation-identity.test.ts
  - tests/issue-3520-overlay-finalize-identity.test.ts
  - tests/issue-3520-overlay-safety-identity.test.ts
  - tests/issue-3520-promise-plan-identity.test.ts
  - tests/issue-3520-selfhost-cache-identity.test.ts
  - tests/issue-3520-monomorphize-identity.test.ts
  - tests/issue-3520-program-abi-callable-planning.test.ts
  - tests/issue-3520-program-abi-type-remap.test.ts
  - tests/issue-3520-support-callable-abi.test.ts
  - tests/issue-3520-vec-support-callable-abi.test.ts
  - tests/issue-3520-class-support-callable-abi.test.ts
  - tests/issue-3520-class-integration-callable-abi.test.ts
  - tests/issue-3520-class-method-alias-abi.test.ts
  - tests/issue-3520-closure-host-bridge-abi.test.ts
  - tests/issue-3520-data-struct-host-bridge-abi.test.ts
  - tests/issue-3520-module-init-callable-abi.test.ts
  - tests/issue-3520-source-callable-abi.test.ts
  - tests/issue-3520-type-class-abi.test.ts
  - tests/issue-3520-global-population-abi.test.ts
  - tests/issue-3520-module-global-integration-abi.test.ts
  - tests/issue-3520-callable-export-population-abi.test.ts
  - tests/issue-3520-program-abi-import-callable-planning.test.ts
  - tests/issue-3520-imported-callable-abi.test.ts
  - tests/issue-2856-calendar-residuals.test.ts
  - tests/issue-1899-funcidx-authority.test.ts
loc-budget-allow:
  - src/codegen/closure-exports.ts
  - src/codegen/data-struct-host-bridge.ts
  - src/codegen/struct-field-exports.ts
  - src/codegen/index.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/context/types.ts
  - src/ir/integration.ts
  - src/ir/builder.ts
  - src/ir/from-ast.ts
  - src/ir/nodes.ts
  - src/ir/verify.ts
  - src/ir/backend/porffor/assembler.ts
  - src/runtime.ts
  - src/emit/binary.ts
  - src/emit/object.ts
  - src/emit/wat.ts
# R1 must resolve exact checker declarations to the one authoritative identity
# inventory. TypeOracle deliberately does not expose ts.Symbol/ts.Type objects,
# so these two structural joins remain reviewed raw-checker boundaries until
# the oracle grows a declaration-identity API.
oracle-ratchet-allow:
  - src/codegen/index.ts
  - src/codegen/ir-class-shapes.ts
# This long-lived identity migration adds validation and sidecars at the exact
# legacy/IR seams below without changing body ownership. Splitting those seams
# inside the same already-wide change would obscure parity review; #3399 owns
# their mechanical decomposition after this checkpoint lands.
func-budget-allow:
  - src/ir/integration.ts::compileIrPathFunctions
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::generateMultiModule
  - src/ir/backend/linear-integration.ts::makeLinearIrResolver
  - src/ir/integration.ts::makeResolver
  - src/codegen/context/create-context.ts::createCodegenContext
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/backend/linear-integration.ts::compileLinearIrFunctions
  - src/ir/type-evidence.ts::buildIrRecursiveTypeEvidence
---

# #3520 — IR-only R1: source-qualified identity and whole-program ABI map

## Objective

Give every source and synthetic compiler unit a structural, source-qualified
identity and build one deterministic `ProgramAbiMap` before changing which
front-end emits bodies.

This is an identity/ABI landing, not an ownership flip. The same units still
take the same direct, compile-twice, or IR-overlay route as before. R1 removes
the name-collision and late-slot-allocation assumptions that would otherwise
make R2's prepare-before-emit inversion unsound.

## Current evidence

The current middle-end calls a display string an identity:

- `src/ir/nodes.ts:36-52` defines `IrFuncRef`, `IrGlobalRef`, and `IrTypeRef`
  with only `{ kind, name }`; the comments explicitly bind those names to the
  legacy context maps.
- `src/ir/nodes.ts:2591-2605` makes `IrModule` only a flat function array;
  imports, globals, types, exports, classes, and synthetic units are not a
  program-owned contract.
- `src/ir/from-ast.ts:561-570` chooses `options.funcName ?? fn.name.text`, and
  `calleeTypes` / `classShapes` / `moduleBindings` are flat string maps
  (`:444-470`, `:503-517`).
- `src/ir/integration.ts:150-220` keys propagated signatures and local calls by
  function name. Its post-pass table at `:685-710` also joins functions by
  name.
- `src/ir/passes/inline-small.ts:88-102` and
  `src/ir/passes/monomorphize.ts:99-126` build `byName` maps. A duplicate
  display name silently overwrites the earlier entry before either pass.
- `src/codegen/index.ts:4970-5046` copies import aliases between the flat
  `funcMap`, `closureMap`, and `moduleGlobals` namespaces. The multi-source
  overlay must separately collect name collisions at `:5274-5284` because the
  IR itself cannot represent distinct same-named declarations.
- `src/codegen/class-bodies.ts:1078-1118` registers instance and static methods
  from the same `${className}_${methodName}` display name. The existing
  collision guard deliberately suppresses a second placeholder; getters and
  setters need separate spelling conventions at `:1197-1283`.
- `src/ir/integration.ts:921-970` finds `__module_init` by display name and
  patches class/module slots allocated by legacy compilation. That adapter is
  temporary and cannot be the identity model for an IR-only program.

These are not hypothetical multi-source-only hazards. Two files may both
declare `main`; two nested classes may both be named `C`; one class may have
static and instance `m`; and `get x` / `set x` are separate executable units
even though users see one property name.

## Identity contract

Add one canonical identity vocabulary, with a single encoder/comparator:

- `IrSourceId` is independent of the process cwd and absolute checkout path.
  It combines a normalized program-relative source key with the source's
  deterministic compiler order. The entry file and synthesized/lib sources
  have explicit kinds; no `Map` insertion accident defines order.
- `IrUnitId` identifies an executable source unit by source, lexical owner
  chain, unit kind, and declaration ordinal. Kinds cover top-level functions,
  class constructors/methods/accessors, object methods, nested declarations,
  closures, module init, and synthetic support units.
- `IrClassId` identifies a class declaration/expression by source, lexical
  owner, and declaration ordinal. The class's spelling is only `displayName`.
- `IrBindingId` (or an equivalently closed union) identifies function, global,
  import, type, export, and synthetic/runtime bindings. A callable reference
  distinguishes a source `IrUnitId` from an intrinsic/import/support binding;
  no ad-hoc magic string enters the identity domain.
- Synthesized identities derive from `{parentId, role, ordinal}`. Lifted
  closures and monomorphized clones never derive uniqueness from a generated
  display name or a type string alone.

Identity values must be immutable and serializable for diagnostics/tests. A
human-readable label is stored separately and may remain byte-compatible with
current telemetry. Equality, maps, call graphs, passes, and ABI resolution may
never use that label.

The inventory exposes two explicit populations rather than conflating nested
support artifacts with terminal source outcomes:

- `allUnits` is exhaustive over source, nested, lifted, and synthetic support
  units. Records rooted in an existing R0 attempt carry `terminalOwnerId` and,
  where applicable, `lexicalOwnerId`. A genuinely exhaustive unit for which R0
  has no attempt root carries `terminalOwnerId: null` plus
  `unownedReason: "no-r0-attempt-root"`; R1 must not fabricate a terminal
  outcome merely to make ownership total.
- `terminalUnits` is the exact one-to-one population consumed by the R0 outcome
  ledger. Its count must equal terminal outcomes, while every additional
  owned `allUnits` record must resolve to one terminal owner.

An equality check between `allUnits.length` and the R0 outcome count is invalid:
R0 deliberately attributes lifted/support preparation failures to their source
owner. R1 makes that relationship structural instead of manufacturing extra
terminal rows.

## `ProgramAbiMap` contract

Build one whole-program inventory in deterministic source order. The map owns:

1. Every source and synthetic unit, class, and binding identity.
2. Callable signatures, global storage, imported callable/global signatures,
   Wasm type intents, exports, class layouts, and support-unit relationships.
3. Stable source order and dependency order, including explicit parent/child
   links for lifted closures and constructor support units.
4. The intention and eventual final-layout Wasm index for each identity.
   `ProgramAbiMap` is an identity/intention ledger, not an allocator:
   `ModuleAssembler` remains the sole allocator, and only binds finalized
   indices after planning. A second binding, an unplanned binding, or two
   identities sharing a non-alias slot is an R0 `Invariant`. In particular,
   global/type raw indices are never preallocated or cached by the ABI plan.
5. Explicit aliases. An import alias, inherited member, or export alias points
   to a canonical binding ID; it is not implemented by copying a display-name
   map entry.

R1 supplies a narrow `LegacyAbiAdapter` (name may follow repository
conventions) so existing direct code can resolve its old `funcMap`,
`moduleGlobals`, `structMap`, and export slots from `ProgramAbiMap`. The
adapter is the only string-keyed compatibility boundary. It must:

- generate collision-free internal Wasm names from IDs while preserving the
  old spelling when it is unambiguous;
- reject an ambiguous reverse lookup instead of choosing first/last wins;
- record intentional aliases separately from accidental collisions; and
- expose the old display labels for telemetry without making them keys.

Repairing the current runtime/legacy collision behavior through this adapter is
later R1 work. The first shadow landing proves identity and alias semantics
without rewiring `funcMap`, `moduleGlobals`, `structMap`, exports, or module
arrays, so it cannot claim that existing runtime collisions are fixed.

## Bounded landing sequence

### Commit 1 — identities and exhaustive inventory

- Add the identity types, canonical encoder/comparator, and source-order
  builder.
- Inventory single- and multi-source ASTs without changing selection or body
  routing.
- Cover class declarations/expressions, static/instance/accessor distinctions,
  nested scopes, object methods, lifted functions, module init, and known
  synthetic support roles. Unsupported syntax is still inventoried.
- Cross-check the R0 outcome ledger: every terminal row maps to exactly one
  `terminalUnits` identity, every `allUnits` record resolves through
  `terminalOwnerId`, and legacy labels/histograms remain unchanged.

### Commit 2 — key source planning and analyses by identity

- Replace source-unit string keys in `propagate.ts`, `type-evidence.ts`,
  `select.ts`, `ast-lowering-plans.ts`, imported/module-binding plans,
  promise-delay ownership, IR-first call-graph closure, outcome reconciliation,
  and self-host selection with structural IDs. Keep `class-member-keys.ts` as
  the legacy slot adapter until Commit 4.
- Key source-level recursion/SCC evidence by identity and add a validated
  source-owner ID only at the linear integration seam. Escape, ownership,
  stack-allocation, encoding, and string-evidence analyses already key their
  semantic facts by IR value/allocation IDs and do not need a source-name
  migration. Property names, intrinsic names, layout field names, and the
  generic linear-plan `ownerFunction` label remain strings in this commit.
- Keep existing selection results, preparation order, and diagnostics stable;
  this commit changes lookup identity only.

### Commit 3 — key IR references, passes, and backends by identity

- Replace name-keyed local-call/type maps in `from-ast.ts`, `integration.ts`,
  lowering, verification, overlay finalization, and backend contracts with
  IDs.
- Put an `IrUnitId` on every `IrFunction`; make direct calls carry a typed
  callable binding ID. Keep `name` only as a display/debug field.
- Key inlining, recursion/SCC analysis, monomorphization, and clone edit tables
  by identity. A clone receives a derived ID; its display name may retain the
  current format.
- Make WasmGC, linear integration, and the Porffor adapter consume the same
  binding identity. Backend-local scratch labels and concrete export strings
  remain explicit labels below the ABI boundary.
- Keep runtime/helper string references behind a typed intrinsic/import binding
  variant until R6; do not invent source IDs for runtime providers.

### Commit 4 — ABI map and legacy-slot adapter

- Plan/import/intern every ABI entry once, then feed current declaration and
  integration code through the compatibility adapter.
- Replace collision scanners and name-based patch lookup where an ID is
  available. Keep the existing routing order and legacy body emitters.
- Preserve current public export names. Internal name changes are permitted
  only for a real collision and require runtime evidence.
- Emit diagnostic tables sorted by canonical source/unit order, never JS `Map`
  accident or filesystem walk order.

## R1a implementation status — PR #3490 (merged)

PR #3490 merged to `main` at `9e813698d081417330476e64d495149508b24a76`.
The issue remains `in-progress` on the R1b continuation branch.

Implemented in the bounded landing:

- opaque, serializable `IrSourceId`, `IrUnitId`, `IrClassId`, and
  `IrBindingId` encodings whose uniqueness does not use display names;
- dependency-first source ordering from compiler-resolved edges when available,
  with authoritative empty/external resolutions, unique relative/bare-specifier
  fallback only when resolution is unavailable, checkout-independent
  `@library/` keys, collision rejection, and raw canonical source-key SCC
  ordering as the disconnected-root/cycle tie-breaker;
- fixed-width numeric identity components, so the canonical text comparator
  orders source orders and regular/derived ordinals numerically past 9;
- producer-tagged provenance for timer, node:path, typed Node import wrappers,
  generated ambient import classes, eval/super early-error IIFEs,
  process.stdin, and Iterator source rewrites. Synthetic IDs use semantic
  producer roles; repeated units with the same parent and role use an explicit
  sibling ordinal rather than a display spelling;
- an exhaustive final-target source-AST/compiler-prelude `allUnits` inventory
  plus the exact R0-compatible `terminalUnits` population, including nullable
  ownership for compiler support units that have no R0 attempt root. The
  host-free dead-binding pass snapshots pre-elision ordinals so every retained
  support node keeps its ID; deliberately removed support nodes remain absent
  and never manufacture terminal rows;
- additive `sourceId` / `unitId` fields on compiler-produced terminal outcomes,
  while legacy outcome key, label, count, and order remain unchanged;
- a validated `indexIrTerminalDeclarations` AST-node-to-ID join so subsequent
  declaration planning does not need to rejoin by display name; and
- a semantic/shadow `ProgramAbiMap` and read-only `LegacyAbiAdapter` data-
  structure seam with
  separate plan/final-bind phases, explicit `required | alias | none` policy,
  deterministic numeric plan order, namespace-aware lookup, and typed
  alias/export/final-index invariants. Production codegen does not build this
  map yet, so this landing does not claim whole-program ABI completeness.

Intentionally deferred from this PR:

- changing source planning, call graphs, IR references, passes, or backends to
  use the new IDs (the remainder of commits 2 and 3);
- assigning derived identities to pass-created lifted closures,
  monomorphization clones, and other post-AST support units (Commit 3);
- giving every nested node inside one compiler helper its own named semantic
  role. Iterator helper children currently derive from the semantic top-helper
  parent/role plus structural sibling ordinal; this is deterministic for the
  current helper AST but internal sibling edits intentionally revise those
  child IDs;
- binding current codegen slots into `ProgramAbiMap`, or changing
  `ModuleAssembler` allocation/finalization order; and
- routing the legacy runtime maps through `LegacyAbiAdapter` or repairing their
  current collision cases. Those binding points require the broader locked R1
  file set and runtime evidence; the shadow seam is interface/invariant
  groundwork, not runtime-collision completion.

Remaining numbered work:

- **Commit 2:** thread `IrUnitId` from the validated declaration index through
  selection, propagation, source planning, recursion/SCC evidence,
  imported/module binding, promise-delay, self-host planning, the additive
  linear source-owner join, and terminal outcomes. Keep class-member naming as
  the legacy adapter; value/allocation-keyed ownership, escape, stack, encoding,
  and string-evidence analyses do not need migration here.
- **Commit 3:** put identities on IR functions/references, key inline and
  monomorphization edits structurally, derive IDs for pass-created units, and
  carry the same binding identities through verification/lowering/backends.
- **Commit 4:** populate the whole-program ABI intentions, bind only
  ModuleAssembler-final indices, then route legacy maps/exports through the
  adapter and prove runtime collision behavior plus non-collision byte parity.

## Commit 2 implementation plan — source planning by identity

**Active R1b branch:** `symphony/3520-r1-planning-identity`

### Root cause

R1a created structural source/unit/class identities, but production planning
still rebuilds independent name maps in each phase. `buildTypeMap`, recursive
evidence, selection, IR-first closure, imported/Promise plans, and overlay
reconciliation can therefore resolve the same declaration through different
`Map<string, ...>` instances. Multi-source compilation makes the defect
observable: the inventory distinguishes two declarations named `main`, while
planning still collapses or conservatively rejects them by that label.

The R1a terminal join is also only half-threaded. Outcome rows carry `unitId`,
but `recordObservedIrOutcomes` immediately rejoins selection, failures, and
integration events through `legacyMatchName`. Commit 2 must make the ID the
join key before Commit 3 changes `IrFunction` and `IrFuncRef` themselves.

### One per-program identity context

**Files: `src/ir/identity.ts` and new internal
`src/ir/planning-identity.ts`**

`buildIrUnitInventory` remains the only inventory builder. Its scanner records
the exact source, unit-declaration, and class-declaration objects while it
constructs the returned `IrUnitInventory`; that scanner metadata is associated
with that exact inventory object. `buildIrPlanningIdentityContext` consumes the
already-built inventory and validates the scanner metadata. It must never call
`buildIrUnitInventory`, clone/reconstruct an inventory, or recover a declaration
through name, text, line, or span matching. A copied or independently rebuilt
inventory is rejected with the typed `untracked-inventory` invariant.

The new internal module owns the context/error/validation implementation and
keeps the large identity scanner within the repository LOC budget. This split
does not receive a LOC-budget allowance and does not change any baseline.

```ts
export interface IrPlanningIdentityContext {
  readonly inventory: IrUnitInventory;
  readonly sourceIdBySourceFile: ReadonlyMap<ts.SourceFile, IrSourceId>;
  readonly sourceFileBySourceId: ReadonlyMap<IrSourceId, ts.SourceFile>;
  readonly unitIdByDeclaration: ReadonlyMap<ts.Node, IrUnitId>;
  readonly declarationByUnitId: ReadonlyMap<IrUnitId, ts.Node>;
  readonly terminalByUnitId: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly classIdByDeclaration: ReadonlyMap<ts.ClassDeclaration | ts.ClassExpression, IrClassId>;
  readonly declarationByClassId: ReadonlyMap<IrClassId, ts.ClassDeclaration | ts.ClassExpression>;
  readonly moduleInitUnitIdBySourceId: ReadonlyMap<IrSourceId, IrUnitId>;
  readonly moduleInitUnitIdBySourceFile: ReadonlyMap<ts.SourceFile, IrUnitId>;
}

export function buildIrPlanningIdentityContext(inventory: IrUnitInventory): IrPlanningIdentityContext;
```

Ordinary unit and class entries use their exact scanner-captured declaration
object. Only two semantic anchors are explicit:

- module init is source-owned and therefore appears in
  `moduleInitUnitIdBySourceId` / `moduleInitUnitIdBySourceFile`, not in the
  declaration maps; and
- an implicit constructor is anchored to its owning class declaration or
  expression. Unit and class maps are separate, so that class-like node may
  validly map to both its constructor `IrUnitId` and its `IrClassId`.

A field-initializer support unit retains its own scanner-captured declaration.
There is no general exception that permits a consumer to search by span. Every
forward/reverse pair, terminal owner, source object, and module-init anchor is
validated; duplicate or missing entries are typed R0 invariants.

Dependency order is a derived view, not a second identity index: iterate
`context.inventory.sources` and resolve each record through
`context.sourceFileBySourceId`. This preserves the inventory's SCC/canonical-
key ordering for planning without changing the existing global R0 source loop
or legacy body-emission order.

The compiler builds the final complete inventory once, after all source
rewrites/reparses, then immediately derives one context from that same object.
Single- and multi-source overlays receive that context; no per-source overlay
may rebuild inventory. Checker resolution must select an exact declaration and
look it up in the context. Checker-free textual resolution remains conservative:
only a unique eligible declaration in the existing domain may project to the
legacy path; ambiguous or absent targets retain the current demotion.

### Validated legacy projection retained by Commit 2

Commit 2 does not yet make `IrFunction` or the codegen slot tables structural.
It therefore retains a validated, one-to-one compatibility projection for each
active source-planning population:

```ts
interface IrLegacyUnitProjection {
  readonly unitId: IrUnitId;
  readonly legacyName: string;
}
```

Both directions are validated: an ID has exactly one legacy name and a legacy
name identifies at most one active ID at the receiving API. A collision is
demoted by the current typed collision/safety policy before a name-keyed call;
it is never collapsed by first/last wins. The originating `unitId` remains on
the selection, plan, skip/preparation record, and outcome evidence across that
call, and a returned name is accepted only through the same projection.

This compatibility projection remains required for the still-name-keyed
`compileIrPathFunctions`, `IrTypeOverrideMap`, `from-ast` `calleeTypes`,
`classShapes`, and integration interfaces until Commit 3 or 4 replaces those
interfaces. Class resolution likewise carries `{ classId, legacyName }`; the
local class-expression resolver returns that pair, while `classShapes` remains
name-keyed. `class-member-keys.ts` and every existing static/instance/accessor
collision guard remain active legacy adapters.

### Ordered migration of planning consumers

The dependency order is load-bearing:

1. Land `IrPlanningIdentityContext` over the exact existing inventory and
   export it only through the internal IR barrel.
2. Key propagation and recursive source evidence by `IrUnitId`; derive
   deterministic worklist/SCC order from the context.
3. Make selection and source plans carry unit/class IDs for every executable
   owner/target, without changing which units are selected.
4. Build and validate the one-to-one legacy projection before invoking the
   still-name-keyed compile, override, class-shape, from-AST, or integration
   APIs. Preserve collision demotion.
5. Carry the original ID through IR-first closure, preparation, integration
   correlation, and terminal outcome reconciliation.
6. Add source owner IDs only at the linear integration seam and tighten the
   existing self-host cache eligibility/fingerprint behavior.

Do not start Commit 3's `IrFunction`/`IrFuncRef` migration in this slice. In
particular, do not reconstruct an owner from `IrFunction.name`.

### Exact file and API changes

| File / current API                                                                                                                            | Commit 2 contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/ir/identity.ts` — inventory scanner and `buildIrUnitInventory`                                                                           | Capture exact scanner metadata while building the one authoritative inventory. Expose only the narrow internal hand-off needed by `planning-identity.ts`; do not add a second scan, span join, inventory copy, LOC allowance, or baseline change.                                                                                                                                                                                                                                      |
| `src/ir/planning-identity.ts` — new internal module                                                                                           | Own `IrPlanningIdentityContext`, its typed invariant error/codes, read-only map wrappers, and `buildIrPlanningIdentityContext(existingInventory)`. Validate that the exact tracked inventory and all forward/reverse source, declaration, terminal, class, and module-init joins agree. Module init uses its source anchor; implicit construction uses its class anchor.                                                                                                               |
| `src/ir/index.ts`                                                                                                                             | Export the context and builder through this internal IR barrel. The root `src/index.ts` public package surface is unchanged.                                                                                                                                                                                                                                                                                                                                                           |
| `src/ir/propagate.ts` — `TypeMap`, `buildTypeMap`, `buildCallGraph`, `collectFunctionDeclarations`                                            | Make source declaration, call, inbound, seed, worklist, and result keys `IrUnitId`. Resolve declarations through the supplied context. Parameter/local lexical scopes remain string-keyed. Preserve the current unique checker-free fallback and demote ambiguity.                                                                                                                                                                                                                     |
| `src/ir/type-evidence.ts` — `RecursiveTypeEvidence`, `buildRecursiveTypeEvidence`, `recursiveComponents`                                      | Carry `{ unitId, displayName, declaration, symbol }`; key source calls, escapes, signatures, decisions, graph members, and Tarjan components by `IrUnitId`. Derive tie-breaking from context order; render the display label only after the decision. This is source-level recursive evidence, not a rewrite of value/allocation-keyed escape analysis.                                                                                                                                |
| `src/ir/select.ts` — `IrFallback`, `IrSelection`, `IrModuleInitAssessment`, `planIrCompilation`                                               | Carry a required `unitId` on executable fallbacks, selected functions/members, local edges, and non-empty module-init assessment; carry `IrClassId` with class decisions. Keep display/member/property names as labels. Preserve selection, compile-twice, and every collision demotion.                                                                                                                                                                                               |
| `src/codegen/index.ts` — `buildIrClassShapes` / `tsTypeToClassPositionIr`; `src/ir/module-bindings.ts` — `makeIrLocalClassExpressionResolver` | Resolve class declarations through `classIdByDeclaration`, but return `{ classId, legacyName }` from the local class-expression resolver. Keep `classShapes` and legacy `ctx.classSet` / `structFields` name-keyed behind a validated projection. Ambiguity retains the current demotion.                                                                                                                                                                                              |
| `src/ir/imported-functions.ts` — `IrResolvedFunctionTarget`, `makeIrImportedFunctionResolver`                                                 | Change construction to `makeIrImportedFunctionResolver(checker, sourceFiles, identityContext)`. Return the exporting declaration's `targetUnitId` alongside its legacy target name. Symbol/declaration identity chooses the target; canonical-name counting cannot choose semantic identity. The name remains only for the validated `funcMap` / from-AST compatibility projection.                                                                                                    |
| `src/ir/ast-lowering-plans.ts` — imported-call/function-value/host-callback plans                                                             | Add required `ownerUnitId` and source `targetUnitId`; retain explicitly named legacy target, trampoline, cache-global, and capture strings consumed by current lowering. Exact AST-site maps remain node-keyed.                                                                                                                                                                                                                                                                        |
| `src/ir/module-bindings.ts` — `IrModuleBindingIdentity`, `makeIrModuleBindingResolver`                                                        | Keep the checker-resolved `VariableDeclaration` as binding identity until Commit 4. Every source use carries its `ownerUnitId` (or module-init ID), and class evidence carries `IrClassId`. Generated `__mod_*` names remain compatibility labels.                                                                                                                                                                                                                                     |
| `src/ir/promise-delay-lowering.ts` — owner collection and plans                                                                               | Key owner certification/selection by `IrUnitId` and store it on every plan. Capture/lifted names remain strings. Derived identities for executor/timer functions wait for Commit 3.                                                                                                                                                                                                                                                                                                    |
| `src/codegen/ir-first-gate.ts` — `collectLocalCallEdges`                                                                                      | Produce ID-keyed source edges and use the source's actual module-init ID internally. Before `compileIrPathFunctions`, validate and pass the one-to-one `{ unitId, legacyName }` projection; correlate its named result back through those exact pairs. Do not remove conservative collision demotion.                                                                                                                                                                                  |
| `src/codegen/ir-overlay-finalize.ts` — blocked closure and preparation                                                                        | Carry IDs through blocked-component, Date/Promise/callback owner, and preparation state. Host/lifted slot names stay strings at the legacy boundary. Translate to a name only through the active projection and retain the ID on the structural state.                                                                                                                                                                                                                                 |
| `src/codegen/index.ts` — `IrOverlayPlan`, `computeIrFirstSkipSet`, `planIrOverlay`, multi-source safety                                       | Keep structural selection/declaration/owner/blocked/skip state ID-addressed. Retain `IrTypeOverrideMap` as name-keyed and create its entries only from validated pairs. Multi-source collision scanners remain safety gates and demote the exact affected IDs. Never translate a skipped name through a global name map.                                                                                                                                                               |
| `src/ir/from-ast.ts` and `src/ir/integration.ts` — `calleeTypes`, class shapes, compilation/integration report                                | Keep these interfaces name-keyed in Commit 2. Supply only validated projected names, retain each source ID in the calling plan/sidecar, and correlate each compiled/error result through the same pair. No named event can satisfy a different same-label ID. Their structural API migration belongs to Commit 3/4.                                                                                                                                                                    |
| `src/codegen/index.ts` — `recordObservedIrOutcomes`                                                                                           | Reconcile selection, preparation, static/member policy, integration correlation, and patch evidence by the retained `unitId`; use `terminalByUnitId` for metadata/duplicate checks. Legacy keys, labels, histograms, and public compiled-name telemetry remain unchanged output.                                                                                                                                                                                                       |
| `src/ir/backend/linear-integration.ts` — `compileLinearIrFunctions` source integration seam                                                   | Add/require `ownerUnitId` only on the source integration descriptor or a total validated sidecar used at this seam. Keep generic `LinearAllocationSitePlan.ownerFunction`, `planLinearMemory`, allocation/layout IDs, and stack operation schemas unchanged until Commit 3 gives `IrFunction` an ID. `encoding`, `escape`, `ownership`, `stack-alloc`, and `string-evidence` already use IR value/allocation IDs and need no Commit 2 source-name migration.                           |
| `src/codegen/stdlib-selfhost.ts` — `memoKey`, `irCache`, `buildSelfHostedIr`                                                                  | Preserve `memoKey` as the context-free cache-eligibility guard and preserve the guard that excludes ctx-bound type/resolver (`typeIdx`) state. Compute a deterministic template fingerprint only after eligibility and only for an identity-free template; never cache a program-relative ID. A ctx/typeIdx-dependent build must never enter the cache. If that cannot be proved without widening the slice, defer the fingerprint change to Commit 3 rather than weakening the guard. |
| `src/codegen/class-member-keys.ts`                                                                                                            | Leave the string-keyed module, relocation logic, and collision guards in place as the legacy compatibility adapter through Commit 4.                                                                                                                                                                                                                                                                                                                                                   |

### String-versus-identity boundary

After Commit 2, structural source-planning state uses `IrUnitId`/`IrClassId`
for selection membership, caller/callee closure, recursive components, owner/
target facts, blocked/skip decisions, and terminal joins. Strings remain valid
for local/parameter/property/field names, import/export spellings, public names,
intrinsics/helpers, concrete Wasm names, diagnostics, and current legacy slot
interfaces.

The validated `{ unitId, legacyName }` projection is deliberately still used as
a semantic compatibility boundary for `compileIrPathFunctions`,
`IrTypeOverrideMap`, `calleeTypes`, `classShapes`, and integration. The ID must
remain alongside every projected name, and reverse correlation must use the
same one-to-one projection. Thus Commit 2 removes independent name re-joins
without claiming that all string-keyed compiler APIs have already disappeared.

Commit 2 does not assign `IrBindingId` to module globals, put IDs on
`IrFunction`/`IrFuncRef`, derive IDs for lifted/monomorphized functions, migrate
generic linear-plan ownership, or bind ABI slots. Those remain Commit 3/4 work.

### Outcome join and parity requirements

The existing global R0 source loop remains unchanged. Within each source,
`recordObservedIrOutcomes` consumes that source's terminal records in canonical
inventory order and addresses structural state by `unitId`. It validates named
integration evidence through the source's one-to-one projection rather than a
global `legacyMatchName` map.

For every terminal ID, apply and record exactly one branch in this stable
precedence:

1. an inventory-authored `directFailure`;
2. the selector's typed rejection;
3. a typed preparation failure;
4. the explicit `static-class-member` compile-twice outcome;
5. a typed late-preparation rejection;
6. the explicit `module-init-legacy-coupling` integration outcome;
7. another typed integration error; or
8. successful, exactly-once patch evidence.

Duplicate or absent terminal/evidence IDs, multiple compiled/error events for
one projection, a same-label event owned by another ID, or leftover unconsumed
integration evidence produces the existing typed invariant. Branch precedence
must not silently mask duplicate evidence. R0 row count/order, fallback
histograms, `displayName`, `key`, public compiled-name telemetry, the global
source-loop order, and emitted binaries remain unchanged.

### Anti-vacuity tests for Commit 2

Extend `tests/issue-3520-ir-unit-identity.test.ts` and add focused planning
fixtures only where required. Prove behavior through real consumers:

1. Build an inventory once, derive `IrPlanningIdentityContext` from that exact
   object, and prove its forward/reverse maps, source-derived dependency view,
   source-owned module init, and class-anchored implicit constructor. A copied
   or rebuilt inventory must fail as `untracked-inventory`; no span match is
   accepted.
2. Give two files declarations named `same` and classes named `C`; reverse
   caller insertion order and prove distinct propagation/selection IDs with no
   inventory rebuild. Where the receiving legacy API cannot represent both,
   prove the existing collision demotion instead of a collapsed name entry.
3. Create same-named recursive SCCs with different scalar evidence and prove
   the worklist, Tarjan components, decisions, and diagnostics stay attached to
   the correct IDs.
4. Cover instance/static `m`, get/set `x`, repeated computed labels, nested
   same-named classes, class expressions, and implicit constructors. Prove the
   local resolver returns `{ classId, legacyName }`, class shapes remain behind
   the validated projection, and current slot demotions/output do not change.
5. Resolve default and renamed imports through checker declarations. Prove
   `makeIrImportedFunctionResolver(..., identityContext)` returns the exporting
   unit ID and that call/function-value plans retain owner/target IDs across the
   named from-AST/integration boundary.
6. Give same-named Promise/Date owners and `<module-init>` units in two files;
   prove blocked/preparation/outcome state stays separate and named events only
   correlate through their exact pairs.
7. Exercise module binding from a function and module init. Prove structural
   owner IDs coexist with exact binding declaration identity and that a same-
   spelled shadowed local is not captured.
8. Exercise the linear source integration seam with same-label source owners.
   Prove its additive/sidecar `ownerUnitId` is total while generic allocation
   plans still use their unchanged schema and value/allocation IDs.
9. Prove the self-host `memoKey` eligibility and no-ctx-bound-type/resolver
   guard remain active: eligible identity-free templates fingerprint safely,
   while a ctx/typeIdx-dependent build never reads or writes the cache.
10. Cover every outcome branch above, including inventory `directFailure`,
    `static-class-member`, and `module-init-legacy-coupling`; reject same-label
    cross-ID evidence and prove per-source canonical order without changing the
    global source loop. Keep legacy rows/histograms and tracked/untracked output
    byte-identical.

Run the new tests with the R1a identity/ABI/outcome suites, #2138, linear,
self-host, phase3c, equivalence, and cross-backend differential validation. Run
#1983 and inline-small separately as control-matched known-failure matrices:
their exact failures must match the pre-branch base and are not an expected
green command. No local Test262 run or baseline refresh belongs to this commit.

### Commit 2 risks and containment

- **Inventory substitution:** rebuilding or copying an inventory loses its
  scanner object joins. Build once, require exact object identity, and reject
  untracked inventories.
- **AST identity invalidation:** a transform after inventory construction makes
  exact node maps stale. Finish rewrites first; reject unknown nodes without a
  text/span fallback.
- **Ambiguous checker edges:** aliases, overloads, merged declarations, and
  reassignments may resolve to multiple/non-executable declarations. Accept one
  indexed executable declaration or retain Unsupported/compile-twice behavior.
- **Legacy projection collision:** structural planning cannot make the current
  named compiler API represent two occupants. Preserve collision demotion,
  validate both projection directions, and never use first/last wins.
- **ID loss at return:** a name-only compiled/error result can be attached to
  the wrong unit. Retain the ID sidecar through the call, consume each named
  result once through the exact projection, and reject leftovers/duplicates.
- **Linear scope creep:** `IrFunction` lacks a structural ID. Add owner identity
  only at source integration; changing the generic plan would also require the
  #3298/#3299/#3300/#3502 test families and
  `scripts/benchmark-allocation-policies.mts`, so defer that schema change to
  Commit 3.
- **Self-host cache leakage:** a fingerprint cannot make ctx/type-index state
  context-free. Preserve eligibility guards and defer caching when any resolver
  state is bound to the active compilation.

### Commit 2 implementation status

Implemented on the active R1b continuation branch:

- the exact inventory scanner now retains frozen source/unit/class declaration
  metadata outside the serializable identity records;
- `buildIrPlanningIdentityContext(existingInventory)` validates immutable
  bidirectional source, unit, terminal, class, and source-owned module-init
  mappings without rebuilding the inventory or joining by display/span;
- `indexIrTerminalDeclarations` now consumes those exact record/node joins;
  copied or independently rebuilt inventories are rejected; and
- the planning implementation lives in `src/ir/planning-identity.ts` so
  `identity.ts` remains below the 1,500-line subsystem limit without an
  allowance or baseline change.

Validation for this foundation is **30/30** identity tests, **10/10** ABI
tests, and **96/96** across the expanded identity/outcome/multi-source/producer
matrix. Typecheck, lint, formatting, diff, and LOC-budget checks pass. This is
stage 1 of the ordered Commit 2 plan.

Stage 2 now adds the structural propagation boundary:

- `IrLegacyUnitProjection` validates an immutable one-to-one active
  `{unitId, legacyName}` population and correlates returned named evidence
  exactly once. Duplicate IDs/names, missing or mismatched pairs, foreign or
  duplicate results, and deterministic leftovers are typed invariants.
- `buildIrUnitTypeMap` keys declaration collection, calls, inbound sites,
  seeds, worklists, and results by `IrUnitId`. Checker resolution joins only
  exact indexed declarations; checker-free textual resolution is admitted
  only for a unique active label.
- `buildIrRecursiveTypeEvidence` keys SCC graphs, components, decisions,
  signatures, anchors, owners, and targets by `IrUnitId`. Canonical work order
  comes from the authoritative inventory.
- The still-name-keyed selector/integration seam is served only through the
  validated projection. Duplicate labels are conservatively omitted from that
  compatibility population instead of choosing a first or last structural
  owner.

The focused Stage 2 suites pass **13/13**. The existing propagation/evidence
consumer matrix passes **95 tests with 1 skipped**, including reversed-source
numeric and string recursive SCCs that share a display name plus a third
non-recursive peer. Typecheck, lint, formatting, diff, and LOC-budget checks
pass.

Stage 3 threads that context through the production entry seams:

- single-source and multi-source WasmGC planning build one inventory/context
  and retain that exact context from propagation through terminal outcomes;
- tracking-only compilation preserves the pre-R1 binary/result behavior while
  deriving its outcome population from the same authoritative inventory;
- linear propagation and recursive evidence share one inventory/context rather
  than independently rebuilding their source population; and
- outcome collection requires the exact `SourceFile` object, resolves its
  `IrSourceId`, filters terminal units by that ID, and deduplicates whole-source
  failures by source ID. A cloned AST with the same filename is rejected with
  the typed `source-record-mismatch` invariant.

The Stage 3 checkpoint passes **86/86** focused identity, context, propagation,
projection, outcome, multi-source, and linear tests. Typecheck, lint,
formatting, diff, and LOC-budget checks pass. Selection, feature plans,
IR-first closure, and final outcome correlation still need to retain IDs
through their remaining legacy calls.

Stage 4 adds the structural selector and a fail-closed legacy projection:

- `planIrCompilationByIdentity` keys function/member claims, fallbacks,
  recursive evidence, and local call edges by `IrUnitId`; class-member facts
  also retain their exact `IrClassId`, while names remain compatibility labels;
- exact terminal/class/module ownership is validated against the authoritative
  context. Missing or mismatched joins raise typed planning invariants instead
  of becoming name lookups, plain errors, or silent omissions;
- the structural receiving population includes unnamed functions, anonymous
  class members, and implicit-constructor terminals even when an existing
  direct failure keeps them outside the claim set;
- duplicate function/class labels and repeated class-shape descriptors never
  choose first/last wins. The adapter omits ambiguous occupants and re-closes
  their local-call component with the existing host-versus-standalone caller
  policy before producing the still-name-keyed `IrSelection`; and
- the structural selector reuses the production selector predicates and has a
  direct unambiguous projection-parity test. This checkpoint is additive; the
  production overlay has not switched to it yet.

The Stage 4 selector suite passes **12/12**. The combined #3520, #3142,
#3143, and #3529 selector/preclaim matrix passes **192/192**. Typecheck, lint,
formatting, diff, and LOC-budget checks pass. The standalone #1169q control
retains its pre-existing async fallback-expectation mismatch (**9/10**); no
selector semantics changed. No local Test262 run or baseline refresh was
performed.

Stage 5 moves the production overlay onto that structural selector boundary and
adds exact imported-target identity without changing the legacy lowering API:

- production builds one `IrUnitTypeMap`, selects through
  `planIrCompilationByIdentity`, and retains the exact selection, omitted IDs,
  declaration/type rows, and safe `IrUnitId` population throughout override
  preparation;
- the still-name-keyed override, integration, and slot interfaces receive only
  the validated unambiguous projection. Within-source duplicate labels are
  omitted before preparation, and safe names are projected only from the
  retained safe IDs;
- every preparation-time removal keeps the structural safe-ID population and
  its legacy projection synchronized. The old independent selector call,
  independently projected TypeMap, and last-wins top-level declaration scan
  are no longer used by the production overlay;
- the imported-function resolver now has an additive structural form that
  resolves checker-selected declarations to exact `targetUnitId` values.
  Cross-source same-label targets remain distinct and are marked ambiguous
  only at the final legacy compatibility projection; and
- the existing two-argument imported resolver preserves its behavior, while
  cloned, stale, duplicate, or out-of-population source objects fail with typed
  planning invariants in the structural form.

The combined Stage 5 matrix passes **265/265** across all #3520 identity,
projection, context, selector, and overlay suites plus #3214 callable/imported
callback coverage, #3142 module-init, #3143 IR-first, #3529 selector preclaim,
and #2138 multi-module overlay. Typecheck, lint, formatting, diff, and
LOC-budget checks pass. No local Test262 run or baseline refresh was performed.

Stage 6 carries structural identity through the first exact lowering plans:

- imported-call, top-level function-value, and host-callback plans now retain a
  required `ownerUnitId`; imported/function-value plans also retain the exact
  checker-selected `targetUnitId`;
- multi-source production creates the exact imported resolver from the
  authoritative planning context, gives selection only its explicit
  ambiguity-rejecting legacy adapter, and correlates every named certification
  back to the exact resolver at the same AST node before constructing a plan;
- integration receives the validated owner-ID projection alongside the
  remaining name-keyed plan maps and supplies the exact active owner to the
  AST lowerer. Imported calls, function values, host callbacks, and their
  nested lifted bodies reject missing or mismatched owner IDs before emitting
  IR; and
- target IDs remain side-by-side with the current symbolic backend names. This
  stage does not claim that `IrFuncRef` or backend slot lookup is structural
  yet; that is Commit 3 work.

The expanded structural/overlay/feature matrix passes **269/269**. The
fallback gate remains unchanged with zero unintended, post-claim, or
module-level increases, and hybrid IR-only readiness remains **31 emitted / 6
typed Unsupported / 0 Invariants** across 37 terminal units. Typecheck, lint,
formatting, diff, and LOC-budget checks pass.

Stage 7 completes Commit 2's source-planning identity migration:

- Promise-delay plans, module-binding uses, local-class evidence, host-Date
  snapshot plans, and the linear source seam retain exact owner/class IDs.
  Name-keyed lowering and slot APIs are reached only through their validated
  legacy projections;
- blocked-component closure, IR-first skip selection, multi-source safety, and
  terminal outcome correlation are ID-keyed. Named compiler results cannot
  satisfy a foreign or same-labelled unit, and closure is computed over the
  full safe function population before the requested skip subset is projected;
- class shapes are indexed by `IrClassId` with exact checker-selected
  declarations and parent identities. The remaining class-shape name map is a
  checked compatibility view rather than semantic identity;
- integration validates the exact selected function, class-member, compiler
  support, and module-init AST populations. Finalization also proves that
  callback, Promise, and Date sites remain reachable from their exact active
  owners. Replaced, detached, or reordered AST populations fail with typed
  planning invariants instead of matching by text or span;
- integration reports distinguish terminal compiled owners from synthetic
  artifacts and reconcile every logical error event with all public error
  objects. Raw compiled/error labels are telemetry only and cannot prove
  terminal success or patch safety;
- the fallback gate now carries the graph-wide identity inventory, context,
  unit types, and structural selection through its accounting, projecting to
  labels only for the final stable histogram; and
- new identity plumbing was extracted from `planIrOverlay` and
  `generateMultiModule`. Both functions are smaller than the pre-Stage-7 HEAD,
  so the checkpoint adds no new god-function size debt.

The complete #3520 matrix passes **145/145** and the compatibility matrix
passes **249/249**. Hybrid IR-only readiness remains **31 emitted / 6 typed
Unsupported / 0 Invariants** across 37 terminal units. The fallback gate has
zero unintended, post-claim, or module-level increases. Typecheck, formatting,
diff, and LOC-budget checks pass; the six existing god-file baseline failures
remain, while both functions touched by this stage shrink. No local Test262 run
or baseline refresh was performed.

Commit 2 is complete. `IrFunction`/`IrFuncRef`, pass edit tables, verification,
and backend callable references remain the next Commit 3 boundary; whole-
program ABI binding and the legacy slot adapter remain Commit 4.

Stage 8 begins Commit 3 by making function-artifact identity total:

- every `IrFunction` now carries its required `IrUnitId`; the builder accepts
  the structural ID and compatibility label atomically, and WasmGC integration
  rejects a selected function, class member, or module initializer that lacks
  its exact prepared identity;
- main functions retain their terminal owner ID. Lifted closures and nested
  functions derive IDs from `{ parentId, "lifted-closure", ordinal }`, with
  label and ID allocated from the same counter. Monomorphization clones derive
  from the callee ID and canonical clone-plan ordinal rather than clone names;
- the linear integration seam supplies the same owner IDs, and every other
  production pass copy preserves `unitId`. Repeated benchmark construction now
  uses explicit, stable artifact IDs rather than process-order counters;
- the self-host cache stores an `Omit<IrFunction, "unitId">` template, checks
  resolver/dialect/type-index eligibility before lookup, fingerprints the
  template input, and rematerializes a fresh artifact with the caller's live
  support ID; and
- the frozen interchange contract is now v2.0. Serialized functions and
  coverage rows both require `unitId`; `name` is documented as the temporary
  compatibility/reference label while callable/global/type references remain
  symbolic in this bounded sub-slice.

The #3520/backend/phase3c matrix passes **168/168**; including the repeated-
benchmark identity proof, the focused matrix has **174 passing** with one
intentional skip. The compatibility matrix passes **233/233** and the cross-
backend differential suite passes **29/29**. Full equivalence remains **1,608
passing / 35 failing** against 36 known baseline failures: there are no new
regressions and one baseline failure now passes; the baseline is intentionally
unchanged. Hybrid IR-only readiness remains **31 emitted / 6 typed Unsupported
/ 0 Invariants** across 37 terminal units, and the fallback gate has zero
unintended, post-claim, or module-level increases. The separate six-file
known-base matrix is **51 passing / 11 known failures** on this branch versus
**50 passing / 12 failures** on exact control `7906aa8a80327c`: all 11 branch
failures reproduce identically, while the required-identity fixture migration
fixes one stale scaffold failure. Typecheck, lint, formatting, diff, and LOC-
budget checks pass. No local Test262 run or baseline refresh was performed.

Commit 3.1 is complete. Typed callable binding/reference migration, structural
pass edit tables, and backend binding consumption remain the next Commit 3
sub-slices; whole-program ABI binding and the legacy slot adapter remain Commit 4.

Stage 9 completes the Commit 3.2 callable-binding checkpoint:

- every `IrFuncRef` carries a required closed binding domain: exact source or
  compiler unit, declared import, runtime symbol, intrinsic, or structurally
  derived support binding. Factories validate and freeze those references;
  the verifier rejects legacy name-only calls and lifted-function references,
  including refs nested inside buffered control-flow instructions;
- source direct calls are planned at their exact `CallExpression` sites and
  carry the target `IrUnitId` plus signature. Imported calls, top-level
  function values, closure trampolines, lifted functions, Promise support,
  class dispatch, and monomorphized clone calls retain their structural target
  or provider binding instead of reconstructing identity from a label;
- WasmGC binds source-unit refs through an exact unit-to-slot table and never
  falls back to a same-labelled runtime/helper slot. Linear Wasm and Porffor
  bind source units by ID as well; runtime, intrinsic, and import dispatch use
  their structural symbol or module field. The remaining compatibility label
  use is confined to the temporary exact unit/support-to-legacy-slot adapter;
- helper preregistration and string-encoding analysis classify by binding
  domain and symbol. Source functions deliberately named like string,
  dynamic-boxing, or undefined-check helpers do not register or resolve the
  corresponding provider; and
- the interchange contract is now v3.0. Schema and documentation require the
  closed callable binding union while retaining `name` only as compatibility
  and diagnostic metadata.

The changed-file matrix passes **115/115** with two intentional skips. The
binding-aware backend/self-host matrix passes **50/50** with one optional
Porffor skip; the class inheritance/collision matrix passes **21/21**; and the
linear/cross-backend regression matrix passes **35/35**, including all 29
differential cases. Typecheck and diff checks pass, and the protected Test262
log and equivalence baseline are unchanged. The LOC allowance records this
checkpoint's required contract threading; extracting the remaining legacy
adapter machinery is follow-up work rather than part of this paused slice.

Commit 3.2 is ready for review. Structural inline/monomorphization edit maps,
integration evidence maps, and the final Program ABI slot adapter remain for
Commit 3.3 and Commit 4 before R1 can close.

## Resume checkpoint

- **Branch:** `symphony/3520-r1-planning-identity`
- **Draft PR:** `#3496`
- **Resume from:** the branch tip containing Stage 9 / Commit 3.2. The pushed
  worktree is expected to be clean; no stash or local-only patch is required.
- **First task:** replace the remaining source-function `byName` tables in
  `src/ir/passes/inline-small.ts` and `src/ir/passes/monomorphize.ts` with
  `IrUnitId`/callable-binding maps. Recursion detection, rewrite sites, clone
  plans, and pass-output reconciliation must all use the same structural key.
- **Then:** migrate integration verifier/error/pass bookkeeping to IDs, thread
  support/import bindings through the backend ABI tables, and replace the
  temporary exact-unit/support-to-legacy-label slot join with `ProgramAbiMap`
  resolution. Only after those steps should R1 acceptance be reevaluated.
- **Do not touch:** `benchmarks/results/test262-run.log` or
  `scripts/equivalence-baseline.json`. No local Test262 run is required for
  this checkpoint.
- **Known unrelated control:** two #2956 L3 string/charCode fixtures remain
  pre-existing failures; binding-affected linear cases and the 29-case
  cross-backend suite pass.
- **Not rerun after Stage 9:** the full equivalence gate and fallback/readiness
  ratchets. Run them before declaring R1 complete; do not infer completion from
  the focused matrices below.

### 2026-07-25 resume state

- Pulled `origin/main` to `6f3e4358033ab8`, then merged it into the continuation
  branch at `30e3553f48b972`. Draft PR #3496 now has a current-main checkpoint.
  The main checkout's existing Test262 log change and `.capc-worktree` link
  were left untouched.
- Reconciled current-main #3565 verifier demotions with #3520's grouped
  terminal-evidence ledger. Public diagnostic order stays stable, while a
  mixed verifier event selects a real invariant as its terminal
  representative. Current-main #2952's new iterator-close call is also typed
  as a runtime binding instead of reintroducing a name-only `IrFuncRef`.
- Merge validation is green: **64/64** focused #2138/#3519/#3520/#3565/#680
  tests, **71/71** #2952 control-flow tests, TypeScript with incremental output
  disabled, scoped Biome lint, Prettier, and diff checks on the resolved files.
- The pre-dispatch gate correctly reported the existing
  `ttraenkler/codex-r1` claim and active #3518 dependency; this is the same R1
  continuation, not a competing dispatch. Three isolated, pushed Symphony
  worktrees were assigned disjoint Commit 3.3 lanes:
  `symphony/3520-c33-inline`, `symphony/3520-c33-monomorphize`, and
  `symphony/3520-c33-integration`.
- Commit 3.3 also absorbed current-main #3551: its ABI-withdrawal cascade,
  reference scan, and orphan-slot records now use exact callable/unit and
  owner identities while preserving withdrawal and stubbing behavior.

### Commit 3.3 completion

- Integrated and pushed the three isolated lanes:
  `5fb6df6272df26` keys inline-local resolution and recursion by `IrUnitId`;
  `06e51c25e4873b` keys monomorphization grouping, clone provenance, growth,
  and edit tables by identity; and `6cf2d2744ae4ee` keys integration artifact
  ownership, failure/TU evidence, pass reconciliation, ABI withdrawal, and
  orphan-slot ownership structurally.
- Added exact duplicate-label/provider regressions for inline,
  monomorphization, nested withdrawal, tagged-union attribution, and
  synthetic-vs-terminal report classification. Runtime/import/intrinsic/
  support lookalikes never become local unit edges.
- Combined validation passes **209/209** across 32 focused #3520/#3529/#3551/
  #3565/#3471/phase3c files. A strict-nullability rerun exposed and fixed an
  impossible post-pass artifact dereference at `fa789b2cc4cbc6`; the focused
  post-fix matrix passes **45/45**, TypeScript is green with incremental output
  disabled, and scoped Biome, Prettier, diff, and LOC checks pass.
- Commit 4 is active in three additional isolated, pushed worktrees:
  `symphony/3520-c4-class-identity`,
  `symphony/3520-c4-backend-identity`, and
  `symphony/3520-c4-abi-session`. The cutover must publish one program-owned
  ABI map after the index space freezes; a per-source map is not acceptable.

### 2026-07-26 Commit 4 foundation checkpoint

The Commit 4 foundation is integrated through `54f30f076f8dbb`, but R1
acceptance remains partial and this issue stays `in-progress`. The integrated
sequence is:

- `100d13edd532d9` makes class shapes source-qualified, and
  `e9674975ee622c` keys class integration caches and checks by exact
  `IrClassId`;
- `b88293dc401ebe` creates one compilation-owned `ProgramAbiSession` for each
  single- or multi-source compilation that requests the IR identity inventory;
- `cf88b88f6d2bc8` keys source-function backend tables by `IrUnitId`;
- `8a574b16b2e6e4` binds the currently adapted globals through structural
  `IrBindingId` references; and
- `50816a88d826f5` plus `216f5ea9e1c370` harden the session lifecycle and make
  every adapted global producer prove the same canonical payload and
  structural order; and
- `54f30f076f8dbb` removes the obsolete name-keyed local-call and
  overlay-finalization cluster after every production caller moved to the
  `IrUnitId`-keyed implementation.

The foundation now validates these boundaries:

- a single session owns the inventory, plan, allocator-object locators, and
  publication for its exact `WasmModule`;
- module, TDZ, argument-count, and function-value-cache globals are planned by
  canonical binding payload rather than display name;
- the runtime API supports exact defined-function/global locator replacement,
  imported slot resolution after late index shifts, and explicit type-cell or
  type-object remaps; and
- publication is one-shot and occurs immediately after
  `indexSpaceFrozen = true`, so final indices are resolved from the frozen
  module layout.

Validation at `216f5ea9e1c370` passes the strict TypeScript check; all #3520
suites plus backend contract, linear integration, and cross-backend coverage
(**34 files / 239 tests**); Prettier; scoped Biome lint with the two existing
`index.ts` `any` warnings; the diff check; and the LOC-budget check. After the
cleanup, the #3143, #3203, #2138, and complete #3520 matrix passes
**249/249**, and `check:dead-exports` reports **15 known / 0 new**. Strict
TypeScript, Prettier, scoped Biome, diff, and LOC checks remain green.

This is not yet the whole-program ABI cutover described by Commit 4:

- production `ProgramAbiSession` planning currently covers the adapted defined
  globals only; callable signatures, callable/global imports, Wasm types,
  classes/layouts, exports, aliases, support bindings, and derived-unit
  provenance are not yet populated as production ABI entries;
- source functions and classes carry structural identity through the IR and
  pass tables, but concrete WasmGC, linear, and compatibility-slot resolution
  still contains direct `funcMap`, `structMap`, module-array, and display-name
  scans instead of routing exclusively through `LegacyAbiAdapter`;
- function/global replacement and type remap APIs have focused lifecycle
  coverage, but allocator replacement, dead-type elimination, and compaction
  do not yet notify the production session; and
- exports are still emitted directly by legacy codegen rather than represented
  as explicit Program ABI aliases.

Accordingly, the acceptance criteria below remain unchecked. This checkpoint
does not enable IR-only mode by default and does not justify retiring any
direct codegen path. Preparation ownership, compile-once migration, remaining
runtime/async/linear adoption, fallback removal, and direct-handler deletion
remain later R2-R10 work and are explicitly outside R1.

### Final PR #3496 validation

- The branch was merged forward through current-main runtime, call, literal,
  interpreter, module-init, global-environment, and baseline-contract changes.
  Main-owned semantics remain present, including the current #2726
  global-environment delete guard.
- The required CI guard suite exposed a missing structural-order anchor for
  ambient and transformed-import classes that have no executable `IrUnit`.
  `ProgramAbiStructuralOrder` now assigns those classes deterministic,
  source-local tail anchors while preserving the existing source, unit, and
  member-backed class anchors. Dedicated coverage includes multiple zero-unit
  classes, mixed live/ambient populations, reversed source input, transformed
  import wrappers, and the exact #2961/#3565 regressions; the final focused
  post-merge matrix passes **44/44**.
- Strict TypeScript, full Biome lint, Prettier, diff, LOC, function-budget,
  oracle, dead-export, issue, and change-scoped quality gates pass. The
  dead-export audit reports **15 known / 0 new** after deleting the obsolete
  name-keyed overlay cluster.
- The post-main regression matrix passes **397 tests in 43 files**, with 46
  intentional Test262-harness skips. It covers every #3520 suite, #2138,
  backend contract, linear integration, cross-backend differential coverage,
  and the current-main #2928/#3615/#3623/#3637/#3638/edition fixtures.
- `check:ir-fallbacks -- --verbose` reports no unintended, post-claim, or
  module-level increase. Hybrid IR-only readiness remains **READY** across 37
  terminal units: **31 emitted / 6 typed Unsupported / 0 Invariants**.
- Full equivalence reports **1,608 passing / 35 known failures**, with no new
  regression and one known baseline failure now passing. The equivalence
  baseline remains unchanged.
- No local Test262 corpus run was performed.
  `benchmarks/results/test262-run.log` and
  `scripts/equivalence-baseline.json` remain unchanged.

### PR #3496 merge-group regression repair

- Exact merge-group run `30183268819` at head
  `83b55f7790096a93aa60c97c25cd14e22d30b1e3` failed the Test262 regression
  and standalone guards against immutable baseline commit
  `de3acdd66f5e9835108502b92e4648747e541a3d`. The host gate reported 63
  stable non-timeout regressions and 31 improvements; 56 of those regressions
  shared the structural-identity diagnostic repaired here. All 52 standalone
  non-CT regressions shared the same diagnostic.
- The field-evaluation support record and a function or arrow used as its
  initializer both used the initializer expression as their declaration
  anchor. This violated the planning context's intentional declaration/unit
  bijection. Field evaluation is a property operation, while the nested
  callable is a separate executable unit, so static and instance field units
  now anchor to their `PropertyDeclaration`. An implicit constructor likewise
  anchors to its class declaration rather than borrowing the first instance
  initializer.
- Moving the inventory anchor exposed a second stale assumption in IR-first
  call-edge collection: property initializers still resolved their terminal
  owner through the initializer expression. They now resolve the field unit
  through the property declaration, then retain the initializer expression as
  the body boundary. This preserves module-init ownership for static fields and
  constructor ownership for instance fields without aliasing nested callable
  units.
- Both defects have red-before-fix invariant tests. The focused identity matrix
  passes 39/39. Replaying the exact affected baseline-pass/candidate-regression
  paths locally restores 56/56 host rows and 52/52 standalone rows to runtime
  pass. A fresh-process standalone replay also passes 52/52 on both this branch
  and current-main control `dde8800c95694231e76ca3a56512a4060dbf81ad`.
  The baseline and allowlists are unchanged; rows outside this diagnosed
  signature are not attributed to this repair.
- After merging current main `c941712943f45994149480b60165b5e18afb9505`,
  the complete #3520/#2138 matrix passes 212/212. Strict TypeScript, lint,
  formatting, LOC, fallback, and hybrid IR-readiness gates pass, with 31
  emitted / 6 typed Unsupported / 0 Invariants. The linear/cross-backend matrix
  passes 43/43. Full equivalence reports 1,608 passing / 35 known failures,
  zero new regressions, and one known baseline failure now passing; the
  equivalence baseline remains unchanged.

Minimum resume validation:

```bash
pnpm run typecheck
pnpm run check:loc-budget
pnpm exec vitest run tests/issue-3520*.test.ts tests/issue-2138-multi-module-ir-overlay.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm exec vitest run tests/linear-integration.test.ts tests/cross-backend-diff.test.ts tests/issue-3000-c.test.ts tests/issue-3000-e.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-fallbacks -- --verbose
node scripts/equivalence-gate.mjs
```

### 2026-07-26 production callable/imported-global continuation

The first production ABI populations after PR #3496 are implemented on
`codex/3520-c4-production-abi`:

- every inventory-backed source/unit callable observed by WasmGC IR integration
  now receives the canonical `callable/body` binding ID, a structural callable
  reference key, a canonical signature intention, and an exact
  `WasmFunction` locator;
- migrated unit calls resolve through
  `ProgramAbiSession.resolveCurrentIndex(...)`, so late function-import shifts
  are resolved from the current allocator layout instead of a captured
  `funcMap` index;
- overlay replacement and orphan stubbing update the exact function locator in
  the same mutation seam, so ABI publication follows the final function object;
- host string-constant globals now plan exact imported-global intentions
  anchored to the unique entry source, including deterministic literal order,
  deduplication, late/interleaved imports, lone-surrogate field encoding, and
  the valid empty import field; and
- native-string builds retain the no-import sentinel path and publish no
  string-constant ABI entries.

The complete #3520 matrix plus #2138 multi-source coverage passes **216/216**
across **35 files**. Strict TypeScript, LOC budget, Prettier, and diff checks
pass. Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed
Unsupported / 0 Invariants / 37 legacy bodies**, and the fallback ratchet
reports no unintended, post-claim, or module-level increase. Full equivalence
reports **1,608 passing / 35 known failures / 0 new regressions**, with one
known baseline failure now passing; the baseline remains unchanged.
The existing `ir-scaffold` host fixture still fails **1/7** because it does not
provide the already-requested `env.__unbox_number` import; the identical
failure reproduces on untouched PR #3496 head `c96312ba`.

This remains a bounded R1 continuation, not the final ABI cutover. Derived
lifted and monomorphized units remain explicitly unplanned because
`LoweredFunctionResult` and the monomorphization sidecar do not yet preserve
the complete `{ parentId, sourceId, terminalOwnerId, role, ordinal }`
`ProgramAbiDerivedUnitRecord`. No display-label or encoded-ID inference is
used. Imported/runtime/intrinsic/support callables, remaining imported globals,
Wasm types and class layouts plus DCE remaps, exports and aliases, and
production `LegacyAbiAdapter` replacement of the remaining `funcMap`,
`structMap`, module-array, and display-name scans still remain before R1 can
close.

### 2026-07-26 lifted-callable provenance continuation

The next stacked continuation on `codex/3520-c5-derived-provenance` moves
successfully emitted lifted closures into the production Program ABI:

- lifted allocation now preserves exact `{ id, parentId, role, ordinal }`
  provenance beside `LoweredFunctionResult`; integration joins it to the
  authoritative inventory's `sourceId` and terminal owner by ID, never by
  output order, encoded ID, or display label;
- accepted lifted functions register complete `ProgramAbiDerivedUnitRecord`
  values only after lowering has produced the settled Wasm function and
  signature. The owner body retains derived suborder zero and its owner-wide
  lifted ordinals occupy one-based suborders;
- the backend keeps an exact `IrUnitId -> WasmFunction` table and resolves the
  current live or stable function handle from the allocator object. Synthetic
  compatibility labels may therefore collide with source functions without
  aliasing their slots or locators;
- derived callable planning occurs after the placeholder is replaced, so the
  ABI records the real lowered signature rather than placeholder type zero;
  and
- integration telemetry continues to classify terminal versus synthetic
  artifacts from exact artifact/owner IDs. Equal public labels no longer
  manufacture a false invariant.

The production collision regression compiles one source owner, two lifted
closures, and a top-level function deliberately named like the first lift. All
four callables publish distinct final function slots while the legacy
name-only adapter correctly rejects the ambiguous label. The complete #3520
matrix plus #2138 passes **221/221** across **36 files**. Strict TypeScript,
Prettier, scoped Biome lint, diff, and LOC checks pass. Hybrid readiness remains
**READY** at **31 IR-emitted / 6 typed Unsupported / 0 Invariants / 37 legacy
bodies**, and the fallback ratchet reports no unintended, post-claim, or
module-level increase. The eight-shard equivalence gate passes with **1,608
passing / 35 known failures / 0 new regressions**; one baseline failure now
passes.

This is still a bounded lifted-only slice. Monomorphization already creates
exact clone IDs but its result sidecar drops the clone role and parent-local
ordinal. More importantly, clone-local ordinals are not injective across
different lifted parents after structural ordering collapses to the inventory
ancestor. The next derived-unit slice must preserve full clone provenance and
assign an explicit provenance-path (or equivalent owner-wide) ABI rank before
monomorphized clones can leave the compatibility adapter. Provider/import/
runtime/support callables, remaining imported globals, Wasm types and class
layouts plus DCE remaps, exports and aliases, and the production
`LegacyAbiAdapter` cutover remain after that.

### 2026-07-26 monomorph-clone provenance continuation

The next stacked continuation on `codex/3520-c6-monomorph-provenance` moves
monomorphization clones through the same exact derived-unit Program ABI
contract:

- `monomorphize` now returns one immutable
  `{ id, parentId, role: "monomorphization-clone", ordinal }` provenance record
  for every clone, including clones whose parent is itself a lifted unit. The
  legacy clone-origin sidecar remains temporarily for compatibility, and
  integration rejects any disagreement between origins, provenance,
  signatures, and output functions.
- Integration composes each clone's `sourceId` and `terminalOwnerId` through
  its exact parent record. It registers the complete derived graph
  topologically before callable planning, so module/pass insertion order
  cannot make a child appear to be an inventory root or erase a lifted parent.
- `ProgramAbiStructuralOrder` assigns dense, deterministic per-root ranks from
  complete role/ordinal provenance paths. Source bodies retain rank zero;
  parents precede descendants; the same clone ordinal under two different
  lifted parents cannot collide; and reverse registration/planning order
  produces the same ABI order.
- Ordering is sealed per inventory root rather than globally. A source that
  has started planning rejects later descendants beneath that root, while a
  distinct source may still register a child before its parent. Root-local
  descendant traversal also prevents an unrelated incomplete provenance graph
  from poisoning another source's ordering.

The production integration-contract regression runs the real monomorphizer,
then injects two contract-valid ordinal-zero clones beneath two real lifted
closures sharing one source owner. The clones are deliberately placed before
their parents and in reverse order; publication still recovers
owner/lift/clone provenance order, exact binding IDs, distinct final function
slots, exact function objects, and the distinguishing `f64` versus branded
boolean parameter/result types. This seam is intentionally explicit:
production source lowering currently normalizes direct-call tuples to one
callee signature, so no natural source fixture reaches monomorphization with
heterogeneous tuples. Pass-level tests continue to prove real clone discovery,
call rewriting, and ordinals.

The strengthened regression also exposed the next concrete R1 boundary.
Callable intents containing capture-reference types retain their pre-DCE
`typeIdx`, while the final located Wasm function correctly uses the compacted
post-DCE index. Final identity, locator, and callable dispatch are correct, and
no current consumer treats the stale signature metadata as authoritative.
Program ABI type intentions plus DCE remap notification must nevertheless land
before signatures or aliases can become authoritative; the regression binds
all stable non-capture positions and documents the deferred ref-index check.

The complete #3520 matrix plus #2138 passes **224/224** across **37 files**.
Strict TypeScript, Prettier, scoped Biome lint, diff, and LOC checks pass.
Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants / 37 legacy bodies**, and the fallback ratchet reports no
unintended, post-claim, or module-level increase. The eight-shard equivalence
gate passes with **1,608 passing / 35 known failures / 0 new regressions**; one
baseline failure now passes, and the baseline remains unchanged.

This remains a bounded R1 slice. Provider/import/runtime/support callables,
remaining imported globals, Program ABI type intentions and DCE remaps, class
layouts, exports and aliases, and the production `LegacyAbiAdapter` cutover
still remain before R1 can close.

### 2026-07-26 type-layout authority continuation

The next stacked continuation on `codex/3520-c7-type-remap` makes the callable
and global intentions already populated by production code authoritative
through DCE type compaction:

- callable and global planners retain immutable structured `ValType`
  contracts beside the frozen public draft. The public canonical strings are
  materialized only at publication, after all reported layout changes;
- dead type elimination constructs the complete old-to-final type-index
  vector, including explicit `null` entries for eliminated types, and reports
  the exact before/after type arrays while the old layout is still installed;
- `ProgramAbiSession` validates the complete layout before changing state,
  remaps every callable/global reference and exact type cell together, and
  rejects invalid, incomplete, ambiguous, or eliminated-reference layouts;
- matching aliases inherit the remapped canonical contract. Aliases whose
  original intent differs retain their own intent and continue through the
  existing `ProgramAbiMap` mismatch checks; and
- function/global locator replacements and final publication validate the
  concrete allocator object against the tracked contract. A late replacement
  can no longer make stale metadata look authoritative.

The production regression compiles a real lifted closure and a contract-valid
monomorph clone whose capture reference shifts during DCE. Both published
signatures now exactly equal their final located Wasm function types, including
the compacted capture index and their distinct `f64` versus branded-boolean
parameters/results. Lower-level regressions cover callable, alias, global, and
type-cell remapping plus transactional rejection of malformed layouts.

The complete #3520 matrix plus #2138 passes **227/227** across **38 files**.
Strict TypeScript, Prettier, scoped Biome lint, diff, LOC, function-budget,
dead-export, and oracle-ratchet checks pass. Hybrid readiness remains **READY**
at **31 IR-emitted / 6 typed Unsupported / 0 Invariants / 37 legacy bodies**,
and the fallback ratchet reports no unintended, post-claim, or module-level
increase. The eight-shard equivalence gate passes with **1,608 passing / 35
known failures / 0 new regressions**; one baseline failure now passes, and the
baseline remains unchanged.

This closes the concrete stale capture-reference gap exposed by C6, but not all
of R1. Provider/import/runtime/support callables, remaining imported globals,
Program ABI type and class-shape intentions, exports and aliases, and production
`LegacyAbiAdapter` replacement of the remaining `funcMap`, `structMap`,
module-array, and display-name scans still remain before R1 can close.

### 2026-07-26 function-value support-callable continuation

The next stacked continuation on `codex/3520-c8-support-callable` moves the
cached top-level function-value trampoline into the production Program ABI:

- function-value preparation now validates and publishes the exact trampoline
  and closure-cache allocator objects as one pair. The trampoline is a
  unit-anchored `callable/support` entry; its existing companion cache remains
  an exact `global/support` entry;
- support-callable planning recomputes the opaque binding ID from the
  authoritative unit anchor and semantic role, owns one exact required
  `WasmFunction` locator, and registers the complete callable type contract.
  The API deliberately supports only ordinal zero until structural ordering
  has an explicit artifact-ordinal dimension;
- the resolver consults a planned support binding by structural key before any
  intrinsic, runtime, or compatibility-name fallback. Once planned, a support
  reference cannot silently redirect through `funcMap`; and
- the paired planning helper lives in `program-abi-planning.ts`, leaving the
  already-large codegen driver seven lines smaller than the C7 branch.

The production regression passes a deliberately nonexistent compatibility
label through the real integration resolver and proves that it still reaches
the exact trampoline slot. It then verifies that the published signature
contains a reference type and exactly matches the final post-DCE function
type. A source-name collision separately proves that a demoted owner publishes
no nonexistent support entry. Planner regressions cover relabelling, a late
function import, mismatched reference role and final signature, and duplicate
allocator ownership.

The complete #3520 matrix plus #2138 passes **232/232** across **39 files**.
The related #3214 callable and imported-HOF matrix passes **60/60** across
**3 files**.
Strict TypeScript, Prettier, Biome lint, diff, LOC, function-budget,
dead-export, and oracle-ratchet checks pass. Hybrid readiness remains **READY**
at **31 IR-emitted / 6 typed Unsupported / 0 Invariants / 37 legacy bodies**,
and the fallback ratchet reports no unintended, post-claim, or module-level
increase. The eight-shard equivalence gate passes with **1,608 passing / 35
known failures / 0 new regressions**; one baseline failure now passes, and the
baseline remains unchanged.

This is the first non-unit defined support callable with an authoritative
production locator, not the end of R1. Non-externref class constructor/init
callables are covered by C9; class-method adapters and externref/Promise-host
helpers remain. Exact imported callable IDs and import locators, dual-mode
runtime/intrinsic providers, remaining imported globals, Program ABI
type/class-layout entries, exports and aliases, and the production
`LegacyAbiAdapter` cutover still remain.

### 2026-07-26 class constructor/support-callable continuation

The next stacked continuation on `codex/3520-c9-class-support-callables`
makes the non-externref WasmGC class constructor pair structurally
authoritative in the production Program ABI:

- `<Class>_new` now resolves to exactly one inventoried
  `class-constructor` or `class-implicit-constructor` unit beneath the exact
  `IrClassId`. The integration seam binds that unit to the allocator-owned
  constructor slot; an omitted source constructor remains a source-unit
  callable and never receives a fabricated support identity.
- `<Class>_init` is now a class-owned `callable/support` entry anchored by the
  exact `IrClassId` and semantic `class-constructor-init` role. It carries
  class-local structural order, the exact defined-function locator, and a
  callable contract that is checked again against the final post-DCE type.
- Support-callable intent now requires exactly one inventoried owner: a unit
  or a class, never both. Source callables reject class provenance;
  import/runtime callables reject source provenance; foreign owners and wrong
  source order fail with typed Program ABI invariants. Session draft equality
  includes the class owner.
- Compatibility-only integration builds and reuses the same exact planning
  identity context for class-shape resolution. Missing or duplicate
  constructor units, absent or mismatched allocator slots, and non-function
  `_init` types fail closed instead of falling back through a display label.
- A collision fixture relocates a compiler-owned `A_init` beside a user
  function named `A_init`, proves distinct ABI IDs and final function slots,
  verifies the published post-DCE signature against the located function, and
  executes the IR `super(...)` path to `"Rex/4|Lab|99"`.

The focused C9 matrix passes **21/21**. The complete #3520 matrix plus #2138
passes **243/243 across 41 files**; the class/collision matrix passes
**27/27**; and the linear/cross-backend/class matrix passes **43/43**. Strict
TypeScript, Biome lint, Prettier, diff, LOC, function-budget, dead-export,
oracle-ratchet, and issue-spec checks pass. Hybrid readiness remains **READY**
at **31 IR-emitted / 6 typed Unsupported / 0 Invariants / 37 legacy bodies**,
and the fallback ratchet reports no unintended, post-claim, or module-level
increase. The eight-shard equivalence gate reports **1,608 passing / 35 known
failures / 0 new regressions**; one baseline failure now passes and the
baseline remains unchanged. No local Test262 corpus run or baseline refresh
was performed.

This is a bounded class-constructor ABI slice, not completion of class or R1
ABI ownership. Externref-backed classes (including the JS-host Promise
`*_new__onhost` path) have no WasmGC `_init` and remain excluded. Inherited
ordinary instance-method adapters are covered by C10; inherited accessors,
statics, and other synthetic helpers remain. Exact imported callables and
import locators, dual-mode runtime/intrinsic providers, Program ABI
type/class-layout entries, exports and remaining alias families, and production
`LegacyAbiAdapter` replacement of the remaining `funcMap`, `structMap`,
module-array, and display-name scans still remain before R1 can close.
Preparation/body ownership, routing policy, and R2-R10 work are unchanged.

### 2026-07-26 inherited instance-method alias continuation

The next stacked continuation on `codex/3520-c10-class-method-aliases` moves
projected local instance-method adapters into the production Program ABI:

- an inherited child method is now an explicit class-owned support alias of
  the exact ancestor source-method callable. The alias has its own structural
  reference, provenance, deterministic inventory-derived order, and callable
  contract, but owns no locator or independent function slot;
- ancestor class shape, AST declaration, source unit, allocator handle,
  `WasmFunction` object, and current Program ABI slot must all agree before the
  alias can be planned. The legacy label is only a consistency assertion and
  cannot select the canonical method;
- structural resolution follows `aliasOf` through the canonical source
  callable. A relocated child compatibility key therefore remains stable
  across import insertion, type-layout remapping, and final DCE publication;
  and
- accessors, statics, externref-backed classes, unresolved projections, and
  builds without a Program ABI session deliberately remain on the
  compatibility seam until their member/provider identities are exact.

The production regression covers an `A -> B -> C` hierarchy, a method
overridden in `B`, a second method inherited transitively from `A`, and a user
function that collides with `C_m`. It proves that `C.m` aliases the exact `B.m`
source unit, `C.n` aliases the exact `A.n` source unit, neither child adapter
allocates a function, both published post-DCE reference-bearing signatures
match their canonical functions, the colliding user function owns a distinct
slot, and the emitted program executes to the expected value. Planner
regressions cover reversed discovery order, multiple derived ordinals,
relabelling, late function imports, type remapping, structural-reference
mismatch, and wrong owner/role/ordinal identities.

The complete #3520 matrix plus #2138 passes **246/246 across 42 files**; the
focused class/planner matrix passes **41/41**; and the
linear/cross-backend/class matrix passes **43/43**. Strict TypeScript, Biome
lint, Prettier, diff, LOC, function-budget, dead-export, and oracle-ratchet
checks pass. Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed
Unsupported / 0 Invariants / 37 legacy bodies**, and the fallback ratchet
reports no unintended, post-claim, or module-level increase. The eight-shard
equivalence gate reports **1,608 passing / 35 known failures / 0 new
regressions**; one baseline failure now passes and the baseline remains
unchanged. No local Test262 corpus run was performed.

C10 completes the currently identified inherited ordinary instance-method
projection, not the remaining class/provider surface or R1. Exact imported
callable IDs and import locators, dual-mode runtime/intrinsic providers,
inherited accessors, externref/Promise-host helpers, Program ABI
type/class-layout entries, exports and remaining alias families, and the
production `LegacyAbiAdapter` cutover still remain. R2 must then prepare the
whole IR program before body emission; R3-R8 move function, class,
module-initializer, multisource, runtime/async, and linear ownership to that
program; R9 removes fallback policy; and R10 deletes the direct codegen path.

### 2026-07-26 retained imported-callable continuation

The next stacked continuation on `codex/3520-c11-import-callables` moves the
module's retained function-import population into the production Program ABI:

- before IR body lowering, every registered function import is validated and
  cataloged by its exact module/field structural key and allocator `Import`
  object. Import refs now resolve through that exact object and current import
  position; a compatibility label cannot redirect the call through
  `funcMap`;
- pre-DCE cataloging deliberately creates no required ABI slots. After
  dead-import and type elimination settles the final module, every retained
  function import receives a deterministic entry-source-owned callable ID,
  complete final signature contract, structural reference, and exact
  `import-function` locator;
- repeated module/field imports are real production allocator entries rather
  than a theoretical error case. The most recently inserted retained object
  owns the base structural ref used by current symbolic IR; every earlier
  retained duplicate receives a separate allocator-occurrence key, ID,
  signature, and final slot. This preserves existing module-index semantics
  without consulting the compatibility map; and
- single- and multi-module finalization invoke the same retained-import
  planner immediately after DCE and before Program ABI publication.

The production regression lowers a real `console.log(number)` import call,
passes a deliberately false adapter label through the resolver probe, verifies
the exact published `env.console_log_number` import object and post-DCE
signature, and executes the emitted program. Planner regressions cover reverse
registration order, equal fields from different modules, late import shifts,
reference-bearing type remapping, runtime-immutable catalogs, dead
preparation-only imports, allocator duplicates, malformed signatures, and
missing entry provenance.

The complete #3520 matrix plus #2138 passes **255/255 across 44 files**. The
focused catalog/production/structural matrix passes **40/40**; the full #3214
imported-HOF and host-callback matrix passes **60/60**; and the linear,
cross-backend, and adjacent constructor matrix passes **43/43**. Strict
TypeScript, lint, scoped Prettier, diff, LOC/function budget, dead-export,
checker-oracle, issue-spec, and fallback gates pass.

The hybrid readiness lane remains **31 IR-emitted / 6 typed Unsupported / 0
Invariant across 37 terminal units**, with all 37 legacy bodies still emitted.
The full equivalence gate reports **1,608 passing / 35 known failing / 0 new
regressions** and one prior baseline failure now passing; the shared baseline
was deliberately left unchanged. This continuation did not run a local
Test262 shard.

C11 closes retained raw function-import IDs and exact import-object locators,
not semantic provider ownership or R1. Dual-mode runtime/intrinsic providers,
inherited accessors, static and externref/Promise-host support helpers, Program
ABI type/class-layout entries, exports and remaining alias families, and the
production `LegacyAbiAdapter` cutover still remain before R2 can start.

### 2026-07-28 runtime/intrinsic callable-provider continuation

The continuation on `codex/3520-c12-callable-providers` moves every
runtime/intrinsic callable that crosses the WasmGC IR resolver into a
compilation-wide exact-provider sidecar and the production Program ABI:

- the resolver still performs the existing mode-specific provider selection
  exactly once, including lazy helper materialization. It immediately captures
  the selected `Import` or `WasmFunction` object under the structural
  runtime/intrinsic binding key; later resolutions follow that exact object
  through live import shifts or stable defined-function handles without
  consulting `funcMap` or scanning a display name;
- provider discovery remains lazy, so helper allocation order and the
  compatibility pipeline's side effects do not move. Planning is delayed until
  dead-import and type compaction settle. Imports observed only while lowering
  an IR candidate that later withdraws are discarded with that candidate;
  retained provider keys are then sorted and assigned deterministic
  entry-source-owned identities;
- a provider that points at an already planned import, source body, or support
  callable becomes an exact ABI alias. Otherwise the lexically first semantic
  provider for an allocator object owns its locator and any additional
  runtime/intrinsic identities alias it. One structural provider changing
  allocator ownership is a typed invariant; and
- `intrinsic` is now explicit Program ABI callable provenance rather than
  being collapsed into runtime/import provenance.

Production coverage proves defined `Math_sin` and `__fmod` providers, and the
dual-mode `__ir_string_compare` binding: host mode aliases the retained
`env.string_compare` import while native-string mode owns the exact
`__str_compare` definition. Planner coverage reverses discovery order,
deliberately relabels references, shifts imports after observation, shares one
defined object across runtime/intrinsic identities, and rejects provider
rebinding. A withdrawal regression proves a candidate-only provider import can
be removed without manufacturing a required ABI entry.

The focused provider matrix passes **6/6**. The sharded #3520 matrix reports
**247 passing / 1 failing across 43 files**; the sole failure is the existing
linear inventory-count assertion in
`issue-3520-context-integration.test.ts`, and an untouched `origin/main`
control reproduces it exactly. The #2138 multi-source matrix passes **6/6**,
and the linear/cross-backend/constructor matrix passes **43/43**. Strict
TypeScript, scoped lint/Prettier, diff, LOC/function budget, dead-export,
checker-oracle, issue-spec, and fallback gates pass. Hybrid readiness remains
**31 IR-emitted / 6 typed Unsupported / 0 Invariants across 37 terminal
units**, with all 37 legacy bodies still emitted. Full equivalence reports
**1,611 passing / 32 known failing / 0 new regressions**; four baseline rows
now pass and the shared baseline remains unchanged.

C12 removes the generic runtime/intrinsic resolver's repeated name/index
ownership, but it does not yet remove the compatibility provider-selection
step that chooses the first exact object. Inherited accessors, static and
externref/Promise-host support helpers, Program ABI type/class-layout entries,
exports and remaining alias families, and production `LegacyAbiAdapter`
replacement of `funcMap`, `structMap`, module-array, and name scans still
remain before R1 can close.

### 2026-07-28 retained type and class-layout continuation

The continuation on `codex/3520-c13-type-class-abi` makes the complete
post-DCE Wasm type population and every inventoried class explicit in the
production Program ABI:

- class collection records the exact allocator `TypeDef` beside its exact
  `IrClassId` before DCE. The existing session-owned type cells follow that
  object through the complete type-layout remap, so final class slots are
  resolved from allocator identity rather than `structMap`, a debug name, or a
  captured raw type index;
- finalization assigns every retained type object exactly one required
  `type`-space owner. Exact class layouts retain class-owned entries; all other
  function, struct, array, recursive-group, and subtype definitions receive
  deterministic entry-source-owned type identities in final allocator order;
- every inventoried class receives a class intent. Classes with a live WasmGC
  layout own its exact type cell, while ambient or otherwise unallocated
  classes remain explicit slotless intentions rather than disappearing from
  the whole-program inventory;
- the canonical type/layout contract excludes cosmetic Wasm debug names but
  retains value brands, field names/order/mutability/presence metadata,
  inheritance indices, finality, and nested recursive shapes. Publication
  rematerializes the contract from the exact final type object after DCE; and
- legacy class-expression collection can allocate the same exact declaration
  twice under compatibility names. The structurally last live compatibility
  allocation becomes the single class-owned slot, while every superseded
  allocator object remains independently cataloged as a generic retained type.
  One `IrClassId` is therefore never duplicated or silently rebound.

The focused production/type-contract matrix passes **4/4**. The sharded #3520
matrix reports **251 passing / 1 failing across 44 files**; the sole failure is
the unchanged linear inventory-count spy assertion in
`issue-3520-context-integration.test.ts`, reproduced on the exact C12/current-
main control. The #2138 multi-source matrix passes **6/6**, and the broad
class/inheritance/accessor, linear, and 29-case cross-backend matrix is green.
Strict TypeScript, Prettier, scoped Biome lint, diff, LOC/function budget,
dead-export, checker-oracle, issue-spec, and fallback gates pass. Hybrid
readiness remains **31 IR-emitted / 6 typed Unsupported / 0 Invariants across
37 terminal units**, with all 37 legacy bodies still emitted. The eight-shard
equivalence gate reports **1,611 passing / 32 known failing / 0 new
regressions**; four baseline rows now pass and the shared baseline remains
unchanged.

C13 closes final retained type-slot and class-layout population, not R1.
Inherited accessors, static and externref/Promise-host support helpers,
remaining imported globals, exports and public aliases, and production
`LegacyAbiAdapter` replacement of `funcMap`, `structMap`, module-array, and
display-name scans still remain before R1 can close. This slice populates the
class/type authority but deliberately does not yet reroute existing
`structMap` consumers through it.

### 2026-07-28 complete retained global-space continuation

The stacked continuation on `codex/3520-c14-global-abi` makes the complete
final Wasm global index space explicit in the production Program ABI:

- finalization walks exact retained import-global objects followed by exact
  defined `GlobalDef` objects, matching Wasm global-index order without reading
  `moduleGlobals`, a compatibility name, or a captured raw index;
- a source, runtime, cache, or string-constant global that already has a
  semantic ABI owner keeps that owner. Every remaining allocator object
  receives one deterministic entry-source-owned global binding, so the
  complete final global space is a bijection rather than a selected subset;
- generic retained import identities preserve the exact module/field payload
  but use a distinct structural role. A compatibility duplicate therefore
  cannot collide with a semantic imported-global binding even when both share
  a spelling and ordinal;
- duplicate import spellings remain distinct allocator-owned slots and make
  the legacy reverse lookup explicitly ambiguous. Reusing one allocator object
  in two final slots is a typed invariant rather than first- or last-wins
  behavior; and
- every newly cataloged global retains its structured value type, mutability,
  exact allocator locator, and post-type-compaction contract. Publication
  resolves the object against the final module only after the index spaces
  settle.

The focused global-population matrix passes **4/4**. The sharded #3520 matrix
reports **255 passing / 1 failing across 45 files**; the sole failure is the
unchanged linear inventory-count spy assertion in
`issue-3520-context-integration.test.ts`. The exact C13 control reproduces the
same failure. Strict TypeScript, scoped Biome/Prettier, diff, LOC/function
budget, dead-export, checker-oracle, issue-spec, and fallback gates pass.
The focused class/accessor/externref/Promise/cross-backend matrix passes
**85/85**, the #2138 multi-source matrix passes **6/6**, and linear integration
passes **3/3**.
Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The eight-shard equivalence gate reports **1,611 passing / 32 known
failing / 0 new regressions**; four baseline rows now pass and the shared
baseline remains unchanged. The four direct class runtime suites retain the
exact C13 control's **23/23** missing-`string_constants` host-fixture failures,
so they are not C14 regressions.

C14 closes complete imported and defined global-slot population, not R1.
Inherited accessors, static and externref/Promise-host support helpers, exports
and public aliases, production consumers of the populated class/type/global
authorities, and the `LegacyAbiAdapter` replacement of direct `funcMap`,
`structMap`, module-array, and display-name scans still remain before R1 can
close.

### 2026-07-28 complete callable-space and public value-export continuation

The stacked continuation on `codex/3520-c15-callable-export-abi` makes the
complete final Wasm function index space and every public function/global
export explicit in the production Program ABI:

- after dead-import elimination and semantic import/provider planning, final
  callable population walks exact retained function-import objects followed by
  exact defined `WasmFunction` objects. Existing source, import, runtime,
  intrinsic, class, and support owners remain canonical; every otherwise
  unowned definition receives one deterministic entry-source support identity.
  The result is a one-to-one function-space population without reading
  `funcMap`, a module-array position through a captured import count, or a
  display name;
- generic retained definitions use explicit source support provenance. Support
  callable validation now requires exactly one unit, class, or source anchor,
  checks that anchor against the authoritative inventory, and retains it in the
  immutable callable intent;
- one finalization boundary now orders dead-import/type compaction, retained
  callable imports, semantic providers, total callable ownership, total global
  ownership, public export aliases, and retained type/class publication. An
  export can therefore target only an exact allocator object that already has
  one required owner;
- every public function/global spelling becomes a non-allocating `export`
  alias of that exact callable/global binding. Equal public targets share one
  canonical owner, same-named internal functions remain distinct, ambiguous
  legacy reverse lookup fails, duplicate external names fail across all export
  kinds, and missing targets are typed invariants; and
- function export descriptors may carry either a live index or a stable
  `#1916` function handle. Export planning resolves the handle through
  `absoluteFuncIndex`, whose current-import count and
  `funcOrdinalToPosition` registry are the existing final-layout authority,
  then selects the exact import/function object. The descriptor remains a
  handle until serialization; Program ABI records the resolved final slot.
  Memory/table/tag exports remain backend-layout concerns outside the Program
  ABI's function/global/type value spaces.

The focused callable/export population matrix passes **5/5**, including a real
stable-handle export. The complete #3520 matrix reports **260 passing / 1
failing across 46 files**; the sole failure is the unchanged linear
inventory-count spy assertion in `issue-3520-context-integration.test.ts`, and
the exact C14 parent reproduces it. The broad class/accessor/externref/Promise,
cross-backend, #2138, and linear matrix passes **101/101 across 12 files**.
Strict TypeScript, scoped Biome/Prettier, diff, LOC/function budget,
dead-export, checker-oracle, issue-spec, and fallback gates pass.

Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The full equivalence gate reports **1,611 passing / 32 known failing /
0 new regressions**; four baseline rows now pass and the shared baseline
remains unchanged. No local Test262 corpus run was performed, and neither
`benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C15 closes total final callable-slot population and public function/global
export aliases, not R1. Semantic inherited accessor, static, externref, and
Promise-host support identities still need to replace their compatibility
selection seams. Production consumers must then route through the populated
callable/global/type/class authorities, and `LegacyAbiAdapter` must become the
only name-keyed boundary by replacing direct `funcMap`, `structMap`,
`moduleGlobals`, module-array, and display-name scans before R1 can close.

### 2026-07-28 semantic inherited class-member continuation

The next stacked continuation on `codex/3520-c16-legacy-abi-cutover`
([PR #3763](https://github.com/loopdive/js2/pull/3763)) removes the inherited
accessor/static callable seam:

- `class.call` now retains the semantic member kind separately from the
  source-level member name. Getters and setters no longer smuggle backend
  spellings such as `get_value` through the IR, and
  `IrClassLowering.memberFunc(kind, name)` replaces the kind-erasing
  `methodFunc(name)` contract;
- own instance methods, getters, setters, and static methods resolve only to an
  exact inventoried source-unit kind. With a production Program ABI session,
  a projected member that has neither an exact source owner nor an exact
  inherited owner is an Invariant instead of silently reaching the generic
  name adapter;
- inherited methods, getters, setters, and statics walk the source-qualified
  class-shape chain, prove one exact ancestor AST declaration and terminal
  unit, and verify that the child compatibility key and ancestor key identify
  the same allocator-owned `WasmFunction`; and
- getter/setter/static child bindings are non-allocating, class-owned Program
  ABI aliases of the canonical ancestor source callable. Ordinary method alias
  IDs retain their existing role for compatibility; the new roles include the
  semantic kind and member name.

The production regression covers an `A -> B -> C` hierarchy with an inherited
getter, setter, and static method plus colliding top-level `C_get_value`,
`C_set_value`, and `C_scale` functions. It proves distinct source identities,
collision-relocated child aliases, exact canonical signatures/final slots, no
child function allocation, distinct user-function ownership, and end-to-end
execution.

The focused class-member matrix passes **13/13 across 3 files**. The complete
#3520 matrix reports **261 passing / 1 failing across 47 files**; the sole
failure remains the inherited linear inventory-count spy assertion previously
reproduced on the exact C14 parent. The adjacent accessor/class,
cross-backend, integration-preflight, constructor/super, and linear matrix
passes **86/86 across 8 files**. Strict TypeScript, Biome lint, scoped
Prettier, diff, LOC/function budget, dead-export, checker-oracle, issue-spec,
and fallback gates pass.

Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The supported eight-shard equivalence gate reports **1,611 passing /
32 known failing / 0 new regressions**; four baseline rows now pass and the
shared baseline remains unchanged. Two attempted unsharded runs exhausted
their Vitest worker channel before producing JSON, so the final evidence uses
the repository's lower-memory shard mode. No local Test262 corpus run was
performed, and neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C16 closes projected local class-method/accessor/static callable identity, not
R1. Externref-backed class and Promise-host support helpers still need exact
semantic ownership. Production consumers must then route through the
populated callable/global/type/class authorities, and `LegacyAbiAdapter` must
become the only name-keyed boundary by replacing direct `funcMap`,
`structMap`, `moduleGlobals`, module-array, and display-name scans before R1
can close.

### 2026-07-28 retained host-class callable continuation

The next stacked continuation on `codex/3520-c17-host-class-abi`
([PR #3770](https://github.com/loopdive/js2/pull/3770)) makes every retained
class source callable and the JS-host Promise constructor helper structurally
authoritative:

- class collection now observes the exact allocator-owned function object for
  each explicit or implicit constructor, method, getter, and setter beside its
  exact AST declaration. It likewise records WasmGC `<Class>_init` and
  Promise-subclass `<Class>_new__onhost` helpers beneath the exact
  `IrClassId`;
- after DCE, one class-callable registry selects the structurally last live
  allocation for each source unit or class support identity. A retained direct
  body receives the canonical unit owner even when IR selection rejected the
  class, while an IR-replaced object keeps the locator already installed by
  integration;
- the Promise run-on-host body now has the semantic
  `promise-subclass-onhost-constructor` role and a class-owned structural
  reference. Collision relocation remains a diagnostic/allocator name only;
  it cannot select the helper or its final slot; and
- class semantic planning runs before total retained-callable population.
  Only genuinely unclassified functions can therefore receive the generic
  `retained-module-function` identity. Reusing a retained allocator object
  under a different semantic owner is a typed duplicate-locator invariant.

The production anti-vacuity fixture combines `Error`-backed and
`Promise`-backed subclasses with six colliding top-level function names. All
five class source units are explicitly Unsupported by IR selection and retain
their direct bodies, yet each publishes its exact source-unit callable ID,
collision-relocated allocator object, final slot, and post-DCE signature. The
retained Promise `__onhost` body separately publishes the exact class support
identity and final function object.

The focused host-class, inherited-member, Promise-constructor, and externref
runtime matrix passes **18/18 across 6 files**. The sharded #3520 matrix reports
**262 passing / 1 failing across 48 files**; the sole failure remains the
inherited linear inventory-count spy assertion documented by C12-C16. The
adjacent #2138 multi-source matrix passes **6/6**, for **268 passing / 1 known
failing across 49 files** in the combined migration run.
The broader accessor/class, constructor/super, integration-preflight,
cross-backend, and linear matrix reports **91 passing / 27 failing across 12
files** on both C17 and the exact C16 parent. Every failure is the identical
known host-fixture omission of the `string_constants` import; C17 adds none.

Strict TypeScript, full error-level and scoped Biome lint, Prettier, diff,
LOC/function budget, dead-export, godfile, checker-oracle, issue-spec,
test-vacuity, verdict-oracle, done-status, and issue-index consistency gates
pass.

Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The fallback ratchet reports no unintended, post-claim, or
module-level increase. The supported eight-shard equivalence gate reports
**1,611 passing / 32 known failing / 0 new regressions**; four baseline rows
now pass and the shared baseline remains unchanged. No local Test262 corpus run
was performed, and neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C17 closes retained local, externref-backed, and Promise-host class callable
identity, not R1. Production consumers must still route through the populated
callable/global/type/class authorities, and `LegacyAbiAdapter` must become the
only name-keyed boundary by replacing direct `funcMap`, `structMap`,
`moduleGlobals`, module-array, and display-name scans before R1 can close.

### 2026-07-28 exact module-initializer callable continuation

The stacked continuation on `codex/3520-c18-module-init-abi` removes
display-name lookup from compiler-created module-initializer allocation,
IR-patch resolution, startup wiring, and initialization guards:

- every compiler-created initializer is allocated through a stable function
  handle and recorded in an exact sidecar even when Program ABI telemetry is
  disabled. IR integration resolves the preallocated body from its
  source-qualified module-init unit instead of scanning for
  `__module_init`;
- the single-source retained initializer owns the exact module-init unit
  binding and final callable slot. A same-named user function owns its separate
  top-level-function binding and can no longer steal the IR patch, startup
  target, or public initializer alias;
- the sidecar follows allocator handles through IR body replacement and
  dead-layout finalization. Startup guards compare the exact function object,
  so a user-authored `__module_init` remains an ordinary exported/user
  callable; and
- the current multi-source frontend still emits cumulative initializer passes.
  Until R5 replaces that behavior with one prepared whole-program unit, every
  physical pass receives an explicit entry-source support identity and ordinal
  rather than an invented source-unit owner. Existing first-pass guard/start
  behavior and final public alias selection are preserved byte-for-byte.

The three-test anti-vacuity fixture proves the same-name IR-emitted case, an
Unsupported direct-body case, and two ordered multi-source passes at runtime.
The exact C17 parent rejects the collision fixture because both callables
attach to the user function; C18 assigns two exact required bindings and
distinct final slots, preserves the user result `99`, and runs the synthetic
initializer once to produce the expected top-level state. The focused suite
passes **3/3**, and the combined callable-population/module-init suite passes
**8/8**.

The sharded #3520 plus #2138 migration matrix reports **272 passing / 1 known
failing across 50 files**. The sole failure is the inherited linear
inventory-count spy assertion already reproduced on C12-C17. The adjacent
module-init/startup/ABI matrix adds no branch-specific failure; two optional
test262.fyi fixtures are unavailable because that local corpus/submodule is
not installed.

For a non-collision numeric module, the exact C17 parent and C18 emit identical
bytes in all four checked modes: host
`cc43eff221a66ea95123b273ff2fabd3e3e8e6045d072696fdebd0d21d2bf8c0`,
deferred host
`722a2a8038937ed145c483b3336e8711eb20dddcc0910972bf0a214bb1ea354e`,
standalone
`903c9b027532c47c856c6f13fc76f68ca1a4ebee0c3a17408d918e70c1f72ea6`,
and WASI
`a4033b7b395844fc1cb421e26c232a671d0dd56d276230df978b966788aa5afc`.

Strict TypeScript, formatting/diff, scoped lint, LOC/function budget,
dead-export, godfile, checker-oracle, issue-spec, test-vacuity,
verdict-oracle, done-status, and issue-index consistency gates pass. Hybrid
readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported / 0
Invariants across 37 terminal units**, while strict IR-only correctly remains
not ready because all 37 legacy bodies are still emitted. The six typed
blockers are four async/call-graph selection units and two static class-member
builds. The fallback ratchet reports no unintended, post-claim, or
module-level increase.

The supported eight-shard equivalence gate reports **1,611 passing / 32 known
failing / 0 new regressions**; four baseline rows now pass and the shared
baseline remains unchanged. No local Test262 corpus run was performed, and
neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C18 closes structural ownership and resolution for current module-initializer
allocators, not R1 or R5. Remaining R1 production consumers still include
direct `funcMap`, `structMap`, `moduleGlobals`, module-array, and display-name
joins outside the module-init seam. Multi-source compile-once initialization
and body-ownership changes remain explicitly deferred to the prepared-program
R2-R5 cutover.

### 2026-07-28 exact top-level source-callable continuation

The stacked continuation on `codex/3520-c19-source-callable-abi` removes the
production `funcMap` name join between top-level function allocation, retained
direct bodies, IR replacement, and symbolic direct-call resolution:

- each top-level function declaration now receives a stable function handle
  and is observed atomically against its exact declaration/unit identity.
  Compiler-injected top-level shims are accepted only when the inventory
  classifies them under an explicit compiler-origin `synthetic-support`
  identity;
- IR integration resolves source artifacts and planned source-unit targets
  through that exact registry. The only remaining name fallback at this seam
  is restricted to low-level compatibility tests that deliberately construct
  integration without a production identity context;
- stable handles follow an allocator through IR object replacement and
  dead-layout finalization. A supported IR-emitted body and an Unsupported
  retained direct body therefore publish the same source-unit callable
  identity rather than switching between a source owner and a generic retained
  support owner; and
- same-named functions in different source files retain distinct declaration
  identities, allocator handles, required ABI bindings, and final slots even
  when the current multi-source collision policy keeps both bodies on the
  direct path. Legacy reverse lookup reports ambiguity instead of choosing the
  last `funcMap` entry.

The exact C18 parent publishes no source-unit binding for an Unsupported
default-parameter function and neither source-unit binding for a same-named
cross-file pair. C19 publishes all three exact required bindings. The focused
anti-vacuity/runtime suite passes **3/3**; the source/module-init/total-callable
population matrix passes **11/11**; and the IR-first, multi-module,
preregistration, and function-artifact matrix passes **24/24**.

The six-shard #3520 plus #2138 migration matrix reports **281 passing / 1
known failing across 52 files**. The sole failure is the inherited linear
inventory-count spy assertion reproduced throughout C12-C18. A compatibility
test initially exposed the intentional no-identity integration harness; its
restricted adapter fallback and the full original shard now pass **37/37**.

For a supported numeric source function, the exact C18 parent and C19 emit
identical bytes in all four checked modes: host and deferred host
`12eff1c41f38ee28b4162f6b5ff3e05e57d6f8060ec9fd7577be0b72bafe8a85`,
standalone
`2e3508c8c7c6b21c7f56168d6febc639a40c23c1365d82bc5a3a05f4b7766d29`,
and WASI
`9e0eda0baf5d05fcdd0b6d7cb79dc6c0f73792bc05a80d9e47d126c043fc4cf4`.

Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The fallback ratchet reports no unintended, post-claim, or
module-level increase. Strict TypeScript, formatting/diff, scoped lint,
LOC/function budget, dead-export, godfile, checker/verdict-oracle,
issue-spec, test-vacuity, done-status, and issue-index consistency gates pass.

The supported eight-shard equivalence gate reports **1,611 passing / 32 known
failing / 0 new regressions**; the same four baseline rows now pass and the
shared baseline remains unchanged. No local Test262 corpus run was performed,
and neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C19 closes exact top-level declaration callable ownership, not R1. Class
integration still has a physical compatibility-key join, and function
expressions, lifted/support allocation, module globals, class/type consumers,
and remaining module-array/display-name scans must still move behind the
structural authorities before R1 can close.

### 2026-07-28 exact class integration callable continuation

The stacked continuation on `codex/3520-c20-class-integration-abi` removes the
production physical-name join for exact class source callables and
class-constructor initializer support:

- the class allocator registry exposes stable handles for exact constructor,
  method/accessor, and compiler-owned `<Class>_init` observations. Resolution
  follows the allocator object through replacement and DCE rather than
  recovering it from `funcMap`;
- IR class resolution and Phase-3 class body replacement use those exact
  source-unit/support identities. A name fallback remains only for low-level
  compatibility contexts that deliberately omit the production registry; and
- the anti-vacuity fixture deletes every physical-name mapping for one
  implicit constructor, instance method, and initializer support function
  before integration. The exact C19 parent fails with a typed
  `missing-function-slot`; C20 resolves all three objects, IR-emits both
  `main` and the method, and retains the exact unit mappings.

The focused class ABI suite passes **4/4**. The wider class optimization and
behavior matrix passes **54/54** across constructor allocation, class-body
replacement, instance/static dispatch, getters/setters, inheritance and
`super`, source/support aliases, host classes, and host/native-string modes.
This is preservation evidence for the current class lowering optimizations;
retirement remains blocked on the program-wide optimization inventory in
#3518, so no direct class handler is deleted by this identity-only slice.

Strict TypeScript, formatting/diff, LOC budget, dead-export, godfile,
checker/verdict-oracle, issue-spec, test-vacuity, done-status, and issue-index
consistency gates pass. Hybrid readiness remains **READY** at **31 IR-emitted /
6 typed Unsupported / 0 Invariants across 37 terminal units**, with all 37
legacy bodies still emitted. The fallback ratchet remains unchanged with zero
unintended, post-claim, or module-level increases.

The six-shard #3520 plus #2138 migration matrix reports **282 passing / 1
inherited known failing across 53 files**. The sole failure is the unchanged
linear inventory-count spy assertion (two builds observed versus one expected).
The supported eight-shard equivalence gate reports **1,611 passing / 32 known
failing / 0 new regressions**; the same four baseline rows pass and the shared
baseline remains unchanged.

The exact C19 parent and C20 produce byte-identical class-program output in all
four checked modes: host and deferred host
`8e85294fa13c47a41f17e5c370aed18c46876994ded547d5f1a5c592e41a0dd5`,
standalone
`26338f2162dcb59169417085b908462be3c03233c8988be1f686a95ae43ec182`,
and WASI
`b1693c53c755bf26e9cdef72bb33778dafac47222224e07ce28b8e03f3302378`.
No local Test262 run was performed, and neither
`benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C20 closes the exact class source and constructor-init resolution seam, not R1.
Inherited child alias validation still consumes physical compatibility keys.
Class/type/global registries, lifted and other support allocation, function
expressions, and remaining module-array/display-name scans must still move
behind structural authorities before R1 can close.

### 2026-07-29 inherited class integration callable continuation

The next stacked continuation on
`codex/3520-c21-inherited-class-alias-abi`
([PR #3786](https://github.com/loopdive/js2/pull/3786)) removes the production
physical-key dependency for inherited class callables:

- class collection observes each compatibility alias beside its exact child
  `IrClassId` and canonical ancestor `IrUnitId`. The registry follows the
  allocator-owned function object back to its exact source unit and never
  reconstructs identity from class, member, getter/setter, or static display
  labels;
- IR class integration resolves the ancestor allocation through the exact
  source-unit handle and the child alias through the exact
  `(child class, canonical unit)` pair. Physical `funcMap` lookup remains only
  for low-level compatibility contexts that deliberately omit the production
  registry; and
- the anti-vacuity fixture uses an `A -> B -> C` hierarchy with an inherited
  instance method, getter, setter, and static method. It deletes every
  physical-name entry sharing the four allocator handles before integration,
  then proves all four child aliases plan against their exact canonical units.

The focused method/member/integration alias suite passes **3/3**. The broader
class ABI, integration, optimization, inheritance, `super`, private-member,
linear, host, and native-string matrix has **181 passing tests across 20 green
files**. Six adjacent legacy runtime files reproduce the exact parent result:
**45 failures / 2 passes**, all failures reporting the unchanged missing
`string_constants` runtime import. They are a control-matched harness issue,
not a new C21 result.

The #3520 plus #2138 migration matrix passes **283 tests with one inherited
known failure across 54 files** when each file runs in a fresh Vitest process.
The sole failure is the unchanged linear inventory-count spy assertion (two
builds observed versus one expected). Running the full matrix in one child
process reaches the documented Vitest heap ceiling, so no result is inferred
from that runner failure.

Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The fallback ratchet remains unchanged with zero unintended,
post-claim, or module-level increase. Strict TypeScript, Biome lint,
formatting, and diff checks pass.

The supported eight-shard equivalence gate reports **1,611 passing / 32 known
failing / 0 new regressions**; the same four baseline rows pass and the shared
baseline remains unchanged. No local Test262 corpus run was performed, and
neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C21 closes inherited class callable integration, not R1. The compatibility
alias map remains for direct-codegen consumers until their optimizations and
runtime behavior are structurally owned. Class/type/global registries, lifted
and other support allocation, function expressions, and remaining
module-array/display-name scans must still move behind structural authorities
before R1 can close.

### 2026-07-29 exact class layout integration continuation

The next stacked continuation on
`codex/3520-c22-class-layout-integration-abi`
([PR #3787](https://github.com/loopdive/js2/pull/3787)) removes the production
class-name join for struct layouts and field indices:

- the existing type registry now resolves the current allocator-owned
  `StructTypeDef` and module type index by exact `IrClassId`. It follows the
  type cell through allocator replacement and DCE remapping instead of
  recovering the layout from `structMap`;
- IR class integration derives its field-index table from that exact struct
  object. `structMap` and `structFields` remain fallback inputs only for
  low-level compatibility contexts that deliberately omit the production
  registry; and
- the inherited-class anti-vacuity fixture now deletes the `A`, `B`, and `C`
  entries from both physical layout maps, in addition to deleting every
  physical callable mapping. IR integration still resolves all three layouts,
  their inherited fields, and the four inherited callable kinds.

The focused layout/callable suite passes **6/6**. The broader exact class/type,
integration, optimization, inheritance, `super`, private-member, and linear
matrix passes **69/69 across 15 files** when each file runs in a fresh Vitest
process.

The #3520 plus #2138 migration matrix remains **283 passing / 1 inherited
known failure across 54 files**. The sole failure is the unchanged linear
inventory-count spy assertion (two builds observed versus one expected).
Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The fallback ratchet reports no unintended, post-claim, or
module-level increase.

The supported eight-shard equivalence gate remains **1,611 passing / 32 known
failing / 0 new regressions**; the same four baseline rows pass and the shared
baseline remains unchanged. Strict TypeScript, Biome lint, formatting, diff,
LOC/function budget, dead-export, and godfile gates pass.

No local Test262 corpus run was performed. The stacked continuation does not
target `main`, while the full Test262 workflow runs at the merge-group
boundary. Neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C22 closes exact class layout and field integration, not R1. Direct codegen
still owns the compatibility layout maps until its class optimizations and
runtime behavior retire. Module globals, remaining class/type consumers,
lifted and other support allocation, function expressions, and module-array
or display-name scans must still move behind structural authorities before R1
can close.

### 2026-07-29 exact module-global integration continuation

The current stacked continuation on
`codex/3520-c23-module-global-integration-abi`
([PR #3789](https://github.com/loopdive/js2/pull/3789)) removes the production
module-binding join through `moduleGlobals` and `tdzGlobals`:

- declaration collection exposes each direct top-level identifier
  declaration's exact allocator-owned value global to the Program ABI global
  registry. Retained TDZ allocation attaches the exact flag object to that
  same `ts.VariableDeclaration`;
- repeated declarations that share one compatibility allocation observe the
  same object without reallocating it. The user-function/import collision
  behavior from #2669 and #3428 is preserved in a focused module-global
  registration subsystem rather than growing the declaration driver;
- IR module-binding integration resolves value and TDZ storage by the exact
  declaration observation whenever the production registry exists. Missing
  structural observations fail closed; the two name maps are consulted only
  by low-level compatibility contexts that omit Program ABI ownership; and
- the anti-vacuity fixture deletes both the `state` value entry from
  `moduleGlobals` and its flag entry from `tdzGlobals` before integration.
  `<module-init>` still emits, and both exact `GlobalDef` objects receive their
  source-owned Program ABI plans and locators.

The focused Program ABI global/module-init matrix passes **19/19 across five
files**. The allocation extraction's #2669, #3428, module-global, and TDZ
regression controls pass **25/25**. The adjacent #3142 selector control remains
**14/15**, and #3529 compatibility preflight remains **11/13**; their three
assertion failures reproduce unchanged on the exact C22 parent.

The #3520 plus #2138 migration matrix advances to **284 passing / 1 inherited
known failure across 55 files**. The sole failure remains the linear
inventory-count spy assertion (two builds observed versus one expected).
Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The fallback ratchet reports no unintended, post-claim, or
module-level increase.

The supported eight-shard equivalence gate remains **1,611 passing / 32 known
failing / 0 new regressions**; the same four baseline rows pass and the shared
baseline remains unchanged. Strict TypeScript, Biome lint, formatting, diff,
LOC/function budget, dead-export, godfile, oracle-ratchet, and adoption gates
pass.

No local Test262 corpus run was performed. This continuation is stacked rather
than targeting `main`, while the full Test262 workflow runs at the merge-group
boundary. Neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C23 closes exact module value/TDZ integration, not R1. Direct codegen still
owns the compatibility maps until its module-state optimizations and runtime
behavior retire. Remaining class/type consumers, lifted and other support
allocation, function expressions, and module-array or display-name scans must
still move behind structural authorities before R1 can close.

### 2026-07-29 exact synthesized artifact allocation continuation

The current stacked continuation on
`codex/3520-c24-synthetic-slot-abi`
([PR #3790](https://github.com/loopdive/js2/pull/3790)) removes the production
display-name join from fresh lifted and monomorphized artifact allocation:

- every synthesized artifact in a Program ABI session now receives a fresh
  allocator-owned `WasmFunction` keyed through its exact derived `IrUnitId`.
  Production no longer probes `funcMap` for an empty same-labelled function;
- production also stops publishing the synthesized slot back into `funcMap`,
  so an exact source function with the same compatibility label cannot have
  its physical mapping overwritten. Low-level integration callers without a
  Program ABI session retain the old compatibility behavior; and
- the anti-vacuity fixture pairs a captured lifted closure named
  `owner__closure_0` with an empty top-level source function of that exact
  label. C23 reproduces a duplicate-locator invariant because both Program ABI
  owners share one allocator object; C24 proves they publish distinct final
  function slots.

The focused lifted, monomorphization, integration-pass, outcome-correlation,
and callable-planning matrix passes **29/29 across eight files**. The #3520
plus #2138 migration matrix advances to **285 passing / 1 inherited known
failure across 55 files**. The sole failure remains the linear
inventory-count spy assertion (two builds observed versus one expected).

Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The fallback ratchet reports no unintended, post-claim, or
module-level increase. The supported eight-shard equivalence gate remains
**1,611 passing / 32 known failing / 0 new regressions**.

Strict TypeScript, Biome lint, formatting, LOC/function budget, dead-export,
and godfile gates pass. No local Test262 corpus run was performed because this
continuation is stacked rather than targeting `main`; the full corpus runs at
the merge-group boundary. Neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C24 closes fresh synthesized artifact slot allocation, not R1. Remaining
class/type consumers, preflight reservations for lifted support, function
expressions, and module-array or display-name scans must still move behind
structural authorities before R1 can close.

### 2026-07-29 synthesized reservation retirement continuation

The next stacked continuation on
`codex/3520-c25-synthetic-reservation-abi`
([PR #3791](https://github.com/loopdive/js2/pull/3791)) removes the obsolete
preflight display-name reservation for the synthesized host-callback and
Promise-delay families:

- when a Program ABI session owns the compilation, overlay finalization no
  longer demotes an exact source owner merely because `funcMap` or the module
  contains a source function with the callback, Promise executor, or Promise
  timer artifact's compatibility label;
- low-level contexts without Program ABI ownership retain the old name
  collision guard. Exact `__make_callback`, `Promise_new`,
  `__timer_set_timeout`, `__box_number`, and `__call_1_f64` runtime-helper
  import validation remains unchanged; and
- structural anti-vacuity tests prove the same occupied label demotes a
  compatibility context but retains the exact owner under a real
  `ProgramAbiSession`. End-to-end host-callback and Promise fixtures prove
  genuine IR emission, binary validity, and Promise settlement while the
  corresponding source functions coexist.

The focused structural, callback, lifted-slot, and Promise identity matrix
passes **47/47**. The targeted Promise integration selection passes **8/8**,
including runtime settlement with both lifted labels occupied. The exact
fresh-process #3520/#2138/linear matrix reports **283 passing / 1 inherited
known failure across 55 files**; the sole failure is the unchanged linear
inventory-count spy assertion.

Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The fallback ratchet reports no unintended, post-claim, or
module-level increase. The supported eight-shard equivalence gate remains
**1,611 passing / 32 known failing / 0 new regressions**; four baseline rows
pass and the shared baseline remains unchanged.

Strict TypeScript, Biome lint, formatting, diff, LOC/function budget,
dead-export, godfile, oracle-ratchet, and adoption gates pass. No local Test262
corpus run was performed because this continuation is stacked; the full corpus
runs when the stack targets `main` or reaches the merge-group boundary.
Neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

Queue shepherding found one inherited current-`main` gap in the changed root
tests: a void closure parameter call in statement position was still rejected
after IR selection. C25 now represents that `closure.call` with a null result
while preserving the existing expression-position refusal. The shadowed
`setTimeout` fixture proves the helper remains IR-compiled, and the focused
callback, Promise, overlay, and Program ABI matrix passes **86/86** with strict
TypeScript and Biome lint green.

C25 closes the callback and Promise-delay synthesized-name reservations, not
R1. Remaining class/type consumers, function expressions, other support
families, and module-array or display-name scans must still move behind
structural authorities before R1 can close.

### 2026-07-29 nested source-callable ownership continuation

The next stacked continuation on
`codex/3520-c26-nested-callable-abi`
([PR #3792](https://github.com/loopdive/js2/pull/3792)) publishes retained
direct-codegen nested callables through their exact source-unit Program ABI
owners:

- arrows and function expressions now publish their existing optimized
  `WasmFunction` under the callable binding derived from their exact
  `IrUnitId`;
- direct host callbacks and object-literal methods, getters, and setters use
  the same structural path. The object-member AST nodes previously entered the
  closure compiler through a compatibility cast, so the registry now validates
  their actual `object-method`, `object-getter`, or `object-setter` inventory
  kind; and
- pushing the direct body and observing its structural owner is atomic. This
  slice does not rebuild the body, change its optimization decisions, or skip
  legacy emission.

The focused nested-callable, host-callback, and Program ABI matrix passes
**63/63**. The targeted Promise integration selection passes **8/8**. The
committed fresh-process #3520/#2138/linear matrix reports **286 passing / 1
inherited known failure across 55 files**; the sole failure remains the
unchanged linear inventory-count spy assertion.

Hybrid readiness remains **READY** at **31 IR-emitted / 6 typed Unsupported /
0 Invariants across 37 terminal units**, with all 37 legacy bodies still
emitted. The fallback ratchet reports no unintended, post-claim, or
module-level increase. The supported eight-shard equivalence gate remains
**1,611 passing / 32 known failing / 0 new regressions**; four baseline rows
pass and the shared baseline remains unchanged.

Strict TypeScript, Biome lint, formatting, diff, LOC/function budget,
dead-export, godfile, oracle-ratchet, and adoption gates pass. The first
merge-group Test262 run exposed two adapter boundaries in this slice: a
top-level function declaration routed through an accessor callback could let
the callback body steal the declaration's exact source slot, while
literal-eval callables created after inventory freeze were incorrectly treated
as inventoried source units. Nested publication now observes only non-function
declarations with an exact inventory record; top-level callback adapters and
post-inventory support callables remain on generic callable planning. The
focused source-callable suite passes **8/8**, and the exact **19** Test262 paths
covering the reported callable-planning failures pass **19/19** locally.
Neither `benchmarks/results/test262-run.log` nor
`scripts/equivalence-baseline.json` is changed.

C26 closes exact retained ownership for arrows, function expressions, host
callbacks, and object-literal methods/accessors, not R1. Nested function
declarations, typed-`this` twins and other support callables, remaining
class/type consumers, and module-array or display-name scans must still move
behind structural authorities before R1 can close.

### 2026-07-29 nested function-declaration ownership continuation

The next continuation on
`codex/3520-c27-nested-function-abi`
([PR #3797](https://github.com/loopdive/js2/pull/3797))
publishes retained nested function declarations through their exact
`nested-function` Program ABI owners:

- capture-free, capturing, forward-sibling, and recursive reservations now
  publish the same preallocated `WasmFunction` object under the callable
  binding derived from the declaration's exact `IrUnitId`;
- the eager class-order reservation in `declarations.ts` uses the same
  structural publication path, so early registration cannot fall back to a
  display-name or raw module-array lookup; and
- literal-eval declarations created after inventory freeze stay on generic
  support-callable planning. This continuation does not rebuild bodies, alter
  hoisting or capture boxing, change optimization decisions, or skip direct
  emission.

The focused source-callable ownership suite passes **11/11**, covering the
pre-reserved sibling, capturing, single nested, eager class-order, runtime, and
post-inventory eval paths. A broader nested-function audit reports **137
passing / 5 skipped** across nine files. Three runtime failures reproduce
identically on the exact `cd9d53f20428a9` parent, while two additional rows
require the absent local Test262 checkout; there is no new failure attributable
to C27.

C27 closes exact retained ownership for nested function declarations, not R1.
Typed-`this` twins and other support callables, remaining class/type consumers,
and module-array or display-name scans must still move behind structural
authorities before R1 can close.

### 2026-07-29 typed-this twin callable ownership continuation

The continuation on `codex/3520-c28-typed-this-abi`
([PR #3798](https://github.com/loopdive/js2/pull/3798)) gives every admitted
typed-`this` twin its own structural Program ABI owner:

- the original function-expression body keeps the callable binding derived
  from its exact source `IrUnitId`, while the optimized twin receives a
  separate `typed-this-twin` support binding anchored beneath that same unit;
- twin observation happens atomically with allocator publication, and final
  ownership is selected only after DCE. A removed twin creates no required ABI
  slot, while a retained twin is resolved from its exact `WasmFunction` object
  rather than its generated `__typed_this` label; and
- admission, the second optimized compilation, receiver-param specialization,
  numeric field/return/local promotion, arity padding, direct-call
  devirtualization, guard-shim construction, and the generic fallback body are
  unchanged.

The production fixture proves the generic body and admitted twin finalize to
two different function slots while the standalone program still returns the
expected value. The focused source-callable and complete typed-`this`
optimization matrix passes **103/103 across eight files**. Strict TypeScript
and changed-file Biome lint pass. The hybrid IR-only readiness lane remains
**READY** at **31 emitted / 6 typed Unsupported / 0 Invariants across 37
terminal units**, with all 37 legacy bodies still emitted.

C28 closes exact ownership for the typed-`this` twin family, not R1. Other
support callables, remaining class/type consumers, and module-array or
display-name scans must still move behind structural authorities before R1
can close.

### 2026-07-29 direct function-value ownership continuation

The continuation on `codex/3520-c29-function-value-abi` moves retained direct
function-value wrapper artifacts behind their source unit's Program ABI owner:

- capture-free direct values keep the existing lazy module-global singleton.
  The exact trampoline and cache `GlobalDef` are now observed as one pair and
  published under `function-value-trampoline` and `function-value-cache`
  bindings derived from the target declaration's `IrUnitId`;
- capturing nested declarations keep their activation-local, first-dynamic-read
  memoization. Their shared module trampoline receives the same unit-derived
  callable owner, while no module cache binding is invented; and
- an already prepared C8 singleton is reused only when its callable and global
  locators are the exact retained allocator objects. Finalization does not
  recompute its pre-DCE signature contract. Post-inventory helpers, imports,
  class adapters, and synthetic-name collision fallbacks remain on generic
  compatibility planning.

The implementation does not change wrapper types, trampoline bodies,
`ref.func` enrollment, pending signature rebuilding, constructibility,
capture boxing, TDZ flags, closure identity, direct `call_ref` selection, or
lazy cache instructions. The focused source-callable suite passes **13/13**,
including runtime identity and calls for both capture-free and capturing
nested declarations. The C8 production support-callable suite passes **2/2**,
the function-value planner suite passes **10/10**, and the #2976 closure
identity suite passes **4/4**. The #3270 closure-split control is **6/7** on
both this branch and the exact landed C28 base; its existing IR-fallback
diagnostic for a bare nested-function reference is unchanged.

The required expected-green migration matrix passes **98/98 across 11 files**,
and cross-backend differential validation passes **29/29**. The full
equivalence gate reports **1,611 passing / 32 current failures / 36 known
baseline failures**, with zero new regressions and four baseline failures now
passing; the baseline is intentionally unchanged. Strict TypeScript, Biome
lint, formatting, LOC, godfile, dead-export, oracle-ratchet, and IR-adoption
gates pass. Hybrid IR-only readiness remains **READY** at **31 emitted / 6
typed Unsupported / 0 Invariants across 37 terminal units**, with all 37
legacy bodies still emitted. Neither the equivalence baseline nor the
Test262 run log is changed.

C29 closes exact retained ownership for direct source function-value
trampolines and capture-free cache globals, not R1. Other support callable
families, remaining class/type consumers, and module-array or display-name
scans must still move behind structural authorities before R1 can close.

### 2026-07-30 vec host-bridge callable ownership continuation

The continuation on `codex/3520-c30-vec-host-bridge` moves the six core vec
host bridges behind one entry-source-owned structural family:

- `__vec_len`, `__vec_get`, `__is_vec`, `__vec_mut_supported`, `__vec_push`,
  and `__vec_pop` publish `vec-host-bridge` support bindings at fixed ordinals
  0 through 5 beneath the canonical entry source. Their callable ordering role
  is the next reserved role after `typedThisTwin`;
- reservation allocates all six helpers as one batch and observes the exact
  `WasmFunction` objects only after every allocation succeeds. Final body
  filling and compile-time calls resolve those objects through their current
  handles, so late-import shifts cannot redirect selection through a generated
  name; and
- `funcMap` remains a compatibility publication only when the helper label is
  unoccupied. The historical logical export is also the zero-overhead runtime
  fast path. A physical export is added only when a user already owns that
  logical export or occupies its exact short `$v<ordinal>` family, using a
  deterministic `$` suffix on collision. Free suffix gaps are filled with
  helper aliases through one slot beyond the last occupied suffix, so the
  runtime can select the final function in the contiguous family without
  mistaking a preserved user export for the helper. Runtime projection first
  requires the historical logical export, preventing an array-free user
  `$v<ordinal>` from fabricating an internal vec helper. A user can export all
  six historical helper labels or all six short prefixes and still retain
  those exact names and bodies while runtime array reads, wrapping, and
  mutation use the structural helpers; and
- structural observation, body filling, and physical publication are
  correctness-critical. Their failures now abort compilation before physical
  bridge publication instead of returning a successful module containing
  placeholder bodies.

The exact five-entry `SINGLE_HOST_ENTRIES` census was run in fresh processes
against `origin/main` at `e541b9d56c766c` and this continuation, using
`readFileSync(entry) -> analyzeSource(source, entry) ->
generateModule(ast, { experimentalIR: true, trackIrOutcomes: true })`.
Defined functions remain **166 → 166**. Generic
`retained-module-function` rows move **101 → 77**, exactly matching the
**24** vec bridge rows present across four of the five entries. The same
measurement keeps routing and body outcomes unchanged at **37 terminal /
30 emitted / 7 Unsupported / 0 Invariants / 37 legacy bodies / 30 IR
bodies**.

The size follow-up compares raw binaries from `origin/main` at
`10f40b6458c6c`, PR head `11abdfd6b544`, and the collision-only alias
implementation. Three representative helper-using modules measure
**1,065 / 1,340 / 1,569 bytes** on main, **1,222 / 1,497 / 1,726 bytes** at
the PR head, and **1,065 / 1,340 / 1,569 bytes** after the follow-up. The
deterministic **+157 bytes per module** is therefore eliminated rather than
traded for a shorter always-present duplicate namespace. Ordinary modules
publish zero `$v<ordinal>` physical aliases; only an actual logical-label or
exact short-family collision pays for its affected short family.

The focused C30 suite passes **9/9**. It proves all six source-anchored IDs,
fixed ordinals, direct final-slot object identity, and zero vec support
publication for an array-free module; reserve-to-fill allocator-object
identity survives a forced late-import increase and subsequent dead-import
compaction; all six public-label collisions preserve the user exports while a
runtime E2E asserts push length, intermediate length/value, pop value, final
length, and wrapped returned-array values; sparse short-namespace collisions
retain six distinct terminal structural helpers; all-six prefix-only
collisions terminate in the structural helpers while preserving wrapped
`[7, 8, 3]` and fieldless-class `{}` behavior; an array-free `$v0` spoof
creates no historical logical helper and preserves the helper-free fieldless
fallback; forced ABI observation failure produces a compile error with no
physical exports; tracked/untracked binaries are equal with IR enabled; and
routing/outcome telemetry remains stable. The adjacent callable-planning,
#2083, #3272, #3637, #2927, and #3311 matrix passes **50/50 across six files**.
The IR fallback ratchet, function budget, strict TypeScript, and the exact
census pass without changing the equivalence baseline or Test262 run log.

C30 closes exact retained ownership for the six core vec host bridges, not R1.
Other support callable families and remaining module-array or display-name
consumers must still move behind structural authorities before R1 can close.

### 2026-07-30 closure host-bridge callable ownership continuation

The C31 continuation on `codex/3520-c31-closure-host-bridge` moves the bounded
host-visible closure dispatcher family behind one entry-source-owned structural
role:

- direct `__call_fn_0` through `__call_fn_4` use fixed
  `closure-host-bridge` ordinals 0 through 4, method
  `__call_fn_method_0` through `__call_fn_method_5` use ordinals 5 through 10,
  `__closure_arity` uses 11, and `__is_closure` uses 12. The optional
  `__closure_has_rest` classifier uses ordinal 13 only in modules that actually
  emit it. Higher method dispatchers remain on generic retained ownership in
  this bounded slice;
- each existing helper body is first materialized as one exact
  `WasmFunction`, then planned under the canonical entry source and published
  at the current Program ABI-resolved handle. The public labels, exported
  signatures, dispatcher bodies, method-receiver save/restore behavior,
  `funcMap` compatibility entries, closure classifier semantics, and #2083
  closure-free gating remain unchanged. When a user owns a logical helper name
  or its reserved `$cN` physical prefix, codegen preserves every user export
  and publishes the exact helper at the terminal free physical suffix. One
  immutable compiler-authored i32 manifest records exactly which helpers were
  emitted. A collision-safe empty Wasm table authenticates that metadata as
  compiler-owned rather than a user name/value convention, while a 17-slot
  funcref table binds every set bit to the exact compiler helper object. The JS
  runtime proves the manifest is an immutable i32 and both tables have exact
  `funcref` element types and `0..0` / `17..17` limits through Wasm import
  validation. It rejects reserved bits, externref or malformed tables, never
  falls back to a user logical export, and composes closure and vec projections
  from the same raw export object into one internal view; and
- tracked and untracked compilation use the same allocator-object lookup.
  Tracking adds only structural ownership metadata and does not allocate,
  relabel, or rebuild a helper.

The exact five-entry `SINGLE_HOST_ENTRIES` census was run against C30 main at
`c462d0216e3925` plus C31. It reports **166** defined functions, **51** generic
`retained-module-function` rows, exactly **24** `vec-host-bridge` rows, and
exactly **26** `closure-host-bridge` rows across the emitting entries. The
closure manifest adds no callable and does not change the structural row
counts. Routing and body outcomes remain **37 terminal / 30 emitted / 7
Unsupported / 0 Invariants / 37 legacy bodies / 30 IR bodies**.

The focused C31 suite passes **11/11**. It proves every fixed ID and public label,
the absence of a second generic callable owner, exact final-slot object
resolution across a forced late import and dead-slot compaction, zero bridge
rows for a closure-free module, tracked/untracked byte equality, direct closure
identity/call behavior, method receiver identity, conditional rest
classification, collision-safe logical and physical export ownership, and the
five-entry census. Simultaneous vec and closure logical/physical/manifest
collisions resolve through both `buildImports().setExports` and `wrapExports`.
A closure-free forged `__is_closure` + `__call_fn_0` + `$cf` family remains
public but cannot fabricate runtime closure discovery, so a fieldless class
instance still crosses `wrapExports` as an object. Missing compiler aliases,
non-empty markers, mutable-i32 or f64 manifests, and reserved availability bits
also fail closed for a real compiled boxed class. An externref table containing
matching JS helper functions is rejected even when its length, availability,
and terminal aliases otherwise match. The adjacent #2083 and vec/closure
dispatch-runtime matrix passes **95/95 across thirteen files**, including the
focused C30 and C31 structural-ownership suites.

C31 closes exact retained ownership for this bounded closure host-dispatch
family, not R1. Higher-arity method dispatchers, other support callable
families, remaining class/type consumers, and module-array or display-name
scans still need structural owners before R1 can close.

### 2026-07-30 date civil support callable ownership continuation

The C32 continuation on `codex/3520-c32-date-civil-support` gives
`__date_civil_from_days` one canonical entry-source `date-civil-support`
binding at derived ordinal 0 and callable role ordinal 10. The exact allocator
object remains behind its stable function handle; tracked and untracked
binaries are byte-identical, and late-import/DCE locator resolution moves
0 → 1 → 0 without rebuilding the helper. A same-named source function cannot
occupy the Date role or redirect Date lowering: C32 always mints the exact
helper independently and installs the `funcMap` compatibility alias only when
the logical name is free.

Across `SINGLE_HOST_ENTRIES`, C31+C32 contain **166** defined functions,
**74** generic rows, **26** closure rows, and **1** Date row. Composed with
C30, the census is **50 generic + 24 vec + 26 closure + 1 Date**, the intended
one-for-one **51 → 50** generic move for C32. Routing remains **37 terminal /
30 emitted / 7 Unsupported / 0 Invariants / 37 legacy bodies / 30 IR bodies**,
so terminal adoption gain is zero.

The focused C32 suite passes **7/7**, including matching `bigint → bigint` and
mismatched `number → number` source-name collisions in both tracked and
untracked standalone lanes. Both the Date calendar result and user function
result are preserved, both binaries validate, and each tracked binary matches
its untracked counterpart. The suite also preserves leap-day output
`20240229`, exact structural/final-slot ownership, and census parity. The
adjacent negative-year suite passes **42/42** and the calendar-residual suite
passes **28/28**. The sole `date-native` `Date.now()` harness failure reproduces
on the exact C31 parent because `env.__date_now` is not supplied.

C32 closes exact retained ownership for this one civil-date support helper, not
R1. Other Date helpers and remaining support callable families still need
structural owners.

### 2026-07-30 data-struct host-bridge callable ownership continuation

The C33 continuation on `codex/3520-c33-data-struct-host-bridge` moves the two
host-visible data-struct classifiers behind one canonical entry-source
`data-struct-host-bridge` role at callable role ordinal 11:

- `__is_data_struct` owns derived ordinal 0 and
  `__struct_field_names` owns derived ordinal 1. Each existing body is
  materialized once, attached to its exact allocator object, and published only
  after late imports and helper allocation have settled. The historical
  logical labels remain public. Reserved `$d0` / `$d1` physical families always
  terminate at the compiler helper while preserving same-named source exports
  and every occupied shorter suffix;
- an immutable i32 availability manifest, exact empty funcref marker, and exact
  two-slot funcref binding table authenticate the family. The runtime proves
  the global and table types through Wasm import validation, requires every set
  bit to match the terminal physical function by identity, requires every
  unset binding slot to be null, rejects reserved bits and externref-table
  forgeries, and never falls back to a logical user export. Vec, closure, and
  data projections share one internal prototype view while the raw/public
  export object remains unchanged; and
- active element encoding now honors the existing `Element.tableIdx` field.
  Table zero retains its compact legacy encoding; later tables use the explicit
  active-funcref form. This is required when C31's closure binding table and
  C33's data binding table coexist, and prevents either family from
  initializing the other's table.

Across `SINGLE_HOST_ENTRIES`, C30+C31+C32+C33 retain **166** defined functions
and move exactly five rows from generic ownership: **45** generic + **5**
data-struct + **24** vec + **26** closure + **1** Date. Routing remains **37
terminal / 30 emitted / 7 Unsupported / 0 Invariants / 37 legacy bodies / 30
IR bodies**, so the continuation changes ownership only.

The focused C33 suite passes **13/13**. It covers both exact IDs and final
allocator objects, late-import/dead-slot re-resolution, zero-data and
private-only-class availability, tracked/untracked byte equality, exact census
composition, data-versus-closure classification and field order, simultaneous
vec/closure/data logical and physical collisions through both
`buildImports().setInstance` and `wrapExports`, the per-import immutable Global
association, donor-instance poisoning and recovery, raw legacy compatibility,
Proxy-table fail-closed recovery, host-only token import with zero standalone
imports, exact metadata types and
terminal identities, and fail-closed deletion, non-empty/externref marker,
mutable/f64/reserved manifest, swapped funcref binding, and explicitly
null-initialized externref binding-table forgeries.

C33 closes exact retained ownership for these two data-struct host helpers, not
R1. Per-field accessors and other support callable families remain on their
existing ownership paths.

### R1a validation evidence

- Representative inventory denominator: **1 source / 2 classes / 12 allUnits /
  6 terminalUnits**, with **6/6** outcome-ID parity and byte-identical tracked
  versus untracked output. The definition-expression fixture separately proves
  **1 / 3 / 10 / 2**, including three unowned implicit constructors.
- Collision matrix: same-named functions across sources, same-named nested
  functions/classes across lexical owners, static versus instance methods,
  get versus set accessors, and two legacy `<computed>` labels all receive
  distinct structural IDs. Two required ABI bindings sharing display label
  `same` receive distinct internal names and reject ambiguous reverse lookup;
  one explicit import alias resolves to its canonical final slot.
- Determinism: `/checkout-one` and `/different/checkout-two` produce identical
  IDs; reversing the caller input array preserves IDs/order; `a.ts` importing
  lexically later `z.ts` orders `z.ts` first, with disconnected sources tied by
  canonical key. Relocating both a project and an external declaration-library
  root preserves source IDs; exact resolved-dependency entries override syntax,
  checker-resolved external modules do not bind unrelated same-basename sources,
  duplicate final source keys fail, and numeric order/ordinal 10 sorts after 2.
- The #3520 identity, #3520 ABI, and R0 outcome suites passed **66/66**
  (**27** identity/provenance, **10** ABI invariants, and **29** R0 outcomes). The
  identity matrix snapshots exact timer/node:path/typed-Node-wrapper/
  process.stdin/Iterator R0 rows; proves raw/gc/standalone/WASI user
  class/member/function IDs and retained host-free-DCE support IDs; and keeps
  tracked/untracked host-free binaries stable. Removed DCE support units are
  target-absent and are not claimed as cross-target identities. The green
  focused matrix passed **93/93**. The separate known-base matrix passed
  **9/15**: its three existing #1983 type-index failures and three inline-small
  harness/expectation failures reproduce identically on the exact pre-branch
  base `d3d2454b`, so the combined nine-file result is **102/108** with no new
  failure attributable to this slice. #2138, #3529, and phase3c are green.
- `pnpm run typecheck`, `pnpm run lint`, `pnpm run format:check`, and
  `pnpm run check:loc-budget` pass; compiler-driver identity anchoring lives in
  `src/compiler/ir-outcome-inventory.ts` rather than growing `src/compiler.ts`.
- `pnpm run check:ir-only -- --policy=hybrid`: **READY**, 37 terminal units,
  31 emitted, 6 typed Unsupported, 0 Invariants; existing labels/counts remain
  unchanged.
- `pnpm run check:ir-fallbacks -- --verbose`: pass, zero unintended,
  post-claim, or module-level increases.
- Full equivalence gate: **1,608 passing**, **35 known failures**, zero new
  regressions, and one existing baseline failure now passing; the baseline is
  intentionally unchanged in this identity-only slice.
- Cross-backend differential validation passed **29/29**.
- No local Test262 run was performed; neither
  `benchmarks/results/test262-run.log` nor
  `scripts/equivalence-baseline.json` is changed.

## File ownership and locks

The implementing agent owns the files listed in frontmatter for the duration
of R1. The expanded lock is deliberate: a repository audit found source-unit
string keys in AST lowering plans, imported/module binding plans,
promise-delay ownership, IR-first call graphs, analysis passes, overlay
finalization, and the Porffor adapter in addition to the initially named core
files. Lock `src/ir/nodes.ts`, every typed-reference consumer, the listed
passes/backends, and `src/codegen/index.ts` as one identity change. Do not split
those files across parallel developers.

New identity/ABI modules are preferred over growing `codegen/index.ts`.
Changes in codegen context are adapter plumbing only. R1 may thread identity
through backend-linear/Porffor contracts, but it must not change backend
ownership or lowering behavior; whole-program multi consumption belongs to R5
and shared backend conversion belongs to R8.

## Anti-vacuity tests

`tests/issue-3520-ir-unit-identity.test.ts` must prove all of the following:

1. Two source files with identical top-level function/class/global display
   names receive distinct IDs and ABI entries in deterministic source order.
2. Two same-named classes in different lexical scopes, and two anonymous class
   expressions, do not share `IrClassId`, field layout, constructor, or member
   entries.
3. `static m`, instance `m`, `get x`, `set x`, a private/computed member, and a
   top-level spelling that resembles the legacy synthetic key all inventory as
   distinct units. Supported units resolve to distinct slots; unsupported
   members still receive distinct terminal identities.
4. A lifted closure in each of two same-named parents and two monomorphization
   clones cannot alias in inline/mono maps. Reversing unrelated `Map` insertion
   order does not change canonical IDs or output ordering.
5. Imported/default/renamed aliases and inherited members resolve as explicit
   aliases to one canonical binding, while an accidental collision raises the
   stable ABI invariant.
6. The R0 ledger has exactly one outcome per `terminalUnits` record; nested and
   support records remain present in `allUnits`, resolve to a terminal owner,
   and do not change legacy display labels/histograms.

Run the collision tests alongside `tests/issue-1983-funcmap-collision.test.ts`,
`tests/issue-2138-multi-module-ir-overlay.test.ts`,
`tests/ir/inline-small.test.ts`, `tests/ir/phase3c.test.ts`, and the
multi-file equivalence suite.

## Acceptance criteria

- [ ] `IrSourceId`, `IrUnitId`, `IrClassId`, and typed binding identities are
      the only keys for program-level IR semantics; display names are labels.
- [ ] Same display names across files/classes/lexical scopes and
      static-vs-instance/get-vs-set members cannot collide or overwrite an IR,
      pass, ABI, or concrete slot entry.
- [ ] One deterministic `ProgramAbiMap` inventories signatures, globals,
      imports, types, exports, aliases, classes, and synthetic support units in
      source order before R2 uses it for ownership.
- [ ] Inline, recursion, propagation, monomorphization, integration, and clone
      identity are keyed structurally; there is no `byName` last-wins behavior
      for source units.
- [ ] The legacy adapter is the only name-keyed compatibility boundary and
      rejects ambiguous reverse lookup.
- [ ] Selection, Prepared/Unsupported outcomes, direct-vs-IR routing, and body
      emission counts are unchanged in R1.
- [ ] Non-collision fixtures are emitted byte-for-byte identically across gc,
      standalone, and WASI. Collision fixtures match JavaScript runtime
      behavior and retain public export names.
- [ ] Existing fallback/adoption and R0 telemetry counts/labels retain parity;
      the new IDs add information but do not reclassify outcomes.

## Risks and mitigations

- **Public-name churn:** structural IDs could leak into exports or diagnostics.
  Keep display/export names as explicit ABI labels and byte-compare every
  non-collision fixture.
- **Nondeterministic IDs:** filesystem or `Map` insertion order could change
  binaries and baselines. Derive IDs from normalized source identity, lexical
  position, unit kind, and deterministic clone ordinals.
- **Adapter ambiguity:** a reverse name lookup can silently choose the wrong
  legacy slot. Require a unique structural owner and raise a stable Invariant
  on zero or multiple matches.
- **Late index shifts:** lazy imports/globals can invalidate numeric slots.
  Keep symbolic binding identities until the one planned finalization boundary and
  test late-import pressure.
- **Wide pass blast radius:** identity touches builders, passes, and codegen.
  Land the bounded commits with old/new telemetry parity after each step and
  keep routing unchanged throughout R1.

## Out of scope

- Creating `PreparedIrProgram` or moving preparation before body emission
  (#3521).
- Skipping any additional direct body, changing fallback policy, or removing
  `experimentalIR` / IR-first switches.
- Compile-once class/closure ownership (#3522), module init (#3523), or
  whole-program multi-source ownership (R5).
- Rewiring runtime families (R6), async policy (R7), linear consumption (R8),
  or deleting direct handlers (#3090/R10).

## Required completion evidence

Expected-green Commit 2 and R1 gates:

```bash
pnpm exec vitest run tests/issue-3520-ir-unit-identity.test.ts tests/issue-3520-program-abi.test.ts tests/issue-2138-multi-module-ir-overlay.test.ts tests/ir/phase3c.test.ts tests/linear-integration.test.ts tests/issue-3161.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
pnpm run check:ir-only -- --policy=hybrid
pnpm run check:ir-fallbacks -- --verbose
pnpm run typecheck
pnpm run lint
pnpm run format:check
node scripts/equivalence-gate.mjs
pnpm exec vitest run tests/cross-backend-diff.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

Known-base control matrix, run separately against both the branch and its exact
pre-branch base:

```bash
pnpm exec vitest run tests/issue-1983-funcmap-collision.test.ts tests/ir/inline-small.test.ts --pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism
```

This control command is not expected green while the existing #1983 type-index
and inline-small harness/expectation failures remain. Completion requires the
exact test/failure set and diagnostics to match the pre-branch control, with no
new failure. Do not combine it with the expected-green command or report the
combined exit status as a green gate.

The PR report must include the source/unit/class/binding denominators, a
collision matrix, deterministic-order proof, old-vs-new telemetry diff, and
the byte-identity result for the non-collision corpus. A passing runtime sample
without distinct ABI IDs/slots is vacuous and does not close R1.

## Branded instance API prerequisite

The C33 data-struct bridge is split behind a behavior-neutral host wiring
prerequisite. `buildImports().setInstance(instance)` validates the
`WebAssembly.Instance` internal slot through captured intrinsics, then performs
the same export wiring as the retained `setExports(instance.exports)` API.
Canonical Test262, benchmark, fuzz, npm-compat, generated runner-bundle,
dogfood, equivalence, stress, and website harnesses use the branded path.
The remaining shared instance-owning test helpers do the same, and pass the
instance rather than its exports record to `wrapExports`. The npm callback
counter keeps one documented raw overlay only after branded wiring has
established the trusted helper identities. `setExports` remains supported for
legacy callback, closure, vec, and string families.

The brand and export-view ownership checks capture both `Reflect.apply` and
`Object.prototype.hasOwnProperty` at module initialization. Regression coverage
poisons `Function.prototype.call` during raw compatibility wiring and replaces
`Reflect.apply` after import; neither mutation can bypass the instance brand or
redirect the metadata ownership checks.

## C33 authority repair

C33 is the second, independently reviewable layer on the branded API. Each
host data-struct module re-exports the exact immutable string-constant Global
created by its `buildImports` result. `setInstance` requires that object
identity before it may establish data-struct authority, so a genuine instance
created with another `buildImports` cannot poison the target and the associated
instance can recover afterward. Native-string targets retain zero host imports.
Because engine-created imported-string Globals cannot preserve the association
object's identity, `instantiateWasm` and its streaming variant use the explicit
string-constant import path only when this reserved token is present.
Standalone output remains import-free.

The runtime pins the token, manifest, tables, and helper identities. Raw
`setExports` remains usable by legacy bridge families but cannot establish
first data authority. Proxy table shape reads and callable-slot reads are
guarded fail-closed.

The playground and generated load-time benchmark runtimes retain the complete
`buildImports` result through instantiation. Both pass the exact
`string_constants` and `string_constants16` maps into the instantiator and wire
callbacks through `setInstance`. Consumer execution coverage pins the authority
census at raw `0`, mismatched-token `0`, and canonical branded `2`, then invokes
a compiled callback after the same association is established.
