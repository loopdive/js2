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

## Finite forwarding-epoch successor proposal — 2026-10-08

Metadata-only release: `6905:forwarding-epoch-successor-plan-20261008`, owner
`ttraenkler/codex-linear-b-forwarding-epoch-astra-20261008`, write45834-oo2576pj,
parent-effect-verified ledger5e2b1234a0. Planning checkout is isolated branch
`codex/6905-linear-prepared-memory-plan-20261007` at
`cfb6b7b238f34bede1b64962fa3c38f36a1f3537`. This appendix requests owner-reviewed
implementation partitions; it transfers no claim or source authority. The
requirements below are specifications, not executed test results. Parent owns
integration/publication; all original evidence and HOLDs remain.

### Genuine source history, not a fabricated predecessor

Commit `2a98b75de993bdc568e3668a2965c026876fe322`, parent
`6c88d157444ea4ae377a7ef1b82b15ef2f4f6603`, added the forwarding-operation arm
and is an ancestor of canonical main845. Parent independently verified this
history and exact diff. For `src/ir/analysis/contracts/linear-memory-layout.ts`:

- Before:4670 bytes, blob `cac9d1e33659380a6ee8d8e03014af53e1123533`, SHA256
  `dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72`.
- After:4763 bytes, blob `280a72ab47f43584f93efb664e3e64b55dc896b5`, SHA256
  `977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754`.
- One insertion at UTF-8 byte offset2820, length93; exact payload, including
  the terminating newline after the final brace:

```text
  | {
      readonly family: "vector";
      readonly operation: "resolve-forwarding";
    }
```

Read-only byte inspection confirmed deletion of `[2820,2913)` reproduces the
complete parent blob and reinsertion reproduces the complete child blob. This
is file-operand history, not semantic certification of that entire commit.
No authenticated forwarding successor was found in the inspected historical
helpers; an owner identifying one must supply its real entrypoint and caller.

Parent independently verified full raw inverse and forward byte equality on
the genuine4670/4763-byte operands from6c88/2a98, using offset2820 and length93.
This is source-byte-only validation, not an executed regression or geometry
acceptance. At this record, canonical main remains845 and A's PR6596 remains
documentation-only at8c383; no geometry source endpoint is available to seal.

### Payload, order and separate source views

Inverse order is geometry graph → main845 planner/layout → pre-forwarding
layout → unchanged lowering-analysis proof. Geometry must reconstruct the4763
byte layout WITH forwarding; only the separately recorded forwarding epoch
removes its93 bytes. The planner is unchanged by that step. Replay the reverse
order and require complete current-byte equality for every geometry operand.

The finite successor payload binds a fixed schema, UTF-8 byte coordinates,
ordered planner/layout/new-shared-owner domain, complete before/current
length/SHA256/blob pins, the insertion above, and exact geometry inverse/forward
recipes. Include scalar-key/vector adapter rewrites, old helper/receipt pins
and the old expected52704-byte predecessor. Record the new shared owner's
absence in the earlier epoch. Do not fill geometry candidate pins until actual
reviewed source is published: PR6596 documentation is not a source endpoint.

One owner-approved capture entrypoint returns closed immutable views:
`readCurrent(path)` for captured live bytes, `readGeometryBefore(path)` for
authenticated main845 operands, and `readLoweringBefore(path)` for the old
proof's operands. Obtain the final predecessor by calling the unchanged
`captureLinearLayoutPredecessor`; do not copy its reconstruction algorithm.
Capture physical operands once and reject unknown paths or mixed epochs.
Independently approved caller pins authenticate the successor implementation
and raw receipt before use; expected hashes never come from candidate output.
No historical-file/Git fallback may repair a malformed supplied current input.

Reuse the existing C1 historical authority and lowering verifier. The split
views in `ir-program-validator-relocation.ts::captureSourceMapProgramValidatorRelocation`
are an existing composition pattern, not permission to reuse its source-map
receipt for Linear or create a second historical authority. Preserve old raw
lowering helper, fixture and receipt bytes; no resealing of their hashes.

### Join before old physical-pin rejection

- C1: authenticate the successor before `captureC1CurrentPopulation`'s closure
  pin (current line872). Its actual closure and `resolveContract` must retain
  current source, with an approved current closure/resolver contract. Only the
  historical reconstruction receives predecessor views; never feed historical
  planner text to real TypeScript resolution to satisfy an old pin.
- Policy: capture/authenticate current operands before `loweringAnalysisRead`
  pins physical files. Supply a separate closed predecessor reader to
  `loweringAnalysisLayoutProof` within `authenticateLoweringAnalysisPolicy`;
  both exported predecessor entrypoints must traverse it. Do not turn the
  physical reader into a permissive multi-epoch reader or rewrite its receipt.
- Fixture: at the acquisition seam, authenticate current source first and
  materialize exact old fixture bytes from the verified predecessor view.
  Preserve historical mutations/expectations and add current-chain coverage.
  Unchanged direct physical acquisition still rejects changed source; it must
  not be reported as passing. Preserve the original test-source snapshot too.
- Instruments: C1 pins its reader instruments. Any changed reader needs an
  owner-approved instrument successor BEFORE old `captureC1HistoricalAuthority`
  authentication, reconstructing only named old instrument operands while
  preserving the original manifest/root. Do not simply replace old instrument
  hashes. Successor authority must be independently anchored, not self-approved.

### Finite acceptance controls, not claimed executions

Retain every original proof, fixture and mutant control. Add genuine positive
forwarding-before/after epochs and, once published, geometry-after; require
exact inverse AND complete forward equality. Required rejecting controls:

- Missing, duplicated, altered or shifted forwarding insertion; unrelated-byte
  mutation; old layout presented as current; wrong predecessor endpoint.
- Mixed planner/layout epochs; absent/extra shared owner; geometry offset,
  pointer flag, scalar key, vector delegation and shared-body mutations.
- Wrong helper/receipt pins, unknown paths, malformed coordinates, truncation;
  changed reader output on reuse must not substitute a second source epoch.
- Damaged current operand with a healthy historical copy available still fails.
- Instrument/authority mutation or missing successor join fails before the old
  proof. Both policy entrypoints and fixture acquisition must exercise the join.

Positive observations must distinguish current resolver text from reconstructed
old-proof text and retain both epochs. No synthetic resolver trace, hidden
healthy-file substitution, reduced mutant population or semantic/runtime claim
follows from byte-history acceptance.

### Exact owner-review requests, not implementation release

