# Native string/value consumer integration work

## Current checkpoint status

This is an append-only development record; earlier sections describe superseded
drafts. The consumer and physical ABI integration are now implemented on composed
HEAD `428e5b4b2e7645593681a998df42f5d769c53300` plus the owned working diff.
Actual consumer execution passed 68/68; ABI planning passed 61/61; the boundary
suite passed 258/258; materialization/codec/module regressions passed 51/51; final
TS7 exited zero. After the test-only lint repair, the selected encoding rerun
passed 16/16 with 52 skipped. These are local bounded results, not CI or retirement
proof. Detailed terminal handles and failed intermediate attempts remain below.

The revised no-demand comparison passed; publication still requires normal hooks.
The comparison lane is local WasmGC standalone, using the explicit paired runner
against baseline `2ccdcffd9d7939eb4b64e2d0f4910856acd13a9e` and the above candidate
HEAD plus a fully hashed working-source census. It must not be described as a
comparison of two clean commits. Required populations are five source executions,
one exact source refusal, and one canonical-producer IR vector execution.

The public compiler cutover, complete native async consumer, ordinary vector
source admission, cross-backend coverage and strict closure/retirement remain
open. This checkpoint does not complete issue 3518 or the migration goal.

## Function-budget repair after dependency-composition hook failure

Parent's pending demand merge commit invocation 36823 terminated with exit 1.
Parent reports lint and LOC checks passed; the function-budget gate rejected
materializePhysicalProgram at 427 lines against its 300-line limit. No allowance,
baseline or hook configuration was changed.

The sole-writer repair touched only program-consumer.ts and this handoff.
Extracted four private helpers without changing the statements' execution order:
prepareNativeEmission authenticates retained inputs and seals native ABI planning
before module creation or any reservation; reconcileNativeEmission reads the
authenticated producer inventory and actual flattened type signatures, checks
declarations, and updates the same resolver/binding maps and helper-object census;
recordEmissionObservation captures the completed ABI in the existing observation
record after sealing and emitted-body checks. physicalSignatureConverter retains
the existing conversion closure over the exact vector/string type packs.
The no-demand path still plans ABI
at its original post-freeze point.

Only scoped formatting and source inspection ran. The function-budget checker,
compiler, tests and hooks have not been rerun, so this is not a gate-pass claim.
Maxwell's physical-plan files, parent observation API, pending merge/index and
all other staged/unstaged files were preserved. Parent retains composition and
publication; the consumer and handoff are frozen again for that work.

## Consumer implementation ownership transfer — static review

Parent transferred the existing consumer draft to the producer implementer as a
subtask of the same verified consumer claim. The pending dependency merge and
its six staged files remain untouched. No commit, merge, test, compiler or hook
was run during this review. The nine producer originals remain frozen in their
separate worktree; they have not been copied into this checkout.

Read the complete full contract, ABI join specification and declaration
amendment. Added consumer pre-allocation checks for exact retained
program/projection identity, current issued value-plan provenance, and equality
between the physical resource plan and retained reservation input. Added an
explicit accepted reservation-step versus captured inventory order check.
Added three unrun aggregate controls for pre-freeze mutation of a real global
header, function type coordinate and interned function signature, each after a
genuine non-mutating inventory observation.

The ABI planner remains Maxwell-owned and absent from this draft checkout.
Its proposed interface remains the optional fourth reservation input and
PhysicalSetupPlan.nativeStrings { resources, bindings }. Each binding entry
must be the canonical required owner; its reference retains resolver lookup
identity, including aliases. The consumer binds each required owner once, not
aliases independently. Confirm this with the final planner before composition.

No execution or typecheck claim follows from this static review. Producer,
source-admission and ABI-planner dependency composition and the independent
actual-consumer suite remain required. Do not interpret prior producer tests
or guard-only validation as consumer validation.

