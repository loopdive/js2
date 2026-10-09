---
id: 6878
title: "Preserve the Boolean result brand of delete expressions at externref boundaries"
status: in-progress
assignee: ttraenkler/codex-6878-delete-result-boolean-sol61
sprint: current
created: 2026-10-06
updated: 2026-10-10
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
model: gpt-6.1-sol
task_type: bugfix
area: codegen
language_feature: delete-operator
related: [4231, 6651]
pr: 6548
loc-budget-allow:
  - src/codegen/expressions.ts
  - src/codegen/numeric-property-analysis.ts
func-budget-allow:
  - src/codegen/expressions.ts::compileExpressionInner
  - src/codegen/numeric-property-analysis.ts::makeProver
---

# Preserve the Boolean result brand of delete expressions

## Atomic reservation and scope

Reserved by the unchanged `scripts/claim-issue.mjs --allocate --by
ttraenkler/codex-astra-delete-boolean-plan --json`, original process63827,
actual exit0. The allocator reported verified upstream/issue-assignments,
pr_scan=ok. An independent GitHub read of6878.json confirms status reserved,
empty assignee/branch, requested_by above, reserved_at2026-10-06T21:13:56Z,
write_id47272-3viuhv7w. This is a reservation, not a worker claim. No GitHub
issue was created and no main/source branch was pushed. Thomas Tränkler
<git@thomas.traenkler.com> author/committer identity was explicitly supplied;
no script, hook or shared Git configuration was changed. The maintained
allocator's documented orphan-record push protocol was explicitly authorized.

This independently tracked repair supersedes no foreign6651 epic ownership.
The Astra plan was approved for bounded Sol implementation after dispatch;
the implementer must claim this issue normally in its new isolated worktree.

## Measured baseline, unchanged original

Current measured source is f7fb987b6ae6bae925f7ae085e5222e1c15697f8 in
`6651-f7-current-diagnostic`, source manifest
e451edddff191c33f48b13f4619361f1f522b2e6565b95cad02e818653d9001b.
Its `.tmp/6651-f7-eight.nHjDxg/receipt.json` SHA256 is
8b5bca008f389d4159a6a38663aeb62615b6bfb02ec37c34977391324f107847.
The maintained honest14/auto/default-QuickJS packet completed8 canonical
originals:7PASS/1FAIL, no CE, exclusions, skips or timeout. Completeness passed
with8 callbacks settled. Thirteen variants are eligible maximum, not measured
calls; strict reruns occur only after primaryPASS.

Only `test/language/statements/variable/binding-resolution.js` fails,
reached_test=true/noStrict: `Expected SameValue(«1», «true») to be true`.
Original SHA256:
9afe8b6819631896698a0552df50d750ddfa6803429ed99c6d8b13b8680cee79.

```js
var obj = { test262id: 1 };
with (obj) {
  var test262id = delete obj.test262id;
}
assert.sameValue(obj.test262id, true);
assert.sameValue(test262id, undefined);
```

ResolveBinding precedes initializer evaluation. The first assertion fails;
the outer hoisted-binding assertion is unobserved. Displayed1 could still be
an old field value rather than a boxed delete result: runtime attribution is
UNKNOWN until retained lowering and the complete candidate original establish
it. Never weaken either assertion or alter the harness/oracle.

Latest admitted implementation base is410cc7da1d7385b68e109fca87099c8bce85b0fc.
Actual local Git diff f7→410 is empty for expressions.ts, typeof-delete.ts,
with-var-decl.ts, with-scope.ts, type-coercion.ts and ir/with-environment.ts.
This proves relevant source comparability, not current410 runtime success.
The existing f7 result remains explicitly f7 evidence.

## Implementation Plan

Current with-var-decl already resolves/captures the dynamic binding BEFORE
compiling its initializer toward externref. The IR with-target planner already
recognizes var-initializer writes and selects the open-object representation.
Do not reimplement scope hooks, alter allocation/IR, or fix this by forcing a
different target representation.

Ordinary member/generic arms of `compileDeleteExpression` return bare i32.
The historical4231 RC-B repair brands only bare with-identifier delete as
Boolean. `type-coercion.ts` selects `__box_boolean` for boolean:true i32,
otherwise numeric boxing. This is an existing representation contract.

At the existing `DeleteExpression` dispatch in `src/codegen/expressions.ts`
(f7/410 lines1643–1645), call the unchanged emitter exactly once. If its result
is i32, return that result's metadata with boolean:true. Preserve null and
other results unchanged. Delete completion is a language-defined Boolean;
the normalization is not a test-name, identifier-name or with-only shortcut.
No emitted deletion instruction, configurability check, strict throw,
side-effect order, receiver evaluation or binding decision may change.

The dispatch is the sole source caller of compileDeleteExpression. Prefer
this few-line boundary fix over rewriting many return sites or changing the
shared coercion engine. Own only that dispatch, one focused test module and
this MD. A helper is unnecessary unless it materially improves direct testing;
any optional pure helper must be grouped, not another flat codegen module.

Obtain one unchanged-original baseline/candidate retained compilation as part
of normal implementation verification. Join actual receiver representation,
pre-RHS binding capture, delete result, selected box helper and write/read
identities. If it instead takes a closed-field coercion or fails to write,
stop causal attribution and report the actual route before broadening scope.
This finite join is not a new generic instrumentation prerequisite.

## Custody and integration boundaries

The preceding17-open-PR audit included complete pagination for six large PRs.
No exact delete-dispatch hunk overlaps were found. Shared expressions.ts edits
in5753/5784/5883/6341/6468 concern generic scalar unions, undefined, promise
handling, new.target or delegate registration. 5784's typeof-delete change
is in compileTypeofExpression;6468's typeof additions are separate too.
No foreign source, claim, held proof or PR is adopted. A concrete newer hunk
overlap stops integration; unrelated shared-file ownership is not a blanket
lock. Recheck exact source delta if main advances beyond410 before dispatch.

Implement in a fresh current-main own Sol worktree, never old2929 or the
frozen diagnostic worker. Preserve peers' edits, normal hooks and independent
IR inventories. Add exact issue-local budget grants only if normal measured
function/file regrowth requires them; never edit shared budget baselines.

## Verification and acceptance

- Preserve all8 official paths from the f7 packet. Required unchanged positives:
  for-of/array; the var/let/const for-of array-iterator-get-error originals;
  function parameter-destructuring counterpart; with/scope-var-open; and
  with/set-mutable-binding-idref-with-proxy-env. Require the target's TWO
  assertions and seven existing passes, normal completion and no exclusions.
- Add12 distinct semantic controls: successful/refused member delete through
  externref; successful/refused computed delete; missing property; side-effect
  operand once; strict nonconfigurable TypeError identity; receiver/key order;
  bare with-delete Boolean; captured original reference plus outer undefined;
  RHS-created property cannot retarget earlier binding; nested with/unscopables.
  Check strict true/false and typeofBoolean, not truthiness/numeric coercion.
- Run Boolean-brand controls under normal host and standalone profiles.
  Preserve property presence/value assertions and existing4231/6651 with and
  2726 deletion regression suites.
- Matched baseline/candidate/exact source-removal/restoration: same source
  background, private lock graph, original bodies, harness, options and normal
  providers. Retain per-row first assertions, actual modes and source hashes.
  No earlier F-to-F regression or previous-PASS loss is accepted.
- Retained route must agree with the semantic change. If only assertion one
  recovers, report the remaining real defect; do not mark this full target done.
- Run normal changed-test/type/lint/inventory/cycle/budget/hook gates and fresh
  required CI before publication. No hook bypass, score-profile override or
  historical-proof waiver. Full11,778 originals and all74Intl remain required;
  this small packet is not a replacement census or an assumed global gain.

No implementation or tests have run under this new issue at filing time.

## Current Sol verification (2026-10-06, unfinished)

Normal own offline frozen-lock COPY installation SAME99256 completed child65017
exit/close0 with both streams EOF and normal prepare DONE. Receipt3db3a4ba
is retained in `.tmp/6878-preparation/install/receipt.json`. The independent
graph6c8d3e47 admits45 roots/825 physical packages/1636 edges/171 explained
platform/closed-ancestry omissions; cached-artifact a545146a verifies the
five known side-effect keys,41 copied built artifacts, five positive executable
probes and38 own generated wrappers. Fresh postinstall count remains ZERO:
cached lifecycle artifacts are not freshly executed builds. Canonical corpus
d98d28a1 is read-only11778/74Intl/b363/ab852/632db; no peer compiler or provider
outputs were copied. Source is410/1852/35b9b2af, not frozen f7/1850/e451.

The original focused helper exported test(), which makes its SourceFile a
module. `typeof-delete.ts` calls `isStrictContext(expr)` with its default true,
not the passed inferModuleStrictArguments:false. Thus the helper incorrectly
forced sloppy refusal cases strict. Original test e255680e is preserved bytewise
at `.tmp/6878-preparation/original-module-test.ts`; original baseline61246,
receipt eebc3a23 in `.tmp/6878-focused-baseline.XAUGck/receipt.json`, remains
24 settled/6PASS18FAIL. No original failed receipt was rewritten.

Root-approved helper-only correction keeps ALL12 literal semantic bodies and
assertions, makes test() unexported Script code, adds a top-level strict
result!==1 throw, and uses the documented deferTopLevelInit / __module_init
entry after supported __setExports wiring. Current focused test baa3a632.
Corrected unchanged-production baseline92606 receipt21d79bab,
`.tmp/6878-focused-baseline.eavXNW/receipt.json`:24 settled/8PASS16FAIL.
Both host refusal cases now PASS, consistent with the concrete goal correction.
Opaque WebAssembly errors serialized as JSON null remain UNKNOWN first effects,
not inferred Boolean errors or passes.

Production candidate is only expressions.ts dispatch4 inserted/1 removed,
SHA bfef5d169a7b271939f5313a5be7fb24a83782755ec57d8c43174276e7bd8d20.
The existing emitter runs once; i32 completion metadata is spread with
boolean:true; null, VOID_RESULT and all other kinds remain unchanged. No
deletion instruction, scope/capture/coercion engine or IR source was edited.
Corrected candidate50991 receipt3f04f39c,
`.tmp/6878-focused-candidate.zR9bW3/receipt.json`:24 settled/12PASS12FAIL,
four gains/no prior PASS loss. Both lanes gain RHS-created binding and nested
with/unscopables controls. The residual12 FAIL are NOT accepted completion;
all controls remain frozen and their raw logs/errors retained.

Actual current410 unchanged-original baseline and candidate remain unmeasured
at this entry. Frozen f7 authoritative7PASS1FAIL remains explicitly f7 evidence,
not silently repinned. Own normal5-command compiler/runtime/core/QuickJS build
chain SAME63151 is live; output `.tmp/6878-normal-build.cA4D76`, candidate source
1852/f47ca4c1. Normal authoritative8 and retained target route are next; no
readiness/publication/full-census gain claim.

### Actual unchanged candidate packet and retained route

SAME63151 completed normal five child builds0/close0/EOF/errors[], source/private
and common hooks unchanged; build cbc36601. Fresh raw/default selector admission
177d1abd selects QuickJS with compiler91465690721b4cb2, core613be6002c683359158d5ca3,
artifact04a9abfac8350642 and adapter8975593ab146c691; strict ABI3/zero core imports/
five callables/actual canary and normal required-cache linked-pair verification.

