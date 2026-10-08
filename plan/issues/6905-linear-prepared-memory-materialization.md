---
id: 6905
title: "Linear Prepared IR memory materialization and ownership handoff"
status: in-progress
sprint: current
created: 2026-10-07
updated: 2026-10-08
priority: high
feasibility: hard
reasoning_effort: high
task_type: implementation
area: codegen-linear
goal: ir-full-coverage
related: [3528, 2956, 6889, 6888, 6893, 6896]
files:
  - plan/issues/6905-linear-prepared-memory-materialization.md
  - src/codegen-linear/runtime.ts
  - src/codegen-linear/runtime/vector-initialization.ts
  - tests/issue-6905-linear-prepared-memory-materialization.test.ts
  - src/codegen-linear/runtime/README.md
  - scripts/compiler-boundaries.json
---

# Linear Prepared IR memory materialization and ownership handoff

## Evidence and release state

Exact inspected base: `3c671f11506f91f4eb91624cf9a8456ca95a6ce8`.
The original shared-route specification remains blocked on explicit ownership
agreement and publication of A's shared contract and wiring. Subsequent bounded
amendments below release only the independent initializer extraction and new
regression file; these are now implemented and measured. No shared-route
allocation support or full migration completion is claimed.
Canonical reservation owner: `ttraenkler/codex-linear-b-prepared-memory-20261007`.
Planning claim: `6905:prepared-memory-plan-20261007`, owner
`ttraenkler/codex-linear-b-memory-astra-20261007`, branch
`codex/6905-linear-prepared-memory-plan-20261007`.

Parent measured unchanged `tests/issue-3525-prepared-linear-early-return.test.ts`
on this base: **17/17 pass, zero skips, exit 0**; total 167.84s, tests 118.059s.
Command: `pnpm exec vitest run tests/issue-3525-prepared-linear-early-return.test.ts
--pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism`, under
an external 240s deadline. Test SHA256:
`8c3787b33a1d38dd42a261a1d8f40fdea10053a37816bef38c064f761387fd3d`;
raw log SHA256: `5057f2b17ba35b094561c4a00b79e77f3f0d07eaefa9eb55397c6bd4949e5e21`.
Custody: `plan/log/6905-linear-prepared-memory-20261007/prepared-scalar-control.log.gz`
and `plan/agent-context/linear-prepared-memory-session-b-20261007.md` (parent-owned).
This proves existing scalar Prepared consumption, including poisoned legacy
generators and both targets; it proves neither allocation nor whole-IR parity.

## Current source and root cause

- `src/compiler/ir-program-driver.ts::runIrProgramDriver` (line 13) already calls
  `prepareWholeIrProgram`, `acceptPreparedIrProgram`, `emitAcceptedIrProgram`.
  The consumer is **`src/ir/program-consumer.ts`**, not the historical backend
  path in [IR-only R8: linear consumes the shared Prepared IR program](3528-ir-r8-shared-linear-prepared-program.md).
- `src/ir/program-physical-plan.ts::planPhysicalSetup` (1222, refusal at 1457)
  rejects Linear when `program.allocations.size > 0`. Its signature converter
  (950) admits native vector carriers only with native resource layouts.
- `src/ir/program-consumer.ts::physicalSignatureConverter` (808) uses native
  vector/string carriers; `physicalBodyResolver` (1103) builds GC vector handles.
  `materializePhysicalProgram` (1234) has no corresponding Linear memory pack.
- `fillPrimaryBody` (931) delegates to
  `src/ir/program-native-invocation.ts::fillPreparedPrimaryUnit` (223), which
  constructs `new LinearEmitter()` without runtime-operation options. The
  common fill path must retain original function/slot/signature ownership.
- `src/ir/backend/linear-emitter.ts::emitVecNewFixed` (313) already requires
  planned allocation/initialization operations. The overlay's
  `compileLinearIrFunctions` (1039) supplies these, binds frozen memory facts
  (1535), and corrects vector scratch locals (1594). It is not the shared route.
- `src/ir/lower-generic.ts::ensureVecDataScratch` (847) currently creates a
  GC `ref_null` scratch. Shared Linear fill lacks the overlay's i32 correction.
  Removing only the allocation refusal would therefore be unsound.
- `src/wasm/physical/module-reservations.ts::PhysicalModuleReservations` already
  provides `reserveMemory` (781), `reserveDataSegment` (791), function/global
  reservation, freeze/fill/seal. No second module-index allocator is needed.

