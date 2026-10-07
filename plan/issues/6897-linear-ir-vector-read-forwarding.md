---
id: 6897
title: "Linear IR vector reads: resolve relocated array headers before length and payload access"
status: in-progress
created: 2026-10-07
updated: 2026-10-07
sprint: Backlog
priority: high
horizon: s
feasibility: hard
task_type: bug
area: ir, codegen-linear
language_feature: compiler-internals
goal: backend-agnostic-ir
related: [6893, 1977, 6865]
assignee: ttraenkler/codex-ir-shared-read-forwarding-20261007
reasoning_effort: medium
origin: "Session B PR6568 requests Session A shared IR read-forwarding repair"
---

# Linear IR vector reads after relocation

Session A owns shared IR and integration; Session B retains its C-ABI and runtime leaf scopes. Latest Astra High authored the implementation plan below; Sol6.1 Medium implements after root grants a bounded claimed scope. This opening note records the initial planning snapshot; the independently qualified candidate and its remaining limits are recorded below. Retain legacy code and all original requirements.

Canonical reservation/claim actual JSON verified at upstream ledger f1b9305f2d, id6897, owner ttraenkler/codex-ir-shared-read-forwarding-20261007, branchcodex/6865-public-maps-main-a5-20261007, write99176-dgmv99z7. This record reserves an A dependency issue, not B's claims/files.

## Acceptance

- [ ] Attribute the retained 3.75,69,40 obligations individually on a pinned current composition, preserving authentic owner/IR evidence and original options.
- [ ] Resolve forwarding for length and payload through the existing defined runtime helper, including allocation-free read demands and ABI validation before emission.
- [ ] Native stale-length/stale-payload/multihop controls pass without read-side mutation/allocation; negative capability cases fail closed.
- [ ] All previously passing control rows remain passing; source-map/currentness guards and B's leaf implementation remain unchanged.
- [ ] Required normal hooks/checks and protected merge queue deliver the reviewed exact head to canonical main. Local work is not delivery.

## Implementation Plan

Exact frozen Astra plan SHA256 ee9949838153ca9badd180d5edcef4015c63afffcf3b309c50bf4d8fe846bb45. Three-file source slice is conditional on the per-owner attribution gate; existing direct-emitter test adapters require explicit scope release. No benchmark, array-return admission, f32 extension, source-selector widening or legacy retirement is authorized by this issue.

# Shared Linear IR read-forwarding: bounded diagnosis and repair plan

Status: read-only architecture proposal, 2026-10-07. No tests, runtime processes, benchmarks, source edits, claims, commits, or publication performed for this plan. Root must record and authorize the concrete implementation issue before a Sol writer starts. Session B's C-ABI leaf remains B-owned.

## Evidence and epoch boundary

Local read base: a5c5689f9c85090d44f940204ae3c65605f01ce5, branch codex/6865-public-maps-main-a5-20261007, composed worktree /private/tmp/js2-ir-public-source-map-main-a5-20261007. Working source hashes below, not HEAD alone, identify the code reviewed. Root owns the preserved integration changes. No old whole-file overwrite is authorized.

Remote authority: held PR6568, fork ttraenkler/js2, exact published head 08fecaa9f53c80f0178d4a101fc3a6aa873a799a. Issue6893, Session B handoff, comparison JSON, tests, implementation, and decompressed combined log were read through GitHub contents at that head, without checking out or mutating B's branch. B's original baseline is 91e519587ec2d383a96cfc7d06f48bac04d2c286; implementation commit 608edfabf404aba0e69691eeccbda7518ca7988d and final validation witness f23aa8afd7d8cc483b3ec92cfde45b525d6d13ae are different identities from the publication head.

Published results, not measurements on this A composition: new 18 tests baseline 8 pass/10 fail, candidate 17 pass/1 fail; unchanged 80 controls baseline and candidate 78 pass/2 fail. Candidate combined 98 = 95 pass/3 fail, without skips. The comparison JSON's raw-log hashes identify its two underlying runs; the separately read combined gzip log has its own decompressed hash below. Preserve all first failures and distinct receipts.

The three scalar obligations are:

| Exact retained test | Source behavior | Published actual / required | Route evidence |
| --- | --- | --- | --- |
| issue6893 “retains the separately owned scalar IR read's correct 3.75 requirement”, case aliasScalar31-out-of-scope-A | export function run(): number { const values=[1.5,-2.25]; const alias=values; alias[31]=3.75; return values[31]; } | 0 / 3.75 | Compile and Wasm validation succeed. Actual report compiled run, no rejections, compiled canonical-owner evidence. Scalar C header double run(void). |
| issue1977 “pushed values survive relocation” | a=[7]; for (let i=1; i<=30; i++) a.push(i); return a[0]+a[1]+a[30]+a.length; | 24 / 69 | Existing test measures execution; published log does not provide per-owner IR evidence for this row. |
| issue1977 “aliases observe growth through the forwarding record” | a=[1]; b=a; for (let i=0; i<20; i++) a.push(i); return b.length+b[20]; | 16 / 40 | Same route-evidence limitation. |

The exact issue1977 source includes its original whitespace and wrapper; reuse the file, not a normalized replacement fixture. Its compile options are only target: linear, with default ABI and optimization. The new issue6893 fixture uses target: linear, abi: c, optimize: false and JS2WASM_LINEAR_IR=1. Preserve these differences. Neither a common wrong value nor a passing diagnostic establishes a shared cause.

B's ten-line C-ABI array-return repair resolves a returned header before reading its exported pointer/length pair. Published explicit number[] source-return cases still report missing-return-type/override admission and use fallback. Their improved marshaling is real, but is not proof of shared IR array-return support. That admission remains open outside this scalar-read slice. f32 issue6888 is also separate.

## Static mechanism, ownership, and limits

