---
id: 3528
title: "IR-only R8: linear consumes the shared Prepared IR program"
status: blocked
sprint: Backlog
created: 2026-07-21
updated: 2026-09-05
priority: critical
horizon: xl
complexity: XL
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen-linear, compiler
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r8
model: gpt-5.6-sol
parent: 3518
depends_on: [3525, 3526, 3527]
related: [1713, 1714, 2953, 2954, 2956, 3090, 3497, 3500, 3518]
origin: "#3518 R8 — delete linear's second selector/direct frontend after shared-program parity"
files:
  - src/ir/program.ts
  - src/ir/program-abi.ts
  - src/ir/runtime-manifest.ts
  - src/ir/async-plan.ts
  - src/ir/backend/linear.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/backend/emitter.ts
  - src/ir/backend/legality.ts
  - src/codegen-linear/index.ts
  - src/codegen-linear/context.ts
  - src/codegen-linear/runtime.ts
  - src/compiler.ts
  - scripts/check-linear-ir.ts
  - scripts/linear-ir-baseline.json
  - tests/issue-3528-linear-shared-prepared-program.test.ts
---

# #3528 — IR-only R8: linear consumes the shared Prepared IR program

## Objective

Make linear lowering consume the exact same frozen `PreparedIrProgram`,
`ProgramAbiMap`, runtime-feature manifest, and `IrAsyncPlan` instances as
WasmGC. Backend choice occurs only after front-end preparation:

```text
source -> PreparedIrProgram -> WasmGC emitter
                            -> linear emitter
```

Linear may choose different value/layout/runtime providers below typed IR, but
it may not reread source AST, rerun selection/type propagation, rebuild IR,
infer a second ABI, or fall through to direct AST visitors. A source feature
unsupported by linear is a typed pre-emission backend `Unsupported`; a missing
adapter for a feature advertised as linear-capable is an `Invariant`.

## Current evidence

Linear is currently a direct frontend with an additive single-source overlay:

- `src/codegen-linear/index.ts:101-280` scans the `TypedAST` for classes,
  functions, globals, strings, and runtime needs, preassigns legacy slots, and
  then calls `compileLinearIrFunctions` at `:227`. A rejected overlay function
  immediately falls through to direct `compileFunction`.
- `src/codegen-linear/index.ts:283-438` implements multi-source separately and
  never invokes the IR overlay. It scans every source, handles entry/re-export
  names, and compiles every top-level function directly.
- Direct visitors remain the semantic frontend:
  `compileFunctionMulti` (`src/codegen-linear/index.ts:441-523`),
  `compileFunction` (`:525-625`), `compileStatement` (`:682+`), and
  exported `compileExpression` (`:1615+`), plus class/literal/call helpers in
  the same module.
- `src/ir/backend/linear-integration.ts:1-38` explicitly describes an overlay
  that independently runs `planIrCompilation`, `lowerFunctionAstToIr`, verify,
  legality, and demotes everything else to LINEAR DIRECT.
- `compileLinearIrFunctions` at
  `src/ir/backend/linear-integration.ts:156-412` accepts a
  `ts.SourceFile`, builds its own TypeMap/recursive evidence at `:192-216`,
  walks top-level `FunctionDeclaration` AST at `:218+`, runs its own fixpoint,
  constructs an `IrModule`, and catches build/lower errors into direct-path
  rejection buckets.
- The linear resolver still reads checker/AST representation and mutates
  direct-backend registries for strings, aggregate helpers, types, and runtime
  operations. `LinearIrResult` reports an overlay population, not an exhaustive
  shared-program denominator.
- `linearIrEnabled` at `src/ir/backend/linear-integration.ts:137-139` is
  default-on with `JS2WASM_LINEAR_IR=0` restoring the direct backend. Default-on
  overlay is not IR-only ownership.

The ratchet is also false-safe for retirement:

- `scripts/check-linear-ir.ts:64-89` compiles only playground examples. Its
  `try/catch` at `:68-75` swallows compilation crashes as “direct-path
  concerns.”
- The gate requires only that `compiled` not decrease (`:115-117`) and that no
  rejection bucket increase (`:118-123`). A corpus can pass with direct
  emissions, unhandled sources, multi-source AST lowering, or a permanently
  partial IR overlay.

## Shared consumer contract