## Implementation Plan

### 1. Agree one bounded first capability and generic input (A prerequisite)

First increment: default-arena, fixed-length **f64 vectors**, locally allocated
and read/length-observed through shared Prepared IR; scalar public boundaries.
Internal vector calls require fully covered producers/callees. Public array ABI,
growth, strings, objects, refcells, dynamic values and stack/linked heaps remain
outside this increment. Refuse unsupported demands before reservation; never use
source-name allowlists or fallback after acceptance.

`PreparedIrProgram.allocations` is the detached `AllocRegistrySnapshot`, verified
by `src/ir/program/allocations.ts::assertPreparedIrProgramAllocations`. A must
publish the projection joining live IDs, owners, types and existing metadata to
selected `runtime.prepared.functions`. Preserve absent evidence and retired IDs;
neither proves live demand or stack eligibility.

Reuse `src/ir/analysis/linear-memory-plan.ts::planLinearMemoryFromFrozenFacts`
(687) and its verifier (599). Its input is `LinearPreparedAllocationFacts`, not
the program snapshot directly. A owns any factoring of
`prepareLinearAllocationFacts` (393) into producer analysis plus a pure detached
projection; the consumer must not rerun that producer to refresh authority.
Account for runtime-support allocations and projection/body changes explicitly;
missing/extra/aliased IDs require validated joins, not positional assumptions.
Do not add a second serialized allocation registry or backend addresses to IR.

### 2. Publish exact shared wiring and ownership seams (A retained)

A retains these named functions; B does not edit them:

- `program-physical-plan.ts::planPhysicalSetup`, `physicalSignatureConverter`:
  consume the Linear plan, validate the complete demand, and replace the blanket
  refusal only for fully materializable resources/carriers/providers.
- `program-consumer.ts::acceptPreparedIrProgram`, `materializePhysicalProgram`,
  `physicalSignatureConverter`, `physicalBodyResolver`, `fillPrimaryBody`:
  retain the exact accepted resource plan; reserve imports before definitions,
  freeze indices, fill target resources, bind layouts/operations, then lower
  each original body into its original slot and reconcile actual receipts.
- `program-native-invocation.ts::fillPreparedPrimaryUnit`: install the genuine
  target emitter/converter while retaining signature and completion checks.
  A also owns the narrow scratch-type seam in `lower-generic.ts` and relevant
  layout/emitter contracts. Prefer a representation-derived scratch carrier;
  do not duplicate overlay postprocessing or globally change GC scratch types.
- `linear-integration.ts::makeLinearIrResolver`, `linearValueTypeConverter`,
  `linearRuntimeFunctionName`: A controls any extraction needed to share the
  existing f64 layout/operation mapping, preserving the overlay unchanged.

No entry/index, maps, ABI preparation or admission edits are released to B.
Earlier fixture rejection remains A's prerequisite, not hand-authored IR credit.
A publishes interfaces/dependency commits before dispatch, including a real caller.

### 3. Target materialization and runtime reuse (conditional B source slice)

Proposed B file: **`src/backend/linear/program/memory.ts`** only, after approval.
Its bounded responsibilities are plan/reserve/fill/completion for the accepted
fixed-f64-vector memory pack, and target layout/carrier/operation bindings.
Proposed exports must be finalized by A's actual callers, not speculative hooks.
Use existing `LinearMemoryPlan`, canonical vector layout (length +8, capacity
+12, elements +16, stride 8, minimum capacity 16) and `LinearRuntimeOperation`.
Return i32 vector carriers with the exact plan's `LinearVecLowering` handles.
Resolve operations through this transaction's reservation tokens after freeze,
never helper names, imported namesakes, guessed offsets or a detached module.

Reuse `__malloc`, `__arr_new`, `__linear_ir_vec_init_f64`. Preserve existing
source-order evaluation, reverse consumption into original element indices,
completed-length publication and value-first `(f64, i32, i32) -> ()` initializer.

**Additional dependency:** `src/codegen-linear/runtime.ts::addRuntime` (129),
`addArrayRuntime` (847) and `addLinearIrVecRuntime` (1375) directly append module
resources today. They cannot be invoked on the ledger-owned module unnoticed.
The allocator owner (active 4540) and A must publish reservation-compatible
reuse of the existing bodies, with legacy builders using the same bodies.
Any extraction has its own exact file/function agreement; it is not B permission
to copy an allocator, append then adopt slots, or emit a throwaway module and
rebase its indices. No malloc/OOM/linked-heap correctness expansion is included.

