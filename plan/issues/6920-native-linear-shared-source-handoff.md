---
id: 6920
title: "Native Linear numeric-vector shared source handoff and integration plan"
status: in-progress
sprint: current
created: 2026-10-08
updated: 2026-10-08
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: planning
area: ir
language_feature: arrays
goal: correctness
parent: 3518
assignee: "ttraenkler/codex-astra-native-linear-shared-handoff-plan-20261008"
---

# Native Linear numeric-vector shared source handoff and integration plan

## Decision and release status

Session A must supply one reviewed, coherently tested source dependency joining
its real public native caller, detached allocation facts, common geometry and
shared consumer dispatch. Session B then supplies its retained target memory
pack and providers against those actual interfaces. A plan, an uncalled module,
a legacy overlay result, a fabricated IR fixture or a missing capability renamed
as unsupported does not satisfy this handoff.

This issue is the complete planning deliverable, prepared by Codex GPT-6 Astra
High. It authorizes no production edits, runtime execution, commit or push.
Root retains integration, publication, runtime approval and protected queue
operations. The assigned writer owns only this new issue and its worktree's
private `.tmp/plan-evidence/`. All other agents' files and claim records remain
untouched. The implementation partitions below are requested releases, not
assertions that donors have acknowledged them.

Planning worktree: `/private/tmp/js2-ir-native-linear-shared-handoff-plan-20261008`,
branch `codex/native-linear-shared-handoff-plan-20261008`, exact canonical base
`8452732f0b88c14c5c7634ece58f83240970ea4c`. Atomic allocate-and-claim used
`CLAIM_ASSIGN_REMOTE=upstream`; effect read returned owner
`ttraenkler/codex-astra-native-linear-shared-handoff-plan-20261008`,
write `59431-3derzbyp`, status `in-progress`, reserved/claimed
`2026-10-08T19:25:16Z`, open-PR scan `ok`. Exact record was independently read
through GitHub Contents/base64 and verified against blob
`9485062084c9b46e50a28a93799e0a5672a442fd` before this issue was written.
No GitHub issue was created. No foreign claim was released or inferred expired.

## Observed evidence and published prerequisites

The following are evidence from the named earlier runs or read-only inspection;
none is a runtime result produced by this planning task.

| Operand | Exact evidence and actual status | What it permits |
| --- | --- | --- |
| Canonical compiler | `8452732f0b88c14c5c7634ece58f83240970ea4c` | Fixed source baseline; do not silently replace it with a moving main |
| A1 public caller | `/private/tmp/js2-ir-native-linear-public-caller-20261008/.tmp/a1/next49/runtime/terminal-receipt.json`: 49 registered/executed, 43 pass, 6 fail, zero skips; CLI/IPC/JSON identities agree | Genuine public scalar entry and negative controls, not complete native startup or vector delivery |
| A1 six failures | P02/P04 deferred standalone and P05–P08 WASI: `error.reference.construct has no linear adapter` | Preserve original source and assertions; real ReferenceError/TDZ dependency on S |
| A2 source facts | `/private/tmp/js2-ir-native-linear-source-facts-20261008`: 18 executed, 17 pass, 1 fail, zero skips | Genuine checker-produced f64 allocation and detached facts; no native physical allocation completion |
| A2 remaining failure | Original raw-surrogate source catalog with present-undefined encoding: `program allocations: site 0 has missing or stale encoding evidence` in old replay validator | Repair validation ordering/replay, keep fixture and presence bit |
| S startup | Root dispatch reports private 71/76, five failures, repairs active | Required sibling dependency; no tested source commit available yet |
| Recursive class DATA fix | PR6597, **fix(ir): inspect recursive class cells without invoking getters**, head `bec8ac003452a63e9a3fa6f8ff57d5f83e69a4af`; API read: open, unmerged | Source increment only. Root reports CI complete; independent review/main merge not established |
| Geometry publication | PR6596, **docs(ir): publish adopted B implementation handoff**, head `8c383ecd8305da61c27a49901d38dd8f31218d94`; API read: open, unmerged | Documentation only; no geometry source implementation |
| Adopted A geometry plan | `/private/tmp/js2-ir-linear-layout-contract-plan-20261008/implementation-plan.md`, SHA256 `f7af00c7d72841db0c9d541bbdcbc717fac4e4c3e5918ec33752e57b3c849266` | Complete geometry design, ownership and finite proof requirements; retained in full |
| Adopted A2 extraction addendum | `/private/tmp/js2-ir-native-linear-caller-plan-20261008/allocation-facts-clean-closure-addendum.md`, SHA256 `ed9ff5dc9ac24b2c266927dd40c74f57f7bad1888d5603f2ed6102a86af8098d`; bounded request `.tmp/a2-addendum/canonical-extraction-handoff.md` in A2 worktree | Exact canonical DATA/verifier/provenance recipe; provisional patch needs the documented ordering refinement |
| B published plan | PR6577, head `a40bee66df93e34870c810d16c12ebf3444c5889`, `plan/issues/6905-linear-prepared-memory-materialization.md`, title **Linear Prepared IR memory materialization and ownership handoff** | Genuine published plan and retained initializer work; shared-route resources still conditional |
| B plan byte readback | GitHub Contents/base64, verified blob `6864ce21a4964717ebad1a5105bb531360d21ec9`, SHA256 `40d7e010ed6833a285a1eed15f10389f35968e6ce3002a7fddefb3eb3c476203` | Lossless local planning input, including forwarding successor appendix |
| Public coordination | PR6583 comment6067351930; root advisory-hunk release comment6067224039 | Root-provided coordination references; separate B scope, no new source authority |