1. Shared frontend semantics already request bounded indexed reads. src/ir/array-element-lowering.ts:529, emitSafeVecGet, emits vec.len for an unsigned index/length guard, then vec.get in the true branch. Linear's existing out-of-bounds result is zero. An obsolete length can reject a newly grown, valid index before its payload is loaded. Fixing only payload access cannot repair that path.
2. src/ir/lower-generic.ts:2445-2475 lowers vec.len through emitter.emitVecLen and vec.get through emitVecDataPtr followed by emitElemGet. It contains no forwarding-header policy. This is the correct dependency direction: semantic read intent remains shared; physical header resolution belongs to the Linear target adapter.
3. src/ir/backend/linear-emitter.ts:256/266 currently loads length directly from the supplied header and forms dataBase as header+elementsOffset. emitElemGet:274 loads from that base. Neither resolves a forwarding record. This is a concrete static incompatibility with a stale-but-valid alias to the runtime's relocated vector, independently of the three reported result values.
4. src/codegen-linear/runtime.ts:797, ensureArrayResolveRuntime, already defines __arr_resolve(i32)->i32. It follows every tag/pointer link described by LINEAR_ARRAY_FORWARDING and returns the current header; it neither allocates nor compresses/mutates the chain. addArrayRuntime:847 installs it. Existing __arr_get:1071 resolves before bounds and payload reads; __arr_set and push/grow also use forwarding. Reuse this implementation; do not copy its loop into the emitter or add a second representation.
5. src/ir/analysis/effects.ts:143 classifies vec.len/get as heap reads and stores as heap writes; calls also have conservative heap effects. This review has not proved an optimizer reordering defect. Do not change effects/GVN or infer purity from the resolver's lack of writes.
6. Linear has an existing symbolic capability handshake. LinearEmitterOptions:81 accepts resolveRuntimeOperation; linear-integration.ts:541 collects demands; :582 validates them; :1802 performs preflight before authenticated frozen-body consumption; :2556 maps operations to concrete runtime names; :2612 finds a defined module function and applies the import-function offset. No global observer counter or host-import namesake should become authority.
7. Current vector runtime operations cover allocation/growth/initialization, not read resolution. An allocation-only demand is insufficient: a function can read a parameter or alias without allocating a vector. Production codegen-linear/index.ts:306/731 already registers the array runtime. No C-ABI, runtime algorithm, public compiler, source selector, or generic lowering edit is presently justified.
8. Shared emitVecDataPtr is also used by vec.set and forof.vec. The latter (:2643-2669) computes and stores length/data before its loop. Calling the resolver there repairs an already-forwarded entry pointer; it does NOT establish correctness when the loop itself grows the vector. This is a concrete limitation to retain, not a reason to silently broaden this work into iteration semantics.
9. The generic vec.get sequence forms its data pointer before emitValue(index). The authentic IR/value-materialization evidence must show any effectful index computation has occurred in source order before physical access. Do not cache a resolved pointer across a call, growth, store, or iteration merely because SSA ids match. Discovery of a separate scheduling defect requires a separate bounded amendment.

## First gate: attribute the retained source cases

Before claiming a fix, root should grant one bounded qualification window on pinned current source, with B's exact test/source packet composed under its existing ownership. Reproduce the three originals with unchanged flags/expectations. Record actual per-module/canonical-owner admission, prepared IR read and mutation instructions, and final defined function body binding for each.

Use passive forwarding wrappers at real preparation/lowering seams only if existing receipts are insufficient: call the real implementation once with the original arguments/receiver, retain its return and errors, and record immutable copies for evidence. Never mutate IR, headers, bodies, options, module tables or observations to manufacture admission. Keep route observations outside public mintable proof contracts.

For the issue6893 scalar, determine whether vec.len/vec.get reads the original alias after actual growth, where the length guard obtains its value, and whether __arr_set or another real operation performed the growth. For each issue1977 row separately, establish its real IR/fallback owner, mutation provider, read instructions and alias value. An observation of runtime forwarding on a synthetic vector is a mechanism control, not proof that a given source took that path.

If all relevant reads reach the raw-header emitter, proceed with the bounded candidate below. If a failing row reaches an already resolving runtime read, a different owner, or an index/materialization problem, preserve its failure and stop attributing that row to this repair. The statically demonstrated stale-header emitter defect can still have its own authentic direct-lowering control.

## Conditional implementation slice

A single A-owned Sol source writer should own these three existing files, with root reviewing integration hunks. No concurrent edits to the same functions.

- src/ir/analysis/contracts/linear-memory-layout.ts, LinearRuntimeOperation: add a closed, allocation-independent vector operation for resolving forwarding, e.g. family: vector, operation: resolve-forwarding. Use a distinct union arm without fabricated allocationClass or elementStorage. This is a Linear representation contract, not a claim that WasmGC/C/LLVM use forwarding headers. Keep concrete helper names and Wasm indices out of it.
- src/ir/backend/linear-emitter.ts, emitVecLen and emitVecDataPtr: through one small private target-specific helper, request that operation using the existing resolver, emit its i32->i32 call, then the existing load or offset arithmetic. Resolve callback/function index before appending any instructions so missing capability leaves the output untouched. No optional raw-pointer fallback. Use the existing sourcePositions.append path for every physical instruction; no invented source positions, source-map flags, extra nop, or finalizer exception.
- src/ir/backend/linear-integration.ts, addLinearBackendInstructionDemand/collectLinearBackendResourceDemand: add this operation through the existing deduplicating addOperation path whenever vec.len, vec.get, vec.set, or forof.vec will invoke one of those primitives. Traverse nested buffers using the existing traversal. Include demand for allocation-free read functions. Do not append it to every allocation's operation list or require a new handle field merely to hide an instruction demand.
- Same integration file, linearRuntimeFunctionName and resolveLinearRuntimeOperation: bind that one operation to the existing defined __arr_resolve. Retain real module indexing with import offset. At production preflight, validate the actual defined function's (i32)->i32 type using ctx.mod's function/type records before the first body consumer. Reuse a small local validator from binding if needed; keep it specific to this operation, without adding arbitrary callbacks or a second resource framework. The existing names-only public preflight input is not evidence of an ABI check. An import-only namesake, absent helper, or wrong defined signature must fail before emission/output.
- Check existing runtime-operation narrowing exhaustively at typecheck. Unsupported operations still throw. A no-vector scalar body need not request this capability.