Reserve through the ledger; retain heap-floor/header/allocator behavior. This
vector pack needs no data segments; later literals require endpoint-aware placement.
Reject missing/duplicate/foreign/unfilled tokens. Helpers join support receipts,
not source-unit counts. Preserve one-shot acceptance and sealing.

### 4. Separate test slice and frozen comparison

Sol 6.1 Medium T: **`tests/issue-6905-linear-prepared-memory-materialization.test.ts`** only.
Sol 6.1 Medium K: approved target module only. A retains wiring; the runtime owner
retains extraction. Order: contract publication → prerequisites → K/T → A integration
→ parent-serialized validation. No idle target module lands.

- First positive source: `export function run(a:number,b:number):number {
  const values=[a,b]; return values[0]+values[1]+values.length; }`.
  At `(1.5,-2.25)` require **1.25**, real shared acceptance/emission and validated
  executed Wasm. Use runtime inputs and identical optimization settings to keep
  allocation observable; assert the retained allocation/body census. Its exact
  shared-route baseline outcome is **unmeasured**, not inferred from the overlay.
- Add empty/multiple literals, distinct fractional values, branch/early return,
  and an internal vector call where prepared admission permits it. Verify i32
  locals/carriers, header/length/payload and finite arena use with fresh instances.
  Poison legacy generators/overlay entry as the unchanged scalar control does.
- Test import-offset and namesake controls, missing/foreign reservation tokens,
  unsupported carrier/policy/provider demands, stale or extra allocation facts,
  repeat emission and cross-transaction reuse. No unchecked admission by name.
- Source-free replay must consume the real captured/encoded program without
  frontend/checker imports, preserve allocation ownership and reproduce output.
  Tampered snapshots must fail without resource/body completion or fallback.
- Run identical new test bytes on exact base and coherent candidate; preserve
  every failure, raw log, input/hash/options and dependency SHA. Compare outputs
  to native JS and retained direct controls; compare replay artifacts under the
  same target/configuration, not GC bytes to Linear bytes. Unit-only synthetic
  resource tests never replace source execution. Keep all existing fixtures.
- Rerun the unchanged 17-case scalar control on both epochs and relevant existing
  allocation/ownership controls. No skips, green-pinned refusals or erased reds.
  Any remaining source/admission/emitter failure stays attributed to its owner.

## Acceptance and handoff

No independently used B implementation is possible before A's seams and runtime
reuse are released. R8 and legacy remain. Follow generic IR → target representation;
use cohesive subfolders, no duplicated optimization orchestration or borrowed
central-file growth allowance.

- [ ] A publishes exact contracts, caller wiring and file/function partition.
- [ ] Runtime owner publishes reusable reservation-safe bodies; no duplication.
- [ ] Shared source route actually allocates, executes and records exact owners.
- [ ] Frozen baseline/candidate, source-free replay and both-target controls pass.
- [ ] Parent publishes coherent evidence/dependencies for A's final integration.

## Amendment: independent baseline requirement before source wiring

Read-only reground: HEAD `609286c99f06ea7abcfed51aebd33ecaec3f454c`, containing
main `9e22f80ce60956ea2f397b4dfbe1cd46cdabac0a`. The allocation refusal and existing
shared APIs remain. A's contract is unpublished; K stays blocked. This amendment
permits a separately claimed Sol 6.1 Medium T baseline slice before section 4's
source dependencies: only new `tests/issue-6905-linear-prepared-memory-materialization.test.ts`.
No shared files, existing tests, harness/configuration or production modules change.
This is meaningful independent specification of observable behavior, not a new
resource interface or implementation release. Parent handles claims and runs.

Freeze one source under `./entry.ts` and arguments `(1.5, -2.25)`:

```ts
export function run(a:number,b:number):number {
  const values=[a,b]; return values[0]+values[1]+values.length;
}
```

Implement four ordinary, independent tests (no shared failing setup):

1. Native JavaScript control: execute the equivalent array expression with those
   arguments and assert literal **1.25**, independently of compiler outputs.
2. Actual shared Linear scalar control: source `export function run(a:number,b:number):number
   { return a+b+2; }`, same arguments/result, accepted/emitted and executed.
