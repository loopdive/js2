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
loc-budget-allow:
  # L0-P1's production capture/consumer seam is explicitly owned here; the
  # driver grows only for the required frozen handoff and remains bounded.
  # 2026-09-05 Astra repair: preserve existing string evidence and close
  # unsupported owners/callers before capture; no new runtime capability.
  - src/ir/backend/linear-integration.ts
func-budget-allow:
  # The same bounded handoff is assembled at the existing linear entrypoint;
  # keep its allowance scoped to that one production function.
  # 2026-09-05: capability refusals must reconcile the exact batch here.
  - src/ir/backend/linear-integration.ts::compileLinearIrFunctions
---

# #3528 — IR-only R8: linear consumes the shared Prepared IR program

## Execution amendment — 2026-09-05

Complete the active pre-emission encoding/acceptance repair, then execute
package C of the approved
[whole-program cutover plan](3518-ir-only-default-and-direct-frontend-retirement.md#current-execution-plan--whole-program-cutover-2026-09-05).
Consume package A's production-authoritative program in both backends and own
the lossless codec/replay implementation against A's schema. Begin implementation
after the shared interface is available and a worker slot is free; backend read
inventory can start earlier. Shared compiler entry-point edits belong to A.
Prove a real whole program with startup and cross-unit calls survives fresh-process
replay without source/checker access. The current captured scalar body remains
useful evidence but does not satisfy whole-program replay. Backend capability
gaps must precede artifact emission and remain reported as incomplete coverage.
Full R8 and epic acceptance are unchanged; this amendment creates no new claim.

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

### Implementation Record — 2026-09-05 — L0-P1 immutable body handoff

Implemented the L0-P1 production boundary in `src/ir/backend/linear-integration.ts`.
After `prepareLinearIntrinsicFunctions` and `prepareLinearStringRepeatFunctions`,
the linear producer now captures the exact built `IrModule`, owner census,
runtime manifest/provider projection, counted-string receipt projection, effect
facts and detached allocation facts in an authenticated `FrozenIrBodyBatch`.
`planLinearMemoryFromFrozenFacts` consumes the captured allocation evidence and
performs only backend layout/policy work. Each accepted linear owner is lowered
through `consumeFrozenIrBodyBatch` with an authenticated backend/session join and
physical-signature evidence; accepted lowering failures are terminal invariants
and cannot fall through to direct emission. The same immutable batch is exercised
with both the existing `LinearEmitter` and `WasmGcEmitter` in the common-input
test; normal WasmGC production remains outside this slice.

The batch factory in `src/ir/frozen-body-batch.ts` verifies every executable
function before ownership publication, owns nested IR/maps/sets/provider data,
preserves optional fields and explicitly branded recursive shapes, records
ordered `effectsOf` facts, and computes a deterministic digest over the owned
graph with undefined/null/numeric-edge values and recursive identity preserved.
`src/ir/backend/frozen-body-consumer.ts` validates exact owner sets, backend
legality, physical slots and session identity before lowering any body. The
allocation registry snapshot and `verifyLinearPreparedAllocationFacts` retain
live/aliased/retired provenance, explicit metadata presence, canonical site
structure and exact body/fact joins; unknown, retired, cyclic, missing, extra or
falsified evidence is rejected before layout.

Validation was run in the implementation worktree at base
`485c73e72adc49be115d99de2cd4c0394f7d0fd0`:

- `pnpm run typecheck`: exit 0.
- `tests/issue-3528-frozen-body-handoff.test.ts` plus
  `tests/ir/alloc-registry.test.ts`: 2 files, 20 tests passed. This includes
  one real linear production capture, same-object dual-consumer execution,
  two-function loop/branch/mutable-slot/`math.imul` graph execution, ordered
  imported-call execution in both emitters, immutable mutation controls,
  malformed body rejection, recursive-shape/digest recapture, exact selected
  `math.abs` provider/attachment and missing-manifest controls, complete
  allocation-fact corruption controls, and a nonempty late-lowering failure
  whose retry is rejected after the first accepted attempt.
- Required IR/linear group 1: 8 files, 55 tests passed. Required linear and
  allocation group 2: 6 files, 66 tests passed.
- `node --import tsx scripts/check-linear-ir.ts`: exit 0, 13 files measured,
  10 compiled, buckets `select:async-function=4`,
  `select:body-shape-rejected=24`, `select:call-graph-closure=11`.
- `node --import tsx scripts/check-ir-only.ts --json`: exit 0; single-host and
  standalone lanes each reported 5 entries, 41 terminal units, 38 IR bodies,
  zero unsupported/invariant/legacy bodies, and three non-executable units.
- `node --import tsx scripts/check-ir-fallbacks.ts`: exit 0; no unintended,
  module-level or post-claim increases; deferred
  `string-builder-candidate` remained 2 versus baseline 2.
- `pnpm run check:ir-dialect`, `pnpm run check:ir-kind-neutrality`,
  `pnpm run check:ir-layering`, targeted Prettier, `pnpm run lint`, and
  `git diff --check`: exit 0. The layering ratchet remained 86 import lines
  across 15 files, equal to baseline.

After the ordinary signed merge `843a6e960836c92fc544c0fd66ad028dc45908ab`
of upstream `origin/main` `b67ab1fc0eb2bafe959c3100df6e68d03325ce4f`, the
focused handoff suite remained 2 files/20 tests green; typecheck, scoped LOC
and function budgets, dialect/kind/layering gates, targeted Prettier and lint
also remained green. Direct post-merge ratchets remained green with the same
13-file/10-compiled linear census, 5-entry/41-terminal/38-IR-body counts per
`check-ir-only` lane, and zero unsupported/invariant/legacy bodies; fallback
counts stayed unchanged with deferred `string-builder-candidate` at 2.

The branch was then advanced by the ordinary signed merge
`1b09760a21473e1f1246a50be51cef2f59f2c1cf` of upstream
`39e4a13b94273dc9074e5b45e9a4cec661605ef0` (PR #5613, no owned-file overlap);
the final-head focused rerun remained 2 files/20 tests green, with typecheck,
budgets, lint, formatting and `git diff --check` also green.

The frontmatter contains one scoped `loc-budget-allow` for
`src/ir/backend/linear-integration.ts`, which the ratchet measured as
`1936 → 2255 (+319)` for this plan's explicitly owned production capture,
consumer seam, diagnostics, and resource preflight, and one scoped
`func-budget-allow` for its existing
`compileLinearIrFunctions` entrypoint (`549` lines versus the `419` baseline).
No oracle allowance or baseline-file update was made.

The repository-wide `node scripts/check-issue-ids.mjs` helper could not run in
this worktree because it resolves the space-containing path as
`/Volumes/Archiv%20Mini/.../plan/issues` (ENOENT); no issue-id result is inferred
from that failed helper. No full local Test262 run was attempted. The slice
does not claim backend-neutral frontend preparation, normal WasmGC production
routing, one source build per owner, whole-program ABI/session publication,
async-plan cutover, or R8 completion; remaining loops, handlers, containers and
WASI work stay explicitly outside this increment.

### Implementation Record — 2026-09-05 — linear preclaim diagnostics and resource preflight

The follow-up audit closed two concrete observability/resource gaps at the
linear producer boundary. A post-claim `IrUnsupportedError` is now retained on
`LinearIrRejection.outcome` with its typed `kind`, `code`, and `stage`, and the
same rejection carries the exact inventory-backed `sourceId`, `sourceKey`,
`unitId`, source filename, line, and column. Selector bucket records retain
their existing shape; typed build demotions expose the additional diagnostic
projection. The source `const [a, b, c] = [1, 2, 3]` control remains a real
unsupported carrier: it reports `array-representation-unsupported` at build,
has no built owner in the frozen batch, and reaches no consumer/lowerer.

`collectLinearBackendResourceDemand` and
`validateLinearBackendResourceDemand` now run after the immutable memory plan
is bound and before the first authenticated body consumer. The demand includes
runtime helper names, symbolic operation bindings, allocation sites, layout
IDs, and data-segment IDs. The existing linear operation map is reused,
including vector `grow` through the checked `__arr_set` helper. Missing helper,
unmapped operation, allocation, layout, or data segment is a typed
`selection-preparation-mismatch` invariant before body emission. The check
keeps data segments and static globals relocatable: it proves symbolic
availability and does not require final addresses or global indices.

Focused validation after this repair: `tests/issue-3528-frozen-body-handoff.test.ts`
passed 12/12, including the supported nonempty production batch, typed
unsupported/location control, real production vector allocation, missing
`__arr_new` control, missing-layout control, an ASCII string/data-segment
control, and the relocatable-data assertion.
`tests/issue-3501-empty-array-element-inference.test.ts` passed 9/9 runnable
tests (2 native tests skipped) after its build-rejection assertions were made
metadata-tolerant. The prescribed R8 group 1 passed 8/8 files and 58/58 tests;
group 2 passed 6/6 files and 66/66 tests. Typecheck, lint, targeted Prettier,
and `git diff --check` passed. The broader six-file adjacency run was 48
passed, 8 failed, 2 skipped; the failures are existing-head residuals outside
this repair (existing vector selector claims, UTF-16/non-ASCII linear-string
post-claim lowering, and synthetic global fixtures), so no baseline or fallback
threshold was changed.

The remaining resource boundary is intentionally explicit: resolver callable,
global, and type lookups that are not represented by the linear helper/layout
demand remain governed by the authenticated consumer and lowerer. A future
backend-neutral preparation slice must settle those authorities before moving
the producer above the backend branch. This record does not claim normal GC
cutover, full resource neutrality, or R8 completion.


## Implementation Plan — 2026-09-05 — Astra linear CI integration repair

The existing R8 PR's exact `linear-tests` run at source
`a2809ce8f0908b953b98513c9e06461f93448983` completed 241/243 tests in
25 files. Its two failures are `linear-advanced.test.ts` — "compiles template
literals with number" — and `linear-string-data-layout.test.ts` — "keeps
literals clear of the Ryū tables when the number formatter is linked".
Both enter the frozen backend consumer with an accepted owner and then fail
because `string.len` lacks the ASCII encoding evidence demanded by
`bindLinearStringRuntime`. This is an existing handoff/CI blocker within
L0-P1 consolidation; it does not authorize a new string feature or broad
retirement. Root's exact job log is retained as
`.tmp/ir-completion-20260905/r8-linear-tests-failure.log` in the integration
checkout (job `101332370811`, run `33975844766`).

1. Reproduce both exact failures on the repaired local candidate before
   changing source. Pair the enabled linear overlay with the direct
   `JS2WASM_LINEAR_IR=0` control on identical fixtures in fresh processes;
   preserve native value assertions and report exact test denominators.
   If a later candidate already fixes them, identify the actual changed
   bytes instead of adding another repair.
2. Trace the string encoding evidence from built IR through intrinsic/string
   preparation, allocation facts, memory planning, frozen capture, and the
   emitter's shared string-runtime binding. Determine whether valid evidence
   was dropped or the body was accepted without a supported representation.
   Do not infer ASCII from a string type, function name, or success in the
   legacy backend; do not run a speculative body lower to obtain proof.
3. Preserve valid evidence when already available. Otherwise classify the
   known unsupported string operation before frozen acceptance and before
   the first emitter callback, retaining typed source/unit/stage diagnostics.
   Reconcile owner/provider/allocation/call-dependency vectors after a
   declined owner so the retained batch remains exact. Already promised
   counted-string owners and post-acceptance contradictions stay fatal.
4. Reuse the actual shared runtime's capability/encoding contract in the
   narrowest preparation boundary. Keep legitimate relocatable data valid,
   and preserve resource and provider preflight. Do not relax the emitter,
   enable ASCII without proof, skip either existing test, rewrite baselines,
   or broaden generic lowering recovery after frozen acceptance.
5. Add a production refusal control with zero accepted/emitted prefix, an
   exact supported ASCII positive that remains owned, and any dependency
   closure control required by the changed join. Run the two former CI
   failures, the complete 25-file linear CI cohort, the frozen-body/allocator
   controls, and relevant typecheck/format/budget gates. Attribute any
   remaining failures to measured controls rather than "existing" totals.
6. Keep source ownership in the existing R8 worktree: linear integration and
   its focused tests/issue. Inspect consumers before changing shared string
   analysis/legality helpers; avoid unrelated R4 storage and bench-string
   work. Keep `f2593aa2` as an ancestor, commit a signed clean local repair
   with normal hooks, and leave publication to parent integration review.

### Implementation Record — 2026-09-05 — Astra linear string capability repair

Work continued in the same R8 checkout from signed
`f2593aa20797e5a2f8d06a2eb399d5ff8d2ee76a`. Before source edits, the exact
two-file CI population reproduced 16/18 passing tests and both recorded
post-acceptance ASCII failures (`.tmp/astra-r8-exact-before.log`). The direct
control retained from the same head is deliberately mixed: advanced 8/8,
string-data-layout 1/10, with nine independent direct `.charCodeAt()` refusals
(`.tmp/r8-linear-ci-direct.log`). It is not evidence of full direct-path parity.

The source-derived trace (`.tmp/astra-r8-string-boundary-before.log`) separates
the mechanisms. The test called "template literals with number" actually
builds the ASCII expression `hello ${name}`, where `name` is `"world"`. Its
concat allocation already has ASCII encoding evidence, but the exact SSA
length read lacked `inputEncoding`. The number formatter's allocation has
only conservative `wtf16` evidence; no audited ASCII origin exists in this
pipeline for that call.

The linear producer now preserves existing allocation evidence on missing
SSA length-read annotations and validates the shared runtime's exact encoding
contract before capture. Only `LinearStringEncodingUnsupportedError` can
produce a typed `string-evidence-unsupported` outcome at `resolve`, retaining
the original diagnostic and exact source/unit location. Missing allocation or
layout resources, provider contradictions, and any post-acceptance error remain
fatal. Already promised counted-string owners also remain fatal at this earlier
boundary. The runtime's ASCII requirements are unchanged.

The only shared production change is in `analysis/linear-string-runtime.ts`.
Its readers were enumerated before the change: the linear resolver and the
Porffor assembler/sink, plus the focused string-contract tests. Its pure
`validateLinearStringRuntimeEncoding` function is used by both the real binder
and preparation over detached allocation facts. Preparation does not construct
a provisional memory plan or invoke the caller's allocation policy. Review
first exposed a double policy call: the counting control observed `[0,1,0]`
for retained site 0 and declined site 1. The final implementation observes only
`[0]` (`.tmp/astra-r8-policy-before.log`, `.tmp/astra-r8-focused-final.log`).

Encoding, ownership, escape, and stack-candidate analyses still run once.
Their provider-field readers were checked: none reads the attached provider
fields. For this linear path, `attachProvidersToBuffer` in
`intrinsic-support.ts` only copies `intrinsic.provider`; the supplied
`attachIrStringSupport` callbacks add no storage or length carrier and only
attach the exact string callable providers. These transformations preserve
instruction kinds, allocation IDs, operands, and encoding evidence. The final
batch validates allocation/body joins after those attachments.

Refusals close transitively over structurally bound source callers. Intrinsic
providers and their manifest are prepared from the retained functions only;
live allocation facts are projected to their exact retained instruction IDs.
The registry snapshot retains its historical audit entries, while executable
facts, signatures, owners, and the final memory plan contain only the retained
population. Build-stage refusals also enter the frozen owner census as
rejected. This keeps the Ryū test's literal/checksum owners in IR while its
unproven formatter uses its existing direct body.

Production controls cover a zero accepted/emitted prefix with an independently
passing emitter/provider control, supported ASCII template and character reads,
two levels of declined callers beside an owned ASCII/Math function, the fatal
counted-string promise, and exactly one caller-policy decision per retained
allocation. The provider-refusal fixture also compares its existing direct
`Math.floor` error with `JS2WASM_LINEAR_IR=0`; that separate direct limitation is
not claimed as repaired. The Porffor non-ASCII check now uses an explicit input
graph because a refused production owner is correctly absent from the batch.

Validation in this checkout is recorded in `.tmp/astra-r8-*.log`. The final
focused group passed 41/41 tests in four files: frozen-body 17, string-contract
7, allocation registry 10, allocation provenance 7. The complete linear CI
cohort passed 243/243 tests in 25 files, including both original failures
(`.tmp/astra-r8-linear-ci-final.log`). The final R8 group 1 passed 63/63 in
eight files (`.tmp/astra-r8-group1-policy-final.log`). Group 2's six required
files passed 66/66 across the final CI and focused runs. These populations
overlap and are not combined into an inflated unique-test total.

Typecheck and the linear ratchet passed; the ratchet measured 13 files,
10 compiled functions, and the unchanged rejection buckets. IR-only checks
passed 5/5 entries in each of the single-host and standalone lanes: 41 terminal
units, 38 emitted, three non-executable, and zero unsupported, invariant, or
legacy outcomes per lane. The fallback gate reported no unintended,
post-claim, or module-level increases. LOC, function-size, oracle, coercion,
dead-export, layering, instruction-kind, dialect, lint, formatting, and
`git diff --check` gates passed on the final source.

The newest-main LOC comparison against
`b1537bbeca3858faf45fd89eff5506d21d1e230f` reports inherited growth outside this
repair: `closure-exports.ts` +98, `calls-closures.ts` +3, and
`nested-declarations.ts` +3. These exact differences already exist at `f2593aa2`;
the repair has zero changed lines in those files and adds no allowances for
them. The ordinary local LOC/function gates pass using this issue's existing
bounded allowance. The coercion and dead-export scripts mishandle the space in
this checkout's path; their successful controls use a symlink to this exact
checkout with Node's preserve-symlinks flags, without editing either gate or
creating another checkout. No result is inferred from the original encoded-path
failure or the coercion script's misleading whole-tree result.

This repair resolves the recorded linear CI blocker. It does not claim R8
completion, normal WasmGC production routing, or completion of the remaining
callable/global/type resolver joins. Publication and integration remain with
the parent; no source branch or public ref was pushed.

### Additional Hook Repair Plan — 2026-09-05 — memory-plan controls

Normal commit hooks passed formatting, lint, and budgets, then stopped at
`tests/issue-3298.test.ts`: two of five tests passed, and three failed
(`.tmp/astra-r8-commit-final.log`). Two synthetic `global.set` instructions
lack the semantic `target.binding` required by the current memory planner.
The UTF-8 control expects an executable allocation from a production owner
that preparation now correctly declines. Parent independently reproduced
three failures on its integrated, unchanged `f2593aa2` source and explicitly
assigned this directly related test file to the same repair lane.

Before changing the tests, inspect their current and base fixtures and the
global identity contract. Give synthetic global operations real semantic
bindings, preserving assertions about the exact stored identity. Keep the
production non-ASCII refusal assertion and move the canonical UTF-8 data
assertions to an independently built IR graph with its own real allocation
registry. Preserve exact bytes and the ASCII runtime requirement. Then run
the repaired memory-plan controls and affected string/frozen controls before
retrying the normal signed commit hooks; no gate bypass or new string feature
is authorized.

The source comparison confirms the two global-fixture failures are inherited:
`b1537bbeca3858faf45fd89eff5506d21d1e230f` already has the name-only
`savedLabel` write and the planner's required `target.binding.bindingId` read.
The repaired fixture uses `irModuleGlobalRef` and compares the exact semantic
binding ID while excluding its adapter label as the storage key. The UTF-8
control separately checks a production typed refusal with no live allocation,
an independent builder/registry plan's exact `[104, 195, 169]` bytes, the real
binder's unchanged ASCII refusal on that plan, and the production direct body's
native result `2`.

The repaired hook/identity population passed five files: 46 tests passed and
two existing conditional tests were skipped out of 48
(`.tmp/astra-r8-hook-controls-final.log`). This includes all five memory-plan
controls, all 17 frozen-body controls, seven string-contract controls, eight
global/type-binding controls, and nine passing empty-array controls. Only
the memory-plan test and this issue record changed after the earlier final
source validation; the reviewed production source is unchanged.

## Implementation Record — 2026-09-06 — package C: codec, shared consumer, fresh-process replay (Claude)

Claim `3518:backend-consumption-replay`, owner
`ttraenkler/claude-fable-ir-backend-c-20260906`, branch
`claude/3518-whole-program-c-20260906`, base `8e89954c` (A's typed handoff).
Package A's `PreparedIrProgram` (`prepared-ir-program-v1`) is the only schema;
nothing here defines a second ledger, cache or admission path.

### What landed

- `src/ir/program-codec.ts` — `encodePreparedIrProgram` / `decodePreparedIrProgram`
  / `assertPreparedIrProgramShape` / `digestEncodedPreparedIrProgram`. The codec
  encodes exactly the prepared-data model `freezePreparedIrValue` accepts and
  decodes by handing the rebuilt value back to that same copier, so "prepared
  data" has one definition. Canonical bytes: sorted keys, single-key tags for
  every non-JSON value (`$bigint`, `$number` for `-0`/`NaN`/`±Infinity`,
  `$undefined`, `$map`, `$set`, `$irClassShapeCell`, `$classShapeRef`), `$`-keys
  escaped as `$$`. Re-encoding a decoded program is byte-identical. Recursive
  class shapes close onto the same decoded object; any other cycle, executable
  value, foreign instance, unknown tag, non-canonical order or `-0` literal is
  refused with `PreparedIrProgramInvariantError("invalid-prepared-data")`.
- `src/ir/backend/program-consumer.ts` — `consumePreparedIrProgram({program,
  backend, factories})`, the one consumer both backends call with the SAME
  decoded object. Order: shape → `verifyIrFunction` per body against the
  program's declarations → unit/support/global references must close inside the
  program ABI → `verifyIrBackendLegality` per body → lower every body via the
  existing `lowerIrFunctionBody`, all-or-nothing. A backend capability gap is a
  typed `unsupported` (stage `backend-legality`, owner-located through A's
  `preparedIrProgramOwner`); a contradiction or an accepted body that fails to
  lower is a typed `invariant`. Nothing is emitted on any failure.
- `scripts/ir-whole-program-replay.mjs` — fresh-process replay: decodes the
  bytes, consumes for `wasmgc` and `linear`, assembles/instantiates each module,
  and records every module the process resolved through a `node:module`
  `register()` hook. Reports frontend modules (`src/ir/from-ast`, `src/compiler`,
  `src/checker/`, `src/index`, `src/codegen/index`) and TypeScript-library
  modules separately.
- `tests/helpers/ir-whole-program-codec-fixture.ts`,
  `tests/helpers/ir-whole-program-replay.ts`,
  `tests/issue-3518-program-codec-replay.test.ts` — hand-assembled complete
  program (4 bodies incl. a cross-unit call, i64 bigint const, `-0`/`Infinity`
  consts, a recursive class shape in the ABI, a `ReadonlyMap`, a
  present-but-undefined key, one startup plan), 9 tests.

### Measured (2026-09-06, this worktree, vitest single file)

- 9/9 tests pass. Both backends lower the identical decoded object and match the
  native oracle: `main()=42`, `helper(21)=42`, `big()=9007199254740993n`,
  `special()=Infinity`.
- Negative controls with `emitters===0` (nothing reached emission): call to a
  body absent from the program → `invariant/resolve/unknown-function-ref`;
  declared-result contradiction → `invariant/verify/verifier-failure`; support
  binding not planned in the ABI → `invariant/resolve/unknown-function-ref`.
  Codec refusals: 14 distinct malformed/non-canonical inputs.
- Fresh-process replay child: decode + byte-identical re-encode, both backends
  ran with oracle-equal results, **92 modules loaded, 0 frontend modules,
  5 TypeScript-library modules**. The TS library arrives through a transitive
  VALUE import (`src/ir/identity.ts` calls `ts.isImportDeclaration` etc. at
  runtime; `module-init-plan.ts` likewise) — reported as a measured fact, not
  asserted, and referred to A (see interface requests below).
- Gates: LOC/function budgets OK (no growth in owned budget files), coercion
  OK, oracle-ratchet OK, prettier/biome clean on the new files. `check:dead-exports`
  crashes on this machine's space-containing checkout path (`%20` in
  `audit-legacy-reachability.mjs` ROOT); run via a space-free symlink it reports
  ONE pre-existing dead export, `src/codegen/program-abi-module-init-planning.ts#directCallTargets`,
  introduced by the P2A merge (`2d8e449d`), not by this package.

### Not yet done (package C remaining scope)

- `compileLinearIrFunctions` still builds its own `FrozenIrBodyBatch`; routing
  the linear entry onto `consumePreparedIrProgram` needs A's strict producer to
  hand a `PreparedIrProgram` to the linear driver (today the linear frontend
  prepares its own overlay from source). Planned next once A's driver exists.
- WasmGC wiring (`src/ir/integration.ts`, `src/codegen/index.ts`) is A's file
  scope; C provides the consumer API and requests the call.
- Runtime projections (`program.runtime[]`, B's manifest/async producers) are
  encoded as data but no fixture with a projection exists until B lands; the
  consumer's only projection rule so far is "async body without a projection for
  this backend ⇒ unsupported before emission".
- The seven-unit application fixture (D) has not been pushed through this path;
  the codec evidence above is on a synthetic complete program built from A's
  types, not on A's driver output.

### Implementation Record — 2026-09-06 — package C increment 2: reviewed corrections, accept/emit contract, re-authentication (Claude)

Base: signed integration dependency `7b2e8b03` merged into the C branch (merge
`ad1d205c`); first increment `5dd03b8e` preserved. Root's independent codec
controls (`c-codec-independent-controls.json`) and D's container probe
(`c-codec-container-probe-v2`) are all addressed and pinned as tests.

**Codec (`src/ir/program-codec.ts`).** The accepted data domain is now stated
and enforced: it is exactly what A's `freezePreparedIrValue` accepts and
preserves. Fixes for the five reviewed cases: (1) leading/trailing whitespace,
(2) duplicate keys, and every other non-canonical serialization are refused by
the acceptance rule `encode(decode(text)) === text` (no second parser, first
differing byte reported); (3) own `__proto__` data properties survive
(records are built with `Object.create(null)` + `defineProperty`, encoder
reads descriptors); (4) integer-like keys are written by the codec's own
serializer in UTF-16 code-unit order — `JSON.stringify` key order is no longer
used anywhere; (5) array holes, present `undefined` and present `null` are
three distinct spellings (`{"$hole":true}` is legal only as an array element).
`decodePreparedIrProgramData` returns persisted claims verbatim (unauthenticated);
`decodePreparedIrProgram` regenerates every persisted backend/target projection
through the pure `prepareWholeProgramRuntimeManifest`, refuses any
`preparedIrDataMismatch` against the persisted runtime data, freezes the
regenerated joins in place (restoring the WeakMap plan/manifest authority that
clones cannot carry) and runs A's complete `assertPreparedIrProgram`. Old
`preparedIrProgramAbiLookup(program.abi)` calls are gone; the draft lookup is
used only for regeneration input.

**Consumer (`src/ir/backend/program-consumer.ts`).** `acceptPreparedIrProgram(program, options)`
→ `PreparedIrBackendAcceptance` and `emitAcceptedIrProgram(accepted, plan)` →
`EmittedPreparedIrProgram`, on A's signed types (`PreparedIrBackendOptions`
with backend/target/sharedExceptionTag/utf8Storage/sourceMap/moduleName and the
optional linear data projection). Acceptance: A's validator → exact
backend/target projection (missing ⇒ located `unsupported`, `sourceFile`
retained) → unit-body closure on the projection's PHYSICAL functions → per-body
`verifyIrBackendLegality` (gap ⇒ located `unsupported`). Acceptances are
authenticated by a module-private WeakSet; a structurally forged or cloned
acceptance and a second emission both fail with `invalid-transaction-capability`.
Emission lowers every physical body all-or-nothing, calls the plan's
`reserveSharedExceptionTag` before lowering when requested (missing hook ⇒
`emission-failed` before any emitter exists), assembles via the backend's
physical plan and returns exact `emittedUnitIds`. Observations `accepted` /
`emission-started` / `emitted` are raised through A's `observePreparedIrProgram`
from the consumer — A may relocate these calls into its public wrapper.

**Replay runner (`scripts/ir-whole-program-replay.mjs`).** Consumes the
program's declared exports against a separately pinned oracle file, replays
every requested backend/target from the same decoded object, prints a nonempty
module census, and fails closed (exit 1) on decode/canonicality failure, any
not-accepted target, any physical-plan gap, any oracle mismatch, receipt/
projection count mismatch, or any TypeScript / source-frontend / compiler /
producer module load.

**Measured (2026-09-06, vitest single file, load1 < 8 gate).** 19/19:
- synthetic complete fixture (now passes A's validator: exact
  `irUnitCallableBindingId`, class layout entry, allocation snapshot, one
  regenerated projection per backend): byte-identical re-encode AND
  `preparedIrDataMismatch === undefined`; both backends emit 4/4 bodies,
  8 emitters for 8 physical bodies, oracle `main=42, helper(21)=42,
  big=9007199254740993n, special=Infinity` on wasmgc:host and linear:host.
- 20 codec refusals incl. the five reviewed cases; 4 data-model probes.
- re-authentication refusals: tampered manifest feature, dropped physical body.
- 5 consumer negatives, each with 0 emitters: missing projection (located,
  `sourceFile`), forged acceptance, cloned acceptance, second emission,
  unreservable shared exception tag; plus linear options on wasmgc refused.
- A-produced common backend subset (`math.ts`/`entry.ts`, 2 sources): prepared
  by `prepareWholeIrProgram`, codec-identical, mismatch-free, runs on BOTH
  backends through the codec (`main()=42`).
- A-produced original mixed application (exact D sources, digest
  `236fa7d9…` reproduced by recipe `json`): 7 terminals, codec-identical,
  mismatch-free, **wasmgc:host accepted**; requesting a linear projection at
  preparation is a located `unsupported` (`promise.capability.create has no
  linear adapter` @ entry.ts) and linear:host acceptance is `unsupported` (no
  projection) — recorded as incomplete coverage. Emission through the scalar-
  subset plan reports gaps (`executable startup unit`, `runtime providers`)
  instead of a smaller module — the full physical plan (globals, imports,
  providers, startup, exception tag) is the next C step and depends on A's
  `registry/physical-imports.ts` extraction.
- fresh-process replay: both targets ran, 4/4 receipts, **0 TypeScript, 0
  frontend modules** (A's pure identity split removed the earlier 5); fail-closed
  controls: non-canonical byte ⇒ exit 1 with decode failure; oracle mismatch ⇒
  exit 1.
- typecheck 0 errors; LOC/function/coercion/oracle gates OK; prettier/biome
  clean. `check:dead-exports` (via space-free symlink) still reports only the
  pre-existing `directCallTargets`, owned by root's audit fix.

**Still open for C.** Full physical plan for the mixed application (A's
physical-imports dependency); routing `compileLinearIrFunctions` onto
`acceptPreparedIrProgram`/`emitAcceptedIrProgram` (needs a
`PreparedIrProgram` handed to the linear driver by A's wrapper); D's
independent runner remains under review and is not used as evidence here.

### Implementation Record — 2026-09-06 — package C increment 3: internal physical setup, one-argument emission, fail-closed replay (Claude)

Dependency: signed `2e68ccfe` merged as `bc6f4604` (attributed merge; the
earlier merge `ad1d205c` of `7b2e8b03` carried git's default message — its
author is Thomas Tränkler, produced by Claude Fable 5.1 Default, recorded here
rather than by rewriting shared history). Increments 1–2 preserved.

**Emission is one argument again and owns its physical setup.**
`emitAcceptedIrProgram(accepted)` (`src/ir/program-emission.ts`) reads the
physical plan acceptance derived and builds the module itself: reserves the
shared exception tag first (through A's `ensureExnTag` on the probe-style
source-free physical context), imported functions/globals (`addImport`),
defined numeric globals, one `WasmFunction` slot per physical body and the
startup adapter slot; freezes the index space; plans and seals A's
`ProgramAbiMap` over the program's own ABI entries and binds every required
binding to its reserved index (`finishBinding`); lowers every physical body
through the existing WasmGC/linear emitters into its slot, refusing any lowered
signature that contradicts the reserved ABI slot; materializes `wasm-start`
(start section) or `deferred-export` (`__module_init` export) from the startup
plans and the module exports from the ABI export aliases; and derives
`emittedUnitIds` from the functions actually present in the module. Root's
counterexample (four receipts over an assembler returning zero functions) is
no longer expressible: there is no caller-supplied resolver, assembler or
reservation. Emission lives outside `src/ir/backend/` because it needs the
codegen physical-import registry; it imports no frontend module.

**Acceptance includes the physical plan.** `src/ir/program-physical-plan.ts`
(pure, no backend/codegen imports) derives imports, globals, slots, exports and
startup from the ABI entries, startup plans and the selected projection, and
returns the first located `unsupported` for anything this increment cannot
materialize: non-scalar carriers, runtime/support callables and globals,
type/class layouts, host-callable/self-hosted provider intrinsics, async
bodies, WASI start, reference-typed global initializers, and linear allocation
plans. A gap is an acceptance failure; it can never become a smaller module.
Consequence for the original mixed application: wasmgc:host is now a located
`unsupported` at acceptance with exactly one gap (`async body run needs
scheduler/promise runtime materialization` @ entry.ts) instead of "accepted but
unemittable" — the honest state until the Promise/scheduler runtime is
materialized.

**Phase accounting.** C is the sole owner of `accepted` / `emission-started` /
`emitted`; they are raised once per acceptance from the consumer/emitter only
(`beginAcceptedIrProgramEmission` consumes the token; `emitted` is raised only
after the module and receipts exist). Pinned by a subscriber test.

**Replay runner.** Validates the oracle schema before touching the program
(nonempty unique targets over known backends, nonempty calls with export/args/
expected); per target requires acceptance, nonzero receipts equal to the
projection's physical functions AND to the module's owned functions, ≥1
checked row, all matched. The module census is a `node:module` resolve hook
appending `{url,parent}` synchronously to a file before each resolution
returns, so every loaded module is on disk before the import that loaded it
settles — read after the last await, no timer. `--probe-forbidden-import`
deliberately imports `src/ts-api.ts` after the replay and must fail closed.

**Measured (2026-09-06, vitest single file, load1 < 8 gate): 21/21.**
- synthetic complete fixture (4 bodies, ABI export aliases, no class entry):
  both backends emit 4/4 receipts = 4 module functions = 4 exports, 184 bytes,
  oracle `main=42, helper(21)=42, big=9007199254740993n, special=Infinity`;
  shared-tag request reserves `env.__exn` as import #0; forged/cloned
  acceptance and second emission refused; linear options on wasmgc refused;
  missing projection located with `sourceFile`.
- codec: 20 refusals incl. the five reviewed cases; 5 data-model probes (adds
  the recursive class-shape probe at data level); 2 re-authentication refusals.
- A-produced common backend subset (2 sources): codec-identical, mismatch-free,
  emitted and run on BOTH backends through internal emission (`main()=42`),
  `main` exported through the ABI alias.
- A-produced original mixed application (exact D sources, digest
  `236fa7d9…` = `sha256(JSON.stringify(files))`): 7 terminals,
  codec-identical, mismatch-free; wasmgc:host `unsupported` (1 physical gap,
  above); linear projection at preparation `unsupported` (no linear Promise
  adapter); linear:host acceptance `unsupported` (no projection). Incomplete
  coverage, recorded.
- fresh child replay: 167 modules loaded, 0 TypeScript, 0 frontend; both
  targets 4/4; fail-closed controls verified for non-canonical bytes (exit 1),
  oracle mismatch (exit 1), deliberate `ts-api` import (exit 1 with the module
  named), and six malformed/empty/duplicate oracle schemas (exit 2, no target
  touched).
- typecheck 0 errors; LOC/function/coercion/oracle gates OK; `check:dead-exports`
  OK on the spaced path (25 known, 0 new) after root's audit fix; prettier and
  biome clean.

**Not yet materializable (next C steps, dependencies named).** Promise/
scheduler and other runtime-callable providers, string/vec/object carriers and
type/class layouts, reference-typed globals, WASI start, linear memory plans:
each needs the corresponding runtime materialization (B/A) and the linear
memory plan; the mixed application and the three-source common fixture
(`594eaf3f…`, `__new_ReferenceError` pending with A) stay incomplete until
then. Routing `compileLinearIrFunctions` onto the consumer still needs A's
wrapper to hand a `PreparedIrProgram` to the linear driver.

### Correction plan — 2026-09-06 — package C increment 4 (recorded before the fixes)

Root reproduced seven defects against `999a6a42` (records:
`codex-3518-reference-error-runtime-20260906/.tmp/c-increment3-review/` and
`codex-3518-ir-integration-20260905/.tmp/ir-completion-20260905/c-increment3-physical-controls*`).
Dependency adopted first: signed `5c9fd95d` (A's canonical runtime callable
declarations, parent runtime leaf `b38d1ecf`, parent `2e68ccfe`) merged as
`ea64ff08`. Planned corrections, each with a paired positive/negative test:

1. The accepted physical plan is exposed deep-frozen (nested records and
   arrays); mutation cannot change emitted output. Acceptance keeps its own
   private copy.
2. Emission state transitions (`begin`/`finish`) become private to the single
   one-argument construction path: acceptance and emission move into one
   module (`src/ir/program-consumer.ts`); `src/ir/backend/program-consumer.ts`
   and `src/ir/program-emission.ts` are removed. `emitted` is raised only after
   successful construction, exactly once.
3. The replay oracle value domain is validated before replay: plain JSON
   number/boolean/string/null or an exact single-key `$bigint` (canonical
   decimal) / `$number` (`-0`, `NaN`, `Infinity`, `-Infinity`) tag; malformed
   values are schema refusals (exit 2), distinct from mismatches (exit 1).
   Positive NaN / -0 controls are added to the synthetic fixture.
4. Oracle targets are validated against the actual `RuntimeTarget` set
   (`host`, `strict-no-host`, `standalone`, `wasi`); unknown targets exit 2
   before the program is touched.
5. ABI export aliases are planned with their target index space; global
   exports are materialized (`export let answer = 42`); any other space is a
   located refusal at acceptance.
6. Exception resources are derived at planning (bodies containing `throw` /
   `try`): a local `__exn` tag, or the requested shared import; the resolver
   provides `ensureExnTag`. `export function fail(): void { throw null; }`
   must accept, emit and throw at runtime.
7. The startup adapter is identified by construction ownership, not by
   display name; a user body named `__module_init` replays.

Also: WasmGC options carry no own `linear` property unless supplied.

### Implementation Record — 2026-09-06 — package C increment 4: seven reproduced defects corrected (Claude)

All seven items of the correction plan above landed, each with paired
positive/negative regressions in `tests/issue-3518-program-codec-replay.test.ts`:

1. `planPhysicalSetup` returns the plan through `freezePreparedIrValue` (deep-
   frozen, null-prototype, nested arrays included); `acceptedPhysicalSetupPlan`
   exposes that same object. Root's retarget of `main` to `special` now throws
   `TypeError` in strict mode and `main()` stays 42.
2. Acceptance and emission live in one module, `src/ir/program-consumer.ts`
   (`src/ir/backend/program-consumer.ts` and `src/ir/program-emission.ts`
   removed). The public surface is exactly `acceptPreparedIrProgram`,
   `emitAcceptedIrProgram`, `isAuthenticAcceptedIrProgram`,
   `acceptedPhysicalSetupPlan`, `emittedStartupAdapterIndex`; begin/finish no
   longer exist. `emitted` is raised only after construction succeeded; a second
   `emitAcceptedIrProgram` throws before any observation (pinned: exactly
   `accepted, emission-started, emitted` per acceptance).
3. `oracleValueProblem` (shared by the runner and `compareExports`) enforces the
   exact value domain; `{}` and `{"$number":"not-a-number"}` are schema exit 2,
   distinct from a mismatch (exit 1). Positive NaN and -0 rows added to the
   synthetic fixture (now 6 bodies, 6 ABI export aliases).
4. Targets are validated against the actual `RuntimeTarget` set; `wasmgc:bogus`
   exits 2 without touching the program.
5. Export aliases are planned with their canonical target's index space and
   emitted as `func` or `global` exports; `export let answer: number = 42`
   accepts, emits (start section + global export) and reads 42 on both backends.
6. The plan derives `exceptionTag {required, shared}` from `throw`/`try` bodies
   and the options; emission reserves a local `__exn` tag or the shared import
   first and the resolver provides `ensureExnTag`. `export function fail(): void
   { throw null; }` accepts, emits and throws a `WebAssembly.Exception` under
   both tag modes.
7. The startup adapter is identified by constructed identity
   (`emittedStartupAdapterIndex`), never by name; a user body named
   `__module_init` replays in-process on both backends and in the child, with a
   real adapter present alongside it. A `deferred-export` adapter that would
   collide with a user `__module_init` export is a planning gap.

Also: WasmGC options carry no own `linear` key (`preparedIrDataMismatch` against
the input options is undefined).

**Measured (2026-09-06, vitest single file, load1 < 8): 27/27.** Synthetic
fixture: 6/6 receipts = 6 module functions = 6 exports on both backends, 8
oracle rows incl. NaN/-0. A-produced: two-source subset runs on both backends;
`answer` global, `fail` throw (local and shared tag), `__module_init` user body
each run on both backends; original mixed application still `unsupported` at
wasmgc:host acceptance with the one async gap, linear typed gaps unchanged.
Child replay: zero TypeScript/frontend modules; fail-closed controls for
non-canonical bytes, oracle mismatch, forbidden import, and ten schema
refusals. Typecheck 0; LOC/function/coercion/oracle/dead-exports gates OK;
prettier/biome clean. Dependency `5c9fd95d` merged as `ea64ff08` (attributed).
The three-source common fixture (`594eaf3f…`) and the full mixed application
remain incomplete: runtime-callable providers (`__new_ReferenceError` declared
by A, not yet physically materialized), scheduler/promise runtime, non-scalar
carriers and linear memory plans are the open C steps.