Source-proof owner: finite successor payload/adapter and preservation-fixture
acquisition/current-chain tests. Trusted-adapter and C1 authority owners: closure
and resolver contract, pre-pin composition, instrument-history successor and
current-reader tests. Policy-caller owner: pre-pin capture and both predecessor
entrypoint joins. A geometry/forwarding owners: confirm source endpoints and
publish the geometry source before sealing its successor. These refer to the
held owners already identified above; each must acknowledge exact hunks.
B owns this appendix only. No foreign helpers, fixtures, receipts, runtime,
registry, workflow or production source are edited or newly authorized.

## Conditional native memory interface acknowledgement — 2026-10-08

Metadata-only claim `6905:native-interface-amendment-plan-20261008`, owner
`ttraenkler/codex-linear-b-native-interface-astra-20261008`, write93440-ye5ufxfv,
parent-effect-verified ledger49bb2fc5d3. This isolated branch starts at
`a40bee66df93e34870c810d16c12ebf3444c5889`; only this issue appendix is released.
All previous appendices, historical fixtures, receipts and failures remain.

Astra High read the complete711-line,47999-byte issue6920 plan, **Native Linear
numeric-vector shared source handoff and integration plan**, published in
PR6596 at `5d1d87224101fc3ed8a2cc4e54a5a4230dca0dfe` in `ttraenkler/js2`.
Verified SHA256:
`e264f64d0e600664881b656c8aae2d2f349ae5c3eeb4ada10a6bd8af816c9cfc`.
Parent independently read the complete plan and confirmed the source predicates
below on main845. This is conditional architectural acknowledgement, not tested
source acceptance, a donor handshake, implementation dispatch or a claim transfer.

### A-C/B-M agreement and required DATA refinements

The five proposed API names and single B implementation home
`src/backend/linear/program/memory.ts` fit this issue's retained responsibilities.
Do not introduce a second facade/API alongside them. A owns common acceptance,
dispatch, original body/slot identity and final publication; B owns the agreed
target pack. Name every additional contracts/helper path and its exact owner
before any edit; "cohesive helpers" is not blanket new-file authority.

1. **Actual demand versus operation catalogue.** Existing
   `linear-memory-plan.ts::operationsForLayout` always lists vector allocate,
   grow and initialize-element, including fixed vectors. Rejecting that list
   wholesale as growth demand would reject the required positive fixture.
   Preserve the canonical plan; distinguish its operation catalogue from exact
   selected-body demand and transitive provider dependencies. Reject actual
   unsupported growth before reservation; do not delete catalogue entries or
   silently admit growth merely because a provider exists.
2. **Exact module/facts join.** `planLinearMemoryFromFrozenFacts` takes
   `(module: IrModule, facts, policy)`, not a runtime projection. Its verifier
   rejects missing AND extra allocation IDs. A-F/A-C must publish the canonical
   module view and selected facts, including support bodies, with exact final
   owner/ID census or an explicitly authenticated projection rule. B must not
   filter facts opportunistically, fabricate an IrModule or rerun analysis.
3. **Detached DATA versus indexed object.** Use canonical
   `LinearMemoryPlanSnapshot` for detached/serialized DATA. Keep any indexed
   `LinearMemoryPlan` class instance, with its private maps/methods, private to
   validated target planning. No new generic capability schema is needed.
   A's existing private acceptance record retains the exact accepted plan;
   an exposed plan copy or successful validation boolean cannot authorize use.

### Five-function transaction contract

- `planPreparedLinearMemory({program, projection, options})`: validate and plan
  without ledger mutation. Return a discriminated supported immutable plan or
  located typed unsupported result; malformed DATA throws the existing invariant.
  Separate source allocations, admitted executable demand, support inventory
  and export requirements. An empty scalar requirement set stays genuinely empty.
- `reservePreparedLinearMemory(tx, plan)`: reserving phase only, after all
  imports. Reserve exactly the planned resources and bind the opaque pack to
  this transaction and accepted plan. No freeze, final-index lookup, body fill
  or export publication here; do not codec-persist the reservation authority.
- `preparedLinearMemoryBindings(tx, pack)`: after freeze and before primary
  lowering. Authenticate pack/plan/transaction and actual ledger tokens. Return
  exact carrier/signature conversion, logical layout and representation-derived
  scratch bindings, operation-to-callable bindings and support inventory.
  A composes common function/global bindings. No name-based authority, fake GC
  handle, post-edited locals or acceptance capability is returned.
- `fillPreparedLinearMemory(tx, pack)`: filling phase only. Fill each planned
  provider and heap global exactly once through existing ledger APIs, using
  canonical shared runtime bodies. No raw-module mutation/adoption or copied
  allocator, initializer or forwarding algorithm.
- `requireCompletedPreparedLinearMemory(tx, pack)`: use existing
  `assertCompletedReservation` for every owned function/global and reconcile
  the entire pack inventory. This does not seal unrelated program resources.
  A retains overall primary/startup/resource completion and sole sealing.

Two lifecycle clarifications are mandatory. `defineExport` requires the filling
phase: inventory export requirements before freeze, then designate exactly ONE
owner to publish memory/lifecycle exports after required completion, never both
A and B. A provider-construction exception may precede any ledger call and thus
not trigger the ledger's own failure latch. Explicitly invalidate that pack and
make A's acceptance/emission failure terminal; prohibit retry, fallback, later
binding/completion or publication from it. No new kernel API is presumed.

### Real caller and release conditions

Issue6920 names the necessary future joins: `planPhysicalSetup`,
`materializePhysicalProgram`, shared signature/body resolution and
`fillPreparedPrimaryUnit`. Its logical-vector representation seam correctly
covers internal lowering/scratch as well as outer signatures. These are named
future callers, not delivered source. Require reviewed A-F/A-G/runtime-donor
dependencies, agreed A-C/B-M refinements, exact lower-contracts/vector/runtime
owner releases, and coherent source call-through before implementation dispatch
or native acceptance. Preserve the real runtime-input1.25 requirement and all
original obligations. Existing test populations and receipts are unchanged;
these refinements are not executed results or additional claimed passing rows.
Parent/root retains integration and publication; all foreign claims and old
historical proofs remain intact. No source, tests, workflow, registry, commits
or pushes are authorized by this metadata-only acknowledgement.

## Bounded acknowledgement of amended native contract — 2026-10-08