The compiler prepares once, independent of target. Both backend consumers
receive immutable references to:

1. The same ordered source-unit census and R0 terminal outcomes.
2. The same `ProgramAbiMap` binding identities, semantic signatures, exports,
   globals, aliases, class shapes, module-init plan, and support-unit graph.
3. The same verified/transformed IR functions and `IrAsyncPlan`s, byte/hash
   comparable before backend adaptation.
4. The same #3526 intrinsic/runtime-feature manifest. Each backend maps features
   to its representation-specific provider and projects its minimal host
   capabilities without changing the semantic feature set.
5. Backend legality/adaptation results recorded before any body is emitted.
   Linear-only layout planning (arena, vector/string/object layouts, concrete
   `ValType`s, runtime function indices) is a deterministic lowering product,
   never input to shared preparation.

The linear consumer must accept both single- and multi-source programs through
one entry. It resolves every call/global/class/export/module-init/async edge by
structural ID and planned ABI handle. Concrete linear indices and layouts are
allocated once below the frozen ABI and cannot feed back into selection.

## Terminal outcome and gate contract

For each source/support unit and target, the R0 ledger records exactly one
backend terminal result before publication:

- `Emittable(linear)` — the shared Prepared unit and every required feature/
  async adapter are legal; emit once.
- typed `Unsupported(linear/<stable-code>)` — the source semantics are prepared
  but intentionally unavailable for linear; IR-only compilation fails with a
  source location and emits no binary/body.
- `Invariant` — missing adapter, ABI mismatch, unexpected lowering failure,
  duplicate/missing slot, or late mutation; fail in every policy.

There is no `rejected -> compileFunction`, catch-to-direct, or “no report”
state. Linear lowering is not allowed to discover a capability gap after a
body or mutable runtime registry has been published.

Replace `check:linear-ir`'s count ratchet with an exhaustive matrix gate that:

- derives its denominator from the same Prepared program ledger;
- includes single/multi-source, cross-backend, class, module-init, runtime
  family, async, standalone, WASI, fast-relevant, and validity corpora;
- requires zero unaccounted units, zero caught compile failures, zero post-
  Prepared demotions, and zero direct body emissions;
- checks that every emitted linear unit references the same shared IR/ABI/plan
  hash as the WasmGC preparation run; and
- fails, rather than updates a permissive baseline, on a newly missing adapter.

## Bounded landing sequence

### L0 — shared-program parity adapter

- Change the linear entry to accept `PreparedIrProgram` while temporarily
  retaining the old overlay as a comparison oracle only.
- Build a deterministic adapter table from IR types/instructions/intrinsics/
  async operations to linear representations and providers. Record exhaustive
  legality before emission.
- First establish the concrete semantic-body handoff in the implementation
  plan below. Parity requires one preparation object consumed by both adapters;
  equal hashes from two independent frontend builds are only diagnostic data.

### L1 — single-source shared ownership

- Emit every linear-supported function/class/closure/module-init unit from the
  shared program and planned ABI slots. Use #3526 feature providers and #3527
  async plans without source-AST callbacks.
- Turn remaining intentional gaps into typed pre-emission linear Unsupported.
  Remove the single-source `planIrCompilation`/`lowerFunctionAstToIr` rebuild
  and catch-to-direct route after zero-direct proof.

### L2 — whole-program multi-source and startup

- Consume #3525's same multi-source program, aliases, globals, re-exports,
  classes, ordered init, and support registry. Remove the separate direct
  `generateLinearMultiModule` semantic scan.
- Prove single-source and one-file multi-source consume identical unit/ABI/IR
  identities; prove cross-file same names and async delegation by ID.

### L3 — strict gate and AST visitor retirement

- Extend `scripts/check-linear-ir.ts` and its baseline to exhaustive
  zero-unhandled/zero-direct accounting. Preserve its landed authenticated
  census and explicit compile/instrumentation failures; replace the remaining
  overlay compiled-count/rejection-threshold acceptance predicate.
- Poison and then delete `compileFunctionMulti`, `compileFunction`,
  `compileStatement`, `compileExpression`, class/source scanners, the second
  selector/type-propagation driver, and `JS2WASM_LINEAR_IR` only after
  reachability plus corpus proofs pass.
- Keep linear runtime/layout/emitter providers that are reached below IR.