SAME88118 actual canonical child10967 terminal0/close0/EOF; normal completeness
validator17791 also0/EOF. `.tmp/6878-eight.rCSfoQ/receipt.json`54ccedc8 retains
all8 actual original PASS,8 unique canonical/registered rows,8 callbacks started
and settled,0 exclusions/skip/timeouts. Target binding-resolution.js now passes
BOTH unchanged assertions. Thirteen is eligible MAX, actual invocation count
UNKNOWN. No current full-census gain is inferred. An ignored final-report bug
used static clean-source35b instead of actual overlayf47. Original54cc remains
immutable; separate source-provenance-correction2236854f joins actual build,
before.json,1852/f47, bundles/keys, raw8 and completion. Frozenf7 is not relabelled.

Retained original diagnostic33283 saved PASS/id0/ret1/reachedTesttrue and raw
wasm/meta/assembly. Its ignored helper awaited a close listener removed by normal
pool.shutdown; outer exit13/EOF preserved and worker terminal UNKNOWN, not fake
successful closure. NO repeated API call. Subsequent JS Binaryen read63775 failed
before feature setup with an explicit enable-gc diagnostic; no WAT emitted,
failure04ed2400 retained. Separately approved normal CLI consumer-only decoder5902
completed child75500 actual0/close0/bothEOF and native validation true; receipt
faa7bda1, WATdd4aeee1, rawbinary5e4e8005, unchanged input pins and zero new API/
provider calls. No provider was decoded or instantiated by this correction.

Finite route `.tmp/6878-retained-candidate/route-join.md` shows concrete open
object creation, saved HasBinding BEFORE deletion, real delete followed by
Boolean boxing, saved-reference property write and both original assertion
reads. This is candidate route evidence, not yet a matched baseline opcode
comparison. The remaining12 focused failures are UNWAIVED; removal/restoration,
baseline retained route, adjacent suites and normal publication gates remain.
Heavy lease explicitly released after actual decoder terminal; FS-only planning
continues while root coordinates the next finite residual-control step.

## Historical Sol implementation admission (2026-10-06)