A1 G11 is one authored row with four sync/async × WASI defer subcells, not four
extra tests. A1's original46, original48 and both six-case oracle receipts remain
preserved. A2's 13 expanded addendum cases are planned and unexecuted, not a
passing denominator. Earlier three-control joined-graph getter checks were
1 pass/2 fail before screening and 3 pass after, with real getters held at zero;
those selected controls do not replace the full 18-row result.

There is currently **no exact, coherent, passing native vector source commit**
to give B. The API's synthetic `merge_commit_sha` on an open PR is not evidence
of a landed dependency. Root must populate the final dependency commit table
only after the concrete implementation, review and qualification below.

## Required behavior and first closed capability

Use the real exported public `compile` and `compileAsync` entrypoints with
explicit Linear backend and standalone/WASI target profiles. The unchanged
front-end must parse and check this runtime-input source:

```ts
export function run(a: number, b: number): number {
  const values = [a, b];
  return values[0] + values[1] + values.length;
}
```

Instantiate the actual returned Wasm and require `run(1.5, -2.25) === 1.25`.
The real retained source body must have one live f64 vector allocation joined
to its exact source owner, use the canonical array allocator and initializer,
and be observed through prepared → accepted → emission-started → emitted.
An answer obtained after constant folding away the allocation fails this case.
Execution is compared with independent JavaScript and retained direct Linear
controls under exactly recorded options. Compiler `compileAsync` is a public
API variant, not permission to admit async source bodies.

The first closed resource capability is default bump-arena, fixed f64 vectors,
scalar public parameters/results, numeric get/length and already-supported
numeric stores, with internal vector calls only if complete source admission,
ABI closure and carrier checks pass. It includes empty and multiple literals,
branch/early-return paths, source-order evaluation and memory identity within
an invocation. It does not silently expand to public array ABI, growth, dynamic
values, non-f64 vectors, closures, object/refcell allocation, stack arenas,
linked/imported/shared memories, custom allocators or new async semantics.
Every unsupported demand remains a located pre-reservation refusal. Existing
forwarding reads and headers remain correct even though growth is not admitted.

JS-host SOURCE/PROGRAM stays unsupported. Existing legacy paths remain until
full equivalence; this bounded native increment does not retire them. Existing
ReferenceError/TDZ/startup assertions remain mandatory, including the original
six failures. A `var`-only replacement fixture cannot satisfy those obligations.
Lossless surrogate storage/source binding, optimizer and source-map parity stay
explicitly open and require their own complete plans and tests.

## Architecture and complete executable flow

The source route remains:

`compile/compileAsync → compiler.ts::generateModule / runPreparedIrPipelinePresentation
→ compiler/native-linear-pipeline.ts::prepareNativeLinearPipeline
→ compiler/ir-program-presentation.ts::prepareIrProgramPresentation
→ compiler/ir-program-driver.ts::runIrProgramDriver
→ program-preparation.ts::prepareWholeIrProgram
→ program-source.ts::captureTypedIrProgramInput + prepareIrProgramSources
→ program-prepare-ir.ts::prepareTypedIrProgram
→ program-consumer.ts::acceptPreparedIrProgram
→ program-consumer.ts::emitAcceptedIrProgram`.

Use A1's actual source associations, normalized target policy and one-shot
`consumeNativeLinearPipeline`; do not add a second compile orchestrator.
Preparation owns checker/source analysis. Consumption owns validated detached
DATA and exact selected runtime bodies. The physical ledger owns indices and
resource lifecycle. B's target pack owns Linear representation/provider binding.
The common consumer owns the only acceptance and completion capabilities.

Folder placement is substantive:

- `src/ir/analysis/contracts/linear-allocation-facts.ts`: canonical fact DATA.
- `src/ir/analysis/linear-allocation-facts.ts`: one pure detached verifier.
- `src/ir/program/linear-allocation-facts.ts`: whole-program attachment/census gate.
- `src/shared/contracts/linear-memory-layout.ts`: zero-import canonical geometry,
  actively consumed by the old planner and B provider leaves.
- `src/ir/backend/` contracts: representation-neutral body-lowering contract and
  vector-handle union/narrowing, alongside existing emitter/resolver contracts.
- `src/backend/linear/program/`: accepted Linear resource DATA and planning;
  B's `memory.ts` owns plan/reserve/fill/completion and binding implementation.
- `src/codegen-linear/runtime/`: canonical reusable target body builders, called
  by retained direct builders and the ledger consumer; no copied algorithms.

Keep functions in cohesive existing subfolders and retain compatibility imports
where required. Do not land empty facades or move unrelated files solely to
increase a budget. Any new exported function must have the real callsites named
below in the same coherent source packet. Root registers actual module paths,
all-reference closure and floors; workers may not relax dependency directions.

## Implementation Plan

### A-F: finish canonical final allocation facts before selection

Owner: A2 after the named donor acknowledges its exact bounded request.

1. Relocate existing `LinearPreparedAllocationFact`,
   `LinearPreparedAllocationFacts` and `OwnershipMetadata` DATA to the new
   analysis/contracts leaf. Move `Ownership`, `EscapeClass`, `EscapeInfo` once
   to existing `analysis/contracts/allocations.ts`; their old owners import and
   type-reexport the same declarations. Preserve ownership/escape algorithms.