## File ownership and locks

One developer owns `src/ir/backend/linear-integration.ts`, the new/shared linear
backend adapter, `src/codegen-linear/index.ts`, `src/codegen-linear/context.ts`,
`src/compiler.ts`, and `scripts/check-linear-ir.ts` for L0/L1. They encode the
one-consumer/no-fallback invariant and must not be split across parallel
writers.

Coordinate manifest/provider interfaces with #3526, whole-program ABI/startup
with #3525, and async plan lowering with #3527. Runtime/layout files may be
owned by disjoint follow-up slices only after the adapter contract is fixed.

## Anti-vacuity tests

`tests/issue-3528-linear-shared-prepared-program.test.ts` must prove:

1. Instrument preparation and compile the same fixture for WasmGC then linear:
   preparation runs once, both consumers receive the same object/IR/ABI/
   manifest/async-plan hashes, and backend adaptation cannot mutate them.
2. Poison `planIrCompilation`, `lowerFunctionAstToIr`, TypeMap building, source
   AST walks, `compileFunction*`, `compileStatement`, and `compileExpression`
   after preparation. Supported single- and multi-source linear fixtures still
   compile and run.
3. Every Prepared+linear-emittable unit records direct=0/IR=1. An intentional
   linear Unsupported has a stable code/span, emits no body/binary, and cannot
   be changed into success by enabling the old direct path.
4. A missing instruction/type/intrinsic/async/runtime adapter is Invariant
   before emission; a thrown compile, missing report, or caught lowering error
   fails the new gate.
5. Same-name cross-file functions/classes/globals, default/namespace/re-exports,
   closures, class members, ordered module init, and startup resolve through
   shared IDs rather than flat `funcMap` spelling.
6. A real two-suspend async function and async generator reuse the exact R7
   state/liveness/handler plan; no linear-specific async frontend exists.
7. Linear layout/provider differences do not alter semantic IR or feature
   manifest. Reordering internal maps leaves concrete output deterministic.
8. A reachability test detects any import from `typescript` or AST/source
   visitor reachable below the linear backend entry after L3, while explicitly
   allowing retained runtime/layout/emitter modules.

Run the new test with `tests/linear-ir.test.ts`, `tests/issue-2956.test.ts`,
`tests/issue-3497-linear-jsdoc-landing-signatures.test.ts`,
`tests/issue-3500-linear-ir-recursive-call-graph-type-evidence.test.ts`,
`tests/cross-backend-diff.test.ts`, and the `tests/linear-*.test.ts` suite,
plus multi-source, class, module-init, async, standalone/WASI, and Wasm validity
matrices from the R5–R7 issues.

## Acceptance criteria

- [ ] WasmGC and linear receive the same immutable `PreparedIrProgram`,
      `ProgramAbiMap`, runtime-feature manifest, and `IrAsyncPlan`s; their only
      difference begins in backend adaptation/lowering.
- [ ] Linear performs no AST/checker scan, selection, type propagation, IR
      rebuild, semantic ABI inference, or runtime-intent discovery.
- [ ] Single- and multi-source linear compilation use one shared consumer entry
      and resolve all source/support units by structural identities.
- [ ] Every supported linear unit is emitted once from IR; intentional target
      gaps fail typed/source-located before emission; missing adapters and late
      failures are fatal Invariants.
- [ ] `check:linear-ir` requires exhaustive zero-unhandled, zero-caught-error,
      zero-post-Prepared-demotion, and zero-direct-emission evidence across the
      named matrix.
- [ ] The second selector/front-end driver, `JS2WASM_LINEAR_IR` escape,
      single/multi direct function/statement/expression/class visitors, and
      catch-to-direct routes are unreachable and deleted after proof.
- [ ] Linear runtime, allocator, layout, C-ABI, string/collection, and other
      backend providers remain single-sourced below IR where still reachable.
- [ ] Cross-backend/equivalence/linear/full IR-only/typecheck/format/validity,
      standalone/WASI, and merge-group Test262 gates are net-non-negative.

## Deletion boundary

R8 deletes linear AST visitors, its second selector/type-propagation/from-AST
driver, direct fallback routing, and permissive count gate only after shared-
program and zero-direct reachability proofs pass. It retains backend emitter,
memory/layout/allocator, runtime, C-ABI, and provider code. WasmGC's remaining
general direct handlers persist until R9 makes IR-only sole policy and
#3090/R10 proves them unreachable.