3. Direct Linear legacy positive: compile the unchanged allocation source with
   `compileMultiSource`, `experimentalIR:false`, `disableIrFirst:true` and
   `JS2WASM_LINEAR_IR=0`; prove the direct generator ran and overlay did not.
4. Positive shared Linear allocation requirement: unchanged allocation source
   must yield artifacts, authentic acceptance, real emission and runtime **1.25**.
   If preparation/acceptance currently refuses, preserve that failure as red.

Use existing `analyzeMultiSource` → `runPreparedIrPipelinePresentation` from
`src/compiler.ts`; mirror only the minimal input/execution patterns in the
unchanged early-return test. Keep `target:"linear"`, `optimize:false`, maps off.
Observe real `prepareWholeIrProgram`, `acceptPreparedIrProgram`,
`emitAcceptedIrProgram`; spies must call through, never synthesize their results.
For shared rows, poison legacy generators and overlay entry points, verify exact
program/acceptance identity and emitted owner census. Require an actual retained
live allocation in the allocation row, not merely a nonempty historical registry.
Validate nonempty Wasm and execute `result.artifacts` with existing runtime adapter
APIs. Restore all spies/environment in `finally`; do not import another test file.
Include actual structured failures in assertion output without asserting refusal
as success. No `it.fails`, skip/todo, catch-and-pass, fabricated headers, hand-built
IR, dummy allocator, or speculative resource/caller API is permitted.

Parent measures these identical test bytes on current production and later the
coherent candidate, retaining hashes, settings, exact SHAs and all raw failures.
The earlier 17/17 scalar result remains historical evidence, not a new-run result.
Publish the red acceptance file/evidence only in existing **held PR 6577**; it must
never merge alone, be queued, or be presented as standalone green acceptance.
Source-free resource replay, tamper/reservation tests and the broader matrix still
await A's published contract. Four baseline rows do not satisfy those obligations.

## Amendment: used fresh-vector initializer extraction (independent prerequisite)

Verified at the same HEAD: `addLinearIrVecRuntime` (runtime.ts:1375) emits seven
instructions; `src/codegen-linear/index.ts:235` calls it under `linearIrEnabled()`.
Existing overlay use needs no new A contract. After parent's claim, Faraday owns only runtime.ts's new
import and `addLinearIrVecRuntime` body delegation, plus new
`src/codegen-linear/runtime/vector-initialization.ts`. No other runtime function,
index, emitter, integration or shared contract is released. Parent confirms 4540
allocator, PR 6572 array new/grow and PR 6575 string-slice scopes are disjoint.

Export `buildLinearF64VectorInitializationBody(): Instr[]` from that target leaf.
It returns a new array and seven fresh instruction objects on every call:
`local.get 1; local.get 2; i32.const 8; i32.mul; i32.add; local.get 0;
f64.store align=3 offset=16`. Use canonical `LINEAR_VECTOR_ELEMENTS_OFFSET` for
16; keep f64 width 8. No allocation, forwarding, calls, mutable cache or callbacks.
Delegate the existing addRuntimeFunc body factory to it; retain the existing
symbol, duplicate-registration guard, `(f64,i32,i32)->()` ABI, zero locals and
registration order exactly. Do not move symbol ownership or harden unrelated guards.

Noether's existing new issue test file gains three isolated unit controls via
the existing `addLinearIrVecRuntime` API, never importing the new leaf on baseline:
(1) exact registered ABI/seven-instruction body and idempotent registration;
(2) two modules have equal bodies but distinct arrays/every instruction object,
with mutation of one not affecting the other or a subsequently built module;
(3) real bounded runtime allocation plus initializer execution stores 1.5/-2.25
in distinct fresh vector slots, leaving header and adjacent bytes unchanged.
Use existing runtime/module/binary APIs and actual allocator/header setup; label
these unit tests, not source Prepared evidence. Resolve actual function indices,
including a harmless function-import prefix; never guess, rebase or adopt slots.
Parent compares exact emitted unit-artifact bytes and runtime observations across
identical baseline/candidate test bytes; retain hashes/raw results, no claimed pass.
Keep all four prior acceptance/control rows, including the red shared allocation
requirement. This narrowly overrides K's block only for the used extraction;
malloc/resource reservation and A wiring remain blocked. No new IR coverage,
whole-matrix completion or permission to merge the red held PR is implied.