2. Relocate the existing canonical snapshot/index/metadata/equality/census and
   `verifyLinearPreparedAllocationFacts` implementation once to the pure leaf,
   with the exact function-identity compatibility exports required by the
   adopted addendum. Fix its one missing equality: own `fact.encoding` value
   must equal snapshot encoding evidence, in addition to presence checks.
   Delete the program helper's redundant encoding-equality implementation.
3. In `prepareTypedIrProgram`, produce final `linearAllocationFacts` only after
   final middle-end/runtime-support allocation analysis and before semantic
   freezing. Use `prepareLinearAllocationFacts(finalSource.ir, allocations)`
   once in preparation. The attached fact snapshot and `program.allocations`
   are the same final evidence. Reconcile each selected Linear runtime owner
   against the final semantic owner; include nested async-state bodies in the
   census. Allocating runtime support outside this first closed census gets a
   located unsupported result, never omission.
4. `program/validation.ts` and
   `program/allocations.ts::assertPreparedIrProgramAllocations` test own-property
   attachment presence before selecting a validation branch. Present-undefined
   is malformed, not absent. Call
   `assertPreparedIrProgramLinearAllocationFacts(program)` before reading
   `program.allocations` on the versioned branch. The strict gate screens the
   complete joined graph with descriptor-only access and existing
   `freezePreparedIrRuntimeValue(program)` before nested iteration/readers.
   Getters or foreign iterators execute zero times.
5. Add only structural `AllocProvenanceLookup { isKnown, resolve }` to the
   existing provenance signatures. The strict branch uses the authenticated
   snapshot-backed lookup plus the single canonical final provenance check
   and the existing async-state/result-type loop. No second instruction-kind
   table or analysis. The absent branch preserves original reconstruction,
   analysis, order and error behavior. Do not read facts as an admission token.
6. `program/prepared-contracts.ts` imports only canonical DATA. Update
   `program-codec.ts::assertPreparedIrProgramShape`, encode/decode and
   reauthentication to preserve schema, own undefined metadata, aliases,
   retired IDs and exact owner/body census. Decoded strict DATA is validated
   before projection/target selection, without encoding/ownership/escape
   analysis. Runtime factory reauthentication remains canonical and distinct
   from rerunning source allocation analysis.

Required prior packet: A2's entire adopted addendum, not the historical
`canonical-extraction-candidate.patch` alone. Its provisional program-allocation
patch reads the snapshot too early; correct that explicitly. No fabricated
source catalog, namespace deletion or swallowed invariant errors.

### A-G: publish the one canonical geometry authority

Owner: newly isolated A geometry implementer after donor, A2 physical-file and
historical reader acknowledgements. Apply the complete adopted geometry plan.

Create zero-import shared `linear-memory-layout.ts`. Move the seven existing
geometry types, `LinearStringLayoutPlan`, documented offsets/constants and five
pure functions once. Preserve old/new function identity and the single frozen
`LINEAR_ARRAY_FORWARDING` object. Leave stack-arena policy and semantic allocation
analysis in IR. Add `linearScalarStorageKey`,
`linearVectorLayoutIdForElementKey`, `planLinearVectorStorageLayout`,
`planLinearScalarVectorLayout`; the old `planLinearVectorLayout(IrType)` computes
storage then semantic key and delegates. Preserve distinct pointer-shaped IR
semantic IDs; do not replace them all with `vector:scalar:pointer`.

B's actual consumers become:

- `runtime/array-allocation.ts`: `planLinearScalarVectorLayout('f64')`, no `irVal`;
  instruction type from `wasm/model/instructions`.
- `runtime/vector-initialization.ts`: shared vector element offset.
- `runtime/strings/char-code-at.ts`: shared string offsets, existing body intact.

These are B-owned import updates after A supplies the exact reviewed commit.
No unrelated old direct-runtime import cleanup is necessary. A-F and A-G touch
one physical memory-plan file but disjoint algorithms; root alone composes
reviewed hunks, never transplants an entire private file.

The historical preservation successor must compose genuine forwarding history
before old lowering-analysis proof: `2a98b75de993bdc568e3668a2965c026876fe322`,
parent `6c88d157444ea4ae377a7ef1b82b15ef2f4f6603`, layout4670→4763 bytes, exact
93-byte insertion at offset2820. Inverse: geometry→main845 with forwarding→old
layout→unchanged old proof. Forward replay must reproduce complete current
bytes. Retain distinct current resolver and historical proof readers. Authenticate
reader instrument successors before their old pinned callers. Do not reseal old
receipts, weaken mutants, substitute historical bytes into current resolution,
or invent geometry-after pins before source exists. The full B appendix is the
required recipe, not a grant to edit foreign proof files.

### A-C: shared acceptance and emitter dispatch with actual B callers

Owner: root-appointed shared-consumer implementer, explicitly coordinated with
A1/S/A2, B and the physical-kernel donor. This is the missing executable A slice.
Its production file scope is `program-physical-plan.ts`, `program-consumer.ts`,
`program-native-invocation.ts`, the narrow `lower-generic.ts` vector carrier/layout/scratch seams and
`ir/backend/{handles,lower-contracts,emitter}.ts` only as needed to type those seams.
A1's `compiler/native-linear-pipeline.ts`, target-profile and entrypoint changes
are reused and extended only by the actual A1 owner, not copied wholesale.