## Out of scope

- Making WasmGC and linear use the same concrete representation, allocator, or
  runtime implementation.
- Rebuilding IR per target to simplify legality or layout inference.
- Treating a caught compile failure or stable nonzero rejection baseline as
  retirement evidence.
- Deleting retained linear runtime/provider code merely because its old entry
  was an AST visitor.

## Risks and mitigations

- **Semantic hash drift:** target options can leak into preparation. Serialize
  and compare the shared program before adaptation under every target.
- **Legality discovered too late:** current lowering catches failures. Build an
  exhaustive adapter/feature legality result and freeze it before any body.
- **Multi-source regression:** linear currently has a separate direct path.
  Require the R5 one-file/multi/collision/module-init matrix before deletion.
- **Runtime deletion confusion:** AST visitors and providers coexist in
  `codegen-linear`. Keep a function-level reachability classification and
  delete only the frontend side.
- **Gate denominator shrink:** removing a report can make counts appear green.
  Derive expected units from the Prepared census and fail on missing reports,
  compile catches, or unaccounted source/support units.

## Source re-grounding — 2026-09-05

Audited source: `5da655f286fcd569203cd2012b23dc21bf1c626d`. The later fetched
upstream `4946cf70fe82def4bb4ec3e55092153b90b9506b` changes runtime prototype
support but none of the IR or linear files cited here. This is source evidence,
not a new corpus or conformance measurement. All acceptance criteria remain open.
The subsequently verified `0a5a3e87df074982cc3022a95899fc62ad69b036` includes
computed-method selection and the merged retirement plans; it also leaves the
cited linear preparation and ratchet files unchanged.

The July narrative about `check-linear-ir.ts` swallowing a compilation crash
as an empty success is now stale. The current script has an authenticated
complete source/owner census, explicit compile-error evidence, instrumentation
failures, and a failing top-level exception outcome. Preserve those controls.
Its corpus remains the fixed playground population and its acceptance predicate
remains a compiled-count/rejection-threshold ratchet. It still does not prove
zero direct emissions or the shared prepared-program product contract. The
next gate change must extend the existing complete-accounting instrument rather
than replace it with a bare count or reimplement its already-landed safeguards.

Likewise, linear already has early structural identity/selection preparation:
`prepareLinearIrOverlay` (`linear-integration.ts:514`) freezes and authenticates
an exact context/source/oracle record before user slots. However,
`PreparedLinearIrOverlay` (`:501`) retains `LinearContext`, `ts.SourceFile`,
the oracle, and AST-keyed selection evidence. It is neither the neutral
`PreparedIrProgram` handoff nor a complete semantic body snapshot.

The remaining independent frontend rebuild is concrete:

- `planLinearIrOverlay:384` builds its own propagated types, recursive evidence,
  checker overlay and selection. Selection still depends on existing runtime
  functions and linear-specific capability choices.
- `compileLinearIrFunctions:954–1095` derives callable signatures from
  declarations, projects them into legacy names, and retries
  `lowerFunctionAstToIr` in a separate fixed point. Ordinary build failures can
  still demote to the direct route; exact counted-string reservations have
  stronger invariant behavior and must retain it.
- `prepareLinearIntrinsicFunctions:666` prepares a target-specific runtime
  manifest after this rebuild. Sharing the vocabulary or the from-AST helper
  is not evidence that both backends consume the same prepared semantic input.

Before dispatching L0, reconcile the shared frontend boundary with **#4617 —
Frontend-neutral semantic IR snapshot for TypeScript 7 and Acorn**, the active
R2 callable-boundary work, and R5 whole-program ownership. Preserve the existing
unfinished D1a worktree recorded in #4617; do not duplicate it or overwrite it.
The next implementation plan must name the immutable semantic artifact and
its exact production producer/consumers, then prove preparation and semantic
hash equality before permitting linear to bypass its independent builder.
Wrapping `PreparedLinearIrOverlay` in a differently named type, serializing
AST/checker state, or accepting two independently rebuilt hashes as one shared
preparation does not advance the required boundary.