### Final exact ownership and folder documentation

- Verified source claim `6905:vec-initializer-body-20261007`: owner `ttraenkler/codex-linear-b-vec-initializer-sol61-20261007`, branch `codex/6905-linear-vec-initializer-source-20261007`; Faraday owns only the two code files scoped above, **not README**.
- Verified test claim `6905:prepared-memory-regression-20261007`: owner `ttraenkler/codex-linear-b-memory-tests-sol61-20261007`, branch `codex/6905-linear-prepared-memory-tests-20261007`; Noether owns only the new test file.
- Parent alone may create `src/codegen-linear/runtime/README.md`: emitted-body builders only; no registration, module mutation or AST/frontend imports; fresh instruction objects and canonical generic layout contracts. Documentation only, no behavior change.
- Allocator scope remains with [Heap coexistence in one linear memory: relocate the bump arena above the engine’s heap base, passive data segments only](4540-linear-heap-coexistence-arena-relocation.md), owner `ttraenkler/claude-opus`, branch `claude/linear-memory-quickjs-backend-gkhszu`; its heap scope excludes this initializer function.

### Final caller-attribution control: planned floor 8 (5 source / 3 unit)

Preserve all seven original rows; add exactly one ordinary source-overlay control.
Use the identical SOURCE/arguments/result 1.25 with public single-source `compile()`:
`target:"linear", optimize:false, sourceMap:false, experimentalIR:false, disableIrFirst:true`,
and `JS2WASM_LINEAR_IR=1`. Call-through spies must observe `generateLinearModule`,
`prepareLinearIrOverlay`, `compileLinearIr` and `runtime.addLinearIrVecRuntime`.
Require this compilation's real body-admission report, initializer definition in
its captured module, validated artifact and native execution 1.25; a stale global
getter alone is insufficient. Restore spies/environment. No new fixture/config
variant beyond this row; unit custody/exact-artifact proofs stay unchanged. Eight
is the planned test count, not a measured result or new Prepared allocation credit.

### V2 instrument correction: overlay module filename only

Parent's V1 baseline measured **23 pass / 2 fail / 25**: unchanged scalar control
17/17, new population 6/8. Shared array preparation rejects with
`array-representation-unsupported` **before acceptance**; this is the observed
failure boundary, not proof that the later physical-planner refusal was reached.
The other failure is instrument setup: the overlay's extensionless `moduleName`
became a TypeScript root, producing actual AST `[undefined]` and early `node.kind`
failure. Authorize V2 to change **only that overlay row's options.moduleName to
`'issue-6905.ts'`**. Keep SOURCE, arguments, eight rows, spy/ownership assertions,
exact ABI, memory expectations and all production bytes unchanged.

Retain the immutable V1 test snapshot and both raw V1 runs; candidate V1 was still
running when this amendment was requested, so no candidate result is asserted.
Run identical V2 test bytes on both frozen arms. Require all seven untouched V1
rows to match their corresponding V2 observations exactly per arm, and all eight
V2 baseline/candidate observation rows to match exactly, including `binaryBase64`.
Preserve failed-row diagnostics as evidence without converting positive tests to
refusal-success. Attribute any repaired overlay row to instrument correction,
not source wiring, new Prepared coverage, full coverage or permission to merge.

## Measured initializer checkpoint and unresolved source prerequisite

Canonical production epoch: `9e22f80ce60956ea2f397b4dfbe1cd46cdabac0a`.
Baseline tree: `609286c99f06ea7abcfed51aebd33ecaec3f454c` (production equals that epoch).
V1 candidate: `1d44c3e08359d50d8a6a15481bd24e14e9acb13a`.
V2 candidate: `0ab3a68cf0744f2b4b56616ce7b505998d62d7fc`.
Initializer implementation: `af5cdbf4bf8af89344a4434336a13fc2ec8c39f5`.

