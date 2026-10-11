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
| B published plan | PR6577, head `a40bee66df93e34870c810d16c12ebf3444c5889`, [6905-linear-prepared-memory-materialization.md at the published commit](https://github.com/loopdive/js2/commit/a40bee66df93e34870c810d16c12ebf3444c5889), title **Linear Prepared IR memory materialization and ownership handoff** | Genuine published plan and retained initializer work; shared-route resources still conditional |
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

## Implementation Plan refinement: native memory DATA, demand and transaction contract — 2026-10-08

This appendix adopts the architectural corrections in Session B's **Linear Prepared IR memory materialization and ownership handoff**, issue 6905, conditional acknowledgement at PR6577 commit `3e0fed0facf53c681e0e8e518a185144532de5e0`. It refines the implementation direction of **Native Linear numeric-vector shared source handoff and integration plan**, issue 6920, without rewriting its original plan, schema, failures, acceptance obligations or ownership history. Root must review/adopt this appendix before publication. The extra emission-lifetime argument and the precisely named additional source boundaries below still require B's fresh conditional acknowledgement and the actual holders' bounded releases. An architectural agreement is not source delivery or implementation authority.

The five B API names remain the single target interface. The adopted corrections are: derive an authenticated `IrModule`/facts pair before invoking the frozen-facts planner; preserve its operation catalogue while independently checking executable demand; expose canonical snapshot DATA and retain indexed plans privately; publish target exports in B's fill function only; and make every failure terminal for the whole accepted emission attempt, including failures before a ledger call. A owns common program orchestration and the private attempt state. B owns Linear resource construction and bindings. Neither owns a second acceptance path.

### Exact read-only evidence and limits

The full original issue 6920 was read from PR6596 exact head `5d1d87224101fc3ed8a2cc4e54a5a4230dca0dfe`: 47,999 bytes, SHA256 `e264f64d0e600664881b656c8aae2d2f349ae5c3eeb4ada10a6bd8af816c9cfc`. PR6577's API head matched the exact acknowledgement commit above; its parent is `a40bee66df93e34870c810d16c12ebf3444c5889`, and the sole commit change is 97 added lines, zero deletions, in the existing issue 6905 document. The complete B document was acquired using exact-ref base64 and independently checked against its Git tree/blob: 50,614 bytes, SHA256 `ddabfbc9a2ace9ee822619aa1125d0fcf0cd4de273130ace02064385fe1ce739`, Git blob `c23182b7590725d6aff614ac7bdb49b8d9b53b42`. Both PRs remained open with HOLD and no auto-merge at the read. These are document endpoints, not a tested combined native-vector source endpoint.

Source predicates below were read from exact canonical base `8452732f0b88c14c5c7634ece58f83240970ea4c`; local dirty source is not an implementation operand. In particular, the foreign `src/ir/backend/lower-contracts.ts` working copy was neither adopted nor edited.

| Exact-base source | Observed predicate requiring this refinement |
| --- | --- |
| `src/ir/analysis/linear-memory-plan.ts::operationsForLayout` | Every vector catalogue includes allocate, grow and initialize-element. Catalogue membership does not prove a grow instruction is executed. |
| Same file, `verifyLinearPreparedAllocationFacts` and `planLinearMemoryFromFrozenFacts` | Planner accepts `(IrModule, LinearPreparedAllocationFacts, policy)`. Verifier compares exact live instruction IDs with fact rows and rejects missing and extra IDs; module walkers include nested buffers and async states. |
| Same file, `LinearMemoryPlan` and `toJSON` | Class has private lookup maps and methods; `toJSON()` returns the existing `LinearMemoryPlanSnapshot` fields: policy, layouts, allocations, dataSegments, globals. |
| `src/ir/program/allocations.ts` | Whole-program validation includes `irRuntimeSupportFunctions(program.runtimeSupport)` in addition to semantic functions. A module made only from selected primary functions can miss genuine support allocation owners. |
| `src/ir/program-runtime-validation.ts::assertPreparedIrRuntimeProjection` | Canonical runtime reauthentication already checks the projection against semantic/provider data. Reuse this authority; do not replace it with a projection-name test. |
| `src/ir/program-consumer.ts::emitAcceptedIrProgram` | Existing `emissions` WeakSet consumes the acceptance before materialization; it prevents retry, but provides no per-attempt state for retained target bindings to inspect. Observation of emission-started is presently outside its materialization try block. |
| `src/wasm/physical/module-reservations.ts::defineExport`, `assertCompletedReservation`, `seal` | Export publication requires filling. Completion checks are available for defined functions/globals in filling or sealed. No public abort operation is assumed. |
| `src/ir/backend/linear-emitter.ts::vectorReadResolver` | Reads request `vector/resolve-forwarding`, which is not present in the vector allocation catalogue. Treating that catalogue as complete executable demand would also omit a required provider. |
| `src/codegen-linear/runtime.ts::addRuntime`, `ensureArrayResolveRuntime`, `addArrayRuntime`, `addArenaManagementExports` | Existing canonical implementations append resources directly. Default bump allocation legitimately uses `memory.grow`; optional arena exports are off by default. Neither fact admits vector growth or custom lifecycle semantics. |

`src/codegen-linear/runtime/array-allocation.ts` is absent from the inspected main845 tree and from PR6577 at the exact acknowledgement head (Contents returned 404). This is a bounded endpoint finding, not evidence that B has no such leaf on another retained branch/PR. The prior geometry plan and PR6583 references remain evidence to resolve: B must name the exact published leaf commit, path, real caller and qualification before it becomes an integration dependency. Existing array construction in `runtime.ts::addArrayRuntime` remains the current canonical source at main845. B's published `runtime/vector-initialization.ts` does exist at PR6577 and still imports the old IR geometry path, so its later geometry import rewire is also a real outstanding source join.

This task only read source and wrote private planning artifacts. No compiler, Wasm runtime or test cohort was executed, and no source/claim/branch/receipt was changed. Task tracking was appended to a private copy of issue 6920 before analysis. All original observations and denominators below remain inherited evidence, not new runs.

### R1. A owns the authenticated module/facts input; B never invents it

Keep `planPreparedLinearMemory({ program, projection, options })` as the planning call from `program-physical-plan.ts::planPhysicalSetup`. Its generic input dependency is a single A-owned helper, proposed `requirePreparedLinearMemoryInput(program, projection)` in the already proposed `src/ir/program/linear-allocation-facts.ts`. This helper is the narrow join between canonical facts and the exact selected bodies. It must be implemented and reviewed with A-F's existing strict attachment gate, not as a B-side cast of the runtime manifest to `IrModule`.

The ordered contract is:

1. A's `acceptPreparedIrProgram` validates the complete program, including the strict own-property attachment branch and support data, before projection selection and physical planning. Malformed present-undefined attachments never take the legacy absent branch. The strict gate screens the complete joined graph with descriptor-only access before nested readers. Existing canonical runtime projection validation authenticates the selected manifest and attachments.
2. Preparation's final fact census uses the genuine final semantic module plus every body returned by `irRuntimeSupportFunctions(runtimeSupport)`, after the existing support allocation analysis/hygiene. It calls `prepareLinearAllocationFacts` once for that complete final census. Its preparation-only module view retains actual function objects and declarations; it neither creates support IR nor assigns new IDs. This makes explicit the support obligation already present in A-F; `finalSource.ir` alone is insufficient if support functions are outside it.
3. `requirePreparedLinearMemoryInput` verifies that `projection` belongs to this program and that its backend/target/policy is the actual selected one. It joins each selected function to its semantic owner by `unitId` and the existing canonical runtime reauthentication, preserving exact function/body identity in the selected view. It carries `program.ir`'s `declaredSignatures` and `declaredGlobals` unchanged, preserving property absence. It uses the selected `projection.prepared.functions` plus authenticated support functions from the existing support authority, each exactly once. No renaming, fabricated function shell, source-name allowlist or index-based owner inference is allowed.
4. Distinguish three populations in the join receipt: selected primary/derived IR bodies, selected semantic support IR bodies, and later physical Wasm provider bodies. The first two enter the `IrModule` census and detached allocation verifier. The third is inventoried as physical support and never receives synthetic source units or fake IR allocation facts. Reject duplicate ownership, duplicate object occurrence, support masquerading as a primary unit and unresolved support selection. Diagnostic function names are not the owner key.
5. For this first capability, require the selected IR census to preserve the complete final live allocation-ID/owner/kind/result-type/occurrence census already authenticated by A-F. Nested instruction buffers and async-state buffers use the canonical walkers and existing final provenance checks; no second allocating-op table is introduced. Reuse the exact detached fact attachment and its full original registry, including aliases, retired entries, metadata presence and explicit undefined. There is **no facts filtering** and no registry compaction. In this capability `selectedFacts` is the original validated facts object; its name describes its proven match, not a subset. A valid future projection that drops/adds/reassigns live allocation sites requires a separately authenticated projection rule; it is a located pre-reservation unsupported case here. Forged/missing/extra facts or a contradicted owner are malformed DATA invariants, not optional unsupported capability.
6. Freeze the actual `IrModule` view and its joins. The view has exactly the core `IrModule` shape, using the already authenticated functions and declarations; it is an explicit A-owned projection, not an opportunistic B reconstruction. Before calling the planner, run the canonical detached verifier on this exact module/facts pair. The planner's own verifier stays in place as a defense at its public entry. Source-free replay reconstructs this authenticated view from decoded DATA and canonical runtime reauthentication, without checker, source parsing, encoding/ownership/escape analysis, or a mutable registry.
7. Unsupported semantic support is counted and located before refusal; it cannot disappear to make the census fit. The initial numeric capability does not admit number-format/string/closure/dynamic support merely because a support body can be listed. S's real ReferenceError/TDZ provider requirements must also be counted and joined to their actual owner contract, never removed by name. An allocating provider with no final facts or no accepted physical realization is a blocker, not zero demand.

The helper returns immutable in-process generic DATA: `module`, `facts`, selected owner/allocation occurrence joins and semantic support inventory. It is not persisted as a new Prepared schema or treated as acceptance authority. A's private acceptance retains the original program, selected projection and exact target-plan relation. B calls the helper; it does not rerun frontend preparation or keep a second fact projection algorithm.

### R2. Preserve the catalogue; admit executable operations and provider closure separately

There are three different meanings, all recorded separately in the accepted plan:

| Population | Producer and authority | Admission use |
| --- | --- | --- |
| Layout operation catalogue | Existing canonical `LinearMemoryPlanSnapshot.allocations[].operations` | Preserve complete canonical DATA, including grow; do not treat every entry as an executed requirement. |
| Executable semantic demand | A-C's checked traversal of the exact selected primary and semantic-support bodies, with owner and instruction path | Every actual operation must be supported before any reservation. Missing traversal/case means unknown and refusal, never empty success. |
| Physical provider dependency closure | B's exact canonical provider recipes, keyed to resource requirements/signatures and semantic operation bindings | Reserve every actual called helper/global/memory dependency once; a provider's existence grants no extra semantic admission. |

Place the new checked demand walk in `src/ir/program/linear-memory-demand.ts`, owned by the root-assigned A-C implementer after the named vector/shared-source releases. Proposed export `collectPreparedLinearMemoryDemand(input)` is called by B's plan function on R1's authenticated input. Keep its small occurrence DATA type in the same module; no generalized capability registry/schema is needed. It uses the canonical IR nested-buffer traversal and the same selected-body census, and records actual instruction kind plus logical vector type/allocation join. It does not decide physical indices or allocator policy.

For the required fixture, exact selected demand includes fixed f64 construction, numeric get and length. B translates construction to canonical array allocation and initialization binding, and read/data-pointer/length to the actual forwarding resolver; `__arr_new` depends on `__malloc`, which depends on memory and heap global. Require that closure even though no source vector growth occurs. Current `emitVecNewFixed` looks up initialize-element even for count zero, so an empty fixed construction requires that binding under the current emitter contract. Do not omit it by assuming zero loop iterations imply no lookup.

Check the actual narrow lowered population: `vec.new_fixed`, `vec.get`, `vec.len`, already admitted numeric `vec.set`, and every lowering-generated data-pointer/length-write requirement. `vec.set_length`, for-of, internal vector calls or another form may enter only with the corresponding original admission, complete checked carrier/ABI and execution proof; otherwise refuse it. This document adds no new semantic admission simply by naming a lowerer branch. Reject actual grow/push/resizing demand, unsupported element kinds, public array ABI, stack/custom allocators and unsupported allocating support at the exact owner before reservation. Preserve the snapshot's catalogue untouched.

`memory.grow` in the retained default bump allocator is an allocator implementation dependency, not source vector-growth admission. Preserve its existing alignment, growth/OOM behavior and header initialization. Do not reject the required fixture merely because that canonical body contains a Wasm memory-growth opcode, and do not rewrite the allocator in this slice. Existing unsupported linked/imported/shared/custom-memory requests stay unsupported.

An operation lookup at emission must be in the accepted executable-to-provider relation and have a matching owned token/signature. Looking up grow against a catalogue entry without admitted demand fails; looking up a required forwarder absent from the catalogue succeeds only through its separately accepted concrete demand/provider row. No name-based runtime lookup, imported namesake, default index, fabricated GC handle or silent missing-case fallback is permitted.

### R3. Canonical generic DATA and Linear physical implementation have separate homes

The accepted descriptive plan uses `LinearMemoryPlanSnapshot`, obtained from the canonical planner's `toJSON()`. Never place the indexed `LinearMemoryPlan` instance, private maps, policy callback, lifetime guard, reservation token or operation resolver in Prepared IR, codec data, `PhysicalSetupPlan`, public observation or a detached plan snapshot. B may retain the indexed object only in its private planning record associated with the exact issued plan object. A retains the private acceptance relation; deserializing or cloning a descriptive plan never mints it.

The existing `linear-memory-plan.ts` imports producer analyses as well as the frozen-facts planner. A-F's verifier extraction alone does not prove a clean consumer dependency closure. Root must obtain a bounded allocation-donor release for the pure planner factoring below, or an exact already-published equivalent endpoint, before B imports it. The factoring is source relocation/delegation with identity checks, not a rewritten memory policy.

| Physical source path | Exact responsibility and intended owner | Required live callers |
| --- | --- | --- |
| `src/ir/analysis/contracts/linear-allocation-facts.ts` | A-F/A2: existing fact/evidence DATA relocated once under allocation donor release | Strict program gate, canonical verifier, preparation producer |
| `src/ir/analysis/linear-allocation-facts.ts` | A-F/A2: existing pure detached verifier/index/equality/provenance support, including explicit encoding equality repair | Old compatibility export and strict preparation/codec/consumer checks |
| `src/ir/program/linear-allocation-facts.ts` | A-F/A2, coordinated with A-C: strict attachment gate and R1's `requirePreparedLinearMemoryInput`; whole semantic/support owner census | `assertPreparedIrProgramAllocations` strict branch and B plan's checked input join |
| `src/ir/analysis/contracts/linear-memory-layout.ts` | Allocation donor → root-assigned A-F extraction owner: canonical `LinearMemoryPlanSnapshot` and its existing layout/allocation/static-storage DATA declarations, type reexports retained at old home | Pure planner, B descriptive contract, existing imports |
| `src/ir/analysis/linear-memory-from-facts.ts` **new, explicit requested path** | Allocation donor → root-assigned A-F extraction owner: canonical `LinearMemoryPlan`, `planLinearMemoryFromFrozenFacts`, default facts-only policy and their exact pure transitive helper closure; no producer analysis | Old `linear-memory-plan.ts` compatibility imports/type/value reexports and B planning |
| `src/ir/analysis/linear-memory-plan.ts` | Existing donor, composed by root: preserve `prepareLinearAllocationFacts`, legacy `planLinearMemory` producer orchestration and analysis behavior; delegate/reexport moved pure authorities | Existing direct/analysis consumers and preparation |
| `src/shared/contracts/linear-memory-layout.ts` | A-G under original geometry/donor partition: zero-import geometry/constants/pure storage functions only | Original IR planner delegation and B provider leaf imports |
| `src/ir/program/linear-memory-demand.ts` **new, explicit requested path** | Root-assigned A-C implementer under vector/shared-source release: R2 checked executable demand and owner occurrences | `planPreparedLinearMemory` |
| `src/backend/linear/program/contracts.ts` **new, explicit requested path** | B prepared-memory owner `ttraenkler/codex-linear-b-prepared-memory-20261007`, only after B records the exact implementing holder: target descriptive plan/result/resource/signature/export requirement DATA | A physical-plan types and B `memory.ts` |
| `src/backend/linear/program/memory.ts` | Same B holder: the five functions, private indexed-plan records, opaque pack records, token inventory, physical provider dependency binding, target export publication | A's named planning/materialization/fill/verification joins in R5 |
| `src/ir/program-consumer.ts` | Root-assigned A-C implementer: existing acceptance record plus private generic emission state and liveness closure; no new generic lifecycle module | Existing `emitAcceptedIrProgram` and `materializePhysicalProgram`; guard passed to B reserve |
| `src/ir/program-physical-plan.ts`, `src/ir/program-native-invocation.ts`, `src/ir/lower-generic.ts`, `src/ir/backend/{handles,lower-contracts,emitter}.ts` | A-C and their actual holders, only the original named signature/body/vector/scratch seams | Existing shared source path, GC and native scalar controls retained |

Before that pure planner move, enumerate all imported/exported pure definitions and their callers; use the adopted geometry ownership split for overlapping helpers. Move each algorithm only once and preserve compatibility function/class/default-policy identities and snapshot object semantics. Keep stack policy and its existing behavior in IR; if its facts-only helpers must move to satisfy the closure, name those exact definitions in the donor release and keep the old identity reexports. `Encoding` is already an alias of canonical `IrStringEncoding` in `core/string-types.ts`: new pure DATA/planner imports use that canonical type directly (locally aliasing it if useful), retaining the old analysis-module compatibility export without importing that module into the pure closure. Ownership/escape types use A-F's canonical DATA relocation. Do not move producer `analyze*`, `findStackAllocCandidates`, frontend/runtime registration or legacy code into the pure consumer closure. No opportunistic new path beyond this table is authorized.

B contracts describe target requirements (resource keys, Wasm signatures/carriers, snapshot, owner/layout joins, admitted demand, support/dependency inventory, memory limits/floor, export intent). They import canonical generic DATA types rather than restating geometry/facts schemas. Private `LinearMemoryPlan` remains an implementation object in B's planning record, not a target DATA contract. The only generic attempt state/guard implementation lives inside A's existing consumer; B merely accepts the callable precondition specified below. This avoids assigning generic lifecycle policy to the Linear backend.

These are intended ownership boundaries, **not effective claim transfers**. A-F/A-C named implementer identities and write records must be supplied by root before new files are edited; B's implementing identity must be acknowledged by B. A path with an unresolved holder remains blocked. All-reference dependency checks include type imports, reexports and dynamic imports, with a positive forbidden-edge control. Do not create a target leaf that drags producer analysis into detached consumption and call it source-free because an analysis callback happened not to run.

### R4. Five functions, one target-export owner and a terminal whole attempt

Keep the proposed five exports at B's single `memory.ts` home. The sole proposed signature amendment is the required third argument to reserve:

```ts
reservePreparedLinearMemory(
  tx: PhysicalModuleReservations,
  plan: PreparedLinearMemoryPlan,
  assertEmissionActive: () => void,
): PreparedLinearMemoryReservations;
```

`assertEmissionActive` is a private in-process callable created by A inside the existing emission attempt. It throws unless this exact acceptance record, plan, projection and active emission attempt are still current. It is not a success boolean, serialized field, generic DATA schema, public sixth API, kernel extension or B-created acceptance capability. B stores it only in its private plan/transaction pack record. A never accepts one supplied by a caller. This arity refinement still requires B acknowledgement; the earlier conditional acknowledgement did not already agree it.

The full phase contract is:

1. **`planPreparedLinearMemory({program, projection, options})` — no ledger.** Use R1's authenticated module/facts input; derive canonical frozen-facts plan and snapshot; census R2 demand; close exact provider requirements; produce immutable supported DATA or a located unsupported result. Malformed DATA throws the existing typed invariant. Preserve true empty scalar requirements. A scalar-only program does not reserve fake vector providers to satisfy a nonzero manifest. Existing target startup requirements, when real, belong to their own counted provider contract.
2. **`reservePreparedLinearMemory(tx, plan, assertEmissionActive)` — reserving only.** Authenticate issued plan and call the guard before starting. Reserve exactly accepted memory/global/function/type requirements after all imports, through the existing ledger. Attach opaque pack authority to exact `tx`, plan and guard. Neither freeze, final-index lookup, body construction/fill nor export publication happens here. Imports required by other accepted packs are inventoried and reserved before this call; B's default numeric pack adds none. An exception consumes this attempt; partial resources are abandoned with its private module.
3. **`preparedLinearMemoryBindings(tx, pack)` — filling after A's single freeze.** Check private identity, pack failure/completion state and A's guard, and use ledger token/phase validation rather than reproducing it. Resolve only planned tokens to indices. Return emission-local carrier/layout/scratch and operation-callable bindings plus a readonly support-token inventory for A's reconciliation. Every returned operation/layout/carrier callable checks pack state and the guard on use, not only when the object is created. Scalar carriers and signatures can be planned from descriptive DATA before freeze; token-dependent executable bindings are created only now. Never require frozen bindings to reserve the signatures they themselves depend on.
4. **`fillPreparedLinearMemory(tx, pack)` — filling only, once.** Check the guard, construct fresh canonical provider bodies using frozen token indices, fill all owned provider functions and heap globals once, and assert their completion through `assertCompletedReservation`. Verify inventory cardinality and exact expected token kinds. **B is the sole publisher of its inventoried `memory` and any admitted arena lifecycle exports**, via `tx.defineExport` inside this function after all B-owned prerequisites are complete and while still filling. A does not publish these target exports. All export names/kinds/targets were inventoried in the plan before freeze; reserve does not call `defineExport`. B records every resulting export against its intent and prevents duplicate publication. Existing default options have no lifecycle exports; a future permitted `__arena_reset`/`__arena_used` request needs the real canonical bodies and admitted option contract, otherwise it remains a pre-reservation refusal. This plan does not broaden lifecycle admission.
5. **`requireCompletedPreparedLinearMemory(tx, pack)` — A calls before sealing.** Recheck the guard, every owned function/global completion, full memory/type/function/global/export inventory, exact support ownership and publication reconciliation. It validates; it does not publish exports, freeze, seal or complete A's source/startup resources. It is read-only/idempotent during the live attempt after a successful fill; it cannot rehabilitate a failed pack. After overall failure or completion, the guard rejects further use. Any read-only emitted receipt API remains A's existing post-emission observation path over ledger completion, not this mutable target API.

A pack being filled or verified does not end the whole attempt: its already-created bindings remain usable by subsequent primary lowering while A's guard is active. B tracks reserved, bindings-ready, filled/exports-published and verified milestones for single-fill/publication rules; failure is terminal. A's completed/failed state revokes every milestone uniformly. Do not conflate successful provider completion with whole-program completion or reject legitimate body lowering after provider fill.

A continues to publish ordinary source ABI exports and startup exports with its existing narrow functions, then seals exactly once after all target/primary/startup completion checks. During planning A checks the union of B target export intents and ordinary/startup intents for duplicate external names and conflicting owners. A records B intents for collision/currentness checking only; it never copies them into a second publication loop. B's target exports may already exist in the **private unreturned** module when later source lowering fails. That is not successful publication to a user: the failed module is abandoned, no emitted observation/capability/binary is returned, and no retry occurs.

The terminal state belongs to A's existing private `AcceptanceRecord` (or a private per-record attempt field in the same module), with a monotone transition:

`accepted → emitting → completed` or `accepted → emitting → failed`.

Keep the existing authenticity/one-shot `emissions` check and set it **before** any materialization work or emission-started observer. Add only the whole-attempt gap that the ledger cannot observe. The implementation skeleton is deliberately inside the current consumer, not a second orchestrator:

```ts
// After authentic-plan lookup and existing one-shot rejection:
emissions.add(accepted);
record.emissionState = "emitting";
const assertEmissionActive = () => {
  // Recheck record/plan/projection identity and state; throw on any mismatch.
};
try {
  observePreparedIrProgram(/* existing emission-started payload */);
  const result = materializePhysicalProgram(accepted, plan, assertEmissionActive);
  // Materialization has completed all packs, reconciled receipts and sealed.
  assertEmissionActive();
  observePreparedIrProgram(/* existing emitted payload */);
  record.emissionState = "completed";
  return result;
} catch (error) {
  record.emissionState = "failed";
  // Preserve typed invariant or wrap in existing emission-failed invariant.
  throw existingEmissionFailure(error);
} finally {
  if (record.emissionState === "emitting") record.emissionState = "failed";
  // Do not clear the one-shot mark, expose the module, or retry.
}
```

The skeleton names `existingEmissionFailure` descriptively; do not add an unused exported wrapper. Use the existing typed-error propagation and `emissionFailed` behavior. Success observation remains the sole successful event after sealing/reconciliation. Observer failure is terminal and no result is returned; observers are not authority to revive the attempt. The finally branch covers exits that forgot an explicit terminal transition. The guard is inactive on completion as well as failure, so captured target bindings cannot be reused after a successful return either.

B wraps its own reserve/bind/fill/completion implementation failures to mark the corresponding private plan-use/pack record failed before rethrowing, without inventing a public kernel failure setter. A's catch then fails the complete accepted attempt even when the exception arose during provider construction **before `fillFunction` was called**, or later in common source lowering, startup, exports, reconciliation, sealing or observation. Subsequent B calls and previously returned bindings fail via the pack state or A's guard. A's common error does not need to mutate a B-private field: the dead guard revokes every B operation in that attempt. No raw module/packs escape in a public receipt. This explicitly covers both the ledger-latched failures it already detects and ordinary JavaScript construction exceptions it cannot see.

### R5. Narrow real callers and provider ownership

The public route and genuine source requirement remain exactly those in the original plan. No caller bypass, new backend orchestrator, dummy B module or legacy overlay substitute is allowed.

| Existing A join | Required concrete edit and limitation |
| --- | --- |
| `program-consumer.ts::acceptPreparedIrProgram` | Validate strict DATA and authentic selected projection first; keep the exact supported target plan/private acceptance relation, never a boolean bypass. |
| `program-physical-plan.ts::planPhysicalSetup` and its `physicalSignatureConverter` | Call B plan before vector/signature planning; branch explicitly by backend. Store snapshot/requirements DATA in a distinct Linear arm; do not reinterpret GC `vectors`. Convert logical f64 vec ABI/internal types to checked i32 carriers without reservation indices. Refuse residual demand before any ledger. |
| `program-consumer.ts::prepareNativeEmission` | Recheck exact facts/module/selected-support/demand/options/target-plan currentness from detached evidence before resource reservation, using existing private record identity. A newly issued descriptive plan cannot replace the recorded plan just because its fields compare equal. |
| `program-consumer.ts::materializePhysicalProgram` | Retain existing common slot/ABI ownership. In the Linear arm reserve all accepted imports first, then B resources with A's guard, then ordinary/startup resources; freeze once. Do not run GC vector foundation/helper reservations on Linear demand. Keep existing GC branch order/behavior unless its holder separately approves a necessary common hunk. |
| Same function plus `physicalSignatureConverter`/`physicalBodyResolver` | Obtain B bindings after freeze; compose with A function/global binding maps. Add exact B-owned helper tokens to the support-function census; reject overlap with source slots or S's resources. Keep S's actual independent provider contract and exception semantics. |
| `fillPrimaryBody → program-native-invocation.ts::fillPreparedPrimaryUnit` | Pass concrete emitter/converter/resolver configuration from the accepted backend arm. Construct resource-backed `LinearEmitter({resolveRuntimeOperation: ...})`; retain original function object, unit/slot/signature comparison and completion accounting. GC stays on its existing emitter path. |
| `lower-generic.ts::resolveVecType`, `lowerIrTypeToValType`, `ensureVecDataScratch` | Use the same admitted logical representation for outer signatures and internal construction/get/set/length/local types. Linear uses i32 value/data scratch and f64 payload; GC uses its actual nullable data array/type identity. Cache by actual representation/layout identity. No `as` cast to fake GC handles, post-emission local patching, default i32 on missing layout or hidden GP/GC representation fallback. |
| Materialization's fill/completion/publication tail | Fill B pack once, then original primary/startup paths; invoke B completion and common completion/reconciliation while live, publish only each owner's intents, and seal once. S/common failure terminates the same A attempt and revokes B bindings. |

The first native capability accepts genuine layout-free logical f64 vectors with proven source admission. A persisted GC `type.layout` in that Linear path is refused, never silently stripped or reinterpreted. The proposed optional logical-vector representation seam is implemented once in the actual resolver/type contracts and shared by the inner and outer lowerers; absence is a capability failure, not a reason to try GC/GP fallback. Enumerate all existing resolver/emitter producers, consumers and scratch mutators before changing their handle union, and qualify unchanged GC controls.

Provider source ownership is concrete and remains conditional:

| Provider/body | Exact source responsibility and endpoint requirement |
| --- | --- |
| Default bump memory/global/`__malloc` | Actual Allocator4540 holder owns `runtime.ts::addRuntime` extraction. Requested new leaf `src/codegen-linear/runtime/arena-allocation.ts` contains canonical fresh default bump body/resource-description construction used by both direct `addRuntime` and B fill. Root records holder acknowledgement and exact functions before any file exists. Preserve original nondefault branches; no allocator redesign. |
| `__arr_new` | B must first identify its retained `runtime/array-allocation.ts` exact published commit and live caller from other checkpoints. If usable, adopt that canonical leaf under its actual holder; otherwise the array/runtime holder must explicitly release extraction of `runtime.ts::addArrayRuntime`'s existing constructor into that named leaf. Do not create a second leaf/algorithm because it is absent from two inspected heads. |
| `__arr_resolve` | Actual vector/array holder owns `runtime.ts::ensureArrayResolveRuntime` extraction into requested `src/codegen-linear/runtime/array-forwarding.ts`, fresh body construction called by both the retained registration callback and B fill. Shared forwarding geometry must remain identical. |
| `__linear_ir_vec_init_f64` | B's existing `runtime/vector-initialization.ts::buildLinearF64VectorInitializationBody`; preserve its live `addLinearIrVecRuntime` caller, exact value-first ABI and fresh instruction objects; rewire geometry imports only after A-G's exact source endpoint. |
| Optional arena lifecycle bodies | Not admitted by this initial default capability. If a previously supported public option must be included, the Allocator4540 holder must add the exact `addArenaManagementExports` body extraction to `arena-allocation.ts`, and B must bind its accepted requirements before admission. No automatic release or additional runtime helper path follows from this paragraph. |
| ReferenceError/TDZ/startup | Existing S owner supplies real reviewed resource contract and source. B does not allocate a competing memory/global/provider pack for it. A must unify explicitly shared resources through the agreed ledger tokens or refuse the conflicting contract before reservation. |

Runtime leaves consume zero-import shared geometry plus direct Wasm model instruction/type contracts. They do not import A's semantic planner, compiler contexts or B's transaction module. The old direct registration owner and B's fill caller use the **same body builder**, with explicit dependency indices supplied after the respective caller's indices are valid. A third-party source import dependency cannot be satisfied by copying bytes or invoking a raw-module registration routine on a ledger-owned module. Any unexpected transitive provider/path needs another exact bounded holder acknowledgement before implementation.

### R6. Finite successor checks without replacing original evidence

All original F/G/V plans, tests, negative controls, fixtures, failure receipts and denominators remain. In particular: A1's original 49 rows and its six ReferenceError/TDZ failures; A2's original 18 rows and original 17/18 receipt plus separately planned 13 addendum rows; G's planned 24 rows; V's planned 48 rows; B's unchanged 17 scalar controls and its published current-main 24 pass/1 fail/25 population. An appendix is not a runtime result. Do not relabel any original refusal assertion into a success or silently fold new rows into an old denominator.

Freeze one additional **16-row refinement cohort R01–R16** before execution, using genuine captured/prepared source for integration cases and clearly labeled unit transactions for API abuse cases. This cohort is planned and unexecuted; mutation subcells do not enlarge its authored row count. Pair every rejection instrument with a real accepted/live positive so silent zero collection or unobserved calls cannot appear green.

1. R01: required genuine public numeric source reaches the native route despite canonical catalogue grow; snapshot retains the grow entry and actual demand has none.
2. R02: actual source grow/resizing demand is a located pre-reservation refusal; no helper existence can admit it.
3. R03: canonical default allocator memory growth remains a provider implementation dependency, not vector growth admission; preserve actual direct/candidate behavior.
4. R04: read-only vector demand still requires the real forwarding token/provider; missing binding fails with a nonzero healthy read control.
5. R05: authenticated selected primary/support module view matches original facts without filtering; assert declarations, exact owner/IDs, nested/async-state census and support population even when support is unsupported.
6. R06: missing/extra/moved-owner facts and selected-body mismatch subcells fail before reservations, preserving aliases/retired IDs and explicit undefined metadata.
7. R07: unsupported allocating semantic support is counted and located, not omitted; physical helper support does not counterfeit a source unit/fact.
8. R08: canonical snapshot roundtrip/currentness and private indexed-plan separation; serialized/cloned plan cannot act as an issued plan/acceptance.
9. R09: import-offset plus exact provider transitive closure/signatures; validate genuine final calls and actual memory, not only module validity.
10. R10: exports inventoried before freeze, defined exactly once by B during fill after B resource completion, collision with A startup/source intent refused before reserve.
11. R11: injected provider builder throw before its first ledger fill latches B failure and A failed state; original acceptance retry and captured binding/completion calls fail, with zero emitted success/result.
12. R12: later A primary/startup/reconciliation error revokes already-returned B bindings and any partially filled private module; no legacy retry, emitted result or later publication.
13. R13: completion and sealed-success paths make captured bindings unusable after A returns; ordinary emitted receipts remain valid read-only observations.
14. R14: empty scalar demand reserves no synthetic vector pack; empty vector construction still gets the real initializer binding currently looked up by the emitter.
15. R15: same logical vector representation drives signature, nested operations and i32 scratch; genuine GC vector controls retain exact GC scratch/type identity; incompatible persisted GC layout is refused in Linear.
16. R16: source-free decode/reauthenticate/plan/emit with a positive observer proves zero frontend/encoding/ownership/escape execution and complete source/support/provider/ledger census.

The original V runtime-input acceptance remains decisive: real public `compile` and `compileAsync`, explicit Linear standalone and WASI, unchanged source `const values = [a, b]; return values[0] + values[1] + values.length;`, executed Wasm `run(1.5, -2.25) === 1.25`, preserved allocation and source owner, real allocator/initializer/forwarder call-through and exact prepared → accepted → emission-started → emitted trace. Compare independent JavaScript and retained direct Linear controls with exact options. Validate headers, payload order, adjacent/fresh/repeated allocation behavior and actual heap delta. No constant-folded/no-allocation substitute, `var` rewrite for lexical startup, fabricated IR positive, overlay execution or idle target module qualifies.

Retain all V pre-reservation unsupported controls: JS-host SOURCE and PROGRAM, public array ABI, unsupported elements/growth/custom allocator/lifecycle/linked memory and allocating support; all V reservation controls for namesakes, missing/foreign/unfilled/duplicate tokens, replay and cross-transaction misuse. Keep original surrogate, source-map, optimization and historical geometry/forwarding proof obligations. The 93-byte forwarding successor and old proof reader pins must still be handled by their actual owners, with inverse/forward exact-byte checks and unchanged mutants; this contract does not reseal evidence.

Root freezes exact source/test/config/tool/runner operands, executes stock approved validation, reports collected/executed/pass/fail/skip/filter/error counts, and keeps all red evidence. Required typecheck includes selected tests. Run normal boundary/import-cycle/dead-export/budget/oracle gates with the real baseline/merge-preview base, source closure positive controls and required preservation/equivalence suites. No hidden source budget allowance, skipped hooks, namespace deletion, stale receipt substitution or green result inferred from an unrun population.

### R7. Remaining acknowledgements and source endpoints

The B appendix is **conditional architecture acknowledgement only**. All ten named acknowledgement groups in the original issue remain; the following refines their exact remaining questions. Refresh actual claim/path custody before dispatch, without changing foreign records.

| Holder/dependency | Exact bounded acknowledgement still required |
| --- | --- |
| Allocation donor `3518:allocation-ownership-runtime`, `ttraenkler/codex-astra-allocation-ownership-20260908`, original write `34529-rzivb817` | Original A-F/geometry definitions and verifier release plus complete final semantic/support census, `LinearMemoryPlanSnapshot` DATA relocation and newly named pure `linear-memory-from-facts.ts` definitions/compatibility callers. Nothing outside those exact hunks transfers. |
| A2 `ttraenkler/codex-ir-native-linear-source-facts-sol61-20261008`, original write `16740-hhm82aur` | Exact R1 helper and preparation census ownership, strict-before-snapshot repair, disjoint same-file composition with geometry and pure planner extraction. Root must name the actual implementing owner for each new path. |
| Physical kernel `ttraenkler/codex-astra-physical-module-completion-20260908`, original write `19409-8ue0poec` | Confirm use of existing reserve/freeze/fill/defineExport/assertCompletedReservation/seal contract. No new abort API or kernel source release is requested by this refinement. |
| Vector `2956:l2-vec`, `ttraenkler/codex-l2-vec`, write not established in original record | Exact logical-vector handle/scratch/emitter/demand-walk boundaries, array/forwarder donor identity and any overlap with retained B leaves. Do not invent a write ID. |
| Allocator4540 `ttraenkler/claude-opus`, original write `12703-i71z8kda` | Refresh current holder; exact default `addRuntime` resource/body extraction and named `arena-allocation.ts` path, old/new real callers. Optional lifecycle remains separate until explicitly included. |
| B canonical prepared-memory owner and B's named current implementer | Acknowledge R1/R2 DATA inputs, B-owned `contracts.ts` and `memory.ts`, sole target-export publication in fill, new reserve liveness argument and post-attempt revocation, exact retained array/provider source endpoints. Earlier +97-line acknowledgement is not final agreement to the extra argument. |
| A1/S/shared-contract holders and root-assigned A-C implementer | Exact source/function hunk releases, private A attempt state, emission observer try/catch boundary, actual S provider/resource contract, collision/shared-resource ownership and lower-contracts dirty-hunk coordination. Existing S/A1 work is not taken over. |
| Historical source proof `ttraenkler/codex-lowering-analysis-source-proof-20261004`, write `54017-blpvz0m8`; trusted adapters `ttraenkler/codex-lowering-analysis-trusted-adapters-20261004`, write `76271-0mo0ncgo`; policy callers `ttraenkler/codex-lowering-analysis-policy-callers-20261004`, write `75863-k6ti87wv` | Original forwarding/geometry successor, source views, instrument-history authentication and both pre-pin caller joins. New pure planner relocation must be included if it changes an actual pinned/closure operand; do not guess successor hashes before source exists. |

Required coherent source packet remains missing in the evidence read here. Root's delivery table must name exact reviewed commits and tested call-through for: A1 public policy/caller; S ReferenceError/TDZ/startup; A-F strict facts plus the canonical module/support join and pure planner; A-G common geometry; actual R allocator/array/forwarder bodies; A-C planning/signature/body/scratch/failure-state integration; B-M target pack; registry and affected historical reader successors. B's existing initializer source endpoint is a reusable ingredient, not that packet. An absent leaf in the two inspected heads stays an unresolved endpoint request, never permission to replace a donor's work.

### Bounded handoff to B after root adoption

Please acknowledge this exact refinement, particularly the new reserve guard argument and its private A-owned lifecycle, B-only target export publication inside fill, unchanged catalogue versus executable-demand separation, and A-authenticated complete module/facts/support join. Confirm the actual B holder for `src/backend/linear/program/{contracts,memory}.ts` and supply exact retained array-allocation/provider leaf commit/path/caller endpoints where not present in main845 or PR6577's acknowledgement head. This asks for contract/source dependency identification; it does not authorize implementation, foreign edits, donor releases or queue action.

A will supply one coherently reviewed source packet with the real named callers and the original value/memory/source-free/negative-control evidence. B then implements its agreed target pack against those exact interfaces under its own bounded release. Root alone composes shared files, registers modules, publishes source and submits the protected queue. All HOLDs remain until normal independent review and the qualified source packet permit release.

The target is full native IR coverage and eventual direct-front-end retirement after full native IR equivalence. The first numeric-vector capability is an increment, never a narrowed definition of completion. Legacy stays; JS-host SOURCE/PROGRAM stays unsupported; Unicode, optimizer, source-map, lossless surrogate and wider native-scope obligations remain open until their real source and complete acceptance are delivered. No full migration, equivalence, source completion or main delivery follows from this planning appendix.

Root has read the complete Astra High refinement at SHA256 df59813e44deab73be01a4479064c71c6e4e9040c91d1dbb89468af63aa1807a and adopts it as the next A/B contract proposal. B still must acknowledge the new reserve lifetime argument, target export owner and named helper paths. This publication authorizes only the issue6920 documentation append under existing publication claim69561-xdcvftgg; no source, foreign claim, guard/receipt rewrite, HOLD release or queue admission. The required coherent tested source packet and named donor releases remain absent; migration and main delivery are not claimed.

## Implementation staging clarification and canonical runtime reuse — 2026-10-09

This append-only clarification separates **B-M implementation entry** from **composed native-vector acceptance** under issue 6920, **Native Linear numeric-vector shared source handoff and integration plan**. It resolves the wording identified in B's [staging request](https://github.com/loopdive/js2/pull/6583#issuecomment-6069937081); it does not relax implementation prerequisites or acceptance. The exact published plan read was PR6596 head `68c64ccced9122bffcb482f649d3091cc599af61`, 97,935 bytes, SHA256 `e5f5329a3aec835d40f4438642477aa2a078583b39370709f062601bf5f5eb1f`. Its complete prior plan/refinement text is unchanged from the previously read private combined plan, followed only by root's adoption paragraph, which was also read. Root adoption/publication of this new clarification is pending.

### Gate 1: release B-M implementation entry

Root may release the accountable B owner to implement the target pack only when it records all of these prerequisites with exact reviewed source endpoints, file/function custody and applicable bounded proof:

1. **A-F:** strict authenticated module/facts/support join and clean facts-only planner, preserving full original registry, exact selected owner/ID census and canonical provenance checks. An early descriptor-screen-only increment or a still-reanalyzing validator does not satisfy this dependency.
2. **A-G:** usable shared geometry source, exact donor/A2 partition and named historical proof/reader releases. Retain their required endpoint/proof obligations; a proposed geometry schema or an unacknowledged source move is insufficient.
3. **A-C input contracts:** checked executable demand separated from the canonical operation catalogue, agreed logical representation/carrier/scratch/type contracts, and the adopted five-function target contract including `reservePreparedLinearMemory(tx, plan, assertEmissionActive)`. Record exact source/type endpoints; do not substitute an unchecked interface or fake GC/GP representation.
4. **Runtime donors:** canonical reservation-compatible allocator/complete array-constructor bodies and their true transitive dependencies, together with the existing initializer and forwarding builder identified below. Arithmetic fragments alone do not satisfy a complete provider dependency. Keep actual direct callers and their qualification; no copied body, raw-module adoption or guessed index.
5. **S and ownership:** reviewed shared-resource/startup/ReferenceError contract that identifies actual owners and how memory, globals, exception resources and provider tokens join without competing ownership. Record the exact A-C/B-M implementing holders and all required lower-contracts/vector/runtime/donor releases. A contract acknowledgment does not release a held path.
6. **Concrete A-C caller packet:** a reviewed callsite patch/design naming actual `planPhysicalSetup`, `materializePhysicalProgram`, signature/body resolution, `fillPrimaryBody → fillPreparedPrimaryUnit`, representation/scratch seams and whole-attempt lifetime wiring. It must agree with B on arguments, phases, resource ownership and failure behavior. A-C need not already execute the complete vector with the B-M implementation that this gate is about to authorize.

B-M's own finished source and the final public `1.25` result are **not prerequisites for creating B-M**. Gate 1 is reached only by a root-recorded bounded implementation release against the prerequisites above; this appendix itself releases no worker, source path or claim. Missing prerequisite source remains missing. A-C and B-M may then develop together in isolated, explicitly coordinated worktrees against those fixed endpoints. A-C owns common callers and B owns exactly `src/backend/linear/program/contracts.ts` and `memory.ts` under its recorded holder; neither edits the other's files without a separate bounded handoff. Root composes the real implementations and tests the combination before landing either as native-vector support.

A reviewed A-C patch referencing pending B code is a **dependency patch**, not delivered executable support. A B implementation awaiting the shared caller is likewise an integration candidate. Neither can be independently landed as an uncalled facade or advertised as delivered native support; no dummy provider, permissive stub, legacy overlay result or incomplete dependency graph counts. Separately publishable prerequisites may retain their own genuinely exercised narrow capability, as the original plan already permits.

### Gate 2: accept and deliver the composed native-vector source handoff

The final packet includes **B-M**, composed with A-C, A1/S, A-F, A-G, canonical runtime donors, registry and required historical successors at one frozen, coherently reviewed source head. All original acceptance remains: genuine public `compile` and `compileAsync` for Linear standalone and WASI execute the unchanged runtime-input vector fixture with `run(1.5, -2.25) === 1.25`; actual source/allocation/provider/ledger ownership and memory observations agree; codec replay is source-free; refusal, one-shot lifetime, post-failure/post-completion revocation and export-owner/phase controls hold. Preserve every original F/G/V/R cohort, original red evidence and denominators, canonical provenance, geometry/forwarding historical proofs, normal gates and independent review. Root owns protected delivery and reports implementation qualification separately from actual landing. All HOLDs stay until root's existing protected-delivery conditions permit release.

Thus the original **“Dependency DAG and next safe implementer scopes”** (lines 471–474 at the exact read) remains the development rule. **“Exact delivery packet and acceptance”** (lines 662–665 and its complete list), R7's coherent source packet and the **“Bounded handoff to B after root adoption”** sentence at line 944 describe **Gate 2**, not B-M implementation entry. Replace their ambiguous meaning of “B is unblocked” with “the composed native-vector source handoff is accepted”; Gate 1 above is the separate permission to implement. In the line-944 sequence, A supplies the reviewed prerequisite/caller packet first, A-C and B-M then implement and compose, and only the combined packet can supply final caller/value/replay evidence. B may mirror these two gates in issue 6905's lines 769–772; this task edits no B document. No final source packet may omit B-M, and no Gate 1 prerequisite may require B-M to have already completed itself.

### Canonical reuse correction and acknowledged boundary

B's [bounded acknowledgement and endpoint correction](https://github.com/loopdive/js2/pull/6583#issuecomment-6069750069), also read in issue 6905 at PR6577 commit `27e7b3ea47962ebc1899fc47571da47f4230716a`, acknowledges the revised reserve guard, A-owned attempt lifetime, B-only target export publication during filling, complete module/facts/support join and exactly the two B paths above. The documented accountable holder is `ttraenkler/codex-linear-b-prepared-memory-20261007`, write `64168-17jzm5kj`. This satisfies the named **conditional architectural acknowledgement**, including the extra reserve argument; it does not establish donor release, implementation entry or tested source acceptance. Refresh custody normally before any implementation; this planning task mutates no claim.

| Required ingredient | Exact verified endpoint and correction |
| --- | --- |
| Forwarding resolver | Reuse `src/codegen-linear/runtime/arrays/forwarding-resolver.ts::buildArrayForwardingResolverBody` from PR6590 `75c98267d4aabba2f78238f292e0e7c2eb6554f3` in `loopdive/js2` (B records introducing commit `cea128a3b1c25eb15f62bf3cabb5dc97b9643ccb`). The complete builder and actual `runtime.ts::ensureArrayResolveRuntime` caller were read at that endpoint; the caller passes `LINEAR_ARRAY_FORWARDING`. This **supersedes R5's proposed new `runtime/array-forwarding.ts` extraction**. Do not create that duplicate path/body. Holder `ttraenkler/codex-linear-b-forwarding-sol61-20261007`, write `65589-oamjn90s`, remains held; reuse its reviewed endpoint with agreed dependency custody, without concurrent edits or takeover. |
| Array arithmetic | PR6572 fork `ttraenkler/js2` at `76b8a02dca23c8e974661b55fdeaeae38b898d9d` supplies `runtime/array-allocation.ts::checkedArrayAllocationSize` and `checkedArrayCapacityDoubling`. Complete fragments and real `runtime.ts::addArrayRuntime` uses were read: constructor uses checked size, growth uses checked doubling and size. These are arithmetic fragments, **not** a complete `__arr_new` resource/body factory. Reuse them in the actual holder-reviewed constructor endpoint; complete reservation-compatible constructor/allocator source is still required. Keeping old direct growth code correct does not admit source vector growth. |
| Initializer and geometry | Retain B's published `runtime/vector-initialization.ts::buildLinearF64VectorInitializationBody` and genuine `addLinearIrVecRuntime` caller. The prior exact read and B's acknowledgement retain its value-first ABI/fresh instructions. Array and initializer geometry rewires still await A-G's reviewed source and holder release. No extra helper ownership follows. |

The earlier observation that `array-allocation.ts` was absent from main845 and the inspected PR6577 head remains a correct two-endpoint fact; the PR6572 endpoint now resolves its location and precise limited role. It never implied that B's retained work was missing everywhere. R5's complete allocator/constructor reuse obligation remains; its forwarding extraction request is replaced by the existing canonical builder above. No other source or proof extraction is authorized here.

All original failures, fixtures, claim records, tests, proofs, lifetime rules, replay requirements, JS-host SOURCE/PROGRAM refusals and legacy/full-retirement scope remain unchanged. Full native IR equivalence is still required before direct-front-end retirement; a staged numeric-vector increment does not redefine completion. This planning task performed read-only endpoint/source inspection and private documentation only: no compiler/runtime/tests, source edit, claim release, external comment, commit, push or queue action. B should mirror these exact stage names after root adopts the clarification; neither side may infer that Gate 1 or Gate 2 has been met from this document alone.
Root has read the complete Astra High staging and canonical-reuse addendum at SHA256 95eb77bd8679ab9c31ab705f24b8ea2118bab97fbf576ddf14ad72b0efb2adae and adopts both staging gates: Gate 1 releases B-M implementation entry only after its exact prerequisites and bounded root release; Gate 2 accepts and delivers only the composed native-vector source handoff with complete original evidence. Neither gate is met. This adoption retains the canonical forwarding-builder reuse correction and the limited arithmetic-fragment role. Publication is authorized only under existing issue6920 documentation claim69561-xdcvftgg; it grants no source release, implementation acceptance, HOLD release, queue admission, migration completion or main delivery.

## 2026-10-09 frozen geometry packet exchange with Session C

Root reviewed the exact packet and released this append-only publication hunk; source continuation remains paused. Documentary packet `plan/log/6920-shared-linear-geometry-20261009/{README.md,source.patch,tests.patch,boundaries.patch,manifest.json}` preserves the FROZEN UNCOMMITTED candidate on exact donor8452732f0b88c14c5c7634ece58f83240970ea4c, following Session C reported human assignment comment6070849011 and root concrete exchange request comment6070860783. Metadata slice6920:geometry-packet-publication-20261009 effect-read owner ttraenkler/codex-sol-geometry-packet-publication-20261009, write7437-e9y1gc57, in-progress. Source claim94949-it9b3u84 and every foreign record remain unchanged; no transfer or continuation release follows.

Exact source patch19675 bytes/SHA256759889320f82a2761961b9af3d74a9c7d840e909c4292826863ce15a5abf4901; tests16656 bytes/SHA256edcea62258f8f16712b6f826dfc3c695ce46cf6289568e1858435bd6c5e2117e; root policy diff isolated: observed foundation.entries append plus minModules9→10 only; foundation inventory files-row absent, final three-field registration remains root-owned follow-up. All five frozen files and tool pins were checked before/after replay; independently specified24 names match authored literals. Original19595-byte predecessor SHA25685aa3efab25d7a459be3947ab0533e06663df54bfaacb382851309261d52e43d is independently verified preserved. Original patches omit new-file mode headers, so git apply --check rejected dev/null; unchanged patches pass POSIX patch dry-run/apply on the exact donor archive and all five resulting hashes match. Manifest records exact preimages, commands and hashes.

README retains first TypeScript5 OOM,4096MiB retry and duplicated-test-report correction; actual source/type/format/lint evidence remains source-worker static evidence. G24/runtime NOT RUN; authored24 is not collected/pass24; graph OPEN/strict modeled closure FAIL, historical source/proof-policy failures and obligations remain;0main merges. Root's adopted34529 custody correction is retained without foreign release. New metadata/patch counts are not implementation. Root retains integration, publication/runtime authority and protected queue; PR6596 HOLD remains. No native1.25, coherent vector acceptance, delivery, migration or queue qualification follows.


## Root adoption: generic allocation-evidence implementation — 2026-10-09

Root reviewed the complete latest Astra High plan53804 bytes/SHA256732230641a59642bc4b835492a1ffcc1c8c2029a6e987bf5e4ed859f59d9753e and its exact22 standalone/18 ROOT stage matrix. This adoption preserves all40 obligations and full IR migration/equality/legacy-retention requirements. First release is implementation of the new generic IrModule+AllocRegistrySnapshot endpoint only, not a completed native consumer or general witness.

Fresh actual canonical main/base8452732f0b88c14c5c7634ece58f83240970ea4c. Source branchcodex/6920-allocation-evidence-checker-20261009 under owner ttraenkler/codex-sol-allocation-evidence-checker-20261009, actual upstream write19199-2n2yketq; claim was effect-read before adoption. Source owner owns exactly src/ir/analysis/allocation-evidence/{contracts,effect-rules,census,metadata,verify}.ts. This explicitly expands the earlier three-file suggestion to five cohesive modules. Root alone updates this issue adoption text. Test/fixture authoring gets a separate exact claim and release. No existing A2/source/planner/codec/validation/native consumer, geometry, B/C leaf, workflow, policy or historical proof hunk is transferred. Canonical rule joins remain separately held, so new descriptors are not yet claimed shared.

The observed namespace mode is generic truth, not producer authentication; native completeness is a later root policy. Covered contradictory metadata must be invalid, unproved bodies not-covered, and all original contextual validity/provenance/support/projection obligations retained before native admission. No sourcefree dispatch may rely only on consistency. Source/test authoring and static no-emit checks are authorized; collection/runtime execution, commit/push/queue and existing-file wiring wait actual root review. Original fixtures/failures/proof receipts remain.

### Adopted implementation plan (verbatim bytes below)
## Implementation Plan — first generic allocation-evidence semantic endpoint

Implement a finite, body-derived semantic verifier in new `src/ir/analysis/allocation-evidence/` modules. This is the first staged endpoint toward full A-F; it does not replace the general IR witness, original F/G/V/R/E14 obligations, genuine public native standalone/WASI `run(1.5,-2.25)===1.25`, S/B resources or legacy retirement. Root must adopt this plan, assign the exact new paths and later existing-file joins before implementation. This private specification performs no source/test/issue/claim/runtime change. Geometry remains separately paused.

### Inputs and authoritative dependency state

Read the existing semantic design and its nested-if correction, plus Sol's actual API screen `/private/tmp/js2-6920-evidence-api-screen-20261009/API-RECOMMENDATION.txt` (27,030 bytes; SHA256 `98def20cb60cc6a4bec18e9d6e5caa4f467ad718751aa190f89db8532e169b4d`). A follow-up source review independently confirmed escape-only comparison, empty metadata-row legitimacy, and finite not-covered for live alias references. Its `source-inputs.json` pins39 actual/prepared-candidate/design inputs, SHA256 `dba9218a487cce2e1feaa1b62d1b0084447ec6d3ad2fc18bdadc8dc9ee6dea70`. Those exact saved preimages distinguish existing code from proposed A2 extraction; do not treat a private draft as installed.

Actual A2 `/private/tmp/js2-ir-native-linear-source-facts-20261008` retains memory-plan49,040/`5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52`, program/allocations6,602/`e2da59c2bf90e2a833c35206d014e6745f79a94bade7f04c882cdb6495eb7e5f`, attachment helper11,633/`ab303a1b801cf3248d53872c0f2df09b54c48f6eec798ec2e541663ac53c25cc`. The candidate program/allocations7,846/`51f232abc522f6c493b9ab88655e7fbc0873221504c1a0e9def9b673b7772a48` is not apply-ready: strict descriptor/attachment validation must precede snapshot reads and branch selection. Live validation still invokes allocation reconstruction/reanalysis before the late attachment check. Preserve the completed Phase1 thirteen-control receipt and original18 (17pass/1retained encoding-fixture failure); they are not this endpoint's results.

The actual saved first sample is under `/private/tmp/js2-6920-semantic-evidence-probe-20261009/runs/run-1791500133935-95306/`; there is no assumed latest symlink. Its healthy program V8 bytes9,314/SHA`e17410c15ac8770250a82f7c7ab05e786ff22de6a7f108d7852b6ddd8555ce97` and typed census11,440/SHA`0d58d97ab5158216211a397239679ccc2dcd131dacc592a429ae514db775f35e` were read in the adopted refinement. One semantic owner, support0, one Linear/standalone projection of that owner; root12+nested4=16 instruction occurrences, five buffers, five vector receiver uses. Counts describe each actual function view; checking semantic and projection gives two checked views of the same logical owner, not32 distinct semantic instructions. Two else constants are actual f64 NaN, not JSON null. The existing four-probe receipt stays separate: healthy accepted, fact-only mismatch rejected, coordinated forgery passes the old pure consistency check, retained full legacy validator rejects it. Current retained validation is not claimed vulnerable.

### New file ownership, API and dependencies

Propose these **five new implementation paths**, all under one root-assigned source claim, and two new suites under a separate named test owner. The first release assigns only the standalone suite; the later ROOT suite and any binary fixture require their own exact path assignment. No absent path is free by implication. Suggested review budgets are at most250 nonblank lines per new implementation module and60 per function; obey stricter normal repository limits and claim total LOC before dispatch, with no allowance inferred here. Split responsibilities instead of suppressing normal size/LOC/dead-export/boundary gates.

| New module | Responsibility / public surface |
| --- | --- |
| `contracts.ts` | Type-only nonserialized result, reason and location unions; no PreparedIrProgram/runtime/provider imports. |
| `effect-rules.ts` | Exact finite instruction effect descriptors reused by legacy analysis and checker. Export `allocationEvidenceEffect(instr)`; no registry/scheduler. |
| `census.ts` | Private occurrence-aware lexical/root-definition index and exhaustive finite grammar/use check, using canonical core traversal/operand authority. |
| `metadata.ts` | Private global namespace mode, indexed exact presence/value comparison against body-derived expectations and full snapshot denominator. |
| `verify.ts` | Sole public consumer `verifyAllocationEvidence(module, registry)`; orchestrates census/comparison and returns the closed result. |

Concrete generic signature, using existing canonical `analysis/contracts/allocations.ts` DATA without any Linear facts/geometry import:

```ts
export function verifyAllocationEvidence(
  module: IrModule,
  registry: AllocRegistrySnapshot,
): AllocationEvidenceCheck;

type AllocationEvidenceCheck =
  | { readonly kind: "verified";
      readonly profile: "single-block-numeric-vector-if-v1";
      readonly namespaces: AllocationEvidenceNamespaceMode;
      readonly census: AllocationEvidenceCensus }
  | { readonly kind: "not-covered";
      readonly reason: AllocationEvidenceCoverageReason;
      readonly at: AllocationEvidenceLocation }
  | { readonly kind: "invalid";
      readonly code: AllocationEvidenceMismatch;
      readonly at: AllocationEvidenceLocation };
```

Use a three-case result rather than an untyped throw or analysis-layer import of program/errors. `invalid` is an internal diagnostic, immediately mapped at the program boundary to existing `PreparedIrProgramInvariantError("invalid-prepared-data", detail)`; it is never passed to a backend as unsupported. `not-covered` is immediately mapped by required detached native admission to the existing located backendUnsupported result before planning/reservation. The generic accepted-data path keeps its canonical legacy validator for not-covered. A result is an ephemeral report on these exact screened immutable operands, not a new boolean authority, serialized attachment, token, cache or caller-supplied permission. Never use a result for a different module/registry pair.

`AllocationEvidenceCensus` is exactly `{functions,buffers,instructions,allocations,vectorReads,vectorWrites,registrySlots}` using nonnegative integer occurrence counts. Location is the closed union `module`, `{kind:"site",site:AllocSiteId}`, or `{kind:"instruction",unitId:IrUnitId,block:IrBlockId,root:number,arms:readonly {arm:"then"|"else",index:number}[],site?:IrSiteId}`. Function-only exclusions use `{kind:"function",unitId}`. root/indices are positions, never SSA IDs, array offsets or Wasm indices; `site` is copied from the actual instruction descriptor if present, preserving absence/ownundefined in input. Diagnostics render deterministic owner/site/occurrence using the existing sourceMap/inventory, not function display-name lookup or invented source positions. Module/site errors remain located to the existing preparation owner when no instruction exists.

Closed not-covered reasons: `function-shape`, `instruction-kind`, `numeric-opcode`, `reference-carrier`, `nested-allocation`, `nonroot-receiver`, `allocation-alias`, `async-domain`, `resource-limit`. Invalid codes: `namespace-presence`, `namespace-value`, `unused-site-evidence`, `noncanonical-ownership-marker`, `occurrence-mismatch`, `lexical-definition`, `allocation-provenance`, `site-result-type`. Canonical descriptor/closed-schema/SSA/type errors remain their established earlier diagnostics; do not replace all failures with these new codes. A future string/CFG/witness extension requires an explicit reviewed domain/version, not a default-success arm.

The module/registry API deliberately does not accept prepared controls, callbacks, supplied namespace mode or arbitrary owner subsets. Its boundary precondition is a descriptor-screened, structurally/contextually validated actual original-module view and complete snapshot. The root adapter must establish this before **every** entry, including direct physical calls; TypeScript typing is not validation of unknown DATA. This leaf is not a replacement closed-schema validator. Root retains canonical snapshot/provenance/type validation outside this leaf; no duplicate schema parser, `as unknown as` validity shortcut, descriptor getter or opaque class method is introduced.

The generic leaf imports `AllocRegistrySnapshot` from the EXISTING `analysis/contracts/allocations.ts`, core DATA/traversal/operand types, the canonical ALLOC_NAMESPACES owner and canonical lattice AccessSet order only. It does not import LinearPreparedAllocationFacts, either A2 proposed facts leaf, memory-plan, program/errors or prepared program. The endpoint can be authored independently on canonical845 in a new isolated slice. Facts consistency is not removed: the later ROOT adapter must call A2's separately released `verifyLinearPreparedAllocationFacts` and exact snapshot/attachment equality on the same operands, including the direct fact.encoding correction. Forged direct facts or evidence-presence copies still fail there even when registry truth is correct.

A2's proposed DATA/pure-facts/provenance extraction remains a CONSUMER-WIRING dependency, not a dependency of these new generic source files. Its `canonicalSiteFromSnapshot`, `canonicalIndexFromSnapshot`, `metadataValue`, `sameDetachedValue` and lookup-based final-provenance authority must have one canonical owner; the new leaf does not copy them. Its private snapshot index simply retains exact entries by their original integer index and exact metadata by id/namespace. A covered allocation reference must name a direct live slot; other canonically valid alias references are not-covered. Canonical broken/cyclic aliases and missing IDs are invalidated by the required pure provenance gate before capability admission. Thus the leaf needs no alias resolver or mutable registry reconstruction.

For `unknown` metadata values, compare finite semantic shapes through own DATA descriptors: exact keys state/ops for ownership, classification/stackAllocatable for escape; inspect descriptors and types before accessing values. Require the canonical ordered string array, exact own property presence and expected primitive values. This is a body-result comparison, not another general DATA schema validator or copied deep-equality library. Expected absence tests map.has, not map.get alone. Preserve canonical allowance for empty metadata rows. Descriptor-only metadata inspection does not excuse bypassing the earlier whole-program screen/context/provenance gates.

The existing allocation-bearing collector/collectValueTypes is insufficient for this census: it misses alloc-less required instructions, carries display names rather than unit/occurrence, and a flattened map does not prove lexical dominance. No frontend/ts-api/IR facade/program/producer/physical planner import is allowed. The canonical namespace value currently lives beside AllocSiteRegistry; therefore zero constructor/execution is measured here, not a false claim of zero registry-owner module reachability. A stronger no-class-owner import boundary needs its own namespace-DATA extraction and custody, never copied strings.

Internal function plan (names proposed, no new public facade): `census.ts::captureAllocationEvidenceCensus(module)` orchestrates `visitProfileFunction`, `visitProfileBuffer` and `checkProfileOperands`; `metadata.ts::indexRegistryEvidence(registry)` builds original-slot/global-namespace indices once, and `compareRegistryEvidence(index,census)` performs exact requested-cell checks; `verify.ts::verifyAllocationEvidence` returns their first deterministic invalid/not-covered result or the verified report. Census and index types stay private to this directory, not serialized or producer-supplied. The public verified report contains counts and observed mode only, never physical locations, mutable registry, cloned facts or trusted callbacks. Error precedence is canonical invalid DATA/context/provenance first; for valid whole bodies outside grammar report first occurrence in canonical order; compare semantic cells only when the full admitted census is complete. Unexpected internal exceptions propagate as failures, never become verified or a generic Unsupported catch-all.

### Exact first profile and one-pass algorithm

Narrow the initial grammar to the **actual measured sample plus vec.set controls**. The previous designs' optional unary/select/slot support is deferred; do not implement an unproved broader whitelist just because it was mentioned. Regular functions have one block, empty blockArgs and blockArgTypes, only i32/f64 parameters and resultTypes, and a return with matching primitive values or unreachable. Existing validity gates check result arity/type. `funcKind` may be absent or regular; no asyncPlan, asyncRuntime, generatorBufferSlot, closureSubtype or active slots. Valid optional empty/undefined forms accepted by canonical validation may be not-covered rather than declared malformed by a new presence policy. The actual sample's fields are absent. All runtime attachment state domains must be inspected before narrowing PreparedIrFunction to core IrFunction.

Closed instruction grammar:

| Kind | Required independently checked operands/results |
| --- | --- |
| `const` | i32 or f64 result, canonical literal shape/type; retain NaN, infinities and signed zero exactly. |
| `binary` | only `i32.lt_u` with i32 operands/result, or `f64.add` with f64 operands/result. No reference identity or additional opcode inherits zero effect. |
| `vec.new_fixed` | ROOT ONLY, unique live array allocation ID, non-null vec<f64> result, f64 elementType/elements, canonical valid optional capacity; no allocation alias operand admitted by this finite profile. |
| `vec.get` | eligible earlier-root vector receiver, i32 index, f64 result. |
| `vec.len` | eligible receiver; integer:true yields i32, absent integer yields f64. Other canonical-valid but unproved optional forms are not-covered, not silently normalized. |
| `vec.set` | eligible receiver, i32 index, f64 newValue; preserve canonical null result/resultType shape and typed validation. |
| `if` | i32 condition; non-null i32/f64 result; exact then/else canonical buffers and arm-result values of the same primitive type in their respective scopes. Recurse the same grammar; no arm allocation. |

1. After existing descriptor/structural validation and pure registry/provenance checks, index all snapshot slots and metadata rows/namespaces once. Determine global requested namespace set as described below, independently of any target-fact defaults. Validate no duplicate IDs/rows/pairs or broken/cyclic alias graph through canonical authority. Do not reconstruct a registry. Preserve unused/aliased/retired slots and original IDs.
2. Walk every original function in order. Use canonical `forEachNestedBuffer` for child buffer population and `operandsOf` (the canonical direct-operand authority) for reference-use census; do not hand-maintain a second hidden-buffer table. For admitted `if`, match exactly the two callback buffers to then and else in order. Maintain an active buffer recursion-path set, not a global visited set; repeated siblings are occurrences and must encounter duplicate definitions. Use an explicit stack for bounded traversal, not unbounded JS recursion. Every function/block/root/arm gets a precise occurrence.
3. Maintain per-function definition/type/scope index keyed by exact IrValueId. Parameters precede roots. A root definition becomes visible after its inputs/arms; branch scopes inherit enclosing definitions, never sibling arm definitions. Each arm result can use a visible outer value or earlier definition from that arm, but not the other arm, the parent's result or a later root. Pop lexical bindings without copying whole maps per branch: record changes in a scope stack/undo list. A separate seen-definition set detects duplicate SSA IDs globally. The sole root-allocation map records defining root ordinal and type. Require a receiver's root index strictly precedes its containing root (including nested uses). A later/unknown definition violates SSA and must be canonically invalid; a valid parameter/alias/nested allocation receiver is outside this profile.
4. Complete operand census must establish every array reference use is solely get/set/len receiver. It cannot occur as numeric input, condition, element, newValue, if arm/result or return. Cross-check canonical operand enumeration with the closed role classifier, counting actual uses rather than skipping unknown ones. Required allocations without IDs remain detected by canonical final provenance, not merely a list of instructions already carrying alloc. Any other well-typed instruction/domain yields not-covered, without running numeric-only metadata truth checks on that unproved whole module.
5. Seed each root array's semantic expected ownership as owned/empty; accumulate get/len read and set write, using canonical AccessSet stable order (read,write). Both arms are visited regardless of constant condition. No CFG worklist, alias fixed point or registry call exists. Primitive-result if alias edges are acknowledged and checked to have only primitive endpoints; they are disconnected from arrays. Return of primitives and vec.set's primitive stored value can escape in legacy state without changing array state. Derive exact escape local/stackAllocatable:true and no stackCandidate ownership property. Encoding has no write for the admitted grammar; absence is proved from instruction domain, never UNKNOWN→ASCII.
6. After full profile census succeeds, compare **all globally requested namespace cells on all original snapshot slots**, including unused live slots, against derived canonical expected writes. For used arrays compare exact metadata objects and own presence; no optional-field default hides a missing state/ops or ownundefined. For unused live slots expected cells are absent, as a fresh legacy reconstruction receives no writes; a harmless empty metadata row is not newly forbidden if canonical DATA accepts it. Retired/alias metadata stays governed by canonical snapshot rules. Return verified with the exact observed namespace mode only after these comparisons pass. The later root adapter separately compares facts/evidence/direct fields through canonical A2 consistency; it must not write owned/local into missing facts. Only that adapter applies native evidence completeness and returns evidence-not-materialized Unsupported when required namespaces are unavailable.

This establishes the exact one-block result, not a safe overapproximation: legacy ownership processes the sole entry block once; roots seed before uses; nested effects visit then-before-else; primitive alias closure has no path to arrays; escape's ownership backstop remains local; encoding makes no registry write; arrays are outside the stack-candidate kinds. Forged conservative state/extra write/escape is still invalid because equality, not mere safety, is required.

Actual sample control: root vec.new_fixed v2/alloc0; root lengths at2,6,10, nested gets atroot4.then[0] androot8.then[0]; two ifs with NaN else constants; scalar bounds i32.lt_u and f64.add. Verify exactly16 occurrences/five buffers/five reads/zero writes/one allocation and exact metadata ownership{state:owned,ops:[read]}, escape{classification:local,stackAllocatable:true}, absent encoding and ownership stackCandidate. Direct fact stackCandidate=false is retained. Do not rewrite the sample or drop its branches to fit the grammar.

### Global namespace modes and absence are semantic obligations

Live `assertPreparedIrProgramAllocations` starts requestedNamespaces with encoding, unions namespaces across **all** snapshot metadata, then runs ownership on all semantic/support functions if either ownership or escape is requested, escape on all if escape is requested. Comparison iterates only the requested namespaces. In particular escape-only mode computes ownership internally but does not require a globally absent ownership namespace. There are no serialized controls to authenticate producer options; deleting every ownership/escape cell is indistinguishable from valid disabled generic preparation. Matching registry/fact/default copies never proves that an analysis ran.

Define `AllocationEvidenceNamespaceMode` as the four-string union `"encoding-only" | "ownership-only" | "escape-only" | "ownership-and-escape"`. This names actual global namespace materialization, not inferred controls or producer provenance. After the whole body domain and ordinary registry/provenance/type validity pass, the GENERIC verifier checks requested truth and returns verified plus this mode. The ROOT NATIVE adapter applies the last column only after target-facts consistency also passes:

| Actual global namespace presence | Required truth comparisons | Root native result for nonzero allocations |
| --- | --- | --- |
| neither ownership nor escape | encoding everywhere; any present encoding cell on this numeric domain is false | backendUnsupported/evidence-not-materialized; legitimate generic defaults escaped/[]/opaque are not rewritten or condemned |
| ownership only | encoding + ownership at EVERY site; used arrays require exact owned/access object, unused sites absent | backendUnsupported/evidence-not-materialized (escape globally unavailable) |
| escape only | encoding + escape at EVERY site; used arrays require local/true, unused sites absent; ownership state is derived internally for truth, not demanded as a globally absent serialized namespace | backendUnsupported/evidence-not-materialized (ownership globally unavailable) |
| ownership and escape | all three namespaces at EVERY site | eligible for the verified detached allocation-evidence branch only on exact derived values/presence |

Missing ownership on one used site when any other row names ownership is invalid namespace-presence, not a per-site disabled mode. Same for escape. Even an ownundefined pair activates its namespace; on a used array canonical output is an object, so ownundefined is invalid. A numeric array encoding pair with valueundefined is present versus expected absent and is invalid in ALL four modes. Missing whole attachment is the historical generic route and a native capability gap; ownundefined attachment is malformed DATA at the descriptor-first gate. Evidence `{present:false,value:undefined}` for absent encoding is valid, distinct from present namespaceundefined. Site/origin optional ownundefined DATA remains governed by existing codec/structural rules, not blanket rejection. Preserve the original test that deliberately `.annotate(site.id,'encoding',undefined)` after genuine preparation: its semantic failure remains evidence, not a fixture to “fix” or classify Unsupported.

A genuinely zero-allocation module can verify with zero allocation counts and any legitimate unused snapshot cells proved empty; the independent full function/support census must still be non-vacuous when functions are required. Zero allocations does not certify native resources or skip unsupported bodies. If any body is outside the profile, return not-covered and allow canonical generic validation to decide its semantic truth; do not use numeric no-encoding rules to reject valid string IR.

### Share canonical rules without moving a solver

The new rules module is not a second ownership implementation. Before claiming canonical sharing, obtain separate precise existing-file custody for these small joins:

* `analysis/ownership.ts::applyInstrEffect`: replace only existing vec.get/vec.len read and vec.set write+markEscaped operand cases with application of `allocationEvidenceEffect`. Preserve aliasDerived seeding before dispatch and existing touch/markEscaped calls/order. Other switch arms, runBlock, worklist, collectAllocs/collectAliases, joins and writeback remain unchanged.
* `analysis/escape.ts::analyzeEscape`'s visitInstr: use the same descriptor's explicit zero direct-array-escape for those three vec cases; existing behavior is default no direct edge, while ownership carries vec.set's primitive escape. Do not add a new direct escape rule for the receiver or erase the backstop.
* `analysis/encoding.ts::classifyInstr`: optional exact named no-write early return for only the seven admitted instruction kinds, driven by the descriptor and preserving all existing string/call rules. This makes the finite no-write authority shared. No encoding classifier/evidence producer repair is hidden here.
* Reuse `lattice.ts::AccessSet` stable toArray order directly; no new lattice/scheduler or duplicate sorted tag list. Stack exclusion derives from the existing array-not-small rule, with its paired preservation control; no stack-alloc source edit is needed.

Descriptor return is a closed finite result: unsupported or `{ownership: readonly (read/write/escape operand)[], directEscape: readonly [], encoding:"no-write"}` for admitted local cases. vec.set lists receiver write then newValue escape. const, supported binary, new_fixed and primitive-if local effects are empty; if's child traversal is handled by the canonical buffer authority. Shape/type/profile checks remain in census; the descriptor cannot turn an arbitrary binary/reference if into a capability. Existing legacy functions may call descriptor only for exactly their moved cases, preserving all other defaults. If an encoding join is not released, do not claim it implemented; source-preservation proof and paired equivalence tests remain prerequisites before root consumes this capability.

These donor joins are separate from the initial new-file/test slice. Root must name the actual source custodians and any preservation successors; claim34529 is NOT their inferred owner. Existing A2 custody16740/46615 governs facts/provenance extraction; registry facade/analysis registry/seam stays with its real owner. No A2 memory-plan, alloc-verification, validation, codec, physical-plan, geometry or B hunk is assigned to the new-module writer. Source text/history proof obligations remain real and separately owned.

### Later root wiring: validity before capability, no disguised fallback

Implementation entry may author new modules/suites without changing consumers. Root wires existing entry points only after independently reviewed leaf tests and rule/provenance dependencies pass. Required ordering is: descriptor-safe entire joined DATA screen; original population/sourceMap/runtime-support/ABI/contextual SSA and type checks; canonical pure allocation ID/kind/alias/result-type/final-provenance plus facts-consistency checks in the target adapter; generic finite semantic endpoint on complete authenticated views; required native namespace completeness; THEN choose the strictly verified branch versus explicit generic legacy or native Unsupported. Do not call whole `assertPreparedIrProgram` recursively from its allocation hook or run its old reanalyzer before this decision.

At `program/validation.ts`, preserve actual declaredSignatures/declaredGlobals from ABI entries used by runtime verifyIrFunction298–359, original units/derived owners/startup/class layouts/runtime separation and every projection. At `program/allocations.ts`, retain canonical required provenance and exact site.type/resultType checks, including actual async state buffers and all support functions. Reuse A2's released lookup abstraction without AllocSiteRegistry reconstruction. An attachment or pure consistency pass alone cannot select this branch. Reorder owned checks explicitly, not a bare skip of the old allocator validator.

At `program/linear-allocation-facts.ts`, preserve closed fields/dense arrays, exact snapshot equality, direct encoding equality, complete fact IDs and source/projection checks. Its current allocation-ID multiset comparison drops nonallocating owners and is not full-body authentication. The original semantic IrModule is `program.ir`; runtime projections are manifests with functions/providers, not independent IrModules. Retain original declaration context. Any per-projection view passed to the verifier must be authenticated against the exact original module/unit census and canonical runtime reproduction first; no synthetic merged module, reindexed types, filtered fact registry or test-only array body. For this numeric profile, require the complete projection function/operand/type population to match the semantic view apart from already-authenticated runtime attachment fields; no unsupported async attachment is hidden by a core cast. The full same registry is used for generic truth and the unchanged complete facts for canonical target consistency, with original IDs.

Support batches retain their exact original body/ABI contexts through `assertIrRuntimeSupport` and support dependency joins. Current attachment code rejects allocating support; this plan does not silently lift that guard. A support0 sample must explicitly assert0; a required body outside the grammar or an allocating support body not represented in the complete facts makes native admission unsupported before any consumer reconstruction. Nonallocating support still needs complete contextual validity/profile census; do not erase it merely because no allocation IDs occur. If the actual adapter cannot form an authenticated full original-module view for a changed support/projection packet, hold that join rather than filtering facts until the old verifier accepts.

Generic `encodePreparedIrProgram` remains shape/losslessness encoding: valid out-of-profile DATA is encodable. `decodePreparedIrProgramData` remains detached DATA; accepted `decodePreparedIrProgram`/`reauthenticatePreparedIrProgram` must retain canonical runtime regeneration and whole-program validation. Outside profile or missing native evidence, ordinary generic acceptance uses canonical legacy analysis honestly; the required detached native path returns located backendUnsupported before analysis/planning/reservation. Covered false metadata is invalid-prepared-data. At direct `planPhysicalSetup` and accepted physical entries, repeat the current screened/context-valid join; no trusting a prior boolean or accidentally reaching assertPreparedIrProgram's old reconstruction first. Zero analysis on covered input must be measured separately at all these entries. A remaining unrelated native resource gap may still return its original Unsupported; evidence verification does not implement memory resources.

### Finite authored test registrations and canaries

Retain EXACTLY **40 named registration requirements**, with a corrected executable stage split. None is authored or executed by this specification. FIRST release on canonical845 authors exactly **22** leaf registrations in `tests/issue-6920-allocation-evidence.test.ts`: AE01–AE07, AE09–AE17, AE19–AE20, AE24–AE27. These invoke only the actual new `verifyAllocationEvidence(IrModule, AllocRegistrySnapshot)` surface and assert its closed result, counts, mode and semantic contradictions. They cannot assert public preparation, attachment, target facts, codec regeneration, support authentication or completed legacy donor sharing. The later ROOT-owned `tests/issue-6920-allocation-evidence-entry.test.ts` authors the remaining **18**: AE08, AE18, AE21–AE23, AE28–AE40. Do not add skip/todo placeholders to canonical845 merely to represent these held registrations. Their complete expectations stay here until exact source joins are released.

The table below specifies the full requirement associated with each ID; the following stage matrix precisely limits first-stage executable assertions and names every deferred counterpart. A first-stage green AE01 or AE07 certifies only its leaf assertion, NEVER the complete original paired obligation. Receipt denominators must say “22/22 standalone leaf registrations” if actually true and list the18 not-authored ROOT registrations, donor joins, and original eight-pair completion still held. “40/40,” “all eight controls complete,” “sourcefree prepared consumer” and “shared canonical rules implemented” remain false until their real cohorts run. Preserve original18, Phase1 thirteen, saved four probes, and all broader cohorts separately.

AE01 may load the pinned authentic saved V8 program solely as a fixture source, retain typed NaNs, then pass its exact original `ir` and `allocations` DATA values to the new leaf. Record the existing capture path/bytes/hash and verify canonical core shape before invocation. Reading this fixture is NOT passing its A2 attachment through canonical845's older PreparedIrProgram schema. Never copy A2 source into845 or discard/rewrite attachment fields then claim accepted packet/codec provenance. For a portable checked-in fixture, root must separately claim its exact new binary path and custody; otherwise first release uses a genuine canonical845 producer to capture the same measured core module+snapshot through existing APIs, proves the16/five/five/NaN census and records the actual capture receipt. If neither fixture custody nor a genuine matching producer capture is available, AE01 is not runnable and the first-stage maximum is21/22; do not substitute a test-only one-array body. New hand-authored finite core fixtures for other rows are valid ordinary unit tests and are labeled as such.

Every first-stage test supplies structurally valid, context-valid core operands and a canonical snapshot except when deliberately exercising a check genuinely owned by the new census/comparator. Existing structural/provenance failures remain deferred to AE21–AE23 and related ROOT entries; the bare leaf must not gain a copied schema/alias/type authority to satisfy an upstream failure test. No pending root prerequisite is imposed on writing or running the other21 standalone cases.

| ID / exact title suffix | Required paired observation |
| --- | --- |
| AE01 `actual producer sample has 16 occurrences and five reads` | Real final producer+codec packet, exact16/five buffers/five reads/NaN census and metadata; coordinated ownership forgery invalid. First retained eight-pair control. |
| AE02 `nested-only read differs from an unused root array` | No root len/get masks the arm; nested get→read, genuinely unused→[]; forged missing/extra read rejected. |
| AE03 `constant-false arm write remains a may-effect` | One-arm numeric set→write even with constant-false cond; no-set pair and forged missing/extra write fail correctly. |
| AE04 `NaN arms survive and repeated buffers remain occurrences` | Both actual NaNs preserve Object.is/typed DATA; reused sibling buffer counted twice then canonical duplicate-SSA rejection, not global-visited omission. |
| AE05 `reference-valued if is unsupported rather than false DATA` | Valid primitive if verified; valid reference-return/array arm outside profile reaches Unsupported, not numeric no-alias acceptance. |
| AE06 `nested allocation and extra execution domains are not covered` | Root-dominated pair positive; valid nested allocation/additional block/loop/call/async cases not-covered, malformed nondominating cases retain invalidity. |
| AE07 `coordinated metadata agreement is not semantic truth` | Old pure verifier accepts coordinated ownership/access/escape/encoding copies, old full validator rejects; new body checker rejects without either solver. |
| AE08 `whole semantic support and projection census is mandatory` | Actual semantic1/support0/Linearprojection1 positive; added/omitted/changed required body cannot preserve capability. Completes original eight paired obligations. |
| AE09 `globally disabled metadata keeps generic defaults` | Both namespaces wholly absent, consistent escaped/[]/opaque defaults; generic verified/encoding-only, native evidence-not-materialized, no body-truth rewriting. |
| AE10 `ownership-only mode checks ownership before declining native evidence` | Generic verified/ownership-only then native Unsupported; forged access invalid despite absent escape. |
| AE11 `escape-only mode does not require globally absent ownership` | Generic verified/escape-only for exact local/true, native Unsupported; forged opaque or false invalid. |
| AE12 `both namespaces permit exact finite verification` | Two independent arrays/functions accurate; generic verified/ownership-and-escape; metadata reorder permitted only as existing DATA rules permit, no changed effect result. |
| AE13 `ownership activation anywhere applies to every used site` | Remove one site's ownership while another activates it→invalid; remove entire namespace→generic verified in observed reduced mode/native Unsupported when remaining declarations truthful. |
| AE14 `escape activation anywhere applies to every used site` | Analogous complete global vs missing individual escape distinction. |
| AE15 `unused registry slots retain exact empty semantic cells` | Extra legitimate unused live/retired/alias slots and empty rows remain valid under canonical rules; no shortened registry or renumbering. |
| AE16 `unused-site metadata cannot invent a write` | Globally present namespace on unused live site rejects its fabricated object/ownundefined; paired absence accepted. |
| AE17 `present undefined is not a missing metadata namespace` | Ownundefined ownership/escape fail active truth; encoding ownundefined fails absence proof even if all repeated copies match. |
| AE18 `missing attachment differs from own undefined attachment` | Absent uses historical generic route/native gap; ownundefined typed descriptor-first error, no getter/analysis. |
| AE19 `array encoding is absent in every namespace mode` | Four mode pairs preserve absent encoding; ownundefined/ASCII/WTF16 claims all invalid within the covered numeric domain. |
| AE20 `metadata marker presence remains exact` | ownership stackCandidate absent vs ownfalse/ownundefined (invalid), direct fact false retained; legitimate site/origin ownundefined round-trips unchanged. |
| AE21 `required allocation ID cannot disappear from the census` | vec.new_fixed without alloc fails canonical final provenance; valid root ID positive and no collector-only admission. |
| AE22 `site kind and result type retain canonical checks` | Wrong site kind or vec element/result type invalid; exact type pair positive. |
| AE23 `complete alias provenance is checked without reconstruction` | Unused valid alias chain pair; broken/cyclic alias invalid; valid live instruction through an alias outside finite profile is not blanket-invalidated. |
| AE24 `lexical scopes reject sibling and future definitions` | Outer primitive capture in arm positive; sibling arm use/parent result/later root and duplicate definition invalid, not merely Unsupported. |
| AE25 `closed grammar never inherits empty effects` | Supported binary/primitive if positive; well-typed unary/select/slot/unknown-to-profile numeric opcode not-covered. Invalid IR unknown kind retains canonical error. |
| AE26 `buffer cycles and numeric edge values remain observable` | Active-cycle detection rejects cyclic DATA before recursion; acyclic siblings visit separately; NaN/-0/infinities preserved in canonical valid constants. |
| AE27 `legacy observers are live before pure verifier zero counts` | Real passthrough registry-constructor/analysis positives followed by covered leaf zero all counters; provenance/type checks still execute. |
| AE28 `shared finite rules preserve exact canonical annotations` | Released legacy rule joins vs exact baseline across unused/read/write/read+write/primitive-if cases, exact presence/order; genuine producer stack-candidate positive before no-call observation. |
| AE29 `public assertion verifies covered facts without analysis` | Actual assertPreparedIrProgram covered call zeros; absent-attachment genuine legacy positive activates ownership+escape and increments counters. |
| AE30 `accepted codec replay verifies regenerated covered projections` | Encode then accepted decode produces real regenerated projection and same evidence; zero covered consumer analyses/registry constructions, producer work outside interval. |
| AE31 `generic codec preserves valid out-of-profile programs` | Legitimate call or extra block encodes/decodes via normal legacy validation; records real nonzero legacy analysis, no false malformed-DATA or zero claim. |
| AE32 `direct physical preflight refuses before planner effects` | Valid not-covered packet returns located backendUnsupported before registry/solver/planner/reservation, with positive planner observer separately shown live. |
| AE33 `covered forgery is invalid at every joined entry` | Coordinated wrong metadata typed invariant at public assertion/decode/direct physical entry; no Unsupported downgrade or fallback solver. |
| AE34 `semantic and runtime owner populations cannot diverge` | Same full original owner/ABI context positive; extra nonallocating owner/missing function/changed operand/projection fails authentication before evidence use. |
| AE35 `support presence cannot be inferred from allocation count` | Genuine support0 positive; authentic valid support body outside grammar→Unsupported; omitted required support invalid; current allocating-support guard preserved. |
| AE36 `async state provenance remains validated outside the profile` | Valid async program retains generic legacy acceptance/native Unsupported; missing alloc/wrong result in exact async state retains canonical invariant. |
| AE37 `ABI declarations remain the contextual validity authority` | Existing complete signature/global context positive; missing/wrong declaration diagnostic stays canonical, never use standalone weak verifyIrFunction as substitute. |
| AE38 `strict descriptor screens precede joined property reads` | Schema/allocations/ir/runtime/support/attachment accessors rejected zero getter reads; independently reachable positive getters show counters live. |
| AE39 `missing whole namespaces cannot certify native facts` | All four global modes through real generic/native entries; incomplete native evidence→Unsupported only after requested truth checks, no inference of producer controls. |
| AE40 `sample evidence capability preserves remaining native resource gaps` | Actual16/five/five sample passes evidence under current full joins; any unresolved physical resource gap stays its original located refusal. No test asserts1.25 before A-C/S/B public composition actually exists. |

### Exact first-release assertions and retained ROOT counterparts

All statuses below are **planned / not authored / not run**. “Leaf” means eligible in the new-files-only canonical845 successor after root assigns those paths; “ROOT” means held for its actual existing-source custody and joins. A test name is prefixed with its AE ID so no paired sub-observation disappears behind one green label.

| IDs | First-release assertion and exact boundary | Deferred complete counterpart |
| --- | --- | --- |
| AE01 | Leaf: authentic captured core module+snapshot yields16 instruction occurrences/five buffers/five reads, both actual NaNs, exact observed mode; changed ownership rejected by leaf. | AE30 and AE40 must run live final A2 producer, real accepted codec replay, Linear fact consistency and native entry. This leaf result does not complete original pair1. |
| AE02–AE03 | Leaf: independently authored nested-only read/unused and constant-false write/no-write core fixtures; exact access order/presence and forged omission/addition rejection. | AE28 repeats canonical producer equivalence after actual rule joins; original full entry obligations retained by AE33. |
| AE04 | Leaf: core typed NaNs survive loading; valid independent arms counted, and repeated buffer occurrences are visited so duplicate definitions receive the census lexical error. No codec call. | AE30 owns actual codec round-trip and accepted regenerated projection. |
| AE05–AE06 | Leaf: valid core primitive if/root allocation positive; valid reference-valued if, nested allocation, extra block/call and recognized extra execution domain return `not-covered`. Never assert a backend/program error class. | AE32/AE36 own native Unsupported, full async state validity and refusal before side effects. Malformed upstream input is exercised only by actual canonical gates. |
| AE07 | Leaf: accurate registry accepted; fabricated owned/access/local/encoding cells compared against the unchanged body are invalid even when test-created metadata copies agree. It does not invoke a Linear facts checker. | AE33 must reproduce coordinated actual A2 attachment/fact/snapshot forgery with old pure consistency acceptance and retained old full validation rejection before new joined invalidation. Saved four-probe receipt is a baseline reference, not a newly executed AE07 sub-pass. |
| AE08 | ROOT only, no leaf registration or fake support adapter. | Complete semantic/support/projection authentication and original pair8 remain held until AE08/AE34/AE35 actual joins. |
| AE09–AE14 | Leaf: exact four generic modes, absent-whole vs absent-one requested namespace, and contradictory present values, using snapshot cells only. No generic default facts are invented and no native result is asserted. | AE39 owns actual generic defaults, target facts consistency and native completeness/refusal for all four modes. |
| AE15–AE17 | Leaf: structurally legitimate unused original slots/empty rows retained; requested unused cells must be absent; global activation/ownundefined comparisons exact. Alias slots are supplied already canonically valid; no alias resolver is tested here. | AE23 owns complete alias/provenance validity; AE18/AE38 own attachment/descriptor behavior; AE39 owns native decision. |
| AE18 | ROOT only. | Missing attachment vs ownundefined, descriptor-first typed error and legacy/native dispatch. |
| AE19–AE20 | Leaf: numeric-domain encoding absence in each mode and exact ownership marker presence; reject ownfalse/ownundefined stackCandidate. No Linear stackCandidate assertion or codec origin round-trip. | AE30/AE33 retain direct fact false, direct encoding equality, origin/site optional ownundefined round-trip and forged direct fact rejection. |
| AE21–AE23 | ROOT only. | Canonical missing ID/site kind/result type/final alias provenance, including broken/cyclic/unused and valid alias instruction Unsupported. New module writer does not copy existing authority. |
| AE24 | Leaf: own census lexical scope/dominance and duplicate definitions are checked with valid DATA shapes; outer capture positive, sibling/future/root-result use invalid. | AE37 retains contextual ABI/type/SSA authority; leaf lexical checks are not whole IR validity. |
| AE25 | Leaf: closed admitted grammar positive; structurally valid but nonadmitted opcode/unary/select/slot not-covered. | AE37 owns malformed/unknown IR kind's canonical diagnostic; no leaf schema replacement. |
| AE26 | Leaf: finite cycle guard terminates with invalid occurrence diagnostic on a buffer back-edge, while ordinary numeric edge values and independent arms preserve actual values/counts. This is defensive census behavior, not codec validity. | AE38 retains descriptor/closed-DATA rejection before any real prepared consumer traverses such malformed input. |
| AE27 | Leaf: real canonical845 constructor and ownership/encoding/escape solver observers demonstrably increment on a genuine baseline producer/analysis call; reset, then exact leaf invocation records zero. Current producer stack observer may be measured independently if its real reachable call is available. No A2 helper import. | AE28/AE29/AE30/AE32 own actual stack/facts helper positives, pure provenance execution and zero observations at joined consumers. An unavailable helper is held, never represented by an inert spy. |
| AE28 | ROOT donor-preservation registration only. | Exact canonical shared-rule before/after preservation across all finite effects and stack exclusion. New descriptor authoring alone is not sharing. |
| AE29–AE40 | ROOT only; no placeholder green tests on canonical845. | Every full requirement in the original table remains unchanged, including actual public/codec/direct consumer zero intervals and all retained invalid/unsupported distinctions. |

Thus first-stage denominator22 counts AE01–07 (7), AE09–17 (9), AE19–20 (2), AE24–27 (4). Deferred denominator18 counts AE08/18/21/22/23 (5) plus AE28–40 (13). The40 IDs remain individually accounted for; no registration combines a passing leaf half and unexecuted joined half under a completed assertion. AE01 title becomes `captured producer core sample has 16 occurrences and five reads`; AE05 title becomes `reference-valued if is outside the finite profile`; AE09 title becomes `globally disabled metadata yields encoding-only mode`; AE10 becomes `ownership-only mode checks requested truth`; AE11 remains unchanged; AE27 becomes `real canonical observers are live before leaf zero counts`. All other exact titles remain as listed, qualified by this matrix. Test bodies and reports use these narrowed titles. These are not permission to weaken the full original requirements, which remain explicitly named ROOT counterparts.

No producer or legacy analysis is replaced by fake returns. AE27's test-only passthrough module/class wrapper must preserve original implementation/instances and intercept genuine `new AllocSiteRegistry`; spying on prototype.constructor is insufficient. Observe real construction and actual canonical analyzeEncoding/analyzeOwnership/analyzeEscape bindings reached by a baseline call, including transitive compatibility imports. Show positive counters before resetting and invoking the leaf once. The leaf-only interval cannot claim that not-invoked program provenance, prepared codec or physical planner ran. Later ROOT registrations expand the exact observed interval and demonstrate real prepareLinearAllocationFacts/findStackAllocCandidates/provenance/planner positives before their appropriate zero/positive expectations. Producer capture occurs before the zero interval. The canonical845 ordinary legacy rejection of contradictory registry annotations is a read-only callable baseline canary if exercised with valid845 DATA; old A2 pure/full four-probe results remain pinned separate evidence until AE33 genuinely reruns them. No copying A2 code or treating an old receipt as a new pass.

### Complexity, dispatch sequence and remaining general obligation

Use O(F+B+I+U+R+M) time and O(I+R+M+nesting) space for profile verification: Ffunctions, Bbuffer occurrences, Iinstruction occurrences, Uoperand uses, Rregistry slots, Mmetadata entries. Index maps once; no repeated metadata.find per use, full scope-map clones, repeated whole-module scans per site, sorting as a hidden loop solver, or full-worklist trace replay. Canonical upstream DATA/facts validation has its own measured cost and must not be falsely included in a linearity claim if unchanged code is superlinear. Add deterministic operation-count controls on authored doubled input sizes within these registrations, not timing assertions. Keep occurrence paths as private parent-linked stack records and materialize the arms array only for a reported diagnostic; copying every full-depth path would violate the stated bound. Set no new admission cap from guessed sample size: reuse existing safe DATA bounds; explicit implementation resource exhaustion returns resource-limit/not-covered, never verified or malformed valid IR. Budget/gate results remain future measurements.

Implementation order: (1) root freezes source/preimages/API and names all five new-module paths plus the standalone test owner (expanding the earlier three-file suggestion explicitly); canonical provenance/shared-rule ownership is a separate later dependency, not a blocker for this bare leaf slice; A2 pure-facts extraction is required only before target-adapter wiring. (2) author contracts/rules/census/metadata/verify and22 standalone leaf registrations on an isolated successor, leaving original A2/geometry source untouched. (3) implement separately released canonical rule joins with complete before/after preservation and AE28; validate real baseline canary/paired semantics and live counters. (4) root reviews complete immutable view/support/namespace policy and orders the existing descriptor/context/provenance checks; root-owned wiring and the18 deferred registrations (including AE28 donor preservation), with no provisional sourcefree branch relying only on consistency. (5) run separately reported original and new cohorts, native typecheck including selected tests, parser-derived all-reference closure and normal boundary/cycle/LOC/dead-export/preservation gates against actual frozen baseline/candidate. Do not aggregate planned rows into pass counts. Root retains all failures, controls and protected delivery authority.

General exact semantic verification remains UNSOLVED outside this finite profile. Lazy map presence, scheduler activation/visit cap, unreachable/multi-block state, reference alias cycles, async/body domain differences, stack-marker behavior and instruction encodingEvidence truth require a separately proved generic witness/rules/capture design. No signed source, WeakSet, copy agreement, weaker overapproximation or solver renamed “verification” discharges that obligation. Extend proven capability in reviewed stages while preserving full IR objective and all original acceptance; first-profile implementation or40 eventual registrations passing cannot claim general A-F, complete native source support or legacy retirement.



## ROOT adoption — standalone leaf authorship and finite validation, 2026-10-09

ROOT independently read all five source files and the authored test suite; all seven source/test/fixture hashes match their frozen packets. Fresh canonical assignment tree `05b680fa17cd959bc3e3c51671d4374baaf868e6` and actual JSON records confirm source write `19199-2n2yketq` and test write `24554-og1ofvb0`, both in-progress under their named disjoint owners. The 22 literal test names in the authored expected manifest match the independently reviewed suite. Source and fixture remain unchanged.

Adopted test-author record follows. Runtime instrumentation preparation is delegated to the test owner under `.tmp` only; collection and body execution remain withheld until ROOT reads the exact runner and frozen operands. No production admission, original 40-case completion, general witness coverage, retirement, publication or delivery is inferred.

## PROPOSAL — standalone allocation-evidence test authorship, 2026-10-09

Task: author the first 22 standalone leaf registrations for issue 6920, “Native Linear numeric-vector shared source handoff and integration plan,” on canonical base `8452732f0b88c14c5c7634ece58f83240970ea4c` in `/private/tmp/js2-6920-allocation-evidence-checker-20261009`. Adopted latest plan: 53,804 bytes, SHA-256 `732230641a59642bc4b835492a1ffcc1c8c2029a6e987bf5e4ed859f59d9753e`. Test-only actual upstream claim `6920:allocation-evidence-tests-20261009`, owner `ttraenkler/codex-sol-allocation-evidence-tests-20261009`, write ID `24554-og1ofvb0`, claimed `2026-10-08T23:42:19Z`; effect-read from assignment tip `05b680fa17cd959bc3e3c51671d4374baaf868e6`. This is an append proposal for ROOT, not an edit to the source owner's issue.

Authored only `tests/issue-6920-allocation-evidence.test.ts` and separately released `tests/fixtures/issue-6920-allocation-evidence-core.v8`, plus task-specific `.tmp` receipts/config/manifest. No source or existing test changed. The suite statically declares exactly 22 names: AE01–AE07, AE09–AE17, AE19–AE20, AE24–AE27. Exact strings are in `.tmp/allocation-evidence-tests-expected-manifest.json`. All other numeric-vector fixtures are explicitly ordinary hand-authored core unit fixtures; they do not claim producer/codec provenance. Metadata and lexical negatives stay within the leaf's owned comparisons/census. AE06 supplies all live allocation slots for its valid nested-allocation refusal.

AE01/AE04 use a byte-for-byte copy of the actual producer capture `/private/tmp/js2-6920-semantic-evidence-probe-20261009/runs/run-1791500133935-95306/healthy-source-produced-program.v8`: original and copied fixture are each 9,314 bytes with SHA-256 `e17410c15ac8770250a82f7c7ab05e786ff22de6a7f108d7852b6ddd8555ce97`. Every captured byte and the original `linearAllocationFacts` attachment remain intact. Isolated native `node:v8.deserialize` DATA inspection independently recorded 12 root plus four nested instruction occurrences, five buffers, five vector reads, two actual numeric NaNs, one allocation and one registry slot. No producer body, compiler, codec admission or leaf test executed during this inspection. Future test bodies pass only the exact decoded `ir` and `allocations` subviews to the new leaf. No old canonical845 codec-admission claim is made about the full A2 packet.

AE27 authors real passthrough canonical module wrappers: a subclass calls the actual registry constructor and inherits original methods/instances; encoding, ownership and escape wrappers call their original implementations with unchanged arguments and returns, preserving transitive bindings. The authored positive interval invokes actual canonical845 `src/ir/program/allocations.ts::assertPreparedIrProgramAllocations` on the authentic captured core views and requires constructor/encoding/ownership/escape counters exactly 1/1/1/1. After resetting those counters, one actual leaf invocation requires exactly zero in all four. There are no fake solver returns or prototype.constructor spies. These expectations remain unexecuted until ROOT's finite release; no prepared-consumer/provenance/type-execution completion is claimed by the leaf-only interval.

Static-only authorship validation: exact-file Prettier and Biome lint passed. A TypeScript7 native `--noEmit` check includes all source plus this selected suite using `.tmp/allocation-evidence-tests.tsconfig.json`. Initial pending API import resolved after the source writer authored `verify.ts`. The intermediate check reported no test-file diagnostics and two source-file diagnostics (effect-rules.ts:141 TS2367 and metadata.ts:57 TS2322), handed to and corrected by the source owner. The final selected-source-plus-test native no-emit check exited 0 with zero diagnostics; this proves static typing only. No test collection/body, compilation/probe, CI, Wasm/runtime parity, commit, push, PR or queue operation is authorized or performed by this test task.

The 18 later ROOT registrations remain unauthored: AE08, AE18, AE21–AE23 and AE28–AE40. No skip/todo placeholders represent them. The general IR witness/migration, original F/G/V/R/E14 obligations, native standalone/WASI run equality, S/B resources, canonical rule sharing, full type/provenance/alias authority, prepared attachment/codec/projection/support/public consumers, old/new paired cohorts and legacy-retirement requirements remain intact and held. Authorship is 22 registrations; runtime results are unmeasured, not 22/22 passes or 40/40 completion. Original 18, Phase1 thirteen and saved four probes remain distinct receipts with their original retained failures.


## ROOT runtime readback — standalone allocation evidence, 2026-10-09

The finite frozen window is closed. Node25.9/Vitest3.2.4 collected exactly the 22 independently authored names once, then executed once: **22 passed, 0 failed, 0 skipped**. CLI and genuine observed IPC names/statuses agree; 0 instrument/observer/unhandled IPC errors. Collection parent34371/body parent34423 exited0; each phase created two actual workers, all spawn/exit/close observed with stock SIGTERM shutdown. No agent kills or retries. AE27 executed the genuine canonical845 constructor and encoding/ownership/escape controls at1/1/1/1, then the leaf invocation at0/0/0/0. All9,044 frozen operands rehashed with0 drift by writer and independently by ROOT before this post-window issue append.

Final receipt `.tmp/allocation-evidence-runtime/final-receipt.json`:6,231 bytes, SHA256 `6e89f1fc5abc75819c592b53e9c8aff1b598c4e2c02556d7120c951cad08b1ba`; after-window custody2,019,042 bytes, SHA256 `b9eb5171acec67060ba8b6fa5e3bc4b6f078a51d82b0abd86e243b30717fced4`; frozen operands manifest SHA256 `e2dd2d32b0a64d35a213b3e6c1bb7c5e3b75b9ce619d584d24f7fd6435194504`. ROOT read actual row/log/process results and verified all12 raw/result artifact pins. The preparation-only missing tinypool path and reporter-field correction are preserved, not test failures hidden by retries.

This is standalone leaf qualification on canonical845 plus the five authored modules. The remaining18 ROOT registrations, shared canonical rules/provenance extraction, complete support/context/projection/codec/public/direct-native joins, original failed controls, native runtime equality and fullIR migration remain incomplete. No source retirement, pushed source commit, queue action or canonical-main delivery is claimed. The next production join must preserve full-body population and order contextual validation before choosing native semantic evidence; snapshot agreement alone remains insufficient.


## ROOT adopted next production plan and exact source assignment

Actual canonical claim `6920:allocation-provenance-context-20261009`, owner `ttraenkler/codex-sol-allocation-provenance-context-20261009`, write `37849-iyihfm2v`, is in-progress on this branch and was independently effect-read before dispatch. Scope: exactly the four J1 source paths below. Existing A2 facts/extraction claims16740/46615 remain held and untouched; registry facade34529, geometry94949, B files and historical proof readers are not reassigned. Source authoring/static checks are released, runtime and proof-reader changes remain review-gated. Adopted Astra implementation plan follows verbatim, 11,995 bytes, SHA256 `51ff92026a74deb91b9887f668d932af63a5ffdc869f314f31f7093923f5eb5c`.

## Proposed next production slice — share canonical pure allocation checks

Root has closed its actual runtime readback: standalone leaf22/22, genuine AE27 baseline and zero-counter control passing,0 instrumentation errors and0 source drift across9,044 checked files. No runtime was repeated for this specification. This result does not discharge the eighteen ROOT registrations, full forty requirements, general IR evidence witness or public native standalone/WASI1.25 acceptance. Implement the following small extraction first; keep all existing dispatch and reanalysis until the later joins below are complete.

### Exact first source assignment

| Path / function | Authorized patch to request from root |
| --- | --- |
| `src/ir/analysis/contracts/allocations.ts` | Add structural `AllocProvenanceLookup` using existing `AllocSiteId`/`AllocSite`: `isKnown(id): boolean; resolve(id): AllocSite | null`. No serialized schema change. |
| `src/ir/analysis/alloc-verification.ts` | Change only the import/parameter type from `AllocSiteRegistry` to that interface in `verifyAllocProvenance`, `checkId`, `assertFinalAllocProvenance`, `assertVerifiedAllocProvenance`. Keep one existing instruction-kind table, existing nested traversal, known/resolve/kind decisions, error order and `IrInvariantError` identity. Existing registry structurally satisfies the interface. |
| **New** `src/ir/program/allocation-body-validation.ts` | Export `assertPreparedIrFunctionAllocationTypesAndStates(fn: IrFunction, lookup: AllocProvenanceLookup): void`. Move exactly the existing post-`analyze(fn)` async-state provenance and resolved-result-type loop from `program/allocations.ts`. Preserve typed entry-block requirement, each exact state carrier, all original block/state buffers and current walker, resolved site, optional resultType behavior and `preparedIrTypeKey` comparison. Preserve the three current `program allocations:` errors. Import only canonical final verifier, DATA/core types, type-key and error leaves; no registry implementation or analysis. |
| `src/ir/program/allocations.ts` | Replace that moved block with the helper call immediately after `analyze(fn)`. Do not alter reconstruction, alias/retire processing, global requested namespace union, analyses, metadata comparison, or `analyzeIrRuntimeSupportAllocations`. Main-body final provenance remains inside `analyze(fn)` before analyses; helper stays after analyses. |

This is the next implementable four-source-file diff. No validation/codec/consumer change belongs in it. No second provenance algorithm, allocating-instruction table, alias resolver, snapshot-to-registry cast, skip flag or callback granting success is permitted. The helper does not itself repeat main-body final provenance.

Root must assign these exact paths plus new `tests/issue-6920-allocation-provenance-lookup.test.ts` and required source-preservation readers. The saved custody audit records historical `validation-lowering-phase-b-20261001` ownership of verifier/allocation bodies as DONE/released (write82145-fj23duew); it is not a current assignment. Claim34529 owns the registry/facade/seam, not these verifier bodies. Root’s fresh ledger read at05b680fa confirms A2 source-facts16740 and verifier-extraction46615 remain with `ttraenkler/codex-ir-native-linear-source-facts-sol61-20261008`, branch `codex/6865-native-linear-source-facts-20261008`. Preserve its fifteen dirty files; the pure analysis extraction exists only as a private candidate, not installed source. Leaf source/test claims19199/24554 remain distinct and grant no J1 or A2 edit authority. Root must reconcile exact A2 hunks before facts-helper composition. These current claim facts are root-supplied readback; no claim is changed or released here.

### Preserve actual alias and validation semantics

Legacy reconstruction accepts an unused alias whose eventual target is retired; canonical `resolve` returns null if an instruction uses that stale target. Do not tighten that unused case during this extraction. Unknown ID remains the canonical dangling error, known retired ID the stale-provenance error, and wrong kind the exact existing kind error. The strict A2 snapshot verifier separately rejects aliases ending at retired entries even when unused. Preserve both existing domains; do not normalize the legacy domain to the attached-facts domain.

The subsequent A2 dependency is one actual pure facts/snapshot extraction from `analysis/linear-memory-plan.ts` to its proposed canonical facts leaf, including `createVerifiedAllocProvenanceLookup(snapshot)` using the existing verified resolver. It must validate the snapshot before exposing lookup and preserve strict diagnostics. Main-body strict verification then calls `assertFinalAllocProvenance(fn, lookup)` followed by the new type/state helper. Complete semantic/support/projected bodies and async states remain required. Neither the generic evidence leaf nor its instruction collector replaces missing-ID, type or final provenance checks. Direct fact.encoding equality remains a separately released canonical facts correction; do not delete A2's local comparison before composing it.

### Finite first-slice validation

Author eight named registrations in the new suite; these are new extraction controls, not completed AE21–AE23 or additions silently counted in the40:

1. `P01 registry and structural lookup preserve live allocation provenance`: real registry positive and read-only structural delegation produce identical canonical results.
2. `P02 required IDs remain mandatory`: removing a required ID gives the unchanged final error even with the optional debug gate disabled.
3. `P03 unknown retired and wrong-kind IDs remain distinct`: real live positive paired with each exact canonical failure.
4. `P04 unused alias to retired remains legacy-valid`: actual `assertPreparedIrProgramAllocations` accepts the baseline unused alias case; an instruction using that stale target fails. Preserve baseline metadata and denominator.
5. `P05 nested provenance keeps occurrence and error order`: real nested positive and two independent bad occurrences retain the same errors/order through both lookups.
6. `P06 async states retain entry and allocation checks`: genuine valid typed state positive; missing typed entry and missing/stale state allocation keep their errors.
7. `P07 resolved result types retain exact optional behavior`: matching type positive, mismatching type fails, absent optional resultType retains baseline behavior.
8. `P08 legacy allocation order and analyses remain observable`: actual before/after canonical validator agrees, with live positive analysis/constructor observers; this slice intentionally does not assert zero.

Run these only after root's implementation/runtime release, preserving all original receipts. Required normal typecheck, reference closure, boundary/cycle/LOC/dead-export and source-preservation gates remain. Never repin an old proof to current hashes or lower floors. Snapshot-specific AE21–AE23 counterparts remain held until the actual A2 lookup is composed.

### Later join order, now fixed concretely

Current Phase1 screens strict descriptors first but calls old allocation analyses before complete ABI/contextual `verifyIrFunction`, startup and runtime projection reproduction. The late consumer resource gap therefore cannot prevent reanalysis. Preserve the screen and absent-attachment generic first-read behavior; change this order only in a separately claimed ROOT successor:

1. Keep a single validation body with internal `generic` versus `required-linear-evidence` policy and two typed ROOT wrappers. The existing public assertion keeps its signature. Do not expose a bypass option or persist a successful report. At the old allocation position, only generic absent-attachment takes the unchanged legacy path. Present strict input defers allocation admission until all existing class-layout, full ABI declaration/context, sourceMap/population, support, startup and exact runtime reproduction checks complete. This is an intentional strict error-order change, not a claim of identical strict precedence.
2. Then perform closed attachment/snapshot/facts consistency, canonical main/state provenance and result types, and the generic body-evidence check on the complete original semantic module and each authenticated Linear projection using the same full registry. Retain direct fact checks. Preserve original declaration tables/IDs; no merged module, filtered registry or count-based authentication. First capability requires genuine support0. Existing valid generic support retains legacy validation; the current formatter-only WasmGC:standalone restriction remains, so an illegal Linear/support packet stays an invariant. Nonzero support joining is not solved by calling the leaf on an isolated support fragment.
3. Covered contradiction is invalid preparation. Valid outside-profile input uses canonical legacy validation for generic acceptance and a located Unsupported before planners/reservation for required native. Globally missing namespaces are legitimate generic modes; check every present requested namespace before native completeness refusal. Missing attachment on nonzero-registry required-native input is a capability refusal, not a certification of unverified semantics; do not invoke the stricter attached snapshot resolver there. Existing zero-registry/absent scalar behavior stays legacy and is not advertised as covered zero analysis. Ownundefined attachment remains an early typed error.
4. Codec retains Phase1 screen, current shape/facts checks, lossless DATA codec and real runtime regeneration with exact comparison; only final accepted validation selects the new covered branch. Out-of-profile accepted generic replay still performs actual legacy analysis. Preserve the original ownundefined encoding-evidence failure and all original fixtures.
5. At `acceptPreparedIrProgram`'s initial assertion and at the first statement of `planPhysicalSetup`, use the required-native wrapper for Linear before any existing generic assertion can run via `planNativeVectorResources`. Keep exact program/projection membership and backend/target checks. Other backends retain generic validation. Covered repeated generic assertions must themselves be zero-analysis; do not delete them to satisfy counters. Replayed accepted plans revalidate current DATA; no evidence cache is added.
6. Keep the existing Linear allocation materialization refusal. Healthy measured16-occurrence/five-buffer/five-read/NaN input should first reach that honest resource gap with zero consumer analyses; final public1.25 waits for actual A-C/S/B resources and caller composition. AE28's shared-rule donors and preservation are separate prerequisites before consuming the new finite capability, even though J1 can proceed now.

ROOT18 accounting remains AE08/18/21–23/28–40. AE21–23 follow canonical lookup composition; AE08/34/35/37 require whole context/support/projection joins; AE18/38 require early screens at real entries; AE29/30/31/33/36/39 require real public/codec generic/native dispatch; AE32 direct preflight must refuse before downstream work; AE40 retains physical gaps until real native composition; AE28 awaits exact donor joins. Every zero interval has a genuine same-binding positive legacy/producer/planner observer, reset after capture and before the named consumer. Do not count a passing extraction half as a complete ROOT registration.

Read-only preimages: `root18-source-preimages.json` (11,717 bytes, SHA256 `627c33018f2682ce9f965ba77965b52a914f718d1988e0c30117e6ea56422728`). Phase1 allocation source6,602 bytes/SHA256 `e2da59c2bf90e2a833c35206d014e6745f79a94bade7f04c882cdb6495eb7e5f`; verifier/contracts and all relevant A2/Phase1/canonical845-successor paths are pinned in that manifest. Recheck actual successor bytes before editing. This private proposal changes no source, tests, Git state, claims, proof receipts or runtime.


## ROOT architecture registration task — 2026-10-09

Canonical effect-read claim `6920:allocation-evidence-boundaries-20261009`, owner `ttraenkler/codex-ir-evidence-boundaries-20261009`, write `41777-d2f5erfl`, owns only this successor compiler-boundaries.json registration hunk: five generic analysis modules plus the extracted program helper. Add the analysis directory/root and five entry/file rows, raising actual minimum14 to19; add the program helper entry/file row, minimum48 to49. Preserve all prior entries/evidence/proof history and geometry/B/C policy hunks. This inventory declaration is not qualification by itself; parser closure and ordinary boundary checks remain required after all files exist and Git provenance is registered. No historical source proof or retired path is altered.


## ROOT successor-preservation task — canonical allocation checks

J1 changes the parameter types of four existing verifier declarations and extracts the exact async-state/result-type block from the program allocation validator. The unchanged Phase-B fixed receipt correctly rejects both complete live file hashes/lengths before its historical reconstruction. Preserve that receipt/digest, original failures and all135 transfers. ROOT fresh canonical records show Phase-B write82145-fj23duew DONE/released and program-validator proof16792-bv1uimni released; no new reader authority or foreign release is inferred from titles. Astra is specifying a bounded authenticated J1 inverse/reciprocal successor to exact845 preimages before the unchanged Phase-B reconstruction. Proposed reader/receipt/newtests require an exact fresh claim and ROOT review before implementation. This proof must consume all new helper/interface bytes and reject changed bodies/scaffolds; it may not repin history to candidate hashes or mask historical mutant assertions. Existing eight extraction controls and all original obligations remain distinct.


## ROOT adoption — eight portable provenance extraction controls

ROOT read the complete P01–P08 suite and four source diffs/newhelper; exact suite hash `b2ea47d2da4fdf5b810d378ab7e6acf6dcac9bd2645fcb504d47a25678aab37a` and four source pins match. Actual canonical test claim write `40461-imkn9xrm` belongs to the named test owner, independent of source37849. All tests use actual public canonical APIs, never scratch-module imports. Authorship record adopted below. Finite paired baseline845/candidate8 and candidate leaf22 regression are being prepared; no runtime result for this extraction is claimed yet.

## PROPOSAL — J1 portable provenance extraction controls, 2026-10-09

Task: author eight portable controls for the first canonical pure allocation-check extraction under issue 6920, “Native Linear numeric-vector shared source handoff and integration plan.” Adopted Astra proposal `/private/tmp/js2-6920-evidence-implementation-plan-20261009/root18-join-append-proposal.md`: 11,995 bytes, SHA-256 `51ff92026a74deb91b9887f668d932af63a5ffdc869f314f31f7093923f5eb5c`. Canonical base `8452732f0b88c14c5c7634ece58f83240970ea4c`. Actual upstream claim `6920:allocation-provenance-tests-20261009`, owner `ttraenkler/codex-sol-allocation-provenance-tests-20261009`, write `40461-imkn9xrm`, effect-read ledger tip `bca1fcdb4d8a575ffb18908a695b50d515af8695`. This proposal is for ROOT to append after review; it does not edit the source owner's issue.

Authored only new `tests/issue-6920-allocation-provenance-lookup.test.ts` plus task-specific `.tmp` custody/config/manifest/receipt files. The suite declares exactly P01–P08 with the adopted names. All runtime imports refer to actual public canonical source APIs and the established test identity helper. It has no private baseline runtime imports, no direct-helper-only registration and no implementation of a provenance instruction table or alias resolver. Exact canonical845 contracts/verifier/program-allocation source preimages were read from Git into `.tmp/allocation-provenance-tests/before/` solely as immutable custody operands; algorithms and imports remain unchanged. ROOT's later paired execution can copy the same portable suite to the frozen baseline and candidate while each arm imports its own actual source.

P01–P03/P05 exercise the real mutable registry and an object exposing only the new structural lookup's `isKnown`/`resolve`, delegated directly to that same registry. Exact canonical arrays of errors, ordering, typed final `IrInvariantError` identity/code/stage/cause and complete message are asserted. The optional intermediate debug gate is demonstrably disabled while the required final/public gates retain missing-ID rejection. Unknown, retired and wrong-kind IDs stay distinct; two independent nested bad occurrences preserve then-before-else order.

P04 uses a real three-slot registry snapshot: an unused alias ending at a retired slot remains accepted by the actual legacy public validator, with a legitimate unused live slot/empty metadata row retained. Using that alias in a live allocation instruction fails with the canonical stale-provenance diagnostic. Input denominator, raw alias/retired entries and metadata remain unchanged. This does not adopt A2's stricter unused-alias domain.

P06 constructs a genuine typed state plan and requires the actual canonical async-plan verifier to accept it as a positive control. The actual public allocation validator then exercises the extracted state's typed-entry, required-ID and retired-site checks. P07 exercises matching/mismatching root and state result types through that same public caller, plus the historical resultType-null/omitted-field tolerance of the allocation-only gate. The deliberately omitted-field compatibility fixture is explicitly not whole-IR schema admission. The suite never imports or invokes the new type/state helper directly to claim the eight-control floor.

P08 preserves real canonical constructor and encoding/ownership/escape implementations with passive passthrough observers. Its snapshot is produced by genuine registry construction and actual canonical analyses before the observed intervals. The healthy public caller requires exactly constructor→encoding→ownership→escape; a post-analysis type failure retains that same order, while required main-body provenance failure occurs after construction and before any analysis. This extraction intentionally requires positive analysis observations and does not assert a zero-analysis consumer.

Static authorship validation passed: native TypeScript7 `--noEmit` includes all source and the selected suite; zero diagnostics. Exact-file Prettier and Biome lint pass. The authored suite pin, current four-source pins, actual claim, eight-name manifest, before custody and static result are recorded under `.tmp/allocation-provenance-tests/`. No collection, test body, compiler/runtime probe, CI, commit, push, PR or queue operation was performed for this task. Existing tests, fixture, issue, source and historical proof readers were not edited by this owner.

The eight registrations are J1 extraction controls, not completed AE21–AE23, not an addition to the original forty and not credit against the deferred ROOT18. Genuine before/after runtime equality, canonical A2 snapshot lookup composition, attached facts consistency, descriptor/context/support/projection/public/codec/native joins, general IR witness and migration, shared-rule donor preservation, physical resources and native standalone/WASI result acceptance remain held. Original leaf22, original18, Phase1 thirteen and saved four probes stay separately measured with their existing outcomes and retained failures.


## ROOT paired runtime and static gate readback - J1, 2026-10-09

Canonical845 baseline8=8/8 pass; candidate J1 same8=8/8 pass; candidate allocation-evidence regression22=22/22 pass. Each cell had one qualified exact-name collection and one body, with0instrument/observer/IPC errors and all12 observed workers closed via stock shutdown; no retries/kills/mutations. ROOT independently read actual rows/process results, verified all artifact pins and rehashed all17,387 frozen operands with0drift before this post-window append. Final receipt44,161 bytes SHA256 `b2d1bfb83edec6cd38d9556e4a6684bd6dc458e31660f4ae33643b39569e7bb4`; after-window custody3,721,393 bytes SHA256 `3eeec277691b01ae7a7e60ecd7c30e0ade0e7e3588b93382f9d7b4215e4641f6`. Original18/Phase1/other cohorts were not rerun.

Normal cycles and boundary-inventory gates passed after exactGit registration. Full architecture mode remains exit1 on both845sourcebaseline and candidate, with identical4unknown edges,13,817 forbidden/debt edge counts and full debt list,0unresolved/transitive/errors. Newinventory6rows are counted (1892 to1898 sources). Normal dead-export command exits0 but explicitly reports graphOPEN, strictmodeled closureFAIL and retirementNOTCERTIFIED due optimize412/platform151; preserve those qualifications. Staticgodfile48failures remain outsideowned sourcepaths, no floors/baseline changed. This is not full architecture/IR equality.

## ROOT adopted successor proof implementation plan

Actual canonical claim `6920:allocation-provenance-preservation-20261009`, owner `ttraenkler/codex-sol-provenance-preservation-20261009`, write `47027-8ym7mzqp`, independently effect-read in-progress. Sourceownership: new helper+new receipt and exact old filesystem-reader import/transport hunk specified below. New16-test suite will have separate owner/claim. Preserve old JSON and old suite byte-for-byte. Root reviewed the full frozen Astra plan16,502 bytes SHA256 `a894a497852e84664e585d77ae359826d88ab45ecfc9a2dc9675d8552be08a4a`, adopted verbatim below. Authoring/static only; no new runtime until root reads complete proof/source/test receipts.

## Implementation Plan — bounded J1 successor before the retained Phase B proof

Add one authenticated four-source successor around the existing Phase B reader. Its inverse must recover the exact three pre-J1 files (the fourth file did not exist), then independently replay the complete four J1 files byte-for-byte. Only then may the existing nine-original/thirteen-current/135-transfer Phase B proof execute. This is preservation of the exact reviewed extraction, not current-hash-only approval or retirement. All original receipts, fixtures, mutants, failures, forty evidence requirements and full public native/general-IR objectives remain in force. No production or proof source was edited and no runtime was executed for this proposal.

### Exact paths and frozen inputs

Request a new root-owned proof slice for these three new paths and one old-reader hunk:

- `tests/helpers/ir-allocation-provenance-lookup-successor.ts`
- `tests/helpers/ir-allocation-provenance-lookup-successor.json`
- `tests/issue-6920-allocation-provenance-preservation.test.ts`
- `tests/helpers/ir-validation-analysis-relocation.ts`: one successor import and replacement of its exported filesystem-read implementation with initial-input transport, described below. Do not change its reconstruction/assertion algorithms or receipt digest.

Do not edit `tests/helpers/ir-validation-analysis-relocation.json` or `tests/issue-3518-validation-analysis-relocation.test.ts`. Actual fixed old JSON is327,660 bytes/SHA256 `9a52664fbba6044d168f428f9398e5d2bff923cf7cac1adc6aae04827431e969`; old helper18,322/`05f37c0bf66544a226dc22c1f6173c8e36d536e94834997af9ce5dd65e91eacb`; old suite22,549/`84e05af3b178b0d5fd261dc2a0602e1b53d62f473e2e10dfada21ad448945387`. Root's fresh record says historical Phase B write82145 is DONE/released and validator-preservation16792 released; that permits root to assign a successor, not to erase historical proof. J1 source claim37849 is separate from the new proof claim. No foreign claim is released by this plan.

Read-only source pins (`j1-proof-source-preimages.json` includes complete SHA256/Git-blob/byte records):

| Source | Exact predecessor | Exact J1 current |
| --- | --- | --- |
| `analysis/contracts/allocations.ts` |1508 / `65a55b5e766280af62d728b8c54a6ead6f39e2c5c74d7eee6cb9c0aab697a813` |1715 / `8f72c7cf5563171d02522fc7b1581db8cb68d67574fa97d17098e3594565b9e4` |
| `analysis/alloc-verification.ts` |6498 / `93b78752e411016cc490655c0fc981ec3beaadc227682ae35c0599fcc5c6e2a4` |6525 / `5a0e389a0694ed087154974b17be8e3edbd14c9781f01a97acb18b0dc2260238` |
| `program/allocations.ts` |6602 / `e2da59c2bf90e2a833c35206d014e6745f79a94bade7f04c882cdb6495eb7e5f` |5638 / `aec062632da95addb294e203514e8218284177bfccd7154f3cbb1d8bdd412c33` |
| `program/allocation-body-validation.ts` |ABSENT, not an empty source |1864 / `d48bf8cec3edbdb89759df63dbb5a8e3f455b7d739b1e990d669a1eceb69430a` |

Paths in this table are relative to `src/ir/`. The current source root is `/private/tmp/js2-6920-allocation-evidence-checker-20261009`; the read predecessor root is `/private/tmp/js2-6920-linear-facts-entry-screen-20261008`. Recheck the actual root-approved source freeze before receipt authoring; do not silently update these constants if source changes. The old JSON itself independently authenticates the two overlapping predecessor owners at the exact pins above. Contract predecessor is additionally pinned by the new receipt; new helper absence is explicit historical provenance, never simulated by treating a current empty file as absent.

### Closed receipt and live reciprocal reconstruction

Use the repository's existing TypeScript syntax-only parser and byte-span relocation pattern; no checker/Program, module execution or general patch framework. New receipt schema1/kind `allocation-provenance-lookup-successor` contains: fixed predecessor identity; truthful uncommitted J1 provenance; old Phase B receipt SHA; ordered three predecessor records and four current records with full bytes/SHA256/Git-blob; exact import/parameter/body/interface role records and byte spans; the two directional recipes. Store the new JSON's exact byte count and digest as fixed literals in the new helper only after root reviews the final receipt. Never accept caller-provided expected hashes, recompute trust pins from current files, or overwrite the old JSON. Closed field/population validation rejects additional operations, fields and owners.

All four current files are read and fully authenticated before slicing; source text, comments, imports and unchanged scaffold are covered by complete pins. The proof still needs actual role checks and inverse/forward reconstruction: a trusted complete pin alone is not the relocation argument. All spans are unique, ordered, nonoverlapping, bounded UTF-8 byte spans. Every source byte belongs to a pinned unchanged span, one exact reviewed import/type edit, a moved live body, or an explicitly approved new declaration/scaffold record. No unaccounted helper/interface body or free-form executable literal is allowed.

Implement exactly these transformations:

1. **Verifier types:** parse the import as an ImportDeclaration with a type-only import clause, one named binding and exact module string. In `verifyAllocProvenance`, `checkId`, `assertFinalAllocProvenance`, `assertVerifiedAllocProvenance`, select the parameter named `registry` at position1, with a TypeReference identifier `AllocProvenanceLookup`. There are exactly four approved type-reference edits and one approved import edit. Inverse changes only those type tokens to `AllocSiteRegistry` and the exact import to its old owner; forward performs the reciprocal edits. All function bodies and every other type token remain live unchanged bytes. Reject `typeof`, an expression/value use, optional parameter, alias binding, fifth edit or changed import kind. Do not globally replace the identifier spelling.
2. **Contract insertion:** identify one exported `AllocProvenanceLookup` InterfaceDeclaration between `AllocSite` and `AllocRegistryProvenanceSnapshot`. Its exact reviewed207-byte insertion (including comment/separators) has two MethodSignatures in order: `isKnown(id: AllocSiteId): boolean` and `resolve(id: AllocSiteId): AllocSite | null`. No heritage, generics, optional/rest/member initializer, third member or executable sibling. Inverse removes this exact declaration span; forward inserts the fixed reviewed type-only declaration. This is an authenticated new API declaration, not falsely presented as a moved old body.
3. **Moved program loop:** parse `assertPreparedIrProgramAllocations` and identify the function-body `for (const fn of [...program.ir.functions, ...irRuntimeSupportFunctions(program.runtimeSupport)])` whose first statement is exactly `analyze(fn)`. Its second statement is the named helper call `(fn, registry)`. Import must be a real named import from `./allocation-body-validation.js`. Inverse removes only that call and inserts the live helper's moved comment+two loop statements. Convert exactly the helper parameter's two bound `lookup` value uses: the second argument of its state `assertFinalAllocProvenance` call and receiver of `lookup.resolve(instruction.alloc)`. Reconstruct them as the enclosing program function's `registry` binding. Keep all `fn`, state, block, buffer, root, instruction and invalid bindings tied to their lexical roles. No spelling replacement in strings/comments/property names or shadowed scopes.
4. **Helper and local error closure:** parse the helper as exactly one exported function plus its five approved imports. Its body is exactly the local `invalid` declaration followed by the two transferred loops and their original comment. The `invalid` initializer is a live byte-identical copy of the existing local initializer in the current program function, using the same error class/code/message prefix; prove that equality, do not ignore it as boilerplate. The helper's declaration/signature/doc/import/braces are fixed reviewed scaffold. Forward builds it from the reconstructed predecessor's live local invalid declaration and moved statements, with the reciprocal two bound-use renames and exact prescribed indentation. Whole helper equality must then match all1864 current bytes. Additional statements/imports/runtime initializers are rejected.
5. **Program import adjustment:** the exact two removed import bindings (`forEachInstrDeep`, `preparedIrTypeKey`) and the added helper import are role-checked and reversed/replayed. Do not reorder other imports, upgrade type imports to runtime or introduce a wildcard.

Indentation is a fixed byte operation over the authenticated transfer's line prefixes (old loop indentation4, helper2), with exact inverse/forward pins. Check the exact line/span structure; do not format/reprint ASTs or normalize arbitrary whitespace. No string/template token may acquire a changed value. Helper signature/invalid scaffolding is separately accounted for rather than deleted wholesale and assumed harmless.

After inverse, assert complete predecessor pins for all three files; compare the verifier and program predecessor pins to the unchanged old JSON's current records as an explicit chain join. Then replay all FOUR current files independently from those predecessor bytes and the fixed approved new declaration/scaffold, authenticate each complete output and require byte equality with the originally captured current. Reuse no cached success. Unknown/missing/drifting input fails closed. The receipt must not carry the complete old or new executable file as a literal fallback.

### Minimal old-reader transport, with stage boundaries intact

New helper exports `reconstructBeforeIrAllocationProvenanceLookup(rawReader)` and `readBeforeIrAllocationProvenanceLookup(path, rawReader)`. Its Reader is `(path: string) => string`; it imports no old helper (avoid a cycle), reads its own fixed receipt plus the four exact sources once per reconstruction, and uses local syntax/hash utilities. The mapped transport domain is the three predecessor source paths; new helper path and unknown paths stay raw when explicitly requested, while every mapped reconstruction still authenticates all four live sources.

Change only the old helper's filesystem entry to:

```ts
const readIrValidationAnalysisRaw = (path: string): string =>
  readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
export const readIrValidationAnalysisActual = (path: string): string =>
  readBeforeIrAllocationProvenanceLookup(path, readIrValidationAnalysisRaw);
```

Add its exact named successor import. The old reader now supplies its historical Phase B-current view for the overlapping verifier/program-allocation paths; other old thirteen paths remain raw. The new proof's raw filesystem reader MUST NOT call the transported old export recursively. No old fixed constants, thirteen/nine path lists,135 transfers, seven ImportType edits, recipe logic, source assertions or wrappers change.

Crucially, leave `reconstructIrValidationAnalysisSources(rawReader)` and all its callers/injected readers otherwise untouched. Existing tests obtain the old-stage view through the transported default read, edit using unchanged Phase B declaration offsets, then pass those already-stage-matched mutants directly to the old assertions. Do not send these mutants back through the J1 current guard, and do not reinterpret their early rejection as preserved deep detector behavior. An explicitly supplied historical fixture reader tests the old proof only; it is not proof of live J1 source. The default real filesystem chain and new suite prove J1. Existing callback count tests continue counting their same old receipt+thirteen requests; the new suite independently measures all new receipt+four actual dependencies. No hidden successful validation cache or global monkeypatch is introduced.

### Finite new controls and actual adoption gate

Author exactly sixteen new `it` registrations in the new suite, with finite variant arrays inside tests rather than hidden unbounded populations. Each mutation first proves its authentic positive and proves the requested change actually altered the intended bytes/role. These are preservation controls, not additional AE requirements or a claim the old suite is green:

1. `S01 complete four-source inverse and reciprocal`: verify3 exact predecessors,4 exact replayed currents, helper absent-before provenance and unchanged old receipt digest.
2. `S02 actual Phase B chain remains exact`: run the real default chain through the unchanged135-transfer proof; independently check its9 outputs/13 replayed inputs/7 existing edits.
3. `S03 every live source is mandatory`: four missing-path variants plus wrong helper path; each must fail, with successful dependency reads shown first.
4. `S04 warmed source drift is rejected`: mutate each of the four complete sources after a successful reconstruction; repeat real capture, reject, restore in the injected reader and succeed again. No disk edits.
5. `S05 helper body and diagnostics are authenticated`: change each of the three moved diagnostics and local error prefix/class/code; remove result-type check or state provenance call; all rejected.
6. `S06 call order and helper binding are fixed`: helper before analyze, duplicate/missing call, wrong args/import owner and shadowed lookup role rejected.
7. `S07 four type-only parameter edits are bounded`: four parameter-type variants plus fifth unrelated edit, runtime/value reference or import type/value change rejected, despite unchanged runtime body.
8. `S08 exact interface declaration is covered`: method order/type/optionality and extra member/initializer/runtime sibling variants rejected.
9. `S09 unchanged scaffold remains covered`: change comments, whitespace, unrelated import or append runtime statement in each file; full pins fail.
10. `S10 role proof rejects spelling-only equivalence`: shadowed lookup, property/string occurrence substituted for the genuine argument/receiver, wrong parameter position and duplicate declaration rejected by structure diagnostics.
11. `S11 receipt authentication cannot be repinned by caller`: one-byte JSON change and semantically equivalent reserialization fail the fixed digest; diagnostics accepting a draft never become authority.
12. `S12 transfer metadata is closed`: missing/extra/reordered owner, span, rename, declaration and executable literal records fail structure diagnostics before reconstruction.
13. `S13 independent reciprocal catches wrong forward recipe`: altered forward helper scaffold/import/rename/order cannot reproduce the pinned complete four-source output.
14. `S14 old-stage mutants remain old-stage`: construct at least one unchanged historical full-verifier mutant using old declaration spans and show the unchanged old assertion rejects it directly; do not claim this result if it only hits the new outer pin.
15. `S15 operation capture is fresh and bounded`: reader observes new fixed receipt+four current sources exactly once per reconstruction and twice over two operations; unknown-path passthrough has its explicit separate behavior.
16. `S16 supplied historical input is never live proof`: original valid Phase B fixture reader still exercises old proof, already-historical double normalization still fails as before, and neither route can be reported as authenticating a changed/missing current helper.

Some outer source mutations necessarily fail the new complete pins first. Keep independent parsed-role/draft-recipe diagnostics to test the transformation algorithm itself, explicitly without treating drafts as authoritative. Retain and run the original suite unchanged; its existing already-before mutants still go straight to its original detector. Do not rewrite old fixtures to current J1 bytes or weaken the old digest to accommodate the new source. If unrelated baseline debt surfaces, report its exact old failure and keep it held.

Root next reviews the frozen source pins and exact transformation recipe, assigns the four proof paths/hunk, authors the new receipt/helper/tests, then runs the sixteen new registrations, old preservation cohort and required normal checks. Receipt generation is not a passing proof; only complete positive inverse/reciprocal plus genuine negatives qualifies this successor. This source-preservation completion does not release A2 facts wiring, AE28 semantic rule changes, general detached evidence, legacy retirement or native resource emission.


## ROOT reviewed successor dependency census amendment

Source author identified a concrete S15 conflict in the frozen proposal: authenticating the old Phase-B JSON current-row chain inside the bare successor adds a real dependency beyond newreceipt+fourcurrentfiles. ROOT approves **six explicit supplied-reader reads**, each once per bare reconstruction: newfixedreceipt, four exactlivefiles, and the unchanged oldPhaseB JSON. Authenticate allsix; no hidden direct filesystem read/cache. Retain the original five-read plan as predecessor text and report this bounded amendment; sixteen registration names/obligations remain unchanged. Existing old-stage injected-reader receipt+thirteen request census remains unchanged. S01/S02/S15 prove the actual six-dependency chain and S03 includes missingoldreceipt as refusal, never label six as five. No source/hash authority is relaxed.

Paired godfile diagnostic is now measured: normal profile-godfiles --check on the isolated canonical845 baseline exits1 and emits the exact same4369-byte log as candidate, SHA256 `52a3c9d40eff13d80dacda660c23d2a6ede6f064de333b322e9d42591d3374af`. All48 retained failures are pre-existing; no profile or floor was updated. An initial redirection-only missing.tmp failure invoked no gate and is not reported as a gate result.


## ROOT preservation source and test review

ROOT read the complete final provisional711-line helper (29773 bytes SHA6285c6f9e5a4e7c5db8f28b5e42997949b38191995ceb3e4bfcbfe35fe35dcc6), complete receipt (11637 bytes SHA4528c914b70535665feebbd0f93ed5d43ef0a5fbb9b4a752e056da84f89a2c7d), minimal oldreader transport (18566 bytes SHA69a9f38de63cf98321189e4e2928fa04af784244faa9732961751a66a96da0f1) and sixteen-test suite (23721 bytes SHA46d282a10760745990dbe820772898e59e05d978cae763bfd6e0380334cc2688). Exact pins and four live source operands independently match. Source roles are checked independently from full-file authentication; the tests require named role failures, and a structurally valid same-length wrong-forward-scaffold control must reach the independent replayed-helper hash detector. Only the declared before-import insertion may have a zero span. Allsix dependencies are supplied-reader reads. Existing JSON and old suite remain unchanged; no successful-validation cache or executable-file fallback exists.

ROOT approves replacing ONLY the provisional receiptBytes0 and SHA UNREVIEWED constants with11637 and the reviewed4528c914 digest above. This authorizes fixed proof authority for subsequent reviewed execution; it is not a runtime result. Actual test claim50964-2glprsoz was effect-read before adoption. Adopted test-author record follows.

### Allocation provenance successor preservation controls — authorship proposal (2026-10-09)

The portable sixteen-control suite `tests/issue-6920-allocation-provenance-preservation.test.ts` is authored against the actual successor proof and unchanged Phase B proof APIs. Its 23721 bytes have SHA256 `46d282a10760745990dbe820772898e59e05d978cae763bfd6e0380334cc2688`. This is test authorship, not a runtime or proof-completion result.

Claim `6920:allocation-provenance-preservation-tests-20261009` was effect-read in progress for `ttraenkler/codex-sol-provenance-preservation-tests-20261009`, write `50964-2glprsoz`, branch `codex/6920-allocation-evidence-checker-20261009`, before test edits. The actual record is preserved at `.tmp/allocation-provenance-preservation-tests/actual-claim.json`.

The exact S01–S16 literal inventory is `.tmp/allocation-provenance-preservation-tests/expected-manifest.json`; names were statically compared to the authored registrations, with no skip/todo/only or private scratch imports. The adopted plan SHA256 is `a894a497852e84664e585d77ae359826d88ab45ecfc9a2dc9675d8552be08a4a`.

S01/S02 independently pin three authentic predecessor sources, four reciprocal outputs, the authentic unchanged old JSON and its actual owner-row join, then the original nine-output/thirteen-input/135-transfer/seven-edit chain. S03/S15 apply ROOT's explicit six-dependency amendment: new fixed receipt, four current sources and authentic old Phase B JSON once each; twelve reads across two operations. Existing injected old-stage operations still require old receipt plus thirteen inputs exactly once.

Each source or role mutant follows an authentic positive. Role controls require the owned `allocation provenance successor:` diagnostic and exclude complete-file/source pins, pin shape, digest and receipt-authentication failures. S13 includes a structurally valid same-length comment mutation in the forward helper scaffold; structure must pass and the actual independent reciprocal must fail specifically on the replayed helper complete-file pin. Draft diagnostics cannot authenticate caller-repinned JSON.

The suite exercises mandatory sources, warmed source drift, exact diagnostics/error closure, state provenance, helper call order, lexical binding/import roles, four bounded type edits, exact interface shape, unchanged scaffold, closed metadata, old-stage mutants and double normalization. Supplied historical fixtures remain historical proof and cannot establish current-helper custody. No duplicate production algorithm or complete-source fallback is supplied.

No collection/test body/compilation/probe/CI/Wasm or publication was executed in this authorship task. Selected TypeScript7 no-emit, formatting and lint all exited 0 against the provisional helper/JSON/old-reader pins recorded in `.tmp/allocation-provenance-preservation-tests/authorship.json`; the no-emit log has zero diagnostics. The new receipt remains unavailable as fixed authority until ROOT completes its review and authorizes that pin.

The sixteen preservation controls have their own denominator. They do not increase the eight extraction-control or twenty-two leaf-control counts, credit the eighteen ROOT-deferred original cases, complete the original forty-case matrix, waive historical tests or establish native/general-IR completion. Source, old suites, binary fixture and old JSON were not edited by this test lane.


## ROOT finite preservation qualification release

Post-review helper fixed constants are independently verified:29831 bytes SHA7f818067a0ecb8963f582e232f1692af9d3ca9283b9596f42e9ab8846f1f6443, only the two approved trust literals changed; JSON4528c914, oldreader69a9f38d and suite46d282 unchanged. Release exactly five runtime cells: candidate sixteen new controls; canonical845 and candidate paired unchanged validation-analysis relocation suite; canonical845 and candidate paired unchanged verifier-body relocation suite. Original source-derived registration names/table expansions and fixed receipt supply the old floors before collection, never collector-derived floors. All inputs freeze before execution; each has exactly one stock collection and conditional one body with actual CLI/IPC names/status/errors/child closure, no retries/kills/mutations. Retain failures and compare all actual paired rows; no old fixture, receipt, gate or test is weakened. Original eight/twenty-two need no repeat because production source is unchanged, and other cohorts remain untouched. No qualification or publication result is claimed before records are read.


### J1 successor runtime qualification and root readback — 2026-10-09

The exact five-cell finite window is closed. New successor controls16/16; canonical845 versus candidate unchanged historical preservation116/116 in both arms; unchanged historical verifier39/39 in both arms. Total326 actual body rows, zero failures/skips/instrument/IPC/observer faults. Ten stock collection/body CLI parents exit0; twenty observed worker spawn/exit/close records complete. Ordered authored name plus registration-occurrence/status/error signatures are identical in both historical pairs; the two genuine operandIrType duplicate titles remain distinct occurrences. No retries, kills or source/test/fixture/issue/proof mutations inside the window.

Root independently read the final receipt and checked all sixty actual raw artifact byte/SHA pins, exact paired row signatures, all five authored floors, CLI/IPC row counts and child closure. Root also reread and hashed all17391 current operands against after-window custody: zero drift. This is executed preservation evidence, not full IR equivalence or native admission. Original eight/22 controls were not rerun because their production sources did not change; ROOT's deferred18/full40 coverage is not credited.

Final receipt `.tmp/j1-proof-runtime/final-receipt.json`:570970 bytes/SHA256 `fd2653f7c010bbdba90caa21f35415c3089be98199b0ed37054ee57e9e387c8a`. After-window custody3722600 bytes/SHA256 `2ac0e258ee2ba6c07f88e26562c66d33cd2854c66f5ae23cdb4de026e70627a5`. Freeze3793527 bytes/SHA256 `ac4fa1837cd614b342e205f9cd3ffeb90d206bafb181fdea5c25c7514d0e5a77`. Normal full hooks and publication are next; no canonical-main delivery yet. Legacy code retained.


### Signed local checkpoint and next-join classification review — 2026-10-09

Signed unpublished checkpoint `b1a60eab2158dafa62af87dd39db808c8b2ba0f2` contains exactly18 reviewed paths, authored Thomas Tränkler with Codex coauthor and Model Codex GPT-6.1 Sol High. Full normal hook chain passed formatting/lint, source/function budgets, changed-root22+8+16 tests and zero-growth oracle ratchet. Initial signing-only failure is preserved; existing authorized SSH agent retry succeeded, without bypass or key/config changes. Root effect-read the actual commit, author/trailers, SSH signature and clean tree. No PR, push or main delivery yet.

Publication remains held for a concrete Astra next-join domain review: mutable/J1 allocation provenance does not reject repeated same-type live allocation-site IDs, whereas strict Linear facts explicitly rejects duplicate body IDs. Canonical registry-aware cloning mints fresh IDs. The finite leaf currently classifies any repeated ID as invalid; a canonical-valid generic input outside its one-occurrence profile should instead be not-covered and preserve ordinary legacy fallback. This is a static contract finding, not an observed public compiler miscompile or an executed duplicate-program witness. Astra is deriving the exact correction/control/descriptor-order plan; source/test edits and runtime qualification await its root-adopted scope. Retain all original snapshot/metadata/provenance defects and strict native fact invariants. Do not infer full IR coverage, native admission or retirement.

Coordination review completed separately: exact repaired6598 `9ae339bf726d28792123ffe170a2d54bdc8f88bb` guard/control accepted; required preservation CI31/34, new suite21/21. The initial three intrinsic-row proposal was incomplete; root published exact additional row/hash/count plus executable predecessor inverse scope in shared-thread6071989772, requiring C update existing6921 issue and preserve original failures. No broad repin, production authority or queue release.


### Implementation Plan — Astra-reviewed allocation-site reuse classification

Adopt Astra High's exact source-backed correction received2026-10-09. Base signed local checkpoint b1a60eab2158dafa62af87dd39db808c8b2ba0f2 remains unpublished. Current generic/J1 validation checks known/live/kind/types for each occurrence but does not enforce occurrence uniqueness; registry-aware inlining and specialization mint fresh IDs, while the strict Linear frozen-facts verifier independently rejects duplicates. Do not conflate these contract domains or aggregate reused-site effects.

Source ownership: existing Sol6.1 High checker owner, only `src/ir/analysis/allocation-evidence/contracts.ts` and `census.ts`. Add coverage reason `allocation-site-reuse`. In `registerAllocation`, remove duplicate presence from the stale/kind invalid predicate, then return not-covered for `state.allocations.has(id)` only after the existing live/kind, result-type equality and result non-null checks. All actual malformed provenance/result cases remain invalid; canonical-valid reuse exits the finite profile for ordinary generic fallback. No mutable registry/planner/native adapter/context/solver/proof changes. Preserve original22 registrations, all J1/extraction proofs and binary fixture.

Disjoint test ownership: Sol6.1 High test owner claims a new site-reuse-tests slice before authoring `tests/issue-6920-allocation-evidence-site-reuse.test.ts`, exactly five registrations. Pair same-function and cross-function reused live IDs with genuine generic function verification and the complete retained legacy allocation validator on actual producer fixture views. Do not substitute a helper-only proof or fake registry. Repeated-site wrong result-type remains invalid before coverage refusal; stale/wrong-kind/missing-ID cases remain invalid with live positive controls; distinct IDs retain verified result, exact occurrence census/location and real observer controls. Test-local views may extend the authentic frozen fixture while preserving its original bytes. Explicitly distinguish allocation-contract validity from whole prepared population/ABI/projection authentication; this task does not claim the latter.

Source and test workers author in parallel within these disjoint paths, re-read actual canonical claims and pins first. Static typing/format/lint allowed; collection/body execution requires root review of exact source, five registrations and ordinary positive provenance. Then one bounded collection/body window for original22 plus new5; rerun unrelated historical cohorts only if actual inputs change or a normal hook requires them. All original failures/receipts retained; normal signed follow-up commit, no rewrite or bypass. This classification correction adds no new covered grammar, solver skip, native support or legacy retirement claim. J2/J3/full40/general witness/native standalone/WASI/resource goals remain intact.


Frozen Astra addendum independently read in full: `/private/tmp/js2-6920-astra-next-join-review-20261009/site-reuse-classification-addendum.md`,11784 bytes/SHA256 `b16c755a55508a944feead0ab435cbc47963e9079b5b7530bc335a291384bd85`. Adopt the exact two-file fix and SR01–SR05 matrix. Keep the previously assigned new filename `tests/issue-6920-allocation-evidence-site-reuse.test.ts` rather than the alternate proposed filename.

Explicit static control refinement before execution: profile exclusion precedes allocation registration, so changing an instruction's vector result outside the eligible nonnullable f64 profile remains reference-carrier not-covered; this correction does not reorder or broaden that profile. SR04 instead pairs an eligible instruction with a mismatching registry result type for actual canonical/J1 type failure and site-result-type refusal; separately the second reused allocation with a null result must retain lexical-definition refusal before reuse coverage. No optional noncanonical f64-signed fixture is required. SR05 uses genuine independent per-site read/write evidence and changed/swapped/omitted-evidence refusals, not merely two empty rows. Original22 test bytes remain fixed. Authoring/static checks released in disjoint source/test paths; execution remains withheld until root reviews actual controls and claims.


### Root adoption of next-join implementation plans — planning only

Root read both frozen Astra High plans in full and adopts their architecture and staged requirements. This records the next real native consumer work; it does not release source edits to the shared planner or claim current Phase1/A2/J1/J2 composition. C retains its exact geometry source/test hunks; one root-appointed composer will authenticate the combined agreed predecessor before snapshot/facts extraction. Required-native descriptor screening, complete context and body-derived evidence remain mandatory before any solver skip, with generic legacy behavior retained. The current two-file classification fix and its five controls remain the immediate publication prerequisite.


Frozen plan source: /private/tmp/js2-6920-evidence-implementation-plan-20261009/j2-snapshot-facts-append-proposal.md; 17100 bytes/SHA256 `7a81203ee5d306388010749908cc4ca644c4f074118143873b28af76c5017b29`.

## Implementation Plan — J2 generic snapshot reads, then canonical Linear facts

Implement one canonical extraction with real existing producer/verifier/planner callers. J2 supplies snapshot provenance and target-facts consistency; it supplies neither semantic evidence truth nor a consumer analysis skip. Preserve the twenty-two leaf results, remaining eighteen/full forty obligations, general IR witness, old failures and public standalone/WASI `run(1.5,-2.25) === 1.25` resource objective.

The original A2 `.tmp/a2-addendum/canonical-extraction-handoff.md` and candidate were read, not applied. Its proposed attachment-only early return, blanket34529 donor premise and suggestion that an ownundefined encoding fixture should become semantically accepted are superseded by the adopted truth/custody decisions. Its duplicate declaration of `AllocProvenanceLookup` in alloc-verification is also obsolete: J1 already gives that interface its canonical `analysis/contracts/allocations.ts` home. Do not apply that candidate patch over J1. Preserve original A2's fifteen dirty files and unexecuted thirteen proposed controls.

### Three new canonical homes and their real readers

| New module | Exact responsibility and moved symbols |
| --- | --- |
| `src/ir/analysis/allocations/snapshot.ts` | Generic read-only snapshot authority. Move the existing `canonicalIndexFromSnapshot`, `canonicalSiteFromSnapshot`, `snapshotSiteAtCanonicalIndex`, `metadataValue`, `verifyRegistrySnapshot`, and `sameDetachedValue` once from memory-plan. Add the verified read view below; it imports canonical generic allocations/core DATA only. It does not import Linear facts, geometry, program, registry implementation or analyses. |
| `src/ir/analysis/linear/contracts/allocation-facts.ts` | Move existing `LinearPreparedAllocationFact`, `LinearPreparedAllocationFacts`, `OwnershipMetadata` DATA. Use existing generic AllocSite/AllocRegistrySnapshot/Ownership/EscapeClass/EscapeInfo and core `IrStringEncoding`, with no type import through solver files or memory-plan. |
| `src/ir/analysis/linear/allocation-facts.ts` | Move `verifyLinearPreparedAllocationFacts`, private `sameStringArray`, `collectModuleAllocationInstructions`, `collectValueTypes`; import the generic snapshot authority and target DATA. Retain existing collector semantics and original error/order behavior except the explicit encoding correction below. No allocator/layout/provider/analysis import. |

Supporting existing hunks: append the existing documented `Ownership`, `EscapeClass`, `EscapeInfo` declarations to `analysis/contracts/allocations.ts` without moving/changing J1's interface; replace their definitions in `analysis/lattice.ts` and `analysis/escape.ts` with imports and identity-preserving type reexports. No rank, lattice, effect, scheduler or solver body changes. Preserve documentation as part of the exact declaration move; do not attach old declaration comments accidentally to an unrelated import or rank table.

`analysis/linear-memory-plan.ts` immediately imports the relocated helpers, collector and facts DATA. Its **existing** `prepareLinearAllocationFacts` calls the relocated verifier and generic reads; its **existing** `planLinearMemoryFromFrozenFacts` and layout walk use the same canonical reads/collector. Preserve public verifier/equality bindings by direct reexports of the identical function objects (`verifyLinearPreparedAllocationFacts`, `sameDetachedValue`) and existing Fact/Facts type exports. No wrapper implementations. Producer analyses, geometry, layout, policy, stack/heap and resource functions stay where they are. Rewire A2 `program/linear-allocation-facts.ts` to the new target verifier and `program/prepared-contracts.ts` to the DATA home only when composing that real A2 source. Canonical845 has no strict program helper; do not manufacture one merely to pass extraction tests.

These are three NEW files plus exact existing hunks, not a three-file total diff. Real memory-plan callers use the extraction in the same source change; no unused-module publication checkpoint is allowed. Generic-to-specific dependency direction is allocations snapshot → Linear facts → existing planner/program adapters, never reversed.

### Minimal generic read interface, one resolver

In the new generic snapshot module propose:

```ts
interface AllocationSnapshotRead extends AllocProvenanceLookup {
  canonicalIndex(id: AllocSiteId): number;
  siteAtCanonicalIndex(index: number): AllocSite;
  metadata(id: number, namespace: string): {
    readonly present: boolean;
    readonly value: unknown;
  };
}
export function createVerifiedAllocationSnapshot(
  snapshot: AllocRegistrySnapshot,
): AllocationSnapshotRead;
```

This is a nonserialized, invocation-local read view over the exact snapshot. The target verifier starts with `const read = createVerifiedAllocationSnapshot(preparedFacts.registry)` in place of its old `verifyRegistrySnapshot` call, then uses `read.canonicalIndex`, `read.siteAtCanonicalIndex`, and `read.metadata` at the exact existing call sites. Thus the new factory is reached by actual production callers immediately. Its J1 `isKnown`/`resolve` methods are available for the later real program provenance join, without importing a target module into generic validation. Do not add the obsolete target-coupled `createVerifiedAllocProvenanceLookup` export merely as an unused compatibility alias: it was a private proposal, not a published binding.

The factory invokes the moved existing strict snapshot verifier first. `isKnown` preserves the existing typed registry range predicate. `resolve` returns null for unknown or directly retired IDs, otherwise delegates to the **same** moved canonical resolver and site accessor; no catch-all converts malformed provenance into null and no second alias walk is authored. Its canonical-index/site/metadata methods delegate to the same moved algorithms. Keep only helpers actually needed by memory-plan exported; site accessor/snapshot verifier can remain private behind the view when no direct caller needs them. `sameDetachedValue` retains its existing function identity through memory-plan's export. Its WeakMap/WeakSet is only local cyclic structural comparison, never persisted truth authority.

The input precondition remains ordinary screened DATA with canonical structural types, stable for the duration of verification. This factory verifies the existing strict provenance/snapshot domain, not a new complete unknown-input schema. Existing producer snapshots satisfy it; J3 must execute Phase1 whole-graph descriptor screening and closed attachment checks before calling it on decoded input. Do not brand `unknown` with casts or read an accessor before those gates. The moved verifier does not by itself enforce all strict program metadata-owner/namespace/closed-field rules: preserve those existing adapter checks. Its historical `linear-memory frozen allocation facts ...` error text may remain in this first generic extraction to preserve diagnostic compatibility; that string creates no target dependency and is not permission to call the algorithm general semantic verification.

Preserve the two actual domains: strict snapshot verification rejects alias cycles, unknown targets and aliases ending at retired entries, including unused aliases. Direct unused retired slots remain legitimate. Legacy mutable reconstruction permits unused alias-to-retired and returns stale/null if an instruction uses it. Do not change the mutable registry or absent-attachment legacy path to use this stricter factory. No promise of solver-free provenance for all legacy inputs is made by J2. Body IDs still receive canonical required-ID/kind/result/state checks through J1; an allocation collector cannot detect a missing required ID.

No new cache, ID renumbering, shortened registry, snapshot mutation or analysis is introduced. Keep the existing algorithms' costs honestly: metadataValue currently searches arrays and alias resolution walks chains; J2 is not a claim of linear whole-program complexity. Optimizing their indexing requires a separately reviewed equivalence change, not a disguised rewrite in this extraction.

### One explicit verifier correction; everything else remains canonical

In the relocated target verifier preserve all existing checks for fact IDs, site equality, ownership/escape metadata, evidence presence, defaults, stack flag, body duplicate/missing/extra IDs, and exact optional encoding property presence. Add only the missing direct-value equality:

```ts
if (!sameDetachedValue(fact.encoding, encoding.value))
  throw new Error(`linear-memory frozen allocation fact ${id} disagrees with encoding value`);
```

Place it **after** the existing encoding own-property/presence check and existing evidence.value equality check. This preserves established diagnostics when presence or evidence already contradicts the registry and rejects only an otherwise-consistent wrong direct encoding value. The older private candidate placed it earlier; do not inherit that incidental error-order change. Once this canonical guard is actually composed, remove A2's redundant local direct-value equality in the same reviewed transaction. Keep its closed DATA schema and own-property rules intact.

Absent encoding, present-undefined encoding and explicit values are distinct DATA states. The target verifier can accept self-consistent present-undefined as a representation/consistency result; the later numeric body-truth endpoint correctly rejects falsely asserted encoding on that body. Therefore the unchanged original fixture which calls `.annotate(site.id, 'encoding', undefined)` does not become semantically valid through J2. Likewise coordinated ownership/escape copies may still pass target consistency; body truth, exact context and canonical provenance remain mandatory before any J3 skip.

Collectors move without broadening: `collectModuleAllocationInstructions` includes block and async-state allocations but carries a display name, and `collectValueTypes` is not a lexical dominance or complete async-body definition proof. J1 and full contextual validity remain independent. Do not claim these collectors authenticate support/projected owner population, SSA or semantic effects.

### Finite extraction controls before J3 wiring

New proposed suite: `tests/issue-6920-allocation-snapshot-facts.test.ts`, exactly twelve new registrations. These do not replace the original18, Phase1 thirteen, A2 planned thirteen, J1 controls or AE21–AE23's complete integration requirements.

1. `J201 actual producer and planner use the relocated authority`: genuine canonical producer facts and frozen-facts planner positive; assert exact before/after results and retained compatibility verifier/equality function identity.
2. `J202 snapshot lookup and mutable lookup agree on live provenance`: genuine direct-live and alias-to-live snapshots through actual J1 main-body and result/state helpers; no mutable registry constructed during snapshot verification.
3. `J203 strict and legacy retired-alias domains stay distinct`: unused direct retired accepted, strict alias-to-retired rejected, real unchanged legacy unused alias-to-retired accepted; instruction-use stale error retained.
4. `J204 strict snapshot defects cannot become null success`: exact denominator/site identity/duplicate metadata/alias cycle/unknown target failures paired with a real valid snapshot; stable canonical diagnostics.
5. `J205 missing IDs kind and result types remain J1 checks`: exact live positive and required missing ID, mismatching kind, stale ID, resolved type and async-state negative controls on the snapshot view.
6. `J206 complete Linear fact denominator is preserved`: duplicate, missing, extra fact IDs and changed site projection rejected; original IDs and unused snapshot slots retained.
7. `J207 direct encoding value cannot disagree with evidence`: genuine encoding positive; change only direct fact.encoding and reject through both canonical and old exported verifier binding.
8. `J208 encoding presence preserves original failure order`: absent/present-undefined/value cases; change presence and evidence independently, then combined contradictions confirm old presence/evidence errors precede the new value-only error. Semantic undefined fixture is not rewritten.
9. `J209 ownership escape defaults remain consistency checks`: four globally materialized modes and exact optional/marker values retain existing verifier semantics; coordinated forgery still needs the separate body-truth endpoint, demonstrated with an explicit paired leaf rejection for its covered case.
10. `J210 descriptor preconditions stay at the actual adapter`: composed A2 strict accessor/ownundefined controls reject with zero getter execution and genuine live positive observer. If A2 is not yet composed, this registration is HELD, not simulated by a fake adapter or counted green.
11. `J211 sourcefree closure has a live negative control`: parser-derived all-reference closure of the new DATA/snapshot/facts paths excludes program, target geometry/backend, solver and mutable-registry implementation dependencies where specified; inject an actual forbidden edge into the test reader to demonstrate detection. Canonical ALLOC_NAMESPACES currently shares the registry owner module, so the target verifier's allowed namespace-owner import must be reported honestly; do not copy namespace strings or falsely claim it absent.
12. `J212 genuine observers distinguish producer from consumers`: real constructor/encoding/ownership/escape/stack calls positive during producer or legacy baseline; reset, call generic snapshot and target frozen-facts verification/J1 helpers, require zero constructor/solvers while canonical provenance executes. No fake result or inert import spy.

J201–209/211–212 can qualify the actual extraction on canonical845+J1. J210 completes only with actual A2 helper composition, so a first checkpoint may truthfully report11/12 with1 held. Do not disguise this as complete public sourcefree validation. Runtime, typing, reference closure, LOC/dead-export/boundary and source-preservation checks need root's actual implementation/test release; no tests run here.

### Exact custody, preservation and next real caller

A2 source16740 and verifier-extraction46615 remain the same actual owner `ttraenkler/codex-ir-native-linear-source-facts-sol61-20261008`; root must release the specific new homes/import rewires and physically compose their private proposal with current J1. Existing generic contract/lattice/escape type moves need explicitly assigned source/proof custody, not an inferred34529 permission. The shared `linear-memory-plan.ts` hunk overlaps a physical file with C geometry, but J2 owns only listed facts/snapshot/collector declarations and their imports/reexports. It excludes shared geometry/constants/layout functions and C's pending edits. Freeze a concrete composed predecessor and coordinate those exact byte ranges before either writer proceeds.

Preservation needs a new exact extraction successor, proposed `tests/helpers/ir-allocation-facts-extraction-successor.{ts,json}` and its own test suite, through root's existing source-proof authority. It must authenticate all complete affected donors/new owners and reconstruct the exact pre-J2 J1 contract pin before the retained J1 successor; lattice/escape must reach the unchanged Phase B pins; memory-plan must join the actual agreed geometry epoch and existing lowering preservation chain. Treat the new direct-encoding guard as one explicit reviewed semantic addition with its paired tests, not a falsely byte-identical relocation. Never repin J1/Phase B/geometry receipts, normalize away unknown edits or claim an unproved historical baseline. This paragraph names dependencies, not a new proof implementation assignment.

After J2 and its proofs, J3's real order is unchanged: early descriptor screen; full original population/ABI/contextual SSA/type/support/startup/runtime reproduction; strict attachment and target-facts consistency; this generic snapshot lookup passed to J1 main/state/result provenance; body-derived generic evidence on complete authenticated module/projection views; then generic legacy fallback versus required-native Unsupported or covered zero-analysis acceptance. Keep support0 first capability and all nonzero support/general witness obligations. Required-native entry must occur before `acceptPreparedIrProgram`/`planPhysicalSetup` can reach old generic reanalysis; final resource refusal remains until A-C/S/B actually compose. J2 alone changes no public admission mode or physical resource lifecycle.

Read-only pins for eleven actual/candidate inputs: `j2-source-preimages.json`,2,499 bytes/SHA256 `2eb67d5fab1da604326aa5b58f4211296d9d481cf7c1bc4de1eb4d86109a0046`. The three new path proposal supersedes the private flat target-facts path; no existing public module is renamed silently. Earlier frozen proposals remain unchanged. This private appendix edits no source, tests, issue, claim, Git state or runtime.


Frozen plan source: /private/tmp/js2-6920-astra-next-join-review-20261009/required-native-entry-order-addendum.md; 14126 bytes/SHA256 `764814454df1a9932b97829487d1cccece89d5028ff0ec8f04e389670eaa8a90`.

# Required-native entry order and remaining custody

Private read-only follow-on to `site-reuse-classification-addendum.md`, Codex GPT-6 Astra High, 2026-10-09. This is next-join planning, not a prerequisite for its bounded two-file classification fix. No runtime/test execution, source/test/shared issue/Git/claim/public comment change. The exact 17,100-byte J2 proposal and frozen J1/evidence source were read. Source domains below are deliberately distinguished.

## Existing call chain and absent-attachment hole

Phase1 source is `/private/tmp/js2-6920-linear-facts-entry-screen-20261008`, not its `-baseline-` sibling. A2 original is `/private/tmp/js2-ir-native-linear-source-facts-20261008`. Frozen J1/leaf candidate is `/private/tmp/js2-6920-allocation-evidence-checker-20261009`. Do not treat the three as already composed.

In Phase1 `program/validation.ts::assertPreparedIrProgram` (198ff), the first statement calls `screenPreparedIrProgramLinearAllocationFactsInput`. That screen (`program/linear-allocation-facts.ts`, 104ff) examines the own attachment descriptor, rejects an accessor and own-property undefined, and calls `freezePreparedIrRuntimeValue` on the entire program only when attachment is present. Absence returns before screening the remaining graph. The subsequent schema/reconciliation/sealed reads therefore retain historical absent-attachment getter behavior. This is intentional generic compatibility, not a sufficient required-native boundary.

After population, source-map, support and semantic/runtime separation checks, Phase1 still calls the old `assertPreparedIrProgramAllocations` at 209, before class layouts, full ABI/contextual `verifyIrFunction` (363), startup and exact runtime projection reproduction (399). The later strict attachment helper cannot prevent that reanalysis. Original A2 lacks the early screen and likewise has old allocation validation before the attachment helper. Its private candidate attachment-only solver return is not approved evidence truth.

`program-consumer.ts::acceptPreparedIrProgram` first invokes the generic assertion (299). `program-physical-plan.ts::planPhysicalSetup` first invokes only the attachment helper (1234); absence returns immediately, after which it reads projection functions and program ABI and calls `planNativeVectorResources`. That resource entry invokes the generic assertion (287). `planNativeValueResources` also invokes the generic assertion (330). Consequently adding only a late resource failure or modifying only the generic attachment-present branch leaves absent required-native input exposed to getters and/or reanalysis.

`compiler/ir-program-driver.ts::runIrProgramDriver` calls prepare, then accept, then emit. Place the new gate at the actual accepting/direct-planning entries rather than adding a driver-only check; direct physical callers and accepted-plan revalidation would otherwise miss it.

## Minimal placement and caller order

Use the previously proposed single validation body in existing `program/validation.ts`, with a private policy discriminant `generic` versus `required-linear-evidence`. Preserve the public `assertPreparedIrProgram(program, options?)` signature. Add one typed internal required-native wrapper used immediately by actual consumer and direct planner in the same change; reexport through the existing program-validation facade only for those real callers. It may return the existing located `PreparedIrProgramFailure` on missing capability, and throw existing invariant errors on established contradictions. Do not introduce a new public unused API checkpoint, callback that grants validity, boolean success cache, detached token, or second validation body.

At the beginning of that common body, before any program property read:

1. Execute the Phase1 optional attachment screen exactly as today. It preserves the accessor and own-undefined attachment diagnostics without running those getters.
2. If policy is required-linear-evidence and no own attachment descriptor exists, call the existing `program/data.ts::freezePreparedIrRuntimeValue(program)` unconditionally. Detect absence with `Object.getOwnPropertyDescriptor`, not `program.linearAllocationFacts`. This is the missing whole-graph screen for required-native absence. The generic-absent path still does no added graph screen.
3. Now run existing schema, population, source map, support and semantic/runtime separation checks. Keep ordinary generic absent-attachment allocation validation at its current position and preserve its error/analysis order. For strict attached input or required-native validation only, defer allocation admission through the complete existing class-layout, ABI declaration, contextual SSA/type, startup, support-dependency and exact runtime reproduction checks. Never call whole `assertPreparedIrProgram` recursively from an allocation hook.
4. For an actual attachment, execute its closed DATA/schema, namespace-owner and presence rules, target facts consistency, and exact semantic/projection comparison through the composed J2 canonical extraction. J1 main-body final provenance and result/state helpers use J2's verified snapshot view on every authenticated original/projected body. Retain every original slot and ID; no merged module or filtered registry. Full semantic and projection validation must finish before the leaf's result is used.
5. Run the generic allocation-evidence endpoint on the exact complete original view and each required authenticated Linear projection. Contradictions inside its covered domain are invariant errors. Outside-profile input, including allocation-site reuse, uses unchanged canonical legacy validation for generic acceptance; required native returns located Unsupported before planners/reservation. Namespace presence/completeness is evaluated only after any requested present evidence has been checked. A report over one view is not reusable for another.
6. Missing attachment with nonzero registry is a required capability refusal before old allocation analysis, not proof that the allocation graph or metadata was valid. Do not feed this legacy-domain snapshot into J2's stricter resolver; unused alias-to-retired is deliberately legal in the generic legacy domain. Preserve the existing zero-registry/absent scalar legacy path, including its validation and honest analysis accounting. Do not advertise every missing-attachment request as zero-analysis. The required-native entry still screens that zero case before reads. Ordinary generic absence remains unchanged.

`freezePreparedIrRuntimeValue` is the existing descriptor walk and in-place freeze; it preserves authenticated identities and permits the established FrozenMap/FrozenSet/class-shape domain. Reuse it rather than a new JSON copy, shallow `Object.freeze`, or accessor-reading recursive walk. This preserves the existing DATA precondition; it is not a claimed defense against arbitrary Proxy traps. No proxy promise is added.

In `acceptPreparedIrProgram`, choose the required wrapper for Linear as the initial program validation; return its existing failure shape immediately. Other backends retain generic validation. In `planPhysicalSetup`, perform the same required wrapper for Linear before reading projection.prepared, program.abi, constructing bodies, or calling resource planners. Preserve exact projection membership and backend/target checks; a valid program does not authenticate a caller-supplied unrelated projection. Existing repeated generic assertions may stay: covered attached generic validation must itself select the proven zero-analysis branch; deleting those checks to obtain zero counters is unsound. A required out-of-profile request returns before those repeated calls. Replayed accepted plans traverse the same real gates on current DATA.

Keep the existing allocation materialization refusal (`preparedLinearAllocationResourceGap`) until resources are genuinely composed. Evidence admission must not convert its absence into successful native emission. The first honest milestone is reaching the same resource gap with measured zero consumer allocation analyses for genuinely covered, attached input.

## Codec remains a real round trip

Phase1 `program-codec.ts::assertPreparedIrProgramShape` begins with the same optional screen. Its normal generic absent behavior stays unchanged. `reauthenticatePreparedIrProgram` first shape-checks, regenerates every runtime projection with `prepareWholeProgramRuntimeManifest`, compares all persisted fields against the regenerated result, freezes it, constructs the reauthenticated program and invokes complete generic validation at the end. Preserve this exact reproduction and identity process; do not use shape validation as acceptance. Encoding and detached decode remain lossless DATA paths; accepted generic decode may legitimately run legacy analyses for an uncovered program. Later native acceptance must still use the required gate.

## Finite next-join controls, assigned to existing ROOT18 requirements

These are required assertions for the real joined entries, not extra fabricated green registrations:

- AE38/AE18: with attachment absent, individually place accessor descriptors at schema, ir, allocations, runtime and runtimeSupport on otherwise real prepared DATA. At actual Linear accept and direct physical setup, every getter counter remains zero and a typed invariant is observed. Include a nested accessor to prove whole-graph coverage. Paired attached controls retain existing accessor/own-undefined attachment diagnostics. A separate deliberately invoked getter proves observer liveness.
- AE29/AE32/AE39: a genuine nonzero-registry program without attachment reaches required-native located Unsupported before registry construction/encoding/ownership/escape/stack/planners/reservation, with a real same-binding producer/legacy positive then reset. Its unchanged generic validation still takes legacy analysis and reproduces baseline acceptance/errors. A real zero-registry scalar absent control remains accepted by the existing legacy path and is reported separately rather than counted zero-analysis.
- AE33/AE34/AE35/AE37: alter complete ABI, contextual SSA, support or runtime reproduction in attached input; each original invariant remains fatal even when target copies and leaf metadata agree. The finite leaf never replaces full context. Support0 is the initial capability; illegal current Linear/support remains invariant under the formatter-only WasmGC:standalone rule. General support needs a separate authenticated population join.
- AE30/AE31/AE36/AE40: actual producer/codec/direct consumer checks with covered input give zero consumer allocation analyses and then the unchanged physical resource gap; actual generic uncovered round trip still runs legacy validation. Present-undefined numeric encoding fixture remains semantically rejected. No fixture is rewritten to make a consistency-only verifier look semantic.

These are not completion claims for eighteen ROOT registrations or the forty full requirements. J2 controls, original18 with its retained encoding failure, Phase1 thirteen, J1 and preservation cohorts keep distinct denominators. Every zero interval needs a live positive using the same instrumented real binding; import-only or stub observers do not count.

## Disjoint custody and source preservation

C's four source/test paths are exactly:

- `src/shared/contracts/linear-memory-layout.ts` — shared geometry DATA/constants/functions.
- `src/ir/analysis/contracts/linear-memory-layout.ts` — geometry declaration replacements and identity reexports only.
- `src/ir/analysis/linear-memory-plan.ts` — agreed geometry constants/layout helpers/adapters and geometry imports/reexports only.
- `tests/issue-6865-linear-layout-contract.test.ts` — C geometry controls.

The recorded coordination is in `/private/tmp/js2-6920-shared-linear-geometry-20261009/.tmp/session-a-thread-watch-20261009.md` and `session-c-geometry-confirmation-20261009.md`; the latter records A's release and C's claim. This is documentary custody context, not a freshly verified claim grant. C does not own allocation facts, semantic evidence, source proof, boundary inventory, registry, or public integration. A retains those duties and their separately assigned workers. No concurrent whole-file replacement of shared linear-memory-plan is permitted.

A's J2 snapshot/facts hunk owns the three new canonical homes specified in the frozen J2 proposal, generic contract/type moves, facts/snapshot/collector definitions/imports/reexports and actual producer/planner caller rewires. Geometry and facts coexist in one physical file: root appoints one composer from a concrete agreed successor, authenticates the complete combined file, and attributes exact hunks. Required-native validation/consumer/physical/codec changes are A integration ownership and outside both the tiny leaf correction and C's geometry release. Existing B/provider/runtime responsibilities remain untouched.

Prerequisites before consumer solver skipping: compose actual Phase1+A2+J1+J2 with original source bytes retained, preserve the fifteen dirty A2 files rather than transplanting its obsolete candidate, and finish actual rule-sharing AE28. A new extraction preservation successor must authenticate all affected donors/new owners and reconstruct the pre-J2 J1 contract before the unchanged J1 successor; lattice/escape continue to Phase B pins. Shared memory-plan must join C's actual geometry epoch and the retained lowering proof chain. Exact semantic additions (encoding value guard and site-reuse classification) need explicit deltas and real negative controls; never normalize them into a false byte-identical relocation or repin historical receipts. Root independently reported J1 326/326; this document does not remeasure or broaden that result.

No fake adapter, no preapproved skip callback, no uncalled public API, no blanket attachment success. General IR witness, all forty obligations, nonzero support, real native resources and public standalone/WASI `run(1.5,-2.25) === 1.25` remain required.


### Protected-queue delivery decision — recursive class getter fix

Fresh effective canonical-main rules on2026-10-09 contain only six strict required check contexts plus merge queue; no approving-review rule. The previous formal-review assumption is corrected by the actual rules, not waived. Root read the complete exact6597 diff and C independent review6069386313 at `bec8ac003452a63e9a3fa6f8ff57d5f83e69a4af`; paired controls12fail/2pass baseline versus14/14 fixed, inherited neighbor failures unchanged. Fresh required checks have actual successful rows, with skipped duplicates excluded. Head is signed, current main845 and PR CLEAN/MERGEABLE.

Root released only6597 HOLD and submitted the exact head using ordinary `gh pr merge --match-head-commit`, no admin/bypass/force. Effect-read GraphQL: OPEN, exacthead unchanged, isInMergeQueue=true, position1, stateQUEUED, enqueued_at `2026-10-09T01:05:26Z`. This is queue admission, not main delivery. Real merge-group conformance/checks and canonical ancestry/content remain required. All other holds and foreign branches/claims remain unchanged.


### Allocation-site reuse controls — test authorship proposal (2026-10-09)

Authored only the new portable five-registration suite `tests/issue-6920-allocation-evidence-site-reuse.test.ts`, 17068 bytes / SHA256 `0d5d44a9cbdfa8b3c6b444bdb6359506cbb92785d3d6689b7c51e6101623f101`. Fresh canonical test-only claim write `71072-eptamrwm` was effect-read before editing, actual ledger tip `f3d121534ed96a27934a0adad3b8afa4dfb28a37`, owner `ttraenkler/codex-sol-allocation-evidence-site-reuse-tests-20261009`.

The literal SR01–SR05 manifest is `.tmp/allocation-evidence-site-reuse-tests/expected-manifest.json`. Selected TypeScript7 no-emit, format and lint all exited 0; exact source/API/preserved-operand pins and actual call routes are in `.tmp/allocation-evidence-site-reuse-tests/authorship.json`. No collection, test body or runtime helper/probe execution occurred in this task.

Real contextual function verification and the full retained allocation validator are paired with same-function/cross-function reuse, using genuine registry snapshots and original canonical analyses. No helper-only substitute, fake registry or replacement analysis answer is used. SR04 follows the minimum honest type control: nullable registered type versus eligible nonnullable instruction fails resolved-type validation, while an actual repeated null-result occurrence fails lexical definition before reuse. Existing profile exclusions remain unchanged. SR05 uses actual canonical read/write metadata and independent per-site literals, swapping/omitting materialized cells for real negatives; it also consumes the unchanged healthy producer fixture and proves the observer's positive full-caller route before zero leaf counts. Each leaf check and full caller preserves supplied module/snapshot inputs.

This establishes authorship and static compatibility only. These five have a separate denominator and do not replace the original22, J1 eight, sixteen proof controls, original forty/ROOT18, target-facts uniqueness or native/general-IR obligations. Function/allocation-contract validity is not whole prepared population, ABI/projection equality or strict Linear/native admission. No source, original suites, binary bytes, J1/proof files or issue were edited by this lane.


Root independently read the entire five-control suite and packet, exactclaim71072-eptamrwm, preserved original22/fixture/J1pins and two-file source patch. Static selectedtyping/format/lint0. Runtime release is limited to one stock collection then qualified body for new5 and original22, with the existing passive observer and exact authored manifests, closed child records and frozen source/tool/fixture/issue custody. No J1/historical rerun in this finite window; normal hooks may execute their unchanged suites later. Body failures remain failures, no retries/kills/edits inside the window. All broader native/general/full40 obligations retained.


### Allocation-site reuse qualification — actual closed window

New SR01–SR05 executed5/5 and original leaf22/22, zero failures/skips/errors/instrument/IPC/observer faults. One stock collection and one body per cell; four CLI parents exit0; eight stock worker spawn/exit/close records complete. Genuine contextual/provenance/full allocation-validator positives, malformed error precedence, per-site read/write swaps/omissions, authentic fixture and same-binding constructor/analysis observations all passed. Input validity here is the function/allocation contract, not whole prepared population or native admission. No J1/historical rerun in this finite window.

Root independently read final actual rows/floors/closure, verified all24 raw artifact byte/SHA pins, and reread all9051 current frozen operands against after-window custody: zero drift. Final receipt56213 bytes/SHA256 `9c7b5e55d31dffed65b44050d1c83098691bfc4b1ce6a941af8822ec0ab59981`; after-window custody2020871 bytes/SHA256 `cfa3749397b75e0bbf07e94d849eb9c6dc9c7078a84cc1b62cf5cd5aa7c99b2c`. Source fix and five controls are qualified for normal signed follow-up commit and fork publication through a ready PR. Do not rewrite b1a or claim current native admission/full40/general witness/equality/retirement.


### Session A source publication handoff — 2026-10-09

Signed tested SOURCE_HEAD `d413734a7d189c6d3eb6d93403a32fbee0a93e21`, parent checkpoint `b1a60eab2158dafa62af87dd39db808c8b2ba0f2`, remains based on canonical8452732f0b88c14c5c7634ece58f83240970ea4c. Full normal commit and Node25.9 pre-push hooks passed; actual fork branch readback matched d413. Ready PR6599 “feat(ir): verify allocation evidence with preserved provenance” is OPEN/HOLD pending independent Astra review and the concrete primitive-annotation guard/regressions; no main delivery or queue release for this checker.

Fresh metadata-only claim `6920:session-a-source-handoff-20261009`, owner `ttraenkler/codex-sol-session-a-source-handoff-20261009`, write89995-6v69lqr6, authorizes only the append in existing `plan/log/ir-coordination-session-a.md` and this publication record. Historical handoff and complete prior issue bytes are retained. This later documentation commit is a separate publication head, to be confirmed externally after push; d413 remains the tested source epoch. All eighteen nonmetadata source/test/fixture/policy/proof paths are unchanged. No source authorization follows from documentary publication.

The handoff records actual claim owners/hunks, separate22/eight/sixteen/five test floors, closed runtime custody, preserved initial signing/Node24 failures, unchanged architecture/godfile baseline debt, C geometry claim4237 and A released60707, untouched B/foreign work, and pending native/general witness joins. PR6597 DATA dependency is now verified delivered on main d2beec5ce7952d1271ce6188422eb8a533845656 with exactbec8ac head ancestry/blobs;102 actual shards and0/48735 regression gate succeeded using cached088046348f71f3fc7a2301dbcff6444fe2967bbc base distance1, required quality/equivalence/diff succeeded, but postmerge cancelled CI/nonrequired shards are not full-green evidence. This delivery does not rebase or deliver PR6599. Root retains all HOLD, integration and protected queue decisions.


### Independent Astra review of published checkpoint — bounded carrier correction

Root read the full independent review of tested source `d413734a7d189c6d3eb6d93403a32fbee0a93e21`, SHA256 `b3c0ecb477148e3a4d3823f237935b8900c8b33c5cbe12b26069d8df3e64f5a5`. One P2 endpoint correctness defect: allocation IDs on numeric instructions are accepted by canonical context/provenance but omitted from the finite allocation census. Genuine scalar-carrier metadata can be rejected as unused, and omitting it can yield false verified status. This is a static source-backed finding; no public join or compiler miscompile is asserted. J1 and its historical proof chain have no additional blocking findings. PR6599 remains HOLD. Published metadata-only head4c9ec99b22c9ca1b48bfd343bef52e4de015db06 preserves source d413 and all old receipts.

Root adopts the exact plan below with one source file only: reuse coverage reason instruction-kind, no contracts union change. Existing sourcechecker owner19199 owns profileInstructionExclusion in effect-rules.ts; separate test owner claims a new allocation-evidence-carriers-tests slice and owns only new testfile. Original22/reuse5/J1/proofs/fixture immutable. Static authoring/type/format/lint allowed; runtime collection/body release withheld until root reads five actual registrations and genuine canonical controls. Root owns issue/integration/queue. No whole-file source replacement or foreign claim release.

## Proposed issue6920 implementation-plan appendix for ROOT adoption

### Close the finite profile over all allocation-bearing instructions

**Scope:** This repairs the first numeric-vector profile. It does not broaden ownership, escape, encoding, native capability, or the canonical provenance contract. Keep J1, legacy algorithms, all historical receipts, original22 leaf tests, original5 reuse tests, and the binary fixture unchanged.

1. In `profileInstructionExclusion`, refuse a defined allocation ID on every kind other than `vec.new_fixed`: `instr.kind !== "vec.new_fixed" && instr.alloc !== undefined`. Return a located `not-covered` result through the existing profile machinery. Reusing `instruction-kind` is sufficient and keeps the fix to one source file; if ROOT wants a dedicated `allocation-carrier` reason, explicitly assign the small contracts union hunk too. Do not use `Object.hasOwn(instr, "alloc")` for this guard: canonical optional own-undefined behavior must remain distinct from a defined ID.
2. Do not add a new canonical rejection to `alloc-verification.ts`, rewrite the source to strip the field, silently delete metadata, or teach this finite checker a primitive-allocation solver. Generic compatibility belongs to the unchanged canonical fallback. Missing, stale and unknown IDs still fail the existing canonical precondition; the new coverage guard does not grant them validity.
3. Add a new separately counted portable test file, suggested `tests/issue-6920-allocation-evidence-carriers.test.ts`, with real registry construction, actual canonical encoding/ownership/escape calls and the full retained `assertPreparedIrProgramAllocations` caller. Use passthrough observers and live positives; no fake analysis values, fake registry or helper-only substitute.

Proposed five registrations (internal table cells do not inflate the denominator):

- **AC01 genuine numeric carrier:** the exact two-instruction example above. Assert `verifyIrFunction` and final canonical provenance success, genuine metadata literals, and full allocation-validator success. Before the fix the leaf incorrectly rejects site1; after the fix require exact instruction location `not-covered` at root0, with all inputs unchanged.
- **AC02 omitted carrier metadata:** preserve site0 namespace activation, omit only site1's row, and assert the full canonical caller rejects the missing site1 evidence. The leaf must return the same coverage refusal, never `verified`; ROOT's future generic fallback must still run canonical validation. Pair with AC01's genuine positive.
- **AC03 admitted-kind carrier matrix:** use valid unique IDs and registered result types for `const`, both eligible `binary` forms, `vec.get`, both eligible `vec.len` forms, and primitive `if`; include one numeric carrier inside an if arm. Require exact root/arm coverage locations, and check their honest canonical metadata with the genuine retained caller. A null-result `vec.set` with a defined ID may conservatively be outside the profile too; do not claim it has a canonical allocation-result write.
- **AC04 absent versus own-undefined:** the same healthy instructions with absent `alloc` and explicit `alloc: undefined` retain existing finite verification/census, where canonical validation accepts them. Ordinary root `vec.new_fixed` remains covered and its required-ID/provenance failures stay independently guarded. Do not reinterpret `undefined` as a new allocation.
- **AC05 live observation and recovery:** the genuine retained caller produces nonzero constructor/solver counters, followed by zero constructor/solver counts during both healthy leaf verification and carrier coverage refusal. Re-run the unchanged healthy view after each mutation; compare complete supplied module/snapshot values before/after. Include unchanged captured producer fixture as a healthy control if useful, without changing its bytes.

Before implementation, ROOT assigns exact source/test custody and records the hunk in issue6920. After static review, ROOT releases only the new five-registration cohort plus existing original22 and reuse5 for paired qualification. Preserve separate denominators and exact source/tool/fixture pins. Broader cohorts or runtime execution remain ROOT-controlled; this appendix authorizes none by itself. Normal source budgets/hooks follow the established publication workflow.

Acceptance: the genuine canonical carrier controls remain accepted by the old caller and become explicitly outside the finite leaf profile; missing carrier metadata cannot produce a finite verified report; absent/own-undefined healthy controls and genuine vectors keep their prior results; no existing canonical semantic/provenance behavior or historical proof receipt changes.



### Defined allocation-carrier controls — authorship proposal (2026-10-09)

Authored only `tests/issue-6920-allocation-evidence-carriers.test.ts`, 13883 bytes / SHA256 `8408defeef5e07864caba84c152ea712ee441119e50ccaa74479bc94183efba0`. Fresh canonical test-only claim write `99228-59u54fsg`, owner `ttraenkler/codex-sol-allocation-evidence-carriers-tests-20261009`, was effect-read before editing at ledger tip `72d3cfebfcb1c813ced05ff1f9e93930dea00926`.

The literal AC01–AC05 manifest, actual API routes, source/custody pins and zero-diagnostic selected TypeScript7 no-emit plus passing format/lint receipts are under `.tmp/allocation-evidence-carriers-tests`. Nine matrix cells are internal to the five registrations. No suite collection, test body, runtime helper or probe was executed.

The exact returned-scalar counterexample has genuine registry IDs and canonical metadata, independently cross-checked against the reviewed owned/local array and escaped/returned scalar literals. Omitting only site1 metadata retains site0 namespace activation, requires the actual full retained validator's missing-ownership error and never permits a finite verified result. All admitted numeric kinds and a nested arm receive exact located refusals with actual canonical positive metadata. Absent and own-undefined annotations retain the complete healthy census; the required vector ID stays independently guarded. Genuine passthrough constructor/encoding/ownership/escape observations are nonzero on the full caller before zero leaf counts on healthy/refused views; module/snapshot custody and healthy recovery are checked after each matrix perturbation.

These are unusual but current canonical allocation/function-contract cases, not evidence of endorsed producer behavior or whole prepared population/ABI/projection/native validity. No helper-only substitute, fake registry, copied solver or replacement annotation answer is supplied. Source, original22, reuse5, J1/proof cohorts, historical receipts, original fixture bytes and issue were untouched by this test lane. Original forty/ROOT18 and general-IR/native/shared-rule obligations retain their separate scope.


Root read all13883 bytes of the five-carrier suite, exact99228 canonical claim, literal five-name manifest and one-line effect-rules guard/inverse. The nine internal cells preserve actual context/provenance/full retained validation positives and distinguish undefined from defined allocation IDs. Statictyping/format/lint0. Execution release is exactly newcarrier5, original22 and reuse5, separate one collection/body pair per cell with Node25.9, reviewed unchanged passive runner/verifier/observer, exact authored floors/names and complete worker/custody channels. No baseline/J1/historical cohorts, retries/kills/input edits or general/native admission credit. Normal future hooks remain required.

Fresh canonical main independently read after getter delivery is `e610189829ad1554b813d6ca224515666b0e2d28`, parent `d2beec5ce7952d1271ce6188422eb8a533845656`. Only benchmark/report and LOC-baseline refresh files changed in e610; getter source/test/issue remains delivered. Main integration into this branch is pending until the current carrier window closes; no source or proof will change during that window.


### F1 allocation-carrier correction — qualified closed runtime window

AC01–AC05 executed5/5, original leaf22/22 and reuse5/5; total32 actual body rows, zero failures/skips/errors/instrument/IPC/observer faults. Six stock CLI parents exit0, twelve worker spawn/exit/close records complete. Genuine scalar-carrier canonical metadata/omission refusal and all nine kind/arm positives passed; own-undefined/required-vector-ID, true positive solver observations and zero leaf/recovery/input-custody controls passed. One stock collection then one body per cell; no retries/kills/frozen edits. No J1/historical/full40/native admission credit.

Root independently verified all36 raw artifact pins, exact authored floors/actual CLI+IPC rows/complete closure and9053 current operand hashes: zero drift. Final receipt70592 bytes/SHA256 `57a9e1aa8d0e335150c33262e036b5e44c031c9e40373df70709a789bbc95c50`; after-window custody2021333 bytes/SHA256 `983100024d82d2d8c80be9afc6a4d0df2844f5bfa6713ca8eac7bf859031e822`. Exact source guard plus five regressions are released for a normal signed follow-up on existingPR6599; historical inputs remain unchanged. Current canonical e610 integration follows this commit after fresh remote/hash validation, no rewrite/force/bypass. Independent Astra delta review and actual CI/queue still required before source main delivery.

### Reviewed F1 correction and exact canonical integration checkpoint

Root accepted the exact-e734 Astra carrier delta review (`ec35adf5b604c7f22c673c66879ee1ed4d8abae802212edf72a038b0b70801d6`). Carrier/source commit full normal hooks passed56/56. The normal signed merge `1d9a6c8a16de6b393f8c78e0055f52388ab2b6af` has exact parents e734e6331bd4cbdb1d8f9e5abb9b462957ac94de and revalidated canonical main e610189829ad1554b813d6ca224515666b0e2d28; full normal Node25 merge hooks passed70/70. All21 prior candidate file pins and14 canonical dependency file pins remain exact, with clean tree and verified Thomas SSH signature. Merge receipt8080 bytes/SHA256 `c9e8cb8597419fe33102996afddea1ee278ff14655faf2ffd39c89be60719149` retains complete operands and hook/signature artifacts.

Metadata slice6920:session-a-source-handoff-20261009, owner ttraenkler/codex-sol-session-a-source-handoff-20261009, actual in-progress write89995-6v69lqr6, was freshly effect-read for the publication record. This append preserves every prior issue/handoff byte and source/proof epoch. SOURCE_HEAD1d9 is distinguished from the later metadata publication hash, which requires actual remote readback. No source change, B-contract completion, general/native/public admission, equality, retirement, CI acceptance or queue release follows from metadata publication; root retains those decisions.


### ROOT-adopted AE28 canonical local-rule successor — preparation only

ROOT read and adopts the complete Astra High plan below, exact37610 bytes/SHA256 `72e41c5a4f250471c15f6ae1bb42bc1d956edaa7d9633360b449999b492d3644`. New isolated worktree `/private/tmp/js2-6920-ae28-rules-20261009`, branch `codex/6920-ae28-rules-20261009`, starts at exact published predecessor `1e388ef647c9827102b87e869f7526f8c928f11e`. The queued checker lane is untouched. At root's preparation readback PR6599 is OPEN/unmerged, protected group58994f7b4d2cbc1a239b8fb0c0e3f39644066489 has exact parents e610189829ad1554b813d6ca224515666b0e2d28 and1e388 and identical tree1e388; real merge-group run37873242369 is queued/nonterminal and CI37873242356 in progress. This records no main delivery, acceptance or terminal success.

Actual new canonical source claim `6920:ae28-canonical-local-rules-20261009`, same existing checker owner `ttraenkler/codex-sol-allocation-evidence-checker-20261009`, write43989-lv9fr4w8, and disjoint metadata claim `6920:ae28-plan-adoption-20261009`, same owner, write44305-2ijq5h0r, were effect-read in progress on the new branch before this append. Old source claim19199 and all foreign claims remain unchanged. Source custody is only five proposed hunks: ownership.ts applyInstrEffect vector cases/import; escape.ts analyzeEscape.visitInstr three vector cases/import; encoding.ts classifyInstr descriptor/import; effect-rules.ts descriptor comment only; census.ts applyEffects local-facet guards. No executable source release occurs in this preparation; ROOT must separately authorize implementation, tests and proof custody.

The complete pre-claim canonical ledger tip72d3cfebfcb1c813ced05ff1f9e93930dea00926 contains2972 records; fresh all32-open-PR/file pagination finds no foreign overlap with these five paths (only queued6599's own effect-rules/census). Historical donor claim82145 is done/released; actual3518 Phase B source plan names ownership/escape/encoding. Held34529 is registry/facade/seam only. The actual6837 source plan excludes existing analyses and owns orchestration/middle-end paths; held12877/54169/64646 do not grant these donor vector dispatches. A2's actual fifteen dirty paths exclude allfive. Held54017/75863/76271 remain separate proof/policy/adapter custody and are not assigned here. This audit is path/hunk-specific, not a title-based release or permission to modify historical proof readers/boundary metadata.

Scope provenance is retained explicitly: `plan/log/3518-ir-wrap-up-2026-10-01/validation-lowering-extraction-spec.md:70` names the three donor paths; `plan/agent-context/3518-preparation-ownership-implementation-plan-2026-09-08.md:26` assigns only registry/facade/seam to34529; `plan/issues/6837-ir-modular-analysis-optimization-pipeline.md:84` explicitly excludes existing analyses from the orchestration source writer. Actual records and complete paginated PR file census are preserved in this lane's `.tmp/ae28-ledger-all-records.json`, `ae28-ledger-relevant-records.json` and `ae28-open-pr-file-census.json`; this is no blanket declaration that every held claim is free.

All original source/test/proof/fixture bytes and prior issue prefix remain preserved. The initial signing and Node24 pre-push failures, canonical godfile/boundary debt, original finite/historical runtime receipts and broader unfinished native/general/full40 obligations remain evidence. No source/test/proof edit, compilation, runtime, collection, source-branch commit/publication or queue action is authorized by this preparation; the two normal assignment-registry writes are recorded above. Full adopted plan follows unchanged.

## Implementation Plan — AE28 canonical local allocation-rule sharing

Proposed appendix for issue6920, **Native Linear numeric-vector shared source handoff and integration plan**. Prepared by Codex GPT-6 Astra High, 2026-10-09. ROOT must read and adopt this appendix and assign the exact existing-file/test/proof hunks before implementation. This planning task grants no executable edit, claim transfer, runtime execution, publication, queue release or acceptance of PR6599.

### Observed predecessor and scope

Read-only source endpoint: `/private/tmp/js2-6920-allocation-evidence-checker-20261009`, exact published HEAD `1e388ef647c9827102b87e869f7526f8c928f11e`, source merge `1d9a6c8a16de6b393f8c78e0055f52388ab2b6af`. This includes the e734 carrier guard and reviewed canonical DATA dependency. No runtime probe or test was executed for this plan.

The issue's original forty requirements remain intact. AE28 is the held requirement **shared finite rules preserve exact canonical annotations**; it must establish actual donor sharing, exact baseline/candidate annotations, and a genuine stack-candidate producer positive before a leaf no-call observation. This plan does not discharge AE08/18/21–23/29–40, the general IR witness, public standalone/WASI `run(1.5,-2.25)===1.25`, or any migration/retirement obligation. The already qualified leaf22, reuse5, carrier5, J1 eight and historical cohorts keep their own denominators and receipts.

The useful next implementation is **five small existing-source hunks, without another production module**: share the existing local descriptor with canonical ownership, escape and encoding, then make the finite consumer explicitly require the descriptor's zero direct-escape/no-encoding contribution. Keep canonical schedulers, alias analysis, namespace materialization, metadata writeback and generic fallback intact.

### Architecture decision: share local effects, retain each algorithm's responsibilities

Keep `src/ir/analysis/allocation-evidence/effect-rules.ts::allocationEvidenceEffect` as the single owner of the currently supported local rules. Its existing location is in generic IR analysis, not in a target backend. It imports core instruction/operand/type contracts and a type-only coverage contract; it does not import a solver, program adapter, registry constructor, frontend or target. Moving this small already published function into a sixth module would add custody and preservation surface without removing an existing dependency problem. Reconsider a separate broader rule module only when a later concrete general-rule expansion needs it.

The direction is:

```text
core instruction/type/operand contracts
                |
     local allocation effect descriptor
          /                  \
canonical legacy solvers      finite body census + exact metadata comparison
          |                            |
canonical producer metadata   invocation-local generic truth report
          |                            |
          +--- later authenticated generic program adapter ---+
                                                              |
                                      later target facts/resources/native decision
```

No target imports are introduced into generic analysis. No target facts, stack layout, resource handles or emission decisions belong in the descriptor. The later adapter still authenticates complete original/support/projection populations, contextual ABI/SSA/types, descriptors, provenance and facts consistency before using any report. A report is not a reusable authority object or a new JSHost support mode.

Do **not** substitute `analysis/effects.ts::effectsOf` for these rules. That existing model is shared scheduler/DCE heap/control/slot information; `writesHeap` does not say which value escapes, `readsHeap` does not encode an ownership access set, and it supplies neither direct escape attribution nor encoding writes. Its memoized recursive traversal also has different occurrence semantics. It remains unchanged.

### What is reusable, and what is a finite-profile theorem

| Source fact | Shared owner and meaning | What it does not establish |
| --- | --- | --- |
| `vec.get`, `vec.len` read `instr.vec` | Existing descriptor's ownership operand event; canonical ownership applies `touch(..., null, "read")` | Receiver is owned, local, a numeric vector, or dominated by an eligible root |
| `vec.set` writes receiver, then escapes `newValue` | Existing descriptor preserves this exact event order; canonical ownership uses existing `touch` and `markEscaped` | Stored value is primitive; receiver escapes; direct escape class is stored |
| Three vector operations have zero **direct** escape edges in the current canonical attribution pass | Existing descriptor's `directEscape: []`; canonical escape consumes that rule | Final escape is local. Ownership's backstop can still make a stored allocation opaque |
| const, supported binary opcodes, vec.new_fixed, vector get/len/set, and if have no encoding write at the local instruction | Existing descriptor's `encoding: "no-write"`; canonical encoding consumes it at `classifyInstr` | Strings in child buffers have no write, unrecognized instructions are harmless, or a default encoding may be manufactured |
| Local effects of if are empty | Descriptor covers only the if instruction's own contribution | Its children have no effects. Each caller must retain its existing traversal and alias responsibilities |
| Canonical access ordering and union | Existing `lattice.ts::AccessSet` | A new copied lattice or alphabetically sorted replacement order |
| Owned/local/true on admitted vector sites, absent encoding and absent stackCandidate marker | Finite census derives this only after the complete restricted body check | A generic per-allocation rule applicable to aliases, calls, loops, reference-valued carriers, extra allocations or absent evidence |

The current duplication is precise: the leaf descriptor repeats the canonical ownership vector cases; direct vector escape and numeric encoding no-write are currently implicit defaults in their canonical passes; and the finite consumer does not read its descriptor's directEscape/encoding fields. The owned/local metadata literals are **not a second general solver** if they remain conditional on the proven closed profile. Extracting generic constructors that merely return those literals would not prove the condition and would create misleading authority.

The profile must retain all exclusions: one ordinary block, primitive parameters/results, root-only unique live vector sites, earlier-root receivers, exact lexical scopes, closed opcode/operand census, no reference carriers, no allocation aliases/site reuse, no async domains, and the F1 guard for every defined non-vector allocation ID. In particular, do not move `profileInstructionExclusion` or call it from legacy solvers: canonical solvers intentionally accept broader inputs, including the unusual scalar allocation carriers now refused by the finite checker.

### Exact production edits

**1. `analysis/allocation-evidence/effect-rules.ts`**

Keep `AllocationEvidenceEffect` and `allocationEvidenceEffect`'s current public shape and supported cases. Retain `unsupported` outside that rule domain. The descriptor is instruction-local; it must not recursively traverse buffers, instantiate a registry, read metadata, inspect target facts, classify lexical dominance, or invoke an analysis.

Update its stale “Legacy analysis sharing is a separate source join” comment only when all three joins below actually exist. Document that descriptor recognition is not profile admission. Preserve the e734 guard and all function/profile/operand behavior byte-for-byte. There is no need to widen `directEscape: readonly []` into a speculative general escape-event schema in this slice.

**2. `analysis/ownership.ts::applyInstrEffect`**

Add a named import of the existing descriptor. Replace only the existing `vec.get`, `vec.len` and `vec.set` switch bodies with one shared-case block consuming `effect.ownership` in order. Keep aliasDerived result seeding before the switch. Use the existing helpers:

```text
read/write event -> touch(state, event.value, allocOf, null, event.op)
escape event     -> markEscaped(state, event.value, allocOf)
```

A shared vector case must require `effect.kind === "effects"`; an unexpected unsupported descriptor is an internal rule mismatch and must fail loudly, never fall through to an empty effect. Use one explicit local Error if needed, rather than adding a new public error contract or helper framework. This unreachable-on-the-fixed-rule-domain safeguard is part of the reviewed substitution and must be recorded in the preservation recipe. Do not keep a second vector-effect fallback table.

Moving the vec.set case beside the two read cases is allowed as an exact named span change; it must still emit receiver write **before** newValue escape. Do not put a broad descriptor early return in front of the entire switch. In particular, if must keep its then/else recursive traversal and its existing alias behavior; binary i32.eq/i32.ne identity effects must stay unchanged. Leave `runBlock`, allocation/alias collection, worklist, MAX_VISITS, block joins, alias fixpoint, terminators, result queries and registry writeback untouched.

**3. `analysis/escape.ts::analyzeEscape`'s `visitInstr`**

Add the descriptor import and exactly three named vector switch cases. Require the recognized descriptor's `directEscape.length === 0`, then finish that local case. An unsupported descriptor or unexpected nonzero direct-edge population is an internal rule mismatch, not permission to drop edges. This deliberately consumes the descriptor's current closed zero-edge contract; it does not add a new direct stored edge for vec.set.

Keep direct edge rules for object/class/refcell stores, captures, calls, returns and throws unchanged. Keep all child traversals, severity ordering, allocation collection, ownership backstop and writeback unchanged. Do not return early for if merely because its descriptor has no local edge. The implicit no-vector-edge default is made explicit and shared; final local classification still belongs to the complete canonical pass or the finite-profile derivation, not this direct-edge check.

**4. `analysis/encoding.ts::classifyInstr`**

Add the descriptor import and a local recognized-no-write dispatch before the existing switch. A recognized descriptor with `encoding === "no-write"` returns without calling `record`; unsupported descriptor falls through to the unchanged existing switch. An impossible recognized-but-other encoding contribution is a loud internal mismatch if the implementation uses an explicit guard. Do not add any fallback that turns unsupported into a no-write witness for the finite checker.

The admitted binary cases remain only i32.lt_u/f64.add; other binary opcodes still reach their old default. The if no-write return is safe **only because** `analyzeEncoding`'s outer `forEachInstrDeep` still invokes `classifyInstr` for each child separately. Preserve that outer traversal exactly. Keep string origin/join/evidence rules and call binding classification untouched. In particular, explicit encoding evidence and present-undefined annotation behavior are not repaired or normalized here.

Although the older issue called this encoding join optional, this bounded proposal includes it: AE28 must not claim shared encoding absence while leaving that field as an unconsumed decorative value.

**5. `analysis/allocation-evidence/census.ts::applyEffects`**

After obtaining a recognized descriptor, explicitly require its current zero direct-escape and no-write encoding facets before using the finite rule. An unsupported/inapplicable facet returns the existing located `not-covered/instruction-kind`; do not synthesize expected metadata. This is a defensive closure check over the descriptor's present closed types, not implementation of hypothetical future edges.

Keep the ownership-event application and read/write occurrence counts. The escape event may be ignored for vector-site accumulation only because the already executed operand/profile check proves the stored operand is primitive and the F1 guard prevents such a primitive from being an untracked allocation carrier in a verified module. Retain the explanatory comment tying that omission to those preconditions. Do not add an ownership result map, alias graph, solver callback or registry reconstruction.

All remaining source stays unchanged, including `metadata.ts`, `contracts.ts`, `verify.ts`'s behavior, `lattice.ts`, `stack-alloc.ts`, `alloc-registry.ts`, J1 and the program adapters. The stack-kind policy stays with the actual `stack-alloc.ts::allocKindOfInstr` and `SMALL_ALLOC_KINDS`: vec.new_fixed is currently unrecognized by the former, and array is absent from the latter. Do not copy a target/finite small-kind table, export a speculative new stack-policy API, or infer stack eligibility solely from ownership's differently named `isStackAllocatable`. The real producer/positive/counterexample controls below are sufficient for this unchanged policy. A narrowly assigned wording update to verify.ts's remaining-work comment is optional documentation only; do not silently add it to the five-file proof population. Its current statement that legacy sharing remains work can simply be updated in a separately reviewed hunk if ROOT wants that accuracy in this implementation.

### Why the finite result remains exact

For an admitted function, root vector allocations start owned/empty; every possible use is an earlier-root get/len/set receiver. The shared rule can add read/write accesses but cannot widen those roots' ownership. Stored values and all if/return values are primitive and disconnected from vector identity; the carrier guard closes the previously demonstrated loophole. Canonical ownership visits the sole block and both nested arms, so the leaf's AccessSet union equals its per-vector writeback rather than merely overapproximating it.

Canonical escape's direct vector edges are empty and its ownership backstop still sees each vector as stack-allocatable in the ownership sense, so local/true is exact. This is different from the stack-allocation optimization: `findStackAllocCandidates` only recognizes eligible small kinds, and vec.new_fixed receives no ownership stackCandidate marker. Encoding's shared no-write rule applies to every fully enumerated instruction, so requested encoding cells must be absent. The namespace comparator's global activation and unused-slot behavior stay unchanged.

This proof fails outside the profile; the result remains not-covered there. No solver may use the finite profile guard to alter generic legacy behavior.

### Honest counterexamples and validation populations

Use genuine current solvers and registry objects, never copied algorithms or fake annotations. The new source receipt proves bounded source evolution; it does not prove behavioral equivalence by itself. ROOT must qualify exact real baseline and candidate source epochs with the same operand fixtures, preserving return/metadata presence, ordering and error rows.

Keep the issue's designated file for the original obligation: `tests/issue-6920-allocation-evidence-entry.test.ts` may initially contain **exactly one real registration**, AE28 `shared finite rules preserve exact canonical annotations`. The other seventeen held ROOT registrations must remain unauthored, not skipped or presented as green. This file name does not authorize writing an adapter or invoking nonexistent public joins.

AE28's actual body should:

1. Build ordinary typed core fixtures through current builders/helpers and real registries for unused/read/write/read+write vectors, nested-only read, constant-false-arm write and primitive-if numeric inputs. Use exact independent expected metadata literals, own-property presence and canonical access order. Compare actual `OwnershipResult` and `EscapeResult` values as well as snapshots where meaningful. Run the full retained allocation validator on compatible snapshots to prove the metadata is not a local helper invention.
2. Run real `prepareLinearAllocationFacts` on appropriate fresh inputs to exercise the actual producer path through encoding, ownership, escape and stack-candidate selection. This is invocation of an existing producer function over explicitly labeled core fixtures, not a claimed public frontend/codec/native compile.
3. Establish stack observer liveness with a genuine eligible nonescaping object (as in existing `tests/ir/ownership-analysis.test.ts`) that produces a nonempty candidate and an actual ownership `stackCandidate:true` field. A returned object is the negative pair. Arrays remain noncandidates with the marker absent, and actual direct Linear facts retain `stackCandidate:false`. Do not require the generic full allocation validator to accept a small-object snapshot containing a producer-only marker it historically does not reconstruct.
4. Reset real constructor/encoding/ownership/escape/stack/prepare-facts observers after producer capture; call only the actual finite leaf on an eligible complete numeric view and require zero calls to those producer/solver bindings. A descriptor call is pure rule execution and is allowed. Preserve original input graphs and legitimate optional values. Do not claim zero public assertion/codec/physical calls that were not invoked.

Add `tests/issue-6920-allocation-evidence-rule-regressions.test.ts` with **six new registrations**, separate from the original forty. All six are baseline-neutral canonical preservation tests and can run identically on the pinned pre-join and candidate sources:

| ID | Required distinction |
| --- | --- |
| AR01 | Stored allocation escapes through ownership while vector direct-edge attribution remains empty. Use a canonically valid reference vector/store or the established numeric allocation-carrier form; arrange no direct return of the stored allocation. Pin canonical opaque fallback, not an invented stored classification. Keep a true local pair. |
| AR02 | Reference-valued if/select or slot alias followed by escape still propagates to the original allocation. Primitive if remains finite-covered; reference carrier remains outside the leaf. This catches an accidental broad descriptor early return that skips child effects or alias seeding. |
| AR03 | i32.eq/i32.ne identity effects and at least one opaque call/return case stay on the old ownership/escape rules. i32.lt_u/f64.add remain their old no-local-effect cases. Include genuine context/type declarations for calls rather than treating standalone incomplete verification as full validity. |
| AR04 | String const/concat/repeat or an existing genuine provider-bound call retains real encoding writes, including an encoding-producing child under if. Root if is locally no-write but its string children must still be visited. Keep the original explicit-evidence/presence outcomes; no fixture repair. |
| AR05 | Scalar allocation carriers and repeated sites retain complete canonical annotations/write order and remain leaf-uncovered under current guards. Missing one active site's evidence still fails the full retained validator. This prevents the legacy solvers from accidentally adopting the finite profile's exclusions or a sitewise union. |
| AR06 | Multiple independent sites/functions, all four global namespace materialization modes, unused original live/alias/retired slots and empty rows retain exact existing canonical outcomes. Compare by the current contract: order-independent namespace lookup where permitted, but exact ordered access arrays and exact property presence. Retain valid alias-to-retired legacy behavior separately from future strict snapshot behavior. |

Do not require every out-of-profile example to pass every target-facts checker: legacy and strict target domains differ. Record precisely which actual function/allocation/full-prepared authority is invoked. Reuse existing valid fixtures for less common IR kinds. A demonstration excluded by the finite checker is useful donor preservation, not new finite capability.

Add a separate one-registration `tests/issue-6920-allocation-evidence-rule-sharing.test.ts` for **AR07 actual donor bindings reach the shared descriptor**. Use a passthrough observer around the real exported `allocationEvidenceEffect`, preserving its actual return. Invoke ownership, escape and encoding separately on controlled vector instructions and assert each route really consults it; include nested vectors to show traversal remains live. Then invoke the finite leaf and observe the same original descriptor. Keep all other exports actual. This registration is candidate-only because the predecessor intentionally has no donor joins; do not mark it skipped in a baseline run or count it as a baseline equality row.

Thus the initial semantic plan has **seven paired registrations** (AE28 plus AR01–AR06) on baseline/candidate, and **one candidate-only sharing registration** AR07. Original22/reuse5/carrier5 remain separate regression cohorts. Exact test names and literal manifests must be frozen by the test author and reviewed before any runtime release. Internal matrices do not inflate these denominators.

### Preservation successor: exact predecessor plus reciprocal replay

The three donor files still exactly match their Phase B current-source pins at this endpoint (checked by reading the retained JSON and hashing current bytes). Any donor edit will therefore need a new successor, not repinning that receipt or weakening its original mutants.

Proposed new proof files:

- `tests/helpers/ir-allocation-rule-sharing-successor.ts`
- `tests/helpers/ir-allocation-rule-sharing-successor.json`
- `tests/issue-6920-allocation-rule-sharing-preservation.test.ts`
- one exact named-import/raw-reader composition hunk in `tests/helpers/ir-validation-analysis-relocation.ts`

The new receipt authenticates the **complete five production files** listed above, before and after, including the existing shared rule module and census even though those are not Phase B donors. No whole-file executable copy of a legacy algorithm is created. Record exact named import/dispatch/comment/finite-facet-check edits as reviewed source evolution. The new joins are semantic-preserving substitutions with independent runtime obligations, not falsely described as byte-identical declaration moves.

Required operation:

1. Authenticate the fixed root-reviewed receipt bytes and closed schema, exact path population, lengths, SHA256 and Git blob IDs. Read every complete current source exactly once within a reconstruction invocation; do not cache a prior successful reconstruction.
2. Verify parsed roles for the actual descriptor import and local dispatch sites: ownership call after aliasDerived seeding; exact three vector cases; event order and existing touch/markEscaped bindings; escape vector-only zero-edge guard with untouched child/backstop placement; encoding rule check in classifyInstr with outer traversal untouched; census checks all local facets before accumulation. A descriptor import that is never used is not sharing.
3. Apply only the declared inverse edits and authenticate the complete pre-AE28 files. The three reconstructed donor hashes must join the unchanged Phase B receipt's current rows. Reconstruct exact effect-rules/census preimages too, including the carrier and site-reuse fixes; do not normalize those away.
4. Independently replay forward from the reconstructed predecessors using the recorded exact recipes and require equality of every complete live source file. Unchanged scaffold, imports, diagnostics and trailing source remain covered. Literal source snippets in a receipt are non-executable transformation data; never eval or import reconstructed receipt text as a baseline implementation.
5. Feed those exact predecessor sources into the existing J1/Phase B reader chain. One suitable composition is `readIrValidationAnalysisActual(path) = readBeforeIrAllocationProvenanceLookup(path, p => readBeforeIrAllocationRuleSharing(p, readIrValidationAnalysisRaw))`. The new successor acts only on its declared five paths and otherwise reads the supplied predecessor stream unchanged. For Phase B donor reads it supplies pre-AE28 bytes; J1's four-source reconstruction still executes on its unchanged domains. Preserve the old-stage injected-reader semantics so an old mutant is tested as an old-stage mutant, not magically repaired or promoted to live proof.
6. Run the unchanged Phase B nine-original/thirteen-current/135-transfer inverse and reciprocal, and the unchanged J1 four-current/three-before successor. Original JSON bytes, trust digests, old test fixtures, mutation expectations and floors remain untouched. Changes to an original proof must not be disguised as a source pin update.

The current J1 helper/receipt need **no edit** for these five source hunks. Do not add an AE28 route to them merely to make the graph look uniform. The common Phase B reader owns the actual integration. If the real source/proof audit reveals another reader requiring adaptation, stop at that named hunk and ask ROOT to assign it; do not make broad text replacements.

Author **twelve new preservation registrations**, separate from the semantic and historical cohorts:

| ID | Required proof control |
| --- | --- |
| AP01 | Complete five-source inverse and independent forward equality; predecessor donor pins join original Phase B rows. |
| AP02 | Actual J1 then Phase B chain executes with original receipts byte-identical and all expected historical populations present. |
| AP03 | Every current source and both historical receipts are mandatory in the complete chain; missing/wrong-path substitutions fail. |
| AP04 | Warm-success then current-source drift fails on a fresh call; restored genuine source succeeds. No successful cache. |
| AP05 | Ownership route/order mutations fail parsed-role diagnostics independently of outer file hashes: omit shared call, swap write/escape use, move before seeding, shadow binding. |
| AP06 | Escape route/child/backstop and encoding traversal/no-write placement mutations cannot be hidden by inverse recipes. |
| AP07 | Descriptor semantic mutation and dropped census facet guard fail authentication; finite profile/carrier guard cannot be erased by reconstruction. |
| AP08 | Complete unchanged scaffold/import/diagnostic/trailing-byte changes are covered. |
| AP09 | Closed receipt population, span bounds, duplicates/order and recipes reject malformed records; caller-supplied repins are not authority. |
| AP10 | A structurally plausible wrong forward recipe fails independent replay rather than being accepted by its inverse alone. |
| AP11 | Historical-stage donor mutants reach original historical assertions; supplying an already historical file cannot stand in for current live proof. |
| AP12 | Fresh bounded capture and passthrough behavior; proof failure in the new live stage cannot be concealed by a separately supplied historical snapshot. |

The source-role diagnostics need not become a generic TypeScript interpreter. Fixed whole-file/receipt authentication bounds the actual reviewed change; role checks independently reject named dangerous placements and bindings. Do not claim arbitrary semantic equivalence from spelling matches alone.

### Exact predecessor pins and dependency custody

Static pins read at published1e388 (these are not new passing runtime evidence):

| Path | Bytes | SHA256 |
| --- | ---: | --- |
| `src/ir/analysis/ownership.ts` | 23654 | `9c622ef53c8c9c1ecbc1c0bc8eee907dfb00da82a5f16c89feecb0c6d918495f` |
| `src/ir/analysis/escape.ts` | 10829 | `72d036b3565c778b29425f9c853276d67d48b13e2dfff6d38d8d4afa327e4c53` |
| `src/ir/analysis/encoding.ts` | 10358 | `e1a4e863db13b51769904457502adcca368cf4a9d8bacf79659daaba34596c23` |
| `src/ir/analysis/allocation-evidence/effect-rules.ts` | 5949 | `8b59082258a7422a6a7913e3af593aa98b0f2fa57b1cd3b7d9b84f799d7ca761` |
| `src/ir/analysis/allocation-evidence/census.ts` | 9853 | `ed9b780817a6f2521b67b9b748ea9e4b6bb2328ea17539be574b7639b8c57e60` |
| `src/ir/analysis/stack-alloc.ts` (unchanged) | 4570 | `05524070d9665dc9f56e192b734d74394098432dc7fea1a96d71897eb4e35b18` |
| `src/ir/analysis/lattice.ts` (unchanged) | 5739 | `8814ff9b71c04e9e16760a913984aaba60f23b402a700968fd6c2a70c92fc22c` |
| `tests/helpers/ir-validation-analysis-relocation.ts` | 18566 | `69a9f38de63cf98321189e4e2928fa04af784244faa9732961751a66a96da0f1` |
| original Phase B JSON | 327660 | `9a52664fbba6044d168f428f9398e5d2bff923cf7cac1adc6aae04827431e969` |
| unchanged J1 helper | 29831 | `7f818067a0ecb8963f582e232f1692af9d3ca9283b9596f42e9ab8846f1f6443` |
| unchanged J1 JSON | 11637 | `4528c914b70535665feebbd0f93ed5d43ef0a5fbb9b4a752e056da84f89a2c7d` |

ROOT must freeze the exact actual implementation predecessor anew; this table is not permission to overwrite a later legitimate change. The J2 proposal will later move type declarations from lattice/escape and shares the Phase B proof domain. Prefer sequencing this bounded join and its successor first, then have J2 reconstruct this epoch before the retained AE28/J1/Phase B chain. If ROOT chooses another order, specify an exact new composed predecessor and add a separate successor; never rebase the proof by changing original digests.

Existing claims from the issue are not inferred authorization for new donor edits. **Actual root assignment/claim checks are required before executable work** for:

- ownership/escape/encoding's named import and dispatch hunks;
- effect-rules/census's named checker hunks with their current owner;
- the new semantic test files and AE28's single original-registration hunk;
- new successor helper/receipt/test plus the old Phase B reader import/composition hunk;
- any issue budget allowance or policy update, if actual gates require one.

No new production module is planned, so a module-count/boundary inventory change should not be necessary. Validate the actual all-reference dependency graph, including type imports/reexports/dynamic imports, and demonstrate the forbidden-edge detector on a controlled negative input. Do not edit boundary or LOC baselines to make the change pass. Genuine growth allowances belong to this issue after exact measured need and ROOT approval of the hunk.

C retains the four agreed geometry paths/hunks: `src/shared/contracts/linear-memory-layout.ts`, `src/ir/analysis/contracts/linear-memory-layout.ts`, geometry parts of `src/ir/analysis/linear-memory-plan.ts`, and the issue6865 geometry tests. AE28 edits none of them. Calling the existing prepare-facts producer in tests does not confer its source custody. B's native leaves, A2's fifteen dirty files and its facts-extraction claims, generic consumer/native joins, allocation registry/contract moves, public pipeline, runtime resources and queue remain excluded.

### Qualification and acceptance sequence

1. ROOT adopts the appendix and confirms exact source/proof/test claims. A latest Sol implementer receives the five bounded source hunks; no new parent goal or source ownership is inferred from this planning task.
2. Freeze the real predecessor and all source/test/proof/tool operands. Author the source and new tests, independently review the actual rules/dispatch and the genuine fixture contracts, then finalize the new proof receipt only after ROOT reviews the complete transformation and current operands.
3. Before runtime, run authorized selected typing/format/lint plus source budgets, dependency/boundary/cycle/dead-export checks. Existing canonical architecture debt stays separately attributed. Do not regenerate original receipts or grant budgets from an unrelated issue.
4. ROOT releases actual baseline/candidate semantic qualification: seven paired registrations, one candidate-only live-sharing registration, existing32 candidate regressions, and the new12 plus unchanged historical proof cohorts. Existing ownership/escape/encoding analysis suites are relevant donor regressions; qualify their actual collected denominators rather than importing old counts. Exact cohorts and execution order may be split into frozen windows, but none may be silently omitted or merged into a misleading total. No general/full-Test262 execution is implied by this plan.
5. Pair exact annotation/error rows on identical operands and distinguish deliberately different shared-rule invocation counts. Every zero interval has a genuine positive on the same real binding. Close process/IPC/observer records and hash custody before source or issue edits resume. Preserve failures; no retries, kills or source changes inside a frozen window.
6. Independently review the actual source and proof successor, run normal required commit/push hooks and current-base budgets, then publish through the existing authorized workflow. PR6599 queue decisions remain ROOT's separate task. AE28 completion requires the actual donor joins and their qualified paired/proof evidence, not merely this appendix or the existence of a descriptor.

Bounded acceptance: exact canonical annotations and diagnostics are preserved on the demonstrated donor domain; each canonical pass really consumes the shared local descriptor; the finite checker still refuses all existing excluded bodies; stack and encoding absence claims have actual paired controls; original historical receipts/algorithms/custody remain intact; no legacy analysis/fallback or consumer validation is removed.

### General body-derived witness remains a required later capability

This slice removes the current local-rule duplication. It does not eliminate the canonical solvers or make numeric-vector inference a universal witness. A later general design must address the following concrete obligations, with actual source owners and new preservation successors:

- **Complete rule domain:** every executable instruction, terminator and nested/state/support buffer must have either an audited semantic rule or a located refusal. Enumerating alloc-bearing instructions alone is insufficient. The F1 numeric carriers and same/cross-function site reuse demonstrate why “allocation == vec.new_fixed” and “site == one occurrence” are not general facts.
- **Identity and order:** authentic owner/unit/block/occurrence/definition/use identity, exact snapshots/alias resolution and complete population joins remain prerequisites. Canonical writes are currently ordered and can overwrite the same site; blindly unioning per-site access sets changes repeated-site semantics. General witness rules must reproduce or separately, explicitly change that behavior.
- **Ownership derivation:** seeds, imported reference defaults, CFG block-argument edges, captures/slots/if/select alias components, terminator effects, joins and worklist behavior must be proved. A certificate that merely supplies a conservative post-fixpoint is insufficient for the present exact-equality contract: forged TOP would otherwise pass. A future derivation certificate can establish reachability from canonical seeds plus complete transfer closure, but the soundness/minimality proof and its resource limits must be designed explicitly rather than presumed.
- **Actual bounded algorithm:** current ownership has a MAX_VISITS guard and ordered worklist, followed by alias propagation. A mathematical least-fixpoint witness is not automatically equal to a canonical run that stops at its guard. Either demonstrate that the bound is never reached for the authenticated domain, refuse that case, or preserve the exact bounded behavior in a separately reviewed design. Do not silently fix its convergence policy inside a witness extraction.
- **Escape composition:** direct classifications, severity joins, alias-derived ownership backstop and exact writeback all matter. vec.set's zero direct edge plus opaque fallback is an immediate counterexample to treating shared local edges as the final escape result.
- **Encoding derivation:** current forward value map, literal code-unit checks, string joins, explicit evidence and identity-based provider rules require their own audited transfer authority and occurrence/order proof. An opaque supplied encoding tag is not a general body-derived proof just because consistency copies agree.
- **Metadata and stack optimization:** complete global namespace materialization, absent versus present-undefined values, unused slots, ownership field shape and stackCandidate augmentation need exact producer-specific rules. Generic no-analysis verification must not require a namespace globally disabled by legitimate preparation, while native admission still requires its materialized evidence.
- **Consumer authority:** only the real generic adapter may combine descriptor/context/provenance/snapshot truth with the report and choose generic fallback versus required-native refusal. Target adapters add facts/layout/resource constraints afterward. No target leaf or passed callback may grant source-body authority, and no public validation may be skipped because a small local descriptor returned recognized.

Those are retained implementation obligations toward the original full migration, not grounds to rename the final goal as the finite profile. The next executable release can usefully complete AE28 while the general witness, J2/J3 composition, original seventeen other ROOT registrations, complete native resources and public equality remain explicitly unfinished.


### ROOT-adopted AE28 efficiency addendum — metadata release before V2

ROOT read and accepts the full15572-byte Astra High efficiency addendum below, SHA256 `7f35c075667d0af290b2dd912a6a9b936741b1a9f1c1cf16a25a43cc8ea7a700`. Source claim43989-lv9fr4w8 and metadata claim44305-2ijq5h0r were freshly effect-read in progress for the SAME existing owner ttraenkler/codex-sol-allocation-evidence-checker-20261009 on codex/6920-ae28-rules-20261009. This explicitly widens effect-rules.ts custody beyond the V1 comment-only hunk: private closed rule/event types and four deeply frozen static rule objects; exported allocationEvidenceRule/allocationEvidenceOperand; and the old allocationEvidenceEffect API as a fresh-materialization compatibility adapter. The same other four source files will consume the new rule binding directly, resolving operands immediately in ordered ownership/census application. No new module, policy table, cache, per-instruction storage, solver or foreign source hunk is assigned.

V1 source pins, static packet, patch and diagnostic recipes remain immutable private evidence and receive no runtime/performance qualification. The real proof predecessor remains exact published1e388ef647c9827102b87e869f7526f8c928f11e, not the uncommitted V1 checkpoint. Original Phase B/J1 receipts and their obligations are retained. Before further executable edits ROOT publishes this scope and releases V2 separately; this adoption changes only this issue.

The planned normal-path rule lookup/resolver policy construction is allocation-free after module initialization; whole analyses still allocate their existing maps/sets/operands/results. Runtime dispatch cost and actual efficiency are unmeasured. The compatibility adapter must retain fresh nested identities/current operands, with controls inside existing paired AR01; candidate-only AR07's title/API explicitly changes to the actual static-rule binding. Seven paired semantic, one candidate sharing and twelve successor-proof floors remain distinct, with original regression/historical cohorts unchanged. No same-speed claim, test floor inflation, source proof repin, runtime, collection, source-branch commit/push or queue action is released here.

Full addendum follows unchanged.

# AE28 addendum: allocation-free shared local rules

Proposed by Codex GPT-6 Astra High, 2026-10-09. This narrowly supersedes the allocating-descriptor dispatch in `plan.md`; all other semantic, ownership and preservation obligations remain. ROOT must publish the issue/claim amendment before executable edits. No source, tests, receipts, Git state or shared issue were changed, and no runtime was run for this addendum.

Reviewed V1 packet: `/private/tmp/js2-6920-ae28-rules-20261009/.tmp/ae28-source-review-packet.patch`, 5,872 bytes, SHA-256 `7894a760c1da6b3f4e3bb20fdd423cbc6daee8c57009c0e62abd3f34fb0af8ee`. V1 is a static-only checkpoint, not a runtime-qualified candidate. Published `1e388ef647c9827102b87e869f7526f8c928f11e` and its receipts remain immutable.

## Decision and exact API

Keep policy in the existing generic module `src/ir/analysis/allocation-evidence/effect-rules.ts`. Replace its rule-producing implementation with a frozen, module-initialized local-rule representation and retain the old public descriptor as a compatibility adapter. No new production file, per-instruction cache, instruction-keyed map, memoized operand, copied policy table, general solver, or visitor framework.

Use these exact new function names:

```ts
allocationEvidenceRule(instr: IrInstr): AllocationEvidenceRule
allocationEvidenceOperand(instr: IrInstr, operand: "vec" | "newValue"): IrValueId
```

Both are named exports with actual production consumers. Keep the representation types and singleton constants private unless a concrete production type import is needed; tests can use `ReturnType<typeof allocationEvidenceRule>`. Do not add test-only production exports.

The private closed types are:

```ts
type OwnershipRuleEvent =
  | { readonly op: "read" | "write"; readonly operand: "vec" }
  | { readonly op: "escape"; readonly operand: "newValue" };
type AllocationEvidenceRule =
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "effects";
      readonly ownership: readonly OwnershipRuleEvent[];
      readonly directEscape: readonly [];
      readonly encoding: "no-write";
    };
```

Create exactly four private rule objects once: `UNSUPPORTED_RULE`, `NO_LOCAL_EFFECT_RULE`, `VECTOR_READ_RULE`, `VECTOR_WRITE_RULE`. The read rule has one `(read, vec)` event; the write rule has ordered `(write, vec)`, `(escape, newValue)` events. Freeze each rule, each event, and every nested array with `Object.freeze`; `as const` alone is insufficient. Sharing frozen empty arrays is safe. Do not put an instruction, value ID, registry, closure over an invocation, or resolved operand in these objects.

`allocationEvidenceRule` contains the sole recognition/policy switch. Preserve the current domain exactly: vec.get/vec.len → read; vec.set → write; binary i32.lt_u/f64.add, const, vec.new_fixed and if → no-local-effect; everything else, including other binary opcodes → unsupported. Normal lookup only reads `instr.kind` and, for binary, `instr.op`; it constructs nothing. Recognized means only these instruction-local facets are available. It is neither finite-profile admission nor a claim that arbitrary ref-valued vectors, const allocations or full CFGs need no other canonical work.

`allocationEvidenceOperand` is a closed role resolver, not another instruction-effect table. For `vec`, require vec.get/vec.len/vec.set and return that instruction's current `vec`; for `newValue`, require vec.set and return its current `newValue`. Use exhaustive role handling and explicit invariant failure on a mismatched instruction/role, never a cast that silently reads undefined or a fallback ID. It performs no normal-path allocation. No exported role registry or callback protocol is needed.

Resolve one event immediately before applying it. In ownership vec.set, read receiver, finish `touch(..., "write")`, then read the current newValue and call `markEscaped`. Do not collect operand IDs up front. This retains the old canonical receiver-write-before-stored-escape sequence and operand-read timing; V1's eager descriptor read of both fields is removed. Escape and encoding require no operand resolution and must not start reading vec/newValue. The static rule never caches instruction contents: repeated sites, updated instruction operands and later invocations see current values.

## The same five production files

1. **effect-rules.ts:** actual policy extraction plus the resolver and compatibility adapter, widening the earlier comment-only hunk. Leave `primitiveKind`, every profile guard, `profileOperands`, population checks and function exclusions byte-for-byte unchanged. The scalar allocation-carrier guard remains independent of generic rule recognition.
2. **ownership.ts::applyInstrEffect:** named-import `allocationEvidenceRule` and `allocationEvidenceOperand` from `./allocation-evidence/effect-rules.js`. Only the three vector cases dispatch the rule. Require recognized; iterate the static ordered events with an indexed loop, resolve the current event operand, and use the existing `touch`/`markEscaped`. No broad early return, fresh event array, spread, map, iterator-producing helper or per-visit closure. Keep alias seeding, other cases, worklist/limits, joins and writeback unchanged.
3. **escape.ts::analyzeEscape/visitInstr:** named-import `allocationEvidenceRule` from the same module. The three vector cases require recognized and the closed empty directEscape facet, without resolving ownership operands. Preserve all other cases, traversal and the ownership backstop. Unsupported generic instructions continue through their old rules; they do not acquire an empty-edge certificate.
4. **encoding.ts::classifyInstr:** named-import that same `allocationEvidenceRule`. The proposed early local dispatch now returns an existing static object instead of allocating a descriptor on every call. Recognized no-write returns; unsupported falls through to the entire unchanged switch. Preserve outer `forEachInstrDeep`, string/provider writes, explicit evidence and presence behavior. This still adds dispatch overhead, which needs measurement below.
5. **allocation-evidence/census.ts::applyEffects:** named-import both new functions from `./effect-rules.js`, replacing the old adapter import. Keep recognized/facet checks and all admission/census ordering. Iterate static events by index. For read/write, resolve the current operand immediately before the existing root lookup/access/count update. Continue skipping the escape event only under the already established primitive-operand/carrier exclusions, with the existing explanatory comment. It need not read the skipped stored operand again.

The shared rule lookup and resolver are allocation-free on their normal paths after module initialization. The canonical analyses and finite checker as a whole still allocate maps, sets, profile operands, results and metadata as before. Do not describe the whole analysis as allocation-free. Do not change stack source/policy, C's four geometry hunks, B's native leaves, A2, consumers, J2 or native/public joins.

## Public compatibility and actual usage

Keep the exact exported `AllocationEvidenceEffect` type and `allocationEvidenceEffect(instr)` signature/result shape. Implement the latter by calling the real local rule and materializing its events through the same resolver, in order. Unsupported still returns a fresh `{kind:"unsupported"}`. Recognized calls each return a fresh top-level object, fresh ownership array, fresh directEscape empty array, and fresh event objects containing `{value, op}`. Never return frozen rule objects/arrays from this adapter; never retain operand values between calls. The adapter is allowed to allocate because none of the four hot consumers uses it.

Do not delete this published compatibility export, redirect hot consumers through it, or add dummy calls/re-exports to manufacture production reachability. Its genuine existing use is the AR01 descriptor assertion in `tests/issue-6920-allocation-evidence-rule-regressions.test.ts`. The inspected `check:dead-exports` script roots source outside src/codegen and its old unreferenced-function ratchet is described for codegen; it is not evidence that this compatibility API has a production caller. Keep that distinction explicit, without baseline edits or exemptions. Any different gate failure needs its actual diagnostic reviewed, not an invented consumer.

Add baseline-neutral fresh-result/current-operand checks within AR01's existing registration before freezing the paired manifests: call the actual adapter twice, require equal content but distinct nested identities, then exercise a distinct genuine store (or an isolated adapter-only instruction clone with different operand IDs) and verify new values without altering analyzed fixtures. Include unsupported/no-local-effect freshness. These are compatibility checks within the same seven registrations, not additional migration or performance proof. Keep original canonical semantic matrices and expected results unchanged.

## AR07: observe the real hot binding

Explicitly replace AR07's existing `allocationEvidenceEffect` observer with a passthrough module mock of the named `allocationEvidenceRule` export. Use importOriginal, call `actual.allocationEvidenceRule(instr)` exactly once, record its actual instruction/result identity and route, and return that exact result. Leave other exports actual. All three canonical donor files and census must directly import this same exported binding. Do not spy on the compatibility wrapper and infer internal calls: ESM lexical calls within effect-rules.ts do not pass through a mocked namespace export.

Keep the genuine ownership/escape/encoding/leaf invocations, nested vectors, independent expected metadata and input-preservation controls already planned. Require each route to observe the actual vector instructions and equal shared rule identities for matching rules, including canonical-to-leaf identity. Assert deep frozen static results/events/arrays, exact role/op order and unsupported/no-write distinctions. A separate wrapper around the real compatibility adapter may count calls and require zero during the four hot routes; its counter needs a positive control from a genuine direct adapter call followed by reset. It must never supply a synthetic result or alter a rule.

Within this same candidate-only registration, resolve a rule against two actual store instructions with differing operands and assert the corresponding current IDs; use getter-backed isolated operands if testing read order, clearly labeled as an API ordering control rather than a valid-IR theorem. Canonical semantic preservation remains established by the seven paired cases. Do not require the compatibility adapter's module-internal calls to trigger the exported-rule spy, and do not install mutable production instrumentation for this test.

Counts remain seven paired semantic registrations, one candidate-only AR07, twelve successor proof controls, plus unchanged separately labeled historical cohorts. AR07's title/manifest must now say static rule binding. Test author must freeze the final literal manifests before ROOT releases runtime.

## Exact proof custody and execution boundary

Retain the original AE28 donor/predecessor reconstruction strategy. Authenticate five complete source preimages from the actual adopted pre-AE28 branch endpoint and five final candidate files; do not treat uncommitted V1 as the historical donor or first execute it just to manufacture a baseline. The effect-rules recipe now covers real policy extraction and compatibility, including constants/types/helpers; the other four recipes record imports and exact call-site substitutions. Update the new successor's bounded recipe and twelve controls to cover this actual enlarged five-file delta.

Replay inverse edits to reconstruct the full true predecessor bytes, and forward edits to reconstruct exact final candidate bytes. Require exact hashes/populations/recipe consumption and mismatch rejection. The reconstructed ownership/escape/encoding donors must still join the actual original Phase B current-source pins. Preserve the original Phase B and J1 receipts, original reader obligations, reciprocal tests and earlier mutation populations; no repins, copied canonical algorithms, weakened mutants, or new unreviewed helper exports. Original full preimages and new proof12 are not replaced by static rule identity checks. ROOT must check any intervening source epoch and publish the widened five-hunk ownership before Sol resumes edits.

## Bounded baseline/candidate performance evidence

After the final candidate and test manifests are frozen and ROOT explicitly releases the runtime cohort, measure the actual pre-AE28 baseline against this candidate using the same pinned Node/runtime, flags, machine, fixture bytes and measurement script. V1 has no runtime/performance qualification. Keep any measurement script/raw outputs in ROOT's private evidence lane; no benchmark product/framework or noisy CI threshold is part of this change.

Use genuine builder-created functions and real canonical passes with fresh equivalent registries for every measured invocation. At minimum cover (a) vector read/write/len-heavy functions, including nested arms, (b) mixed generic encoding traversal with strings and unsupported local-rule kinds, so the new every-instruction dispatch cost is visible, and (c) the admitted finite census over genuine canonical snapshots. Include both a small function and a bounded larger instruction population. Build fixtures/snapshots outside the timed region; keep unavoidable per-invocation registry construction equally inside or equally outside for both versions and state which. Never reuse a previously annotated registry as the candidate's shortcut.

Before/after timing, assert exact independent ownership/access/escape outcomes and encoding namespace presence/results. Consume actual result/snapshot fields into a reported checksum and validate that checksum against the untimed semantic controls, so timing cannot become an unused no-op or a fake-output test. Disable passthrough observers for timing; validate binding liveness separately through AR07. Record source/test/script hashes, instruction/site/iteration counts, registry boundary, warmups, samples and process conditions.

Use a predeclared modest fixed warmup and iteration count for each paired row, enough to exceed timer granularity; alternate baseline/candidate order across a small fixed sample count (for example five paired samples). Report every sample, median/range, absolute time and relative difference. If Node allocation/GC observations are collected, report their method and limitations; heap-size deltas/RSS alone do not prove allocation counts. Static source plus frozen-identity controls establish removal of per-call rule descriptor construction; wall-clock evidence only establishes the measured bounded workloads. Do not invent a strict percentage threshold, select only favorable samples, or claim equal speed without measurement. A material repeatable regression returns to ROOT for a focused decision; this addendum does not authorize architecture expansion or dropping difficult rows.

Acceptance wording before measurements: **shared static local policy avoids the newly introduced per-visit descriptor allocations; runtime cost is unmeasured**. After actual evidence, report the observed bounded costs honestly. Neither outcome claims general body-derived witness completion or shrinks the original migration goal.


### PR6599 protected delivery and V2 predecessor precision

ROOT published widened AE28 V2 source scope before executable edits in sharedcomment6073242379. Actual PR6599 “feat(ir): verify allocation evidence with preserved provenance” is delivered as protected merge58994f7b4d2cbc1a239b8fb0c0e3f39644066489, exact parents e610189829ad1554b813d6ca224515666b0e2d28 and1e388ef647c9827102b87e869f7526f8c928f11e; published/group trees both359d61ac76fec435ebe2b34067d6818f2ef74e6e. Current canonical main7fc2b700eb320e18db213f286350fd1bd56982ef is its direct-parent successor, changing twelve metadata/report/budget/example files and no candidate source/test/proof path. This verifies bounded checker/carrier content delivery, not native/public/general admission or epic completion.

All102 actual Test262 shards succeeded (20host/82standalone), each lane48735 registered verdicts. Six actual required group checks and the differential succeeded. Host39700pass/8596fail/314compile_error/11compile_timeout/114skip matches48735 baseline, zero regressions/exclusions. Standalone42224pass versus42225 mark (42175floor), one compile-timeout flake excluded, zero Wasm-change regressions/net0. Exact e610 cache was absent; compatible source baseline d2beec5 was distance1 overall and zero Test262-relevant commits behind e610. No fabricated exact-base hit or full-CI-green claim: group CI was cancelled after delivery and eight broad issue shards cancelled.

Separate postmerge failures remain retained: shard2job113641013249 JS heap OOM/ERR_IPC_CHANNEL_CLOSED(exit2); npm-compat acornjob113641090132 runtime-eval provider build lacked a usable compiler;24npm measurement jobs and refresh-fast aggregate failed, aggregate count exit1 with no partial reports. Raw252check/120job records and gate logs remain in `/private/tmp/js2-6599-delivery-shepherd-20261009/`, summarized by `delivery-final.md`; no retry/cancellation by shepherd. These failures are not relabeled green.

AE28 source baseline/proof preimages remain exact1e388. V1 has no runtime/measurement qualification. V2's source is compatible with delivered7fc; normal current-main integration follows proof/static/paired qualification before final publication, never during a frozen runtime window. Root owns that later merge and all source acceptance/queue decisions.


### AE28 V2 root source and semantic-control review — 2026-10-09

Canonical metadata claim44305-2ijq5h0r was independently read at issue-assignments tip df160ab7aedb5fbf11b69f9f8990dc784cc5ee0c: existing checker owner ttraenkler/codex-sol-allocation-evidence-checker-20261009, in-progress, branch codex/6920-ae28-rules-20261009. No foreign claim or source scope changed.

ROOT read the full actual five-source delta and final AR01 compatibility/AR07 static-binding controls. An independent byte-level check verified all five published1e388 predecessor and current full-file hashes, every exact edit span, inverse recovery of complete predecessor bytes and separate forward reconstruction of complete current bytes. All three semantic test pins and their unchanged source/proof/fixture operands matched the final packet. Source review accepts the bounded five-file static-rule change for preservation-proof authoring; it does not establish runtime correctness or performance.

Final source packet `.tmp/ae28-v2-source-review-packet.json`: 15253 bytes, SHA25671de6ba40d46acfe32b3b1bacc06e1e14162542ba41d2117eb3fa8f3b0d83592. Exact transforms `.tmp/ae28-v2-source-transforms.json`: 14509 bytes, SHA256730d5850645699c1e5b09503e0d4de7e015cf95b192229856edbfcd220f10fc5. Semantic packet `.tmp/ae28-semantic-tests-review/authorship-packet.v2.json`: 13227 bytes, SHA2561cabf5e26b5703ee62de9c6f19cd13eb58ce8dbf0daac3dc263876d50df93509. Source/test selected TS7, lint and formatting exited0; source budgets, import cycles, inventory validity and parser closure exited0. Architecture completeness remains false; no waiver or full-architecture claim.

The seven paired registrations and one candidate-only AR07 are authored, not executed. Twelve new preservation controls are now authorized for authoring under actual58644-15pxldcw, solely new rule-sharing helper/receipt/suite plus the old default-reader import/composition. Original Phase B and J1 receipts and injected historical-reader contracts stay unchanged. Frozen runtime qualification and bounded genuine performance measurement remain pending independent review of that successor. No runtime, speed, complete native admission, general witness, solver-skip or legacy-retirement claim follows.

Coordination acknowledgment6073415611 records C's geometry boundary dependency and exact published PR states: #6600 OPEN/unmerged at e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f; it merged canonical7fc into its branch, not delivery to main. Old boundaries.patch alone does not clear ten missing-module diagnostics. Astra is reviewing exact files/layer/target and foundation rows against the actual checker before A claims/implements policy. #6598 remains HOLD at16fa30957a267a96358ce6e44f9d5f3e56c8b59a; quality/equivalence pass and actual issue shard4/job113625763446 remains running at this read. Neither event is credited as canonical delivery.


### AE28 successor proof pre-activation defect — 2026-10-09

Independent Astra static review and ROOT's full actual helper read found a genuine-positive parser mismatch: descriptorRoles uses props on allocationEvidenceEffect's final returned object, but props accepts only PropertyAssignment; the frozen accepted source returns shorthand ownership (ShorthandPropertyAssignment). Thus the source-role positive will reject actual accepted production before any mutation control once trust is activated. No proof runtime has executed and the fixed receipt authority remains0/UNREVIEWED; this finding is not a measured runtime failure.

Track repair in this existing issue: narrowly authenticate the actual compatibility object's ownership shorthand and exact local binding without relaxing the four static-rule object parser or altering the production source/receipts/fixtures. Await Astra's complete independent review and concrete helper/test-only amendment before author edits or trust activation. Preserve the initial authoring packet and static failures. Original Phase B/J1 custody and all existing denominators remain unchanged.


### Private measurement envelope review before execution

ROOT read the full proposed qualification plan, genuine six-workload measurement source, deterministic checkout-independent identity factory, native TypeScript resolver and process driver. No collection, body or measurement was released. A concrete process-custody defect is tracked here: the driver's spawn error listener rejects before close, allowing the outer failure path to finish before child closure and descriptor cleanup. The author is released only to repair the private envelope so error records are retained and settlement/failure occurs after close; preserve the initial draft, fixed workloads/iterations/sample order, and refresh static packet pins. This implements the adopted always-await-closure obligation; it does not change production, tests, proof authority, receipts or fixture inputs. Any spawn/import/fixture failure remains raw failure, never a fallback or retry. AP12 and final proof pins remain explicit freeze preconditions.


### Adopted Astra compatibility-proof repair plan

ROOT read the full independent review and repair plan below and adopts its exact two-file amendment before implementation. Only the compatibility inspector in the new successor helper and AP07's existing matrix are released; strict static props, receipt bytes, five production files, semantic suites, old/J1 receipts and common reader stay unchanged. Existing proof claim58644 retains ownership. Fixed live authority remains0/UNREVIEWED until ROOT separately reviews the repaired files. The private performance driver's error-then-close repair was also read; only its narrow process-settlement change is accepted, not runtime qualification or performance evidence. Preserve all prior packets/drafts/failures and twelve literal proof registrations.

# AE28 successor proof review — hold trust activation

Codex GPT-6 Astra High, 2026-10-09. Independent read-only review of the final authoring packet at `/private/tmp/js2-6920-ae28-rules-20261009/.tmp/ae28-preservation-authoring/review-packet.json`: 19,794 bytes, SHA-256 `fa4c97370a9ef158ea2c30266845e57f0f69f7f35745615208b9f7cbca61ded1`.

**Recommendation: do not activate the two receipt trust literals yet.** The complete byte reconstruction and historical custody are sound at the reviewed checkpoint, but the compatibility-role diagnostic rejects genuine current source and incompletely checks the adapter's required data flow. Repair only the new helper's compatibility inspection and AP07 mutation matrix, then obtain ROOT's final review and normal runtime release. No production, original receipt, J1 helper, reader-composition or semantic-test change is needed.

The adopted 37,610-byte plan (`72e41c5a…d3644`), 15,572-byte efficiency addendum (`7f35c075…a700`) and private preservation preparation/role delta were reviewed. This task executed only independent byte/hash reconstruction and TypeScript syntax-tree inspection of text. It did not import or execute the authored helper, collect/run tests, create a TypeScript Program, execute compiler bodies, activate trust, edit repository files, mutate claims/Git, or post comments. Findings below are source/AST conclusions, not runtime observations.

## Findings requiring repair

### F1 — P1: genuine compatibility return is rejected

In `tests/helpers/ir-allocation-rule-sharing-successor.ts`, `props()` at lines544–550 requires every object member to be a `PropertyAssignment`. `descriptorRoles()` at lines725–728 applies it to the actual `allocationEvidenceEffect` return. The frozen production source at `src/ir/analysis/allocation-evidence/effect-rules.ts:100` is:

```ts
return { kind: "effects", ownership, directEscape: [], encoding: rule.encoding };
```

`ownership` is a TypeScript `ShorthandPropertyAssignment`, not a `PropertyAssignment`. Independent parsing confirmed zero syntax diagnostics and this exact node kind. Therefore genuine source reaches `parsed role static direct properties` failure. Once the fixed receipt becomes active, all new AP positives invoking reconstruction and the default historical composition that reaches these donors will fail. The current deliberate `UNREVIEWED` rejection simply occurs earlier; it does not cure this defect.

**Fix:** preserve `props()`'s strict shape for frozen static rules/events. Give the compatibility result a dedicated, narrow AST check accepting the actual shorthand and authenticating its binding to the fresh local `ownership` array. Do not rewrite accepted production source into a longer explicit property just to satisfy the proof, and do not broadly permit shorthand, spreads or arbitrary property forms in static policy objects.

### F2 — P2: compatibility role checks can accept discarded events or wrong projections

The compatibility portion of `descriptorRoles()` at lines708–728 checks the presence of a fresh local array, one resolver call, a final object with four property keys, and fresh `directEscape: []`. It does not authenticate the array that is returned, the actual `ownership.push` operation, the pushed `value/op` projection, the final kind/encoding bindings, or the fresh unsupported branch.

Concrete counterexample: change only the final return to:

```ts
return { kind: "effects", ownership: [], directEscape: [], encoding: rule.encoding };
```

This discards every constructed ownership event. It also changes the problematic shorthand into a `PropertyAssignment`, so the current `props()` accepts it. The fresh array declaration and resolver call remain present, all four keys match, and the sole checked final value (`directEscape`) remains `[]`; the inspected role predicates no longer reject this corrupted adapter. Independent AST inspection verified those object shapes. Similarly, `ownership.unshift(...)` instead of `push(...)` reverses two-event order while leaving the currently observed resolver and loop checks unchanged.

This is **not a bypass of live source authentication**: the fixed complete-file pins reject either changed file. It is a defect in the independently claimed semantic-role diagnostic and its AP07 controls, which the adopted plan requires in addition to whole-file hashing. Current AP07 only replaces the local array initializer with `rule.ownership`; that does not test whether the correctly initialized array is actually populated and returned.

**Fix:** authenticate the bounded adapter data flow below and extend AP07's existing registration with actual changed-source negatives. Do not respond by changing receipt pins, disabling the role check, or describing a full-file digest failure as independent semantic-role rejection.

## Narrow implementation-plan amendment

Authorize exactly the compatibility portion of `descriptorRoles()` (or one private compatibility-only helper it calls) and new AP07 cases in `tests/issue-6920-allocation-rule-sharing-preservation.test.ts`. Static `props()`, generic proof/replay logic, all five source files, original receipts/J1 and the common-reader hunk stay unchanged. Avoid a new parser framework or general scope/semantic analyzer.

Require the actual five top-level adapter statements in order:

1. One const declaration `rule = allocationEvidenceRule(instr)`, with the existing sole `instr` parameter and no substitute rule binding.
2. `if (rule.kind === "unsupported") return { kind: "unsupported" };`: no alternate branch; a fresh object expression containing exactly that literal field. Returning `UNSUPPORTED_RULE`, changing the condition, or manufacturing extra fields must fail this role diagnostic.
3. One const `ownership` initialized with an empty array expression. This is the array used by both the event application and final shorthand.
4. The existing indexed event loop. Preserve its seed/condition/increment checks. Its body must contain the current `event = rule.ownership[index]!` declaration followed by exactly the actual push operation. Authenticate receiver/method `ownership.push`, one fresh object argument, exactly `{ value: allocationEvidenceOperand(instr, event.operand), op: event.op }`, in that order. Reject missing/extra push, discarded object construction, unshift, wrong value/operand, wrong op and reuse of a static event object. The current instruction and event bindings must be those declared in this capsule.
5. A fresh returned object with exactly four members: literal `kind: "effects"`; the actual `ownership` shorthand bound to statement3; fresh empty `directEscape: []`; and `encoding: rule.encoding`. Do not accept `ownership: []` or an unrelated identifier simply because the field key exists. Keep the static object utility strict and inspect this result separately.

These checks can use the existing TypeScript AST utilities and precise expression checks, consistent with the rest of this finite proof. No runtime evaluation of captured source is appropriate. The public exported type/signature and unchanged finite-profile code remain covered by complete source pins and reciprocal reconstruction; this repair does not expand into a general proof of all possible TypeScript programs.

Extend AP07's existing matrix, retaining its genuine unchanged-source positive before each altered-source assertion and its distinct live-hash rejection. Include at least:

- Actual final `ownership` shorthand replaced by `ownership: []`.
- `ownership.push` changed to `ownership.unshift` (meaningful order corruption), and a discarded push/object result control if needed to distinguish mere resolver presence.
- Pushed op changed from `event.op` to literal `"read"`, and resolver operand changed from `event.operand` to `"vec"` (wrong stored-value selection).
- Fresh unsupported result replaced with `UNSUPPORTED_RULE`, plus inverted unsupported condition.
- Final kind changed, final encoding replaced with an unrelated expression, and fresh directEscape replaced with `rule.directEscape`.

Use `replaceOnce` or an equally exact change assertion. Each matrix row must prove that the direct role diagnostic rejects with the role-stage prefix, independently of the live complete-file digest. Keep the genuine current-source positive; do not substitute a fabricated passing adapter or change the production return. Preserve twelve literal AP registrations and all existing historical/semantic denominators. No new test suite or source scope is necessary.

## What the review verified

- Reviewed helper: 36,739 bytes / `cf6e4cca0908e5fc3e37be197eace0d88554da849cc1e0e9781cd5812ee8c7f1`; new receipt: 45,797 / `7b947e08fab9d09418b3431f0f638f2f8e0278cc5af40ac1d979d7ed2064d8b2`; AP suite: 23,696 / `afcfea579fc51dae82d4bb6bc99d1b31fe575e9bd1d7363e80292a020e953a52`; common reader: 18,730 / `21d909a664c3e0dcd99e52b13c2185d376f8c1fabedb58a2d80b08556a9aca3d`. All four actual files match the packet.
- All five actual current files match all recorded byte/SHA-256/Git-blob pins. Each true predecessor was independently read from Git commit `1e388ef647c9827102b87e869f7526f8c928f11e` with lazy fetching disabled; all five complete bytes match the receipt. No V1 source is substituted as baseline.
- Independently applied all 17 inverse and all 17 separately recorded forward steps as data. Each exact source span, expected text, replacement pin, byte boundary, order and full reconstructed output matched. The programs reconstruct the actual opposite files, including unchanged scaffold/trailing bytes. No captured source was compiled or executed.
- All three reconstructed canonical donors match the original Phase B current-source records across byte count, SHA-256 and Git blob. All 26 immutable packet operands and all four live anchors match. Original Phase B JSON and J1 JSON/helper remain unchanged.
- The common reader's two inverse steps reconstruct the complete actual 1e predecessor. Its only change is the named successor import and default composition `J1(path, requested => AE28(requested, raw))`. The old APIs that accept supplied historical readers retain their old implementations and do not wrap those readers in AE28. No circular helper import was introduced.
- Fixed live authentication uses private `receiptBytes/receiptSha256` before JSON/schema/reconstruction. They remain `0/UNREVIEWED`, correctly prohibiting authority now. Caller-repinned drafts have separate diagnostic APIs and cannot select live authority. The authenticated receipt is deeply frozen; whole-file pins bind complete current/predecessor/anchor files.
- The live successful reconstruction path reads exactly the new receipt, five current files and four anchors freshly through the supplied reader. No success cache or hidden filesystem anchor substitution appears. Unknown-path passthrough calls its supplied reader without pretending to authenticate a chain.
- AP01–12 are twelve distinct literal registrations, matching the frozen manifest; their bodies contain genuine positive and nonempty assertion/mutation paths. They are not collected/executed results. AP03 covers mandatory dependencies; AP04 warm-drift capture; AP08 full scaffolds; AP09 draft repins; AP11 historical-stage isolation; AP12 fresh ten-read capture and composed-versus-historical separation. AP05–07 are bounded syntactic role diagnostics, not a general semantic equivalence solver. Beyond the compatibility defects above, full fixed-source authentication remains the complete-byte protection.
- AP10 uses a forward-only, same-length changed comment payload, not an inverse mutation disguised as a forward test. Independent byte assembly produced an 8,002-byte effect-rules file with SHA-256 `977d2a23c5e8894c270bff2b27b8abc0369663cfc078a766a3dd45b2c8d7c776` instead of current `56a0a59536d0d12760fc7dc93fae032669b87eb4a741d089847d00d26f30b18d`. Only “Shared” → “Mutant” in the comment differs; the inverse recipe remains unchanged. After F1 repair, the test is correctly arranged to pass closed draft structure and exact inverse, then reach the independent replayed-current-pin failure. This stage outcome has not been executed in this review.

Private reproducible review records: `/private/tmp/js2-6920-ae28-proof-byte-review-20261009.json` and `/private/tmp/js2-6920-ae28-proof-ast-review-20261009.json`. They contain independent byte/AST observations only, not authored-helper results.

## Acceptance after repair

ROOT should adopt the narrow two-file proof repair before the author resumes. Keep the new receipt's bytes and all five source/current/predecessor pins unchanged; no source change is needed to repair this helper. Regenerate the authoring packet's helper/test/patch hashes and preserve the earlier failed-review packet. Verify the common reader, original receipts/J1, production and semantic-test seals are unchanged.

After reviewing the repaired helper and AP07, ROOT may approve the two-literal trust activation against the unchanged exact 45,797-byte receipt digest. Preserve a separately pinned helper before/after that activation, with no other changes hidden in the trust edit. Only then release the actual new12 and unchanged historical/J1/source-semantic cohorts under the already assigned custody and runtime plan. Confirm AP07 genuine positives and all new role mutants, AP10's intended forward-only failure, and the old supplied-reader controls through real execution; do not infer their passage from TS7/lint/format success or this source review.

No performance, native/public equality, JS-host support, general witness completion, migration completion or queue acceptance follows from proof authoring or this review. ROOT retains those separate decisions.


### ROOT repaired-proof acceptance and exact trust release

ROOT read the complete compatibility/AP07 repair patch and independently checked its two current file pins, all33 immutable operands, exact helper prefix/suffix outside the compatibility inspector, unchanged static props, and all17 inverse/17 forward data programs against actual published1e Git source and current full files. The repaired inspector authenticates the genuine five-statement adapter, fresh unsupported branch, current event push/value-op order and actual ownership shorthand; ten new AP07 mutants retain all12 literal registrations. No authored proof runtime has yet executed.

Accept repaired unactivated helper40107B/SHA6e3c76f8dacbdf801241bbc3082a9c854100e3be73627e827ed737fecdc7e13c and suite25673B/SHAd51bfb82c82a3bf748019c00adee19b0745816b866ee1e806c5d46d39b52339e for exactly two-literal trust activation: receiptBytes=45797 and receiptSha256=7b947e08fab9d09418b3431f0f638f2f8e0278cc5af40ac1d979d7ed2064d8b2, the independently reviewed unchanged receipt. Preserve before/after helper pins and assert no other byte change. This releases activation and subsequent final private qualification inputs, not runtime bodies or performance until the final freeze is reviewed. Original receipts, reader, production, semantic suites and fixture bytes stay fixed.


### Exact activated helper and qualification freeze boundary

The two-literal activation completed under freshly effect-read own claim58644. ROOT independently compared the entire unactivated40107B helper with actual activated40165B helper and verified the only changes are the approved receipt byte count and digest. Activated helper SHA256b799ad4d8cd52819a21db12c36b7347c4fb8226b87c175f87135094091c848dc. Receipt45797B/7b947e08fab9d09418b3431f0f638f2f8e0278cc5af40ac1d979d7ed2064d8b2, reader18730B/21d909a664c3e0dcd99e52b13c2185d376f8c1fabedb58a2d80b08556a9aca3d and suite25673B/d51bfb82c82a3bf748019c00adee19b0745816b866ee1e806c5d46d39b52339e remain exact. No helper, collection, test body or performance executed yet.

The qualification owner may now finish the detached actual1e baseline, exact portable test copies and final private source-derived contracts/four proof pins, then capture freeze DATA for ROOT review. Runtime release remains separate. ROOT will preserve this issue and all source/test/proof/config operands unchanged through the released window until its seal; queue/coordination evidence can continue in separate lanes. All23 proposed qualification cells retain their actual497 registration occurrences and separate denominators. Performance requires successful real qualification and a further explicit release, not merely the activated digest.


## 2026-10-09 closed qualification and adopted AP08 amendment

Canonical metadata claim44305 and proof claim58644 were read back before this append. The finite original qualification window is sealed: 23 cells,497 executed,496 passed,1 AP08 selector failure,0 skipped/instrument faults/custody drift; all observed workers closed. Original final receipt83693 bytes SHA16ee40d55e85daba1175f547e6428a8079f08cc286b5968bd9bd379334d84a4b and seal1158339 bytes SHAeccdb2dd87aed537374dfc9cf1f1fff3f72d8508d6de9544773de5298f65fd03 remain unchanged under .tmp/ae28-qualification-prep. ROOT independently authenticated all48 referenced collection/body/input/seal artifacts. The original failure remains a failure.

ROOT adopts the full Astra amendment below and releases only the existing proof-owner AP08 tuple edit. Source/helpers/receipt/reader and other tests stay unchanged. No performance authorization yet. Successor AP12 execution and honest source-compatible association with the original22 passing cells require a separately reviewed execution contract; no retcon of the failed original epoch.

# AE28 AP08 selector repair — private implementation amendment

Codex GPT-6 Astra High, 2026-10-09. Read-only planning during the frozen qualification window. **Do not implement until ROOT seals that window, adopts this amendment in issue6920 and releases the existing proof-suite owner.** No repository, source, test, receipt, issue, claim or Git edits were made; no authored helper/test was executed, rerun or interrupted. The other qualification cells continue unchanged and performance remains held.

## Actual failure and cause

Read the candidate-AP12 CLI and verified IPC records under `/private/tmp/js2-6920-ae28-rules-20261009/.tmp/ae28-qualification-prep/candidate-AP12/`. Both report twelve executed, eleven passed, one failed, zero skipped; the verified record has `custodyEqual:true`, empty instrument/IPC/observer fault arrays and closed worker records. The failing row is AP08 at test line460. Its assertion expects `/complete source pin/` but receives:

```text
mutation span missing or repeated: return uncovered("nonroot-receiver", at)
```

This is a mutation-selector defect before the intended live-source hash check. In the actual frozen census, the selected substring appears twice: once in `checkOperands` and once in `applyEffects`. The existing `replaceOnce` correctly refuses to choose between them. Keep that guard unchanged; do not use replaceAll, silently select the first occurrence or accept its error as a passing preservation control.

Frozen census: 10,151 bytes / SHA-256 `fe5f001a13c82b4bbecc6c17143a102ba0f0d90202f9a1fcd44d0cebe8d2774f`. Frozen AP suite: 25,673 bytes / `d51bfb82c82a3bf748019c00adee19b0745816b866ee1e806c5d46d39b52339e`.

## Exact test-only hunk

Only replace AP08's census tuple in `tests/issue-6920-allocation-rule-sharing-preservation.test.ts`:

```diff
-      [censusPath, 'return uncovered("nonroot-receiver", at)', 'return uncovered("instruction-kind", at)'],
+      [
+        censusPath,
+        '    const root = state.roots.get(value);\n    if (!root) return uncovered("nonroot-receiver", at);',
+        '    const root = state.roots.get(value);\n    if (!root) return uncovered("instruction-kind", at);',
+      ],
```

The explicit two-line anchor is the actual `applyEffects` receiver lookup/refusal at census lines131–132. `checkOperands` instead uses `state.roots.get(operand.value)`, so it is excluded without inventing a new selector API. The only changed mutant source token remains the intended diagnostic string; the lookup, control flow, source length and all other bytes are retained.

Independent text inspection established:

- Old unanchored selector: **2** occurrences.
- Proposed full anchor: **1** occurrence; replacement anchor: **0** before mutation.
- Constructed private in-memory mutant: 10,151 bytes / SHA-256 `f1006524035fc1199978a6bdd30bfef4550a5cecc6304bca8b06acf84493c783`.
- Reversing that unique replacement exactly restores the original bytes; the other `nonroot-receiver` return remains unchanged.

These are text/hash observations, not a run of the proof helper or suite. The existing `replaceOnce` enforces actual uniqueness again during the repaired test. Preserve AP08's `positive()` call: it authenticates the genuine unchanged five-source input before any mutation. Preserve the same `changed(path, mutation)` supplied-reader route and the exact existing `/complete source pin/` assertion. Expected rejection remains the current complete-file pin for `src/ir/analysis/allocation-evidence/census.ts`; do not switch to a role-only, recipe, generic exception or mutation-helper failure matcher.

## Custody and acceptance

Keep twelve literal registrations and every other AP08 row/negative unchanged. No production file, new receipt, helper trust literal, original historical receipt/reader, semantic test, assertion-helper semantics or expected source pin changes. This repairs a test's ability to construct its intended mutant; it does not change runtime behavior or rehabilitate the first failed result.

After the current window is sealed, ROOT should retain its complete failed receipts and full original input seal, append this narrowly assigned repair to issue6920, and let the current proof-suite owner make only the tuple edit. Record a new test hash and successor qualification seal; the old 18,352-input window must not be rewritten. The unchanged helper/receipt/production hashes must still match. Run normal static formatting/typing requirements and the ROOT-approved successor AP12 execution; require actual twelve collected/executed, twelve passing, zero skipped/instrument faults, and the unchanged `/complete source pin/` check reached by the intended changed census bytes. No rerun or worker termination is authorized by this planning artifact.

Evidence pins retained here: `body-verified.json` 21,360 bytes / `42e3bf46fea2b32a4290621acf5c5de7b63836d240bff8a7ef01ed0b36fa3f4c`; `body.json` 7,221 / `51cdf7973e5b799dcc932eff1d61b099c20a1abcbb04088bfb510e98c6546739`; `body.stdout.log` 3,122 / `b1364b0bb323efe0629da95f72178f3c31c22e8012aca199df9b815dd755d9f0`; `body.stderr.log` 1,050 / `5057f22f4243e2215de66bdb50ca351bfb6210dbbfa586c6db504e223ee9d4d0`.

AP07's reported ten compatibility mutants passing and the genuine baseline-entry positive remain separate results. Neither this amendment nor a future repaired AP12 result establishes performance parity, general witness completion, native/public equality, JS-host IR support or full migration completion.



### AP08 implementation review and static validation

Sol6.1 High implemented the exact adopted tuple. ROOT independently replayed the complete old suite to the new suite using only that replacement and authenticated all34 unchanged production/helper/receipt/reader/other-test pins. Twelve registrations, positive control, replaceOnce and complete source pin matcher are unchanged. Suite25822 bytes SHA b8550b1f12aa85592a365e0566f2fa4822073e47af4984ee9908087f9b99662e; exact patch953 bytes SHA0fb0fefa4424d9c1aa6735d8d8e8c06e7af72fab1dc84fc10a3e24dad7bb9f09. Normal selected TS7 and Prettier checks exit0. Worker report10006 bytes SHA3823b146742781a6a5e42bc98a6dce4cd2c77d28fca7239b9cf60ad05b72100c lives under .tmp/ae28-ap08-selector-repair-20261009; its original suite and pre-edit pins are retained. Original309 sealed artifacts remain unchanged. This is test-authoring/static acceptance only: successor twelve-control runtime and performance are not yet run or accepted.


## Adopted Astra successor qualification execution amendment

ROOT read and adopts the full plan below. Private envelope preparation only is released first, followed by independently reviewed fresh AP12 execution; performance remains held. Coordination audit6074098309 publishes current B head checks, exact missing durable CI archive and current-main refresh request while retaining foreign holds/claims. No source scope is transferred by that request. Original failures and full scope retained.

# AE28 AP08 successor qualification — narrow execution amendment

Astra High, 2026-10-09. Private planning only. ROOT adopts/releases the work. No repository edit, authored-helper/test execution, runtime probe, Git mutation or performance run was performed for this plan. The approved AP08 repair is already complete; do not expand it.

## 1. Exact transition and retained evidence

Q0 is `/private/tmp/js2-6920-ae28-rules-20261009/.tmp/ae28-qualification-prep`. Retain every file and the actual sealed failure: 23 cells / 497 occurrences / 496 pass / one AP08 fail, zero faults/drift and all processes closed. Its 22 other cells contain 485 passing occurrences. Do not separately reuse the eleven passing AP12 rows.

Independent review anchors:

| Q0 artifact | Bytes | SHA256 |
|---|---:|---|
| `freeze.json` | 3988382 | `da09f17145a6ced001178cb3ebf7e63f4ee2913ce8c2c1bea8a87ce99d990f3b` |
| `qualification-seal.json` | 1158339 | `eccdb2dd87aed537374dfc9cf1f1fff3f72d8508d6de9544773de5298f65fd03` |
| `qualification-final-receipt.json` | 83693 | `16ee40d55e85daba1175f547e6428a8079f08cc286b5968bd9bd379334d84a4b` |
| `contracts.reviewed.json` | 170027 | `cf1ddfd6da93b75d22dfb20b5676e79fa477dbd27b89f6a9efe9f982bc56e215` |

The exact candidate test transition is 25673 bytes / `d51bfb82c82a3bf748019c00adee19b0745816b866ee1e806c5d46d39b52339e` to 25822 bytes / `b8550b1f12aa85592a365e0566f2fa4822073e47af4984ee9908087f9b99662e`. ROOT independently replayed the single unique AP08 tuple replacement and checked all 34 immutable pins; this review also read the actual new full-file hash. The adopted repair plan is `/private/tmp/js2-6920-ap08-selector-amendment-20261009.md`, SHA `aa07de7900f2ab1e068b3e822e6db3c9aa78687cde48314159c6310d3759be29`.

The only other changed original operand is the issue: ROOT's latest reviewed issue bytes are 372452 / `4b9771b57d23232da10312011df22419d7baada28efaf80c48f6e64cf1d0d3b0`. Preserve its old frozen prefix plus ROOT's authorization append(s). Adopting this plan may append again: ROOT must record/review that final full hash before freezing, with the same prefix/append-only check. Do not guess a future hash. All other 18350 original operands must equal Q0. HEADs/branches stay unchanged; candidate Git status/diff hashes legitimately change for these two paths. Check the exact two-path delta, not equality of the old aggregate Git hashes.

## 2. Fresh private AP12 window; release this first

Use adjacent Q1 `.tmp/ae28-qualification-ap08-successor-20261009`. Do not overwrite Q0. Keep the existing source/test ownership and actual claim; ROOT coordinates the release.

Copy `run-cell.mjs`, `verify-cell.mjs`, `execute-cell.mjs`, `passive-observer.cjs`, `check-custody.mjs` and `seal-window.mjs` byte-for-byte from Q0. Their home-relative operation supports Q1. There is no new runtime protocol or decoder.

Prepare a Q1-only derivative of the existing freezer and reviewed DATA contracts. Its `cells` must contain exactly `candidate-AP12`, floor twelve, identical expected names/full-name occurrence order, grammar, root and test path, and the new reviewed suite hash. The original freezer's hardcoded 23/497 and old `newSuite` pin need explicit Q1-only assertions, not disabled checks or edits to Q0 data. Preserve the other three proof pins. Preserve the full 23-slot Q0 contracts by reference for later association. Q1's unmodified sealer then truthfully seals one executed cell.

Freeze both roots and the same complete source/test/config/script/fixture/policy/dependency population, with exactly the two approved old-input differences above and individually listed new Q1 private tools/review files. Do not call the new total “18352” if the private inventory grows. Require:

- Both full `src` trees, every other test/helper/fixture, original Phase B/J1 authority, AE28 helper/receipt/activated trust, common reader and all semantic tests unchanged.
- The same actual Node realpath/version/bytes (`/Users/thomas/.nvm/versions/node/v25.9.0/bin/node`), Vitest 3.2.4 CLI, complete Q0 resolved tool/package closure and all 132 old dependency symlink targets. No install or package resolution change.
- Identical runner/verifier/observer/envelope/custody/sealer bytes, stock config/flags and effective semantic environment. Permit only the explicit old-home→Q1 substitution for evidence/observer/custody paths. Preserve prior `NODE_OPTIONS`; record environment rather than silently normalize other differences.
- Both original root paths/HEADs/branches preserved; exact approved test/issue diff and new Q1 Git-state fingerprint. No source/proof/helper/config mutation or baseline change.

Emit a small compatibility DATA record listing old/new pins for the two exceptions, unchanged old operand/link counts and hashes, new private files and actual Git-state delta. ROOT independently checks this and the new freeze before execution. Do not rerun Q0 custody/verifier against today's edited tree: its global old-pin check should reject the two changed inputs.

After ROOT releases Q1, the exact commands are:

```sh
/Users/thomas/.nvm/versions/node/v25.9.0/bin/node /private/tmp/js2-6920-ae28-rules-20261009/.tmp/ae28-qualification-ap08-successor-20261009/execute-cell.mjs candidate-AP12
/Users/thomas/.nvm/versions/node/v25.9.0/bin/node /private/tmp/js2-6920-ae28-rules-20261009/.tmp/ae28-qualification-ap08-successor-20261009/seal-window.mjs qualification
```

The owner awaits collection, all twelve actual callbacks and every observed process close; retain all raw CLI/IPC/log/custody artifacts. Seal even on a test failure using the existing protocol. No retry/kill or edits inside the window. A failure/fault keeps performance held. This stage needs no performance-driver rewrite or association framework before the twelve tests can run.

## 3. Source-compatible association after Q1 seals

If Q1 is genuinely twelve-pass and fault-free, create a private `qualification-association.json` and a small DATA-only validation step using the already authenticated verifier outputs. No production verifier, new execution observer or replay of test callbacks is required.

The mapping must contain exactly the 23 IDs from pinned Q0 contracts: the original 22 successful cells point to their original absolute Q0 collection/body records with their original freeze SHA; `candidate-AP12` points to Q1 collection/body records with Q1's freeze SHA. Pin each referenced file. Do not copy old receipts into Q1, relabel them with its freeze SHA, overwrite Q0 AP12 or patch any failed flag.

Before accepting the association, ROOT independently authenticates Q0 against the fixed anchors above, including its truthful failed status, rehashes its 276 seal-pinned raw artifacts, and authenticates Q1's reviewed freeze/seal and their raw artifact pins. Authenticate the unchanged original verifier/protocol hashes from Q0 freeze. The existing verifiers supply their independently executed raw-IPC/CLI agreement; the association adds no claim that a new decoder ran.

Validate the join itself against records, not summary booleans: exact cell IDs/root/test contracts, original freeze associations, collection/body floors and ordered names/full-name multiplicities, complete process exit/close, `preconditionPassed`, all body rows pass, no skipped/todo or instrument/IPC/observer faults, and CLI/verified counts and statuses agree. Consume each row once within its original cell. Baseline and candidate rows cannot substitute for each other. Require precisely 22/485 retained plus 1/12 new; exclude old AP12 in its entirety from eligibility while retaining it in failure history.

Reuse additionally requires the repaired AP12 file and issue to be irrelevant to the other 22 test bodies. Perform a bounded read-only audit of actual selected imports/config/setup, source-reader path lists and file-reading helpers (including constructed paths). Their global custody hashing of these files is evidence capture, not semantic dependence; actual one-suite CLI/IPC collection also establishes AP12 was not executed by the other cells. Record that distinction and the audit paths. Unresolved dependence invalidates that cell's reuse and returns to ROOT; do not silently grant compatibility or automatically expand the rerun.

Pin the resulting association and its compatibility record independently in ROOT's reviewed release record. Its own self-declared input hashes are not authority. The eventual gate must reject a missing/duplicate/substituted cell, old failed AP12, changed receipt, wrong freeze or source/dependency drift. This is a small validation of existing evidence, not a new test population.

## 4. Performance stays held for a separate narrow review

Q0 `performance-driver.mjs` line 9 requires local `body-verified.json` files for all 23 cells and correctly rejects the old AP12 failure. Leave that driver immutable. After Q1 passes and ROOT accepts the association, prepare a fresh private performance home with the same measurement/loader/custody files and existing workload parameters.

The only qualification logic replacement in the copied driver is: authenticate the independently ROOT-pinned association and its Q0/Q1/compatibility inputs; require its exact 23 IDs/contracts to equal `freeze.performance.requiredCells`; check current source/tool/dependency compatibility; then allow output creation and child spawning. Record the association hash and both epoch pins in the process receipt. Do not merely read a new `allPassed` boolean or redirect only AP12 while leaving the other receipts unauthenticated.

A new performance DATA freeze after Q1 seals can pin the now-existing association, evidence references, unchanged source/dependencies and minimal driver delta without circular future-result hashes. ROOT reviews that narrow diff/freeze before separately releasing performance. The final performance sealer must similarly read qualified status from the authenticated association instead of expecting 23 local test directories, while retaining all existing raw/lifecycle/custody checks. No modifications to Q0's tools, synthetic directories or broader harness redesign.

Keep byte-identical `measure.mjs`, loaders, six real workloads, five alternating paired samples, warmups/iterations, actual registry/results/checksums, owner-awaited ten processes, no-retry behavior and no noisy threshold. The AP12/issue changes must not enter its actual workload import/fixture dependencies. This stage is deliberately deferred until the twelve-control successor is complete. It does not block starting the targeted Q1 window.

## Acceptance/reporting

On success: “497 passing occurrences in 23 qualification slots across two epochs: 485 authenticated compatible occurrences reused from 22 sealed cells, plus twelve newly executed AP12 occurrences.” Actual cumulative execution history remains 24 body cells / 509 occurrences / 508 pass / the original one AP08 failure. Do not claim a fresh all-green 497-test run or rewrite Q0 green.

Any failed association premise keeps performance held and is reported specifically. No source changes, historical repins, general witness/native join/JS-host IR/legacy equality claim or migration-complete claim is authorized. Full migration scope remains unchanged.



## Q1 actual proof success and adopted geometry integration review

Q1 is sealed with12 collected/executed/pass,0fail/skip/fault/drift; all4 actualworkerrecords have spawn/exit/close. ROOT independently inspected realCLI/IPC/process records and all12rawseal artifactpins. Seal34511 bytes SHA05311b16c316010bf73438f4c8bae85a9e42bd713c94d139a74c6f362fb0f5bb; bodyverified15896 bytes SHA97c98c2ce11d0bf999a3b92290bfac8a1438eb009dd37e931323581e9c314b32. Old Q0 remains496pass1fail/497. Performance not yet run: ROOT now releases only preparation of the adopted source-compatible22/485 plus Q1/12 evidence association and narrow private performance prerequisites from the full plan above; separate actual performance execution review/release required.

The full read-only Astra geometry review below is adopted after Q1 closure. ROOT refreshed actual upstream historical claims54017-blpvz0m8,76271-0mo0ncgo and75863-k6ti87wv: all still in-progress under their original named owners/branches. No claim is released/transferred, no historical reader edit is authorized yet. Original false-positive historical matches remain disclosed, not counted as detector acceptance.

# Shared Linear geometry and B initializer integration — reviewed update

Astra High, 2026-10-09. Read-only source/evidence review; no tests, runtime, source/issue/claim edits, publication or queue action. ROOT may adopt this update in **Native Linear numeric-vector shared source handoff and integration plan**, issue 6920, after the current Q1 window seals.

## Exact checkpoints and recommendation

Fresh REST reads confirm PR6600, **refactor(linear): publish shared Linear memory geometry contract (6920 A-G)**, remains OPEN/unmerged/HOLD, no auto-merge, head `e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f`, base `7fc2b700eb320e18db213f286350fd1bd56982ef`. Local `/private/tmp/js2-6920-linear-geometry-boundary-20261009` is clean at `b932e3a05e353acc59e7b547ef4e417a5d8637e1`. REST independently confirms that published fork commit's sole parent is C's exact head and its only changed files are the existing issue and `scripts/compiler-boundaries.json`.

PR6577, **refactor(linear): extract initializer and preserve Prepared evidence**, is OPEN/unmerged/HOLD, no auto-merge, actual head `6d41eb99a08bcb8505febcb9b7ff4f43b9b2544b`. Its actual leaf and caller were read at that ref.

**Recommendation:** the shared constant endpoint is technically suitable for B's single-import repair. C must consume/publish the policy dependency on its existing PR and report the exact new head; ROOT can then release only B's owned initializer import hunk against that reviewed dependency, retaining HOLD. This is not acceptance of the full historical source chain or the positive native allocation requirement. Historical proof work is a separate still-required owner join, not permission for B/C to edit its readers.

## Source and policy findings

The three production operands are identical between C's head and b932:

| Path | Bytes | SHA256 |
|---|---:|---|
| `src/shared/contracts/linear-memory-layout.ts` | 7580 | `08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937` |
| `src/ir/analysis/contracts/linear-memory-layout.ts` | 3161 | `83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91` |
| `src/ir/analysis/linear-memory-plan.ts` | 45359 | `08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc` |

No bounded source correctness defect was found in this extraction. The shared module has zero value or type imports. It owns the existing offsets, storage/layout primitives and one frozen `LINEAR_ARRAY_FORWARDING` object (`tag=6`, offsets 0/4, pointer width4). The old planner re-exports the same value/function bindings; the IR contracts re-export the moved DATA types. Stack-arena and semantic allocation policy remain in IR. `planLinearVectorLayout` computes storage first; scalar IR values use the shared scalar factory while compound pointer-shaped IR types retain their semantic keys through `linearIrTypeKey`. The factories retain fresh mutable result/nested objects; forwarding alone remains the shared frozen identity. These are the intended existing behaviors, not a new generic record-layout capability claim.

b932 adds exactly the shared foundation activation/minimum9→10 and its clean/foundation files row. It changes no allowed edge or source. Existing `ir-analysis → foundation` permission covers the contracts' transitive import. Do not add a special IR allowance for the B runtime leaf or promote the full planner to foundation. The previously reported inventory result and C's G24 results remain their recorded measurements; this review ran neither. Classification of B's own runtime leaf/README is a separate B/A inventory responsibility, not supplied by b932.

## Exact B-owned bounded repair and release conditions

At B head6d41, `src/codegen-linear/runtime/vector-initialization.ts:3` is the actual IR value edge. Its entire production repair is:

```diff
-import { LINEAR_VECTOR_ELEMENTS_OFFSET } from "../../ir/analysis/linear-memory-plan.js";
+import { LINEAR_VECTOR_ELEMENTS_OFFSET } from "../../shared/contracts/linear-memory-layout.js";
```

Keep the direct type-only `Instr` import from `../../wasm/model/instructions.js`. Keep `buildLinearF64VectorInitializationBody` and all seven instruction objects byte-identical: local1 pointer + local2 index×8, local0 f64 value, `f64.store` align3/offset16. Each invocation still constructs a fresh array and fresh instruction objects. Do not add `irVal`, a layout planner, another constant, runtime registration, a memoized body or a wrapper.

The real `runtime.ts:1376` `addLinearIrVecRuntime` caller already imports this builder (line19), checks the existing name guard, and passes the builder directly to `addRuntimeFunc` with `(f64,i32,i32)->()` and empty locals/results (line1384). This caller requires no change. B's plan explicitly acknowledges this same bounded rewire after source publication. No new resource pack or unused adapter is needed.

Before release, ROOT records the exact new C head containing b932 and the source pins above, plus B's current head/owned-hunk acknowledgement. B alone composes the dependency and import repair on its branch. Refresh actual source/import closure and policy classification in that composition; require the initializer's value import to terminate at the zero-import shared owner. The reported 9→10 cycle delta is motivation, not a result measured by this review; validate the exact composed graph rather than promise a particular global cycle count after unrelated main changes.

After owner release, use existing `check:import-cycles`, `check:compiler-boundaries:inventory`, typecheck and B's existing initializer/Prepared regression controls on the exact composed checkpoint, with normal hooks and preserved raw results. Existing scripts are `node scripts/check-import-cycles.mjs` and `node scripts/check-compiler-boundaries.mjs --mode inventory` (use the established actual-base option where required). Preserve the original B population and genuine `array-representation-unsupported` failure; a one-line import rewire cannot make it pass. Keep actual value-first ABI, fresh-body and memory/neighbor witnesses, and report any failure independently. No runtime execution is authorized by this review itself.

## Open integration finding: historical source-reader chain

**P1 for full A-G/historical acceptance, not a new defect assigned to C's four-file source scope:** no geometry/forwarding preservation successor or reader integration exists in the inspected C/b932 diff. The old helper still pins planner49040 and layout4670 in `tests/helpers/ir-lowering-analysis-relocation.ts:91–103`; `captureLinearLayoutPredecessor` at417 rejects changed planner bytes before invoking its old pair proof. The JSON receipt remains111423 bytes / `dc8241d36da5b2fe29abe12ed6ee348fc456ef22939c61aabe05d09daad92134`.

C's committed `plan/log/6920-shared-linear-geometry-c/README.md` explicitly records 3005→2902 historical failures and explains that all103 apparent new passes arise from changed first-error text matching old negative assertions. That honest disclosure is correct. Zero new failing test IDs and G24 24/24 do not establish historical detector liveness or preservation. Preserve those original rows; do not convert them into acceptance evidence.

The adopted issue6920 A-G plan and B's actual issue6905 “Finite forwarding-epoch successor proposal” already specify the needed repair; do not replace it with a weaker new scheme:

1. Authenticate complete current planner/contracts/shared-owner bytes and exact geometry inverse/independent forward reconstruction. First reconstruct the genuine main845 layout **with forwarding**, 4763 bytes / `977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754`. Only then apply the separate genuine `2a98b75de993bdc568e3668a2965c026876fe322` / parent `6c88d157444ea4ae377a7ef1b82b15ef2f4f6603` bridge: exact93-byte insertion at2820, reaching the old4670-byte operand. Replay in reverse to reproduce every complete current geometry operand. Call the unchanged old proof for its52704-byte predecessor; do not copy its algorithm or repin its receipt.
2. Source-proof owner handles the finite successor and `tests/issue-3518-lowering-analysis-preservation.test.ts` acquisition/accepting/current-chain seams. Preserve every old historical mutant and its meaningful deep rejection, with genuine new-current positives before mutations.
3. Trusted-adapter/C1 owner handles `tests/helpers/ir-c1-current-source.ts::captureC1CurrentPopulation`: current closure pin at872 precedes old layout proof at880, so the join belongs before that pin. Current resolver/type-host inputs stay actual current bytes; only historical proof gets predecessor views. Changed reader instruments need independently anchored instrument successors before old `captureC1HistoricalAuthority`; do not update old hashes to bless changed code.
4. Policy owner handles `tests/helpers/ir-runtime-program-policy-evolution.ts::loweringAnalysisRead` (7573) and `authenticateLoweringAnalysisPolicy`, which pin physical source before proof. Both exported entrypoints, `captureLoweringAnalysisPredecessorPolicy` (7767) and `captureLoweringAnalysisPredecessorPolicySource` (7796), must traverse the authenticated join. Keep supplied current input distinct from historical readers; no healthy historical/Git fallback repairs a mutant.

These are existing bounded obligations, not permission to fix thousands of unrelated historical failures or expand C's scope. Exact implementation pins are established only after owner-authored source exists. Required acceptance retains full reciprocal source equality, mixed-epoch/missing-owner/delegation/forwarding mutations, wrong reader/receipt authority, supplied-current corruption with a healthy historical copy, both policy entrypoints and genuine current resolver observations.

## Ownership and adoption text

C claim4237-ijwd2prx owns only the three geometry hunks and G24 test. A's confirmation expressly retains historical proof/readers, boundary inventory, facts, registry and integration; the old A geometry preparation claim is released. The same record corrects the earlier overbroad assumption that allocation donor34529 owned geometry algorithms—do not demand or invent that release again. A2/J2 same-file facts composition remains distinct.

The inspected issue/acknowledgement records contain outstanding requests, not an exact release from historical source-proof54017-blpvz0m8, trusted-adapter76271-0mo0ncgo and policy-caller75863-k6ti87wv for this published geometry checkpoint. Their current claim state was not refreshed by this review. ROOT must obtain/effect-read the actual owners' bounded acknowledgements before assigning those files; C's source claim or B's plan is not that authority. If newer acknowledgements already exist, record their exact endpoint instead of requesting duplicate permission.

Suggested adoption: “C's exact geometry source plus A's b932 inventory dependency supplies the canonical offset endpoint for B's owned initializer import-only update, conditional on C publishing the composed head and B acknowledging that checkpoint. HOLD and existing positive failures remain. Historical geometry/forwarding source reconstruction, C1 current-reader/instrument joins and both policy entrypoint joins remain separately owner-controlled prerequisites for full A-G/current-chain acceptance. No native caller parity, JS-host IR support, legacy equality or migration completion is claimed.”



## Sealed first performance failure and corrected historical resumption plan

The first performance epoch is closed and FAILED before timing. Actual first baselinechild58903 spawned/exited1/closed1, no signals; driverexit1. Runtime loader retained type-only AllocKind import in builder.ts and native Node25 rejected missing runtime export. Actual0/5pairedsamples,0timingrows/medians/checksumcomparison; no performance improvement/equality claim. Performance seal28295 bytes SHA662f4f580afbefddd5ea67f86079c56b9bafcbacf8f3b0e34e454cb0401f2297 and driver5145 bytes SHA3d3ed27e5e0d6638be47225bb300f26dc4e3c3557b4567455bbfba728929532d retained unchanged. ROOT independently inspected actual stderr546 bytes SHAccfd17e6588604d37d6aa9640bd82d664dc97deb6cf9c8c474920fa6aa2e9541 and all3rawseal pins. Inputs18675/132links unchanged, custody0. Qualification remains actual485old+12new passing occurrences with original Q0 AP08 failure retained separately. A narrow loader-only new instrument epoch is being specified; no retry/source modification is authorized by this record.

ROOT adopts the full Astra historical resumption plan below, correcting earlier broad policy-owner wording. ROOT READ actual original dispatch-map and full release-amendment. These are retained earlier A-owned partitions, not foreign B/C work. Resume assignments must preserve original identities/claims and exact file custody, old dirtydrafts and their2254/2646 historicalepochs; no claim is transferred/force-released or presumed abandoned. Trusted-adapter76271 owns BOTH policyhelper APIs; caller75863 owns only13tests19initialoperands. Production geometry remains consumed only from published C plus b932; full historical acceptance requires the finite named joins. No implementation starts before an actual isolated current composition and explicit per-owner hunk assignment.

# Historical geometry preservation: resume A's original D1 owners

Astra High, 2026-10-09. Proposed private implementation specification under existing issue6920, **Native Linear numeric-vector shared source handoff and integration plan**. ROOT adopts it after the active performance window seals. No source, issue, claim, worktree or runtime mutation is authorized by this document alone.

## 1. Provenance and exact ownership

Read together: `/private/tmp/js2-historical-layout-prepared-work-inventory-20261009.md`; the retained proof lane's `.tmp/d1-layout-legality/preservation-integration-readiness/dispatch-map.json`; and the adapters lane's `.tmp/d1-layout-legality/preservation-draft/release-amendment.md`. Their roots are under `/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm/worktrees/3518-layout-legality-{proof,adapters-draft,callers-draft}-20261004`. The same ROOT-authored dispatch appears in issue3518 at the D1 amendment/custody sections beginning lines6460/6472/6531 in the inspected published geometry tree.

These are OUR retained Session A preparations. The inventory records ROOT's fresh confirmation of the three original in-progress claim identities; no transfer, abandoned owner or external B/C permission is inferred:

| Original identity / write | Resumption partition |
|---|---|
| `ttraenkler/codex-lowering-analysis-source-proof-20261004` / `54017-blpvz0m8` | Existing source-proof helper and finite geometry/forwarding capture implementation; no C1/policy-helper edits. |
| `ttraenkler/codex-lowering-analysis-trusted-adapters-20261004` / `76271-0mo0ncgo` | `tests/helpers/ir-c1-current-source.ts`, `ir-c1-historical-authority.ts`, and `ir-runtime-program-policy-evolution.ts`; this includes BOTH policy capture APIs. |
| `ttraenkler/codex-lowering-analysis-policy-callers-20261004` / `75863-k6ti87wv` | Thirteen existing policy test files / nineteen original initial operands (15 raw, four semantic), as enumerated in the actual dispatch map. No helper/receipt ownership. |

**Scope correction:** “policy owner joins both entrypoints” means the trusted-adapter owner for the helper implementations; it must not silently assign those functions to the thirteen-file caller owner. ROOT retains source/policy receipts, C1 manifest/anchor, current-source/graph tests, preservation-suite integration and final composition. Any renewed source-owner work on the preservation test needs ROOT's explicit bounded delegation, consistent with the earlier portable-test transfer. Copied helper/authority/source files in caller/adapters drafts are assembly inputs, not grants to modify them.

Resume the original addressable owners if available; the inventory found no current handle. ROOT must resolve actual identity/assignment before executable edits rather than invent an agent handle or implicit replacement owner. A fresh isolated successor checkout can be used under that resolved custody; leave all old dirty worktrees, untracked files, staging and `.tmp` evidence intact. Do not merge into or wholesale transplant them.

## 2. Freeze the current composition; do not redo delivered D1

PR6475, **refactor(ir): give linear layout contracts and backend legality canonical owners**, is already delivered: publication `650cb1b0a08df7976662c721e0da884b109fbfe0`, merge `7755320d74de1b52eafedbf6cc5cd37d57c6a081`, 2026-10-04. Its delivered helpers replace old draft epochs as the implementation starting point. In particular, draft helper17637/d7e0dd0c and receipt111561/c21a9577 are preserved history, not current authority.

REST main at this review is `7928f27343a171d8e0de434ea005d630eaf64bf3`. Its source-proof, C1-current and policy-helper blobs equal the inspected C/b932 helper blobs (`c732f2eb22a127714373bc8fa363514bcf7a818b`, `020e91dc1d9bd0646b8b16d9b5224fd513caf861`, `2dbe6d7fa227cb7463d73d20d847c433a933dfbc`). Main's planner/layout remain the 49040/4763-byte pre-geometry files. Geometry is published on C's `e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f`; policy-only dependency `b932e3a05e353acc59e7b547ef4e417a5d8637e1` has that exact parent. Neither fact says geometry is on main.

ROOT first freezes one actual composition of current main plus C's source and b932 policy, after C's publication/coordination. Record every real conflict or changed dependency. The three geometry file pins from the reviewed C checkpoint are:

- shared layout:7580 / `08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937`;
- IR layout contracts:3161 / `83e6b8a07bdc8e8b93fed590bc0aed5c5f779bde98466e9cbbe3feb7a825cb91`;
- planner:45359 / `08f844117ef1b6e0eb17a87555d00db5be89257e5817ad76322320fa837ae7fc`.

Do not invent a merged HEAD or resulting policy hash. If these source pins change in composition, return the exact hunk to ROOT before deriving recipes. Exclude A2/J2 dirty facts work, AE28 frozen lane, B runtime leaves and all production redesign from this preservation task.

## 3. Source owner: add a finite bridge to the existing proof

Use the existing `tests/helpers/ir-lowering-analysis-relocation.ts` reconstruction logic and unchanged `captureLinearLayoutPredecessor`; do not copy its algorithm into another verifier. Preserve its old APIs and explicitly supplied historical-reader semantics. Prefer a bounded append-only current-geometry capture in that same helper, preserving the complete currently published18956-byte body as an authentic predecessor. ROOT and source owner freeze the concrete entrypoint spelling/signature and finite receipt location before edits; this specification does not pretend a new API already exists. The prior adopted contract already requires three closed views: actual current, geometry-before, and lowering-before.

ROOT supplies/reviews the new finite receipt's authority. Keep old `ir-lowering-analysis-relocation.json` at111423 bytes / `dc8241d36da5b2fe29abe12ed6ee348fc456ef22939c61aabe05d09daad92134` and the current helper predecessor18956 / `253eda01462fad0ab84a940965a083eaf80b0ca8a3e10a4ca012fbafaaf30e99`. No overwrite of old source pins/receipt or unrelated `early.return` bridge.

The new capture must authenticate fresh actual planner, contracts and shared owner, plus independently anchored receipt/helper authority. Capture each source once into a closed immutable per-call view; no cross-call success cache, Git read, old checkout fallback or healthy-source substitution. If a caller already supplies planner bytes, require exact equality to that call's actual authority channel before deriving history. Unknown paths, missing/extra owners, mixed epochs or differing repeated source reads reject.

Build exact finite source recipes in this order:

1. Inverse current geometry into the genuine pre-geometry planner49040 / `5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52` and layout4763 / `977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754`. Bind the shared owner's actual complete bytes and its absence at the predecessor. Include every moved type/function/constant and exact imports/reexports, scalar-key factoring and both vector adapters. Preserve shared forwarding identity, fresh layout objects and retained IR stack policy by the already-reviewed source contract; this proof changes no production behavior.
2. Apply the separately named forwarding epoch: genuine `2a98b75de993bdc568e3668a2965c026876fe322`, parent `6c88d157444ea4ae377a7ef1b82b15ef2f4f6603`, exactly93 UTF-8 bytes at2820. Only that step reaches layout4670 / `dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72`. Do not hide this semantic operation arm inside geometry relocation. The planner is unchanged by this step.
3. Call unchanged `captureLinearLayoutPredecessor` with the proved old planner and closed old-layout reader to obtain the existing genuine52704-byte donor. Its established piece counts and proof logic stay authoritative; new geometry piece counts are measured from the actual authored recipe, never borrowed from D1's129/140 totals.
4. Independently replay authentic old bytes forward through forwarding and geometry, reconstructing every complete current operand. Consume every source span exactly as declared, check byte coordinates/multiplicities and all full hashes; independent forward payloads must not be silently derived from inverse output. No whole current/predecessor source copies used as a fallback answer.

## 4. Trusted adapters: join before old rejection, preserve current resolution

In `ir-c1-current-source.ts::captureC1CurrentPopulation`, the closure `assertPin` at872 precedes planner proof at880. Authenticate/capture geometry before this old planner rejection, while respecting earlier original receipt/population failure priority. The actual `closure`, observed current pins, TypeScript source files and resolver must retain current geometry text/routes, including the real shared import. Only the historical reconstruction sees proved predecessor text. Do not satisfy the real resolver by substituting the old52704-byte planner. Retain current population versus authority comparisons and the independent caller's helper-body check before accepting imported proof output.

`ir-c1-historical-authority.ts` needs the bounded current closure/resolver successor for this actual source graph. Preserve immutable historical contracts, predecessor pins and unrelated current entries. Reuse its existing current/historical mechanism. Derive new actual resolution observations; the old13 requests/57 operations are a baseline record, not a count to synthesize if the new shared import genuinely changes the graph. Explain every added route, and assert no unrelated route drift.

In `ir-runtime-program-policy-evolution.ts`, `loweringAnalysisRead` (7572) physically pins old files before `authenticateLoweringAnalysisPolicy` (7589) calls the old proof. Capture/authenticate current geometry before that path's old rejection and pass an explicit predecessor reader to the old layout proof. Both `captureLoweringAnalysisPredecessorPolicy` (7767) and `captureLoweringAnalysisPredecessorPolicySource` (7796) must traverse the join. Preserve primitive/descriptor-before-IO ordering, fresh C1 authentication, original receipt/helper-prefix checks and genuine source/authority comparisons. Do not make the physical reader permissively accept arbitrary epochs.

Any changed reader/helper is itself an instrument pinned by C1. ROOT's independently anchored instrument successor must reconstruct the exact published predecessor of each named changed instrument before unchanged historical authentication, then independently replay its complete new bytes. Preserve all historical `beforePins`, immutable receipt bytes, existing recipe domains and untouched instruments. New current authority fields/digests bind actual reviewed candidate bytes only after recipes pass. Never simply replace old historical hashes or compute expected trust from candidate output.

## 5. ROOT/test owner and caller owner: preserve real acquisition and detectors

`tests/issue-3518-lowering-analysis-preservation.test.ts::fixture` currently reads and pins physical old planner/layout before copying them (171 onward). Replace that acquisition premise only: first authenticate current geometry through the real bridge, then materialize exact old fixture operands from its proved historical view. Keep old-stage mutants direct to the unchanged old APIs; do not route them through a current full-hash guard and mistake early rejection for detector preservation. Preserve its independent inverse/forward witness and existing `historicalOwner` early-return bridge. Add separate current-chain controls using the actual new source domain.

Caller75863 first inventories the already-delivered nineteen initial sites against its saved thirteen-file recipes. Do not reapply old wrappers or rewrite later Deno/source-map/current-main successors. Add or adjust only a concretely missing outer acquisition join. Preserve the six hostile semantic factories prepared before the missing-receipt closure, direct deep mutants, exact diagnostics, registration order/duplicates and all subsequent APIs. Report no-op sites as already integrated. Any additional file or helper change returns to ROOT for a bounded scope update.

ROOT separately authenticates the exact b932 policy delta (one foundation entry/minimum and one files row) through the existing current-main policy chain. Preserve all original inventory history/allowedEdges and existing unrelated successors. The current policy contains more history than the old ca11 draft: never substitute draft584010 policy or normalize current policy into an invented old epoch. A missing current-main bridge is a separately named finite prerequisite, not permission to loosen the original policy checks.

## 6. Dependency order and finite acceptance

Dispatch source capture/recipe work and adapter read-only seam preparation after ROOT records the original-owner resumption scopes. Source freeze comes first; adapters consume its exact API/receipt/helper pins; ROOT composes authority/instrument recipes; callers/test owner then use the real accepting joined entries. Keep all source/static/proof/runtime windows separately released. No physical fault test during AE28 performance or another owner's execution window.

Necessary checks, using the existing suites/harness rather than a new framework:

- Genuine current geometry →4763 forwarding→4670 old proof→52704 donor, plus independent full forward replay. Healthy main-before and exact forwarding controls remain separately attributed. Reject missing/duplicate/shifted/altered93-byte insertion, unrelated bytes, mixed epochs, missing/extra shared owner, changed scalar key/vector delegation/offset/pointer policy, malformed coordinates and wrong full authority pins. A forward-only wrong payload must pass inverse diagnostics and then fail actual independent forward equality.
- Repeat healthy capture then change each supplied source/receipt/helper channel: fail fresh, with recorded read order and no cache. Supplying damaged current text while healthy historical files exist must fail. Distinguish full-hash authentication from deeper structural-rule diagnostics; do not change expected pins just to claim a guard was reached.
- Actual C1 success before each fault, real current resolver text distinct from historical proof text, both raw/semantic policy entrypoints and real fixture acquisition. Preserve primitive/accessor priority and paired malformed-old-input versus bomb-new-reader controls.
- Reuse the existing exclusive physical fault/restoration harness for installed helper/receipt missing and inert corruption, cached module and pre-import child. Require healthy-before/after, actual accepting callers, independent caller-owned pin failure, full exit/close and exact restoration; no wrapper intercepts credited to C1, global fs mock or sentinel regex pass.
- Recollect the actual preservation/current-source/graph suites and affected thirteen old policy cohorts after integration. Freeze literal/derived registration manifests and execute all callbacks with CLI/IPC/error/custody evidence under ROOT's normal protocol. Preserve the original distinct34-development,2254/13-file and2646/17-suite historical records; derive current denominators rather than promise those totals. Run existing G24/semantic compatibility only for an actual production composition change or unresolved concern, not as substitute evidence for proof correctness.

C's recorded103 apparent improvements are specifically old first-error-text matches; they are neither new failures caused by this task nor accepted preservation passes. Keep the full original rows and diagnose genuine positive reach. Do not broaden this finite join into a mandate to repair every unrelated historical failure. A test that still fails before its intended guard is reported blocked at that exact prerequisite, not green.

Acceptance is the actual current joined proof/reader chain with unchanged historical authority and live deep controls. It does not grant native allocation execution, JS-host IR support, legacy equality, performance parity, general witness capability, migration completion or queue release. ROOT retains all publication/HOLD decisions.



## Adopted loader-only measurement successor amendment

ROOT read/adopts the full Astra amendment below after the failed window closed. Release private implementation/static preparation only. Genuine loader controls and both-arm untimed fixtures require separately reviewed finite execution; actual timings require subsequent ROOT acceptance. Old source/qualification/proof/fixture/workload sizes and all failed attempts stay unchanged. No production type import fix or whole-program acceptance is credited.

# AE28 measurement loader successor — narrow amendment

Astra High, 2026-10-09. Private specification only: no source/tool edits or runtime probes performed. ROOT adopts, reviews the private implementation, and separately releases untimed controls and timing.

## Failure and fixed scope

Preserve `.tmp/ae28-performance-associated-20261009` unchanged, including its performance seal28295 bytes / `662f4f580afbefddd5ea67f86079c56b9bafcbacf8f3b0e34e454cb0401f2297`. The first baseline child failed during module linking: `src/ir/builder.ts:16` imports the type `AllocKind` through a mixed ordinary import. The 750-byte loader only resolves emitted `.js` paths to actual `.ts`; Node's syntax transformation leaves that mixed import as a runtime request. This is one closed failed child, zero completed pairs/samples, not a measurement of analysis speed. All original source/proof/qualification and the accepted497-occurrence association remain valid under their recorded instruments.

Create a distinct private successor performance home. Change only its source loader, the minimal untimed mode in the copied measurement script, and corresponding driver/freezer/receipt plumbing. Do not edit `builder.ts`, any production import/export, baseline/candidate source, fixture, proof preimage, expected output or workload size. No `AllocKind` special case, stub export, dropped runtime error or synthesized result.

## Loader implementation

Use the already installed and frozen **TypeScript5.9.3** `transpileModule` API, not TS7 or a package install. Actual frozen implementation:

- `/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm/node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/lib/typescript.js`:9112572 bytes / `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675`.
- Adjacent `package.json`:3620 bytes / `822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6`.

The local declaration at `typescript.d.ts:11397` exposes `transpileModule`; `TranspileOptions` supplies `fileName`, `compilerOptions`, `reportDiagnostics`. Repo `tsconfig.json` uses ES2022/ESNext/bundler and does not enable `verbatimModuleSyntax`.

Retain the existing `.js`→`.ts` resolver and add a standard Node ESM `load(url, context, nextLoad)` hook. For actual file-URL `.ts` implementation files in the frozen baseline/candidate source/test roots (plus explicitly frozen private loader-control files), read the exact source and call:

```js
ts.transpileModule(source, {
  fileName: absoluteSourcePath,
  reportDiagnostics: true,
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    verbatimModuleSyntax: false,
    isolatedModules: true,
    useDefineForClassFields: true,
    noEmit: false,
    declaration: false,
    sourceMap: false,
    inlineSourceMap: false
  }
})
```

Return its emitted JavaScript as `{format:'module', source: outputText, shortCircuit:true}`. Throw on any error diagnostic or absent emitted output, preserving source filename and diagnostic text. Delegate other URLs/extensions/dependencies to `nextLoad`; never execute `.d.ts` as an implementation. Use the exact pinned TypeScript module resolution/realpath for both arms and record these options, module hash and loader hash in the new freeze. No custom transformer, handwritten identifier erasure, export inspection, fake import alias or per-instruction cache. Standard TypeScript's usage-based import elision removes imports used only as types; genuine value-used bindings and explicit side-effect imports must remain. This is transpilation, not a semantic typecheck claim.

The returned ESM JavaScript must reach execution through this hook; it must not fall back to Node's raw TypeScript path on diagnostics. The old Node transform flag can be removed from the successor child command because the hook now supplies JavaScript; record that exact argv change uniformly. Node executable/version, dependency bytes and six actual workloads otherwise remain fixed. Module compilation/loading and fixture construction occur before the existing timed loops and are excluded costs, explicitly reported as such.

## Small loader controls, then genuine untimed workload gate

Before either timing arm, statically inspect emitted AST from two small frozen private control modules using the actual loader/compiler options:

1. Positive mixed import: one binding used only as a type and another used as an exported runtime value. Verify the type-only binding disappears, runtime binding remains and emitted module is nonempty; execute the same tiny positive module to observe the actual dependency's value. Include an explicit side-effect import and observe its real effect, so import removal is not accepted wholesale.
2. Negative true-value import: import a nonexistent export from a real private dependency and **use it as a runtime value** (`export const observed = missingValue`). Verify the emitted import still names it. Loading through the actual hook must fail with the missing-export link error and nonzero closed child result. A parse/transpile failure or unrelated exception is not this control's success. Keep an actual exported-value companion positive. No production file is mutated for these controls.

These controls are loader qualification, not benchmark samples or new source-qualification tests. They must be owner-awaited and preserve their raw failure diagnostics. No global interception or empty-export workaround.

Add one explicit `fixtures-only` mode to the existing copied `measure.mjs`, using the same imports, `numeric`, `mixed`, `annotate`, expected metadata, prepared-allocation validation, `workloads`, `.run()` and `.check()` functions. It performs the existing setup and, for each of the exact six rows, one actual run/check plus before/after fixture and full input custody checks. It must branch before the40 warmups and before any `performance.now()`/timed iteration loop. Do not duplicate fixture constructors or relax a failed genuine check.

Write a separate untimed receipt with six ordered names, root/epoch/freeze/tool pins, fixture hashes, actual instruction/site counts, actual `result.score`, and the actual checked metadata/census payload. Compare both arms' actual payloads, hashes and semantic-unit checksums, not just an `ok` field or expected constants. No `elapsedMs`, `nsPerInvocation`, fabricated timed checksum, sample index or performance result file is produced in this mode. Keep the original expected-result guards and input-error behavior unchanged.

Run two fresh owner-awaited children, baseline then candidate, through the same new loader. Require clean exit/close, all six nonempty result rows, exact ordered names, unchanged input/fixture custody, existing genuine verification and exact cross-arm result/fixture equality. Any failure seals this new preparation attempt and leaves timing held; do not automatically repair/resize fixtures or rerun. ROOT reviews both actual receipts before releasing timing.

## New epoch and timing release

Freeze the complete successor source/tool/dependency inputs and independently authenticate the existing source-qualification association; do not rerun or relabel the497 occurrences solely because this measurement instrument changed. Keep all old epoch seals/receipts and their failed status. Record a distinct measurement-instrument epoch with the old failure as predecessor and exact private script diffs.

Once ROOT accepts the loader controls and genuine both-arm untimed outputs, release the original ten fresh sample children: five alternating paired samples, the same six rows,40 warmups,500 small/50 larger iterations, real pass/registry/census calls, consumed checksums and no retry/no noisy threshold. The untimed children do not count among those ten or as completed samples. Each timed child retains its original pre/post real-result checks. Report all five actual timings per arm, loader/compiler/options provenance and excluded setup costs; no equal-speed, allocation-count or whole-program/native claim.

A practical sequence is one new private instrument freeze covering controls and fixtures-only code, followed by a ROOT-pinned preflight receipt used as a timing prerequisite. If the existing freezer cannot pin future output, make the final timing DATA freeze after preflight; preserve identical reviewed tool/source bytes and record the association between freezes. This is a narrow gate on the existing driver, not a new benchmark framework. Do not require a second untimed run merely to change the DATA freeze. ROOT owns final release and adoption after the failed window is sealed.



### AE28 sealed qualification, loader preflight and actual bounded costs — 2026-10-09

ROOT accepted the truthful source-compatible qualification view:497 passing occurrences in23 slots across two epochs (22 original Q0 cells/485 occurrences plus newly executed Q1 AP12/12). Original Q0 remains23 cells/497 executed/496 pass/one AP08 selector failure, with its unchanged failed seal. Actual cumulative qualification execution remains24 body cells/509 occurrences/508 pass/one failure; this is not a fresh all-green497-test run. Q1 seal34511B/SHA05311b16c316010bf73438f4c8bae85a9e42bd713c94d139a74c6f362fb0f5bb is retained.

The first performance epoch remains a closed failure: one baseline child exited1 during module linking because the Node type transformation retained the type-only AllocKind import; zero timed rows/pairs completed. Its immutable seal28295B/SHA662f4f580afbefddd5ea67f86079c56b9bafcbacf8f3b0e34e454cb0401f2297 remains truthful. The separately adopted standard TypeScript5.9.3 loader then passed four real closed preflight children: positive actual value37/side-effect1, genuine used missingValue export refusal (expected exit1 after the positive), baseline and candidate untimed fixtures. Both arms produced six equal full result payloads, fixture hashes and actual scores; no timing/sample fields. Preflight seal38449B/SHA40139ed7ad266f946f22518938ee3ca66816eee8ccf77036e7e607ce5038821d and receipt12743B/SHA6201ee6e02b177bbacb1eff53d1482114d59e18a48e806653184d8db6795b57e are retained.

The final fixed timing epoch completed ten fresh children, all actual spawn/exit/close successful, five alternating paired samples and six workloads per arm/sample (60 timing rows). Every paired fixture/count/checksum/registry boundary agrees; all20 before/after pair custody checks and final seal report zero drift across18732 inputs/132 links. All31 raw artifact hashes and actual sample outputs were independently read back. Driver145717B/SHA60f8fc172a62d25797c449ce69315e9b03a942ddc7644f9def054f0de04fd397; performance seal181951B/SHAf3a5a17f1db40a1688bc4d9ae9a6fd0d87bd295ebbd54f4755aac4e9451a1ccd; final freeze4085523B/SHA9f161b0c6528c632e1efe2989e63656dacb659931ad936bcd1f71faee459c072.

| Workload | Median baseline→candidate ms | Baseline range ms | Candidate range ms | Median difference | Candidate slower pairs |
|---|---:|---:|---:|---:|---:|
| vector-small | 19.404125→18.765792 | 18.342708–23.455208 | 17.886084–19.322833 | -3.29% | 2/5 |
| encoding-small | 1.856500→1.928375 | 1.830000–1.892875 | 1.904792–2.197708 | +3.87% | 5/5 |
| census-small | 8.563375→8.069042 | 8.161084–8.738000 | 7.963292–8.539125 | -5.77% | 0/5 |
| vector-larger | 33.424125→34.213500 | 32.795542–34.038542 | 33.501459–34.771959 | +2.36% | 5/5 |
| encoding-larger | 4.231208→4.000000 | 4.165625–4.258667 | 3.927041–4.072958 | -5.46% | 0/5 |
| census-larger | 10.543333→10.144333 | 10.127417–10.761083 | 10.036791–10.768084 | -3.78% | 2/5 |

Every actual sample, including outliers, remains in `.tmp/ae28-performance-typescript-timing-20261009/performance/driver.json` and the full sample table `performance-result.md` (2519B/SHAfd0e5bc7e3091d12bca7a56cd0f0d1c4313e3fe5eb5d9e66d994788bb5d2501c); complete result JSON115671B/SHAa9d817559a3fdfe09b935a39a202077a8cb45c5cb3393ac4d81cbeb4901f657f. Small rows use500 iterations, larger50; all use40 warmups. Encoding-small is slower in5/5 pairs (+0.071875ms per500, about0.144µs/invocation), and vector-larger is slower in5/5 (+0.789375ms per50, about15.79µs/invocation). These observed increases are disclosed, not erased by four lower medians. No percentage threshold, overall averaged speed or equal-speed claim is made.

Both arms used actual Node25.9.0 and frozen TypeScript5.9.3 on Apple M4/darwin arm64. TypeScript transpilation/module loading and fixture construction precede timing; registry/output/snapshot/checksum costs remain inside the recorded measured boundaries. OS scheduling/GC are not byte-frozen, five samples do not establish universal significance, and there is no allocation counter/forced GC or whole-program/native/public/general-witness/migration-completion claim. No retry, extra sample, fixture resize, source change or worker kill occurred.

ROOT adopts the complete independent measured-cost decision below: proceed with this qualified architectural checkpoint and disclose both consistent slowdowns. The one-hunk encoding default-dispatch hypothesis stays a separately qualified successor after delivery; it is not implemented in the frozen candidate and does not trigger a blanket497 rerun.

# AE28 measured-cost decision

Astra High read-only review, 2026-10-09. **Proceed with the qualified AE28 PR and disclose the two measured slowdowns. Do not reopen this frozen candidate for an unmeasured optimization.** Keep the small encoding dispatch optimization below as a separately qualified successor in existing issue6920. “Just as efficient” has not been demonstrated; delivery should not claim that it has.

Evidence: `.tmp/ae28-performance-typescript-timing-20261009/performance/driver.json`,145717 bytes / SHA256 `60f8fc172a62d25797c449ce69315e9b03a942ddc7644f9def054f0de04fd397`. The sealed execution has ten closed successful children, five paired samples, six identical-result workload rows and zero custody drift. No new execution occurred in this review.

| Row | Median baseline→candidate ms | Difference | Candidate slower in paired samples |
|---|---:|---:|---:|
| vector-small |19.4041→18.7658|−3.29%|2/5|
| encoding-small |1.8565→1.9284|+3.87%|5/5|
| census-small |8.5634→8.0690|−5.77%|0/5|
| vector-larger |33.4241→34.2135|+2.36%|5/5|
| encoding-larger |4.2312→4.0000|−5.46%|0/5|
| census-larger |10.5433→10.1443|−3.78%|2/5|

These are sample-batch wall costs with shared registry/output costs included, not pass-isolated timings. Encoding-small's median difference is0.071875ms per500 invocations (about0.144µs/invocation); vector-larger's is0.789375ms per50 (about15.79µs/invocation). Both slower directions recur in all five pairs; do not dismiss them as nonexistent or hide them behind the other four median improvements. Conversely, five bounded samples do not establish a universal regression rate or exact causal contribution. Do not average unlike workload percentages into an “overall” speed claim.

## What the source explains

`encoding.ts::classifyInstr` now invokes `allocationEvidenceRule` before its existing switch, so explicit string/call handlers incur a rule lookup that currently always returns unsupported. That is a concrete extra dispatch on these paths. The larger encoding workload nevertheless measured faster; the data do not isolate that dispatch as the sole cause of the small-row slowdown.

`ownership.ts::transferInstr` vector cases now perform shared-rule recognition, a frozen event-array loop, current operand resolution and an event-op branch before `touch`/`markEscaped`. `escape.ts` also recognizes the vector rule to enforce its empty direct-escape contribution. These replace some direct local operations/no-op branches with shared-policy interpretation. They add executed control flow, but no per-visit descriptor/array allocation. The measured vector-larger row combines encoding, ownership, escape, registry construction, snapshot and checksum; it cannot attribute its15.79µs delta to one helper. The existing static frozen rules and fresh compatibility adapter satisfy the concrete avoidable-allocation repair without proving equal runtime cost.

Restoring direct duplicated vector policy, caching operands, pre-resolving write/escape operands, adding closures per visit or dropping genuine result checks would violate the accepted architecture/semantics and is not justified by these timings.

## Smallest useful follow-up, after delivery

Proposed production scope: **one hunk in `src/ir/analysis/encoding.ts::classifyInstr`**. Move the existing shared-rule lookup and `encoding === 'no-write'` assertion into the existing switch's `default` branch. Preserve all explicit string/call handler bodies and their order unchanged. Every currently shared instruction kind reaches that default; it still calls the same canonical shared binding. Unsupported kinds retain their old no-record behavior. Do not add a duplicate list of eligible instruction kinds, a second encoding policy table or a special string fixture fast path.

This removes a structurally unnecessary lookup from existing explicit encoding handlers while retaining shared no-write policy for the domain it actually owns. It is a performance hypothesis, not a promised speedup, and does not directly optimize ownership's vector event loop. Leave ownership, escape, effect rules, census and compatibility descriptor untouched in this follow-up. A vector event-application redesign is not justified before isolating its actual cost and would widen the proof/architecture surface.

Implementation/acceptance boundaries:

1. ROOT authorizes the one encoding hunk and the exact source-proof successor/test scope in issue6920. Keep the current source/proof/performance epoch immutable. The current497 qualification view remains evidence for the current candidate, not automatic qualification of changed encoding bytes.
2. Preserve all explicit encoding outcomes, unsupported fallback behavior, canonical shared binding and profile admission. Exercise the existing real encoding suite and relevant portable semantic/AR07 shared-binding controls. Update only the necessary independent source-preservation transport/structural assertions for this precise dispatch move; retain original receipts/preimages and old controls. ROOT selects any further affected registrations from the actual dependency change; do not launch a blanket497 rerun automatically or claim unchanged source pins.
3. Once the changed source and proof are accepted, make one predeclared paired comparison under the same TypeScript loader, fixtures, six rows, iterations, warmups, checksum guards and five-sample protocol. Preserve the current measurements as the previous candidate. No repetition until green, threshold invention, fixture reduction or cherry-picked sample exclusion. Report both improved and worsened rows; if the move is not useful, retain its evidence and make an explicit delivery decision rather than tune the benchmark.

Suggested issue/PR statement: “AE28 now shares allocation-free static local rules across canonical analyses and the finite evidence checker. Six bounded workloads preserve their actual outputs; four median costs improved, while encoding-small was3.87% and vector-larger2.36% slower in this five-pair run. Equal-speed performance is not established. A bounded encoding dispatch follow-up remains recorded.”

This recommendation concerns this qualified architectural checkpoint. It grants no native parity, general witness completion, legacy retirement or protected-queue release; ROOT retains those decisions.

## Shared Linear geometry boundary inventory: adopted bounded dependency plan (2026-10-09)

ROOT adopted the complete Astra High plan below and assigned exactly two policy locations plus this append. Isolated branch `codex/6920-linear-geometry-boundary-20261009` starts at actual published C head `e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f`; fresh REST PR6600 is OPEN, merged:false, HOLD, and canonical main is `7fc2b700eb320e18db213f286350fd1bd56982ef`. C merged main into its branch; geometry is not delivered to main. No C branch/source/test/claim edit is authorized here.

Actual upstream claim `6920:linear-geometry-boundary-inventory-20261009`, owner `ttraenkler/codex-sol-linear-geometry-boundary-20261009`, write `77854-2m6xnnwx`, is in-progress and was independently effect-read before this append. Scope is foundation's one added entry/minimum9→10 and exactly one clean/foundation files row for `src/shared/contracts/linear-memory-layout.ts` in `scripts/compiler-boundaries.json`; no allowedEdges, other rows/history, checker, source, tests, or proof changes. Existing issue custody at the packet's missing files-row finding and Session C continuation reserves this inventory to A/ROOT.

Fresh canonical ledger `df160ab7aedb5fbf11b69f9f8990dc784cc5ee0c` contains2,976 records. Historical D0 `38570-vbf5jpfz` initial detector and foundation `58141-jewit8ch` identity activation remain held; their published bounded delivery is recorded in `plan/agent-context/3518-first-boundary-dispatch-2026-09-07.md`. Named5753 key/object-layout registrations `60976-gs24rmdq`/`80767-mlvveu0a` remain separate (`plan/agent-context/5753-composed-boundary-repair-2026-09-15.md`). ROOT's `41777-d2f5erfl` owns only six allocation-evidence registrations, explicitly preserving geometry policy followup. Proposal `29777-pzvu0tq3`, C `4237-ijwd2prx`, AE28 source `43989-lv9fr4w8`, metadata `44305-2ijq5h0r` and all foreign records remain untouched. No newer competing exact geometry inventory hunk was found. The new claim does not transfer historical owners' scopes.

Before policy editing, actual unmodified C inventory under Node25.9.0 and immutable comparison base C exited1: invalid-inventory, ten errors (one unclassified-module, one unclean-active-layer, six unclassified-target, two forbidden-transitive-path),1,899 tracked source modules, foundation9, architectureComplete:false. Exact raw output/stderr/exit and all2,976 claim records are preserved in the task-private `.tmp/boundary-*` receipts. Candidate evidence is pending; no gate pass, geometry semantic rerun, public admission or architecture completion follows from plan adoption. ROOT authorized the narrow assignment notice in existing PR6583 before policy implementation.

### Complete adopted Astra plan

# Issue 6920 — complete the shared Linear geometry boundary inventory

Private implementation-plan proposal, Codex GPT-6 Astra High, 2026-10-09. ROOT must adopt this plan and assign the exact policy hunks before implementation. This read-only planning task changed no repository, source, tests, issue, claims, Git state, or public comments and ran no checker/test/compiler runtime. The frozen AE28 lane is unrelated and remains untouched.

## Exact checkpoint and custody

GitHub REST-backed connector revalidation of PR6600 returned **open, merged:false**, head `e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f`, base main `7fc2b700eb320e18db213f286350fd1bd56982ef`. C's [comment6073377464](https://github.com/loopdive/js2/pull/6583#issuecomment-6073377464) says main was merged into C's branch; it does not establish that PR6600 was merged into main. Its G24 24/24 and clean typecheck are C's reported measurements, not executions by this planner.

Read the exact remote head's policy, checker and three geometry source files. The local preserved geometry source/checker files independently have the identical Git blob IDs, allowing direct inspection without touching C's checkout:

| File | Exact head Git blob |
| --- | --- |
| scripts/compiler-boundaries.json | `47808eea7a41637438ed783d8a35dc18d99c4382` |
| scripts/check-compiler-boundaries.mjs | `e6758d9cacabfe0a56fe60ec8812bb860355fe27` |
| src/shared/contracts/linear-memory-layout.ts | `59450b9ad09d7ebf16af04a8a1ab655a5c81b0ee` |
| src/ir/analysis/contracts/linear-memory-layout.ts | `0dd2108962236a64e2b96479309b5b1e9735c90e` |
| src/ir/analysis/linear-memory-plan.ts | `3db990eb21e3ed216cd798548af6d076e32ed9e1` |

The old packet is `/private/tmp/js2-ir-b-contract-docs-20261008/plan/log/6920-shared-linear-geometry-20261009/boundaries.patch`, 648 bytes, SHA-256 `8068abcac73db2354db1c0a24bc292ef114f1d04d5b401dbf65d08e4e5a56a59`. It adds the foundation entry and raises its minimum from nine to ten; it contains no `files` classification. C's report that this patch alone retains all ten diagnostics matches the actual checker logic.

Existing issue plan: `plan/issues/6920-native-linear-shared-source-handoff.md`, A-G zero-import geometry plan and the “Session C geometry continuation confirmed” custody section. The broader `/private/tmp/js2-ir-main-boundary-plan-20261008/implementation-plan.md` concerns the separate dirty composition and many other modules; do not import its broad layer changes into this narrow fix.

## Why this module belongs in foundation

The shared module has zero imports/re-exports, including type imports. It owns storage/layout DATA, existing address/header/forwarding constants and pure geometry/key functions over storage kinds and strings. Its single frozen forwarding object is local data. It has no IR instruction identity, allocation registry, ownership/escape solver, target emitter, compiler context, parser, physical resource handle, or host runtime dependency. Classifying this actual closed module as clean foundation is justified by its contents, not merely its filename or the word “shared”. It does not claim that the entire allocation planner is foundational or that the constants are universally target-independent.

The IR contracts file remains clean `ir-analysis`: it re-exports geometry types and imports the needed shared types, while retaining allocation/site/policy records and their canonical IR-analysis dependencies. The larger planner remains at its current classification; its four shared-module references do not justify promoting it. No source move or semantic change is required.

## Exact minimal edit: one policy file, two locations

Only edit `scripts/compiler-boundaries.json`:

1. In the existing `layers` object with `id: "foundation"`, append `"src/shared/contracts/linear-memory-layout.ts"` to `entries` and change `minModules` from `9` to `10`, exactly as the old packet does. Preserve all nine entries, active/required status and roots.
2. Add exactly one object to the existing `files` array, preferably adjacent to the existing shared-contract classifications:

```json
{
  "path": "src/shared/contracts/linear-memory-layout.ts",
  "state": "clean",
  "layer": "foundation"
}
```

Do not add a second `modules` list: the checker builds its module population from the actual source tree and joins it to `files`. Do not duplicate the existing IR contracts row, which is already `{path:"src/ir/analysis/contracts/linear-memory-layout.ts",state:"clean",layer:"ir-analysis"}`.

**No allowedEdges change is necessary.** The exact head already contains:

```json
"foundation": ["foundation"],
"ir-analysis": ["ir-analysis", "foundation", "ir-core", "wasm-model"]
```

The clean foundation classification makes the real IR-contracts → shared-contract dependency traversable under that existing rule. Do not add a per-file transitive exception, grant foundation → IR, broaden mixed-layer permissions, ignore type-only references, exempt the path, or weaken enforcement. No new layer, external policy, nonModules entry, moves/evidence record, checker code, or activationHistory rewrite is required for this repair. Preserve existing history and all source-evidence denominators; subsequent immutable-base comparison protects the new active entry/minimum.

The `files` row alone is the missing classification needed to resolve the reported errors; the entry/minimum additionally makes this actual tenth foundation module a required activation root. These are separate responsibilities.

## Expected diagnostic mechanism

The checker inventories actual modules at lines412–414, then requires each active-root occupant to be clean in the proper layer at lines417–445. Without the row, the shared file creates `unclassified-module` and `unclean-active-layer`.

At lines545–551, all six imports/re-exports targeting it are recorded as unresolved `unclassified-target`: two type-only references from the contracts file and four references from the planner. The contracts file is enforced. Its two unresolved references become terminal edges at lines591–614; the unresolved terminal has no allowable external-package rule, causing the two `forbidden-transitive-path` diagnostics. They are consequences of missing classification, not evidence that `ir-analysis → foundation` is forbidden.

After classification, those six edges resolve normally. The contracts file's two edges reach clean foundation under the existing direct/transitive allowance, and the shared module has no onward dependencies. The planner is explicitly `unmigrated` in `mixed-needs-split`, whose allowedEdges array is empty. Its four now-resolved shared references therefore become ordinary **unenforced forbiddenEdges debt records**, not clean-layer errors; do not grant an allowance or relabel the planner to hide them. Preserve and report that graph-accounting change. Confirm the actual post-edit report rather than inferring a gate pass solely from this reasoning.

## Composition and ownership constraints

Fresh read-only `issue-assignments` API results:

- C's `6920:c-shared-linear-geometry-source-20261009` is in-progress, assignee `ttraenkler/claude-session-c-geometry-20261009`, write `4237-ijwd2prx`. It owns the three geometry source hunks and `tests/issue-6865-linear-layout-contract.test.ts`. Do not alter these or C's branch/claim.
- A's old geometry preparation claim is released, write `60707-95hx19zl`; that is not permission to resume competing geometry edits.
- AE28's canonical local rules claim is in-progress, assignee `ttraenkler/codex-sol-allocation-evidence-checker-20261009`, write `43989-lv9fr4w8`. Its five source files, three authored test files and evidence freeze are not part of this assignment.

The issue and coordination thread reserve compiler-boundary inventory/policy to A/ROOT. Before executable edits, ROOT must effect-read current canonical ownership and publish a narrow policy-hunk assignment under issue6920. A new slice label does not permit overwriting another owner's policy changes. Retain B's provider/native leaves, dirty primary checkout, all historical proof readers/receipts and protected-queue ownership.

Compose against the exact C source or a ROOT-owned successor containing it. Applying this policy to main without the new shared source would instead produce a stale classification and missing activated root. ROOT may hand the exact two hunks to C for its own integration, or prepare its own explicitly coordinated integration branch containing C's source; this plan authorizes neither a foreign-branch edit nor duplicate geometry implementation. Revalidate head/base and merge conflicts before using the rows on a newer checkpoint.

## Validation and acceptance

Run only after ROOT adopts/releases the implementation. First retain the unmodified exact C-head inventory report (including stderr/exit), then run the same command against the composed policy candidate, with the immutable actual pre-edit comparison base pinned:

```sh
node --max-old-space-size=2048 scripts/check-compiler-boundaries.mjs \
  --mode inventory --base e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f \
  > /private/tmp/js2-6920-boundary-candidate.json \
  2> /private/tmp/js2-6920-boundary-candidate.stderr
```

Use distinct baseline output names and capture each real exit code. At the final commit/merge-preview checkpoint also run the actual CI form, `node --max-old-space-size=2048 scripts/check-compiler-boundaries.mjs --mode inventory --base HEAD^1`, preserving its JSON/stderr. Do not rely on the default `--base HEAD` for historical activation protection, nor on default mode: default `complete` intentionally remains failing while migration debt exists. If an intervening parent has different actual policy/source, record its full SHA and preserve all its additions rather than forcing this older pin as a substitute.

Required assertions from the real report: inventory mode exits0; `inventoryValid:true`; exactly one clean foundation row for this module; foundation has ten entries/modules and minimum ten on this checkpoint; the new root is visited; all six actual references resolve to that same module with their original syntax/type-only flags; its outgoing reference population is zero; none of the ten reported diagnostics remains and no replacement error appears. Source population/bytes and all unrelated policy state must be unchanged. The expected truthful status is `inventory-valid-architecture-incomplete`, with `architectureComplete:false`; retain remaining debt and normal forbidden-edge reporting. Do not misreport that status as full architecture completion.

Use the existing `tests/issue-3518-compiler-boundaries.test.ts` for normal policy/checker regression coverage if required by ROOT's gate cohort, plus formatting and the ordinary required CI gates. No new test framework or checker implementation is needed for two data hunks. G24's reported result is source-semantic evidence already owned by C; this policy-only change does not independently rerun or supersede it. Keep the actual final main ancestry/content and protected-queue verification with ROOT.

Acceptance is complete canonical inventory registration and the genuine inventory gate result for the composed geometry checkpoint. It confers no JS-host IR admission, no IR/legacy output equality, no native public result, no source migration completion and no legacy retirement. All original issue6920 obligations and historical receipt custody remain intact.



### Exact composed inventory and detector qualification (2026-10-09)

Actual unchanged checker under Node25.9.0, explicit immutable base `e5b67e2d2ddb92cc2ccd039a5677f476a78bf93f`: baseline exited1 with ten errors; the exact two policy-location candidate exited0, `inventoryValid:true`, status `inventory-valid-architecture-incomplete`, `architectureComplete:false`, zero errors and zero unresolved references. All1,899 tracked source paths/hashes are unchanged. Exactly one clean foundation classification was added; foundation's ten entries/modules/minimum are ten and all ten roots were visited. The shared module has zero outgoing references. Its original six incoming references preserve source/syntax/type-only/line and now resolve to the same foundation module.

All four unknown-edge rows remain unchanged. Forbidden-edge debt increases truthfully from13,817 to13,821: exactly the planner's four formerly unclassified references become unenforced mixed-needs-split→foundation debt; no prior forbidden edge was removed. The planner's classification, allowedEdges, existing activated roots/history, historical evidence and unrelated policy data are unchanged. Candidate policy606,971 bytes/SHA256d32f2d135094d616309588dabdcdfb3af643b87896c0de27c107f5e4e15a1896; exact C policy preimage606,787 bytes/SHA256b5d6c24b2a0c4cdeeb3aabaae8213eb71a1eaa09c399ff693b7939da75bd66e9.

Existing unmodified `tests/issue-3518-compiler-boundaries.test.ts` ran through normal Vitest3.2.4 on Node25.9.0:125/125 passed,0 failed/pending. Prettier's policy check exited0. Raw baseline/candidate JSON, stderr and exits; regression report/log/exit; exact row audit; and fixed original source population are preserved in this lane's `.tmp/boundary-*` review packet. A private audit initially looked for baseline unclassified references in the resolved array; inspection corrected it to actual unresolvedEdges, with that diagnostic retained and no production checker rerun or input mutation.

Authorized preimplementation notice [PR6583 comment6073476414](https://github.com/loopdive/js2/pull/6583#issuecomment-6073476414) records actual claim77854-2m6xnnwx and exact scope. No source/tests/checker/proof changes, geometry semantic rerun, commit, push, queue change or main delivery occurred. ROOT review precedes signed normal dependency delivery for C's existing PR6600. CI-form `--base HEAD^1` belongs to the later actual committed/merge-preview checkpoint; no fabricated successor parent is used here.


### ROOT review and bounded dependency delivery release (2026-10-09)

ROOT independently verified every review-packet artifact/file hash, the exact two policy locations and unchanged allowedEdges/other policy data, the complete281162-byte issue prefix and full adopted Astra plan, all1899 source hashes against both actual reports, all six references/no outgoing shared references, every13817 original debt row plus precisely four unenforced planner rows, errors10 to0 and125/125 actual detector test rows with zero pending. ROOT approved normal signed Thomas/Codex GPT-6.1 Sol High dependency commit and fork publication on this separate branch; C must merge the exact dependency into its existing PR6600. Root retains protected-queue ownership and HOLD. Fresh claim77854-2m6xnnwx remains held by the assigned boundary owner; PR6600 remains OPEN/unmerged at exacte5b67e2d2ddb92cc2ccd039a5677f476a78bf93f, canonical main7fc2b700eb320e18db213f286350fd1bd56982ef. No source, test, historical proof or AE28 work is altered. Full normal hooks and postcommit CI-form inventory against the actual first parent remain required; this release is not a claim that those later operations have already passed.


## ROOT-adopted B CI archive and finite source contract release — 2026-10-09

ROOT delegates this docs-only publication to slice `6920:b-ci-contract-publication-20261009`, actual upstream/issue-assignments owner `ttraenkler/codex-sol-b-ci-contract-publication-20261009`, write `94594-m2o7o4g1`. Authoring HEAD/base is freshly verified canonical `616da017ca11cefa61f3f8d71a1c7ac18773491c`, branch `codex/6920-b-ci-contract-release-20261009`. Scope is only the new full contract log and appended issue6920/Session A log sections; no production functions or foreign claims are owned.

The [complete adopted contract](../log/6920-b-ci-contract-release-20261009.md) preserves the full 26,593-byte Astra High spec (SHA-256 `d6f6f6d4d6962dadc24be72059b10fa6ae3747740c60027cca49c20c51fff88c`) and [ROOT's normative release](https://github.com/loopdive/js2/pull/6583#issuecomment-6076669715). Part A is exactly two inserted uploader steps; existing advisory80796 and shard10279 regions are excluded. Part B is only the named finite runner functions/controls, historical953f74 plus fixed2a8c200c bound to canonical616da; `PINS`, `APPROVAL_COMMIT` and baseline stay immutable. B needs fresh named claims and complete adoption in issue6915, “Linear owned-ASCII append: optimize the existing copy kernel”. B parent reviews exact patch/freeze before authorizing one serialized qualification; 36 complete observation graphs plus completion must equal the old baseline within38 envelopes and full custody. Difference/refusal stops; no auto-retry/repin/filtering.

PR6600, “refactor(linear): publish shared Linear memory geometry contract (6920 A-G)”, exact `e8f56680589752d67c83ce80cbb43b1bebf1f056`, is queued position1 in actual group `2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa`, awaiting102 conformance shards/required gates, not delivered. PR6593, “fix(ci): preserve trusted Linear append regression custody”, exact `2f8ae6bde384d9f182981c11b94f7230988caa42`, remains blocked on source approval/full-witness qualification. Failed/missing historical evidence stays failed/missing. No future trees, import rewiring, native admission, HOLD removal or queue authority are released; ROOT retains integration/queue. This docs publication runs normal hooks, not the qualification or runner self-test.

ROOT authorizes a fourth docs artifact, `plan/log/6920-b-ci-contract-release-20261009.spec.txt`, under the same docs claim. It preserves the exact normative26593-byte specification/SHA above. The full readable Markdown display substitutes only the absent B-owned6915 issue pathname with its title and existing PR6593 authority; normal link checks remain enabled. Original signed checkpoint `c890a55c10fceb48149d9116a1ad44c0f89869b5` stays historical, unpushed; follow-up publication identity is confirmed externally. No B issue copy or gate changes are authorized.


## Publication refresh after verified C geometry delivery — 2026-10-09

ROOT records PR6600, “refactor(linear): publish shared Linear memory geometry contract (6920 A-G)”, delivered at `2026-10-09T07:57:57Z` as canonical merge `2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa`, exact reviewed head `e8f56680589752d67c83ce80cbb43b1bebf1f056` and reviewed tree prefix `e9fdf1f42`. ROOT verified six required group gates and all102 actual conformance jobs successful. This replaces the earlier queued status for C; original queued-state records above remain historical.

This docs branch refresh merges freshly API/fetch-verified main `b47c6e4b9d64ce848407a80a03a063fb102ffe8b`, whose parent is delivered2d0. Publication head is reported externally after the signed merge/push. Claim94594-m2o7o4g1 remains effect-read in-progress with owner `ttraenkler/codex-sol-b-ci-contract-publication-20261009`; ROOT delegates only the two new contract artifacts and issue6920/Session A log appendices. Both canonical C append and this lane's prior release append remain intact. All non-doc paths match refreshed main exactly.

The adopted tested contract base616da and finite historical953f74/current2a8c200c targets remain historical and unchanged. Newly delivered geometry changes complete `src` identity; neither this main merge nor C delivery automatically approves a new B source tree. B PR6593's existing source-approval/full-witness limits, fresh claims, one serialized parent-authorized qualification and stop-on-difference/refusal remain. Original PINS/APPROVAL_COMMIT/baseline and exact normative26593-byte specification/SHA remain immutable. No B source/runner/workflow/claims, native admission, HOLD or queue authority change is performed by this docs refresh; ROOT retains integration and protected queue decisions.


## Session A B geometry-source contract release — 2026-10-09

ROOT adopts the [full reviewed third-source contract](../log/6920-b-geometry-source-release-20261009.md) and exact normative31,726-byte companion (SHA256 `aa04bdb08792e0dc6db4007462bf982456335068b9dcb75e5f668402af511c58`), following [ROOT's full-text release](https://github.com/loopdive/js2/pull/6583#issuecomment-6077817777), published at `2026-10-09T09:02:24Z`. This append preserves the exact canonical Session A handoff prefix. Publication claim `6920:b-geometry-contract-publication-20261009`, owner `ttraenkler/codex-sol-b-geometry-contract-publication-20261009`, was effect-read on upstream/issue-assignments as in-progress / `48581-uq40ialx`; authoring base is fresh API-verified canonical `cffb28679df96764e295fd2064e0a4ceec643efe`, source `171606514a3cf6733e82eb11549a659856d68c1a`. Signed publication head is reported externally after normal hooks and remote readback.

Private implementation only: B's runner literal/predicate/corresponding embedded controls may add the fixed geometry tree1716 anchored to delivered2d0. Original approval/PINS/successor/baselines/all128 controls and full source/config custody stay fixed. Existing runner owner62837 must acknowledge, serialize and effect-read a fresh same-owner continuation; no competing writer or foreign claim release. B parent adopts the full plan before editing, reviews exact patch and independent committed-input freeze, then separately authorizes ONE trial requiring strict exits, complete custody,38 envelopes and all36 full ordered observation graphs plus completion equal to the retained baseline. No runtime release, future-tree approval, rebaseline or filtering; stop on any difference/refusal and preserve it.

Fresh B PR6593, “fix(ci): preserve trusted Linear append regression custody”, is `75a018957cd83b8c727adc73136ed0f2bf780fad` with HOLD; initializer PR6577, “refactor(linear): extract initializer and preserve Prepared evidence”, is `80c93a3e1fd6ab47e6deec6db59878cb26e1f721` with HOLD. Initializer writer is unavailable and claim4467 is not transferred. Existing zero-child CI failures remain archived. ROOT verified geometry PR6600 delivered at `2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa` with102 actual conformance jobs passed, and docs PR6602 delivered at `bb58c562545e4bd08310ab2bfc41bbd88679d958` with docs-only skips. No new runtime measurement follows from this publication.

ROOT's A integration owner60335 retains its separate head7928/pendingb932 and dirty unpublished proof work untouched. C1's old DATA-pin failure remains preserved; private bridge authoring is pending, without native-equality/retirement credit. All B HOLDs and ROOT's final integration/queue authority remain. Only the two new contract artifacts and these two appendices are owned; no B issue copy, source, runner, workflow, gate, foreign claim, HOLD or queue mutation is included.


### Finite cloud metadata-domain takeover (2026-10-10)

The user explicitly authorized taking over the blocked metadata-domain helper
in addition to the CI timeout prerequisite. This continuation adds only the
three canonical imports and the published
`checkRegistryEvidenceMetadataDomain` proposal to
`src/ir/analysis/allocation-evidence/metadata.ts`, plus a separate regression
suite. The 3240-byte proposal block matches SHA256
`f192fe3e90beb7920c5b776c23fd532a493e606f4bd4a34fbc2bcb4fe2946bdd`.
Removing the additions reconstructs the canonical 5550-byte original, SHA256
`7686bf689b3ff97457e7fcd7c6dc0417ea87e9fa855181b31831d106186b6175`.

The helper checks present ownership, escape and encoding value domains after
prior DATA/snapshot/context screening; absence remains absent and extension
namespaces remain outside its authority. It grants neither coverage nor body
truth. Existing census/comparison algorithms, tests and fixtures are preserved.
The live prepared-program validator is not wired to this helper by this finite
change, and private caller composition remains unverified.

PR6626 at `4e9ed97a63dd672971857f443380948af4c9c519` remains draft
and unmerged. Its initializer experiment and compiler-boundary archives were
hash-verified as historical evidence, after refreshing all 157 coordination
comments; they supply no current-main acceptance or broader release. Existing
claim records remain preserved. The attempted continuation claim was not
published; Git publication is blocked by HTTP403, permission denied to
ttraenkler. No merged dependency or complete IR equivalence is claimed.

Local validation: all 51 tests across the new suite and six existing allocation
evidence suites passed; the final renamed/formatted new suite passed 11/11.
TS7 typecheck and the import-cycle ratchet passed. The current-source boundary
inventory remains valid but architecture-incomplete, with graphComplete false;
it is not full IR acceptance. The original first 50/51 run is retained in
private evidence, including the explicit-undefined fixture-construction defect
fixed in the new suite. No existing failure or fixture was rewritten.