Current source defects this slice must replace together:

- `planPhysicalSetup` blanket-refuses every nonempty Linear allocation registry;
  its vector signature conversion uses GC-native layout requirements.
- `physicalBodyResolver` binds only GC vector handles.
- `fillPreparedPrimaryUnit` constructs bare `new LinearEmitter()` and uses a
  generic converter without a concrete resource-backed Linear invocation.
- `lower-generic.ts::resolveVecType` and `lowerIrTypeToValType` prefer explicit
  GC layout references; their fallback also assumes GC handle fields. Supplying
  only a custom outer converter cannot fix internal vec operations.
- `lower-generic.ts::ensureVecDataScratch(arrayTypeIdx)` unconditionally creates
  `ref_null`; the overlay fixes emitted locals afterwards. That overlay
  postprocessing is not present in shared consumption and must not be copied.

The concrete A-to-B interface is specified below. Names are proposed new exports,
not claims that such source exists. B must acknowledge and implement them together
with A's callsites; if existing B work uses a better exact name, root amends this
contract before dispatch rather than leaving two APIs.

```ts
// src/backend/linear/program/memory.ts (B), DATA types in contracts.ts if needed
planPreparedLinearMemory(input: {
  program: PreparedIrProgram;
  projection: PreparedIrProgramRuntimeProjection;
  options: PreparedIrBackendOptions;
}): PreparedLinearMemoryResult;
reservePreparedLinearMemory(
  tx: PhysicalModuleReservations,
  plan: PreparedLinearMemoryPlan,
): PreparedLinearMemoryReservations;
fillPreparedLinearMemory(
  tx: PhysicalModuleReservations,
  pack: PreparedLinearMemoryReservations,
): void;
requireCompletedPreparedLinearMemory(
  tx: PhysicalModuleReservations,
  pack: PreparedLinearMemoryReservations,
): void;
preparedLinearMemoryBindings(
  tx: PhysicalModuleReservations,
  pack: PreparedLinearMemoryReservations,
): PreparedLinearBodyBindings;
```

Contract definitions:

- `PreparedLinearMemoryResult`: supported exact immutable plan or located typed
  unsupported failure; invalid DATA throws the existing typed invariant. An
  empty scalar program has a genuinely empty requirement set, not a fabricated
  provider manifest. No public success boolean bypasses validation.
- `PreparedLinearMemoryPlan`: backend/target/options identity; exact detached
  facts and selected projection join; canonical `LinearMemoryPlan`; finite
  memory/global/function/export requirements with semantic keys and signatures;
  admitted operation set, source owner/allocation/layout mapping and complete
  support-body inventory. No callback, checker, mutable registry, physical
  handle/index, fresh source analysis or serialized allocator capability.
- Plan derivation calls existing `planLinearMemoryFromFrozenFacts` on the actual
  selected projection with its strict final facts and canonical default arena
  policy. Audit every plan decision and operation. Reject stack/custom decisions
  rather than reinterpret them as heap allocations. Read/write-only vector
  parameters need exact ABI/type layouts even without a local allocation site.
- Reservation pack: opaque module-local authority joined to this exact `tx` and
  plan, with memory, heap global, allocator/array/initializer/forwarding helpers
  as actual ledger tokens. Never codec-persist it or return it in public evidence.
- Body bindings: exact carrier/signature conversion, vector layout resolution
  keyed by logical type/allocation owner, representation-derived scratch carrier,
  operation→reserved callable binding, and actual support inventory. They are
  emission-local implementation interfaces, not fields in PreparedIrProgram.
  Linear vector value/data scratch carrier is i32; f64 payload remains f64.
  Names are diagnostics only. No namesake may supply a missing binding.

A's exact call ordering:

1. `acceptPreparedIrProgram` validates the entire program before selecting a
   runtime projection, target or physical plan. `planPhysicalSetup` obtains the
   Linear plan above before signature conversion. Only the accepted fixed-f64
   capability replaces the blanket allocation refusal; residual requests refuse
   before any ledger is created. Existing WasmGC plan behavior is retained.
2. Dispatch target resource planning before `planNativeVectorResources` and
   target resource reservation before `reserveNativeProgramFoundation`; do not
   call the GC family with Linear vector demand and hope an empty plan is safe.
   The no-GC-demand scalar arm may keep its verified empty data contract.
   `PhysicalSetupPlan` carries an optional/discriminated Linear plan; its existing
   GC vector field is not repurposed as a Linear plan. The private acceptance
   record retains the exact accepted plan and authentic selected projection.
   Repeat currentness checks before emission using detached equality plus exact
   owner/projection joins. An exposed plan copy cannot authorize emission.
3. `materializePhysicalProgram` reserves imports before definitions, then asks
   B to reserve the complete Linear pack through the existing ledger. Reserve
   ordinary program slots and startup resources in the same transaction. All
   types/functions/globals/memory/exports are inventoried before freeze.
4. Freeze reservations exactly once. Obtain final indices only from ledger
   tokens. `preparedLinearMemoryBindings` refuses a foreign/stale/unfrozen pack.
   Bind common function/global/ABI slots and target-specific vector handles.
   `physicalBodyResolver` composes common binding lookups with B's real vector
   resolver instead of trying the GC resolver first or inspecting names.