- V1 identical test SHA `dc1fc260e3a8239cb87056d3b38e32db97e0645d9c8079ec3dec08c3a8e2c002`: both arms **23 pass / 2 fail / 25**, exit 1. The unchanged scalar control passed 17/17 in each arm; all eight new observation records matched exactly.
- V2 identical test SHA `d63ce7141a98425a490405127cbbd63e382f5de857ebb8031c15da2a64ce7d31`: both arms **7 pass / 1 fail / 8**, exit 1. All eight observation records matched exactly, including unit binary bytes. All seven untouched rows matched V1→V2 separately in both arms. Zero skipped/pending.
- The repaired overlay row proves this compilation's real caller, admission, owner/slot/body identity, two initializer calls, validated artifact and native result **1.25**. It is overlay preservation, not shared Prepared allocation support.
- Shared allocation still fails at **preparation**, `array-representation-unsupported`, with prepare 1 / accept 0 / emit 0. The later physical planner is not reached. A's frontend representation/admission prerequisite therefore precedes the memory contract and shared wiring request.
- All source fixtures, ABI/store/memory assertions, legacy and hooks remain. The initializer leaf is actually used; no speculative target resource module was added.

Lossless V1/V2 logs, original V1 test and exact-row comparison are under
`plan/log/6905-linear-prepared-memory-20261007/`. Integration details and complete
claims/file ownership are in `plan/agent-context/linear-prepared-memory-session-b-20261007.md`.
PR #6577 remains **non-draft / hold / no queue submission** until A's prerequisite
and shared route make the ordinary positive allocation requirement pass.

### V3 instrument correction: preserve generator-spy tuple types

Parent measured V2 **7 pass / 1 fail / 8 on both arms**, with all eight observation
rows exact across arms and the seven untouched V1 rows exact against V2. Explicit
test-inclusive TS7 then reported **12 diagnostics**: `generatorSpies` array
inference erased index-specific GC/Linear spy return types. Preserve the V2 test
snapshot, diagnostics and both raw runs. Authorize only an **`as const` tuple
annotation on the original `generatorSpies` array**; no `any`, `WasmModule` cast,
configuration weakening, runtime changes, assertion changes or fixture changes.
Recheck explicit test-inclusive TS7 without weakening its population or settings;
if this correction is insufficient, retain diagnostics and stop for review.
Parent reruns identical V3 test bytes on both frozen arms: require all eight rows
exact V2→V3 within each arm and exact baseline→candidate, including `binaryBase64`.
Keep the positive shared-allocation failure red. This is type-instrument repair,
not source coverage, production wiring, full acceptance or permission to merge.

### Final V3 measurements

Type-only corrected test SHA `0afcb36a4cb3e783a06191bfe6356d568d96791d7aeca8249bfcdd580eac8d77`.
Candidate tested HEAD `4ad7fd4279b40273f0d01200e32ab38fc86c3ad0`.
Both frozen arms: **7 pass / 1 fail / 8**, exit 1, zero skipped/pending.
All eight complete observation rows are exact across arms, and exact V2→V3 in
each arm, including unit binary bytes and original preparation failure.
Strict test-inclusive TS7: **exit 0, zero diagnostics**, unchanged configuration;
the original V2 twelve-diagnostic log is preserved. The later publication adds
only docs/evidence. Shared preparation is still red; hold and ownership remain.

## Current-main composition in progress — 2026-10-08

Canonical main `8452732f0b88c14c5c7634ece58f83240970ea4c` merged without
conflicts into candidate execution HEAD `14aa145dd9ca39bff986dd1626e78f6e12e8da6d`.
No production edits were authored. The exact V3 test and original seventeen-case
scalar control retain the hashes above. Parent serializes both-arm execution
and strict typing; a read-only Sol6.1 Medium agent audits evidence, not source.
All historical fixtures and failures remain unchanged. No result is inferred
from this preparation; the shared allocation prerequisite remains unreleased.

B's exact canonical docs and initializer claims were freshly checked before
composition; A's current PR6583 scope has no overlap with this PR's authored
source/test paths. Claims are not shared API authority. A retains shared
admission/preparation, registry and integration/queue ownership. The latest A
coordination note describes excluding JS-host support from the future IR route;
this refresh does not alter host routing or claim unknown Linear policies are
native. Existing compatibility controls are preserved, not counted as native
migration completion. Actual shared target/policy contracts still need publication.

## Measured current-main composition — 2026-10-08