The recorded `/private/tmp/js2-4617-d1a-function-value-baseline` directory is
not visible in this filesystem. Its worktree/branch registration remains, so
absence here is not proof that the unpublished bytes were deleted on every
host. Preserve the registration and the recorded checkpoint; do not prune or
recreate that path as a cleanup step. Any D1a continuation must first establish
which recorded changes are available and compare them with current production
source, rather than treating the historical dirty worktree as a ready artifact.

## Implementation Plan — 2026-09-05: L0-P1 immutable body handoff

**Dispatchable prerequisite, not L0 or R8 completion.** Proposed claim
`3528:l0-p1-frozen-body-batch`; root verifies/reserves before dispatch. Astra
plans; Luna Max implements. Source baseline is upstream
`470ceba797a2822ead2a4060fc65fb78c0b52887`, present in planning head
`a5fbaa544046f854daba8881d80c72bc56b87bf9`. This section records source analysis
and required tests, not a newly measured runtime or coverage result.

### Actual boundary and remaining dependencies

`compiler.ts:1092–1101` selects `generateLinearModule`/`generateLinearMultiModule`
or WasmGC `generateModule`/`generateMultiModule` before any shared semantic
preparation. Linear's single-source body (`codegen-linear/index.ts:182`) creates
runtime/context state, prepares the AST-bearing overlay, allocates user slots,
then calls `compileLinearIrFunctions` (`linear-integration.ts:803`). That
function independently infers/builds/verifies bodies (`:954–1095`), attaches
runtime providers (`:1110`), plans memory (`:1128`) and lowers (`:1147`). Its
multi-source entry still has a separate direct frontend.

WasmGC instead builds/transforms/prepares bodies in `ir/integration.ts`; its
`lowerIrEntryFunction:505` uses the async adapter or
`lowerIrFunctionToWasm` (`lower.ts:546`). Both numeric backends already reach
`lowerIrFunctionBody:585` with different emitters/type converters. Sharing
that lowering helper does not share their prepared input.

There is no production shared semantic program to pass to linear:

- `PreparedIrProgram.reconciliation` (`program.ts:201`) is still
  `pending-production-wiring`. Its candidate container cannot certify this
  handoff merely by accepting an `unknown` IR payload.
- `IrFunction`/`IrModule` (`nodes.ts:2460/2564`) contain executable semantics,
  but `readonly` is not runtime ownership. The existing mutable build results
  are the data this phase must actually capture and consume.
- `IrFromAstResolver` (`from-ast.ts:383`) still decides string iteration,
  string/extern coercion and vector representations from backend capabilities.
  Linear's resolver combines frontend queries and lowering operations
  (`linear-integration.ts:1373`). This phase does not erase those choices.
- #4617's landed `semantic-declaration-snapshot.ts` records declaration-query
  facts, not function bodies. Its unpublished D1a function-value work remains
  unavailable and must be preserved. The interchange contract in
  `ir/contract.ts` has a schema/version but no production module serializer.

R2-B1 at PR #5600, exact `2d8741c3332c0928b905bf4948c904e0ee112004`, issues
`PreparedCallableBoundaryCandidate` through
`program-abi-source-callable-planning.ts:412`, and certifies final IR, physical
signature and closure support in `integration.ts:538`. Those authenticated
module/session receipts are backend evidence, not neutral body data. Reuse that
distinction; do not serialize its callbacks, allocated function, or handle as
semantic authority. R5 M2-P1 freezes ordered source/init census; active M2-P2A
prepares and publishes initializer batches. Neither supplies this missing body
artifact. L0-P1 does not depend on modifying or completing their transactions.

### Increment: replace the production body handoff

Introduce **`FrozenIrBodyBatch`** in `src/ir/frozen-body-batch.ts`: an owned,
validated, deeply immutable snapshot of the actual executable `IrModule` and
its preparation inputs. It is a body-preparation artifact with explicit
producer/representation provenance, **not** a fully neutral `PreparedIrProgram`
or a new whole-program ABI seal.

The production producer is a named `prepareLinearIrBodyBatch` extraction from
`compileLinearIrFunctions`, immediately after the existing
`prepareLinearIntrinsicFunctions` and `prepareLinearStringRepeatFunctions`
finish, before `planLinearMemory` and the first body lower. Every successfully
built owner must cross this handoff; no permanent name, signature, fixture,
owner-count, or operation-family bypass is allowed. Keep selection and its
existing Unsupported/rejection records above this boundary.