Initial physical sequences: supplied header; call the real __arr_resolve; i32.load lengthOffset, or supplied header; call resolver; i32.const elementsOffset; i32.add. emitElemGet retains typed stride/load. Re-resolving in guard and payload is conservative and deliberate; do not add a persistent pointer cache in this slice. vec.set shares address formation, so retain its direct in-bounds store control. vec.set_length remains separate; do not claim all mutation paths repaired.

Do not replace vec.get wholesale with __arr_get: that would collapse the existing element/layout and source-position contracts into a concrete f64 runtime call and obscure bounds ownership. Do not fix the scalar C-ABI wrapper, select a legacy route, disable optimization, hardcode values, or change missing-helper errors into fallback.

Scope exclusions: codegen-linear/c-abi.ts (B), runtime.ts algorithm, codegen-linear/index.ts registration, compiler/public telemetry, from-ast/select, generic lowerer/effects, memory allocation schemas, f32 stores/admission and source-return admission. If an exclusion proves necessary, stop for root's finite amendment rather than widening the patch.

## Focused tests and fail-closed controls

Proposed A-owned new test: tests/issue-6893-linear-ir-read-forwarding.test.ts. Give it one cohesive helper for genuine runtime module construction and actual binding; avoid copying B's large C-ABI suite. Test actual modules/emitters and keep public source cases as a separate proof layer.

Required mechanism controls:
- Current header, one relocation, and a real multi-hop chain produced by __arr_set/push/grow; old and current aliases read the same length and initialized f64 payload. Include fractional values, pre-growth entries and the new tail. Compare memory bytes, allocator usage, chain headers and adjacent allocation before/after read-only calls: reads must not allocate or alter them.
- Distinguish stale length from stale payload: a newly valid index and an older still-in-range entry whose current payload is changed after growth. This prevents a length-only or pointer-only partial repair from passing.
- Allocate-free read IR over a runtime-created forwarded vector still demands and binds the helper. Scalar/string-only IR does not accidentally demand it.
- Missing emitter resolver, missing defined runtime helper, import-only namesake, and incompatible defined signature fail closed. Check the output buffer/body consumer has not run and no public artifacts are returned where applicable. With a real resolver plus preceding imports/namesake import, the actual defined helper is called and host namesake counter stays zero.
- Preserve unsigned bounds/negative behavior and existing zero sentinel tests. Do not advertise JS undefined/hole parity from those controls. Retain no-growth dense arrays, direct in-bounds stores, and ordinary WasmGC primitive behavior.
- A read after an intervening growth observes the new current header; no cache may retain the old data address. Effectful index evaluation needs a source-order control if the admitted source surface supports it; an unsupported pattern remains reported, not silently rewritten.

Two existing direct-emitter tests have concrete contract fallout and need an explicitly granted test scope before change:
- tests/ir-vec-two-backend.test.ts: global bare LinearEmitter at line43 and exact raw sequences at lines71/81 must wire an actual defined resolver/module and assert the resolver call plus original load/address operation. Keep all numerical and WasmGC assertions. Its WAT hand-layout demonstration alone does not prove execution of the changed emitter; add actual emitted-code execution in the new helper. Numeric-only bare emitters remain valid.
- tests/issue-3299.test.ts: runtimeOperation at475 currently accepts memory allocation, vector allocation and initialization only, while its actual runtime module already installs addArrayRuntime. Extend just this test adapter to resolve the new operation to its real __arr_resolve; retain all public/C/backend assertions.

No edit to B's 18 tests or issue1977's 8 fixtures/assertions is proposed. Preserve the entire published 98-test population (6893/1977/1938/c-abi/4539/1835), rerun at composed current A source only when root releases a window, and publish exact rows. The three retained numerical requirements are 3.75, 69 and 40; none is waived. Require authentic IR route/native result for rows credited to this IR repair. The already passing unrelated rows must remain passing.

Run typecheck/lint/format and the focused resource/emitter tests before broadening. Then qualify the unchanged 98 once, plus the explicit new negative controls. For source-map integration, exercise mapped/unmapped scalar IR counterparts with the same options apart from map request: successful native outputs, byte-identical core sections, expected presentation/custom sections and real source positions. Keep all current association/currentness/mutation guards unchanged. Existing broader source-map/C1/runtime-closure qualification stays root-owned after final source freeze; this plan does not recapture proof.

## Performance, delivery, and stop boundaries

The candidate adds one forwarding traversal to each primitive call, including both guard and access. A zero-hop read checks the tag; h forwarding links require O(h) traversal. This is a static cost description, not measured performance parity. Do not add a benchmark now. Root may later compare the same source corpus, effective options, versions, artifact sizes and stage timings under the existing budget procedure. No blanket waiver, unchecked fast path, or stale cache is authorized by a budget failure.

Published B results remain historical until rerun on this composition. A passing synthetic test is not a fixed original row; a passing diagnostic is not native/source-map parity; source fallback cannot earn IR delivery credit. Final proof metadata, main delivery credit, ready/held PR decisions, and cross-session scope coordination remain root responsibilities. B's C-ABI implementation and f32 issue6888 remain separately tracked.

## Exact read pins

All REMOTE entries below refer to 08fecaa9f53c80f0178d4a101fc3a6aa873a799a. LOCAL entries refer to read working bytes in the A worktree, not an assertion of clean HEAD. Format: path, byte count, SHA-256.