Candidate `14aa145dd9ca39bff986dd1626e78f6e12e8da6d` has source tree
`eb095b75eca043b7f9a14ee9dad3a027e1fb612a`. Baseline test-only execution
`3fee634ae67f23f57085ce6b792e584cd78e85ac` has unchanged main845 source tree
`953f74f80cf2f8085b8e1c93489fcdd357929b37`. Identical V3/scalar test bytes
and unchanged before/after receipts were verified. Both runs exit1:
**24 pass / 1 fail / 25, zero pending**; the seventeen original scalar controls
all pass. All eight complete new observations match exactly, including the
same positive shared-allocation preparation rejection. All five complete saved
unit binary witnesses validate and match; source artifact hashes/lengths and
memory hashes/header/neighbor observations match. Full memory bytes and full
source binaries are not retained witnesses and are not claimed as such.
Complete raw failure text matches exactly (1,561 characters), without exclusions
or execution-path normalization. Strict test-inclusive TS7 exits0, zero diagnostics.

Evidence, input/terminal receipts, frozen runner/configuration and an executable
count-floored comparison are under
`plan/log/6905-linear-prepared-memory-20261007/main-845/`. Historical tests and
failure evidence remain unchanged. The old test provenance `baseline:609286...`
is historical metadata; the fresh execution HEADs above govern this comparison.
The committed historical comparator passed in two-log mode with all eight rows;
the historical four-log omission mode was not used.

The unmodified boundary inventory still exits1, as required quality job112868414223
also did: missing normal non-module classification for
`src/codegen-linear/runtime/README.md`, plus module/target classification for
`src/codegen-linear/runtime/vector-initialization.ts`. A owns the registry and
must apply exact normal legacy-linear/Linear-target entries, not exemptions.
The full fresh report and diagnostics are preserved. The shared source array
admission, target-policy contract, memory materialization and source-free replay
requirements above remain undelivered. No unused memory adapter was added.
HOLD/no auto-merge remains; A controls final integration and protected queue.

## Bounded registry handoff adopted — 2026-10-08

Parent releases only this existing issue and `scripts/compiler-boundaries.json`
on isolated branch `codex/6905-linear-prepared-memory-plan-20261007`, starting
HEAD `54e235eb04a7e1dedca95f7f83ebd1563a99a250`. Fresh actual PR6577 read
confirms that exact head in `loopdive/js2`, OPEN/HOLD, MERGEABLE and
autoMergeRequest null. No source/test or other worktree edit is authorized.

Canonical claim `6905:registry-handoff-20261008`, sole owner/requester
`ttraenkler/codex-linear-b-registry-sol61-20261008`, branch as above, is
in-progress, write ID `64014-r0cwwzpb`, claimed/updated
`2026-10-08T16:21:13Z`. Fresh effect-read ledger tip is
`9ee414938dc59387da48ce7234bd720f857d17c3`; exact claim blob is
`3ab9ae2a2404e45b422e0aeb106b8a1f56ed0252`. Existing claims stay held;
this bounded metadata reservation does not transfer their source authority.