The artifact must own the following existing data losslessly:

1. The ordered function array; each `unitId`, diagnostic name, params/value IDs,
   result types, `valueCount`, export/`funcKind`, slots, blocks/block arguments,
   every nested instruction buffer, all instruction operands/types/source
   sites/allocation IDs, terminators and branch arguments. Preserve optional
   closure subtype, generator slot, `asyncPlan` and existing runtime attachments
   when present. Preserve class/shape identity and all structural callable/global
   bindings; never replace a binding with its display name. Do not silently
   omit currently unsupported or newly added fields from a copy or digest.
2. Exact source/terminal-owner records projected from the authenticated overlay,
   plus an explicit built/rejected owner census. Snapshot each body's logical
   signature from its IR params/results, and retain existing declaration tables
   with their actual completeness. A partial `declaredSignatures` or
   `declaredGlobals` table stays partial; this is not `ProgramAbiMap` completion.
   `IrType.val` and slot types may still reflect producer-specific representation.
   Preserve optional ValType brands (`boolean`, `symbol`, `bigint`,
   `undefSentinel`) exactly, including absent versus present false; neither
   `irTypeKey` nor `irTypeEquals` alone proves a lossless copy or fingerprint.
3. The existing effect facts from `effectsOf`, joined to stable owner/block/
   nested-buffer/instruction positions, with ordered read/write slot sets.
   The body graph remains the authority for evaluation order. Reuse the effect
   model; do not add a second classifier or change an existing effect policy.
4. The allocation facts consumed by `planLinearMemory`: referenced allocation ID,
   resolved canonical site/kind/type/origin, ownership/access/stack-candidate
   evidence, escape result and encoding, including explicit absent/unknown
   evidence. Capture after the current analysis sequence; preserve explicit
   live/aliased/retired provenance, and distinguish unobserved evidence from
   known missing facts. Aliases retain exact ID joins and a live canonical
   target for every referenced allocation. Add a read-only registry snapshot
   method if needed; never infer retired versus unknown from `resolve() ===
   null`. No live registry is retained.
5. Runtime and representation inputs actually settled by this producer:
   retain the result/manifest currently discarded by
   `prepareLinearIntrinsicFunctions:666`, exact structural callable/provider
   references and attached provider data, the AST-free counted site/owner/source
   and final-instruction digest projection, and relevant producer policy/version
   facts. Explicitly record an empty manifest/demand population. Some ordinary
   string/vector operations still use resolver/layout inputs outside the R6
   manifest: record that boundary instead of claiming a complete R6 manifest.

`PreparedCountedStringAppendReceipt.plan` contains a `SourceFile` and syntax
plan (`ast-lowering-plans.ts:345`); it must stay in the upper integration
sidecar. Preserve its existing exact source/reservation authentication before
freeze and final successful-owner publication rule. The new artifact retains
only its data projection and executable instruction evidence. It must not
contain `PreparedLinearIrOverlay`, `LinearContext`, TS nodes/checkers/oracles,
AST-keyed maps, resolver closures, a mutable Wasm module, or allocator objects.

Reuse `freezePreparedIrValue`'s defensive ownership rules where suitable
(`program.ts:292–363`); freezing the outer object or a native `Map` is inadequate.
The artifact factory validates semantic structure, references and census before
issuing a private authenticated instance. Its deterministic content digest must
cover executable data and declared incompleteness, preserve instruction/argument
order, distinguish missing/null/empty and numeric edge values, and handle the
existing allowed recursive class shapes by structural identity. This is an
internal fingerprint, not an implementation or claim of #3030 interchange.
Hashes never authenticate forged or cross-session objects.

### AST-free consumer and allocation extraction

Create `src/ir/backend/frozen-body-consumer.ts` with one consumer taking the
exact batch plus a separate backend plan/capability object. Linear production
must use it for the bodies just captured; leaving the old local `built` map as
the emitter's authority would make this an unused wrapper. The consumer uses
existing `lowerIrFunctionBody`, `LinearEmitter`/`WasmGcEmitter` and type converters.
No new Wasm instruction scheme is needed. Keep the existing linear local-slot,
vector scratch-local and stack-arena adaptation when extracting the body loop.