REMOTE plan/issues/6893-linear-cabi-array-forwarding.md 31711 15a668ce0a7c44d5fdd8e67a904a471df140479994afca2ec289f1422c87da10
REMOTE plan/agent-context/linear-cabi-session-b-20261007.md 9084 18ca7b49da85b4d824a8b7bb2d5e0dc94cf34745807359be54d7d0f7477a04e5
REMOTE plan/log/6893-linear-cabi-20261007/final-comparison.json 7015 d08e8d1fe7c2ec1f2762a8b71db9e6e583d39e0b7261991e1d61cd6ab1def4bc
REMOTE plan/log/6893-linear-cabi-20261007/baseline-probes.json 2747 894f0438186aadce8ff66cbfa2cbb9d2482c982fc2b2e93ec2443f672d1dcc2f
REMOTE tests/issue-6893-linear-cabi-array-forwarding.test.ts 28427 7612ec537bd3876f3a872e029629601442b7593b1150c30cd25d49db7351be62
REMOTE tests/issue-1977.test.ts 3869 2131321ce2694abac729cdc3f508db53d1ee8d487e64d5ab7248cfcf8bd4e13c
REMOTE src/codegen-linear/c-abi.ts 27454 d303abd67069493c08dedc6cd124482f80675c06e0ca1748cea168098fc82d46
LOCAL src/ir/backend/linear-emitter.ts 23702 02621ed234d1fd473554596efb874523f40afbed2d2785fbeb211ddf1068f622
LOCAL src/ir/backend/linear-integration.ts 113493 1a0b4f26b0f10d20af2cf06b91f5cb4df628bdd0ffbf299610cf939b288dc8de
LOCAL src/ir/analysis/contracts/linear-memory-layout.ts 4670 dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72
LOCAL src/ir/backend/handles.ts 22904 f6e3f9516befb445947bad64a2f0b023e5f5592e385f04e282eb0848f12e0453
LOCAL src/ir/analysis/linear-memory-plan.ts 49040 5f2f5ded3a788e2cc1b70dceb01afe97d249e0e5407e555ced11c5aedb0dbc52
LOCAL src/ir/array-element-lowering.ts 23676 5a032a39858e7fe3eee1e16b139ce5370a53e800ed10dd7fb994272abfc90596
LOCAL src/ir/analysis/effects.ts 25469 b9ea0dfc036a4da09742974011dd98a51aa471a7a2650ebed303f3937e04412d
LOCAL src/ir/lower-generic.ts 209039 cb7ebd26794640248148031d98a040db7e1a40b8b40627f778801fccb35d975e
LOCAL src/codegen-linear/runtime.ts 167063 2a562751f9e2c6291944836681b3bc99b402c2d154a88c429ee16013eaf09e0f
LOCAL src/codegen-linear/index.ts 239146 1b79af9792efb8e574f10f4150773aeb76f621a56e8ea2b6361bbc54a6bd8d3a
LOCAL tests/issue-1977.test.ts 3869 2131321ce2694abac729cdc3f508db53d1ee8d487e64d5ab7248cfcf8bd4e13c
LOCAL plan/issues/6888-linear-f32-vector-store-admission.md 10937 e541da0b4156e80edc7bbfa125b93c81c2e6af8b5001bbda883bc3c09961c50d

REMOTE plan/log/6893-linear-cabi-20261007/final-candidate-and-controls.log.gz (decompressed bytes) 76116 390dab545d25b9ebd5ec20625bc154c1d73675abde1b872f152d932334fa7d47
LOCAL tests/ir-vec-two-backend.test.ts 17906 19b31a171c1704a1d82566350e2ebac299c8b3d576d0d30b93f04c22c896f0f5
LOCAL tests/issue-3299.test.ts 21427 9c88a138ab5b41b0c0b3a2d9bfe4446b63b6953828b6b563fd4e0d1e1c7fc852





## Implementation-plan update: original route gate satisfied, 2026-10-07

This update to **6897 — Linear IR vector reads: resolve relocated array headers before length and payload access** supersedes the old plan's pending attribution gate only. It retains the three-file source boundary, explicitly listed test adapters, original numerical/source requirements, and all delivery exclusions. Root adopts this append; this review changes no canonical status, acceptance checkbox, claim, source or test. No runtime work was performed.

### Evidence and ownership

Read actual `upstream/issue-assignments:6897.json` at local ledger ref `ce0d5788277023d92f806a0855adea33d5be22f8`: in-progress, assignee/requested_by `ttraenkler/codex-ir-shared-read-forwarding-20261007`, branch `codex/6865-public-maps-main-a5-20261007`, write ID `99176-dgmv99z7`. This is a verified local ledger observation, not a new remote freshness assertion or transfer of B's claims.

Read and hash-verified `.tmp/vector-read-attribution-20261007/measurement.json` (`1355a2af23bfb0399e1f216047c87cf81bc5fb07ae09a9e845bd3aa2658988b3`) and `body3/route-projection.json` (`cd4e8a99246a9b879d5ffccdba18060ad21f11827cc87d1f73478ee9d3e4f9d5`) in `/private/tmp/js2-ir-vector-read-attribution-20261007`. Mandatory body: 3 collected/completed, 0 passed/3 failed/0 pending, process exit 1, exact JSON/IPC names and statuses; 15,913 custody inputs and observer/Git state unchanged. Native results remain **0 versus 3.75**, **24 versus 69**, **16 versus 40**. The numerical assertion precedes later in-test attribution assertions; those later assertions did not execute. The actual retained DATA independently supplies the joins below.

For EACH source, the canonical owner matches the actual lowered IR owner and compiled-owner evidence, and joins the installed defined function at physical slot 50. The corresponding emitter records contain raw `emitVecLen` length loads and `emitVecDataPtr` header-plus-offset addressing, then typed payload reads; passive observer faults are empty. The two push sources actually lower push as `vec.len` followed by `__ir_vec_elem_set_f64`, bound to defined `__arr_set`; they do not call `__arr_push` from the source function. The observed defined `__arr_set` body calls defined `__arr_resolve` and `__arr_grow`. These are observed instruction/provider routes, not direct measurements of runtime pointer values or executed forwarding chains.

**The old conditional route gate is satisfied. Release the bounded implementation after root's scope review; no additional instrumentation or attribution barrier is needed.** This is sufficient to target the independently visible raw-header incompatibility, not proof that forwarding is the sole cause of every wrong result. Candidate native execution must still satisfy all three original numbers. The evidence epoch is a5 plus the frozen family60 composition, not current root26091; B's exact `08fecaa9f53c80f0178d4a101fc3a6aa873a799a` C-ABI repair remains read-only/uninstalled. Neither B98 qualification nor current-root/performance/delivery credit follows.

### Exact source implementation (one Sol writer; root composes)

Current static review is rooted at `/private/tmp/js2-ir-public-source-map-main-26091-20261007`, HEAD `26091eabd4561e5be154741e7e18143070d3ce59`, with its integrated working changes. `source-census.json` beside this isolated append pins the working bytes reviewed. The same three seams remain present:

1. **`src/ir/analysis/contracts/linear-memory-layout.ts::LinearRuntimeOperation`:** add a distinct closed arm `{ family: "vector"; operation: "resolve-forwarding" }`. No allocation class, element storage, allocation ID, function name or physical index belongs on this allocation-independent header operation. Do not change allocation policy or `defaultOperationsForLayout`.
2. **`src/ir/backend/linear-emitter.ts::emitVecLen/emitVecDataPtr`:** a small private helper requests that operation through `LinearEmitterOptions.resolveRuntimeOperation`. Resolve the binding before appending physical instructions; missing callback/binding fails with no change to this invocation's supplied buffer. Then append `call __arr_resolve` followed by the existing length load or elements-offset addition, through `sourcePositions.append`. Preserve layout offsets, typed stride/load, source scope, and all numerical primitive behavior. No raw-header fallback, independent forwarding loop, pointer cache, extra nop, or source-map-specific branch. Keep `emitElemGet` unchanged. The buffer guarantee is per emitter invocation; it does not claim rollback of earlier generic operand emission. Production preflight below supplies the stronger before-body guarantee.
3. **`src/ir/backend/linear-integration.ts`:** pass the existing deduplicating `addOperation` into `addLinearBackendInstructionDemand` and add the new operation for **`vec.len`, `vec.get`, `vec.set`, `forof.vec`**. These are the actual users of the two changed primitives; the last two must not acquire an undeclared dependency. Existing `forEachLinearIrInstruction`/deep-buffer traversal already covers nested and async-state buffers. Derive demand from instructions even when `memoryPlan.allocations` is empty; do not infer read capability from allocation demand. Scalar-only and string-only bodies must not request it. Map this operation to defined `__arr_resolve` in `linearRuntimeFunctionName`.

**Typed binding and preflight must be real.** `resolveLinearRuntimeOperation` currently finds a named defined function and returns `ctx.numImportFuncs + localIdx`. For this new operation, additionally inspect `ctx.mod.functions[localIdx].typeIdx` and the corresponding `ctx.mod.types` entry: require an actual function type with exactly one i32 parameter and one i32 result. Missing type, non-function type, wrong arity or wrong kinds fail through the existing invariant/error conventions. Bind the actual defined function, never `funcMap`'s import namesake. Preserve the established import-function offset; do not use all-import count or the observed slot 50 as a constant.

After the current `validateLinearBackendResourceDemand` call and **before the first authenticated frozen-body consumer**, resolve every demanded forwarding operation against this actual `ctx.mod` table with that same typed binder. Reuse the same validator when the emitter later requests the operation. This is a small production preflight step inside the owned file, not a new public capability framework. Keep the existing names-only exported validator useful for structural resource checks; do not present it as ABI validation or widen every operation's ABI contract for this task. Tests must exercise the actual typed production preflight. There is no need to add a public mintable receipt or a new observer callback.

The existing runtime `ensureArrayResolveRuntime` follows the forwarding tag/pointer chain without allocation, writes or path compression. Production array runtime registration already installs it. Re-resolving before both bounds length and payload is intentionally conservative. The extra length read used by push also benefits from the same operation. Keep `vec.set_length` and iterator growth-during-body semantics outside this slice: `forof.vec` resolves its entry header but still captures length/data before the loop. This does not prove iteration remains correct after in-body growth.

### Explicit test scope and finite validation

The same source writer may update only these two existing adapters after root releases them, and add the focused test named by the old plan:

- **`tests/ir-vec-two-backend.test.ts`:** the shared vector `LinearEmitter` and two exact sequence assertions need a real defined resolver/module, expecting call then the original load/add. Preserve all GC and numerical assertions. Its numeric-only bare emitter in `runLinear` does not need a vector resolver and remains a healthy no-demand control. Label the existing hand-written WAT example as a layout illustration; actual emitted-module execution belongs in the new focused test.
- **`tests/issue-3299.test.ts::runtimeOperation`:** add only the new operation-to-actual-defined-`__arr_resolve` mapping; its module already registers the real array runtime. Keep every C/public/backend expectation intact.
- **New `tests/issue-6893-linear-ir-read-forwarding.test.ts`** (retain the old agreed name): genuine runtime module and emitted-code controls for stale length, stale payload after changing an old in-range entry, real multi-hop growth, no-growth and direct in-bounds stores; read-after-intervening-growth; unchanged memory/allocator/forwarding headers across reads. Retain fractional values and unsigned/out-of-bounds zero behavior. Add allocation-free read demand, absence of scalar/string demand, and nested-buffer demand checks. Missing callback, missing defined helper, import-only namesake and wrong defined ABI must reject; actual production preflight rejects before any frozen-body consumer. A valid defined helper with preceding imports and an import namesake must resolve correctly without calling the namesake.

No changes to original attribution, B's 18 tests, issue1977's fixtures, source expectations, flags, or environment are authorized here. The three original obligations must be rerun on the frozen candidate with authentic owner evidence and return **3.75, 69, 40**; a mechanism control or a fallback result cannot satisfy them. Preserve the failed baseline receipt. New tests may observe real memory for mechanism controls; that is validation of the repair, not a demand for another preimplementation attribution round.

Run scoped typecheck/lint/format and applicable budget gates, then focused new/adapted tests and the unchanged `issue-3528-frozen-body-handoff.test.ts` resource/preflight controls (no adapter edit currently indicated). Root releases the unchanged 98-test B/control population only after exact B packet composition is agreed; that remains a real later dependency. Root also owns final mapped/unmapped native/core/presentation checks, currentness/final-association/C1 qualification and publication after source freeze. No runtime, benchmark or test262 run is authorized by this review itself.

### Remaining limits and stopping conditions

No fourth source file is presently justified: leave `src/codegen-linear/c-abi.ts`, runtime algorithm/registration, generic lowering/effects, selectors, allocation schemas, telemetry, f32 and array-return admission unchanged. Any newly demonstrated need outside the three source files requires root's finite scope amendment, not a speculative barrier now. If one original number remains wrong after this repair, preserve its failure and attribute that residual before widening; do not infer a new optimizer defect from its signature. Current source sizes are 138 lines for the contract, 571 for the emitter and 2,748 for integration; measure changed-function/LOC gates against the actual composed base and keep helpers cohesive. Existing unrelated issue allowances do not grant these files a waiver.