5. Fill B's provider bodies and primary units through the same transaction.
   `fillPrimaryBody → fillPreparedPrimaryUnit` receives one concrete
   backend-lowering configuration (emitter, converter, resolver) selected by the
   consumer, preserving original fn/slot/signature identity and completion checks.
   Linear constructs `new LinearEmitter({resolveRuntimeOperation: ...})` with
   the exact pack; WasmGC constructs its existing emitter/resolver unchanged.
6. Introduce one concrete optional logical-vector resolver seam in
   `IrLowerResolver`, proposed
   `resolveVectorRepresentation(type: Extract<IrType, {kind: "vec"}>, alloc?: AllocSiteId)`.
   Its result supplies the actual value carrier, data-scratch carrier and
   `IrVecLowering | LinearVecLowering` handle. B provides this from its accepted
   layout map. Both `resolveVecType` and `lowerIrTypeToValType` consult the same
   seam, so internal reads/locals/construction and outer ABI agree. For the first
   Linear capability require genuine layout-free logical numeric vecs; reject
   a persisted GC `type.layout` rather than reinterpret or delete its bindings.
   Existing GC explicit-layout and resolver paths remain byte/behavior-compatible.
   Refusal/no handle cannot fall back to a fabricated GC handle. Enumerate the
   actual `vec.len/get/set/set_length/new_fixed`, for-of and lower-type callers;
   only already admitted operations may reach emission. `ensureVecDataScratch`
   now receives verified representation data, not only a GC arrayTypeIdx.
   Make vector scratch allocation derive from that verified representation handle:
   GC uses its actual nullable data-array reference and type identity, Linear
   uses i32. Key cache by representation plus actual layout/type identity, not
   fake GC indices. Update resolver handle types/narrowing to express the real
   union where needed; enumerate existing producers/consumers first. Do not cast
   a Linear handle to GC or post-edit emitted locals. Unsupported/no layout is
   an error, not a default i32.
7. Require B pack completion and canonical primary/startup/resource completion,
   bind only inventoried ABI entries, reconcile helpers as support functions
   rather than source units, seal, then emit the sole success observation.
   Any fill failure poisons the transaction; do not fallback or reuse acceptance.

The existing checkout's `src/ir/backend/lower-contracts.ts` has foreign changes.
They were observed, not inspected as authority or modified. Implement only in
an isolated worktree and request the actual owner/hunk handoff before touching
that path. Broadening vector types affects all resolvers/emitters, so list actual
readers and mutators and qualify GC controls; a structural cast is not a repair.

### B-M and runtime donor R: real target resources and canonical provider reuse

B owns `src/backend/linear/program/memory.ts` and its cohesive target-specific
contracts/helpers, retained native arrays, prepared-memory, physical-resources,
body-resolver and Unicode leaves. A owns the common callers above. No A worker
edits B's leaves or copies their bodies into the shared consumer.

B derives canonical f64 layout (+8 length, +12 capacity, +16 elements, stride8,
minimum capacity16, alignment8). One two-element minimum-capacity array consumes
144 canonical record bytes before allocator accounting; assert actual heap delta
under the selected allocator, do not mistake arena reservation size for payload.
Reuse `__malloc`, `__arr_new`, `__linear_ir_vec_init_f64` and `__arr_resolve`.
`LinearEmitter::vectorReadResolver` actually requests
`{ family: "vector", operation: "resolve-forwarding" }` for reads; its complete
demand is required even for fixed arrays without growth. Preserve reverse stack
consumption into original element indices and publish length after initialization.

`codegen-linear/runtime.ts::addRuntime`, `addArrayRuntime` and
`addLinearIrVecRuntime` currently mutate raw modules. They cannot run on a
ledger-owned module and then have slots adopted. Runtime donor R must extract
actual pure body construction and exact resource definitions into cohesive
runtime leaves, with BOTH old builder and B fill path calling the same source.
Reuse B's published initializer and checked allocation leaves. Capture true
function/global dependencies as explicit inputs; pass ledger-resolved indices
only after freeze. Never build a throwaway module and rebase its indices,
rediscover resources by name, duplicate malloc or call an unreviewed fake factory.

Allocator4540 owner must acknowledge the exact `addRuntime` bump-body/resource
extraction, preserving heap floor, alignment, header initialization, growth/OOM
and arena lifecycle exports. Array/runtime owner must acknowledge exact
`addArrayRuntime` allocation and `ensureArrayResolveRuntime` forwarding-body
extraction. Plan coverage must
include every transitive helper that real bodies call. If the current holder
supplies an existing reservation-safe provider, use that canonical provider;
record its exact source commit and callers instead of creating another.

First numeric vector pack has no string data segments. It still owns real memory
limits, memory export and heap initialization as needed by existing public target
options. Use existing `reserveMemory`, `reserveGlobal`, `reserveFunction`,
`defineExport`, `freezeReservations`, `fillFunction` and `seal` APIs. No physical
kernel change is presumed. An actually missing ledger operation is a new bounded
request to its owner, not an out-of-ledger mutation.

### A-P, S and root: public integration and startup

A1 owner continues only the actual public caller and target-policy seams;
its original 49-row test source and failure artifacts remain preserved. S owns
ReferenceError construction/TDZ/startup resources and their actual provider
capability. A-C must accept S's real reviewed resource contract; it may not
waive the `error.reference.construct` demand, turn throws into traps or replace
lexical declarations with var. Compile-time control-flow exclusion requires a
real proof valid for the source, not deletion of runtime demands by name.

