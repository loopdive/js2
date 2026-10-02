---
id: 3518
title: "IR-only default and direct front-end retirement"
status: in-progress
created: 2026-07-21
updated: 2026-10-01
priority: critical
feasibility: hard
reasoning_effort: medium
task_type: refactor
area: ir, codegen, codegen-linear, compiler
language_feature: compiler-internals
goal: ir-full-coverage
sprint: current
depends_on: [3519]
horizon: xl
complexity: XL
es_edition: n/a
lane: ir-retirement
model: gpt-6.1-sol
related: [1373b, 2855, 2950, 3090, 3142, 3143, 3341, 3517, 3529, 3520, 3521, 3522, 3523, 3525, 3526, 3527, 3528, 3678, 3681, 4382, 4576, 4577]
origin: "2026-07-21 explicit user directive: enable IR-only by default and retire the old direct codegen path"
oracle-ratchet-allow:
  - src/codegen/multi-prepared-array-leaf.ts
loc-budget-allow:
  # PR5883 cycle cut: exactly two type-only service imports and two readonly
  # context fields (+4 lines); implementations remain in subsystem owners.
  # No function-size exemption or shared baseline change.
  - src/codegen/context/types.ts
  - src/codegen/map-runtime.ts
  - src/codegen/index.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/multi-prepared-scalar-leaf.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/builder.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower-generic.ts
  - src/ir/core/nodes.ts
  - src/ir/runtime/manifest.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/select.ts
  - src/ir/runtime/verify.ts
func-budget-allow:
  - src/ir/runtime/verify.ts::verifyInstrStructure
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::planIrOverlay
  - src/ir/backend/linear-integration.ts::compileLinearIrFunctions
  - src/ir/backend/linear-integration.ts::makeLinearIrResolver
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeResolver
  - src/ir/lower-generic.ts::emitInstrTree
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/ir/prepared-component-dependencies.ts::collectFunctionEvidence
  - src/ir/select-identity.ts::planIrCompilationByIdentity
---
# #3518 — IR-only default and direct front-end retirement

> **Tracking epic, not a single developer task.** The current compiler is a
> default-on **hybrid**: some functions compile once through IR, while the rest
> still compile through the direct AST→Wasm front-end or compile twice and are
> patched by an IR overlay. This epic ends only when IR is the sole front-end,
> both WasmGC and linear consume the same prepared IR program, unsupported
> source fails explicitly, and the direct front-end is deleted.

## Current model routing — user direction (2026-10-01)

Astra specifies hard tasks and records implementation plans in `plan/issues`.
Sol 6.1 at Medium is the default implementer. Increase implementation effort
when concrete complexity warrants it; this epic's default does not require
maximum effort for every slice. This supersedes historical model assignments
below. Root coordinates issue claims, integration, validation and delivery.

## Current sequencing — develop IR before retirement (2026-09-20)

The user requires the IR path to be developed while the old compiler remains
operational. Retirement happens only once **everything is on the IR path,
tested, and behaviorally equal**. Keep the old compiler as the comparison
baseline throughout development. Passing subsets, body extractions, inventory
checks and local commits do not authorize deleting old code or changing the
default path. The full epic remains open until its complete requirements are
verified; only verified main merges count as delivery.

This sequencing supersedes earlier instructions that would retire code during
partial migration. Historical plans and failure evidence below remain intact.

## October 2 implementation dispatch: existing landing blockers

The integration owner writes the plan and owns issue updates, acceptance review,
composition and protected-queue delivery. Implementation workers use
`gpt-6.1-sol` at medium effort, in disjoint owned worktrees. This replaces the
earlier implementation-model routing for these assignments only.

Verified remote main at dispatch: `2bfe3eddf84d4d27f471eddb91e441709b7f6eff`.
PR #5883 remains held and now conflicts with main; remote checkpoint is
`32c2da64881923d67f0f53c6019a475db6ee1ecd`. PR #6405 is newer intrinsic
preparation work owned elsewhere: do not adopt or modify it without an explicit
handoff. Do not confuse green checkpoint checks with whole-program equivalence.

### A — Finish the existing native binding implementation

Reuse the frozen binding-v3 candidate and separate two-control supplement, rather
than implementing a competing binding API. Owned source: vector-domain-plan,
native-vector-bindings, native-vector-binding-bodies and native-vector-binding-grammar;
tests are the original 31 controls plus two additive controls. The existing
module-ownership prerequisite has 179/179 controls and source/test TS7 passing.

Verify the frozen hash manifest; run canonical and supplemental TS7 and both
test files serially, retaining each first log and exit independently. A typecheck
failure is not permission to replace original tests. Diagnose demonstrated
failures, preserve the original source/receipts, then make the smallest correction
and rerun the unchanged population. Validate real zero-import Wasm, cross-instance
projection identity, receive-only nodes, preflight-before-write, duplicate/missing
slots and post-seal proof integrity. Produce an exact patch and handoff for
composition onto current main; do not activate carrier migration or relax gates.

Recovery finding: the original temporary candidate is empty; durable v3,
ownership and supplemental patches still match recorded hashes. Reconstruct in
a new persistent owned worktree from the exact `55d1c373` base and archived
DomainV1-v2 patch, then match each recorded source/test hash. Preserve the empty
old directory. The original aggregate hash manifest/config are missing: create
and label a new validation manifest/config, rather than claiming byte-identical
harness recovery. Record this limitation and all new first results explicitly.

First recovered validation measured canonical TS7 exit 0, supplemental TS7 exit 0,
original controls 30/31 (exit 1), and supplemental controls 2/2 (exit 0), with no
skips and all nine original hashes unchanged across the batch. The failing
duplicate-slot case was rejected with an allocation-role diagnostic instead of
the graph-key API's expected noncanonical diagnostic. Preserve this first result.
A narrow error-normalization correction retaining the cause is source-reviewed;
the original test remains unchanged. The corrected serial batch is now terminal:
canonical TS7 (74191) and supplemental TS7 (40807) exit 0; original controls
(82455) pass 31/31 and the separate supplement passes 2/2, with no skips.
These results apply to the reconstructed pinned basis, not current main.
The 29-artifact archive preserves both batches, original source and exact patches
under `plan/agent-context/5748-binding-recovery-v4-20261002/` in A's owned tree.
Current-main composition must transplant only the seven-line ownership method,
preserving main's newer snapshot and recursive-type reservation behavior.
A has released the execution slot; no active validation process remains there.

Follow-on A composition is source-only in a new persistent
`codex/5748-binding-main-20261002` checkout at fetched main
`e473d92460af75ced29e9666e7e97cdde8df12ca`. Preserve the recovery checkout and
both receipt batches. Add the eight binding/domain/test files and only the seven
ownership-method lines; audit compatibility with current physical ownership.
No live activation or PR #6195 deletion. Return exact hashes, compatibility
findings and a current-owner/full-33 validation manifest before execution.

After checkpoint8b37543 was published and its local hooks terminated, A received
the sole execution slot for that frozen e473 composition: canonical/supplemental
TS7, unchanged31+2 binding controls and all seven current-owner suites in its
reviewed handoff. Preserve first failures and actual nonempty denominators; no
automatic source/test changes or prior-base success inheritance. New main9187cce
changes CI test262 gating, not these compiler/runtime inputs; retain the exact
measured basis and incorporate the stricter gate before landing acceptance.

Current-main binding canonical TS7 (91260) exits0; the original31 controls
pass31/31. The supplemental project (43406) exits1 with diagnostics in existing
owner fixtures, not the new binding files. Preserve that full-project failure.
After unchanged runtime coverage, compare identical seven-owner-only strict
projects on candidate and exacte473 main, and separately check full source plus
the two new binding suites. These additional scopes attribute the errors; they
do not replace or turn the original failing supplemental check green.

The supplemental failure contains38 diagnostics. Runtime has now measured
31/31 original binding controls,2/2 supplemental controls,149/149 module-owner,
15/15 completion,6/6 type-authority and49/49 snapshot controls. The unchanged
native-object-layout suite instead reports50/52: both historical Object-layout
digest assertions fail (prefix=false and prefix=true). Attribution is pending;
do not repin the digest, edit fixtures or count these two failures as passes.
A's serial assignment additionally runs that entire unchanged52-case file on
exacte473 main, preserves both raw failures and compares complete rows/error
text with only checkout-root normalization. This is diagnosis, not authority
to change the historical oracle. Remaining owner suites must finish before
the execution slot transfers to C's frozen three-arm Promise comparison.

All nine candidate runtime files are now terminal:427 collected,425 passing,
2 failing,0 pending. The remaining owner suites pass81/81 extensible-self-root
and42/42 final-parent controls. Binding-only strict TS7 exits0 (69536), while
candidate seven-owner-only TS7 exits1 (60318); baseline attribution is pending.
The two layout failures occur at the historical source-span hash assertion,
before declaration execution/comparison. B receives a read-only source-lineage
assignment to identify the actual historical/current layout delta and whether
the native recipe tracks either layout. This does not authorize oracle changes
or confer equivalence credit. A remains the sole local execution owner.

Baseline attribution is now terminal: exacte473 seven-owner TS7 (96961) exits1
with stdout byte-identical to candidate (60318). Its unchanged full layout file
(38473) exits1 with50/52. Parent independently compared all52 ordered names,
statuses and complete failure messages: equal after checkout-root substitution
only. Thus both failures and38 typing diagnostics already exist on the exact
baseline; neither becomes a pass. Candidate binding-only TS7 and33 binding
controls remain separately measured positives. All granted A executions have
terminal receipts; A is instructed to release the slot without further execution.

A confirmed all15 validation runs terminal and released the slot. C received
the reviewed manifest's explicit parent grant and started the unchanged pinned
three-arm diagnostic, process46373, run directory
`.tmp/5883-host-three-arm-2026-10-02T05-16-12.973Z-46373` in C's owned checkout.
Parent independently verified that exact process live with original-main child
output. No runtime outcome is inferred from startup. Source pins remain runner
4cb1b7d73aada42758b1b457d7f389e79e4a7b1f79d56c39dc04814bffbdc684
and plugin b87b2a6d158fe86fb16be291c952c7b85d5bc1722f11940be5718a6186e73234;
subjects are immutable2bfe and published8b375. Only the manifest's execution
grant changed. Original fixtures, full eight-case populations and35-second
timeouts remain unchanged; original failure reproduction and both wired arms'
exact positive assertions are required before accepting the wiring hypothesis.

Live PR5883 readiness review now finds all44 checks terminal (24 success,
19 skipped,1 failure), unchanged published head8b375, hold retained, auto-merge
off and no unresolved review threads. Quality run36966835057/job110712310593
fails its changed-root gate: original pop-storage-regression file has19/33
passing and14 failures, first at line101's missing storage-body capacity marker.
This is a demonstrated landing blocker, not a waived instrument defect. D's
next read-only assignment must inspect all failure messages, emitted/source
ownership and historical changes before parent specifies a repair preserving
all33 cases and behavioral assertions. No CI retry, fixture repin or gate change.
New main db906b60073de22c91842fbd6d46f5443cb09b7b adds benchmark artifacts
after9187's stricter test262 gate; reviewed delta frome473 has no compiler/runtime
changes. Integrate that gate before landing; skipped checks prove no execution.

The three-arm Promise diagnostic now has independent terminal child receipts:
untouched2bfe exits1 with exactly the two original35000ms timeouts and6/8 passes;
identically wired2bfe and8b375 each exit0 with8/8 original assertions passing.
Parent read every ordered row and the positive two-site transformation receipts.
This supports the missing instance-wiring hypothesis for these two fixtures;
it is not full Promise/IR equivalence or permission to erase original failures.
No production fix or permanent original-fixture edit has been made.

B's read-only layout lineage identifies d71b6e53ab23ac25bc810efd83c6a8ea1a6493ee
as the entire historical/current span change: legacy Object now appends mutable
protoLink:anyref at index6 and asserts its last-field placement. Historical
span4195bytes/e4d546ab becomes4599bytes/b7944c4c on exacte473. The IR factory
still defines six fields, and its constructors still supply six operands.
The old test reads moving production source despite authenticating a historical
span. A future historical-oracle repair must preserve the exact old span/digest
and both prefix cases; merely changing its expected digest is prohibited.
Current representation compatibility remains separate unresolved implementation
work: IR wrapper payloads/realm slots already use index6. Do not blindly append
the legacy field or claim historical-layout coverage proves current equivalence.
Before implementation, specify coordinated declarations, constructors, field
readers and prototype semantics, or a fully justified representation boundary.

### PR5883 Pop proof repair plan — 2026-10-02

Checkpoint c1a69649afa93b2fccc1ca4115c0c20e0d96be54 publishes the comparison
archive and issue updates through normal hooks (including18/18 numeric-local
controls), with all31 archived byte streams independently rechecked. Hold stays.
D's complete CI inspection attributes all14 failures to the same line101 check;
all14 logged values equal their original expectations, but their final value
assertions were not reached, so no pass credit is assigned. Changed-root CI
actually launched73 cases:59 passed,14 failed; its final13 cases never launched.

Parent owns the repair specification and integration. Sol6.1 Medium D owns only
the existing `tests/issue-5883-pop-storage-regression.test.ts` instrument once
the exact emitted-body inspection is reviewed. No production changes are implied.

1. Preserve the entire current33-case file, inputs, expectations, options and
   120000ms timeouts. Execute it unchanged once on exactc1a69649 with one fork,
   preserving independent terminal exit, native JSON rows, raw logs and emitted
   WAT. No retry on observation timeout and no automatic mutation on failure.
2. Inspect exact emitted Pop, dispatcher, storage-Pop and canonical-Get bodies
   at O0/O2. Demonstrate the externref path's concrete call and matching length
   write; distinguish other carrier branches. Return source/value/WAT evidence
   before editing. Existing source shows Get owns `array.len`; storage-Pop calls
   its allocated/filled Get before truncation. This must be checked in emission,
   not inferred from export names or a whole-module marker.
3. The repair must relocate the capacity-proof obligation to the exact reachable
   Get while proving its call precedes the corresponding Pop length decrement.
   Preserve source-Pop to dispatcher evidence and both direct/inlined dispatcher
   routes. Reject missing/ambiguous function or carrier identification. Do not
   concatenate unrelated bodies, delete assertions, lower expected values, skip
   rows or alter fixtures. Parent specifies exact matcher changes after step2;
   D then implements only that bounded instrument change.
4. Re-execute all33 controls and then all nine changed-root files (86 cases),
   preserving any additional failures. Complete assertions, not logged expected
   values, establish acceptance. Run normal hooks, integrate the latest upstream
   without dropping its stricter gate, and keep hold until protected-queue entry
   is justified by full required CI and review. No old compiler retirement.

Parent's push session99055 is terminal exit0. D now receives the sole execution
slot for step1 only; all other agents remain source-only. The plan grants no
test edits before step2 review and no concurrent compiler/test/hook execution.

#### Emitted-path amendment and implementation grant

The unchanged local run is terminal (runner59487/child59503, exit1), exactly
19/33 pass and14 fail, zero pending. Parent independently read all14 WATs:
storage-Pop310 is an unreachable-only stub in every case; dispatcher304 instead
contains the inlined Pop and one call to Get306. All14 logged values match,
but remain failed until the actual value assertions execute successfully.
Consequently step3 means the *reachable* direct OR inlined route, never a
mandatory proof about a dead storage body. Source-only construction cannot
substitute for this emitted-path evidence. Preserve the first run untouched.

D may now edit only this existing test file, as follows:

- Retain all33 registrations, generated programs, options, timeouts, expected
  values, zero-import/runtime checks, terminal controls, direct-Get controls and
  explicitly non-conformance lookup receipts. No production or fixture edits.
- Authenticate unique emitted function names and unique `__vec_externref` and
  `__arr_externref` type declarations; derive indices from this emitted module,
  not hardcoded306/310/2/1. Missing or duplicate matches fail closed.
- Preserve source-Pop's call to its exact dispatcher. Select storage-Pop only
  if dispatcher directly calls that exact index; otherwise require the existing
  inlined-pop evidence and inspect dispatcher itself. Never concatenate bodies
  or obtain a capacity marker from an unrelated function/carrier.
- In the selected body, isolate the unique `ref.test (ref <externref-vec>)`
  then-arm using balanced WAT parentheses (including nested empty-case guards).
  Prove the sequence uses one receiver local and length local: receiver load,
  extern conversion, length-minus-one, call to exact Get, same receiver and
  length-minus-one, then `struct.set <externref-vec> 0`. Require one such Get
  call and one corresponding length write in that arm, in that order.
- Isolate Get's matching externref then-arm. Prove the logical-length comparison,
  matching vector backing-field load, `array.len`, unsigned capacity comparison
  and conjunction feed the conditional whose then-arm reads the exact externref
  backing array. An `array.len` elsewhere is insufficient. Preserve the original
  actual-value assertion after the strengthened path proof.
- Add negative instrument assertions inside an existing P row (no new test-row
  denominator): missing exact Get call, wrong-carrier length write, reversed
  Get/write order, and a capacity marker moved outside the matching Get arm
  must each be rejected. Do not mutate the real compiler module or source.

Return the single-file diff for parent review before executing repaired tests.
Only after that review: full33, then all nine changed-root files/86cases; retain
first failures and all unmeasured rows until actual execution proves them.

While D implements source-only, B receives the sole execution slot for the
already reviewed V9 runtime pair: unchanged `run.mjs before runtime`, then
`run.mjs after runtime`, each once, serially in its owned5753 checkout. Parent
rechecked runner de4de8baba610fdf504a66fa5cee99a0648578c1b92837f228e388cfb84d3bad,
config c5d09e5df4c3b737ca14dc96a63f367bc3dbe2af620013c96d2941e4b9092593
and invocation manifest6b39d436638a428ebdef0654170c395cb47ab250d7b5af0a4d2f3b427360b3a8.
Verify all original input pins before dispatch; no substitutes or re-freezing.
Require six exact selected names executing out of38 declared tasks, with the32
unselected tasks accounted separately. Retain failed outcomes; selected pending,
missing/skipped/todo, wrong population, environment drift or infrastructure
failure prevents acceptance. Preserve raw logs and independent terminal exits.
No retries, timeout restarts, fixture repairs, compiler changes or installations.
Stub admission/physical comparisons are not included in this runtime grant;
neither six bounded cases nor equal failures waive the original176 acceptance
population, full migration equivalence or any retirement gate. Release the slot
after the pair is terminal, before documentation packaging or further execution.

The separate Object layout audit now enumerates the coordinated native family:
six-field ordinary prefix; primitive wrapper payload and ordinary realm state
at6; wrapper realm state at7. A seventh inherited field would require payload/
ordinary state7 and wrapper state8, plus ordinary, wrapper and String constructor
operands, mixed-access consumers and fixture builders to move together. Relevant
owners are object-layouts, ordinary-object-storage-bodies, primitive-wrapper
layouts/bodies, realm-object-layouts, string-create/exotic/own-keys bodies and
both native-mixed-object-access and mixed-object-access-bodies. Closure/builtin
function and HashedString indices are unrelated and must not be shifted.

This is not authority for that migration now. Native realm state intentionally
holds actual prototypes as externref, whereas legacy protoLink encodes Proxy
links inside ordinary storage. Native inherited subtyping must remain internally
consistent; equivalent semantics need not require identical cross-family physical
layout. Parent must specify and test the representation boundary before adopting
or rejecting prefix parity. Production program-consumer reaches ordinary native
kernel storage; wrapper/realm/mixed owners remain test-assembled, and realm
population remains incomplete. Do not mistake isolated layout tests for complete
production assembly. Queue-blocking Pop proof repair retains immediate priority.

B's V9 runtime pair is now terminal: both shell exit receipts and runner terminal
receipts are0, instrumentFailure false. Parent independently read both full JSON
reports: six exact selected names passed on each arm;32 unselected tasks remain
skipped in each38-task population, not additional passes. Init/dispatch counters
are each1. This is bounded runtime preservation, not full176 acceptance or stub
admission. B is instructed to release without further execution.

Parent reviewed D's complete single-file Pop proof diff and its four negative
controls. The capacity relocation negative additionally proves one original arm
marker, zero after removal, actual out-of-arm insertion and preserved whole-body
marker count; no silent failed replacement can satisfy the negative. Frozen test
SHA540a85fdffa5c45ffaee58efcae0b9a97ec71992f69c1ee7e16206a8679ef668,
101 additions/13 deletions. All original registrations/programs/options and value
assertions remain. D receives the sole slot for repaired full33 first, then the
full nine-file86-case changed-root population serially if33 passes. Do not edit
during execution. Preserve each raw log/JSON and independent exit, report actual
counts and do not omit later files merely because an ordinary test fails. Stop
on infrastructure/population failure; no automatic repair/retry, hooks or push.

The repaired standalone33-case run is now terminal exit0:33/33 pass, no pending.
Parent independently compared all30 before/after logged program receipts (14
Pop,8 direct-Get,8 lookup-preservation): complete source text/hash, expected and
actual values are unchanged. All22 corresponding emitted WAT files are byte-
identical before/after. The four instrument negatives execute inside the existing
dense-O0 row; no population was removed. This is the test proof's correction,
not changed compiler behavior. The separate full86-case batch remains in flight;
neither its final13 cases nor protected-main delivery is yet credited.

The full batch subsequently finished86/86, zero pending, all nine exits0,
including the previously unlaunched13. Runner87631/PID61619 is terminal0 and
D released the slot. Normal Prettier changes only layout: complete parsed TS
trees match at fac751b072230291dd05f8d8b0dc23a7477fdcf267e6357f7f52f32527e00629;
formatted source20b7ce668160da90e128ba4e97c9b785ae7e87a7f798d24956eddbd269ea7ade.
Independent Sol6.1 source review finds no actionable defect, with explicitly
format-specific matching and observed inlined-only runtime coverage. Exact24
JSON streams and all46 stream hashes are archived in
`plan/agent-context/5883-pop-proof-repair-20261002/`; first raw logs/WAT persist.

Fresh upstream is39cc565790e151e4559d7526dd7c57ade6a9d74d, merging PR6416.
Unlike the previous benchmark-only delta, this changes compiler/prototype/
constructor paths and inventory. Preserve this tested repair checkpoint first;
then merge exact upstream and validate the combined source rather than inheriting
the old86/86. No source changes from upstream may be silently dropped to recover
old receipts. Parent owns integration and the next execution slot.

Repair commit017a00642bd99c44b60196e05ec28aef6adcc290 and inspected merge
bbd4abc201fcd8dd0a3903910258f09d7bbd419c are local, not yet published. Merge
parents are exact017a and39cc. All43 non-overlapping incoming paths match
upstream Git blobs; the two automatic overlaps retain only the reviewed Promise
route delta and four checkpoint inventory rows. Normal fast hooks passed; all24
archived result streams and formatted test20b7ce66 remain unchanged afterward.

D receives the sole local execution slot on this exact merged head: canonical
TS7, then the full nine-file86-case changed-root population, then the complete
incoming `issue-6775-builtins-misc-residue.test.ts` and
`test262-edition-ratchet-host-lane.test.ts` files, all serial/one fork. Record
actual denominators for the incoming files rather than guessing them. Freeze
source/config/fixtures throughout, preserve first failures and independent exits,
and do not restart or repair automatically. These runs validate this composition;
pre-merge positives remain separately labeled. Release before formatting, hooks,
commits or push, which stay with the parent. Required remote CI still gates merge.

B's source/receipt audit finds the required1+9 compile results in each V9 arm
(20 total), all successful/terminal with errors/imports empty and saved Wasm.
There are20 user-side empty-import observations with matching test names and
lastCompleted ordinals, no compile-throw records. Those observations lack a
binary hash/module identity; sequential original-source flow supports association
but is not independent hash binding. Do not upgrade this limitation to proof.

Next bounded B source assignment: prepare a separately named saved-binary audit,
without running it or modifying the frozen V9 checker/runner/receipts. Enumerate
exactly compile0 for2917 and compile0..8 for6655 on both arms; reject extras,
missing records or throws. Recompute each saved binary SHA-256 against its
successful terminal result, then (only after a future execution grant) validate
that exact byte buffer as a WebAssembly.Module and inspect Module.imports. Never
instantiate or execute exports; require zero actual imports on all20 binaries.
Preserve original user-side observations as separately ordinal-associated data.
Record this as a new post-run artifact audit, not a retroactive identity binding
for old events. Fresh output only, no overwrite, baseline substitution or fixture
change. Return source/pins for parent review; D keeps the execution slot.

Fresh bbd4 composition validation is terminal: canonical TS7 exits0, full
changed-root86/86 and incoming builtins23/23 pass, all7517 pinned inputs unchanged.
The host gate first reports5/22,17 failures from sandbox `tsx` IPC listen EPERM.
After explicit local-permission escalation, unchanged22 cases report9/22,
13 failures: the worktree's Test262 placeholder is empty and the gate correctly
refuses classification. Both failed runs remain intact, not relabeled.

The canonical Test262 checkout matches the exact gitlink b363f29d3c43c626dc852744ad64a0b48a003693;
its tracked test files are unchanged. Parent linked its contents into the owned
placeholder per repository provisioning rules, without touching the canonical
checkout or hook/shared Git configuration. Existing unrelated untracked canonical
fixtures were neither changed nor selected by this22-case file. With dependency
and IPC setup corrected, full unchanged22/22 passes (session84852, child79308,
exit0). No gate/fixture/source/baseline repair or exemption was used.

Next fetched main883ec89d8e4eff9e6af2f2e09cb53b20a748f390 adds documentation,
CI/release tooling and the async representation-scope freeze; its delta from39cc
has no compiler/runtime source changes. Integrate it while preserving new docs
checks and independently validate its four touched tests and path-check command.
No new main merge by this session is claimed. Parent keeps the execution slot.

Docs/CI merge d9b681a4f55ff75e765367d22370a779b5436399 contains exact883.
No compiler/runtime, TypeScript/Vitest config, Pop fixture or host-ratchet source
changed in this merge. The new path checker passes156 references/11 flags.
All four incoming docs/release test files ran:53/55 pass,2 fail, zero pending.
Both failures are release CLI refusal cases expecting1 but receiving0; they
remain failures, not excluded coverage. Independent source audit verifies exact
upstream883 blobs for release.mjs (affd8ad581efe81899a9317e865c12f88a4a6515)
and its test (e2b08732ddc88af31a894c17b78a989dbb2ecd03), and no delta in any
of the four test files. Source diagnosis: resolve(argv[1]) retains /var while
the module URL resolves /private/var, so the CLI guard skips main. Local filesystem
facts support that diagnosis; original JSON records statuses, not child URLs.
No actual release was invoked by the parent, no gate/assertion was weakened,
and no unrelated release-tool fix is included. Follow-up needs a symlink-safe
entry guard with alias/direct/import-only controls, preserving refusal-before-
mutation behavior. Existing55-case results stay visible as inherited Mac failures.

PR5883 landing scope is expressly preservation of current Promise lowering and
the independently tested vector storage correction, not completion of5197's
live-vector feature acceptance. That acceptance remains unresolved/open, along
with graph closure, managed bootstrap and full IR retirement. Required published-
head and protected merge-group checks must pass before removing hold/landing;
PR stubs and skipped conformance jobs do not count as executed Test262 coverage.

Separate5753 progress: parent reviewed frozen saved-binary auditor a7c98264 and
its70-input manifest2253a984, verified source pins and ran once under the held
exclusive slot. All20 saved Wasm byte hashes match captured results; actual
Module.imports on those exact buffers is empty20/20, without instantiation.
The original frozen admission checker also returns four admissible1/9 cohorts.
This is a new post-capture hash-bound observation; prior user observations remain
ordinal-associated. Full176 and physical-comparison obligations remain unwaived.

### Sol6.1 bounded physical-comparison dispatch — 2026-10-02

Integration follow-up: exact upstream1f1b0ad61cbc74d0bde3a326e8b7e2e02b7add99
is merged locally as16e81912d6d75e8c93e691bfeee10c14cfea7e62, without
conflicts. Its seven incoming compiler files and six-case iterator test are
byte-identical to upstream; issue5197's additional prototype finding is retained.
This adds real iterator semantics, so previous86/86 checkpoint results are not
new-composition evidence. D has the exclusive serial validation slot for
canonical typecheck, all nine unchanged suites and the entire incoming iterator
suite. B implements only the new comparison launcher; C reviews; A inventories
existing held IR PRs read-only to identify the next dependency-first landing.
No new main delivery or hold release is claimed.

Fresh composition validation is now terminal: D session11087/runner6762 exited0,
canonical TS7 passed, all nine checkpoint suites passed86/86 and the entire
incoming iterator suite passed6/6, zero pending/failures. All7522 pinned inputs
were unchanged. Parent inspected each child result and archived the exact JSON
streams under `plan/agent-context/5883-main1f1b-validation-20261002/`; raw logs
and the pin manifest are retained with hashes. Publication/required remote
checks and protected-main delivery remain pending; no retirement credit.

Parent's first launcher source review found a concrete admission mismatch before
execution: it required `final.valid`, but authentic V9 final-environment receipts
contain `initialCompilerEnvironment` and `finalCompilerEnvironment`, not that
flag. B must compare those complete objects against authenticated invocation
evidence and add a genuine frozen-receipt positive control with missing/drift
negatives. Historical receipts/pins stay unchanged; preserve the rejected source
revision separately. No compiler launch was authorized or counted as failed.

Parent authored the [implementation and acceptance plan](../agent-context/3518-sol61-physical-comparison-plan-20261002.md)
before assigning further source work. B owns only a new guarded launcher and
receipt contract around unchanged V7 diagnostics; C independently reviews it;
D checks the published PR5883 head. All are native Sol6.1 Medium assignments.
No new compiler feature scope, fixture/baseline repair, historical-pin refresh,
local execution or PR5753 hold release follows from this source-only dispatch.
The measured6/6 per-arm runtime and20/20 saved-module audit remain bounded
evidence. Full176 acceptance, broader owner correspondence, current-main
integration and end-to-end IR equivalence are still required. Parent retains
issue ownership, execution grants, integration and protected-queue decisions.

Latest dispatch reconfirms parent ownership of implementation plans, issue
updates, integration and protected-queue decisions. Existing native Sol6.1
Medium agents retain isolated assignments: A validation/attribution; B frozen
comparison acceptance review without execution; C frozen Promise comparison
awaiting the slot; D read-only live PR5883 readiness review. No new sidebar
sessions, overlapping writers or extra migration scope are authorized here.

### B — Repair and execute the bounded extraction comparison instrument

Own only the #5753 V9 runner/config and its receipt documentation. Preserve V8's
invalid 4,620-file collection and all earlier fixtures/failures. CLI `list` does
not invoke the proposed reporter guards in the installed Vitest version. Implement
the reviewed programmatic entrypoint: preserve CLI environment setup; `init()`;
assert effective single-project settings; enumerate exactly six specifications;
pass those same objects to collection. Reject extra filters, typecheck/in-source
collection, missing hooks and changed invocation inputs. Runtime uses `start([])`
with pre-dispatch specification checks. Verify six exact selected test names
separately from file count. No unknown-as-empty or skipped-test success.

After source review and a separate execution grant, run the unchanged before/after
subjects and original physical/runtime comparison plan. Equality of two failures
is preservation evidence, not positive runtime coverage or retirement proof.
No edits to closure/class/property production files in this assignment.

After D's five first checks and the parent's documentation hooks terminated,
B received the sole execution slot for before/after collection only, using the
approved frozen V9 runner/config and exact six-file/six-selected-name floors.
The before collection process was observed live (PID66527, Vitest child66532).
Stop at the first infrastructure failure; retain every first receipt. Runtime,
physical comparisons and stub-admission execution remain ungranted. This is
integration-owner scheduling under standing authority, not a new user approval.

Both V9 collection arms are now terminal exit0. Parent inspected raw exit files,
terminal receipts and both populations: six modules and six exact selected
names, no extra active tests, suite errors or unhandled errors. Live-process
inspection confirmed no remaining collection runner. This establishes collection
scope only; selected rows are pending, not runtime passes. D next receives the
sole slot for corrected canonical and unchanged thirteen-file scoped TS7.

### C — Complete the dormant construction prerequisite

Own only `src/linked-provider-construction.ts`, its 27-control test file and
its handoff in the managed-constructor worktree. Preserve the frozen first source.
Prepare exact source/test typechecks and full controls; execute only after A
returns the slot. Correct demonstrated failures without weakening no-start,
actual Module-to-Instance ownership, copied-input, same-bytes/different-occurrence,
setter noninvocation, partial failure and disposal controls. No active caller
wiring, parallel artifact schema, exports-by-name authority or lifecycle-adapter
replacement is authorized by this prerequisite alone.

October 2 first construction validation is terminal and green on its pinned
`349eab3` basis: canonical TS7 (59863) and supplemental TS7 (6009) exit 0;
full controls (6576) exit 0. Parent inspected JSON: one file, 27 distinct names,
27 passed and no other statuses. Source/test hashes remain the frozen originals.
This is not current-main composition or an active managed graph. The receipt's
"user slot transfer" wording denotes the integration owner's grant under standing
user authority, not a fresh user approval; preserve the first receipt with this
clarification instead of rewriting it.

Current-main source audit found no add/add constructor conflict, but transplant
acceptance must use recgroup ABI3 (not recovery's ABI2), and later graph release
must preserve the original root-import object as decoder-project identity.
Snapshot import objects or latest-project fallback are not substitutes: validate
two interleaved live projects against their own raw provider export owners.
Existing provider construction orders setter, initializer, decoder registration,
exposed wrappers and namespace publication; move that release only after all
graph bindings, preserving its internal order. Keep root initialization caller
owned. The separate package-linker signature-validation instantiation path must
join the same ownership design before claiming complete coverage.

A's physical FunctionReservation proof and C's copied-byte engine Module are
still disconnected. Implement the planned producer-to-final-byte association
before selecting bootstrap exports; names/no-start alone cannot authenticate it.
Join by explicit instance occurrence, not artifact hash, namespace or sorted
array position. Required composition evidence includes unchanged C27/A33, current
owner suites, ABI3 acceptance/ABI2 refusal, actual provider-start rejection,
root/reverse allocation supply and identical-byte distinct-instance identity.
No release API or adapter retirement is authorized by a dormant transplant.

### D — Reconcile the existing #5883 checkpoint with current main

Read-only merge-tree of checkpoint `32c2da6488` and main `2bfe3eddf8`
identified only `scripts/compiler-boundaries.json` and
`src/codegen/promise-combinators.ts` as textual conflicts. Main changes the
observable Promise code that the checkpoint extracted; do not choose either
whole file or reintroduce duplicate emitters. In a separate integration worktree,
map each incoming semantic hunk into the extracted owner, retain main's dynamic
Promise-method behavior, preserve exact published fixtures, and reconcile the
inventory without relaxing classification. Review also automatically merged
call-namespace-static and promise-custom-combinator callers for stale contracts.
Provide per-hunk provenance, exact changed paths and proposed regression commands.
No tests, hooks, commit, push or hold removal until the integration owner grants
the slot and reviews the composition. Preserve the working issue updates in the
recovery checkout; do not edit that checkout from this assignment.

Source composition has been reviewed. The five production/inventory changes
preserve main's extracted Promise owners; eight separate additive controls cover
aggregate Resolve and overridden prototype-then behavior. Original fixtures stay
unchanged. The bounded manifest declares 376 existing plus eight additive controls;
these are source counts, not measured results. Three historical suites have an
exact-main paired population of 273 declared controls; equal failures prove only
preservation, not positive equivalence. After A and C terminated, D received the
sole execution slot for two TS7 checks, scoped format check, inventory and full
boundary checks only. Preserve all five first outcomes independently. Runtime
validation, publication and hold removal remain subsequent integration decisions.

A later remote read and fetch found main `e473d92460`; its delta from the
measured basis touches DOM containment, runtime, one inventory record and npm
benchmark artifacts, not the five Promise owners. Do not change a running
measurement subject. Reconcile this delta after the first bounded checks and
before publication, retaining both main's removal of the runtime-containment
inventory record and its runtime implementation changes. Earlier results remain
explicitly pinned to the `2bfe3eddf8` composition.

First canonical source TS7 failed with ten TS2459 diagnostics: incoming class
receiver and species callers require four declarations that the composed
`promise-combinators.ts` leaves private. Current main explicitly exports
`CustomCapabilityRuntime`, `buildCustomCapabilityExecutorInstrs`,
`customCapabilityTypeError` and `ensureCustomCapabilityRuntime`. After the five
frozen checks terminate, restore only those four export modifiers; retain their
existing bodies and all original callers. Preserve first diagnostics and rerun
the source check against a newly pinned corrected subject before runtime tests.
The scoped test project also reports BufferSource/instantiate typing errors in
historical fixtures and the new additive control. Preserve historical fixtures
and compare the identical project on exact main before attributing those errors.
For the new control only, copy emitted bytes into an ArrayBuffer-backed Uint8Array
before WebAssembly.compile, preserving the exact byte sequence and assertions.
Archive its original source separately. Do not weaken the test project or cast
away the mismatch. Formatting changes, if needed, must remain scoped and retain
the pre-format source and first output.

All five first checks are terminal with unchanged subject pins: source TS7 exit1,
scoped-test TS7 exit1, format exit0, inventory exit0, complete-boundary exit1.
Inventory measures 1,783 tracked modules, four unknown edges, zero unresolved
edges and 13,050 forbidden edges; it explicitly reports architecture incomplete.
Inventory validity is not complete-boundary acceptance or retirement evidence.
The export correction is required before runtime validation or publication.

The parent subsequently inspected the working repair: exactly four export
modifiers were restored, with no helper-body changes. The new additive test
now compiles `Uint8Array.from(result.binary)`; its assertions remain intact.
Those source corrections are approved for revalidation, not yet measured.
Pair historical typing using identical twelve-original-test projects on exact
main and candidate; check the additive control separately, without suppressing
or casting away type errors. Keep both original thirteen-file failure evidence
and all original fixtures. D remains source-only while B owns collection.

B has since returned the slot with both actual tool handles terminal (76310,
32502, exit0). D now owns serial execution: corrected canonical/full13 TS7,
then the reviewed runtime manifest if canonical source TS7 exits0. Runtime
measurement is allowed despite independently preserved historical test-typing
errors; this does not accept or suppress them. Pair identical twelve-original-
test projects on exact `2bfe3eddf8` main and candidate. Stop on infrastructure
failure, preserve semantic failures, and do not change the measured source.
The first runtime JSON inspected by the parent reports the dynamic-then suite
9/9 passed, zero failed or pending, one expected file. This is only the first
suite; remaining runtime files, baseline comparisons and broader regressions
are unproven. Remote PR remains held at `32c2da6488`, main remains `e473d92460`.

Second-pass terminal receipts now confirm canonical TS7 handle46562 exit0;
full13 TS7 handle76057 exit1 with the same sixteen historical diagnostics and
zero production/additive diagnostics; runtime handle98019 exit0, 9/9.
Before step7, baseline preflight stopped with Git exit128 because whole-tree
diff invoked the unrelated acorn.wasm LFS clean filter in the sandbox. No step7
test launched. Preserve this infrastructure failure. Resume using targeted exact
main/index byte checks for measured sources/configs/tests/141 fixtures, without
changing LFS configuration or the asset; do not restart successful step6.
The remaining serial validation grant is renewed on that corrected preflight.

Resumed runtime manifest is terminal through step23. Candidate collected and
passed 136 original plus eight additive controls (144/144); the 33-control
ownership suite passed on both exact main and candidate. Two original historical
suites failed before registration on both arms: 216 earlier-main declarations
at `builtin-static-globals.ts` dependency mismatch, and 24 export declarations
at `promise-class-receiver-drive.ts` dependency mismatch. Those 240 cases are
uncollected, not zero failures or passing coverage. Both arms' first messages
match. Identical twelve-original-test TS7 projects exit1 on both arms with sixteen
diagnostics; parent `cmp` of complete stdout is equal. All fixtures remain
unchanged. These are inherited-failure comparisons, not a waiver or complete
equivalence. Broader original source/settlement/equivalence suites and latest-main
composition still precede protected-queue acceptance. Prepare the checkpoint
with its hold intact; do not retire old code or claim full migration completion.

Broader original-file validation is running on the same frozen composition.
Early results: generic capability 2 passed/8 pending (not 10 passes), settlement
19/19 passed, boundary instrument 125/125 passed. Delay source preservation
measures 64 passed/81 failed of145 on both main and candidate; resolution
preservation measures 22 passed/30 failed of52 on both. Parent compared every
row's full name, status and full failure messages after only checkout-root
normalization: zero differences in all145 and52 rows. Preserve those failures
and fixtures; matching failures are not positive preservation proof. Remaining
Promise combinator/string/value/double-wrap/equivalence suites are unproven.

The broader eleven-file batch has now completed: 401 collected, 280 passed,
113 failed and eight existing pending cases. String combinators12/12,
value-slot representation5/5, double-wrap6/6, Promise chains8/8 and IR Promise
slice11/11 all pass. The remaining two failures are the original host-backed
Promise.all/race35-second timeouts: the eight test rows and full failure stderr
match main after only checkout-root normalization. All113 broader failures have
thus been paired with identical original-main failures; the eight pending cases
remain pending, not passes. No fixture, assertion or timeout was changed.
This supports publishing the reconciled checkpoint with its hold, not clearing
the outstanding semantic/bootstrap requirements or full-IR retirement gates.

Host-timeout follow-up plan (source preparation only): preserve the unchanged
eight-case fixture and both first timeout receipts. Test the source-backed
missing-instance-wiring hypothesis with three explicit arms: original pinned
main, narrowly wired pinned main, and identically wired candidate. The only
repair is genuine `imports.setInstance(instance)` after the two original
Host.Source instantiations, before calling their exports. Do not add initializer
calls, change compiler input strings/assertions/35-second limits, or hide cases.
Use a separate instrument with a pinned original fixture and exactly two verified
insertion sites; never rewrite the fixture on disk. Run all eight original cases
under identical configuration, recording compile/instantiate/settlement phases
where observations can be added without replacing runtime behavior. Require
exact repaired-baseline/candidate outcomes and positive expected [1,2,3]/10
values, not equal timeouts. An otherwise identical no-wiring control attributes
any improvement. If wiring does not discriminate, reject the hypothesis.
The original full suite stays unchanged; no repair is accepted before execution
and source review. This probe does not introduce a new lifecycle adapter or
activate the pending managed graph.

### Integration dependencies and acceptance

Current-main preparation seam (verified at `2bfe3eddf8`):
`PreparedIrProgram` in `src/ir/program/prepared-contracts.ts` already owns the
complete inventory, derived units, ABI snapshot, startup sequence and allocation
snapshot. `src/ir/analysis/contracts/allocations.ts` distinguishes live, aliased
and retired allocation entries plus explicit metadata. The existing
`assertPreparedIrProgram`/allocation validation must validate each prepared node
before graph roles are projected; do not create an alternative partial inventory.
`preparedIrProgramOwner` is diagnostic source-location lookup, NOT a receipt
issuer or proof of backend ownership.

The next graph-planning slice must take validated preparation for every occurrence
(providers and root) before the linker provider/cache loop. Project live vector
allocation IDs and their verified semantic/storage/layout contracts into one
canonical role set; resolve aliases through existing allocation provenance and
retain retired/missing/unknown entries as explicit diagnostics rather than
silently omitting obligations. Two occurrences of one prepared program remain
two suppliers. Derive semantic startup order from prepared startup and dependency
records, not alphabetical node ordering or emitted export discovery. Persisted
graph data carries no physical reservation tokens; backend owners join exact
logical roles to reservations later. The graph key excludes final artifact hashes
and relocatable indices. Cache lookup must happen only after this complete key
exists. Do not double-compile sources merely to discover allocations.

Required preplanning controls: actual prepared root/provider inputs; aliased and
retired allocation cases; missing metadata and explicit undefined distinguished;
duplicate occurrence/role rejection; same bytes at two occurrences; reverse and
receive-only nodes; dependency/startup order; changed root layout changing every
affected cache identity; partial population and copied receipt rejection. This
slice is not yet dispatched because logical layout-to-domain mapping and the
existing preparation owner must be agreed with the active IR preparation work.
Do not make structural `sealed`/`reconciliation` fields sufficient admission.

1. A and C validation precede composition; B is independent source work.
2. Plan graph allocations before artifact hashes, using existing IR preparation.
   Preserve manifest V1 behavior while adding an explicit V2 through the same
   ownership model for provider and root. Both optimizer paths need producer-owned
   final-byte reconciliation; a hash, name or private wrapper of caller data is
   not sufficient. These shared seams remain architect-owned until specified.
3. Build init guards before once-only physical fill, verify deferred startup,
   then bind every graph node including reverse/root slots before any user init.
   Preserve original setter/decoder order and caller-owned root initialization.
4. Implement the native/static driver and actual DCE-retained edges, then migrate
   every construction path including compile-time signature validation. No
   host-only or source-eligibility waiver substitutes for this requirement.
5. Complete semantic services, private-slot exclusion and producer/consumer
   closure. Preserve original failures/fixtures and require exact equality with
   the narrowly repaired baseline under the approved three-arm comparison.
6. Land only justified non-draft PRs through protection, verify contents on main,
   refresh dependents after delivery. Old compiler remains until the complete IR
   path is implemented and equivalent. PR #6195 remains held pending substantive
   replacement; do not disguise its adapter-size failure with a budget waiver.

Only one local compiler/test/typecheck/hook owner at a time. A owns the initial
bounded validation grant; B and C are source-only until explicitly handed the
slot. Agents must report process handles and return the slot on terminal state.
Do not kill, restart on observation timeout, edit the shared root, install shared
dependencies, force-push or overwrite another task's work.

## Active sequencing amendment — standalone separation (2026-09-07)

The user now prioritizes the standalone WasmGC implementation and requires
frontend, pure IR, backend, Wasm physical/model support and generated runtime
concerns to have real folder and dependency boundaries. New host and linear
backend implementation is deferred; existing behavior and unfinished drafts
remain preserved. This priority does not remove the epic's full acceptance
criteria or declare the hybrid compiler retired.

Astra High specifies and independently reviews the implementation plan;
Astra Low native subagents implement isolated slices. Earlier cloud evidence
and standalone task drafts remain preserved; new implementation is coordinated
through native subagents under the user's 2026-09-07 direction. The coordinator
retains integration and publication. These assignments supersede older ownership
directions below without discarding their implementation contracts.

The [approved first dispatch](../agent-context/3518-first-boundary-dispatch-2026-09-07.md)
and [standalone layering plan](../agent-context/ir-standalone-wasmgc-layering-plan-2026-09-07.md)
were published in PR 5730, merged as
`9b0358ec7d373034de6ff524eae286a50aaf2a4e`. D0 introduces an exact source
inventory and a dependency checker, including type-only paths and independent
base-policy comparison. F0 extracts the shared identity/source-origin
foundation while retaining compatible old imports and one canonical brand
declaration. Implementations may proceed in parallel; publication requires
their composition and validation.

`check:compiler-boundaries` is the full-separation check and must still fail
while migration debt remains. CI's explicitly named inventory mode enforces
nonempty activated boundaries and preserves its report; a passing inventory
does not certify IR-only production execution. The existing cutover and
dead-export checks remain unchanged. Further backend/runtime moves require
reviewed dependency removal, not relabeling or test-only callers.

### Approved extraction evidence amendment — 2026-09-08

The user approved separating moved-caller preservation from retirement proof:
**“Yes—separate preservation from retirement proof.”** The new rooted auditor
found two actual nonliteral imports, in the optional Binaryen loader and the
platform dynamic-import callback. Both remain unresolved in strict evidence.
Their supported inputs and runtime behavior are not restricted to manufacture
a closed graph.

The [two-verdict contract](../agent-context/3518-open-import-preservation-contract-2026-09-08.md)
permits the N1 extraction check to use six resolved real-caller witnesses with
exact, reviewed provenance for those two open sites. It preserves the strict
failure result, all unknown rows, missing-consumer failures and the ordinary
dead-export ratchet. Additional unknowns still fail preservation. A passing
preservation check is not retirement/deletion authorization; every acceptance
criterion below remains open until independently proved.

The [N1 validation checkpoint](../agent-context/3518-native-foundation-validation-2026-09-08.md)
records actual code, focused execution and byte/order evidence. The next
[canonical ABI seam](../agent-context/3518-program-abi-seam-dispatch-2026-09-08.md)
removes a real frontend dependency from the existing program authority without
replacing the producer or modifying the preserved P/C drafts. These are
intermediate checkpoints, not a new public compiler mode or completed cutover.

Foundation PR 5733 landed at `fa9e1ea0c7986b53f290e88822b262ab10ca62f4`;
the published F0 head is verified in upstream/main ancestry. The isolated ABI
draft has 59/59 tests and typecheck passing, with parent composition and artifact
parity still pending. The [lowering-cycle proposal](../agent-context/3518-lowering-cycle-plan-2026-09-08.md)
was dispatched as the bounded checkpoint below. Neither is direct-codegen retirement.

### Lowering-cycle implementation checkpoint — 2026-09-08

The Astra High [lowering-cycle plan](../agent-context/3518-lowering-cycle-plan-2026-09-08.md)
is implemented by the existing Astra Low native agent, with parent-owned
integration and controls. The new authoritative claim is
`3518:lowering-cycle-separation`, owner
`ttraenkler/codex-astra-lowering-cycle-20260908`, write ID `33574-pj5u0k6s`.
The old linear handoff PR 5618 was verified merged at
`e204b64fc810e1cb359f0530dfd7c1c4ec461258`, with its exact head in main's
ancestry. The earlier recorded Luna stand-down and parent integration scope
were reconciled. Historical claims and all P/C/ABI drafts remain untouched.

Generic lowering now lives in `src/ir/lower-generic.ts`; concrete Wasm assembly,
constant instructions and resolver/result contracts live in three explicitly
named backend modules. `src/ir/lower.ts` is an explicit compatibility facade.
All eight original runtime exports retain object identity. Generic lowering
still requires its emitter/converter and no longer imports the concrete
emitter, convenience wrapper or facade. The measured bounded value graph has
17 modules/19 edges, including all 12 direct dependencies; negative controls
inject reverse, unknown, unresolved and unparsed edges. This does not certify
resolver callbacks, pure IR types or the whole compiler's closure.

The 4595-line original splits into 4193 generic, 313 contract, 90 wrapper,
31 constant and 22 facade lines: 4649 combined, a 54-line scaffolding increase.
Three additional import-splitting lines in consumers give net source growth
of 57 lines. All 22 named function-declaration bodies were compared unchanged;
the nested `emitInstrTree` arrow was checked separately. The function-budget
spans remain 2297 and 3380 respectively. Exact braced-body SHA256s are:

- `emitInstrTree`: `75c0cceb6224dda24e892bcc5433532f10985c863b09fd4ae4245037811a2424`.
- `lowerIrFunctionBody`: `ed92c0a576009ab30571152c9b01dfc6caf19a2e2ca3dfb436edef32b4436739`.

Only the existing issue's one file allowance and two function allowance keys
move to the new canonical path; old allowance keys are retired. Neither budget
baseline nor checker is changed. The initial-relocation test verifies exact
bodies/spans, unchanged baseline contents and the one-for-one allowance map,
and fails if the comparison base is unavailable. It explicitly skips this
initial-only receipt after a canonical lowering implementation already exists
at the comparison base; the ongoing raw-emission controls remain active.

The real pushRaw gate now requires all five resulting files, including in its
whole-tree and JSON modes. For the first split it compares generic lowering
against the old file using actual text diffs, including untracked destinations;
the facade and other new files receive no duplicate legacy-site credit. Later
changes compare canonical paths against themselves. All 60 current raw sites
remain (10 tagged, 50 untagged), with zero added sites. The old fallback ceiling
of 82 untagged sites is unchanged, not reseeded upward or silently reduced by
the move. Missing destinations, new untagged sites, count-neutral replacements,
duplicate facade sites and incomplete coverage metadata are negative controls.

One test-only write-map amendment repairs an existing bytecode call fixture:
`tests/ir-bytecode-proof.test.ts` used a target with no required binding.
The parent reproduced its exact `binding.kind` failure on clean foundation
`d71fab8b9565ad3a2bb567ed82f22e8750e804a4` (one selected failure, 22 explicitly
skipped), before integrating `irUnitFuncRef(irIdentities.next("add"))`.
Its resolver and exact `LOAD 0 / LOAD 1 / CALL 1 / RET` expectation remain.
The original existing cohort is now 45/45, while new lowering/relocation plus
retained pushRaw controls are 57/57; no tests are hidden from those counts.
After syncing the artifact-only main update `120cd638cf2a971934eaaccf47aaf65f06491f3d`,
the final combined gate/boundary/self-host cohort passed 101/101: those 57
controls, all 42 existing D0 controls and both existing self-host producer tests.
Typecheck and both source-size gates pass. The six N1 production witnesses
remain 6/6 full and 6/6 with the legacy handlers cut, while both nonliteral
imports and the strict closure/retirement failures remain visible.

Exact local paired evidence uses Node v22.23.2 + tsx, unoptimized standalone
WasmGC: clean N1 head `36ea5ce9f54190c1f2c7af0466cf768afb453394` versus that
source plus this split composed on `b46055f4fefc817368095afbfe1a9b85d72b3082`.
Incoming main commits changed only artifacts and the existing LOC dashboard.
The public IR branch/loop fixture has identical full bytes, WAT, imports,
exports, string pool and results `[7,-2,-7,0,0,10]`: 22707 bytes, SHA256
`80e45e15ecaa4a83a9319595b0e04236a6865814ae0baf806e86b69982c9706f`.
The real `emitSelfHostedFunc` producer/registration/lowering fixture preserves
the complete function/type/global/ordinal order and results `[42,0]`: 114
bytes, SHA256 `67b02ec78d47fe382c9c2815d1cd42d1ebe472dcafc0d1fc77c5c8f7490cc388`.
Both modules validate and instantiate with zero imports. This is not an
optimization-enabled or full-conformance result.

The composed D0 inventory covers 1248 modules, retains six clean modules and
all older debt, and observes 9770 resolved edges (2502 type-only/7268 runtime),
four unknown edges and zero inventory errors. All four new lowering files
remain explicitly unmigrated/mixed; removing this cycle does not promote them
to certified pure modules. Complete architecture remains false.

### Generic-lowering main compatibility handoff — 2026-09-10

Local no-commit integration of PR 5738 head
`c257b46620fb4996bf5233763b80298c1fd03dc6` with main
`1429cfdf2167f31532d70c5304430a9300c2a982` reconciles only the LOC allowance
conflict: retain `lower-generic.ts`, `core/nodes.ts` and `runtime/manifest.ts`
under `src/ir/`, preserving the other allowances without budget increases.
The first focused run passed 139/140 tests: its old exact graph count expected
17 modules/19 edges, while main's canonical core/analysis paths yield 21/24.
The reviewed delta adds five reachable canonical modules and removes the
compatibility `ir/identity-values.ts` path from reachability, with eight added
and three removed edges; changed reachable source blobs are exact main blobs.
The compatibility test now pins all 21 module identities and all 24 ordered
edges, retaining the original 12 direct-edge assertion, shared identity witness,
all forbidden/unknown-input rejection controls and fresh-process execution.
No production source, checker or baseline is changed by this follow-up.

The original failed log, before/after graph and blob proof remain preserved in
`/private/tmp/js2-5738-conflict-repair.q0RndK/{focused-tests.log,assessment.json}`;
the failed log SHA256 is
`a4e0a986526d440e7b22633b2104b2b35dfca3ca682410f3a67579d8583b6650`.
The identical seven-file cohort rerun passed **140/140**, zero skips, exit 0
(Node 25.9.0, Vitest 3.2.4, one fork, 2048 MB fork heap, 42.85 seconds), with
`LOC_GATE_BASE` pinned to the exact main above and ordinary integration
dependencies. Its separate log is `focused-tests-exact-graph.log` in the same
directory. Formatting and main-relative whitespace checks pass.
This bounded compatibility repair does not clear the historical host-regression
hold, certify complete architecture or replace cumulative validation.

### N1 landed CI incident and publication hold — 2026-09-08

PR 5735 landed as `b9a67c10b4b06cabcc020e0dea1dfa105267661e`; its published
head and exact source/gate/test content were verified on upstream main.
This is **not a clean CI landing**. Its [actual merge-group regression job](https://github.com/loopdive/js2/actions/runs/34167945399/job/101885705677)
failed at 23:10:38 UTC September 7 with 20 host pass-to-fail transitions: 18
Temporal and two BigInt typed-array tests. A hold label was applied at
23:10:56, but the merge bot landed it at 23:12:42.

Read-only inspection found that ruleset 16700772 uses `HEADGREEN`: only the
final cumulative head must be green. The subsequent metadata-only PR 5734
compared `b9a67c10...` to its cumulative head `b46055f4...`, selected no shards,
and received a [successful no-op regression job](https://github.com/loopdive/js2/actions/runs/34169177677/job/101886099044)
at 23:11:37. Its comparison excluded N1's changes. The parking helper adds a
label but does not dequeue. The evidence supports cumulative-head/path-filter
interaction, not an administrative bypass. Repository settings and CI have
not been changed; permission for a separate CI-safety PR has been requested.

The failing gate used cached foundation `fa9e1ea0...`, one artifact-only commit
behind its exact base `8b679f89...`. Direct comparison of that foundation's
run 34165082130 and N1 run 34167945399 artifacts reproduces exactly 20 host
transitions and zero standalone status transitions, with 48735 unique paths
per side per lane. No paired Wasm hashes are present in those JSONL records;
the gate's "with wasm-hash change" count is not positive evidence of different
binaries. The two downloaded CI Temporal providers are independently identical:
1701142 bytes, SHA256
`332629e79db0b0c3b7e773cb6bb34b4711a17d39ef8bf8cb5936184983eb7ff2`.

Bounded local follow-up used the actual bundled CI worker and honest original
harness, with fresh workers per row and the normal primary/strict sequence.
On both clean d71 foundation and published N1, both BigInt failures and three
representative Temporal failures pass, along with one non-BigInt typed-array
and one Temporal positive control: 14/14 variants per side, identical complete
binaries, imports and pools. Temporal uses each side's downloaded CI provider
and a verified warm cache hit. This samples five of the twenty failing paths;
it does not reproduce long-lived CI shard history, erase the CI failures or
establish their cause. The other fifteen paths have not been locally rerun.

The lowering checkpoint may be published non-draft for review, but must retain
an explicit hold until inherited host-failure attribution and safe queue
validation are resolved. Do not weaken a gate, waive these rows, claim IR
retirement, or treat the ABI compatibility question as approved.

### Source-free typed preparation — active checkpoint, 2026-09-08

The [typed-preparation implementation plan](../agent-context/3518-typed-preparation-checkpoint-plan-2026-09-08.md)
specifies the next connected step: detach source-produced IR and the complete
allocation snapshot, run preparation with explicit controls and owned state,
then preserve the existing source wrapper's diagnostics and observation lifecycle.
It incorporates Astra High's five-control, lossless-capture and exact A/B API
amendments. This is not a public-route switch or a clean-layer certification.

The coordinator verified claim `3518:typed-program-preparation-boundary` at
`ed53d4e1e9f4c9701212ed1d91957a5eebceefa0`; the new record is the only ledger change.
All 16 open PRs were scanned for the 18 owned source paths, including the complete
135-file large-PR page set; none overlaps. P/C drafts still match their recorded
fingerprints and remain untouched. Existing historical claims are preserved.

Two native Astra Low workers receive disjoint source and middle-end maps in fresh
worktrees from `6ff05f6b5a197f8d0423036f7d171888ff99bd40`. Astra High reviews the
integrated result; the coordinator owns shared docs, normal-hook publication and
PR shepherding. Heavy checks stay serialized at 2 GiB with one fork and no local
Test262 campaign. Every implementation checkpoint goes to a non-draft upstream PR.
The merge hold, two unresolved imports, full retirement criteria, pending ABI
getter decision and prohibition on new host/linear work remain unchanged.

Non-draft held PR #5745 carries the plan and B middle-end implementation
checkpoint: explicit controls, transaction-owned GVN counters with historical
reporting preserved, and IR-only async preparation. New focused tests pass 77/77;
typecheck passes. Four failures in 284 existing controls reproduce with identical
messages on the unchanged prerequisite (11/15 in the two failing files); they
remain documented, not waived. A's detached-input preparation and fresh-process
acceptance are a separate pending checkpoint. This does not complete retirement.

The B code checkpoint is `f10ce7aeef`. Its CI found three missing exact-inventory
records; the follow-up records them as unmigrated debt, preserving every prior
policy entry and gate. Inventory mode passes with all 1,259 modules counted;
complete mode still fails. A's admission repairs now pass 66/66 focused and
26/26 legacy controls with conditional High approval. The user has now resolved
the input contract: robust compiler handling of JavaScript source, with IR as
internal compiler-produced data rather than intentionally fabricated live
objects. All source robustness, invariant, losslessness and semantics checks
remain required. The coordinator copied the 15 frozen A files and independently
verified 12/12 public compilation artifact pairs. Composed validation now passes
169/169 tests and typecheck. The separate historical whole-program comparison
retains 28 pairs: all 16 prepared serializations and 10 executable artifact pairs
match; two raw error-stack differences are checkout prefixes only. Record
allocation still fails backend emission and vector preparation still refuses
on both versions; executed-allocation proof remains open. No failures are
waived. High approved held publication of the bounded implementation, not full
checkpoint/backend acceptance. Temporary comparison-checker hardening is still
pending and its earlier exit 0 is not treated as a blanket equality verdict.
The linked plan records exact source censuses, the relayed decision, integrated
inventory/caller evidence and the frozen handoff. Complete architecture still
fails, and the two strict nonliteral imports remain unresolved.
Published B inventory checkpoint `247f5d0110` has 29 passing and 14 skipped CI
checks, no failures or unresolved reviews. The existing merge hold remains.

### Complete semantic nodes checkpoint — structural checkpoint, 2026-09-08

Published non-draft held PR 5744 now includes caller-proof follow-up
`6ff05f6b5a197f8d0423036f7d171888ff99bd40` over structural checkpoint
`8429806b2abb6a9f04160471170a0659c94bd335`. Fresh CI completed with 29 successful
and 14 skipped checks, no unresolved review threads, and a mergeable head.
Neither checkpoint authorizes retirement or clears the existing merge hold.

The [Astra High full-node implementation contract and measured receipts](../agent-context/3518-core-nodes-checkpoint-plan-2026-09-08.md)
retains PR 5742 ancestry at `acfd3e37b8765c4c4788c1fa94718d62c60e473c`.
The non-draft held PR targets main to run the existing main-only PR CI; its
cumulative diff includes that parent until the parent lands.
It moves the complete semantic instruction/function closure, with prepared
function/module compatibility types remaining beside the existing authenticated
async runtime authority. This is not another helper-only slice and is not
prepared-program completion or direct-codegen retirement.

Two Astra Low native subagents own disjoint nodes/async/dialect and pure
vocabulary/identity source slices. The parent integrates the source, boundary,
kind, dialect and caller controls and publishes a single non-draft held PR.
Claims `3518:core-nodes-separation` and `3518:core-vocabulary-separation` were
verified on upstream's ledger, now `1aada624aa73f843511e7b4c41f84c0b9332490b`;
all 815 previously held claims are preserved. No old P/C draft was changed:
the 12-file P fingerprint remains
`ecb33cddf6a6d0049b5c6d4b8440a2d95415ae60bf7a108172c396dc62816494`,
and the five-file C fingerprint remains
`73665f99262a0bae9dac0b48e21c1cbd0c1ec247b39885fc087e826c2047e73f`
(SHA-256 of sorted JSON `{path,blob}` rows).

Integrated source/seam/dialect/boundary/kind controls pass 168/168 and typecheck
exits 0. Existing consumers pass 51/67; all 16 counted-string proof failures
reproduce identically on the untouched parent (same 29 test names, outcomes and
first error lines). No test is waived. All six paired standalone public compiler
programs, including allocation and a loop, match the parent byte-for-byte and
in WAT, descriptors, order, pools and outcomes; each validates, has zero imports
and returns the expected value twice.

The normal commit hook also caught an obsolete old-file declaration expectation
in the parent core-type seam. Its replacement requires the unique canonical
declarations and exact compatibility type forwarders; all 25 tests pass.

The actual dependency inventory passes with 1,256 modules, 18 clean, five
adapters, 1,233 unmigrated, 9,794 resolved edges, four unknowns and zero errors.
Seven verified canonical destinations are activated under unchanged dependency
permissions. Complete mode still fails. Exactly 174 kind-record path prefixes
relocate (116 nodes, 55 dialect, two intrinsic vocabulary, one string encoding);
reversing those and applying deterministic Prettier formatting recovers the
entire PR 5742 baseline blob `6b2be2d5b198b8df35b97e6fa14275c73d29c19b`.
No verdict, quote hash, counter or ratchet changed. LOC/function gates pass:
the existing nodes LOC allowance transfers to the canonical path, with no new
function allowance or budget baseline change.

N1's six and the prior ten core caller obligations still pass both full and
dispatch-cut paths; the dead-export ratchet remains exactly 25/25 and strict
closure still fails on the same two dynamic imports. All 134 existing caller and
open-extension controls pass unchanged. The new twelve-obligation
node execution gate is now implemented and independently approved for bounded
caller preservation. Astra High approved actual function-object
observations during public compilation instead of extending the incomplete
static class interpreter. Its dispatch-cut result must remain explicitly unknown
and its closure/retirement flags false. The composed gate observes all twelve
targets across six successful public compiler programs and passes preservation;
its older report is exactly unchanged after removing the one additive report
field. New calibration/admission tests pass 56/56, old caller controls pass
134/134, and typecheck exits 0. The reviewed follow-ups expand the new controls
to 82/82 passing: loader overrides, an owned-child deadline, implicit constructor
behavior and child-admission failures. The final package check passes, while the
final strict command still exits 1 on the same two imports. The explicit package
requirement and controls will be pushed to the same held PR. Astra High verified
the final hashes, receipts and unchanged older report, with no findings remaining;
no complete migration or retirement acceptance is claimed.

Structural head `8429806b2abb6a9f04160471170a0659c94bd335` completed 29 successful
and 13 skipped CI checks and is conflict-free. This does not clear the inherited
merge hold or substitute for the follow-up's CI.

PR 5743 independently finished green at `c2d900d4fa9811f3359c308369bfb2b4184e90a9`
with 29 successful and 13 skipped checks, no unresolved review threads and no
auto-merge request. It remains on hold: green PR-head checks do not resolve the
inherited N1 host-CI/merge-queue incident. No CI/ruleset edits, hold removal or
merge authorization are implied here.

### Core type construction checkpoint — 2026-09-08

The [Astra High core checkpoint contract](../agent-context/3518-core-types-checkpoint-plan-2026-09-08.md)
implements the next-core proposal published in PR 5741. Five canonical core
modules extract type construction/equality, shape contracts, symbolic references,
capability provenance and tag refinements. Old exports retain object/brand
identity. Instructions, functions, async/provider contracts and the full
`src/ir/core/nodes.ts` destination remain unfinished; `irValSigned` and
`isDynamic` remain unmoved with unproved production-caller obligations.

This independent checkpoint starts at upstream/main
`25b9a41c3828dfb403797003dc6b66c72a2547ba`. It does not silently incorporate
the held lowering PR 5738, ABI PR 5739 or startup PR 5741. Their source maps
are disjoint, but shared policy/issue changes require deliberate composition.
PR 5741's PR-head checks are now green and it is conflict-free; this does not
clear the inherited N1 host regression or authorize queue admission.

The added caller contract requires ten fixed canonical targets with class-free
full and dispatch-cut paths. N1 retains its independent six-target check, both
open-import receipts, unchanged dead-export baseline and strict closure failure.
Unused class methods, including nested classes and class expressions, cannot
become preservation evidence. The kind-neutrality record changes only the two
reviewed shape-citation file prefixes; all counters and verdicts stay fixed.

Publication remains non-draft on `loopdive/js2` with `hold`. The previous
N1 merge-group failure and cumulative queue-check safety decision remain open.
The separate ABI getter compatibility decision is also unanswered. No CI
workflow/ruleset changes, direct-main push, force push, public cutover or
retirement approval is part of this checkpoint. Focused validation receipts
are recorded below before publication.

Validation of the frozen source and composed gates:

- Astra Low: 77/77 focused tests (25 seam, 7 fnctor ABI, 6 class identity,
  4 class-type identity, 16 tag-domain, 19 dynamic-type); typecheck exit 0.
- Parent: 134/134 caller controls (29 additive core, all 39 original rooted
  audit and 66 approved-open-site controls), then 120/120 composed checks
  (25 seam, 15 boundary, 33 kind evidence, 5 existing stable-evidence,
  42 existing compiler-boundary controls). These cover 306 distinct tests
  across worker and parent, not 331 independent tests: the 25 seam cases repeat.
- Independent AST comparison: all 37 moved and 120 retained declarations are
  text-identical, with moved documentation preserved. All ten source blobs
  match the frozen worker. The normal commit hook rejected the test-only local
  name `constructor`; integration renamed it to `constructorIdentity` without
  changing its assertions or production source. Source delta is +61 LOC; largest moved function
  is 71 lines. No LOC/function allowance or budget-baseline edit was needed.
- Actual package preservation check: ten of ten full AND dispatch-cut core
  witnesses, excluding class-body visitation; N1 six of six in both graphs.
  Historical dead-export ratchet remains 25/25, with zero additions/removals.
  Two nonliteral imports remain unknown. Strict command exits 1;
  preservation exits 0; retirement/deletion remains uncertified.
- The actual dependency inventory has 1,249 modules: 11 clean, 1,234 unmigrated,
  four compatibility adapters. It resolves 9,765 edges (2,499 type-only,
  7,266 runtime), records four unknown edges and zero checker errors.
  Inventory exits 0; full completion exits 1 with architectureComplete=false.
  The canonical closure alone contains eight modules, twelve resolved edges,
  and only the tag-refinement equality import is a runtime edge.
- Kind evidence retains 85 instructions/terminators, three excluded references
  (88 anchored kind declarations), 55 neutral / 27 JS / three unresolved
  verdicts. Reversing exactly two citation prefixes recovers the original
  whole baseline blob; no count/verdict/evidence quote changes are accepted.

Standalone preservation uses the real public `compile` API, unoptimized WasmGC,
`experimentalIR:true`, `trackIrOutcomes:true`, Node v22.23.2. The clean comparison
checkout is `36ea5ce9f54190c1f2c7af0466cf768afb453394`, independently verified
source-identical to both original main `25b9a41c3828dfb403797003dc6b66c72a2547ba`
and the incorporated metadata-only refresh
`16498efb481cb022ee5c4dcc9bb137b6d4c91a50`. The candidate uses the ten frozen
source files. Five original scalar/vector/record/class/closure programs produce
identical complete binary bytes, WAT, imports, export order, string pools,
IR outcomes and repeated runtime values on both sides. All validate and have
zero Wasm imports. This is preservation evidence, not IR-only coverage proof.

Matched binary receipts (bytes; SHA-256):

- scalar: 22,604; `b1e14e671d61c47b1123965592c9ad09469849b320cd3bc4b892dd382989c7ee`
- vector: 50,209; `7111975b8af803999fc2b52af8c7be06d4463d26b15b37c151fbdf65a52ede33`
- record: 22,852; `a0191bb20c6065d57c2af104a1f060b73fde18727918da6b86f800e3699d1c1c`
- class: 22,903; `88562dac074b1f3df4689cea57cab1774a4dea21b06bfe97784e79941d304206`
- closure: 32,977; `468b0fc913eb7192725f91225476eafe2ee148279c06932ece3e61bd76240ed9`

Reproduction receipts remain in the integration worktree
`/private/tmp/js2-3518-core-types-checkpoint-20260908/.tmp/`: `core-extraction.mjs`
and JSON, `core-caller-tests.json`, `core-composed-tests.json`,
`core-reachability.json`, `core-strict.json`, `core-inventory.json`,
`core-complete.json`, `core-paired.mjs` and paired base/candidate JSON. None
replaces the committed executable controls. No local Test262 campaign ran.

## Historical execution plan — whole-program cutover (2026-09-05) — moved to the log (2026-10-02, #6796)

This section was moved verbatim to
[`plan/agent-context/3518-log.md`](../agent-context/3518-log.md) to keep this issue file
readable (repo hygiene, #6796). Headings, in order:

- Historical execution plan — whole-program cutover (2026-09-05)

## Product outcome

One source-language front-end builds typed IR. Backend choice happens below
that boundary:

```text
TypeScript/JavaScript source
          |
          v
  PreparedIrProgram
     /          \
WasmGC        linear
lowering      lowering
```

There is no production edge from AST nodes directly to either Wasm backend.
Runtime and builtin behavior remains shared implementation, but it is reached
through semantic IR intents rather than `compileExpression` /
`compileStatement`. Features intentionally outside the compiler's supported
language fail with a stable source-located `Unsupported` diagnostic; they do
not resurrect the direct path.

`PreparedIrProgram` is also the versioned, validated, losslessly serializable
handoff between frontend preparation and backend emission. Both backends
consume the same frozen program snapshot. Deserialization re-runs structural,
type, ABI, effect, and runtime-manifest verification before any artifact side
effect; it never reparses source, reselects features, or invokes a legacy path.

## Current truth (audited 2026-08-09)

The following measurements are independent and must not be conflated:

| Signal                                           |                  Current result | What it proves                                                         | What it does **not** prove                                                  |
| ------------------------------------------------ | ------------------------------: | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Playground function `body-shape-rejected` bucket |                           **0** | The narrow #2856 function corpus has no rejection in that bucket       | All source is IR-capable, strict mode is safe, or legacy is unreachable     |
| Playground module-level residual                 |              **1** before #3517 | The remaining measured initializer is the Algorithms `Map` initializer | Module init is compile-once or its legacy slot is dead                      |
| IR-first compile-once ceiling                    |         **441 / 1,568 (28.1%)** | The numeric/boolean allowlist can safely skip those legacy bodies      | Widening signatures can reach the remaining 71.9%                           |
| Adoption matrix                                  |       **18 / 58 rows IR-owned** | Those syntax rows have an IR implementation in measured configurations | Their legacy handlers are unreachable in mixed functions or at module scope |
| Front-end reachability                           | **59,676 legacy-only fn-lines** | Approximate final deletion opportunity                                 | Those lines are dormant today                                               |
| Runtime/builtin reachability                     |               **~47K fn-lines** | Behavior emission must gain IR-owned entry points                      | Those routines should be deleted with the front-end                         |
| Bounded host + standalone readiness              | **37/37 IR; 0 legacy in each** | Every measured playground terminal is prepared and compile-once in both lanes | Global runtime/linear/direct paths are unreachable or repository-wide IR-only is ready |

R0 is complete. After the #3522 cross-owner/Builtins transactions and the
#3523 Algorithms and Calendar function-plus-module-init transactions, the
bounded single-host playground gate is green at 5/5 entries, 37 terminal
units, 37 emitted IR bodies, 0 typed Unsupported outcomes, 0 Invariants, and 0
legacy bodies. All Algorithms and Calendar terminals now seal in exact
prepared components and compile once through IR. This is a bounded census,
not repository-wide strict IR-only readiness.

The #4577 Calendar checkpoint brings the matching standalone census to the
same 5/5 entries and 37/37 compile-once IR bodies, with zero legacy,
Unsupported, or Invariant outcomes, and promotes that bounded lane from
baseline-only to strict IR-only policy. Calendar's ten source terminals, seven
reusable callbacks, five nullable DOM globals, and exact DOM/interaction/clock
imports form one sealed transaction. This does not widen the denominator beyond
the five playground entries.

Additional blockers:

- The bounded WasmGC `classes.ts` component now prepares `main` together with
  all ten constructor/method/accessor terminals in one exact transaction.
  Explicit constructors bind their source unit to `_init`; one AST-free `_new`
  support wrapper owns allocation. Standalone `classes.ts::main` remains the
  explicit ambient-console selector boundary, while implicit, externref-backed,
  unsafe-super, forward-ABI, nested-class, and closure families retain the
  typed direct route until their complete transactions land.
- #3523 now gives Algorithms' exact host `const Map<K,V> = new Map()` and
  Calendar's gap-free initialized lexical sequence source-qualified
  compile-once ownership. Broader statements, classes/statics, live seeds,
  deferred/standalone/WASI startup, and multi-source module shapes still need
  the complete ordered R4 contract; these bounded routes are not evidence that
  generic `__module_init` compilation is dead.
- Multi-source/M0 is a per-source, post-legacy overlay; fast-mode multi-source,
  class members, module init, and IR-first body skipping are incomplete.
- Physical standalone reachability is not retired by the green bounded census:
  public direct toggles remain; non-prepared single-source units still enter
  `compileDeclarations`; multi-source is direct-first; and CJS, nested
  function/class/expression, IIFE, dynamic-code, fast, WASI, and linear roots
  retain direct AST-to-Wasm entry edges. R9 must first make the complete
  standalone program denominator fail closed; R10 then proves and deletes dead
  direct reachability without removing shared host/WASI behavior.
- The linear backend still has direct AST-reading paths and does not consume the
  same whole-program IR contract as WasmGC.
- The R0 typed gate has replaced substring-matched build-error policy. The
  bounded playground lane now passes its strict shadow with no legacy bodies;
  the wider authoritative class/module/multi-source/runtime/linear matrices
  remain the expected blockers to a repository-wide policy flip.
- The normal fallback gate now reconciles preliminary selector labels with
  source-qualified terminal outcomes. Its async-function bucket fell from four
  to zero with #4124; this does not claim that async methods, closures,
  `for await`, async generators, or AST planner deletion are complete.

## Terms used by this program

- **Claimed**: the selector predicts that a unit is lowerable. This is not
  evidence that it was emitted.
- **IR-emitted**: integration successfully patched a legacy-created slot. This
  is still not compile-once ownership.
- **Prepared**: typed IR, ABI, imports, runtime intents, and verifier results are
  complete before backend/body emission starts.
- **Compile-once**: no legacy body was emitted for a Prepared unit.
- **IR-only**: every source unit is Prepared or compilation terminates with a
  typed Unsupported/Invariant error; no direct body is available to demote to.

## Dependency spine

Every row is an independently reviewable landing. R1–R8 now have concrete
child issues; R9–R10 receive child issue IDs before dispatch. This epic owns
their order and acceptance boundaries.

| Slice                        | Outcome                                                                                               | Depends on                            | Exit evidence                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R0a — #3529 (done)**       | Restore typed-producer equivalence parity without weakening unknown-throw-to-Invariant classification | #3143; exposed by #3519               | 154 new compile failures return to the committed baseline through preclaim/typed Unsupported or true invariant fixes; no baseline expansion                     |
| **R0b — #3519 (done)**       | Typed `Prepared` / `Unsupported` / `Invariant` outcomes plus an honest `check:ir-only` readiness gate | #3143, #3529; informed by #2855/#3341 | No TypeMap or compile failures are skipped; `result.errors` and every unit outcome are accounted for; hybrid vs IR-only policy is tested                        |
| **R1 — #3520 (in progress)** | Source-qualified `IrUnitId` and a whole-program `ProgramAbiMap`                                       | R0                                    | Same-named units across files/classes cannot collide; signatures, globals, imports, types, exports, and synthetic units are planned once                        |
| **R2 — #3521 (in progress)** | `PreparedIrProgram` and prepare-before-emit compile-once pipeline                                     | #3520                                 | Prepared free functions never call legacy body compilation; the versioned validated program round-trips losslessly; unsupported units are decided before emission |
| **R3 — #3522 (in progress)** | Classes and class members are Prepared/compile-once                                                   | #3521                                 | Constructors, instance/static methods, fields, inheritance, wrappers, and type indices no longer depend on legacy body compilation                              |
| **R4 — #3523 (in progress)** | Module init is Prepared/compile-once                                                                  | #3521, #3522                          | One program-owned module-init unit replaces the compile-first/patch-later `__module_init` overlay, including top-level binding/TDZ/export effects               |
| **R5 — #3525 (blocked)**     | Whole-program single- and multi-source Prepared ownership                                             | #3520–#3523                          | Cross-file calls/imports, fast mode, collisions, module init, and class members use one `PreparedIrProgram`; no per-source overlay loop remains                 |
| **R6 — #3526 (blocked)**     | Typed semantic intrinsic/runtime-feature/host-capability contract                                     | #3521                                 | The ~47K runtime/builtin emission lines are reached from a frozen semantic manifest, never AST dispatch; families land in measured sub-slices                   |
| **R7 — #3527 (blocked)**     | AST-free async suspension plans and canonical Promise ABI                                             | #3522, #3525, #3526                   | Every supported async container uses one verified `IrAsyncPlan` and the existing frame engine; no AST callback/direct async route remains                       |
| **R8 — #3528 (blocked)**     | Linear consumes the shared Prepared program                                                           | #3525–#3527                          | WasmGC and linear receive the exact same program/ABI/runtime/async plans; `src/codegen-linear/` has no source-AST lowering path                                 |
| **R9**                       | Fail-closed IR-only default; remove escape hatches                                                    | R3–R8; #2949, #2952, #1373b, #3583   | Default policy is IR-only; hybrid demotion, `experimentalIR: false`, `JS2WASM_IR_FIRST`, `disableIrFirst`, skip allowlists, and compile-twice switches are gone |
| **R10**                      | Reachability-proven direct-front-end deletion                                                         | R9                                    | Re-run #3090 audit; delete the frontend-only fn-lines and dispatch roots; zero direct AST→Wasm reachability remains. **The ~59,676 figure is a July number that today's audit does NOT reproduce (85,609 across 107 frontend files vs 59,676 across 35) — re-derive before scoping; see `#3090`'s 2026-09-03 note**                                    |

R0a and R0b completed on 2026-07-21. R1 remains active while R2 production
preparation and the first R3 static-method transaction are now in progress.
The current cutover is deliberately component-local: sealed owners skip direct
body emission, while unsealed owners retain the typed hybrid route. R4 follows
R3 because its ordered plan consumes the class/static-intent census owned by
#3522. #3525, #3527, #3528, and R9 remain integration barriers rather than
parallel deletion opportunities. R9 also requires the explicit dynamic-value,
control-flow, async, adoption-owner, and broader-corpus coverage closure named
above.

### 2026-08-30 #4522 Math rollback checkpoint

This is a bounded pre-R9 retirement, not an IR-only policy claim. The temporary
per-method Math withdrawals used during the initial rollout are removed while
the exact ambient recognizer and target-capability boundary remain unchanged.
The production registry remains a 33-method contract, and the shared linear
legality boundary remains exactly 10/33.

The closed #4522 proof adds a literal 21-row method/arity/provider census with
42 host/standalone positive cells, 21 shadowed cells, 21 alias cells, 42
wrong-arity cells, and 21 provider mutations. It joins the independently
literal retirement population to the production registry and rejects missing,
duplicate, and synthetic foreign rows. Each positive cell uses the retained
global `experimentalIR: false` compile of the same source as an observational
direct oracle for runtime and public Wasm surface parity; it is not a production
fallback. Before the #1231 retirement, the #4522 R9 environment denominator
was fifteen readers: four global controls, the separately owned exact
mixed-primitive selector rollback, nine named Prepared cutovers, and the
default-on linear direct-backend escape hatch. Diagnostics, self-checks, and
codegen-only tuning remain separately classified. This full inventory stays
owned by #4522 until the R9 policy flip.

### 2026-08-31 #1231 object-shape rollback checkpoint

#1231 retires the one boxed-object representation escape hatch without changing
the selector, lowering, emitters, or any other R9 reader. The exact live
environment denominator is therefore now fourteen: three remaining global
controls, the exact mixed-primitive selector rollback, nine Prepared cutovers,
and the linear direct-backend reader. This is the bounded **15→14** transition;
it is not an IR-only policy flip.

## Program rules

1. **Typed policy, not message matching.** Expected capability gaps are
   `Unsupported`; compiler contract failures are `Invariant` with stable codes.
   Invariants fail in hybrid and IR-only modes. Unsupported units may use the
   old path only while the explicitly temporary hybrid policy exists.
2. **Prepare before emit.** A unit cannot be called compile-once when legacy
   body/declaration emission ran first and IR patched its slot later.
3. **Whole-program ABI first.** Source-qualified identity and ABI planning
   precede cross-file/class/module ownership; name-based patching is not an
   acceptable IR-only foundation.
4. **No telemetry blind spots.** TypeMap failure, thrown compilation,
   `CompileResult.success === false`, fatal `result.errors`, selector
   rejections, post-claim failures, unpatched slots, and backend legality all
   participate in the readiness verdict.
5. **No corpus-zero shortcuts.** A zero histogram is a regression ratchet, not
   proof that a reason is unreachable. IR-only readiness is fail-closed over
   actual compile outcomes.
6. **Runtime is rewired, not copied.** Shared coercion/string/object/collection/
   regex/async behavior stays single-sourced behind semantic IR intents.
7. **Optimizations migrate before deletion.** Every reachable direct handler
   must have its correctness behavior and optimization decisions inventoried.
   Each optimization needs an IR lowering/pass owner plus differential
   output-shape or performance evidence where semantic equivalence alone would
   miss a regression. An unmapped optimization blocks deletion; it is never
   silently discarded as cleanup.
8. **Deletion follows reachability.** No direct handler is removed until the
   new gate proves it unreachable in every supported policy/backend and the
   #3090 audit confirms the call edge is gone.
9. **One serializable backend handoff.** The prepared program schema is
   versioned and deterministic. WasmGC and linear accept the same verified
   snapshot; backend incapability is a typed pre-emission outcome, never a
   request to reparse, reselect, or fall back.

## Acceptance criteria

- [ ] `pnpm run check:ir-only` passes on the authoritative playground,
      equivalence-inline, cross-backend, multi-source, class, module-init,
      async, fast, standalone, and WASI matrices with complete unit accounting.
- [ ] Full merge-group Test262 is net-non-negative in JS-host and standalone;
      no shard may omit IR outcome or fatal `result.errors` data.
- [ ] Every supported source unit is represented in one `PreparedIrProgram`
      before backend emission; no class/module/M0 exception remains.
- [ ] WasmGC and linear consume the same IR and `ProgramAbiMap`; their only
      divergence is backend lowering/runtime representation.
- [ ] The versioned `PreparedIrProgram` serialization round-trips all semantic
      values, source identities, ABI/effect data, and frozen runtime intents
      without loss. Malformed or incompatible input fails validation before
      artifact emission.
- [ ] A differential backend-input fixture proves WasmGC and linear consume the
      exact same prepared-program snapshot. Backend incapability returns a
      typed diagnostic and cannot trigger frontend reconstruction or fallback.
- [ ] Unsupported source produces stable source-located diagnostics. There is
      no silent selector fallback, post-claim demotion, skipped-slot escape, or
      legacy catch path.
- [ ] The IR-only policy is the only production policy. All IR/legacy escape
      hatches and compile-twice switches are removed from public options, env
      handling, tests, scripts, and documentation. The env-var set to remove
      is the complete live #4522 `retire-at-R9` table, including both global
      IR switches and bounded multi-source cutover switches; do not hardcode a
      stale cardinality here. Diagnostics/self-checks classified keep there
      survive — consume that table, do not re-audit at flip time.
- [ ] `compileStatement` / `compileExpression` and the direct AST→Wasm handler
      graph are unreachable and deleted. The refreshed #3090 report records
      zero frontend-only survivors and separately records retained runtime/
      substrate code.
- [ ] The direct-handler retirement inventory maps every behavior and
      optimization to an IR lowering, pass, runtime semantic intent, or
      explicit Unsupported outcome. Differential Wasm-shape and performance
      gates show that deletion does not silently drop legacy optimizations.
- [ ] Equivalence, cross-backend, linear, typecheck, lint/format, loc/dead-
      export, full Test262, standalone-floor, and artifact-validity gates pass
      on the final merged result.

## Out of scope

- Treating IR-only as a promise that every ECMAScript feature is implemented.
  Explicit, typed unsupported diagnostics are acceptable; hidden direct
  fallback is not.
- Deleting runtime/builtin behavior merely because it is currently reachable
  through legacy dispatch. R6 must first provide IR-owned semantic entry points.
- Adding new language behavior to the direct front-end during migration.

## Dated records 2026-07-24 → 2026-09-30 — moved to the log (2026-10-02, #6796)

These 59 sections were moved verbatim to
[`plan/agent-context/3518-log.md`](../agent-context/3518-log.md) to keep this issue file
readable (repo hygiene, #6796). Headings, in order:

- Standalone-lane Implementation Notes (fable, 2026-08-15)
- Standalone-lane Test Results (fable, 2026-08-15)
- Review (Fable, 2026-07-24)
- Slice: standalone readiness lane + top blockers (fable, 2026-08-15)
- 2026-09-02 — R9 coverage-closure gap, measured
- 2026-09-03 — R10's audit discrepancy is ATTRIBUTED (the July tree was reachable after all)
- 2026-09-03 — is the R9 denominator representative? Measured, and the answer is no
- Completion audit — 2026-09-05
- Implementation Plan — 2026-09-05 — consolidate existing migration work
- Astra High continuation specification — 2026-09-07
- Physical vector checkpoint after PR #5763
- Promise resolution extraction after PR #5764
- Confirmed ordinary-thenable capture defect
- Native Promise resource checkpoint (2026-09-08)
- Capture-once Promise integration (2026-09-08)
- Native string literal and TypeError resources — 2026-09-08 checkpoint
- Native primitive-value checkpoint — 2026-09-08
- Native scanner dependency authentication — 2026-09-08
- Native argument-vector checkpoint — 2026-09-08
- 2026-09-12: resume existing PR queue, refresh frame extraction against main
- 2026-09-12: certified native-delay admission queue refresh
- 2026-09-12: logical vector and native-main lowering queue refresh
- 2026-09-12: full-family source preparation queue refresh
- 2026-09-12: native delay/combinator extraction queue refresh
- 2026-09-12: expanded recursive-type/callable checkpoint queue refresh
- September 13 refreshed source-family parent
- September 13 signed-parent reconciliation
- Implementation plan: join the existing scanner and prepared-main PRs — 2026-09-13
- Prepared/scanner receipt repair evidence — 2026-09-13
- Completed composed scanner/prepared validation — 2026-09-13
- Implementation plan: refresh shared native declarations — 2026-09-13
- Implementation plan: refresh vector backing refinement — 2026-09-13
- Implementation plan: refresh prepared native string consumer — 2026-09-13
- Queue admission reconciliation: current main — 2026-09-13
- Forward the validated main reconciliation into string admission
- Reconcile the refreshed main base e06f7674 — 2026-09-13
- Ownership reconciliation — 2026-09-13
- Resume string admission after verified PR5760 delivery — 2026-09-13
- Vector refinement delivered-parent refresh — 2026-09-13
- 2026-09-13 — PR #5794 refresh after native string consumer delivery
- 2026-09-14 — PR #5796 refresh after authenticated Promise closure delivery
- Removed string-call allocation repair (2026-09-14)
- 2026-09-14 — resume native string-output delivery after PR 5716
- 2026-09-15 — takeover, active PR blockers and descriptive Promise inventory
- Native timer publication contract extraction — 2026-09-14
- September 19 resume from freshly fetched main
- Implementation Plan — C1 native object key foundation (2026-09-19)
- 2026-09-27 B: actual prototype companion seeder recipe plan
- 2026-09-27 B: authenticated seeder descriptor binding
- 2026-09-27 B: compose the seeder adapter with signed singleton recipes
- 2026-09-27 B: first seeder measurement and bounded batch construction
- 2026-09-27 B: combined-base checks and normal-hook reporting failure
- 2026-09-27: publication blocked by numeric addition proof regression
- 2026-09-28: PR 6205 current-main integration and coercion-gate repair
- Claimed follow-up — builtin metadata preservation (2026-09-28)
- Claimed continuation — prototype-chain native bodies (2026-09-28)
- Native builtin function objects — implementation plan (2026-09-30)
- Shared invocation substrate implementation plan — 2026-09-30
- Public native object/Number graph implementation plan — 2026-09-30

Records from the 2026-09-30 mixed-object-access plan onward stay below.

## Implementation Plan — mixed object access and genuine public Number join (2026-09-30)

Astra reviewed the actual current graph and preserved Number sources; exact
brief SHA256 `2aeba58eda9d6c90d24b76be697f912df5144ebc2ec3310c0122ee9bf058cb73`. Its 48-input receipt recorded zero drift, with no
tests or source edits. The existing writer is implementing the exact four
paths below. Full public completion and the unchanged original nine rows
remain required.

# Issue 3518 — IR-only default and direct front-end retirement
# Next production dependency: mixed object access, then genuine public Number join

Read-only implementation brief, 2026-09-30. Root owns claims, tracked issue/inventory,
Git and integration. This file is analysis, not an implementation or validation
receipt. The graph's current source includes pending state/carrier and public
catalog declarations; those do not complete a public realm. The input manifest
beside this file pins the actual graph and preserved Number files used here.
No compiler, tests, gates, network operations or Git mutations were run for this
brief. Original failures and every preserved lane remain intact.

## 1. What actually fails, and what the next change must accomplish

The original unchanged public fixture is
`tests/fixtures/issue-3518-native-object-access-712.ts.txt`, SHA256
`c0550b99175c0eb61afa7d5d110a287f3fe90e9fc8e581c6d58a19fe0a971ba9`.
The unchanged nine-row suite is
`tests/issue-3518-public-number-object-712.test.ts`, SHA256
`afc3885f51522cec10d5eccac536636b104b9a01b8c5e5c139b8dbd5fef35d37`.
It creates a default-prototype object whose `valueOf` getter updates trace to 1
and returns a genuine capturing function which updates trace to 12 and returns
7. Its `toString` getter throws 99 and must never execute in the successful
conversion. `Number(object) * 100 + trace` must be 712 on repeated calls in two
fresh instances. `Number({})` is an additional inherited-default-method test;
it is not this fixture and replaces none of its nine rows.

Actual graph baseline: 5/9, with four native original/decoded UTF16/UTF8 rows
refused during preparation: `runtime feature js.number.from-value has no provider`.
See `.tmp/public-native-object-number-graph/baseline-vkacxnna/result.json`.
This occurs before public acceptance, emission or Wasm instantiation.

The cause is a missing canonical symbolic provider, not missing Number syntax:

1. `frontend/builtins/prepare-number-conversion.ts`, `ir/program-source.ts` and
   `ir/from-ast.ts::lowerPreparedNumberCall` already produce the real intrinsic
   `js.number.from-value : (externref) -> f64`. Accessor literals already produce
   ordinary-object descriptor operations and genuine source closure units.
2. `ir/runtime/number-conversion-callable.ts` has the semantic declaration and
   intrinsic support already recognizes its feature.
3. `ir/runtime/callable-declarations.ts` has no canonical Number provider row;
   `ir/runtime/contracts/manifest.ts` and `ir/runtime/manifest.ts` lack the
   corresponding provider ID. `RuntimeManifestBuilder.#selectProvider` correctly
   rejects the zero-provider result.
4. Merely registering that row would expose the later physical deficiencies.
   The preserved Number lane already gets that far: its same nine rows remain
   5/9 with seven reported materialization gaps. These are **three unique
   intrinsic functions** (`js.number.from-value`, `js.object.create-default`,
   `js.object.define-accessor`) plus four body references (one default create,
   two accessor definitions, one Number call), not seven different functions.

The next implementation is therefore the already planned **mixed object access
owner**, not a provider-registration-only checkpoint. It implements actual
cross-family own-property/prototype behavior and the Get algorithm, with honest
pending dependencies for unrestricted getter Call and complete descriptor
population. The eventual public Number provider must bind the completed whole
graph. No partial population, selected-property proof, source-demand fabrication,
host bridge or primitive-unbox alias may stand in for that graph.

## 2. Exact next ownership

The existing native graph writer owns only these four new paths for this step:

- `src/runtime/wasmgc/values/mixed-object-access-bodies.ts`
- `src/backend/wasmgc/resources/native-mixed-object-access.ts`
- `tests/helpers/native-mixed-object-access.ts`
- `tests/issue-3518-native-mixed-object-access.test.ts`

Root owns issue/inventory and grants any additional existing-file change. Do not
modify the bounded builtin kernel, default invocation, old ordinary lookup, the
original public suite/fixture, historical receipts, or prepared Number lane to
make these component tests pass. The existing state/layout/public declaration
owners are dependencies, not competing issuers. Do not silently add physical
coordination to `src/ir/` or import backend ownership into a pure runtime leaf,
even as a type-only dependency.

This increment can implement and authenticate complete structural access bodies
and the pure general getter algorithm now. A completed production getter Call
owner and full source/intrinsic own-property population do not yet exist; they
must remain explicit missing dependencies, not be replaced by a raw function
handle with a completion flag. Section 6 defines the reserve/bind/fill seam.

## 3. Pure body contracts and actual operand layout

Use repository `Instr`, `LocalDef`, `ValType`, `FuncHandle`, `TypeHandle` and
`GlobalHandle` types. Produce fresh `{ locals, body }` values. Pure operands are
physical instruction-generation data; they do not issue or attest ownership.
The backend derives them solely from authenticated reservations. Validate
own enumerable data fields before reading configuration, including nested rows,
optional presence and instruction trees; reject getter/inherited/hidden fields,
extra roles, sparse arrays, cycles, invalid handles/types/indices and malformed
instruction operands without evaluating callbacks. Do not weaken current pure
builder/config conventions to accommodate the tests.

Recommended fixed internal protocol, retaining the established distinction:

- 0 = proven absent, or semantic false for Has/SetPrototypeOf.
- 1 = present, or successfully resolved true/result.
- 2 = actual population/initialization prerequisite unresolved.
- 3 = unknown, foreign or unsupported carrier/edge (including corrupt cycles).

These are internal statuses, not JavaScript booleans. Do not implement Has as
`status != 0`. Use a distinct enum if the implementation needs finer internal
reasons, but preserve these semantic distinctions and test every terminal.

| Role | Actual Wasm parameters | Results |
| --- | --- | --- |
| own descriptor | object `externref`, canonical PropertyKey `externref` | `i32 status`, `ref null PropEntry` |
| prototype lookup | object `externref`, canonical PropertyKey `externref` | `i32 status`, `ref null PropEntry` |
| Get | object `externref`, key `externref`, original receiver `externref` | `i32 status`, `externref value` |
| Has | object `externref`, key `externref` | `i32 status` |
| actual GetPrototypeOf | object `externref` | `i32 status`, `externref actualParent` |
| internal SetPrototypeOf | object `externref`, proposed object-or-null `externref` | `i32 status` |

For actual GetPrototypeOf, `(1, null)` is a normal authenticated null parent;
`(2/3, null)` is unresolved and must not end a traversal as absence. For own or
chain lookup, status 1 requires a live nonnull entry. A null entry by itself is
not an answer. The public scalar Get adapter comes later: only status 0 maps to
genuine undefined, status 1 unwraps its value, and 2/3 cannot be published as a
successful JavaScript result.

Get has locals after parameters 0=object, 1=key, 2=originalReceiver, for the
entry (`ref null PropEntry`), getter (`externref`), status (`i32`) and a genuine
argument vector if needed. Consume multi-results in stack order: save the entry
first, then status. A live data entry returns status 1 and entry field 1 converted
from anyref. An accessor uses the canonical flag 8 and getter field 4. The
canonical missing-getter representation returns status 1 with genuine undefined.
Otherwise invoke exactly `Call(getter, originalReceiver, emptyArgumentVector)`.
No inherited property is consulted after a live entry, including a data value
of undefined or an accessor without a getter.

The adjacent mixed Call ABI is `(callee externref, thisValue externref,
ref issuedArgumentVector) -> externref`. **NewVector is `() -> externref`** in
`native-argument-vectors.ts`; apply `any.convert_extern` then `ref.cast` to its
issued carrier before passing the non-null typed vector to Call. Push is
`(vector externref, element externref) -> ()`. Never pass a marker struct or
confuse capacity 8 with an argument limit. Native lifted transport remains
`(ref closureRoot self, externref originalThis, ref vector userArguments)`;
algorithm slots receive `(originalThis, vector)`. Neither transport arity is
header user-formal arity or own `.length`.

All cursors, entries, receiver, status and cycle-tracking state are per-call
locals. Has never invokes a getter or reads the returned PropEntry value. The
String own-descriptor donor may read StringData while synthesizing its virtual
character descriptor; this is part of that genuine internal method, not an
accessor invocation. A getter reentering any of these
operations cannot overwrite the outer receiver/entry. Let its genuine shared
tag exception propagate unchanged; never rebox a payload, catch it as absence,
or replace it with TypeError. State restoration around source calls belongs to
the authentic mixed invocation owner, not ad-hoc writes in property lookup.

## 4. Exact family, own-property and prototype authority

The same extensible ordinary storage root is not an arbitrary-object admission
proof. Authenticate an issued concrete family and its runtime realm evidence
**before** bag, private state or payload reads. Dispatch rules:

1. **Public native functions:** use the public declaration entry's final type,
   exact metadata ID in field 4, runtime realm identity in field 6, actual
   singleton identity, and the expected lifted function type. Structural
   canonicalization can alias metadata families/types; `ref.test` alone is
   insufficient. Field 3 is mutable metadata state. Bag is field 2; actual
   prototype is field 5; immutable InitialName is field 7. Never return the bag
   as a prototype or recover mutable own name from InitialName after deletion.
2. **Unknown native metadata:** after known-native matching, recognize native
   metadata families and return unresolved for an unknown ID/singleton/realm.
   It must not fall through to a permissive source row merely because its
   transport function signature matches a source signature.
3. **Source functions:** use exact issued source shapes from the same combined
   closure pack and retained `nativeSourceClosureRealmState` owner, then compare
   runtime state realm identity. A root closure shape or equal signature is
   insufficient. Captures stay at 3+, state follows all captures (including a
   dedicated zero-capture final subtype), and bag stays at field 2. The existing
   source issuer enforces immutable fields after the header, disjoint from
   mutable native metadata; preserve that actual proof. A legitimate source
   with the same transport signature as a native function must still work.
   Do not attempt `ref.eq` on funcrefs as an invented function identity test.
   In this four-file checkpoint, a recognized source-shaped candidate remains
   status 2 before bag/prototype reads until authentic original source slot and
   allocation/lowering authority joins the production composition. The existing
   all-source callable association explicitly does not certify canonical IR
   lowering. Pure-body source fixtures may use actual lowered source slots, but
   cannot turn that fixture into a production completion grant.
4. **Genuine String wrappers:** match the issued stateful String wrapper before
   generic ordinary handling. State is field 7; payload remains field 6. Borrow
   `NativeStringOwnDescriptorReservations.findOwn` with exact wrapper, ordinary,
   String, Symbol, equality and flatten dependencies. This donor first calls
   ordinary own find, then synthesizes a virtual index descriptor. “String
   first” means family dispatch, **not reversing that own-property precedence**.
   Its virtual indices are enumerable/nonwritable/nonconfigurable; length is
   the actual seeded nonenumerable/nonwritable/nonconfigurable own property.
5. **Other primitive wrappers:** use exact issued stateful wrapper types and
   state realm. Their payload remains field 6, state field 7. Do not classify
   them by the ordinary root or treat a String wrapper as generic storage.
6. **Concrete ordinary objects:** match the issued final ordinary type, state
   field 6, and state realm identity. Read real own storage through the existing
   own finder. The six-field prefix's old prototype field 0 is not authoritative
   for these public objects, even if nonnull. State field 0 is their actual
   externref prototype; state field 1 identifies the realm.
7. **Object.prototype:** require the actual singleton identity from the same
   pending/public population owner and its issued final six-field subtype.
   Its actual prototype is null and immutable. An independently allocated
   same-shaped six-field object is not that singleton or a generic ordinary
   object. Its complete descriptors still require actual population.
8. Everything else is unknown until its genuine family owner joins: bare
   storage roots, legacy implicit-prototype objects, foreign states, arrays,
   proxies, bound/dynamic carriers not yet implemented, host objects or clones
   cannot be silently treated as empty ordinary objects. This is an explicit
   missing dependency of unrestricted public support, not an exclusion from
   the full migration goal.

Reuse `native-object-access.findOwn` and canonical hash/key-equality, not its
`lookup` or `has`: the latter follow ordinary root field 0 and preserve an
implicit-prototype status. Reuse actual PropEntry representation and descriptor
flags from `ordinary-object-descriptor-common.ts`; ignore tombstones, preserve
live presence and property order. String/Symbol keys are canonical inputs here;
ToPropertyKey is a separate real general dependency, not a host coercion hidden
in an equality helper. Symbol identity must use the authentic shared Symbol
carrier, not descriptions or an invented numeric ID.

Population is separate from carrier recognition. Current source allocations
start with bag 2 null, while source functions still owe own name/length and,
where constructible, prototype/other canonical properties. Current native
catalog declarations reserve null singleton slots and no standard algorithm
bodies. Null/uninitialized function bags and incomplete intrinsic own storage
must not prove absence. Within the scoped structural protocol an authenticated
live entry may report present; any own miss on an incompletely populated
source/native function or Object.prototype returns 2 before following its parent.
Actual GetPrototypeOf may resolve a separately authenticated parent without
claiming that the object's own descriptors are complete. The later
source/intrinsic population producer must seed all initial own descriptors in
canonical order before exposure, and its
exact allocation/initializer bodies must be part of full graph authentication.
A nonnull bag, global flag, count, supplied callback or catalog label alone is
not that proof. Reserve/build the access owner against pending identities now;
keep its missing population dependency explicit. The runtime initialization
guard, if emitted, uses the retained population owner's real state and is only
a guard; toggling it cannot certify a graph the compiler has not completed.

Traversal checks an own entry before asking for a parent, preserves receiver
unchanged, and terminates as absent only at an authenticated actual null link.
Do not inspect a more distant parent early: it may be unsupported while the
nearer object already supplies the requested property. No fixed depth cap.
Prevent malformed admitted-state cycles from hanging without adding observable
Get/GetPrototypeOf calls or returning absence; maintain call-local visited
identity state if necessary. Do not use lookahead that changes failure/order.
Future Proxy integration must implement its actual internal methods and abrupt
behavior; blindly applying an ordinary-chain walker to proxies is not a join.

SetPrototypeOf must authenticate target/current parent first, accept SameValue
of current and proposed parent even for a nonextensible target, then check
extensibility and the proposed actual chain before any write. Flags are real
ordinary storage flags (nonExtensible bit 1), not descriptor attribute bits.
For source/native functions, obtaining these flags requires authenticated
initialized bag storage, with no silent allocation or population substitution.
Reject self/indirect cycles, unknown or unresolved edges without mutation;
Object.prototype may only retain null. Check an already cyclic proposed chain
not containing target as well, so it cannot hang. Do not follow bag.prototype.
The later Object/Reflect API layer owns argument validation and conversion of a
semantic false result into the specification's return/throw behavior.

## 5. Backend ownership, authentication and physical indices

Recommended issued pack exposes the own/lookup/Get/Has/prototype function tokens
and an honest scope such as `mixed-object-access-structure`; a reserved Get
slot is not a completed Get capability. Derive all rows from real producers.
Do not accept caller-authored family arrays, runtime type IDs, population IDs,
getter handles, completion booleans or a copied public packet as authorities.

The structural dependency record retains these exact existing owners:

- public `NativeObjectRealmDeclarations` plus its exact expected dependency
  record, checked with `requireNativeObjectRealmDeclarations`;
- its realm requirements, common public builtin issuer, single combined closure
  owner/plan, state layouts/anchors, shared invocation substrate/vector owner,
  exception selection/tag, and optional genuine source type owner;
- exact ordinary own-lookup/storage dependencies, primitive wrapper layout
  dependencies (with that SAME state owner), and String own-descriptor owner;
- genuine native value/undefined and key String/Symbol resources as needed.

Validate nested dependency descriptors before invoking older authenticators
that read fields directly. Optional absent versus present undefined/null,
accessor, hidden or inherited is significant. Preserve original records and
identity snapshots, revalidate their data descriptors and currentness on every
require/fill/completion. A cache hit never bypasses this validation. Compare
same-ledger owners, layouts, source requirements and state, all shared string,
vector, key and tag dependencies; independently genuine but different owners
are not interchangeable.

Keep declaration/reservation/require/fill/completion/inventory phases explicit:
`declareNativeMixedObjectAccessResources`,
`reserveNativeMixedObjectAccessResources`,
`requireNativeMixedObjectAccessReservations`, structural canonical fill and
completion, and `nativeMixedObjectAccessReservationInventory` (names may follow
local conventions). The later getter binding is a separate single-use operation
against an authentic mixed invocation issuer; no public raw-handle binder now.

Authenticate all dependencies and the entire canonical declaration recipe before
calling `assertReservationKeysAvailable` with every key for THIS owner, and
before its first allocation. Test a collision on its last key. This proves zero
new mixed-access keys on refusal; it does not promise rollback of earlier realm,
String or substrate owners or continued access to an already-failed ledger.
Do not reserve during fill. Obtain all indices from exact issued tokens in the
appropriate phase. Types and functions are different spaces; imports/displaced
functions/globals must not change a captured type-ID association. Completion
checks the complete fresh canonical locals and instruction bodies, not only
`filled`, completed token status, body length, selected rows or matching ABI.

## 6. Real cyclic composition, with no fabricated completed Call

The four-path checkpoint has no genuine unrestricted mixed invocation owner yet.
Do not implement `completedCall: true`, accept a caller FuncHandle as an owner,
reuse selected Number/method0 demands, or create a fake source closure request.
Use this dependency order:

1. Existing public preparation derives current program/projection/catalog and
   real source requirements; supplements native literals through their genuine
   owner. Reserve the one canonical exception tag before imports close, shared
   vectors/TypeError, ordinary/String/wrapper/key/state prerequisites.
2. Issue public builtin requests before the sole combined source/native closure
   pack, even in a genuine no-source program. Reserve the real source unit slots,
   pending catalog declarations and structural mixed-access tokens, including
   the eventual Get slot. Existing public declarations borrow the sole realm
   and Function.prototype anchors; instantiate no bounded bootstrap kernel.
3. Fill the standalone structural access subgraph when its authentic leaves
   permit it; its scoped completion says nothing about getter dispatch or
   intrinsic descriptor population. Implement pure Get now and execute it with
   clearly labelled dependency observers in component tests. The production
   Get slot/completion remains pending until step 4 exists.
4. Adjacent implementation in the already planned new
   `mixed-invocation-bodies.ts` / `native-mixed-invocation.ts` reserves real
   generic Call/IsCallable/Construct/IsConstructor entries borrowing this exact
   access pack. Its own completion and source state remain with that owner.
5. Perform the sole freeze after all reservations. Bind all source callables to
   original consumer slots with `bindNativeRealmSourceClosureCallables`; this
   authentic association is unavailable during the earlier reservation phase.
   Bind mixed invocation to mixed access once, after checking the same public
   packet, state, source types/slots, vector, values, realm and exception tag.
   Fill pure Get from that real Call token and shared empty-vector constructor,
   then fill invocation and the canonical algorithm/source/population bodies.
6. Audit a finite explicit dependency graph after fill: both owners' canonical
   definitions, actual source lowering, every edge and whole catalog population.
   Do not recursively treat an already-visited or reserved owner as complete.
   A bodies-complete record can certify canonical code; only the whole-graph
   owner can certify complete public population and publish public bindings.

The current compilable owner exposes `fillNativeMixedObjectAccessStructure`
and `requireCompletedNativeMixedObjectAccessStructure` for the exact structural
subset only. Keep Get unfilled, with either an always-refusing
`requireCompletedNativeMixedObjectGet` or no successful getter-completion API.
Caller-filling that reserved token cannot bypass the owner's refusal. Expose no
raw-handle binder, caller authenticator or pending-source-matcher permit.

No type import from a nonexistent future issuer is required in this checkpoint:
leave its production Get bind/fill entry unavailable until the adjacent owner
is implemented in its own authorized paths. At that point extend this same leaf
with the typed one-use binding operation described above. The pure Get operand
contract and reserved token specify the concrete later join without minting
authority today. A module containing genuinely pending catalog/Get slots cannot
be sealed/emitted by filling them with test stubs; runtime body components and
production owner reservation/completion refusal controls remain distinct.

## 7. Exact component and ownership tests for the four paths

The helper must use genuine existing reservations, native storage, StringCreate,
wrapper/state owners, real vector constructors and emitted Wasm. Label imported
observer getter/Call functions as component dependencies; they do not prove a
public native module or a completed catalog. Do not fill 44 pending catalog
algorithm slots with stubs so that a whole pending module can be emitted.
Owner reservation/refusal controls can inspect the genuine pending packet
separately from pure-body executable fixtures. Component input constructors or
anchor setters must remain visibly test-only, with no production ready grant.

At minimum cover normal UTF16 and physically displaced UTF8, nonempty exact
family/row counts and actual Wasm values/identities for:

- ordinary own/inherited data; live undefined shadows an inherited value;
  getter-less live accessor shadows inherited getter; tombstones permit lookup
  to continue; redefine preserves descriptor semantics and observable order;
- genuine String wrapper length and canonical virtual indices, noncanonical
  indices/out-of-range/Symbol keys, UTF16 code-unit behavior including isolated
  surrogate, actual own-before-virtual precedence, String as a prototype;
- ordinary -> source -> native -> ordinary actual prototype chains; result is
  the actual function object identity, never its expando bag; inherited getter
  receives the original ordinary or explicitly supplied primitive receiver;
- data/Get presence distinct from null/undefined, Has invokes zero getters;
  exact call count, zero user args, supplied receiver unchanged, reentry into
  Get/Has/prototype operations, normal return and thrown payload identity;
- genuine zero/capturing source carrier shapes, native same-shaped metadata
  with different IDs, unknown/forged metadata, legitimate same-transport source,
  wrong realm/state/singleton/type and bare/unknown carriers. Wrong families
  must be rejected before their bag/state/private payload is read;
- incomplete intrinsic population and null/uninitialized source function bag
  stay unresolved; default/Object.prototype identity cannot be substituted by
  an ordinary root allocation, a bag, a clone, or a partial catalog owner;
- explicit actual null termination; unknown intermediate parent; self/indirect
  cycle, preexisting cycle not involving target, immutable Object.prototype,
  nonextensible same/different parent, no mutation after refusal; long valid
  chains prove there is no fixture-sized traversal cap;
- cloned/copied/foreign-ledger owners; swapped genuine shared String/vector/
  state/tag owners; stale source/realm/recipe/dependencies; inherited/accessor/
  hidden/extra/undefined/null fields with getter invocation counters zero;
  last-key preflight collision; wrong body AND wrong locals after completion;
  duplicate bind/fill and use in the wrong phase; missing final dependency.

For controls requiring the future real mixed Call or population owner, state
that prerequisite and keep them as mandatory next integration controls, rather
than silently substituting a source-selected observer or calling a helper a
public test. Do not weaken 35-second preservation timeouts, scopes, assertions,
error handling, historical receipt hashes or known failures. Root schedules
one heavy process and records actual collected/pass/fail/skip/error counts.

## 8. Minimal reviewed Number reuse, after the mixed dependencies

Read preserved donors in `/private/tmp/js2-ir-number-current-main-20260930`.
Do not overlay its 56 pending files or old broad source hunks onto this graph.

| Prepared material | Reuse and current integration obligation |
| --- | --- |
| `ir/runtime/number-conversion-callable.ts` provider + canonical mismatch/policy; its hooks in `callable-declarations.ts`, `runtime/contracts/manifest.ts`, `runtime/manifest.ts` | Compose these four logical hunks against current validators. Canonical `native.js.number.from-value`, standalone/WasmGC only, externref->f64, no host capabilities. Symbolic obligation only; no physical admission. |
| `runtime/wasmgc/values/number-from-value-body.ts` | Reuse real ToPrimitive(number), @@toPrimitive/GetMethod, valueOf-before-toString, exact abrupt propagation, Symbol TypeError and explicit BigInt conversion. Harden config/Instr inputs to current conventions. Bind scalar general Get and genuine general IsCallable/Call, not selected coverage. |
| `bigint-to-number-body.ts` + `resources/native-bigint-number.ts` | Reuse real narrow/wide BigInt conversion, including rounding/overflow, with exact current BigInt owner/plan and complete canonical bodies/locals checks. |
| `resources/native-number-primitive-classifier.ts` | Reuse authentic primitive-family predicates only; add current own-data/currentness/completion discipline. Same actual Boolean/String/Symbol/BigInt/value owners. Not IsCallable. |
| `runtime/contracts/well-known-symbols.ts` + `resources/native-well-known-symbols.ts` | Reuse canonical named symbols and actual carrier/interning. Harden dependency capture. Bind real @@toPrimitive, never a string spelling or caller-selected numeric ID. |
| `object-prototype-to-string-body.ts` | Reuse algorithm only with actual ToObject, IsArray (including revoked Proxy behavior), internal slots, general Get(@@toStringTag), native String recognition/concat. Constant-false slot probes are not general completion. |
| `native-number-callable-coverage`, method-effects, Number-invocation analyses, `native-callable-classifier.ts`, selected invocation/getter edits | Preserve their bounded tests/contracts. They certify selected values and reject default/inherited population. Do not promote them into general IsCallable, relax their refusal or fabricate selected demands. New all-source/public owners replace that authority for this graph. Independent semantic/projection occurrence checks may be reused. |
| pending Number-selected object-literal/Object.create/Symbol source hooks | Original accessor fixture needs none of these to be recognized. Do not overwrite the stronger current genuine Object.create(null) resolver or its discarded/statement-call hooks. General syntax additions require their own source identity/ambient declaration/signature/mutation/escape/policy proof. |

The new Number owner is the already planned
`src/backend/wasmgc/resources/native-number-from-value.ts`. Its dependencies are
real scalar mixed Get, general mixed IsCallable/Call, native primitive/scanner
and BigInt owners, canonical @@toPrimitive Symbol, same value/undefined/Boolean
carriers, same TypeError owner and same tag. Explicit adapters preserve donor
method0(receiver,method)/method1(receiver,method,arg) ordering when constructing
Call(callee,receiver,vector). Never alias `native-values.unboxNumber`, whose
object fallback is not observable full Number conversion.

Literal supplementation belongs in the authenticated
`backend/wasmgc/program/native-realm-literals.ts`: add the actual number hint,
valueOf/toString and error strings/Symbol descriptions required by the real
algorithms, preserving original source literal order/encoding and exact retained
realm/literal identity. Primitive/Boolean resources must be demanded by real
algorithm requirements even if source has no explicit Boolean boxing call.

## 9. Eventual public consumer join and completion bar

Use the already planned `src/backend/wasmgc/program/native-object-number-abi.ts`
for exact public intrinsic declaration/occurrence/physical-token reconciliation.
Later authorized edits to `program-consumer.ts`, `program-physical-plan.ts`,
backend `program/native-realm.ts`, native requirement/literal planning and the
retained source allocation/invocation seams must do all of the following:

- derive real complete source/semantic/projection requirements, currentness and
  catalog obligations; preserve default/bootstrap consumer behavior;
- replace the existing early `physical:exception-tag` reservation with the real
  public exception producer when public mode is selected (same checked required/
  shared import policy), never allocate a second tag; use one substrate/closure
  population/state owner and no bounded bootstrap population in public mode;
- reserve all actual owners, source slots, algorithm entries, startup/ABI
  adapters before one freeze; bind exact original source bodies and state;
- authenticate complete algorithms, every source/native own descriptor,
  constructors/prototype aliases and initialization order. Allocate identities
  first, link actual prototypes/constructor aliases, seed all descriptors, then
  publish readiness only after successful actual population;
- reconcile the three canonical function bindings and all four original unit
  references in physical resources, ABI manifest, callable maps and startup;
  preflight/emission replay must rederive exact identities and canonical bodies,
  not count or stringify a prepared-looking substitute;
- accept canonical default prototypes only through the actual completed
  Object.prototype singleton and same whole-realm owner. Old implicit/default
  prototype refusals remain valid for old/unowned/incomplete representations.

Required public evidence remains the original **9/9** (all original rows,
unchanged hashes), four actual native original/decoded x both-encoding routes,
zero host imports, repeated 712 on two fresh instances. Add a separate fresh
child decoding those exact bytes with zero TypeScript/frontend preparation or
resolution; byte-identical codec re-encoding, actual public acceptance/emission
and Wasm execution are mandatory. Preserve original baseline failures alongside
new results. Add Number({}), inherited native/source getters/methods, general
@@toPrimitive ordering/abrupt cases, Symbol/BigInt/primitive conversions,
state/receiver restoration, descriptor/prototype mutation and full catalog
population controls. A component observer or backend-only typed-IR fixture does
not satisfy any of the four native public rows.

Full completion remains unrestricted: all 45 Object/Function catalog intrinsics,
actual constructor links, full Object statics and prototype methods, generic
ToObject/ToPropertyKey/descriptors/Set/ownKeys/extensibility/integrity, arrays,
iterables/IteratorClose and relevant exotics; general Function call/apply/bind/
toString/@@hasInstance, restricted properties, bound Call/Construct, source
newTarget/Construct/name semantics, and real CreateDynamicFunction including
parsing/global environment/SyntaxError. `eval` and `with` remain in full IR
scope. No unavailable member may become an absent key, stub body or host import.
A closed-demand optimization could be proposed later; it cannot redefine this
public API, the whole-realm completion contract, or the migration goal. Nine
passing rows are necessary regression evidence, not full IR or realm completion.

## 10. Concrete blockers retained, without stalling structural work

- Canonical mixed getter Call/IsCallable owner is not implemented yet; implement
  pure Get and the structural owner now, then bind it through the adjacent real
  mixed invocation issuer. No invented authority in the four-file checkpoint.
- Source/intrinsic complete own-property allocation/population is still missing;
  source shape/state alone is not that evidence. General source Construct/name
  reflection is explicitly not granted by source-call association.
- Pending public declarations still reserve 44 callable rows and 45 catalog
  intrinsics without their complete algorithms/initialization. Do not emit them
  with placeholder fills or equate declaration completion to public completion.
- Runtime registration, native Number conversion ownership and physical
  consumer/ABI wiring are separate real later joins. Four symbolic provider
  edits cannot make the original public fixture executable by themselves.

Root can dispatch the four mixed-access files immediately under the verified
public graph claim. The final production Get bind and whole public provider
remain coupled to the adjacent genuine invocation/population work. No unrelated
armed lane or existing pending Number source needs to be changed for this step.


### Adjacent mixed Call source ownership findings

Independent read-only inspection confirms the genuine all-source association
must be obtained from nativeRealmSourceClosureCallableBindings(tx, emission,
realm), retaining that exact pack together with the SAME private emission.
Revalidation compares that relationship and invokes
requireCompletedNativeSourceClosures(tx, sameEmission). The lower-level public
association binder alone accepts genuine raw slots and proves association,
not canonical lowering; an arbitrary association plus an independently completed
emission does not join source authority. fillPreparedPrimaryUnit supplies the
real canonical source-lowering marker and the ledger checks body/locals drift.

Current selected native-invocation supports only externref/f64 parameters and
externref/f64/Boolean results; it cannot become unrestricted GenericCall by
renaming it. General adapters still need genuine numeric/Boolean/BigInt/Symbol/
String/vector/reference conversions, actual receiver/argc/extras restoration,
missing undefined, void boxing and all source signatures. Current source
association is synchronous fixed-parameter and has no class-constructor Call
mode authority. Classes remain IsCallable=true with throwing Call, distinct
from IsConstructor. Async/rest/Construct/newTarget coverage remains required;
these findings grant no exclusion from the full migration goal.


Root registered precisely the two actual mixed-access production leaves after
they existed: inventory1744→1746, backend entries/floor48→49, native-runtime
entries95→96 and floor94→95. All1744 prior ordered rows, layer policies,
activation history and allowed edges are preserved. Boundary activation-tail
expectations add only these leaves. This is metadata registration before tests,
not a passing gate or public completion claim. Getter/Call/population remains
explicitly pending. New source/helper/test draft validation has not run yet.


### Mixed-access first-draft review and bounded correction dispatch

Independent review of the exact four frozen draft inputs found two defects before
execution: both recipe preflights omitted the authenticated external PropEntry
type key, and older own/String dependency owners could mark an incorrectly
first-filled executable definition complete. The new mixed owner must rebuild
and compare those actual dependency bodies and locals with authenticated
operands; ledger completion alone does not establish canonical semantics.
The writer is correcting only its four owned files and adding wrong-body,
wrong-locals, genuine same-ledger owner-mismatch, and String virtual-value/length
controls. Initial draft bytes and review findings are retained in
`.tmp/public-native-object-number-graph/mixed-access-dispatch/review/`.
No tests have run on this draft; 31 was the initial static planned count.
Production getter Call, source population and whole public completion remain
explicitly unresolved. Existing fixtures and original public nine-row failures
remain unchanged. The canonical root worktree advanced externally to
9398d8d272259df6b3a3809ee0a338bfad84e0a9 with unrelated dirty files; it was
read only and is preserved. This graph worktree stays at 8a730516.


### Mixed-access corrected draft checkpoint

The four-file corrected draft remains source-scoped and was independently pinned
by root: the pure body recipe is unchanged; the new owner supplies PropEntry
preflight prerequisites and reconstructs the executed ordinary key/hash/findOwn,
String index/virtual/own, equality and flattening definitions and exact empty
sentinel. Both body and locals must match authentic donor recipes. Old
whole-chain lookup/has helpers are unused and are not accepted as heterogeneous
traversal authority. Six new dependency body/local refusal rows raise the static
planned denominator from31 to37. Same-ledger alternative-owner mismatch, actual
String surrogate characters/length and tombstone continuation controls are
included. The configured implementation attribution is Codex GPT-6 Astra Max.

Second review confirmed the two production fixes and identified a test-helper
trap before execution: tombstoned entries were inserted and then looked up
through real findOwn for a getter update, although findOwn correctly skips
them. Only helper instrumentation is released for correction; production lookup
and the inherited-value assertion remain preserved. Draft1/draft2 and review
receipts remain retained. No typecheck or test evidence is claimed yet.


### Mixed-access first executed diagnostic and scoped repairs (2026-10-01)

On the exact reviewed draft, TS7 passed. The strict focused run executed a
37-row suite with10 passes,3 failures and24 skipped due to two beforeAll
failures; there were zero todo or worker errors. All7426 compiler/config
and14559 retained tracked inputs stayed unchanged. Full logs, JSON rows and
exact input copies are preserved in `.tmp/public-native-object-number-graph/
mixed-diagnostic-c0tdhzjh/`; this is failed evidence, never a success count.

The normal emitted fixture's initializer referenced an undeclared lifted
control function; the helper must declare the genuine exact ref.func target
through the ledger, preserving the ledger validator. Displaced UTF8 fixture
construction omitted the canonical WTF16 empty literal demanded by genuine
String flattening. The existing production native-string-values composition
already includes this prerequisite, so this is not a new public-consumer
defect. Root will preserve every selected realm literal row and supplement
its genuine realm plan with canonical ('', 'wtf16') if absent; this lets the
narrower foundation plan carry the same actual algorithm prerequisite.

One normal canonical-completion control took36.163s against the unchanged
35-second limit. The new owner redundantly authenticates individual physical
indices for every44 singleton plus anchors. The writer may batch those exact
tokens through the genuine callback-free ledger API, preserving fresh full
canonical audits. This is an optimization hypothesis until measured; the test
limit, assertions, public fixture and completion scope remain unchanged.


The corrected production/helper cohort is cleared by independent review3.
The root-owned realm requirements regression retains its original source-prefix,
currentness, cache and reservation assertions. Its old homogeneous UTF8 assertion
is replaced with exact selected-prefix order/encoding plus exactly one appended
canonical WTF16 empty carrier, preserving the separate selected UTF8 empty.
Normal UTF16 selection is still homogeneous with exactly one empty literal.
No limits, fixtures or completion checks are relaxed.
PR6359 is now verified delivered on fresh main e303c5c: all9 merge-path blobs
match exacthead90d at mergeeb136e20; all source blobs persist on freshmain;
all82 standalone+20 host unique protected shards, final regression gate,
CI/CLA/differential merge_group runs passed. Its slice claim completion is
verified on issue-assignments tipc5fd4303. The IR migration epic remains active.


### Mixed-access second diagnostic and exact prerequisite census

Second frozen run: TS7 passed;37 planned rows produced23 passes,2 failures
and12 skipped from one displaced beforeAll. All error paths require the real
StringCreate ('length','wtf16') binding; all12 normal Wasm controls and11
normal ownership controls passed. Completion34.678s/postfill34.224s remained
under unchanged35s limits; no broader performance guarantee follows.
Zero worker errors/todo/drift across7426 compiler/config and14559 tracked
inputs. Exact six-input cohort/logs/results are retained in
`.tmp/public-native-object-number-graph/mixed-diagnostic-292vx1sm/`.

Independent scoped prerequisite inventory traced every actually selected
donor: exactly('',wtf16) for flatten and('length',wtf16) for StringCreate;
other selected owners add no further fixed encoding tuples. Substrate/error
literals are text-only;11 fixture control keys are separately reserved and
are not added to the production plan. Root supplements precisely these two
canonical carriers, deduplicated by value+encoding while retaining every
selected UTF8 row. The preservation test requires the exact selected prefix
and both canonical rows, including retained UTF8 variants. No public readiness
or successful37-row rerun is claimed yet. Next heavy slot prioritizes the
main-based Function component; graph files remain preserved for its next run.


### Resume after Function delivery: fresh literal inventory authentication (2026-10-01)

The active full IR migration goal resumed after the requested wrap-up. The
public-native-object-number-graph slice was freshly checked unassigned and
reclaimed by ttraenkler/codex-public-native-object-number-graph-20260930 on its
preserved branch. No peer claim or reservation was changed. PR6369 has merged
as6383d218; exact protected merge-group and current-main content proof is being
collected separately. Legacy retirement and whole native provider completion
remain unproved.

The unchanged37-row mixed cohort remains36/37, with canonical structural
completion40.134s exceeding35s. The single standalone instrumented replay
measured ledger public operations32.809s/36.687s (89.43%); physicalIndex3459
+physicalIndices2133+assertTypeReservation5650 dominate, while scalar completion
checks132 took only0.579s. Inclusive totals overlap and are not additive.
Receipt: mixed-performance-pjcruab8. No timeout or assertion may be relaxed.

Scoped implementation plan: native-builtin-function-requests.ts resolves
common/catalog literal lists by calling requireNativeStringLiteral once per
text. Every call reauthenticates the full same string owner and its type family.
Instead, within each individual private literal-list authentication, obtain
one freshly authenticated nativeStringLiteralReservationInventory from the
actual tx and exact original owner. Select its original immutable request
bindings in the same order, preserving first-match text semantics, encoding
behavior, missing-text refusals and retained-binding identities. Never accept
a caller inventory, cache proof across calls, remove argument-vector checks,
or bypass a changed requirement/dependency/ledger check.

Writer owns only this existing prepared source file and one focused regression
test file. Root owns claims, metadata, integration, Git and publication. Other
prepared source changes remain intact. Required controls: genuine native
request issuer, common/public literals, missing literal, warmed then corrupted
ledger/dependency refusal, foreign owner refusal, no getter execution, and
fresh per-call authentication; tests must not replace owners with fake packs.
After review, run TS7 plus the full unchanged37-row suite with source pins and
retain all prior failures. Only then run current375 preservation cohort and
seven gates. No global ledger API or audit suspension is part of this repair.
Full45 catalog/transitive algorithms, genuine Get/Call/source binding, original
public9 rows and both backends remain acceptance obligations for the full goal.


### Function component verified main delivery — 2026-10-01

PR6369 “feat(ir): add Function call and apply algorithm bodies” merged as
6383d2187cac76626dd04c1a37e1733997c79c00, exact parentsae62dbdc+5dd3fc53.
Freshly observed/fetched/observed main25ee5b64b883b6d735b1072272a24d8740256e0b
contains both signed head and merge. All8 PR-path blobs match at merge and
all source/test blobs match that main. Actual protected merge_group runs
36787500620/36787500581/36787500609/36787500589 succeeded, including all unique
82standalone+20host shards and final regression/report gates. This component
counts delivered; no PR-head stub/skipped shard is counted. Local raw proof:
.tmp/public-native-object-number-graph/resume-20261001/pr6369-verified-delivery.json.

Its scoped claim was released during stand-down and remains released; this
record does not close the migration epic. Full native provider completion,
originalpublic9 rows, entire45catalog, both-backend equality and legacy
retirement are still unproved. The goal resumed under the freshly reclaimed
public-native-object-number-graph slice; no foreign claim was changed.


### Fresh literal authentication repair validated — 2026-10-01

The narrow native builtin request owner repair now resolves each common/catalog
literal list from one fresh genuine String inventory per invocation, preserving
original first-text bindings and all currentness/refusal contracts. No proof is
cached across calls. Actual TS7 passed, new24/24 controls passed, and unchanged
mixed37/37 passed with zero skips/setup/worker errors. Formerly failing canonical
completion control took23.271s, below its unchanged35s limit (retained old
40.134s failure). Source/test bytes stayed frozen across all validation.

Current375/375 preservation (349boundary+26realm requirements) and all7 gates
passed;7427compiler/config and14559tracked pins had zero drift. This is current
root/component evidence, not a new broad historical comparison. The reachability
verdict remains preservation-only PASS, graph OPEN, strict closure FAIL,
retirement/deletion NOT CERTIFIED. Earlier failure cohorts and originalpublic9
fixture remain unchanged; its last actual5/9 result is not replaced by these
component controls. FullGet/Call/source authority and45catalog remain pending.

Exact owner source SHA256ece7be10320cf5c034b59c553995b3ce72a40ad037878d315e7b8369aa121263;
new test SHA256fcb430600ea1c1088fc4cd39d90e794f505779b4c8a6ceb0735e52c599a6b4b6.
Implementation: Codex GPT-6 Astra Max. Root integrates claims/metadata/Git.
Receipts under .tmp/public-native-object-number-graph/resume-20261001:
request-literal-validation-4077db63, mixed-validation-1d95dba6,
preservation-gates-b32dc940. No graph commit/push/PR yet; next delivery action is
fresh-main composition, normal signed hooks and ready publication when verified.


## Astra implementation plan — genuine source identities and mixed invocation (2026-10-01)

Root reviewed the complete following brief. It was drafted while the literal
authentication validation was running; its reference to the former36/37
checkpoint is historical. The current actual result is37/37 plus24/24 controls,
TS7 and375/375 preservation with7gates. No Get/Call/source-identity implementation
is claimed by this paper. Its full catalog and genuine source-completion bar
is retained. Deliver the current validated checkpoint through fresh-main
composition before expanding code scope; verify claims and exact file ownership
again before any future dispatch. The full brief follows without truncation.

# Issue 3518 — IR-only default and direct front-end retirement
# Next production scope: authentic source targets, mixed Call and Get

Read-only architecture brief, 2026-10-01. Root owns claims, metadata, integration and publication. No tracked files or tests were changed or executed for this brief. The existing literal-list authentication optimization has a separate writer and is outside this scope. Start this implementation only after root accepts the frozen mixed-access run and its preservation gates; this document does not turn the existing 36/37 timeout result into a pass.

## Decision and completion boundary

Implement the actual source invocation authority and the mixed invocation/access cycle. Do not publish a Number provider or a successful public consumer route by treating this cycle as a completed realm. Keep the existing structural access checkpoint and old default invocation behavior compatible.

The current catalog has **45 intrinsic objects, 44 callable entries, and two constructible entries** (%Object% and %Function%). Full public realm completion therefore requires all 45 actual identities/descriptors/links, all 44 canonical Call algorithms, all 44 genuine lifted Call entries, both genuine Construct entries, and their transitive dependencies. It does not mean 45 identical function triples. Keep normative-optional catalog entries in the currently selected catalog; do not remove them to reduce the denominator.

`wholeRealmReady` cannot honestly become true before that graph is materialized and authenticated. Under the assigned unrestricted public Get/default-object contract, **the original nine-row public Number suite cannot be made accepted before full catalog materialization**. The `constructor` links expose Object/Function and their other members; missing members cannot become absence or runtime stubs. A later proven closed-demand optimization could change compilation reachability, but is not this architecture or its acceptance bar.

The next increment may issue/audit canonical *code definitions and links* while the whole graph is incomplete. That is a bodies/association fact, not a subset public-completion capability. Full `requireCompletedNativeObjectRealm`, scalar public bindings, and original public acceptance remain blocked by explicit missing roles. No observer, raw FuncHandle, completed-token count, user boolean, partial catalog, or fabricated source requirement can discharge a missing role.

## Exact existing facts that drive the change

- `native-mixed-object-access.ts` owns seven tokens, fills six structural roles, and deliberately leaves Get pending. Its source rows return unready before bag/prototype reads. Already-filled structural code cannot be patched later: ledger fill is single-use.
- `program-native-invocation.ts` owns the genuine private source-emission map and canonical-lowering markers. `nativeRealmSourceClosureCallableBindings` obtains the all-source association from that exact map. The lower-level public `bindNativeRealmSourceClosureCallables` accepts real same-shaped slots but is only an association issuer, not proof that the body was lowered.
- `requireCompletedNativeSourceClosures` currently covers lifted source units. It does not separately certify every outer allocation-owner body in `requirements.allocations`. A general source allocation claim must cover those bodies too.
- Source shapes are shared by `(signature, captures)`. Their current fields are header 0–2, captures 3+, then immutable realm-state reference. A field-0 `funcref` test proves a signature, not membership in the original unit set. Do not add `ref.eq` on funcrefs or dispatch the first same-shaped entry's slot.
- The public declaration owner reserves all real native tokens and only fills null/zero module initializers. It does not implement its initialization function, algorithms, lifted functions, or constructors. Its readiness global is immutable and currently initialized to zero.
- Existing selected native invocation supports only a limited argument/result conversion population. Its requirement issuer selects particular call/apply/getter demands. It cannot be renamed into generic Call or used to justify source functions absent from those demands.

## Proposed owned files

Root must approve this explicit expansion before edits. Names below are proposed API names, not claims that those APIs already exist.

### New production files

1. `src/backend/wasmgc/resources/native-source-call-targets.ts`: genuine pre-source unit identities and allocation-tail initializer owner. It takes exact source requirements and exact realm-state owner, not selected invocation demands.
2. `src/backend/wasmgc/program/native-source-invocation.ts`: relocate the existing physical source-emission owner here, preserving its actual private maps and lowering operations; add the authentic all-source execution association/completion API here.
3. `src/runtime/wasmgc/values/mixed-invocation-bodies.ts`: pure family matching, source adapters, native lifted dispatch, checked invocation and state-boundary definitions. No backend/IR owner imports, even type-only.
4. `src/backend/wasmgc/resources/native-mixed-invocation.ts`: exact reservation, reciprocal access binding, code filling and canonical finite completion audit.

### Existing production edits needed now

- `src/runtime/wasmgc/values/realm-object-layouts.ts`: add the explicit public source variant with an immutable SourceUnitIdentity field after the existing state field; add pure identity/tail-initializer declarations/builders. Ordinary/wrapper layouts and existing state layout remain unchanged.
- `src/backend/wasmgc/resources/native-source-closures.ts`: optional genuine `callTargets` carrier, preflight/reservation-plan/shape/currentness checks, and an authenticated retained-target accessor. Existing absent-option layouts and behavior stay identical. Present undefined/null/accessor/hidden/foreign values refuse.
- `src/backend/wasmgc/resources/native-source-closure-callables.ts`: expose the exact unit-to-shape/signature/original-slot association required by the new execution owner. Preserve the old selected and all-source association APIs; do not relabel their completion scope.
- `src/ir/program-native-invocation.ts`: compatibility re-exports for the relocated physical APIs, plus the existing semantic preparation helper if it remains here. No second WeakMap, new issuer, or parallel lowering implementation.
- `src/runtime/wasmgc/values/mixed-object-access-bodies.ts`: an explicit source-match port for the public composition, and a checked-Call Get body that propagates unresolved statuses. Preserve the existing pure scalar-Call component builder/default structural behavior.
- `src/backend/wasmgc/resources/native-mixed-object-access.ts`: optional authentic pending invocation port packet at reservation, exact reciprocal one-use bind, Get fill and canonical body audit. No raw-handle or callback completion permit.
- `src/backend/wasmgc/resources/native-object-realm.ts`: canonical native lifted-entry binding/fill association and explicit remaining-role inventory as the algorithm owners join. Keep declaration-only behavior. Do not set wholeRealmReady merely because dispatch bodies were filled.

No edit to `native-builtin-function-requests.ts` is needed for these identity/Call changes: reuse its genuine common/public issuer and preserve the independent literal optimization. No existing emitter or `IrClosureLowering` field change is needed for the multi-result tail technique below. No current historical closure-layouts receipt requires rehashing for that technique.

### Focused new tests/helper

- `tests/helpers/native-mixed-invocation.ts`
- `tests/issue-3518-native-mixed-invocation.test.ts`
- `tests/issue-3518-native-source-call-targets.test.ts`

The helper must lower actual original and freshly decoded prepared source, bind the actual slots, and use real native vector/error/value/storage owners. Component execution and full public acceptance must remain explicitly separate. Never make a pending full-catalog module emit by filling its missing slots with controls.

### Additional semantic producer prerequisite, before claiming unrestricted source Call

The retained source contract currently proves fixed parameters/public length; it has no affirmative class Call mode, Construct capability, or strict/global/lexical this-mode contract. `funcKind` alone does not fill that gap. This work must report unavailable modes and converters explicitly. To enable more modes, root must separately approve the real source-contract extension at:

- `src/ir/source-closure-invocation.ts::fixedClosureParameters` (or a new adjacent source-facts helper, not the selected invocation proof);
- the two `fixedClosureParameters` producer calls in `src/ir/from-ast.ts` around 15651/15678;
- `src/ir/core/nodes.ts::IrFunction.closureSubtype` and the genuine preparation/codec validation readers of the new field;
- `src/ir/program/native-source-closure-requirements.ts::calculate` and source callable resolution.

The fact must originate from the real source node, directives/module/class context and actual lowering policy before preparation, survive serialization, and be checked between semantic/projection views. Do not infer strictness/constructibility from an absent field, the name, the presence of a prototype property, or a caller flag. The existing codegen strictness helpers are analysis donors, not backend imports. Missing source modes remain typed unsupported and stay on the full goal; they are not silently excluded from it. In particular classes are callable in the IsCallable sense while their ordinary Call operation throws; that is distinct from IsConstructor.

## Source identity and the unrelated-header problem

Use a real unit identity, not a new closure root or a physical type index as a nominal brand.

`reserveNativeSourceCallTargets(tx, requirements, { realmState })` must authenticate exact issued requirements/current program/projection and exact state owner before reserving anything. Declare/preflight every key of this owner first. For every actual `requirements.units` row reserve:

- one immutable nonnull `ref SourceUnitIdentity` global, initialized canonically by a distinct `struct.new`;
- one tail initializer with exact signature `() -> (ref RealmState, ref SourceUnitIdentity)`.

The tail initializer calls the genuine existing `realmState.sourceInitializer` and then reads that unit's identity global. Its two results are in the order required by the final source struct. All globals/functions and their complete canonical definitions are retained privately and reauthenticated. Structurally identical identity types are harmless because the runtime comparison is of the actual singleton reference.

A public source allocation shape becomes:

`[func, arity, bag, captures..., state, sourceUnitIdentity]`.

Header/capture coordinates and the state coordinate `3 + captureCount` remain unchanged; identity is `4 + captureCount`. Fields after the header remain immutable, preserving native-metadata/source separation. Default stateless and existing state-only source modes remain byte-compatible.

The existing WasmGC emitter already emits `call layout.realmStateInitializer` immediately before `struct.new`. A unit-specific authenticated lowering view can use the new two-result initializer in that position; the existing single-result state initializer is not changed. Capture recovery uses the same widened shape but never emits an allocation initializer. Allocation resolution without the actual unit association must refuse; it must not silently fall back to the shared state-only initializer for a widened shape.

The relocated source resolver must select the initializer by the real IR `liftedUnitId`/original slot relation. Wrap source unit `resolveFunc` lookups using the owner's private unit map; an external resolver returning a different same-signature unit must not select a different initializer. Retain and compare the exact allocation occurrence, allocating owner unit and lifted target from the issued requirement census. Do not associate only by `(signature, captures)`. The existing subtype resolver receives the stable lifted FuncHandle, so maintain the privately verified one-to-one reverse map from that actual original handle to its unit target; source `resolveFunc` must first map the real IR unit reference to that exact handle. This composes with the existing resolver ABI. A shared shape view may describe capture recovery without an allocator, but only the private unit-specific allocation view may supply the two-result initializer; neither a missing handle nor direct use of the shared shape may allocate an identity-bearing closure.

At runtime the source matcher requires the exact issued final allocation shape, actual state realm, and actual source-unit identity before any bag/prototype read. Mixed Call then directly invokes that identity's original slot with the actual closure as self. **It does not invoke field 0 as an arbitrary source callback.** This preserves captures and distinguishes two same-shaped source units without pretending that a signature test compares funcref identity. The ordinary immutable header remains correct for old readers because canonical allocation still emits exactly the original lifted reference.

There are two separate proofs: canonical lowering proves the produced header/identity pair; identity-directed dispatch proves that changing an unrelated header cannot redirect mixed Call. Do not claim a universal runtime funcref-membership test. A control that changes the source resolver/allocation target must fail canonical-source acceptance. A deliberately crafted component object with a copied identity and an unrelated header must never invoke that unrelated header through mixed Call. Foreign/unknown identity and missing identity refuse before bag reads.

## Relocated source owner: association and actual completion

Preserve the existing implementations of `beginNativeSourceClosureEmission`, `bindNativeSourceClosureUnits`, `nativeSourceClosureCallableBindings`, `nativeRealmSourceClosureCallableBindings`, `nativeSourceClosureValueType`, `nativeSourceClosureResolver`, `fillPreparedPrimaryUnit`, and `requireCompletedNativeSourceClosures` in one backend owner. The old IR path re-exports the same functions/identities. Keep `prepareNativeSourceClosureInput` semantic and backend-independent if it stays in the IR facade; the relocated backend owner must not import the facade back. All physical ownership and lowering markers move together, so existing imports and new backend imports resolve to the same issuer instance.

Add an opaque backend-owned execution association, for example:

- `nativeRealmSourceExecutionBindings(tx, emission, realm, callTargets)`;
- `requireNativeRealmSourceExecutionBindings(tx, pack, exactExpectedDependencies)`;
- `requireCompletedNativeRealmSourceExecution(tx, pack)`.

Its private owner retains the SAME genuine emission, the exact result of `nativeRealmSourceClosureCallableBindings(tx, emission, realm)`, exact source types/combined closures, exact call-target owner, state, program/projection and original slots. Requiring some independently completed emission plus some separately authentic association is insufficient. A public lower-level raw-slot association cannot mint this execution proof.

Track canonical lowering of the union of all lifted units and all actual allocation-owner units. Keep allocation-owner tracking separate from the old lifted-unit map/count so the existing source APIs retain their contract. Bind those owner slots from the consumer's original slot map, not new duplicates. `fillPreparedPrimaryUnit` records each real retained function/slot once only after actually lowering it. Source-aware lowering must install the authenticated closure resolver and exact source-unit lookup; do not let caller-supplied callbacks replace these checks. Completion checks every marker, body/local snapshot, source requirement/current projection, all allocation associations and every canonical target initializer/global.

Readers/callers of the current adapter, found in this tree:

- production: `src/ir/program-consumer.ts`;
- tests: `issue-3518-native-object-realm-declarations`, `native-realm-source-integration`, `native-object-get-owner`, `native-getter-invocation` suites;
- helpers: `native-builtin-functions`, `native-getter-resource-fixture`, `native-getter-invocation-fixture`, `native-object-realm`, `native-realm-source-integration`, `native-realm-object-layouts`, `native-mixed-object-access`, `native-invocation-substrate`.

The source owner mutators are begin/reserve, original-slot bind, association cache issuance, and `fillPreparedPrimaryUnit`'s actual completion marker; require/resolver APIs also enforce currentness. Move those private stores together. Retain the old imports as compatibility; do not update every caller opportunistically. The inventory names the old mixed module and must record the genuine new backend leaf and compatibility status through root's normal boundary workflow.

Source shape/tail readers are `native-source-closures.ts`, `native-object-realm.ts`, `native-source-closure-callables.ts`, `native-mixed-object-access.ts`, `realm-object-layouts.ts`, the native source resolver and WasmGC allocation/capture emitter. Existing `closure-layouts.ts`, `lower-generic.ts`, emitter interface and linear emitter need no new transport field for the proposed tail initializer. The historical closure-source/state-preservation helpers read `closure-layouts.ts` exactly; do not edit or refresh their receipts for an unrelated relocation.

## Real mixed invocation ABI and dependency ownership

Public-facing semantic roles retain these signatures:

- `Call(F externref, thisValue externref, argv ref IssuedArgumentVector) -> externref`.
- `Construct(F externref, argv ref IssuedArgumentVector, newTarget externref) -> externref`.
- `IsCallable(F) -> i32 Boolean` and `IsConstructor(F) -> i32 Boolean`, only with a complete applicable family proof.
- Native lifted Call is exactly `(self ref ClosureRoot, originalThis externref, argv ref IssuedArgumentVector) -> externref`, locals 0/1/2.
- Native algorithm Call is exactly `(originalThis externref, argv ref IssuedArgumentVector) -> externref`, locals 0/1.
- Native Construct tokens are currently `(self ref ClosureRoot, argv ref IssuedArgumentVector, newTarget externref) -> externref`.

Transport arity, source parameter count, header arity/public length and mutable own `.length` are distinct. Never use field1 or own `.length` to decide how many vector elements to transport.

The new owner borrows the exact pending full-public declaration pack and original dependencies, call-target/source-execution owners, value/conversion owners, one substrate/vector plan and one actual exception token. It owns currentThis/argc/extras state; the shared substrate still owns only vectors/TypeError. No duplicate Error, vector, realm, Function.prototype, source closure pack or tag.

Reserve a separately named internal checked invocation operation with explicit status/result if needed to expose honest unready/unsupported state during graph construction. Keep scalar Call's ABI above; never silently bind a status pair to it. Its statuses must distinguish known noncallable (genuine TypeError on Call), known callable, unavailable implementation, and unsupported/foreign carrier. IsCallable cannot return false merely because a known native algorithm is still pending. A Get body using checked Call must propagate status2/3 unchanged; it must not push success before that call. The existing scalar-Call pure Get builder stays compatible. Public scalar adapters are not completed while unresolved statuses can represent valid admitted language values.

Native matching precedes source fallback: exact final native type, physical metadata ID, realm, singleton and expected lifted signature. Unknown metadata families/IDs never become source. Generate native lifted wrappers from their actual entry/algorithm tokens; do not borrow the bounded bootstrap kernel's population or switch on its two behavior tags. Unavailable catalog bodies remain unfilled and explicitly listed as prerequisites, not stubbed or implemented by the Call dispatcher.

Source matching uses exact source identities above and invokes original slots directly. Build adapters from each actual logical parameter/result contract and issued physical signature. Reuse the actual vector length, materialize every required formal and preserve all excess arguments. No eight-argument limit. Preserve missing versus explicit undefined and the real f64 default sentinel. Missing ref/conversion owners are refusal, not null/zero fallbacks.

Reuse `buildClosureInvocationBoundary` for save/restore and catch-all rethrow identity, plus the real argument/result conversion leaves where their exact dependencies exist. The old conversion helpers have intentional legacy fallbacks (`0n`, null, drop-result); general native admission must reject those missing dependencies. Implement genuine Boolean/Symbol/BigInt/String/reference/vector/callback conversions by their issued owners, not numeric unboxing aliases. Apply receiver normalization according to the affirmative source Call mode; native originalThis is untouched. Capture cells and lexical this remain the actual lowered source semantics.

A genuine callback parameter must resolve through the same source target identity/slot owner, not a shape-only callback contract or selected source `.call` plan. Test actual callbacks that reenter Get/Call, two same-shaped functions, and returned getter closures. Source invocation state must restore after argument conversion, call, result boxing, nested invocation and abrupt completion.

Construct/IsConstructor remain separate capabilities. Do not fabricate them from Call, prototype properties, source function names or a vector-only apply body. Bound Call must prepend bound arguments/use bound this; bound Construct must prepend arguments and substitute newTarget only when required by actual target identity. Real source constructors, classes, generators/async, bound/dynamic functions and Proxy callable/constructible cases remain required and must have explicit missing-role records until implemented.

## Reservation, binding and canonical cycle

1. Reauthenticate real program/projection/catalog/source requirements and canonical supplemental literals. Reserve the one checked exception token while imports are open; reserve genuine strings, vectors/TypeError, values, ordinary/String/wrapper/state owners.
2. Reserve source-call-target identities/tail initializers from genuine source requirements and state. Issue all real builtin requests before the sole combined closure pack. Reserve source types using that call-target owner, then the consumer's original unit slots and all pending public catalog declarations. A genuine no-source program uses its actual empty/no-source census, not fake closure requirements.
3. Reserve the mixed invocation ports before the final access fill; it need not have access bound yet. Access reservation can retain this privately issued pending invocation pack/source-match token. Reserve Get, checked/scalar Call and Construct roles plus required algorithm ports before the sole freeze. Each owner preflights all its own keys; do not claim transaction rollback across earlier owners.
4. Freeze once. Bind source units/allocation owners to original slots, derive the all-source execution association from that same emission, and bind the exact invocation/access pair once. Check realm, layouts, source identities, original slots, strings/values/vector/substrate/tag and all optional-presence rules. No reservation during fill.
5. Fill canonical leaves and target identities/initializers, then the real source-match/invocation/access bodies using the already-issued cyclic handles. Lower every actual source/allocation-owner body through the genuine resolver. Complete algorithm/population producers as they become implemented. Referencing a real pending token permits instruction construction, not readiness.
6. Audit the finite graph in explicit stages: issued identity/currentness, exact association edges, canonical code/locals, actual source lowering, canonical algorithm/population dependencies, then full public completion. An in-progress/visited node must never mean complete. Avoid mutual recursive `requireCompleted` calls between Get and Call; currentness checks inspect issued peer identity, and one outer audit checks both canonical bodies and every actual prerequisite.
7. Structural-only already-filled access owners remain structural-only. Public composition creates a fresh transaction and chooses its authentic source port before first fill. Do not refill classifier/lookup bodies in an old pack or turn a boolean into a source authority permit.

The current declaration-only ready-global initializer is zero and cannot be rewritten after fill. A later full-population mode must leave its immutable ready token unfilled until all compile-time graph obligations are authenticated, then fill its canonical true initializer once. Preserve the declaration-only zero path/tests. Runtime bootstrap `state` is separate and restores/rethrows actual abrupt identity. Neither a runtime flag nor the immutable guard substitutes for compiler-owned completion.

## Reuse and later public binding

Reuse current genuine source/type/all-source association, shared substrate, state/layout, ordinary own/key/String descriptor leaves, and the already-reviewed mixed traversal. Do not reuse ordinary `lookup`/`has` for heterogeneous chains.

The delivered Function component supplies real pure `create-list-from-array-like-body.ts` and `function-prototype-invoker-bodies.ts`. Root must compose their delivered bytes from current main into this preserved graph; their host-observer harness is not a production dependency owner. Bind the actual general Get/ToLength/index-key/IsCallable/Call/vector/undefined/error/tag roles later. Preserve full f64 ToLength/index iteration and actual property-key-mode String/Symbol classification. Native lifted three-operand transport wraps their two-operand algorithms; no extra hidden user argument.

After complete mixed access/invocation and population, reuse the reviewed Number algorithm/BigInt/well-known-Symbol pieces and register the real logical Number provider. Public ABI reconciliation must bind exact js.number.from-value, js.object.create-default and js.object.define-accessor plus their real body references. Do not overlay the preserved 56-file Number lane or weaken its old bounded proof. The whole public coordinator belongs under backend/wasmgc/program, not a new physical IR-root module. Existing consumer default/bootstrap behavior and the original fixture/tests remain unchanged until a genuinely complete public mode is selected.

## Required controls and acceptance evidence

Preserve the current mixed37, substrate/source/state/wrapper/builtin suites, all historical failures and exact original public fixture/suite bytes. Keep 35-second limits and root's single-heavy-process rule.

New concrete controls must include:

- Real original and fresh-decoded source; zero and capturing closures; mutable captures, real getter returning a closure, nested callback/reentry and exact thrown payload. Decode/replay performs zero frontend/TypeScript work.
- Two different source units with identical signature/capture shapes and different results. Their actual unit identities choose their own slots and captures. Foreign/missing/swapped identity, wrong same-signature header, wrong original-slot map and poisoned source resolver must not invoke an unrelated source function.
- Exact SAME emission + all-source association + completion joins: association from another valid emission, a raw-slot association, copied pack, stale prepared body/census, unlowered last source unit, unlowered last allocation owner and wrong initializer/body/locals all refuse.
- No-source genuine program; no fabricated demand or selected invocation proof. Last-key collision reserves zero new keys for that owner, without claiming earlier-owner rollback.
- Getter uses original receiver and a real empty vector; present undefined/getter-less descriptor stops; Has executes no getter; String own-before-virtual, real UTF16 units and actual prototype identities remain intact.
- Native exact ID/realm/singleton and same-shaped metadata cases; legitimate same-transport source; unknown metadata cannot fall through to source. Check family authority before bags.
- Null/canonical undefined/host undefined receivers, missing and excess arguments including growth beyond eight, default parameters, void/value returns, all implemented conversion classes; explicit named refusal for every unimplemented conversion/mode. Do not collect only supported rows and call the result unrestricted.
- Normal and displaced UTF8/UTF16 type/function/global/tag spaces; one original closure pack, vector owner, TypeError owner and tag. Completed native production paths have no host semantic imports.
- Body/locals/currentness checks both at first fill and after completion, warmed-owner corruption, own-data/accessor/hidden/extra fields without getter execution, foreign same-ledger dependency owners, duplicate binding/fill and wrong phases.
- Partial catalog, last missing Call algorithm/lifted/Construct slot, missing descriptor/population edge or caller-filled plausible stub cannot complete the realm or bind public Number. Missing roles remain explicit; changing counts or wholeRealmReady cannot remove them.

Runtime components should execute real source and real native algorithms whose genuine dependency owners are complete; no fake full-catalog emission. Separately exercise the production owner's full pending catalog and refusal graph. Such controls establish the actual implementation pieces, not original-public acceptance.

Final public evidence still requires the unchanged original nine rows, both native encodings and fresh decoded replay, repeated result712 on two fresh instances, and general native realm behavior beyond that fixture: full catalog property descriptors/order/deletion/redefinition, inherited Get and actual prototypes, Object/Function/Construct/newTarget/bound operations and all transitive/exotic dependencies. Full dynamic Function/eval/with, both-backend equality and retained legacy behavior remain obligations until all IR behavior is tested equal.

## Exact blockers to an immediate public green result

1. All catalog algorithm/population slots are not implemented; declaration-only readiness is correctly false.
2. The same-shaped-source header problem and allocation-owner completion gap need the actual identity/direct-slot and private lowering join above.
3. General source this/Call/Construct modes and complete ABI conversions have no affirmative owner yet; unsupported is required rather than guessing.
4. String/ordinary/source/native descriptor population, scalar Get/Call, and general ToObject/ToPropertyKey/array/iterator/Proxy/bound/dynamic dependencies remain open.
5. Number's symbolic provider and its physical full-graph join are still absent. Registering the provider alone merely moves the original refusal and proves no semantics.

These blockers sequence the implementation chain; they do not reduce the user's full migration objective or justify legacy retirement.



### Native realm infrastructure publication handoff — 2026-10-01

The preserved graph checkpoint is integrated onto freshly verified main
4c5a334669d3d9ac4db29e850f73d65965ba89f6. Its final fast-forward from25ee5b64
changed only six npm benchmark JSON artifacts; compiler/tests/configuration
bytes stayed identical. Source composition had no conflicts. Three additive
metadata conflicts preserve all main policy/entry/history and Function runtime
leaves, then add graph leaves: inventory1749, native-runtime floor97.

This is infrastructure scope: catalog/requirements, authenticated realm state
and layouts, source state, pending declarations/bootstrap and mixed structural
object access. Full mixed Get/Call/source lowering authority, all public
intrinsic algorithms/populations and the logical Number provider stay open.
No legacy code is retired. The complete next Get/Call plan remains above.

Original unlanded public9 suite is preserved verbatim as a tracked handoff
artifact, not a discovered test for this infrastructure checkpoint. Its SHA
and original fixture stay exact, all assertions remain unchanged, and actual
5/9 plus four missing-provider failures are retained. Full public completion
must restore and pass it unchanged; no completion credit is taken here.

Fresh first cohort1012/1106 had94 failures solely in the later-main historical
input suite. New main's actual TypedArray Call fix invalidated that old input.
A separate fixed two-span outer receipt reconstructs its prior test view;
raw readers and all old receipts/mutation guards remain strict. Actual new29
and existing248 pass, TS7 zero errors. The wider repaired historical cohort
is607/680:73 failures in two unchanged suites. A genuine exact-main production
checkout with the same eight test-only input adapters reproduced all204 paired
rows (131pass73fail) with zero status/first-failure differences and no source
changes. Only these specific comparisons establish baseline attribution.
All original failures are retained; none is skipped or converted to expected
failure. Component tests are separate from whole-public/retirement evidence.

Durable resumable handoff, row-level failures, paired attribution, repair
provenance and validation live in
`plan/log/3518-native-realm-checkpoint-2026-10-01/`. Normal signed commit and fork
push hooks remain required. Protected queue delivery must be verified on main;
a published PR is not delivery. Release the slice claim on stand-down while
keeping this epic in-progress. Preserve all other dirty prepared lanes.


## 2026-10-01 source-parameter projection preservation delivery

Claim `3518:source-parameter-projection-preservation-20261001`, owner `ttraenkler/codex-source-parameter-projection-preservation-20261001`, branch `codex/3518-source-parameters-main-20261001`, based on freshly verified upstream main `4c5a334669d3d9ac4db29e850f73d65965ba89f6`. This independent existing-bug repair does not include pending PR6371's realm infrastructure or the frozen new source identity implementation.

Actual physical preparation rebuilds in `vec-layout.ts`, `string-carrier.ts` and `physical-ref-support.ts` discarded affirmative fixed/default parameter facts whenever a carrier/type changed. Preserve the exact original `parameters` record explicitly and compare its identity in the unchanged fast path; absent source facts remain absent. Three production files gain two lines each. Existing assertions and fixtures remain unchanged.

New seven-row controls cover actual vector/string/reference type rewrites, absent facts and stable second pass, plus genuine captured String source preparation/codec with one lifted source unit and one allocation represented in both semantic/projected views. Fresh-main before-edit run measured 4/7: three pure projection rows lost the record, three absence controls and the genuine source/codec row already passed. The genuine transport row is a preservation control, not evidence that the pre-edit driver itself exercised the buggy reconstruction. It verifies no public execution or full source Call parity. Independent static review found no additional same-function reconstruction seam and no defect in the narrow repair.

Validate exact current-root TypeScript, new controls and relevant physical/source requirements preservation; run all normal hooks and protected CI/queue. Only actual verified main merge counts delivery. The new source identity draft remains separately held and preserved pending genuine validation/lowering dependency separation; do not weaken boundary policy or omit guards to publish it. Full catalog, source modes, mixed Get/Call/Construct/newTarget, dynamic Function/eval/with, original public nine-row parity and both-backend equality stay required. Legacy retirement remains unauthorized until full IR equivalence.


Current-root validation measured 49/49 across new projections (7), existing physical-reference controls (4), native source requirements (28) and native source callable contracts (10), with no ignored worker errors. TS7 passed. Fresh-main LOC/function, coercion and oracle gates passed; compiler inventory is valid with zero inventory errors and architecture explicitly incomplete. Dead-export preservation passes its 6/6 full and cut witnesses while graph OPEN/strict modeled closure FAIL/retirement NOT CERTIFIED remain unchanged. No architecture or full IR completion is claimed.

## 2026-10-01 — PR6371 canonical-audit delivery repair

Fresh authoritative CI inspection found required quality failure at signed head `e4737c9f1dcb632c56f3cc3a31e3ad47cd7f848e`: three original mixed structural owner tests timed out at the unchanged 35-second gate (349, 361, 375 in `tests/issue-3518-native-mixed-object-access.test.ts`). The other 34 rows passed. Preserve their fixtures, assertions, mutation controls, original failure log, and timeout. No completion or delivery credit is given.

Claim `3518:6371-canonical-audit-performance-20261001`, owner `ttraenkler/codex-6371-canonical-audit-performance-20261001`, was verified as in-progress on upstream `issue-assignments`. Isolated repair branch/worktree starts at the exact PR head. Root owns integration, validation and metadata; architect investigates read-only. Original published head and the seven-file source-identity draft remain unchanged.

Local first-row diagnostic (one selected test, 36 filtered rows not counted as coverage) passed in 23.33 seconds against the same unchanged code; CI recorded 52.96 seconds. Next measure the real fixture/dependency/fill/completion paths before choosing a semantics-preserving optimization. No timeout increase, admission weakening, stale validation cache, skipped control, or registry/provider substitute is authorized by this repair. Full IR migration and legacy parity remain open.

### Measured serializer bottleneck and implementation ownership

The direct exact-head CPU profile attributes 11,756 sampled ticks to recursive serialization in `wasm/physical/module-reservations.ts`, versus 1,932 collection-brand probe ticks. Every authenticating coordinate call freshly snapshots all completed function bodies. A post-freeze closure-token batch preserves every coordinate and one fresh ledger audit per owner call; a reentrant getter that swallows a phase error must still be rejected after the batch. Reserving behavior and all canonical body checks remain unchanged.

The physical snapshot writer owns only `src/wasm/physical/module-reservations.ts` and new `tests/issue-3518-physical-snapshot-comparison.test.ts` in isolated `/private/tmp/js2-ir-6371-snapshot-writer-20261001`. Replace only completed-function textual snapshots with a private immutable structural expected tree. Capture once at fill; every audit must traverse all live values again, preserve `Object.entries` sibling capture timing, ordered enumerable own string fields, array/byte tags, exact Float64 bits including NaN payloads and signed zero, present undefined, and active-cycle rejection. Preserve locals/body identity checks and all other ledger checks. Ignore the same hidden/symbol/prototype differences as the prior snapshot domain. Traverse later fields even after a mismatch so later errors retain precedence. No public completion permit or successful-validation cache. Root owns metadata, Git and serialized heavy validation. Differential controls must compare the actual new ledger with the authenticated original textual algorithm, not a second candidate invocation.

The first before/after stage measurements used different profiling instrumentation; treat their ~15% difference as diagnostic, not paired speedup proof. Final attribution requires the same harness/instrumentation and all original 37 rows at the unchanged timeout. Full normal gates and protected delivery remain required.

### First repair verification rows

The initial three-file cohort measured 192/193 passed, zero skipped: all 37 original mixed-owner rows and all authentication-performance rows passed; the sole failure was a newly drafted closure fixture using the special `promise:settle` metadata key for an incompatible reference signature. Preserve that original log; the fixture now uses explicit ordinary `batch:first`/`batch:alias` keys. No original control changed.

After adding the swallowed-phase-error regression, the unguarded batch measured 6/7 selected rows: the reentrant getter marked the private ledger failed while validation incorrectly returned. Adding the post-batch filling/sealed phase guard corrected that demonstrated defect. The full closure-resource plus authentication-performance cohort then passed **157/157**, zero skipped. These are scoped current-root measurements; protected CI and main delivery are still unverified.

The phase check also belongs inside the existing batch primitive: public `tx.state` can be shadowed, while the old next scalar audit checked private state. The snapshot writer is authorized to add an immediate private filling/sealed check after `physicalIndices`' live layout audit, with a reentrant getter/false-public-state control. No reusable validation permit or broader state-policy change. The closure owner keeps its phase check as an additional guard; tests cover both filling and sealed phases.

The first integrated snapshot/closure/authentication/ledger cohort measured **354/355**, zero skipped. All 49 new snapshot differential rows and existing physical/authentication controls passed. The only failure was root's newly added assumed type census of five; actual authenticated allocation showed external=0, root=1, both signatures use root=1, metadata=3 and4. The new control now explicitly checks that measured root alias and four distinct owner tokens; no original assertion changed. Preserve the failed run. This does not omit the interned function signature type: the full ledger audit still checks every registered type.

### Final scoped repair evidence before refreshed-main integration

The actual five-file cohort passed **392/392**, zero skipped: 107 closure, 149 ledger, 50 authentication, 49 snapshot differential and 37 unchanged mixed-owner rows. TS7 exited 0; LOC/function/oracle/coercion and compiler inventory pass. Dead-export gate is preservation-only6/6 full + 6/6 cut; graph OPEN, strict closure FAIL and retirement NOT CERTIFIED remain. The paired same-instrumentation diagnostic on exact e473 versus candidate measured 23.79s versus 17.16s (28% single-run reduction, not a CI timing guarantee). Durable rows/pins/handoff are `plan/log/3518-native-realm-quality-repair-2026-10-01/`. Fresh upstream main advanced before publication; preserve signed work and integrate the verified base before updating the existing PR. No main-delivery or full migration credit yet.

Normal-hook follow-up: two new snapshot controls used sparse array literal syntax rejected by Biome. Length-constructed arrays retain index0 holes, explicit undefined, length and key order. Appending seven controls also invalidated the historical exact-byte closure-test pin; the original100-row test was restored byte-exact and the seven controls moved to `tests/issue-3518-closure-coordinate-audits.test.ts`. Existing receipt SHA and assertions remain unchanged. Both original hook failures are retained in `.tmp/canonical-audit/`.


## 2026-10-01 — source validation/lowering prerequisite: real closed contracts

Claim `3518:source-validation-contracts-20261001`, owner `ttraenkler/codex-source-validation-contracts-20261001`, branch `codex/3518-source-validation-contracts-20261001`, starts at verified main `a8cd258d553278d8e5f908878f56a81377ba8e40`. The previous native-realm quality repair is published at `21c7922d5f8601aab52542690815d5b951796a14` in existing ready PR6371; three CI jobs were verified running when this lane began. No duplicate PR, competing repair dispatch or main-delivery credit.

The frozen seven-file source-call identity draft remains byte-preserved in its own worktree. Its actual graph imports mixed validator/lowerer debt from activated clean backend roots; 43 component rows do not make that graph valid. Implement the full prerequisite in dependency order: A genuine shared/core/runtime contracts and single-identity error/producer owners; B actual analysis/full verifier/allocation/class-layout bodies; C full program/runtime reconstruction and validator; D actual generic/Wasm lowering closure and contracts; E one source identity issuer and authentic primary fill integration, including genuine linear compatibility. The existing detailed architect specification is preserved under `.tmp/source-contracts/extraction-spec.md` and the source-identity handoff. No allowed-edge relaxation, callback validation permit, duplicated registry/class, facade toward debt or check omission.

Phase A writer owns new canonical preparation errors, global binding keys, declared types, fnctor ABI, neutral tag domain, runtime JS tag domain/default producer, remaining string runtime vocabulary, counted-string site-ID grammar, shared surrogate scanner, four runtime symbols and date callables; retain old paths as explicit aliases of the same implementation. Move only the exact bodies/declaration closures specified; keep rich outcomes, AST plans/proof/digest authority, provider ownership and global factories in their existing donors. Preserve class/function/object identity, optionality, comments, ordering and failure behavior. Root owns claims, issue/gate metadata, historical live-source relocation composition, integration/Git and one serialized heavy validation process. The writer is isolated and may not run compiler/tests or modify other lanes.

Baseline affected historical source/declaration instruments on pinned main before changing their live inputs. After body movement, authenticate complete actual source/facade bytes, exact declaration/body order and approved import substitutions; append one reciprocal outer relocation input before existing historical inverses, preserving every earlier receipt/hash, malformed-source control and original failure. Prove actual namespace identity and canonical clean import closure under the unchanged detector. Keep whole-compiler strict graph debt explicit. Only protected verified main merge counts delivery.

This is a required dependency of full source execution, not a replacement goal: all 45 intrinsic identities, 44 Call algorithms/lifted entries and two intrinsic Construct entries, complete Get/Call/Construct/source modes/this/newTarget/bound behavior, dynamic Function/eval/with, original public nine-row Number fixture, fresh-process replay and both-backend equality remain required. Retain legacy until all IR behavior is implemented, tested and equal. Do not declare complete from this contract phase.


## 2026-10-01 — wrap-up handoff and preserved unvalidated extraction

The user requested wrap-up and PR publication. The existing ready implementation stays in PR6371 at signed head21c7922d5f8601aab52542690815d5b951796a14 with protected auto-merge enabled; quality and issue-tests remained running at the recorded wrap-up read, so no main-delivery claim is made. PR6372 parameter projection repair is separately verified delivered as d1d7d68583ba312aa04f58f6144b3222a90c2d5e. Main ff564bcc adds only the official npm-compat refresh to the a8cd baseline.

Phase A source is frozen unvalidated in the isolated writer worktree:26 paths (12 new canonical owners,13 donor edits,one new suite), all live hashes checked against its manifest. No draft production/test files are included in the handoff PR. Before-edit a8cd historical cohort completed107 passed/35 failed of142 collected assertions, plus an ownership-file collection ENOSPC and a compiler-fixture heap abort. Exact raw failures and original receipts remain preserved; this is not passing candidate evidence and no gate/hash/fixture was weakened.

See [the durable wrap-up handoff](../log/3518-ir-wrap-up-2026-10-01/handoff.md), exact frozen manifest, original raw baseline rows and full A–E dependency specification. Reclaim the scoped source-validation-contracts claim on resume after verifying canonical ownership; stand-down releases its active claim, never the migration epic. Full IR/source/catalog/public-nine/replay/both-backend acceptance remains open and legacy stays until tested equality.


## 2026-10-01 — source-contract integration wrap-up

The new integration remains uncommitted at freshly verified main ff564bcc in `/private/tmp/js2-ir-source-contracts-integration-20261001`. Production TS7 passes; focused source/component tests 121/121, complete boundary suites 477/477, original ownership 22/22. Historical core remains 16/20 and program-data 37/47, with original receipts and failures preserved. New reciprocal reader has 65 drafted rows but is neither integrated nor tested; architect pre-A inverses are static findings only. No complete IR/public-nine/backend equality or retirement is claimed.

Ready documentation PR6374, “docs(ir): preserve migration handoff and extraction baseline”, preserves exact current source/test/metadata bytes, staged and unstaged patches, authenticated snapshots, executed JSON/errors, claim release and ordered resumption in `plan/log/3518-ir-wrap-up-2026-10-01/handoff.md` and its `resume-checkpoint/manifest.json`. The scoped source-validation claim is released on upstream issue-assignments (released_at 2026-10-01T03:13:54Z, write_id 68420-4cmsrof8); revalidate ownership before resuming. All worktrees remain preserved. PR6371's quality and issue-tests now pass, but it remains OPEN at 21c792 and is not delivered. Only verified main merges count.


## 2026-10-01 final source-contract stand-down and refreshed handoff

User requested wrap-up, handoff and PR publication. Continue the ready existing PR6374, “docs(ir): preserve migration handoff and extraction baseline,” rather than create a duplicate. Integrate exact verified main `0d94fc71681fd4988ae0ca32dda3a12f614e4b47`, preserving both sides of the sole shared issue-file conflict. Source work remains uncommitted and outside the documentation PR.

Current source branch `codex/3518-source-contracts-main-20261001` at `1265c47d` has 41 preserved staged/unstaged paths. Latest actual results: relocation65/65, components121/121, ownership22/22, boundaries477/477, program123/123 (76 new +47 original), core17/20, runtime69/75, historical runtime2/631. The 629 historical rows stop at the common positive source check; no claim of independently attributed defects. Production TS7 and main-based preservation gates passed; inventory1761 is valid but architecture incomplete. Reachability remains graph OPEN/strict closure FAIL/retirement NOT CERTIFIED. No fixture, timeout, hash or negative control was weakened.

The three-file core reader is frozen with 132 drafted rows, not integrated or executed. Runtime inverse specs preserve34 bounded spans and27 production inputs; implementation and real runtime tests remain outstanding. All exact source bytes, index/worktree patches, latest raw results, specifications and both static diagnostics are pinned in `plan/log/3518-ir-wrap-up-2026-10-01/final-checkpoint/manifest.json`. The earlier34 raw archives remain immutable. Read the updated handoff before resuming and reclaim through the canonical ledger: this slice was released and read back with write_id `76946-fhh4sf6o`, released_at `2026-10-01T03:42:15Z`; no other claim/reservation changed.

PR6371, “feat(ir): add native realm state and structural object access,” is now verified delivered as1265c47d: exact ancestry/content and all102 actual protected conformance shards plus final regression succeeded. Merge-group issue-tests was cancelled, so no all-CI-green claim. PR6372 remains verified delivered. The migration epic continues; public Number remains5/9, and legacy retirement requires complete tested equality. All worktrees and original failures are preserved; writers stopped and no heavy process remains.


## 2026-10-01 resumed core/runtime historical receipt implementation

The active migration goal resumes after the signed handoff publication. Fresh upstream main remains0d94fc71; source worktree/base1265c47d and all41 archived paths were verified. The scoped source-validation-contracts claim is reacquired on the canonical issue-assignments branch, authoritative write_id87615-9npim132. Existing handoff PR6374 remains separate documentation.

Integrate the exact frozen three-file core reader at only the three initial historical receipt reads; restore default parsing to raw current source for current closure/type/runtime checks. The132 new and20 original rows require actual strict execution. Never normalize existing injected mutants twice or refresh old hashes. Runtime inverse writer owns only three new helper/receipt/control files in its isolated worktree, preserving all35 prior frozen paths; root owns existing75/631 suite plumbing and all compilers/gates/Git. No static compatibility proof is credited as executed behavior. Preserve the original core17/20, runtime69/75 and historical2/631 results and the complete final acceptance.


Executed resumed core proof: strict single-fork152/152 PASS, zero skipped or worker errors:132 new live-reconstruction controls and all20 original vocabulary rows. The prior17/20 failure remains archived. Four moved/retained original receipts keep every old hash/count; all current runtime39-entry/Boolean-brand/async-authority checks and19 typed negative controls pass on raw current input. Production TS7 exits0. Formatting precheck found only existing test layout; helper/JSON frozen bytes were already clean and stay unchanged. This establishes affected historical controls, not full runtime/native/source/backend equality. Runtime75/631 remains unresolved pending the separately owned live inverse.


While the runtime inverse is authored, root remeasures the unchanged original nine-row public Number712 fixture against the current source checkpoint. The source pin c0550b99 and archived test bytes are preserved; a temporary ignored harness only selects that exact original file and keeps the existing timeout/heap/current config. No existing test, fixture, source or competing Number lane is edited. The previous5/9 remains archived; new outcomes require terminal evidence and do not certify both backends or dynamic-code completion.


Current public Number measurement preserves all9 rows:5 PASS/4 FAIL, zero skipped. All4 actual public IR cases still fail at preparation with js.number.from-value lacking a provider; the oracle and4 legacy cases pass. This re-executed native-realm/source-contract checkpoint does not meet the public fixture requirement. Durable raw evidence and core152/152 proof are pinned in plan/log/3518-source-contract-core-progress-2026-10-01/manifest.json. Complete migration and retirement remain unproved.


## 2026-10-01 user-requested final resumed stand-down

Refresh existing ready PR6374, “docs(ir): preserve migration handoff and extraction baseline,” with the executed core152/152 and unchanged public Number5/9 failures. Source remains uncommitted at1265c47d; all46 source/test/metadata/issue paths retain separate index/worktree bytes. Runtime writer froze three files with331 drafted, zero executed rows. Existing75/631 initial-read plumbing is also unexecuted; prior69/75 and2/631 failures remain. Full source/provider/backend equality and legacy retirement remain open.

The immutable resumed-checkpoint manifest and updated handoff pin raw executions, all source bytes/patches, runtime draft/static audit and release. Scoped claim read back released at2026-10-01T04:15:43Z, write_id 89776-u29luamo; no other claim/reservation changed. Writers stopped, no heavy process remains, all other worktrees preserved. Normal signed commit/fork push hooks and protected exact-head delivery remain required; the documentation PR is not migration completion.

## 2026-10-01 — resumed real source contract integration

Reclaimed scoped ownership3518:source-validation-contracts-20261001 through authoritative upstream issue-assignments for ttraenkler/codex-source-validation-contracts-20261001, branch codex/3518-source-contracts-integration-20261001, base freshly verified mainff564bccab11c53ae1aeaf1d510385e16b54a832. The ready implementation PR6371 and documentation-only PR6374 stay untouched. Full migration remains open; no retirement authorization is inferred.

Integrate the frozen actual Phase A body movements only after exact before/after hash checks. Keep the initial26-path freeze and known invalid derived-unit test role as original evidence; the writer produces a new revision correcting only that role to a genuine supported identity. Root owns authenticated historical input composition, precise inventory/JsTag-owner metadata, new-path budgets, integration and serialized compiler/test validation. Do not change allowed edges, earlier receipts, fixtures or control denominators.

The before-edit a8cd historical cohort remains107/142 passed with35 failures, a separate ownership-file ENOSPC collection failure and one compiler-fixture heap abort; these failures are not attributed to the draft. Diagnose and prove existing instrument/environment issues without skipping controls or hashing saved historical text in place of live production. Continue complete validator/program/runtime/lowering dependency extraction after contracts; all catalog/source/public-nine/replay/backend-equality requirements remain in scope and legacy stays until complete tested equality.


Resumed validation evidence: exact candidate production TS7 passes; new53 and existing68 component controls pass121/121. Whole source inventory1752 retains all1740 prior rows/policy/history and accepts exactly12 genuine closed owners (foundation9/core29/runtime17), with architecture explicitly incomplete. Current-main LOC/function gates pass25 changed source paths (+117 LOC); the prior unscoped origin-based read is retained but not used as main-based evidence. JsTag implementation exemptions relocate with the exact same population, no baseline allowances changed.

The full boundary execution passes477/477:352 semantic/provider controls (all prior349 plus3 additive activation corruption rows) and125 general compiler-boundary controls. The first125 run preserved a pre-existing frontend static-expectation failure; current-main’s three frontend roots were already present in the before-policy, and all are now pinned exactly while retaining the original contract root and prior allowed-edge/hash checks. Source-contract activation history is appended after the unchanged88 records; no older receipt is refreshed. Existing ownership source inverses move unchanged to one helper shared with program-data, preserving all3 source/intermediate/output hashes and original mutation controls. The previously uncollected ownership suite now executes22/22 after restored capacity.

Core fixture runtime checks now affirm the actually delivered39-entry vocabulary, exact Boolean-unbox branded result and canonical async guard identity while old historical38 receipts remain untouched. Bounded current-type VFS follows genuine async and String two-hop aliases with exact nonempty name populations; all19 negative controls remain. The real root-config TS5 fixture heap is4096 MiB rather than the overriding2048 that aborted; configured roots, real source, diagnostics, rows and timeouts are unchanged. Remaining historical drift is still open, and contract source is not yet committed/published.

## 2026-10-01 — fresh delivered realm integration and receipt repair

Reclaimed source-validation-contracts-20261001 for ttraenkler/codex-source-validation-contracts-20261001 on codex/3518-source-contracts-main-20261001, based on current upstream main1265c47d (native-realm PR6371 merged). The earlier 35-path worktree and published wrap-up remain immutable evidence; ready handoff PR6374 is untouched.

Integrate exactly the preserved26 source/test paths after checking all current donor before-pins against new main. Combine all newly delivered realm inventory/test changes with the appended source-contract metadata; preserve prior activation history, original historical receipts and every fixture/control. Root reviews and runs the frozen authenticated PhaseA reader, then exact pre-A program/core inverses at initial historical reads only. Raw current runtime/type compiler checks stay current. No executable snapshot, hash reseed, weak fallback, timeout increase or provider substitution. Independent writer ownership is limited to three new pre-A program helper/receipt/test files; no compiler/test/Git/network work is delegated. All full IR/population/source/public-nine/replay/backend-equality criteria remain open before retirement.


Fresh-main continuation: PR6371 “feat(ir): add native realm state and structural object access” is merged as1265c47d; exact repaired-source/test bytes and head ancestry verified. Actual protected Test262 run36808651261 has all102 concrete numbered shard jobs and final regression gate SUCCESS; matrix stubs are excluded. Merge-group CI's issue-tests job was cancelled, so all-CI-green is not inferred; exact PR-head quality/issue tests had passed. Raw records are in .tmp/source-contracts-main/pr6371-delivery-verification.json. Fresh-main metadata preserves all1749 current entries plus12 source-contract leaves (1761 total), both realm and source-contract activation test arms, and prior88 history plus3 additions. The newly integrated genuine live PhaseA reader executes65/65 controls; all13 inverses and25 forward owners are checked from actual source, with missing/mutation/blob/receipt/refusal controls. Old pending historical cohorts still require their remaining authenticated inverses.


Executed fresh-main receipt repair: all47 original program-data controls now PASS, including the genuine root-config TS5 positive/negative compiler fixture; all76 new full-pin/live-span/reciprocal/mutation controls PASS (123/123 combined, no skipped). Existing historical hashes and statement floors62/34 and41/28 remain unchanged; compiler input is raw current. Whole boundary suites remain477/477 on new realm main; new PhaseA reader65/65 and component/ownership controls retain their original populations. Production TS7 passes. Exact-main LOC/function (+117 LOC in25sourcepaths), JsTag/coercion/oracle and inventory gates PASS, with all1761 current metadata entries and architecture/graph explicitly incomplete. Remaining core17/20 and runtime69/75 failures are still preserved; core reciprocal implementation and later runtime policy/Boolean composition remain ongoing. Source stays uncommitted until affected preservation/gates and normal hooks are justified.

## 2026-10-01 resumed runtime reciprocal reader validation

After publishing the final handoff at5363fd87 in ready PR6374, “docs(ir): preserve migration handoff and extraction baseline,” resume the complete IR migration goal. The canonical slice claim is reacquired with write_id 92121-m1jz4k2t. Source base1265c47d and all46 archived paths remain intact; actual upstream main11661c31 differs only in benchmark/baseline artifacts. No other claims or lanes change.

Integrate the exact three-file runtime freeze33aa7477 after verifying all27 current production input pins. The331 controls are drafted, not passing evidence until actual execution. Root owns the preserved75/631 initial historical-read plumbing; current runtime/type/compiler inputs stay raw, and injected historical mutants are never renormalized. Preserve old69/75 and2/631 failures, every original hash/count/fixture/timeout, and the public Number5/9 failures. Run one strict heavy process at a time, new controls plus75 before all631. Full45/44/2 catalog/source/dynamic/replay/both-backend equality remains required before legacy retirement.


First strict runtime cohort executes405/406: all75 original rows pass,330/331 new controls pass, zero skipped/worker errors. The sole new shift-control mutant is a no-op when its final span already ends at EOF. Preserve the original log/JSON and freeze. A test-only revision relocates EOF spans to the beginning while every other span keeps end relocation; all331 rows, positive altered-source checks and raw-owner rejection assertions remain unchanged. Full631 original suite is executing using one fresh27-source capture per mutation proof, without cross-operation caching or mutant renormalization. Independent read-only implementation review finds no concrete defect but correctly limits the new metadata/raw negatives to their outer digest/hash guards. Full migration/public equality remains open.


Strict original historical runtime validation now passes631/631 (terminal0, zero skipped/worker errors), retaining every old receipt/census and all malformed/mutated source guards. This supersedes the common-positive2/631 result without deleting it. Genuine one-operation live capture and old inverse checks execute; no cross-operation success cache, stored executable fallback, source-hash refresh or timeout increase. The before405/406 failure and exact EOF-only revision remain immutable. Durable runtime progress is plan/log/3518-source-contract-runtime-progress-2026-10-01/manifest.json. Repaired331 and five original behavioral suites execute before gates and source publication; public Number5/9 and complete IR acceptance remain open.


Final runtime/behavioral cohort passes402/402 (all331 revised controls plus71 original tag/non-JS/fnctor-ABI/backend/dominance rows), no skipped or worker errors. Original runtime75/75 and historical631/631 are verified separately. Seven preservation gates pass with inventory1761/1761 tracked, zero errors and incomplete architecture; graph OPEN/strict closure FAIL/retirement NOT CERTIFIED remains. Fresh main812df162 contains the signed handoff by exact ancestry/content; source/test code is unchanged since1265c47d. Main LOC per-file ceilings/threshold remain equal and global ceiling is more permissive; final merge uses its actual baseline. A-only contract relocation is ready for normal signed hooks and implementation publication, not complete mixed source call or retirement.

## 2026-10-01 — source contract PR handoff

The signed source checkpoint `a42694443adf30798f980616bec3ec504ac9b65f` completed normal hooks with all twelve changed-root suites passing. Fresh canonical main `18a53eeca1601e35ef511492d9929db90474c75c` is integrated for publication; both issue histories and immutable receipts are preserved. The final handoff is `plan/log/3518-source-contract-runtime-progress-2026-10-01/HANDOFF.md`. This is phase A only: full extraction and original public/backend parity remain required, and legacy retirement is not certified. Publish the ready implementation PR through the fork and verify protected main delivery before calling this checkpoint delivered.


## 2026-10-01 — phase B complete verifier/allocation extraction resumed

Claim `3518:validation-lowering-phase-b-20261001`, owner `ttraenkler/codex-validation-lowering-b-20261001`, branch `codex/3518-validation-lowering-b-20261001`. Source dependency is the exact signed PR6378 head `63c5ce9ae1d5a77591abaff28e27fe974926bf4f`; canonical main `f37134584ee7ce68c43d9ea66381bd80be6b660d` was checked and its intervening changes do not alter these sources. PR6378 is pending protected checks, not verified main delivery. No other open PR touches the thirteen assigned source paths; older differently scoped claims are preserved.

Implementation plan follows phase B of `plan/log/3518-ir-wrap-up-2026-10-01/validation-lowering-extraction-spec.md`: repoint the five existing analysis modules to genuine clean allocation/core/string owners; extract the complete allocation provenance algorithm to analysis while retaining its optional debug wrapper at the facade; extract the complete function verifier to runtime, preserving all rules, prepared async attachments, error order, and default naive-dominance environment behavior; extract full program allocation reconstruction/metadata revalidation and nominal class-layout validation. Preserve existing values, registry namespaces and the single dominance cache through aliases.

The isolated writer owns only those donor bodies, four real canonical destinations and new focused semantic/identity controls. Root owns issue/claim/metadata/budget/source-receipt composition, heavy validation and publication. Freeze source inputs before edits; preserve original hashes, malformed/mutation tests and failures. Extend historical readers only through authenticated reciprocal relocation before their unchanged existing inverses; current compiler/type/runtime reads remain raw. No checks removed, no layer edges relaxed, no fake validation permit, duplicate registry/cache, executable snapshots or debug-default suppression. Before publication, incorporate verified phase-A main delivery and fresh main, complete normal hooks/checks, and use the protected queue.

Completion of this phase requires actual closed import graphs plus unchanged old/new API/semantic behavior, full original verifier/allocation failures and required refusal controls. It does not establish whole migration completion, public Number parity, full 45/44/2 catalog/source/dynamic coverage, fresh-process replay, either backend's full equality or legacy retirement. All remain required.

Phase-B pre-edit evidence: production TS7 passes; thirteen original suites measure 212/219, seven failures, zero skipped and no worker errors. Nine donor source hashes match the frozen pre-edit manifest. Seven existing rows fail before B: one old selector census and three final-allocation outcome arrays omit the current non-executable module-init row; three semantic ownership receipt/catalog rows expect the earlier intrinsic source/catalog rather than current added declaration/signature behavior and 39 versus 38 catalog entries. Preserve them as baseline failures, not extraction regressions, and do not weaken their original fixtures/hashes/counts. Exact rows and raw evidence are pinned in `plan/log/3518-validation-lowering-b-2026-10-01/resume-checkpoint/baseline/manifest.json.raw.txt`.

Additional pre-B boundary baseline: 353/457, 104 existing failures, zero skipped and no worker errors. Semantic-provider boundary passes352/352. Program-data boundary has one passing row and104failures:102 fixture setups fail before mutant injection at the unchanged historical intrinsic declaration receipt; two older policy assertions have stale history selection/current floors. This is one shared setup defect rather than102independently reached refusals. The initial fixture reader now composes the already-verified 27-source runtime evolution once per proof before the unchanged historical inverse. Original fixture source/rawfailedlogs are archived, fixed40/44module denominators/hashes and all mutant assertions remain; no saved executable fallback or cross-proof cache is added. Exact policy evolution and actual-B activation changes remain to validate after frozen source integration.


## 2026-10-01 — final Phase B stand-down and publication repair

The user requested wrap-up and handoff publication. Phase B is frozen as 14 pinned paths (13 changed), 133 preserved declaration transfers and 39 drafted controls; no candidate compile, tests or actual boundary gate were run. Production files in the integration remain at the phase-A dependency. The original 212/219 and 353/457 failing baselines remain immutable; the partial initial-reader probe is 0/2, exposing missing historical source projections rather than healthy positives. The complete frozen writer, root patches, original rows, policy review and read-only graph findings are archived as inert raw files in [the continuation handoff](../log/3518-validation-lowering-b-2026-10-01/HANDOFF.md). Only the Phase B claim is released (40138-k7ulq2nc, 2026-10-01T05:53:19Z); verify and reclaim before resuming. PR6378 remains the ready phase-A implementation. Its first quality run found three evidence citations still targeting the old string facade. Their paths now target the exact canonical live declarations, with every quote, verdict, count and ratchet unchanged; the real kind-neutrality gate and all five original evidence controls pass. Fresh canonical main88cdb141 is integrated for the normal signed publication. Only verified main ancestry/content counts delivery. Full IR parity and legacy retirement remain open.


## 2026-10-01 — verified Phase B integration and candidate execution

Resume the complete migration goal under canonical scoped claim `3518:validation-lowering-phase-b-20261001`, owner `ttraenkler/codex-validation-lowering-b-20261001`, write_id `63764-feehmtqm`. Isolated integration is `/private/tmp/js2-ir-validation-lowering-b-resume-20261001`, branch `codex/3518-validation-lowering-b-resume-20261001`, exact dependency0e4638af and canonical main88cdb141. Ready PR6378 remains open/unmerged; B publication waits for actual prerequisite main delivery. The complete prior wrap-up and local46-artifact supplement preserve every unfinished draft and failure. The prior stand-down release remains historical evidence, not current ownership.

Implement the already-reviewed full verifier/allocation/class-layout body extraction and exact Phase B policy delta. Root independently verifies all14 writer paths, all9 original donors and fixed before policy, then copies only13 changed source/test paths. All original133 canonical declarations and2 retained wrappers, public API/identity/cache/error order/async attachments/default dominance and optional debug behavior remain required. No old code is retired. The original219 and457 failure populations and first raw outputs remain preserved. Root owns metadata/budget/source-reader joins and one heavy compiler/test/gate slot; three disjoint native writers own only their fixed preservation/graph/policy helpers and tests. Execute the real candidate before drawing conclusions.

Budget transfer (2026-10-01): move the touched-issue LOC allowance from old src/ir/verify.ts to canonical src/ir/runtime/verify.ts, whose complete algorithm is preserved2865→2868 lines solely from imports. Grant only relocated src/ir/runtime/verify.ts::verifyInstrStructure (381 actual inclusive lines, body hash unchanged). verifyBlock is200 actual lines; historical379 baseline is not a current measurement. Remove the obsolete LOC grant, do not duplicate it, and preserve shared baseline files. Full migration/native catalog/source/dynamic/Number/replay/both-backend equality and retirement remain open.


### Phase B assigned implementation slices and first measured results

User reaffirmed repo-file issue tracking and native agent fan-out. Root updates this epic for each owned slice; no GitHub issues are created. All native writers run Codex GPT-6 Astra Max, appropriate for complete fail-closed byte-preservation/AST-role/history authority proofs. Integration/evidence owner is Codex GPT-6 Default. Scope is disjoint, existing isolated worktrees are reused and no source/test work is duplicated.

- Source preservation owner `astra_native_builtin_functions`: complete live-only9→13→9 reciprocity helper and fixed receipt, exact135 transfers including2 retained wrappers, seven individually authenticated inline type-import rewrites, full source docs/private/order/import coverage and fresh-read/corruption controls. Original14 candidate paths must remain unchanged.
- Historical graph owner `native_builtin_callable_inventory`: full4-output/17-input initial-only reconstruction and controls; root owns fixture joins. Actual historical physical authority is now verified from original Git objects and introducing4b00bce, not a narrative or executable archive fallback.
- Policy owner `astra_builtin_functions_plan`: authenticate full current1765/history94 policy before exact original56/9 projections; retain complete original91 prefix, allowed edges, original174fixture, native98/floor97, legacy nested mutation behavior and all old hashes/counts. Root applies metadata/budgets and owns program-data historical view joins.

Actual integrated production TS7 exits0. All39 new verifier/allocation/class-layout semantic/API/type controls pass, zero skipped or worker errors. First new graph suite measures128/129: one retained-kernel initializer negative fails before detector injection because its text locator is ambiguous. The owner is repairing only the locator to a unique genuine retained declaration; preserve paired healthy source, real mutation and unchanged refusal assertion. Original first raw JSON/log remains under `.tmp/validation-lowering-b-resume/first-integration/graph-controls.*`; this is not a passing129 suite. Policy draft review found a separately scoped issue: its copied history was frozen before original test mutants could edit it. Return a fresh mutable copy for old mutation inputs while keeping full actual-policy/fixed-receipt authority authenticated; add a regression proving no source-policy mutation or successful-cache leakage. Candidate original219-row run is live; no baseline change or full migration/parity conclusion is asserted.


### User model-routing amendment — Astra specifications, Sol6.1 implementation

The user explicitly requires Astra to specify hard tasks and write implementation plans in repo issue files, and Sol6.1 to be the default implementer at reasonable effort. Epic implementation defaults are now model:gpt-6.1-sol / reasoning_effort:high; use medium for straightforward bounded repairs and high/xhigh only where the actual task warrants it. AstraMax is retained for hard architectural specification/review, not blanket code implementation. Preserve historical attribution: existing frozen source/helper drafts were produced by AstraMax; any later Sol modifications carry their actual model/effort. Do not relabel inherited code as Sol-authored.

Astra source writer froze its current3-path helper/receipt/test at manifest d52e084aa3af641a279de34f4e49943437440b031dba9ff14e3827b20196a6b9, original14sourcepaths still exact. Native worker `sol_phase_b_preservation`, Sol6.1High, now exclusively owns review/implementation of these3paths in the preserved isolated writer worktree. Astra architect `astra_builtin_functions_plan` owns only a new isolated implementation-plan appendix for the unresolved historical graph edge; root merges that appendix, retaining current issue history. Root remains the integration/evidence owner and sole heavy validator.

New graph/policy controls execute192/192 (129+63), no skipped/worker errors. Original219 remains212/219; exact failed-row names and first error text match pre-edit evidence, zero new failures. Historical metadata positives pass2/2, but both original graph positives still fail exact original edges: inventoryvalid40modules/110edges and44/120, one additional runtime import each. Original109/119 expectations remain untouched. Actual full detector reports are saved for the architect; diagnostic inventory success does not certify historical fidelity.


## 2026-10-01 — implementation plan: Phase B initial graph fidelity and complete source preservation

This is an Astra Max architecture specification. Root owns integration, claims, production metadata, budgets, serialized compiler/test/gate execution and publication. The assigned Sol 6.1 High implementer owns only the explicitly dispatched helper/receipt/control files; root merges this section by append. Preserve other writers' source and historical evidence. The scope is faithful preservation of the complete Phase B extraction, not a new intrinsic implementation or a migration-completion grant.

### Measured starting point and exact remaining edge

The current integration is `/private/tmp/js2-ir-validation-lowering-b-resume-20261001`. Its saved `first-integration/reviewed-controls.json` records all 129 initial-graph reconstruction controls and all 63 full-current-policy controls passing. Those helper proofs do not establish the older actual graph assertions. The original 219 behavioral controls still measure 212 passed and the same seven failures, with identical first errors and no new failing rows. Preserve that baseline and its original fixtures. The selected four older boundary controls have two passing policy/history rows and two failing actual graph rows; the other 101 were unselected in that diagnostic, not executed successfully.

The authoritative `first-integration/current40-report.json` and `current44-report.json` both resolve every module and have no unknown/unresolved/forbidden edges, transitive violations or inventory errors. Their edge counts are 110/120, respectively. The unchanged assertions require:

| Historical fixture | Modules | Resolved edges | Import / export-from / import-type | Type-only / runtime |
| --- | ---: | ---: | --- | --- |
| Original contract graph | 40 | 109 | 89 / 19 / 1 | 99 / 10 |
| Original ownership graph | 44 | 119 | 98 / 20 / 1 | 102 / 17 |

The single extra runtime edge is `src/ir/core/types.ts:8` to `src/ir/core/binding-key-primitives.ts`, importing `requireBindingId` for `irSupportRef`. It is a genuine later source evolution. Commit `efe352fee8afc3feb6a28c34d00fc658dc1fb205` introduced the import, support-reference interface/factory, union member and equality branch. Root's complete before/after sources prove that its parent equals the original core-types source at `3a119a88b28bb347f4faaaa2146bd991acf61228`, and its after source equals current production exactly.

The earlier ABI-import suspicion is disproved. `src/ir/program/abi.ts` is byte-identical at canonical introduction `e90f2a14aa263084cf94449b706b3df07bf30d71`, the fixture revision `3a119a88`, and current production: 32,535 bytes, SHA256 `29591c6feab869c6780144aabcc413afafa38e4adbc8c3f8d5b7bcdc7e9c833d`, Git blob `c9240ad8bc83c36774a7def20db27425252f459a`. Preserve its `irSourceGlobalBindingKey` import and `ProgramAbiMap.validateInventoryMembership` guards. Removing that valid unchanged import or changing 109/119 would conceal the actual defect.

Root's source authority is saved under `.tmp/validation-lowering-b-resume/graph-history-authority/`: `manifest.json`, `formatter-support-authority.json`, complete original/introducing-parent/introducing-after files, and `formatter-support-delta.patch.raw.txt` (SHA256 `19b43ecc7cb155dbc00f41388d3923e47b3147aedf4575ee5e53adfb7b474b79`). Archive these as non-executable provenance when publishing. They authorize fixed receipt pins; the eventual helper must never read archived source, Git or a saved executable snapshot at runtime.

### Bounded core-types graph evolution: exact ownership and API

Add only these three independently owned files:

- `tests/helpers/ir-program-core-type-evolution.ts`
- `tests/helpers/ir-program-core-type-evolution.json`
- `tests/issue-3518-program-core-type-evolution.test.ts`

Root owns the narrow initial-copy join in `tests/issue-3518-program-data-contract-boundary.test.ts`. Leave the existing `ir-program-initial-graph-evolution.ts/.json` and its 129 controls unchanged: their four-output, seventeen-input authority is already measured and does not own this additional source transformation. Do not repurpose the broader core-vocabulary or runtime inverses; their receipt domains do not implement this core-types evolution.

Expose `reconstructProgramCoreTypeEvolution(rawReader)` returning exactly one historical source entry, `src/ir/core/types.ts`, and an explicit `readBeforeProgramCoreTypeEvolution(path, rawReader)` if needed by the initial reader. Mapped reconstruction must authenticate its fixed receipt digest and the complete live input/dependency pins before returning any output. Unknown paths remain raw; a missing or altered mapped input must throw, never fall back. A diagnostic receipt/span validator may support mutation tests but must not authorize reconstruction with caller-authored receipts.

The receipt must pin:

- Original core types: 31,278 bytes, SHA256 `49f0b751abc784cff47501d3309a1e2d20307ce5c3a460bab1a60ef3bb19dac5`, Git blob `ba531205b0429574c6e675dd456dd8487b22923f`.
- Current core types: 32,296 bytes, SHA256 `58d3795e4f38002798fbdb93c7599f74cb422555ba0ed84f160a51aec52543a2`, Git blob `db0b740a300009d035b7af28377bf0333e023105`.
- The genuine newly imported dependency `src/ir/core/binding-key-primitives.ts`: 1,497 bytes, SHA256 `9b5715139c147146b4ed29d972e5ffad677e4fe496c95868b9ecc8935e57fa24`, Git blob `76364db86fb07972f66a78a886d66197e2355f6a`.
- Original fixture/source revision, actual introducing commit and parent, and full patch authority above. Do not claim the absent canonical ABI path at `f95d8a0` as an original core-types source.

The only five approved removal spans in the current core-types file are zero-based, half-open UTF-8 byte intervals:

| Role | Current interval | Original insertion offset | Current span SHA256 |
| --- | --- | ---: | --- |
| `requireBindingId` runtime import, including newline | `[429,493)` | 429 | `c15c8a493239514f1f02b35958fba28ba9988d69b2e403d7419f5474ba7cf338` |
| `IrSupportRefType`, including attached documentation and spacing | `[1847,2138)` | 1783 | `b92cd6cf1b3b97cef43eea24a9765cf788561a81d06b09d5f0ce517bd6f212f1` |
| `irSupportRef` factory and trailing spacing | `[2138,2627)` | 1783 | `23431b972e35d90ee52a9d994000681a416ca541995a2cf50eb28482e566c7ff` |
| `IrType` union member | `[14059,14080)` | 13215 | `3fe70544aa4637ee05df322539fb1fc5a80a496334c577d56a284942cb1f8830` |
| `irTypeEquals` support-reference branch | `[24757,24910)` | 23892 | `629873380465d9802fb18df627a04c78b2346591ecf891ba21c7e692ae22d9e2` |

These spans total 1,018 bytes. Static byte arithmetic independently reproduced the complete original and then the complete current file from those actual live slices; no compiler, checker or test was run for this proof. The interface and factory share original insertion offset 1783: forward replay must retain their explicit interface-before-factory order, not reverse them through repeated insertion at one offset.

Implementation must check current full-file SHA/blob/length first, then exact declaration/import and nested owner roles with syntax parsing, unique contextual anchors, span bounds, UTF-8 boundaries, order and complete span pins. Reconstruct the historical file from the untouched live remainder only. Authenticate its complete original SHA/blob/length and declaration census, then forward-replay the five captured live spans at their authenticated old coordinates and require byte-for-byte equality with the full current source. Pin attached documentation and the retained `irTypeEquals` body too; do not accept an import-only deletion that leaves an unbound factory. Receipt data contains coordinates, pins and non-executable anchors, not an old factory implementation. Every operation freshly reads its input and dependency; successful source authentication must not be cached across operations.

### Initial-copy placement and required adversarial controls

In the old boundary suite's `fixture(includeOwnership)` (current line 132), keep the actual raw reader and existing runtime/program reconstructions. Compute the new core-types reconstruction from that raw reader before the initial module-copy loop. In the loop select its authenticated result only for `src/ir/core/types.ts`; retain the existing intrinsic and four program-source arms. Do not feed the projected core-types source into the existing seventeen-input program reconstruction: that owner correctly authenticates current core types as a raw dependency. Each source view has one explicit initial-copy purpose.

After copying, `put`, `append`, `run`, ownership additions and all existing source/policy mutants must operate on the actual scratch files without another normalization pass. Keep fixed 40/44 modules, original 109/119 edges, all syntax/type splits, original outgoing ownership edges, policy hashes/floors and transitive witnesses. Do not alter detector logic, allowed edges, activation rules, source lists or timeouts. Current compiler, runtime and type fixtures continue reading real production, including the actual `irSupportRef` implementation and the raw `issue-3518-symbolic-support-ref.test.ts` behavior.

New controls must prove both complete-source inverse and reciprocal replay, exact input/output populations, all five owned roles and their two same-offset insertions. Include meaningful missing-source/dependency, wrong full SHA/blob/length, changed import module or type/value form, deleted/duplicated/reordered interface/factory, changed factory validation/return, changed union member, changed equality condition/body, documentation and unrelated retained-body mutations, shifted/overlapping spans, swapped same-offset replay order, altered provenance/receipt and extra executable declaration failures. Warm a successful read, then mutate the next live read and require refusal; returned history or a caller-supplied mutant must not become an accepted current input. Assert each mutation actually changes its operand. Preserve all existing 129/63 controls and add real post-copy edge/source mutants demonstrating the new projection cannot erase later injections.

Root acceptance is the new helper's complete collected population, both unchanged actual 40/44 positives, then the full original 105 boundary controls and affected semantic/provider boundary cohort, with zero hidden setup omissions or worker errors. Preserve the initial 110/120 failures and the earlier ENOENT diagnostic instrumentation failure. A correct reconstruction helper alone is not a passing original graph; only actual detector execution on the restored fixtures establishes those positive controls.

### Final Phase B nine-to-thirteen source-preservation acceptance

The separately assigned source-preservation implementation remains:

- `tests/helpers/ir-validation-analysis-relocation.ts`
- `tests/helpers/ir-validation-analysis-relocation.json`
- `tests/issue-3518-validation-analysis-relocation.test.ts`

Its frozen receipt starts from the nine actual donors: `analysis/{lattice,ownership,encoding,escape,dominance}.ts`, `verify-alloc.ts`, `verify.ts`, `program-allocations.ts`, and `program-class-layouts.ts`. The thirteen live files are those nine plus `analysis/alloc-verification.ts`, `runtime/verify.ts`, `program/allocations.ts`, and `program/class-layouts.ts`, all under `src/ir/`. Preserve the frozen source pins and the genuine 133 canonical declarations plus two retained optional wrappers: 135 one-to-one transfers, 67 transfers between files, and exactly seven inline `ImportType` module-string rewrites. Reconcile these exact records, not just a selected exported-name count.

Implement the fixed receipt against one fresh capture of all thirteen complete current sources per operation. Check SHA256, Git blob, lengths, declaration kind/name/occurrence/order, private members/initializers, attached documentation, import/export form and every exact token rewrite. Reconstruct all nine originals exclusively from live current declaration slices plus non-executable import/export/comment/spacing scaffold, require each whole original pin, then replay all thirteen complete current files. Every current declaration and facade residue needs exact ownership; no executable text may come from a stored historical snapshot or unreviewed replacement template. Keep canonical error class, allocation registry, dominance cache and function identities; preserve complete prepared-async verifier checks and optional intermediate versus mandatory final provenance checks.

The actual facade already imports `assertFinalAllocProvenance as assertVerifiedAllocProvenance`, so the retained optional wrapper's original call spelling and body remain unchanged. Do not add the previously considered executable call rename, duplicate a private algorithm or change production merely to simplify the receipt. Pin only the seven actual inline type-import token rewrites. `lattice.ts` is byte-identical across views; do not promise a distinguishable double-normalization refusal for that unchanged file.

Required controls cover all thirteen mandatory live owners, all nine outputs, missing/wrong source, fixed receipt authority, stale/wrong whole and declaration pins, lost/duplicate/reordered declarations or facade exports, optionality/readonly/docs changes, mutated algorithm and private state, changed type/value import or inline import qualifier, extra executable source, wrong reciprocal coordinates/coverage and fresh-read corruption after a successful operation. Any malformed-receipt component validator remains separate from the fixed reconstruction authority. Existing historical mutants remain raw after their first view is constructed. Actual compiler/type/runtime inputs remain current.

Root runs this complete new proof, the already collected 39 new semantic/identity controls, affected existing verifier/allocation/backend/async controls, and compares the unchanged original 219 population against its preserved 212/219 baseline. No new failure or silent-empty success is acceptable; the seven separately attributed existing failures are retained, not repaired by filtering module-init rows or replacing old intrinsic receipts. Static reconstruction and declaration counts do not establish runtime preservation by themselves.

### Budget transfer and publication limits

Transfer the existing large-file allowance from `src/ir/verify.ts` to its actual canonical owner `src/ir/runtime/verify.ts`. The narrowly required function allowance is `src/ir/runtime/verify.ts::verifyInstrStructure`, preserving the original 381-line body exactly (original lines 640–1020, 16,304 bytes, SHA256 `dea7b10ff74257299961f88eb19c7951dad3c059b269b4ed287d34783fffe5df`, Git blob `562c1e9c992294cbf9db586afb667d8d45b3f333`). Root owns this metadata edit and actual budget gates. The real original `verifyBlock` is 200 lines and `verifyInstrTypeRules` is 299; the stale committed `verifyBlock:379` baseline is not authority for another allowance. Do not edit baseline JSON, expand a global threshold or split unchanged algorithms merely to satisfy a budget.

Keep the reviewed 1,765-row policy, whole 91-record prefix plus exactly three B activations, unchanged allowed edges, exact historic 56/40/44/174 views and raw-current classifications. Current architecture remains incomplete. This preservation checkpoint does not complete genuine mixed Get/Call/Construct, the complete 45-catalog/44-Call/two-Construct population, bound and dynamic Function behavior, eval/with, original public Number 9/9, fresh decoded replay or either backend's full observable equality. All remain required before legacy retirement.


Sol 6.1 High scoped mutation-locator repair now executes all 116 source-preservation controls successfully, zero failed or skipped. Only the two test mutation strings changed; the source helper, receipt and all thirteen production owners retain their frozen hashes. First 115/116 evidence remains preserved. Actual corrected execution: `.tmp/validation-lowering-b-resume/first-integration/analysis-corrected.json`.


Actual provider/support-ref execution: all352 semantic/provider boundary controls pass on the integrated B candidate. Raw current symbolic support-ref suite measures15/20; the same five rows fail on exact pre-B dependency0e4638af with identical first error text. Its test/coretypes/ABI facade/canonical factory sources are byte-identical before and after B. All five stop at the original two-body relocation hash positive, so their four mutation refusals are not credited. Preserve these existing failures and hashes; do not remove production support-ref behavior to force historical graph counts. Exact paired records are `first-integration/provider-support-controls.json`, `support-ref-before-b.json`, and `support-ref-comparison.json` under `.tmp/validation-lowering-b-resume/`.


Sol 6.1 High bounded core-type implementation is integrated as exactly three new helper/receipt/control paths, fixed receipt SHA7656fac126fa982f114f900382e6f3a256d417d3750406a142e96df22d6f80e2. Root independently verifies seven actual live source/blob pins and full reconstructed original bytes against the measured efe352 Git authority (actual parent721cd33a828c89cfc04c851b011f910b76a4d2c5). The earlier129 initial-graph helper files remain byte-identical. All49 new controls execute successfully with zero skipped/failed. Root joins the single core/types historical source only at initial fixture copy, after other inverses independently capture authentic current inputs. Four selected old positives now pass: metadata2/2 plus actual graph40modules/109edges and44modules/119edges. Their original counts, syntax/type populations and policy hashes remain unchanged;101unselected controls are not yet credited. Actual full105 execution is running. Original110/120 failure evidence remains preserved.


Complete original program-data boundary executes105/105 with zero skipped, failures or worker errors. Combined with the already executed352/352 semantic/provider controls, both unchanged original boundary populations pass457/457. The first failing baselines, diagnostic110/120 edges and selected-only runs remain preserved. No historical receipt/hash/count/negative assertion changed. Targeted additional TS7 coverage of nine new helper/control paths finds four type-only diagnostics outside the production TS7 project: two Array.isArray callback implicit-any annotations, a syntax Statement-to-NamedDeclaration assertion, and a readonly-to-mutable assertion in an intentional JSON-copy negative. Two existing Sol6.1High isolated workers own these narrow annotation repairs; fixed receipts, runtime expressions, test populations and production code stay unchanged. Preserve the first typed diagnostic log.


Targeted TS7 of all nine new B helper/control paths now exits0 after four type-only corrections from the two Sol6.1High workers. Root verifies exact callback annotations, compatible syntax-name cast and readonly JSON-copy mutant cast; runtime expressions, all fixed receipts and every test row/assertion are unchanged. The original first four-diagnostic log remains preserved. New helper revisions are initialgraph0fe14c4a…, analysis05f37c0b…; coretype test15f1a8ba…. Actual production TS7 already passes independently. Original model ownership remains Astra for frozen source/initial helper logic and Sol for the bounded core-type implementation and its scoped later repairs.


Actual candidate gates: compiler inventory accepts1765 rows with zero inventory errors, sourceRevision0e4638af and exact canonical-main comparison88cdb141. Four new production files remain unstaged/untracked (1761tracked/4untracked), so do not report final tracked delivery. All nine activated B owners are clean with54 resolved outgoing source edges and zero unknown/unresolved/forbidden outgoing edges; the unchanged pure lattice owner legitimately has zero imports and its whole declaration source is authenticated by preservation pins. A first reporting-only hypothesis requiring imports from every owner was rejected by that measured shape; no detector or gate changed. Global architecture/graph remain incomplete. JsTag and kind-neutrality gates pass. Canonical-main-scoped oracle/coercion gates pass; the earlier default-origin coercion result overincluded64 unrelated codegen files and is retained as a diagnostic, not candidate-scope evidence. LOC/function gates already pass unchanged production against the same exact main base; shared baselines are untouched. Normal signed commit/hooks, prerequisite main delivery and protected publication remain required.


Pre-commit delivery evidence: canonical scoped claim63764-feehmtqm reverified, canonical main directly reverified88cdb141, PR6378 still open at exact dependency0e4638af. Explicitly staged B files now produce a real1765/1765 tracked inventory (zero untracked, zero inventory errors), superseding the preserved pre-stage1761/4 snapshot. Whole architecture/graph remain incomplete. Durable49-artifact measured archive is [the Phase B integration handoff](../log/3518-validation-lowering-b-2026-10-01/integration-2026-10-01/HANDOFF.md); manifest f37072aaf032763892dec2930b67e001b0bcd28796d4f0ac30856e253c7ad8d3,819056 raw bytes. Production14 frozen pins and16 previous integration checkpoint pins reverified before stage. Normal signed hooks are next; no bypass or main delivery is claimed.

### 2026-10-01 — normal-hook lint repair, Sol6.1 Medium

The first full normal commit hook stopped at two test-only lints and made no commit. Sol6.1 Medium renamed the local `escape` binding and changed the deliberate sparse-array mutation to `Reflect.deleteProperty`, with explicit successful deletion, unchanged length and absent-own-index assertions. The control still creates a hole; assigning `undefined` was rejected as a semantics change. No production source or fixed receipt changed, and the existing39 verifier and63 policy rows remain the required rerun population. Original failure log, exit and exact before/after test hashes are preserved in `plan/log/3518-validation-lowering-b-2026-10-01/lint-repair-2026-10-01/`. Thirteen production pins stay byte-identical to the original Astra freeze; its original test pin remains immutable historical evidence, superseded only for this reviewed lint repair. Root owns actual validation and full-hook retry.

Root rerun after the lint repair:102/102 affected controls pass (39 verifier,63 policy), zero skipped/unhandled errors; targeted TS7 of all nine new preservation paths exits0. Scoped Biome and Prettier pass. Production freeze hashes verified unchanged. Full normal commit hooks remain the next acceptance step.

## 2026-10-01 — PR6378 quality blocker: fresh capture inside one historical proof

Exact prerequisite head0e4638af fails quality job110246367505 in run36824281778: historical-runtime suite630/631; the explicit intermediate-view/overload/denominator positive test times out at the existing35000ms limit. Root local full suite631/631 passes (883772ms total), so this is runner-cost sensitivity, not permission to waive the failure. The single positive repeatedly invokes `readRuntimeContractReceiptSource` through global `read`, re-authenticating the entire27-source composition for each census/view.

Bounded Sol6.1 Medium implementation plan: own only tests/issue-3518-historical-runtime-reconstruction.test.ts and only this existing positive test. Take one fresh `currentHistoricalRead()` at the start, pass it to the original positive and all existing read/view/census operands inside this same proof. That existing helper authenticates the full fixed population and falls back to raw current data for out-of-domain paths; retain it unchanged. Preserve every test row/name, expected hash/count/overload/shape and all630 remaining mutation controls. No module/global/cross-operation cache, retries, fallback, source/helper/receipt or timeout change. Root verifies the exact diff, runs selected before/after controls and full631 cohort, commits with normal hooks and updates existing PR6378 through the fork. No duplicate PR or gate bypass.

Scoped canonical ownership verified: `3518:pr6378-historical-capture-20261001`, owner `ttraenkler/codex-pr6378-historical-capture-20261001`, branch `codex/3518-pr6378-historical-capture-20261001`, write_id `18840-to2baw11`. Sol6.1 Medium owns the one existing positive test only; root owns issue evidence, Git, all actual verification and existing-PR update.

Root exact selected comparison on the unchanged Node25/Vitest single-fork harness: original positive passes1/1 in23419ms; Sol Medium repaired positive passes1/1 in859ms. Both intentionally leave630 unselected rows uncredited. All18 assertion expressions/41 literal values and the53251-byte outside-proof residue remain unchanged; existing35000ms timeout and every helper/receipt/mutation function are unchanged. Scoped Biome/Prettier pass. Full631 acceptance awaits the normal signed commit hook. Exact CI failure, original/current patch and selected runs are preserved in `plan/log/3518-pr6378-quality-capture-2026-10-01/`. User routing is now reflected in epic frontmatter: Sol6.1 default, high for this complex epic; Medium for this bounded repair, Astra for hard specs.


## 2026-10-01 — delivered prerequisite and fresh Phase B integration

The user confirms Astra writes implementation plans for hard tasks in plan/issues; Sol6.1 Medium is the default implementer. Raise effort only for a concrete unresolved difficulty. Historical model attribution remains unchanged. Legacy remains operational until all IR coverage, tests and behavioral equality are complete.

Prerequisite PR6378, “refactor(ir): isolate canonical semantic contracts,” delivered exact signed head a5cf2e922e33beea974e42d032152596f05af271 as main merge2030fafc70e46a135aec9c1efa372942d917b62c. Full fresh PR178/178 path blob/mode/type comparisons match; exacthead is second parent. All102 actual queue Test262 shards (82standalone,20host), final regression and differential gates passed. The separate merge-group CI run/issue-tests was cancelled and remains uncredited; post-main benchmark validity and three memory failures are preserved, attribution unproved. Delivery of this prerequisite does not establish complete migration.

Phase B branch codex/3518-validation-lowering-b-resume-20261001 starts at signed clean23ddb71a0ecfa3ef2bede4546e551321e66f34f6. Fresh canonicalmain a8955988411c197304f1897ae592c7bb606ac122 includes2030 and adds only benchmark reports and a LOC baseline update. Root integrated this exact main without committing; the sole conflict was this append-only issue. Both complete historical appendices are preserved. Thirteen production freeze pins are to be reverified; refreshed normal hooks/checks, signed commit and fork publication remain pending. No B/C1 delivery credit. Canonical scoped ownership remains3518:validation-lowering-phase-b-20261001/write63764-feehmtqm.

Root integration preflight: all13 original production pins remain exact after main merge; the only refreshed root test is the already-delivered historical-runtime proof. Normal merge commit hooks use CHANGED_ROOT_TESTS_BASE=exact signed B parent23ddb71a to select that complete631-row cohort, retaining earlier2430/2430 B acceptance and unchanged receipts. No hook bypass or changed detector threshold. Newmain benchmark/baseline changes and issue appendices preserved; signing and publication remain pending.

Independent production continuation: Sol6.1 Medium runtime-definition checkpointV2 now passes configuredfocusedTS7 and38/38 original runtime rows (earlier32/38 sixfailures and logs preserved). The two foreign-defect observation rows remain incomplete replay coverage; this checkpoint does not claim42pending algorithms or2Construct implemented. Newly claimed physical exception-reference support passes18/20 actual engine/assembler rows; two failures expose existing object-link global displacement and WAT signature-index defects. Astra High wrote the linker implementation plan in the separate issue worktree. Additional linker source scope remains withheld pending reconciliation of held3518:object-link-function-indices; no fake/fullacceptance credit.

## 2026-10-01 — isolated WAT numeric-type preservation dependency

Root owns canonical slice `3518:wat-type-index-preservation-20261001`, assignee `ttraenkler/codex-wat-type-index-preservation-20261001`, branch `codex/3518-wat-type-index-preservation-20261001`, freshly verified base `a8955988411c197304f1897ae592c7bb606ac122`. Claim write and canonical effect verification succeeded; the script also warned its main issue lookup found no file, so that warning is retained in the raw receipt rather than treated as issue absence. The issue is present in this exact checkout. Default implementation: Codex GPT-6.1 Sol Medium; Astra hard planning remains Codex GPT-6 Astra High. Root owns integration, heavy validation and delivery.

The repaired non-recursive type-declaration loop is deliberately isolated from this root's paused physical exception slice. It changes only `src/emit/wat.ts` non-recursive declaration retention/comment and adds `tests/issue-3518-wat-type-index-preservation.test.ts`. Preserve every other source and the original physical 21-row suite. The fresh complete 14-open-PR census found PR 5753's WAT traversal patch entirely at line 362 onward, disjoint from this loop; its head and base were checked again after reading all files. No competing declaration-loop writer is dispatched.

### Implementation Plan — Astra High, retained verbatim

### 2026-10-01 — measured physical failures and narrow WAT declaration repair

Root's preserved `.tmp/exception-reference/validation-v2/runtime.log` and `results.json` report **18 passed / 20 tests, 2 failed**. This architect read the actual log and inspected source only; no validation was rerun. The direct emitted-binary native/foreign/host replay, tagged catch-reference, success and trap controls pass in that run. Actual object-link replay with only function/global/type displacement fails engine validation: `throw_ref` expects exnref but receives an i32 global at byte 176. Actual WAT assembly fails the `count` and `status` returns because they are assigned an externref result signature but produce i32. Thus neither the allegedly bounded three-space link nor WAT round-trip is passing evidence. The suite's passing incompatible-tag-prefix negative establishes an invalid linked module, but cannot yet attribute that invalidity solely to tags: independent global-index corruption can satisfy the same negative. Preserve the raw results and obtain the isolated tag mutation control after the actual link is repaired.

The WAT defect is in the existing non-recursive **type declaration selection**, outside exception type spelling and outside instruction traversal. In `src/emit/wat.ts`, `computeInlineableTypes` selects types used by one defined function; the non-recursive loop in `emitWat` then omits those declarations (`if (inlineableTypes.has(i)) continue`, inspected at line 146). Other functions/imports/tags/instructions retain original numeric type references. Names on the declarations do not assign their numeric index.

The current mixed replay fixture reserves types in this order: native tag 0, zero tag 1, mixed tag 2, init signature 3, shared `() -> i32` count/status signature 4, publication `() -> externref` signature 5. Init and publication signatures are single-use. Skipping original type 3 moves the explicit count/status declaration to WAT index 3, but both functions still print `(type 4)`. The inline init signature supplies an implicit type with an externref result at the resulting index 4; the assembler's exact count/status return failures match this displacement. The underlying physical signatures and the direct binary are not repaired by changing count/status to return references, and the exnref spelling is not the cause.

**Narrow repair recommendation, pending root's explicit sub-scope extension:** keep every original `mod.types` declaration in order in the non-recursive `emitWat` declaration loop. Remove the declaration skip and document that inline function signatures do not permit deleting numeric type slots. Retain `computeInlineableTypes` and `formatFunction`'s existing inline parameter/result formatting so the human-readable function lines remain useful. Retain the explicit-rec physical-table branch as-is. No index-remapping table is needed when all declaration slots remain; do not compensate by changing fixture order, adding fake type uses, forcing a rec group, replacing only selected numeric references with names, or special-casing exnref/EH modules.

This requires **no new production path** beyond the already held `src/emit/wat.ts`, but it does require expanding its currently authorized sub-scope from `formatValType`/null printing to the non-recursive declaration loop inside `emitWat` (inspected lines 144–148) and its explanatory comment. Root must record that precise extension against the fresh foreign-PR evidence before dispatch. The later `formatInstrIndented`/`instructionFrames` traversal remains outside scope and must preserve PR 5753's work exactly. No codegen, linker or generic exception helper is part of this WAT repair. The existing `tests/issue-3518-exception-reference-replay.test.ts` can own the additional focused assertions under its current path claim.

Required verification after the repair is implemented:

1. Assemble the unchanged real `emitWat(fixture("mixed").module)` output and execute the existing repeated-replay assertions, including `count() === 1`, `status() === -1`, absent publication and every original mixed payload/identity. Assert all six fixture type declarations survive in their original order and count/status still reference the real shared signature. Do not replace the assembler with string-only checks.
2. Add a small non-EH physical control to the same suite: an earlier single-use signature followed by a different shared signature used by two exported functions, with distinct executable results. Assemble real WAT and execute both shared functions. This isolates the generic numeric-type displacement from exception syntax and supplies a meaningful ordinary-code control.
3. Keep `tests/issue-319.test.ts` for “[ts2wasm] Codegen: Inline single-use function type signatures in WAT output” unchanged, including its inline function-line checks. Static inspection shows its title mentioning absent standalone types is not an assertion that declarations are absent; do not weaken or rewrite it. Retain `tests/issue-3518-explicit-rec-emission.test.ts` and the already required WAT/physical controls. Root runs appropriate serial checks and reports the resulting denominators; this plan itself establishes no new pass.

**Correction to the earlier API spelling in this addendum:** `TagLinkage` in the inspected physical reservation API uses `{ kind: "defined", name }`, not `{ kind: "define", name }`. Use the actual typed `reserveTag` API and existing `prefix(true)` builder; do not cast the earlier misspelling into acceptance. This correction changes no tag ownership, linking requirement or acceptance boundary. Linker ownership remains pending independently of the WAT declaration repair.


### Isolated delivery acceptance

Use an ordinary non-EH module built through real physical reservations with an earlier single-use signature and two shared-signature exports. Assemble actual emitted WAT with installed wat2wasm and execute distinct results, comparing to actual direct emitted binary. Demonstrate the exact test fails with baseline emitWat and passes with the declaration repair. Preserve unchanged issue-319 inline formatting and explicit-rec tests. No exception flag or linker change is required by this narrow ordinary test. Root verifies focused configured typing, appropriate required gates, normal signed hooks and protected PR admission.

Existing broader evidence remains **55/56** (physical 20/21, unchanged issue-319 6/6, explicit-rec 29/29); the actual displaced object-link failure is still open and its original test is unchanged. This separate dependency never earns physical linked replay, full native/public Number, backend equality, frontend retirement or main-delivery credit before its own verified merge.

Fresh main integrated before validation: `5dfc21de143e8db1da8b273871cf119510101f05` (PR 6379 npm-compat refresh), a descendant of the claim base. Actual six-file diff changes benchmark artifacts only; no source/test/issue path changed. Implementation pins: WAT `af9b4919d339b350def32993527d6b66dacca981b1b79cfe2cec835e383b8649`; new ordinary test `c43073896f40feae63f05b750d17971bf0a5978d5108e2541dd162a78bed7858`. Unchanged issue-319 and explicit-rec tests are preserved. Sol 6.1 Medium source handback, root configured heavy validation pending.

### Current execution evidence before normal commit

Root configured focused TypeScript7 test/dependency check: exit0, zero diagnostics. Actual baseline source at exact `5dfc21de143e8db1da8b273871cf119510101f05` against the unchanged new ordinary test: **0/1 passed**, exit1, actual wat2wasm reported both i32 exports expected f64 at implicit return after omitted type slot. The independent direct binary executed correctly before assembly failure. Baseline bytes/log/results are retained, and the reviewed candidate source was restored byte-exact in a finally block. Candidate serial suites: **36/36, zero skipped** = new ordinary1 + unchanged inline-signature6 + unchanged explicit-rec29. Actual direct-binary and assembled-WAT values both `[12.75,17,41]`, zero imports. WABT wat2wasm1.0.41; no experimental exception flags.

Normal hooks, push gates and protected CI/queue delivery are still pending; this is current local evidence, not main delivery or full exception/native/IR completion. Implementation by Codex GPT-6.1 Sol Medium; issue integration/validation/delivery by Codex GPT-6 Default.


### Refresh after Phase B protected main delivery

Phase B PR6380 landed at `05bf09b947b6d3089a66f45b445b930865daa2b2`, exact parentBhead `dcdf71deb3288c1b838c2a70b301e9a0a0c17875`, 87/87 PR-path content matches and102/102 actualconformance shards. This WAT PR6382 leftqueue because of the shared issue appendix conflict, with headchecks24SUCCESS/18SKIP and nofailedheadcheck in the diagnostic read. Root merged that freshly verifiedmain and retained the complete main issue prefix plus complete WAT appendix. WAT/test source pins remain exact; no source conflict or gate/assertion/config/timeout change.

Normal merge hooks use the configured base through the repository's merge-base selector. With the old WAT HEAD before merge completion, the merge base remains5df and all **eight** inherited-B-plus-WAT cohorts run; none was skipped. Root also reran the unchanged36-test affectedWAT set on the merged source. Current-root evidence is not relabeled as old baseline comparison. Full IR/main equality/legacy-retirement obligations remain open.


WAT refresh signed merge `e3c26ce962a` passed the full normal hook chain: **854/854 across8 cohorts** `[49,105,129,352,116,63,39,1]`, lint/format/LOC/function/oracle allpass. The earlier expectation of one selected test in pre-commit prose/message was false because merge-base is computed against oldHEAD, not MERGE_HEAD; the raw selector/log and full actualpopulation remain preserved, and this explicit documentation correction supersedes that expectation without rewriting history. Focused typing and affected36/36 currentchecks passed; all source/testpins unchanged. A following documentation-only normal signed commit corrects the issue wording; once mergedHEAD contains freshmain, its actual selector legitimately selects this PR's one WAT test. Root's first correction preparation also rejected a stale expected-count assertion before any file edit; its subsequently missing-message normalcommit exited128 without changingHEAD. Those rawreceipts are retained; the measured854 is authoritative.


### Fresh canonical main before readmission

The exact pre-admission guard detected that canonical main advanced to `c047f1ce0b7bece1ba1ce1012f5e2fb6d3120d5f`, so admission stopped before any queue mutation. Root fetched and reviewed all12 changed paths: benchmark reports and the generated LOC baseline only. The baseline now follows delivered PhaseB verifier relocation; no WAT/test/source/issue change occurred. This exact main is integrated with source/test pins unchanged. Normal signed hooks and push gates remain mandatory; original854/854 merge acceptance and36/36 affected behavior evidence remain recorded. The first merge command's post-merge shell bookkeeping used zsh's reserved `status` variable and failed after the clean pending merge; raw log/state retained, no merge was repeated.

## 2026-10-01 — implementation plan: Phase C full runtime reconstruction and prepared-program validation

**Specification owner: Codex GPT-6 Astra Max. Implementation model: Codex GPT-6.1 Sol High, in the bounded sequential slices below. Status: architecture specification only; no C source, compiler, checker, test, gate, claim, or publication action was performed to produce this section.** Root owns claims, integration, metadata, preservation integration and serial heavy validation. This appendix is an exact suffix to the isolated policy-writer issue; integrate only this suffix, preserving the independently edited issue prefix.

### Grounding and completion boundary

This re-grounds Phase C of `plan/log/3518-ir-wrap-up-2026-10-01/validation-lowering-extraction-spec.md` against the frozen source in `/private/tmp/js2-ir-validation-lowering-b-resume-20261001`, not against the old source-target draft or an inferred future main. Root reports canonical main `88cdb141`, prerequisite PR #6378 still open at `0e4638af`, and the B integration pending its own delivery. Those delivery facts require root's fresh authority check before dispatch; this plan does not claim that B or #6378 has landed.

Root's reported B evidence is production TS7, new 39 controls, original 457 boundary controls, source-preservation 116 and core 49 passing; nine canonical B owners have 54 resolved outgoing edges and no outgoing forbidden, unknown or unresolved edges. The original 219 controls remain 212/219, and the raw support-ref cohort remains 15/20 both before and after B. Preserve their exact failures, original fixtures and denominators. A C-only relocation cannot turn them into migration acceptance or classify an unmeasured failure as pre-existing.

C moves the real runtime producer, its independent projection validator and the complete prepared-program validator into already active data/runtime/program layers. It creates no runtime feature/provider, native body, physical binding or completion grant. The full Object/Function catalog, genuine Get/Call/Construct, bound/dynamic Function, eval/with, original public Number nine-row cohort, source modes, decoded replay, both-backend observable equality and final legacy retirement remain the full objective. C does not narrow those obligations. D's generic/actual lowering extraction and E's source-private-owner/linear-branch separation remain separate prerequisites to publishing the blocked source/native identity checkpoint. C may supply its full validator dependency; it does not make that checkpoint publishable by itself.

The ten donor pins below were read twice without drift. They are the starting live-source authority for this plan, not new historical expected hashes. Preserve every earlier receipt and derive the eventual relocation receipt from the real final sources. Re-ground if root's chosen integration base changes any pin.

| Current donor under `src/ir/` | Bytes | SHA-256 | Git blob calculated from these bytes |
| --- | ---: | --- | --- |
| `program.ts` | 21542 | `3df8deb9d3647466c2381957aa22410c593057cbdd855007b1279ebd755a5510` | `59092bfff8a18c74e30fe9ac35d00336f10fcc19` |
| `program-abi-contracts.ts` | 11056 | `855ce794bc57f152a564c388b0d0c5de3ae056d4382c097fc3182c0a68343fda` | `61792aab44a2e238342140c18206839b0f0503af` |
| `prepared-component-dependencies.ts` | 74563 | `0ea7a1b7d7ce5bf0a035d8b3a4c9c5a65aabd841ddd3c7a7c10bf82b11c9b8a7` | `c75052c6c51a824bc1ad0af99155271fb4d30480` |
| `generator-support.ts` | 8816 | `fbc2d0cb9837ca7a55ac1dc6cef62b0f51a91ccf41a5c4a09c1854599f07a01f` | `b054a6a5a28326a0dc77edb6cf16bfa834d2507a` |
| `intrinsic-support.ts` | 49626 | `03e5d583b91a7589481c80e1ca1dd5a621fee3e593f5ca9537f9c573b8925e40` | `843e50acc3ac00b01e996a8c0bb24ade33c1fb51` |
| `program-runtime-demands.ts` | 13421 | `e3b2d8e2adc4dbee309050dd9085ef710949422e1b94789cdc3138b1737caf32` | `7ab4f93af694716ae532c1fb598f35fa42e067f5` |
| `program-runtime-abi.ts` | 4475 | `0f8eb92a65a87a4fe0275aa4e90f88a600f3f598f9278fd01edd198fff4c41a4` | `d10bd411a6030ba898b8febe5bf3d0ff1d99e35f` |
| `runtime-program-manifest.ts` | 12069 | `d9698e66ad1d048e51dd58f6a5b47b2adf65a61da1787c5d543b1ac6437036a9` | `bd80eecc4f6937a72757ea0124bea7af92e3cf27` |
| `program-runtime-validation.ts` | 8186 | `bb4006f9bcdf641f665b6b1ee10ea6fd8ced30e168d09faf8439358d574f2b0c` | `0e514564a61e077baaba01048ad5ca6a5688ebd9` |
| `program-validation.ts` | 19427 | `816c404e96f8e9a5782d5c51714f0aec0592967bb13f1e09ca50f3f29c2c3299` | `46d2679da3f750ac01b54b40cc33ba9ae2eb29ba` |

### Exact ten production moves

Own only these ten new source leaves and the ten named donors for forwarding/import cleanup. This is three partial extractions and seven complete module moves. Existing canonical dependencies remain their original authorities. Preserve declaration bodies, ordering, overload occurrences, documentation, private constants/classes, initializers, default parameters and exported type visibility. Rebase only explicit module links and necessary type imports; do not opportunistically refactor algorithms.

1. **NEW `src/ir/program/owner.ts`** — move `preparedIrProgramOwner` from `program.ts:81–103`. Depend on `program/prepared-contracts.ts` and `shared/contracts/ir-identity.ts`; keep the existing `PreparedIrProgramOwner` contract. Preserve original/derived lookup, `terminalOwnerId ?? ...` precedence, terminal/source lookup, missing-owner `undefined`, source-key spelling, and both nested and outer freezes. A derived unit still reports its real terminal source location. `program.ts` re-exports this exact function object; the rich mixed program producer and public `preparedIrProgramAbiLookup` remain where they are. No registry/cache and no fabricated first-source diagnostic owner.
2. **NEW `src/ir/program/draft-abi-lookup.ts`** — move `preparedIrDraftAbiLookup` from `program-abi-contracts.ts:37–44`, including its doc comment. Depend only on `PreparedIrAbiEntry` from prepared contracts and the existing `PreparedComponentAbiLookup` interface. The closures must read the same caller-owned entry vector on every call, retain order and return the actual plan objects. Do not snapshot/freeze the vector, invent a second `ProgramAbiMap`, or call the public validated lookup recursively. The original ABI builder remains intact and re-exports the same draft function.
3. **NEW `src/ir/program/runtime-support-dependencies.ts`** — move the complete `assertPreparedIrRuntimeSupportDependencies` from `prepared-component-dependencies.ts:50–137`, including its nested `invalid`/`visit` closures and active-cycle set. Use the real formatter declarations, prepared contracts, errors, core types/references, type binding key and callable binding key. Preserve traversal of the actual scratch/kernels/implementation, unique entry-source anchor, exact canonical support references, exactly one matching ABI binding, contract/slot checks, dense-array and cycle refusal, forbidden dependency kinds, and own physical `typeIdx`/literal `storage`/`materializer` rejection. The unrelated component/source evidence and roughly 1,700 other donor lines stay mixed and untouched. Re-export only this relocated proof; it proves semantic support dependencies, not physical readiness.
4. **NEW `src/ir/runtime/generator-support.ts`** — move the entire 222-line donor's implementation and private helpers. Re-export all six public functions from the old path. Preserve `mapArray` identity-on-no-change, `valueTypesOf`, `irGeneratorPushProviderSymbol`, numeric `setReturn` demand enumeration, `requireSameProvider`, the exact generator push/epilogue/yield-star/return attachment and collected provider order. Keep the existing optional numeric-box provider requirement, conflict errors and idempotency. Import instruction walkers/types from core, callable helpers from core, and **`PreparedIrFunction as IrFunction` from `runtime/contracts/prepared.ts`**. The old `nodes.ts` API names the prepared type; replacing it with core-only `IrFunction` would silently narrow the return/parameter API. Preserve the generator donor's actual block traversal; widening it to a new async-state algorithm is outside a relocation.
5. **NEW `src/ir/runtime/intrinsic-preparation.ts`** — move the entire 1,053-line `intrinsic-support.ts` implementation, its private helpers/constants, two interfaces, error class, both overload signatures and implementation. Its current imports already name clean canonical leaves; adjust relative paths only. Old `intrinsic-support.ts` explicitly forwards every current public API and type, including `PreparedIrRuntimeManifest` and the existing `verifyIrIntrinsicInstruction` re-export. Do not export previously private helper types/functions. Keep all provider selectors, `stringConstFeatureFor`, `IrRuntimeFunctionPreparationError`, `prepareIrRuntimeManifest`, and the single existing async attachment issuer. The full contract below is mandatory; a wrapper around selected provider rows is not this move.
6. **NEW `src/ir/program/runtime-demands.ts`** — move the entire 335-line `program-runtime-demands.ts` implementation. Repoint walkers to core nodes; retain prepared-function API types; use `core/runtime-symbols.ts`, `core/async-callables.ts`, `core/string-runtime.ts`, the new runtime generator owner and `shared/contracts/string-surrogate.ts`. Preserve every separate exported scan and the aggregate's exact ten fields, order, nested values and defaults. All existing scans that cover semantic block and async-plan buffers must still do both; preserve deep traversal, regex literal pattern/flags, lone-surrogate detection, trusted flatten exclusions, callback authority distinction and sorted unique concat-many arities. `functionPrototypeCallDemand` remains the existing symbolic demand; it is not full catalog readiness or a substitute for new source mode facts.
7. **NEW `src/ir/program/runtime-abi.ts`** — move the whole 96-line donor, including its private `RuntimeCallableInput`, `assertPreparedIrRuntimeCallableDeclaration`, `prepareIrProgramRuntimeCallables` and existing identity re-exports. The two identity functions continue to come from `program/runtime-abi-identity.ts`; do not copy them. Use the genuine canonical declaration registry, native async/vector collectors, population, owner, errors and data comparator. Preserve full block/async-state and call/closure reference enumeration; canonical binding-key de-duplication and `localeCompare` ordering; the exact failure location and error class; unknown-runtime refusal and the existing separate treatment of unknown intrinsic references. Do not add providers or infer a runtime declaration from a use site's guessed signature.
8. **NEW `src/ir/program/runtime-manifest.ts`** — move the entire 261-line `runtime-program-manifest.ts`, including `locatedFailure`, `invariant`, `checkFunctionPopulation`, private `demandFeatures`/`mergeDemands`, all public input/result types and `prepareWholeProgramRuntimeManifest`. Use canonical prepared contracts, owner/data/errors/population, runtime producers and shared preparation errors. Keep its genuine whole-population and demand-map proof, owner selection, deterministic merging, exact host/native runtime attachments, provider map wrapping and diagnostic classifications. Neither optional callbacks nor a supplied pre-completed manifest may replace this producer.
9. **NEW `src/ir/program/runtime-validation.ts`** — move the entire 172-line `program-runtime-validation.ts`: semantic/provider separation, private independent `assertClockProjection`, and complete `assertPreparedIrRuntimeProjection`. Depend on the actual async-currentness issuer, new draft lookup/demand/manifest owners and canonical program data/errors/contracts. Preserve the positional witness **before** full producer rederivation, exact policy/projection comparison, full function/state populations and final `current.manifest === projection.prepared.manifest`. Never replace the witness with only self-reproduction, a cached object/hash, or a caller's completion marker.
10. **NEW `src/ir/program/validation.ts`** — move the entire 385-line `program-validation.ts`, including `invalid`, `sameSignature`, `validateEntry`, `validateRuntimeCallables` and the full `assertPreparedIrProgram`. The old path explicitly re-exports the same function. Use the existing canonical `ProgramAbiMap` constructor in `program/abi.ts`, real B allocation/class/full verifier owners, real support proof, canonical ABI signatures/callable results/population/data/errors, and the new runtime ABI/projection owners. Preserve original options and error order. Do not introduce a shorter source-only validator or weaken checks because the first source identity fixture does not reach them.

### Hidden dependency cuts and API identity

The ten new files must pass the actual unchanged boundary policy over their full transitive closure, including type-only imports. Existing mixed facades are not acceptable dependencies of a new active-root file even when they merely re-export a clean symbol. The following are exact substitutions, not permission to copy bodies or split further unrelated modules:

| Old facade dependency encountered in C | Actual canonical dependency |
| --- | --- |
| `program.ts` for comparison/maps/errors/types/owner | `program/data.ts`, `program/errors.ts`, `program/prepared-contracts.ts`, new `program/owner.ts`, selecting the actual imported symbol |
| `program-abi.ts` | `program/abi.ts`; keep its exact class object and infer/use the actual prepared inventory type, without creating a replacement class |
| `program-abi-contracts.ts` for keys/signatures/draft lookup | existing `program/abi-signatures.ts` and new `program/draft-abi-lookup.ts` |
| `program-callable-contract.ts`, `program-population.ts` | existing `program/callable-results.ts`, `program/population.ts` |
| `nodes.ts` | `core/nodes.ts` for walkers/instructions, `core/types.ts`/`core/value-references.ts` for their declarations, `runtime/contracts/prepared.ts` for old prepared-function aliases |
| `callable-bindings.ts`, `abi-bindings.ts`, `declared-types.ts` | `core/callable-bindings.ts`, `core/global-binding-keys.ts`, `core/type-binding-keys.ts`, `core/declared-types.ts` by exact symbol |
| `outcomes.ts` | `shared/contracts/ir-preparation-errors.ts` for the same error constructors/classifier; preparation-failure contracts remain shared |
| `async-plan.ts`, `async-semantic-runtime.ts` | `runtime/async-attachment.ts` for currentness, `analysis/async-plan.ts` for analysis, `core/async-callables.ts` for the exact callable constant |
| `runtime-callable-declarations.ts` | `runtime/callable-declarations.ts`, preserving the original registry and declaration objects |
| `runtime-symbols.ts`, `string-runtime.ts`, `../string-surrogate.ts` | Phase A's `core/runtime-symbols.ts`, `core/string-runtime.ts`, `shared/contracts/string-surrogate.ts` |
| `verify.ts`, `program-allocations.ts`, `program-class-layouts.ts` | Phase B's complete `runtime/verify.ts`, `program/allocations.ts`, `program/class-layouts.ts` |
| `prepared-component-dependencies.ts` | only new `program/runtime-support-dependencies.ts` for its moved proof; do not import the entire mixed component validator |

No new C file needs TypeScript AST/Program, frontend capture/authority, source-class prepared instruction support, legacy codegen, concrete Wasm emitters, `lower-generic.ts`, `codegen-linear/index.ts` or a physical resource owner. A/B already supply the necessary error, binding, type, surrogate, analysis and verifier cuts in this frozen tree. Do not move them again. Keep the single `RuntimeManifestBuilder`, `ProgramAbiMap`, `PreparedIrProgramInvariantError`, `IrInvariantError`, `RuntimeManifestInvariantError` and async-attachment `preparedManifestByPlan` authority. Moving `IrRuntimeFunctionPreparationError` must leave old/new imports strictly identical, with unchanged `name`, `unitId`, `cause`, message and `instanceof` behavior.

Old-path consumers remain supported without broad caller churn. Actual readers include `program-prepare-ir.ts`, `program-codec.ts`, `program.ts`, `program-abi-contracts.ts`, `runtime-program-producers.ts`, `program-middleend-ir.ts`, `program-source.ts`, `program-consumer.ts`, `program-physical-plan.ts`, `program-native-async-resources.ts`, `program-native-invocation.ts`, `integration.ts`, `backend/linear-integration.ts`, `math-runtime-providers.ts` and `codegen/stdlib-selfhost.ts`. Enumerate their current imported values/types before editing facades and prove compatibility. New canonical C-to-C edges must directly name the new real owners; retained mixed consumers may continue through exact re-exports. Repointing the blocked physical source-target owner is a later root-owned integration action after full closure validation, not an extra C writer edit.

### Full runtime producer invariants

`runtime/intrinsic-preparation.ts` must keep the following actual behavior, including rejection paths and object identity, with no new semantic defaults:

- Preserve `prepareIrRuntimeManifest`'s two overload signatures and `includeEmpty?: true`: absent work returns `undefined` only under the existing non-`includeEmpty` condition; `includeEmpty: true` returns a real canonical empty manifest. Preserve own optional fields and the distinction between omitted `builtinDemands`/`vectorDemands` and supplied empty arrays. Empty arrays are truthy and deliberately select actual explicit-occurrence validation/projection behavior.
- Validate every supplied native async/vector demand against genuine semantic instructions. Preserve function/source-location population checks, `funcKind`/async-plan ownership checks, intrinsic argument/result type uses, effect evidence, and all request orders into the genuine builder. Preserve the ten scalar/compound demand inputs and their exact feature mappings. No request is fabricated from a test fixture or reduced to selected methods.
- Keep every provider selector's existing absent-feature result, malformed-kind error and exact host/native result shape: number boxing; string compare/equality/length/concat/char-code-at/many-arity/constants; callback wrapping; Function.prototype call. Preserve host module **and** field where the actual API provides them, `carrier-field` and native-global roles without premature physical indices, actual capability kind guards, callable-family range checks, char-code-at's provider-ID distinction, and native callback-dispatch service identity. Do not turn a malformed selected provider into `undefined`.
- Keep `sameProvider`'s backend-op/sequence/composite distinctions and exact callable binding/name comparison. Existing matching instruction attachments preserve identity; stale/foreign provider attachments throw. Keep deep mapping and unchanged-array fast paths exactly; do not silently clone all semantic functions or mutate their buffers.
- The one actual async issuer remains `createPreparedIrAsyncRuntime`. Preserve canonical manifest provider objects and order, exact intents, native-managed versus host-capability/host-managed agreement, real host capability domains, native empty adapters versus genuine host adapter records, state mapping and backend requirements. Reject contradictory pre-attached runtime data. Do not copy the issuer WeakMap, accept a same-shaped caller attachment, or reconstruct its authority from serialized fields.
- Preserve the native standalone clock projection's exact call identity, zero arguments, non-null f64 result, absent allocation field, canonical positive zero and own-site presence. It is selected only through the existing explicit demand/policy/provider path. The independent program-level positional check remains required as well.
- When a source-location map is supplied, retain the actual `IrRuntimeFunctionPreparationError(unitId, cause)` wrapping. Without it, preserve the original thrown object. The whole-program producer must retain the existing unsupported-versus-invariant classification, stage and precise requesting owner. A global policy/catalog failure with no requesting source still throws the actual invariant; never attach the first file's owner.

`program/runtime-manifest.ts` must still check original/derived population before preparation, reject runtime attachments in semantic functions, validate each genuine native/vector demand, reject missing/extra per-unit demand entries, require real async plans and required number-bridge intent, derive locations from real terminal owners, and merge demand booleans/pairs/arities in the same order. Invoke the actual producer with `includeEmpty: true`, the full frozen occurrence lists and source locations. Preserve canonical readonly wrapping of its provider map and frame-capability failure behavior.

`program/runtime-abi.ts` must keep the canonical runtime declaration proof and entry-source identity helpers. Runtime rows remain ordered after ordinary/support ABI entries using the current stable callable binding IDs; intrinsic clock may be the existing no-physical-slot case. Do not change that into a fabricated physical function or allocate anything during semantic validation.

### Full prepared-program validator invariants

Retain the actual sequence in `assertPreparedIrProgram`, including first failure and error payload. The acceptance checklist is executable behavior:

1. Check schema, reconciliation and sealed ABI, then real original/derived function population. Reject own `runtimeSupport: undefined`; run genuine runtime-support validation, semantic/provider separation, B allocation reconstruction and B nominal class-layout verification.
2. Validate every original terminal receipt's denominator, ID, source, kind and declaration positions. Reject duplicate ABI IDs. Preserve all contract kinds, complete parameter/result signatures, structural keys, aliases and source/capability/support provenance.
3. For formatter support, preserve the source-owned canonical scratch type, five kernels and implementation sequence, exact required index-space roles, entry-source anchor, declaration order and position relative to the runtime tail. Reject omitted, extra, reordered or substituted rows; do not infer dependencies from occurrence summaries instead of the actual support bodies.
4. Re-derive the complete runtime callable declaration population from semantic functions; validate exact canonical entries/order/signatures and the real no-slot policy. Run the complete relocated runtime-support dependency traversal.
5. Construct the original canonical `ProgramAbiMap` over the same inventory/derived units, validate and plan each actual entry, then seal it. Do not delegate to a permissive lookup or accept a caller's pre-sealed class as evidence.
6. Collect full signatures/globals and reject contradictory aliases. Validate every semantic body plus the actual formatter implementation, its callable ABI and existing Promise contract. Traverse both block and async-state nested instructions for call/closure/global binding references. Run the full B `verifyIrFunction` with declared signatures/globals and the caller's original `options`; retain all errors and their order.
7. Preserve the optional verification-options contract: omitted options retain B's actual default `JS2WASM_IR_VERIFY_DOMINANCE_NAIVE` behavior; passing options retains its original interpretation. No unconditional `{ verifyDominanceNaive: false }`, reduced verifier, environmental default change or validation callback permit.
8. Check startup source population/order, exact executable versus empty module-init evidence, module/global/TDZ storage bindings, and the original empty/non-executable cases. Require nonempty runtime projections, unique backend/target pairs, formatter policy restrictions, exact selected manifest policy and full projection population.
9. For every projection, run the independent clock witness before reproduction: exact function, unit, block, state and nested-buffer populations/order; canonical selected clock provider; unchanged non-clock instructions; positive zero with correct result/type/own site and no concealed allocation. Then re-run the full whole-program producer from the genuine semantic program and fresh demand scans, using the actual draft ABI lookup. Compare all prepared data and recheck genuine async attachment currentness against that exact manifest.

There are no new Wasm instructions in this extraction. Existing symbolic reference, source, allocation, async, formatter, error and runtime projection semantics must be unchanged; existing physical consumers must receive the same declarations and lowering inputs.

### Sequential implementation slices and ownership

Root checks the fresh canonical claims and exact source pins before assigning each slice. Use one Sol 6.1 High source implementer at a time for this chain, with explicit handoffs; do not dispatch overlapping preservation edits in parallel.

- **C1: leaf prerequisites, four pairs.** Own new owner, draft lookup, runtime-support dependency and generator modules plus their four donors. Preserve all other donor declarations and old public namespaces. Add focused owner/derived-location, live-vector lookup, canonical support refusal and generator idempotency/provider tests. All dependencies can already point to real A/B/current leaves; no temporary import to a future C file is required.
- **C2: real runtime construction, four pairs.** After C1, own new intrinsic preparation, runtime demands, runtime ABI and runtime manifest plus their four donors. Move the full provider/attachment/manifest algorithms and all private declarations. Add identity, absent-versus-empty inputs, complete demand scans, provider/error/currentness and ABI ordering controls. Do not change provider inventories, capabilities, policies or source admission as part of the relocation.
- **C3: independent/full validation, two pairs.** After C2, own new runtime validation and program validation plus their two donors. Preserve positional clock verification and deterministic reproduction as separate checks, then all final program verification. Add genuine prepared/decoded and independently corrupted program controls; import the same canonical constructors and owners.
- **Preservation/inventory integration is an explicit root-assigned responsibility.** Suggested new test-only trio: `tests/helpers/ir-runtime-program-relocation.ts`, its fixed `.json` receipt, and `tests/issue-3518-runtime-program-relocation.test.ts`. A separate behavioral suite such as `tests/issue-3518-runtime-program-validation-relocation.test.ts` may cover new-path imports and negative semantics. These proposed names require root ownership confirmation. Existing reader adaptations below are assigned separately from production source. Do not broaden an implementer's ownership to every old suite by implication.

A partially completed slice is an internal checkpoint, not a publication shortcut. Root determines how to stage preservation companions so old tests remain meaningful. Do not run old full-byte readers over new facades and then erase their failing rows; do not deliver the whole source/native checkpoint just because C1 or C2 tests pass.

### Live source preservation and exact reader placement

Use one bounded, authenticated outer C relocation over the **ten original donors and twenty final current source files** (ten retained facades/partial donors plus ten real new owners), with exact original/current byte lengths, SHA-256 and Git blobs; complete top-level declaration/import/export censuses; declaration kind/name/ordinal and overload occurrence; doc/full-text spans; exact import-type versus runtime-link roles; full retained donor residues; and reciprocal reconstruction. Pin every additional existing dependency actually consulted by the proof in an explicit closed list. Never discover the expected set from the source/policy under test.

All executable/type declaration text in the inverse must come from the actual current canonical owner or retained donor. Fixed recipe literals may encode reviewed module links, forwarding scaffold, comments and whitespace; they may not store executable historical snapshots. Reconstruct each original whole source byte-for-byte, then replay all twenty current files byte-for-byte. Authenticate receipt bytes and its internal relationship/census structure before use. Mutation coverage must reject changed/missing/duplicated/reordered old or new declarations, overloads, docs, class members, private helpers, residue bodies, exports/import kinds, scope/offset drift, foreign dependency bytes, added unknown fields/files and nonreciprocal recipes. Include body-equivalent but identity-duplicating facade/issuer/constructor negatives. Do not add cross-operation source-result caches; a fresh top-level proof may capture its complete fixed population once before applying mutations.

Composition order is **live final C source → authenticated C inverse → existing B/A or pre-A/runtime/ownership stages in their existing order → unchanged historical syntax/receipt assertions**. C does not change A/B canonical owners, but the outer reader must supply reconstructed C donors to any nested stage that pins them. Each stage must see its exact admitted input; do not apply C twice, retry on failure, substitute saved text or select a historical branch by hash. Mutated historical inputs are injected only after the initial genuine capture and must bypass all normalization. Raw current imports, compiler/type fixtures, object identity tests and runtime execution always use actual current sources.

Specific current readers and required actions:

- `tests/issue-3518-program-data-contract-seam.test.ts:14–16` currently reads raw → A → program-pre-A → ownership. Insert C at the first live boundary, before A/pre-A. This restores the actual moved owner in `program.ts` and support proof in `prepared-component-dependencies.ts` while retaining all old declaration hashes and compile fixtures.
- `tests/issue-3518-program-ownership-runtime-seam.test.ts:434` defaults to `historicalSource(path, read(path))`; its original evolution controls at 480+ also read pinned current operands. Give those historical initial operands the checked pre-C view, then retain the exact old evolution/mutant controls. Preserve explicit raw-current import/type/runtime checks and add raw C-owner equivalence checks. Do not globally redefine its `read` to a historical view.
- `tests/helpers/ir-program-pre-a-evolution.ts/.json` and `ir-program-initial-graph-evolution.ts/.json` authenticate the complete support-dependency donor among their fixed source sets. Supply a pre-C reader to their outer callers; do not refresh their pins or replace actual current compiler/type input. Original fixed historical graphs, their original edge/floor/count assertions and raw-current policy guards stay independent.
- `tests/helpers/ir-runtime-contract-evolution.ts` has a fixed 27-source population including `intrinsic-support.ts`, `program-runtime-abi.ts`, `runtime-program-manifest.ts` and `program-runtime-validation.ts`. Its current fixed pins and old runtime receipts remain unchanged. Feed one complete authenticated pre-C reader to its `reconstructRuntimeContractReceiptSources`/initial read API, before its Boolean/clock/vector/callable inverses.
- `tests/issue-3518-historical-runtime-reconstruction.test.ts` has both `read` and `currentHistoricalRead()` initial capture arms. Route both through that same C-before-runtime composition. Its later injected import/body/order/type-only mutants remain raw operands. Preserve its existing fresh top-level capture and yielding behavior; do not multiply whole captures per source row or hide them behind stale caching.
- `tests/issue-3518-runtime-data-contract-seam.test.ts` separates `read` from `historicalRead`. Change only the historical initial reader's upstream input for old retained declarations. Keep actual raw current declarations, prepared contracts, async WeakMap ownership, assignability/compiler fixtures and runtime identity controls current.
- `tests/issue-3518-provider-verification-ownership.test.ts:368–415` combines a destination map, current declaration checks and old declaration reconstruction. The historical receipt path for `intrinsic-support` needs the initial pre-C source view; retain the exact original names/counts/function/class hashes. Add distinct raw current canonical-owner/facade checks instead of pretending the new empty facade has the old implementation. Override/mutant strings must continue to bypass initial reconstruction.
- `tests/issue-3526-string-boundary-schema.test.ts:787` is a **raw current implementation guard** for capability-kind checks. Its `irSource("intrinsic-support.ts")` must explicitly name `runtime/intrinsic-preparation.ts` after the move, retaining the same guard assertions; never normalize current code back to a historical source to satisfy it.
- `tests/issue-3521-program-runtime-demands.test.ts:38–39` actually imports the two old APIs in a fresh process with a working frontend barrier; it is not a source-text receipt. Keep this compatibility control intact and add a separate actual-new-path import/control under the same barrier. Old aliases alone do not prove the canonical transitive type closure.
- `tests/helpers/semantic-provider-source-receipts.mjs` currently lists `demands`/`support`/`program` in `ARM_PATHS` and dynamically imports their real APIs. Exact forwarding preserves those existing arms; do not rewrite the baseline arm or substitute a historical implementation. If root adds direct canonical candidate owner coverage, make it an explicit additional path/receipt and preserve original imported identities. `scripts/lib/frame-delay-three-arm-contract.mjs` is an artifact/child/source-pin auditor, not a direct reader of these C bodies; there is no demonstrated need to edit it merely because the older spec mentioned it. Retain its manifests and evidence checks.

This reader list is the inspected starting census, not permission to skip a newly discovered actual raw source reader. Root/implementer must perform a final exact donor-path/symbol search before changing shared contracts and add a bounded handling rule for any additional real reader. Do not use wildcard source search/fallback inside a test helper.

### Semantic and architecture acceptance

Root runs full typechecking and the applicable unchanged suites after exact source/preservation snapshots, with existing timeouts and test denominators. No validation is claimed by this specification. Required new positive and adversarial controls include:

- Every old/new exported runtime function and error/class object is strictly identical. Type fixtures retain complete prepared-function and prepared-module APIs, overload narrowing for `includeEmpty: true`, optional inputs and private-type nonexports. Private issuers remain unique; real prepared async attachments created through one path are accepted through the other and stale/wrong-manifest attachments are rejected through both.
- Genuine original and derived owners return the same frozen location/source evidence. Unknown owners preserve `undefined`. A real draft ABI vector amended before sealing is still observed by all three lookup methods, in order, with the same plan identities; no recursive final-validator call occurs.
- Genuine generator/async/string/callback/ordinary runtime demand fixtures exercise all ten aggregate fields, nested block/state instructions and actual existing provider families. Test omitted and explicit-empty occurrence lists independently, present-undefined option behavior where currently distinguished, empty `includeEmpty` preparation, matching attachment idempotency, mismatched kind/binding/capability/provider refusal and exact thrown object/cause provenance.
- Use actually prepared programs and actual codec decode/reconstruction, not forged frozen program-shaped fixtures. Independently corrupt receipts, original/derived population, allocation metadata, class layouts, aliases/signatures/globals, support source/ABI/body dependencies, formatter order, runtime callable rows, startup evidence, policy/projection counts and async attachment joins. Preserve exact class/code/stage/location and first-failure ordering. A shared producer defect must still be caught by the independent positional clock witness: wrong position/count, wrong result/site/alloc, negative zero, foreign clock provider and residual clock calls are necessary paired controls.
- Keep omitted/default verifier options and explicit dominance options separate, including a fresh-process default-environment control. Use the complete real verifier, not a test implementation. Existing ordinary, generator, async, support, clock/vector and both-backend supported policies retain their actual results/refusals and emitted bodies/bytes where extraction is behavior-neutral.
- Preserve unchanged `issue-3521-whole-program-validation`, `issue-3521-whole-program-population`, `issue-3521-whole-program-projections`, `issue-3521-prepared-ir-program`, `issue-3521-program-runtime-demands`, `issue-3521-runtime-callable-abi`, `issue-3518-runtime-producers`, runtime-support transport/codec/source-free and the source/provider historical suites. Keep current source closure/call/apply/getter/throw/replay cohorts as consumers of the same validated program contracts. Record exact per-row before/after failures instead of claiming blanket pre-existing status.

For the actual frozen B inventory, C adds exactly **two `ir-runtime` leaves and eight `ir-program` leaves**: 1,765 → 1,775 entries, runtime 18 → 20, program 40 → 48, if root's chosen base is unchanged. Append the two runtime paths in order `generator-support`, `intrinsic-preparation`; append the eight program paths in this section's numbered order. Preserve every original row/order, whole 94-record B history, all roots/floors/classifications and allowed edges. Root records only actual new activation evidence after the exact closure is valid; use new bounded history suffixes and authenticated historical policy projection without refreshing earlier 91/88/56/40/44/174 proofs. Old mixed facades retain conservative inventory classifications until their own closure is actually proved; no whole-root activation or allowed-edge exception is needed.

The required C graph proof must enumerate actual canonical imports/exports/import-type edges with zero outgoing forbidden, unknown or unresolved edges, including transitive dependencies. Fresh-process runtime barriers supplement that proof but cannot see erased type imports. Keep the existing global strict migration FAIL visible until the rest is migrated. Inventory validity is not full architecture completion.

No new source exceeds the existing 1,500-line LOC threshold on these measured donors; the largest moved file is 1,053 lines. `prepared-component-dependencies.ts` must shrink rather than regrow. The moved `prepareIrRuntimeManifest` implementation is 261 lines and the final validator is 200 lines on this source, below the current 300-line function threshold. Root must measure final formatted bodies, but no blanket C budget grant, threshold change, baseline JSON refresh or unrelated algorithm split is justified now. Preserve B's already reviewed 381-line verifier allowance transfer as B's evidence; it is not a reusable C allowance.

### Corrections to the older Phase C text and remaining work

A/B's dependency cuts are now real in the frozen B tree; they are prerequisites to reuse, not more C implementation work. The partial donor ranges are owner 81–103, draft lookup 37–44 and support dependencies 50–137. Generator/demand `IrFunction` must preserve the old prepared contract even where a particular body does not inspect `asyncRuntime`. The intrinsic producer already has canonical imports, so this move does not require a new provider registry or broader runtime extraction. The existing draft lookup intentionally reads a live pre-seal vector. The runtime-demand child test is an API/import test, and the frame-delay auditor is not an implementation-text reader. These are concrete corrections to the older plan; none relaxes source or semantic preservation.

The meaningful C deliverable is the actual complete clean program validator plus genuine runtime reconstruction, unchanged old APIs and fully measured preservation/semantic evidence. It does not provide affirmative source strict/global/lexical-this or Construct facts, a header-to-source target association, generic/actual lowering cleanliness, full native realm population or a public provider completion permit. D/E and those semantic joins remain required under their own fresh claims. Keep both backends and legacy behavior available until the full user objective is tested and equal.





## 2026-10-01 — Phase C dispatch addendum: retained author scopes and disjoint C1 preservation

**Architect: Codex GPT-6 Astra Max. This addendum changes the next dispatch sequence only. It does not supersede the full ten-move Phase C plan or release another author's claim.** Root owns author coordination, canonical claims, integration, metadata and serial validation. The architect inspected saved records and local source text only; no Git, network, compiler, checker, TypeScript Program, test or gate was run.

### Current evidence and exact ownership boundary

Root reports prerequisite PR6378 published at signed head `a5cf2e922e33beea974e42d032152596f05af271`, base `88cdb141`, with normal hooks 1929/1929 and numeric18 passing; required CI is running. This is not protected-main delivery. C1's production and test/dependency typechecks exited zero and its runtime controls passed 43/43, without skipped rows or worker errors. Its nine frozen source/test pins remain unchanged. Full C preservation, policy activation and C2/C3 remain unfinished.

The saved complete claim ledger is `.tmp/c2-dispatch-preflight/canonical-claims.json` in `/private/tmp/js2-ir-runtime-validation-c1-20261001` (SHA256 `77c509ad3ad6f02c65643569254b678ef69f88fe2d98603caefa3862e3fd266b`). It records 2,558 total records and 784 active claims. Root's separate 13-open-PR scan found no overlap in the nine proposed C2 paths; that scan does not cancel held claims and does not cover new preservation paths automatically.

Two relevant scopes remain held:

- `3518:runtime-callable-abi`, owner `ttraenkler/astra-ir-program-a-20260905`, branch `codex/3518-whole-program-a-20260905`. Root recorded local head `7381096e29ceb4965f0989c212a407e9f0825506`, not a canonical-main ancestor, and no uncommitted C2 donor changes.
- `3518:semantic-runtime-producers`, owner `ttraenkler/astra-ir-producers-b-20260905`, branch `codex/3518-whole-program-b-20260905`. Root recorded local head `45a6c72add4605df078fb2a90cd1f600617f56c2`, a canonical-main ancestor, and clean donor paths.

The actual local author records refine, rather than remove, this restriction. In the A worktree `/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm/.claude/worktrees/codex-3518-whole-program-a-20260905`:

1. `plan/issues/3518-ir-only-default-and-direct-frontend-retirement.md:773–778` assigns A the runtime-ABI donor, ABI construction and final validator; `:845–850` assigns A the unchanged runtime-demand scans. The same issue at `:760–771` assigns intrinsic-support/runtime-program-manifest producer changes to B-authorized work and explicitly excludes the demand module from that worker's grant.
2. `plan/issues/3521-ir-r2-prepared-program-free-function-compile-once.md:407–461` defines the exact runtime-callable ABI scope. Its author-written results at `:485–540` report 17/17 focused and 60/60 combined controls and state, “These results establish the scoped preparation repair.” That is explicit bounded implementation-result evidence. It does not say the current author has stood down or transfer the still-held source scope. The later observation-authority plan retains the owner's other claims.
3. `.tmp/a-preparation-consumer-handoff.md` hands a signed preparation API to consumer C, including real manifest/demand entry points, complete validation and genuine async authentication. It grants consumption, not a new implementation owner for those files.

In the B worktree with the corresponding `codex-3518-whole-program-b-20260905` directory, issue3518 `:305–307` explicitly says no old claim is released and retains B's pure runtime-program-manifest leaf. Its `.tmp/package-b-commit-message.txt` describes the completed producer implementation and 118 focused controls while leaving full application integration and other semantics open. Neither this commit message nor ancestry supplies a current author stand-down. The old integration amendment also explicitly retains lane claims under parent coordination.

**Recommendation: do not dispatch C2 production now solely because the PR scan is clear.** Root may use the bounded author-result records to reconcile the exact finished implementation scopes with the responsible authors/parent ownership. No such reconciliation was established by this read-only task. A different claim name or new destination directory cannot authorize a duplicate implementation. In particular, reserve BOTH `src/ir/program-runtime-abi.ts` and proposed `src/ir/program/runtime-abi.ts`; the donor and moved implementation are one responsibility. Omitting only that pair does not automatically free the demand or B producer pairs.

### Immediate disjoint task: finish the already-planned C1 source-preservation companion

Subject to root's fresh path/claim check and explicit separation from the frozen C1 source writer, dispatch **Codex GPT-6.1 Sol Medium** for exactly these three NEW test-only paths:

- `tests/helpers/ir-runtime-program-relocation.ts`
- `tests/helpers/ir-runtime-program-relocation.json`
- `tests/issue-3518-runtime-program-relocation.test.ts`

All three were absent in the C1 tree when inspected. This task does not edit any production donor/new owner, existing suite, old receipt, issue, script, policy or budget. It consumes the frozen C1 implementation and implements the preservation responsibility already named in the full Phase C plan; it is not an alternative runtime implementation or a smaller semantic completion criterion. Root owns subsequent initial-reader wiring and metadata. No second worker edits the C1 behavioral suite.

Use `.tmp/c1-freeze.json` (SHA256 `da94daaa89bd149f0723361d0173456e967fef166ea9577fed056b9cca800615`) and `.tmp/c1-source-census.json` as reviewed implementation evidence, then independently authenticate actual live bytes. The current production input is exactly these eight files, paired in this order:

| Pre-C donor | Actual C1 canonical owner |
| --- | --- |
| `src/ir/program.ts` | `src/ir/program/owner.ts` |
| `src/ir/program-abi-contracts.ts` | `src/ir/program/draft-abi-lookup.ts` |
| `src/ir/prepared-component-dependencies.ts` | `src/ir/program/runtime-support-dependencies.ts` |
| `src/ir/generator-support.ts` | `src/ir/runtime/generator-support.ts` |

The original whole-source SHA256 values, in that order, are `3df8deb9d3647466c2381957aa22410c593057cbdd855007b1279ebd755a5510`, `855ce794bc57f152a564c388b0d0c5de3ae056d4382c097fc3182c0a68343fda`, `0ea7a1b7d7ce5bf0a035d8b3a4c9c5a65aabd841ddd3c7a7c10bf82b11c9b8a7`, and `fbc2d0cb9837ca7a55ac1dc6cef62b0f51a91ccf41a5c4a09c1854599f07a01f`. Their byte lengths are respectively 21,542; 11,056; 74,563; and 8,816. The archived `.tmp/c1-original-*` files establish reviewed before-state evidence only; helper execution must never read them or use stored executable historical text.

Implement one explicit C1 receipt profile, not an auto-detected set of historical alternatives. Authenticate its complete JSON schema, fixed path/census/order, full current and original byte lengths/SHA256/Git-blob identities, declaration/doc/full-span records, import kinds, exact forwarding scaffolds and retained residues. Any additional live dependency used by the proof must be enumerated and pinned explicitly. Do not copy a dependency population from the caller or discover expected files dynamically.

The existing static census reports 12 moved declarations and 79 retained declarations: one owner function with 36 retained donor declarations; one draft lookup with two retained; one runtime-support proof with 41 retained; and all nine generator declarations with zero retained implementation declarations. Reconfirm the full text and docs from live inputs, including private generator helpers, the six original generator exports and `PreparedIrFunction as IrFunction`. Reconstruct all four original files using the actual moved declarations plus genuine donor residues and only approved textual module/import/scaffold inverses. Replay that result back to all eight current files byte-for-byte. No algorithm copy, reconstructed runtime object or second issuer is created.

Expose a typed, source-only helper returning the exact four reconstructed donor strings, for example `reconstructRuntimeProgramRelocationSources(readLive): ReadonlyMap<C1DonorPath, string>`. The operation freshly captures/authenticates the complete fixed live population once and fails closed before exposing any output. A reader callback supplies file text only; it is not a validation permit. Unknown output paths, malformed receipt data, missing/extra population and nonreciprocal transformations must fail. Do not introduce a process-global success/source cache, a missing-file fallback, hash-selected historical branch, or catch-and-retry normalization.

New controls must demonstrate the full positive reciprocal proof and reject each side's deleted, duplicated, renamed, reordered or edited declarations/docs; changed retained bodies; wrong export names/aliases/import paths/type-only roles; extra declaration/file/receipt field; altered length/hash/blob/ordinal; changed dependency bytes; absent destination; and nonreciprocal replay. Include separate paired mutations to a real moved body and its old facade/residue. Later injected historical mutants are already the control operands: they must bypass all reconstruction. Raw compiler/type fixtures, real imports and runtime identity remain actual current source and use no historical reader.

Root then wires the authenticated view once at each existing initial live historical reader, before the existing A/pre-A/ownership/runtime stages in their already approved order. First affected readers include program-data/ownership seam initial reads and the existing program-pre-A/initial-graph support-dependency inputs. Exact final caller census and any existing-file edits remain root-assigned. Preserve all older receipt hashes, malformed operands and fixed graph counts. The new trio alone does not claim those old suites passed or make C1 publishable.

### Resume C2/C3 sequentially after ownership is resolved

Keep the full C2 four-pair scope intact. If root receives an explicit bounded B authorization before A's, the intrinsic-preparation and runtime-manifest pairs can be scheduled together: their actual imports do not require program-runtime-abi. If A authorizes only the demand relocation, that pair is independently implementable after C1's generator owner. These are conditional dependency facts, not present grants. The complete dependency order remains:

1. C1 prerequisites and their authentic preservation, with old public API object/function identity preserved.
2. Full `intrinsic-support.ts` → `runtime/intrinsic-preparation.ts`; full `program-runtime-demands.ts` → `program/runtime-demands.ts`; full `program-runtime-abi.ts` → `program/runtime-abi.ts`; full `runtime-program-manifest.ts` → `program/runtime-manifest.ts`, in the authorized owner sequence. Both overloads, defaults/empty-input distinctions, complete providers, async attachment issuer, runtime error classes, demand ordering and ABI authority remain unchanged.
3. Full `program-runtime-validation.ts` → `program/runtime-validation.ts`, then full `program-validation.ts` → `program/validation.ts`. The latter still requires the genuine reserved ABI pair. Do not route around it with a callback, permissive lookup, partial validator or facade import misclassified as clean. The held A scope explicitly includes final validation and needs its own reconciliation.

Use Sol 6.1 Medium for a fixed, fully specified unchanged-body relocation or bounded reader adapter. Escalate a specific unresolved semantic or extraction defect to Astra specification / Sol High only with concrete justification. This replaces the earlier blanket High recommendation for routine moves; it does not reduce controls.

The C1 receipt is a measured four-donor/eight-current checkpoint. The eventual mandatory **ten-donor/twenty-current reciprocal proof** remains the Phase C acceptance target; extend the fixed receipt by reviewed explicit deltas when actual C2/C3 bytes exist, retaining the prior receipt/evidence. Never treat six untouched donor files or a four-pair success as proof that all ten moved. Root still owns the full inventory change of two runtime and eight program leaves, exact roots/floors/activation records and unchanged edge policy. This test-only dispatch activates no production leaf and grants no budget.

Full type/semantic/historical/boundary validation remains serial root work against exact frozen snapshots. Preserve original failures and denominators separately from new passing controls. C1's 43 runtime controls, this source proof and any later clean module checkpoint do not establish source/native public readiness, complete catalog algorithms, both-backend parity, Phase D/E extraction or legacy-retirement permission.




## 2026-10-01 — Phase C correction: measured inventory populations and exact C1 historical readers

**Architect: Codex GPT-6 Astra Max.** This appendix corrects population forecasts and narrows the C1 initial-reader integration. Earlier appendices, original receipts, test denominators and failed-run evidence remain immutable. No source, test, helper, policy, Git, network, compiler, checker, Program or test-run action was performed for this specification. Root owns integration and serial validation. The active Sol 6.1 Medium writer owns only the new `ir-runtime-program-relocation.ts`/`.json` helper and its new suite; this appendix grants no additional files to that writer.

### Population correction: classified modules are not required-entry lists

The authoritative measured B report is `/private/tmp/js2-ir-validation-lowering-b-resume-20261001/.tmp/validation-lowering-b-resume/delivery/staged-inventory.json`, SHA256 `8a21ccdd4a75e60c00b41893cabd62a22e0ed0168e93cc0f0825975da847a374`. It reports `inventory-valid-architecture-incomplete`, zero inventory errors and 1,765 modules. Its actual classified populations are:

| Layer | Measured modules | Existing explicit entries | Existing floor |
| --- | ---: | ---: | ---: |
| ir-program | 41 | 40 | 40 |
| native-runtime | 103 | 98 | 97 |
| ir-runtime | 18 | 18 | 18 |
| ir-analysis | 11 | 11 | 11 |
| ir-core | 29 | 29 | 29 |

The one additional classified program module is `src/ir/program/native-promise-inventory.ts`. The five additional classified native modules are `src/runtime/wasmgc/values/string-create-body.ts`, `string-exotic-bodies.ts`, `string-exotic-define-body.ts`, `string-index-key-body.ts` and `string-own-keys-body.ts`. All six already have real clean file classifications. Their existence explains the difference from the explicitly required entry arrays; it is not permission to erase rows, invent entries or rewrite historic floors. Earlier forecasts that called 40/98 the complete B classified populations are superseded by this measured 41/103 result. The earlier explicit 40/98 entry arrays and native97 floor remain reviewed policy facts.

The actual C1 report at `/private/tmp/js2-ir-runtime-validation-c1-20261001/.tmp/c1-validation-20261001/inventory.json`, SHA256 `3c081081b76cf81d44dd8921c0055227e3d93c84a058046a7c9937ac818d236f`, reports **1,769 modules, four unclassified C1 owners and 12 errors**. Each new owner has an unclassified-module, unclean-active-layer and unclassified-target consequence. Classified program/runtime populations are still 41/18 in that report; the four new files have not yet been classified. This is an invalid-inventory result. C1's genuine 43/43 runtime controls and two successful typechecks do not turn it into a completed closure or a valid policy report.

Root must register only the actual four C1 leaves: three under `ir-program` (`owner.ts`, `draft-abi-lookup.ts`, `runtime-support-dependencies.ts`) and one under `ir-runtime` (`generator-support.ts`). Verify their real runtime AND type-only edges against unchanged policy, then measure the final classified report. On an otherwise unchanged B population, the arithmetic prediction is 1,769 total, program44 and runtime19, with native103/analysis11/core29 unchanged; it is not measured acceptance. The complete ten-leaf C plan would predict program49/runtime20 and 1,775 total on that same population, not program48. Separately, the corresponding required-entry lists would gain three/one at C1 and eight/two over full C. Record exact ordered additions and floors from the actual reviewed metadata change; do not confuse these entry deltas with total layer population.

Preserve B's complete 1,765 file rows, 94-record activation prefix, all earlier policy history and allowed edges. Retain the original historical40/44 graph populations, original109/119 edge assertions, original56-entry historic view, original174 fixture and all negative controls. The full-current policy guard must authenticate the actual complete candidate before projecting a historical view. Do not truncate an unknown list, increase a timeout, suppress a diagnostic, add a blanket layer exception or adjust a counter to fit a forecast. Global architecture completeness remains false unless actually established by the unchanged gate.

### Exact initial-reader integration scope

The C1 inverse has exactly four historical outputs: `src/ir/program.ts`, `program-abi-contracts.ts`, `prepared-component-dependencies.ts` and `generator-support.ts`, authenticated from their eight actual donor/owner files. At each top-level historical proof, capture the complete C1 population once, then use its checked four outputs only for the named donor paths; all other inputs remain genuine current reads. Missing known output must throw. Injected historical/mutant text is supplied AFTER this initial capture and must never enter the C1 normalizer. No whole-suite/global success cache or repeated normalization inside a verifier/fixture `run` is permitted.

**First root or separately claimed Sol 6.1 Medium adapter tranche: four existing suites below.** Their receipt/helper implementations and JSON pins remain unchanged. A bounded local initial-reader adapter may use the new helper's finalized authenticated map API; it must not copy its inverse algorithm. Root checks each existing file's ownership before dispatch.

1. **`tests/issue-3518-program-data-contract-seam.test.ts:14–16`.** Supply the authenticated pre-C read to `readBeforeIrSourceContractRelocation`, retaining the current sequence **C1 → Phase A → program-pre-A → ownership**. The C1 support-dependency output is required by the pre-A full-source pin; the C1 program output is required by the retained declaration/ownership receipt. `parse`/`verifyRetained` default historical operands then retain their old hashes/counts and full original declaration order. Their explicit `text` and `overrides` operands at `:366–371` remain untouched. The changed-owner mutation at `:740+` must still mutate the reconstructed genuine owner body and fail the original detector. The separate compiler child at `:439–503`, its actual repository roots and raw imports remain current and never use this source view.

2. **`tests/issue-3518-program-ownership-runtime-seam.test.ts:434`.** Use pre-C source only in the default historical `parse` operand before `historicalSource`. At `:480–514`, replace only the initial genuine operands of the original reciprocal/mutation controls with that same pre-C view, including the intermediate-hash control's program input. The ownership helper's current program SHA is exactly `3df8deb9d3647466c2381957aa22410c593057cbdd855007b1279ebd755a5510`, which is the C1 inverse's original program SHA. Preserve every later changed-source operand and intermediate hash check. Do not globally redefine `read`: raw import inspection at `:605+`, actual old/new function and error-class identity, and runtime collection controls remain raw.

3. **`tests/issue-3518-program-pre-a-evolution.test.ts`.** Its helper captures four records plus nine dependencies, including the complete support-dependency donor. Pass a fresh pre-C reader explicitly to each genuine default reconstruction/reciprocal operation (`:233+`, `:255+`, `:284+`, `:353+`, `:372+`). Existing byte-offset mutation builders targeting that donor must take their initial text from the authenticated pre-C output so the unchanged receipt coordinates name the actual former declaration. Other source paths remain raw. `changed` overlays must forward the supplied mutated string directly to the old helper, never rerun C1 on it. Preserve the original13-input read-order/warm-read controls at the pre-A boundary; observe C1's additional eight-source capture separately, rather than changing the old denominator. Preserve all receipt-data corruption tests.

   One existing RAW-current assertion requires an explicit location update: the control at `:380+` expects `assertPreparedIrRuntimeSupportDependencies` in the old donor. Its body now lives in actual `src/ir/program/runtime-support-dependencies.ts`. Assert the original full function authority there and the exact named forwarding export in the actual old donor; keep the real `case "support-ref":` assertion on the old donor where it remains. Do not satisfy a raw-current assertion using historical reconstructed text. The raw optional `runtimeSupport` contracts, raw-before/after source preservation and historical absence assertions stay intact.

4. **`tests/issue-3518-program-initial-graph-evolution.test.ts` from the reviewed B integration.** Its `positive()` (`:86`) and default `reconstructProgramInitialGraph`, `verifyProgramInitialGraphReciprocal`, `reconstructProgramPreA` and `createProgramInitialGraphReader` calls require the pre-C INITIAL reader. Keep `readProgramInitialGraphActual` raw. Preserve all17 old inputs/four outputs, their full pins, missing-input/type/error controls, exact positive-before-mutation ordering, and read/recapture behavior. The `changed` reader continues to overlay supplied mutants after initial reconstruction. The current receipt's only C1 input intersection is the support-dependency donor; no new original-output path is invented.

**Root-only companion: `tests/issue-3518-program-data-contract-boundary.test.ts`.** Use the latest B fixture, not the stale C1 checkout copy. The current C1 copy lacks B's initial-graph/core-type helpers and earlier authenticated reader fixes. The reviewed B file SHA is `41e154f5216525ea4a7b98a5e2004e771de9016c352bff9b03de535c257ce962`. At B `fixture()` around `:166–184`, create the checked C1 view immediately before `reconstructProgramInitialGraph` and supply it as that call's input. The initial-graph receipt remains SHA `0cd9d3d2580f0473c7fa940578f9e706d1a86b15688547896e919cd180c1b904`, with exactly17 inputs and four outputs. Preserve the independently captured runtime and core-type branches, `initialIntrinsic`, all output selection, initial `put`, and the `includeOwnership` path. Later `put`, `append`, `run` and copied mutant source never call any inverse. Root also evolves the full-current policy guard from its actual metadata delta; these two responsibilities must not be handed implicitly to the helper writer.

### Readers that need no C1 adaptation now

The fixed Phase A receipt's 25 inputs, runtime-contract helper's 27 current inputs, core-vocabulary reconstruction population and B core-type helper's seven inputs have **no C1 donor intersection**. The program-pre-A receipt includes a program original as provenance, but its live affected record is the support-dependency donor; provenance is not an extra live read. Consequently:

- Do not edit `ir-source-contract-relocation.ts/.json`, `ir-runtime-contract-evolution.ts/.json`, `ir-core-vocabulary-evolution.ts/.json`, or `ir-program-core-type-evolution.ts/.json` for this checkpoint.
- Do not add a blanket C1 capture to historical-runtime reconstruction's `read`/`currentHistoricalRead()`, runtime-data's historical reader, provider-verification's raw `parse`/`verifyLedger`, core-vocabulary's receipt reader or the corresponding unaffected helper suites. C2/C3 will change the runtime helper's actual donor population; the prior full-C plan remains applicable then. Revisit those initial readers only when those real moves occur.
- The source `type-key`/factory preservation chain concerns ABI/type-reference/type-key owners outside the C1 output set. `tests/issue-3518-symbolic-support-ref.test.ts` remains PR5753 author-owned and excluded. Neither this appendix nor a generic C1 reader grants edits to it. Preserve its prior PhaseA → type-key → factory plan and unresolved ownership separately.
- Real import/barrier tests, startup/current policy readers and `semantic-provider-source-receipts.mjs` still consume actual APIs/source. The C1 facades preserve those APIs; there is no demonstrated historical-reader repair for those paths.

This narrows the full-C forecast to the actual C1 intersection, without deleting future C2/C3 obligations. No C2 or C3 source dispatch is authorized until root reconciles the retained A/B author scopes, including the reserved runtime-ABI pair and final validator.

### Freeze and acceptance of the adapter tranche

Root integrates the exact helper freeze only after independent review. Freeze and compare each reader's before/after text, original receipt bytes and raw fixtures; only the described initial operands and the one raw support-proof location assertion may change. Validate the helper's genuine positive before relying on a negative. Preserve separate denominators for the new C1 proof, the unchanged43 runtime controls, each original historical suite and the full boundary gates. Record initial refusals and old failures rather than classifying unexecuted negatives as passed. Root executes typechecking, focused historical positives/all mutants, original graph gates and final inventory serially with unchanged limits.

The source-only proof does not establish runtime parity, backend acceptance or completion. The mandatory final ten-donor/twenty-current C inverse, complete C2/C3 runtime reconstruction and validation, D/E, all public catalog/source semantics and both-backend equality remain open; legacy retirement remains conditional on the full user goal.


### 2026-10-01 — Phase C1 initial-reader integration claimed and isolated

Root creates isolated integration worktree `/private/tmp/js2-ir-runtime-program-c1-integration-20261001`, branch `codex/3518-runtime-program-c1-integration-20261001`, exact signed Bbase23ddb71a0ecfa3ef2bede4546e551321e66f34f6. B and C1 authoring worktrees remain intact. Nine C1 production/runtime-test pins and three Medium-preservation files are copied byte-for-byte, all38dependency pins match the genuine Bsnapshot. Latest B boundary fixtureSHA41e154f5216525ea4a7b98a5e2004e771de9016c352bff9b03de535c257ce962 and its initial-graph helper/receipt are retained; no stale boundary replacement. Actual prior C1evidence43runtime and298preservation plus final focusedTS7 is consumed with stated scope, not reclassified as full closure.

Canonical claim `3518:runtime-program-c1-reader-integration-20261001`, owner `ttraenkler/codex-runtime-program-c1-reader-integration-20261001`, write_id `53742-1jeff89k` is verified by direct effect after atomic claim. Fresh complete claim list verifies785held scopes before this new claim; all old A/B, program-data/ownership and5753claims remain unchanged. New task is only C1 initial-reader adaptation to already specified preserved algorithms, not takeover of original donor/receipt implementation. Fresh13open-PR heads match their authenticated complete saved file censuses. Only our own immutable prerequisite6378 overlaps three existing reader suites; no external PR overlap in the five planned test paths. Do not modify6378branch or publish this consumer before dependencies land on protected main.

Native Sol6.1Medium owns only four existing suites specified in authenticated Astra13338byte addendum: program-data-contract-seam, program-ownership-runtime-seam, program-pre-A-evolution, program-initial-graph-evolution. Root owns latest B program-data-contract-boundary fixture, metadata, issue/evidence and sole heavyvalidation lane. New helper/receipt, old inverse helpers/receipt JSONs and all12copied C1paths stay frozen consumption-only. Preserve every original hash/byte/census/edge assertion, receipt mutant, raw injected source and real compiler/import/runtime path. New view is initial authenticated C1beforePhaseA/preA/ownership; no global successcache/fallback or repeated normalizing of later mutants. No C2/C3source, PR5753supporttest or legacy retirement. Worker does static text/syntax/format work only, no compiler/checker/Program/Vitest/gates/Git/network/commits. Root will review exact freeze and run required typed/runtime/history/inventory controls serially.


### 2026-10-01 — actual C1 metadata classification, inventory remains architecture-incomplete

Root registers only four actual frozen C1canonical leaves, preserving all1765Bfile rows, complete94history prefix, other policy fields and allowed edges. Required program entries/floor40→43 andruntime18→19; two exact activation records appendprogram3thenruntime1. Actual unchanged inventory detector exits0:1769modules,44classifiedprogram and19runtime,0inventoryerrors. Fournewowners have16resolved outgoing runtime/type edges, no direct unknown/unresolved/forbidden/transitive diagnostic from those owners. ArchitectureComplete remainsfalse; this does not establish full global closure. Fullrawreport and alltype/runtime rows are `.tmp/c1-integration/classified-inventory.json`; scopedcheckpoint is classified-inventory-checkpoint.json. Initialunchanged-policy12error diagnostic retained beforeclassification; root authoring script had a staticparse typo before anywrite, separatelyrecorded. Newfullcurrent C1metadata authentication+reciprocalpreBview is being specified byAstra; oldBreceipt/helper/tests remainunchanged until exactinitial-view integration, so historicalguard acceptance isstillpending. No source/edge-policy/oldfixture weakening.




## 2026-10-01 — implementation plan: exact C1 policy inverse before the unchanged B guards

**Architecture: Codex GPT-6 Astra Max. Next implementation: Codex GPT-6.1 Sol Medium after root's independent claim/path check.** This is a three-file test-instrument task, separate from the active four-suite source-reader adapter and from production C2/C3. Own only NEW `tests/helpers/ir-runtime-program-policy-evolution.ts`, NEW corresponding `.json` fixed receipt, and NEW `tests/issue-3518-runtime-program-policy-evolution.test.ts`. Root owns all existing test adaptations and `scripts/compiler-boundaries.json`. Do not edit `ir-validation-policy-evolution.ts/.json`, refresh its original pins or absorb the source inverse into this metadata helper.

### Measured candidate and fixed authority

The integration is `/private/tmp/js2-ir-runtime-program-c1-integration-20261001` on root's branch from B `23ddb71a`. Root copied the frozen nine C1 source/test files and three source-preservation files and checked 38 B dependency pins. Root reports source preservation298/298, final TS7 and C1 runtime43/43 passing. None is execution evidence for the new metadata inverse, which does not yet exist.

The architect read the actual current policy and independently constructed the proposed C1 data in memory from the exact B policy plus the fixed delta below. Ordered JSON equality holds. Root's actual detector report `.tmp/c1-integration/classified-inventory.json` (SHA256 `09a0c69f4f39fb7d6779c3bb8eccd0a1ac4be50746714f8379eefae208f6deac`) reports zero inventory errors, `inventory-valid-architecture-incomplete`, 1,769 modules, program44, runtime19 and native103; architecture remains false. Root additionally reports 16 outgoing edges from the four new owners without unknown, unresolved, forbidden or owner-transitive diagnostics. This specification ran no detector, compiler, Program or tests.

The old B helper remains exactly SHA256 `a962c04960b945705e9ac5a354da3e96c8e0cf5543382847231dd3df9204fb40`, and its receipt remains `39dacc9d17fb52b6a369ed81d7498afc30b00bc06d89362bba039305aa96fa0e`. The original B policy suite before root's future reader-only adaptation is 11,268 bytes, SHA256 `1b5ba110797b8241bb6b5857678e3fb860052842725fbf7d58ac8c426eb5ab40`; retain its actual65 rows, all literals, original mutations and evidence.

Root's fixed authoring artifacts are `.tmp/c1-integration/compiler-boundaries.before.json.raw` and `metadata-delta.json` (delta SHA256 `dfcbaaff9a8f1f60c3f62fe55da8c27f786c473814b99848b804fe1a805d57e7`). They document provenance; helper execution must derive B from actual C1, never read that saved B file as the answer.

| Pin | Exact B | Actual C1 |
| --- | --- | --- |
| Raw file bytes | 564180 | 565188 |
| Raw SHA256 | `88d8916fea2c0d8a9685b652d1b4a3ec6c4593b98de2d2180761d7bd4cba7330` | `460eb6835dff1d22322ac9fb0fdd9526f04cd09d99d4dec8138f8e66b91ffd57` |
| Raw Git blob | `4184f8ec3d808930a1dba57f6511d32b6d796a8b` | `5395e0265ca6fef778141101ea688e456417c558` |
| Ordered JSON data SHA256 | `e8d0034c26f59e042da49dfcc4af562436b562421b9e231ae78d664ab70c73e3` | `f24c0f10d4e8e9b5dc23471ec327f2fab7312890a5d4db035066e8c189ed2a11` |
| Files SHA256 | `7d74424329d2bd52e02a282b257b4d950e81346cb0d1ced455e9beb246b6c2ae` | `c1e4f0b02ab0d5a42e0dbef3f725d64c427fc2c866e4989b5d0da8313cd92616` |
| History SHA256 | `b299da75bbd99efdcf3ba51ae52ead964ebfb4b2b36f3b78d739f02ec4efe4b0` | `1c64b137373008c3bce05ac01a50808d2d3c2198b20b779d4f24f3bfcbdfed70` |
| Layers SHA256 | `248d066f41ea35249cb74655101b154f2f9e4fe235b6fe9ae63e9a49d56c529d` | `c1be051d77d0857faeec740a200f3291fca0be93f2eb1bab8f93d9f2e12e9e36` |

Data hashes above use `SHA256(JSON.stringify(capturedJsonData))`, preserving own-key and array order. Raw-byte pins are authoring/actual-file positive evidence; do not confuse formatting bytes with the object API's data contract. Allowed edges remain SHA256 `efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7`. The old complete91-history prefix remains `906d96d460433bb445216a2ed6fe10ffd7bf7dbbebbe1a9f557b0f878ad4403f`, and original nine activations remain `820a39c3d3b05a1a20d030ae10b1e19621802cfed5cf9a29ccb5dccb80b3d6ee`; the new layer does not replace those old authorities.

### Sole admitted metadata delta, with exact positions and order

Retain all 16 top-level fields in their current order: `schema`, `description`, `sourceRoot`, `tsconfig`, `requireGitProvenance`, `externalAssets`, `frontendWrapper`, `moduleExtensions`, `layers`, `allowedEdges`, `externalPackages`, `activationHistory`, `nonModules`, `moves`, `evidence`, `files`. The twenty layer rows keep their original order and all unrelated fields. No old file row is reclassified in C1.

1. Append exactly four `files` rows at indexes1765–1768, each with key order `path`, `state`, `layer`:

   ```json
   [
     {"path":"src/ir/program/owner.ts","state":"clean","layer":"ir-program"},
     {"path":"src/ir/program/draft-abi-lookup.ts","state":"clean","layer":"ir-program"},
     {"path":"src/ir/program/runtime-support-dependencies.ts","state":"clean","layer":"ir-program"},
     {"path":"src/ir/runtime/generator-support.ts","state":"clean","layer":"ir-runtime"}
   ]
   ```

2. Layer index9 remains `ir-program`. Keep its first40 entries exact; append owner, draft-abi-lookup, runtime-support-dependencies in that order at indexes40–42. Change only `minModules:40` to43. Layer index8 remains `ir-runtime`; keep its first18 entries exact, append generator-support at index18, change only18 to19. Both rows retain key order `id`, `status`, `roots`, `required`, `entries`, `minModules`, active/required status and existing roots. Do not reorder layers to match dispatch order.
3. Keep all94 original history records exact, then append index94 `{layer:"ir-program", entries:[the three program paths above], minModules:3}`, followed by index95 `{layer:"ir-runtime", entries:[the generator path], minModules:1}`. History object key order is `layer`, `entries`, `minModules`. The suffix's minima count additions; they are not43/19.

The four-row suffix hash is `6d12f8014525f7b223a04874152193faf1538f721f930c107dc4d2d8269613cf`; the two-history-record suffix hash is `47a9cb95bc57dfe89c8a3fab1e8abb555935f9e508045dbab87e062cb89ef1d9`. Required program/runtime populations are43/19; classified populations are44/19. Preserve native required98/floor97 and classified103, analysis11 and core29. Every other file, layer, field, root, entry, activation, external package, move, evidence row and edge remains exact.

### Authentication, inverse and reciprocal contract

Use a fixed receipt schema/kind for **C1-only policy evolution**. Bind its complete textual SHA in the new helper; record the existing B helper/receipt provenance and the before/current pins, exact counts, two layer deltas, four appended rows and two appended activations. Recipe schema and independently specified constants must reject extra/missing fields and inconsistent populations. Do not learn the expected paths, suffix length, layer indexes or accepted digest from the candidate policy. No alternative profile chosen by a matching old hash, failure retry, or historical fallback is permitted.

Suggested narrow APIs:

- `authenticateIrRuntimeProgramPolicyEvolution(receiptText?)`: authenticates the one fixed receipt, including exact before-B authority.
- `authenticateIrRuntimeProgramPolicy(value: unknown)`: freshly captures and authenticates the complete C1 value; returns a deeply frozen, detached current data snapshot. This is test data, not a production readiness token.
- `beforeIrRuntimeProgramPolicy(value: unknown)`: performs the same full current authentication, reverses only the admitted delta, calls the unchanged `authenticateIrValidationPolicy` on the reconstructed B policy, proves reciprocal replay, and returns a **fresh mutable detached B data copy** for original mutation tests. It must not return the frozen B guard's object or share nested arrays/objects with the caller/current capture.

Share a private implementation to avoid redundant captures inside one operation, but retain no cross-call acceptance cache or mutable authority. Do not export a function that accepts only96 history records and labels them a complete policy. Every historical input must originate from full C1 authentication.

Before `JSON.stringify`, copying via spread/Object.values, or inspecting policy fields, capture by own property descriptors. Require ordinary JSON object/Array prototypes; reject accessors without invoking them, symbols, hidden fields, functions (including `toJSON`), undefined, bigint, cycles, nonfinite numbers and negative zero. Arrays must have their genuine own length plus every dense canonical index and no extra fields; reject holes and inherited elements. Reject null/foreign prototypes for records. Preserve exact string keys/order and primitive values. Only serialize the resulting owned data copy, never the supplied object. Getter/toJSON controls must prove call counters stay zero. Do not allow a caller-supplied serialization or validator callback to attest the policy.

Authenticate the entire current data digest and separately check the fixed1769 files,96 histories, exact suffixes, complete original1765-row/94-record prefix pins, layer indexes/fields and unchanged allowed edges. Remove only those authenticated suffixes, restore the two known layer floors and entry prefixes while retaining field positions, and verify the complete B digest. Run the real unchanged B guard, including its own complete layers/files, five analysis reclassifications, conservative facades,91→94 history and reciprocal pre-B proof. Then replay the exact C1 delta onto the verified B copy and compare the complete ordered data with the captured C1 policy and current pins. Do not reconstruct B by returning `receipt.before.layers` plus a saved policy object; derive the unchanged data from the actual captured C1 value.

### New controls and retention of original B controls

The new suite begins from the actual current policy file, checks its raw/data pins and genuine positive authentication, proves full C1→B→C1 identity as ordered JSON data, and proves the reconstructed B passes the unchanged guard and its original56/nine historical view. Check caller nonmutation, detached returned arrays and mutable B output; mutate that output, verify the original B detector rejects it, and show a fresh read remains valid.

Use explicit independently enumerated cases for deletion, duplication, replacement, reordering and unknown additions in each of the four file rows, each layer's old/new entries, both activation rows and the original prefixes. Mutate each floor, layer/state/root, old dominance classification, conservative facade, allowed edge and unrelated top-level field. Include same-count substitutions and order-only changes, so a length-only check cannot pass. Reject before-C1/B and already historical inputs, missing/extra history, changed fixed receipt/provenance/pins and malformed raw JSON. Test getters at root/nested row/array index, hidden/symbol/toJSON fields, inherited/foreign/null prototypes, sparse arrays, array extras, cycles, undefined, nonfinite numbers and `-0`; establish actual mutation before expecting refusal. Reauthenticate the SAME previously accepted object after mutating an old row, new row, layer entry and history tail; no object identity shortcut is allowed. Existing65 B cases remain65, with all hashes and mutation bodies retained; collect/report the new suite's real denominator separately.

### Exact caller integration: root owns existing files

The current import/use census finds three existing suites using the B helper. A changed initial input must never install normalization inside a detector receiving injected mutants.

1. **`tests/issue-3518-validation-policy-evolution.test.ts:25–30`, `actual()`.** Root changes only its genuine initial factory to parse the actual C1 policy, call the new complete inverse and retain the old `authenticateIrValidationPolicy` positive. Return the mutable checked B copy. Everything after `actual()` still exercises the original B detector directly, including `rejected`, getter/sparse/receipt mutations, old94/91/56/nine assertions, intermediate prefix guards and stale-object controls. Never call the C1 inverse on a mutated B operand. Retain original receipt text and all65 rows.

2. **`tests/issue-3518-semantic-provider-boundary.test.ts`.** Keep a distinct raw-current policy factory around `:393`; it authenticates complete C1 before returning mutable actual current JSON. The full-current layer/file assertions around `:989–1095` must use that C1 value and append ONLY the exact C1 program3/runtime1 entries after the existing B additions; preserve signed historical entry-prefix hashes and all other layers. Keep `assertCurrentActivations` at `:813` unchanged: it consumes authenticated B94, strips B to91, then preserves PhaseA91→88 and every older receipt. Its initial callers around `:990`, `:1141–1173`, `:1216`, `:1231`, `:1259`, `:1276` must obtain B history from the new full-policy inverse first. Subsequent array mutations go directly to `assertCurrentActivations`/`assertNewActivations`; no new wrapper normalizes them. The original174-module fixture, fixed source/edge counters, negative dependencies and current raw compiler/source inputs remain unchanged. A helper returning only history is not a replacement for full-policy authentication.

3. **`tests/issue-3518-program-data-contract-boundary.test.ts`.** Root's `policy()` at `:126` authenticates actual C1 with the new guard while retaining mutable current JSON for the existing fixture construction. The old historical-view calls around `:343` and `:430` explicitly receive `beforeIrRuntimeProgramPolicy(p)` and then call unchanged `historicalIrValidationPolicyView`. Preserve full original40/44 source populations,109/119 edges, old56 entries/nine activations and all later `put`/`append`/`run` mutants. The separate C1 SOURCE inverse before `reconstructProgramInitialGraph` remains separate; neither metadata inverse nor historical layer projection supplies source text. Once the fixed fixture policy has been constructed, its mutated policy is never rerun through the new normalizer.

Other current policy consumers use genuine membership/entry checks and are not an implied edit grant: compiler-boundaries, capability-schema, core-nodes/type, identity-foundation, startup and checked-delay tests retain actual current data and their existing detectors. Root performs a final caller search if composition adds a new exact B helper consumer. Do not generically project every policy read to B. The four active source-reader adapter files stay with their current writer; PR5753's symbolic-support-ref suite stays excluded.

### Handoff and remaining acceptance

Freeze the new three files and fixed receipt before root's serial validation, preserving the exact before hashes and metadata delta. Root reviews integration of the three existing policy callers, measures all original/new rows and actual inventory, and retains failures without modifying original limits or receipts. The architect's in-memory equality check and root's valid inventory are not executed metadata-helper tests. No extra budget or policy edge is authorized.

C1 metadata completion does not grant global closure, whole source/native readiness or protected delivery. C2/C3 production remains reserved pending A/B author-scope handoff; the full ten-donor/twenty-current C proof, runtime reconstruction/full validator, D/E, all intrinsic/source semantics, both-backend equality and legacy-retirement conditions remain required.


### 2026-10-01 — C1 policy proof claimed, next Medium implementation

Canonical `3518:runtime-program-c1-policy-inverse-20261001`, owner`ttraenkler/codex-runtime-program-c1-policy-inverse-20261001`, write_id`59798-ftpvuv9g` isverifiedafteratomicclaim. Fresh13PRhead/filecensus confirms threeNEWpolicy-proof paths absent and no overlap; oldclaims unchanged. Astra's exact15695bytesuffixSHAfe4af08ef5f28fb2922e38e706cbfd4fcc17e113b51a706d7da1492329809b0e isauthenticated/copied intoissue and .tmp/c1-integration/c1-policy-inverse-plan.md. Sol6.1Mediumowns ONLYnew helper/receipt/controls; rootowns threecaller integration files andmetadata. The complete currentC1profile mustauthenticate descriptor-safe fresh data before derivingmutable exactBprofile through unchangedBguard andreciprocal replay. ExistingB65controls/pins/history and malformedoperands stayunchanged. No alternateprofile/cache/unknown-tailtruncation/getterexecution oroldreceiptweakening. FullcurrentC1ordereddataSHAf24c0f10d4e8e9b5dc23471ec327f2fab7312890a5d4db035066e8c189ed2a11 matches independentAstra derivation andactualrootmetadata.

Actual four historical-reader suites nowpass274/274,0failed/skipped/unhandled, exit0:47data,129initialgraph,22ownership,76preA. Readerfreeze4/4,12C1pins and7oldhelper/receiptpins verified. Independent read-only Medium review hasnofindingswithinreaderplumbing; dynamic evidence is authoritative. Focusedreader+boundaryTS7reports3existingdiagnostics; exactcleanB23dd withsamecompiler/options/fiveincludes givesidentical3diagnostics afterline-number normalization: twoStatement-to-NamedDeclaration assertions inunchangedsource/runtime receipt helpers and possiblyundefinedlayer inunchangedBboundaryloop. No newtypeddiagnostics fromreaderadaptation; baseline logs preserved in B `.tmp/c1-type-baseline-20261001`. These areboundedtest-type defects, not permissiontosuppresschecks orweakenproofs; a separate minimaltype-onlyrepairwillpreserveallreceipts/runtimeoperations and rerunfocusedTS7.


### 2026-10-01 — minimal historical helper type repair, independently scoped

RootverifiedcleanBbaseline reproducesexactlythe3focusedTS7diagnostics,0newadapterdiagnostics. Canonical3518:c1-historical-helper-types-20261001 owner`ttraenkler/codex-c1-historical-helper-types-20261001` write_id`60229-g9hekvei` isverifiedafteratomicclaim; oldsourceclaimsremainunchanged. Sol6.1Mediumowns ONLYtwoexistinghelpername-access typeassertions andsingleboundarylayer non-nulltypeassertion aftertheexistingpositiveexpect. No runtimeoperation/receipt/hash/assertion literal/negativeoperand maychange. Exactbefore snapshots recorded. ExistingPRoverlapis onlyourimmutable6378prerequisite consumedinthisdependentintegration, nootherPRwritecollision; noprerequisitebranchpush. Rootownsotherboundarymetadata/sourceadapterhunks andwillwaitforfrozenone-linecorrectionbeforeeditingthose. NewC1policywriterownsonlyits3NEWpaths. AlloldJSONreceiptsand12C1source/helper/testpinsremainfrozen. Thisrepairwillbecheckedforbyte-identical emittedJavaScript andserialfocusedTS7; nofixtureweakening/checksuppression.


## 2026-10-01 — confirmed model routing and C1 measured integration checkpoint

User directs Astra to specify hard tasks and update implementation plans in `plan/issues`; Sol 6.1 at Medium is the default implementer. Higher effort requires concrete task complexity. Existing C1 source/policy specifications remain authoritative; legacy retirement still requires complete IR implementation, testing and equality.

Root measured the four adapted historical readers at 274/274, the new exact C1 metadata inverse at 204/204, both with zero failures or skipped rows. Focused TS7 passed after three erased type assertions were repaired; emitted JavaScript for the three repairs is byte-identical to the originals. Original behavior remains 212/219 with the same seven baseline failures, exact unchanged row statuses and first error messages. Inventory classifies 1,769 sources (program44/runtime19/native103), with no inventory errors and architecture incomplete. None of these measurements establishes protected main delivery.

Next bounded task follows the recorded Astra implementation plan: connect only the three existing metadata callers through full initial C1 authentication and the exact B inverse. Preserve the original B helper/receipt, all historical pins and subsequent negative mutations. Root retains the serial test lane and integration ownership. Evidence is in `.tmp/c1-integration/policy-validation/acceptance-checkpoint.json`, `reader-validation`, `type-repair-emission-equality.json`, `original-controls/comparison.json` and `classified-inventory-checkpoint.json`.


### C1 policy caller implementation ownership

Claim `3518:runtime-program-c1-policy-callers-20261001`, owner `ttraenkler/codex-runtime-program-c1-policy-callers-20261001`, canonical write `66011-slokxmfj` verified by decoded contents. Sol 6.1 Medium owns only the three existing policy test callers listed in the Astra plan, in `/private/tmp/js2-ir-c1-policy-callers-20261001` on `codex/3518-c1-policy-callers-20261001`. Root owns integration and serial execution; no production source, old receipts, other claims or PR branches are authorized for this task. Fresh canonical main and all13 open PR exact heads match the prior verified file census.


### C1 three-caller handback and delivery retry

Sol 6.1 Medium implemented only the three claimed existing policy callers in the isolated writer branch. Frozen before/after and reverse-edit checks preserve original assertions, mutation bodies, receipt hashes and limits. Independent read-only Sol review found no concrete defect in either the new helper or its caller integration; review was static, not runtime evidence. Root copied only those three files after verifying input and dependency pins. Actual original-cohort runtime is now running serially. Initial focused compiler invocation exited127 because `tsgo` is absent; retain that evidence and rerun with the repository-configured `node node_modules/typescript7/lib/tsc.js` after the runtime lane ends.

Prerequisite PR6378 “refactor(ir): isolate canonical semantic contracts” remains open, ready, mergeable and based on main at exact head a5cf2e922e33beea974e42d032152596f05af271. One-shot admission inspection found49 checks with only `issue-tests` cancelled (run36835009764, attempt1, exact same head). Root requested a targeted rerun of verified database job110280560202; command exit0. No hold/queue bypass, duplicate PR, new source push or main-delivery credit.


### Measured denominator correction

The preserved B normal-hook acceptance record reports63/63 for `issue-3518-validation-policy-evolution.test.ts`,105/105 for program-data-contract-boundary and352/352 for semantic-provider-boundary (cohort sum520). Earlier architectural prose saying65 B policy rows is a count error, not a new acceptance floor. Preserve all actual original cases unchanged and verify the actual runtime rows. Root's current C1 serial run has completed semantic-provider352/352; remaining cohorts and final JSON/exit remain pending at this checkpoint.


### C1 exact caller runtime acceptance and scoped typing follow-up

Actual three-caller runtime passed520/520: semantic-provider352/352, program-data-contract-boundary105/105, B policy63/63; exit0, zero failed/pending cases. Original detectors/mutations/counts remain unchanged. Repository-configured focused TS7 reports12 unknown-activation accesses in four provider-test mutation blocks. Clean signed B23ddb71a with identical compiler/options/three includes reproduces the same12 diagnostics plus2 prior errors already repaired here. No new typed diagnostic. Both raw runs and exact normalized comparison retained.

Within the same three-caller claim, Sol6.1Medium owns a precise type-only repair of those four local validated histories in the isolated writer tree. Preserve both original guard bodies, all runtime operations, assertions, receipt hashes and mutants; no `any`, ts-ignore or suppression. Prove emitted JavaScript byte-identical, then root reruns the focused configured compiler. Runtime acceptance does not establish typed completion or main delivery.


### C1 caller checkpoint typed completion

Sol6.1Medium repaired only a type import and four local result assertions; root independently reproduced byte-identical emitted JavaScript (65,535 bytes, SHA2564c3496a7c33e060597065becf52b4387f5f2cdb266d73f704616e0ec58e3ca37), with no Program/checker in the equality probe. Final repository-configured focused TS7 exits0. The actual520/520 runtime evidence remains applicable because emitted behavior is identical. Original13behavioral cohorts remain212/219 with the same7 baseline failures, not a claimed full green suite. Root has updated the visible current-model-routing section and epic default effort to Medium while preserving historical instructions and Astra plans. No commit/push/queue/main delivery has yet occurred for C1.


### C1 required-gate checkpoint

Root executed LOC, function, coercion, oracle and dead-export checks; all exit0. LOC/function/oracle also exit0 against freshly verified canonical main88cdb141, including the four untracked new C1 owners in45 changed source paths; net+163LOC. The dead-export command uses preservation-v1 and explicitly leaves strict modeled closure open: no global closure or retirement certification. Current-source inventory remains valid/incomplete. Exact logs and exit records are in `.tmp/c1-integration/required-gates`. C1 remains uncommitted dependency-following work; normal hooks, protected queue and actual main delivery are still required. Existing failure evidence and legacy path remain preserved.


### C1 normal-hook checkpoint scope

Before staging, root re-read canonical issue-assignments and verified all six C1 ownership records, the complete12 copied source/preservation hashes and26 exact changed paths. Prettier checks26/26 passed. The normal commit hook will compare C1 against exact immutable parentB23ddb71a using its documented `CHANGED_ROOT_TESTS_BASE`, selecting all ten changed C1 root suites rather than triggering the inherited mass-edit skip. This is a dependency checkpoint, not CI/main validation: full B normal-hook evidence2430/2430 remains preserved and fresh protected-main integration must follow actual predecessor delivery. Empty local test262 directories and all external fixtures remain untouched; these ten IR unit-test cohorts do not claim Test262 conformance. No bypass flags or hook edits are authorized.


### C1 normal-hook lint refusal and exact repair scope

First normal commit exited1 in Biome before runtime hooks: four noDelete diagnostics in the new policy/source-preservation controls. All26 staged paths and HEAD23ddb71a remain intact after lint-staged rollback. The unsafe suggested undefined assignment is rejected because it would erase the real sparse/missing-field conditions. Sol6.1Medium will replace only those four deletion expressions with checked `Reflect.deleteProperty` operations, preserving actual holes, inherited-element controls and missing own properties.

Canonical claim `3518:c1-precommit-lint-20261001`, owner`ttraenkler/codex-c1-precommit-lint-20261001`, write `84736-qdeoczkg` verified by decoded canonical contents; same isolated writer branch. Own only the two new control suites and the unpublished new C1 policy receipt/helper. The source-proof suite is itself one of18 immutable receipt inputs, so update exactly its recorded byte count/hash and the new receipt's fixed digest after the reviewed deletion-equivalent change. Original B receipts, all source/body/span/policy pins and remaining17 immutable inputs must remain byte-identical. This is provenance for a specific reviewed test repair, not relaxed acceptance. Preserve before bytes and paired evidence; root reruns both real suites and configured focused compiler before retrying all normal hooks.


### C1 lint repair actual acceptance before full-hook retry

Root reviewed and copied exactly the four claimed paths. All17 unchanged/new18 total immutable inputs verify; source-proof helper/receipt and every production source/body/span/policy pin remain unchanged. The sole source-proof-test pin exception is recorded in the post-lint checkpoint with both original and reviewed hashes, preserving the original artifact. Actual affected cohorts now pass502/502 (source298/policy204), zerofailed/pending, runtimeexit0 and focused repositoryTS7exit0. The four deletion cases still establish real absent own properties; sparse/inherited arrays retain their original length and prototype condition. No lint suppression or unsafe undefined replacement. Root will retry the complete normal-hook commit, not credit the first refused attempt as delivery.


### 2026-10-01 C1 normal-hook checkpoint and signing recovery

Root's normal commit ran all ten selected root-test cohorts:1339/1339 passed, with normal formatting, budget and oracle gates enabled. No bypass was used. Commit creation then failed solely because the noninteractive invocation could not unlock the configured private-key path; HEAD remains dependency23ddb71a and the26 reviewed paths remain staged. Preserve that full failed-signing log and original source/receipt freezes.

Fresh canonical issue-assignments reads verify all seven C1 slice owners. A positive signing probe using the matching public key and already loaded macOS SSH agent produced a verified git-namespace signature. The normal commit retry uses per-invocation signing settings and retains signed Thomas author, Codex coauthor and actual Model trailer; no shared config or gate is weakened. These are local checkpoint counts, not canonical-main delivery, full Test262 coverage or retirement certification.


## 2026-10-01 — C1 refresh after verified B main delivery

Phase B PR6380 has delivered exacthead `dcdf71deb3288c1b838c2a70b301e9a0a0c17875` as main `05bf09b947b6d3089a66f45b445b930865daa2b2`: exact freshbase5df/headparents,87/87fullPRpathcontent matches, exact merge-groupCI quality/issue/equivalence8/8, differential and102/102Test262shards plusfinalregression gate succeeded. Postmain ongoingruns are separately excluded. OnlyownBdeliveryclaim completed/effectverified; fullIRepic/oldforeignscopes remainopen.

Root refreshed the preserved signed C1 checkpoint `4346f628af67149dd04b298a131c6ac1359da474` from that freshly verified main. Sole conflict is issue appendices; both complete appendices remain. Fresh canonical read verifies seven held own C1 claims. Complete14-open-PR file census followed by exact full shared-policy patch review found no C1 semantic key collision across sixforeignPRs; existing1765row/94historyprefix, moves/allowededges/unrelatedvalues preserved. Foreign5942 sequencing-spike issue insertion remains unlanded; C1 does not remove it or claim its delivery. C1 edits neither side of the detected foreign5784/5753 function-proto-call policy conflict. No foreigntakeover/source retirement/unknownprefixallowance.

Correction of informal source-pin count: C1's nine frozen pins consist of **eight production files plus one runtime test**, not nine production files. All eight current production pins and13Bdependency pins must remain byte-exact; preservation metadata/lint test successor exceptions retain original receipts. C1 exact12moved/79retained declarations, including9generator declarations, remain its bounded scope. Earlier1339/1339 wholehook evidence is preserved; currentnormalmergehooks/currentchecks stillpending. Root soleheavy/Gitdeliverylane; defaultnewimplementerSol6.1Medium/AstraHighhardplans, historicalAstraMax/SolHighsource provenanceunchanged. CurrentWATPR6382 separateappendixrefresh; no C1source/test/helperoverlapwithopenPRs.


### C1 canonical-base guard refresh

Before signing the pending main refresh, canonical main advanced to `c047f1ce0b7bece1ba1ce1012f5e2fb6d3120d5f`. Root reviewed the exact12-path benchmark/LOC-baseline delta, verified its issue bytes equal deliveredBmain05bf09, and saved the fully resolved prior issue, index patch, source freeze and merge state under the worktree's own .tmp. Only this root's uncommitted clean-origin merge was aborted; signed4346 checkpoint and all prepared C1 work remained intact. Root then merged freshly verifiedc047, resolving the sole shared-issue conflict with the saved completeB+C1 histories. All25 nonissue C1 pins remain exact, including8 production source pins; no fixtures, receipts, tests, assertions, thresholds, timeouts or original raw failures changed. Current normal signed hooks are pending and their actual selected population will be measured, never inferred from earlier1339-row evidence.


### C1 normal validation and WAT-delivery main refresh

SignedcleanC1main integration `d517920690446d05861bbd7d9eb7a7fd900f80dc` passed the fullnormalhookchain1970/1970 across11cohorts `[631,105,47,129,22,76,43,204,298,352,63]`, with no unhandled-error section. All25nonissue C1 pins remain exact, including8production source files. Normalforkpre-push typecheck/lint/format/oracle/coercion/18numericparity/committed+working issueintegrity passed; exactd517head published. Before openingaPR, freshcanonicalmain guard detected `f1f5132f6ffccde2cbec2892270b7bd172796cab` and stopped beforePRcreation.

Fetched actualmain contains WATPR6382merge `d3e804aadc6` plusPR6381npmbenchmarkrefresh. Exact9pathdelta changesonlyWATsource/regression, benchmarkartifacts andthissharedissue; allC1source/test/helper/receipt/policy pathsunchanged. Rootintegratedthatmain, preservingits complete issue bytes plus completeC1appendix andthe existing user model-routing insertion near the top. First resolutionpreflight incorrectly assumed theC1issue waspureappend-only; its assertion stopped before any trackedfile/Gitstage/commitmutation, preserving the rawconflict. Exact removal/reinsertion of theone knownroutingparagraph establishes complete byte-preservation of both histories.

FullWAT maincontent/protectedworkflowprovenance verification is independentandstillpending; nofullIRcompletioncredit. Refreshednormalhooks useexactfreshmainthroughunchangedmerge-base selector; actualC1+newWAT selectedpopulationisrecordedwithout guessingresults. No source/fixtures/receipt/assertions/counts/timeouts/gates/protectionswereweakened.


## 2026-10-01 — current-main WKS integration and model routing

User direction: Astra specifies hard tasks and writes their implementation plans in plan/issues; Sol 6.1 Medium is the default implementer, with effort raised for concrete complexity. Historical attribution remains unchanged. The next exact WKS implementation plans follow; no GitHub issue is created.

Root integration branch codex/3518-well-known-symbol-integration-20261001 starts from verified current main c7366c3c6d3eb9e4c5cff0b29b11c42e3faab4c7. C1 PR6384, refactor(ir): isolate runtime and program ownership, delivered exact8edd38c556db902909f0321307cfa785b3ef36e9 via2ca34324ceb29d821a31e3176e61cc3b1747dbb6; independent Sol confirms all26 paths blob/mode/type match merge and current main. Merge-group102 conformance, report/final regression, quality, equivalence8+gate, differential and CLA succeeded. Attempt1 issue-tests110373668355 was CANCELLED and receives no success credit. Root requested an official exact-merge-group rerun: run36863556777 attempt2/job110387553636 is in progress at the recorded read. Required-gate acceptance and seven own C1 claim completions remain pending. Original cancellation/raw evidence is retained; post-main evidence is not substituted.

The well-known-symbol-policy-integration-20261001 claim remains with ttraenkler/codex-well-known-symbol-policy-integration-20261001 and is now effect-verified on this integration branch. Fresh full14-PR file/head census and2570 canonical claim keys show no new overlap; seven unchanged reviewed shared-metadata PR heads and all foreign/old claims remain intact. Archived WKS114/114 source evidence and its three source hashes remain unchanged; no source has yet been copied into this integration.

Root scratch authoring independently authenticates actual C1 policy565188bytes, original helper10742byte prefix and19 immutable inputs. Its exact two-leaf successor is565875bytes/SHA451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59,1771files/98histories; four localized raw spans reconstruct original bytes reciprocally. The scratch fixed receipt SHAce9351c3b4c026a746d44cc769b6ff3968c2feabe686abe07e8361d4b28f7172 binds the actual reviewed Astra addendum SHA803f3fcc5af93344f878b33dace6c9484d2d4aa1437e9537548c899f4204753c. Metadata/receipt have not been applied. Astra reviews this hard proof in the preserved isolated WKS tree; SolMedium helper/new-suite implementation dispatch waits required C1 rerun proof and root application. Root owns policy, receipt, four caller edits, serial heavy validation and protected delivery. No public/full-migration completion or retirement is implied.

## 2026-10-01 — WKS production metadata and exact C1 successor policy plan

**Architect: Codex GPT-6 Astra High. Implementation default: Codex GPT-6.1 Sol Medium.** Root owns this issue, metadata, integration, serial heavy validation, signing and protected delivery. The WKS writer owns only its three recovered production/test paths. The plan is based on read-only inspection of the WKS recovery tree at main88cdb141 and the separate exact C1 integration policy; no compiler, checker, tests, network or Git mutation was performed for this specification.

Root reports actual WKS production controls114/114 and focused TS7 exit0 after the writer's type-only repair, including descriptor-safe dependency capture and its14 new negative controls. These are reported bounded production results, not a new architect execution or evidence of public Number/catalog completion. Preserve the original archived implementation, all failure evidence and the unchanged public nine-row fixture.

### Delivery order and exact metadata delta

Publish WKS after verified C1 delivery. This avoids changing the active26-path C1 checkpoint and gives the new policy one genuine predecessor. It does not eliminate compatibility work: the C1 guard authenticates the complete policy digest, and its original suite also pins the raw565,188-byte policy. Do not publish unclassified WKS leaves or omit activation records to avoid those controls.

Root changes only the following portions of `scripts/compiler-boundaries.json`, against the inspected exact C1 policy:

| New clean file | Layer | Required entries and floor | Classified population |
| --- | --- | --- | --- |
| `src/runtime/contracts/well-known-symbols.ts` | `runtime-contracts`, layer index10 | 9 to10 | 9 to10 |
| `src/backend/wasmgc/resources/native-well-known-symbols.ts` | `backend-wasmgc`, layer index11 | 49 to50 | 54 to55 |

Append each path to its existing layer's ordered entries and increase that layer's floor by one. Append two clean `files` rows in contract/owner order, with key order `path,state,layer`. Append two activation records in the same order, each with its one entry and `minModules:1`. Preserve the complete existing1,769-file/96-history prefix, all existing layer fields and all unrelated policy data. Expected candidate arithmetic is1,771 files and98 history records; program44, IR-runtime19 and native-runtime103 populations remain unchanged. These arithmetic expectations require the actual final detector report. Backend required entries/floor50 must not be confused with classified backend population55.

The contract has no imports. The owner has seven direct target modules: two type-only imports to `wasm-physical` and `native-runtime`, and five value-bearing imports to `runtime-contracts`, `ir-program` and three `backend-wasmgc` modules. The targets are physical reservations, native declaration types, the WKS contract, program data, native strings, native Symbol carrier and native resource declarations. Every direct edge is already permitted; root verifies the actual complete transitive type/value closure. Change no allowed edge, root, external-package rule or existing file classification.

The allowed-edge data digest stays `efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7`. Global architecture remains incomplete unless the unchanged full gate actually establishes otherwise.

### One explicit WKS successor profile in the existing policy proof

Extend `tests/helpers/ir-runtime-program-policy-evolution.ts` with explicitly named WKS-successor APIs while keeping the original C1 APIs and their accepted population unchanged:

- `authenticateWellKnownSymbolPolicy(value)` authenticates only the complete reviewed WKS-current policy and returns a detached frozen current snapshot.
- `beforeWellKnownSymbolPolicy(value)` authenticates that policy, reverses exactly the two-leaf delta, invokes the unchanged genuine C1 guard, proves reciprocal replay and returns a fresh mutable C1 copy.
- `beforeWellKnownSymbolPolicySource(raw)` performs the corresponding exact raw-text inverse for the existing C1 raw-byte witness.

Add one fixed receipt, `tests/helpers/ir-runtime-program-policy-well-known-symbols.json`, and one focused suite, `tests/issue-3518-well-known-symbol-policy-evolution.test.ts`. This is a fixed successor profile inside the existing proof, not a generic delta engine, profile autodetection, permissive historical fallback or new source-reconstruction framework.

The before profile is the existing C1 ordered-data digest `f24c0f10d4e8e9b5dc23471ec327f2fab7312890a5d4db035066e8c189ed2a11`. Its raw565,188 bytes retain SHA256 `460eb6835dff1d22322ac9fb0fdd9526f04cd09d99d4dec8138f8e66b91ffd57`. Root records the after-profile hashes from the actual reviewed metadata bytes; do not invent them from a formatting prediction.

Reuse the existing descriptor-safe capture implementation. Before serialization reject accessors, hidden/symbol fields, foreign prototypes, sparse arrays/extra array properties, cycles and non-JSON values. Authenticate the entire current policy, exact suffixes, unchanged prefixes, both layer deltas and every unrelated field before reversing anything. Replay must reproduce the complete ordered current data. There is no identity-based success cache or caller attestation.

For raw-text preservation, record only the reviewed localized replacements for the two layer edits, activation suffix and file suffix. Authenticate the complete after bytes first; reverse those fixed replacements; verify the original byte count/hash; compare parsed inverse data with the semantic inverse; then forward-replay exact after bytes. Do not use a new formatter's serialization as the original raw file, nor store a complete historical policy as a fallback.

Keep `ir-runtime-program-policy-evolution.json`, `ir-validation-policy-evolution.json` and every source-relocation receipt untouched. The original C1 proof continues rejecting WKS-current directly; only the explicitly named new profile accepts and projects it.

### Exact four-caller integration scope

1. **`tests/issue-3518-semantic-provider-boundary.test.ts`.** Its initial `policy()` authenticates WKS-current and returns actual current data. The direct current-policy guard near line997 in the inspected C1 version becomes the explicit WKS guard. At existing historical activation inputs compose WKS-current to exact C1 to the existing B inverse. Injected history mutants never enter this normalization. Extend the independently enumerated current layer-entry suffixes by exactly the WKS contract/owner; preserve the existing signed-prefix hashes and floor formula, now yielding10/50. Preserve the original174-file bounded source fixture and all mutations.
2. **`tests/issue-3518-program-data-contract-boundary.test.ts`.** Authenticate actual WKS-current in `policy()` and return current data. Add WKS-to-C1 only before the two existing historical policy compositions, around lines355/442 in the inspected C1 version. Keep genuine current source readers, fixed historical source populations and all later fixture mutations unchanged.
3. **`tests/issue-3518-validation-policy-evolution.test.ts`.** In initial `actual()` only, add WKS-to-C1 before the existing C1-to-B operation. All original B hashes,63 controls and mutation operands remain unchanged.
4. **`tests/issue-3518-runtime-program-policy-evolution.test.ts`.** Initial `actual()` obtains authenticated C1 data before the original C1 guard. Its raw-positive input obtains exact C1 bytes through the explicit raw inverse. Preserve the565,188-byte/hash assertions,1,769/96 counts and all204 original controls. Describe this as an authenticated C1 view, not current raw bytes.

These four callers and the policy-helper source are not in the C1 receipt's18 immutable source/reader inputs; this scope does not require repinning that receipt. All source inverses remain unchanged because WKS adds files and moves no declarations. Do not adapt the four C1 source-reader suites or feed historical metadata to the actual current boundary detector.

### Root validation and publication scope

Claim the metadata/compatibility responsibility separately from the writer's three WKS paths. Root owns exactly the policy, this issue, the existing policy helper, the new fixed receipt/suite and the four existing callers. The oldA/oldB C2/C3 scopes remain held and untouched.

After freezing the production handback and composing verified delivered C1, run the following serially:

- Actual WKS production controls and final focused typing, preserving all15 named identities, both encodings/displaced spaces and descriptor-safe capture refusals. Report the real denominator; do not add14 again to the reported114.
- New fixed WKS-policy positives for genuine current input, C1 inverse, raw inverse, reciprocal replay and detached copies. Independently reject deletion/replacement/duplication/reordering of each new file/entry/history row, wrong floor/layer/state/root, same-count substitution, unknown additions, modified original prefixes/edges/unrelated fields and warmed-object mutation. Establish the actual mutation before expecting refusal, and keep getter counters zero.
- Original C1 policy204 plus semantic-provider352, program-boundary105 and B-policy63:724 existing controls, separate from new controls and from WKS runtime execution.
- Unchanged compiler-boundary detector on the genuine candidate with both required entries and their complete type/value closures. Record valid inventory separately from incomplete architecture.
- Required type, format, LOC/function, coercion/oracle/dead-export checks and normal publication hooks. No new budget, timeout, skip or gate exception is granted.

Deliver C1 first, then compose WKS on its verified delivered content in the WKS integration worktree. A fresh unrelated policy change requires an explicit reviewed composition before after hashes are fixed; it cannot be accepted as an unknown prefix. Only verified protected-main ancestry/content counts delivery. Native WKS completion does not supply source bindings, full realm completion, public Number9/9, backend equality or legacy-retirement permission.



## 2026-10-01 — Astra WKS proof implementation addendum against actual C1

**Architect: Codex GPT-6 Astra High; bounded implementer: Codex GPT-6.1 Sol Medium.** This specifies the nine already named metadata/test/issue files; it grants no production/source-relocation changes. Root owns actual policy bytes, after hashes, canonical claims, current-main reconciliation and all heavy checks. Root reports C1 PR6384 exact `8edd` in protected queue group `2ca34324`, not yet main delivery. Implementation composition waits verified C1 delivery, not queue status. The existing WKS114/114/type0 source evidence is unchanged and is not proof of this new metadata instrument. This addendum's static inspection performed no Git/network/compiler/TS Program/test/gate operations.

The unchanged issue prefix before this addendum is **1,364,738 bytes /19,210 lines**, SHA256 `389bb042925721d037447c30074c5ee6a736edbe757f441af193273fc7dcccc4`. Root retains that prefix and the original18902–18967 plan. The actual C1 helper inspected in `/private/tmp/js2-ir-runtime-program-c1-integration-20261001` has only a semantic policy inverse: it exports `authenticateIrRuntimeProgramPolicyEvolution`, `authenticateIrRuntimeProgramPolicy` and `beforeIrRuntimeProgramPolicy`; there is no existing raw-source inverse to reuse. The helper's complete10,742-byte text has SHA256 `2636bd52d821cbc1a7aaff425a03d1ea56fe29b584db5925d6ef099a893f5f3d`. Append the new WKS implementation after that exact text without editing old functions/constants/accepted populations. Its existing private descriptor capture, digest, freeze and semantic primitives can be called by appended code; do not rewrite the old proof into a generic parameterized engine.

### Exact fixed receipt and responsibilities

`scripts/compiler-boundaries.json` receives only the previously specified two ordered layer additions (runtime-contracts index10:9→10; backend-wasmgc index11:49→50), two clean file suffix rows (contract then owner) and two matching one-entry/min1 activation suffix rows. The complete C1 prefix is1769 files/96 histories; WKS is1771/98. Classified runtime-contracts9→10 and backend54→55; native classified103/required98/floor97, program44 and IR-runtime19 remain unchanged. No other layer/top-level field or allowed edge changes.

Add `tests/helpers/ir-runtime-program-policy-well-known-symbols.json` as one root-authored fixed receipt. Export its path constant and `authenticateWellKnownSymbolPolicyEvolution(text?)` for authentication/testing, alongside the three already planned WKS APIs. Bind the receipt's complete UTF-8 text SHA256 in the appended helper after root freezes actual bytes. The receipt has exactly these ordered top-level fields, with no optional wildcard fields:

- `schema:1`, `kind:"wks-exact-runtime-program-policy-successor"`.
- `provenance:{reviewedBase, planSha256, c1HelperPrefix:{bytes,sha256}, immutableInputs:[{path,bytes,sha256}]}`. Root supplies the full verified delivery base SHA and plan pin. The helper prefix pin is the exact value above, not a hash of the future extended helper. Immutable inputs comprise the original C1 receipt and the18 source/reader/B-authority inputs already enumerated by that receipt, exactly once each; do not include modified caller suites as immutable inputs or pin the new helper to its own future hash.
- `before` and `current`, each using the existing `Profile` shape exactly: `source:{bytes,sha256,gitBlob}`, `dataSha256,fileCount,filesSha256,activationCount,activationHistorySha256,layersSha256`. The before profile is the real C1 profile below. Root measures current fields after the four exact edits; no after hash/byte count is specified or guessed here.
- `allowedEdgesSha256`, the unchanged `efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7`.
- `layerDeltas`, exactly two rows in index10/index11 order, using existing C1 delta field names `index,id,beforeEntries,currentEntries,beforeMinModules,currentMinModules,roots,additions`. They fix runtime-contracts9/10/9/10/root`src/runtime/contracts`/the single WKS contract path and backend49/50/49/50/root`src/backend/wasmgc`/the single WKS owner path.
- `addedFiles`, exactly the two `{path,state:"clean",layer}` rows in contract/owner order; `activationAdditions`, exactly two `{layer,entries:[path],minModules:1}` rows in the same order.
- `census:{layers:20,files:1771,histories:98,requiredContracts:10,contractsFloor:10,classifiedContracts:10,requiredBackend:50,backendFloor:50,classifiedBackend:55,requiredProgram:43,classifiedProgram:44,requiredRuntime:19,classifiedRuntime:19,requiredNative:98,nativeFloor:97,classifiedNative:103,requiredAnalysis:11,requiredCore:29}`.
- `raw:{offsetUnit:"utf16-code-unit",spans:[{role,beforeOffset,afterOffset,before,after}]}` with exactly four ordered roles `runtime-contracts-layer-tail`, `backend-wasmgc-layer-tail`, `activation-history-tail`, `files-tail`. Raw offsets address JavaScript string positions; whole-source byte counts/hashes use UTF-8, so those units are never mixed.

The known before profile is raw565188 bytes/SHA`460eb6835dff1d22322ac9fb0fdd9526f04cd09d99d4dec8138f8e66b91ffd57`/Git blob`5395e0265ca6fef778141101ea688e456417c558`; data SHA`f24c0f10d4e8e9b5dc23471ec327f2fab7312890a5d4db035066e8c189ed2a11`; files1769/SHA`c1e4f0b02ab0d5a42e0dbef3f725d64c427fc2c866e4989b5d0da8313cd92616`; histories96/SHA`1c64b137373008c3bce05ac01a50808d2d3c2198b20b779d4f24f3bfcbdfed70`; layersSHA`c1be051d77d0857faeec740a200f3291fca0be93f2eb1bab8f93d9f2e12e9e36`. Compare the receipt before profile to `authenticateIrRuntimeProgramPolicyEvolution().current`, not merely to its own internally consistent fields. Preserve original C1 receipt6804 bytes/SHA`8e2589e90fbc697dceba56e1bbe53447250a94f3bcb03d99317ad4878bc1f58c`, B helperSHA`a962c04960b945705e9ac5a354da3e96c8e0cf5543382847231dd3df9204fb40` and B receiptSHA`39dacc9d17fb52b6a369ed81d7498afc30b00bc06d89362bba039305aa96fa0e`. Verify the existing C1 helper prefix and all19 immutable inputs freshly; these do not certify current policy without the full proof.

### Four localized raw replacements, not a saved historical policy

Author the four spans against actual unchanged C1 bytes. Span1 begins at the existing quoted final contract entry `src/runtime/contracts/native-realm-catalog.ts` and ends after that layer's `"minModules": 9`; its after text appends the WKS contract and changes only that floor to10. Span2 analogously begins at the existing last backend entry `src/backend/wasmgc/resources/native-mixed-object-access.ts` and ends after `"minModules": 49`; append only the WKS owner and change its floor to50. Preserve surrounding indentation, commas, newlines and all other bytes.

Span3 contains the final existing history record (ir-runtime, entry`src/ir/runtime/generator-support.ts`, min1) and the close of the activation array through the following `"nonModules"` key anchor. Its after text preserves that original record and appends only the two WKS activations before the same close/anchor. Span4 contains the last existing files record (`src/ir/runtime/generator-support.ts`, clean, ir-runtime) through the file-array/top-level closes and final newline; its after text preserves that row and appends only the two WKS clean rows. No whole-layer/full-policy saved-text fallback is allowed. The four spans must be nonempty, nonoverlapping, strictly increasing in both coordinate systems, unique in each corresponding source and independently checked against these fixed role anchors. Exact root-authored fragments/offsets belong in the receipt; they are not rediscovered from an untrusted policy at runtime.

Implement private fixed forward/reverse raw application. Authenticate the complete input profile byte count/hash/Git blob before any replacements. Assemble from slices of the original input using that direction's recorded offsets, checking exact fragment, first/last occurrence uniqueness and monotonic end offset; do not chain replacements whose offsets drift. Verify complete output profile and reverse reciprocal reconstruction. Reject duplicate/missing/reordered fragments, whitespace/newline changes, insertion outside spans and malformed offsets even if parsed JSON appears equivalent. `beforeWellKnownSymbolPolicySource(raw)` accepts primitive string only, proves full current raw authenticity, derives exact C1 raw by these spans, parses both and cross-checks its inverse against the genuine semantic proof, then forward-replays exact WKS bytes. It does not call a formatter or return a stored565188-byte snapshot. Original C1 raw supplied to this WKS API is not a fallback success.

### Semantic proof and explicit entry APIs

Use one private WKS proof action returning detached `current` and `before` values. Capture the entire unknown input through the existing descriptor-first routine before JSON.stringify, spread, field reads or Object.entries. Preserve its zero-getter behavior and reject hidden/symbol/accessor fields, foreign prototypes, sparse/extra arrays, cycles, functions/toJSON, undefined/bigint, nonfinite numbers and negative zero. Never allow a caller validator/serialization callback. Every public action starts a fresh capture; no cross-call identity/success cache.

Authenticate the fixed receipt, complete WKS ordered-data digest and all independent census values. Check exact two-row file/history suffixes and complete1769/96 prefix hashes, full layers and unchanged allowed edges, fixed ordered16 top-level keys and all20 layers. Validate both exact layer identities/status/required/roots/entry prefixes/tails/floors before reversing. Derive C1 from this captured current policy by removing only two file rows/two history rows and restoring the two layer tails/floors; verify full before profiles. Call the **unchanged genuine** `authenticateIrRuntimeProgramPolicy(before)`, which itself proves B through the unchanged B guard. Forward-append the independently fixed WKS delta to a detached copy of that verified C1 result and compare the complete ordered WKS data and digest to the initial capture. Other fields are retained from actual current input, never copied wholesale from receipt-saved layers or a saved policy.

`authenticateWellKnownSymbolPolicy(value)` returns a detached deeply frozen current snapshot; `beforeWellKnownSymbolPolicy(value)` returns a fresh mutable detached C1 copy for old mutation controls. `beforeWellKnownSymbolPolicySource(raw)` implements the raw contract above. Original C1 APIs continue accepting only1769/96 with their old digests and directly reject1771/98. Original B APIs likewise do not gain WKS admission. The receipt-authentication API may accept alternate text only to test its one fixed digest/schema; it accepts no alternative expected hash/profile.

### Four caller starting views and original-control preservation

1. `tests/issue-3518-semantic-provider-boundary.test.ts`: `policy()` parses actual current policy, invokes the WKS guard and returns that actual current object. Replace its direct current C1 guard with the WKS guard. At **every existing** `beforeIrRuntimeProgramPolicy(policy())` or equivalent initial historical input, insert `beforeWellKnownSymbolPolicy` immediately inside it; the old activation inverses receive genuine B-derived data. Do not adapt `assertCurrentActivations` to accept a new arbitrary prefix or normalize an injected history mutant. Add only the two exact WKS suffix paths to independent current layer-entry expectations (contracts10/backend50). Keep all352 original cases, signed prefixes, original174-file live fixture and current782-edge census (403type/379runtime): WKS adds no import to a module already in that bounded fixture. The separate future SameValue175-module correction is outside this WKS proof.
2. `tests/issue-3518-program-data-contract-boundary.test.ts`: `policy()` authenticates/returns actual WKS-current. Only the two existing `historicalIrValidationPolicyView(beforeIrRuntimeProgramPolicy(p))` initial views near actual C1 lines355/442 insert WKS→C1. Preserve all105 cases, actual current source readers, existing source inverses and mutation operands.
3. `tests/issue-3518-validation-policy-evolution.test.ts`: only initial `actual()` changes from `beforeIrRuntimeProgramPolicy(JSON.parse(read(...)))` to explicit WKS→C1→B. All63 cases still start from exact authenticated B; hashes, `refused`, mutation generators and genuine B calls stay unchanged.
4. `tests/issue-3518-runtime-program-policy-evolution.test.ts`: initial `actual()` reads real WKS data then calls `beforeWellKnownSymbolPolicy` and the original C1 guard. The single original raw-positive input becomes `beforeWellKnownSymbolPolicySource(read(...))`; its565188/raw SHA/data SHA/1769/96 assertions remain unchanged and described as a reconstructed authenticated C1 view. Do not change its `refused` helper, independent C1→B replay,204 mutations or18 immutable-input assertions. The test suite is proving C1 against genuine WKS-derived initial input, not claiming raw WKS is old C1.

These four callers and the existing helper are absent from C1's18 immutable source/reader pins, confirmed by reading the actual receipt. No repinning of that receipt, source-relocation helper or old B authority is needed. New WKS receipt uses19 immutable inputs because it additionally pins the original C1 receipt itself; this is not a change to C1's original18. The only new test file is `tests/issue-3518-well-known-symbol-policy-evolution.test.ts`; the only new receipt is the fixed WKS JSON above. Preserve the nine-file scope including this issue; any additional dependency or overlapping source path needs root's new exact scope check.

### New controls and root handback

New positives must independently read actual policy/raw bytes, establish1771/98 and the10/50 versus classified10/55 census, prove genuine C1 guard acceptance of the derived1769/96 inverse, prove C1→B remains real, reconstruct WKS data using a test-local independently enumerated two-row delta, and reconstruct raw bytes from the four reviewed fragments. Check all immutable pins, original-helper prefix, frozen/detached current results, mutable/detached historical copies and repeated independent calls. Existing C1/B guards must reject raw WKS semantic data directly; WKS guard must reject direct C1 data. Report actual new test count only after execution; do not inflate724 old controls with wrappers.

Negatives independently delete/replace/duplicate/reorder each new file, layer entry and activation; change layer index/id/root/state/status/required/floor, swap same-count entries, insert unknown paths, mutate any old prefix/edge/unrelated field or key order, and corrupt complete current/raw/receipt bytes. Prove every mutation before expected refusal. Exercise each of four raw fragment boundaries and bytes outside them, LF/CRLF/final-newline and whitespace-only drift, missing/duplicate/reordered anchors, while preserving original fixed-receipt failure evidence. Getter/toJSON counters stayzero; test nested accessors, holes/inherited elements, symbols/hidden fields, foreign prototypes, cycles and warmed-object mutations. Fresh genuine input must still pass after each refusal. Raw and semantic proofs must agree; tests must not call the candidate twice and call that an independent oracle.

Root first verifies delivered C1 content/policy/helper pins and current overlap/claims, authors/freezes actual after metadata and receipt, and dispatches Sol6.1 Medium only inside the authorized scope. If delivered main contains a policy change outside these exact two WKS additions, stop authoring and specify the concrete composition; do not adjust old hashes or choose a looser profile. Root alone runs typing, actual new proof suite, all724 original controls (204+352+105+63), unchanged114 WKS production rows as required by final source changes, inventory/architecture checks and required normal gates/hooks. Source-only specification is not runtime, C1 delivery or full migration evidence. Public9/9/all45/44/44/2, source/mixed/dynamic/backends and legacy-retirement requirements remain unchanged.


## 2026-10-01 — Astra static review of root-authored WKS successor artifacts

**Reviewer: Codex GPT-6 Astra High; implementation default remains Codex GPT-6.1 Sol Medium.** Root reports C1 exact8edd content merged through2ca34324 and verified on actualmain `c7366c3c6d3eb9e4c5cff0b29b11c42e3faab4c7`, with all26 path blob/mode/type matches and independent successful conformance/final/quality/equivalence/gate/differential/CLA evidence. The original issue-tests attempt1 cancellation remains retained; the official exact merge-group retry was still in progress at this dispatch, so root has not claimed complete acceptance/claim completion. No Git/network or CI query was performed by this reviewer. Root retains the stated retry-proof prerequisite before applying/dispatching metadata.

Read-only review covered the five root-authored scratch artifacts in `/private/tmp/js2-ir-well-known-symbol-integration-20261001/.tmp/wks-integration/` and the copied `astra-exact-helper-plan.md`. Independent Python byte/JSON arithmetic, separate from the root authoring script, found **no artifact discrepancy**. This is static data verification, not execution of the TypeScript helper, compiler inventory, test suite or gate. The root authoring script was read, not executed. No tracked policy/source/receipt was changed: tracked `scripts/compiler-boundaries.json` still exactly equals before-policy.json and the tracked WKS receipt is absent.

The receipt is9,566 bytes/SHA256 `ce9351c3b4c026a746d44cc769b6ff3968c2feabe686abe07e8361d4b28f7172`; authority-freeze is2,772 bytes/SHA `dd25c93ddfe768936932d00018081cf20d812a98ba0fdb4785bed251106b1392`; author script is7,013 bytes/SHA `0ce67b7568baa66793d557881e7187597f45ea2bebdfb4749e52c747f6cae3ca`. The16,129-byte copied plan is an exact contiguous appendix of this issue and matches recordedSHA `803f3fcc5af93344f878b33dace6c9484d2d4aa1437e9537548c899f4204753c`. Reviewed-base provenance equals root's stated fullc736 SHA; that agreement is not an independent Git ancestry check.

Before policy matches the original C1 receipt current profile in every raw/data/file/history/layer field:565188 bytes,1769 files,96 histories. Current scratch policy is565875 bytes/SHA `451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59`, Git blob `74dc1b073145713d122e28a0b45f34c0cc41a066`, ordered-data SHA `462b8a9a6047378eed5913e51441761734663ff8c53cbb804106368ff1a33be7`. Independent construction of only the two specified layer-entry/floor additions and two file/history suffix rows matches the complete current ordered data; all unrelated data/field order and allowed edges are unchanged. Actual scratch counts are1771/98, contracts10/10/10 and backend50/50/55; program43required/44classified, IR-runtime19/19 and native98required/97floor/103classified retain their exact values. Every declared census and both complete layer-delta rows match the independent specification.

Four spans occur exactly once on each side, remain nonoverlapping/increasing, and obey the reviewed fixed anchors. Their before→after UTF-16 offsets are9384→9384,12760→12816,64874→64999,565065→565475; lengths are78→134,92→161,140→425,123→400 code units. Independent UTF-16-unit slicing reproduced exact forward current bytes and exact reverse C1 bytes, including final newline; the net687-byte increase agrees with the raw profiles. Both whole raw SHA256 and Git-blob profiles and all ordered semantic hashes agree with receipt/freeze. These offsets are literal frozen coordinates, not search-derived authority for accepting a different file.

Receipt schema/top-level order, fixed kind, exact two added-file/activation rows, layer indexes/roots/floors and census conform to the preceding contract. All19 immutable paths are unique; rows2–19 exactly equal C1's18 immutable records and every actual current file matches its declared byte/hash pin. The first row is the unchanged original C1 receipt. The actual helper is still the exact10,742-byte prefixSHA `2636bd52d821cbc1a7aaff425a03d1ea56fe29b584db5925d6ef099a893f5f3d`. No old receipt, helper prefix or source input needs repinning for these authored artifacts.

Implementation clarification: pin the reviewed receipt's exact text SHA above in the appended helper, but still validate its independently fixed shape/constants/profile relation and full actual policy before deriving any predecessor. The root authoring script and authority-freeze are authoring evidence, not runtime validators or a successful-authentication cache. Do not execute/import that scratch script from tests, trust its saved before-policy as the inverse answer, or replace the genuine unchanged C1 guard with a saved hash comparison. Implement descriptor-safe full capture, semantic and raw inverses, genuine C1 invocation, reciprocal replay, immutable-input/prefix checks and all negative/current-source controls exactly as specified. Keep the four caller initial-view boundaries and all724 original rows/raw565188 witnesses unchanged. The author's optional `--apply` branch is not authorization to run it before root's retry-proof/integration gate.

This review froze and preserved the complete preceding issue prefix:1,380,867 bytes/19,266 lines, SHA256 `276edbdf0743e99d5603070d97a1a2745d8b4311c6edfc95052512354e25c448`. Only this review appendix changed. No new source, helper, receipt, policy or claim edits and no compiler/tests/gates ran. Root owns any later artifact revision and fresh after pins; unknown main-policy drift requires explicit composition, not relaxed hashes. Full public/catalog/backend/dynamic/legacy-retirement obligations remain open.

Root formatting handback: the reviewed scratch receipt was formatted with the repository Prettier configuration before its eventual helper binding. Exact ordered JSON data, policy bytes, four spans and all pins are unchanged; formatted receipt SHA256 5b28556311bb1548e3fb399fc8dee458fcec60f0d5366714e6298af123b73a61. The original reviewed receipt and a separate before/after formatting proof are retained. No tracked policy or receipt has been applied.


### 2026-10-01 — implementation proceeds on verified delivered C1 contents

Fresh exact rerun job110387553636 confirms its mandatory pinned issue-test step SUCCESS; the advisory changed-test step remains in progress. All C1 source/policy/helper contents and ancestry on main are independently verified, with all other merge-group gates successful. Root therefore begins reversible successor implementation while preserving the complete remaining job obligation. C1 claim completion and successor publication remain gated on terminal acceptance; no incomplete job is called passing. This updates the earlier implementation-wait decision without weakening any test, gate, historical receipt or migration requirement. Root has applied only the reviewed two-leaf policy, formatted fixed receipt and three frozen WKS source/test leaves in the isolated successor tree. Sol6.1Medium owns only the helper append and new focused policy suite in an isolated worker tree; root owns the four original callers, metadata, issue, serial heavy checks and delivery.


### 2026-10-01 — C1 mandatory protection verified and WKS validation begins

Root corrected the earlier required-gate classification against the active main ruleset16700772. Its six mandatory contexts are cheap gate (main-ancestor + lint), merge shard reports, quality, equivalence-gate, check for test262 regressions and cla-check. Each is SUCCESS on exact C1 merge_group2ca34324, attempt1, with102 successful conformance shards and actual final/report/equivalence jobs. The issue-tests job is not required by that ruleset. Attempt1 and retryattempt2 advisory cancellations remain recorded and receive no success credit; the retry fatal pinned step did pass. Root did not change protections, workflow, timeouts or tests.

A fresh main advance to5a41f88a104b21469f5670f2a41895d5764c52e8 contains only six npm benchmark artifacts. Root fetched that exact commit, proved C1 merge ancestry and all26 PR path blobs/modes/types still exact. The first completion preflight correctly stopped before any claim mutation when main changed. Only the seven owned C1 slices are eligible for completion, not the epic or foreign claims.

Sol6.1Medium completed only the existing policy-helper append and new focused suite; all original10742 helper bytes remain exact, and the154 drafted cases are not counted as passing before execution. Root imported the two authenticated source pins. Independent Sol static review of the four original callers found no concrete defect and proved preservation of all724 original generators/mutation operands and the174-module/782-edge fixture. Root actual native WKS114/114 and focused typing pass on delivered C1; the real boundary detector reports1771 modules, zero inventory errors, architecture incomplete. All six candidate suites are now executing serially with the original timeouts/flags; new policy/runtime acceptance, normal hooks and publication remain pending.


C1 slice completion handback: all seven owned claims are now decoded/effect-verified done at canonical tip 559ef3e41078e742a9f65f0d2a31f160e9959c8b. This completes only the delivered C1 relocation and preservation slices. The tracking epic, foreign claims and remaining public/native/source/dynamic/backend requirements remain open. Original advisory cancellations and the protection-rule correction are preserved.


### 2026-10-01 — executed WKS candidate acceptance

The six-suite candidate run passed992/992 with zero failed/pending: new WKS policy154, native Symbol114, and all724 preserved controls (program boundary105, C1 policy204, semantic provider352, B policy63). Full scoped TS7 exited0. Lint initially rejected the new suite’s delete operator; Sol6.1Medium replaced only that operation with Reflect.deleteProperty, preserving actual deletion and reinsertion. The focused successor suite passed154/154; root preserved the original full result and raw lint failure. Repository formatting then changed only layout and produced byte-identical transpiled JavaScript. The final typing/lint/format/LOC/function/oracle/coercion/dead-export gates all exit0 using the exact current-main source scope. No grant, timeout, assertion or gate was weakened.

The boundary inventory contains1771 modules, zero errors, contracts10 and backend55 classified; two new required entry/floor counts are10/50. Architecture remains incomplete. The original C1 helper prefix, original C1/B/source receipts, all19 immutable inputs and the native production source pins remain exact. Independent Sol reviews found no concrete caller or helper bypass; malformed content is refused by full digests, with no later-branch isolation credit. Normal signed commit/push hooks, final current-main/head/claim/overlap checks and ready protected PR delivery remain outstanding. Public Number9/9, the full native catalog algorithms, source/dynamic/mixed execution and both-backend equality are not established by this component.


## 2026-10-01 — Implementation Plan: integrate the prepared Number prerequisites after WKS

**Architect: Codex GPT-6 Astra High; default implementer: Codex GPT-6.1 Sol Medium.** This bounded increment imports the existing four production leaves and four tests, then proves their exact boundary-policy successor. It does not repeat the completed production repair or implement the missing public Number graph. Planning base is `75e59458067c293749da33fb5fbb4eaf7031144c`; root's dispatch records WKS PR6386 OPEN with quality running, not delivered. Root must establish actual protected-main ancestry, content and required merge-group evidence before source integration. A later main descendant is usable only when the exact reviewed source/policy delta and every predecessor pin/profile remain valid; ancestry alone admits nothing, and an unrelated policy change requires an explicit new composition.

### Existing prepared input and ownership

The donor is `/private/tmp/js2-ir-number-prerequisite-recovery-20261001`. Its `.tmp/number-recovery/definition-capture/validation-v5/results.json` actually records **713/713**, zero failed/pending: BigInt body201, BigInt owner75, primitive classifier185, Number body252. V6 records **252/252** for the changed Number test, exact other-seven pins, and reciprocal restoration of its four lint-only identifier edits. All eight current donor files match V6 `source-freeze.json`; all eight are absent from this planning base. These are unpublished component results, not a fresh run on the future integration tree.

| Frozen donor path | Bytes | SHA-256 |
| --- | ---: | --- |
| `src/runtime/wasmgc/values/bigint-to-number-body.ts` | 9195 | `a698e80ad9054d7dd66ed33e17798b339b3ae2c16c7b9efdd004394d52e91d80` |
| `src/runtime/wasmgc/values/number-from-value-body.ts` | 9609 | `00376356e12a0d70976addeff7911b1ec5401375b1f4eb0d7c81450568c20b59` |
| `src/backend/wasmgc/resources/native-bigint-number.ts` | 15683 | `ccc1c66d4fc734339cc9a192dc29f24d08483fb7a559b777a903a622b64c3cc6` |
| `src/backend/wasmgc/resources/native-number-primitive-classifier.ts` | 21040 | `210c30e3f2928952ebfceeafb8f6545930054b0c5ed9c1ec66ca2afcc41e7161` |
| `tests/issue-3518-bigint-to-number-body.test.ts` | 11598 | `f80b9fe1701a8f289a458a5032d3d4bd0af4910d723eabe343476b4814c3f130` |
| `tests/issue-3518-native-bigint-number-owner.test.ts` | 29455 | `b266965df90630f184a136f07c6867f99b59507f1ee11f0ca141c047e6b8f621` |
| `tests/issue-3518-native-number-primitive-classifier.test.ts` | 43687 | `45ad86969dd28b1597eef4e8e0a53531ea4f3dc54e90e2784ca6cb01baec626d` |
| `tests/issue-3518-number-from-value-body.test.ts` | 36900 | `2abc9c96ebd7fcda5547c8f093530d08d56796b4ab4b636b64a4d3b0ff5ae969` |

Root alone integrates these bytes under the preserved original Number claims and receiver-ABI continuation after fresh canonical overlap checks. This plan grants/releases no source claim. The new planner claim covers only this append-only issue and its scratch. Preserve old foreign linker and C2/C3 claims, the WKS writer's source, and the separate runtime-definition owner. No donor branch overlay or unrelated archive recovery.

The implementations already contain the intended mechanisms: `buildBigIntToNumberDefinition` at donor line224 retains full-width guard/sticky/ties-even conversion; `buildNumberFromValueDefinition` at line167 retains scalar `Get(target,key,receiver)`, actual receiver/method argument order, primitive/Symbol/BigInt branches and uncaught abrupt propagation. The BigInt owner's `captureLiveDefinitions`/`requireCompletedNativeBigIntNumber` are at lines70/323; classifier equivalents at104/432. They preflight original live descriptors before borrowed producer/ledger reads and independently compare full definitions after genuine dependency completion. Import these completed repairs; emit no new Wasm instructions in this integration task.

Keep `tests/helpers/native-bigint-carrier-fixture.ts` unchanged (2844 bytes, SHA `e4256172936834a5b36df9619705b2197969ac52b1b376ca53a31532c7d8d915`) and the WKS contract `src/runtime/contracts/well-known-symbols.ts` unchanged (749 bytes, SHA `86933d515e3a243a9577ce4d14f3edd059423292fda7c638d907ec61b321d404`). Preserve the original public fixture and all V1–V6 raw failures/results. Number's252 tests retain their algorithm-component imported Get/Call harness label; they are not public source execution.

### Exact four-leaf metadata delta

Root edits only `scripts/compiler-boundaries.json` as follows. Append the two runtime body paths in table order to `layers[12]` (`native-runtime`, root `src/runtime/wasmgc`), and the two backend owner paths in table order to `layers[11]` (`backend-wasmgc`, root `src/backend/wasmgc`). Retain active/required flags and all old entry bytes/order. Append four `{path,state:"clean",layer}` rows to `files`, in the table's four-source-path order. Append exactly two activation records, first native-runtime with the two body entries/minModules2, then backend-wasmgc with the two owner entries/minModules2. Tests are not classified source modules.

| Complete policy census | Real WKS predecessor | Number successor |
| --- | ---: | ---: |
| files / activation records / layers | 1771 / 98 / 20 | 1775 / 100 / 20 |
| backend entries / floor / classified | 50 / 50 / 55 | 52 / 52 / 57 |
| native entries / floor / classified | 98 / 97 / 103 | 100 / 99 / 105 |
| contracts entries / floor / classified | 10 / 10 / 10 | unchanged |
| program entries / floor / classified | 43 / 43 / 44 | unchanged |
| IR-runtime entries / floor / classified | 19 / 19 / 19 | unchanged |
| analysis / core required entries | 11 / 29 | unchanged |

**Do not normalize the native floor to100.** Its existing one-entry offset is historical reality; add only2 to97. Historical WKS/C1/B inputs must still show98/97/103. Preserve all16 top-level keys/order, roots, external-package rules, evidence, moves and allowed edges (SHA `efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7`). Static import inspection finds22 direct module edges: body2/type-only2, Number body2/type-only1, BigInt owner6/type-only2, classifier12/type-only4. All targets fit existing native/backend permissions. Root still runs the real complete transitive type/value inventory; this static count is not its replacement. Add no edge, budget allowance, timeout, gate or fixture expansion.

### One fixed Number proof, explicitly deriving genuine WKS

**Recommendation: append to `tests/helpers/ir-runtime-program-policy-evolution.ts`, after its exact existing23854 bytes**, SHA `fe575facb2aedc750760ba302ded54ab37ac223ff70e0d07f25faa804de84474`. This reuses private descriptor-first `capture`, digest/freeze and profile types without extracting or changing either predecessor. The concrete invariant is stronger than preserving exported names: every old C1/WKS byte remains identical, and the new proof must call `authenticateWellKnownSymbolPolicy(derivedBefore)` successfully. A separate leaf would either duplicate the defensive capture implementation or require touching/exporting old internals; neither is needed for this fixed increment. Do not turn the helper into a generic policy engine.

Append explicit APIs `numberPrerequisitePolicyReceiptPath`, `authenticateNumberPrerequisitePolicyEvolution(text?)`, `authenticateNumberPrerequisitePolicy(value)`, `beforeNumberPrerequisitePolicy(value)` and `beforeNumberPrerequisitePolicySource(raw)`. Add only `tests/helpers/ir-runtime-program-policy-number-prerequisites.json` and `tests/issue-3518-number-prerequisite-policy-evolution.test.ts`. Old C1/WKS/B APIs continue rejecting direct Number-current data. No profile detection, prefix fallback, caller-selected hashes or normalization of mutants.

Root first authors/freezes actual candidate policy and the fixed receipt in scratch. Freeze the eight source inputs above, the complete predecessor, policy before/after profiles, exact four raw spans, and the helper prefix before the implementer binds any after digest. The receipt uses the WKS receipt's ordered shape (`schema,kind,provenance,before,current,allowedEdgesSha256,layerDeltas,addedFiles,activationAdditions,census,raw`), with kind `number-prerequisites-exact-runtime-program-policy-successor`. Provenance fixes the actual reviewed delivered base and this plan's digest, `wksHelperPrefix`, ordered `immutableInputs` and ordered `sourceInputs`. The former is exactly the WKS receipt itself followed by its existing19 immutable inputs (20 unique paths); the latter is exactly the eight V6 files above, with bytes and SHA. Recheck all on every public proof action. Do not pin a mutable whole issue or a whole helper containing its own receipt hash.

The unchanged WKS receipt is9470 bytes / SHA `5b28556311bb1548e3fb399fc8dee458fcec60f0d5366714e6298af123b73a61`. Require the new receipt's complete `before` profile to equal its genuinely authenticated `current`. Actual WKS policy:565875 bytes, SHA `451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59`, Git blob `74dc1b073145713d122e28a0b45f34c0cc41a066`, ordered-data SHA `462b8a9a6047378eed5913e51441761734663ff8c53cbb804106368ff1a33be7`. Freeze actual Number after values; no after hash is invented here. Preserve every old receipt, source-relocation helper and immutable input, including C1's18 and WKS's19 membership/order. The new receipt hash is a literal bound in appended code; alternate text is only a negative-test operand, never authority to select a profile.

Semantic action: freshly descriptor-capture the entire unknown input before field reads/serialization; retain old zero-getter and non-JSON refusals. Authenticate fixed receipt and all pins; check complete current ordered digest/profile,16 keys,20 layers, allowed edges, independently enumerated census,1771-file/98-history predecessor prefix digests, exact four/two suffixes, and layer identities/roots/status/required/entry tails/floors. Derive `before` from that actual captured current object by removing only those suffixes and restoring backend50/50 and native98/97. Check its full predecessor profile, then invoke **unchanged `authenticateWellKnownSymbolPolicy(before)`**, which really proves WKS→C1→B. Forward-replay an independently fixed four-leaf delta over a detached copy of that verified result and compare complete current data/digest. Never substitute a receipt-saved whole policy or layer. Return detached deeply frozen current from authenticate, fresh mutable WKS from before; each call recaptures, including after a previous success.

Raw proof has exactly four nonempty, unique, nonoverlapping spans in source order, offsets in UTF16 code units: (1) backend layer tail from quoted `src/backend/wasmgc/resources/native-well-known-symbols.ts` through minModules50, appending only the two owners and floor52; (2) native layer tail from quoted `src/runtime/wasmgc/values/mixed-object-access-bodies.ts` through minModules97, appending only the two bodies and floor99; (3) final WKS backend activation record through array close and `"nonModules"` anchor, preserving it and appending only the two grouped min2 records; (4) final WKS backend files row through final array/object close/newline, preserving it and appending only four clean rows. Root records exact fragments/offsets from the real before/after files; layerDeltas are index11 then12, regardless of the native-first file/history order.

Authenticate whole input bytes/SHA/Git blob before applying raw spans. Validate role anchors, monotonic original-input offsets, accumulated displacement and first/last-occurrence uniqueness; assemble slices without drifting offsets. Check output complete profile, exact reciprocal reconstruction and agreement of parsed raw inverse with the semantic inverse. `beforeNumberPrerequisitePolicySource` returns the actually reconstructed WKS bytes, then exercises the unchanged WKS raw inverse to C1. Refuse whitespace changes outside spans, duplicated/reordered fragments, object-wrapped strings and direct old WKS input. No formatter or saved565875-byte output snapshot can establish the inverse.

### Exact compatibility edits and worker split

Root owns the eight imports, policy, fixed receipt, this issue, and **five** existing caller files. Sol owns only the helper append and the new Number policy suite after root hands over frozen artifacts. This is18 tracked paths total, including eight new source/test paths; no contract, native fixture, source reconstruction or old receipt change. Root rechecks exact path overlap/claims before granting implementation scope. Neither this planner nor Sol takes over the old Number/foreign claims.

1. `tests/issue-3518-semantic-provider-boundary.test.ts`: at `policy()` near400 and the direct current guard near998 authenticate Number-current and still return/test actual current policy. At every existing initial `beforeWellKnownSymbolPolicy(policy())`/`beforeWellKnownSymbolPolicy(p)` historical composition insert `beforeNumberPrerequisitePolicy` immediately inside WKS; retain WKS→C1→B and all original mutation operands. Append exactly the two native/two backend paths to the independent current layer-addition lists near1102; preserve signed-prefix hashes and floor formula. Keep the174-source fixture and782-edge census (403type/379runtime) unchanged: none of its existing sources imports these newly added leaves. Do not include new leaves in that historical fixture merely to inflate coverage.
2. `tests/issue-3518-program-data-contract-boundary.test.ts`: current `policy()` near135 uses the Number guard; the two initial historical compositions near357/445 become Number→WKS→C1→B. Preserve actual current readers,105 controls and all source inverses.
3. `tests/issue-3518-validation-policy-evolution.test.ts`: only initial `actual()` near29 gains Number inverse immediately before WKS. Preserve63 controls, B hashes, refusal helpers and mutants.
4. `tests/issue-3518-runtime-program-policy-evolution.test.ts`: only initial `actual()` near25 gains Number inverse before WKS; initial raw-positive near74 becomes Number raw inverse then WKS raw inverse. Preserve204 controls, original565188-byte C1/raw/data assertions,18 immutable inputs and independent C1 replay.
5. `tests/issue-3518-well-known-symbol-policy-evolution.test.ts`: its initial `raw()` near22 becomes `beforeNumberPrerequisitePolicySource(read("scripts/compiler-boundaries.json"))`; its existing `actual()` parses that authenticated derived WKS input. Preserve all154 WKS controls,565875-byte/hash/19-pin assertions, independent two-row replay, raw fragments, `rawRefused`, `rejected`, descriptor refusals and all mutation operands. Change the positive test's description to identify the authenticated WKS predecessor view. Mutants built from `raw()` are sent directly to the existing WKS raw API, never back through Number. The new Number suite separately reads the true current raw directly; it must not reuse this historical initial view.

These narrow initial-view adaptations preserve four old callers'724 controls plus WKS154 = **878 historical controls**. Historical guards never learn to admit Number, and a malicious current input cannot be made acceptable by choosing a predecessor from its shape. Root retains before/after caller bytes and reviews each mutation generator/operand for preservation.

### Required proof and bounded completion

New Number tests independently read actual current bytes and establish1775/100 and each census; derive1771/98 WKS and prove genuine unchanged WKS→C1→B; independently replay the four source rows/two histories and both layer changes; independently assemble the four raw slices and reciprocal bytes. Check all28 fixed full-file pins (20 predecessor inputs +8 source inputs), the23854-byte helper prefix and nested10742-byte C1 prefix, detached/frozen versus mutable copies, and repeated actions. Explicitly require each old guard to reject direct Number, and Number to reject direct WKS/C1/B. No wrapper around an old test counts as a new semantic result.

Negatives cover deletion/replacement/duplication/reordering of each new source row, required entry and activation; wrong layer/state/root/floor; same-count substitutions; extra unknown files/entries/history; any old prefix/allowed-edge/unrelated-field drift; receipt/source pin drift; raw fragments, offsets, outside-span bytes and reciprocal mismatch. Preserve descriptor-first zero-getter tests, hidden/symbol/inherited/sparse/cyclic/non-JSON inputs and warm success→actual mutation→refusal→exact restoration→success. Establish that each mutation happened before asserting refusal; no successful-object cache, mutant auto-selection, rewritten receipt or swallowed failure.

Root runs serially against final integrated bytes: focused current typing; the four production suites retaining all713 rows (201/75/185/252), zero skips; all878 historical policy/boundary controls; unchanged114 WKS native controls; and the new Number suite, whose actual denominator is reported only after execution. This is1705 existing controls plus actual new controls, not a claim that1705 have been rerun here. Preserve native owner no-semantic-import execution, genuine carrier/encoding/displaced-coordinate controls, full-definition/accessor restoration controls, and the Number component label. Run real inventory/architecture and unchanged format/lint/LOC/function/oracle/coercion/dead-export gates/hooks, with current-main scope and no grants. Inventory should contain1775 modules with zero errors while architecture remains incomplete; extra rows/errors require explanation, not baseline rewriting. Root retains failures, source/policy/pin freezes and actual required protected delivery evidence.

Completion of this increment means these exact prepared leaves and their strict successor proof are delivered. Public Number remains the recorded **5/9**, with four public original/decoded×encoding rows missing `js.number.from-value`; no public row was rerun here. Current source still declares that feature without its provider (`src/ir/runtime/number-conversion-callable.ts:11`, contracts manifest feature near43/provider IDs near102), reserves unfilled checked Get `(externref,externref,externref)->(i32,externref)` (`native-mixed-object-access.ts:197,459`), and refuses full realm completion (`native-object-realm.ts:457`). The later real joins remain source identity/captured cells and scalar Get/Call/IsCallable, genuine Number owner and provider, all45 catalog objects/44 Call algorithms/44 lifted entries/2 Construct entries, complete population/failure replay and dynamic behavior, then both-backend equivalence. Runtime-definition component completion does not discharge the42 pending Call algorithms or2 Construct roles. Existing harder graph plans cover those separate claims; do not widen this import/proof task into speculative implementations. Legacy remains until complete IR coverage, testing and equality.

**Exact next dispatch:** after root verifies WKS delivered content/protection and renews its held-claim integration authority, root imports only the eight V6 files and authors/freezes the stated policy/receipt/raw spans. Dispatch Sol6.1 Medium to append only the fixed Number proof to the existing helper and create its one new suite using those artifacts; root adapts the five callers, validates serially and delivers through normal protection. Raise effort only for a concrete new mechanism or incompatible current contract. This planning pass performed read-only source/evidence inspection and static byte/JSON arithmetic; no compiler, TypeScript Program, tests, gates, network or source mutation was run. The only Git read was the required initial isolated-worktree branch verification.


### 2026-10-01 — Static interface review: distinguish declarations from type/value edges

This addendum clarifies the preceding import-count wording without changing its integration scope. Sol6.1 Medium's donor receipt `.tmp/number-recovery/current-interface-review.json`, captured2026-10-01T14:49:43.576764Z, SHA-256 `2f9334ee2714145e8301bf0ae2c5754d6decec38da433dbbbb566674ff155ce8`, lists **22 import declarations**, consisting of9 wholly type-only declarations and13 value-bearing declarations. Splitting mixed declarations into their separate type/value dependencies yields **28 edges:15 type and13 value**. Thus the preceding phrase “22 direct module edges” denotes declaration-level module imports, not the boundary detector's split type/value edge unit. The four per-file declaration totals remain2/2/6/12; all28 split edges use existing permitted layer relations. The historical fixture's782 split edges (403type/379runtime) remains a separate, unchanged population.

The receipt confirms all eight V6 source/test pins, byte-identical external production interfaces, and all40 external test dependency declaration rows. It records86 reachable module hashes from the saved TypeScript-resolver graph at `c7366c3c6d3eb9e4c5cff0b29b11c42e3faab4c7`; static readback here independently confirms86/86 hashes against planning base `75e59458067c293749da33fb5fbb4eaf7031144c`. Its `recorded_graph_complete` is explicitly false, with empty recorded scoped unknown/unresolved/forbidden/transitive-violation lists. This is hash continuity for that recorded reachable set, not a freshly recomputed or complete graph, current inventory admission, typing or runtime evidence. Its `source_edits_required` is empty. Integrate all four frozen production leaves together because the BigInt owner imports the frozen BigInt body absent from the baseline; no source API repair is indicated. The public source fixture remains SHA `c0550b99175c0eb61afa7d5d110a287f3fe90e9fc8e581c6d58a19fe0a971ba9`, with the original5/9 result unchanged.

Root's follow-up reports WKS in protected queue position1, group `6c216adfc54f6c8c07b83dcad54d8bfb7121a285`, parents abbreviated `5a41` + exact WKS head `75e59458067c293749da33fb5fbb4eaf7031144c`; CI run36879254320 and Test262 run36879254659 are in progress. These are root-reported pending observations, not independently fetched or successful delivery evidence. Source integration still awaits actual protected-main ancestry/content and required merge-group acceptance. The next dispatch, fixed successor proof, frozen source scope and all validation obligations above remain unchanged. This follow-up ran only receipt/byte reads and static arithmetic; no compiler, TypeScript Program, tests, gates, Git or network operations.


### Root execution audit — original public Number fixture on the published WKS source

After the static plan, root reran the original unchanged `tests/issue-3518-public-number-object-712.test.ts` (4487 bytes, SHA256 `afc3885f51522cec10d5eccac536636b104b9a01b8c5e5c139b8dbd5fef35d37`) and the original source fixture `tests/fixtures/issue-3518-native-object-access-712.ts.txt` (293 bytes, SHA256 `c0550b99175c0eb61afa7d5d110a287f3fe90e9fc8e581c6d58a19fe0a971ba9`) against exact source revision `75e59458067c293749da33fb5fbb4eaf7031144c`. No prepared Number prerequisite production leaf was added, and no source, assertion, fixture, timeout or metadata changed. This is current published-head evidence, not historical/current comparison or verified-main acceptance.

Actual result: **5/9 passed, 4 failed, zero skipped**, exit1. The native oracle and all four explicit legacy host/standalone × UTF16/UTF8 rows still execute712. All four public original/decoded × encoding rows still fail in actual preparation with `invariant: runtime feature js.number.from-value has no provider`. They do not reach decode, acceptance or emission, so none earns decoded/runtime coverage. Preserve these failures and the complete nine-row denominator. The initial audit setup mistakenly expected the already-present byte-identical source fixture to be absent; the first startup therefore had no dependency symlink and executed zero tests. That setup observation and startup log are retained separately; only the subsequent actual nine-row report counts.

Raw evidence is retained in `/private/tmp/js2-ir-number-successor-plan-20261001/.tmp/number-successor-plan/current-public-number-audit/`: input-freeze.json, report.json, runtime.log and acceptance-audit.json. The standalone Astra plan and its digest remain unchanged. WKS PR6386 is now first in the protected queue at actual merge-group `6c216adfc54f6c8c07b83dcad54d8bfb7121a285`, with exact parents freshly verified main `5a41f88a104b21469f5670f2a41895d5764c52e8` and published head75e5945. Its specific merge-group CI and conformance runs are active at this observation; no main delivery or full migration completion is claimed. Root leaves the existing Number and new planning claims held.


## 2026-10-01 — Fresh Number component acceptance and bounded Sol dispatch

Root integrated all eight frozen V6 source/test files into isolated
`codex/3518-number-prerequisite-integration-20261001` at freshly verified main
`345616935e6ad070f1c39f9eb360131241acbbae`, after protected WKS delivery. Four
original Number claims retain their actors and now name the integration branch;
root's separate policy claim remains held. The full18-path overlap census
found no new or changed overlap. No foreign claim was transferred or released.

Actual focused TypeScript7 typing exited0 with no diagnostics. Fresh Number
runtime suites passed **713/713**, zero failures/pending:201 BigInt body,
75 BigInt owner,185 classifier,252 Number body. All eight source/test and20
predecessor pins remain exact. The unchanged native WKS suite passed
**114/114**, zero failures/pending. These component results do not establish
public source, decoded replay or catalog coverage. Original public Number
remains **5/9** with four actual preparation refusals for missing
`js.number.from-value` provider; its original test and fixture are preserved.

Astra High approved root's frozen metadata/receipt before application.
Sol6.1 Medium owns only the exact23854-byte-prefix helper append and new Number
policy suite in isolated `codex/3518-number-policy-proof-20261001`, under root's
held `3518:number-policy-proof-20261001` claim. Root owns five initial-view
caller adaptations and the sole heavy validation lane. Independent Sol static
review confirms all878 historical generators, mutants, assertions and pins
preserved, with the174-module/782-edge fixture unchanged. The WKS positive is
explicitly labeled as an authenticated predecessor view. These historical
runtime suites and the new Number proof suite have not run on this tree yet.

Fresh source inventory enumerates1775 modules, exits0 and has no inventory
errors. Status remains `inventory-valid-architecture-incomplete`: whole graph
has4 unknown dynamic imports and12847 forbidden edges, with0 transitive
violations. This is not architecture completion or a zero-forbidden graph.
Astra reviews the four new modules' scoped records and import counting units
from the retained actual report. No budget, allowed edge, gate assertion,
fixture, timeout or legacy path was relaxed. No Number PR or delivery yet.


## 2026-10-01 — Actual Number inventory units and scoped closure correction

Astra High's read-only review of root's actual fresh inventory corrects the
planning addendum: the detector counts22 outgoing reference records for the
four new production modules,9 type-only and13 runtime. The auxiliary static
28 count includes six extra mixed-import type facets and is neither the
detector unit nor individual binding count. The historical174-module fixture
still expects782 reference records,403 type-only and379 runtime; no count or
fixture changed.

The union of the four new modules' dependency closures contains90 clean
modules (4 new and86 existing),309 resolved reference records (208 type-only,
101 runtime). All90 saved module hashes match current source bytes. Filtering
that saved report by these module sources yields zero scoped unknown,
unresolved, forbidden and transitive-violation records. Individual overlapping
closures were not summed. This is scoped current inventory evidence; the
whole graph still has4 unknown and12847 forbidden records and remains
incomplete. No full architecture, historical fixture runtime, public source
Number or whole migration completion is inferred. Root retains the complete
report and Astra's independent readback; no detector or source repair needed.


## 2026-10-01 — Actual historical compatibility run and Number restoration counterexample

Root executed all five preserved historical callers: **878/878**, zero
failures/pending (semantic352, program105, B63, C1 204, WKS154). The new Number
suite's first actual run was **246/247**, zero pending. Its symbol-descriptor
warm restoration test created a non-configurable property and ignored a failed
deletion, so the unchanged proof correctly refused the unrestored object.
Independent static review had missed this test cleanup defect; both that review
and the actual failure are retained. No helper or refusal was weakened.

Sol6.1 Medium repaired only the new test's cleanup: the injected symbol is
configurable, every deletion must succeed, and restored own keys, descriptors
and plain prototype are checked against the detached original before
reacceptance. Exact inverse diff proves all247 controls and their refusal and
zero-callback assertions preserved. Helper SHA remains
`148601474472e3d2021faa66b1735c1ca6f9d17a7a16bc80e32ae737170053a9`;
repaired suite SHA is
`010d81d228228e2581ceaa6a10d52577fc98ee09f0c7a3f61b5308ac9ad51cf5`.
Independent static repair review passed; the actual repaired run is pending.

After the historical run, root freshly read canonical main via `ls-remote`,
fetched exact `a49f245868e1bb37ebdca00421352c134d1db940`, and verified ancestry
and its six benchmark-only paths. No owned or pinned path changed. The isolated
branch fast-forwarded to that exact main head; prior runtime reports retain
base345616 and are not relabeled as fresh post-refresh executions. The repaired
proof run starts on a49f. All18 scope paths and seven owned claims were freshly
verified, with no new PR overlaps or claim transfer. No Number delivery yet.


## 2026-10-01 — Repaired Number proof actual acceptance

The repaired247-control Number policy suite actually passed **247/247**,
zero failures/pending, on exact refreshed main
`a49f245868e1bb37ebdca00421352c134d1db940`. Focused TypeScript7 across all11
checkpoint test entrypoints exited0 with no diagnostics. All28 full input
pins and the exact23854-byte historical helper prefix remain unchanged.
The separate actual runs total **1952 passing checks**:713 Number components,
114 native WKS,878 historical policy controls,247 Number policy controls.
The first three reports retain their original345616 base; only benchmark
files changed during the verified fast-forward. The original246/247 failure,
its static-review miss and exact test-only repair remain preserved.

Repository gates, normal commit/push hooks, ready fork PR and protected-main
delivery are still required. These component/proof results do not turn the
original public Number5/9 into9/9, prove whole mixed execution or retire the
old compiler. Full epic remains active; only verified main merges are delivery.


## 2026-10-01 — Number checkpoint repository gates before normal hooks

Root ran the five unchanged repository checks at exact a49f main base:
LOC and function budgets, coercion-site and oracle ratchets, and the required
legacy-reachability preservation mode all exited0. Budgets measured only the
four new production files, net1340 lines; no allowances or ceilings changed.
Coercion/oracle checks correctly enumerate zero changed codegen files and are
not runtime coverage. Reachability reports preservation-only PASS (6/6 full
and6/6 cut witnesses), graph OPEN, strict modeled closure FAIL and explicitly
**retirement/deletion NOT CERTIFIED**. Its required preservation-mode success
is not architecture completion. Full raw logs are retained. Normal hooks,
signed commit, push, ready PR and protected queue delivery remain pending.


## 2026-10-01 — Normal hook fixed-authority formatting failure, no commit

The actual full normal signed-commit attempt exited1; HEAD remains a49f and
no checkpoint commit exists. Formatting/lint and both budgets passed. Its
changed-root lane genuinely enumerated10 tests, passed all713 Number native
component controls, then stopped with247/247 new policy controls refusing the
receipt digest. Historical878 controls were not reached in that hook run.
Those were separately measured earlier; no full-hook success is inferred.

Normal Prettier changed only the two receipt roots arrays from multiline to
inline, removing32 bytes:12758 bytes/a5bd7bdf... became12726 bytes with SHA
`92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845`.
Complete ordered JSON data is exactly equal. Root's independent programmatic
formatter check reproduces the hook bytes and proves canonical idempotence.
All28 full-file inputs, policy/raw profiles, original23854-byte helper prefix
and complete unchanged helper still match their prior pins. The guard correctly
refuses the changed bytes; it has not learned alternate authority or normalized
receipt whitespace. Original normal-hook failure/log and frozen receipt are
retained. Earlier247/247 acceptance belongs to the original receipt bytes and
is not relabeled as current acceptance.

Astra High is specifying an explicit canonical-format authority amendment.
Root will freeze independently verified canonical bytes before any Sol digest
binding, preserve both predecessor guards and all original controls, and prove
the old noncanonical receipt remains refused. No formatter, hook or gate will
be bypassed. New proof execution and full normal hooks remain required; no
Number PR or protected-main delivery exists yet.


## 2026-10-01 - Astra implementation amendment for canonical Number receipt authority

# Number prerequisite receipt formatting authority amendment — 2026-10-01

Adopt exactly one newly reviewed serialized representation of the same Number receipt payload. The preserved `.tmp/number-integration/root-receipt.json` is **12,758 bytes**, SHA-256 `a5bd7bdf49069d030c29eda4f1b334d97c761b220f2e2887ca3a7cea0d9abfb4`. The actual hook-formatted `tests/helpers/ir-runtime-program-policy-number-prerequisites.json` is **12,726 bytes**, SHA-256 `92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845`. Independently replacing only the two multiline `layerDeltas[0].roots` and `layerDeltas[1].roots` arrays with their inline forms reproduces the entire destination byte for byte; each replacement removes 16 bytes. Full ordered JSON equality holds, including every key, array, profile, pin, and raw policy-span string. Ordered payload SHA-256: `13db4f038759cb2186ce8764543fe0f9d174d58d1136ec4174d170a18082c33d`.

## Failure mechanism and authority decision

`package.json` maps staged `*.json` to `prettier --write`; `.husky/pre-commit:1` invokes lint-staged unconditionally. `.prettierrc` uses printWidth 120 and tabWidth 2; the receipt destination is not excluded by `.prettierignore`. `author-successor.mjs:19` invoked Prettier on a scratch pathname, but the saved original receipt is byte-identical to `root-receipt.unformatted.json`. That scratch result did not establish canonical stability at the committed destination. This static review did not run Prettier or establish why the earlier scratch invocation returned unchanged bytes. Root reports that destination Prettier checking now passes; independently freeze its actual bytes before implementation.

The saved normal hook failure reports **247/247 Number successor rows failing at the fixed receipt digest**. That is expected fail-closed behavior. Authorize an explicit serialization amendment before publication: replace the one fixed Number receipt digest with the reviewed canonical digest. Do not accept both representations, normalize receipt input, derive the accepted hash from the candidate under test, select authority from mutants, skip hooks/formatter, or change ignore/configuration/gates. The previous representation must be refused under the amended authority. Preserve the prior freeze, tests/pass receipts and terminal failure as history; do not overwrite them silently.

## Independently rechecked invariants

All **28 unique full-file pins (20 historical inputs + 8 frozen Number source/tests)** match their actual byte counts and SHA-256. The original helper prefix remains **23,854 bytes / fe575facb2aedc750760ba302ded54ab37ac223ff70e0d07f25faa804de84474**; nested C1 remains **10,742 bytes / 2636bd52d821cbc1a7aaff425a03d1ea56fe29b584db5925d6ef099a893f5f3d**. The WKS/C1 receipts, B helper/receipt, and all other historical pinned inputs are unchanged.

The before policy still equals genuine WKS-current: **565,875 bytes / 451258b5feed7669d08553de966cb654a88f134a1d197fb9768fa97607843e59**, ordered data **462b8a9a6047378eed5913e51441761734663ff8c53cbb804106368ff1a33be7**. Actual `scripts/compiler-boundaries.json` equals the frozen current policy: **567,166 bytes / 8213f6d2d3bf112544ca2aa50b68e585f4ba2c1f9795acc240c9e8495712e7df**, ordered data **5dea4a676b8ddbc6fc50c7c77446e799ee4db12f4113c1fdf4edff33de848b21**. Complete file/layer/history profiles and Git blob hashes match. All four UTF-16 raw spans are unchanged; independently replaying both directions reproduces the exact before/current bytes. Allowed-edge hash remains **efe7e7ed8dee1a009d2bef3ff36dba80df1a805cd3f5b7b472e62ec6dcff64c7**. The companion static-review JSON records each of the 28 checks, both prefix hashes, all profiles and spans.

## Implementation ownership and exact changes

1. **Root owns the receipt/freeze and issue appendix.** Preserve original evidence. Confirm repository Prettier at the actual destination leaves the 12,726-byte candidate unchanged, including a repeat-format stability check when freezing. Create a separately named canonical scratch receipt and amended freeze tied to this plan, this static review, and the original authority freeze. Record the exact two-span formatting change, ordered equality, unchanged policy/source pins and prefixes. If formatting yields any other bytes, stop for exact review rather than auto-selecting another digest. Keep receipt payload/provenance/planSha256 unchanged; record this amendment separately and append this authored plan to the claimed issue without changing existing issue bytes. Existing source claims and actors retain their scope.
2. **Sol 6.1 Medium owns exactly the existing helper and new Number proof suite.** In `tests/helpers/ir-runtime-program-policy-evolution.ts:577`, change only `numberReceiptSha256` from `a5bd7bdf49069d030c29eda4f1b334d97c761b220f2e2887ca3a7cea0d9abfb4` to `92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845`. This binding is inside the appended Number section, after the immutable 23,854-byte prefix. Leave the actual Number→WKS→C1→B proof, all raw/semantic profiles, full-file checks and failure paths unchanged. In `tests/issue-3518-number-prerequisite-policy-evolution.test.ts:165-166`, change the independent positive byte assertion **12758 → 12726** and digest literal to **92c0539b00d3b8ba5bb58951c1612f62fa334627f2b928e6ff1485ae9cd25845**. Do not import or derive that expectation from the helper.
3. **Add a targeted assertion block inside the existing positive pin test beginning at line 162; keep 247 test rows.** Starting from the canonical receipt text, replace exactly once each literal `"roots": ["src/backend/wasmgc"]` and `"roots": ["src/runtime/wasmgc"]` with the original three-line representation: `"roots": [`, newline + eight spaces + quoted path, newline + six spaces + `]`. Assert each exact inline fragment occurs once before replacement. Assert the resulting full text is **12,758 bytes / a5bd7bdf49069d030c29eda4f1b334d97c761b220f2e2887ca3a7cea0d9abfb4**, and `JSON.stringify(JSON.parse(oldText)) === JSON.stringify(JSON.parse(currentText))`. Assert `authenticateNumberPrerequisitePolicyEvolution(oldText)` throws `receipt digest mismatch`, then authenticate the fresh canonical receipt successfully. This derives only the known two-array formatting predecessor; no whole-document formatter/reserialization is used to construct it, and no scratch file becomes a committed test dependency. Existing whitespace/newline and all other mutation controls remain intact. This strengthens rejection while preserving the 247-row denominator.
4. **Root independently reviews final changes.** The helper diff is exactly one digest literal after the frozen prefix. Suite changes are exactly the independent hash/byte literals and the bounded predecessor-rejection assertions in the existing test. The receipt's only change versus original remains the reviewed 32-byte formatting delta. No production source, policy, source pin, original helper prefix, caller, historical receipt/test, budget, detector or gate changes are authorized by this amendment.

## Required validation by root after implementation

Run against the final canonical candidate and capture new evidence. Require **247/247 Number successor rows**, including fresh canonical acceptance and exact old-representation rejection, plus all existing field/span/whitespace/newline/full-pin negative controls. Preserve and exercise semantic and raw Number→WKS→C1→B inverse derivation; snapshots cannot replace it. Run the normal required changed-root/full hook path and retain its real per-suite denominators: **713 Number native**, **878 historical boundary/policy controls**, and the separate **114 WKS native controls** wherever included by the required acceptance run. Do not combine partial runs into fabricated completion; the failed normal hook stopped before the historical controls. Preserve the historical **174-module/782-reference-record (403 type-only/379 runtime)** fixture and authentic native populations. Verify all 28 pins, immutable helper prefixes, policy bytes/profiles and canonical receipt hash after formatting and normal hooks. No skipped formatter, hook or gate is part of the repair.

This review ran only read-only byte/JSON/hash/profile inspection and wrote this plan plus `format-authority-review.json`. It ran no formatter, compiler, TypeScript Program, tests, gates, Git, or network; it provides no new execution or migration-completion credit.


## 2026-10-01 — Canonical Number authority actual proof acceptance

Root applied the separately frozen canonical representation after Astra's
explicit amendment. The helper changed by exactly one appended digest literal;
the new suite changed only its independent positive byte/hash literals and
assertions deriving the exact old representation, proving ordered data equality,
rejecting those old bytes and accepting fresh canonical bytes. Independent Sol
inverse review recovers the complete prior helper and canonical suite preimages;
all247 registrations, mutations, refusals and callback assertions remain intact.
All28 input pins and the immutable23854-byte helper prefix match.

The actual canonical candidate passed **247/247**, zero failures/pending, on
exact a49f main base. Programmatic Prettier at all three actual destination paths
(helper, new suite, receipt) leaves their bytes unchanged. This is new execution
credit for canonical authority, not a relabeling of old receipt results. Both
the symbol-cleanup246/247 failure and full-hook247/247 digest refusals remain
preserved. Full normal hooks and delivery are still pending; no legacy retirement.

### PR5883 failed queue: authenticated dependency-cycle repair

Queue CI36981845038/job110757903671 failed the newly introduced import-cycle
ratchet. Parent reproduced base9c exit0 (697/295) and queuecda exit1 (699/296)
on isolated unchanged trees. Exact graph comparison adds only the two extracted
Promise owners to the SCC and confirms the net+1 codegen->ir edge. The prior
published head had no such gate; its earlier green checks did not cover this.

Parent plan5883-import-cycle-repair-plan-20261002 dispatches Sol-6.1 Medium D
in isolated codex/5883-cycle-main9c-20261002, source-equivalent to failed queue
before repair. Cut real compiler-service imports through explicit per-context
forwarders and physical/leaf owners, preserving runtime order/public signatures.
No baseline increase, hidden loader, legacy removal or queue bypass authorized.
Existing fixtures/92 checkpoint rows, canonical check and normal hooks remain
required. Queued publishede946 remains untouched; local repair is unpublished.

C independently reviewed the four production files and found no demonstrated
emission mismatch. Seven new controls exist, but construction compares the
repaired constructor to itself and cannot detect shared added allocations.
Parent amended the cycle plan with independent baseline requirements and
fail-on-call guards for all forwarded providers; D receives the bounded test
repair after its current read-only review. Production remains frozen. No SCC,
runtime, hook or main-delivery credit is claimed from source review.

Parent unchanged import-cycle checker run7635/child7261 exited0, no monitored
input changes: largest SCC697, five multi-file SCCs, ten two-way directory
pairs,1785files/9935valueedges/3632type-only references skipped. The failed queue
had SCC699. No baseline update was performed. Full membership/directory metric
comparison, strengthened service tests, prior92 rows, canonical and normal hooks
remain required before publication. Raw invocation/log/pins/terminal are in
.tmp/5883-cycle-repaired-20261002. The initial runner attempt failed before
spawning because the worktree lacked .tmp; no gate result was inferred from it.

Checkpoint run48392/child8685 exited0 with unchanged inputs: all11suites99/99,
including prior92 unchanged test identities and seven new service controls.
A independently cleared the strengthened construction control. Canonical run
34492/child9110 then exited1, unchanged inputs, exactly two TS2322 diagnostics:
lazy pendingState getter inference widens literal0 to number. Parent amended
the plan to annotate the two getter returns with typeof PROMISE_STATE_PENDING,
preserving lazy access and the strict service contract. D implements only that
correction. Publication still requires repeated canonical and normal hooks.

Canonical rerun89397 passed; post-annotation18/18 passed, both unchanged inputs.
Formatting applied only the three flagged new/edited files. Normal gate99279
passes LOC but rejects createCodegenContext565>514(+51). Parent plan now splits
only the two new record literals into small private constructors in that same
module, preserving fresh records/lazy forwarding and all graph edges. No budget
allowance/baseline change authorized. D implements; parent revalidates before
publication. Full constructor module state already matched unchanged queue cda
exactly (10types,zero functions), not merely candidate self-comparison.

Private service constructors reduce the function to516 lines, still2 over its
unchanged514 cap (gate54309). Parent rejects metric-gaming or an allowance and
authorizes one cohesive helper extraction: unchanged linked-package/namespace
state construction, preserving map identity and set order. Add explicit identity/
default/order controls. Canonical55698 is already running on the pre-extraction
source; do not edit inputs until it terminates. Publication remains held.