Root may now dispatch the bounded repair under the verified A reservation. Passing it will not deliver B's leaf, qualify 98 historical cases, settle for-of mutation semantics, establish performance equality, or authorize legacy retirement.


## Focused implementation result and root integration

Workerfrozen30/30terminal0, JSON/IPCidentities+statuses exact,15916input/Gitcustodyunchanged. Exactoriginalnative3.75/69/40 reachedwithcompiledIRownerjoins; eightproductionresource/ABInegatives specificerror+zeroartifacts+consumer0, realruntimegrowth/multihop/readmemoryunchanged/importoffset controls pass. MeasurementSHA3c5a9fe4abc10930c3bc843b0f826ad13b825d73746f513ec45dd1dfda86e9bb. NotB98qualification ormain delivery.

Rootreviewedexact6filemanifest6e4f8fe7 andproductiondiff; guardedallpreimages, copied6filepacket into26091integration, archivedpreimages .tmp/main26091-integration-20261007/vector-installation. Rootexistingobject/string sourceuntouched. Newcomposedstatic/adapters/frozen3528/runtimecontrols stillneeded; original5adaptertypingdiagnostics andsourcebudgetreds remain, no waiver. Bsource/claims unmodified.


## Companion qualification: failure comparison required, 2026-10-07

One unchanged four-file body registered 63 cases: 58 passed, four failed, one existing optional Porffor case skipped. Vector adapters passed 14/14; issue-3299 passed its active case; focused forwarding controls passed 30/30 again. The unchanged frozen-body handoff suite passed 13/17 and failed at lines 639, 718, 753 and 776 (refusal/owner-population expectations). Preserve these assertions and failures. Root authorized one exact pre-vector baseline comparison of the same 17-case handoff suite using archived source preimages, with guarded restoration of candidate pins. No causality claim, B98 credit, broader source scope or main delivery follows yet.


## Exact companion baseline comparison, 2026-10-07

The unchanged frozen-body handoff suite reproduced all four failures without the vector repair: 13/17 passed, with all 17 statuses and complete failure messages identical to the candidate. Baseline measurement SHA256 `f9164254e8bcbe03299d61d2c50dbb6f548e3115b6864fe7e728af40d6f1daa1`. Candidate source bytes, six repair pins, all 15,916 inputs and Git state were restored exactly after the controlled comparison. This proves the four observed failures predate this repair in the compared composition; it does not establish a common cause or make the suite green. Independent main delivery is being planned against the bounded three-file repair; B leaf ownership and held PRs remain unchanged.


## Independent main delivery amendment: vector header reads, 2026-10-07

This amendment belongs to **6897 — Linear IR vector reads: resolve relocated array headers before length and payload access**. It permits the existing bounded correctness repair to proceed independently through the protected queue. It does not qualify or retire the public/legacy compiler, deliver Session B’s C-ABI leaf, or wait for the unrelated source-map packet’s budget repairs. Root owns issue adoption, claim transfer, final integration and publication; one Sol6.1 Medium implementer owns the six files below. This is a static specification, not a new runtime result.

### Authenticated base and exact operands

Root authenticated canonical main `6e5a583e56553c6066646591d1637c45c15e99e8` after PR6578 at approximately 14:53 UTC. This review read that exact cached Git object with `GIT_NO_LAZY_FETCH=1`; it neither refreshed a root branch nor claimed a newer remote tip. Before implementation release, root checks the actual main revision and claim scope once. If main has advanced, compare these six paths and their required interfaces; retain unrelated delivered changes. Do not replay a whole source-map worktree or wait for another architecture phase.

| Canonical operand | Bytes | SHA-256 |
|---|---:|---|
| `src/ir/analysis/contracts/linear-memory-layout.ts` | 4670 | `dba3ca2121063a52b0ae1130f48c0acc70e0f819a9e665a2a2744572eddfae72` |
| `src/ir/backend/linear-emitter.ts` | 21857 | `dda316ded6fd9e08bd530e6f743000850a064d950a62dbd9506e5313c8b21041` |
| `src/ir/backend/linear-integration.ts` | 97938 | `15612a208a0a2d00a4356d2dc231c303dfc799eafa90d436b94ad01c6f63a306` |
| `tests/ir-vec-two-backend.test.ts` | 17906 | `19b31a171c1704a1d82566350e2ebac299c8b3d576d0d30b93f04c22c896f0f5` |
| `tests/issue-3299.test.ts` | 21427 | `9c88a138ab5b41b0c0b3a2d9bfe4446b63b6953828b6b563fd4e0d1e1c7fc852` |
| `tests/issue-3528-frozen-body-handoff.test.ts` | 50870 | `5609787e0411a11527ad0580d14998104194732283533fd3d95cd6959f6d96d3` |

The new `tests/issue-6893-linear-ir-read-forwarding.test.ts` is absent at this main revision. Its retained name is intentional; the planning/delivery issue remains 6897.

The exact donor is `/private/tmp/js2-ir-shared-vector-read-forwarding-20261007`, evidence `.tmp/shared-vector-read-forwarding-20261007/installation/manifest.json` SHA-256 `6e4f8fe766802b23e7da74d4588c3b40be042a12017262f35c0ab049773c2c66`, patch `28fe14ab8120b1447cfae26ea91d2e04f0429de08701dbdd6b3387dd59fde805`. Donor source epoch is 26091 plus its frozen 64-file source-map provision, not clean canonical main. The frozen donor outputs are:

| Owned file | Bytes | SHA-256 |
|---|---:|---|
| `src/ir/analysis/contracts/linear-memory-layout.ts` | 4763 | `977e572b62737c3459df08c15e4d3f6ce7f461f9fc5b1aac344ad676690e3754` |
| `src/ir/backend/linear-emitter.ts` | 24245 | `5cef162f9a3e3560f77265f2a05cefab595843661555c7d8d63f0244668b7934` |
| `src/ir/backend/linear-integration.ts` | 113703 | `29347c0aa4b42ad572f1ea725600e2e32b3157347a0139ede0bff595080f356d` |
| `tests/ir-vec-two-backend.test.ts` | 18615 | `6eccb60d9f5b019e9291a3ab8cb7282f4e4c72ba172682437e2d2156fa21fdbf` |
| `tests/issue-3299.test.ts` | 21561 | `8148b04aa60e680fdf79057ef8cc2a53fd2ff1d8e20a57f4d40797a5a7e05cee` |
| `tests/issue-6893-linear-ir-read-forwarding.test.ts` | 18752 | `01d3d64c885888e3cf80b33295bfcd43d37520e64c78a2e2daa94da6db979cf9` |

Contract and both existing test preimages match canonical main byte for byte. The emitter and integration do not: donor preimages are `02621ed234d1fd473554596efb874523f40afbed2d2785fbeb211ddf1068f622` and `1a0b4f26b0f10d20af2cf06b91f5cb4df628bdd0ffbf299610cf939b288dc8de`. Port their semantic hunks into canonical files. Whole donor copies would import unrelated source-map implementation. Final port hashes must be measured after implementation; donor emitter/integration hashes are not expected final pins.

### Exact implementation and ownership

1. **Contract**, `LinearRuntimeOperation` at canonical line82: retain the donor’s separate closed `{ family: "vector"; operation: "resolve-forwarding" }` union arm, with no allocation class/storage/id/index. No default allocation operation, policy or schema changes.
2. **Emitter**, `emitVecLen`/`emitVecDataPtr` at canonical249/259: resolve through the existing options callback before modifying the supplied buffer, using the donor private `vectorReadResolver` checks and error strings. Append a call to the returned defined-function index before the existing length load or elements-offset addition. Main uses `out.push`, so use that existing sink; do not import `sourcePositions`, add emitter options, or transfer donor source-map fields. Preserve all offsets, element load/stride logic and numerical methods. Both reads resolve afresh; no cached pointer, raw-header fallback or new resolver loop. Update the two header comments to describe the resolver call accurately.
3. **Integration**, canonical `addLinearBackendInstructionDemand`439 and collector533: pass the existing deduplicating `addOperation` callback and demand forwarding for `vec.len`, `vec.get`, `vec.set`, `forof.vec`. Preserve deep instruction/async-buffer traversal and existing string/intrinsic demands. Demand exists even with zero allocations. Add donor private `preflightLinearBackendResources`: ordinary structural validation plus actual typed binding of every demanded forwarding operation. Replace only the names-only preflight block at1537–1547 after `bindMemoryPlan`, before `consumeFrozenIrBodyBatchWithFactories`1554. Main has no donor `assertNumericGlobals` block here; do not transplant that unrelated context. At `linearRuntimeFunctionName`2200 use the donor compact family dispatch, preserving every existing memory/vector/string/stack mapping and constraints. At `resolveLinearRuntimeOperation`2256 retain defined-function lookup and `ctx.numImportFuncs + localIdx`; for the forwarding operation require the actual referenced type to be a function with exactly one i32 parameter and one i32 result. Missing type, struct type, wrong kinds/arities, missing definition and import-only namesake fail before any frozen-body consumer. Do not change exported structural-validator semantics or manufacture authorization receipts.
4. **Tests**: copy the exact three donor test outputs above after checking their preimages/new-file absence. The two adapter changes are precisely required by the new emitter operation: actual runtime resolver registration and call-prefix assertions in `ir-vec-two-backend`, and the existing real-runtime `runtimeOperation` adapter in `issue-3299`. Keep all GC, C/public, numerical and native assertions. Keep all 30 new control identities, original source strings/options and expected values. The existing hand-written WAT case remains a layout illustration; actual changed-emitter execution is covered by the new real-module controls.

No fourth production file or extra test helper is presently required. Actual new-test relative imports all exist at main. `tests/helpers/ir-identities.ts` is main/donor exact, 3056 bytes, SHA-256 `42d958bb82f322169236903aef37e0ad68681b5ba06be0c458bfa7412cc213f0`. Actual runtime is also exact, 167063 bytes, `2a562751f9e2c6291944836681b3bc99b402c2d154a88c429ee16013eaf09e0f`. It already installs `ensureArrayResolveRuntime` at797 through `addArrayRuntime`847; the generated resolver follows the chain using loads/local assignment and performs no allocation or stores. Canonical linear module generation registers array runtime at223/445. Canonical frozen-body consumer exports the same real factory entry point; canonical report exposes `funcs`, `ownerEvidence` and IR module data required for genuine route assertions. Other imported entrypoint/binary files differ from donor because of the larger packet; consume canonical implementations, do not copy them. `test-dependencies.json` retains every measured dependency pin.

The implementer must not edit Session B’s runtime/C-ABI leaf, B’s tests, original issue1977 tests, generic lowering, effects, selectors, allocation schema, policy, C1, claim files or budget baselines. Root updates the existing claim’s branch and exact three-source/three-test ownership before writing a fresh isolated main worktree. Root owns this issue amendment. If a fresh compile or control exposes a concrete missing dependency, preserve it and identify its exact file/function before asking root to amend scope; do not silently import the 64-file provision.

### Finite validation and historical limits

The saved donor focused run is 30/30 with exact native results **3.75, 69, 40** and compiled IR owner joins. Its four-file companion population is 63 registered: 58 passed, four failed, one existing optional Porffor skip. The unchanged frozen-body suite contributes 13/17, and its exact pre-vector comparison preserves all17 statuses and all four complete failure messages. Receipt: donor `.tmp/shared-vector-read-forwarding-20261007/baseline3528/measurement.json`. This proves no four-case delta in that composed donor epoch; it is not a canonical-main result and does not establish a common cause. Keep those receipts and assertions intact.

On the fresh isolated main branch, measure the exact original three source/option obligations before the source port and after it. Record native output, binary validation and owner joins, not just successful compile or IR eligibility. Keep 3.75 with `target:linear, abi:c, optimize:false` and `JS2WASM_LINEAR_IR=1`; keep 69/40 with their original `target:linear` defaults. Existing original attribution 0/24/16 remains historical even if fresh main differs. Do not add a new preimplementation instrumentation project.