Metadata-only claim `6905:native-refinement-ack-plan-20261008`, owner
`ttraenkler/codex-linear-b-native-refinement-astra-20261008`, write15398-onsgpj14,
parent-effect-verified canonical ledgerf2a607e43c. Only this appendix is released;
all preceding issue bytes remain intact. Accountable current6905 root holder is
`ttraenkler/codex-linear-b-prepared-memory-20261007`, write64168-17jzm5kj.
That accountability does not assign a new implementation worker or transfer
foreign source claims. Parent/root retains integration and publication.

Astra High independently read the complete amended issue6920 at PR6596 fork
`ttraenkler/js2`, commit `68c64ccced9122bffcb482f649d3091cc599af61`:
97935 bytes,949 lines, SHA256
`e5f5329a3aec835d40f4438642477aa2a078583b39370709f062601bf5f5eb1f`.
Parent independently read the new appendix, lines712–949, and verified the
original47999-byte prefix unchanged. This acknowledges the amended architecture,
not reviewed/tested source, native completion or an effective donor handshake.

### R1/R2 DATA, demand and the exact B boundary

Acknowledge A's `requirePreparedLinearMemoryInput` as the sole authenticated
module/facts/support join. Preparation counts complete final semantic functions
and canonical semantic support, including nested/async-state occurrences. The
selected view retains genuine function/declaration identity and exact final
allocation owner/ID/kind/result/occurrence census. Original facts and their full
registry, aliases, retired IDs and own-undefined metadata remain unchanged;
there is no B-side filtering, fabricated module or analysis rerun. A legitimate
projection-changing capability needs separate authenticated authority; malformed
facts remain invariants, not a convenient unsupported result.

Keep primary/derived IR, semantic support IR and physical Wasm provider bodies
distinct. Physical helpers do not counterfeit source units or allocation facts.
Unsupported support is counted and located before refusal. Source-free replay
uses decoded DATA and canonical reauthentication, not frontend analysis.

Acknowledge the three separate populations: unchanged canonical operation
catalogue, A's checked executable demand, and B's canonical physical dependency
closure. Catalogue grow does not admit source growth or reject fixed vectors;
allocator `memory.grow` is not vector-growth admission. Required forwarding and
empty-construction initializer bindings remain real demands. Unknown/missing
cases fail before reservation; emission lookups require the accepted relation.

Exactly two proposed B paths are acknowledged under the current root holder:
`src/backend/linear/program/contracts.ts` for descriptive target DATA and
`src/backend/linear/program/memory.ts` for the five functions and private pack
implementation. Use canonical `LinearMemoryPlanSnapshot`; indexed plans stay
private. No additional helper path, sixth API, facade or implementation dispatch
is authorized. A's canonical facts/planner/demand dependencies remain A-owned
and require their named source holders and published endpoints.

### Five functions and whole-attempt lifetime

Retain `planPreparedLinearMemory`, `fillPreparedLinearMemory`,
`requireCompletedPreparedLinearMemory` and `preparedLinearMemoryBindings`.
Explicitly acknowledge the revised reserve signature:
`reservePreparedLinearMemory(tx, plan, assertEmissionActive)`.

A creates the private guard inside its existing consumer attempt; it checks the
exact acceptance/plan/projection identity and active state. B never supplies or
serializes that authority. Reserve checks it before resources, remains in the
reserving phase and performs no fill/export/freeze/index lookup. After A's one
freeze, bindings validate tokens and recheck the guard and pack state on every
returned operation/layout/carrier callable use. Descriptive signature planning
before freeze must not depend on those later token bindings.

B is the sole publisher of its inventoried memory and any explicitly admitted
lifecycle exports, inside fill during filling after B prerequisites complete.
A checks combined export-name/owner collisions before reservation and publishes
only its own source/startup intents. Optional lifecycle remains unadmitted by
default. Completion rechecks ledger completions and full inventory/publication
equality; it is read-only/idempotent while the attempt is live and never seals.
Successful B fill/verification does not revoke bindings needed by later primary
lowering; whole-attempt completion does.

B-local failures latch its private pack/plan-use state before rethrowing. A's
whole-attempt failure, including provider construction before a ledger call,
later primary/startup/reconciliation/sealing or observer failure, revokes all
captured bindings. Completion also revokes them. Preserve one-shot consumption
before materialization/emission-started observation, terminal catch/finally,
original errors and no retry/fallback/result from a failed private module.
No public kernel abort API or parallel generic lifecycle framework is requested.

### Canonical provider endpoints: reuse, not duplicate extraction

PR6572 at `76b8a02dca23c8e974661b55fdeaeae38b898d9d` in `ttraenkler/js2`
publishes `src/codegen-linear/runtime/array-allocation.ts` exports
`checkedArrayAllocationSize` and `checkedArrayCapacityDoubling`. These are checked
arithmetic fragments, NOT a complete `__arr_new` body/resource factory. Parent
verified the fragments and real runtime callers. Preserve that distinction:
reuse the arithmetic, while complete constructor/allocator resource reuse still
requires exact donor source and callers. Do not copy or invent a full provider.

The retained initializer is
`runtime/vector-initialization.ts::buildLinearF64VectorInitializationBody`, with
the real `runtime.ts::addLinearIrVecRuntime` caller on this PR's published source.
Preserve value-first ABI/fresh instructions; geometry rewire awaits A's source.

Correct R5's proposed duplicate `runtime/array-forwarding.ts` to the existing
`src/codegen-linear/runtime/arrays/forwarding-resolver.ts::buildArrayForwardingResolverBody`.
Published PR6590 head `75c98267d4aabba2f78238f292e0e7c2eb6554f3`, introducing
commit `cea128a3b1c25eb15f62bf3cabb5dc97b9643ccb`, already has the full builder
and `runtime.ts::ensureArrayResolveRuntime` calling it with
`LINEAR_ARRAY_FORWARDING`. Parent verified the full builder/import/caller.
Source holder `ttraenkler/codex-linear-b-forwarding-sol61-20261007`,
write65589-oamjn90s, remains held; this acknowledgement transfers nothing.
Use that canonical endpoint under its holder's agreement, not a second file.

No concrete defect remains in the requested amended five-function contract;
the forwarding path correction above is required before dispatch. Actual shared
source, donor acknowledgements, coherent real callers and planned qualification
are still owed. Old proofs, legacy behavior, original failures, tests and receipts
remain unchanged. No executed result, source acceptance, new native coverage,
HOLD release, source/test/claim edit, commit or push follows from this appendix.

## Adopted implementation-entry and composed-acceptance gates — 2026-10-09