Owned worktree `6878-delete-result-boolean-sol61`, branch
`codex/6878-delete-result-boolean-sol61`, actual HEAD
410cc7da1d7385b68e109fca87099c8bce85b0fc. Clean scoped initial status;
1852 physical source paths (not the frozen f7 diagnostic's1850). Relevant
expressions.ts f7→410 diff empty. Package/lock/workspace hashes match the
admitted own-f7 private graph. Common111908/b40 unchanged and Thomas author
identity verified. Approved plan SHA08e86f301329087b38aef7097d46c237cddb215a4bb52d4fc6f4fb27209d6970
fully read before implementation.

Unchanged maintained claim allocator SAME31582 actual0 verified issue6878 on
upstream/issue-assignments, assignee above/owned branch. Independent read
SAME40935 returned expected held-status3 for this exact own assignee since
2026-10-06T21:17:08Z, not a foreign claim conflict. Documented orphan assignment
protocol only; no source/main push or shared configuration change. Reservation
is now claimed, not a second issue allocation.

Private byte-copy SAME23357 is running from immutable OWN6651 admitted
Node/pnpm/CAS dependency artifacts only. Fresh exclusive realpaths, no shared
node_modules/store or copied compiler/runtime/provider bundle/cache. All build,
focused semantic tests and authoritative current410 baseline/candidate/removal/
restoration results remain NOT RUN. Root's heavy lease granted after the prior
freeze compiler10757 actual0/EOF; normal install begins only after byte-copy
terminal and unchanged source/private-input readback. No budget grant exists
unless actual normal measured gate establishes a specific need.

## Exact residual control1 compile-only checkpoint (2026-10-06)

Approved residual plan155–277 was fully read. SAME85036 completed0/EOF;
exact tracked corrected Script body/options were extracted, not rewritten:
`fileName: issue-6878-delete-result-boolean.ts`, skipSemanticDiagnostics:true,
inferModuleStrictArguments:false, deferTopLevelInit:true, target:standalone.
No IR, engine, validation or source-map option was overridden. The returned
profile is native-first/standalone/wasmgc, hostValueInterop:off; this is NOT
the authoritative packet's auto/default-QuickJS profile. Exact options omit
sourceMap, so its absence is recorded NONE rather than silently adding it.
Zero runtime, instance, provider or decoder executions occurred.

Receipt `.tmp/6878-control1-compile/receipt.json` SHA256
841b01770db5e44e93e57964189869ea2bf9b98ec680cb8629558ebd9581cf46
records success:true/errors:[]/imports:[] and native validation true.
Binary267908B SHA256
32d90e624a65dbe18fc06b500519a1d1e2a675aebe604da27528ba9fb11b4545;
normal compiler-returned WAT2626048B SHA256
2e7c9fab971fbc8b7f0d41ad30702014a773f35fd3a103c04d07245991cf80b7.
All before/after source/private/metadata pins match. This compile-only result
does not repair the earlier pool shutdown failure or change a semantic verdict.

The anchored returned-WAT definitions provide a decisive finite carrier join:

- `test`6254–6430 declares obj:externref but actual:f64, despite `actual:any`
  in the unchanged literal. Open-object creation135 and property set150 precede
  receiver/key capture into locals4/5. Null/undefined guards remain before delete.
- Lines6320–6324 call154 (`__delete_property`) then convert i32 to f64 and
  store local1. This route performs real deletion; it is not constant-true IR
  deletion without mutation. Numeric local allocation is directly observable;
  the exact source allocator decision remains a separate residual question.
- Lines6325–6358 rebox through SMI/ref.i31 or call63 (`__box_number`), NOT
  call65 (`__box_boolean`). Lines6360–6367 call86 `booleanResult` then branch
  to sentinel11. The guard has actual ABI `(externref,i32)->i32` at6120 and
  tests strict equality plus Boolean category via75; expected:true is boxed65.
- Presence162 and read139/undefined232 checks follow that guard; sentinel12
  is at6425. Neither sentinel is observed dynamically by this compile-only
  experiment, so an opaque focused runtime exception is not relabelled11.
- `__module_init`83172 calls87 `test`, stores its f64 result in global29,
  compares with1 and constructs/throws the Control-result error if unequal.
  The exact top-level assertion/deferred initializer is present.

The four-line dispatch normalization therefore recovers the original official
route but does not cover every allocated-local carrier. No allocator, IR,
coercion or broader source change is authorized by this checkpoint.

## Unfinished draft publication plan and gate ledger

Approved Astra checkpoint plan279–449 SHA0d0e34c8 was fully read. Root expressly
authorized an unfinished DRAFT checkpoint despite the known12 required semantic
failures, not a ready PR, merge, issue completion or semantic waiver. Keep status
in-progress. Preserve all24 unchanged controls and first-effect UNKNOWNs; no skip,
expected-failure, body rewrite or proposal/profile change is permitted.

Normal checks use the existing physical private graph, Node24,3072MB and one
serial heavy chain. Typecheck/lint/changed-file formatting, boundary inventory,
import-cycle/flat-dir/coercion/oracle/dead-export ratchets, actual measured file/
function budgets at upstream410, issue integrity/coverage/collision checks and
the real changed-root gate are required. Sanctioned SKIP_SLOW_PRECOMMIT=1 may
avoid rerunning the recorded slow gates, never bypass the fast hooks. Any size
grant must name only this issue's actually faulted path/function, with measured
old/new sizes; shared baselines are immutable. Commit and push preserve Thomas
author/Codex coauthor/Sol6.1 High attribution and normal hooks/signing.

Publication targets verified ttraenkler/js2 branch and loopdive/js2:main, ONE
draft with Description and CLA sections and a relative repository issue link.
The CLA checkbox stays unchecked; maintainer exemption is not a fabricated
human attestation. No queue/ready promotion or foreign PR adoption is allowed.
Outstanding work remains12 required reds, matched current410 original baseline,
exact source removal/restoration and adjacent suites/current-main/full census.
Frozen f7=7/8 is historical, not a matched410 baseline; candidate8/8 is not a
current whole-ES2015 gain. Actual gate outcomes are appended below, not inferred.

Measured budget rationale (2026-10-06): normal gates at exact upstream410
faulted ONLY expressions.ts1763→1766(+3) and its existing
compileExpressionInner617→620(+3). The sole dispatch evaluates the delete
emitter once, guards null/VOID/non-i32 outcomes and sets existing Boolean
metadata on i32. These exact file/function grants cover intended dispatch
growth, not semantic failures or any allocator/IR/ABI expansion. No total,
unrelated path/function or shared baseline grant was added. Initial ungranted
failures remain in `.tmp/6878-gates.Eaw2dg/{loc,func}.stderr`.

Dead-export gate completed0/EOF with its normal preservation-v1 contract,
not exhaustive closure: stdout reports graph OPEN, strict modeled closure FAIL
and retirement NOT CERTIFIED. Nonliteral imports at optimize412/platform151
remain runtime-unknown. This result does not justify a closure/proof claim or
unrelated source repair; the original stdout/stderr is retained.

Normal initial gate observer SAME85364 completed0/EOF with unchanged source/
test/common inputs. Receipt2866fc46 retained all16 actual command terminals:
typecheck, lint, inventory, import cycles, flat-dir, coercion, oracle,
dead-exports, issues, spec coverage and both issue-ID checks0; initial formatting
and both measured ungranted size gates1; changed-root1. Changed-root selected
exactly this one tracked test file and actually collected24:12PASS/12FAIL,
all known required reds, no skip/pruning/expected-failure. Its normal flags
include dangerouslyIgnoreUnhandledErrors as maintained, not a worker override.

Normal formatter SAME25693 child85123 completed0/close0/bothEOF on ONLY source
and owned test. Original observer721c9dcc exited2/HOLD because getChildren
includes formatting punctuation/trailing commas; its preimages and receipt
remain immutable at `.tmp/6878-format.XwLy65`. Separate FS-only semantic
readback853db111 compares complete TypeScript forEachChild ASTs, retaining all
semantic node kinds and identifier/literal/template texts: both before/after
trees EXACT (sourcee62b7605/test88134aa0). This is an observer correction,
not a semantic failure waiver or re-execution.

Formatted candidate expressions SHA256
ff0a0e9b783e40037ad5dd5f8095b2c2f3e0c3caabeb9438be9201949f876416;
test SHA2569c86f318b3e319c5e73d243864db33aeec4270388ef3f8f34c63cabf21db20d6.
Full1852 source digest is a4bb84219b057aa09ec956d56f0f9f2a76f1c66a376b6a2d622573dcf2ed4ed7.
Normal formatted size gates measured1763→1764(+1) and617→618(+1), both0
under the same exact issue-local grants; initial+3 faults remain historical.
No new bundles/providers/official packet were built after formatting. Earlier
f47/410 build, original8 and control1 receipts remain their exact measured
epoch, not silently re-labelled as this formatted source or future commit.

The ignored core-admission helper originally selected the current manifest but
indexed the first all-cache manifest for its binary. A single own cache entry
masked that mismatch in historical admission177d1abd. Separately corrected
helperf69a21d6 derives BOTH paths from selected current[0]; original6a46ae58
archived without re-admission or changed old receipts. No production ABI guard
or cache schema changed. Future normal admission must use its actual new
compiler/source epoch, not copy the old proof.

Final formatted checkpoint gates (2026-10-07 Europe/Berlin): SAME11278
completed0/EOF, receipt at `.tmp/6878-gates.z1FCNf/receipt.json`, unchanged
source/test/common pins. ALL15 normal metadata commands completed0/close0/
bothEOF/errors:[]: full typecheck, lint, changed-file prettier, measured LOC/
function budgets, boundary inventory, import cycles, flat-dir budget, coercion,
oracle, preservation-only dead-exports, issue integrity, spec coverage and
both main/open-PR issue-ID checks. The actual changed-root command completed1
normally, one selected file/24 collected/12PASS12FAIL. This is the sole known
semantic-red draft exception, not a green test gate or permission to merge.

Normal commit uses the sanctioned fast hook option after manually recording
the real slow-gate outcome; all unconditional hooks remain installed. The
only staged paths are this issue, expressions.ts and the owned focused test.
No dependency/provider/bundle/ignored receipt or shared baseline is committed.
Upstream server main independently read as410; no owned-branch duplicate PR
exists at this snapshot. The forthcoming draft preserves this unfinished
dispatch checkpoint before any separately approved local-inference phase.

## Published draft and approved phase II (2026-10-07)

ONE upstream draft6548 was created/attached and independently read OPEN/draft,
base main/headf79b9a96c80140416adb88408569c13b0f68f611, author ttraenkler.
Normal commit45041 completed0/close0/bothEOF; receiptc1b41ddc retains only
the3 owned paths, Thomas author/committer, Sol6.1 High/Codex/✓ attribution.
Fast precommit lint-staged and both exact size gates passed; actual slow-gate
reds were recorded separately, not suppressed as tests. Committed issue graph
integrity passed4775/4775. Normal push51621 completed0/close0/bothEOF;
receipt1726ee80, actual fork head exactf79 and commonb40 unchanged. Normal
pre-push18/18 numeric-local parity also passed. No force/upstream tracking/
signing/config override was used. The draft's pinned issue URL was independently
verified from the published upstream Git object; no ready/merge claim exists.

Astra phaseII plan513–654/ebfd80a0 fully read and root-approved AFTER retaining
that draft. Own additional production scope is ONLY existing
`src/codegen/numeric-property-analysis.ts` isBooleanish immediately after
unwrap: structurally recognize DeleteExpression as Boolean. Existing isNumeric
Boolean arithmetic admission remains unchanged; no IR, allocator, declaration,
coercion, cache, context or proof change is authorized. Exact preimage641473df
was read; no concrete competing hunk identified. Preserve every peer edit.

Existing numeric analysis intentionally accepts Boolean as numeric evidence,
but its separate Booleanish veto lacked delete. The grounded local publication
could therefore force actual:any into f64 before the dispatch metadata reached
its consumer. This single structural fact withdraws unsafe numeric inference
through existing property/parameter/return/local readers; their blast radius
requires separately counted real controls, not an assertion of invisibility.
Normal completion of delete is Boolean; unary-plus/arithmetic over its result
must remain legitimately numeric, and strict abrupt completion is unchanged.

The existing24 body/helper/options remain frozen9c86f318. First run the exact
candidate24 and retain every verdict/opaque failure. Then add separately counted
real inference, wrapped/mixed-write/numeric arithmetic/shadowed-slot, property/
ordinary-return identity controls and unchanged3765 suites. Matched normal
source-keyed official8 and exact predicate-line removal/restoration follow;
never reuse old f47/410 bundles/providers as fresh proof. One selected retained
control1 compile may verify its corrected carrier, with no new generic probe
family. No predicted24PASS or full-census gain is banked by this application.

## Phase-II measurements and canonical-main integration (2026-10-07)

The published-checkpoint candidate at f79/c522 actually completed the frozen24
as19PASS/5FAIL (receipt a4cc8d26, `.tmp/6878-focused-phase2-candidate.rZsalo`).
Its seven gains versus dispatch-only12/12 were standalone controls1,2,3,4,5,6,8;
no earlier pass was lost. This is the old source epoch, not current-main proof.

Normal non-autostashing merge of reviewed upstream116f04da completed0/close0/
bothEOF, producing2953fe1f3a4b9493a7550044cfe691f4951542cc with parentsf79+116f.
Merge receipt68259691 is `.tmp/6878-main-merge.9R5WHe/receipt.json`.
Thomas author/committer, Codex/Sol6.1 High/✓ and normal hooks were retained;
LOC_GATE_BASE was explicitly116f. Package/lock/workspace bytes are unchanged.
The dirty predicate line, frozen test and own issue ledger remained byte-exact,
as did common Git configb40. No stash/reset/force/public checkpoint rewrite.
The canonical imported/promise/new.target work is main's own landed intent;
the production diff versus116f still contains only the reviewed delete dispatch
and Booleanish line. The source set now includes1870 physical Git source files.

The unchanged24 then actually completed19PASS/5FAIL on this merged source,
SHA9ba37e0a5cba06b037d706dc4db606875c3a500c4900edea9b1a160bf34aa81f.
SAME50903 child25786 exited1/close1/bothEOF/errors:[], observer0 and unchanged
inputs. Receiptc99e698b is
`.tmp/6878-focused-phase2-currentmain-candidate.7H5L7g/receipt.json`.
All24 identities/statuses match the oldf79 candidate. Remaining host reds are
successful member/computed delete, bare with-identifier and pre-RHS capture;
standalone pre-RHS capture also remains red. JSON failureMessages are opaque
null values; no payload/sentinel/first-loss interpretation is invented.

The subsequent separately counted regression group uses the real TypeScript
checker and existing analysis (six structural rows with positive Boolean type
evidence and genuine-number controls), plus three new unchanged helper/runtime
bodies in both profiles. The original twelve bodies/helper/options remain
unchanged. Results, removal/restoration and original packets are still pending;
no issue completion, ready PR or full-census credit follows from19/24.

Candidate regression run SAME87363 actually completed36 collected,28PASS/8FAIL,
child40538 exit1/close1/bothEOF/errors:[]; source/private pins unchanged.
Receiptba87a4db is `.tmp/6878-focused-phase2-currentmain-candidate.hEMSjt/receipt.json`.
The frozen24 still has exactly19/5. Separately counted additions are6/6 real
checker/analysis passes and3/6 runtime passes. Property-write identity fails
in both profiles; ordinary return plus parameter identity fails in standalone
and passes in host. Numeric arithmetic passes in both profiles. All three new
reds are opaque null JSON failures, not identified payloads/first assertions.
They are not called candidate regressions before matched predicate-removal
results exist. No test body/assertion is pruned or weakened for these outcomes.
The first textual frozen-body check accidentally used a pre-format archive and
returned false; the subsequent exact HEAD9c controls+run text comparison is
true. Both observations remain in the execution transcript.

Unchanged neighboring suites completed18/18 numeric-local passes
(`.tmp/6878-focused-phase2-currentmain-candidate.aCZt8Z/receipt.json`,8300e155)
and4/4 linked-parameter passes (YH67Aj,2f872523), each own independent process,
normal exits0/close0/bothEOF and unchanged1870/9ba/private inputs.
Five normal merged-source build commands completed0/EOF at BXlT63 (a25f1d0e),
then fresh strict ABI3/current default-QuickJS admission62d6c508 selected
compiler4515bb6ed6dd1a02/coreff3d90489ba7761a63b21f07/adapter92d7912c21460b62.
The source-independent own QuickJS artifact was a legitimate normal cache hit,
not a borrowed artifact. The unchanged official8 completed8PASS, exact8 unique
canonical rows/registered/callbacks and one durable completion, exclusions/
skip/compile_timeout0. Receipt7b96cfb2 at `.tmp/6878-eight.IAWTOg` retains actual
runner+validator exits0/EOF and default engine announcement.13 remains the
eligible variant maximum; actual variant calls remain UNKNOWN. No census credit.

Separate native control10 diagnostic26254 stopped1 before compile because
common config changed. Own preserved bytes independently prove ONLY a97-byte
normal branch stanza append, codex/5269-current-main-integration-sol61,
upstream/refs/heads/main: deleting that unique insertion reconstructs111908/b40
byte-exact. Root independently admitted ONLY112005/30498348; own effective
.husky and Thomas identity were unchanged. Receiptc8e14f95 retains private
current bytes and this exact classification. No shared config was rewritten.
The failed diagnostic remains0 compile/native/render executions, not success.

Separately named metadata-admitted native diagnostic20882 completed0/EOF.
Actual tag/native prepare/native char/init exports were all present; one init
and exactly one renderer call at its catch produced `Error: Control result: 102`.
Receipt0d15975d at `.tmp/6878-control10-render-currentmain-metadata-admitted`
preserves exact body/helper/options/source9ba. Boolean assertion101 did not fail;
the outer-binding undefined assertion102 is its actual first failed sentinel.
This native-first diagnostic is not the official auto/QuickJS route, has no
canonical credit and does not authorize a hoist/reference-capture repair.

The full approved Astra current-main attribution appendix656–765 was read.
Removal changed ONLY the structural Booleanish line, retaining the dispatch
and all merged main changes. Removed source1870/5310b1a1342f7acac71bc9ef578580baae8a8bc96164e231f942aa734a5318ff
completed36 collected15PASS/21FAIL, child84497 exit1/close1/bothEOF/errors:[],
unchanged inputs (vnvFtF/receipt.json,74f6e277). Splits are original24=12/12,
added12=3/9. Actual row join against candidate28/8 shows13 recovered rows:
seven original standalone, five real-analysis and standalone arithmetic. No
candidate pass is lost. The three new runtime reds are F/F, not status
regressions; their first effects remain UNKNOWN. Removal neighboring suites,
normal builds/original8 and exact restoration are still pending at this entry.

## Completed phase-II contrast and next checkpoint epoch

The removed arm's numeric18 and linked4 completed18/18 and4/4 with actual
exit0/close0/bothEOF, receipts36b9806b (KvAWqQ) and569bdba3 (c2MwsT).
Its five normal source-keyed build commands completed0/EOF at OZwVHG
(c04e0b7b), followed by fresh default-QuickJS/core ABI3 admissione6168f97:
compiler032997197974b7bf, coree0262d626efdf4db57f4be5a and adapterc993164600b97466.
The unchanged official8 completed8PASS, runner+validator0/EOF, one durable
completion and zero exclusions/skips/timeouts (vkHE0R,5c04af81).

Byte-exact restoration returned numericde964d92 and source1870/9ba37e0a.
The same36 completed28PASS/8FAIL with actual child16688 exit1/close1/bothEOF,
unchanged inputs (MgsLsX,9fcd8ed5). Exact fullName identity and failureMessages
joins match all36 candidate rows; no restoration mismatch. The thirteen gains
versus removal comprise seven original standalone controls, five real-analysis
rows and standalone arithmetic; no prior pass was lost. The five original and
three added runtime reds remain unwaived, with opaque null reports except the
separately rendered native control10 first sentinel102. They do not justify a
new production hunk in this task.

Restoration numeric18 and linked4 also completed18PASS/4PASS, independently
settled0/close0/bothEOF (RHY4dA,6e5a64f4; K7PdrJ,7012d960). Normal restored
five completed all0/close0/bothEOF/errors:[] at OLhRZK (adca3179); an initial
relative admission argument was rejected before execution, and the required
absolute owned path then admitted unchanged source/providers (32db0899).
Fresh maintained selection returned candidate compiler4515bb6ed6dd1a02,
coreff3d90489ba7761a63b21f07 and adapter92d7912c21460b62. Own keyed caches
were normal hits, not copied peer outputs. Official8 completed8PASS at DbCLDx
(2a12f4a5), actual runner21727 and validator21935 both0/close0/bothEOF;
registered/canonical/started/settled floors8, one durable completion, exclusions/
skip/compile_timeout0. All three arms' official8 verdicts are identical. Actual
variant invocations are UNKNOWN;13 is only the eligible maximum. These are
bounded measurements, not full11778 census credit or issue completion.

After the contrast settled, fresh upstream main was ab86c902, beyond the
previous report-only21bcc. Its landed6867 optional-field/tuple-rest changes
touch calls, coercion, struct registration, index and module records, plus one
new source module; none touches this issue's two production hunks/test/ledger.
Normal non-autostashing merge completed0/close0/bothEOF, HEAD72329d4b with
parents2953+ab86, preserving dirty source/test/MD and common304 byte-exact.
Receiptb964da3c is `.tmp/6878-post-contrast-merge.lbixRf/receipt.json`.
An observer preflight first compared the owned branch rather than its integrated
main and rejected before any Git child; its original script remains archived.
The corrected comparison uses116f→ab86, without weakening the overlap guard.

The new source membership is1871 and ordered SHA256 is
209dff5309c4884c53cba7b362534fcd4c7ba829f2cb62dce4dad7b19738e3dc.
All physical source Git blob identities match HEAD except the exact dirty
Booleanish line; versus ab86, source changes remain only delete dispatch+veto.
Epoch582fa0df at `.tmp/6878-post-contrast-epoch.si0cbr/receipt.json` retains
the full inventory and bounded main/owned diffs. Old2953/1870 contrast and
providers are not relabelled as this new source epoch. Normal mechanical gates,
unfinished draft checkpoint publication, then fresh final-HEAD source-keyed
build/admission and current36 evidence precede a separately authorized frozen
11778-original census. No ready/merge claim while the eight focused reds remain.

Normal72329 mechanical assessment P9MSvM completed typecheck/lint/changed-file
Prettier all0/close0/bothEOF. The actual budget terminals were1, not waived:
numeric-property-analysis1684>1683 (+1) and its makeProver301>300 (+1).
This issue grants only those measured file/function keys for the single
DeleteExpression Booleanish veto, in addition to the existing dispatch grants.
No shared baseline/inventory/schema or unrelated budget is changed. The normal
ratchets must pass after this local frontmatter grant; semantic reds remain real.

The normal remaining mechanical assessment actually completed at Axj7gv,
receipt96ed2abc: LOC/function/inventory/import-cycles/flat-directory/coercion/
oracle/dead-exports/issue-integrity/spec-coverage/IDs-against-main/IDs-against-
open-PRs all12 terminals0/close0/bothEOF/errors:[], unchanged source1871/209d.
Dead-exports is a preservation-only pass: graph OPEN, strict modeled closure
FAIL and retirement/deletion NOT CERTIFIED; moved-runtime unknown nonliteral
imports at optimize412/platform151 remain explicit, not full-closure proof.
The unchanged normal changed-root gate actually ran the sole owned file,
36 collected28PASS/8FAIL, child32525 exit1/close1/bothEOF. Its eight names are
the same five original and three added runtime reds; no expected-failure/skip/
body/profile/oracle change masks them. The full checkpoint remains draft and
in-progress. Initial receipt67dcffe3 retains the two measured budget failures;
subsequent grants do not rewrite that history. Fresh final-HEAD mechanical,
current-candidate36 and normal providers are still required before census seal.

## Root recovery release: with-body function var hoisting

2026-10-09: root read the full frozen 193-line Astra plan below, SHA256
35d57a21932d6c7131da18ee165e88117eaa7bed672c34f260b0116203cd9360.
Sol 6.1 High owns only the existing walkStmtForVars body-recursion condition
and narrow new controls in this dedicated worktree. Root owns this issue,
all heavy verification and publication. No other production/IR ownership is
expanded, and the existing 36 registrations remain mandatory and unchanged.
Historical sentinel102/WAT evidence identifies a real missing hoist but is not
fresh current-head acceptance. Other seven causes remain UNKNOWN. Required
paired native validation, exact exception rendering and normal gates still
precede readiness; no 100% standalone census claim is made.

# Delete-result required failures: bounded next implementation

Frozen source-only Astra plan, 2026-10-09. Root owns canonical issue 6878,
“Preserve the Boolean result brand of delete expressions at externref
boundaries,” and execution. No source/test/IR/issue change, compiler, parser,
typecheck, formatter, build, install, Git mutation or external write was run.

## First release: hoist function vars declared inside with

Implement the missing WithStatement descent in `walkStmtForVars` in
`src/codegen/index.ts`. Its existing LabeledStatement arm can accept
`ts.isLabeledStatement(stmt) || ts.isWithStatement(stmt)` and recurse through
the same `stmt.statement`, then return. This one-condition change reuses the
normal var allocator and undefined initializer; it does not execute a with
receiver or initializer during hoisting. Do not traverse the with expression,
enter nested function bodies, change lexical hoisting, or add generic AST walks.

The standalone pre-RHS capture failure already has a native sentinel, complete
emitted-body proof, and a matching source omission. No further generic receiver
diagnostic is needed before this implementation. Its current-head success must
still be measured; the retained native execution belongs to an earlier epoch.

## Source and record custody

Read-only target checkout:
`/Users/thomas/Code/js2/.codex-worktrees/6878-delete-result-boolean-sol61`.
Verified HEAD `56c33d1a3246191cfe8b466d83e937b7c354e475`, branch
`codex/6878-delete-result-boolean-sol61`, clean status. Relative paths below
refer to that checkout. Planner output is confined to its separately assigned
`/Users/thomas/.codex/worktrees/collection-raw-anyref-comparison-plan-astra/js2/.tmp`.

Read the local canonical issue/handoff, fixture, final-current native output,
rendered control10 capture, and shepherd recovery6 receipt. No GitHub poll.
PR 6548's required quality 112541913712 is recorded as 28 PASS / 8 FAIL / 36;
the separate local epoch confirms the same eight full names at the exact head:
`.tmp/6878-focused-phase2-finalcurrent-candidate.rCaomg/receipt.json`, SHA256
`f6aeb5802d49aff8590fe059d4ae194b13cea273753378b71d9017784749ea83`.
Actual terminal exit/close 1, both streams EOF, 36 settled records. Its stdout,
stderr and vitest.json were read. Every JSON failureMessage is null; stderr
shows WebAssembly.Exception objects, not decoded assertion sentinels.

Fixture `tests/issue-6878-delete-result-boolean.test.ts` has 288 lines, SHA256
`454da1999b7be41d56daf6a19c204c2bbc0930cdc2e664f01b361b4d4bfa2773`.
The existing source diff versus integrated main ab86c902 consists of only:
DeleteExpression dispatch attaching boolean:true to its i32 result; and
numeric-property-analysis classifying DeleteExpression as Booleanish. Preserve
both. Their prior removal/restoration gains are not evidence for these residuals.

## All eight exact remaining row identities

Prefix `#6878 delete Boolean completion`:

1. `(host) successful member delete through externref` — possible sentinels
   11 (Boolean identity/type) or 12 (presence/read after deletion); actual opaque.
2. `(host) successful computed delete through externref` — 31 or 32; opaque.
3. `(host) bare with-identifier delete retains its existing Boolean brand` —
   91 combines Boolean result and property presence; opaque.
4. `(host) pre-RHS reference capture writes Boolean while outer binding stays
   undefined` — 101 or 102; opaque at this head/profile.
5. `(standalone) pre-RHS reference capture writes Boolean while outer binding
   stays undefined` — current-head opaque; exact earlier native control10 is 102.

Prefix `#6878 phase-II adjacent runtime`:

6. `(host) property-write delete preserves strict Boolean identity` — 131
   (holder read's identity/type) or 132 (deletion presence); opaque.
7. `(standalone) property-write delete preserves strict Boolean identity` —
   131 or 132; opaque.
8. `(standalone) ordinary return and parameter keep delete Boolean identity` —
   141 (result identity/type) or 142 (deletion presence); opaque. Host twin passes.

Those are assertion alternatives from unchanged source, NOT measured payloads.
An unexpected exception before either sentinel remains possible. Do not merge
these rows into one causal bucket or infer eight fixes from one hoist patch.

## Concrete native control10 causal chain

Retained source is the exact fixture helper assembly, with:

    var obj: any = { test262id: 1 };
    with (obj) { var test262id: any = delete obj.test262id; }
    if (!booleanResult(obj.test262id, true)) return 101;
    if (test262id !== undefined) return 102;

The unchanged helper compares strict equality AND typeof boolean, calls test
from deferred top-level initialization and throws `Control result: N` on failure.
Options: fileName `issue-6878-delete-result-boolean.ts`,
skipSemanticDiagnostics:true, inferModuleStrictArguments:false,
deferTopLevelInit:true, target:standalone; no extra IR/engine/source-map override.

Capture `.tmp/6878-control10-render-currentmain-metadata-admitted/receipt.json`
SHA256 `0d15975df0bd88950e7dc5e873644f9e6bbad58cc9e568b5737fbea6feeaf95f`:
HEAD `2953fe1f3a4b9493a7550044cfe691f4951542cc`, source set
`9ba37e0a5cba06b037d706dc4db606875c3a500c4900edea9b1a160bf34aa81f`,
one native execution, one actual renderer call, all tag/renderer/init
capabilities present. Actual exception is `Error: Control result: 102`.
Source SHA `9bd2cecc3d697423b95e1f9ec7c4f37b603d215192cb2e72c82dd55dce793e00`;
270027-byte control.wasm SHA
`934bbc9eab8e97f25aa218a54be45c480f95e2c7d550cbf213598702e32187c2`.
This is native-first standalone, NOT the official auto/default-QuickJS lane.

Complete compiler-returned WAT was read for `$test` at lines 6257–6481;
file SHA `aa516f8be9cc80354013a8c38e73a4e6c0d472d3b5620c1e4a96d9bf426b861c`.
It declares `$test262id externref` at local11 and never initializes it at entry.
It captures HasBinding BEFORE delete, calls real delete154, boxes Boolean65,
and saves the result in local10. The captured object arm writes local10 through
setter150; only the alternate fallback arm assigns local11. Boolean guard86
on obj.test262id passes at runtime (otherwise sentinel101 would have won).
Next, local11 is tested by undefined predicate232; false selects sentinel102.
The unset externref local is Wasm default null, not the native undefined singleton.
These function numbers are this saved module's identities, not future indices.

Current source has precisely the missing precursor:

- `function-body.ts:773/860` calls hoistVarDeclarations for function statements.
- `index.ts:13967` delegates each statement to walkStmtForVars.
- `index.ts:14339–14411` handles variable/block/if/while/do/for/for-in/of/labeled/
  try/catch/finally/switch statements, but no WithStatement.
- `index.ts:14137` hoistVarDecl allocates the binding; lines 14316–14335 seed
  externref slots through emitUndefined and local.set.
- `with-var-decl.ts:80–94` already captures the reference before RHS evaluation
  and writes through the chosen environment, correctly leaving the outer local
  untouched when the object binds it. Do not change this behavior.

Read-only diff from captured 2953fe1f to current HEAD shows no changes in this
hoister, with-var-decl, or assignment emitter. The only index.ts differences
are an unrelated optionalFieldFlag import/use for struct field registration.
Thus the source omission survives; the old native result remains dated as old.

## Ownership, blast radius and size

Sol may own only the WithStatement addition to the existing body-recursion
condition in `src/codegen/index.ts`, plus focused regression additions if needed.
Root owns canonical issue updates and all execution. Preserve initializer
lowering, reference capture, boxing, delete helper, IR and scope algorithms.
The change affects function-scoped var declarations nested in with, including
unreachable with branches and nested with bodies, as JavaScript hoisting requires.
It does not make with receiver expressions eager or leak nested-function vars.

Current index.ts is 15360 physical lines, SHA
`a58542a37a378ea33bb4e2add23b1aecd2b2f28c37b741a3f3c6ee11f17f43d7`.
Committed LOC baseline lists 15318: raw baseline margin is -42, not spare room.
walkStmtForVars is 73 lines and has no function-specific baseline entry; it is
below the standard 300-line ceiling. Extending the existing labeled-body
condition can keep physical line count unchanged without packing statements,
deleting comments or a budget grant. Root must run real formatting/budget gates;
these counts do not certify their effective comparison baseline. No broad
refactor or shared-baseline edit is needed for a one-condition correction.

## Root validation of this release

Use the unchanged 36-case fixture/options on exact source baseline and candidate.
Require pre-RHS standalone to pass both assertions; render any remaining native
exception with the existing actual-instance renderer, preserving the exception
and result as evidence. Host pre-RHS is a separate outcome, not assumed fixed.
Revert only this condition for attribution, then restore it; retain every row
identity and first failure. Expected behavior is canonical undefined seeded at
function entry, exactly one original RHS/delete evaluation, and the existing
pre-RHS environment choice. Require no prior PASS loss.

Focused adjacent controls should cover a read before an unreachable with-body
var declaration; a with receiver with a once-only side effect; nested with;
and a nested function's var that must not leak to the outer frame. Preserve
lexical declarations/TDZ and the existing RHS-created-property/unscopables
controls. Root runs relevant with/hoisting regression tests, normal mechanical
gates, unchanged official eight and required changed-root gate. Official eight
previously passed all arms and cannot substitute for the native focused row.

## Remaining rows after this release

Their current stdout/JSON cannot resolve first assertions. A finite exact-row
exception rendering pass is warranted for the other seven, using the existing
render-control10 pattern and the actual original fixture assembly/options; no
rewritten probes or manufactured returns. This can accompany normal root
validation rather than blocking the supported hoist implementation.

Source leads only, not causal assignments: host delete-aware reads in
property-access.ts:3004 onward switch to a struct dispatcher while
__in_module_init is true (the fixture calls test during deferred init), which
can bypass tombstones; runtime.ts __delete_property / _wasmStructHasOwn already
own deletion/presence. Property-write dispatch boxes the Boolean before
member-set's field coercion; numeric-property-analysis already vetoes delete
writes from numeric properties, so another identical veto is not a justified
fix. Standalone return/parameter failure needs its actual ABI/value/presence
join; host success does not license a global return-representation change.

After payload rendering, inspect only the indicated original body and helpers:
11/31 → result carrier; 12/32 → presence/read; 91 → compare and presence
separately; 101 → dynamic binding write/read; 131 → holder write/read carrier;
132/142 → deletion; 141 → remove return, identity parameter/return and consumer.
Keep unknowns if payload rendering cannot authenticate. No full eight-failure
repair, PR readiness, CI recovery, canonical ES2015 gain or publication is
claimed here.

## Root paired hoist execution — 2026-10-09

Root read complete frozen source and handoff; the sole production condition
adds WithStatement beside LabeledStatement. Parent remains 15,360 lines;
actual Prettier check passes with no parent reformat. New controls were read
in full and formatted. Initial focused typecheck 44031 failed on the DOM
BufferSource generic/instantiate overload; copying emitted bytes into an
actual new Uint8Array fixes those types without a cast or changed content.
Focused typecheck 15655 then terminated exit 0.

Candidate session 44129 terminated exit 1, 36P/8F/44, 22.57s; exact report
.tmp/6878-with-var-candidate-20261009.json. Original fixture separately is
**30P/6F/36**, versus the historical 28P/8F. New controls separately 6P/2F/8;
their two host failures remain mandatory and unmasked.

Root removed only the new WithStatement condition for the matched baseline.
Baseline session 17279 terminated exit 1, **30P/14F/44**, 23.39s; exact report
.tmp/6878-with-var-baseline-20261009.json. Root independently matched all 44
unique complete row names: **6 FAIL-to-PASS, 0 PASS losses**. Two fixes are the
existing host and standalone pre-RHS outer-binding cases; four are the new
unreachable-var host/standalone and standalone once-only/nested-with controls.
The two new host-control failures occur on both arms. No assertions, profiles,
old fixture bytes or compiler options were changed to earn this difference.

Root restored the candidate condition after baseline terminal. Parent SHA256
4a581c7c8153dec0c8bb3640d34ed2909f69bbc841cf7aa6ee911f32fb8035b1 and original
36-case fixture SHA256454da1999b7be41d56daf6a19c204c2bbc0930cdc2e664f01b361b4d4bfa2773
are independently verified. These are native regression gains, not new
authoritative Test262 verdicts. Six original and two new failures still block
readiness; actual exception rendering/neighbor controls/mechanical gates and
official runner checks remain next. No completed/ready/full11778 claim.

## Root authenticated remaining-payload execution — 2026-10-09

Session7604 terminated exit0. The separate diagnostic extracts literal bodies
and the exact compile template/options from unchanged fixtures; ten normal
compiles and ten genuine native initializers use returned imports and actual
exception rendering. No mock imports, changed assertions or fabricated values.
Retained receipt: `.tmp/6878-remaining-native-render-LcEnN6/receipt.json`;
source script `.tmp/6878-preparation/render-remaining-native-controls.mts`.
All three fixture/parent seals stayed identical before and after execution.

Eight reproduced failures render `Error: Control result: N`: member-host12,
computed-host32, bare-with-host91, property-write-host131,
property-write-standalone131, return/parameter-standalone141,
with-receiver-host212 and nested-with-host222. These sentinel values identify
the original assertion stopping execution; they do not by themselves prove
one shared cause. The two pre-RHS cases (host and standalone) completed as
positive controls. Original member/computed failures occur after Boolean
identity checks; remaining property-write/return failures stop at Boolean
identity checks. Host with failures still need carrier/store attribution.

Next implementation plan must inspect actual lowering and native helper
ownership for these unchanged sources before choosing fixes. All eight remain
required; zero canonical Test262 credit and no PR readiness claimed.

## Root genuine-instance binding attribution — 2026-10-09

Astra inspected current public API and lifecycle adapter: real
`__setInstance(instance)` establishes data-struct authority; legacy
`__setExports(raw exports)` explicitly does not. Root separately labelled
diagnostic binding modes, retaining legacy default and unchanged fixture bytes.
Only the genuine-instance host arm calls the actual returned lifecycle method
with the genuine instantiated module; standalone remains unchanged.

Session38674 terminated exit0, ten normal compilations/real native initializers;
receipt `.tmp/6878-remaining-native-render-aZeXFE/receipt.json`. Root matched all
ten ordered rows to LcEnN6: exact source hashes/options/tracked template options,
binary hashes and actual physical binary-byte equality. Three host failures
become completed: bare-with91, receiver-once212, nested-with222. Both positive
pre-RHS cases remain completed. Five fail identically: member-host12,
computed-host32, property-write-host131/standalone131 and return-standalone141.

This attributes three local failures to missing genuine-instance driver wiring,
not compiler gains. Do not weaken authority checks or claim full-suite credit.
Preserve original bodies/options and old receipts. Next correct maintained
driver lifecycle explicitly, pair the whole44 fixture, then implement the five
remaining lowering defects from authenticated source evidence.

## Astra authenticated remaining-failure implementation plan — 2026-10-09

# 6878: remaining native delete/with failures — source-grounded plan

2026-10-09, Astra planning handoff. Root owns execution, the canonical issue,
production, tests and publication. This planner wrote only this new scratch
document. No compiler, test, parser, formatter, typechecker, build, install,
hook, source edit, commit, push, issue allocation or GitHub operation was run.
The requested old planner directory was absent; after listing attachments,
the managed worktree tool created this separate planner checkout at the exact
source HEAD. Existing changes and other agents' work were not modified.

## Exact source and evidence custody

All source paths/line numbers below refer to the read-only authoritative tree:
`/Users/thomas/Code/js2/.codex-worktrees/6878-delete-result-boolean-sol61`.
HEAD independently read as `56c33d1a3246191cfe8b466d83e937b7c354e475`.
The dirty hoist candidate `src/codegen/index.ts` independently hashes to
`4a581c7c8153dec0c8bb3640d34ed2909f69bbc841cf7aa6ee911f32fb8035b1`.
The one-condition WithStatement descent stays in place. Preserve the existing
DeleteExpression Boolean result brand and numeric-analysis Booleanish veto.

Read the prior frozen 193-line Astra plan and root's subsequent entries in
`plan/issues/6878-delete-expression-boolean-result-brand.md`, the full two
fixtures, root's extraction/render script, receipt and retained WAT bodies.
Root's matched native measurement is baseline 30 PASS/14 FAIL/44 versus hoist
candidate 36 PASS/8 FAIL/44: six gains, zero losses. These are attributed root
measurements, not executions by this planner, and carry zero Test262 credit.

Frozen old fixture SHA256:
`454da1999b7be41d56daf6a19c204c2bbc0930cdc2e664f01b361b4d4bfa2773`.
New mandatory eight-case fixture SHA256:
`9df80184aba57401917ab099dac35655743ee73b6fe788a5d2467b4af49d67a3`.
Root's diagnostic script is
`.tmp/6878-preparation/render-remaining-native-controls.mts`;
retained native directory is `.tmp/6878-remaining-native-render-LcEnN6/`.
Its `receipt.json` records ten actual compiles/initializers, actual returned
imports, actual native exception rendering, eight failures, two completions.
The original source and binary SHA256 for every row are in that receipt.
No synthetic mock import, replacement body, source rewrite or generated return
value may substitute for these inputs.

Exact retained row IDs and first observed sentinels:

- `0-controls-0-host`: 12; member-delete Boolean assertion 11 passed.
- `0-controls-2-host`: 32; computed-delete Boolean assertion 31 passed.
- `0-controls-8-host`: 91; combined result/presence assertion, not split yet.
- `0-adjacentControls-0-host`: 131; property Boolean identity/type.
- `0-adjacentControls-0-standalone`: 131; property Boolean identity/type.
- `0-adjacentControls-1-standalone`: 141; return/parameter result identity/type.
- `1-controls-1-host`: 212; once-only receiver count/property-value assertion.
- `1-controls-2-host`: 222; outer function locals must remain undefined.
- `0-controls-9-host` and `0-controls-9-standalone`: completed; positive controls
  for the already-fixed pre-RHS reference capture/outer undefined behavior.

Every compile uses the original fixture template, fileName
`issue-6878-delete-result-boolean.ts`, skipSemanticDiagnostics:true,
inferModuleStrictArguments:false, deferTopLevelInit:true; standalone alone adds
target:"standalone". No extra engine/IR/optimization override. The 36-case
fixture includes six analysis registrations, so distinguish its runtime rows
from the 44 total registrations when reporting execution counts.

## Release D: genuine-instance binding separates three driver defects

The current fixtures and render script call only
`importObject.__setExports(instance.exports)` before `__module_init`.
That is an obsolete/incomplete binding for current struct introspection:

- `src/index.ts:360–371` documents `__setInstance(instance)` as the call that
  establishes data-struct authority; raw `__setExports` explicitly does not.
- `src/runtime/instance-lifecycle-adapter.ts:48–68`: setExports calls
  install(exports,false), whereas setInstance checks the genuine Instance
  internal slot and calls install(exports,true).
- `src/runtime.ts:19606–19620`: only that true argument permits establishing
  the data-struct bridge authority in the prepared export view.
- The authoritative Test262 driver binds the genuine instance before deferred
  initialization at `tests/test262-runner.ts:4640` and `:5164–5170`.
- `tests/issue-6438-raw-exports-struct-decode.test.ts` pins refusal without
  authority and success with __setInstance; this security contract stays.

Concrete relevance, not just documentation: bare-with WAT uses host
`__with_has_binding` before delete and to select the assignment target.
Nested-with WAT initializes both outer locals correctly, puts the outer object
on the open-object path, but creates the inner object as a closed numeric
struct; a false inner HasBinding falls through to local.set innerValue, exactly
the path to sentinel222. Once-only-receiver WAT increments the boxed count once
and uses HasBinding to choose between writing the struct environment and the
function local. Its sentinel212 can therefore expose the same missing host
shape authority.

Root completed that separately labelled driver comparison during planning:
session38674 exited0, receipt
`.tmp/6878-remaining-native-render-aZeXFE/receipt.json` (read in full here).
All ten source/options/tracked-options/binary hashes match LcEnN6; root also
reports independent physical-byte equality. Each arm uses fresh imports and
an actual fresh Instance. Under genuine-instance binding, bare-with91,
once-only-with212 and nested-with222 all complete. The other five failures
remain12,32,131,131,141; both pre-RHS positive controls still complete.
This is **three driver corrections, five remaining compiler failures**, not
three compiler gains. There is no supported with-scope/HasBinding/runtime
security production change. Source and fixture seals remained unchanged.

Carry those ten retained rows, plus genuine-instance twins of the other relevant
passing original controls (refused deletes, once-only operand/order,
RHS-created-property, unscopables). Record every full name, hook presence,
source/binary hashes and terminal. Preserve both historical driver receipts.
Never run both binding arms on one Instance/import state: established authority
can contaminate the other arm. Standalone remains the independent control.

With that matched evidence now present, root may update the two test run helpers to
the documented genuine-instance hook. Keep every literal body, assertion,
target, registration and compile option intact, and retain the old fixture
bytes/receipt as a dated historical baseline. This is an explicit driver
correction, not a silent rewrite of the frozen test result. Until root adopts
it, the old fixture remains unchanged and its eight failures remain recorded.
Do not make __setExports establish authority to turn these tests green.

## Slice R: deferred-init delete reads must observe tombstones

Supported production seam: `tryEmitDeleteAwareDynamicGet`,
`src/codegen/property-access.ts:3004–3111`.
In `0-controls-0-host.wat:83` the test calls host delete, boxes Boolean, passes
booleanResult, then calls __extern_has. The RHS property read branches on the
module-init flag and directly reads struct field0 as f64, boxing stale17.
Computed-delete uses the same final `obj.p` read. The source's own comment at
3066–3068 claims "nothing has been deleted yet" during init; these original
deferred-init bodies falsify that assumption.
Runtime `__extern_has` delegates to tombstone-aware `_wasmStructHasOwn`
(`runtime.ts:4659`, tombstone check precedes shape/sidecar checks), so replacing
delete result boxing or the in-operator is not supported by these WAT bodies.

Narrow correction: for **deferred** top-level init, do not select the
start-section-only struct-get bypass. A caller must bind the real Instance
before deferred init; the normal host __extern_get then has authenticated
exports and preserves tombstones. One bounded option is to decline reserving
the init dispatcher when `ctx.deferTopLevelInit` is true, taking the already
existing bare-get path. Leave standalone and the nondeferred start-section
fallback unchanged. Preserve receiver evaluation exactly once, existing string
key pooling and late-import index handling. Do not rewrite the global init flag
or all dispatchers. Changes to the companion setter are not required to prove
these two failures and need independent evidence.

Root validation: correctly bound host original member+computed rows pass all
assertions; standalone twins and refused-delete/strict-TypeError controls keep
passing. Attribution removes only this guard on the same correctly bound driver
and reproduces 12/32; restore it. Run `issue-2179.test.ts` and
`issue-2800-toplevel-new-objlit-init-read.test.ts`, including its nondeferred
start-section top-level-object-read case. Add a small correctly bound deferred
init read/delete/read control only if it adds coverage beyond the originals.
Nondeferred delete-during-start general correctness is not claimed by this
bounded fix; it would require its own native/helper investigation.

## Slice P: preserve a property's number-to-Boolean write in its carrier

This is separate from R and from the driver defect. Retained host WAT
`0-adjacentControls-0-host.wat:90` creates holder.result as an f64 field,
correctly boxes delete with __box_boolean, then the module-init setter
dispatcher calls __unbox_number and stores f64. The subsequent read boxes a
number, explaining sentinel131. Changing delete's brand again cannot help.

Standalone WAT `0-adjacentControls-0-standalone.wat:6259` creates holder on open
$Object storage, correctly boxes delete and stores through native __extern_set
after its closed-struct candidate misses. Its read nonetheless takes a
same-property-name f64 result vote; the fallback native read is unboxed and the
consumer receives a number. Thus storage and read both need consistent field
facts; a host-only setter patch leaves standalone wrong.

Primary source owner: `collectObjectLiteralAssignedPropertyNames` in
`src/codegen/declarations/object-shape-widening.ts:103–236`, and its existing
declaration-keyed consumer `ensureStructForType` in `index.ts:13615–13628`.
Today indexed writes collect concrete primitive RHS types and union-receiver
dot writes do so too, but an ordinary dot write with Boolean RHS is neither
mayCarryObject nor a union receiver. It leaves the literal seed's f64 intact.
The existing numeric-property DeleteExpression veto prevents one *promotion*;
it does not widen this already-numeric literal seed.

Bounded implementation: record incompatible direct primitive writes against
the actual literal property's declaration, reusing the declaration-keyed
assigned-write map and existing carrier widening. For an any-annotated receiver
such as the original holder, a property symbol may not resolve: follow the exact
receiver binding declaration to its object-literal initializer and exact static
property key, not a name-wide guess. Resolve wrappers and use the existing oracle;
do not add raw checker queries, fabricate an `any` annotation or treat unrelated
same-spelled properties as aliases. A narrow helper may own this resolution.
Unresolvable aliases/receivers stay UNKNOWN/outside this bounded proof; widening
all numeric fields named result/value is not an acceptable shortcut.

The existing `receivesIndexedCarrier` consumer can then choose externref and
mark stale scalar checker facts. Both host struct getter/setter and standalone
candidate vote must see that same widened field. Do not add an independent
Boolean special case to generic coercion or mutate shared struct fields after
function emission. Verify emitted evidence before broadening the dispatch code:
host no longer unboxes the Boolean into an f64 field; standalone does not
narrow an open-object Boolean read to f64. If its candidate still appears f64,
identify which registration failed to consume the recorded write first.

Independent controls: original property row in both targets; number-only same
shape still numeric; a separate same-name property retains its own carrier;
unannotated direct receiver; literal computed key; strict Boolean identity plus
typeof, and deliberate unary-plus/arithmetic returns real numbers. Preserve
unknown-key/alias conservative paths and existing indexed/union carrier tests.
Root pairs this slice's removal/restoration while R/driver remain fixed. Both
131 rows must settle beyond the identity assertion; any newly reached132 is a
separate remaining failure, not a claimed pass.

## Slice L: Boolean call returns must not prove an f64 receiving local

Retained standalone return WAT `0-adjacentControls-1-standalone.wat:6256`:
`actual` is f64; remove returns the Boolean box correctly (function at83441,
delete154 → Boolean-box65); identity is inlined as an externref identity; then
the receiving assignment unboxes that externref to f64 and reboxes a number
before booleanResult, which fails141. Do not rewrite return/parameter ABI or
__box_boolean. Host's passing twin is an independent preservation control.

Exact existing source mechanism: `numeric-property-analysis.ts:1103` admits a
call from its internal numericFunctions set; `isBooleanish:1148` sees direct
delete but does not follow calls or identifier return chains. The greatest
fixpoint permits Boolean-compatible arithmetic evidence, and the grounded
local proof at1503–1562 consumes that unfiltered function set. The explicit
comment at1284–1300 already documents the unsound local-from-predicate case:
public function filtering happens only at1602, after the local proof.
`usage-inference.ts:325–327` then accepts the positive local oracle despite a
Boolean-observing call use. This is a local-carrier proof defect.

Owner boundary: numeric-property-analysis and a focused helper only if needed;
do not change the greatest fixpoint/public return-ABI publication boundary.
That boundary intentionally keeps arithmetic-compatible internal evidence for
existing consumers, with documented measured performance consequences from
filtering globally. The local proof needs **number-only** call evidence.

Implementation direction: supply the grounded-local prover a separate admitted
call-return set whose returns are proved plain Number, including the parameter
definitions along identity chains. Compute it with conservative finite
iteration/grounded slots, or add an equivalent transitive Boolean-contamination
veto scoped solely to local admission. Direct delete/comparison/Boolean literal
and a call returning any of those cannot authorize an f64 local; identity must
not launder that fact through its parameter. Cycles/unknown calls/fallthrough/
same-named ambiguous declarations must not become positive Number proofs. Keep
the existing genuinely numeric local, arithmetic consumer, recursion and
call-return-refinement contracts. Before editing, read existing test pins around
the publication-only filtering and parameterDefinitionsAgree; don't solve this
by deleting the designed greatest-fixpoint behavior for all consumers.

The exact code algorithm is Sol's bounded implementation choice, but release
requires the original emitted actual local to retain externref and141 to pass.
Tests: direct delete-return, one/two identity hops, same-spelled functions in
separate scopes, mixed Number/Boolean return, unknown/cyclic returns refused,
and genuine Number identity kept eligible. Reuse `issue-3765-numeric-locals`,
`issue-4121-interprocedural-proofs`, `issue-4121-numeric-return-carriers`,
`issue-4121-unboxing-admission` and relevant `issue-4406-ret-unbox-*` pins.
No claim that a flag-off run is a final fix; removal/restoration attribution
uses the same original options and bodies. Any newly reached142 stays a real red.

## Sequencing, ownership and gates

D is root-only and first: its completed experiment settles the three with-host
failures and prevents engineering around under-assembled imports. R, P and L can
be implemented in isolated Sol 6.1 lanes after root copies this plan into the
existing issue and hands out exact nonoverlapping ownership. R owns only the
delete-aware getter; P owns the direct-write declaration pre-pass and narrowly
necessary carrier plumbing; L owns only number-proof admission for locals.
Root retains index.ts/hoist and canonical issue ownership. P must request a
specific index.ts hunk from root if existing consumer reuse is insufficient.
Root alone serializes all heavy execution and integration; no peer compiler or
test run while the serial slot is occupied. No numeric issue ID is invented.

Read actual LOC/function gates before implementation. Current physical sizes:
property-access6939 (committed baseline6924), property-access-dispatch5575
(5573), numeric-property-analysis1684 (1683), object-shape-widening2781 (2781),
index15360 (15318). These are counts, not effective gate verdicts or spare
capacity. Existing issue grants cover only expressions.ts and
numeric-property-analysis.ts plus compileExpressionInner/makeProver. They do
not authorize unrelated parent growth or a new analysis function over300 lines.
Prefer a small semantic change and well-scoped extraction only when needed;
never pad grants, delete comments, compress statements, alter shared baselines
or change inventory/schema to evade gates. New helper files need normal flat
directory, import-cycle, inventory, oracle and function/LOC checks. Root may
record a narrowly measured grant in this issue only if the actual gate requires
it and the added code is necessary; no unmeasured grant is requested here.

For each slice keep all44 original registrations mandatory, pair same source
epoch and same driver on both arms, diff complete row names, report counts and
first failures, retain actual terminal/stream records. Run meaningful adjacent
checks once per changed mechanism, then normal typecheck, lint, changed-file
formatting, LOC/function/inventory/import-cycle/flat-directory/oracle/coercion/
dead-export/issue-integrity/spec/ID gates and the actual changed-root gate.
Keep root's unchanged official-eight packet and final source-keyed provider
admission requirements. No census gain follows from native helper controls;
full11778 remains a separate, frozen original-input measurement. No readiness,
merge recovery or100% claim until all required checks actually settle.

## Remaining uncertainty

The genuine-instance diagnostic completed with three driver corrections and
five unchanged compiler failures. Complete44 verification on the adopted driver
is still required; ten diagnostics do not replace it. Property and local
carrier corruption is visible in retained original WAT, but a successful
implementation must still pass the complete original bodies and show no loss.
The planner did not execute or certify any candidate. A read-only planner git
status attempt failed because Git LFS tried to create a shared .git/lfs/tmp
file under sandbox; no clean-status assertion is made and no filter/config was
changed. The managed planner checkout itself is not production evidence.

## Root complete44 genuine-instance driver adoption — 2026-10-09

After the byte-identical matched diagnostic, root explicitly updated only the
two run helpers to call actual `__setInstance(instance)` rather than raw-export
binding. All literal bodies/assertions/compiler options/targets/registration
counts remain intact. This is a documented driver correction, not a silent
claim that the historical frozen fixture was green. Original fixture bytes
remain recoverable at56c33d1a and old baseline/candidate receipts are preserved.
New old-fixture SHAabc1dc156dacb63a6c95c4306806f0556adfa5c2ea4fdb381c7c15c6f94a2c93;
new eight-case SHA14b7501a750a2467efac4739eca9dbd88de2c20f071afa85cc051ee0e30bebf5.
Production index still4a581c7c8153dec0c8bb3640d34ed2909f69bbc841cf7aa6ee911f32fb8035b1.

Session25207 terminates1, **39P/5F/44**,24.34s. Root independently matched all
44 full registration names against preceding36P/8F arm: exactly three driver
corrections, zero PASS losses. Remainingfive are member/computed-host reads,
property-write Boolean identity host/standalone, return-identity standalone.
Eight new hoisting controls all pass. Source-level delete/Boolean fixes remain
unfinished, no canonical credit or completed PR claim.

## Root slice-R native verification — 2026-10-09

Root read the complete source handoff from isolated Sol lane, authenticated
the exact parent preimage324ddf2409af117921352653354ff66a604ec3c014dfc40895b06a638ae59eb4,
then integrated only the getter/comment hunk. Parenta0570818152651cbaf770f569e7af5c4eeef8b31adc1d27d6d1eb36f057c5756,
6938lines, actual Prettier check passes. Deferred init now uses tombstone-aware
host reads; nondeferred start-section fallback remains. No body/option edits.
Driver formatting/type session22300 previously terminated0.

Full44 candidate session83422 terminates1, **41P/3F/44**,38.37s. Root matched
all44 original full names to genuine-instance39P/5F baseline: exactly member
and computed host FAIL-to-PASS, zero PASS losses. Remainingthree are property
Boolean identity host/standalone and standalone return/parameter identity.
Both original semantic reads now pass all assertions, not just compilation.
Attribution removal/restoration, nondeferred neighbor checks and source types/
gates remain required. No canonical Test262 or PR completion claim.

Neighbor session31461 terminates1, **11P/1F/12**: all ten issue2179 controls
pass and issue2800 nondeferred initialization read passes, but its post-delete
tombstone control observes0 instead of1. Root does not assume unrelatedness:
temporarily removed ONLY `|| ctx.deferTopLevelInit` for matched baseline
neighbor session55905. This handle is live; guard restoration must follow its
terminal result before candidate integration/types/publication. Source comment
is retained, old fixture/driver/source elsewhere unchanged. Until baseline
evidence settles, neighbor regression status remains UNKNOWN.

Matched neighbor baseline55905 terminates1, **11P/1F/12**,76.46s. Same
nondeferred top-level read passes and same post-delete control returns0
instead of1; all ten issue2179 cases pass. This rejects a new neighbor PASS
loss from the deferred guard, without declaring the existing failure acceptable.
The issue2800 helper still manually builds imports and uses legacy raw-export
wiring, so driver attribution remains separate pending actual experiment.
Root restored the guard after terminal and reauthenticated parenta0570818...5756.

Root read slice-P handoff and full exact patch from separate Sol worktree.
Authenticated parent preimage6475ed5fa85f83b1ed7dceea229a62804d0140679d1d5373aec326aa606771f4;
integrated only object-shape-widening, new object-property-write-target helper,
and new21-registration carrier fixture. No index/runtime/old-body edits.
All three actual formatting checks pass (session54565 terminal0).
Focused source/test types session94352 is LIVE with all three6878 fixtures;
no runtime/WAT/carrier fix result claimed yet. R guard remains restored.
New focused fixture seeds result0 as supplemental coverage; retained original
adjacent source seeds result23 and remains mandatory in full44 execution.

Merge-authorized shepherd's fresh recovery8 audit finds zero eligible owned
PRs. Published6548 is still56c33d1a with28P/8F/36, not this local41P/3F/44;
no unpublished gain is a reason to mark that old head ready. Conflict/required
CI/unfinished scope holds are preserved; no source/queue/PR state mutation.

Focused types94352 terminates1: only DOM BufferSource/instantiate overload
errors in old/new carrier run helpers. Root fixes them with an actual
`new Uint8Array(result.binary)` byte copy before real validation/instantiation,
matching the already-correct hoisting helper; no unsafe cast or byte mutation.
No test262/source/options/assertions changed. R/P behavior and rechecked types
remain next; terminal failure is not ignored as a successful gate.

Focused types85747 terminates0 after byte-copy driver corrections. Current
original fixture SHA86e07e09cf4ff80337679a25e6cce035b88ad10fbc6ed6e48492670c645274d8;
new property fixture9d4e59430603d668a0cf22981fcd5feee7c53d3c4e800d65d9f63f603d1486f4.
R parent and P parent/helper match frozen source hashes. Full original44 plus
new21 candidate session34081 is LIVE, all65 mandatory. No L source integrated
during this source epoch; any P gain/loss must come from actual complete rows.
Last goal turn is PROGRESS: authentic R two-gain/zero-loss native comparison,
three driver corrections and complete original-nine preservation evidence
changed the next implementation action; full11778 objective remains active.

Full65 P candidate34081 terminates1: **64P/1F/65**,111.97s. Root independently
matched original44 complete names to R-only41P/3F baseline; originals now
**43P/1F/44**, exactly two property-write identity gains (host and standalone),
zero PASS losses. All21 supplemental carrier/resolution registrations pass.
Remaining original is standalone return/parameter Boolean identity141.
No original expectation/sourcebody/options were weakened; byte-copy driver
change preserves actual emitted content. Complete WAT/attribution/neighbor/gates
remain necessary; this is not a canonical Test262 pass-rate update.

R+P normal native diagnostic26763 terminates0 with ten genuine initializers;
receipt `.tmp/6878-remaining-native-render-nRruQ8/receipt.json`. Root matched
all ten IDs/original source hashes/options/tracked template options to aZeXFE.
Nine complete; only original return/parameter standalone141 throws. Main read
actual host property WAT: holder.result is externref; setter stores directly
without numeric unboxing, getter returns externref. Standalone actual store/read
blocks likewise preserve externref through the closed candidate and open fallback
before Boolean observer; no numeric unbox. The old standalone actual local
remains f64 in the sole remaining case. These are emitted/native evidence, not
manufactured outputs or canonical verdicts.

Root read full isolated Sol slice-L handoff/diff/new24-test fixture and verified
numeric parent preimage de964d921844e29db567d92c09a4ce3adfd346288f891729cbbff6baa605552f.
Integrated only its numeric-local proof/new fixture after P terminal. Normal
formatting gives parent1806lines SHA073843081199509e6f1315ccebd9de4a6cc3a1f04a4b919f9dcba0399f6c574c;
new fixture151lines SHAece9a4e9df42d387e56ea19a7ccca72a3db896236470ea16e8e2b731c5a9c22f.
Root applied the same real Uint8Array byte-copy DOM typing fix to its helper,
not a cast. Focused all-four-fixture types11918 terminates0. Greatest fixpoint,
field/public-return publication and original bodies/options remain intact.
Full89 original44+P21+L24 candidate is now live; no L semantic result claimed yet.

Full89 candidate40220 is terminal1: **86P/3F/89**,110.90s. All retained44
originals and all21 property-carrier registrations pass. Local proof24 has
21 passes and three failures: literal Number return, Number identity and two
Number identity hops incorrectly decline their numeric positive proof. All
six native Boolean controls and actual externref WAT controls pass. These
positive controls remain mandatory: no assertion weakening or ready/publication
claim. Reports are `.tmp/6878-RPL-full89-20261009.{stdout,stderr,json}`.
Source declaration-binding evidence and a narrow proof correction are next.

Declaration-proof correction plan and source epoch: actual `buildScopes`
registered FunctionDeclaration on `frameOf(node)` (the declaration's own
function frame), while fact collection never recorded its callable definition.
Root read all definition consumers; existing value provers require `expr` and
therefore must continue treating declaration markers as opaque. Astra reviewed
the proposed parent-owner registration and exact `functionDeclaration` marker,
including the missing block-scope boundary. The local Number-call proof now
requires a nonempty actual owning binding and every recorded definition to
retain the exact function node. Block/conditional/Annex-B declarations remain
refused because pooled function frames cannot prove their lexical ownership.
No mutation/shadow/duplicate refusal is waived. Added four negative declaration
controls and one genuine nested-function positive, preserving all old controls.
Sol correction dispatch/resume was rejected by agent thread limit; root applied
this small reviewed correction in its already-owned isolated candidate, not the
dirty shared checkout. Normal formatting completed. Focused29 execution57686
is live; no successful semantic result is claimed before terminal evidence.

Focused declaration correction57686 terminates0: **29P/0F/29**, all rows
independently read from actual JSON. All three old numeric positive failures
are restored; every old Boolean/refusal/native WAT control and all five added
declaration ownership controls pass. Source1825lines SHA25132364dd10d0da73a41ea276f28b75f5b6096519f2516fb1af76b27bec8d36;
fixture162lines SHA9bd53aa4acda12f25b2a962e6d7ccec208ea1fc21f8de57fcff22d79eb77225b.
Reviewed current normative FunctionDeclarationInstantiation, §10.2.11:
https://tc39.es/ecma262/multipage/ordinary-and-exotic-objects-behaviours.html#sec-functiondeclarationinstantiation
Body declarations are instantiated in the containing function environment;
the conservative analysis still refuses ambiguous/conditional blocks rather
than claiming exact block-scope modeling. Full94 composed candidate launched
under identical parent1024/fork3072/pool1/maxWorkers1; broad preservation and
source gates remain unproven, so PR6548 stays unfinished until measured.

Current measured LOC rationale supersedes no historical gate receipt: against
actual upstream fork pointab86c902 numeric-property-analysis is1683→1825,
**+142**, not merely the original single Booleanish line. The same existing
issue-local path grant is now used for the bounded Number-only local proof,
exact declaration-definition recording and documented refusal boundaries.
No property/public-function fixpoint or ABI rewrite is included. The separate
property-write target helper is grouped under declarations (97lines), while
object-shape-widening shrinks2781→2750 by moving the reused target scanner.
No flat codegen file, shared baseline update, comment deletion, line packing
or unrelated budget allowance is introduced. Function/cycle/inventory results
must be measured afresh; this rationale is not a passed gate or new permission
to grow unrelated oversized functions.

Composed execution8125 terminates0: **94P/0F/94**, zero pending/skips.
Actual JSON contains29 local-call controls,36 original delete controls,
21 property-write controls and8 hoisting controls, all passed. All old89
registrations survive plus the five new declaration controls; no missing or
duplicate name is accepted as coverage. Source remains frozen at25132364...8d36.
Fresh finite root-serialized source assessment33069 is live (focused types,
changed-file formatting, LOC/function/oracle/cycle/flat/inventory/coercion/
dead-export preservation and issue integrity); all output is retained under
`.tmp/6878-composed-gates-20261009-*`. Numeric neighbors, original Test262,
removal/restoration and publication remain pending. Full11778 acceptance is
unchanged and unproven. This goal turn is PROGRESS: actual corrected proof
and94 complete passing controls changed authoritative implementation evidence.

Finite assessment33069 terminates1 with all eleven child outcomes retained.
Types/format/LOC/function/oracle/cycles/flat/coercion/issue integrity pass.
LOC growth is explicitly1683→1825(+142), net+208 across6 changed source files;
makeProver300→302(+2) remains covered only by this issue's existing exact key.
Actual import-cycle pass: largestSCC698,4 nontrivialSCCs,10 two-way pairs;
flat829/829. These are this checkout, not another branch's699/830 counts.
Inventory fails only unclassified module/target for the new97line helper.
Root adds its explicit `mixed-needs-split` debt classification, owner6878 and
prepared binding/property-identity next boundary, preserving active-layer
floors/allowed edges/architecture debts. This is inventory maintenance, not
an architecture-complete claim or detector waiver.
Dead-export preservation actually aborts SIGABRT at1024MiB, explicit native
`Reached heap limit` diagnostic. It produced no verdict and is NOT green.
Keep the original failure logs; rerun separately at3072MiB as one serialized
child, without changing audit semantics or source. All six compiler paths and
four fixtures remained byte-identical across the original finite assessment.

Classified inventory rerun14735 terminates0. No compiler source or fixture
changed; only the explicit new helper ownership/debt entry was added. Complete
architecture remains a separate unproven property. Dead-export3072 rerun is
now live, preserving1024 abort logs and original audit flags. Next mandatory
work after its terminal: numeric-local/interprocedural/ABI neighbor controls,
same-input removal/restoration, fresh source-keyed normal providers and retained
original Test262 packet. Then normal publication/checks and upstream-main
integration; no full11778 or ready-PR claim follows from focused94 success.

Dead-export3072 rerun5101 terminates0. Actual output:12/12 observed core-node
callers (dispatch-cut UNKNOWN),10/10 full and dispatch-cut class-free core-type
references,6/6 full plus cut preservation witnesses. **Preservation-only PASS**;
graph OPEN, strict modeled closure FAIL, retirement/deletion NOT CERTIFIED.
Moved-runtime production-rooted evidence remains incomplete for the existing
nonliteral imports at optimize412 and platform-capability-adapter151. Do not
relocate those old unknowns into a full-closure green claim. The1024 abort stays
retained;3072 changes only resource bound, not audit semantics/source.
Current eight-file numeric/inference/ABI neighbor execution36185 is live,
parent1024/fork3072/pool1/maxWorkers1. No compiler mutation during either run.

Numeric/inference/ABI neighbor candidate36185 terminates1:73PASS/4FAIL/77,
zero skipped/pending. Retained JSON is
`.tmp/6878-numeric-neighbors-20261009.json`. The four failures concern two
interprocedural refusal controls, one numeric-return kill-switch control and
one predicate-call operand control. This is not a ready-publication verdict.
Root temporarily removes the entire corrected local-number slice from only
`src/codegen/numeric-property-analysis.ts`, retaining R/P/hoist and all fixtures,
for identical eight-file pre-L baseline27369. Baseline source SHA256 is
`de964d921844e29db567d92c09a4ce3adfd346288f891729cbbff6baa605552f`;
candidate is `25132364dd10d0da73a41ea276f28b75f5b6096519f2516fb1af76b27bec8d36`.
Both run on HEAD56c33d1a3246191cfe8b466d83e937b7c354e475 with dirty owned
composed changes, normal Vitest compiler/native harness, identical resource
bounds and77 unchanged named registrations. Baseline output prefix is
`.tmp/6878-numeric-neighbors-pre-L-baseline-20261009`. Handle27369 is confirmed
live on2026-10-10; no source changes are permitted until terminal. Restore the
full exact candidate after completion, compare every row/error and investigate
any actual PASS loss without weakening existing assertions or acceptance.

Source-only neighbor investigation identifies the numeric-return kill-switch
failure at the flag assertion, before its WAT/native ABI assertions. Current
source has `resetDerivationFlagCache` only in `compileSourceSync`, while
`compileMulti` routes through `compileMultiSource` directly into `runPipeline`
without that reset. Sequential linked compiles can therefore retain the prior
cached enabled value after environment changes. This is a source-supported
hypothesis; matched pre-L execution is still pending and no regression
attribution has been made. Astra is reviewing common pipeline epoch ownership,
all flag readers/adapters and concurrency before a separate Sol implementation.
Do not change the fixture's OFF assertion, broaden inference, or count a cache
repair as Test262 conformance without measuring the authoritative originals.

Baseline27369 reaches natural terminal1 on2026-10-10. Full JSON comparison
requires77 unique identities in each arm and exact set equality: both73PASS,
4FAIL,0missing,0status delta; all four failure messages are byte-identical.
Therefore the local-number slice produces zero observed regressions in these
77 neighboring controls. This does not make existing four failures green.
Root restores the full corrected candidate immediately after terminal and
reads back SHA25625132364dd10d0da73a41ea276f28b75f5b6096519f2516fb1af76b27bec8d36.
Matched source epoch is unchanged HEAD56c33 with retained R/P/hoist. No assertion
or kill-switch has changed. Next remove only the grounded local-number callback,
execute the original36+hoist8 fixture packet and restore it to attribute the
remaining return-value repair; no current-source full Test262 claim yet.

Root now removes only the grounded-local `numberCallReturn` callback assignment
(all corrected binding/declaration collection and R/P/hoist remain) and launches
unchanged original36 plus hoist8 at identical parent1024/fork3072/pool1/worker1.
Retain `.tmp/6878-original44-grounded-call-removed-20261010.*`; no source edits
during the active run, then restore the exact callback and candidate hash before
further work. This is attribution, not a ready-publication or full-suite result.

Root fully reads Astra's81-line cache-epoch implementation plan on2026-10-10:
`/Users/thomas/.codex/worktrees/es2015-fresh-full-census-plan-astra/js2/.tmp/6878-derivation-cache-epoch-plan.md`,
SHA2567a12970675ded0210cf74610d6634c8dc21b22fac6da0b22429f2a318822fdf4.
Preferred repair resets at synchronous runPipeline entry but retains the early
single-source reset because declaration-root seeding reads flags before that
pipeline. Seven flag keys, slot/verdict dependency, incremental/files/project/
package paths and separate object-output bypass are enumerated in the plan.
Root asks whether compiler.ts and compiler/output.ts entry points are currently
held by other-machine IR work; neither production file may change pending
reconciliation. A fresh Sol6.1High isolated lane owns only a new real compiler
lifecycle regression fixture and MD handoff, re-grounded on dbf5b4 main.
Required tests preserve linked f64-on/externref-off runtime behavior, all seven
epoch transitions, pre-analysis DTS sequencing and field-verdict safety. No
manual cache reset between measured compiles, predicate live-read shortcut,
original expected-value change or unmeasured conformance credit is permitted.

Callback-removal55124 reaches terminal1:42PASS/2FAIL/44 unique registrations.
Standalone ordinary return/parameter Boolean identity fails as expected, but
JSON-only error serialization retains null rather than the underlying error.
The standalone successful-member-delete row also fails with STACK_TRACE_ERROR
at39497ms, requiring actual reporter/timeout evidence rather than a guessed
semantic attribution. No unsupported42→44gain claim is made. Root restores the
callback immediately and verifies full numeric source SHA25132364...8d36.
Rerun unchanged44 controls on the restored candidate with verbose and JSON
reporters to preserve actual error details and restoration evidence. Retain
the entire removal failure packet; never drop its second failed row.

Source-only Sol6.1High cache-lifecycle packet delivered on fresh main dbf5b4 at
`/Users/thomas/Code/js2/.codex-worktrees/6878-derivation-cache-regressions-sol61`.
Root fully reads254-line new test and full own MD handoff. Test delivery SHA256
cc3d64d566aa8dd7fccf06dad0f08ad455f7416b9029d1328f054f28fed30b7f.
Eight serial registrations,30 intended compile arms, none executed: five
adapters times four family transitions, three safety-gate, three linked numeric
carrier/runtime, four genuine declaration-sequencing arms. Reset is confined
to test-isolation before/after hooks, never between measured compiles. Original
fixtures and production files are unchanged; object output stays uncovered
pending ownership. No passing-test or canonical Test262 credit follows.
Root also assigns a source-only finite full11778 census observer implementation
from the fully read Astra plan; no heavy execution or stale1870 count is allowed
in that worker lane. Root remains sole serialized executor and owns publication.

Restoration32409 reaches natural terminal0:44PASS/0FAIL/44, two files,172.93s.
The exact successful-member-delete and ordinary-return/parameter rows both pass
on the restored callback. Full numeric source remains25132364...8d36. Preserve
removal42/2/44 and its error-fidelity caveat; reporter JSON plus verbose gives
an explicit complete restored result rather than erasing the failed packet.
Root fully reads the incoming-main Astra preservation plan (SHA256
2d7c534c44103c178050a36ff4a4f8a6253ca6feaea742260975ff93d4208a2a).
Checkpoint exact11 owned paths, no temporary removal/scaffolding or peer source;
then merge pinned current dbf5b4 main normally. Numeric must remain byte-identical,
both property-write/whole-shape helpers and all three getter routes retained.
Incoming route-neighbor tests and fresh source-keyed normal providers/originals
must run in the integrated epoch; historical94/44 passes do not transfer.