After the port, freeze the six files and run the retained 30-case control plus the two adapted suites and unchanged frozen-body suite as the existing 63-case body. Collect actual names before running and stop if the population unexpectedly differs. Require the original three numbers and authentic compiled IR owners; the eight production negative cases must observe specific failures, zero output binary and zero body-consumer calls. Preserve allocation-free/nested demand, no scalar/string demand, stale-length and changed-old-payload reads, real multihop/read-after-growth, no-growth and fractional stores, unsigned zero-sentinel behavior, all-memory/allocator unchanged by reads, and the real defined helper after imports without invoking a host namesake. Keep the optional Porffor skip explicit; its skipped adapter branch earns no execution credit.

Run unchanged `tests/issue-1977.test.ts` on the independent candidate to preserve its original fixture population. A whole 98-case Session B qualification remains contingent on actual B composition; it is not a prerequisite for independently delivering these three IR obligations, and this port earns no B98 or array-return admission credit. No f32 widening, for-of growth-during-body claim, benchmark or test262 sweep is needed for this finite port.

Require source TS7 and focused-test-inclusive typing, scoped formatting/lint, then the branch’s ordinary build/required checks. The donor’s adapter-inclusive TS7 had five diagnostics, exactly matched by its unchanged adapter control; do not call that clean or assume the same result on fresh main. If the fresh 17-case frozen-body result has failures, compare the identical suite on this actual main base and preserve complete messages before attribution. The earlier donor baseline does not excuse a new independent regression. No blanket rerun of unrelated historical source-map/metadata/fault suites is implied.

### Budgets and protected delivery

Canonical sizes are contract138, emitter561 and integration2383 lines. Exact donor semantic deltas are +4, +17, and **−4** lines respectively; emitter’s canonical `out.push` formatting and accurate comments may alter its small count. The integration change is cohesive: preflight extraction shrinks the large `compileLinearIrFunctions` body, and compact existing family dispatch offsets the added forwarding checks. Preserving those same six integration hunks predicts2379 lines on this base; this is static arithmetic, not a gate result. Measure actual formatted candidate sizes and changed-function spans.

Run `check:loc-budget` and `check:func-budget` against the actual independent change base. They are change-scoped: integration is already above1500, so any net growth must be resolved in the owned implementation or explicitly addressed through this issue’s reviewed procedure. Do not borrow source-map issue allowances, edit global baselines, compress code merely to hide growth, or claim inherited donor reds waive candidate gates. No function-budget waiver is indicated by the narrow helper extraction; actual gates decide. The larger packet’s +361 integration and other file/function failures are retained in its receipts and outside this independent diff.

After the candidate’s actual native/typing/format/lint/budget/required checks, root reviews the exact six-file diff plus this issue update and opens the existing issue’s ready PR through the protected queue. No root source-map fixes, C1 refresh, Session B leaf, full migration redesign or legacy retirement is a dependency. Recheck the released main base and verify merge ancestry and installed content before claiming delivery. Preserve any new failing assertion; never change expected3.75/69/40, source bytes or routing requirements to make publication possible.

## Independent canonical-main candidate measured, 2026-10-07

The opening “no source writer has started” sentence and earlier compositions are historical authoring snapshots. This independent candidate is based on authenticated canonical main `6c88d157444ea4ae377a7ef1b82b15ef2f4f6603`, branch `codex/6897-vector-read-independent-20261007`. Actual upstream slice `6897:vector-read-independent-delivery-20261007` belongs to `ttraenkler/codex-ir-vector-read-independent-20261007`; its JSON record was fetched and verified before edits. Only the three production files, two existing test adapters, new focused test and this reserved issue are changed. Session B's C-ABI leaf and the 64-file source-map composition were not copied.

Before the port, the exact original sources/options compiled to valid binaries with actual compiled IR owner joins and returned **0, 24, 16** instead of **3.75, 69, 40**. After the canonical `out.push` port, all three unchanged numerical requirements returned **3.75, 69, 40** with authentic compiled owner joins. The focused controls passed **30/30**, including eight actual production ABI/helper refusals before body consumption, genuine import-offset/namesake controls and real forwarding/memory/allocator tests. The vec adapter passed **14/14**; issue3299 had **1 pass and 1 existing optional Porffor skip**. Its skipped native adapter branch earns no execution credit. Unchanged issue1977 passed **8/8**, preserving all fixture identities.

The full four-file population was **63 registered:58 passed,4 failed,1 skipped**. The four failures remain in unchanged issue3528's string-refusal and compiled-owner expectations. A controlled full **17-case** run against the exact clean-main three-source preimages reproduced **13 pass/4 fail**, with all17 identities/statuses and all four complete raw failure messages exactly matching the candidate. All candidate files and Git state were restored afterward. Neither suite is called fully green; this establishes no new failure delta in that specific comparison and does not establish a shared cause for the four failures.

Source TS7 and focused-test-inclusive typing, scoped Biome/Prettier and the ordinary build passed. Adapter-inclusive typing still reports five diagnostics; these are recorded, not called clean or repaired outside scope. Both change-scoped LOC/function budget gates passed without allowances: integration **2383→2376** lines and emitter **561→576**. All31 recorded architecture commands and the separately prescribed CI hybrid readiness profile completed successfully; six initial sandbox IPC failures were preserved and only their unchanged commands retried with tool escalation. The plain strict readiness gate passed its own bounded corpus; this is not whole-compiler equivalence or retirement authority. Runtime JSON/IPC names/statuses and **15,890** source/framework input hashes remained exact across the recorded bodies and required checks.

Local evidence remains under `.tmp/vector-read-independent-20261007/`: clean-main three-obligation baseline, `qualification63`, the exact-main `baseline3528` comparison, `qualification1977`, required-check raw channels and IPC recovery records. These ignored artifacts are local receipts, not remote links. Ready publication still requires root review, normal signed hooks and fork delivery. No Session B98, array-return admission, f32 widening, for-of in-body growth semantics, performance equality, default-route switch or legacy retirement is claimed.