Metadata-only claim `6905:implementation-entry-staging-plan-20261009`, owner
`ttraenkler/codex-linear-b-staging-astra-20261009`, write35708-daoey8xz,
parent-effect-verified ledger41be8b2538. This appendix starts from
`27e7b3ea47962ebc1899fc47571da47f4230716a` and preserves all prior issue bytes.
It mirrors root's adopted issue6920 staging clarification at PR6596 commit
`f0e0af9c6364220e10ad61fefe4d51e276b54027`:109170 bytes, SHA256
`4e496964c254c7a3f3d4ac6bf9dfaef99d5a7b0ceaffef056098671c002d991c`.
Astra High and parent read the complete addition; the original97935-byte prefix
matches its prior hash. This is a planning clarification, not source acceptance.

### Gate 1: release B-M implementation entry

Root must record exact reviewed source endpoints, applicable bounded proof,
file/function custody and an explicit bounded release for all prerequisites:

- A-F: strict complete module/facts/support join, exact owner/ID census and clean
  facts-only planner; no filtered registry or still-reanalyzing substitute.
- A-G: usable canonical geometry, donor/A2 partition and named historical
  proof/reader releases with their endpoint/proof obligations preserved.
- A-C inputs: checked executable demand distinct from the catalogue, concrete
  representation/carrier/scratch/type endpoints and agreed five-function API,
  including `reservePreparedLinearMemory(tx, plan, assertEmissionActive)`.
- Runtime donors: canonical reservation-compatible allocator and COMPLETE array
  constructor/provider dependencies, with retained initializer and forwarding
  builder; checked arithmetic fragments alone are insufficient.
- S/ownership: reviewed startup/ReferenceError/shared-resource contract and
  exact A-C/B-M holders plus all required vector/lower-contracts/runtime releases.
- Concrete A-C caller packet: reviewed patch/design for actual planning,
  materialization, signature/body resolution, primary fill, scratch and lifetime
  joins, agreeing arguments, phases, resource ownership and failure behavior.

B-M's finished source and the final public1.25 result are NOT Gate 1 prerequisites.
After explicit release, A-C and B-M develop in coordinated isolated worktrees;
B owns only the agreed `src/backend/linear/program/{contracts,memory}.ts` scope.
Pending caller patches and B code are integration candidates, not independently
delivered support. Compose before landing: no dead facade, dummy provider,
permissive stub, legacy fallback or uncalled module may satisfy this gate.

### Gate 2: accept the composed native-vector source handoff

The packet includes B-M with A-C, A1/S, A-F/A-G, runtime donors, registry and
required historical successors at one frozen reviewed source head. Require the
unchanged public standalone/WASI sync/async compile fixture returning1.25,
actual source/allocation/provider/ledger and memory observations, source-free
replay, lifetime/export controls, all original F/G/V/R and retained B cohorts,
failures, denominators, proofs and normal independent/protected-delivery gates.

Explicitly supersede the staging meaning of this issue's historical lines769–772:
their coherent source call-through requirement belongs to Gate 2, NOT a demand
that B-M already exist before Gate 1. No original evidence obligation is removed.
Canonical `runtime/arrays/forwarding-resolver.ts` reuse still supersedes the
duplicate `runtime/array-forwarding.ts` proposal; array fragments remain arithmetic,
not a complete constructor. Both gates are UNMET. No dispatch, additional path,
helper ownership, claim transfer, HOLD release, source/test change, retirement,
commit or push is authorized. Parent/root retains integration and publication.

## Semantic evidence prerequisite for implementation entry — 2026-10-09

Metadata-only claim `6905:semantic-witness-entry-plan-20261009`, owner
`ttraenkler/codex-linear-b-semantic-astra-20261009`, write48308-1tjk3a8g,
parent-effect-verified canonical ledger00465b714f. This append-only clarification
starts at `104eff7c191d5947297f4b8e6b993f09bc9eb1ff`. Astra High reviewed A's
source-derived finding in coordination comment6070453212; parent independently
read the canonical verifier, collector and program-allocation validation source.
This is not an executed forgery result or source acceptance.

Gate 1's A-F prerequisite additionally requires a reviewed canonical semantic
verification or authenticated-witness endpoint establishing encoding, ownership
and escape evidence against the actual final semantic/support bodies. Agreement
between saved registry metadata and fact projections is insufficient: coordinated
false annotations can agree. `verifyLinearPreparedAllocationFacts` compares those
projections; its allocation collector excludes instructions lacking `alloc`.
Neither exact census nor descriptor safety establishes semantic evidence truth.

Retain `verifyAllocProvenance`/`assertFinalAllocProvenance` as the single required-ID,
known/live and allocation-kind authority. Preserve the semantic evidence obligation
currently enforced by `assertPreparedIrProgramAllocations`, plus its async-state
provenance and resolved result-type checks. Removing or renaming its analyses is
not verification. Until a qualified replacement exists, retain existing semantic
validation and keep zero-analysis dispatch held separately.

A's `requirePreparedLinearMemoryInput` must require that validation before returning
the canonical module/facts pair, including decoded replay. B consumes that reviewed
contract; it does not implement a competing semantic verifier or treat snapshot
equality, an accepted plan, or the lifetime guard as evidence authority. All five
agreed API signatures and existing owner partitions remain unchanged.

Preserve existing nested missing/foreign/wrong-kind/retired-ID controls,
revalidation-after-success, missing/stale encoding and result-type mutations in
`issue-3518-verifier-body-relocation.test.ts`, and stale encoding rejection in
`issue-3518-inline-call-allocation.test.ts`. Retain support/currentness negatives,
async-state checks, absent versus present-undefined evidence, A2's original18 and
its unchanged failing manual encoding-undefined fixture, and all prior census,
forged-evidence and zero-getter controls. The planned forgery control must include
coordinated alteration of snapshot metadata AND fact projections, not just their
disagreement. This is a required future control, not a claimed test execution.

Both entry and composed-acceptance gates remain UNMET. No fixture, failure,
denominator, source, test, foreign claim, HOLD or queue policy is changed or
released by this metadata clarification; legacy retirement remains blocked.

### Astra neutral-geometry import specification — 2026-10-09

Planning-only claim `6905:neutral-geometry-import-plan-20261009`, owner
`ttraenkler/codex-linear-b-geometry-import-astra-20261009`. Astra High reviewed
this specification; it does not release source implementation or historical
proof edits. Starting B publication is `6d41eb99a08bcb8505febcb9b7ff4f43b9b2544b`.

