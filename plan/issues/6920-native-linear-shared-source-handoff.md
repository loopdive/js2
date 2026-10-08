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