Root integrates reviewed A-F/A-G/A-C/S/R and B-M exact source heads in a dedicated
integration tree. Register actual new modules and policy populations; preserve
class DATA fix6597 as a separately reviewed dependency if its source is needed.
Keep native admission opt-in and its public errors honest while incomplete.
Only the joined source can claim the first native vector handoff.

## Dependency DAG and next safe implementer scopes

```text
A-F donor ack → canonical facts + strict codec validation ───────┐
A-G donor/A2 ack → shared geometry → B provider import rewires ├→ B-M actual pack
R allocator/array donor ack → shared real provider bodies ─────┘       │
A-C reviewed common contract + scalar/GC-compatible dispatch ─────────┤
S real ReferenceError/TDZ/startup repair + A1 public caller ───────────┤
Historical source/adapter/policy ack → finite successor proof ────────┤
Root registry + source joins → frozen integration cohort → review ───┤
Protected checks/queue → exact published source packet → B adoption ─┘
```

Contract and real callers are reviewed together before Sol implementation.
A-C and B-M may be developed in isolated coordinated worktrees after named
acknowledgements; neither lands a nonfunctional stub. Source publication waits
for coherent composed execution. If narrower prerequisites are published first,
label their proven finite capability and keep native vector acceptance open.

| Slice | Safe next action after root release | Blocker before production edit |
| --- | --- | --- |
| A-F, A2 owner | Apply canonical extraction plus strict-before-snapshot refinement; keep original18 controls and add finite strict cases | Allocation donor acknowledgement; geometry same-file partition; root qualification approval |
| A-G, Sol High proposed | Three source operands from adopted geometry plan, old planner delegation, identity/layout tests | Allocation donor + A2 + historical proof owner acknowledgements |
| A-C, dedicated A implementer | Common acceptance/physical/signature/resolver/body/scratch dispatch with concrete B API | Root file/hunk assignment, B contract acknowledgement, physical/shared lower-contracts owner census |
| R, actual runtime owners | Extract canonical allocator/array/forwarding bodies used by old builder and B fill |4540 and actual array donor ack, exact before/after caller validation |
| B-M, B retained implementer | Real `backend/linear/program/memory.ts` and provider leaf rewires | Exact A-F/A-G/R source dependency and A-C contract/callsite agreement |
| S and A1 | Continue already owned repairs; preserve original lexical startup cohort | S coherent reviewed source commit; no takeover by this task |
| Root integration | Registry, required historical reader joins via their owners, exact composed source and publication | All reviewed executable pieces and complete finite qualification |

No named foreign acknowledgement is present in the evidence read for this
issue. Missing/old branch names, slice labels, dates or a public advisory release
are not a file-scope transfer.

## Named acknowledgement requests root must record

1. **Allocation donor** `3518:allocation-ownership-runtime`, owner
   `ttraenkler/codex-astra-allocation-ownership-20260908`, write34529-rzivb817:
   independently acknowledge (a) A2's exact lattice/escape definitions,
   alloc-verification structural signatures and strict program/allocations
   branch, and (b) geometry-only memory-plan/contracts hunks. Include canonical
   DATA/helper relocation scope from A2's full request; preserve all algorithms
   outside the named extraction. Request owner-authored patch if preferred.
2. **A2 physical-file owner**
   `ttraenkler/codex-ir-native-linear-source-facts-sol61-20261008`,
   write16740-hhm82aur: confirm disjoint geometry/facts hunk composition and
   exact source epoch. Root alone joins same-file patches.
3. **Historical source proof**
   `ttraenkler/codex-lowering-analysis-source-proof-20261004`,
   write54017-blpvz0m8: successor DATA/adapter and fixture acquisition/current-chain
   tests, including authentic forwarding epoch and full inverse/forward equality.
4. **Historical trusted adapters/C1**
   `ttraenkler/codex-lowering-analysis-trusted-adapters-20261004`,
   write76271-0mo0ncgo: current closure/resolver contract, pre-pin composition and
   authenticated instrument-history successor. Old helper/receipt pins stay.
5. **Historical policy callers**
   `ttraenkler/codex-lowering-analysis-policy-callers-20261004`,
   write75863-k6ti87wv: capture before old physical rejection and BOTH predecessor
   entrypoint joins, current reader distinct from historical reader.
6. **Allocator4540** owner `ttraenkler/claude-opus`, write12703-i71z8kda
   (record from adopted geometry plan): exact default bump resource/body
   extraction from `addRuntime`, old and new live callers, no allocator redesign.
   Root must refresh exact ledger/path census before dispatch.
7. **Physical kernel3518** owner
   `ttraenkler/codex-astra-physical-module-completion-20260908`,
   write19409-8ue0poec (adopted plan): confirm A's consumer integration boundary;
   kernel source remains held unless an exact missing API is independently agreed.
8. **Vector2956:l2-vec** owner `ttraenkler/codex-l2-vec`, no write ID in adopted
   record: exact generic vector handle/scratch/emitter boundary and array/forwarder
   body donor ownership. Do not invent a whole2956 record or a write ID.
9. **B prepared-memory owner**
   `ttraenkler/codex-linear-b-prepared-memory-20261007` and its current source
   owner named by B: acknowledge concrete plan/reserve/fill/completion/bindings
   contract, exact target files and real provider dependencies. B keeps its leaves.
10. **A1/S/current shared-contract writers**: root must join current exact claim
    records with modified-path/function inventory and issue a bounded assignment;
    this issue does not guess write IDs or assume its own planning claim covers them.