C published composed PR6600 head `e8f56680589752d67c83ce80cbb43b1bebf1f056`,
with exact parents A's boundary dependency
`b932e3a05e353acc59e7b547ef4e417a5d8637e1` and canonical main
`616da017ca11cefa61f3f8d71a1c7ac18773491c`. Parent independently verified both
ancestries and unchanged four geometry source/test blobs and boundary-policy
blob against b932e. The neutral endpoint
`src/shared/contracts/linear-memory-layout.ts::LINEAR_VECTOR_ELEMENTS_OFFSET`
defines16; the IR planner re-exports that same binding. Endpoint SHA256 is
`08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937`.
Publication is not protected-queue delivery or A's dependency acceptance.

The actual extra import-cycle edge is the initializer leaf's value import into
the IR planner; an existing runtime-to-planner edge does not absorb a distinct
file-to-file edge. After A reviews/releases this exact hunk and the dependency
is composed with its boundary registration, Sol6.1 at appropriate effort should
change ONLY `src/codegen-linear/runtime/vector-initialization.ts`'s import from
`../../ir/analysis/linear-memory-plan.js` to
`../../shared/contracts/linear-memory-layout.js`. Reconfirm canonical ownership
before editing. No shared source, compiler, allocator, policy or proof changes
belong to this slice; do not duplicate the numeric offset or alter the builder
interface to evade the cycle.

Preserve all seven instructions, fresh objects, stride8, f64.store align3/offset16,
the existing caller, `(f64,i32,i32)->()` ABI, zero locals and registration behavior.
Qualify baseline/candidate with identical composed dependencies and unchanged
tests. Retain all eight complete observation witnesses, all25 test statuses,
complete original failure text and all five full binary witnesses; preserve
historical comparator and archives unchanged. Keep provenance identities distinct
and attribute any composed-source differences rather than normalize them away.
Recheck typing, boundary and import-cycle gates without exceptions or ratchet
weakening. No composed candidate execution or gate result is asserted here.
The ordinary positive array failure and public native1.25 acceptance remain;
this import change alone does not implement native memory or full IR equivalence.
A retains explicit source release, shared integration and protected queue.

### Released geometry import: Astra execution plan — 2026-10-09

A accepted the preceding neutral-geometry plan in coordination comment
`6077074683`, releasing exactly one initializer import hunk after normal
composition of delivered PR6600. Verified geometry delivery is protected merge
`2d0c31a3e2dbe0a4a46d123226fa1d62f7d4c7aa`; endpoint
`src/shared/contracts/linear-memory-layout.ts` is SHA256
`08c85d9e8c9891a74b9c0c02a1310b67b16832980849dc0e7b6d511d91350937`.
This is an offset16 contract, with the IR planner re-exporting the same binding.

Documentation-only claim: `6905:geometry-import-integration-plan-20261009`,
owner `ttraenkler/codex-linear-b-geometry-import-plan-astra-20261009`.
The source claim remains `6905:vec-initializer-body-20261007`, recorded owner
`ttraenkler/codex-linear-b-vec-initializer-sol61-20261007`, write4467-r35vmfcy.
Its ownership was freshly effect-read. The issue identifies the original writer
as Faraday, but currently reachable agents cannot authenticate that historical
writer identity. No source ownership is inferred from a reused display name.
Obtain an explicit original-writer handoff or a documented owner-coordinated
recovery before assigning a replacement. No source edit has been made.

Astra's bounded implementation and qualification plan:

1. Confirm sole writer and exact source claim. Parent normally composes freshly
   verified canonical main containing delivered geometry **before** editing the
   import. Freeze composed baseline HEAD/source tree, configuration, toolchain,
   test hashes and geometry endpoint. Keep original evidence untouched.
2. Candidate differs by exactly one source hunk in
   `src/codegen-linear/runtime/vector-initialization.ts`: replace the import
   from `../../ir/analysis/linear-memory-plan.js` with
   `../../shared/contracts/linear-memory-layout.js`. No copied constant,
   instruction, caller, ABI, helper registration, source proof or shared edit.
   Preserve seven fresh instructions, stride8, store alignment3/offset16,
   `(f64,i32,i32)->()` ABI and zero locals.
3. Reuse unchanged `tests/issue-6905-linear-prepared-memory-materialization.test.ts`
   (SHA256 `0afcb36a4cb3e783a06191bfe6356d568d96791d7aeca8249bfcdd580eac8d77`)
   and `tests/issue-3525-prepared-linear-early-return.test.ts`
   (SHA256 `8c3787b33a1d38dd42a261a1d8f40fdea10053a37816bef38c064f761387fd3d`).
   Independently verify both hashes after composition.
4. Reuse the retained parent pattern in
   `plan/log/6905-linear-prepared-memory-20261007/main-845/run.mjs.gz` and
   explicit test-inclusive `tsconfig-test.json.gz` through separately reviewed
   copies in a new evidence location. Use `compare-rows.mjs` in **two-log mode**,
   never the historical four-log omission mode. Use the complete population
   comparator pattern in `main-845/compare-population.mjs`; it resolves archive
   paths relative to its own location, so do not overwrite historical carriers.
5. Require equal identically composed dependencies and test bytes, all25 named
   statuses, all8 complete observations, all5 full binary witnesses, complete
   unnormalized failure text and unchanged before/after custody. Preserve fresh
   instruction-object isolation, actual initializer execution and overlay
   caller/body joins. Historical24pass/1fail and the1561-character failure are
   retained measurements, not predictions of new results. Attribute any
   composition-induced difference before accepting the one-hunk comparison.
6. Recheck normal typing, explicit test-inclusive typing, compiler boundary
   inventory and import cycles against the actual base, without new allowances
   or policy weakening. Preserve the ordinary shared-allocation positive
   failure and unmet public native1.25 requirement. No refusal becomes success;
   source rows keep their existing hashes/lengths rather than invented full
   source binary/memory observations.

This is an Astra specification, not a new execution or source qualification.
Original writer handoff, composed identities and measured results remain
pending. Publish through existing PR6577 with HOLD intact; A owns shared
integration and protected queue. The separate append source approval does not
automatically admit this newer geometry source epoch.

### Composed baseline diagnostic plan — 2026-10-09

Parent normally composed verified canonical main
`cffb28679df96764e295fd2064e0a4ceec643efe` before the released import edit.
This canonical advance adds benchmark/docs metadata over b47; canonical source
remains1716065. The clean composed baseline HEAD is
`cdde1880d00af27156751557739d5e2a4e5dcf35`, source tree
`712bfef554321f3fe081f72bb89654d7dc6d8104`. Existing initializer SHA829df3,
both retained test hashes0afcb/8c378 and delivered endpoint08c85d are unchanged.
No initializer edit or claim transfer occurred. This merge is not qualification.