The WasmGC consumer for this increment is this same entry driven by the real
`WasmGcEmitter`, `wasmValueTypeConverter` and Wasm assembly in common-input tests.
Normal WasmGC production still uses `lowerIrEntryFunction` and does not yet
receive the new producer's object. Report that limitation explicitly. The
production linear handoff, rather than a test-only factory, is the deliverable.

Separate preparation facts from physical layout in
`analysis/linear-memory-plan.ts:462`: extract its initial encoding → ownership →
escape → stack-candidate analyses into a producer helper, and add a layout-only
entry consuming frozen allocation facts. Keep a compatibility entry for existing
callers if needed, but linear production below the new handoff must use the
frozen-fact entry and must not rerun those analyses against a retained mutable
registry. Allocator policy, layout selection, physical indices, helper bodies,
data segments and type conversion belong to the backend plan, outside the
semantic snapshot. Do not change the R4 module-storage producers.

Backend preparation validates the complete batch before lowering any body:

- Join exact owner IDs to the supplied backend's own slots and semantic/physical
  signature evidence; reject duplicate/missing/foreign owners. Different
  backends may use different physical slots without changing the batch.
- Apply `verifyIrBackendLegality` and the existing runtime/layout policy to the
  actual frozen instructions, including nested buffers and retained plans.
  A producer-specific carrier/provider that the requested backend cannot
  implement is typed, source-located Unsupported before emission. Do not guess
  another carrier or rebuild the source for that backend.
- Settle the resolver inputs demanded by this batch before the first body:
  callable/global/type lookups, supported layouts, provider attachments and
  helper operations. Use existing provider/layout authorities. Missing promised
  input, inconsistent signatures, detached receipts or unresolved declared
  references are Invariants, not fresh Unsupported or a spelling fallback.
- Authenticate the resulting backend plan to this exact batch and its own
  compilation/module session. Prepare once, consume once per backend plan;
  independent backend plans may consume the same immutable batch. Recheck joins
  before publishing output. Do not import TS or expose a callback that can
  request source selection, type inference, body construction or runtime intent
  discovery from the consumer.

Backend attachment and physical adaptation may make owned derived records;
mutating the batch is forbidden. Produce detached results keyed by owner and
publish through the existing linear caller only after successful validation.
Keep intentional pre-ownership policy outcomes and existing rejection buckets
visible above the consumer. Once a backend plan promises emission, a lowering
throw or missing adapter is a fatal Invariant; do not catch it into direct
compilation, an empty module, or a successful report. Do not claim that this
linear boundary supplies R5's whole-program transaction.

If current runtime/layout APIs cannot provide a required input before lowering,
identify and extract that exact preplanning operation within this linear scope.
Do not compensate by widening a catch, silently retaining a mutable producer
object, excluding more supported source shapes, or describing the body snapshot
as fully backend-neutral. A need to change R2/P2A/R4 authorities is a dependency
escalation to the lead, not permission to edit their files.

### Evidence required before landing

Add `tests/issue-3528-frozen-body-handoff.test.ts` and focused allocation-fact
controls. Measure baseline and candidate on the same source, target options and
entrypoints, with explicit denominators and real runtime assertions.

- Capture a batch through the real linear production producer. Feed **that same
  object** to both backend consumers, with separate legitimate module/slot plans;
  assert object identity and unchanged semantic digest before/after both runs.
  Include a multi-function numeric call graph, branches/loops/live mutable slots,
  and nonempty common Math intrinsic demand such as `math.imul`/`math.trunc`.
  Instantiate both generated binaries and check expected results, including
  negative/zero/large conversion inputs. Two independent calls to `compile`
  followed by hash comparison do not satisfy this test.
- Add an observable ordering case using the same explicit import binding and
  host trace in both backend plans: two effectful calls with a live intervening
  value must preserve argument and call order. This can be an additional
  body-builder control; it does not replace the production-producer test.
- Cover production linear vectors/objects/strings and counted-string reservation
  controls. Assert the allocation analyses run before freeze and are poisoned
  afterward; layout/lowering consume the captured facts. Preserve exact receipt
  identities/digests and failed-owner non-publication.
- Poison the second selector, TypeMap/checker queries, AST walks,
  `lowerFunctionAstToIr` and direct body emitters after the producer has finished.
  Both consumer invocations still execute the supported common input. Count
  actual frontend attempts separately from artifact creation: L0-P1 does not
  erase the earlier fixed point or claim every source function built once.