All acknowledgements must name holder, claim key/write identity when present,
exact files/functions, base and conflicting in-flight bytes. Retain all other
scope with each holder. Root owns external coordination; this writer sends no
GitHub comment, steals no claim and does not release another task.

## Finite staged qualification and actual oracles

These are planned gates, not executed results. Before any run, freeze complete
source/test/config/tool inputs and exact independent baseline/candidate commits;
use root's approved stock runtime/custody process. Each stage reports collected,
executed, pass/fail/skip/filter/error counts. A failure remains visible. Zero
collected tests, missing traces or silent empty manifests are failures of the
instrument. Existing suites keep their original source bytes and denominators.

### F: final facts / codec stage

Run unchanged A2 18-row cohort, requiring 18/18 with zero skipped only after the
real strict branch repair; keep original17/18 receipt. Add the already planned
13 addendum cases as a distinct 13-row cohort, collect their exact names once,
and report 31 total only if all 31 distinct rows really execute. Required cases
include canonical/compatibility function identity, present-undefined vs absent
encoding, forged encoding, missing live instruction, kind/result-type mismatch,
alias cycle/retired target, invalid metadata owner/namespace, zero getter and
foreign iterator execution, moved-owner IDs and nested async-state census.

Use healthy genuine captured source facts as the positive. Versioned direct
validation and `decodePreparedIrProgram` must execute zero allocation encoding,
ownership or escape analyses; the absent-attachment canonical legacy control
must actually execute those analyses. Call-through observation requires a
nonzero positive instrument control. Missing allocating runtime support must
refuse with its actual owner, not disappear. Native physical allocation still
refuses until stage V; F alone is not vector execution.

### G: shared geometry and preservation stage

Create a fixed authored cohort with **24 named rows** before execution:
8 storage-kind old/new/full-independent-geometry rows; 7 distinct semantic
pointer-type rows; 4 record/string geometry rows; 3 authority/freshness/forwarding
identity rows; 2 dependency-parser positive/negative controls. Preserve the
adopted plan's complete expected tables (pointer4; record8/8/8; vector8/12/16/16;
UTF-8 string8/12/4/4; forwarding6/0/4/4), complete object equality and identity
requirements. These 24 are a proposed new cohort, not the count of existing
geometry tests or a population estimate.

Run original issue3298/3299/3502 suites and exact B provider suites separately
with actual denominators discovered by collection, never inferred. Run the
historical successor finite positives/mutants required by B's published appendix:
missing/duplicate/shifted93-byte insertion, mixed epochs, altered shared owner,
geometry/key/delegation mutations, wrong reader/receipt pins and healthy-old-file
fallback attempts must all fail the proof. The original historical fixtures and
mutants remain; no resealing. New shared root all-reference closure is one module,
zero imports, and actual B leaves must reach no IR through type or value edges.
Root's actual registry/import gates verify classification and no new cycle growth.

### V: real native public vector and source-free consumer stage

Create one fixed planned **48-row** vector cohort, separately from original
A1's49 rows and B's existing test file. Do not replace or expand their reported
historical denominators retroactively.

- V01–V16: four genuine source programs × two targets × public sync/async compile.
  Programs are runtime pair→1.25; empty plus nonempty allocations; multiple
  distinct fractional vectors; branch/early-return allocation. Require actual
  source owner census, physical helper binding and JS/retained-direct value oracle.
- V17–V24: eight lifecycle observations, each a named row: cold memory/header,
  payload order, minimum-capacity/actual heap delta, adjacent allocations intact,
  repeated calls in same instance, fresh instance independence, valid native
  top-level/defer behavior, authentic TDZ/ReferenceError behavior. Preserve S/A1
  original lexical fixtures for the last two; no var replacement.
- V25–V32: eight real captured-program replay rows across both targets: valid
  source-free codec execution; own-undefined evidence preservation; owner-ID
  swap rejection; stale/missing/extra facts rejection. A row containing multiple
  named mutation subcases records them as subcells, not extra authored tests.
- V33–V40: eight reservation/transaction controls: nonzero import-offset fixture,
  namesake callable rejection, missing resource, foreign token, unfilled helper,
  duplicate key, replayed acceptance and cross-transaction binding. Valid
  reservation is paired with each negative; unit controls never replace V01–V16.
- V41–V48: eight pre-reservation unsupported cases: JS-host SOURCE, JS-host PROGRAM,
  public vector ABI, unsupported element representation, growth demand, custom
  allocator/lifecycle, linked/imported memory, unsupported allocating runtime
  provider. Verify typed location, zero reservation/body fill and no legacy fallback.

All 48 rows are planned, unexecuted. Freeze exact bodies/cases before the first
baseline run. Additional necessary cases are added as a successor cohort with a
new stated count, preserving the original48 evidence. Internal vector-call
support is conditional: if claimed, add explicit real producer/callee/source-free
rows before admission; otherwise refuse it and keep the narrower capability.

Original A1 **49** must rerun as49 with all original assertions; original six
ReferenceError failures may become passing only through real S changes. Original
B scalar shared-consumer control **17** must rerun unchanged. Existing B allocation,
initializer, Unicode and current-main overlay control files keep original rows
and expected semantics; record exact per-file counts at their delivered heads.
Poison real legacy generation/overlay entrypoints only in tests and retain healthy
GC/legacy positives proving observer reach. Valid Wasm and empty success counters
alone are insufficient: execute the resulting function and inspect real memory.