Worktree: /private/tmp/js2-3518-native-string-value-consumer-20260909.
Branch: codex/3518-native-string-value-consumer-20260909.
Verified upstream claim: 3518:native-string-value-consumer,
ttraenkler/codex-native-string-value-consumer.
Current integration base: ea0f05c36267939d5731e3d5e927ada071ae1780 (#5782).

## Validated guard draft; consumer join remains unimplemented

assertNativeValueResourcePlanFor uses the existing private sources map to check
the exact program, projection and representation, then calls the existing
currentness assertion. It does not replace complete program authentication or
introduce another registry. The dedicated four-case test file covers genuine
original/decoded preparation, a separately issued equal-visible plan, copied
plans, detached projections and representation substitution. Formatting and
diff checks pass. Session 95140 passed 14/14 new and existing boundary tests
in 14.61 seconds; TS7 session 56498 exited 0. Both ran sequentially with 2 GiB
bounds and a single test fork. The heavy slot was released to source validation.

## Required remaining integration

The published full contract is
3518-native-string-value-full-contract-2026-09-09.md. Source, demand collector
and materialization leaves are being implemented in distinct claimed workers.
Consumer acceptance and emission still need the connected production join and
real executable original/decoded source tests. No readiness claim is made for
those unimplemented changes.

Existing structural factories are irSupportGlobalRef, irSourceTypeRef,
irSupportFuncRef and preparedIrRuntimeCallableBindingId. Supplemental entries
must preserve semantic entries and alias structure in one ProgramAbiMap;
support intent alone is slotless and cannot substitute for typed callable,
global or type intent. Final indices remain distinct from stable handles.

One contract question is pending High's decision: acceptance must know resource
declarations before allocation, whereas the current materialization interface
exposes its complete token inventory only after reservation. Do not manufacture
declarations by scratch allocation, helper-name inference or a duplicate recipe.

High resolved this question with the acceptance-time symbolic-declaration
amendment saved alongside this handoff. Producers share pure recipes with their
reservation implementations; no supplemental ABI entries may be added after
reservation. The producer worker owns those recipes and shared selector.

Parent captured the provisional aggregate planner and two tests from that
worker, preserving its originals, with exact SHA-256 matches:

- Planner: 280a421dac57041d9e48b9e8b2e750472f564dad21294564a720ed6aa603bf7e
- Planning test: 80d918cfaab1d31ef02aa95d2d88cad509cc1148acec4e4f684102f55a15d006
- Materialization test: 2918e466d73ef786ec079ee301db266a745c3cfff1f0d079183d338eaddb4c74

These provisional files predate the declaration amendment and are unvalidated.
They still require the demand/selector dependencies and amendment integration.
Earlier guard-only TS7/test evidence does not validate this expanded worktree.

Parent has now integrated published demand checkpoint #5786 (2ccdcffd9d) into
the #5782 base with a pending merge commit. Only appended issue notes conflicted;
both checkpoint sections were preserved. Existing unstaged guard and aggregate
drafts remain separate from that merge. No test/hook process ran for this merge.

The aggregate draft now composes the five producer recipes at planning time and
retains declarations and exact reservation steps. Its privately captured token
inventory is checked for complete key/space coverage and reordered by the
authenticated recipe rather than grouping global/function spaces. Added exact
literal declaration assertions and five pre-allocation declaration mutation
controls. These changes are unvalidated until the producer recipe and source
admission checkpoints are composed. Actual module descriptor reconciliation,
supplemental ABI binding and real consumer execution still remain.

Source admission is published as #5787 (bda70f02b1), based on #5781. The
consumer's private acceptance map now holds a record with the descriptive
physical plan and a slot for exact native reservation input; no issued native
plan is cloned. The native slot is not populated yet, so this structural change
does not claim native execution. Maxwell owns physical-setup/ABI planning in a
separate worktree after High's exact compatibility guidance. Parent retains
program-consumer emission/acceptance and aggregate ownership. Hilbert owns
independent actual-consumer execution tests after its verified slice claim.
Euclid has the sole heavy validation slot for the producer recipes.

The parent consumer draft now collects and plans native demands during
acceptance, retaining the exact issued value plan and a separate copied demand
snapshot. Proposed planner API is the optional fourth NativeStringValueReservationInput
argument and PhysicalSetupPlan.nativeStrings { resources, bindings }; Maxwell
has that contract. Native emission plans/seals supplemental ABI before
allocation, reserves string types before imports, then resources before program
globals/functions, and compares authenticated captured token descriptors with
the accepted declarations. Function observations use the actual flattened
module type table, never the expected recipe signature. Resolver maps retain
structural references; final binding uses physical indices, not handles.

Canonical fills and owner-scoped literal emission are wired, and exact emitted
helper ownership includes the captured native functions. The no-demand path
keeps its original allocation and ABI-planning order. These are implementation
drafts, not verified claims: producer/planner dependencies have not been composed,
TypeScript and execution tests have not run, and the pending dependency merge
has not been committed. Full ABI/consumer negative controls and no-demand
byte/WAT parity remain required before publication.

C/P scoped releases permit native integration only in separate worktrees. The
e042 async files and the twelve paused P draft files remain unchanged. Async
ABI, plans, frame/adapter and helper accounting are excluded and require later
explicit reconciliation. Public routing, all required native families, strict
closure and direct-codegen retirement remain open.

## Composition checkpoint after publication of #5789

Producer declarations are published in non-draft, dependency-held #5789 at
`5404151bfc1b49d6cffed4a87a8985c51bd3dd93`, based on #5782. That isolated
checkpoint passed 322/322 resource tests, 250/250 boundary tests, full TS7,
and normal commit/push hooks. Those results do not validate this consumer.

The parent copied Maxwell's frozen r1 physical planner, its 57 authored tests,
and its handoff into this tree with apply_patch. All three SHA-256 hashes
match the worker's frozen manifest exactly; scoped diff-check passes. The
original worker tree is preserved. These tests are still unrun. Published
source admission and producer declaration prerequisites still need merging;
the existing #5786 merge remains pending and its staged changes are separate.

Euclid explicitly froze the consumer tree before the parent resumed sole
composition ownership. The #5753 coordinator currently owns the serialized
heavy-validation slot; no consumer tests, typecheck, or commit hooks run in
parallel. Hilbert's execution matrix now has 68 authored cases, not an
execution result. Its actual-module assertions await a reviewed read-only
binding-index observation using existing emission state, without a new
ownership registry or exposing reservation capabilities.

## Actual integration validation (2026-09-09)

Published dependencies are now integrated with normal-hook merge commits:
`db417d9f00` (#5786), `e56d89fdd4` (#5787), and
`428e5b4b2e7645593681a998df42f5d769c53300` (#5789). The declaration merge
preserves both parent histories exactly as ordered subsequences and leaves
allowed edges unchanged. Its bounded boundary census is 97 modules and 361
imports (233 type-only, 128 runtime). The exact history and actual-closure
tests each passed independently; 253 other tests were skipped in each selected
run, not counted as passes. Full composed boundary validation remains due.

The first dependency commit attempt, handle 36823, failed the function-budget
gate because the draft materializer was 427 lines. Euclid split four private
helpers without moving ABI sealing after allocation or changing reservation,
fill, seal, and observation order. High approved consumer hash
`a9f3e90fdab7fb2baf5cedf427302fe822523d3cb4f8818e3c33411f025ccd76`.
The repeated normal hook passed the unchanged function budget. Each dependency
commit's changed-root gate explicitly skipped its large root population
(77/78/80 respectively); none of these skips is execution evidence.

Full composed TS7 handle 15820 exited 0 before the revised test matrix was
copied. Maxwell's support-callable owner repair was copied with exact hash
`ba0066c37237d101355a3ef81f0d690e6705aefeccd607e8fea8a0c0fd73fbcf`;
High approved the exact one-line production change and owner controls.

The first combined run, handle 93539, exited 1: 60/61 ABI cases passed and
0/68 execution cases passed. The ABI signature countermodel accidentally
reproduced the first function's existing result signature. Test-only r3 now
appends one parameter and asserts actual inequality before rejection. Its
hash is `03b02bfa3c3c05e23cc29694da3117e302a7f36262490b3b9364c7826b648d4c`.
All 68 execution cases stopped before acceptance because their explicit policy
omitted native string storage. The repaired test only adds that policy field;
hash `75192e5fbacb2e9d7060c2036405b2e5c193755faadb15b5bd1e7124e8083314`.
No production default or validator was relaxed.

After the fixture repair, handle 90568 exited 0: all four required-42 GVN/UTF8
combinations pass actual preparation, acceptance, emission and execution for
original/decoded programs; 64 tests were skipped. The complete 68-case run
was started as handle 69379; its result is pending, not presumed passing.

Handle 69379 is now terminal, exit 0: **68/68 execution tests passed** in
318.50 seconds. This includes the retained 52 original cases and 16 dependency
initialization-order cases, with original/decoded programs and actual binary
instantiation. Source-free resource recipes are no longer the only evidence:
these fixtures use the real accepted prepared-program consumer. This remains
a bounded native-string/number path, not public routing or full IR retirement.

High also approved activating the aggregate as mandatory clean backend-wasmgc
entry nine. The new record preserves all previous 49 activation records and
the allowed-edge policy exactly; the consumer and physical-planner facades
remain unmigrated. The aggregate's clean dependency graph is not ownership
authority: issued-plan identity, real producer tokens, actual descriptor
reconciliation, and completion checks remain required and unchanged.

Full composed boundary handle 53502 exited 0: **258/258 passed**, including
the aggregate's mandatory-entry/deletion/classification/unknown/unresolved
controls and actual complete bounded closure. The final bounded census is
98 modules, 378 imports (241 type-only and 137 runtime), and 50 activation
records. Every old record and allowed edge remains unchanged.

Combined ABI/guard/aggregate handle 66353 exited 1 with 80/87 passed. The
revised ABI suite is fully passing (61/61); the seven failures were older
materializer fixtures stopping in preparation because their policy omitted
native unbox. That test now explicitly selects native unbox and uses the
ledger's final physical index in its zero-import probe, not a stable handle.
The repaired seven cases remain due for rerun. Production sources did not
change. Scoped Biome passes all nine implementation/test files after a test-only
ASCII regex replacement with equivalent character-code membership.

After the full boundary run became terminal, the serialized heavy slot was
released to the existing #5753 coordinator for bounded #5784 CI diagnosis.
Final consumer TS7, repaired producer cases, encoding reruns after the lint
repair, no-demand old/new parity, existing consumer regressions, and normal
publication hooks remain pending. No consumer PR or completion claim yet.

After the diagnosis slot returned, consumer regression handle 87775 exited 0:
**51/51 passed** across repaired materialization, existing codec replay and
module-completion suites. The mixed async application's existing unsupported
host/linear outcomes remain explicit; this is not async runtime completion.
Final combined TS7 handle 31084 exited 0 with no diagnostics, including the
new execution tests and all composed prerequisites.

The no-demand comparison remains unrun while its provenance checks are being
completed: source input census includes untracked files, Git overrides must
not redirect baseline verification, runtime identity includes actual loader
and native executable content, and descriptor encoding must preserve absent
versus own-undefined fields and sparse arrays. These requirements strengthen
the comparison instrument; they do not redefine the unchanged-output bar.

Encoding rerun handle 89819 exited 0 after the test-only lint repair:
16/16 selected required-42, empty, UTF8-byte-overflow and lone-surrogate cases
passed; 52 other cases were skipped, not re-counted as passes.

The first no-demand runner attempt stopped before a child launched because
the baseline worktree had no node_modules link. Adding a link to the same
existing dependency tree as the candidate changed no source or installed
package. The second attempt, handle 95730, exited 1 at the mandatory vector
source: the untouched baseline frontend cannot register vec for the number[]
annotation. Diagnostics and the failed receipt are retained in
`/var/folders/cv/0b_qldpn6ddcw_1md64v39700000gp/T/js2-no-demand-pair-YXmJ85`.
This is not a successful preservation run; the six-case success bar was not
silently weakened. Review is checking the baseline capability and separating
source admission from actual accepted-consumer vector behavior. The vector
front-end gap is also a real remaining migration task, not just a test issue.

High's baseline audit confirms that ordinary array sources lack both a
physical vector resolver and logical-vector facts; removing the annotation
cannot turn the failed fixture into a genuine positive. The comparison
contract is corrected explicitly: retain all six original source inputs as
five execution rows and the specific original vector-source refusal, then
add a separately labelled producer-driven IR vector row from the same vector
source. The latter must use canonical inventory, identity, startup/callable,
checker-vector-fact, AST-lowering, allocation-capture and typed-preparation
producers before unchanged consumer acceptance/emission. No handwritten IR,
resource probe, baseline edit or implicit source-family certification is
allowed. All three populations are mandatory and must be reported separately;
six successful ordinary-source executions are not claimed.

The revised comparison runner passed High's static review at SHA256
`90f4d32ce8c5d1bbb45bef78ade3ce444c72ff596177d6527f1b6b83a9eb22be`.
That exact file is now copied into this consumer checkpoint; `git diff --check`
passes. It has not yet executed. The #5784 inventory repair currently owns the
exclusive heavy validation slot; wait for its explicit terminal/release before
running the paired comparison. The previous failed receipt remains evidence
of the source admission gap, not evidence of consumer preservation.

Prettier formatting subsequently changed the runner hash to
`dead2b853516033efe5ac5c0e6a09b839820c10dd56035be6c02035bf88c9cbb`.
An exact comparison against Prettier's output on the original reviewed file
verified this was formatting only. The paired receipt must pin this new hash.

The revised runner executed as handle 90443 and terminated with exit 1 in the
baseline arm. Actual WebAssembly instantiation rejected function `run`:
`struct.new[1] expected type (ref 1), found local.get of type (ref null 1) @+97`.
Receipts and child diagnostics are retained at
`/var/folders/cv/0b_qldpn6ddcw_1md64v39700000gp/T/js2-no-demand-pair-67tI0E`.
No successful paired comparison or seven-row completion is claimed. The test
worker is investigating the actual canonical vector emission and the reviewer
has the failure; the original fixture and execution requirement remain intact.

The failure is traced to production: `ensureVecDataScratch` in `ir/lower.ts`
declares a defaultable nullable array local. `WasmGcEmitter.emitVecNewFixed`
reloads it immediately before `struct.new`, whose canonical vector data field
is nonnull. High approved adding only `ref.as_non_null` at that reload boundary;
both successful construction branches have just stored a fresh array. Keep the
scratch nullable, the field nonnull and all capacity/error/ABI behavior intact.
Euclid owns the isolated repair and real numeric/externref construction tests,
including populated, empty and spare-capacity cases and removal countermodels.

The required preservation instrument now has three explicit arms: untouched
original baseline (including the actual vector compile failure), original plus
only the reviewed emitter repair, and consumer candidate with the identical
repair. Full artifact/value parity is required between repaired baseline and
candidate only. The source-level vector refusal remains distinct in all arms.
Pin all HEADs, emitter blobs, runner hash and complete source censuses; reject
any extra production difference in the repaired baseline. Hilbert owns this
runner amendment. Neither its implementation nor a passing run is claimed yet.

Parent created the separate repaired baseline at
`/private/tmp/js2-3518-vector-repaired-baseline-20260909`; worktree creation
handle 55090 exited zero. Its detached HEAD is still the original
`2ccdcffd9d7939eb4b64e2d0f4910856acd13a9e`; the only source change is the one
approved emitter instruction, Git blob
`e2affc4733c5a1a67d977f5ffcd021c1c50f0b6f`. This is a pinned working-source
repair, not a claim of a separately committed baseline. Its node_modules link
targets the same existing canonical dependency installation as both other arms.
No compiler/test execution has run in this new checkout yet.

### Three-arm execution completed

Vector repair published as non-draft held PR #5792, commit
`c5c87e4abdd58539e22c89d96c4259c344461d40`, stacked on #5789. The identical
one-instruction fix is applied in this consumer working snapshot.
High approved runner `902f140ff61226eae88ef4bc927dda50636cf90d72ab8f09cc1794f3efa13a92`;
the exact verified Prettier-only transformation executed with hash
`59c563961fcc6475db993415b801820ecbf54543a1c5ad1bb84180dcf84553f7`.
Independent pins: `/private/tmp/js2-3518-three-arm-pins-20260909.json`.

Parent run 76083 terminated with exit 0. The untouched original reproduces the
required vector CompileError; repaired baseline and candidate have full parity
for five source executions, one exact source refusal and one canonical-producer
IR execution. These are seven rows, not seven executions. Original/decoded
versions and fresh-instance values are checked as prescribed. Complete input,
runtime, binary/WAT/module, progress and terminal receipts are retained at
`/var/folders/cv/0b_qldpn6ddcw_1md64v39700000gp/T/js2-no-demand-pair-PRxP1a`.
This proves the bounded repaired-baseline preservation contract, not ordinary
vector source admission, async consumer support or direct-codegen retirement.

## Next complete migration slice: native async consumer

Euclid's read-only census of this checkpoint identifies the canonical five-owner
delay/fetch/sequential/parallel/main family as the next complete consumer slice.
The source admission contract does not currently authorize a smaller delay-only
family. Existing native Promise, queue, settlement, resolution, delay, combinator,
frame-dispatch, await, vector and string producers are prerequisites, not proof
that the consumer executes async functions: physical planning still refuses them.

The missing joins are source-free frame layout and selected-state lowering;
complete authenticated Promise closure/object/accessor/value prerequisites;
and timer, microtask, formatting/concat/stdout driver completion. All supplemental
ABI contracts must be planned before allocation, then reserved through the one
ledger, frozen once and filled with canonical bodies. End-to-end evidence must
cover original/decoded programs, pending timers, 70/3e9 transport, sequential and
reverse Promise.all, rejection, observable main output and undefined completion.
The historical 16-function/33-call census must be recounted after composition.

High has been asked to specify disjoint implementation lanes and the necessary
C/P ownership releases. The census used the preserved C/P handoff, not fresh
inspection of those external frozen worktrees; no new write scope or async
execution evidence is implied by this plan.

## Ordinary vector source ownership reconciliation

The read-only ordinary-vector proposal is preserved in
`3518-ordinary-vector-source-admission-census-2026-09-09.md` (original SHA256
`9de2551f0e3c6566d55ef71f187b60ca62509676d85235a7ce16cf17934ccfc8`).
It is not an implementation or a substitute for the emitter repair above.
Parent freshly inspected the paused P worktree at
`/private/tmp/js2-3527-p-async-resources-20260907`, HEAD
`6037ac8bcf07be4f71839cea33cf8c90ecc87f94`: its dirty source/preparation files
still match the recorded pause hashes
`9855568268481a32acf16390a157630752ba98bb698cf0aa57d6d96e784669df`
and `417bf1d5fcc23cb1ad95f2a70a2a9683dd5d4c96111a93c1509e1b5cc3464059`.
A new explicit release was requested for additive ordinary-vector signature/fact
wiring in those two files in a separate checkout. No release is inferred from
the prior string scope; no paused file was modified or adopted.

P subsequently recorded the explicit ordinary numeric-vector release at the top
of its actual `.tmp/3527-p-handoff.md`. Parent read the record: a different
worktree may add default-off selection/validation and canonical numeric-array
signature/checker-fact wiring in source/preparation, plus new helper/tests.
Async ABI, codec/resource schema, authenticated family contracts and adoption
of paused drafts remain excluded. File-level overlap remains and will require
later reconciliation; this is not a conflict-free merge claim. Both paused
source hashes still match. High has the release for the next implementation
specification; no source writer has been dispatched under it yet.
