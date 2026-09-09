---
id: 3518
title: "IR-only default and direct front-end retirement"
status: in-progress
created: 2026-07-21
updated: 2026-09-09
priority: critical
feasibility: hard
reasoning_effort: max
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
model: gpt-6-astra
related: [1373b, 2855, 2950, 3090, 3142, 3143, 3341, 3517, 3529, 3520, 3521, 3522, 3523, 3525, 3526, 3527, 3528, 3678, 3681, 4382, 4576, 4577]
origin: "2026-07-21 explicit user directive: enable IR-only by default and retire the old direct codegen path"
oracle-ratchet-allow:
  - src/codegen/multi-prepared-array-leaf.ts
loc-budget-allow:
  - src/codegen/index.ts
  - src/codegen/ir-prepared-free-functions.ts
  - src/codegen/multi-prepared-scalar-leaf.ts
  - src/ir/backend/linear-integration.ts
  - src/ir/builder.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/lower.ts
  - src/ir/core/nodes.ts
  - src/ir/runtime/manifest.ts
  - src/ir/prepared-component-dependencies.ts
  - src/ir/select.ts
  - src/ir/verify.ts
func-budget-allow:
  - src/codegen/index.ts::generateModule
  - src/codegen/index.ts::planIrOverlay
  - src/ir/backend/linear-integration.ts::compileLinearIrFunctions
  - src/ir/backend/linear-integration.ts::makeLinearIrResolver
  - src/ir/from-ast.ts::lowerFunctionAstToIr
  - src/ir/integration.ts::compileIrPathFunctions
  - src/ir/integration.ts::makeResolver
  - src/ir/lower.ts::emitInstrTree
  - src/ir/lower.ts::lowerIrFunctionBody
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
is the next bounded plan, not a competing dispatch or completed dependency split.

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

## Historical execution plan — whole-program cutover (2026-09-05)

The user approved replacing continued hybrid feature-by-feature expansion with
a coordinated whole-program cutover, and requested parallel implementation.
This section supersedes future dispatch order in older slice plans. It preserves
all eleven acceptance criteria below and the correctness obligations of work
already in flight. It is an execution change, not a new definition of completion.

The planning baseline is the integration record at `3d2dfce953652e3d8491490cdd786b14943342cd`:
the mixed application executes correctly but all seven terminals remain legacy;
`PreparedIrProgram.reconciliation` still says `pending-production-wiring`.
Focused green suites therefore do not establish a complete new compiler path.
Recheck current main, open implementation PRs, and slice claims before dispatch;
this recorded baseline is not a claim about future public state.

### Transition and central contract

1. Finish the existing initializer, async currentness, and linear acceptance
   repairs; integrate their actual source histories and review combined results.
   Preserve their worktrees, claims, tests, and public updates. Do not interrupt
   a writer or start a competing implementation under this amendment.
2. Stop commissioning additional source-shape admission exceptions, feature
   toggles, and per-component legacy/IR arbitration. Existing safety checks stay
   until their dependency is removed. Repairing a current regression is allowed;
   expanding the hybrid framework is no longer the next milestone.
3. Make the existing prepared program production-authoritative. One preparation
   driver resolves source-qualified units, bodies, shared ABI contracts, module
   bindings and startup order, effects, runtime demands, and async plans before
   either backend emits. Extend and connect existing IR and manifest structures;
   do not build a second candidate ledger or a replacement compiler from scratch.
4. The producer returns a complete verified program, a source-located unsupported
   outcome, or an invariant. A missing fact is explicit. All call, allocation,
   provider, export, and startup references must resolve within the complete
   program. Backend representation and capability checks happen before artifact
   emission; neither backend reconstructs semantic facts from source or live
   checker/codegen caches. Symbolic relocations may be resolved below this boundary.
5. Exercise the new path without per-unit legacy fallback. During development,
   the existing compiler is a separately invoked comparison oracle; keep its
   public behavior until cutover is justified. Do not add a new public escape
   option or make the strict path silently invoke the old compiler. Serialization
   belongs to this same contract, with stable identities and lossless semantic
   data; it must not capture AST objects, callbacks, or mutable context handles.

### Parallel work packages and exclusive responsibility

The main-thread lead owns architecture, scheduling, integration, and independent
review. Retain the already selected implementation models. Each writer uses an
isolated worktree and an explicit slice claim. These are proposed responsibilities,
not claims acquired by this document; existing owners must be reconciled first.

| Package | Deliverable | Proposed exclusive implementation surface | Dependency / handoff |
| --- | --- | --- | --- |
| A — authoritative preparation | One complete program and a strict public-compiler route, including ordinary and multi-source startup/call ownership | R2/R5: `src/ir/program.ts`, `src/ir/prepare.ts`, shared program ABI contracts, `src/ir/integration.ts`, `src/compiler.ts`, `src/codegen/index.ts`, `src/codegen/multi-prepared-program.ts`, `src/codegen/ir-prepared-free-functions.ts` | Publish the minimal typed producer/consumer interface first. A alone integrates changes to shared entry points. Other packages supply typed inputs or consumer APIs. |
| B — semantic/runtime producers | Populate the program with semantic runtime demands and existing immutable async plans; preserve behavior through shared runtime helpers | R6/R7: `src/ir/runtime-manifest.ts`, runtime-provider modules, `src/ir/async-plan.ts`, `src/ir/async-prepare.ts`, `src/ir/async-from-ast.ts`, and dedicated IR async adapters | Reuse current repair results. Begin the reader/mutator inventory alongside A; implement against A's interface, with no private ABI or ownership cache. Request shared-entry-point wiring from A. |
| C — backend consumption and replay | Both backend entry points consume the same verified program; lossless codec and fresh-process replay | R8: `src/ir/backend/linear-integration.ts`, WasmGC/linear emitters and legality, `src/codegen-linear/index.ts`, and the program codec module | Assigned exclusively to the user's external Claude Fable 5.1 session after the interface handoff below. A owns the schema; C owns its codec implementation. C does not edit the shared compiler entry points. |
| D — application evidence | Independent whole-application fixtures, exact unit accounting, oracle comparison, and affected integration checks | R9 evidence under this epic: dedicated whole-program tests/fixtures and their runner; existing coverage scripts only with explicit ownership | Can start immediately alongside A/B on a pinned source snapshot. Owns no compiler source and cannot redefine supported scope, suppress failures, or alter baselines to accept the candidate. |

Existing R1 identity, R3 class/closure, and R4 module-storage owners remain
authoritative for their modules. A consumes their interfaces and routes concrete
missing prerequisites to those owners; this table does not grant access to their
claimed files. B/C likewise enumerate readers and mutators before moving shared
facts. Every dispatch must say the worker is not alone, must preserve others'
changes, and must refer out-of-scope defects to the responsible owner.

Use at most the available three Codex worker slots plus the lead. A + B + D run
in those slots; the user's separately activated Claude session owns C. Do not
start a competing Codex C worker. Rerun D's harness on each meaningfully changed
combined candidate. C consumes A's interface and requests schema changes from A.
Review A's core change independently; authors do not supply their own independent
acceptance. The lead retains integration and publication for all four packages.

### Evidence runner repair — independent review 2026-09-06

B reviewed D's exact signed `a8e5840492aefb450274ac37d1b6a52c390e1cb8`
runner (SHA256
`17ffdd9467df02a1a3291838382538899c633d612ba9b2220a0420d0033f4b04`).
The original seven counterexamples now pass seven of seven, but an expanded
24-control predicate review passes only 20. These bounded controls executed
the unchanged predicate bodies in a fresh VM; they did not compile or replay
an application. D's candidate remains unaccepted for integration.

The lead assigns this bounded implementation plan to D, retaining its existing
runner/test ownership and unchanged fixture population:

1. Validate every observed phase's resolved target as well as backend, source
   and exact program identity. Missing targets and a host-to-standalone target
   substitution must both fail. The four phases must belong to one actual
   preparation and emission of the requested target.
2. Recompute strict accounting from the immutable captured row facts at the
   admission boundary. An issued proof containing a direct-body emission must
   remain rejected after a caller changes only `strictAccounting.pass` to true.
   Preserve exact once preparation/IR counts, zero direct emissions and the
   existing original-unit/receipt joins; no mutable summary flag supplies truth.
3. Require separately pinned compiler provenance and affirmative evidence of
   the executed legacy route for the direct oracle. An explicit checkout,
   `experimentalIR: false`, successful compilation and runtime parity currently
   allow the CLI to pass seven prepared IR rows with zero direct rows. Such a
   run must fail oracle admission. Record actual oracle and candidate revisions
   and compiler source fingerprints separately. Missing route evidence remains
   incomplete rather than being interpreted as zero preparation.
   Consume the existing `CompileResult.irBodyRouteAudit`: `compileMulti` assigns
   its internal route and `trackIrOutcomes` enables the physical recorder even
   with IR disabled. Validate its registered graph/generator and direct-entry
   receipts against the exact fixture identities; no compiler instrumentation
   rewrite is needed merely to expose those existing observations.
4. Add the four failed cases to focused regressions, preserve all earlier
   controls, and rerun B's independent 24-control cohort on the resulting exact
   signed bytes. Run the affected runner tests and typecheck with normal hooks;
   a future combined compiler run still must exercise A/C's real boundary.

D edits no compiler source, fixture denominator, baseline or other package's
files. A retains the next load-clear heavy validation slot. Root owns this
issue amendment and integration; B owns independent review. This repair does
not establish whole-program runtime acceptance or retire any epic criterion.

Independent review of D's signed `b3f08613aff01fadfa4d924b4be7924e1a340c8e`
passes 21 of 24 controls, including only five of the original seven. Three
valid controls (01, 06, 20) fail because the runner compares A's observation
`RuntimeTarget` (`host`) directly with the artifact target (`gc`). Its own test
fixtures changed the observation to `gc`, which does not match A's producer.
D must keep those two domains separate: derive the expected resolved runtime
target through the existing explicit target-policy mapping, compare all four
events to that resolved target, and separately retain exact artifact/backend
checks. Missing, mixed and wrong resolved targets must still fail. Preserve
B's unchanged valid controls, add an actual A-schema positive, and obtain B's
independent replay before integration. B is also reviewing the direct-oracle
physical audit joins; any resulting defects require an explicit follow-up.

B's second positive-controlled review of the same signed runner passes only
four of ten direct-audit controls: it accepts a missing terminal, an anonymous
count-only receipt, explicit structural incompleteness, a foreign entry source,
a wrong entry target and a `terminal-ir` disposition. A separate target-domain
cohort passes two of three: changing a standalone record's target to `gc` still
passes despite its authenticated standalone proof. The accounting-flag repair
does reject its independently tested counterexample.

This acceptance-boundary repair transfers to Astra/B after D releases its
runner edits and B signs the granted import-only patch. B must require the
actual audit's completeness and empty violation set, exact registered graph
and generator, all required terminal receipts with valid legacy disposition,
and source/backend/target joins through both oracle admission and the final
proof-to-record check. Counts alone cannot establish coverage. Preserve the
existing oracle/candidate fingerprint checks and independently rerun all
positive and negative cohorts. D returns to bounded read-only evidence; root
retains independent integration review. No fixture denominator changes or
compiler-hook rewrites are authorized by this handoff.

### First bounded implementation checkpoint

Review the approach after the first implementation cycle, no later than one
working day of implementation after prerequisite consolidation. This is a review
budget, not a promise that the full compiler can be migrated in a day. A publishes
the minimal interface as its first implementation artifact; do not spend that
cycle producing another exhaustive specification without executable integration.

- Promote the existing mixed application's sources from the recorded integration
  probe into a stable test fixture. Pin its source hash and original seven-unit
  census. Require all seven units to be prepared exactly once, zero direct body
  emissions, correct initialization order and values, native Promise identity,
  and the recorded microtask behavior through the public compiler's strict path.
- Add an independently structured mixed application, plus renamed/reordered
  declarations and an explicit missing-fact control, to reject fixture-specific
  admission. Preserve the inputs when reporting a failure; do not simplify away
  a class of work to claim success.
- Serialize a real prepared whole program containing startup and cross-unit
  calls, then replay the exact snapshot through both backends without source or
  checker access. Compare supported output with the same native/direct oracle.
  Record a backend capability gap as incomplete evidence, never as successful
  cross-backend coverage. The async mixed application and common backend subset
  may be separate fixtures; keep both denominators explicit.
- After serialization, missing/contradictory ABI, provider, or identity evidence
  must fail before artifact emission. A positive runtime control must prove that
  the exercised route is real and does not rebuild the frontend.
- Review whole-program coverage gained, direct entry edges removed, duplicate
  ownership mechanisms retired, regressions, and implementation effort. If only
  metadata, additional guards, or local tests changed, the approach has not passed
  this checkpoint. Revise the central integration work instead of spawning more
  admission slices or reducing the acceptance bar.

### Expansion and completion

Once the complete path works, expand by shared semantic mechanisms across the
full declared class, closure, module, async, fast, standalone, WASI, equivalence,
and conformance populations. Reuse existing runtime implementations through
typed IR operations; retain their effects, exceptions, allocation requirements,
and optimization behavior. AST-driven runtime dispatch cannot be hidden inside
an opaque IR operation. New optimizations and separate TypeScript/Acorn frontend
generalization do not precede this cutover; already supported behavior and
optimization-preservation requirements remain in scope.

Validate affected modules and the combined application path before broad checks;
repeat unchanged passing suites only for a new concern or changed candidate.
Full Test262 remains a merge-group CI obligation, not a new local sweep. The final
IR-only policy, complete serialized handoff, both backends, optimization ledger,
direct-handler deletion, and all eleven existing acceptance criteria must still
be proved against landed source. A successful checkpoint does not complete R2,
R5, R6, R7, R8, or this epic.

Dispatch status: this side conversation updated the plans and, at the user's
explicit request, sent the parent thread the amendment and dispatch sequence.
No subagent was started, contacted, or assigned, and no active claim was changed.
The main thread must perform the live ownership/publication check and execute
the waves above.

### Whole-program dispatch ownership — 2026-09-05

The combined prerequisite head `1376d702fd272485d07d564ed87754f11349a388`
passed normal changed-root hooks (129 tests, two existing optional skips across
12 files), typecheck, and all 26 C1 controls. Both IR-only lanes retained their
41-terminal census: 38 IR, three non-executable, zero legacy/unsupported/invariant.
The 13-file fallback gate passed. These bounded gates do not replace the unchanged
seven-terminal application checkpoint or full conformance CI.

The lead verified current main `2257b950eeab2b1f4ef66a8db4ce32efbf525c74`
and preserved the published generic-async, settled-async, and initializer branch
histories in consolidation. The incoming six compiler files include initializer
terminal identity and pass-two closure-registry currentness fixes. Eight older
R2/R6 branch-backed claims have merged PRs whose heads are ancestors of this main;
none has a linked worktree. Their existing implementation can therefore be
extended by the new packages without commissioning their completed slices again.
Their claim records are preserved. The unresolved no-branch
`3521:scoped-prepared-abi-seal` claim remains protected: A must consume existing
session APIs without editing `src/codegen/program-abi-session.ts` or
`tests/issue-3521-scoped-prepared-abi-seal.test.ts`. Live R1/R3/R4 ownership remains
unchanged.

The lead acquired and remotely verified distinct claims
`3518:authoritative-preparation` (A, Astra Max),
`3518:semantic-runtime-producers` (B, Astra Max), and
`3518:application-evidence` (D, Luna Max), and dispatched all three writers in
isolated worktrees from signed consolidated head
`af5eef9e24a8fb5b575cb57ce9eee0e8ebe425e8`. Their branches are
`codex/3518-whole-program-a-20260905`,
`codex/3518-whole-program-b-20260905`, and
`codex/3518-whole-program-d-20260905`. This head passed normal hooks: 170 tests,
two existing optional skips across 16 files, plus formatting, lint, budget and
oracle checks. Post-merge typecheck and the unchanged mixed application's
runtime/native-Promise/microtask controls passed; its ownership remains seven
Unsupported terminals, zero IR bodies and six direct body emissions.

A published the signed typed interface at
`8e89954c406fed59033b2c54a03d54481fc9773a`, directly after consolidation, and the
shared population validator at `899bd71cf8e709e4552bbb81a95e40be522d0b18`.
The lead verified both signatures. A owns shared compiler entry points; B
supplies existing runtime/async producers; D commits independent executable
evidence without changing compiler source. Dispatch and compatibility evidence
do not complete implementation or pass the whole-program checkpoint.

B's signed implementation `4d4c22ef222b8b55ab3e44901458940109f2525c`, directly
after `1b9ced2d`, is now independently reviewed and fast-forwarded into the
integration branch. It adds complete-population runtime/async producers and
the pure replay manifest entry, preserving the exact runtime authentication
joins. The final committed producer suite passed 25/25; the preceding unique
focused cohort passed 118/118 across eight files, and standalone typecheck
passed. Normal commit hooks passed formatting, budgets and oracle checks;
their changed-root runner automatically skipped at 23 files above its 20-file
threshold. No hook bypass was used. The root audit dependency passed 25/25
combined tests and standalone typecheck after this integration. None of this
closes the full application/replay checkpoint.

### External package C handoff — 2026-09-06

The user supplied a concrete proposal from the active Claude Fable 5.1 session.
The lead approved exclusive transfer of `3518:backend-consumption-replay` to
`ttraenkler/claude-fable-ir-backend-c-20260906`, using branch
`claude/3518-whole-program-c-20260906` and isolated worktree
`.claude/worktrees/claude-3518-whole-program-c-20260906`. The exact approved base
is `8e89954c406fed59033b2c54a03d54481fc9773a`; the following population-validator
commit is an available dependency. No competing Codex C dispatch is authorized.
The refreshed handoff names current signed integration base
`7b2e8b038a06e77c69d788690cbd5ce935ac5448`, which contains that interface,
the population validator, canonical pure identity leaf, B's signed runtime
producers, the whole-program route audit and A's complete preparation driver.
Root verified A's signature and 24-file scope, then fast-forwarded integration
while preserving this issue amendment. A's 15/15 focused controls, full source
typecheck and corrected original-seven preparation probe passed; emission and
replay remain unproved.
A's following signed diagnostic fix is also integrated: required `sourceFile`
is copied from the resolved owner into source and runtime preparation failures.
Its five focused controls and full typecheck passed. C must retain that field
alongside unit identity and source location in its own located failures.
Claude reported C unassigned and no edits/tests at proposal time. The lead then
verified its exact owner/branch claim on remote assignment tip
`33ed83eb238047ee076c67a4a17611d9875008ff` (claimed at 22:10:50 UTC), and its
registered isolated worktree at the approved base. Existing A/B/D, R8 and scoped
ABI-seal claims remain intact.

The lead grants the R8 handoff for `src/ir/backend/linear-integration.ts`, retaining
the integrated repair `272afba2d5de1af082768f45e5cb7b39f61a55e4` and existing
claim records. C may add `src/ir/program-codec.ts`,
`src/ir/backend/program-consumer.ts`, `scripts/ir-whole-program-replay.mjs`,
`tests/issue-3518-program-codec-replay.test.ts`, and
`tests/issue-3518-backend-program-consumer.test.ts`; it may edit the named linear
integration module, WasmGC/linear emitter and legality modules, and the linear
entry in `src/codegen-linear/index.ts`. C updates the R8 issue file for progress
and justified budgets. A retains schema and WasmGC shared entry-point wiring;
B's producers, D's fixtures/census, scoped ABI sealing, R1/R3/R4 interfaces, and
`src/ir/lower.ts` are consumed without C edits.

A's strict producer entry is `prepareWholeIrProgram(sourceInput)`. Its proposed
C interface separates `acceptPreparedIrProgram(program, options)` from
`emitAcceptedIrProgram(accepted)`. Acceptance validates the complete population,
IR, ABI, startup, runtime and backend capabilities before allocation; actual
emitted unit IDs reconcile against the same program's body vector. A alone
wires shared compiler entry points and internal preparation/acceptance/emission
observations. C must preserve all codec values and identities, reconstruct async
authentication through B's canonical APIs, and reject conflicting decoded
evidence rather than silently replacing it. Fresh-process replay must prove
the absence of TypeScript, source lowering and compiler imports. Capability
gaps remain incomplete coverage with separate fixture/backend denominators.

Concrete codec data review, grounded in the existing schema and A's unsigned
preparation batch, gives C the following implementation requirements. These
are representation obligations for the existing program, not new semantic
authority or permission to edit A's schema:

- `IrModule` contains the function vector and optional declaration Maps;
  `PreparedIrProgram.units` and each runtime projection's provider table are
  also Maps. Preserve collection iteration order: full projection comparison
  compares entry vectors in order. Prepared Maps/Sets are immutable wrappers;
  encode their public entries, not private object fields or methods.
- IR `i64` constants contain BigInt values. Retain them exactly, as well as
  negative zero, non-finite numbers, and present `undefined` versus absent
  fields. Allocation metadata explicitly distinguishes an omitted row from a
  row whose value is `undefined`; JSON omission is lossy.
- Recursive `IrClassShape` graphs carry the exact symbol-keyed
  `[IR_CLASS_SHAPE_CELL]: true` brand exported by `nodes.ts`. It is a local
  unique symbol, not a global `Symbol.for` name. Encode the known schema brand
  explicitly and restore it using that canonical export; stringifying the
  symbol description is insufficient. Preserve recursive class references and
  full layouts. Other executable or arbitrary cyclic objects remain invalid.
- `IrModuleInitPlan` and `ProgramAbiPlanEntry` contain plain data records and
  vectors. `IrTerminalUnitRecord` additionally permits `directFailure.cause`
  of type `unknown`; that field cannot be assumed serializable. Accepted
  snapshots must reject retained errors, source objects and executable causes.
- Decode the ABI entry vector and reconstruct its lookup methods. Preserve
  semantic async plans as data, then compare complete regenerated runtime
  evidence before retaining B's newly authenticated plan/manifest joins.
  Process-local observation IDs and acceptance-token authority are not part
  of the serialized semantic program.

#### C first increment and integration repairs — 2026-09-06

C supplied signed `5dd03b8e237a162162fb46490aef6605760762df`, parent8e89954c,
with seven changed files and a clean worktree. Root verified the signature.
The reported nine tests use a synthetic typed program, not A's driver or D's
seven-unit fixture. Three pre-emission negatives pass; five TypeScript-related
modules still load. Neither result satisfies the complete replay acceptance.
C remains the exclusive owner of its codec/consumer/replay source and tests.

Root's codec-only probes against exact signed bytes reproduced a positive
canonical round trip, then three defects: leading-whitespace and duplicate-key
envelopes are accepted but re-encode differently; an own `__proto__` property
on an accepted plain-data record disappears. D's separate codec-only controls
confirm that A's copier preserves integer-like record keys and sparse holes,
but C cannot decode its own encoding of keys `2` and `10`, and converts an
array hole into a present `null` while still re-encoding byte-identically.
The dense-record positive passes. These are synthetic data-model probes, not
A-driver acceptance or application execution. C must preserve valid data and
reject noncanonical or unsupported input without silent loss. Its next batch
also adopts A's complete-program lookup/validator, authenticated runtime
reconstruction and `acceptPreparedIrProgram`/`emitAcceptedIrProgram` contract.
The no-TypeScript boundary remains required; loaded libraries are not exempt.

The lead owns two concrete integration-gate repairs, separate from C:

1. In `scripts/audit-legacy-reachability.mjs`, derive the filesystem root with
   `fileURLToPath(import.meta.url)` instead of URL `pathname`. The existing
   expression points at nonexistent `Archiv%20Mini`; the decoded path exists.
   Preserve the complete audited population and every verdict/baseline rule.
2. Remove only the unused private `directCallTargets` helper from
   `src/codegen/program-abi-module-init-planning.ts`. Keep the stricter live
   `exactSequentialCallTargets` and all initializer/session behavior unchanged.
   Both reported files have identical blobs at C's parent and integrated1dea,
   establishing that these defects predate C. The saved open-PR census has no
   audit-script overlap. A one-shot ownership read confirms PR5632,
   "feat(codegen): atomically prepare multi-source module initializers", merged
   as `bdea6e9807ce30242c569fd31420def6f014872e`; root inspected its exact module
   initializer patch. Existing claims and other worktrees remain intact.
3. Execute the actual dead-export check from the path containing spaces,
   inspect its nonempty population and any remaining failing rows, then run
   the affected initializer controls and ordinary formatting/type checks.
   Do not suppress the audit, weaken a baseline, or equate gate repair with
   direct-handler retirement.

The actual repaired dead-export gate passed from the path containing spaces:
815 codegen files, 7190 functions, 25 known unreferenced entries and zero new
failures. The report contains both real dispatch cut roots and the retained
sequential helper; the obsolete helper is absent. No baseline changed.
Full typecheck passes. The affected initializer suite passes five of six;
its same-named-user-function control expects `legacyBodyEmitted: true`, but
the compiler reports false. The exact failing control reproduces on unchanged
signed7b with the original planner bytes restored; the owned deletion was
restored byte-identically afterward. This is a separately tracked existing
expectation mismatch, not a six-of-six pass. Review that test against the
actual initializer dispatch before changing its expectation. The five passing
controls cover retained direct fallback, graph ownership, invocation policies
and strict startup authentication. Normal signing of the three-file repair
follows; no test assertion or baseline is weakened here.

#### Separate common-backend source fixture — implementation plan

D owns this new source fixture:
`tests/fixtures/ir-whole-program/common-backend-scalar/manifest.json`.
Its acyclic state/math/entry sources retain synchronous `initial`, `readPhase`
and `run` exports under the existing native execution protocol, with an
explicit `promise: false` result. The state initializer updates exported base;
the math initializer must read that initialized base when computing bias, so
wrong startup order changes observable results. `combine(seed)` evaluates
`Math.sqrt(seed + base) + bias`; `run` changes phase and calls it across files.
The three-source/seven-terminal shape is an expectation to measure, not an
invented census. Source bytes, exact unit IDs, native values and all six phase
observations must be derived from actual parsing/execution and recorded with
their hashes. Preserve all original mixed/renamed fixture bytes and coverage.

After B releases its current validation/signing slot, D may execute native
derivation, exact inventory and A's preparation on both wasmgc/host and
linear/host policies, inspecting the nonconstant sqrt demand and both runtime
projections from one semantic program. The proposal alone proves no backend
capability. Defer public candidate compilation and decoded backend replay to
the actual combined A/C implementation; no old hybrid pass supplies that
acceptance. D edits neither B's runner/test nor C's codec/consumer. Add no
fixture allowlist and do not replace the mixed-fixture denominator. Sign only
the complete measured manifest with normal hooks; keep derivation artifacts
worktree-local. Root integrates the fixture alongside the reviewed runner.

#### Exact fixture census and runner ownership — implementation plan

B owns only `scripts/ir-whole-program-application-evidence.mjs` and
`tests/ir/whole-program-application-evidence.test.ts` under the granular claim
`3518:evidence-runner-acceptance`, owner
`ttraenkler/astra-evidence-acceptance-b-20260906`, branch
`codex/3518-evidence-acceptance-b-20260906`. D released those two files at
`b3f08613aff01fadfa4d924b4be7924e1a340c8e`; broad A/B/C/D and scoped claims
remain held. The claim CLI verified the new claim on the assignment ref.

D also owns metadata-only additions to the existing `original-async-mixed`,
`renamed-reordered` and `independent-mixed` manifests. For all four manifests,
derive `inventory.sourceRecords` as `{ sourceId, sourceKey, kind, order }`
from the actual inventory's source records, and `inventory.terminalRecords`
as `{ unitId, sourceId, sourceKey, kind, observedKind, displayName }` from its
terminal records joined to that source map. `kind` is the actual `IrUnitKind`
(for example `top-level-function`); `observedKind` is the telemetry domain
(for example `function`). Do not parse opaque identifiers or zip independently
ordered vectors. Normalize the manifest's relative filenames explicitly when
joining canonical source keys. Preserve the existing three fixtures' source
bytes, digests, IDs, ordering, native values and coverage denominators.

The runner must bind each terminal to its expected source and actual kind,
validate the matching direct entry point, require an exact unique candidate
source census and candidate mode, and retain the actual raw direct-route audit.
Its schema-complete controls must reject reassigned terminals, wrong entry
points, extra or duplicate sources and mode retagging. Repeated legitimate
initializer passes remain valid. Preserve archived original control results;
expanded public-schema controls are a new cohort, not an unchanged rerun.
Do not manufacture per-source receipts when the measured direct compiler lacks
them. A reviewed terminal ordering: independently constructed, frozen and fully
validated terminal vectors may permute exact records, because population,
receipts and ABI authority join by ID. Source order and startup order remain
semantic. Captured manifest and evidence-row mutations must remain rejected.

The approved dependency-order source fails preparation on A's clean signed
`49f95b3fe92c710fc4877f50d080296671d87eab`: the math initializer calls
undeclared callable `runtime|20:__new_ReferenceError`. D retained the actual
failure report and stable source provenance. A separately measured scale-call
variant passes preparation but does not establish the planned imported-global
initializer behavior; its signed `d7e649091ba36e21b940eb8576feabb0c258c214`
is not accepted as that control. Preserve both measurements. A investigates
the missing runtime ABI declaration; D must retain the approved source/native
census and label preparation failure without substituting coverage.

#### Second consumer increment and measured oracle limits — 2026-09-06

C supplied signed `3b2179d2f7e6f617c4484254e61a6a4f1fe3e8ae`; root verified
the signature and read its actual 19/19 test log. Its A-produced two-source
scalar subset executes through the codec on both backends. The original mixed
source retains seven terminals and passes WasmGC acceptance, while linear is
typed unsupported. Mixed emission remains a physical-plan gap, and the fresh
child uses the synthetic four-function fixture. These are separate populations.

A's contract review rejects the additional caller-supplied physical-plan
argument as the production boundary: its mutable resolver, factories and
assembler remain outside acceptance, and the assembler can omit bodies while
the consumer still reports all lowered IDs. C must build and validate concrete
source-free physical setup internally, expose one-argument authenticated
emission, and derive receipts from actual module construction. C owns the
accepted/emission-started/emitted observations; A owns prepared and its held
public wrapper. The scalar test adapter does not replace startup, global,
provider or async emission. Root also reviews nonempty oracle target/call
floors, exact receipt identities and deterministic forbidden-module evidence.
The saved C signing log skipped slow hooks via `SKIP_SLOW_PRECOMMIT=1`;
normal configured hook completion remains required for the no-bypass handoff.

Root's independent exact-C controls confirm all five original codec fixes and
the canonical positive. The full replay child runs four units and four values
on each backend, with 152 module resolutions and no TypeScript/frontend match.
Empty targets, empty oracle calls and duplicate targets all incorrectly return
exit0/ok:true. A separate actual consumer control lowers four bodies and reports
four emitted IDs while its supplied assembler returns zero module functions and
exports. These are reproduced defects, not merely source-review predictions.

Root combined signed A `fcd2e9109789681f33e2f26d8a3312fb219f40c8` and B
`45a6c72add4605df078fb2a90cd1f600617f56c2`. Full combined typecheck passes.
The physical-leaf probe performs real function/tag import registration and
frozen-tag reuse, with two imports, one function and one function type; its
deliberate frontend import is rejected. This establishes the bounded physical
import boundary, not full runtime materialization or mixed-application replay.

B executed the original direct oracle on clean signed45a6, using the distinct
b3 runner worktree with stable before/after source fingerprints. The actual
25182-byte module matches native initial212/result224 and the two-tick Promise
sequence. Its raw audit has 13 entry records and 10 physical records, but only
six of seven terminals have evidence. The sole structural violation is
`missing-terminal-evidence` for the b.ts module initializer: it has a
declaration pass and no body receipt. CLI exit1 correctly rejects this audit,
independently of temporarily missing fixture metadata. B's focused control
must pin this failure through the exact terminal-record join while retaining
all runtime/provenance assertions; do not invent or ignore the missing receipt.

B additionally owns one data-only captured regression fixture,
`tests/ir/fixtures/captured-original-direct-audit.json`, containing the entire
measured raw audit, source digest and before/after compiler provenance. The
always-run predicate control must label this captured evidence and verify the
exact six-of-seven refusal; it makes no fresh-compile claim. Remove machine
paths and fixed ephemeral revision assertions from test code. The explicit
`JS2WASM_WHOLE_PROGRAM_DIRECT_ORACLE` setting supplies actual oracle execution;
absent or identical checkout configuration must be visibly refused. A configured
run checks stable distinct provenance, native behavior and its actual returned
audit independently, and requires the CLI status to match that audit's verdict.
Retain separate native execution and report captured/configured coverage apart.

The imported-global initializer's ReferenceError constructor requires a
canonical runtime declaration/provider from B, consumed into A's ABI vector
before sealing and physically reserved by C before emission. The existing
allocation-time integration helper supplies no semantic authority. A and B
confirmed that no catalog entry currently exists. Preserve the TDZ guard;
linear's rejection of its null/externref/throw instructions is separate coverage.
An exact-binding proof of prior initialization within ordered startup would
need its own plan and early/cyclic/deferred-read negative controls. No such
optimization or source-arm change is authorized by this runtime declaration.

B also has a narrow grant for the await-expression arm/import wiring in
`src/ir/from-ast.ts`. Read-only ownership review verified the earlier R1 W1-G
and R3 W1-C implementations landed at merge commits `ae5d2d25` and `6b9c5a1f`,
with no linked worktrees or overlapping open PR at review time. This grant
preserves the canonical identity/class APIs and all unrelated from-AST arms.
B's existing runtime-provider scope includes declaring the existing caught-
exception host capability and its async reject-provider dependency, so numeric
await frames cannot allocate that import after manifest acceptance.

For the replay import boundary, A has a mechanical R1 dependency grant: move
only `createDerivedIrUnitId`, `createIrBindingId`, and their canonical encoding
helpers to `src/ir/identity-values.ts`, keep the existing `identity.ts` API via
re-exports, and change only runtime-factory imports in `program-abi.ts`,
`callable-bindings.ts`, and `abi-bindings.ts`. Existing namespaces, validation,
and all unrelated R1 behavior remain unchanged. The eight-open-PR file census
contains no overlap on these four existing modules; the known C30–C33 PRs are
recorded merged by GitHub, and their claimed branches have no linked worktrees.
Local July ancestry is unproven because this checkout has shallow history.
No old claim is released. B owns the new pure `runtime-program-manifest.ts`
leaf, re-exported by its producer module. Both leaves must demonstrate a fresh
runtime import graph free of frontend dependencies.

A also owns the mechanical extraction of four existing runtime symbol constants
(`IR_STRING_COMPARE_FN`, `JSSTR_CHARCODEAT_FN`, `NATIVE_CHARCODEAT_FN`, and
`FUNCTION_PROTOTYPE_CALL_HELPER`) and the unchanged IR demand scans into pure
leaves. Their existing modules retain public re-exports. B retains the await arm;
the two writers coordinate only the shared import hunk. No runtime-helper logic
or additional source-shape admission belongs to this extraction.

Independent review of the first implementation drafts found obligations that
remain open before acceptance:

- A's semantic type keys must handle the recursive class shapes permitted by
  the shared schema, and conflicting layouts must still fail validation.
- Every runtime function must match all semantic fields of its authoritative
  program body, apart from its authenticated runtime attachment. Comparing only
  blocks, parameters and async-plan identity would miss substituted result types
  or export flags. Allocation provenance must also remain validated after replay.
- B's review of A's new in-place runtime freezer found that prototype-erased
  native Map/Set objects can look like null-prototype data records while their
  contents remain mutable after Object.freeze. A owns the native-brand check
  and negative controls; accepted runtime graphs must retain authenticated
  object joins without admitting those mutable collection objects.
- The original seven-unit source now passes A's complete preparation draft on
  signed B4d: fourteen typed bodies include seven declared async-derived helpers,
  with three ordered initializers, six globals and preserved public exports.
  This is preparation evidence only. Root's subsequent cross-backend review
  found that promoting runtime functions minus asyncRuntime into the semantic
  body vector retains intrinsic provider attachments from the first policy.
  Requiring object identity for every projected block/plan then prevents
  independently reconstructed backend projections. A/B own exact semantic-field
  reconciliation plus separately authenticated attachments and a two-projection
  common-subset control. Entire blocks/plans must not be exempted from validation.
  Projection selection must also be unambiguous for backend/target pairs.
- D's strict verdict must require actual shared-program observations, exact
  phase order and unit-ID joins, and unchanged compiler fingerprints. Pending
  observations or nonempty telemetry strings cannot establish acceptance. Load
  scheduling belongs outside correctness tests, and the historical legacy
  baseline must not become an assertion that prevents the intended cutover.
  B's executable review of the next draft additionally reproduced copied proof
  metadata, swapped unit IDs, wrong backend/target labels, and phase objects with
  custom toJSON passing the gate; canonical source keys also failed its positive
  control because of display-only './' prefixes. D owns the exact live-event,
  field-type and identity-to-label joins plus canonical display normalization.

The lead owns the narrow route-audit dependency in
`src/ir/standalone-route-manifest.ts`, `src/codegen/legacy-body-audit.ts`, and
`tests/issue-3518-whole-program-route-audit.test.ts`, plus the related existing
`tests/standalone-cutover-audit.test.ts`. The new generator must
register its real `generateWholeProgramModule` identity. An internal immutable
session selection binds that generator to the canonical single/multi graph
for each public entry; existing legacy sessions retain their exact generator
checks. This adds no public compiler option and changes no terminal, derived
unit, or physical legacy-entry reconciliation. A consumes the new session API
without editing these files. Focused controls must reject missing registration,
wrong graph/generator, and missing terminal evidence, and must retain actual
legacy roots even when the new generator is registered.

The existing standalone JSONL validator also hardcodes the old generator
tuples. Its new-route support remains a separate acceptance dependency: it
must stay fail-closed until the executed path has observable physical coverage.
A must not publish a fresh, unused audit session's empty legacy-entry vector as
proof of direct-dispatch absence. The complete-program observations, actual
emitted receipts and C's source-free replay controls remain required.

The existing injected-inline-failure audit control expected two unresolved
terminals. Both the candidate and exact unchanged `1b9ced2d` source reproduce
three: the source functions `delay` and `fetchUser`, plus the inventoried
compiler timer shim `setTimeout`. The lead's test repair pins these exact three
failed owners and their missing-evidence joins, retaining the incomplete
verdict. The baseline probe restored both candidate audit files byte-for-byte;
this is an expectation correction, not a new source admission or a relaxed gate.

### Prerequisite consolidation record — 2026-09-05

The main thread has adopted this amendment into the isolated integration
checkout. P2A ready PR5632, `feat(codegen): atomically prepare multi-source
module initializers`, is verified OPEN at exact head
`f9d524da9464ba1c27e8cddc46897c8422c24922`, with the reviewed body. Its claim
remains held until actual landing. This is a publication fact, not completion
of R5 or this epic.

The reviewed R8 repair `272afba2d5de1af082768f45e5cb7b39f61a55e4` is integrated
by signed merge `0c34f27a408187631153724c3d50e2a5142c247e`. Normal integration
hooks passed 59 tests with two existing optional skips across seven files;
formatting, lint, budgets, and oracle gates passed. Root verified the SSH
signature and exact parent history. Allocation-policy callbacks remain confined
to final retained allocations; the before/after control is `[0,1,0]` to `[0]`.

The async repair `d073f433edfffc8be623d37a2333f3d763af09cc` was independently
replayed at its exact clean signed head: generic and settled positive controls,
missing/rebound declaration identity, terminal loss, and rejected cached-owner
mutation all retained the required result. The integration test conflict is
resolved by retaining both B2's generic-tail/final-void ownership controls and
P2A's exact-byte exnref child validator with corrupt-byte rejection. No test is
removed to reconcile the histories. The unchanged three-source async application
(source SHA256 `236fa7d971bf9b86aafa778a9a441b2440bae2e2c2c0ae7fdab3f6e517c517fb`)
compiles to 25,182 bytes and matches initial212/result224, native Promise identity,
and the original microtask trace on the combined source. It still reports seven
Unsupported terminals, zero IR bodies and six direct body emissions (the b.ts
initializer row reports zero). This is compatibility evidence only; it does not
pass the seven-unit whole-program checkpoint. Remaining combined candidate gates
must pass before wave dispatch.

The read-only B producer inventory identifies reusable async and manifest
producers, their readers and mutators, and the six required A interface inputs.
It confirms that post-hoc `evaluateIrOutcomePolicy` is not a strict compiler
route, and the current candidate builder excludes initializer units. The
implementation must fix those central boundaries rather than report the
candidate ledger as production ownership. New A/B/D claims and worktrees still
require the current main/open-PR/claim census; existing R1/R3/R4 owners retain
their authority. Public B2/B3/P2A ancestry must remain intact on consolidation.

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

## Standalone-lane Implementation Notes (fable, 2026-08-15)

**Deliverable 1 — the lane landed.** `scripts/check-ir-only.ts` now observes
two lanes. A generic `observeLane` helper backs both `observeSingleHostLane`
(unchanged behaviour, unchanged name, still exported for the #3519 tests) and
the new `observeStandaloneLane`, which compiles the SAME five entries with
`target: "standalone"`.

The lane carries a new `readiness: "ir-only" | "baseline"` field (absent ⇒
`"ir-only"`, so every existing caller is untouched). Under `--policy=ir-only`
a `"baseline"` lane withholds **exactly three** assertions — zero unsupported,
zero legacy bodies, IR-body count equals terminal count. Everything else stays
live for it: anti-vacuity (empty corpus / zero terminal units / zero emitted /
duplicate keys / missing telemetry), the compile-result failures, the
telemetry-consistency cross-checks against `irCompiledFuncs` /
`irFirstSkipped` / `irPostClaimErrors`, the hard `invariants > 0` rule, and
every baseline floor/ceiling. That is what keeps an honestly-red lane from
becoming a blind spot (rule 5) rather than a lane that is merely "not checked".

**Deliverable 2 — the diagnosis. It is NOT #4186.**

The collapse is a **pre-claim selector rejection**, not the patch-time typeIdx
parity demotion that #4186 owns. Every rejected `algorithms.ts` unit reports
`stage: "select"`; there are **zero post-claim demotions** in the standalone
lane (the `check:ir-fallbacks` post-claim bucket is empty, and the A/B below
adds seven IR bodies with all seven landing at `stage: "patch"`). #4186's
mechanism — lattice-typed implicit-any **object** params vs. legacy
`lowerParamType` refusing `__anon_*` — cannot be it: `algorithms.ts` has no
implicit-any object parameter at all; every parameter is explicitly annotated.
Recording this explicitly because it is useful negative evidence for that lane.

The single gate is the **caller-direction call-graph closure**, mode-keyed on
host-ness in two mirrored places:

- `src/ir/select.ts:950` — `const demoteOnLegacyCaller = options?.jsHostExterns !== true;`
- `src/ir/select-identity.ts:971` — the same line on the production identity path.

`jsHostExterns` is `irTargetProfile.allowHostImports`, so it is **false for
standalone/WASI**. With it on, the Step-2 fixpoint deletes any claimed function
that has an *unclaimed local caller*, not merely an unclaimed callee. In
`algorithms.ts` the single unclaimed root is `main` — rejected
`body-shape-rejected` because it drives `console.log` and string concat — and
`main` calls **every other function in the file**. One root rejection therefore
propagates to the whole file through the *caller* direction, which is precisely
why a file that is 100% IR-owned on host emits zero IR bodies standalone. The
same mechanism explains `calendar.ts` and `builtins.ts`; it is a whole-file
amplifier, not a per-shape gap.

The in-tree comment above that line (added by #2858) already predicted this and
named `joinNums` in `algorithms.ts` under WASI as the motivating example. Its
stated precondition for relaxing the demotion was that the offending callee
bodies be "rejected up front by the body-shape work (#2856/#2857)" — which has
since happened: `joinNums` is now cleanly rejected pre-claim with
`primitive-method-unsupported`, and `fibMemo` with `body-shape-rejected`.

**A/B sizing (probe, not a shipped change):** forcing
`demoteOnLegacyCaller = false` in both files raises the standalone lane from
**10 → 17** IR bodies (`algorithms.ts` 0 → 3) with 0 invariants, 0 post-claim
demotions and `success: true` everywhere. That measures the blocker's full
size. It was **not** shipped: the blanket flag also exempts families whose
signature genuinely can diverge, which is the hazard the closure exists for.

**Deliverable 3 — the fix shipped: prove the ABI instead of disabling the
guard.** The closure already has a sanctioned escape hatch,
`SelectionOptions.legacyCallerAbiIsProjected`, whose contract is "the direct
callable and the IR overlay share one fully certified ABI, making a legacy
caller's pre-emitted call safe". The pre-existing certifications only covered
implicit/projected parameters plus one narrow reduce-fusion family. The new
`src/codegen/ir-legacy-caller-abi.ts` adds `hasFullyAnnotatedScalarAbi`: a
declaration qualifies when **every** parameter and the return type carry an
explicit annotation from the fully-annotated scalar surface — `number`,
`boolean`, one-level `number[]`/`boolean[]` params, and `number`/`boolean`/
`void` returns.

Why that is a proof and not optimism: the guard's stated hazard is *signature
divergence* (IR replacing a legacy-allocated `typeIdx` after legacy already
compiled the caller's body). For these annotations both front-ends read the
same `ts.TypeNode` through the same mode-consistent mapping —
`resolvePositionType` gives `number → f64`, `boolean → i32`, `void → no
result`, and `T[] → irVec(...)`, which legacy `getOrRegisterVecType` interns as
the identical `(ref_null $vec_<elem>)` struct. Body lowerability is a
*separate* question and is still decided by the ordinary claim gates, which run
first.

Deliberately excluded, and each exclusion is load-bearing:

- unannotated/implicit positions — that is the #4186 split-brain surface, and
  this predicate must not pre-empt that lane's fix;
- optional / rest / defaulted params — arity is part of the ABI;
- generators and generics;
- **string and object positions**, and non-scalar or nested array elements —
  their carrier depends on `nativeStrings` / vec-element decisions this
  predicate does not reproduce. This is why the shipped fix reaches 16 rather
  than the A/B's 17: `calendar.ts::mname(m: number): string` returns a string
  and is left uncertified on purpose.

The predicate lives in its own module rather than in `src/codegen/index.ts`
because the LOC-budget gate explicitly asks for that; the remaining +2 LOC /
+1 func-line in `index.ts` (one import, one early return) is irreducible —
`legacyCallerAbiIsProjected` is a closure built inside `planIrOverlay` — and is
granted in this file's `loc-budget-allow` / `func-budget-allow` frontmatter.

**Standalone lane, before → after: 10 → 16 IR bodies** (`algorithms.ts` 0 → 3:
`fibIter`, `binarySearch`, `quicksort`; `calendar.ts` 0 → 3: `dimOf`, `fdow`,
`priceOf`). `select/call-graph-closure` fell 10 → 4. The baseline is ratcheted
to the post-fix numbers. The single-host lane is unaffected (still 37/37,
READY) — `jsHostExterns` is true there, so `demoteOnLegacyCaller` is false and
the new predicate is never consulted.

**Descoped, with reasons:**

- **Fast-mode lane (plan item 4)** — not added. Adding a third lane is
  mechanical now that `observeLane` is generic, but it needs its own honest
  measurement pass and its own blocker triage, and the budget went to the
  standalone blocker instead. Deliberately left rather than added unmeasured.
- **The remaining 21 standalone unsupported units** are genuine per-shape gaps,
  not this gate: 11 `body-shape-rejected` (`main`/`renderCal`/`el`/`fibMemo` —
  console/DOM/`Map` bodies), 4 `async-function`, 4 residual
  `call-graph-closure`, 1 `date-constructor-unsupported`, 1
  `primitive-method-unsupported` (`joinNums`, f64 `.toString()`). Each needs
  real standalone lowering; none is a mode-gating bug.
- **String-return certification** (`mname`) — the one A/B-proven remaining unit
  reachable via this gate. It needs a `nativeStrings`-aware carrier proof that
  belongs with the string-ABI work, not here.
- **The `legacyBodyEmitted` ceiling stays at 27.** The six newly-IR units are
  IR-**emitted** (the overlay patches a legacy-created slot), not
  **compile-once** — they still emit a legacy body first. Per this epic's own
  Terms that is a real but lesser tier, and the baseline records it honestly
  rather than implying compile-once ownership the lane does not have.

## Standalone-lane Test Results (fable, 2026-08-15)

Measured in worktree `agent-a560da37ac458f0fa` on main @ `7add6938`.

| Gate                                                | Result                                                                                                                                                                                                          |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` (ts7, the CI gate)              | **clean**                                                                                                                                                                                                       |
| `npx tsc --noEmit` (legacy tsc)                     | environmental failure only — `@types/node` is unresolvable through this worktree's symlinked `node_modules`; every error is `Cannot find name 'process'/'require'/'__filename'` in files this change never touches |
| `pnpm run check:ir-only`                            | **2 lanes reported**; single-host 37/37 IR, 0 legacy, **READY**; standalone 16 IR / 27 legacy / 21 unsupported / 0 invariants, ratcheted; verdict **READY**                                                    |
| `pnpm run check:ir-fallbacks`                       | **OK** — unintended (none), post-claim demotions (none), module-level (none)                                                                                                                                    |
| `npm run check:loc-budget`                          | OK — +2 in `src/codegen/index.ts`, granted by this file                                                                                                                                                         |
| `npm run check:func-budget`                         | OK — +1 in `planIrOverlay`, granted by this file                                                                                                                                                                |
| `npm run check:oracle-ratchet`                      | OK — `getTypeAtLocation +0`, `ctx.checker +0` (the new module makes no checker call)                                                                                                                            |
| `biome lint` (changed files)                        | clean                                                                                                                                                                                                           |
| `tests/issue-3519-ir-only-gate.test.ts`             | **14/14 pass**, including 5 new per-lane-readiness tests                                                                                                                                                        |
| `scripts/equivalence-gate.mjs`, shards **1–8 of 8** | **no new equivalence regressions** in any shard                                                                                                                                                                 |

Standalone runtime probes (`.tmp/`, gitignored):

- `algorithms.ts` compiles standalone, and the binary **instantiates and
  `main()` runs without trapping**.
- A dedicated fixture exercising the three certified shapes (`fibIter`,
  `binarySearch`, `quicksort`, plus a `boolean`-returning `isEven`) reached
  from an intentionally **unclaimed** caller returns `55414`, matching the
  hand-computed JS expectation — and returns the **identical** value on
  unmodified main. The change moves work from the direct path to IR without
  changing observable behaviour.

**Every test failure encountered was A/B'd against unmodified `main` and is
pre-existing.** Nothing in this change set regressed any of them:

- `tests/es5-standalone*` (26 files): 5 failures — harness self-tests ×3,
  descriptor bags, array-semantics dynamic HOF lane. Identical on baseline.
- `issue-1712-standalone` (the acorn case #4186 documents as red on main),
  `issue-3436-standalone-prelude-leak`, `issue-3673-standalone-gaps`,
  `issue-4034-standalone-prelude-size`: 4 failures. Identical on baseline.
- `issue-3520-ir-unit-identity`, `issue-3522-ir-class-compile-once` (×2,
  including its standalone-lane case),
  `issue-3522-ir-cross-owner-free-function`: 4 failures. Identical on baseline.
- `issue-1654-wasi-dataview-arraybuffer`: 3 failures. Identical on baseline.

The equivalence shards additionally reported **7 baseline failures that now
PASS** (`coercion-arithmetic-add` ×3, `math-pow-test262-pattern`,
`issue-1197`, `symbol-basic` ×2). These are **not** attributable to this
change: `math-pow-test262-pattern`, `coercion-arithmetic-add` and `issue-1197`
were each re-run on unmodified `main` and pass there too. The equivalence
baseline is simply stale; ratcheting it is out of scope here.

Full test262 was **not** run (per instruction). The standalone-floor / net
guards (#1897/#2097) run in the `merge_group` and remain the authoritative
check on this change's standalone conformance effect.

## Review (Fable, 2026-07-24)

Verify-first re-audit on main @ `7652f0337` (full document:
`plan/agent-context/fable-ir-review-2026-07-24.md`).

- **The "Current truth" table still holds.** Re-ran `check:ir-fallbacks`
  (all unintended buckets 0; module-level 0) and `check:ir-only` (5/5
  entries, 37 units, 31 IR-emitted, 6 typed Unsupported, 0 Invariants,
  37/37 legacy bodies, NOT READY) — identical to the 2026-07-21 audit.
  Adoption matrix: 18 ir-owned confirmed; denominator is now 58 kind rows
  (prose says 56). Compile-once ceiling and fn-line reachability were not
  re-measured; no allowlist-widening landed since 2026-07-21, so ≈28.1%
  plausibly holds.
- **Ladder gap — R9 needs an explicit coverage-closure dependency.** R9
  depends on R3–R8 only, but a fail-closed flip with `SwitchStatement` /
  `LabeledStatement` / `ForInStatement` still direct-only (#2952 `ready`,
  unstarted) and `%`/`**`/`in`/`instanceof` unlowered would hard-fail
  ordinary core-JS programs. The acceptance gate only catches this if the
  authoritative matrices contain such syntax — the playground corpus barely
  does. Recommend: (a) add "#2952 + #2949 + #1373b + #3583 coverage closure"
  to R9's Depends-on cell, and (b) grow the `check:ir-only` corpus beyond
  the playground before R9 readiness is claimed.
- **#2952 can and should start now** — its structural work (br_table +
  labeled nested-buffer exits) depends on neither R1 nor R2 and is the
  longest-lead item on the R9 critical path.
- **28 adoption-matrix rows had no live owner** (13 tracked by wont-fix
  #1131, 12 by done issues, 3 untracked) — now tracked by new issue #3583.
- R1 groundwork is confirmed landing on main (`4922ed58b`, `1a17b4458`);
  the R2–R8 `depends_on` frontmatter matches this epic's spine exactly.

## Slice: standalone readiness lane + top blockers (fable, 2026-08-15)

Live measurement on main @ `7add6938`: the `check:ir-only` gate has
exactly ONE lane (single-host WasmGC over 5 playground entries, READY at
37/37 IR bodies / 0 legacy). The SAME entries compiled with
`target: "standalone"` collapse: `js/algorithms.ts` = **0 IR / 7 legacy
bodies**, `js/classes.ts` = 10 IR / 1 legacy. The acceptance criteria
require standalone/WASI/fast/multi-source matrices; none is measured
today. This slice adds the standalone lane and attacks its top blockers.

1. **Add a `standalone` lane to `scripts/check-ir-only.ts`**: same 5
   entries, `target: "standalone"`, per-lane baseline in
   `scripts/ir-only-baseline.json` per the existing #3519 schema. Baseline
   HONESTLY at measured current truth (floors/ceilings) — the lane must
   not be required to be READY to land; it must be required not to
   regress.
2. **Diagnose the algorithms.ts 0-IR collapse.** A file that is 100%
   IR-owned on host emitting zero IR bodies standalone means a mode-gated
   capability/seal/registration decision, not per-shape gaps — find the
   single gate (selector capability rows, prepared-component sealing, or
   resolver registration keyed on host mode) and record it here.
3. **Fix the top blockers** to raise the standalone lane's IR-body floor;
   ratchet the baseline with each fix. Known hazards: standalone number
   boxing goes via `$AnyValue` not `__box_number` (#2955 notes),
   standalone-floor CI guard (#1897/#2097) — net standalone test262 must
   not go negative.
4. **Fast-mode lane** (`fast: true`) same pattern, time permitting —
   measure, baseline, do not block on READY.

Acceptance: gate reports ≥ 2 lanes; single-host stays READY; standalone
lane floors ≥ measured-at-landing values; `check:ir-fallbacks` no
growth; equivalence suite + standalone probes green; `tsc --noEmit`
clean.

### Result: caller-direction closure precision (2026-08-15)

**Landed:** standalone lane **16 → 17** IR bodies emitted;
`select/call-graph-closure` **4 → 3**; unsupported **21 → 20**. Single-host
lane unchanged at **37/37**, READY. Newly claimed unit:
`dom/calendar.ts::mname`.

**Root cause.** `legacyCallerAbiIsProjected` — the escape hatch the
standalone/WASI caller-direction closure consults — was backed by
`hasFullyAnnotatedScalarAbi`, whose certified surface **excluded `string`
positions** on the stated ground that "their carrier depends on
`nativeStrings`". That ground does not hold: legacy `resolveWasmType` and IR
`resolveString()` both pick the carrier from the SAME pair,
`ctx.nativeStrings && ctx.anyStrTypeIdx >= 0` → `(ref $AnyStr)`, else
externref. They agree **by construction**, including the `anyStrTypeIdx < 0`
corner. So `mname(m: number): string` — a leaf whose only unclaimed edge is
its legacy caller `renderCal` — was demoted for a signature divergence that
cannot occur.

**The other three `call-graph-closure` units are NOT caller-direction and are
out of reach of any closure-precision change.** Measured directly by
instrumenting the demotion (`caller=`/`callee=` per unit):

| unit | direction | blocked by |
| --- | --- | --- |
| `calendar.ts::mname` | caller only | *(fixed here)* |
| `calendar.ts::onDay` | callee only | callees `updFoot`, `renderCal` both `body-shape-rejected` |
| `builtins.ts::crd` | caller **and** callee | callee `el` `body-shape-rejected` |
| `builtins.ts::rw` | caller **and** callee | callee `el` `body-shape-rejected` |

`onDay` already had `legacyCallerAbiIsProjected === true` before this change —
its caller direction was never the blocker.

**The callee direction is not relaxable today, and this was measured, not
assumed.** Disabling the callee arm outright makes the standalone lane go
NOT READY with a hard compile failure, not a silent demotion:

```
Codegen error: IR path failed for onDay:
  ir/from-ast: direct call to "updFoot" has no exact AST-site plan in onDay
```

i.e. `from-ast` has no lowering for a direct call to an unclaimed (legacy)
local function at all — the callee-direction closure is load-bearing for
*lowerability*, not merely for signature safety. Those three units unblock
only when `el` / `renderCal` / `updFoot` themselves become claimable
(#2856/#2857 body-shape work on the standalone DOM/host surface), which is a
different slice.

**Host-lane invariance is structural, not empirical.**
`legacyCallerAbiIsProjected` is read only under `demoteOnLegacyCaller`
(`jsHostExterns !== true`, `select.ts` and `select-identity.ts` — the only two
consult sites), so widening the certified surface cannot move a JS-host claim.
The 37/37 re-measurement confirms it.

**Tightenings shipped alongside** (each strictly narrows the certified surface,
so none can regress a lane) — the predicate previously certified declarations
whose legacy signature it could not actually predict: destructuring parameters
(`bindingPatternParamNeedsWiden` widens them to externref), `async`
(`prepareAsyncCallableAbi` rewrites the ABI), and a return carrier legacy
overrides on body shape (`functionReturnsDynamicObjectCarrier`, now handed in
as explicit evidence rather than re-derived). The last one was a live hole for
the already-certified `number`/`boolean` returns, not something the `string`
extension introduced.

### Completed checkpoint: standalone Builtins DOM projection (2026-08-20)

#4576 advances the authoritative standalone lane from **27 → 31 of 37 IR
bodies** and from **10 → 6 legacy/typed Unsupported bodies**, with **0
Invariants**. The four newly prepared owners are Builtins `el`, `crd`, `rw`,
and `main`. `select/host-surface-unavailable` falls **4 → 2** and
`select/call-graph-closure` falls **3 → 1**; the remaining six outcomes are
exactly Calendar: two host-surface, two body-shape, one call-graph, and one
Date-constructor blocker. The single-host lane remains **37/37 IR**.

The family is admitted only with the exact `dom@1` embedder contract: eight
signature-checked imports, one authenticated subtree root, and an explicit
native-string boundary. The focused **14/14** Builtins suite proves the
**81-element/24-value** DOM oracle, direct-body poison, conservative near
misses, and tamper/authority failures. The optimized artifact is smaller than
the direct control in raw, gzip, compiler-WAT, function-body WAT, local, and
call counts while retaining 124 functions and the same eight imports. Literal
CSS, batched concat, immutable string-search, constant bitwise, proven-ASCII
case, and native number-format carrier optimizations are all pinned.

The frozen runtime A/B establishes parity within noise, and the complete
publication gate matrix is green. This closes the Builtins checkpoint, not the
R9 epic: Calendar's atomic six-unit retirement remains the next standalone
census step.

### Completed checkpoint: standalone Calendar capability transaction (2026-08-20)

#4577 advances the bounded standalone lane from **31 → 37 of 37 IR bodies**
and **6 → 0 legacy/typed Unsupported**, with every former reason bucket and
Invariant count at zero. The lane now enforces strict IR-only readiness rather
than the temporary baseline-only policy. The single-host control remains
37/37. This closes the exact five-entry playground census, not R9's complete
source-program denominator.

Calendar's nine functions and module init publish atomically with seven exact
reusable callbacks and five source-qualified nullable DOM globals. The frozen
`dom@1` eight-import ABI is unchanged; a separate two-import
`dom-interaction@1` provider owns listener/background mutation and the exact
one-import `clock@1` provider owns Date snapshots under the standalone
UTC/zero-offset profile. Compiler-owned import/storage/callback provenance,
complete registry contracts, instance-pinned runtime authority, multi-source
isolation, donor/tamper controls, and direct-body poison keep all of those
capabilities fail closed.

The final focused matrix is **59/59**. The same-source, same-standalone-runtime
IR-versus-legacy-direct artifact A/B records IR/direct at 30,089/32,379 raw
bytes, 18,387/19,030 gzip-9 bytes, 477,625/481,730 pre-optimization WAT
characters, 62,481/69,234 selected body characters, 155/172 locals, 172/172
calls, 156/167 functions, and 11/11 imports. All 660/660 measured executions
preserve the 12-render oracle, but bracket noise supports no runtime speedup
claim. Aggregate optimization evidence is recorded without promoting pending
per-transform performance rows.

The post-checkpoint reachability audit keeps R9/R10 open. `experimentalIR:
false`, `disableIrFirst`, and the environment kill switch still expose direct
selection; ordinary non-prepared single-source and all multi-source compilation
still enter legacy declarations/body walking before any overlay; fast
multi-source has no overlay; and CJS, nested containers, IIFEs, dynamic code,
generic class/module shapes, WASI, and linear remain outside this bounded
census. The next cutover must fail typed before body emission across that full
denominator, then prove the standalone legacy walkers unreachable before shared
direct code can be removed.

### Bounded audit: `bench_array` Prepared seam (2026-08-24)

The refreshed authoritative five-entry gate is green at **5/5 entries,
38/38 terminal units, 38/38 IR-emitted units, zero legacy bodies, zero typed
Unsupported outcomes, and zero Invariants** in both the single-host and
standalone lanes. That denominator is still bounded and does not prove
repository-wide IR-only readiness.

The exact multi-source `website/playground/examples/benchmarks/array.ts`
target remains a direct-body overlay: compiler-only standalone telemetry records
two source files, six all units, five terminal units, and **16** physical legacy
rows. `bench_array` has both `legacyBodyEmitted` and `irBodyEmitted`, with the
two direct rows exactly `compileFunctionBody` and `compileStatement`; the other
14 rows belong to helpers, DOM callback owners, `main`, declarations, and
module setup. The existing direct and IR paths agree on the target's `() -> f64`
ABI and the IR body already lowers the empty `number[]`, dense `push` fill,
`length`/indexed reduction, i32 vector carrier, in-bounds proof, and vector
allocation/access operations.

The existing scalar and function-value route primitives are sufficient for the
next bounded transaction, but the scalar candidate intentionally rejects array
syntax and the generic function-value candidate is specialized to the prior
reduction fixture. A safe implementation therefore needs one new
`src/codegen/multi-prepared-array-leaf.ts` route, wired narrowly at the shared
pre-body seam in `src/codegen/index.ts`. The route should reuse
`prepareIrBodies`, `skipBodies`/`preserveSkippedBodies`, exact UnitId/terminal
correlation, and the existing `MultiPreparedFunctionValueSupportReceipt` for
the one direct imported callback edge. Its checker proof must require the exact
exported no-parameter `number` declaration, `const arr: number[] = []`, the
literal counted `push` loop, the literal counted `length`/indexed reduction,
source-identity for every array/counter/accumulator/method use, and one stable
imported callback target. Any alias/re-export, extra candidate, capture,
reassignment, dynamic index, extra array method, callback/ABI tamper,
cross-file component, class, module-init, fast, WASI, or single-source near
miss must retain direct ownership or fail before publication.

The default-on rollback must be `JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER=0` and
must restore exactly the current two target direct rows. Runtime instantiation,
raw/optimized WAT A/B, vector/bounds/call/allocation parity, and callback ABI
publication remain acceptance evidence for the implementation; this audit does
not claim those route-specific checks have passed.

### Implementation checkpoint: array leaf route after the first failed attempt (2026-08-24)

This is a design-only checkpoint. No compiler source, runtime artifact, or
heavy test result is accepted by this entry. The first implementation attempt
did not produce a safe array route: adding the route to the existing scalar
union is not enough, because the scalar recogniser rejects array syntax and the
function-value recogniser is deliberately limited to the earlier reduction
fixture. The next implementation must land as one independently reviewable
array transaction; it must not widen either generic recogniser or copy a second
array lowerer.

#### Exact candidate proof

Add `src/codegen/multi-prepared-array-leaf.ts`. Its exported candidate
collector/resolver should be named and shaped like the existing scalar leaf:
`collectMultiPreparedArrayLeafCandidates`,
`isMultiPreparedArrayLeafCandidateEligible`,
`tryPrepareMultiSourceArrayLeaf`,
`planEarlyMultiPreparedArrayLeafRoute`, and
`assertMultiPreparedArrayLeafRouteCurrent`. The route is eligible only when
all of these facts hold before any direct body is requested:

1. The shared planner is active only for `experimentalIR`, non-`disableIrFirst`,
   standalone WasmGC, non-fast, non-WASI, and a graph with more than one source;
   the candidate declaration is in the entry source and the array cutover
   switch is enabled. The resolver must use the exact `IrUnitId`, source record,
   declaration, terminal owner, claim, override, and `ProgramAbiSession`
   joins, not the spelling `bench_array`.
2. There is exactly one exported, bodyful, top-level, non-async,
   non-generator, non-generic, zero-parameter function with an explicit
   `number` return. Its five statements are exactly the benchmark shape from
   `website/playground/examples/benchmarks/array.ts:3-9`: one `const` binding
   with an explicit `number[]` annotation and empty literal; one counted loop
   beginning at numeric literal zero, with a strictly increasing update and a
   single `arr.push(i)` statement; one zero-initialised numeric accumulator; one
   counted `i < arr.length` loop with one `total = total + arr[i]` assignment;
   and a return of that same accumulator. Require the checker symbol for every
   array, counter, accumulator, `length`, `push`, and indexed access to match
   the candidate declarations. The push bound must be a safe integer literal
   (the real fixture is `10000`); do not admit an arbitrary expression merely
   because it currently lowers.
3. The proof must call the shared canonical helpers rather than duplicate their
   semantics: `canonicalCountedPushPlanForLiteral` and
   `canonicalCountedPushPlanForCall` in
   `src/ir/array-element-lowering.ts:226-264`, the empty-array inference and
   `number[]` annotation contract in `array-element-lowering.ts:292-324`, and
   the existing counted-loop/index proof in `src/ir/from-ast.ts:9278-9328`.
   Require the canonical push plan’s single-argument, non-spread, same-symbol
   receiver and pure non-aliasing value proof. Reject aliases, a `let` array,
   reassignment, additional writes/methods, a dynamic or negative bound,
   non-increasing updates, `<=`/`>=` bounds, index mutation, nested functions,
   an escaping array, an extra array literal, or any second eligible function.
4. The candidate’s local call/value graph is a singleton. The only runtime
   value observation of the candidate is the one identifier passed once as the
   fourth argument of an exact named imported call in the legacy `main` owner.
   Resolve that import through
   `resolveMultiPreparedFunctionValueImportTarget` in
   `src/codegen/multi-prepared-function-value-import-target.ts:36-102` and
   require the imported declaration to be the unique exported `addBenchCard`
   helper from the exact `helpers.ts` source record. The caller is a distinct
   top-level terminal with its own UnitId and remains direct-owned. Reject an
   alias, re-export, repeated/stored/returned value, same-source target,
   wrong-arity callback, callback type/ABI drift, an extra direct caller, or a
   callback whose owner/source identity changes.
5. The target must have the exact prepared `[] -> f64` override, one occupied
   callable with the matching source UnitId, no collision/suffix/import-alias/
   live-function binding, no class shape, no module-init/storage terminal,
   no derived owner, no cross-file target, and no late provider. A candidate
   that cannot be fully proven returns ordinary ineligibility before skip;
   drift after certification is an `IrInvariantError`, never a silent direct
   fallback after a skip was requested.

#### Route and receipt API

Reuse the common prepared body state from
`src/codegen/multi-prepared-scalar-leaf.ts:239-304` (export the route base if
needed) and add `MultiPreparedArrayLeafRoute` with `routeKind: "array"`.
`MultiPreparedArrayLeafPlan` may extend the scalar plan’s identity, claims,
overrides, and class-shape maps, but its receipt must retain an immutable shape
record: target UnitId/name/declaration, the exact array declaration, push and
reduction loop nodes, counter/accumulator declarations, source IDs, and the
canonical callback/value-edge evidence. This lets the late assertion prove
AST identity and symbol joins rather than trusting a name or a stale report.

The planner should mirror
`planEarlyMultiPreparedScalarLeafRoute` at
`multi-prepared-scalar-leaf.ts:1273-1337`: build one plan per candidate source,
compute the ordinary graph safety/selection, require exactly one eligible
entry-source candidate, and call `prepareIrBodies` with only the target
function. Reject any class-member, module-init, implicit-constructor, derived,
or second free-function result. Require the same exact skip/preserve/completed
body sets, terminal evidence, artifact evidence, nonempty prepared component,
and `[] -> f64` allocated callable checked by
`tryPrepareMultiSourceScalarLeaf` at `multi-prepared-scalar-leaf.ts:986-1104`.
Do not make a second array-specific IR builder: the prepared body must be the
existing `from-ast` result.

The array route must receive a callback
`prepareFunctionValueSupport(plan, sourceFile, unitId, legacyName)` from the
shared planner and call the existing private
`prepareTopLevelFunctionValueTargetSupport` in `src/codegen/index.ts:2265-2345`.
Store the returned `MultiPreparedFunctionValueSupportReceipt` unchanged and
revalidate it with `functionValueSupportIsCurrent` after the remaining legacy
owners run. This freezes the candidate callable plus exactly one trampoline,
cache global, support binding, locator, and Program ABI role before the direct
caller can materialise `bench_array`; it does not prepare or duplicate the
`addBenchCard` helper. The callback’s owner UnitId, imported target UnitId,
source key, call AST node, and distinct owner must be rechecked at the late
seam.

Wire the map in `src/codegen/index.ts:3570-3623` with
`JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER` and an explicit route-overlap assertion.
The array route must be considered before the generic function-value route and
must never silently share a source state with scalar, Fibonacci, or bench-loop
routes. Reuse `compileMultiPreparedScalarLeafDeclarations` at
`index.ts:8718-8720`; in the late overlay at `index.ts:3665-3688`, dispatch an
array-specific current-route assertion before `completePreparedIrIntegration`.
The final assertion must check final selection, target/support allocator
identity, immutable prepared instruction sequence, exact report receipt, and
the unchanged callback/value edge. Any failed post-certification check is an
Invariant.

#### Existing IR shape that must remain load-bearing

The implementation must preserve the already measured lowerings, not replace
them with a fused hand-written body. `lowerArrayLiteral` uses the empty
`number[]` hint and canonical counted-push capacity at
`src/ir/from-ast.ts:4464-4533`; `tryLowerVecPush` emits the one-element vector
store and length increment at `src/ir/array-element-lowering.ts:368-448`;
`lowerPropertyAccess`/element access uses the counted-loop proof and only emits
unchecked `vec.get` for a proven `0 <= i < arr.length` at
`src/ir/from-ast.ts:5467-5476,5693-5781`; and `lowerForStatement` carries the
proof into the loop body at `from-ast.ts:9605-9640`. The route is correct only
when the resulting prepared body retains the i32 vector carrier, in-bounds
read, vector allocation/store/get, and f64 return conversion observed in the
baseline. If any of those facts cannot be certified, withdraw before skip.

#### Kill switch and focused test contract

Use `JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER=0` as the exact pre-cutover control.
Add `tests/issue-3518-bench-array-prepared-cutover.test.ts`, following the
15/21-case structure of the existing #4589/#4590 route suites:

- default-on direct-body poison must compile with no target
  `compileFunctionBody`/`compileStatement` rows and report one `terminal-ir`
  target with `legacyBodyEmitted: false`, `irBodyEmitted: true`, and a prepared
  component; the kill switch must reproduce exactly the two target direct rows
  and fail the same poison;
- raw direct/Prepared audit rows must differ only by those two target rows;
  target raw WAT must retain the vector allocation, counted push/store, proven
  bounds/indexed get, i32 carrier, and `() -> f64` body shape; source callable,
  trampoline/cache, import/export, and callback Program ABI contracts must be
  exact and singleton;
- raw and optimized Prepared/direct A/B must instantiate and return
  `49_995_000`, preserve DTS/import helper/import/string-pool/public surfaces,
  retain callback publication, and show no optimized size or call/allocation
  regression. Runtime and WAT evidence are required for implementation
  acceptance; this design checkpoint makes no such claim;
- mutation cases must cover renamed-but-equivalent declarations (positive),
  extra candidate/extra caller, alias/re-export/stored value, `let`/reassigned
  array, non-empty or escaping array, push arity/spread/dynamic value, bound or
  index/update changes, `<=`/`>=`, additional array method, callback source or
  ABI tamper, support-name/allocator tamper, post-certification route tamper,
  class/module-init/cross-file component, and fast/WASI/IR-first-disabled
  controls. Every negative must retain the two direct rows or fail with a typed
  pre-emission Unsupported/Invariant; none may skip first and discover drift
  later;
- preserve the existing #4589, #4590, #4591, #2138, standalone-floor, and
  direct-caller suites. Add a required-route env for the positive fixture and
  a dedicated `JS2WASM_TEST_TAMPER_MULTI_PREPARED_ARRAY_LEAF` hook so the
  late fail-closed assertion is exercised without weakening production gates.

The implementation landed in #4836. The default route now removes exactly the
two `bench_array` direct rows and publishes one `terminal-ir` outcome with a
nonempty Prepared component; `JS2WASM_MULTI_PREPARED_ARRAY_CUTOVER=0` restores
the exact direct control. The focused **5/5** suite proves direct-body poison,
runtime/public-surface parity at **49,995,000**, post-certification tamper
failure, a genuinely ineligible loop-shape mutation, and the fast-lane direct
control. Typecheck, formatting, lint, IR layering, oracle ratchet, LOC/function
budgets, issue integrity, numeric local parity **18/18**, and the full PR gate
were green before the merge. This is compile-once evidence for that one
multi-source array leaf, not for the other 14 direct rows or for the wider
standalone program denominator.

### Implementation plan: counted-string semantic IR and `bench_string` cutover (2026-08-24)

The next smallest measured host-free standalone residual is
`website/playground/examples/benchmarks/string.ts::bench_string`. This is the
next residual in the benchmark cutover sequence, not a repository-wide
minimum. A fresh compiler-only census on the post-array tree ran with ten
logical cores, the strict one-minute load limit **< 8**, and a measured load of
**3.9091796875** before every compile:

| benchmark terminal | target legacy rows | current terminal outcome |
| --- | ---: | --- |
| `bench_loop` | 0 | Prepared `emitted`, IR-only body |
| `fib`, `bench_fib` | 0 each | Prepared `emitted`, IR-only bodies |
| `bench_array` | 0 | Prepared `emitted`, IR-only body |
| `bench_string` | 2 | `unsupported`, `select/string-builder-candidate` |
| `bench_dom` | 2 | `unsupported`, `select/host-surface-unavailable` |
| `bench_style` | 2 | `unsupported`, `select/host-surface-unavailable` |

`bench_string` is the only remaining host-free leaf in this measured set.
`bench_dom` and `bench_style` need the broader DOM-capability transaction and
are not interchangeable follow-up candidates.

The exact `bench_string` record is a two-source `compileProject` /
`generateMultiModule` standalone graph with six all units, five terminal
units, one owned support unit, and 16 physical legacy rows. The target source
is `ir-source:v1:0000000000000001:entry:string.ts`; its source-qualified
top-level-function UnitId owns exactly one `compileFunctionBody` row at 3:1
and one `compileStatement` row at 4:3. The other 14 rows belong to helpers,
the direct DOM caller, declarations, and module setup. The audit is
structurally complete with no violations or unattributed entries.

This residual is deliberate optimization preservation. #1004's direct
`tryCompileCountedStringAppend` recognises the exact counted literal append and
replaces 1,000 loop iterations with **one `repeat(1000)` plus one concat**.
`stringBuilderForcedLegacy` therefore withholds the source because the IR
currently has concat and length semantics but no repeat intent. Removing that
selector arm before migrating the transform would turn one aggregate
operation back into 1,000 allocations/calls and violate this epic's
optimization-retirement rule.

#### Transaction A — one shared counted-append proof

Move the semantic proof out of the direct codegen handler into
`src/ir/analysis/counted-string-append.ts`. It must return an immutable
`IrCountedStringAppendPlan`, not synthesized TypeScript AST. Like the existing
counted-push analysis, this plan owns syntax, checker-symbol, type, and
constant facts only; it must not import preparation-owned UnitIds. A separate
`PreparedCountedStringAppendReceipt` pairs the plan's exact AST/symbol identity
with the source record, owner UnitId, provider authority, and final instruction
digest during preparation. The syntax plan records the
accumulator/counter/fragment declarations and checker symbols, exact
loop/append source nodes, start/bound/comparison/unit-step, safe integer trip
count, and accumulator/fragment string types. The proof remains deliberately
tight:

1. one writable `let` integer counter initialized from an exact safe integer;
2. `i < B` or `i <= B` with an exact safe-integer literal or checker-proven
   `const`, and only `i++`, `++i`, or `i += 1`;
3. one body statement, `s = s + fragment` or `s += fragment`, with the same
   checker symbol for every `s` use;
4. a string literal/no-substitution template or a distinct, string-typed,
   source-local immutable identifier as the side-effect-free fragment; and
5. a checker-proven writable `let` accumulator; never `const`, an accessor, or
   an imported/read-only binding; and
6. no capture, alias, getter/member read, call, spread, counter dependency,
   accumulator self-fragment, extra statement, second write, or observable
   intermediate value.

Every checker-resolved constant used for the counter start, bound, or fragment
must be a source-local declaration with an initializer that lexically
dominates the loop in the same reachable scope. Forward declarations, TDZ
reads, cross-source bindings, initializer cycles, and values established only
by a later statement are rejected even if `constInitializerOf` can recover an
initializer node. Add forward-bound and forward-fragment TDZ controls; folding
must never erase the `ReferenceError` that direct JavaScript would produce.

The existing direct handler must consume this same plan while hybrid rollback
exists. It may construct its temporary AST only after the shared proof has
succeeded; it must not retain a second recognizer. Plan identity must be
revalidated immediately before either direct or IR emission so a stale checker
node, source record, UnitId, symbol, or trip count fails typed before artifact
publication.

Trip-count behavior is part of the semantic contract: zero iterations emit no
write, one iteration emits one ordinary concat without repeat machinery, and
two or more iterations emit exactly one repeat and one concat. Inclusive
bounds and nonzero starts use the same checked arithmetic as #1004. Overflow,
non-safe integers, negative/non-finite derived counts, or changed source nodes
withdraw before body skipping.

#### Transaction B — backend-neutral JS-dialect `string.repeat`

Land Transaction B as two signed, queueable checkpoints rather than one large
cutover commit:

1. **B1 — dialect/provider foundation.** Add the v5.2 JS-dialect instruction,
   verifier/effect/clone/digest coverage, exact host/native/linear provider
   ABIs, reservation/authentication, and executable provider tests. This
   checkpoint is intentionally producer-free: it must not remove the selector
   deferral or claim that `bench_string` moved. Its PR description and evidence
   say exactly that.
2. **B2 — counted-plan consumer and cutover.** Starting only after A and B1
   land, consume the shared proof in `from-ast`, implement the `N=0/1/>=2`
   shapes, reserve the linear provider from the prepared receipt before slots,
   remove only the unconditional counted-append deferral, and prove the exact
   builder-off rollback. This is the first checkpoint allowed to claim that the
   single-source counted loop is Prepared.

Transaction C remains a third PR because its source-qualified multi-module
callback composition and rollback are independently reviewable. Do not fold C
into B2 merely to make the bounded standalone census turn green sooner.

Add `string.repeat` to the typed JavaScript IR dialect rather than encoding the
optimization as a backend helper call in the frontend. “Backend-neutral” here
means that host WasmGC, native WasmGC, and linear consume one typed semantic
operation; it does not misclassify ECMAScript `ToIntegerOrInfinity`/RangeError
behavior as language-neutral core IR. The instruction owns a
typed string operand, a JS-number count operand, one string result/allocation,
producer encoding evidence, and an optional provider reference filled only by
final preparation. Extend the builder, node union, in-memory clone and digest
logic, effects, ownership, verifier, prepared-component dependency discovery,
backend legality, inliner/monomorphizer/value-use switches, and string-support
provider mapping. Append the instruction to the frozen schema table and bump
the normative IR contract from v5.1 to v5.2. Executable Prepared-program
serialization is still future work in the current contract; this transaction
must test in-memory clone/prepare/digest/tamper and must not claim an executable
serialize/deserialize round trip unless that separate prerequisite actually
lands. Verification must require `(string, f64) -> string`, exact
allocation/result typing, and provider authority before a component seals.

Add `repeat` to `IrStringRuntimeIntrinsic` with the full ECMAScript
`ToIntegerOrInfinity` contract. The counted-plan producer supplies a proven
nonnegative safe integer, but the instruction/runtime ABI must not silently
redefine dynamic `String.prototype.repeat` semantics for later producers.
Negative or `+Infinity` counts remain RangeError/trap according to each
backend's already documented exception substrate; `NaN`/`-0` normalize as the
existing direct implementations do. Because a general repeat can throw, its
effect classification is a control/full barrier: DCE may not erase it and the
scheduler may not move it across observable effects. The counted producer's
safe constant proof does not silently weaken the general instruction's effect
unless a separately verified nonthrowing-evidence field is added and tested.

Final preparation binds providers without AST inspection:

- host-string WasmGC binds the existing exact `env.string_repeat`
  `(externref, f64) -> externref` callable; it does not pretend the current
  `wasm:js-string` concat/equals provider also owns repeat;
- native-string WasmGC binds a new prepared
  `(ref null $AnyString, f64) -> (ref null $AnyString)` adapter which performs
  `ToIntegerOrInfinity` and RangeError validation before delegating the
  integer count to the existing `__str_repeat`; the unvalidated native helper
  is not itself the semantic provider;
- linear binds the existing `(linear-string, f64) -> linear-string`
  `LINEAR_STRING_REPEAT_FN` runtime from
  `src/codegen-linear/string-repeat.ts`.

The linear integration must consume the same instruction and provider plan as
WasmGC. Linear runtime functions are registered before user slots while final
IR preparation currently happens later, so the shared counted-plan receipt
must reserve the repeat provider before slot assignment and final preparation
must authenticate that same reservation. Add the missing linear
resolver/emitter path. A Prepared body must not re-run
`sourceMayUseLinearStringRepeat`, inspect a property access, or use
`compileLinearStringRepeatCall`. Backend incapability is a typed pre-emission
outcome; it cannot request a legacy AST retry.

`from-ast` consumes `IrCountedStringAppendPlan` before ordinary loop lowering.
For `N >= 2` it materializes the fragment once, emits one `string.repeat`, then
one `string.concat` using `owned-append` only when the existing ownership proof
allows it, and writes the accumulator once. It emits no IR loop. The result's
encoding/allocation evidence flows through the existing string analyses and
must not bypass concat batching, native literal materialization, or linear
memory planning. For `N == 0/1`, use the exact special cases above.

Once this path is sealed, remove only the unconditional
`containsCountedLiteralStringAppend` deferral from
`stringBuilderForcedLegacy`. The current general builder detector recognizes
only `+=`, while the benchmark uses `s = s + fragment`; therefore
`JS2WASM_IR_STRING_BUILDER=0` must explicitly consult **both** the existing
builder detector and the new shared counted-append proof. This makes the same
switch restore both accepted assignment forms without retaining unconditional
deferral or adding a second global string-builder escape hatch. Update the
#1004 test that currently requires the function to stay off IR: it must instead
require the exact Prepared `string.repeat` + concat instruction/output shape
while retaining all 18 semantic and guard cases. Add explicit `const` counter,
`const` accumulator, and read-only/imported accumulator negatives so the
shared proof does not preserve the direct handler's current over-acceptance.

##### B2 implementation checkpoint contract (2026-08-24)

B2 is a stacked implementation worktree while the independently queueable B1
provider foundation is still landing; it must not be published as a completed
cutover until its parent is on `main`. The checkpoint has five atomic proof
boundaries:

1. production selection calls the shared checker/oracle proof, retains every
   accepted loop under its exact source and terminal UnitId, and bare selector
   callers keep the historical conservative deferral;
2. `from-ast` consumes that exact plan before generic loop lowering and emits
   no write for zero trips, one concat for one trip, or exactly one
   provider-bound repeat plus one concat for two or more trips;
3. a `PreparedCountedStringAppendReceipt` survives early/late report merging,
   is removed when its owner is deferred, and is published only after the
   exact terminal patch succeeds with a digest of the final provider-bound IR;
4. single-source linear compilation runs identity selection once before user
   slots, reserves repeat only from the retained exact plan, and later
   authenticates the same source/preparation/reservation object. The direct
   AST `.repeat` heuristic remains a separate compatibility authority and the
   multi-source path remains Transaction C; and
5. focused kills cover missing proof, builder-off rollback, stale
   owner/source/provider, unconsumed or duplicate plan/receipt rows, all three
   trip-count shapes, reservation mismatch, default-on direct-body poison, and
   a multi-source direct-poison control that stays legacy-owned until
   Transaction C.

The checkpoint's runtime verdict must additionally execute WasmGC standalone
and linear artifacts and inspect the target body rather than merely finding a
repeat helper elsewhere in the module. A green selector claim, a whole-module
helper name, or a compact route summary is not acceptance evidence.

For this bounded checkpoint, the counted-loop consumer is the only producer of
`IrBuilder.emitStringRepeat`, so the final per-function repeat census is exact.
Before Transaction C or any second IR repeat producer lands, the instruction
must gain plan/site provenance and a coexistence mutation; a function-wide
count must not silently become a general association proof. After the shared
counted proof is retained, any build, legality, provider-authentication, or
lowering failure is fatal rather than eligible for direct retry. A receipt is
publishable only after its exact terminal artifact compiled; a synthetic child
artifact is not terminal-patch evidence.

The change-scoped LOC/function allowances above are limited to these explicit
B2 seams: single-source selection, exact plan consumption, final receipt
publication/filtering, and backend orchestration. They do not authorize a
second recognizer, multi-source admission, or generic direct-path growth.

#### Transaction C — exact multi-source string leaf

Transaction C is a standalone-WasmGC graph-composition transaction. It does
not claim that the current direct-only multi-source linear compiler has gained
Prepared graph identity, exact UnitId slot adapters, or authenticated receipt
composition. The linear acceptance evidence in Transaction B is the
single-source B2 control proving that the same semantic `string.repeat`
instruction lowers through the linear provider. A future multi-linear cutover
must first land graph-wide identity/options propagation, duplicate-label-safe
slot ownership, and early graph preparation as its own reviewed transaction;
finding `$__str_repeat` somewhere in a direct multi-linear module is not that
evidence.

Before the multi-source route is wired, land a small provenance foundation.
The B2 receipt census is intentionally function-wide only while the counted
consumer is the sole `IrBuilder.emitStringRepeat` producer. C introduces a
second composition boundary, so every counted `string.repeat` must retain an
immutable source-qualified site identity derived from its exact
`IrCountedStringAppendPlan`. Builder creation, verifier, clone/map/inlining,
in-memory digest, WasmGC preparation, linear preparation, and both receipt
validators must preserve and authenticate that identity. Receipt construction
must join each plan to its exact final instruction site rather than accepting
only equal per-function counts/providers. Add non-vacuous coexistence,
reorder, replacement, duplicate-site, missing-site, and borrowed-site
mutations for WasmGC and linear before the production C route can claim a
body.

Land C as three independently reviewable signed checkpoints:

1. **C0 — counted repeat site provenance.** Add the immutable site identity
   and replace both function-wide receipt associations with exact plan/site
   joins. This checkpoint changes no route policy.
2. **C1 — pure string leaf planner.** Add the structural/source-qualified
   candidate, exact retained-plan, callback/import, UnitId, Program ABI, and
   support-receipt validator with mutation-heavy pure tests, but no skip or
   production orchestration.
3. **C2 — standalone WasmGC orchestration.** Wire the planner before generic
   function-value handling, assert non-overlap with scalar/array/Fibonacci/
   bench-loop routes, prepare only the target body, revalidate after all direct
   owners, merge the exact report/receipt, add the rollback switch to #4522,
   and publish raw audit/runtime evidence.

##### C0 implementation checkpoint contract (2026-08-24)

C0 is a behavior-neutral provenance and authentication transaction. It must
not enable another source route, change the B2 direct/Prepared matrix, or claim
the multi-source cutover. Add a branded primitive
`IrCountedStringAppendSiteId` and derive it with one shared factory from the
exact `{ sourceId, ownerUnitId, loopStart, loopEnd }` tuple, using the loop's
source-file positions and a collision-free canonical encoding. Every retained
`IrCountedStringAppendLoweringPlan`, including the zero- and one-trip shapes,
owns this required site ID. Only the two-or-more-trip shape emits a
`string.repeat`, whose new `countedStringAppendSite` field is optional so
unrelated/future general repeat producers remain valid and distinguishable.
Do not reuse the diagnostic `{ line, column }` instruction `site`, which is
neither source-qualified nor unique.

Own the brand, factory/parser, and final exact-site join in a new
`src/ir/counted-string-append-provenance.ts` module. That module accepts only
identity primitives, lowering plans, and final IR artifacts; it must not import
the TypeScript checker or recreate the syntax recognizer. This keeps one
backend-independent authority callable from both WasmGC and linear without an
IR-to-codegen dependency cycle.

The factory is called at the source/UnitId projection seam after the live AST
proof has been revalidated. Both
`src/codegen/ir-overlay-identity.ts::projectIrIntegrationLoweringPlans` and
`src/ir/backend/linear-integration.ts::planLinearIrOverlay` consume that one
factory; neither may invent its own encoding. `from-ast` passes the retained
ID into the sole counted `emitStringRepeat` call. The verifier validates the
canonical ID grammar and source span, while final preparation authenticates
membership and ownership. This field is semantic, serialized contract state
and participates automatically in the canonical instruction digest, so C0
bumps the JS-dialect IR contract and JSON schema from **v5.2 to v5.3**. It does
not claim executable Prepared-program serialization, which remains a separate
prerequisite.

Replace both positional function-wide repeat censuses with one shared exact
site join:

1. build a unique `expectedBySite` over retained plans with trip count at
   least two and reject duplicate expected IDs;
2. scan every successful final artifact deeply, including artifacts without a
   counted sidecar, and ignore only generic repeats whose site field is absent;
3. for each provenance-bearing repeat require a canonical known site, its
   exact source and terminal owner, and the expected canonical provider;
4. reject foreign, borrowed, forged, or duplicate sites, then require every
   expected site exactly once;
5. require zero/one-trip plans to emit no provenance-bearing repeat but still
   publish their plan receipt; and
6. digest the final instruction list and publish receipts in canonical retained
   plan order only after backend lowering and exact terminal patch success.

`PreparedCountedStringAppendReceipt` exposes and authenticates the plan's site
ID. Report validation, deferral filtering, and merge duplicate detection use
that canonical ID as their authority; live `syntaxPlan.loop` object identity
remains only an earlier stale-proof check and cannot authorize publication.
A receipt-bearing input report must independently carry its exact terminal
artifact, so another merge input cannot launder the receipt. WasmGC and linear
must use the same join helper and failure vocabulary.

Until ownership-transfer provenance exists, reject provenance-bearing
functions from `inline-small` and `monomorphize`; preserving an enumerable
field while cloning or moving the instruction is not proof that its original
terminal owner still owns it. Other mappers/provider attachment must preserve
the field exactly, and digest mutations must prove that removing, changing, or
borrowing it changes or invalidates the authenticated evidence.

C0 focused evidence is non-vacuous and backend-paired: an unrelated generic
repeat may coexist; reordered counted repeats still join by site; replacement
with a no-site repeat, unknown/forged site, duplicate site, deleted site,
same-source different-owner borrowing, and cross-source borrowing all fail.
Zero/one-trip plans publish receipts without a repeat. Mapper/clone/provider
tests preserve the site, the verifier rejects malformed/noncanonical IDs, and
report merge rejects a duplicate canonical site even when its AST objects were
cloned or reparsed. C0 runs the existing B2 WasmGC/linear runtime controls and
proves byte/runtime route policy is unchanged before its signed checkpoint.

##### C0 current-main implementation plan (2026-08-25)

Implement C0 as one behavior-neutral signed PR on the current `main`, with no
C1 planner or C2 route wiring mixed into the delta. Preserve the reviewed
two-file site-ID draft as input, but do not publish that foundation alone: the
checkpoint is complete only when both backends and every publication boundary
use the new authority.

1. **Identity and contract surface.** Add
   `src/ir/counted-string-append-provenance.ts` as the only brand,
   factory/parser/currentness, and final association authority. The primitive
   grammar proves a source-qualified, non-derived UnitId and canonical
   fixed-width non-negative source span; the projection and final association
   additionally prove that UnitId is an inventoried terminal owner. Add
   required `siteId` to
   `IrCountedStringAppendLoweringPlan` and
   `PreparedCountedStringAppendReceipt`; add optional
   `countedStringAppendSite` to `IrInstrStringRepeat` and the builder API.
   Bump `IR_FORMAT_VERSION`, the contract prose, JSON schema, and backend
   contract assertions from v5.2 to v5.3. The optional instruction field is
   serialized semantic state; the schema must reject malformed values when it
   is present while continuing to admit unrelated generic repeats without it.
2. **Single projection and consumption.** At the WasmGC
   `projectIrIntegrationLoweringPlans` seam and the linear
   `planLinearIrOverlay` seam, create the site ID exactly once after the live
   loop/source/declaration/UnitId proof succeeds. Revalidation must recompute
   the same ID from the retained source span; it may not accept spelling,
   map position, or AST object identity. `from-ast` passes that exact ID only
   to the two-or-more-trip `emitStringRepeat`; zero/one-trip plans still retain
   their site ID and are consumed exactly once without emitting a
   provenance-bearing repeat.
3. **Shared final association.** Expose one pure helper from the provenance
   module that accepts retained plans plus successful final terminal artifacts
   and returns frozen receipts in canonical retained-plan order. It builds a
   unique expected-site index, walks every artifact deeply (including an
   artifact with no counted sidecar), selects prepared executable
   `asyncRuntime` state bodies when present and otherwise the semantic
   `asyncPlan` bodies (never both), ignores only site-less generic repeats,
   and joins each provenance-bearing repeat to the exact site, source,
   terminal owner, and canonical provider. It rejects malformed, unknown,
   borrowed, duplicate, missing, and unexpected sites; rejects a
   provenance-bearing repeat for a zero/one-trip plan; and includes the final
   provider-bound instruction digest in every receipt. WasmGC and linear call
   this same helper and use its failure vocabulary. Receipt publication stays
   after exact terminal patch/backend success; an earlier successful owner
   cannot publish if a later counted owner makes the transaction fatal.
4. **Publication and transformation boundaries.** Validate receipt `siteId`
   against its plan in `integration-report`, retain the existing exact terminal
   artifact requirement, filter deferred receipts by exact owner without
   rewriting their site, and detect merge duplicates by canonical site rather
   than `syntaxPlan.loop` identity. Provider attachment, nested-buffer maps,
   value-ID rewrites, and instruction digests must preserve/include the field.
   Until a separately reviewed ownership-transfer proof exists, `inline-small`
   must not inline from or into a function containing a provenance-bearing
   repeat, and `monomorphize` must not clone one; add explicit fail-closed
   guards rather than relying on object spread.
5. **Non-vacuous evidence.** Extend the focused C0 unit suite with canonical
   grammar/ownership/span mutations, builder and verifier checks, provider and
   mapper preservation, digest sensitivity, and pass rejection. Exercise the
   shared association helper identically for WasmGC-shaped and linear-shaped
   artifacts with: a coexisting generic repeat, reordered counted sites,
   replacement by a site-less repeat, deleted/duplicate/unknown/forged sites,
   same-source different-owner and cross-source borrowing, wrong provider,
   wrong terminal/source, and zero/one-trip receipt rows. Extend report/merge
   tests with cloned/reparsed AST objects carrying the same canonical site so
   duplicate detection cannot regress to object identity. Re-run the existing
   B2 WasmGC and linear runtime/body-attribution suites and prove route,
   artifact, and runtime behavior remain unchanged.
6. **Review and landing discipline.** Use separate non-overlapping execution
   ownership for production/authentication code and contract/tests, followed
   by an independent read-only review of their integrated bytes. Add LOC or
   function-budget allowances only for measured irreducible growth, never
   speculatively. Before the signed commit run the explicit LOC-regrowth
   ratchet, then all normal pre-commit hooks; before the non-force push run all
   normal pre-push hooks. Every heavy command and the commit/push boundary
   requires a fresh finite non-negative one-minute load strictly below
   `logical cores - 2`. Shepherd the PR through actual merge before beginning
   C1.

##### C1 current-main implementation plan (2026-08-25)

C1 is a dormant, behavior-neutral planner checkpoint that begins only after
C0 is merged on `main`. Its implementation commit adds exactly two files:

- `src/codegen/multi-prepared-string-leaf.ts`; and
- `tests/issue-3518-multi-prepared-string-leaf-planner.test.ts`.

It must not edit `src/codegen/index.ts`, `MultiPreparedEarlyLeafRoute`, any
skip/preserve set, `prepareIrBodies`, an environment switch, or #4522's
retirement inventory. It must not allocate a Wasm function, prepare a body,
or mutate a `CodegenContext`. Those belong to C2. The checkpoint is useful as
an independently signed and reviewed local commit because it freezes the exact
proof object and fail-closed currentness contract C2 must consume instead of
growing a second recognizer in the orchestrator. It is **not** independently
publishable: the dead-export audit intentionally ignores tests, so a new
unconsumed planner module would be new production dead code. Do not add a fake
import or increase `scripts/dead-export-baseline.json`. Land this issue-plan
amendment first, create and review the two-file C1 implementation commit, then
add C2's real production consumer before the branch is pushed or opened as a
PR.

1. **Minimal dormant planner API.** Define a frozen
   `MultiPreparedStringLeafShape` containing the exact proof-owned const
   declaration closure, accumulator declaration, counted loop, `.length` read,
   return statement, and exact cached shared `IrCountedStringAppendPlan` object.
   The collector invokes shared `planCountedStringAppend` read-only for the
   exact structural loop and never rebuilds that proof. Define a
   frozen `MultiPreparedStringLeafCandidateEvidence` extending the existing
   function-value evidence with `shape: MultiPreparedStringLeafShape` retained
   by exact object identity, the entry source/source ID/declaration, the exact
   projected `IrCountedStringAppendLoweringPlan`, imported target declaration/
   source ID, and exact caller declaration/UnitId. Candidate currentness must
   re-walk the body against the retained `candidate.shape`, compare every
   structural node, symbol, and proof-owned const closure by exact identity,
   and call
   `countedStringAppendPlanIsCurrent(proofContext, candidate.shape.plan)`; it
   must not allocate a fresh shape/plan and compare those wrapper identities.
   Export only
   `collectMultiPreparedStringLeafShapes`,
   `resolveMultiPreparedStringLeafCandidate`,
   `requireCurrentMultiPreparedStringLeafCandidate`, and
   `requireCurrentMultiPreparedStringLeafSupport`, plus the exact types in
   those signatures. The collector invokes the module-private structural
   eligibility predicate; the resolver consumes collector output and rechecks
   eligibility; each `requireCurrent*` wrapper calls one module-private boolean
   currentness predicate. C2 must import every exported value through that real
   production chain, and `check:dead-exports` must report zero new rows. Do not
   export redundant boolean/assertion aliases solely for tests. The resolver input carries the current
   `CodegenContext`, entry source, `MultiPreparedFunctionValuePlan`, safe
   selection, projected lowering plans, graph safety, checker/oracle proof
   context, and a `hasForeignLateProvider(unitId)` query. It requires the exact
   same `ctx.irPlanningIdentityContext`,
   `plan.identityPlan.identityContext`, and
   `projectedLoweringPlans.identityContext` object; their source/declaration/
   UnitId forward and reverse maps must join the exact retained sources,
   declarations, units, and terminals. The selector's counted-plan map for the
   candidate UnitId must be an exact singleton containing `shape.plan`, and
   the projected counted-plan map must have the exact singleton
   `shape.loop -> candidate.loweringPlan` entry for that candidate. All return
   values are immutable and every ordinary mismatch returns
   `undefined`/`false` before mutation; currentness drift after a frozen
   candidate exists throws the shared invariant vocabulary only when the caller
   explicitly requests the invariant form.

2. **Exact structural candidate.** Admit one exported, top-level, bodyful,
   non-async, non-generator, non-generic, zero-parameter entry-source function
   with an explicit `number` result. Its body contains exactly the top-level
   immutable declarations named by the retained syntax plan's transitive
   `startConstDeclarations`, `boundConstDeclarations`, and
   `fragmentConstDeclarations` union; one `let` string accumulator declaration;
   the retained counted-string loop; and
   `return <same-symbol>.length`. Every proof-owned const shares the same
   runtime owner, resolves to the exact retained declaration/symbol, and
   lexically dominates its use and the loop. Empty proof arrays retain the
   minimal accumulator/loop/return form. Resolve symbols through the checker;
   do not accept spelling equality. Reject a missing, duplicated, nested,
   reordered-after-use, or unreferenced const as well as any other declaration,
   statement, loop, call, property read, accumulator alias/reassignment/
   capture, class, module-init/storage terminal, or derived owner. Accept the
   shared counted proof's supported `+=`, assignment, braced-body,
   nonempty-seed, identifier fragment/start/bound chains, and zero/one/two-plus
   trip shapes without copying their syntax recognizer.

3. **Identity, selection, ABI, and provenance join.** Require one exact
   source-owned, self-owned `top-level-function` terminal UnitId for the
   candidate; the declaration, identity inventory, claim, safe UnitId,
   selection, source record, `functionClaimsByUnitId`, both override maps, and
   Program ABI registry must all name that same unit. The callable is the
   unique allocated empty target with exact `[] -> f64` ABI. Scope the route
   exclusions to that candidate owner: reject its module-init selection/
   storage, class ownership, derived children, local-call or cross-file call
   component, direct caller activation target, or additional runtime
   function-value target. Evaluate foreign-late-provider evidence with the
   existing `multiIrFunctionValueLeafHasForeignLateProvider(..., true)`
   semantics so the candidate's one expected function-value target does not
   reject itself. Unrelated `main` edges, the second `helpers.ts` import, and
   helper-owned arrow support remain valid graph members and must not be
   rejected as candidate dependencies. Require exactly one selector-retained
   syntax plan and one projected
   lowering plan for the same loop. The projected plan must retain the exact
   syntax-plan object, source file/source ID/terminal owner, canonical
   `String.prototype.repeat` provider, and current C0 site. Re-run
   `countedStringAppendPlanIsCurrent` and
   `requireCurrentIrCountedStringAppendPlanSite`; a same-shaped loop, copied
   AST, borrowed site, spelling match, or map position is never authority.

4. **Exact callback and import edge.** The candidate declaration has exactly
   one value use: argument index 3 of one non-optional, non-generic,
   non-spread call with exactly four arguments. Its nearest function owner is
   the exact top-level entry-source `main` declaration, with a distinct
   self-owned terminal UnitId, explicit `() -> void`, and no safe/final IR
   selection. No stored, returned, directly-called, duplicated, aliased, or
   second-caller use is accepted. Resolve the callee with
   `resolveMultiPreparedFunctionValueImportTarget`, then additionally require
   a direct unaliased named import whose exact inventory `sourceKey` is
   `helpers.ts`, exact exported declaration name is `addBenchCard`, and exact
   distinct source/UnitId/declaration joins hold. The oracle resolves exactly
   one bodyful direct named-export declaration with zero type parameters and no
   overload siblings. Its four parameters are exactly
   `HTMLElement, string, string, () => number`; all are required and none is
   optional, rest, defaulted, or generic. Its explicit result is `void`.
   Reject suffix matches, shadowing, re-export, same-source targets, duplicate
   targets, or helper ABI drift. Candidate currentness must rerun the exact
   argument-index/four-argument/nonspread/nonoptional/nongeneric call proof,
   unaliased import declaration, source key, singleton helper declaration, and
   complete helper ABI; shared function-value-use currentness alone is not
   sufficient.

5. **Graph and allocation safety.** Reuse `buildMultiIrGraphSafety`,
   `exactAllocatedNumericCallable`, and the shared Program-ABI authorities.
   Apply target-reference and occupied-target checks to the candidate's exact
   route projection, not to unrelated functions in the two-source program.
   Reject candidate/import/caller name collisions, a foreign reference to the
   candidate outside the one callback edge, import-alias collisions, any
   occupied candidate-target count other than one, `$`-suffix slots, live
   candidate bindings, preoccupied trampoline/cache namespaces, and mismatched
   callable objects or handles. C1 may inspect the allocation state but must
   prove its own calls do not change module arrays, maps, registries,
   Program-ABI plans/locators, or selection cardinalities.

6. **Three-boundary support currentness.** Wrap rather than alias
   `functionValueSupportIsCurrent` and distinguish three exact boundaries:

   - the pre-support candidate check requires the empty target body and empty
     trampoline/cache namespaces; a mismatch is an ordinary pre-mutation
     decline;
   - immediately after `prepareTopLevelFunctionValueTargetSupport`, the
     post-support/pre-body `before-prepare` check requires the target body still
     empty and authenticates the exact frozen support receipt with
     `functionValueSupportIsCurrent(ctx, candidate, receipt, true)`. The
     support namespaces are now occupied and must not be tested for emptiness.
     At this boundary the source-callable registry observation is the Program-
     ABI authority for the target; only the trampoline/cache have session
     plans and current locators. Authenticate the exact target/handle,
     trampoline function/handle/ref/binding/one-call body, cache global/handle/
     ref/binding/type/init/mutability, unique live support names, recomputed
     support role/binding references, and reverse singleton row
     `ctx.funcClosureSingletonKeyByFuncIdx.get(targetHandle) === legacyName`.
     Any mismatch is fatal because support allocation already began; and
   - `after-direct` authenticates the same receipt and current candidate/
     callback edge with
     `functionValueSupportIsCurrent(ctx, candidate, receipt, false)` while
     permitting a bodyful target. C2 must additionally authenticate the exact
     live target body-array reference and instruction-identity snapshot; this
     boundary never treats an arbitrary nonempty body as the prepared one.

   Stable candidate currentness is separate from the pre-support eligibility
   predicate and never reruns the initial namespace-emptiness checks after
   allocation.

7. **Non-vacuous pure test matrix.** Build the full in-memory
   `website/playground/examples/benchmarks/string.ts` plus `helpers.ts` graph:
   exactly two sources, six inventory units, five terminals, both entry-source
   imports, and the one helper-owned arrow support unit. Create the real checker, identity inventory/context,
   declaration allocation, safe selection, projected C0 lowering plan, and
   Program-ABI support objects. C1 is intentionally dormant, so the test
   fixture must explicitly request counted-string proof through the same
   exported planning boundary used by the enabled single-source controls; it
   must not assume current multi-source orchestration populated the plan or
   hand-forge a lowering-plan object. Pin positive controls for a renamed
   candidate, canonical fixture, unrelated `main`/helper edges retained as
   positive evidence, all shared assignment/seed/trip-count and immutable
   fragment/start/bound declaration-chain variants, and
   unchanged module/map/registry cardinalities after every planning call.
   Mutations must reject:

   - export/body/async/generator/type-parameter/parameter/result drift;
   - extra statement/local/loop/call/property, wrong return receiver/property,
     accumulator alias/reassignment/capture;
   - missing/duplicate/detached syntax or projected plan, stale/forged/
     borrowed site/span, wrong source/owner/provider;
   - missing/swapped/non-self claims, terminals, declarations, selections,
     source records, override rows, module-init/class/derived/call-component
     ownership;
   - missing/duplicate/stored/returned/directly-called callback use, second
     caller, wrong argument index/arity, spread, optional or generic call;
   - aliased/shadowed/re-exported/same-source/wrong-sourceKey import, wrong
     helper name, duplicate target, callback-parameter or result ABI drift;
   - wrong/nested/selected caller, equal/swapped/missing UnitIds, occupied
     names/suffix keys/live bindings, target/support ABI or identity drift; and
   - unfrozen/swapped support receipt members, wrong trampoline target/body,
     cache shape, binding, locator/current index, duplicate live support names,
     and final AST/selection/safety/site drift.

   Every mutation must identify the one fact it changes, retain a positive
   sibling, and assert planner cardinalities remain zero/one as expected so an
   empty detector cannot masquerade as a pass.

8. **Checkpoint gates and C2 handoff.** Measure LOC/function growth and add
   only exact #3518 allowances if a gate proves them necessary; do not add a
   speculative `total` allowance or any dead-export baseline row. Run the
   focused planner suite, TypeScript 7 and 5, Prettier, IR
   layering/dialect/fallback, oracle/coercion/optimization, LOC and function
   ratchets. Run the LOC ratchet again immediately before a normally signed C1
   commit and run every normal pre-commit hook. Keep that signed commit local
   and obtain an independent read-only review. C2 must then import only this
   frozen planner contract, add the route union/orchestration/rollback
   inventory, prepare the target, request the exact skip, and revalidate the
   same evidence after all direct owners; C2 must not duplicate or weaken any
   C1 predicate. Only the combined C1+C2 change may run the normal pre-push
   hooks, prove the production reachability audit has zero new dead exports,
   open a ready PR, and enter the merge queue. Every heavy command and every
   commit/push boundary uses a fresh finite nonnegative one-minute load
   strictly below `logical cores - 2`.

##### C2 current-main orchestration plan (2026-08-25)

C2 begins only after C0 is on live `main` and the signed C1 two-file checkpoint
has passed independent review. It turns the dormant planner into one narrowly
default-on standalone WasmGC route. The initial production boundary is:

- extend `src/codegen/multi-prepared-string-leaf.ts` with the route and
  currentness contract;
- add only a type-level string arm to `MultiPreparedEarlyLeafRoute` in
  `src/codegen/multi-prepared-scalar-leaf.ts`;
- thread the scalar-claim exclusion into the array planner in
  `src/codegen/multi-prepared-array-leaf.ts` before its first preparation;
- orchestrate it in `src/codegen/index.ts`;
- thread the frozen pre-mutation exclusion input through
  `src/codegen/multi-prepared-fibonacci-pair.ts` to the later generic route;
- add `tests/issue-3518-bench-string-prepared-cutover.test.ts`;
- extend `tests/issue-1004.test.ts` only with the exact retained callback/
  observable-result assertions;
- update #4522's bounded-switch inventory in the same behavioral commit; and
- add a durable runtime measurement driver before changing optimization
  retirement evidence.

No `src/ir/*`, public compiler option, schema/dialect, handwritten Wasm body,
linear executable route, or second planner is in scope.

1. **Exact-loop proof injection is a prerequisite, not a global mode.** The
   current multi-source call to `planMultiIrOverlaySource` never sets
   `enableCountedStringAppendProof`, so it cannot produce C0's authenticated
   plan/receipt. C1's pure preliminary collector first proves the exact
   structural/callback/import shape and caches the exact shared
   `IrCountedStringAppendPlan`. Add a private exact-loop plan resolver/map to
   `planIrOverlay` and `planMultiIrOverlaySource`; it returns that cached object
   only when `loop === chosenLoop`. Keep the existing source-wide boolean only
   for current single-source controls. Never probe or admit another loop in the
   source, and require the projected C0 lowering plan to retain the same syntax-
   plan object.

   Run this through the ordinary multi-source planning boundary, then resolve
   the full C1 selection/ABI/site/currentness contract. If full resolution
   fails, discard the provisional proof-enabled plan reference and let late
   `compileMultiIrOverlaySource` replan with proof disabled; the near miss must
   not reach a late counted-string overlay. `planIrOverlay` may perform its
   ordinary baseline type registrations, so zero-side-effect assertions begin
   at route support/allocation and compare the failed preflight with a normal
   proof-disabled planning control. Only a fully certified exact candidate with
   the explicit string-route switch off retains the proof-enabled no-route
   state, making the ordinary late overlay deterministically yield
   `legacyBodyEmitted: true` and `irBodyEmitted: true`. Builder-off is the exact
   proof-disabled direct control.

2. **Reject overlaps before allocation.** The current
   `EarlyMultiPreparedScalarLeafState.route` and entry-source route map are
   structurally singular, so this checkpoint deliberately admits at most one
   successful early route for the one entry source. It does not widen that API
   into a multi-route container. Maintain persistent frozen claimed
   source/terminal/target snapshots. Start empty; after each successful earlier
   scalar route, derive a new snapshot without mutating the old one. Extend the
   array planner's existing resolve-then-prepare call to accept that snapshot
   and reject an overlapping private candidate after resolution but before its
   first allocation/preparation; no resolver export is required. Derive the
   next snapshot, resolve the string candidate against it before string support
   allocation, then derive the snapshot supplied to generic function-value/
   Fibonacci planning. Bench-loop participates in the same exclusivity proof
   where its source graph overlaps. Thread that input through
   `planEarlyMultiPreparedFunctionValueRoutes` in
   `multi-prepared-fibonacci-pair.ts`; it likewise checks its private resolved
   candidate before its first mutation. Candidate resolution order is scalar,
   array, string, then generic function-value/Fibonacci. A conflict discovered only while
   inserting the final route map is too late because both planners may already
   have allocated support. Once an earlier route succeeds, every later family
   must see its exclusion and decline before mutation. Positive controls prove
   scalar, array, string, and generic/Fibonacci routes independently retain
   their existing behavior in otherwise disjoint fixtures; they do not claim
   simultaneous composition within one entry source. A one-fact overlap leaves
   state byte/cardinality-equal to the earlier-route-only control, not
   necessarily to the empty pre-orchestration module.

3. **Exact early route and captured projection.** Define a frozen
   `MultiPreparedStringLeafRoute extends MultiPreparedLeafRouteBase` with
   `routeKind: "string"`, the full C1 candidate, the exact
   `MultiPreparedFunctionValueSupportReceipt`, the exact
   `PreparedCountedStringAppendReceipt`, the allocated target function, the
   exact live body-array reference, and a frozen shallow snapshot of the
   prepared instruction object identities.
   `projectIrIntegrationLoweringPlans` creates a new frozen lowering-plan
   object on every projection, so project once for the
   explicit target-only early prepared selection, resolve C1 against that
   captured object, and
   pass the same projection to `prepareIrBodies`. The preparation callback
   first asserts the selection is target-only. Its report must contain exactly
   one valid receipt whose plan object, site, source, owner, component,
   artifact, provider, and signature match the captured C0 evidence. Store that
   receipt; a structurally equal late reprojection may prove currentness but may
   not replace it.

4. **Reuse shared callback support and ordinary preparation.** Call the
   existing private `prepareTopLevelFunctionValueTargetSupport` for the exact
   `[] -> f64` target/trampoline/cache graph. That call is C2's first mutation.
   Once it begins, a missing/invalid support receipt, failed C1
   `before-prepare` check, preparation withdrawal/throw, malformed preparation
   report/receipt, skip-set mismatch, or artifact/component mismatch is an
   `IrInvariantError` with no direct retry. Call ordinary `prepareIrBodies`
   only for the target, then
   retain the exact live body-array reference plus frozen `[...body]` snapshot.
   Do not freeze the allocator-owned `WasmFunction`, its live body array, or
   instruction objects; later compilation stages legitimately mutate them.
   Never prepare or duplicate direct `main` or imported `addBenchCard`; direct `main` must call
   through the same trampoline/cache receipt. Never synthesize a provider or
   install an equivalent Wasm body by hand.

5. **Use the generic direct-body skip boundary exactly.** The existing
   `compileMultiPreparedScalarLeafDeclarations` path may consume the added
   route arm without a string-specific compiler. Require free-functions
   `requestedSkipProjection`, `skipBodies`, `preserveBodies`, and
   `completedBodies` to be exact singleton sets for the target; require
   `skippedFunctionUnitIds` to be exactly `{route.unitId}`. No class member,
   module init, implicit constructor, caller, import, or support function may
   enter the skip. The default route removes only the target's physical
   `compileFunctionBody` and `compileStatement` rows; the other 14 raw audit
   rows stay exact.

6. **Revalidate after every direct owner.** After direct body compilation and
   `finalizeMethodTrampolines`, recompute the final safe selection and require
   the C1 candidate, callback/import edge, source/UnitId, C0 site and plan
   currentness, support receipt in `after-direct`, the same live target
   body-array reference, the expected final length and per-index instruction
   object identities from the shallow snapshot, and exact skipped UnitId. Then
   call
   `completePreparedIrIntegration` and require the stored counted-string
   receipt to occur exactly once in the merged report before
   `consumeIrOverlayReport` performs the terminal audit. After support
   allocation starts, any missing, duplicate, foreign, or drifted fact is
   `IrInvariantError` with no direct retry and no target legacy rows. Ordinary
   mismatches may decline to direct only before that first mutation.

7. **One rollback switch with two distinct controls.** Add internal
   `JS2WASM_MULTI_PREPARED_STRING_CUTOVER`, default on only for
   experimental-IR, non-disabled, standalone WasmGC, non-fast, non-WASI,
   multi-source graphs. `=0` restores the two target direct rows and must retain
   the exact proof-enabled plan so the late overlay produces
   `legacyBodyEmitted: true` and `irBodyEmitted: true`.
   `JS2WASM_IR_STRING_BUILDER=0` is the true direct artifact with those two rows
   and `irBodyEmitted: false`. Add the new switch atomically to #4522's
   `retire-at-R9` table, update the live `JS2WASM_MULTI_*` count from four to
   five, and leave the separate original four `JS2WASM_IR_*` count unchanged.

8. **Focused orchestration and anti-widening tests.** Use
   `website/playground/examples/benchmarks/string.ts` and require result 5000
   with a renamed-function positive sibling. Keep
   `tests/issue-3518-counted-string-cutover.test.ts` as an anti-widening
   control: its multi-source fixture lacks the exact `addBenchCard` callback
   edge and stays direct. C2 owns mutations for selection/source/UnitId/site/
   receipt/artifact/component/body/instruction/support drift; exact skip/
   preserve/completed mismatch; callback/direct-caller/ABI drift; second
   candidate; overlap with scalar/array/bench-loop/generic-function/Fibonacci;
   and missing/duplicate/foreign post-merge receipts. Host-GC, fast, WASI,
   IR-first-off, IR-off, unsupported backends, and pre-certification shape
   mutations remain direct with zero route allocation/preparation side effects;
   ordinary proof-disabled planning registrations are the control baseline. Add
   `JS2WASM_TEST_REQUIRE_MULTI_PREPARED_STRING_LEAF=1` so every positive route
   test fails if detection is empty. Add a parsed, test-only
   `JS2WASM_TEST_TAMPER_MULTI_PREPARED_STRING_LEAF` selector over the exact
   UnitId and explicit post-certification phases (support, preparation receipt,
   skip report, post-direct currentness, and post-merge receipt). Each selector
   must match exactly once after the first mutation and prove the invariant/no-
   fallback boundary; an unmatched or multiply matched selector is itself an
   invariant.

9. **Artifact and ownership audit.** Prepared raw audit has 14 rows versus the
   direct control's 16; only target `compileFunctionBody` and
   `compileStatement` disappear. Raw and optimized output preserve exports,
   imports, DTS/import helper, string pool, callback behavior, and Program-ABI
   source/target/trampoline/cache joins without pinning numeric slots. Resolve
   call targets structurally. The target WAT contains one aggregate repeat and
   one concat, no counted loop, dynamic carrier, externref round trip, boxing,
   per-iteration call/allocation, AST dispatcher, or duplicate repeat/concat.
   Host-string WasmGC, native-string WasmGC, and linear must continue lowering
   the same in-memory v5.3 instruction through their authenticated providers;
   C2 makes no linear serialization/cutover claim. Compare the optimized
   Prepared artifact to the contemporaneous builder-off direct artifact:
   Prepared optimized bytes, resolved helper/provider call census, and
   allocation census must each be no greater than direct. Use no unrelated
   #4035 size ceiling or historical binary baseline. Raw binary difference is
   observational only; resolved structural call/allocation targets are the
   acceptance authority.

10. **Runtime and retirement evidence are a later signed checkpoint.** Existing
    runtime scripts do not satisfy this issue's protocol. Add a durable driver,
    preferably `scripts/measure/bench-string-ir-runtime.mts`, that launches
    fresh identical memory-capped processes in interleaved ABBA order, retains
    every sample, collects at least 30 valid samples per arm, brackets with a
    contemporaneous direct/direct control, and publishes the paired median plus
    a 95% bootstrap interval. Every child launch enforces a finite nonnegative
    one-minute load strictly below `logical cores - 2`. Direct/direct deviation
    above 5%, Prepared/direct median above 1.05, or interval upper bound above
    1.10 fails closed.

    Do not mark `IR-OPT-COUNTED-LITERAL-STRING-APPEND` retirement-ready in the
    compile-once PR. Only after complete semantic, output, and runtime evidence
    may its owner move from `containsCountedLiteralStringAppend` to the actual
    executable lowerer (expected `from-ast.ts::lowerPreparedCountedStringAppend`)
    in `plan/log/ir-optimization-retirement-ledger.md` and set
    lowering/complete/retirement-ready. At that point, and only then, update
    `tests/issue-3792-ir-optimization-retirement-gate.test.ts` to the measured
    totals of 50 rows, 37 complete, and 4 ready. Neither evidence file belongs
    to the compile-once C2 commit.

11. **C2 landing discipline.** Run the new route/anti-widening suites, the
    unchanged prior scalar/array/bench-loop/Fibonacci controls, TypeScript 7 and
    5, Prettier, dead-export, IR layering/dialect/fallback, oracle/coercion/
    optimization, LOC, and function-growth ratchets. Before every heavy command
    and commit/push boundary, require a fresh finite nonnegative one-minute load
    strictly below `logical cores - 2`. Run `pnpm run check:loc-budget` again
    immediately before the normally signed C2 commit. Run all normal precommit
    and prepush hooks without `--no-verify` or a skip environment. Push only the
    combined C1+C2 branch after its independent read-only review, then open a
    ready PR and shepherd it through the merge queue.

#### Acceptance and non-vacuous controls

Add `tests/issue-3518-bench-string-prepared-cutover.test.ts` and extend
`tests/issue-1004.test.ts`. At minimum the focused evidence must prove:

- default-on direct-body poison succeeds with zero target legacy rows, one
  self-owned `terminal-ir` disposition, `legacyBodyEmitted: false`,
  `irBodyEmitted: true`, a nonempty prepared component, and one authenticated
  repeat provider;
- the rollback matrix is exact and non-conflated: string-route-off with the
  builder enabled restores the two physical direct rows but still permits the
  late IR overlay (`legacyBodyEmitted: true`, `irBodyEmitted: true`), while
  `JS2WASM_IR_STRING_BUILDER=0` is the true direct artifact with those rows and
  `irBodyEmitted: false`. Both execute the direct body and therefore make the
  same direct-body poison fail. Use builder-off, not route-off, for the
  direct/Prepared artifact and runtime A/B;
- raw and optimized direct/Prepared artifacts instantiate and return **5000**,
  preserve callback invocation and all public/import/DTS/string-pool surfaces,
  and retain exactly one aggregate repeat plus one concat with no counted loop;
- the Prepared target uses no dynamic carrier, externref round trip, boxing,
  per-iteration allocation/call, AST method dispatcher, or second repeat/concat;
- host-string WasmGC, native-string WasmGC, and linear each lower the same
  in-memory v5.3 `string.repeat` instruction through their authenticated
  provider; clone/digest/provider/signature tamper fails before artifact side
  effects, and no executable serialization claim is made unless that separate
  substrate lands;
- cross-backend intrinsic tests exercise negative fractions, negative
  integers, `+Infinity`, `NaN`, `-0`, zero, one, and a positive fraction, plus
  the required `"".repeat(-1)` ordering where validation happens before the
  empty-receiver fast path. Unused throwing results must survive DCE, and an
  observable effect before/after repeat must retain order across optimization;
- zero/one/inclusive/nonzero-start, `+=`, braced body, immutable identifier,
  and nonempty seed cases retain exact semantics and expected aggregate
  shapes. Non-ASCII fragments must pass WasmGC semantic/output-shape coverage;
  linear currently accepts only authenticated ASCII string-runtime evidence,
  so non-ASCII must produce a typed linear incapability unless an explicit
  encoding-widening transaction lands; and
- counter-dependent/prepend/self-fragment, multi-statement, dynamic or unsafe
  bound, non-unit/decreasing update, alias/reassignment/capture/getter/call,
  extra candidate/caller, callback source/ABI drift, provider/allocator/plan
  tamper, class/module-init, an unexpected candidate-owned cross-file call
  component, fast, WASI, IR-disabled, and unsupported backend mutations decline
  before skip or fail with typed pre-emission evidence.

The optimization ledger row `IR-OPT-COUNTED-LITERAL-STRING-APPEND` becomes
retirement-ready only after semantic, output-shape, and paired runtime evidence
are recorded. Output evidence must compare structural helper/provider calls,
not unstable numeric function indices. Runtime evidence uses fresh, identical
memory-capped processes in an interleaved **ABBA** schedule with at least 30
valid samples per arm and a contemporaneous direct/direct bracket. Publish all
samples, the paired median Prepared/direct ratio, and a 95% bootstrap interval.
Fail closed if the direct/direct median drifts beyond 5%, if the Prepared/direct
median exceeds 1.05, or if its interval's upper bound exceeds 1.10; no speedup
claim follows from merely clearing those regression limits. Every launch uses
the strict finite, nonnegative one-minute load gate
`load < logicalCores - 2`; on an eight-logical-core host the limit is `< 6`.
An environmental gate abort is diagnostic evidence, never a retryable PASS.

Run the focused #1004 and #3518 suites, prior string-builder/owned-append/
concat-batching suites, array/Fibonacci/bench-loop route suites, standalone
floor, IR layering/oracle/optimization ratchets, typecheck/lint/format, and the
WasmGC/linear cross-backend matrix. Full merge-group Test262 must be
net-non-negative in JS-host and standalone with complete outcome/fatal-error
accounting. The implementation checkpoint must publish exact test counts,
route/audit denominators, artifact hashes and shapes, runtime samples, provider
receipts, and signed issue/evidence locks before this section may claim
`bench_string` compile-once. The direct #1004 handler remains the required
`JS2WASM_IR_STRING_BUILDER=0` control throughout hybrid operation. It can be
deleted only after R9 removes that switch and #3792 plus the refreshed #3090
R10 audit prove the handler unreachable across the full supported denominator.

#### C2a implementation checkpoint: exact `bench_string` compile-once route (2026-08-27)

The first executable C2 checkpoint now consumes the merged C1 proof for the
exact two-source `string.ts` / `helpers.ts` graph. It injects only C1's
identity-bearing counted-loop plan into multi-source overlay planning, prepares
`bench_string` through `prepareIrBodies`, authenticates its callback support and
counted-string receipt, and routes its exact singleton body skip through
`MultiPreparedProgramOwner`. The owner now carries a frozen cross-family claim
ledger in scalar → array → string → function-value/Fibonacci order, so an
overlap declines before the later family's first allocation.

The route is default-on behind
`JS2WASM_MULTI_PREPARED_STRING_CUTOVER`; `=0` restores exactly the target's
`compileFunctionBody` and `compileStatement` rows while retaining the late IR
overlay. The stored counted-string receipt must occur exactly once in the
merged report before terminal consumption. Target body identity is sealed at
the preparation, post-direct, post-overlay-consumption, post-trampoline, and
pre-publication boundaries so legitimate whole-module rewrites are captured
only at their named boundary and any subsequent drift fails closed.

Focused evidence in
`tests/issue-3518-bench-string-prepared-cutover.test.ts` proves the default-on
route survives a direct-body poison with zero target legacy rows, proves the
rollback lane restores both physical rows with
`legacyBodyEmitted: true` / `irBodyEmitted: true`, and separately proves the
poison still fires on that direct lane. The unchanged whole-program owner
census passes alongside it. Prepared and route-off artifacts retain the same
Wasm import/export surface, DTS, compiler import manifest, and string-pool
membership, instantiate through the shared runtime harness, and both return
`5000` from `bench_string`. C1 remains a separately merged 71-test proof
checkpoint; this change does not duplicate its planner predicates.

This checkpoint does not claim the later runtime/optimization-retirement
transaction. The expanded mutation matrix, builder-off artifact comparison,
durable 30-sample ABBA runtime driver, optimization-ledger promotion, and final
R9 switch deletion remain follow-up evidence and must not be inferred from the
compile-once route landing.

#### C2b checkpoint: true-direct control and phase-addressed fail-closed evidence (2026-08-27)

The first follow-up closes a control-path defect exposed by the C2a landing.
`JS2WASM_IR_STRING_BUILDER=0` correctly rejected the counted builder in the
structural selector, but early multi-source orchestration still injected C1's
counted-string proof into the legacy-name projection. The late overlay then saw
`bench_string` in the compatibility selection without a matching structural
owner and failed `selection-preparation-mismatch` instead of producing the
required direct artifact. Early orchestration now withholds every string shape
and proof when the builder switch is disabled. The resulting artifact has the
two physical target legacy rows, a typed `string-builder-candidate` outcome,
`legacyBodyEmitted: true`, `irBodyEmitted: false`, and returns `5000`.

The string route also gains the parsed test-only
`JS2WASM_TEST_TAMPER_MULTI_PREPARED_STRING_LEAF` selector. Its JSON object must
contain only the exact target `unitId` and one explicit phase: `support`,
`preparation-receipt`, `skip-report`, `post-direct-currentness`, or
`post-merge-receipt`. Each phase corrupts a distinct authenticated record after
the route's first mutation. Every corruption fails invariantly with zero target
legacy rows; malformed or foreign selectors are themselves invariants, and the
route requires an armed selector to match exactly once. This turns the C2a
currentness checks into executable no-fallback evidence rather than relying on
their success path alone.

Focused raw and optimized A/B coverage now uses builder-off—not route-off—as
the direct control. Both artifacts preserve the target UnitId, all non-target
legacy audit rows, imports/exports, DTS, and string-pool membership, and both
instantiate and return `5000`. The route-off lane remains separately covered as
the rollback control with `legacyBodyEmitted: true` and `irBodyEmitted: true`.

This checkpoint deliberately does **not** promote
`IR-OPT-COUNTED-LITERAL-STRING-APPEND`. The first corrected optimized A/B on the
current arm64 host measured 130,595 bytes Prepared versus 130,308 bytes direct:
Prepared is 287 bytes larger, so the no-growth output gate is not yet met. The
next implementation transaction must:

1. attribute and remove that target/provider overhead while preserving the
   generic `string.repeat` validation matrix and the counted-plan receipt;
2. lock structural target helper/provider calls and allocations at direct or
   better, without numeric function-index assertions;
3. add and run the durable 30-valid-sample ABBA driver with the 5% direct/direct,
   1.05 median, and 1.10 bootstrap-upper-bound gates; and
4. only after all three evidence classes pass, promote the optimization ledger
   row and synchronize the measured #3792 totals.

The broader syntax/provider mutation matrix and final R9 switch deletion remain
separate follow-ups. No performance, retirement-ready, linear cutover, or
repository-wide IR-only claim follows from this checkpoint.

#### C2c checkpoint: authenticated counted-native repeat provider (2026-08-27)

The accepted-output regression is removed without weakening generic
`String.prototype.repeat`. IR format v5.4 adds the optional
`countedStringAppendTripCount` proof to `string.repeat`. Production from-AST
lowering emits it only for the exact checker-retained counted-loop trip count in
the signed-i32 range. The verifier requires a matching source-qualified
`countedStringAppendSite`, an integer in `[2, 2147483647]`, and an exact f64
constant definition for the instruction's `count` SSA value. The fragment is
canonicalized from the checker-proven literal/const-alias chain to an exact
`string.const`; its UTF-16 length times the trip count must stay at or below the
native kernel's `0x40000000` result bound. Final provenance association joins
the same trip count and fragment back to the retained syntax plan. Missing,
borrowed, out-of-range, non-constant, non-literal, oversized-result, and
provider-without-proof variants fail closed.

Native WasmGC preparation maps only that authenticated form to
`__ir_string_repeat_counted_native`, whose physical provider is the existing
`__str_repeat (string, i32) -> string` kernel. Lowering performs the proven-safe
`i32.trunc_f64_s` conversion at the call site. It does not materialize the
generic `__ir_string_repeat_native (string, f64) -> string` validation adapter.
Site-less repeats, out-of-i32-range counted repeats, host strings, and the linear
backend retain the generic f64 provider and its complete ToIntegerOrInfinity /
RangeError behavior. Adapter-manifest string-pool metadata remains byte-for-byte
compatible with direct output even though the counted artifact has no dead
RangeError path.

On the current arm64 host, the accepted raw and requested-`optimize: 4`
artifacts both measure **130,062 bytes Prepared versus 130,308 bytes direct**:
Prepared is now **246 bytes smaller** and 533 bytes smaller than C2b's 130,595
byte artifact. Both accepted binaries pass `WebAssembly.validate`, preserve DTS,
imports/exports, string-pool membership, target UnitId, non-target route rows,
and return `5000`. Named WAT evidence contains `__str_repeat`, contains no
`__ir_string_repeat_native`, uses non-saturating `i32.trunc_f64_s`, and reduces
the target's static call count from four to two with no increase in target
`array.new` or `struct.new` operations. The focused verifier/provider/contract,
cutover, and phase-tamper suites pass 36/36, and the TypeScript 7 typecheck
passes.

The no-growth and structural output gates are therefore met. Promotion of
`IR-OPT-COUNTED-LITERAL-STRING-APPEND` remains withheld until the durable
30-valid-sample ABBA runtime driver satisfies the existing 5% direct/direct,
1.05 median, and 1.10 bootstrap-upper-bound gates. The broader syntax/provider
mutation matrix and final R9 switch deletion remain later transactions.

#### C2d checkpoint: durable counted-append runtime gate (2026-08-27)

This checkpoint began only after C2c was live on `main`. Add the discoverable
`benchmark:bench-string-ir-runtime` command around
`scripts/measure/bench-string-ir-runtime.mts` and lock its pure protocol helpers
in `tests/issue-3518-bench-string-runtime-driver.test.ts`. Compile the C2c
builder-off direct and Prepared artifacts once, authenticate their exact route
ownership and matching Wasm surface, then execute every timed launch in a fresh
Node process with a 512 MiB old-space cap, explicit GC, warmup, artifact digest
verification, and the exact `bench_string() === 5000` oracle.

Each of 30 rounds brackets one adjacent direct/Prepared candidate pair with
fresh direct controls. Candidate order alternates AB then BA, producing exact
D/P/P/D blocks across each two-round pair. A fresh finite, nonnegative
one-minute load observation must be strictly below `logicalCores - 2` inside
every child before setup. The first load or worker failure aborts without retry
and retains all completed launches as diagnostic evidence. The completed run
must publish all 120 launch records, 30 paired Prepared/direct ratios, 30
direct/direct bracket ratios, artifact hashes and sizes, process memory, the
paired medians, and the deterministic 10,000-resample 95% bootstrap interval in
`benchmarks/results/ir/3518-bench-string-runtime.json`.

The first v1 execution is retained separately as
`benchmarks/results/ir/3518-bench-string-runtime-aborted-v1.json`. It completed
14 rounds / 56 launches before the next child observed load 6.325 against the
strict `< 6` threshold and aborted exactly as designed. That run also exposed
a harness defect before any retirement claim: each fresh child re-imported
`tsx`, the compiler, and the full runtime, reporting roughly 376–559 MiB RSS
and driving the host over its own gate. Protocol v2 replaces that setup with
`scripts/measure/bench-string-ir-runtime-worker.mjs`, a plain-Node worker that
loads only the signed Wasm artifact and Node built-ins. It rejects every
non-function import and installs throwing stubs for function imports, so the
timed `bench_string` path cannot silently depend on host setup. The v1 abort is
diagnostic evidence and is not retried or reclassified; v2 is a materially new
protocol whose complete run must still satisfy every unchanged gate above.

Only a report whose direct/direct median deviation is at most 5%, whose
Prepared/direct median is at most 1.05, and whose bootstrap upper bound is at
most 1.10 may promote `IR-OPT-COUNTED-LITERAL-STRING-APPEND`. On that same
signed checkpoint, move its owner to
`src/ir/from-ast.ts::lowerPreparedCountedStringAppend`, mark lowering/complete
and all three evidence classes verified, set `retirementReady: true`, and
synchronize the live #3792 totals to 50 rows, 37 complete, and 4 ready. Clearing
the bounds proves runtime parity/no regression, not a speedup. It does not
delete the direct handler, retire the builder switch, close #3518, or make a
repository-wide IR-only claim; those remain gated by R9 and the refreshed R10
reachability audit.

Protocol v2 completed all 30 rounds / 120 launches against merged revision
`8c0033daa50f8d08a49976500e4f62e1440882ce`. Every launch observed load in
`[3.2383, 3.2988]` against the strict `< 6` threshold, returned the exact
5,000,000 accumulated checksum, and reported RSS in `[58,556,416, 59,031,552]`
bytes. The direct artifact is 130,308 bytes with SHA-256
`3cbc410df50905b51a6a269fb152a037fea767e6ce06a41e07e047720e4f60aa`;
Prepared is 130,062 bytes with SHA-256
`dd45e84b55933ffa5587d27e1640a2d389db03c48b65b648977f2bfaa5fde3a5`.

The direct/direct median is 1.002100 (0.210% deviation). The paired
Prepared/direct median is 0.986557 and its deterministic 10,000-resample 95%
bootstrap interval is `[0.971562, 0.988501]`. All three fail-closed limits pass,
so the ledger row now names the executable lowerer, marks semantic/output/
performance evidence verified, and becomes the fourth retirement-ready row.
This is parity/no-regression evidence only. The direct handler and builder
switch remain live controls until R9 and the refreshed R10 reachability audit.
The driver/ledger suites pass 22/22, both TypeScript 7 and TypeScript 5 pass,
and repository lint and formatting checks are green.

#### C2e checkpoint: contract the temporary C1 dead-export baseline (2026-08-27)

PR #4982 merged the dormant C1 planner together with 29 entries in
`scripts/dead-export-baseline.json`, despite this plan's explicit requirement
that C1 remain unpublished until a real production consumer made the complete
planner graph reachable. The subsequent C2a–C2d checkpoints now provide that
consumer through `multi-prepared-callable-orchestration.ts` and
`multi-prepared-program.ts`; retaining the exemptions would hide genuine
retirement progress and weaken the #3090 denominator.

On live `main` `db872cf39ffcda8775fa11b0385c896337ab611e`,
`pnpm run check:dead-exports` reports exactly **29 baseline entries gone**, all
from `src/codegen/multi-prepared-string-leaf.ts`, with 23 unrelated known rows
remaining and zero new rows. Remove those exact 29 string-leaf entries now.
This cleanup changes no source, test, route, artifact, optimization evidence,
or runtime behavior; it merely makes the baseline match the production
reachability already proved by C2.

Acceptance is a clean dead-export check with 23 known entries, zero new rows,
and no stale-baseline progress notice, plus formatting, issue integrity, LOC
and function ratchets, and the normal unskipped precommit and prepush hooks.
Do not remove or reclassify any of the remaining 23 rows in this checkpoint.

## 2026-09-02 — R9 coverage-closure gap, measured

The ladder gap noted above ("R9 needs an explicit coverage-closure dependency")
now has a number attached. It was measured, not inherited from an artifact.

`pnpm run check:ir-only` reports **READY** on `main`. That verdict is real but
it is scoped to five entry files hardcoded at `scripts/check-ir-only.ts:14-20`,
and the script's own comment already says so: *"Wider compiler reachability
remains a separate R9/R10 requirement."* The playground directory it draws from
holds **thirteen** `.ts` entries. The other eight have never been in the gate.

Running the gate's own lane observers over those eight (they accept an entries
override, so no compiler change was needed):

| | gate corpus (5 files) | uncovered (8 files) |
| --- | --- | --- |
| terminal units, single-host | 41 | 32 |
| `emitted` | 38 | 16 |
| `unsupported` | **0** | **8** (7 `@select`, 1 `@build`) |
| legacy body emitted | **0** | **10** |
| terminal units, standalone | 41 | 32 |
| `emitted` | 38 | 10 |
| `unsupported` | **0** | **14** (all `@select`) |
| legacy body emitted | **0** | **14** |

Every one of the eight files has at least one unsupported unit on both lanes;
`benchmarks.ts` and `benchmarks/helpers.ts` have three each on standalone. So
this is not one exotic file dragging a corner — the rejection is spread across
the whole uncovered population.

Three things follow that change what R9 has to do:

1. **The denominator is not 5, and widening it flips the verdict.** Adding the
   eight to the gate takes it from READY to NOT READY with 10 (single-host) /
   14 (standalone) direct-body emissions to retire first. R9's fail-closed flip
   cannot be scheduled off the current READY.
2. **Standalone is the harder lane by a factor, and the gap is growing in the
   direction R10 cares about.** 14 unsupported vs 8, and 10 emitted vs 16. The
   DOM-touching entries (`dom.ts`, `style.ts`, `helpers.ts`) reject wholesale on
   standalone while emitting on single-host.
3. **Two single-host units emit BOTH a direct body and an IR body** — the
   literal compile-once violation, distinct from a clean rejection. They are the
   only units in the population carrying an `r2Withdrawal` record, and it reads
   `stage: "not-attempted", reason: "late-feature-preparation"`. Every other
   legacy-emitting unit has **no withdrawal record at all**, because it never
   reached R2 admission — it was rejected at `select`. R2 withdrawal telemetry
   (#3521, landed in #5486) therefore does not explain this population, and a
   census that reads only withdrawal reasons will report an empty histogram and
   look clean. That is a trap worth naming for whoever runs the full census.

### Reproducing

The gate exports `observeSingleHostLane(entries?)` / `observeStandaloneLane(entries?)`,
both of which take an entry-list override. A scratch script that calls them with
the eight uncovered paths and histograms `kind`, `kind@stage`, `legacyBodyEmitted`
and `irBodyEmitted` reproduces the table above. Put it in `.tmp/`.

**One correction worth carrying, because it cost a wrong reading here:** the
outcome field is `kind`, not `status`. A probe that filters on
`o.status === "unsupported"` returns **zero** for every lane and every file,
which reads as "nothing is rejected, everything silently falls back" — the
opposite of the truth. And `legacyBodyEmitted` / `irBodyEmitted` are **not
mutually exclusive**: a unit can carry both, which is precisely the compile-once
violation in item 3. Tallying them as if they partitioned the units
double-counts and hides that case.

### What this does not settle

The playground is still not the whole compiler. Thirteen entry files is the
bounded population this gate was built around; the true R9 denominator is the
standalone corpus plus whatever #4522's `retire-at-R9` table enumerates. This
measurement closes the gap between "5 files" and "the playground", which is the
first step, not the last. The remaining question for the full census is what the
denominator is beyond `website/playground/examples/`.

### The denominator beyond the playground — dogfood corpus, measured

The section above closed "five files → the playground" and left open what the
denominator is beyond `website/playground/examples/`. Measuring the next
corpus out — `tests/dogfood/corpus`, 20 real JS programs, directly R10-relevant
because dogfooding is what "the compiler compiles itself" means:

| | playground gate (5 `.ts`) | dogfood (20 `.js`) single-host | dogfood standalone |
| --- | --- | --- | --- |
| terminal units | 41 | 35 | 35 |
| IR bodies emitted | **38** | **1** | **0** |
| unsupported | 0 | 33 (`@select`) | 31 (30 `@select`, 1 `@build`) |
| legacy bodies | 0 | 33 | 31 |
| entries compiling clean | 5/5 | 18/20 | 18/20 |

The IR path covers ~100% of the gate's corpus and **1 of 35 units** on the
dogfood corpus (0 on standalone). The two entries that fail outright
(`destructuring.js`, `objects.js`) do so with a fatal diagnostic on both lanes.

**A hypothesis worth stating because it was tested and refuted.** The obvious
explanation is that the dogfood files are untyped `.js` while the gate corpus is
annotated `.ts`, and the known IR fallback vocabulary has three type-resolution
buckets. If that were the cause, type reasons would dominate. They do not —
exactly **one** of 33 rejections is `return-type-not-resolvable`. The histogram:

| reason | single-host | standalone |
| --- | --- | --- |
| `body-shape-rejected` | 19 | 16 |
| `class-member-unsupported` | 4 | 4 |
| `class-projection-unsupported` | 2 | 2 |
| `class-method` | 1 | 1 |
| `static-class-initialization` | 1 | 1 |
| `destructuring-param-complex` | 1 | 1 |
| `async-function` | 1 | 1 |
| `async-generator` | 1 | 1 |
| `operand-coercion-unsupported` | 1 | 1 |
| `param-shape-rejected` | 1 | 1 |
| `return-type-not-resolvable` | 1 | 1 |
| `imported-call-planning-unsupported` | — | 1 |

So the wider denominator is gated on **body shape (≈58%) and class coverage
(8 units across four class reasons)** — that is R3 (#3522) territory plus the
`body-shape-rejected` bucket the IR fallback budget already flags as
*unintended* — and **not** on type propagation. A plan that widens the corpus by
improving TypeMap propagation first would be optimising the 1, not the 19.

**Consequence for the ladder.** R9's fail-closed flip is not a small step past
the current READY. On the corpus that matters most for R10, IR adoption is
effectively at zero, and the blocking reasons are the same unintended buckets
#2855 is already ratcheting. R9 should take an explicit dependency on
`body-shape-rejected` and the class family reaching zero on a corpus wider than
the playground, not merely on the current gate staying green.

**Still not settled:** dogfood is 20 files. Neither it nor the playground is the
full standalone denominator, and #4522's `retire-at-R9` table has not been
cross-checked against either. Both numbers above are floors on the work, not the
total.

#### Correction to the section above: the blocker is module-init (R4), not class coverage (R3)

The table above attributed the wider-corpus gap to "body shape (~58%) and class
coverage — R3 (#3522)". **The class half of that is wrong, and the body-shape
half was true but uninformative.** Splitting `body-shape-rejected` by unit kind:

| | count |
| --- | --- |
| `body-shape-rejected` on `<module-init>` | **17** |
| `body-shape-rejected` on ordinary functions | 2 (`exportedFn`, `Ctor`) |

So the largest bucket is not scattered function-body shapes at all. It is one
unit kind, once per file. Grouping every dogfood rejection by unit kind makes
the split plain:

| lane | module-init units | of those, unsupported | non-module-init unsupported |
| --- | --- | --- | --- |
| single-host | 20 | **19** (17 body-shape, 1 static-class-init, 1 operand-coercion) | 14 |
| standalone | 20 | **16** (14 body-shape, 1 static-class-init, 1 operand-coercion) | 14 |

**Module-init adoption on this corpus is zero of twenty executable units, on
both lanes.** That is R4 (#3523, module-init compile-once), not R3. The class
family accounts for 7 of 33 single-host rejections, real but a third the size.

**And this explains why the gate is green rather than merely narrow.** Its five
entries hold five module-init units: 2 emitted, **3 non-executable**, 0
unsupported. A non-executable module-init has no body by construction, so the
gate exercises module-init on exactly two files. The corpus is not just small —
it is unrepresentative in precisely the dimension that dominates everywhere
else.

**Revised consequence for the ladder.** R9's coverage-closure dependency is
first and foremost **R4**. Widening the corpus without module-init compile-once
converts ~58% of the single-host gap and ~45% of the standalone gap into
permanent red. The class family is the second dependency, not the first.

**Method note, since this is the second time in one session the same mistake
shape appeared.** The previous section read a reason histogram and named an
owner from the reason label alone. `body-shape-rejected` is raised from many
sites spanning entirely different constructs, so the label identifies a *demote
path*, not a *feature area*. Grouping by `unitKind` — one extra field already
present in the telemetry — moved the conclusion from the wrong lane to the right
one. Any future census over these outcomes should group by `unitKind` before
assigning an owner.

**Precision correction to the sentence above, added after tracing it.** An
earlier draft pointed at "~20 sites in `src/ir/from-ast.ts`". Those sites are
`demoteToLegacy` calls, and `demoteToLegacy` throws at stage **`build`**
(`src/ir/outcomes.ts:213`). Every module-init rejection measured here is stage
**`select`**, so it comes from `src/ir/select.ts` instead — sending a reader to
`from-ast.ts` for these would cost them the search. The per-arm breakdown is
obtainable with `JS2WASM_IR_SHAPE_DIAG=1` and no source edit (the #2856 Step-1
reject-arm recorder), and is recorded on `#3523`.

### CORRECTION — "R4 first" was generalised from one corpus; it does not hold on the other

The sections above concluded that R9's coverage-closure dependency is R4. That
conclusion was drawn entirely from `tests/dogfood/corpus`. Measuring the
**playground's own uncovered eight** with the same instruments refutes the
generalisation:

| | dogfood (20 `.js`) | playground-uncovered (8 `.ts`) |
| --- | --- | --- |
| module-init units | 20 | 8 |
| module-init **non-executable** | 1 (sh) / 4 (sa) | **8 / 8 — all of them** |
| module-init unsupported | 19 (sh) / 16 (sa) | **0 / 0** |

**On the playground's uncovered files, module-init is not a blocker at all** —
every one of the eight has no executable module-init body. Their blockers are
elsewhere entirely:

| corpus / lane | dominant blocker | count | plausible owner |
| --- | --- | --- | --- |
| dogfood, both lanes | module-init `vardecl-module-storage-unrepresentable` | 11 sh / 9 sa | R4 (#3523) |
| playground-uncovered, single-host | function `expr-ident-not-in-scope` | 7 of 8 | not R4 |
| playground-uncovered, standalone | **`host-surface-unavailable`** | **12 of 14** | R6 (#3526), standalone surface |

So `body-shape-rejected` is not even the leading reason on the playground's
standalone lane — `host-surface-unavailable` is, by 12 to 1.

**What is actually established, stated at the strength the evidence supports:**

- R4 is a real and severe blocker **on module-bearing sources**: zero of twenty
  executable module-init units on dogfood, on both lanes. That stands.
- R4 is **not** established as R9's universal first dependency. The two corpora
  disagree because they differ structurally in exactly the dimension the
  conclusion keyed on: playground examples are browser scripts whose module-init
  is non-executable, dogfood files are modules with real top-level code.
- R9's denominator needs the **union**, so R4 (module-bearing sources) and the
  standalone host surface (R6) are both dependencies. Their relative weight is
  **unknown** until a corpus representative of the real target population is
  defined — which is the open question the census was for, and it is still open.

**Method, since this is the failure I named two sections earlier and then
committed myself.** That note said a reason label identifies a demote path, not
a feature area, and to group by `unitKind` before assigning an owner. I did
group by `unitKind` — and then generalised from a single corpus without checking
the second, which was one probe away and already on the list of things I had
flagged as unchecked. Grouping correctly does not rescue a sample of one. The
standing instruction should be: **name the corpus in the claim, and do not
promote a per-corpus finding to a ladder dependency until a second corpus
agrees.**

### The standalone half is a target/corpus mismatch, not compiler work — third correction

The correction above concluded that R4 and "the standalone host surface (R6)"
**both** gate R9, on the strength of `host-surface-unavailable` being 12 of the
playground-uncovered standalone lane's 14 rejections. Measuring what those 12
actually name weakens the second half considerably.

All 12 are **DOM**, and `document` is the *only* host global named anywhere in
those eight files — 18 occurrences, and zero `window`, `navigator`, `fetch`,
`localStorage` or `console`. Concretely they are `document.body`,
`document.createElement`, `.innerHTML`, `.style.cssText` and `.appendChild`.
Even `benchmarks/fib.ts` — an otherwise pure-math file — has its `main`
rejected, because `main` renders its result into the page:

```ts
export function main(): void {
  const host = document.body;          // ← the rejection
  host.innerHTML = "";
  …
}
```

`main` is 7 of the 12; the rest are `bench_dom`, `bench_style` and `el`.

**Why this is not R6 work in the ordinary sense.** These are browser demo
programs whose entire purpose is to render to the page, compiled for the
**standalone** target, which by definition has no JS host and therefore no DOM.
A standalone build of a DOM-rendering demo is close to a contradiction in terms;
`select.ts:203-204` already says this reason is owned by "the target's
capability policy, not by IR shape coverage". The compiler is not failing to
lower something it should lower — the corpus is asking a host-free target for a
host surface. Note the machinery for the tractable part already exists: #4576's
`standaloneDomOperation` certifies `document.body` and a registered
`document.createElement(tag)`; these 12 are the uses outside that certified
slice.

**Consequence, and it is a correction to the section above.** The playground's
uncovered eight are a **poor standalone denominator**, not evidence of an R6
gap of comparable weight to R4. Two things follow for whoever defines the real
R9 denominator:

1. Standalone conformance should be measured on programs that could plausibly
   *be* standalone. Counting DOM demos against the standalone lane inflates the
   apparent gap with work nobody intends to do.
2. R4 therefore looks stronger, not weaker, as the leading dependency — but
   note this is now the **third** framing of that question in one session, and
   the honest summary is that the ordering is only as good as the corpus. The
   dogfood corpus (module-bearing, host-free) is the better standalone
   population of the two measured here, and its blocker is R4.

**What is still unmeasured:** neither corpus was chosen to represent the R9
target population, and #4522's `retire-at-R9` table has still not been
cross-checked against either. Until that is done, every weight in this section
is a floor on one sample, not an apportionment.

### R9-D1 — implementation plan: put the dogfood corpus under CI as a `baseline` lane

Everything measured above is invisible to CI. `check:ir-only` reports READY on
five files and nothing watches the rest, so the gap this session found can widen
again with no signal. The gate already has the mechanism to fix that without
turning anything red — `IrOnlyLaneReadiness` (`scripts/check-ir-only.ts:48-58`):

> `"baseline"`: the lane is measured and ratcheted against its committed
> floors/ceilings, but is not asserted to be IR-only. Every anti-vacuity,
> telemetry-consistency, invariant, and baseline check still applies; only the
> compile-once assertions are withheld.

That is exactly the shape needed: measure the honest gap, ratchet it so it
cannot regress, and defer the compile-once assertion until R4 and R6 close it.
`STANDALONE_ENTRIES` was itself in this mode until #4577 (the comment at `:22-27`
records the promotion), so there is precedent in this file for both directions.

**Contract.**

1. Add `DOGFOOD_ENTRIES` — the 20 `.js` files under `tests/dogfood/corpus`.
   Enumerate them explicitly rather than reading the directory: a glob makes the
   lane's denominator move when someone adds a corpus file, which is the
   silent-baseline-drift failure this gate exists to prevent.
2. Add two lanes via the existing `observeLane` — `dogfood-single-host` and
   `dogfood-standalone` — both `readiness: "baseline"`.
3. Seed their floors/ceilings with `--policy=hybrid --update`. Today's measured
   values, which the seed must reproduce or the lane is mis-wired:

   | lane | entries | terminal units | emitted | unsupported | non-executable | IR bodies | legacy (real) |
   | --- | --: | --: | --: | --: | --: | --: | --: |
   | `dogfood-single-host` | 20 | 35 | 1 | 33 | 1 | 1 | 7 |
   | `dogfood-standalone` | 20 | 35 | 0 | 31 | 4 | 0 | 8 |

   **These replace an earlier version of this table that was wrong in four
   columns.** It carried `16 / 8 / 10` and `10 / 14 / 14` for emitted /
   unsupported / legacy — those are the **playground-uncovered** figures, pasted
   under dogfood labels; only `terminal units` and `IR bodies` were right. An
   implementer following it would have seeded floors that describe a different
   corpus, and the lane would then ratchet against fiction — the precise failure
   a baseline gate exists to prevent. Re-measured directly for this table.

   The `legacy (real)` column counts `legacyBodyEmitted === true &&
   directBodyEmissions > 0`, **not** the raw flag, which is phantom on 26 of 33
   single-host rows (`#5283`). If the gate's own summariser reads the raw flag,
   seed what it reads and record the discrepancy in the lane's `notes` — do not
   silently seed a different number from the one the tool computes.

**The one real obstacle, stated up front.** Seeding writes
`scripts/ir-only-baseline.json`, and CLAUDE.md says never to edit
`scripts/*-baseline.json` because main is its sole writer. That rule exists to
stop a PR banking a regression into a ratchet. Adding a *new lane* is not that —
no existing floor moves — but it is close enough that the implementer must not
decide alone. **The "land report-only, seed later" alternative an earlier draft of this plan
offered does NOT exist — verified in the gate's own code.**
`evaluateIrOnlyReport` does `const expected = baseline.lanes[lane.name]; if
(!expected) failures.push(\`${lane.name}: missing committed baseline lane\`)`.
A lane present in the code and absent from the JSON **fails the gate
immediately**, so the seed cannot be deferred to a follow-up. The only real
options are:

1. one seeding commit with the project lead's explicit sign-off, or
2. don't add the lanes yet.

**Do not hand-edit the JSON to make a gate pass**, and do not attempt the
deferred-seed route — it was offered here in error and an implementer following
it would land a red gate.

**Acceptance.** `pnpm run check:ir-only` still reports READY (the two new lanes
are `baseline`, so they cannot fail the verdict); the two lanes appear in the
human output with the numbers above; and a deliberate regression in either lane
— e.g. reverting #5498 — makes the gate fail. That last one is the anti-vacuity
check: a baseline lane that cannot go red is decoration.

**Why it is worth doing before R4 lands.** When R4-M1's string slice lands it
should unlock exactly two dogfood files (`escapes-unicode.js`, `templates.js` —
measured on `#3523`). With these lanes in place that shows up as a ratchet
movement CI records automatically. Without them it is another number somebody
has to re-measure by hand, which is how the 59,676 figure became unverifiable.

**Not claimed:** that dogfood is the right R9 denominator. It is a better
standalone population than the playground (see the corpus-mismatch correction
above), and it is *a* measured population under CI, which is strictly better
than none. Choosing the representative corpus remains open.

### CORRECTION — the dogfood legacy-body counts above are inflated ~4x (see `#5283`)

Every "legacy bodies" figure this file quotes for `tests/dogfood/corpus` — 33
single-host, 31 standalone — is built on `IrObservedOutcome.legacyBodyEmitted`,
and that flag is set on units where **no direct pass ran**. Counting rows with
`legacyBodyEmitted === true` and `(directBodyEmissions ?? 0) === 0`:

| corpus / lane | quoted above | of which phantom | real direct emissions |
| --- | --: | --: | --: |
| dogfood, single-host | 33 | 26 | **7** |
| dogfood, standalone | 31 | 23 | **8** |
| playground uncovered, single-host | 10 | 0 | 10 |
| playground uncovered, standalone | 14 | 0 | 14 |

**The playground figures stand; the dogfood ones do not.** Filed as `#5283`,
confirmed on `tests/fixtures/extern-demo.ts` where the row reads
`legacyBodyEmitted: true` with `directBodyEmissions` **absent**.

**What this does and does not change in the sections above.** It touches only
the legacy-body rows. Everything else was read from different fields and stands
unchanged:

- `unsupported` counts (33 / 31 dogfood, 8 / 14 playground) come from `kind` —
  unaffected.
- `emitted` / IR-body counts (1 and 0 on dogfood) come from `kind` and
  `irBodyEmitted` — unaffected.
- **"module-init adoption is 0 of 20 executable units"** was derived from
  module-init `kind` (`unsupported` / `non-executable` / `emitted`), not from
  this flag — **unaffected, and it remains the load-bearing R4 finding.**
- The reject-arm breakdown (`code`), the per-file blocking-category table, and
  the `scalarKind` root cause are all independent of it.

So the R4 conclusion survives; what shrinks is the claim about how much the
direct front end is still *emitting* on that corpus.

**Method, for the fifth time tonight and the sharpest instance.** This was found
by executing gap-6b's own P4 item — an instruction sitting in this repo to
"confirm it with one compile and file it as its own issue" — rather than by
re-reading my own numbers. The telemetry I spent the session counting had a
field whose name and meaning disagree, and nothing in re-checking my arithmetic
would ever have surfaced it. **A measurement is only as good as the field it
reads, and the field is worth one compile of scepticism.**

### Verification pass over every table in this file (2026-09-03)

After two figure errors in one session — the dogfood legacy-body counts
(`#5283`) and the R9-D1 seed table carrying playground numbers under dogfood
labels — every headline table here was re-measured against a single fresh run
rather than re-read. Ground truth:

| corpus / lane | units | emitted | unsupported | non-exec | IR bodies | module-init | of which emitted |
| --- | --: | --: | --: | --: | --: | --: | --: |
| gate 5, single-host | 41 | 38 | 0 | 3 | 38 | 5 | 2 |
| gate 5, standalone | 41 | 38 | 0 | 3 | 38 | 5 | 2 |
| playground 8, single-host | 32 | 16 | 8 | 8 | 16 | 8 | **0** |
| playground 8, standalone | 32 | 10 | 14 | 8 | 10 | 8 | **0** |
| dogfood 20, single-host | 35 | 1 | 33 | 1 | 1 | 20 | **0** |
| dogfood 20, standalone | 35 | 0 | 31 | 4 | 0 | 20 | **0** |

**Everything above verifies except one denominator**, and it is one this file
made load-bearing. The phrase "module-init adoption is **0 of 20 executable**
units" is imprecise: 20 is the module-init *population*, but one of them is
`non-executable` on single-host and four are on standalone. The accurate
statement is **0 of 19 executable single-host and 0 of 16 executable
standalone** — still zero adoption, which is the finding, but the denominator
was the population rather than the executable subset. Read every "0 of 20"
above with that correction.

The playground's "all 8 module-init units are non-executable" is confirmed
exactly (`non-exec` 8 of 8 module-init, 0 emitted), as is the gate corpus's
"2 emitted, 3 non-executable" — which is why it is green.

## 2026-09-03 — R10's audit discrepancy is ATTRIBUTED (the July tree was reachable after all)

Earlier tonight this file recorded that the 2026-07-16 audit's headline numbers
do not reproduce, that three explanations fit equally, and that separating them
needs the Phase-2f JSON (gone) or the July tree — **"this clone is too shallow"**.
That second claim was wrong, and it was wrong in the cheapest possible way: a
shallow clone is not a truncated history, it is a *fetch boundary*.

```bash
git fetch --shallow-since=2026-07-10 origin main     # exit 0, ~seconds
git worktree add --detach …/r10-july-audit <2026-07-17 sha>
node scripts/audit-legacy-reachability.mjs
```

**The script is byte-identical between the two trees** (`git diff` of
`scripts/audit-legacy-reachability.mjs` July↔today is empty), so the instrument
is not a variable and the comparison is clean.

### The measurement

| bucket | files (Jul 17 → Sep 3) | legacy-only fn-lines (Jul 17 → Sep 3) |
| --- | --- | --- |
| **frontend** | 47 → 107 | **60,126 → 85,823** |
| deferred | 3 → 3 | 1,731 → 2,543 |
| runtime | 58 → 61 | 43,403 → 39,791 |
| stays | 111 → 621 | 18,751 → 37,270 |
| *`src/codegen` files scanned* | *219 → 792* | |

### Which of the three explanations was right: two of them, on different columns

- **`legacy-only fn-lines` — the recorded figure is SOUND and the growth is
  REAL.** The July-era tree measures **60,126** against a recorded **59,676**, a
  0.75% gap across one day of commits. So the metric reproduces, and
  60,126 → 85,823 is **+42.7% of genuine growth** in seven weeks. The "front end
  grew 43%" reading I declined to claim is now supported — by a measurement, not
  by the coincidence that two numbers differ.
- **`files` — the recorded 35 is an ARTIFACT.** The same-era tree measures
  **47**, so the old table's `files` column was undercounting (consistent with
  it having counted only the rows it printed). The eye-catching 35 → 107 is
  really 47 → 107, and it sits inside a `src/codegen` population that itself
  went 219 → 792 files.

### What this means for R10, which is the point of measuring it

**The deletion target is growing, and slightly faster than the surface around
it.** As a share of all legacy-only fn-lines the front end went **48.5% → 51.9%**
— so R10 is not being eroded by ordinary IR progress; it is being outpaced.
The one genuinely reassuring cut is share of *total* fn-lines (legacy-only plus
shared), **31.4% → 25.2%**, but that falls mostly out of the `stays` bucket
tripling its shared lines, which is growth R10 never had to delete anyway.

Two consequences worth acting on:

1. **R10's cost estimate must be re-derived, not inherited.** Any plan sized
   against 59,676 is understating by ~26,000 lines.
2. **This should be a periodic measurement, not a one-off.** The whole reason
   tonight's re-run was ambiguous is that July left no committed artifact.
   `plan/log/3090-legacy-reachability-2026-09-03.json` fixes that going forward
   for one date; a cheap recurring capture would let the *rate* be read directly
   instead of reconstructed under a fetch boundary.

**Correction to a figure recorded earlier tonight:** the frontend legacy-only
count appears as 85,609 in the #5509 body and 85,823 here. Both are real —
`main` advanced between the two runs and this branch merged it. The later number
is the one measured against the July tree in the same session, so it is the one
the comparison above uses.

**Method note.** The claim "the July tree is unreachable" was never tested; it
was inferred from `is-shallow-repository = true`. One `git fetch --shallow-since`
would have settled it at any point, and the cost of not running it was an
unattributed number sitting in a PR body as a permanent open question. Same
family as this session's other corrections: an assumption about an instrument's
reach, stated as a fact about the world.

### R10 cost estimate, re-derived from the 2026-09-03 audit

The re-measurement above says any estimate sized against 59,676 understates by
~26,000 lines. Rather than restate the bigger total, here is the **shape** of
the work, from `.tmp/legacy-reachability.json` (792 files; cut set
`statements.ts#compileStatement` + `expressions.ts#compileExpression`).

**The headline 85,823 is not one job. It is two, and they are very unequal.**

| | files | legacy-only lines | shared lines that must survive |
| --- | --: | --: | --: |
| **A — whole-file deletion** (`sharedLoc == 0`) | **78** | **65,318** | 0 |
| **B — split required** (`sharedLoc > 0`) | 29 | 20,505 | 15,956 |
| total (frontend bucket) | 107 | 85,823 | 15,956 |

**76% of the deletion by line count needs no surgery at all** — 78 files contain
nothing but legacy-only functions, so R10 removes the file. The ten largest are
each a single-purpose direct-path emitter:

| file | legacy-only |
| --- | --: |
| `expressions/calls.ts` | 8,756 |
| `expressions/new-super.ts` | 6,299 |
| `expressions/assignment.ts` | 5,799 |
| `expressions/call-receiver-method.ts` | 4,346 |
| `expressions/call-builtin-static.ts` | 4,099 |
| `statements/loops.ts` | 4,049 |
| `expressions/call-identifier.ts` | 3,751 |
| `expressions/operator-assignment.ts` | 3,435 |
| `binary-ops.ts` | 3,391 |
| `expressions/call-namespace-static.ts` | 3,162 |

**The real work is the 29 mixed files, and it is smaller than it looks but more
delicate.** They hold 266 shared functions that survive R10 and must be lifted
out before the surrounding 20,505 legacy-only lines can go. The distribution is
sharply bimodal — some are almost entirely shared, others almost entirely
legacy:

| file | shared (fns) | legacy-only | character |
| --- | --- | --: | --- |
| `closures.ts` | 3,872 (48) | 125 | nearly all survives — likely re-bucket, not split |
| `statements/nested-declarations.ts` | 3,157 (47) | 285 | same |
| `expressions/identifiers.ts` | 1,980 (28) | 873 | genuine split |
| `expressions/builtins.ts` | 1,488 (10) | 2,197 | genuine split |
| `literals.ts` | 766 (20) | 4,879 | mostly deletion, 20 fns to lift |
| `statements/for-of-destructuring.ts` | 660 (**1**) | 2,041 | one function to lift, then delete |
| *19 more* | 1,963 | 6,891 | |

`closures.ts` and `nested-declarations.ts` together are 7,029 shared lines
against 410 legacy-only — those two are probably **mis-bucketed rather than
mixed**, and confirming that is the cheapest single thing that could shrink
R10's scope. `for-of-destructuring.ts` is the opposite and the ideal early
slice: lift **one** function, delete 2,041 lines.

**The export surface is the risk, and it is mostly benign.** 929 legacy-only
functions — 605 module-private, **324 exported**. Of those 324, **232 sit in
whole-file-deletable files**, so they vanish with their file and only their
importers matter; 92 are in mixed files and need individual care.
`check:dead-exports` is a required part of `quality`, so an export left behind
after its consumers go fails the gate — which makes the ordering explicit:
**delete callers before definitions, and run `check:dead-exports` between
slices, not at the end.**

**Sequencing that falls out of the data**

1. Confirm or re-bucket `closures.ts` / `nested-declarations.ts` (7,029 shared
   lines hinge on it).
2. Whole-file deletions, largest first — 78 files, 65,318 lines, no splitting,
   each independently revertable.
3. Lift-then-delete the low-shared-count mixed files (`for-of-destructuring.ts`
   at 1 function, `late-imports.ts` at 9, `builtins.ts` at 10).
4. The genuine splits last: `identifiers.ts`, `literals.ts`, `destructuring.ts`.

**Caveat, stated because the last estimate lacked one.** These are *reachability*
buckets under one cut set, not a compile-tested deletion plan — the audit proves
what is reachable only from `compileStatement`/`compileExpression`, not that
removing it leaves a building compiler. Every count above is a floor on the work
and an upper bound on the deletion.

### CORRECTION (same session) — the "frontend bucket" is an assertion, not a measurement

Two sections above I wrote that the frontend share of legacy-only fn-lines went
**48.5% → 51.9%** and concluded "the deletion target is being outpaced." **That
framing is wrong, and I should have read `bucketOf` before publishing a share.**

```js
function bucketOf(fileRel) {
  const short = fileRel.replace("src/codegen/", "");
  if (BUCKET_FILE[short]) return BUCKET_FILE[short];      // hand-maintained map
  for (const [pre, b] of BUCKET_PREFIX) if (fileRel.startsWith(pre)) return b;
  return "stays";
}
```

The bucket is a **hardcoded editorial label on the file path**. It takes no
input from the reachability analysis at all — that analysis independently
produces the per-function `legacy-only` / `shared` / `unreferenced` classes.
And two of the six prefixes are directories:

```js
["src/codegen/expressions/", "frontend"],
["src/codegen/statements/",  "frontend"],
```

**So every file added under `expressions/` or `statements/` joins "frontend"
automatically.** Of today's 107 frontend files, **100 are there by prefix** and
only **7 by name** (`expressions.ts`, `statements.ts`, `binary-ops.ts`,
`literals.ts`, `typeof-delete.ts`, `closures.ts`, `new-target.ts`).

What survives and what does not:

- **Survives — the growth is real.** `legacy-only fn-lines` is a per-function
  reachability class, unaffected by bucketing. 60,126 → 85,823 stands, and so
  does the conclusion that R10 estimates sized on 59,676 understate.
- **Withdrawn — the share comparison.** 48.5% → 51.9% compares two boundaries
  that are *not the same boundary*: the frontend set expanded as
  `expressions/` and `statements/` grew, so part of that rise is files joining
  the set rather than the front end outgrowing anything. "The deletion target is
  being outpaced" is not supported by this instrument. The file-count rise
  47 → 107 has the same defect, and is mostly those two directories.

**The mis-bucketing hypothesis is confirmed — in the strongest possible form.**
I had guessed `closures.ts` and `nested-declarations.ts` were "probably
mis-bucketed rather than mixed." They are, and not by a judgement call:

| file | how it became `frontend` | legacy-only | shared |
| --- | --- | --: | --: |
| `closures.ts` | a **hand-written entry** in `BUCKET_FILE` | 125 | 3,872 |
| `statements/nested-declarations.ts` | the `statements/` **directory prefix** | 285 | 3,157 |

Neither is a front-end file by any measured property. `closures.ts` is 97%
shared and someone typed it into the frontend list; `nested-declarations.ts` is
92% shared and was swept in by living in a directory. **7,029 shared lines are
counted as front-end deletion scope on the strength of a hardcoded string.**

**This does not weaken the R10 sizing in the section above — it sharpens it.**
That table was built from `sharedLoc == 0`, a measured property, not from the
bucket. Its A/B split (78 whole-file-deletable / 29 requiring a split) is
unaffected. What changes is the reading of the 29: some are not "mixed files
needing surgery" but **files that do not belong in the bucket at all**, and
re-labelling them is a text edit rather than a refactor.

**Actionable, and cheaper than any code change.** Re-bucket by the measured
ratio instead of by path — e.g. a file whose `sharedLoc` dominates its
`legacyLoc` is not a front-end deletion candidate whatever its directory. Until
then, **quote `legacyLoc`/`sharedLoc`, never bucket totals**, and never a share
across two dates.

**Method note, third of the night and the same root.** The census was a
fail-fast path read as a survey; the July tree was a fetch boundary read as
absent history; this is a hardcoded label read as an analysis result. Each time
the instrument was assumed to answer the question being asked of it, and each
time one look at the source settled it in under a minute.

## 2026-09-03 — is the R9 denominator representative? Measured, and the answer is no

The open half of the R9 denominator question was never "how many units fail" but
"**fail on what corpus, and does that corpus stand for what R9 will actually be
asked to compile?**" Both numbers this session quotes come from the playground
examples (13 files) and the dogfood corpus (20 files). Neither had been checked
against anything.

Method: AST node-kind frequency histograms for each corpus, compared by L1
distance over the union of kinds (0 = identical shape mix, 2 = disjoint).
Reference is a deterministic stride sample of test262 — 1,534 files of 47,533
(`test/language` + `test/built-ins`, stride 31), 147,346 nodes.
Probe: `.tmp/corpus-representativeness.mjs`.

### Result

| corpus | files | nodes | L1 distance to test262 |
| --- | --: | --: | --: |
| playground | 13 | 5,171 | **0.576** |
| dogfood | 20 | 1,289 | **0.705** |
| *playground vs dogfood* | | | *0.631* |

**Two things fall out, and the second is the sharper one.**

1. **Neither corpus is close.** 0.58 and 0.71 on a 0–2 scale is a large mismatch
   in shape mix, not a rounding difference.
2. **The two corpora disagree with each other about as much as either disagrees
   with test262** (0.631, sitting between 0.576 and 0.705). So they are not two
   samples of one population — they are two different populations, and a
   conclusion measured on one does not transfer to the other. That is the
   *mechanism* behind this session's earlier "R4 first" retraction, which was
   generalised from a single corpus and had to be withdrawn: it was not bad
   luck, it is what these numbers predict.

### Shapes our denominators barely contain

| kind | test262 | playground | dogfood |
| --- | --: | --: | --: |
| `PrivateIdentifier` | 4.58% | 0.21% | 0.23% |
| `PropertyDeclaration` | 4.29% | 0.06% | 0.23% |
| `PropertyAccessExpression` | 7.22% | 5.92% | 2.79% |
| `ArrayLiteralExpression` | 1.59% | 0.17% | 0.54% |
| `PropertyAssignment` | 1.59% | 0.00% | 0.54% |
| `NewExpression` | 1.31% | 0.12% | 0.47% |
| `ObjectLiteralExpression` | 1.13% | 0.00% | 0.39% |
| `FunctionExpression` | 0.87% | **0.00%** | **0.00%** |
| `ThrowStatement` | 0.76% | 0.00% | 0.08% |

`FunctionExpression` is **exactly zero in both** — an entire syntactic form with
no coverage in either denominator. `PrivateIdentifier` + `PropertyDeclaration`
together are **8.9% of test262 nodes against 0.4% of ours**: class bodies are the
single largest blind spot, by an order of magnitude.

**That has a direct consequence for the blocker ranking.** R3 (classes) is
already the second-largest blocker in tonight's census — measured on corpora that
contain almost no class fields. **R3 is very likely under-counted**, and the
class family's true weight cannot be read off these corpora at all.

### Two corrections this forces, one of them to my own plan

- **R9-D1 proposed the DOGFOOD corpus as the new CI `baseline` lane.** On this
  measurement dogfood is the *worse* of the two candidates (0.705 vs 0.576).
  That plan should not be implemented as written; at minimum the lane should
  carry both corpora, and the choice should be argued rather than inherited.
- **Every per-corpus figure in this file needs its corpus in the sentence.**
  Already the standing rule from the earlier retraction; this quantifies why —
  the corpora are 0.631 apart, so the qualifier is load-bearing, not pedantry.

### Limits, stated plainly

- **Node-kind frequency is a proxy for shape coverage, not for IR
  representability.** A corpus could match the histogram exactly and still miss
  every hard case. This says our corpora are *unrepresentative*; it does not say
  how much conformance R9 would lose.
- **test262 is not automatically the right target either.** It is an adversarial
  conformance suite, deliberately unlike application code. If R9's target
  population is real-world JS, the correct reference is closer to the npm-compat
  package set than to test262. What the measurement establishes is narrower and
  still decisive: **the two corpora we are quoting do not agree with each other,
  so at most one of them can be representative of anything.**
- The sample is 3.2% of test262 by stride, deterministic and re-runnable; it is
  not a random sample and directory ordering could bias it.

**Next step this suggests**, ahead of implementing R9-D1: run the same
comparison against the npm-compat package sources, which are the closest thing
the repo has to real application code. If playground and dogfood are both far
from *that* too, the R9 denominator needs to be built rather than chosen.

### The npm-compat comparison (the step the section above called for)

Real library sources from the npm-compat package set — lodash, acorn, axios,
uuid, cookie, clsx, prettier, eslint — resolved through the pnpm store:
**2,667 files, 1,078,947 nodes**. Same method, now a full matrix.
Probe: `.tmp/corpus-vs-npm.mjs`.

| L1 | playground | dogfood | test262 | npm libs |
| --- | --: | --: | --: | --: |
| **playground** | — | 0.631 | 0.576 | **0.448** |
| **dogfood** | 0.631 | — | 0.705 | 0.681 |
| **test262** | 0.576 | 0.705 | — | 0.575 |
| **npm libs** | 0.448 | 0.681 | 0.575 | — |

**Three conclusions, and the first two are decisions.**

1. **Dogfood is the worst denominator available, against every reference.** It
   is the furthest corpus from real libraries (0.681), the furthest from
   test262 (0.705), and further from libraries than test262 itself is (0.681 vs
   0.575). It is not a hard case; it is an *unlike* case. **R9-D1's proposal to
   make the dogfood corpus the CI `baseline` lane should be dropped, not
   merely re-argued.**
2. **Playground is the best of what exists** — 0.448 to real libraries, the
   smallest distance anywhere in the matrix. Still large, but it is the only
   corpus that is closest-to-something rather than furthest-from-everything.
3. **test262 and real libraries are themselves 0.575 apart**, so there is no
   single "R9 target population" to pick. A conformance denominator and an
   application denominator are different instruments answering different
   questions, and R9 needs to say which one its fail-closed default is
   protecting before either number means anything.

**What real library code has that neither corpus does:**

| kind | npm libs | playground | dogfood |
| --- | --: | --: | --: |
| `PropertyAssignment` | 2.92% | **0.00%** | 0.54% |
| `PropertyAccessExpression` | 7.65% | 5.92% | 2.79% |
| `ThisKeyword` | 1.70% | 0.15% | 0.62% |
| `AmpersandAmpersandToken` | 1.15% | 0.17% | 0.08% |
| `ObjectLiteralExpression` | 0.85% | **0.00%** | 0.39% |
| `BarBarToken` | 0.60% | 0.06% | 0.08% |
| `Parameter` | 2.01% | 0.95% | 1.55% |

**Object literals and `this` are the shape of real JavaScript, and we barely
measure them.** `PropertyAssignment` and `ObjectLiteralExpression` are both
*exactly zero* in the playground corpus. That lands directly on R4: `object` is
already a blocking storage category in the corrected census, and its weight
there is measured on corpora that contain essentially no object literals — so,
like R3/classes, **it is under-counted rather than small**.

**Limits.** Library sources include a great deal of code js2wasm may never be
asked to compile (eslint's rule definitions, prettier's printers), so this is
"what real JS looks like", not "what R9 must handle". And node-kind frequency
remains a proxy for shape coverage, not for IR representability — it can show a
corpus is unlike the target, never that a like corpus would pass. Both
measurements are re-runnable from `.tmp/`; neither is committed as a baseline.

## Completion audit — 2026-09-05

The user has requested completion of the **whole IR migration**. The product
outcome and all acceptance criteria above remain the definition of completion.
Landed selector improvements, bounded compile-once cohorts, and green sample
readiness checks are progress toward that outcome; none closes this epic.

This audit uses canonical upstream `main` commit
`5da655f286fcd569203cd2012b23dc21bf1c626d`, source tree
`3ede655c96c89083a65a3c7e96bca3329d29513f`. It is a source and retirement-ledger
audit, **not a new conformance run**. Earlier measurements in this file retain
their original commits, lanes, and denominators.

### Acceptance status and required evidence

| Requirement | Current evidence | What is still required |
| --- | --- | --- |
| Authoritative IR-only coverage gate | `scripts/check-ir-only.ts` still lists five playground entries and reuses those five for standalone. | Account for the complete declared application and conformance populations, with all terminal outcomes and positive denominator controls, across every required mode. |
| Full host and standalone Test262 non-regression | No full merge-group outcome comparison was performed in this audit. | A complete final-candidate comparison, including skips, compile errors, runtime failures, timeouts, and fatal runner outcomes. Required checks that skip a shard do not supply its evidence. |
| One prepared program before either backend | `src/ir/program.ts` declares `reconciliation: "pending-production-wiring"`; its sealed structural census still contains direct and invariant candidates. | Reconcile every supported unit into the production program before emission; remove remaining class, initializer, and multi-source ownership exceptions. |
| Shared WasmGC and linear frontend/ABI | `src/codegen-linear/index.ts` still compiles declaration statements directly and exports an AST-taking `compileExpression`. `linear-integration.ts` still inspects declarations and the checker. | Both backends consume the same verified semantic bodies and ABI ledger without backend-specific frontend reconstruction. |
| Lossless validated serialized handoff | A versioned `IrAsyncPlan` and its serializer exist. `PreparedIrProgram` remains a structural census; this audit did not establish a complete production serializer. | Connect the whole prepared semantic program, ABI, effects, and frozen runtime manifest to a lossless codec and reject malformed/incompatible input before artifact side effects. |
| Differential backend-input proof | No fresh same-snapshot differential run was performed here; the direct linear path remains. | Feed the identical serialized prepared snapshot to both backends and verify equivalent supported behavior and typed incapability without reparsing or reselection. |
| Explicit stable unsupported results | The equality reference-operand preclaim guard landed through PR 5584, but it addresses one selector boundary. | Account for every unsupported terminal unit, including source location/reason, and remove silent fallback, post-claim withdrawal, skipped slots, and legacy exception recovery. |
| One production policy | Public `experimentalIR` / `disableIrFirst` options, `JS2WASM_IR_FIRST`, and `JS2WASM_LINEAR_IR` switches remain in production code. | Execute the live retirement inventory in **#4522 — Inventory and retirement plan for IR/direct env kill-switches** at R9, after all supported behavior is owned by IR. |
| Delete the direct frontend graph | The unchanged reachability audit finds both real direct dispatch roots and substantial surviving graph overlap; details below. | Prove frontend-only survivors reach zero with a fresh **#3090 — Retire direct front-end after IR-only reachability gates close (~59,676 fn-lines)** audit, classify shared runtime separately, and delete the obsolete direct dispatch and handlers. |
| Preserve behavior and optimizations | The current optimization-retirement ledger has 50 rows, of which 46 are not ready. | Map the full retirement surface and demonstrate behavior plus the required Wasm-shape/performance properties before deleting each implementation. The tracked 50 rows are not a complete handler census. |
| Final merged validation | This audit is not the final merged candidate, and source blockers remain. | Complete the final equivalence, cross-backend, linear, typecheck, lint/format, LOC/dead-export, full Test262, standalone-floor, and artifact-validity checks against the landed implementation. |

Specific live source evidence at the audited commit:

- `src/ir/program.ts:190–203` describes unvalidated unit candidates and pending
  production reconciliation. The type name and `sealed` field do not establish
  the product handoff by themselves.
- `src/ir/async-plan.ts:179` already owns semantic states, values, handlers,
  spills, ABI, and runtime intents; `serializeIrAsyncPlan` exists. Async is not
  starting from zero. Nevertheless, `src/codegen/async-cps.ts:1045` permits AST
  expression operands, while `src/codegen/async-frame.ts:2093`, `:2117`,
  `:2251`, `:2284`, and `:2517` still emit AST statements/expressions for resume,
  await, conditions, and finalizers. These production edges must be replaced.
- `src/ir/runtime-manifest.ts` already has a substantial fixed-point builder
  and frozen runtime manifest, including boundaries, strings, callback
  wrapping, and function-prototype calls. Earlier descriptions of a math-only
  manifest must not be treated as current scope. Complete runtime ownership
  still needs production and deletion evidence.
- `src/codegen-linear/index.ts:665`, `:848`, and `:1781` retain the direct
  statement/expression route. `src/ir/backend/linear-integration.ts:381`
  retains its environment escape hatch.
- `src/compiler.ts:881–887`, `src/index.ts:830–847`, and
  `src/codegen/index.ts:5685` retain public or environment policy choices;
  multi-source routing at `src/codegen/index.ts:10324` still has fast/policy
  eligibility exits.

### Fresh retirement measurements

`node scripts/check-ir-optimization-retirement.mjs --require-ready` exited 1:
**46 of 50 tracked optimization rows are not ready**. Ledger blob:
`2310f1ad7037919585419b0bed9112fd404a07bb`. The failing rows include string
operations, numeric switches/ABI, async frame spills and promises, class and
closure behavior, regular expressions, parser paths, vector operations, and
module TDZ. This count measures ledger readiness, not percentage of the
compiler migrated.

The unmodified `scripts/audit-legacy-reachability.mjs` (blob
`7767986b14664e8aad58d8354ad7d3c803a1d46e`) reported **806 codegen files**.
Its graph actually contained both configured dispatch nodes:
`src/codegen/expressions.ts#compileExpression` (22 function lines) and
`src/codegen/statements.ts#compileStatement` (24 function lines). This positive
control checks the analyzed graph, rather than accepting the declared cut list
as proof that the roots were found.

| Asserted file bucket | Files | Legacy-only function lines | Shared function lines | Unreferenced function lines |
| --- | ---: | ---: | ---: | ---: |
| frontend | 109 | 87,121 | 16,141 | 0 |
| runtime | 61 | 39,952 | 57,406 | 312 |
| stays | 633 | 39,268 | 166,214 | 198 |
| deferred | 3 | 2,543 | 2,958 | 0 |

**These are not deletion permissions or an estimate of removable code.** Bucket
membership is asserted by file-name/prefix rules; reachability is a separate,
conservative static calculation. Twelve files labelled `frontend` contain more
shared than legacy-only function lines. The tool roots functions outside
`src/codegen`, cuts the two dispatchers, and reports codegen functions; it does
not prove final runtime behavior or complete linear-backend retirement.

The normal audit command currently fails in this checkout because its use of
`new URL(import.meta.url).pathname` leaves the space in `/Volumes/Archiv Mini`
encoded as `%20`. The measurement above ran the **same unchanged script and
source** through a space-free symlink, with Node's
`--preserve-symlinks-main`. This records a successful workaround, not a repaired
default CLI. Local evidence is in
`.tmp/ir-completion-20260905/{optimization-retirement.log,legacy-reachability.log,legacy-reachability.json,summary.json}`;
the large graph JSON is not committed as a baseline.

### Implementation sequence from the current state

1. Complete and validate the already-dispatched computed-literal class-method
   identity slice in **#3522 — IR-only R3: compile-once classes, members, and closures**.
   Preserve the equality preclaim fix already merged through PR 5584.
2. Implement the new Astra plan in **#3521 — IR-only R2: prepare-before-emit free-function ownership**: authenticate semantic and physical boundary
   contracts against actual allocator/provider state before claiming bodies.
   Remove declaration-kind certification as the correctness substitute only
   where the replacement contract proves the complete boundary.
3. In parallel, follow the independent prerequisite plan in **#3525 — IR-only R5: whole-program single- and multi-source Prepared ownership**: freeze ordered module-initializer
   planning before routing/emission, joined by exact source and unit identity.
   Mixed callable/initializer ownership remains dependent on coherent R2
   preparation and must not be reported complete by this prerequisite alone.
4. Continue whole-program ownership, async semantic emission, frozen runtime
   support, shared linear consumption, and the full prepared-program codec.
   Preserve existing live slice claims (including module function storage) and
   ground subsequent implementation plans in current source and measurements.
5. Retire policy escapes and direct handlers only after the supported-language
   and optimization obligations are met. Then run the complete final merged
   validation above. No bounded cohort or five-entry readiness check substitutes
   for the epic's acceptance criteria.

## Implementation Plan — 2026-09-05 — consolidate existing migration work

The user explicitly prioritized integrating the current pieces before opening
more parallel feature slices. Astra owns integration planning and review.
Following the user's approved model switch on 2026-09-05, Astra Max also owns
the async ownership/currentness and linear backend acceptance repairs. Both
previous Luna writers confirmed stand-down before the Astra successors took
over their existing worktrees, branches, issue plans, and test evidence.
Luna Max retains initializer publication and bounded validation. Existing
lane claims remain held under parent coordination. D1a authority implementation
is deferred; its preserved worktree and approved evidence remain intact.

The integration claim is `3518:integration-consolidation`, owned by
`ttraenkler/astra-ir-integration-20260905`. It covers candidate composition,
cross-lane validation, and this plan, not another feature or direct-path
retirement. Preserve the independent `3518:bench-string-c2` claim and both
active R4 storage claims. The concise current status is maintained in the
integration lane's `.tmp/ir-completion-20260905/integration-status.md`;
historical agent reports do not override that record's source evidence.

1. **Repair the initializer failure boundary before publication.** For
   **#3525 — IR-only R5: whole-program single- and multi-source Prepared
   ownership**, retain every authentic returned pending receipt before
   validating its complete partition. Any malformed or incomplete partition
   must abort all original pending scopes, including receipts excluded from
   the invalid partition. Classify failure outcomes explicitly: only supported
   preclaim `Unsupported` refusals may resume existing routing. An invariant
   or postclaim failure must abort and remain fatal. Pair real positive
   production initialization with late-partition and injected-phase failures;
   measure scope revocation and absence of direct retry, not only empty output.
2. **Reconcile the actual async prerequisite graph.** For
   **#3527 — IR-only R7: AST-free async plan**, B3 currently contains B2's
   source changes. Preserve both published branches and any automatic main
   merge; never overwrite them with a stale local head. After an actual B2
   landing event, verify the merge's source ancestry and file contents, then
   inspect B3's remaining diff against that main. Do not count B2 twice or
   mark the broader issue complete. B2 currently has a reproduced generic
   async-to-async call regression in equivalence CI; repair the physical
   carrier closure before waiting on its landing. Compose the repaired B2/B3
   histories first and choose a coherent publication path after the actual
   head and queue census. Review loss of retained owner identity after
   Promise ABI issuance as an existing B3 acceptance condition.
3. **Finish the linear handoff's existing contract.** For
   **#3528 — IR-only R8: shared linear Prepared program**, preserve typed,
   located preclaim refusals through the linear rejection report. Verify
   demanded helper/layout availability before the first accepted emission.
   Distinguish legitimate symbolic relocation from an unproved resource;
   relocation does not permit late capability discovery. Retain the repaired
   SSA, declaration, allocation, provider, and one-shot failure controls.
4. **Compose the repaired candidates in an isolated integration checkout.**
   Pin main and all candidate heads, merge ordinary branch histories, and
   inspect every overlapping source hunk. Do not push an integration merge to
   any author's branch or to main. R5 and async changes share declaration and
   integration machinery; independently green branch tests are insufficient.
   Run their focused suites against the combined candidate before broadening
   validation. Preserve exact input hashes and record preexisting failures.
5. **Demonstrate a larger path through the public compiler.** Compile a
   multi-source application with ordered numeric initialization, imported
   reads, an async export with multiple numeric awaits, and a numeric
   loop/branch helper. Execute emitted output and compare values, startup
   order, Promise identity, and microtask observations with native JavaScript.
   Record terminal ownership and direct-body counts for every source/unit.
   Where current mixed-graph or backend support declines, retain that refusal
   as the measured integration boundary; do not call the application IR-only
   or widen admission to make a test green. Separately consume one captured
   supported body graph in both backends and execute both outputs.
6. **Verify landing by effect and preserve the full acceptance bar.** Observe
   actual merge events without polling. Verify source parent ancestry and
   changed file contents on main, then rerun integration checks when landed
   source differs from the candidate. Required merge-group CI, complete
   Test262 accounting, whole-program ownership, and all eleven epic criteria
   remain required. Bounded runtime evidence does not authorize deletion.
## Astra High continuation specification — 2026-09-07

This is a specification checkpoint for the full migration. It changes no
compiler code and closes no acceptance criterion. Implementation is assigned
to **Astra Low**, by continuation of the existing owners or a recorded handoff.
No new parallel replacement of a claimed owner is authorized by this plan.

### Provenance and claim reconciliation

Source base: upstream `loopdive/js2` main
`b3133d1d4da1151d82ef45b58db9566565097c57`, fetched in the isolated
`codex/3518-ir-retirement-spec-astra-high` worktree. The fork's main is not the
base. All source locations below refer to that SHA unless explicitly labelled
package C. Historical R1/R2 results above remain historical measurements.

The full live claim read returned `read upstream/issue-assignments`, tip
`a49968cdd47872a5221ef97367214e9f7072e2db`, with 800 held records. Relevant
records, including exact handles and branch names, are preserved in
[the filtered owner snapshot](../agent-context/3518-owner-claims-20260907.json).
The ordinary `--check 3518` and `--check 3520` report no active **bare** claim;
they do not establish that the issues' slices are free. The pre-dispatch gate
for this epic returns **STOP**, citing package C and overlapping child issues.
This documentation-only continuation is the explicit response to that STOP;
it is not permission to dispatch duplicate implementation. Its own claim is
`3518:astra-high-continuation-spec`,
`ttraenkler/astra-high-spec-20260907`.

Owner handles and next actions:

- **A:** `ttraenkler/astra-ir-program-a-20260905`, original branch
  `codex/3518-whole-program-a-20260905`. Holds authoritative preparation,
  runtime-callable ABI, observation authority, and the subsequent driver,
  result-finalizer, object-output, source-position and WASI slices. Continue
  **lane A** below after recovering the owner's actual latest commits.
- **B:** `ttraenkler/astra-ir-producers-b-20260905`, original branch
  `codex/3518-whole-program-b-20260905`; latest relevant ledger branch
  `codex/3518-prepared-async-frame-reconciled-20260907`. Holds semantic runtime
  producers and async-frame work. Continue **lane B** below, preserving the
  separately claimed IIFE return-scope and call-argument nullability work.
- **D:** `ttraenkler/luna-ir-evidence-d-20260905`, branch
  `codex/3518-whole-program-d-20260905`, holds application evidence.
  `ttraenkler/astra-evidence-acceptance-b-20260906`, branch
  `codex/3518-evidence-acceptance-b-20260906`, holds evidence acceptance,
  private observation collection and initializer evidence. The lead must
  reconcile these two evidence owners before **lane D** has one writer.
- **C, excluded:** `ttraenkler/claude-fable-ir-backend-c-20260906`, branch
  `claude/3518-whole-program-c-20260906`, active PR **5692 — package C:
  PreparedIrProgram codec, backend acceptance/emission, fresh-process replay**.
  Published head inspected: `643ed8ab8dfcee6ec836c71bedd5ddfdb0392435`.
  The coordinating task subsequently confirmed C's live repair at
  `a1bf929730a10c262749df31c22a6c093e99f76f`; local worktree enumeration finds
  that HEAD in `/private/tmp/js2-5692-repair`. It is not treated as merged or
  as the published PR head. C continues its own layering/acceptance repair.
- **Runtime host boundary owner, also excluded:**
  `ttraenkler/astra-reference-error-runtime-20260906`, including
  `codex/3518-export-marshalling-20260907`,
  `codex/3518-host-js-string-provider-20260907`, and
  `codex/3518-reference-error-runtime-20260906`. A consumes its output
  contracts; B consumes its provider contracts. Neither replaces them.

The ledger contains no process ID or Codex session ID. No A/B/D process was
identified in this checkout, and their recorded branch names did not appear
in the queried upstream/fork `codex/3518-*2026090*` remote heads. This is an
**unresolved location/liveness question**, not proof the work was abandoned.
The parent coordination task is `01a03e4f-6022-7c10-90a6-f79349570326`; the
known C shepherd task is `01a035b2-ddc5-79f3-86af-c53857925523`. Do not delete,
release, override or recreate a claim because its branch is not visible here.
The A/B implementation present in C's stack is a recoverable checkpoint, not
proof it is their newest work. Preserve attribution when adopting it.

### Current source and fresh probes

The following remaining dependencies are verified in current source:

1. `src/compiler.ts::runPipeline` calls `generateLinearModule` /
   `generateLinearMultiModule` or `generateModule` / `generateMultiModule`
   (`:1089–1104`). All public source/file drivers converge here, but
   `src/compiler/output.ts::compileToObjectSource` separately calls
   `generateModule(ast)` at `:355`. Changing just the main driver leaves a
   public direct route.
2. `src/codegen/index.ts::generateModule` prepares selected bodies, then calls
   legacy declaration walking and an overlay. Its policy at `:5741` reads
   `experimentalIR`, `disableIrFirst` and `JS2WASM_IR_FIRST`. The multi overlay
   at `:10398` returns early for `ctx.fast`. These are executable routes, not
   dead compatibility type declarations.
3. Upstream `src/ir/program.ts` still permits `direct-candidate`,
   `emitDirect`, and `reconciliation: "pending-production-wiring"`.
   In C's **unmerged stack**, `program-preparation.ts::prepareWholeIrProgram`
   instead builds `prepared-ir-program-v1` with complete reconciliation before
   acceptance. Do not recreate this producer. Its `program-source.ts` still
   refuses non-function declaration producers and unresolved typed storage;
   a codec passing does not close classes, closures or the source population.
4. `src/codegen/ir-async-frame.ts::lowerPreparedIrAsyncFunction` consumes a
   prepared plan but calls `emitPreparedAsyncFrameStateMachine` imported from
   `async-frame.ts`. That shared module retains AST statement/expression arms
   at `:2093`, `:2117`, `:2251`, `:2284`, `:2326`, `:2361`, `:2517` and a
   name-based resume lookup near `:2926`. `AsyncCfgOperand` in `async-cps.ts`
   is an AST-or-callback union. Therefore an AST-free input alone does not
   prove an AST-free reachable emitter graph.
5. `src/ir/backend/linear-integration.ts::compileLinearIrFunctions` derives
   signatures and lowers declarations with the checker. The direct linear
   statement root remains at `src/codegen-linear/index.ts:848`. The legacy
   reachability script cuts only the two WasmGC dispatchers; it cannot by
   itself prove linear retirement.
6. R1 retains both symbolic ABI authority and legacy projections. The new
   R1 continuation note in the source-qualified identity issue specifies the
   exact boundary that A/B/C must preserve. A display-name scan or a final
   numeric slot is not the source of semantic identity.

Fresh commands on the pinned upstream base, with no compiler edits:

- `node --import tsx scripts/check-ir-only.ts --policy=ir-only`: **READY**;
  single-host and standalone each enumerate **5/5 entries, 41 terminals,
  38 emitted IR bodies, 3 non-executable, 0 unsupported, 0 invariants,
  0 legacy bodies**. This is exactly this small corpus, not all applications.
- `node scripts/check-ir-optimization-retirement.mjs --require-ready`:
  **exit 1, 46/50 tracked rows not ready**. The ledger is a required
  optimization obligation list, not a compiler-migration percentage.
- `node scripts/audit-legacy-reachability.mjs --json <scratch-file>`:
  **833 codegen files**. The asserted frontend bucket has 115 files,
  88,395 legacy-only and 17,330 shared function lines. Both actual dispatcher
  graph nodes are present (22 and 24 lines respectively), supplying a positive
  detector control. Bucket membership is asserted; these are not deletion
  permissions. The audit also roots every non-codegen node, including linear,
  as a survivor, and must be supplemented for final retirement.

- Existing `tests/issue-3519-ir-only-gate.test.ts`: **14/14 pass**.
- A fresh public `compile` probe of
  `namespace N { export const x = 1; } export function h(): number { return N.x; }`
  with `trackIrOutcomes: true` succeeds in gc and standalone, each with **two
  terminal Unsupported outcomes and two legacy-body receipts** (`h` and module
  init), zero IR bodies. This is a working direct-route compilation control
  alongside the five-entry READY result; this probe did not execute its binary.

Scratch outputs are under `.tmp/ir-retirement-spec/` in this worktree. No full
Test262 run, backend replay run of C, or baseline/candidate performance
comparison is claimed by this specification.

### Parallel ownership and dependency order

There is no verified unclaimed compiler prerequisite in the overlapping
preparation/runtime/acceptance surfaces. Use these **three owner continuations**
after liveness/handoff reconciliation. They may proceed concurrently because
only one lane writes each named file. Existing owner changes take precedence
until their exact head is captured and reviewed.

- **A — one public preparation/emission driver:** compiler entry and output
  orchestration. Exact design and tests are appended to
  [R5: whole-program ownership](3525-ir-r5-whole-program-multi-source-ownership.md).
  A owns `src/compiler.ts`, `src/compiler/output.ts`, `src/index.ts`,
  `src/compiler/ir-program-driver.ts` (new unless recovered),
  `src/compiler/ir-program-result.ts` (new unless recovered), and its new
  `tests/issue-3525-public-prepared-driver.test.ts`. Existing A output splits
  must be reused instead of creating parallel modules. No backend emission,
  runtime provider, or package C file belongs to A's next slice.
- **B — detach prepared async emission from AST walkers:** exact design and
  tests are appended to [R7: AST-free async plan](3527-ir-r7-ast-free-async-plan.md).
  B owns `src/codegen/ir-async-frame.ts`, the new/recovered
  `src/codegen/prepared-async-frame-engine.ts`, new
  `src/codegen/prepared-async-frame-types.ts`, and
  `tests/issue-3527-prepared-frame-import-boundary.test.ts` plus
  `tests/issue-3527-prepared-frame-runtime.test.ts`. Existing AST frame modules
  are read-only in this extraction checkpoint; deletion is a later R10 step.
- **D — public-route completion gate:** owns new
  `scripts/check-ir-retirement.ts`,
  `tests/issue-3518-public-retirement-gate.test.ts`, and
  `tests/fixtures/ir-retirement/manifest.json` with fixtures beneath that
  directory. Reuse the recovered evidence collector before adding any new
  one. Production observation authority belongs to A/C and is read-only.
  `scripts/check-ir-only.ts`, its baseline, the existing reachability script,
  C's codec/replay tests and helpers remain read-only for this slice. Wire the
  new command into CI only after the existing CI owner grants that file scope.

**C-exclusive write set:** `src/ir/program-codec.ts`,
`src/ir/program-physical-plan.ts`, `src/ir/program-consumer.ts`,
`scripts/ir-whole-program-replay.mjs`,
`tests/issue-3518-program-codec-replay.test.ts`, and C's codec/replay helpers.
A/B/D can import approved APIs or submit a located failing fixture to C; none
edits or mocks away C's acceptance rules. The remaining preparation, ABI,
source-population and runtime-producer modules in C's PR are stacked A/B
history, not free files. This checkpoint gives no new writer those files.

Order: recover/pin A/B/D heads and C's current repair; run each continuation's
before controls; A builds orchestration against C's real API while B extracts
the frame engine and D builds the gate against existing observations; compose
normal merges in an isolated integration branch; C consumes B's prepared
runtime through its own acceptance work; A then completes the single production
cutover; D proves it through public APIs. C currently refuses async physical
materialization and non-scalar layouts, so A cannot truthfully merge a full
cutover until those dependencies and source coverage close. An intermediate
non-draft checkpoint may land internal infrastructure that has no public flag;
it must not advertise a second supported compiler mode or claim migration done.

### D implementation contract: completion evidence through public APIs

Manifest rows are exact input files, entry API, source graph, target, options,
expected semantic oracle and expected terminal inventory. Hash source contents
and preserve the same corpus on base and candidate. Include every API from A's
matrix; fast is a representation option, not permission to omit an IR census.
Do not infer runtime expectations from the candidate's generated output.

The first checked-in fixture graph is deliberately small but heterogeneous:
`state.ts` initializes a numeric live binding and exports a mutator;
`math.ts` imports it and exports a loop/branch helper; `entry.ts` re-exports
both and contains a two-await async export. Same-spelling helpers in separate
files, an imported alias, an empty type-only source and a source function named
`__module_init` provide identity controls. Pin explicit startup order and
numeric values. Keep the async row separate from the scalar subset so C's
current typed async refusal cannot erase the working positive control. Add
runtime namespace, class+closure, dynamic-code, and CJS fixtures as explicit
coverage obligations; preserve a located refusal while unsupported, but **no
new refusal of previously supported behavior counts as final success**.

Build the gate with these rules:

1. Establish a bijection between expected sources/units and terminal
   observations. Reconcile pass-derived units through original owners; list
   compiler support bodies separately. Empty/type-only units need explicit
   non-executable evidence. A missing collector, source, row, phase or process
   result is an error, never zero direct emission.
2. Require prepare-before-accept-before-emit ordering and exactly one owned
   final body per executable unit. Count every entry into direct dispatch,
   including discovery passes whose output is discarded; a boolean
   `legacyBodyEmitted` cannot certify that no direct work occurred.
3. Unsupported is a typed source-qualified failure before artifact publication.
   Invariants and failures after acceptance remain fatal. Refusal rows retain
   the complete original denominator; a refused program cannot publish a
   smaller module or masquerade as a successful all-IR compile.
4. Execute outputs and compare startup, state, throws, exported values and
   async scheduling to the pinned JavaScript oracle. Use C's fresh-process
   replay unchanged for the same serialized snapshot on both backends. Treat
   missing runner output, timeout and skipped execution as failed evidence.
5. Negative controls: delete a unit row; duplicate another; swap two same-name
   source IDs; inject a direct-entry receipt; reorder phases; skip an entry;
   remove a runtime provider; replay a donor projection; zero the corpus;
   substitute an always-green result. Every mutation must fail for its intended
   reason while the scalar positive control still executes. An unsupported
   async fixture must not make the whole gate pass vacuously.

**Astra Low lane D prompt:** Continue the existing D/evidence-acceptance work
only after its two owner handles are reconciled. Implement the gate and
fixtures above in the listed files; you are not alone in the repository and
must preserve peer edits. Do not edit compiler, codec, replay, observer authority,
CI or baseline files. First reproduce the pinned upstream five-entry READY
result beside a namespace direct-path control. Then exercise the public A
adapter and C consumer on the recovered integration head. Return exact
base/head SHAs, manifest hash, per-unit rows, negative-control failures and
runtime values. This gate is complete only when it distinguishes unavailable,
unsupported, corrupt and fully validated evidence. It does not close the epic.

### Final completion audit, required after these continuations

- [ ] A single production route serves async/sync compile, multi-source,
  file compilation, object/linking output and all CLI/selfhost entry wrappers.
  No public option or environment switch can select direct codegen. Execute
  the inventory in [IR/direct policy retirement](4522-ir-kill-switch-inventory-r9.md).
- [ ] Every accepted source and pass-derived unit has one semantic producer
  and one emission receipt. Classes, closures, nested/CJS/IIFE bodies,
  ordered initialization, async/generator state machines and dynamic code
  are included; they cannot be excluded by naming the census a subset.
- [ ] A single validated semantic snapshot and ABI feed both backends.
  Frontend/checker/AST and legacy body modules are absent from backend replay's
  transitive runtime import graph. Runtime and carrier refusals occur before
  resource publication. Backend capability gaps remain visible until fixed.
- [ ] Native/host runtime support and all demanded layouts have authenticated
  providers. Preserve shared runtime/backends; remove direct source walkers.
- [ ] All optimization-retirement obligations have executable preservation
  and removal controls, including Wasm shape and performance where required.
  Re-enumerate untracked handlers rather than treating 50 rows as exhaustive.
- [ ] Reachability is checked from actual public roots for **both** backends,
  including async/eval/object paths and dynamic imports. Require detector
  positive controls and zero unknown edges before using it as deletion proof.
  Run the existing [direct frontend deletion issue](3090-shrink-codegen-delete-dormant-legacy-handlers.md)
  through its owner; do not transfer its still-held bare claim implicitly.
- [ ] Full host/standalone Test262 and application comparisons use the same
  corpus/configuration on explicit base/candidate SHAs. Account for skips,
  fatal runner outcomes, timeouts and missing shards. Required equivalence,
  linear, typecheck, lint/format, budgets, oracle, dead-export and standalone
  floor checks pass on the actual merged candidate.

A new typed refusal protects correctness while a migration checkpoint is
incomplete. It is **not** a license to replace working direct coverage with
errors and declare the user's full migration complete.

### Suspended Claude recovery and next producer prerequisite (2026-09-07)

The [Astra High recovery plan and disjoint Low assignments](../agent-context/ir-migration-recovery-2026-09-07.md)
re-ground this migration against canonical main `9feb7bf8fc` and verified
assignment ledger `df46c34148`. It preserves the old dirty work, distinguishes
landed Claude/A/C code from held B/D checkpoints, and specifies the missing
serialized async resource ownership/ABI prerequisite before actual C/B
integration. It also sequences native and linear resource materialization,
public metadata/cutover, original-population evidence and eventual deletion.
This is specification only: no source implementation, gate relaxation,
claim release or migration-complete declaration is included.

### Connected program-data contract checkpoint (2026-09-08)

The [Astra High implementation plan](../agent-context/3518-program-data-contract-checkpoint-plan-2026-09-08.md)
is published through PR5745 at `f95d8a0bf318e857d981863b1018a9d776483a46`.
Two existing native Astra Low agents implement disjoint program-data and
runtime-data slices under verified `3518:program-data-contracts` and
`3518:runtime-data-contracts` claims. The coordinator owns prerequisite
composition, real consumer rewiring, shared boundary policy, serialized tests
and held non-draft PR publication. No public route or retirement criterion is
changed by these assignments.

The coordinator's isolated integration checkout starts from that plan commit
and reuses fifteen source/test files byte-for-byte from the published held
ABI PR5739 (`c3afa4389469e55d434c0715698dc59c6caa9120`), startup PR5741
(`7b37b23c72af84a1e336cebce2954942408ecea6`) and capability-schema PR5743
(`c2d900d4fa9811f3359c308369bfb2b4184e90a9`), plus the startup import redirect
in `program.ts`. Existing drafts are not overwritten. Older policy files are
not copied wholesale; existing active roots and allowed edges remain intact.

Final architecture clarification supersedes the plan's restrictive ABI
declaration-only wording: the complete existing canonical ABI implementation
may be reused unchanged as a source prerequisite. The getter's missing rooted
caller evidence remains an unresolved acceptance obligation, with the fixed
thirty-target denominator and preliminary 29/30 public full/cut witnesses.
Neither reuse nor downstream type references establish the missing witness.
There is no getter modification, fabricated caller or gate waiver.

Initial composed inventory validation accounted for 1,267 modules, including
23 clean modules, with no inventory errors and `architectureComplete: false`.
The first six-suite prerequisite run passed 132/133 tests. Its one failure
correctly detected that combined policy metadata omitted the explicit
`src/ir/program/index.ts` completion obligation. The obligation was restored;
the unchanged startup-boundary suite then passed 12/12. The complete corrected
six-suite rerun passed 133/133, with no skipped tests. This proves the scoped
prerequisite combination, not the new worker implementations or retirement.
The composed prerequisite typecheck also exited successfully.

Typed preparation's implementation dependency graph remains unfinished,
including verifier-to-AST provenance and mixed semantic/provider validation.
Executed native allocation, complete physical reservation, public cutover,
original-population conformance and final direct-codegen retirement remain
required. Host/linear implementation stays deferred, not removed from the
overall migration obligations. All holds remain in place.

### Program and runtime data integration receipts (2026-09-08)

PR5747's next checkpoint composes the two reviewed native Astra Low slices:
41 program-data declarations and 135 runtime-data declarations, with nine real
consumer files importing their canonical owners. Runtime implementation stays
in its existing owners; contract extraction does not claim source-free
preparation implementation or direct-codegen retirement.

The complete source inventory now accounts for 1,284 modules: 40 clean,
1,239 unmigrated and five compatibility adapters. Inventory validation exits
zero with no errors; `architectureComplete` remains false. Seventeen added
canonical modules account for the increase from the prerequisite population.
The independently fixed 40-module closure contains exactly 109 resolved edges
(99 type-only, ten runtime), with no unknown, unresolved or forbidden edges.
The sole allowed-edge amendment permits analysis contracts to use the existing
pure Wasm model data foundation; physical allocation, emission, backend,
frontend and runtime implementation dependencies remain forbidden. The plan
records the three original transitive errors and the architectural rationale.

The composed program seam and boundary run passed 131/131 tests (38 compiled
identity/seam tests and 93 boundary controls). The compiled probe uses the real
project's complete configured roots, preserving ambient declarations, in an
awaited 2-GiB child process. Earlier failures exposed an omitted ambient root
population and two incorrect expected TypeScript diagnostic codes; these were
corrected without filtering diagnostics or changing the production types.
Independent review additionally required the exact unique 17-owner control
population to be asserted outside the parameterized tests; that correction is
included. Existing runtime seam controls passed 75/75 in the composed checkout.

Eight executed replay cases cover callable aliases and ordered variable startup,
GVN enabled/disabled and normal/reversed source order. They compare canonical
transport, typed preparation versus the existing wrapper, codec replay, complete
Wasm bytes/text, imports, emitted units and actual returned values. The separate
86/86 typed-preparation/codec/allocation replay receipt retains unsupported and
fresh-process negative controls; neither count is a whole-corpus result.

Next implementation remains the preparation implementation's dependency split,
then native physical reservation/materialization and public IR cutover under the
original population and retirement gates. The ABI denominator remains 30,
with the missing public-root `planningSealed` witness unresolved. Strict compiler
closure and direct-codegen retirement remain unproven. Do not treat green
checkpoint checks or skipped Test262 jobs as proof of regression resolution.

After the final denominator correction and formatting, the full boundary suite,
new execution replay suite and fresh-process source-free suite passed 104/104
(93 + 8 + 3), with no skipped tests. The independent reviewer granted source
sign-off with no remaining blockers. Emitted JavaScript ASTs for all nine
consumer integrations remain identical to prerequisite `e90f2a14`; full-repo
lint exits zero. These are bounded preservation receipts, not retirement proof.

### Next executable ownership split (2026-09-08)

The [Astra High executable ownership plan](../agent-context/3518-preparation-ownership-implementation-plan-2026-09-08.md)
is grounded on published integration `3a119a88b28bb347f4faaaa2146bd991acf61228`.
The existing native Astra Low agents now own isolated runtime implementation
slices: complete allocation capture/restore/registry, and complete program data
freezing/error/input admission. Their exact source sets are disjoint. The parent
owns four real consumer integrations, boundary activation and preservation tests.

Remote `issue-assignments` records independently confirm
`3518:allocation-ownership-runtime` for
`ttraenkler/codex-astra-allocation-ownership-20260908` (write `34529-rzivb817`)
and `3518:program-ownership-runtime` for
`ttraenkler/codex-astra-program-ownership-20260908` (write `34718-qohac24f`).
Both worktrees start at the published integration; all old dirty worktrees and
claims are preserved. Worker implementations are pending, not validated here.
The plan fixes lifecycle ordering, historical statement and boundary denominators,
real source-produced admission/replay controls and remaining migration work.

PR5747 CI on `3a119a88b2` passed all eight equivalence shards, their aggregate,
issue tests, linear tests and sanitizer/parity jobs. Quality failed because the
adoption-table generator still searched old `select.ts` for the moved fallback
union. The follow-up redirects that tooling consumer to the canonical failure
contract and updates three generated documentation references. The unchanged
table still contains 58 kind rows and 35 buckets. Five focused controls pass,
covering the real report and absent/empty/added/removed canonical reasons even
when the old location contains a valid union. The exact freshness command now
passes locally; new-head CI must still verify the correction.

### Executable ownership integration in progress (2026-09-08)

The isolated next-checkpoint integration starts at `f757e0201af643f396e26997a306913f4d384a66`.
Allocation slice A is integrated from its three frozen blobs: old facade
`7a1ec715e42dcd80d54bce0686acf931cd5ef248`, canonical registry
`de20b852157f7db39bcf7fc4cf6f5f1936ad2673`, and seam tests
`01e68b057730d5df2f9cff5781e7165ce39ffa23`. Its 24 new tests and 29 existing
allocation replay tests passed 53/53. The historical program-data receipt now
reads all five allocation statements from the canonical implementation in their
original order; its hashes/counts are unchanged. Twenty selected preservation
tests passed, with the other eighteen tests not run in that focused invocation.

A preserves five declarations and all 19 class members (15 methods, one getter,
three fields). Static production caller anchors exist for capture/restoration
and mutation paths, but `captureSnapshot`, `fromSnapshot`, `liveSites` and `size`
have no verified external production caller in the bounded scan. Unit-test calls
do not close those obligations. Independent source review remains pending.

The parent drafted a separate admission-only fresh-process mode and retained the
full preparation mode. Its actual source fixture produces two source records,
three terminal units/bodies, two globals and one live object allocation. An
initial explicitly annotated vector fixture was refused during source projection;
that is not a passing admission case. The replacement uses a real inferred record
allocation, not fabricated IR. Admission-only execution remains unrun until B's
canonical program ownership implementation is integrated. B, four consumer
redirects, full boundary activation, combined tests and PR publication remain
pending; none is implied by A's focused receipt.

Both frozen slices are now composed. B's six files were independently hash-checked
against its manifest before copying. It preserves 22 moved statements, 14
functions, three classes/22 members, four moved initialization statements and
all 37 retained old-program statements. The single `invalidPreparedData` helper
needs a canonical export for the unchanged legacy candidate caller; it is not
reexported from old `program.ts`. A received independent source-review approval;
B and the parent proof additions are under independent review.

The combined B seam, eight execution replays and fresh-process suite passed
31/31 (18 + 8 + 5). Both new admission-only positive/forbidden-load controls
passed on the nonempty source-produced record fixture. Input and option transport,
registry sharing/detachment and next allocation identity were checked without
loading full preparation or codec; their existing separate controls still pass.
All four production consumer rewires retain identical emitted non-import ASTs.

Complete inventory validation accounts for 1,288 modules: 44 clean, 1,239
unmigrated and five adapters, with zero inventory errors and architecture still
incomplete. The clean closure is exactly 119 edges: 102 type-only and 17 runtime;
98 imports, 20 reexports and one import-type. No additional allowed edge changed.
The historical 40-module/109-edge fixture remains intact and passed all 93
historical controls. The twelve added runtime-boundary controls passed in a
separate focused run, alongside policy preservation and twenty reconstructed
statement-receipt checks (33 passed; 110 other cases not run in that invocation).
The unchanged historical denominator remains 560 statements / 374 functions;
canonical runtime text is reconstructed in its original positions. Five new
mutation controls and a complete compiled-seam/boundary run are now pending.

The prior published PR5747 at `f757e0201a` has completed CI successfully (27
successful checks, fourteen skipped checks and a separate legacy context), with
fresh MERGEABLE/CLEAN state and no auto-merge. Its hold remains. Skipped Test262
execution is not original-population evidence or resolution of the inherited
regression. This next implementation checkpoint is not yet published.

### Ownership checkpoint verification follow-up (2026-09-08)

Both frozen implementation slices received independent source approval. The
complete boundary/compiled-seam run passed 147/148: all 105 boundary cases and
the actual old/new type compilation passed, but a new reordered-freeze negative
control made no change because its literal omitted an intervening blank line.
The corrected control and eight additional canonical receipt mutations now pass;
the selected rerun passed 10/10 including explicit historical analysis 1/program
9 population assertions. No historical receipt hash or denominator was reseeded.

The fresh-process guard normalizes file URLs before matching forbidden paths;
bare, query-suffixed and fragment-suffixed old-facade controls all fail closed.
Admission checks object-graph detachment (including symbol-keyed descriptors)
and rejects a shallow-copy control while preserving registry sharing. Combined
typed preparation, codec, standalone replay and fresh-process tests passed 72/72
(30 + 27 + 8 + 7). Existing prepared-program tests passed 19/19, and the full
TypeScript 7 no-emit check passed. Independent parent-proof review is pending.

Upstream main advanced to `ad9ea951a51c9bc7c9e6c2827c3bd38c62c2bd67` via
PR5746's conditional-alias property-write fix. Its changes include an additional
mixed-module inventory entry; integration and post-sync inventory validation are
pending. These tests predate that sync. They do not establish the inherited
regression's resolution or authorize removal of any existing merge hold.

Final guard review required exact query/fragment URLs in the rejection and
census. That stronger assertion exposed tsx stripping the query before the
guard observed it; several diagnostic reruns passed 6/7, not 7/7. The final
controls run the identical registered loader in plain Node for those two suffix
cases, separately from successful real-source admission and its in-process bare
forbidden-facade control. All seven tests now pass with exact URL assertions.
This is a loader-normalization control, not a claim that tsx preserves queries.

The ownership implementation is committed as `a918265e40e35e0adb9b22d652a1a17e7b471345`.
Main `ad9ea951a51c9bc7c9e6c2827c3bd38c62c2bd67` merged cleanly in
`1e54e659761c697af3c182e7591c361d462094a3`, retaining its new mixed-module
inventory classification. Post-sync inventory is valid with 1,289 tracked
modules: 44 clean, 1,240 unmigrated and five adapters; architecture is incomplete.
Post-sync boundary, fresh-process and standalone replay suites passed 120/120
(105 + 7 + 8). Independent High review signed off the complete bounded checkpoint,
including the final guard controls. No retirement/ABI acceptance or hold removal
is implied. Native Low agents also returned source-derived next-split maps:
async semantic verification and attachment authority must separate without
duplicating their WeakMap; intrinsic signature verification must separate from
provider target checks; prepared async-state traversal remains an explicit
middle-end obligation. These are inputs to the next High spec, not tested closure.

### Verification/provider split baseline (2026-09-08)

Published PR5749 is now based on main `2f5b7a7904c19382828b8c1e4f4d248758081493`
through merge `3e0bea4e6c82b9cde9f85c0d80f454e2e7324903`. The upstream update
contains baseline/report changes only. Normal push hooks passed, including
TypeScript, lint, formatting, numeric-local parity 18/18 and issue integrity.

Before the next implementation split, the existing async-plan and runtime-manifest
suites pass 20/20 (12 + 8) on that source revision. The async suite includes real
two-suspension execution and the existing playground async-family IR coverage
control. This is a bounded pre-change baseline, not original-population conformance
or public-retirement evidence. The High implementation specification remains pending.

The [High semantic/provider ownership specification](../agent-context/3518-semantic-provider-ownership-plan-2026-09-08.md)
is now complete and source-reviewed by the coordinator. Semantic lane A owns
eleven production files plus its focused test; provider lane B owns twelve
production files plus its focused test. Their writesets are disjoint, including
explicit ownership of the old async facades by B. The shared catalog stays one
object with its existing runtime compatibility type; provider-only features
remain represented. The parent owns four consumer rewires and preservation
integration. The next checkpoint adds twelve mandatory canonical modules without
changing allowed edges; full mixed verifier and native/public cutover obligations
remain explicit. Existing 224/118 retained and 135 moved-declaration ledgers must
be reconstructed rather than reseeded. Slice locks and isolated writer dispatch
are being prepared; no new implementation is claimed here.

The specification is published at `b4c116639a7e146e83611a988a8da28d77de9368`
in non-draft PR5749. Two isolated native Astra Low writers have been authorized
from that exact commit. Remote assignment records independently confirm
`3518:semantic-verification-ownership` for
`ttraenkler/codex-astra-semantic-verification-20260908` (write `67416-31jdr4mp`)
and `3518:provider-verification-ownership` for
`ttraenkler/codex-astra-provider-verification-20260908` (write `67413-z3mk47rx`).
Parent integration uses a third isolated worktree/branch; all earlier worktrees
remain untouched. Implementation and composed validation are pending. Writers
must freeze their export interfaces and source manifests before parent composition;
heavy tests remain serialized and no completed migration is implied.

Coordinator integration now redirects the four specified production consumers;
their complete non-import source text matches `b4c116639a` byte-for-byte. The
draft policy adds exactly twelve canonical paths (core 15, analysis 5, runtime
10; clean total 56) while preserving all allowed edges and complete historical
activation records. The new semantic/provider boundary suite has 56 cases; only
its fixed-population/policy test has run (1 passed, 55 unrun). The added controls
require every new owner to report unknown dynamic imports and unresolved type
exports, and reject runtime provider imports from all three new semantic analysis
owners. Formatting and diff whitespace checks pass. Full graph and
mutation checks await composed implementations; the initial edge-floor check
must receive an exact composed census before checkpoint approval.

A has reported frozen canonical export interfaces and is drafting its tests;
these interfaces have been forwarded to B. The coordinator has now adopted all
eleven A production files from its frozen manifest, independently re-reading and
matching every SHA256 (11/11). B's production freeze remains pending; no combined
typecheck/replay success is claimed for this next checkpoint.

Provisional High source review found no concrete production blocker: all 224
historical declarations were accounted for (221 exact, three approved intrinsic
specialization/composition differences), along with 37 retained intrinsic-support
declarations. The reviewer checked export classifications, catalog identity,
private members, initializer order and the single async attachment WeakMap.
This is source review only, not frozen-checkpoint approval or execution evidence.
Historical forty-/forty-four-module fixture reconstruction remains required;
the new core contract must not silently enlarge those original denominators.

A-only runtime smoke checks in the composed parent tree confirm identity of the
single 38-row intrinsic catalog across the old and canonical exports, exact ID
coverage and feature identity for all 38 rows, retention of the provider-only
`math.reduce-trig` feature, and forwarding identity for all five effect runtime
exports and twelve callable runtime exports. This does not exercise compiler
execution or the pending B implementation. No heavy process was started.

Both production lanes are now composed. All thirteen B file blobs (twelve
production plus its focused test) matched the frozen handoff. The first composed
TypeScript 7 check found a missing `IrType` import in A's core intrinsic catalog;
the coordinator added that type-only import and notified A to refresh its frozen
manifest. The complete TypeScript 7 check then passed. No runtime body changed.

The provider suite passes 47/47 and the new canonical boundary suite passes
56/56, serialized under the 2 GiB limit. The complete 56-module fixture measures
193 resolved edges: 137 type-only and 56 runtime, with no unknown, unresolved,
forbidden or transitive violations. Its prior provisional edge-floor assertion
has been replaced by these exact counts, and the strengthened closure test passes.
A's focused test handoff, historical fixture/ledger reconstruction, compiler
replay and final review remain pending. No whole-compiler closure, native/public
cutover, retirement acceptance or new PR publication is claimed by these results.

A's refreshed full manifest now matches the composed production, including the
type-only import correction. Its focused suite passes 34/34, including the actual
TypeScript identity/negative controls. Existing source-produced program replay
passes 8/8 across GVN off/on and both source orders; fresh-process typed
preparation and forbidden-load controls pass 7/7. These checks preserve callable
aliases, live global startup and allocation ownership; they do not stand in for
the remaining math/boundary/native-async physical acceptance cases. The native
Low provider agent is implementing High's historical reconstruction specification
in its isolated worktree, limited to test helpers and three historical test files.
High is independently reviewing the composed new tests and consumer rewires.

Broader existing coverage measures 55/56: async-plan 12/12, manifest 8/8,
source Math integration 3/3, number boundary 17/17 and boolean boundary 15/16.
The boolean host-lane exact-import assertion at line 476 reports an extra
`__host_eq` import. Running that identical test on unchanged checkpoint
`b4c116639a7e146e83611a988a8da28d77de9368` reproduces the same failure and
six-entry import vector (one failed, fifteen unselected). This demonstrates
the assertion failure predates the composed extraction; it is not a green
host-behavior result because the assertion prevents later value checks. The
original assertion is unchanged. No unrelated host implementation fix or
merge/retirement approval is implied.

High review identified a preservation-test gap: B's named declaration lookup
can reconstruct historical order even if the current canonical file was
reordered. The provider agent is assigned exact current-owner order assertions
and a mutation control that reorders live declarations and must fail, in addition
to the historical receipt reconstruction. The existing passing tests do not
prove that missing order obligation. Production remains unchanged. Historical
writer dispatch required a claim-helper metadata correction: its isolated helper
copy may change only the stale High model trailer to the actual Low effort,
retaining normal hooks and the compliant push command.

The new boundary suite now has eighty cases. Its additional twenty-four controls
are not yet run: twelve actual historical-facade runtime imports, and twelve
compiler/backend/physical/program dependency cases covering named imports,
star exports, type queries and value exports across the three canonical layers.
The prior 56/56 result applies only to the earlier cases. Formatting and diff
whitespace checks pass; policy edges and exact 56-module/193-edge census are
unchanged. Heavy validation awaits release of the agent's claim-only hook slot.

The historical-receipt claim is independently verified on the remote assignment
branch: `3518-historical-runtime-receipts.json`, assignee
`ttraenkler/codex-astra-historical-runtime-receipts-20260908`, branch
`codex/3518-provider-verification-20260908`, write `78729-iqotx3ma`.
The claim process has finished and parent validation resumed.

The boundary suite now contains 85 cases. Exact new activation-prefix checks and
five corruption controls preserve the old suffix hash. Group deletion/demotion
now requires the specific `activation-demoted` error and exact layer ID in both
inventory and complete modes, rather than accepting unrelated missing-import
errors. All 33 selected new/strengthened controls pass (52 unchanged cases not
rerun in this selection), including the twenty-four facade/syntax additions.
Provider canonical-order and distinct-manifest rollback controls remain with B.

Existing standalone native async-family coverage passes 14/14 on the composed
candidate and 14/14 on unchanged `b4c116639a`, using the same suite and serialized
2 GiB configuration. This includes real timer suspension, non-i31 fulfillment,
aggregate scheduling, undefined completion and direct-emitter poison controls.
These are public compiler observations, not whole-program async materialization.
A is assigned three isolated source-acceptance files to retain paired root-bound
prepared/provider/binary/refusal receipts and fresh canonical-owner admission.
The existing whole-program scheduler/promise-materialization refusal and the
distinction between pre-attachment concat rewriting and mutation of an already
authenticated body remain explicit; neither may be converted into a passing
physical acceptance claim by comparing equal refusals.

Upstream was fetched at `04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0`.
Its change since the checkpoint's main ancestor is limited to six npm-compat
benchmark/report artifacts; compiler source is unchanged. The working branch
has not yet merged that tip because the composed checkpoint is still uncommitted.
High is tracing the actual native async emitter and physical resource requirements
behind `program-physical-plan.ts`'s async rejection, to specify the next real
materialization implementation without merely removing its guard or treating
the existing public compiler's success as whole-program acceptance.

Read-only inspection of B's draft historical helper against composed source
matches five original receipt hashes: intrinsic contracts 20 declarations,
async providers 26, runtime manifest 85, intrinsics 24 and async plan 48.
The remaining intrinsic-support hash mismatch was traced to row 4's JSDoc:
the original `b4c116639a` verifier does retain its documentation, contrary to
the earlier reconstruction specification. Its reconstructed function text is
byte-identical (2,496 characters); the omitted documentation is the only mismatch
across all 41 tuples. B is instructed to retain that validated documentation and
the original hash. No draft helper has yet been adopted into this checkpoint.

### Published semantic/provider checkpoint and follow-up (2026-09-08)

The user requested publication before the remaining validation work finishes.
Non-draft [PR5751](https://github.com/loopdive/js2/pull/5751) now contains source
commit `545923d1c9` and main-sync commit
`87435a9ef1f31821b0467561e167868fedbf3e0b`. It remains held, with no auto-merge.
Normal commit and push hooks passed, including TypeScript, lint, formatting,
ratchets, numeric-local parity 18/18 and issue integrity. The manifest LOC
allowance records the unchanged 85-declaration implementation's relocation to
`src/ir/runtime/manifest.ts`, not a relaxed gate or new runtime algorithm.
The completed new boundary suite passes 85/85.

The six-file historical follow-up is now composed and matches every frozen Git
blob. Its full focused validation and High review are running. It retains the
original hashes and fixes canonical-order/rollback controls; no outcome is yet
claimed for this newly composed follow-up. A's paired source-acceptance work is
still isolated and pending. The [next native async physical cutover plan](../agent-context/3518-native-async-physical-cutover-plan-2026-09-08.md)
records the actual resource reservation, ABI, lowering and completion obligations;
it does not authorize deleting the existing materialization refusal prematurely.

Historical follow-up validation: the four shorter suites pass 213/213
(reconstruction 54, runtime contracts 75, capability schema 27, provider ownership
57). The initial mutation test selected the first helper function instead of
`verifyIrIntrinsicInstruction`; it now selects that exact function and checks
the four-statement/two-provider-branch shape before mutating it.

The historical boundary suite's 105 assertions pass, but two complete runs ended
with a Vitest `onTaskUpdate` RPC timeout after roughly seventy seconds of
synchronous checker children. Those are not clean runs. The parent added an
event-loop yield in fixture cleanup so runner messages can be handled between
tests, without raising limits or weakening checks. A complete rerun is pending.

The complete rerun now passes 105/105 with a clean terminal exit and no runner
error. Combined with the four shorter suites, the historical follow-up passes
318/318. The event-loop yield preserves every assertion and population. High
review remains in progress; paired source-acceptance implementation is still
pending in A's isolated worktree.

Final High review found a normalization gap for function modifiers. The helper
now requires an ordinary non-generator `definition` and exactly a named-export,
non-async, non-generator semantic verifier. Four live-source mutation controls
reject generator/async/export changes rather than erasing them during historical
reassembly. Targeted reconstruction and runtime suites pass 133/133 (58 + 75)
after this repair. Original hashes and production code remain unchanged.

### Physical completion implementation handoff (2026-09-08)

The historical follow-up is published in PR5751 at
`09b7ae5857472a0e8d4c9a197d9b7ac7a6d8b390`; its final High review has no
remaining findings. The scoped runs cover 322 distinct historical tests
(58 reconstruction, 57 provider ownership, 105 historical boundary, 75 runtime
contracts, 27 capability schema), not a single new full-suite run. A fresh PR
read at that head found no unresolved review threads, no reported failed checks,
and the quality job still running; the PR remains held and is not merge-ready.

The [physical module completion contract](../agent-context/3518-physical-module-completion-contract-2026-09-08.md)
refines the next production prerequisite. It preserves the existing allocator's
stable handles and ordinal-to-position authority and adds explicit reservation,
fill and seal states over the actual module objects. A nonempty placeholder is
not proof of completion, and a valid empty void body is not proof of omission.
The existing ABI map remains authoritative; the new ledger must not create a
parallel ABI identity system. Native scheduler, Promise, frame and platform
resources remain required before whole-program async can be admitted.

Work is assigned to the existing native Astra Low subagents, with Astra High
specification and review. The provider worker owns the physical kernel, fifteen
physical record declarations and narrow legacy forwarding surfaces; the parent
owns its integration into the real program consumer. The semantic worker first
repairs three peer-reviewed source-evidence gaps: independent public execution
validation, producer-bound source-free admission, and nonempty authenticated
post-pass ownership joins. Its three-file draft is not yet adopted or measured.
All thirty paired rows and complete located refusals remain required. Equal
refusals establish preservation only, never physical acceptance or retirement.

No direct-codegen retirement, public IR-only default, ABI30 getter witness, or
native async materialization completion is claimed by these checkpoints.

### Physical consumer implementation in progress (2026-09-08)

The physical checkpoint is isolated on
`codex/3518-physical-module-completion-20260908` from `e3de0f3ff7`, so its
production changes do not alter PR5751's preservation candidate. Nine new
source-driven integration controls were run against the unchanged implementation:
eight stop at the intended missing stable-ordinal registration (zero entries
for two alias functions or four startup functions); the listener-failure
single-use control passes. Later instantiation/value assertions in those eight
tests were not reached and are not claimed as measured.

The program consumer draft now uses the physical reservation API, preserves
separate instruction handles and final ABI/export/start indices, removes its
fabricated `CodegenContext`, fills actual reserved objects and seals before
publishing emission. Its integration is not yet validated because the worker's
kernel is still under implementation and has not been adopted. The kernel claim
is independently verified on the remote assignment branch, write
`19409-8ue0poec`, assignee
`ttraenkler/codex-astra-physical-module-completion-20260908`.

Draft review identified that plain JSON snapshots would conflate `-0` with zero
and non-finite instruction constants with null. The worker is assigned exact
numeric/presence-preserving snapshots and mutation controls before freeze.
Neither the existing native async refusal nor physical capability selection
has been changed. Native scheduler/Promise/frame materialization remains open.

High review tightened the source controls to require the exact selected unit
sequence, fixture-declared two/three-unit populations and explicit startup
presence, plus listener-error object identity. The consumer also checks actual
module ownership order against its reserved projection. These revisions remain
unmeasured until composition with the frozen physical kernel.

Boundary activation now requires all original 56 canonical modules plus the
three new physical owners. The prior allowed-edge policy and complete prior
activation history were independently compared to `e3de0f3ff7` and are unchanged;
the two new layer activations are additive. Deletion, frontend-alias and
unresolved-edge controls include the new owners. The old 193-edge fixture
assertions have deliberately not been replaced by guessed counts: run the
composed checker and pin its actual type/runtime edge census before publication.

The frozen nine-file kernel is now adopted with all nine Git blobs verified
against the worker manifest. The composed kernel and real-source consumer pass
83/83 controls (74 kernel, nine consumer), and TypeScript 7 completes with exit
zero. An initial transfer inserted a truncation marker and duplicate text in
the registry file; that agent-created insertion was repaired and the original
frozen blob verified before the clean run. No failed-load test run is counted.

The expanded boundary suite measured 96/97: only the intentionally stale
edge-census assertion failed. A focused run measured 202 edges, comprising 144
type-only and 58 runtime edges, across 59 required modules. Those measured
counts now replace the old literals; the complete rerun passes 97/97 with a
clean terminal exit. Allowed edges and prior activation history stay unchanged.

High review blocks physical publication on five uncovered kernel defects:
sparse publication array holes, distinct NaN payloads, flattened recursive
type indices, omitted canonicalRuntimeRecGroup snapshots, and body-only
ref.func declaration completeness. The existing Low implementation worker is
repairing these with source-grounded controls; the parent owns serialized
execution. The 83 passing controls do not resolve these counterexamples.
No additional consumer-wiring defect was found. Native async acceptance and
direct-codegen retirement remain unproven.

Historical physical-consumer source parity is now measured in separate explicit
baseline/candidate processes. The baseline is PR5751 source at e3de0f3ff7
(head 9c60a92f4d changes tests/docs only, with no source diff or untracked source);
the candidate is this physical worktree. Complete before/after source snapshots
cover 1,303 and 1,306 files respectively and remain unchanged during each run.
The initial eight alias/startup cases produce 32 original/replay execution
records and sixteen exact cross-root pairs. Three additive source cases cover
exported global 42 and local/shared throw-null tags. The supplemented eleven
cases yield 44 emission/execution records and 22 exact cross-root pairs, with
identical bytes, WAT, resource order, wire data and checked results. Descriptor
receipts preserve optional presence, array holes, bytes and floating-point bits.
These are the initial frozen kernel's measurements, not proof of its five
pending repairs. Nonzero function-import offsets and full native async physical
materialization remain separate obligations; a tag import is not a function
import. The lexical-TDZ source refusal is not replaced by the var startup case.

The next real runtime body move is specified in
[the native Promise settlement plan](../agent-context/3518-native-promise-settlement-plan-2026-09-08.md).
It retains the full resolve/adoption, object/closure inventory and frame/runtime
resource obligations; moving six reusable body builders does not retire them.

The five review repairs are adopted from the exact two-file frozen handoff:
kernel `e930d15be902059c960fd6a9c675fb9a11a11110`, controls
`d652f915bae2015a743ccfaa3fa479fc30dc5427`. The original 74 controls are retained;
43 additive controls cover sparse arrays, numeric bits, recursive indices,
canonical runtime group ownership and all existing declaration routes. The
repaired kernel plus consumer passes 126/126 (117 + nine). Before these repairs,
the existing native async and symbolic-reference suites passed 28/28. Those
28 and the historical byte comparison must not be attributed to the repaired
source until rerun. Final High review and the emitter's explicit-rec forward
reference behavior remain unresolved; no publication or retirement is claimed.

Final High review resolves four original findings. Flattened type allocation
is repaired, but the shared emitter still interprets some explicit-rec physical
references as outer-record positions and can form an invalid nested group.
Because the new kernel admits those layouts, publication requires a fail-closed
compatibility guard. The worker is adding that guard and controls without
editing the shared emitter or weakening the existing 117 cases. Reference-free
explicit groups and references solely to an earlier flat prefix remain
supported. Reference-bearing explicit groups that cross this limitation remain
unsupported, not silently re-encoded. Correcting shared-emitter grouping stays
required when those groups are consumed by the full native IR path; this
temporary guard does not reduce the migration's final scope.

The final guard is adopted exactly: kernel
`5a7d3c470e7b8ad7ee5978c02909c8a81a1560ee`, controls
`03098a1f122ab8325957a66b658df3e837a6362d`. Final composed execution passes
185/185 (148 kernel, nine real consumer, fourteen native async, fourteen
symbolic-reference). TypeScript 7 passes. The eleven-case final candidate
comparison again yields 22 exact baseline/candidate pairs, including both
original and replayed programs; bytes, WAT, resource order and actual results
match. Final candidate source census hash is
`5670027d6b5815133f5058ef785a55f7522d82d1058676de532cbe933ab210b0`.
The baseline source census hash is
`121296da14cad893a94f9a97501880631beae38416ca6e5b09374579753b07c2`.
Neither result covers nonzero function-import offsets or certifies full native
physical materialization. The final boundary rerun passes 97/97. High source
review approves the exact final guard blobs and finds no remaining blocker
from the five original findings. Publication is a bounded physical reservation
checkpoint, not acceptance of the still-unsupported native resources.

The semantic source-evidence revision 2 was adopted byte-for-byte from the
worker's frozen three-file manifest and measured: 57/59 focused tests pass,
and TypeScript 7 passes. Both failures originate in the recorder's rejection
of Node 22's native lazy `Error.stack` accessor; the last forbidden-query
child exits nonzero before writing its report for the same reason. The agent
is repairing that distinction without permitting arbitrary diagnostic getters.
The retained positive child report independently records twelve loaded roots,
38 intrinsic definitions, 32 capabilities, two source-derived async states and
one instruction, with true manifest/plan/provider joins. It explicitly leaves
compiler-closure and retirement certification false. These are admission
observations, not whole-program physical execution or a passing 59-test suite.

The next physical integration work is isolated at
`/private/tmp/js2-3518-physical-module-completion-20260908`, based on `e3de0f3ff7`.
Its source changes must not contaminate this checkpoint's paired preservation
measurement. The original source candidate remains unchanged.

Revision 3 of the three source-evidence files is adopted with exact frozen
Git blobs verified. The focused suite now passes 82/82 with a clean terminal
exit. It adds exact native Error accessor handling without invoking custom
getters, plain-Node query/fragment rejection witnesses through the same guard,
transformed-to-returned semantic-plan equality, and independent prepared
byte/call/twice-executed-value checks. Prior 57/59 results remain recorded above;
they are superseded by this measured repair, not erased.

The full thirty-row-per-arm historical comparison stopped in its first baseline
child with Node exit 13 (unsettled top-level await), before producing a complete
report. It is not implied by the 82 focused controls. Its terminal receipt is
retained in `.tmp/semantic-provider-source-pair-revision3-20260908`; the source
worker is diagnosing the recorder without reducing the matrix. Physical source changes remain in
the separate worktree. A fresh PR5751 read at e3de0f3ff7 found MERGEABLE/CLEAN,
no unresolved review threads and completed successful quality checks; the PR
is still non-draft with auto-merge disabled. This is not retirement approval.

Final High review approves the bounded source-evidence checkpoint, with no
remaining concrete instrument-control finding. Independent receipt inspection
confirms twelve roots, 38 definitions, 32 capabilities, two states and one
instruction; all five forbidden URLs have exact denied census rows, including
three genuine plain-Node suffix rejections through the same guard. The current
1,303-file source census matches producer and child snapshots. This explicitly
does not certify the full historical matrix, whole-program native async,
post-attachment mutation, or direct-codegen retirement.

### Historical source comparison completed (2026-09-08)

Recorder revision 4 passes 87/87 focused controls. The non-i31 boundary now
uses the existing issue-4574 synchronous registered-timer callback contract:
without the observer export, wrapping a pending native Promise cannot observe
later settlement. The recorder neither changes runtime behavior nor adds
polling. It binds absolute child output paths and records unresolved awaits
explicitly when the event loop becomes idle; partial journals never substitute
for complete reports.

The full historical run now completes all four children with exit zero, no
signal or spawn error, and fifteen complete rows each: thirty rows per arm
across GVN off/on. Both comparisons have zero raw differences and
`preservationOK: true`; `acceptanceOK: false` remains explicit. Baseline source
is unchanged b4c116639a7e146e83611a988a8da28d77de9368; candidate source remains
the semantic/provider extraction, not the separate physical implementation.
Reports, independent expected receipts, progress journals and terminal hashes
are retained under `.tmp/semantic-provider-source-pair-revision4-20260908`.

Independent native rows in both roots and both GVN settings execute 70, boxed
3,000,000,000 and canonical undefined twice, with observer absence and the
established auto-fire behavior recorded. The original whole-preparation,
Math/TDZ physical-execution, boolean-host assertion and transformed async
authentication gaps remain in the reports. Equal failures are preservation,
not acceptance. Revision 3's exit13 remains documented above as failed evidence.

### Native settlement measured and next implementation dispatched (2026-09-08)

The five-file native Promise-settlement worker draft is frozen at
`/private/tmp/js2-3518-native-promise-settlement-20260908`, based on
`e3de0f3ff7d7828c66b3fea7946f08e593bf77d8`. Parent verified every recorded
SHA256 and measured 100/100 focused tests (89 ownership plus 11 source controls),
45/45 existing regression tests across five suites, and TS7 typecheck exit zero.
Implementation publication and independent review remain pending; this entry
does not imply those worker files are included in this documentation checkpoint.

An independently clean exact-e3de worktree and the frozen candidate completed
the historical eight-row comparison with zero differences and zero pending
rows. Both child processes exited zero, with no signal or spawn error. Reports
are retained in the worker's `.tmp/native-promise-settlement-historical-r1`:
baseline SHA256 `a50049048ed5de0a97bc39fbe977556eb8479cd42b3ed4d3e9404fd789ab829e`,
candidate SHA256 `718c85a33339e1338fa5755ea3b9ea1b0cb50d4687c61fda907e8f82f38bbca4`.
The instrument's acceptance flag applies only to these eight public source rows:
four standalone rows and four separately labelled legacy WASI preservation rows.
It is not whole-program async acceptance, compiler closure, or retirement proof.

The High-authored frame-body plan is recorded in
`plan/agent-context/3518-native-async-frame-body-plan-2026-09-08.md` and assigned
to the existing Astra Low worker in isolated
`/private/tmp/js2-3518-native-async-frame-bodies-20260908`, based on physical
checkpoint `0194b64c246d2b5beab2db00af33a73498e2eb6e`. Its six production and
two test paths are disjoint from settlement and source admission. Claim and
implementation status must be verified separately, not inferred from dispatch.

The independent source-admission prerequisite is recorded in
`plan/agent-context/3518-certified-delay-source-admission-plan-2026-09-08.md`.
Fresh whole-program probes refuse the unchanged certified delay at unknown
Promise construction, and the complete async family at the `number[]` parameter
of `fetchAllSequential(ids: number[]): Promise<number>`. Existing public-route
success does not remove either gap. Preserve
the exact closure inventory while wiring certification; logical vector/await
typing and all runtime/physical/public-cutover requirements remain in scope.

### Native settlement implementation integrated (2026-09-08)

The settlement checkpoint moves six executable builders and seven constants
into `src/runtime/wasmgc/promise/settlement-bodies.ts`. Four existing scheduler
registrations call the canonical builders. Context-bearing hook and unhandled
rejection adapters retain their signatures and allocation order. Identity
fulfillment still targets resolve/adoption, not direct fulfillment. Original
13-declaration receipt and all 88 retained donor declarations remain checked.

High review found no production regression, but identified three test-control
gaps: reconstructed headers could hide signature/modifier changes; forwarding
checks missed type-only clauses and aliases; source receipts did not independently
pin compile recipes/counts. Revision 2 repairs these without changing the three
production blobs or reseeding original receipts. The composed branch passes
148/148 focused controls (129 ownership and 19 source). Revision 1 and its reports
remain preserved rather than relabelled.

Final composed regression measurement passes 45/45 across the existing delay,
native async-family, hook, adoption and rejection-tracking suites. TS7 typecheck
also exits zero. These are measured on the integrated physical/settlement source,
not inferred from the earlier standalone worker results.

Boundary activation now requires 60 canonical modules, adding exactly settlement
to the prior 59. All 23 previous activation records and allowed edges remain
unchanged. The complete selected closure measures 203 resolved edges (145
type-only, 58 runtime), and all 101 boundary controls pass. This selected closure
is not the full compiler graph or a retirement certificate.

The full inventory check exits zero with `inventoryValid: true` but
`architectureComplete: false`: 1,305 modules (60 clean, five compatibility
adapters, 1,240 unmigrated), zero classification errors and zero unresolved
imports. Four unknown dynamic-import edges remain: two in the Porffor loader,
one in optimize, and one in the platform-capability adapter. Inventory validity
must not be reported as static graph closure.

The revision-2 historical pair compares an independently clean exact-e3de root
with the composed settlement branch based on published `1731cf377a`. All eight
pairs match with no pending rows; both children exit zero with no signal/error.
Serialized-report SHA256s are
`aa2915cb82b0322e223f99c3eb1eb60d2adeb4cf68dea4ec2f6c9406dcb7b721`
(baseline) and `bee9a2f9e1429193b97dbc18581f1b7f71e415f6f4e69755087cbf31a991aa3a`
(candidate), retained under `.tmp/native-promise-settlement-historical-r2` in
the settlement integration worktree. Four standalone rows and four legacy WASI
rows remain separately labelled. Acceptance is limited to these public-route
fixtures, not whole-program source admission, physical async acceptance, ABI30,
public cutover or retirement.

The exact source-admission API and seven-file implementation contract are now
in `plan/agent-context/3518-certified-delay-source-api-contract-2026-09-08.md`.
The explicit default-off frontend request does not imply provider availability;
the next missing runtime declaration must remain a located refusal. Full-family
logical vector/await typing remains mandatory and independent.

The frame worker's scoped claim was independently verified upstream with owner
`ttraenkler/codex-astra-native-async-frame-bodies-20260908`, write ID
`67945-bzg89dfn`, claim commit `178447ad6adedc33d882ab35f412f7c5b495caa6`.
Its hook process completed and released the serialized test slot; static
implementation proceeds separately. No frame implementation is implied here.

### Full-family signature attribution corrected (2026-09-08)

The unchanged playground source declares both sequential and parallel functions
as `(ids: number[]): Promise<number>`. The earlier array-returning-signature
description was incorrect. A direct invocation of the current `typeNodeToIr`
on the exact parsed annotations rejects both `number[]` parameters with
`type-resolution-unsupported`, while both unwrapped `number` returns lower to
f64. This is a signature-lowering probe, not successful whole-program preparation.
Parallel additionally requires its original `Promise<number>[]` local and
the `number[]` result of `await Promise.all(pending)`; neither is removed from
the full-family scope.

Source-admission implementation is now claimed separately by
`ttraenkler/codex-astra-certified-delay-source-admission-20260908`, verified
upstream write `79476-841vjtpq`, claim commit
`57e7f2be986125df69c4d16bdbf282937a0272ea`. The claim hook completed and released
the shared validation slot. The seven-file source-admission implementation is
still pending and is not included in this documentation correction.

### Complete native-family next dispatch (2026-09-08)

The source-grounded High plan is
`plan/agent-context/3518-complete-native-family-source-plan-2026-09-08.md`;
the exact shared interface is
`plan/agent-context/3518-native-family-logical-vector-interface-2026-09-08.md`.
These describe the next dispatch, after current delay-admission and frame drafts
freeze. They do not expand those workers' current write scopes.

The connected source goal retains all five original functions: certified delay,
fetchUser, sequential, parallel, and main. It includes array parameters,
effectful Promise-vector push, awaited Promise.all number-vector results, and
main's real clock/logging/string operations. Pure logical vector lowering must
not fabricate physical indices, resolver flags, providers or continuation bodies.

The frozen frontend interface is per-function `logicalVectorTypes`, keyed by
exact original parameter/variable declarations and vector-valued expressions.
Producer identity validation and lowerer assignability/type validation are both
required; missing entries must not fall back to physical registration. The
separate default-off `asyncFamilyProjection` requires explicit native delay
selection and compatible standalone/WasmGC source/runtime projections. Neither
selection is inferred from legacy fast/default settings.

Immediate acceptance remains eight separately reported preparation runs
(original/export-only source, original/decoded input, GVN off/on), complete
support inventory, and five original await sites. These are not eight executions.
Final native execution still requires all eight existing behavioral scenarios,
the unchanged 14-case public-family suite, real runtime declarations/providers,
vector layouts/growth, frame transport and full public cutover/retirement proof.

Preliminary reviews of the current, still-unfrozen drafts identified two
requirements for their handoff: source admission must distinguish actual
structural references from ordinary string/debug-label text equal to a unit ID;
frame preservation tests must run self-contained in ordinary CI and keep the
external-baseline comparison explicit, with no child timeout killing. These
are repair requests, not approvals or measured failures of frozen candidates.

### Native async frame ownership checkpoint (2026-09-08)

The six production files from the approved frame-body plan are composed on
settlement checkpoint `535ee6b6ba19239394ee50f8235e6c528212688b` in
`codex/3518-frame-engine-integration-20260908`. The real prepared async caller
still reaches the original context adapter, which now calls canonical runtime
builders for step bodies, ordered state chains and exception dispatch. Native
await bodies live under `src/runtime/wasmgc/async`; standardized exception-control
algorithms live under `src/wasm/physical`. Old public exports forward the same
function objects. No context, AST, allocator or emission callback moved into
these canonical builders.

The extraction preserves detached instruction-array identity, immediate state
tracking, chain tracking before finalizers, late-import remapping, reservation
and publication order, catch-route cloning, and original restoration/failure
behavior. All three await declarations and six exception-control declarations
retain their historical implementation; 44 other frame functions and the whole
`ir-async-frame.ts` remain unchanged. The pre-existing EH algorithm is preserved,
not repaired by this checkpoint.

Validation history is retained rather than relabeled:

- Revision 1: 46/50 new checks passed, terminal session 90694 exited 1. Three
  tests incorrectly searched for an empty saved body; one expected the empty
  parallel aggregate to settle before its required microtask drain. Failed
  evidence remains in the worker's `.tmp/frame-body-preservation-KqyGEb`.
- Six unchanged production files: 65/65 existing checks passed, session 33588
  exited 0 (14 native family, 38 try/catch, seven finally, six multi-await).
  Production blobs were verified before and after. Worker typecheck session
  90572 exited 0.
- Revision 2: 50/50 new checks passed, session 79128 exited 0. Explicit
  historical comparison session 17907 exited 0: five artifacts and 12 executions
  per root, including eight full-family scenarios, against immutable baseline
  `0194b64c246d2b5beab2db00af33a73498e2eb6e`. The same 21 source-preservation
  tests were rerun, not 21 additional controls. Worker evidence remains in
  `.tmp/frame-body-preservation-Fk3s9C`.
- The composed revision-2 checkpoint passed 50/50, session 3436 exited 0;
  evidence is `.tmp/frame-body-preservation-QH8HUz` in the integration worktree.
- Revision 3 additionally requires exact thrown-error identity and re-reads,
  checks and records main's stdout after repeated timer delivery. High reviewed
  these two test-only changes and approved bounded composition. Final composed
  revision 3 passed 50/50 plus typecheck, session 55719 exited 0. Its explicit
  historical pair matched five artifacts and 12 executions per root, including
  post-redelivery stdout; both child terminals exited 0 without signals.
  Evidence is `.tmp/frame-body-preservation-83o9aW` in the integration worktree.
  SHA256 of `JSON.stringify(parsedReport)` is baseline
  `496685275ae494f90e6b3ae2129e69763b492ab6f95bc3ceb1e38a731a2bea84`
  and candidate
  `d2a797bc7487571cb6bbd8eba40944fe2ccd24ead4a85d948e29cb6290a6948c`.
  These are parsed-report hashes, not hashes of pretty-printed file bytes.
- The boundary registry now requires 63 canonical modules with 207 resolved
  edges (148 type-only, 59 runtime), adding three mandatory owners and twelve
  negative controls. All 24 prior activation records and all allowed edges are
  unchanged. The first 113-assertion run exited 1 due to a Vitest worker RPC
  timeout; it is not a passing suite. An awaited event-loop yield after unchanged
  cleanup addresses synchronous detector starvation without changing assertions
  or timeouts. The clean rerun, session 96705, exited 0 with 113/113 controls.
- Full inventory session 49315 exited 0 with
  `inventory-valid-architecture-incomplete`: 1,308 modules (1,305 tracked,
  three new at measurement), 63 clean, five compatibility adapters and 1,240
  unmigrated; zero errors and zero unresolved edges. Four unknown dynamic imports
  remain: Porffor loader lines 75/76, optimize line 384 and platform-capability
  adapter line 151. This explicitly does not prove whole-compiler static closure.

The source-admission revision is separate, not included here: its seven frozen
files passed 86/86 controls in worker session 4669, with High approving the
constructor/global ownership and retained certification-population repairs.
Its integration, regressions and typecheck remain outstanding.

Neither these preservation receipts nor source admission establish complete
prepared async physical acceptance. Full-family logical vectors and real runtime
declarations/providers, transported frame materialization, public IR-only
cutover, static closure, direct-codegen retirement and the ABI30 witness remain
required. All existing PR holds remain; no merge or auto-merge is authorized by
this checkpoint record.

### Certified native delay source admission integration (2026-09-08)

The seven reviewed revision-2 source-admission files are composed on frame PR
#5755, commit `9505d0860529cf6bedf887d68c2670130d8422b3`, in
`codex/3518-delay-admission-integration-20260908`. Exact worker SHA256s were
verified after transfer. The new shared `planning-sites.ts` remains classified
as unmigrated frontend work: AST ownership validation is not a pure IR contract.
No canonical clean-module population or allowed-edge rule is relaxed.

The source request is explicitly default-off:
`promiseDelayProjection: "standalone-native"` requires standalone WasmGC source
and runtime projections. Exact original AST/checker identities select certified
delay bodies and retain both original executor/timer support records. The shared
four validator declarations retain their historical text after export-only
normalization; the legacy overlay imports the same implementation. Source
selection is consumed before typed capture and does not add transport authority.

Post-lowering checks preserve the pre-lowering certification population, map
objects, exact key/plan identities and returned support records. Schema-specific
references to elided support are rejected, including constructor ownership and
global binding owners. Ordinary string/debug data equal to a support ID remains
valid. Initially empty certification remains valid; deleted certification does
not masquerade as an initially empty population.

High approved revision 2 after its two findings were repaired. Parent worker-root
session 4669 passed 86/86 controls (41 admission, 45 identity/relocation).
Composed session 45233 passed 144/144 across seven suites: the 86 new controls,
30 typed-preparation, 12 native delay, four plan-identity, four closure
compile-once and eight data-contract replay controls. Its following typecheck
failed on a nullable derived-owner assignment. The integration normalizes that
diagnostic cursor with `unit.terminalOwnerId ?? undefined`; every reference and
population check remains unchanged. All seven reviewed files are exact apart
from that one line. An initial mistargeted correction was removed; session
53343 still failed typecheck and ran no tests. Corrected session 40713 passed
typecheck and reran all 86 focused controls successfully. These reruns do not
increase the distinct-test denominator. The exercised whole-program boundary
still refuses the authentic
missing `__ir_promise_delay_native` declaration at `unknown-function-ref` /
`resolve`, with original source ownership. No placeholder declaration/provider
or physical acceptance claim is introduced to bypass it.

Final public-family regression session 35884 passed the unchanged 14/14 cases
with exit 0. Final scoped Prettier and Biome lint checks pass. The parent frame
PR #5755 remains mergeable with successful checks and its hold retained; upstream
main is still `04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0` and is an ancestor of
this stack.

Full inventory session 23708 exited 0 with
`inventory-valid-architecture-incomplete`: 1,309 modules (1,308 tracked and one
new at measurement), 63 clean, five compatibility adapters and 1,241 unmigrated.
There are zero inventory errors and zero unresolved edges. The same four unknown
dynamic imports remain at Porffor loader 75/76, optimize 384 and platform
capability adapter 151; this checkpoint does not claim static closure.

Next implementation is split by the published complete-family plan and frozen
`logicalVectorTypes` interface: the existing Low B agent owns allocation-free
vector and prepared main-operation lowering; Low A will own source-bound family
certification and logical type facts after this source checkpoint is validated.
Keep all five original functions, five await sites, eight separately reported
preparation runs and all eight final execution scenarios. Remaining native
runtime declarations/materializers, public cutover, closure, retirement and
ABI30 obligations are unchanged.

The logical-vector worker's disjoint claim is independently verified upstream:
`3518:logical-vector-lowering`, owner
`ttraenkler/codex-astra-logical-vector-lowering-20260908`, write
`14408-9k4zqvng`, commit `dcec29e63710f2fcd9242716286672797a460469`.
Its normal claim finished with exit 0 and released the shared hook slot. The
worker now implements only the two lowerer files and two focused tests from the
published plan; the coordinator retains integration, validation and publication.

Publication attempt 6025 stopped at the normal function-budget hook: source
preparation grew to 482 lines, crossing the 300-line limit. No commit was created
and no allowance or baseline override was added. A scoped helper extraction is
in progress; all prior test receipts apply to the pre-extraction revision until
the refactor is frozen and revalidated. Parent pre-freeze review caught and sent
back a diagnostic-cursor shadowing error before accepting the refactor.

The next grounded High plan is
`plan/agent-context/3518-native-family-callables-and-providers-plan-2026-09-08.md`.
It covers all six native-family logical bindings, ordinary and attached-state
demands, real delay/combinator implementation movement, timer-service ownership
and ordered physical binding. Complete vector/main source production is its
prerequisite. Native formatting/string materialization and frame/vector delivery
are explicit dependent work, not claims of completion from declaration rows.
Physical refusal remains until those resources and carriers are actually wired.

The revision-3 helper refactor is now frozen and integrated at source blob
`543aa6d670311d985bd58aeb8e741134a7b1f5bd`; all six other source/test files
remain exact. Source selection, native planning and post-lowering validation
are separate 15/45/152-line helpers; the main source producer is 298 lines.
The unchanged function-budget gate passed in session 80810. High independently
verified the exact parent/worker blob, original helper-call ordering, map/array
identity, owner-cursor propagation and corrected catch-local naming.

Parent executed the worker's static reconstruction checker successfully. Inlining
the three helper bodies, restoring the original map bindings and alpha-renaming
the diagnostic cursor reconstructs the original main function exactly, with only
the approved nullable-owner correction. The reconstruction SHA256 is
`f77a77eefc4e6029ef6df386245cf384633f0c3c77c5f48b025e0d3c86c19dec`.
All four historical relocation receipts and all 86 authored controls remain
unchanged. Runtime validation of this exact revision remains separately recorded.

Final composed revision-3 session 60182 exited 0: typecheck followed by 158/158
tests across eight suites (41 admission, 45 identity, 30 typed preparation,
eight data-contract replay, 14 public native family, 12 native delay, four
closure compile-once and four planning identity). No suite was omitted or
rebaselined to admit the refactor. Publication uses the normal hooks again.

### Logical vector/main checkpoint integration — 2026-09-08

Source admission is published as non-draft PR #5756 at
`e3a01efa44f68da1b93c16b1a728d0ba099183f9`, stacked on #5755. Remote SHA
and clean integration checkout were verified after normal hooks. The fresh
PR read reports mergeable/CLEAN with successful checks, hold retained and
auto-merge null; no unresolved review threads (complete first page).

The next isolated integration is
`/private/tmp/js2-3518-logical-vector-integration-20260908`, branch
`codex/3518-logical-vector-integration-20260908`, based on that exact checkpoint.
All four initial worker blobs match: from-ast
`35be9d83b656d81a4310509b3e6191d03618c294`, array-element-lowering
`2acf0fc4ae77dd5974f039b5914706ff8a31e275`, vector test
`062c104dd33f98ce81dde64b12923bc9ad9fa5e2`, main test
`5faaeb03147407e0c941a8f64be15f3b3d56ab20`.

Initial integration session 1100 passed typecheck, then its Vitest fork exhausted
the configured 512 MiB heap before a test verdict. NODE_OPTIONS alone does not
override the repository's fork execArgv. No test success was inferred. Rerun
92007 used the intended explicit 2 GiB fork setting and exited 1: 24/24 vector
and 13/14 main controls passed, 37/38 total. The missing-concat-target test
incorrectly expected refusal: the unchanged lowerer legitimately emits ordinary
logical string.concat when the optional prepared concat target is absent.
The next revision must positively verify that fallback's real operations and
evaluation order, not add a new refusal to satisfy the incorrect expectation.
The full-family source producer still owes complete source-certified targets.

Function-budget session 80623 exited 1: lowerMethodCall grew 932 to 991 lines,
new lowerExprUnchecked is 370 lines and lowerVarDecl is 317. The worker is
extracting bounded helpers without a new allowance or baseline change; old
revision files and failed evidence remain preserved. Measurements above do not
prove the forthcoming refactor until its exact hashes are revalidated.

Low A's disjoint full-family source claim is independently verified on upstream:
`3518:native-family-source`, owner
`ttraenkler/codex-astra-native-family-source-20260908`, write `33104-inpo4zu6`,
commit `455c7dbcc13e5dcee7ba6fb17b8860586199472b`. Claim session 12560 exited
0 and released the heavy slot; the agent implements only its six source/test
files. Parent composes B before A validation. High separately specifies exact
delay/combinator builder resources for the following executable movement.

Full-family runtime materialization, source-free replay, actual native execution,
public IR-only cutover, static closure, retirement and ABI30 remain unproven.

Broader initial-revision regression session 55096 exited 1: 60 passed, two
failed and two existing skips across 64 cases. The 30 i32-array and nine push
cases passed; empty-array inference had nine passes and two skips. The unchanged
14-case native family had 12 passes and two stdout failures. The new early
prepared-console branch omitted the newline construction performed by the
existing lowerHostFreeConsoleCall. Source inspection confirms the real fix is
to concatenate the newline to the validated logical string before the single
append call. Provider behavior and historical expected output must not change.
The worker's next revision includes this behavioral repair and explicit
four-console-call newline dataflow controls, separately from helper extraction.

The next exact High dispatch contract is retained at
`plan/agent-context/3518-native-delay-combinator-body-interface-2026-09-08.md`,
grounded on published `e3a01efa44`. It specifies four delay builders, all eight
historical combinator donors plus their explicit shared dispatch suffix, and
the detached vector-body builder. Existing compatibility adapters retain
registration, cache publication, real callers and exact currentFunc restoration.
Canonical subscription requires a real resolve-value handle; only the old
adapter retains its historical fallback. The plan keeps real byte/resource/
execution comparisons and separate complete-provider/physical obligations.
Implementation dispatch waits for the current vector writer's validated freeze.

Initial composed boundary inventory session 71811 exited 0 with
`inventory-valid-architecture-incomplete`, architectureComplete false and no
inventory errors. All 1,309 modules were tracked at measurement: 63 clean,
five compatibility adapters and 1,241 unmigrated. No new module was classified
clean and no boundary policy was relaxed. This initial-revision measurement
must not be presented as proof of full static closure or the revised worker
patch's acceptance.

The unchanged public native-family positive control was rerun on the exact
published source-admission base `e3a01efa44` in session 39850: 14/14 passed,
exit 0, using the same explicit 2 GiB single-fork configuration. Compared with
the composed candidate's 12/14 in session 55096, this attributes both stdout
newline failures to the new vector/main patch, not the published stack or
the test environment. This remains historical-path evidence, not whole-program
IR-only physical execution acceptance.

Parent took a provisional isolated source snapshot while the worker finished
its test controls: from-ast blob `8c77424de1f0aa3c66fe6f774bb90147bf8180ab`.
Session 88446 exited 0 after typecheck and 38/38 tests: the unchanged 14-case
native family plus the 24 logical-vector controls. Both prior stdout regressions
are repaired in this exact source. Function-budget session 84167 exited 0
without adding any allowance or changing the baseline. The existing historical
lowerFunctionAstToIr allowance is still reported by the unchanged gate.
The full revision is not yet accepted: amended main-operation controls and
independent final-revision review remain required. No implementation PR is
published from this provisional snapshot.

Parent read and executed the complete worker static reconstruction script
`.tmp/logical-vector-refactor-static-rev2.mjs`: all three modified original
bodies reconstruct with token/comment order preserved, except the authorized
newline fix. It also verifies 313 unchanged top-level statements. Measured
sizes are lowerVarDecl 300, lowerExprUnchecked 298, lowerMethodCall 850;
the five new helpers are 19/17/66/103/70 lines. This is static preservation
evidence, not runtime acceptance.

An interim main-test snapshot `8fa40169511d36b3e1f4a19e46c8648f53ed120b`
adds explicit four-call newline dataflow/order checks. Session 99838 exited 1:
13/14 passed including those new assertions; the unchanged mistaken absent-
concat refusal expectation still fails. The worker has not yet replaced that
control with the required positive generic-concat assertions. No test was
silently omitted and no passing 14-case result is claimed for this snapshot.

The worker froze the three source/vector files and handed main-test ownership
to the parent. Its last worker-only main snapshot `b2655cadae4ece86efdc2db23230fdfb6c355c5b`
remains preserved and was not overwritten or adopted. Parent completed the
positive fallback control at main-test blob
`4c9dacc0153109a6641ebee701057d312e1752ec`: 14 ordered calls, two awaits,
zero result types, two five-leaf concat trees and four newline joins account
for all 12 actual concat nodes without a physical lookup. The test denominator
remains 14. Session 54497 passed 14/14, exit 0.

High independently approved the exact repaired source and this test design;
its required test condition is satisfied by session 54497. Final composed
session 47299 exited 0 after typecheck and all six suites: 100 passed and
two existing skips out of 102 (24 vector, 14 main, 14 native family, 30 i32
array, nine push, nine passing/two skipped empty-array inference). Scoped
Prettier and Biome lint both passed in session 53544. All earlier failures
remain above; no expected native output or production gate was weakened.

Final unchanged semantic/provider boundary regression session 86951 exited 0:
113/113 passed, including mandatory canonical-root deletion and forbidden
dependency controls. No boundary policy or test denominator changed. Final
source/test blobs are `8c77424de1f0aa3c66fe6f774bb90147bf8180ab`,
`2acf0fc4ae77dd5974f039b5914706ff8a31e275`,
`062c104dd33f98ce81dde64b12923bc9ad9fa5e2` and
`4c9dacc0153109a6641ebee701057d312e1752ec` in the order recorded above.
Publication proceeds through normal commit and push hooks, stacked on #5756.

### Full-family source integration preparation — 2026-09-08

The vector/main checkpoint is now published as non-draft PR #5757 at
`1cb0f5c7f36be14d7be7eb4592973aea84a8c4e5`. Normal commit/push hooks
completed, including the additional 18 numeric-local controls. The fresh PR
read is mergeable/CLEAN with all reported checks successful, hold retained,
auto-merge null and no unresolved review threads. All four source/test blobs
remain unchanged after hooks. Upstream main remains `04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0`.

This new isolated integration branch starts at the published vector checkpoint.
Low A continues the six-file full-family source producer; High reviews its
source identity, logical type and closure contracts before final acceptance.
Low B has a disjoint next assignment for real delay/combinator runtime-body
movement, using the exact interface plan already published in #5757. Its new
claim has not yet been independently observed; no ownership success is inferred
from dispatch alone.

The complete High recursive-type physical-emission plan is retained at
`plan/agent-context/3518-explicit-recursive-type-emission-plan-2026-09-08.md`.
It specifies shared flattened type coordinates across reservations, binary,
WAT and runtime-group extraction, with explicit group identities preserved.
The temporary guard must be removed only with the real composed emitter fix;
the plan itself supplies no execution or retirement acceptance.

### Full-family source first composed measurement — 2026-09-08

The six-file source revision 1 was independently hash-checked against
`/private/tmp/js2-3518-native-family-source-20260908/.tmp/native-family-source-revision1-frozen-20260908.json`
and composed onto published `1cb0f5c7f36be14d7be7eb4592973aea84a8c4e5`.
Both the historical TypeScript 5 check (session 23134) and the repository's
canonical TypeScript 7 check (26117) exited 0. The two new frontend modules
are explicitly unmigrated in the boundary inventory: session 68170 exited 0,
1,311 modules, 63 clean, five compatibility adapters, 1,243 unmigrated,
zero inventory errors, architecture incomplete.

The first composed test run (28200) exited 1: 50/51 tests passed, comprising
24/24 source contracts and 26/27 identity controls. The remaining control
incorrectly calls `.set` on an immutable identity-map view, so it fails in
setup rather than proving the intended owner-span rejection. Repair is
required; this is not counted as a successful negative control.

All eight original/export-only × GVN off/on × original/decoded preparation
rows were read from their retained `.tmp/native-family-preparation-*/receipt.json`
artifacts. Each genuinely reaches the next canonical runtime-declaration
refusal: `unknown-function-ref`, stage `resolve`, symbol
`__ir_promise_delay_native`, original delay location line 11, span 520–674.
This proves full five-function/five-await logical source admission in these
rows, not native physical materialization or execution.

High's frozen-source review requires four additional repairs before publication:
reject valued returns for zero-result main; retain resolver/method and mutable
Promise.all target identities; retain the operand/callee identities underlying
source certification even when the outer call object survives; and strengthen
the fresh-process forbidden-import guard to the existing complete population
with a real rejection control. Low A owns these repairs and the broken
owner-span test in its original isolated worktree. Revision 1 remains retained
in this integration until a new frozen manifest is independently verified.

Unchanged historical regression session 46709 exited 0: 130/130 across
certified-delay admission (41), certified-delay identity (45), typed-program
preparation (30), and the original standalone native async-family suite (14).
These retain historical behavior and do not erase the new revision's 50/51
failure or High findings.

The disjoint runtime-body claim is now independently verified on upstream
`issue-assignments`: record `3518-native-delay-combinator-bodies.json`, blob
`a2810ef444e00be0d40bf82418a4ba8509e3733b`, write ID `57815-2v4g2ji4`,
assignee/requester `ttraenkler/codex-astra-native-delay-combinator-bodies-20260908`,
claimed at `2026-09-08T14:00:35Z`. Low B is actively editing the three legacy
adapters in its separate body-movement worktree; that draft is not yet frozen
or composed into this source checkpoint.

Unchanged semantic/provider boundary controls also passed: session 61332,
exit 0, 113/113. The boundary policy classifies the two new frontend modules
without promoting them to clean or weakening any mandatory canonical-root
deletion/forbidden-dependency control. These results apply to composed source
revision 1 only; the pending repair revision needs its own validation.

### Full-family source repair and undefined discard — 2026-09-08

Worker revision 2 was independently read and matched in all six files against
`.tmp/native-family-source-revision2-frozen-20260908.json` in the source worker.
Its changed blobs are native source `d19f26a04ac67aa324738f8231ed3d25ad5fca9c`,
contract tests `e6706bfc92f8a51623c72d7606794e11f08412f8` and identity tests
`585bb7b6441dfd8bf4219b160f676410cf50ace0`. It pins full plan descriptors,
resolver methods, Promise.all targets and original syntax children/operands;
rejects incompatible returns; proves immutable owner-span mutation prevention;
and adds eleven genuine forbidden-import rejection processes with exact
terminal/error/census attribution. Existing source-free exclusions are retained.

The first repair run (4838) exited 1: 84/85 passed, 36/36 source contracts and
48/49 identity controls. The new explicit `return undefined` positive exposed
an actual lowerer omission: `lowerDiscardedExpression` could not resolve that
identifier. Canonical TypeScript 7 passed in session 68744. The original eight
family rows still reached the exact delay-declaration refusal.

High specified a minimal existing-checker fix, implemented by the parent only
in `from-ast.ts`. After all existing effectful branches, a discarded identifier
read is erased only when it is `undefined`, has no lexical scope binding, and
the actual checker proves exact global symbol identity and Undefined type.
Missing checker and shadowed names retain the previous lowering path. No new
resolver protocol, runtime value, fabricated provider or source-selection
heuristic was added. Current source blob is
`9055e676d75fbc00565464dfdd1b7c2be8195287`.

Session 70397 exited 0: 125/125, comprising 36 source contracts, 52 identity
controls and all 37 unchanged #4459 discarded-effect regressions. The latter
retain actual IR/legacy execution, comma evaluation and taken-branch ordering.
Three additional direct-lowerer shadow controls were authored while that run
used its previously collected test module; they are explicitly not included
in its denominator. The final identity blob
`43d09b399dce161dc0dce22df055f999cbbfe880` contains 55 controls and awaits
its own final run (25348), together with typecheck and the original 14 native
family behavior controls. Parent owns this integration; the old worker's
frozen revisions remain untouched.

Parallel implementation now also covers the explicit recursive-type emission
plan. The upstream claim `3518:explicit-rec-emission` was independently read:
assignee/requester `ttraenkler/codex-3518-explicit-rec-emission-20260908`,
write ID `65804-08drhqei`, claimed `2026-09-08T14:12:55Z`. Its normal claim
hook completed in session 18001, and its isolated writer may perform static
implementation while the parent owns heavy validation. No emitter change
is included in this source checkpoint.

Final session 25348 exited 0 after canonical TypeScript 7 and all 105 tests:
55 identity controls, 36 source contracts and 14 unchanged native-family
behavior tests. All three new direct-lowerer shadow controls ran and passed.
Scoped Prettier and Biome lint passed in session 81868 (seven source/test
files, plus the boundary JSON in the formatting check). High independently
approved the exact final source/test hashes and closed all four review
findings; its final-test condition is now satisfied. Normal publication
hooks remain required. No tests, budget policies, CI rules or historical
expected runtime outputs were weakened.

### Published full-family source checkpoint and next integration — 2026-09-08

Non-draft PR #5758 publishes the full-family source checkpoint at
`37e169c4903c29ab46fe99de0910634723a19dac`, stacked on #5757. Normal commit
session 32379 and push session 4237 both exited 0. All seven source/test blobs
were unchanged after commit hooks. Push additionally passed typecheck, lint,
formatting, oracle/coercion ratchets, 18/18 numeric-local regressions and issue
integrity. The remote branch was independently read at the exact commit.
No merge or auto-merge was requested; the checkpoint retains hold.

The next isolated integration starts at that published source commit:
`/private/tmp/js2-3518-delay-combinator-integration-20260908`, branch
`codex/3518-delay-combinator-integration-20260908`. Worktree creation session
58006 exited 0; HEAD and clean status were verified, with existing dependencies
linked rather than installed. Low B's eight-file delay/combinator manifest
was read completely at
`/private/tmp/js2-3518-native-delay-combinator-bodies-20260908/.tmp/native-delay-combinator-frozen-20260908.json`.
Its 76 authored tests, 13 donor receipts, 11 source artifacts and 19 executions
per root remain unmeasured by the parent; no correctness or physical
acceptance is inferred from its static receipt. High is reviewing the frozen
slice before composition. Low A has a separate canonical-declaration/manifest
assignment; its next claim hook may proceed now that the parent push finished.

### Delay/combinator first composed measurement — 2026-09-08

All eight files were independently checked against the frozen Git blobs and
composed onto `37e169c4903c29ab46fe99de0910634723a19dac`. Canonical
TypeScript 7 passed in session 28403. The initial patch transfer exceeded
tool output limits; it was reapplied in bounded files/hunks and all eight
final blobs were then verified, not assumed from partial tool success.

Session 94422 exited 1: 75/76, comprising 32/33 ownership controls and 43/43
preservation controls. The failed ownership fixture constructs a bare context
without the real timer dependency, so it never reaches its callback-order
assertions. Low B is repairing only the fixture, not weakening the provider's
missing-dependency guard or fabricating a handle.

The paired public-source run completed both child processes with exit 0,
no signal. Candidate root is this integration; baseline is the independently
verified clean source at `1cb0f5c7f36be14d7be7eb4592973aea84a8c4e5` in
`/private/tmp/js2-3518-logical-vector-integration-20260908`. Eleven artifacts
and nineteen executions per root have identical complete rows: bytes, WAT,
compiler results, resource ordering, actual values and instantiated binaries.
Both preserve 70, 3e9, sequential/reverse-parallel completion, empty timing,
both rejection cases, and main's undefined result/stdout under repeated timer
delivery. Delay concurrency and registration rejection, race, allSettled,
any, invalid-before-empty, grown vectors, thenables and poisoned thenables
also executed with their expected values.

Receipts remain under `.tmp/delay-combinator-preservation-EK9dYV/`.
SHA256 of JSON.stringify(parsed report): candidate
`3aafe0b6b74d9be705e3a4e4ac6ff234d2f6e5a9e4941cb3f1f5f7ac128958f4`,
baseline `dee09c362cba469ded3e0134cfc2a59e291b75c244c8aa4c893aa5be839ced27`.
Their complete fixture and row populations were independently compared after
reading the actual rows. This remains preservation evidence, not standalone
prepared-path physical acceptance or retirement.

High found no production defect but two additional receipt defects: child-only
AST serialization misses unary operators/declaration kinds, and the claimed
20 combinator plus four delay retained declarations lack a donor-derived
ledger enforced by tests. Low B must supplement, not reseed, the existing
13 donor hashes with semantic-field and fixed original-declaration controls.
The five candidate whole-file glue hashes do not substitute for either proof.
No publication occurs until these repairs and the fixture pass validation.

Boundary activation session 28649 exited 0: 121/121 controls. Both new runtime
owners are mandatory; eight additional deletion/forbidden-type/unknown-import/
unresolved-import controls were added to the previous 113. The selected clean
closure is exactly 65 modules and 211 edges (150 type-only, 61 runtime).
All 26 previous activation records and the complete allowed-edge policy were
independently compared with HEAD and are unchanged; one new activation record
is prepended. No historical digest was reseeded.

Full inventory session 1674 exited 0 with zero inventory errors: 1,313 modules,
65 clean, five compatibility adapters, 1,243 unmigrated. The same four unknown
dynamic imports remain (two Porffor loader sites, optimize, platform adapter),
so architectureComplete remains false. This strengthens local runtime ownership
without claiming complete compiler closure.

Historical regression session 44597 exited 0: seven suites, 77/77 tests.
This includes 4573 native delay (12), 4574 native async family (14),
2867 all/race (25), 3137 allSettled (10), 3125 assimilation (8),
3125 widened poisoned-then controls (4), and 2918 late function-index shifts
(4). Both parent and fork heap budgets were explicitly 2 GiB, single fork.
The earlier observation was lost; a live process inspection confirmed no
remaining Vitest process before this measured run. No test was killed.
These unchanged historical suites pass on the five frozen production files;
the separate ownership-fixture and supplemental receipt repairs remain pending.

### Recursive-type emitter parallel validation — 2026-09-08

Hilbert's eight-file static manifest in
`/private/tmp/js2-3518-explicit-rec-emission-20260908/.tmp/explicit-rec-emission-frozen-manifest.json`
was fully read and all eight SHA-256 hashes independently verified. Canonical
TS7 session 61467 exited 0. Eight-suite session 94227 exited 1: 253/258.
All 25 layout and 148 reservation controls passed; actual recursive access
returned 42, subtype casts and cross-module canonical value exchange passed.
Two new tests expected `local index` while the actual guard reports
`local (local.get) index out of range`; Hilbert owns only those assertion repairs.
High independently reviews the frozen production changes.

The other three failures reproduce on unchanged base 1cb0f5c7 in session
30017 (20/23, exit 1): issue-2043's old local-error regex, and two foundation
tests pinning obsolete import/name populations. These are not attributed to
the recursive-type patch. No historical expectation has been reseeded.
The emitter patch is not yet composed or published; boundary activation,
paired preservation, High review and repaired focused tests remain required.

### Delay/combinator rev2 composition — 2026-09-08

The worker's full rev2 manifest was read, and only its three test/helper files
were composed. Git blobs independently match: ownership
`442ee5d2a78bd1489d038629bec8a5f98fac06f0`, preservation
`848e6b843f5ee3b6a7f3841be9614b1b32274af9`, helper
`b11067d35989b8a8fae5a77fd44e8e44bd97785f`.
Parent independently recalculated both hashes for every retained declaration
from original commit e3a01efa: all 24 original and semantic hashes match.
The repaired real-timer ownership suite passes 33/33 within ongoing session
87873; its expanded preservation suite and explicit historical pair must
reach terminal completion before claiming the authored 159-test total.
Receipts are under `.tmp/delay-combinator-preservation-xBNfCl/`.
High has been sent the rev2 manifest to review both earlier receipt blockers.

Session 87873 subsequently exited 0: 159/159, comprising 33 ownership and
126 preservation controls. The explicit historical pair passed again with
11 artifacts and 19 executions per root. This is preservation-only evidence;
full prepared native physical acceptance remains uncertified. High review,
normal commit hooks and non-draft PR publication are the next checkpoint steps.

Final publication preparation: session 98446 completed TS7 and scoped Prettier
checks without errors. Parent read both rev2 paired terminal receipts (candidate
87331, baseline 87387: exit 0, no signal) and independently compared the complete
11 fixture/row populations again. Upstream main remains 04c8e721; PR 5758 remains
non-draft, MERGEABLE/CLEAN with reported checks successful and auto-merge null.
The recursive emitter's precise diagnostic assertion repair independently passed
29/29 focused tests; its production review and composition remain separate work.

### Recursive-type integration handoff — 2026-09-08

Delay/combinator checkpoint committed as de2f1072ebb32771272d24a58407814f9d2a5d38
and pushed to upstream with all normal hooks. First commit attempt was refused
only for a missing Model trailer; the retry included the required Default
attribution and passed hooks. No bypass was used. High cleared B rev2 and the
recursive-type production patch without a remaining concrete blocker.

This isolated worktree, `/private/tmp/js2-3518-explicit-rec-integration-20260908`,
branch `codex/3518-explicit-rec-integration-20260908`, starts at de2f1072 and now
contains all eight reviewed recursive-type files. Seven hashes match the
original frozen manifest; the repaired explicit-rec test hash is
7a136f2558f6162a55c1964f076cc0e520399438377f3499af0e7b273929dfe6,
with its focused 29/29 result measured after repair. All eight composed hashes
were independently verified. Root dependencies are symlinked, not installed.
Initial Git status/diff checks hit sandboxed LFS temporary-file permissions;
these are access failures, not evidence of LFS corruption.

Next: activate the new physical type-layout owner and additive boundary controls,
validate composed types/tests and historical paired preservation, then publish
this separate non-draft checkpoint. Do not alter the historical paired outputs
or remove their failing controls merely to obtain green. Three old failures
remain independently reproduced on baseline as documented above.

Published delay/combinator checkpoint: https://github.com/loopdive/js2/pull/5759,
non-draft creation on base #5758 with hold label. Remote branch independently
matches de2f1072ebb32771272d24a58407814f9d2a5d38. This integration builds on
that published checkpoint; it must receive its own PR after validation.

### Composed recursive-type validation — 2026-09-08

Mandatory physical type-layout activation passed session 9063: 125/125 controls,
66 clean closure modules and 214 resolved edges (152 type-only, 62 runtime).
Four new deletion/forbidden-type/unknown/unresolved import controls cover the
new owner. All 27 previous activation records and all allowed edges were
independently compared against HEAD and remain unchanged; one record was added.

Session 68973 passed canonical TS7 followed by eight suites, 258/258. Parent
also repaired three independently baseline-reproduced stale assertions: the
issue-2043 regex now names the actual local.get guard, and the foundation test
requires the exact two canonical type-only imports plus four allocator names
moved in an earlier checkpoint. Runtime behavior, historical output receipts
and production code were not changed to make these tests pass. High was sent
the parent boundary and test delta for review.

PR 5759 watch session 51627 exited 0, including the real-Wasmtime smoke check.
Fresh remote read confirms MERGEABLE/CLEAN, all reported checks successful,
non-draft, head de2f1072 and no auto-merge. Complete IR migration remains open.

Initial rec paired-preservation session 43200 exited 1 (125/126): candidate
completed, but parent incorrectly supplied de2f1072 as baseline. The unchanged
recorder explicitly pins baseline source to 1cb0f5c7 and rejected that mismatch
before running it. This is not a compiler regression or a passing pair. Evidence
remains under `.tmp/delay-combinator-preservation-xTJKNb/`; rerun uses the original
clean 1cb0f5c7 worktree without changing/reseeding the historical guard.

Corrected paired session 55354 exited 0: 126/126, 11 artifacts and 19 executions
per compiler, complete bytes/WAT/resources/outcomes equal. Evidence remains at
`.tmp/delay-combinator-preservation-cceiUu/`. High approved the parent test and
boundary delta without weakening or production-change concerns. This validates
preservation through the composed emitter, not complete prepared async execution.

Full inventory session 75347 exited 0: 1,314 modules (66 clean, five adapters,
1,243 unmigrated), no errors, and the same four unknown dynamic-import sites.
The first compact-report wrapper incorrectly read the outer result instead of
its report field; it failed locally and was corrected, not counted as evidence.
Strict architecture completion remains false.

The existing semantic-provider historical instrument is additionally running
against clean b4c116639a ownership-integration source, to retain synchronous
prepared source/bytes/WAT/resources/value comparisons across both GVN modes.
Outputs remain under `.tmp/explicit-rec-semantic-pair-20260908/`; no outcome
is claimed until its exact running handle reaches terminal completion.

Semantic historical pair session 56110 exited 1: raw preservation is false,
with four differing rows per GVN mode (alias/startup, original/reversed order).
Parent recursively inspected every differing field: only original/replayed
physical modules' funcOrdinalToPosition entries and startup call handles differ
(0/2 versus stable 2097152/2097154). Complete bytes, WAT, outcomes, canonical
prepared data and all other row fields match. Do not normalize this raw result
into a historical pass. The same instrument now runs with published de2f1072
as its candidate in `.tmp/explicit-rec-parent-semantic-pair-20260908/` so the
new emitter's delta can be compared directly to the actual PR base and the
stable-handle attribution verified, rather than assumed.

Parent-control session 52106 exited 1 with the same raw older-baseline differences.
Independent deep comparisons then proved all 15 complete candidate rows per GVN
mode (30 total) exactly equal between published de2f1072 and this emitter patch,
without normalizing any field. Both full comparison reports are also identical,
including all eight stable-handle differences. Thus this checkpoint preserves
the published source/physical outputs, while the b4 historical report remains
honestly different. Only eight of those 30 rows execute prepared physical code;
the other rows retain their documented preparation/provider refusals or public
controls. Neither report is full native-async physical acceptance.

All scoped formatting checks pass. High approved the production and parent
integration delta. The next action is normal-hook commit and a non-draft PR on
base #5759, with hold retained and no new merge authority.

### Native-callable integration start — 2026-09-08

Recursive emitter checkpoint committed as 2b9cb408c18446361fcf9837045067d1fd97c642
and pushed to loopdive/js2 with normal hooks, all eight worker hashes unchanged.
This worktree `/private/tmp/js2-3518-native-callables-integration-20260908`, branch
`codex/3518-native-callables-integration-20260908`, starts at that checkpoint.
Only A's ten production files are composed so far; all ten SHA-256 hashes match
the fully read revision1 frozen manifest from native-family-callables worktree.
No tests/typecheck have run on this composition yet. Existing dependencies are
symlinked; no install was performed.

High cleared A production but requested a test-only revision: pin each of six
bindings to its exact feature/provider/implementation, demand them separately,
pin all eight delay/all dependencies, and add feature-swap and missing-settlement
controls. A is repairing only the three focused test files. Do not compose an
unfrozen partial test revision. Parent still owns constant forwarding, authenticated
clock projection in ordinary/derived bodies, additive clean-boundary activation,
full-source eight-scenario validation, and physical materialization. The original
goal and ABI30/retirement obligations remain open.

Recursive emitter checkpoint is now published as non-draft
https://github.com/loopdive/js2/pull/5760, base #5759, head 2b9cb408c1.
The remote branch was independently verified at the full recorded commit.

### Native-callable composed evidence — 2026-09-08

TS7 session 96067 passed on the ten frozen production files. Rev2 tests were
composed after fully reading their manifest and verifying all three blobs.
First session 17059 was 81/82: only an empty void logical source fixture failed
before its ABI assertions. Worker rev3 changed only that fixture to an explicit
bare return (replay blob 95ddd43ac88a25f06b8fca6787b0097dde16353c).

Parent forwarded all six compatibility constants from core/async-callables and
added a static exact-forwarding control. Actual full-family session 47412 passed
82/91, including all 55 source-identity tests; eight family scenarios and fresh
source-free replay exposed Promise.all's argument validator incorrectly refusing
the actual non-null externref vector against its nullable parameter. The saved
packet independently confirms that precise type in fetchAllParallel. Parent
fixed only one-way false-to-true vector argument compatibility, retaining exact
element types and strict result types, with reverse/number/Promise-carrier
negatives. Session 85743 then passed 25 declaration controls; all eight source
scenarios advanced to the explicit native-string-policy refusal rather than
the obsolete unknown-declaration refusal. The old expectations are not yet
updated; neither run is claimed fully green.

With explicit native-string/concat policy, the unchanged full-family packet
now reaches a separate real gap: assertPreparedIrProgram throws for undeclared
intrinsic __ir_vec_elem_set_externref in fetchAllParallel's derived state zero.
The complete callable-declaration check remains intact. High is specifying the
closed vector-helper contracts together with authenticated ordinary/derived
clock projection; do not skip the missing declaration or claim native acceptance.

Focused session 54317 passed 83/83 after the fixture/forwarding/nullability fixes
(25 declarations, 46 providers, 12 replay). Rev2 provider-oracle repair was
approved by High. The two new modules are now classified as mandatory clean
owners; compact inventory 37239 has no errors and independently measures 68
selected modules, 228 edges (158 type-only, 70 runtime). Boundary controls are
running after adding all eight owner-specific negative cases. No PR has yet
been created for these uncommitted callable changes.

Boundary session 65096 subsequently exited 0: 133/133, including all eight
negative controls for the two new owners. Parent independently compared all
28 previous activation records and the allowed-edge policy against HEAD; all
remain exact. Two new activation records are prepended. High confirmed the
non-null-to-nullable argument fix is correct and identified the vector-set call
already in the retained source packet (the async transform carries it forward).
The missing canonical vector declaration is not solely a transform artifact.

### Clock/vector continuation — 2026-09-08

The recovered Astra High specification is recorded in
`plan/agent-context/3518-clock-vector-admission-plan-2026-09-08.md`.
Implementation is split between Astra Low native subagents in isolated trees:
`codex/3518-vector-callable-admission-20260908` owns the single measured
externref vector-store callable contract; `codex/3518-clock-projection-20260908`
owns ordinary/derived clock projection and independent positional validation.
Parent owns their shared demand join, source-family tests, boundary updates,
integration and non-draft PR publication. Existing frozen worker trees remain
untouched. Neither slice admits physical native async execution.

Prior validation handle 18810 is missing; a process-table check confirmed no
live matching TypeScript/Vitest process before replacement validation 6170.
The replacement passed TS7, then exited 1 with 63/66 tests: runtime-manifest
8/8 and historical reconstruction 55/58. The three failures reject current
manifest declaration order and changed intrinsic-support receipts. High is
specifying an explicit historical reconstruction adaptation, retaining original
hashes and adding checked deltas; they are not waived or counted green.

The original eight policy-omitting full-family cases now explicitly test the
measured native-storage-policy refusal. Eight additional native-policy cases
require actual complete preparation and record separate source, post-async and
post-optimization call populations, including empty owners and unrecognized
references. These are acceptance tests, not a replacement refusal gate; their
new execution is pending and the vector/clock implementation remains open.

Native-family session 12153 exited 1 with 36/44 passing: all eight new explicit
native-policy cases reject the missing externref-vector declaration. All prior
36 controls pass, including located missing-policy source-free replay and all
eleven real forbidden imports. Parent read all eight recorded stage censuses:
source 5 owners/22 call references; post-async 16/33; post-optimization 16/33;
independent final validation recollection 16/33. Each population has exactly
one unresolved reference, the vector-store helper (source owner
fetchAllParallel, derived owner fetchAllParallel__ir_async_state_0). All empty
owners remain recorded. Initial census labeling omitted the fourth validation
scan; corrected to retain explicitly named validation stages, not discard it.
Receipts remain under `.tmp/native-family-native-policy-*` in the integration
tree. TS7 session 97422 exited 0 after the new tests. A further fresh-process
native-policy acceptance case is now added and awaits its measured run.
Upstream main was rechecked with ls-remote and remains
04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0; no root checkout changes or merges.

Session 51223 then exited 1 with 36/45: the added fresh-process native-policy
case reproduces exactly the same missing-vector declaration (child exit 1,
no signal), while all prior controls still pass. Its terminal and forbidden-load
census are retained in the source-free temporary receipt directory. No native
preparation or physical execution success is claimed. The checkpoint remains
unpublished pending its implementation fixes and historical-receipt repair.

The High-reviewed historical reconstruction specification is saved in
`plan/agent-context/3518-callable-historical-reconstruction-plan-2026-09-08.md`.
A third Astra Low native subagent owns only its shared test helper and four
receipt/ownership suites in isolated branch
`codex/3518-callable-historical-reconstruction-20260908`. It must authenticate
each approved addition before inverting it and applying unchanged historical
hashes; future vector/clock deltas are not pre-authorized by a generic filter.
All three new worker trees are seeded from 2b9cb408 plus the current reviewed
callable changes, preserving prior frozen trees. Parent retains integration and
PR publication. Heavy tests remain serialized: the vector worker now holds the
exclusive next TS7/focused-test slot; clock and receipt workers must wait for an
explicit grant. No parent heavy process remains live after session 51223.

Continuation revalidation found vector implementation had not started: its
slice was UNASSIGNED, and the worker interpreted the implementation no-commit
instruction as blocking normal claim acquisition. Parent clarified that normal
reservation commits/hooks are authorized, without hook bypass or force-steal.
The unused heavy slot was transferred to the ready clock worker; vector and
receipt claim hooks queue behind it. Clock implementation is present in its
isolated tree but is not yet frozen or integrated. Parent preliminary review
requested explicit `clock projection` diagnostic attribution for selected-clock
corruption tests, because generic rejection could be caused by reproduction or
attachment identity checks instead. No completed clock test result is claimed.

Clock TS7 handle 20287 subsequently exited 0. Its first suite run 88288 exited
1 during setup (37 skipped, zero tests executed): the synthetic async state
fixture omitted a typed entry block. The subsequent fixture attempt also
stopped during setup; worker corrected a cross-state SSA fixture reference by
moving its clock after await, retaining the derived-body clock regression.
No setup failure is counted as either passing tests or a demonstrated
production defect. Further clock reruns are paused until claim hooks finish.

Vector reservation 54899 exited 0 and the worker verified its upstream record:
write 22123-8oqnd4vn, claim commit
01fb870b2d117cdc815470ca8625c2f5387103a6. Static implementation has now started
in the assigned isolated tree. The historical worker holds the next claim-only
slot, then clock receives the validation slot again. No tests were killed.

Parent independently confirmed vector ownership with check70455 (exit3 means
the intended worker holds the claim, not a failed read). Historical check38881
likewise confirms the intended owner since 15:44:53Z. No additional claim is
needed. A parent fallback claim attempt20108 failed before creating a commit
because an added signing request expected unavailable GPG; no retry or signing
configuration change was made. The temporary helper was removed. Clock now has
the heavy-test slot again while both claimed workers implement independently.

Parent prepared the two new vector boundary activations and eight negative
controls, without claiming validation before the modules are integrated. All
30 previous activation records compare exactly after the two new records;
allowedEdges remains byte-for-byte equivalent. Closure edge counts still await
measurement on composed production code. Historical digest values are unchanged.

Clock slice frozen and composed: worker TS7 36183 exited0, suite88182 exited0
with 37/37 passing. Parent fully read the incremental manifest, verified both
seed hashes against its current files, copied only the three owned files, and
verified all resulting SHA256s exactly: intrinsic-support
81efcacea391a614899489c24dc184ccf886337880b89b4520d3a2a6b155e3fb;
program-runtime-validation
bb4006f9bcdf641f665b6b1ee10ea6fd8ced30e168d09faf8439358d574f2b0c;
clock test ea7c9df0ca480f3dd5782a5f2e0b011b81e6f3db5b89b525d229be5e785312ea.
Manifest SHA256 c48c0e5b6cb62bcb1c5a49227053e1aa3ccd3cd588f98e90c8736ebadc52ba62.
The suite uses independently prepared fixture groups; corruption cases assert
the clock-specific witness diagnostic, while replay is separately exercised.
Parent composed TS7/four-suite validation90450 is pending. High production
review is also pending. No vector declaration or physical guard is bypassed.

The next connected physical vector implementation specification is saved in
`plan/agent-context/3518-native-vector-physical-materialization-plan-2026-09-08.md`.
It includes canonical grow/store bodies, shared layouts, reservation-backed
provider binding and consumer integration. Dispatch waits for this logical
checkpoint's freeze; an isolated body extraction is not its acceptance target.

Parent validation90450 exited0: TS7 passed, then all 120/120 focused tests
(37 clock, 12 callable replay, 46 provider, 25 declaration). This proves the
composed clock/callable slice, not full-family preparation or physical execution.
No parent heavy process remains live. Vector admission and exact historical
receipt reconstruction remain the next integration obligations.

High completed production-only approval of the exact composed clock hashes:
no concrete blocker found in explicit-demand/provider authentication,
copy-on-write block/state projection, positive-zero/site preservation, allocation
rejection or independent positional checks. Reproduction and attachment-current
checks remain intact. This is not a physical-native acceptance or retirement
approval. Vector draft is now under separate production review before composition.

Vector admission is now composed, including the separate occurrence-demand
population and parent-owned clock/vector join. High production review approved
all eight vector production files and the composed join without concrete
blockers. Parent validation88927 exited0: TS7 and 106/106 tests (61 vector,
45 full-family source-contract). The original/export-only source, each with
GVN on/off and raw/decoded input, now prepares in all eight native-policy
cases. The fresh source-free child also prepares; missing-policy and forbidden
import controls remain enforced. Saved successful receipts remain under
`.tmp/native-family-native-policy-*/receipt.json`. This proves preparation,
not physical execution, public cutover, or retirement.

Recovery inventory46161 exited0 with 70 selected modules and 239 edges:
163 type-only and 76 runtime. Current closure-count assertions were updated
to that measured population; historical hashes were not changed. Boundary
suite77191 is running; no pass is claimed yet. The four-file pre-clock/vector
historical inverse is frozen in the isolated historical worker tree, with
tests still unrun and separate clock/vector inverse layers still required.

Boundary77191 subsequently exited0: 141/141 tests passed in 76.85 seconds,
including actual closure and deletion/type/runtime/unresolved-edge controls.
The historical worker now owns the exclusive heavy-validation slot for its
three pre-clock/vector suites. High reviews the frozen inverse concurrently;
no historical pass or complete compiler-closure/retirement claim is made.

With logical production frozen and reviewed, the two Low native subagents
received the connected physical vector specification: Maxwell owns the pure
grow/store body, shared descriptors and legacy adapter; Hilbert owns the
reservation-backed resource planner/materializer. Both must use fresh isolated
trees, preserve their earlier diffs, and claim before source edits. Claim hooks
wait for the historical test slot to release. Parent retains physical-plan and
consumer integration. This dispatch overlaps setup with historical validation;
it does not waive that validation or authorize publishing an unchecked checkpoint.

Historical pre-clock/vector validation11005 exited0: 3/3 suites, 470/470
tests in 47.63 seconds, using the documented 2GiB single-fork command. Parent
read the saved validation receipt and independently matched all four current
Git blobs to frozen rev1. No repair or TS7 run was needed/performed. This pass
does not cover the composed clock/vector extensions; their checked inverse
and composed validation remain required. Maxwell received the released
claim-only slot for physical vector body ownership.

High historical review found a positive-first control defect: mutation setup
was inside some expected-rejection closures, allowing setup failure to satisfy
the negative. Worker is correcting that before adding the exact checked
clock/vector inverse. The complete High extension contract is saved in section5
of the historical reconstruction plan. No historical hashes are rebaselined.

Upstream main reverified unchanged at
04c8e72156cf576cf584a3ed3a5a66ec5a2b91b0. Maxwell reports claim1146 exit0,
write30305-t7ft6tyi/commit2d54499bd399a269b9a872109047ee6700b2d59a and
remote ownership verification; its source implementation is active. Hilbert
received the released claim-only slot for the independent physical resources.
High is now specifying the subsequent connected Promise/frame resources while
these vector slices proceed. Full-family physical execution remains open.

Parent consumer slice now has its own isolated tree:
`/private/tmp/js2-3518-native-vector-consumer-20260908`, branch
`codex/3518-native-vector-consumer-20260908`, base2b9cb408c18446361fcf9837045067d1fd97c642.
Claim22518 exited0 and verified upstream ownership; temporary operational
helper removed, no main push. Two production files now retain logical vector
signatures until reservation and wire shared types, the required helper slot,
ABI binding, fill and cache-only resolvers into the consumer. Exact unit-order
receipt excludes only the reserved helper and startup objects. The async guard
and unrelated physical gaps remain. These changes are untested until Hilbert's
resource implementation and Maxwell's body implementation compose; they are
not mixed into the current logical checkpoint. Hilbert is checking the API join.

Parent physical tree now includes Maxwell's three frozen grow/store production
files, copied only after matching the recorded SHA256s and unchanged target
base. The full new builder and legacy adapter diff were reviewed; the replaced
hole-sentinel wrapper calls the same allocator and produces the same two
instructions. Final copied SHA256s match production-r1 exactly. Focused tests,
public byte pairing and execution are still pending; no static comparison is
counted as an execution pass. Hilbert's API review found no shape mismatch in
the consumer join; resource implementation remains in progress.

The physical consumer tree now also carries all16 frozen logical-admission
production files. Each existing target matched the exact base before copying;
parent verified final byte equality for16/16 against this logical checkpoint.
The logical checkpoint itself was not changed by that composition. Maxwell has
the exclusive focused grow/store test and sequential TS7 slot; execution results
are not yet available. The composed historical inverse remains in progress.

Physical consumer composition now includes Hilbert's two frozen resource files:
program planner SHA256 b7f82b5c7afe14aa0e38acaf9b5e0b922f9a9b8d3ae2c9081c25b81da870a045;
backend materializer SHA2564da46ab8bc0340894e426ff35f061d193d3fcb3406d1f73b59da05584287341e.
Parent read both complete sources, verified hashes before/after copying, and
linked existing dependencies without installation. The combined tree contains
16logical +3body +2resource +2consumer production files; TS7 remains unrun.
Maxwell's first body suite reports14/22 passing, with eight failures at the
donor text receipt; no full execution or preservation pass is claimed. Its
isolated TS7 runs next, then parent combined typecheck receives the slot.

The complete High native Promise/frame resource specification is saved in
`plan/agent-context/3518-native-promise-frame-materialization-plan-2026-09-08.md`.
It requires real resolve-value/thenable dependencies, shared queue/vector
identity, frame materialization, timer publication and native strings; it does
not permit temporary classifier fallback bodies as completed implementations.

Combined physical TS79890 exited1 with two resolver-shape errors only:
`IrVecLowering` also requires length/data field indices. Parent added0/1 from
the already-authenticated two-field descriptor in its own lowering adapter;
no worker resource/body changes. Recheck40245 exited0. This is the first TS7
pass over all23 composed production files. Existing typed-preparation and
program-codec-replay suites are now running as54407; no test pass is claimed
before termination. Formatting was unchanged and scoped diff checks passed.

Regression54407 subsequently exited0:2/2 suites,57/57 tests in28.76seconds.
These are existing typed-program preparation and program-codec replay tests,
not new vector physical execution coverage. Hilbert receives the next focused
resource-test slot after freezing/copying its tests into the composed parent;
the unseeded isolated worker tree is not an authoritative combined test target.

Resource suite15231 exited0 in the composed physical parent:28/28 tests,
including four complete-source planning/replay/GVN cases and four actual
reserved-helper execution cases (local/shared exception tag, with/without
function-import offset), plus descriptor/provenance/lifecycle negatives.
No test or production repairs; copied test SHA256 remains
1211e2b1b24c1beb03cd90bfca20cda3f9e29e128887ce0053fbf17761596385.
This proves isolated physical vector helper execution, not whole-family
consumer execution. Maxwell receives the released slot for repaired body and
donor preservation suites. High physical review and boundary closure remain
open; parent identified new resource imports through mixed program facades as
a boundary concern requiring repair without weakening validation.

Parent changed only the backend resource utility import from `ir/program.js`
to its exact re-export owner `ir/program/data.js`; no algorithm or validation
was removed. This post-r1 delta still needs composed validation.

Parent read grow/store validation-r3 and frozen-r2 records:22/22 body tests and
20/20 donor tests pass (42/42, zero skipped); isolated TS770823 exited0 on the
same unchanged production snapshot. The eight earlier failures were repaired
only by restoring one extraction-boundary newline in the test reconstruction;
original construction/locals hashes remain unchanged. Public compiler byte
pairing is still required and now granted to Maxwell against exact2b9 baseline.

Physical resource r2 is now integrated with the checked parent wrapper. The
canonical calculation consumes seven narrow data fields, while the parent
retains full program/projection authentication and the private acceptance
authority. Exact provider ID/feature checks and three independent negative
controls were added. R1's28/28 does not validate this revision; new checks await
the historical worker's test slot. The physical boundary policy now activates
the three new modules. Parent independently verified all32 prior activation
records and allowedEdges unchanged. Closure edge counts and the expanded
negative suite are not yet measured; historical hashes remain unchanged.

The four frozen composed-rev3 historical test files are now integrated into
this logical checkpoint. Each target matched base2b9 before copying and each
source matched the rev3 manifest; final Git blobs match a20d372c5135f47a348b9e46bd643bba5f679713,
6282bf27e03d540f87ddb61fc30b8d80bc7ae30e,6b0986c882129c9f75a784fcd84308eba4af00f8,
693227c2413412d030ae47f1db0be09674c5c738 respectively. The worker's required
three-suite run is confirmed live (process39150 with Vitest39158/39168), not
timed out or restarted. No composed historical pass is claimed yet; High
review and logical checkpoint TS7 remain before publication.

High source review approved the exact four copied rev3 hashes. Final sign-off
still requires the existing suite's terminal result and parent TS7; no repeat
review, parallel suite, cancellation or restart is needed.

Composed historical run10243 subsequently exited1:629 reported passes and two
failed controls out of631, plus a Vitest worker `onTaskUpdate` timeout. It is
not a clean full-three-suite verdict. The missed controls are callable import
movement and changed clock inverse span0. Worker is repairing those exact
acceptance holes without dropping controls or changing historical hashes, and
will yield via `setImmediate` between synchronous tests so RPC updates drain.
The failed run is preserved. Parent logical TS797404 is now running; further
suite runs remain serialized. Source review approval did not override this
contradictory execution evidence.

Logical TS797404 and physical-r2 TS717919 both exited0. Physical inventory77057
exited0 with73 activated modules,259 edges (174 type-only/85 runtime), no errors.
Current edge assertions were updated from those measurements; historical hashes
were not changed. Physical resource/boundary suite16994 is now running. The
historical worker repairs the two missed mutation controls statically, then
receives the next slot for focused reproductions before a full rerun.

Physical run16994 exited1:31/31 resource tests and152/153 boundary tests passed.
The remaining boundary control assigned `ir-program` to the already-ir-program
first record, so it was a no-op. Parent changed it to `ir-core` and added an
accepted positive plus explicit changed-digest check outside the rejection
closure. Focused rerun passed5/5 selected controls (148 unselected); the full
corrected boundary suite remains to rerun. No production repair. Historical
worker receives the released slot for focused repaired controls, then full
three-suite validation if those controls pass.

Historical revision4 terminal20877 supersedes the failed revision3 verdict:
763/763 tests passed across3/3 suites, exit0, no unhandled errors,429.01s.
The full rerun was already live when focused-first sequencing was requested;
no separate focused run was performed. The run overlapped parent checks and
must not be described as exclusively serialized. Both original failing
controls passed without removing controls or reseeding historical hashes.
The repair checks complete import-block placement and the complete leading
clock-projection documentation; afterEach yields for Vitest RPC updates.
Parent integrated the two changed files and verified SHA256 values
114a21cb1bc05bfe64045a12f8fa5474a729284f442afc4c155234bc3e08aafc
and5f79142356e98679cb4087e001c0fe6bc9c5a8af0cd75b37d80360284eb28ec3.
Repair-delta High review and post-integration TS7 remain before publication.
This preservation evidence does not establish full native physical execution,
public IR-only cutover, strict graph closure, or direct-codegen retirement.

Post-integration TS7 session16199 exited0. High repair-delta review approved
the exact revision4 blobs, with no remaining concrete repair blocker. Parent
also compared all16 changed production files against the tested worker tree:
16/16 byte-identical, zero mismatches. PR shepherd's fresh19-PR pass found no
conflicts, unresolved review threads, or reported failing/pending checks.
Stacked PRs5752 and5754–5760 lack required checks because CI targets main;
their mergeability is not evidence of complete CI coverage. Existing holds
remain, and neither this checkpoint nor those checks establish retirement.

## Physical vector checkpoint after PR #5763

The physical vector checkpoint is based on6ed68535323e0756c3a0b15dde18fd480ad7fc9f.
It composes same-ledger vector layouts, the canonical grow/store body, checked
resource planning and consumer binding while retaining the async physical
refusal. All12 transferred implementation/test files matched their reviewed
source tree exactly. No existing worktree was reset or replaced.

Fresh composed-tree session10660 exited0: TS7 and226/226 tests across4/4 files
passed (153 boundary,31 resources,22 body,20 donor). Public compiler comparison
revision2 controller82714 and both children exited0:14/14 pairs,28 rows,
56 expected calls, zero raw differences and five rejecting negative controls.
The comparison covers both hole-fill arms, dense carriers and packed branding;
it is extraction preservation, not execution of the full prepared async family.

Detailed limits and provenance are in
`plan/agent-context/3518-native-vector-checkpoint-handoff-2026-09-08.md`.
Promise resolution and same-ledger Promise resources are the next active
implementation slices. Full frame/timer/string execution, public IR-only
cutover, strict closure and the ABI30 witness remain outstanding.

## Promise resolution extraction after PR #5764

The next checkpoint extracts resolution, thenable jobs, settle closures and
finalized classifier body construction into two canonical native runtime
modules. Legacy adapters retain allocation/cache/finalization ordering and
compatibility paths. Completed native callers must provide the real captured
then invocation binding and authenticated complete resource inventories.

High review found and the worker repaired two test defects: reliance on Git
history during shallow-checkout collection, and opcode-only closure checks.
The repaired self-contained fixture authenticates six original declarations;
24 independent coordinate combinations yield48 complete resolve/reject
comparisons with48 wrong-field and48 wrong-target controls. Worker TS7 and
49/49 tests passed. High approved the exact repaired files. None of these
checks establishes public source execution or whole-family native execution.

Parent integrated all four production files and both repaired test files by
verified SHA256. Composed TS7 passed. The active closure now contains75 modules
and263 edges (176 type-only,87 runtime), with no reported closure errors.
Prior activation records, allowed dependency rules and historical hashes are
unchanged. The first composed suite passed209/210; the only failure was a
stale unique-module assertion expecting73 instead of75. It was corrected and
full rerun5973 remains live. Do not report that rerun as passed yet.

Detailed evidence and outstanding limits are recorded in
`plan/agent-context/3518-promise-resolution-checkpoint-handoff-2026-09-08.md`.
The vector-comparison instrument and reproducibility handoff are also retained
under plan/agent-context. Public Promise comparisons are being prepared;
Promise resource materialization is a separate concurrent implementation.

Composed rerun5973 subsequently exited0:210/210 tests across2/2 files passed
in96.37s. This supersedes its pending status, not the execution limitations.

## Confirmed ordinary-thenable capture defect

Public comparison controller76198 exited1 although both compiler children
exited0. All24 baseline/candidate pairs were raw-equal: the extraction
preserves existing behavior. All48 compilation rows,96 instances and184
export observations were attempted. Semantic acceptance is false.

The additional ordinary-object getter-capture recipe fails identically in
both IR modes and both fresh instances on both arms: getter count2 instead
of1; original callback calls0 instead of1; replacement calls1 instead of0;
delivered value99 instead of42; trace13184 instead of1324. The queued job
therefore does not preserve the original captured then method for this case.
Keep the failing row and original receipts. This is an existing correctness
defect, not an extraction regression, and cannot count as native completion.

High is specifying the bounded canonical resolution/job repair before Low
implementation. Acceptance must retain once-only getter access, original
callback capture, poisoned-getter rejection, recursive adoption and the full
comparison denominator. Do not replace the expected values or normalize the
failure away. The original report lives in the instrument worktree under
`.tmp/promise-resolution-public-parent-r1/comparison.json`.

## Native Promise resource checkpoint (2026-09-08)

The isolated checkpoint on #5765 now derives authenticated selected-program
requirements and reserves native Promise resources in the existing physical
ledger. It activates two resource modules without relaxing historical
boundary rules. Session19123 passed192/192 controls (169 boundary,23 resource),
and composed TS7 session42272 exited0. The77-module closure has286 edges:
187 type-only and99 runtime, with no reported closure violations.

High review found no source or boundary-policy blocker but requested a
positive-paired unsealed-program rejection test. That test is added and awaits
its scoped run; it protects the checked wrapper's leading authentication.
Full filling and execution remain unproven: actual value, object, string,
TypeError and closure dependencies are still required. The consumer's async
refusal remains, as do strict closure and retirement gates.

The getter-capture fix is now High-specified and delegated to native Astra Low
in a separate worktree on #5765. The implementation contract and checkpoint
handoff are in `plan/agent-context/3518-promise-getter-capture-implementation-plan-2026-09-08.md`
and `plan/agent-context/3518-native-promise-resource-checkpoint-handoff-2026-09-08.md`.

The requested unsealed-program control subsequently passed with all24/24
resource tests in13.76s; session2053 also passed composed TS7 and exited0.

## Capture-once Promise integration (2026-09-08)

The ordinary then getter defect is repaired in canonical runtime bodies and
their legacy callers: resolution returns callability plus the first captured
function, stores that function in the existing callback field, and the queued
job invokes it with the original receiver. Compiled-method dispatch retains
its existing null-capture path. The native resource pack reserves and fills
the matching two-result lookup without replacing the legacy classifier.

Pauli's isolated explicit-mode suite passed63/63 (49 historical preservation
controls plus7 runtime cases in each of direct and experimental-IR modes).
Parent composed TS7 and87/87 tests passed twice:38918 before budget helpers,
96871 after them. The second run took22.78s. No size allowance was added.
High approved production changes, resource adaptation and private helpers.

The requested two additional historical signature/fill cases are integrated
with exact worker hash03091b33df320d43edd63b64fbebc293b5b2fb81a93388ef6b19c35244a8b271.
Their positive-first4 signature and5 actual-fill mutants still need a terminal
composed result. Boundary regression and the independent public comparison
also remain pending. Original donor hashes and failing baseline receipts are
preserved; this is not full native resource execution or retirement.

Final proof and boundary run31410 passed TS7 and259/259 tests in117.47s.
High approved the added independent body oracle and all scoped changes.
Public repair comparison94830 exited0: all24 candidate cases passed their
semantic expectations, all14 comparator controls passed, and the baseline
reproduced its exact20 known gaps. Both arms completed48 compiles,96 instances
and184 observations. Raw outputs differ; baseline/candidate equality is not
the criterion for correcting the defect. Exact frozen-source scope, hashes
and limitations are retained in the adjacent agent-context result/handoff.

## Native string literal and TypeError resources — 2026-09-08 checkpoint

On getter checkpoint00976e841109235a79991145ee5f0c30933bf3b1, extracted real
string layouts/literal bodies and the six-field TypeError constructor into
canonical runtime modules, with same-ledger backend reserve/fill operations.
Legacy callers retain their registration order, caches and name fallbacks.
Five modules enter the clean boundary inventory; historical activation
records and allowed edges remain unchanged. Measured closure:82 modules,
298 edges (194 type-only,104 runtime), zero unresolved/forbidden edges.

Composed TS7 and213/213 tests passed in session99746 (24 resource/preservation
and189 boundary cases). High approved all eight production files and the
final test-only repair:29 authored cases preserve the24-test prefix and add
actual live/donor constructor comparisons plus two live-guard mutants.
Those five additions await execution; earlier results do not cover them.
Exact donor spans and full-source hashes were independently checked against
5118637e. Collection uses a committed authenticated fixture, not historical
Git availability. Details: agent-context/3518-native-string-error-integration-2026-09-08.md.

Next integrate checked primitive values, then the actual string scanner and
its flatten/exponent/power dependencies; follow with closure/argument-vector
and object/callable inventory joins. A correctly named scanner signature is
not implementation proof. Full Promise execution, fresh-process replay,
IR-only cutover, strict closure, ABI30 witness and direct retirement remain
open. This checkpoint does not satisfy those acceptance requirements.

Final scoped approval and execution: High approved the five live-constructor
controls; parent67641 exited0 with29/29 tests passing in10.08s. All eight
production hashes and the authenticated fixture remain unchanged.

## Native primitive-value checkpoint — 2026-09-08

On #5770, canonical primitive layouts and number bodies now back legacy
callers and same-ledger native resource fills. The checked value-plan entry
authenticates the whole program and selected projection. Integrated TS7
passed;70/70 focused tests passed (60 resource/preservation and10 admission
controls). Repaired comment receipts preserve the original tests and hashes;
the preceding59/60 failure remains recorded rather than discarded.

Four new boundary owners produce a measured86-module,313-edge graph
(203 type-only,110 runtime), without unknown/unresolved/forbidden edges.
Historical activation records and allowed edges are unchanged. Expanded205
boundary controls are still running; final review and publication pending.
See agent-context/3518-native-value-integration-2026-09-08.md for receipts.

This does not complete native strings: the genuine scanner, flattening and
exponent/power resources remain next, followed by closure metadata/ObjVec
and complete object/callable dispatch. Existing Promise pack ownership of
settle captures/trampolines must not be duplicated. Full-family execution,
fresh-process replay, cutover, strict closure and retirement remain open.

Expanded boundary suite86860 subsequently exited0:205/205 passed in132.76s.
The full High native-value implementation plan is included in agent-context.

## Native scanner dependency authentication — 2026-09-08

On #5774, parent added encoding-specific literal lookup through existing
interning identities and completed-string attestation through the existing
physical ledger. This lets flattening require the genuine UTF16 empty global
even when an equal UTF8 literal was demanded first. Old text-only lookup is
unchanged. Forged/foreign owners, incomplete fills and changed completed
global/function contents are rejected by the new completion accessor.

TS7 and34/34 focused tests passed in96731 (5 new completion controls and29
unchanged literal/error cases). Independent review and publication pending.
The full frozen scanner implementation plan is included in agent-context.
Hilbert owns flatten/copy/optionalUTF8decode; Maxwell owns StringToNumber and
grammar/power resources. Parent owns string authentication and the subsequent
owned-scanner dependency in native values. Euclid owns disjoint ObjVec work.

Reservation-phase producer authentication is separate from completed-fill
attestation: reserve-all-before-freeze cannot require completed dependencies.
Neither accessor establishes whole-program execution. Actual scanner,
flattening, resource-chain execution, replay and retirement remain open.

### Scanner materialization integration — 2026-09-09

The pending scanner checkpoint now lives on its own branch,
codex/3518-native-scanner-materialization-20260909, based on #5775; it must
not overwrite the already-published producer-authentication checkpoint.
Canonical flatten/decoder/scanner resources and genuine owned native-value
joins are integrated. The generic instruction walker now has canonical
ownership while legacy callers retain the shared algorithm.

StringToNumber malformed exponents previously returned1 for `1e` and `1e+`.
The shared scanner now rejects missing exponent digits; parseFloat's prefix
grammar remains unchanged. High approved exact semantic-delta accounting,
original13-function/34-constant donor reconstruction and the expanded156
UTF/view recipes. Candidate and immutable baseline public source controls
each passed43/43; this is not yet paired byte-preservation proof.

Current blocker: composed R3 run97437 passed139/185 and failed46/185, all
rooted in the shared UTF8 decoder trapping on a nonzero-offset whitespace
view. The declared `Utf8String.off` field is not consumed by the decoder.
Keep those genuine offset probes; repair the shared production algorithm
after contract review, explicitly account for the semantic delta in both
donor and public projection proofs, then rerun the whole recipe population.
Do not remove coverage or claim that a static check proves execution.

Public three-arm proof has22 passing guard controls; the full66-scenario
run is not yet executed. Bounded compiler ownership has237 passing controls.
Full-family execution, replay acceptance, public IR-only cutover and strict
direct-codegen retirement remain required. Detailed failure and revision
provenance lives in agent-context/3518-native-scanner-integration-2026-09-08.md.

The reviewed shared-decoder repair is now integrated: byte cursor starts at
`off` and ends at `off + byteLen`, without changing allocation or decoding
branches. Targeted5/5 and full scanner/value-chain/walker159/159 pass,
including all156 original expanded recipes. This fixes the46 failures above;
it does not erase their provenance. Decoder-specific mixed-width controls,
the second exact preservation delta, public three-arm pairing and final
composed typecheck remain before publication.

Subsequent proof execution closes the runtime items above:71/71 flatten and
public-preservation tests pass, including66 programs in each of three child
runs,132 calls per run and zero baseline-versus-projection differences.
The untouched candidate produces NaN for malformed exponents while original
baseline results remain recorded separately. Direct decoder27/27 controls
also pass, including18 windows and7 semantic mutants. Post-repair bounded
compiler ownership237/237 passes. Final review and composed typecheck remain
publication prerequisites; full migration acceptance is still open.

Final scanner checkpoint validation is complete:286/286 combined focused
unit controls,237/237 bounded ownership controls and final composed TS7
pass. High's four harness findings were repaired and approved. Ordinary
unit tests need no external checkout variables; the dedicated verifier
retains mandatory66-row/three-arm execution with authenticated native
loader identity, and completed with zero preservation differences.
The two intentional semantic corrections remain explicit: malformed
exponents yield NaN, and valid UTF8 views honor their byte offset/end.

Publication does not establish public cutover. The current production
compiler still calls direct generateModule/generateMultiModule, and the
prepared-program emitter has not yet wired these string/value producers.
See agent-context/3518-native-string-consumer-census-2026-09-09.md for the
next required production integration boundary and ownership coordination.

### Native string type reservation for real consumer integration

The independent type-split draft now preserves a types-first import window,
authenticates single-use literal ownership and exposes a complete private-chunk
inventory. Revised TS7 and 54/54 focused tests pass; final review has no blockers
and 188/188 existing flatten/scanner/value caller regressions pass. Exact provenance and
limitations are recorded in
agent-context/3518-native-string-types-split-2026-09-09.md. This is a prerequisite
for actual prepared-consumer wiring, not evidence that the public direct path
has been replaced. Paused P/C async drafts remain untouched.

### Native string/value demand census checkpoint (2026-09-09)

The provider-free collector now preserves the exact ordered owner, buffer,
instruction, intrinsic and literal populations across program/projection and
async views. It preserves borrowed allocation metadata and presence semantics;
it is not an acceptance authority. High review approved the source and focused
tests after local validation, exact occurrence controls and a non-number
intrinsic control were added. The final focused suite passes 40/40 and TS7
passes. See agent-context/3518-native-string-value-demands-2026-09-09.md for
hashes and the retained initial fixture failure.

The collector is registered as a mandatory clean ir-program module without
changing allowed edges or historical activation records. This is preparatory
work: shared symbolic producer declarations, actual prepared-consumer wiring,
original/decoded execution, public cutover and direct retirement remain open.

Final composed validation passes 281/281 (241 boundary controls, 40 collector
tests), with an exact bounded census of 95 modules and 345 imports. This does
not establish strict whole-compiler closure or direct-codegen retirement.

### Explicit native string-number source admission — 2026-09-09

High approved the three production changes and the revision-3 source tests
in the isolated source-admission branch, based on
`31e4e232eb16804afc1577055d33d1c6530c0e22`. This is an explicit, default-off
frontend selection: `nativeStringValueProjection: "standalone-native"`
requires the source policy and every requested runtime projection to be
standalone WasmGC before lowering. It forwards `stringNumericCoercion:
"number-boundary"` into ordinary and lifted AST contexts. Only statically
string-typed unary plus/minus selects externref coercion followed by
provider-free `js.number.unbox`; omission retains the historical route.
Existing Number-wrapper certification, signatures, async plans and codecs
are unchanged. P explicitly released only this additive source boundary;
its paused work remains preserved.

The focused source suite passed **36/36** (session `36081`, exit 0), followed
sequentially by TS7 with no diagnostics (session `54752`, exit 0), under
2 GiB limits and one Vitest fork. The original r1 30/30 and TS7 receipts
remain retained. Initial review-test r2 passed 34/36: both failures were the
test reporter eagerly serializing a successful frontend carrier containing
circular AST-backed global bindings. R3 only avoids that success-path
serialization; all failure diagnostics, 36 cases and approved production
hashes remain unchanged.

The added controls establish one actual side-effecting string-returning
source call under each unary operator, complete checker-certified Number
wrapper preservation, shadowed Number binding preservation, and successful
whole-program preparation for a valid explicit numeric request. The real
`parse(s: string): number { return +s; }` source also reaches `prepared` with
an explicitly selected native-unbox policy and a `native.js.number.unbox`
runtime attachment. Only the `prepared` observation occurred: backend
acceptance, physical allocation/emission and execution were not attempted.

Static inventory review found all three modified production paths already
registered as unmigrated debt, with unchanged dependency syntax and no new
source modules. No boundary policy, baseline, allowance or status reduction
is introduced. Normal publication hooks and a non-draft held PR remain
pending the serialized slot; this section does not claim publication or
completion of the epic. Exact hashes, commands, failure history and remaining
obligations are in the
[source-admission handoff](../agent-context/3518-native-string-source-admission-handoff-2026-09-09.md).

### Shared native resource declarations (2026-09-09)

String, flatten, scanner and primitive-value producers now share symbolic
declarations with their reservation implementations. This lets checked consumer
acceptance know the complete resource ABI before allocation without a second
allocator or duplicated signature table. Canonical allocation order, type
metadata and existing ownership authority remain load-bearing.

High review's sparse-preflight and signature-observation findings are repaired;
the owned declaration suite passes 20/20. Parent scanner integration resolves
the previously failing dependency census and passes 140/140 combined scanner
and declaration tests. New mandatory boundary records and model-only type
controls are in place; full boundary/clean typecheck/caller validation is pending.
See agent-context/3518-native-resource-declarations-checkpoint-2026-09-09.md
for exact provenance, initial failures and the limits of this checkpoint.

This does not establish actual prepared-consumer execution or public default
cutover. Those joins and all other #3518 acceptance requirements remain open.

The clean producer checkpoint now also passes 250/250 full boundary controls
and unfiltered TS7 (session 54286 exit 0). Full caller revalidation passed
322/322 across eight suites (session 46568 exit 0). Checkpoint validation is
complete; this is not a migration-completion claim.

### Real native-string prepared-consumer integration (2026-09-09)

The composed consumer now accepts native string/value demands, seals their
typed ABI before allocation, uses canonical resource declarations and owned
reservations, and binds final indices after the single physical freeze.
Original and decoded prepared programs execute through the real consumer;
68/68 execution cases passed (handle 69379, exit 0). These include numeric
edge cases, large/private-chunk literals, encoding checks on actual module
objects, startup modes, aliases, and dependency initialization order.

The first combined run failed 69/129: one ABI countermodel was unchanged and
all 68 execution fixtures omitted explicit native string storage. Both are
test-only repairs; no production policy or validator was relaxed. Follow-up
ABI controls, no-demand old/new parity, full composed typecheck/boundaries and
normal publication hooks remain pending. Exact hashes, preserved failures,
dependency merge receipts and review scope are recorded in
agent-context/3518-native-string-value-consumer-integration-2026-09-09.md.

Public compilation still uses direct generateModule/generateMultiModule.
Native-string execution does not satisfy the remaining native families,
async/ABI30, cross-backend, fail-closed default, strict closure, or retirement
requirements; every outstanding epic acceptance criterion stays open.

Follow-up validation completed: ABI 61/61, boundary 258/258, materialization/
codec/module regressions 51/51, and full TS7 exit zero. The three-arm comparison
(76083, exit zero) reproduces the original vector CompileError, then proves
complete repaired-baseline/candidate artifact and value parity for five source
executions, one exact source refusal and one canonical-producer IR execution.
The vector repair is published separately as #5792; ordinary vector source
admission is still unsupported. All three arm receipts, runtime/input hashes,
original/decoded versions and retained binaries/WAT are documented in the
consumer integration handoff. No original-baseline vector success is claimed.

The next complete native async-consumer implementation plan is recorded in
agent-context/3518-native-async-consumer-implementation-spec-2026-09-09.md,
including frame/state lowering, delay/combinator publication, real object and
closure invocation dependencies, complete number formatting and string output.
The ordinary-vector source proposal and explicit P/C scope releases are also
preserved in the handoffs. These plans are not execution or retirement proof.

### Isolated vector construction nullability repair (2026-09-09)

Claim 3518:vector-data-nonnull owns a one-instruction WasmGC emitter fix at
published base 5404151bfc. A nullable/defaultable backing-array scratch reload
now receives ref.as_non_null before the carrier's non-null data field is
constructed. Layout, allocation order and unsupported-capacity refusal remain
unchanged. Full TS7 exits 0; the final combined regression run passes 31/31
across three suites, including all seven new controls. High approved the proof
split: five AST-to-IR component rows with explicit type overrides and a
physical-fixture resolver, one IR-builder externref spare-capacity row, and
one refusal control. This is not whole-source admission or consumer execution.
See agent-context/3518-vector-data-nonnull-2026-09-09.md for exact receipts and
the separate historical-baseline/common-fix application requirement.

## Native argument-vector checkpoint — 2026-09-08

Parent integrated the independently reviewed six-file argument-vector slice
on published string-authentication base bfe31c8bd96d748e867562e3e9b78343b72d1877
(#5775). Canonical array/carrier descriptors and new/push builders retain
legacy callers; the backend reserves and fills through the existing physical
ledger. Dependencies are authenticated before allocation, including an early
argument-array token when supplied. Foreign/copied matching-index tokens do
not gain ownership from structural equality.

The ledger's new reservation-phase assertTypeReservation has six new controls;
the earlier ledger-only validation passed TS7 and154/154 tests. Independent
High review approved the repaired canonical source and exact complete-donor
reconstruction controls. Parent composed TS7 session33890 exited0. Full
boundary suite76281 exited0:213/213 tests,139.31s. The two added modules give
88 modules and319 edges (206 type-only,113 runtime), with historical
activation records and allowed edges preserved.

Runtime validation is still pending: the worker's malformed test launcher
started no tests and remains alive; no stop or replacement was authorized.
Consequently this checkpoint is not yet declared ready for publication.
See agent-context/3518-native-argument-vector-integration-2026-09-08.md for
exact hashes and test provenance. Closure-root/metadata static implementation
is dispatched independently; it must not duplicate Promise capture ownership.
Full object/callable dispatch, real whole-family execution, replay, public
IR-only cutover and strict direct-codegen retirement remain open.

Subsequent independent parent-checkout runtime validation55631 exited0:
38/38 passed (32 argument-vector and6 reservation-auth),0.859s. This did not
terminate or restart the original worker launcher. Initial36/38 exposed two
test-instrument expectations, repaired with High approval: boolean identity
comparison avoids opaque Wasm inspection; a positive-first field-mutability
negative matches the ledger's content contract and proves rejection before
either function fills. No production semantics or identity gates were relaxed.
The focused runtime,213 boundary tests and composed TS7 now pass; publication
checks remain next. Full migration acceptance above remains open.

### Native closure resource checkpoint — 2026-09-09

The closure checkpoint is stacked on argument-vector PR #5776. Canonical
closure layouts retain real legacy callers; the transaction-owned native
closure pack reserves wrapper roots, signatures and builtin metadata in
legacy order. The repaired minimum-arity observer preserves lazy snapshot
timing rather than rescanning later metadata copies.

High review approved production and the R3 complete-live-factory inverse.
Validation: focused R3 62/62; composed runtime controls 76 passed and8 skipped;
boundary policy 221/221; final composed TS7 exited0. Original donor hashes,
complete factory population and20 positive-first mutation controls stay
pinned. See agent-context/3518-native-closure-integration-2026-09-08.md for
revision hashes and failure/repair provenance.

Next: join native Promise consumers to the owned closure producer pack;
do not duplicate Promise capture ownership. Full object/callable dispatch,
whole-family execution, replay, public IR-only cutover and strict static
closure/direct-codegen retirement remain open. This checkpoint does not
claim those acceptance conditions.

### Native Promise / closure producer join — 2026-09-09

High approved the implementation specification in
agent-context/3518-native-promise-closure-join-high-plan-2026-09-09.md.
Euclid owns exactly native-promises.ts and its existing resource test,
based on closure PR #5778. Replace independent raw root/metadata tokens
with the issued closure pack and metadata request ID. Authenticate before
allocations and again before fills, preserving genuine cache aliases,
lazy-arity semantics and existing Promise capture/runtime ownership.
Parent owns boundary updates, integration checks and non-draft publication.

This is a producer-provenance join, not complete Promise execution. Full
carrier inventory, callable dispatch, fill dependencies, native-family
execution, public cutover and the ABI30 planningSealed witness remain open.

The bounded join is implemented and independently approved after two R2
repairs: inherited metadata field descriptors are copied as in the donor;
rejection proofs preserve lossless data, object identities and future
reservation ordinals. Composed Promise/closure95/95 tests and221/221
boundary controls pass. The single new runtime import links the existing
Promise and closure owners; no boundary permissions were relaxed. Final
post-repair typecheck and normal publication checks remain next. See
agent-context/3518-native-promise-closure-join-integration-2026-09-09.md.

### Native async prerequisite composition (2026-09-09)

The native-string consumer checkpoint #5793 is being composed with the published
argument-vector, closure and Promise/closure join stack (#5776, #5778, #5779).
All production changes merged without conflicts. High approved the explicit
1,351-file classification union, unchanged remaining policy/allowed edges,
and both complete activation histories preserved in order. Mandatory boundary
coverage is 102 modules and 391 edges (248 type-only, 143 runtime).

Full boundary run 70325 passed 284/284 with no skips; unfiltered TS7 run 58123
exited zero. Resource and actual consumer regression run 9776 passed 201/201
across five files in 329.49 seconds (terminal exit zero).
The shared resource-declaration implementation contract is frozen in
agent-context/3518-native-async-resource-declarations-spec-2026-09-09.md;
the frame API and object-access donor map are also preserved for the next lanes.
This composition does not remove the async acceptance refusal or establish
native async execution, public default cutover or retirement.

### Formatter semantic support transport checkpoint (2026-09-09)

The formatter prerequisite now builds the unchanged radix source into real,
index-free IR using the source program's allocation registry. A separate typed
support batch survives preparation, ABI registration, validation and codec
replay without being inserted into ordinary source populations. The original
legacy self-hosted builder calls the same extracted frontend kernel.

After composition and formatting, parent run 69266 passed 167/167 across nine
source/transport/resource suites. Full boundary run 5497 passed 64/64; inventory
run 43404 reported zero errors and architectureComplete:false. Source-free
replay and its deliberately forbidden frontend-import control both passed.
The reviewed materializer-use-site hole is fixed with complete validator and
codec rejection tests using an actual canonical kernel reference.

The four clean module activations retain all earlier active history and allowed
edges. Exactly 17 already-unmigrated frontend files now carry mixed-needs-split
layer labels with their frontend destination; three other existing frontend
debt classifications remain unchanged. This is explicit migration debt, not
whole-frontend closure. See agent-context/3518-formatter-d1-high-contract-2026-09-09.md
and agent-context/3518-runtime-support-transport-progress-2026-09-09.md.

Final preservation gate passed its 12 executed callers, 10 core-type references
and six moved-function witnesses under the approved preservation-only contract;
the two known dynamic imports still prevent strict closure. Post-format TS7
passed, and the older self-hosted builtin suites passed 19/19. Normal publication
checks remain in progress.
Physical radix kernels, full formatter materialization, native async execution,
public default cutover, ABI30 and direct-codegen retirement remain open.

### Native async producer declarations (2026-09-09)

The existing closure, argument-vector and Promise reservation callers now consume
pure symbolic declaration plans before allocating. Issued inventories preserve
ownership, request/cache ordering, adopted arrays and inherited metadata type
identity. Promise still owns 25 declarations across 26 ordered operations.
The declaration checkpoint passes 194/194 focused tests (77955, exit zero) and
unfiltered TS7 (43844, exit zero). High approved the twelve frozen source/test
files; earlier failing runs remain in the implementation handoff.

Borrowed tag association is checked while reserving; actual tag provenance is
authenticated only after freeze using the existing ledger. This limitation is
explicit, not a claim of preallocation tag authentication. The full async
consumer, staged cross-producer closure scheduling, complete runtime fills,
public cutover and retirement remain unfinished.

### Formatter requirements and physical option checkpoint (2026-09-09)

The D2 requirements collector retains all eight formatter call occurrences from
the actual async example (two continuation owners, two calls each, both prepared
views). Separate support traversal retains 31 buffers and four inline-WTF16
literals with their original allocation, canonical allocation and metadata
identity. No ordinary source population or existing demand scanner is changed.
The consumer retains an explicitly supplied immutable integer-before-scratch
option without adding an environment read or a no-demand default.

Run 76460 passed 80/80 requirements and boundary tests with no skips, including
fixed call/literal coordinates and rejection of stale allocations and detached
support evidence. Post-change TS7 succeeded in 18552. Inventory is valid but its
graph remains incomplete. Earlier consumer blast-radius run 65740 passed 79/79;
resource prerequisite composition run 30810 passed 194/194.

This is descriptive preallocation evidence, not a new acceptance capability.
Complete formatter resources, scratch-root binding, prepared radix emission and
single-ledger integration remain in progress under the frozen D2 High contract.
The async refusal stays in place; public cutover and retirement remain open.
See agent-context/3518-number-format-consumer-progress-2026-09-09.md for receipts
and agent-context/3518-formatter-d2-high-contract-2026-09-09.md for implementation.

The subsequent physical scratch join is drafted in the formatter backend
aggregate and physical planner. It assigns the canonical string-data resource
to the existing prepared scratch required root and rejects conflicting owners.
Boundary validation passed 72/72; requirements/scratch tests passed 14/14 and
TS7 passed after moving the structural-key check out of the clean aggregate.
The real inventory reports zero errors but graphComplete:false. Exact scratch
signature conversion subsequently passed TS7 and 14/14 focused tests (97644).
The existing native-string consumer execution suite passed 68/68 (9217),
covering original/decoded programs, optimization/storage modes and startup
ordering. This protects existing paths; it does not prove actual formatter
support-body execution or full async admission.

### Native Ryū D2 checkpoint (2026-09-09)

The complete Ryū tables and three executable builders now have canonical owners,
shared by the real legacy callers and issued physical resources. Independent
partial-table caches and the original six-resource reservation order are retained.
High approved R2: 39/39 focused tests (9786, exit zero) and TS7 (39393, exit zero).
The exact donor inverse includes comments, local order and positive-first mutation
controls; earlier 23/39 and 38/39 runs remain recorded in the implementation handoff.

This is canonical extraction and finite/nonzero resource execution, not full
prepared formatter or async consumer acceptance. Nonfinite/zero formatter cases,
both integer options, decoded support execution and parent boundary activation
remain integration obligations. Public cutover and retirement remain open.
See agent-context/3518-native-number-ryu-2026-09-09.md.

### Same-owner staged closure reservation checkpoint (2026-09-09)

The bounded closure resource producer now supports one issued owner and pack
across a settle-metadata prefix, actual Promise reservation, and signature-only
suffix. Complete preflight and all metadata precede the first pause; the legacy
atomic API and complete frozen shape remain. Promise reserve/reserving inventory
accept the authenticated prefix, while fill still requires completion.

High statically approved production and final proof repairs. Focused rerun4029
exited0 with 172/172 across four suites. Earlier33713 exited1 with 170/172;
the surviving physical-only preflight mutant was still blocked by the canonical
walk, and one expected missing-request diagnostic needed the new prefix guard.
Both are retained distinctly in the handoff. TS740649 exited0 before those two
test-only repairs. Final TS711727 exited0 after those repairs and scoped
production formatting; normal publication remains pending.

Original/decoded actual-source Promise interleaving, fresh/cached suffixes,
three lazy-observer timings, full donor receipts, live mutants and allocator
ordering controls establish this reservation prerequisite only. Complete Promise
fill, full native async execution, public cutover and retirement remain open.
See agent-context/3518-staged-closure-reservations-implementation-2026-09-09.md.