The actual static real-test floor is preserved: existing selected files and rows
remain enabled; new V=48 and G=24 and F-expanded=13 receive immutable named test
manifests, with collection checks that fail on missing files, skipped rows or
uncollected tests. These bounded floors are not a repository-wide conformance
population claim. Source/selected-test typecheck must explicitly include actual
test files; the previous test-excluded blind tsc result does not count.

### Normal validation and publication

Run source and actual selected-test TypeScript, formatting/lint, changed tests,
required boundary/layering/import-cycle/dead-export/source-budget/oracle gates,
relevant unchanged equivalence and preservation suites. Use actual main/merge
preview gate base. No baseline edits, broad allowances from untouched issues,
waived receipt failures, disabled hooks or passing status inferred from skipped CI.
Any measured necessary budget grant lives in the exact touched issue with rationale.

Source closure includes import, export, import-type and dynamic edges plus a
positive forbidden-dependency detector control. Detached consumer/codec cannot
reach checker, frontend, source preparation or legacy contexts. Foundation geometry
must be actually used. Preserve GC scalar/vector and native scalar behavior,
including source-free replay and one-shot completion across targets.

Root alone reviews, composes, publishes and joins the protected merge queue.
Commits follow repository signing/hooks, Thomas Tränkler author and actual agent
co-author/model/effort trailers. No commit is authorized by this planning task.
A source PR being all-green or docs being published does not replace independent
review or exact source qualification.

## Exact delivery packet and acceptance

Before telling B it is unblocked, root supplies:

1. Exact canonical base and each reviewed source commit for A1/S, A-F, A-G,
   runtime R, A-C, B-M, registry and historical successor. A missing entry says
   missing; no abbreviated plan hash is substituted for a source commit.
2. Named donor acknowledgements and complete file/function ownership partition.
3. Frozen coherent integration head, full source/test/config/tool manifest,
   normal gate receipts, finite test populations and all original red evidence.
4. Real public `run(1.5,-2.25)=1.25` on standalone and WASI through sync/async
   compile, exact source/allocation/helper/ledger census and actual memory values.
5. Same source-free encoded program replay with no frontend/analysis rerun,
   all rejection controls, S/A1 lexical startup repairs and GC/legacy controls.
6. Exact imports/call recipes B consumes, no idle production exports; documented
   residual limitations for Unicode, optimization, source maps and full retirement.

- [ ] Complete plan independently reviewed/adopted before Sol implementation.
- [ ] Required bounded donor/B/shared-source acknowledgements recorded.
- [ ] Source-facts18 + planned13 strict cases qualified; original17/18 preserved.
- [ ] Geometry implemented once, old/new users joined, historical proof retained.
- [ ] Real canonical provider bodies used by both direct and ledger callers.
- [ ] A consumer/signature/resolver/scratch dispatch connected to B's real pack.
- [ ] S/A1 original startup/TDZ tests and exact49-row caller cohort qualified.
- [ ] Actual48-row vector cohort and unchanged17-row scalar control qualified.
- [ ] Full exact source packet reviewed/published through normal protected checks.
- [ ] B acknowledges consuming those exact commits; no fabricated native completion.

## Planning-only checks

Read-only metadata audit `node scripts/update-issues.mjs --check
plan/issues/6920-native-linear-shared-source-handoff.md` indexed exactly one
issue and requested zero issue-file changes. Its overall exit was1: the same
command also performs global generated-index/link checks against the scoped
issue population and reported550 broken links plus index differences. This is
not a green repository-wide issue gate or a finding that those550 links are
new defects. No generated indexes or other files were changed. Root runs normal
full checks when publishing. Static worktree inspection contains only this new
issue; private evidence is ignored. No compiler, Wasm or test runtime was run.

This planning issue remains in progress for root's adoption/publication. No source
implementation, donor acknowledgement, runtime pass or coherent handoff is claimed.


## Root adoption and controlled publication — 2026-10-08

Root has read the complete Astra High plan at7d3f25c70e04f95778c66a626b1b10b0feba3969d698b5e4f6c6dbc3b3359098 and adopts it as the coherent implementation direction and contract proposal for Session B acknowledgement. The task belongs under3518 IR-only default and direct front-end retirement; old6865 coordination references remain historicalcontext, not an architecture parent for nativevectors. Publication of this complete issue plan via existing docsPR6596 is expressly authorized after actualclaim/effectchecks, exact reviewed documentation diff, fullnormalhooks and signed Thomas/Codex attribution. Root delegates only this issue publication to a unique6920 slice; no overwrite of existing docs, no source commit/claim transfer/queue approval.

No coherent passing vector source endpoint is asserted. All ten named acknowledgement groups, exact source epoch/proof prerequisites and originalA1/A2/S failures remain obligations. In particular, the common logical-vector resolver must serve both internal type lowering and outer signature conversion; direct reads require the actual canonical forwarding resolver body alongside allocator/constructor/initializer. Plan-only interfaces must be agreed with B and real callsites composed before claiming a source handoff. No idle facade or duplicate runtime/geometry algorithm will be published as the missing dependency.

All proposed source slices remain conditional on concrete custody and named bounded acknowledgements. The docs publication permits no foreign production/proof/claim edits. Root continues the separately authorized S repair and preserves all legacy/originalfixture/failure/receipt evidence. No fullmigration, equality, sourcecapability or maindelivery result follows from publishing this issue.