- Mutate producer arrays/maps/sets, nested operands, provider data and allocation
  metadata after capture; the batch and emitted result remain unchanged. Attempt
  mutation through the consumer, swap another batch with equal bytes, use a
  stale/cross-session slot plan, duplicate/drop a unit, alter a call signature or
  required provider, and substitute a same-spelling foreign binding. Each
  corruption must fail before body publication; missing evidence cannot pass.
- A genuine unsupported backend carrier or operation has a typed pre-emission
  outcome and zero body emissions. Deleting an adapter promised by an accepted
  plan instead raises an Invariant. Assert these are distinguishable and the
  old direct route cannot turn either consumer outcome into success.
- Empty/type-only production inputs are explicitly empty and cannot satisfy the
  positive common-input denominator. Removing a report or a selected owner from
  the capture fails census validation. Preserve #4550's authenticated complete
  accounting; do not lower its thresholds or substitute this test for R8's
  eventual whole-program zero-direct gate.

### Exclusive implementation ownership and gates

One Luna Max worker owns:

- New `src/ir/frozen-body-batch.ts`,
  `src/ir/backend/frozen-body-consumer.ts`, and, if useful,
  `src/ir/analysis/prepared-allocation-facts.ts`.
- `src/ir/backend/linear-integration.ts`: only the runtime-result retention,
  post-build body producer, AST-free backend-plan projection/consumer call, and
  resulting report/receipt joins. Preserve its existing selection and from-AST
  producer policies.
- `src/ir/analysis/linear-memory-plan.ts`: preparation-fact extraction and the
  frozen-input layout entry, with focused tests; `src/ir/alloc-registry.ts` only
  for an owned read-only provenance/metadata snapshot if required. Existing
  `lower.ts`, emitters, effect analyses and immutable-copy helpers are reused,
  not redesigned.
- The new issue test, directly affected linear/allocation tests and this issue's
  implementation record. Any additional production file requires a concrete
  source-driven dependency review before widening ownership.

No writes to `ir/integration.ts`, `codegen/index.ts`,
`codegen/ir-prepared-free-functions.ts`, Program ABI/session/publication modules,
R5 ordered-init transactions, R4 storage producers, #4617 D1a files, or the
compiler's backend branch in this phase. Root rechecks live claims/open PRs
before creating the implementation worktree. Preserve concurrent changes.

Required commands, using the implementer's fresh isolated worktree:

```sh
pnpm typecheck
node node_modules/vitest/dist/cli.js run tests/issue-3528-frozen-body-handoff.test.ts tests/linear-ir.test.ts tests/issue-3520-linear-owner-identity.test.ts tests/issue-4550-linear-ir-census.test.ts tests/issue-3518-linear-counted-string-reservation.test.ts tests/issue-3922-linear-string-repeat.test.ts tests/issue-3526-ir-linear-math-intrinsics.test.ts tests/backend-contract.test.ts
node node_modules/vitest/dist/cli.js run tests/linear-array.test.ts tests/linear-string.test.ts tests/linear-functions.test.ts tests/linear-controlflow.test.ts tests/ir/alloc-registry.test.ts tests/ir/alloc-provenance.test.ts
node --import tsx scripts/check-linear-ir.ts
node --import tsx scripts/check-ir-only.ts --json
node --import tsx scripts/check-ir-fallbacks.ts
```

Also run the new focused allocation-fact tests and the repository's applicable
IR layering/kind/dialect checks for the actual changed modules. Record command
exits, source refs and complete output denominators; do not edit baselines to
hide new rejection, direct-emission, post-claim or instrumentation failures.
No pass count is asserted by this plan.

### What remains after L0-P1

The next dependent step must separate the recorded target-dependent builder
choices into semantic operations and explicit backend policy, then move the
single producer above `compiler.ts`'s backend branch and make WasmGC production
consume the same object. R2/R5 must supply reconciled whole-program semantic
ABI, source/init ownership and atomic publication there; R6 supplies complete
runtime intents and R7 the same immutable async plans. Only that cutover can
remove linear's independent selector/from-AST fixed point, followed by its
multi-source direct frontend and the full R8 retirement gate. All R8 acceptance
boxes and full #3518 retirement acceptance remain open after this prerequisite.