Published authority: [A handoff PR6596](https://github.com/loopdive/js2/pull/6596),
commit `555af588b3b41dda3b95a3d53468e0f4d55a32c7`; adopted Astra High plan
SHA256 `ca7b3e3ed09a89da6917231a7ccc906369e567d2e180e0b145ac05c5f299d636`
and handoff SHA256
`29879b4e2ee6d4968156ecf950206239087d75011d028d7d14eec776b9e57f57`.
Matching-path rule and parent's exact scope permit only the two present records
from [A registry proposal PR6595](https://github.com/loopdive/js2/pull/6595),
commit `52b64c8277b4e61c42f24e7821445260aa638179`: normal unmigrated/
legacy-linear `src/codegen-linear/runtime/vector-initialization.ts` and normal
nonModules `src/codegen-linear/runtime/README.md`. Actual source inspection
confirms the other six proposal paths are absent on this checkout; do not add
them or any exemption. Preserve every baseline policy entry, order and byte
outside these two insertions. Neither proposal nor handoff is native delivery.

Require the normal whole-inventory gate with actual Git base, meaningful module
and resolved-edge floors, zero errors, exact published-row equality and complete
baseline-policy/order/byte preservation after removing only these additions.
Run scoped formatting/whitespace and normal fast user-authored commit hooks.
No further Vitest, typecheck or build: the unchanged detector logic was already
qualified125/125 in the preceding6911 task, and parent now owns the heavy lock.
Retain raw evidence in this checkout's `.tmp/6905-registry-handoff-20261008/`.
Do not push before parent review. Original shared-allocation positive failure,
source-free replay and native caller dependencies remain unmet; HOLD and A's
integration/queue ownership remain unchanged.

### Actual bounded registry validation

Normal `node scripts/check-compiler-boundaries.mjs --mode inventory --base
54e235eb04a7e1dedca95f7f83ebd1563a99a250` exits0 with **1,893 modules,
all1,893 tracked;14,595 resolved edges;3 excluded nonModules;zero errors**.
Inventory is valid; architecture and graph remain incomplete. This measurement
uses starting HEAD54e with working policy additions, not the later metadata
commit or native/source qualification.

Count/policy validator passes floors1,700 modules/1,000 resolved edges, exact
one-module/one-nonModule additions, actual path presence, exact two published
proposal rows, entire baseline-policy/order equality after their removal, and
baseline byte equality outside the two insertion blocks. Baseline policy SHA256
`424591ac33717356b1edd6278b7fefc35eec597418911674fb75267093de70da`;
candidate policy SHA256
`b2697983a66a797ea99b1890ae06cd540939fc007ff79116ddd6359ceaf12ed9`.
Scoped Prettier checks for both files and whitespace checks pass. Raw
inventory/stderr, policies, validator/result and claim/PR evidence are retained
in `.tmp/6905-registry-handoff-20261008/`. No additional Vitest, typecheck or
build ran. Preceding6911 detector125/125 remains its own epoch, not a test run
on this branch. This is a local inventory repair, not full CI/Prepared readiness.

### Geometry proof readback and exact owner dependencies — 2026-10-08

A's adopted geometry plan is published at commit
`8c383ecd8305da61c27a49901d38dd8f31218d94` in existing PR6596, based onmain845.
This is a plan, not the reviewed source dependency required by B. B acknowledges
only its three retained runtime leaves after exact source publication: array
allocation consumes the shared scalar-vector factory without irVal; initializer
consumes the shared vector offset; char-code-at consumes shared string offsets.
Provider instructions, required fixtures and existing positive failures stay.

Read-only Astra High review of the actual historical chain found an additional
operand epoch: the old layout receipt pins4,670bytes/SHA256
`dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72`, while
main845 has4,763bytes/SHA256
`977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754`.
The93-byte difference is the vector resolve-forwarding operation arm. Parent
verified the current hash and actual old helper pins. This is source-derived
mismatch evidence, not a newly run test failure. Reversing geometry into main845
does not reach the old operand; the owner must supply an authenticated bridge
or identify an existing one. Do not silently remove forwarding as geometry.

Minimum existing preservation joins requiring explicit owner review/release:

- `tests/helpers/ir-lowering-analysis-relocation.ts::captureLinearLayoutPredecessor`
  pins both operands before proof; its JSON receipt and old implementation remain
  immutable. New successor authenticates complete current files/new shared owner,
  exact inverse and forward replay, including the separate forwarding bridge.
- `tests/helpers/ir-c1-current-source.ts::captureC1CurrentPopulation` pins closure
  before the old layout proof. Its historical authority/manifest and actual
  resolver inputs require exact current-successor coverage, not healthy-source
  substitutions. `ir-c1-historical-authority.ts` remains owner-controlled.
- `tests/helpers/ir-runtime-program-policy-evolution.ts::loweringAnalysisRead`
  and `authenticateLoweringAnalysisPolicy` pin sources before invoking the old
  proof; both policy predecessor entrypoints need the authenticated successor.
- `tests/issue-3518-lowering-analysis-preservation.test.ts` fixture/accepting/
  child/application joins and `tests/issue-3518-c1-current-source.test.ts` guarded
  current-reader joins need genuine current-chain coverage while retaining all
  historical mutants, receipts and negatives. An unused new helper is insufficient.

These are proposed finite partitions for the held source-proof, trusted-adapter
and policy-caller owners to confirm, not ownership declarations. The allocation
donor and A2 same-file facts partition remain with their named owners too.
Readback verified those five claims still held; B has no handoff permitting their
files to be edited. Root owns boundary registration/integration. B cannot deliver
this chain independently by creating a new successor and bypassing old readers.

Exact metadata-only claim `6905:geometry-proof-readback-20261008`, owner
`ttraenkler/codex-linear-b-geometry-readback-astra-20261008`, write20706-p2lbglok,
was effect-verified at canonical ledger4081982a43. Only this issue Markdown is
changed. No source/test/fixture, foreign claim, HOLD or queue state is changed;
no new tests run or native allocation/Unicode/retirement acceptance claimed.