Astra separately clears an unchanged **baseline-only diagnostic** while the
writer handoff remains pending. Its new scratch instrument must preserve the
historical main-845 runner/archive and independently bind the exact HEAD/tree.
Capture the complete committed source population, modes and physical hashes;
reject missing/symlink/dirty/untracked source. Bind both unchanged tests and the
complete package/lock/workspace/TS/Vite/Vitest/concurrency configuration census,
instrument bytes, actual cwd/command, Node/V8/pnpm and effective environment.
Require retained absent NODE_OPTIONS/JS2WASM_LINEAR_IR without silently
overriding incoming settings. Recheck after execution against the original
freeze, never a freshly selected epoch.

Use the unchanged two-file Vitest command and fork settings, default+JSON
reporters, serialized execution and fresh output paths. Always retain raw
streams, reporter, input manifests, terminal receipt and after-custody failures.
Preserve actual status1 as1; spawn/signal/timeout/custody failure must never be
classified as an ordinary completed red result or hidden by successful archival.
Do not predeclare24pass/1fail, force the historical1561-character error, rewrite
tests, retry failures or manufacture missing observations.

Validate exactly25 named assertions, eight ordered observation IDs with their
original provenance/population and five complete binary witnesses with matching
lengths/hashes. Preserve complete unnormalized statuses/errors and all raw
source rows. Changed diagnostics or missing witnesses block preservation
acceptance; baseline alone cannot establish candidate equivalence or native1.25.

Before a compiler child, exercise the real custody/receipt predicates with
inert fixtures: valid snapshot; wrong HEAD/tree; source mutation/missing/extra
or symlink; each test mutation; missing/changed config; toolchain/environment
mismatch; after drift; ordinary exit1 distinguished from spawn/signal/timeout;
missing/duplicate observations/assertions; corrupt binary; secondary cleanup
failure retained alongside the primary failure. Report only executed counts.
Sol6.1 Medium may author only the new scratch instrument/evidence in its own
isolated worktree after its exact baseline-diagnostic claim is effect-read.
Parent/Astra review precedes the serialized diagnostic; the source-writer claim
and one-import handoff remain untouched. No implementation-entry/native release,
append-source approval, HOLD removal, proof repin or queue authority follows.

### Baseline instrument review blockers — 2026-10-09

The first scratch candidate SHA256
`3205ccfad436e7ff012e2548c04d5049e97196576d9d216dafd0dc162551b30b`
and freeze SHA256
`c6fbf361b582d438af4ee6d6664724287615183869eb4fe30781ff61306a2a1a`
passed35 inert controls but received no execution clearance. Parent and Astra
review identified four demonstrated blockers; preserve these original bytes.

1. Remove automatic process-group SIGKILL. No test-termination authority was
   supplied. Latch timeout/output failure, notify parent, continue draining and
   await natural termination; do not finalize a live child or silently retry.
   A capped/truncated capture remains explicitly unqualified.
2. Do not archive the entire inherited environment. Freeze an explicit reviewed
   nonsecret influencing projection, reject unsupported influencing settings
   without printing values, preserve child inheritance, and exercise sentinel
   credential exclusion. Prefix filtering alone is not a safe secret boundary.
3. Preserve both raw output streams: actual Vitest failure details may appear
   on stderr while summary appears on stdout. Validate split-stream failure
   evidence without manufacturing an interleaving or normalizing original text.
4. Inspect both streams for issue6905 records and reject extra, duplicate,
   malformed or truncated records. Historical combined-log replay alone does
   not exercise the actual transport; add finite split-stream controls through
   the same production predicates while retaining all35 earlier controls.

The original baseline checkout remains
`cdde1880d00af27156751557739d5e2a4e5dcf35`, source
`712bfef554321f3fe081f72bb89654d7dc6d8104`. Its independently read committed
source population is1903 paths, not canonical main's1901: B's existing leaves
are part of this composition. Complete frozen custody reports7903 files;
these counts are census evidence, not successful compiler observations.
The same Sol6.1 Medium diagnostic owner repairs only its isolated scratch
instrument, retains the rejected versions, reruns inert controls, and returns
new exact hashes for fresh parent/Astra review before any child. No baseline
compiler run has occurred. Initializer source claim and HOLD remain unchanged.

### One composed baseline diagnostic — actual result

The repaired instrument SHA256
`dcf692c9bbd634c6b9d7133996d7971f07f58f5efa219534d590819ff3059c18`
cleared parent/Astra review; parent repeated57/57 inert controls and independently
captured all7903 files/1903 sources, equal to freeze SHA256
`5847955d2ad1df8cf8cce6e8cc284cb8ef438b8eda161b3243a3f60b1ab02ddc`.
Parent then authorized and ran exactly one baseline-only diagnostic on
`cdde1880d00af27156751557739d5e2a4e5dcf35`, source
`712bfef554321f3fe081f72bb89654d7dc6d8104`. Actual parent and child exit1,
24/25 assertions passed,1 failed;8 complete ordered observations/5 binaries.
Custody is unchanged before/after; no signal/timeout/spawn error/truncation or
secondary errors.30846 raw bytes retained; no automatic termination/retry.

The positive shared allocation test still fails before emission with
`array-representation-unsupported`, resolver cannot register vector for array
literal. Whole8 rows equal historical rows, but complete status/failure text
does not equal the historical combined capture; those actual differences are
retained without normalization. Preservation/native acceptance remains false.
Full instruments, rejected originals, freeze, parent approval/terminal and raw
split streams/reporter/binaries/receipts are published under
`plan/log/6905-linear-prepared-memory-20261007/geometry-baseline-20261009/`.
This baseline result does not transfer the initializer writer claim or authorize
the held one-import candidate, source wiring, native completion or queue action.

### Authenticated original initializer writer continuity — 2026-10-09

Parent read the original native delegation history in this same chat, turn
`01a116b9-e68a-7dd0-b418-0c260cf746f8`, started1791382644. Its initializer
assignment names receiver `01a115a5-f3e1-7471-baa4-dfad394049b6`, exactly the
current agent ID, not merely a reused display name. The later native message
to that same receiver records parent acceptance of initializer extraction
commit `af5cdbf4bf8af89344a4434336a13fc2ec8c39f5`, no further edits and idle
state pending shared contracts. This corrects the earlier unavailable-writer
inference; it does not authenticate any other source owner or transfer a claim.

