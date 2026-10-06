---
id: 6878
title: "Preserve the Boolean result brand of delete expressions at externref boundaries"
status: in-progress
assignee: ttraenkler/codex-6878-delete-result-boolean-sol61
sprint: current
created: 2026-10-06
updated: 2026-10-07
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
