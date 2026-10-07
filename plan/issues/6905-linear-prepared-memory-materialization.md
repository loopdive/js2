---
id: 6905
title: "Linear Prepared IR memory materialization and ownership handoff"
status: in-progress
sprint: current
created: 2026-10-07
updated: 2026-10-07
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
---

# Linear Prepared IR memory materialization and ownership handoff

## Evidence and release state

Exact inspected base: `3c671f11506f91f4eb91624cf9a8456ca95a6ce8`.
**Specification only; source implementation is blocked on explicit ownership
agreement and publication of A's shared contract and wiring.** No source/test
scope transfers with this plan. No migration or production fix is completed.
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