The original agent now explicitly acknowledges ownership and availability for
A6077074683's one-import replacement only. Fresh canonical ledger
`02b092897602b8188ced3e9943f9f47931e5f154` retains original owner
`ttraenkler/codex-linear-b-vec-initializer-sol61-20261007`, write4467-r35vmfcy.
Original source worktree remains dirty on609286c99; both source files match
the accepted AF5 bytes exactly and must not be reset, cleaned or overwritten.

Continue only with that authenticated sole writer in a separate candidate
worktree after adopting the complete paired-comparison plan. All shared A
files and allocator4540 stay excluded. Preserve the actual completed-red
baseline, all fixtures/failures and HOLD. No initializer edit has occurred yet.

### Astra candidate implementation and exact paired qualification plan

1. Effect-verify a fresh candidate slice for the authenticated original owner.
   Create its separate worktree from published2bc9d33a08 after verifying complete
   source remains712bfef554321f3fe081f72bb89654d7dc6d8104. Sole source edit:
   initializer import from `../../ir/analysis/linear-memory-plan.js` to
   `../../shared/contracts/linear-memory-layout.js`. Privately commit/review it.
   Preserve seven fresh instructions, caller/registration, value-first ABI,
   stride8, alignment3 and offset16. Verify endpoint08c85d and same-binding
   re-export. No other source, test, fixture, configuration or proof changes.
2. After review parent normally merges that candidate into the SAME execution
   path `/private/tmp/js2-6905-geometry-baseline-20261009`. Preserve every
   baseline-once artifact, instrument, freeze and receipt. No reset, overwrite
   or baseline rerun. Independently verify the whole source delta is only the
   approved import, complete input populations/modes match, only initializer
   bytes change among selected inputs, both tests/runtime/endpoint/configs and
   toolchain match, and tracked inputs are clean. A private candidate-worktree
   run cannot substitute for this exact-path pair.
3. New scratch candidate instrument copies reviewed v2 without changing it.
   Enumerated adaptation only: committed HEAD/tree literals, instrument/freeze
   locations, fresh candidate-once directory, explicit one-candidate approval
   label and the necessarily changed reporter output destination. ROOT, test
   argv/fork settings, environment policy, custody predicates and no-kill
   handling remain unchanged. Record reporter output-path difference explicitly;
   do not call the whole command byte-identical. Freeze the full actual input
   population against retained baseline entries, permitting only independently
   verified initializer blob/hash change. No observed-difference auto-approval.
   Parent separately authorizes one candidate after exact review/refreeze.
4. Independent comparator pins the ACTUAL new baseline and candidate packet
   identities/hashes; older merged-stream data is historical only. Validate
   each arm's actual HEAD/tree, instrument/freeze/approval joins, complete
   unchanged before/after custody, terminal status, absence of infrastructure
   faults/truncation and separately retained parent status. Require25 uniquely
   named assertions,8 ordered complete rows and5 valid complete binary witnesses;
   join both raw-stream records to observations and retain full reporter/errors.
5. Exact paired equality requires all8 complete ordered rows, all5 decoded
   binary byte sequences/lengths/hashes, all25 full name/status/failureMessages
   records and both unnormalized split stdout/stderr failure segments. Do not
   filter cwd, stack, line numbers, source sites or text, or relax order.
   Candidate HEAD/helper hash are separately joined to its approved snapshot;
   all other provenance/common inputs match and baseline labels stay historical.
   Actual tree change is independently tied to the one-hunk delta. Any mismatch
   stops acceptance, retaining complete values and differing path. No retry,
   normalization, comparator weakening or replacement baseline.
6. Retain all57 v2 controls. Add actual-predicate comparator controls: exact
   duplicate packet positive; authorized identity/helper changes accepted only
   via provenance joins; wrong HEAD/tree/helper or extra changed input rejected;
   missing/duplicate assertion/row/binary rejected; nested row/binary mutation
   rejected; changed status/failure/stack/stdout or stderr failure segment
   rejected; raw-record/archive mismatch rejected; custody drift/timeout/
   truncation/infrastructure fault rejected despite matching witnesses; original
   baseline digest mutation rejected. These are planned, not measured controls.

Measured baseline remains24/25 red,8 rows,5 binaries. Its old historical error
differences stay separate. Candidate preservation cannot establish native1.25,
full IR equivalence, retirement, HOLD removal or queue authority. No candidate
compiler run is authorized by this plan adoption alone.

### Private one-import implementation and independent input audit

Authenticated original Sol6.1 Medium writer committed
`0799a907eb8e6aaee3163420fed09fe0bfc61c3c`, source
`fd543122e5c4f432ad332f2c617f13f4351b902f`. Sole changed source is the released
initializer import; reversing its exact string restores every predecessor
byte. Initializer is673 bytes, SHA256
`8110f838a039fa4e24729c1f64182ac42dc648cbff27ab6067afb832e78780a0`, Git blob
`31e34309e5d663f2e7c71621fac7460dbbed33fb`.
Fresh same-writer continuation write79124-a0jkr95l is effect-read; original
claim/dirty worktree remain unchanged. Parent reviewed and normally integrated
the commit at the SAME baseline execution path, preserving every baseline file.

Parent independently audited all7903 retained records/1903 source files against
actual current committed blobs and physical regular bytes/modes. Exactly one
input differs: initializer old SHA829df3 to8110f8, with exact import-only reverse
restoration. Zero mode changes or other retained input mutations were found.
No candidate compiler child has run. A fresh disjoint instrument slice
`6905:neutral-geometry-pair-instrument-20261009`, owner
`ttraenkler/codex-linear-b-geometry-pair-sol61-20261009`, is effect-read for
scratch-only capture/comparator implementation by the same Sol6.1 Medium agent.
Parent/Astra review and independent freeze precede any one candidate execution.
The measured baseline remains red; no native/retirement/queue acceptance follows.

### Parent candidate-instrument checks (2026-10-09)

Parent inspected the complete comparator and verified the capture delta has
exactly five bookkeeping substitutions from reviewed baseline v2: HEAD, source
tree, freeze filename, approval label and fresh output directory. No compiler,
test, fork, environment, custody or no-kill predicate changes were found.
Candidate capture SHA256 is
`f676847ff5593d5c321d87c9473ada3ab9cad45432eaf5a7b449a30f763e3409`;
comparator SHA256 is
`c28ef87a82502de4763a7d0b9867e677244e86ecdee3c3cf6fa5a9929853b793`.

Parent separately executed the inert production-predicate controls: capture
57/57 and comparator28/28, exit0, no compiler child. These establish instrument
rejection behavior, not candidate execution or native support. The comparator
also validated the actual pinned baseline packet against its published tar.

Parent invoked the current candidate's read-only inspection at the SAME
execution root. All7903 selected inputs (1903 source files), full population,
physical blob/mode custody, environment and toolchain deep-equal its frozen
snapshot, HEAD0799a907/sourcefd543122. Nodev22.23.2 and pnpm10.30.2 agree.
Candidate freeze SHA256 is
`9da12b5abac4ac9c0caf2c26a322dd5113f02b46c0d2996dd1315890d39cd44e`.
Astra High exact review cleared the enumerated adaptation and full comparison
joins. Separate Sol6.1 physical audit independently read7903 unique selected
files/1903 sources, totaling131451520 bytes, with exact Git/physical mode, blob,
length and SHA256 agreement. Only the released initializer differs; the other
7902 records match the baseline. Actual toolchain and finite environment also
match, and the original baseline bundle/instruments remain unchanged.

Candidate execution is deferred for serialization: actual live Vitest parent
89604 and worker99644 have cwd
`/Users/thomas/.codex/worktrees/6878-latest-composition/js2`. These are not this
candidate's processes and are not interrupted or restarted. Recheck actual
process state before separately approving and starting the one candidate.
No candidate compiler run, runtime preservation acceptance, HOLD removal or
queue release is implied by these checks.

The complete reviewed instrument, candidate freeze, immutable pins and author's
85 control records are sealed in
`plan/log/6905-linear-prepared-memory-20261007/geometry-pair-instrument-20261009/reviewed-instrument.tar.gz`:
666847 bytes, SHA256
`54bbedfb3ca5ad182f70592c3dd004a49bc4bafd2bdde2972ce1589d891ded59`.
Parent verified exactly six archive members and every byte against current
reviewed files, without executing the archive. The companion README specifies
the remaining one-run approval and independent packet-digest steps; this packet
does not invent candidate runtime evidence.

### Generic-vector dependency reconciliation (2026-10-09)

Astra High read A's complete proposal in coordination comment6078742098:
38932 bytes, SHA256
`8090c37a1cdb532d15cc66bd464c8a59e9b6562f09e1f88df728dce0283f587c`.
It refines the existing A-C dependency without changing B's five proposed APIs,
phase/lifetime rules or ownership. Gate1 remains unmet; this is no source release.

The concrete caller packet must demonstrate BOTH signature-stage joins:
`program-physical-plan.ts::physicalSignatureConverter` and
`program-consumer.ts::physicalSignatureConverter`. Updating only the emitter or
body resolver cannot satisfy the actual planning-side vector admission.
Construction must retain canonical final allocation-provenance validation and
exact owner/site/layout association, while allocation-free type/read lookup
remains valid. An undefined construction ID must not select a first allocation
or be confused with a descriptive read handle. Existing semantic-entry rules
already require this; no competing B verifier or new blanket rejection is added.

Parent inspected the actual handle and both converter sites. The proposed
`src/backend/linear/program/{contracts,memory}.ts` do not exist at this checkpoint;
the five-function API is a specification, not delivered source. Published complete
semantic/facts/demand entry, generic representation and caller implementation,
full runtime donor/startup closure, attempt-wide revocation wiring and explicit
file/function releases remain prerequisites. No tests or native acceptance are
claimed by this reconciliation.

### Actual exact-path initializer candidate comparison — 2026-10-09

After the foreign suite naturally completed, parent independently re-inspected
the SAME execution root. All7903 selected input records again deep-equal frozen
candidate9da12b5a, at HEAD0799a907/sourcefd543122, with unchanged toolchain and
finite environment. An actual process census found no competing local test run.
Parent authored the exact one-candidate approval binding committed identity,
capturef676847f and freeze9da12b5a, then ran exactly ONE diagnostic. Actual parent
tool88053 terminated exit1; child naturally closed code1/signalnull, no timeout,
spawn/capture/infrastructure errors or truncation. No retry or termination.

Candidate retains25 assertions:24pass and the original positive shared allocation
failure (`array-representation-unsupported`, resolver cannot register vec for
array literal). All8 ordered rows and5 complete binary witnesses are retained.
All30709 observed bytes captured, zero discarded; all7903 before/after records
are byte-identical. Parent separately recorded the observed terminal and froze
the exact12-member candidate packet, SHA256
`86bbe9c0d8a5245aba08ea21dc88a32dc646cfb012df0e5922d0f41c45077837`.

The previously reviewed comparatorc28ef87a actually exited0 against this packet
and the immutable actual baselinecdde1880/source712bfef5. It requires exact
equality of all25 ordered full name/status/failureMessages records, all8 complete
ordered rows, all5 decoded binary byte sequences/lengths/hashes, unnormalized
split failure text and entire stderr. Those checks passed. Authenticated HEAD
and initializer-hash provenance joins differ as specified; no observation or
failure fields were removed. Reporter output paths necessarily differ and are
reported explicitly. Historical main845 failures remain a separate archive,
not a substitute baseline or an equality claim.

Complete candidate evidence is sealed at
`plan/log/6905-linear-prepared-memory-20261007/geometry-pair-trial-20261009/raw-candidate.tar.gz`:
2629409 compressed bytes, SHA256
`5ca9cc77db8a5e5a88b4deff96b30d2f1a381eb91bc02edc14b1e6519ea50bbf`.
Parent read every archive member: one directory and21 regular files,
8400679 uncompressed bytes, all exactly matching retained originals; no duplicate,
unsafe or nonregular file entries. The reviewed instruments, immutable pins,
complete freeze/run packet and parent approval/terminal/comparison are retained.

This is bounded preservation of the released initializer import, NOT native
shared allocation support, performance evidence, full IR equality, main delivery,
HOLD release or legacy retirement. Session A retains shared integration and
protected-queue delivery. The same unchanged positive requirement must eventually
genuinely execute1.25 through the IR path without overlay/legacy fallback.

Independent Astra High actual-packet review reproduced the reviewed inert
comparator exit0 with no discrepancy. It independently read all7903 physical
inputs/1903 source files/131451520 bytes against frozen hashes, committed Git
blobs and modes, rejecting symlinks and selected extra inputs. All12 candidate
pins and original baseline pins/tar still match. The exact source delta remains
one approved import. Actual parentexit1 is separately supplied terminal evidence
from tool88053, not a conclusion inferred from childreceipt or comparator output.
