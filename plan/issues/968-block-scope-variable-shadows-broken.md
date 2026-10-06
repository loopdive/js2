---
id: 968
title: "Block scope variable shadows broken by #954 dedup locals (25 tests)"
status: in-review
pr: 6540
created: 2026-04-05
updated: 2026-10-06
completed: 2026-04-14
priority: high
feasibility: medium
reasoning_effort: high
goal: maintainability
sprint: 38
required_by: [971]
---
# #968 — Block scope variable dedup merges locals that should stay separate

## Problem

~25 tests fail with assertion errors like `assert.sameValue(x, 'outer')` after #954 dedup locals. The deduplication merges local variables from sibling block scopes that should remain separate.

## Sample files

- test/language/block-scope/leave/verify-context-in-labelled-block.js
- test/language/block-scope/leave/try-block-let-declaration-only-shadows-outer-parameter-value-2.js

## Likely Cause

#954's `deduplicateLocals()` in src/codegen/context/locals.ts merges locals with the same name across different block scopes. But sibling blocks (e.g. `{ let x = 'inner' } { let x = 'outer' }`) need separate locals even though they share a name.

## Acceptance Criteria

- Block-scoped variables in sibling scopes are not merged
- No assertion failures on variable shadow tests

## 2026-10-06 residual: generated capture-cell pointer slots

This reopens a narrow residual, not the historical completion record above.
The original issue was done/completed2026-04-14. That historical completion date
is preserved; the current in-review status applies to this new narrow residual.
The approved Astra plan was read in full before implementation: 236 lines,
SHA256 `3f4084e9bb38240600a4c7b55a4c050a7ea883c7d3a69ea006fa0a70bed1ff25`.
Its retained case14 is the unchanged “nested parameter and block shadows retain
local cells across activations” authored diagnostic from the existing ES2015
standalone function/error/Symbol built-ins task5269. It is not an additional
official Test262 original or a new conformance denominator.

### Mechanism and exact ownership

The two fresh-cell allocation sites in
`src/codegen/closures/arrow-phases.ts::emitClosureConstruction` produced the same
`__boxed_${cap.name}` local name for different same-spelled source bindings.
`allocLocal` correctly appended distinct slots, but `deduplicateLocals` later
merged generated names with identical types. Scope save/restore already retains
the parameter's boxed capture metadata; the emitted pointer-slot collapse is
the narrower defect. Retained candidate/removal case14 bytes were identical and
failed first at `first.parameter()` returning a function rather than undefined;
the later assertions had not executed. That historical artifact is not a fresh
baseline or validation of this fix.

Own worktree: `.codex-worktrees/968-capture-cell-slot-identity-sol61`, branch
`codex/968-capture-cell-slot-identity-sol61`, freshly fetched and independently
remote-verified upstream main `6998bf0b290c065249e01861ffdbec2dd268662a`.
The baseline arrow module is SHA256
`ac821fa9b7098c5ee88502259f44aef7a87c54ed141a86157f92fde33d482260`;
the allocator/deduper is
`8dc360977cba2185c3935a864552986d8bfb3fde95dcf35ec65a53559fe7f04f`.

Production ownership is ONLY the two allocation-name arguments, initially
1281/1316. Each now samples the next absolute local index, immediately before
allocation, as `__boxed_${cap.name}@cell:${fctx.params.length + fctx.locals.length}`.
The `__boxed_` prefix remains for the existing prefix reader; `@cell:` is not
source-spellable in a JavaScript BindingIdentifier. Existing same-binding reuse,
cell types, source-keyed maps, capture metadata, allocator, deduper, rollback,
ABI, schema and other generated-box producers are unchanged.

The Phase A worker independently owns the query/export and capture-hook regions
of the same module and its nested-declaration filter. Do not copy whole files,
remove that worker's edits, or infer release of another hunk. No new source file
or compiler-inventory row is proposed. The original runtime-provider worktree
and its live frozen11778 census stay immutable at their separate d0 epoch.

### Prepared verification, not yet executed

`tests/issue-968-capture-cell-slot-identity.test.ts` contains twelve distinct
authored semantic bodies: unchanged case14; let/let; var/let; sibling shadows;
three nested shadows; loop-head freshness; skipped conditional capture; two
readers of one cell; write-only closure plus reader; null/undefined/false;
ordinary `__boxed_` source prefix; and interleaved activations with exact thrown
identity and order. Each uses the original harness in one explicit noStrict
native-first standalone diagnostic mode, retains all assertions, checks native
binary validity/zero imports and normal WAT emission. This is a diagnostic lane,
not maintained-auto Test262 credit.

Four structural controls exercise the actual production emitter for both
allocation arms and normal dedup/remapping; disposable-temp dedup; shared Instr
single remapping; and snapshot/rollback/reallocation uniqueness. Structural
checks do not substitute for native execution.

- [x] Fresh matching baseline reproduces unchanged case14 first failure.
- [x] Twelve native bodies and four structural controls actually pass; report
  real collected counts and any unrelated inherited failure.
- [x] Existing5323/5356/5320/5303 capture and4302 remap modules pass at actual
  current counts.
- [x] The unchanged36 physical5269 controls are measured, including full Symbol
  original counters/tails and mixed15/16; historical6998 21 PASS/15 FAIL is not
  this task's measured baseline.
- [x] Actual source-name removal returns the slot collapse/old case14 failure;
  restoration returns the repair, with raw binary/source/profile receipts.
- [x] Native inspection shows distinct parameter/block pointer locals and the
  correct undefined/null write destinations; all five case14 assertions pass.
- [x] Normal formatting/type/lint/scoped hooks/proof gates pass without waivers.
- [ ] Composition with Phase A preserves its unchanged normative floor.

Source preparation only is currently admitted. Census and Phase A occupy the
two heavy lanes: builds, native execution, Vitest and typechecking are NOT_RUN
until the root grants a resource slot. No successful verification, publication,
semantic-fix credit or task5269 completion is claimed by this append.

### Private setup checkpoint (2026-10-06, no compiler/native verdict)

Own runtime/store byte preparation completed at
`.tmp/968-owned-byte-copy.UUQOQO/receipt.json`, SHA256
`12198a2cf9c1e2772998b036057ae8e015916e198b0d07fd0e2cf3e06a2690a1`.
All8,615 runtime files and25,853 store files matched source/destination
inventories. Physical private Node24.19.0 is SHA256
`7f9f8346011946e63956e45d1860cc409631802529e8cb18a0c86eed2ff5bf2e`.
Source1847 at this checkpoint includes the two candidate arguments, NOT a clean
6998 baseline. Depth-first ordering yields
`a8bcbdc95c4baa6a5fcb83523f297205c722deba414a481ead0b5e3d7f9b3119`;
globally sorted inventory of identical per-file bytes yields
`342a01fb6bbf552e58d2d5e62087ff0e721f765c2e15cdd4e3471a3871dda75e`.
Observer27519 rejected this ordering mismatch before any installer spawn.
That failure is retained, not a source-change waiver.

Normal offline frozen-lock/copy install child32519 completed0 with825 packages
added/reused, zero downloads and normal local-hook prepare DONE. Observer41685
completed2/HOLD because it required fresh postinstall logs. Its retained
install receipt is SHA256
`e50af8eb5f096c5da6890d286bfa685ab8a24393471501a09cbcb12c5620f76c`.
The copied normal PNPM store contains side-effects artifacts for five previous
native builds; fresh postinstall count is explicitly ZERO, not five executions.

Separate readback84318 completed0, receipt
`.tmp/968-owned-byte-copy.UUQOQO/cache-lifecycle-readback.json`, SHA256
`e7c5efb6c07d3c9664880298e2c3b149aec620b7016ce8c31e976af6aae977e2`.
All41 indexed package files match admitted source lifecycle artifacts and
darwin/arm64/node24 cached integrity, mode and physical private-copy link
count1. Positive owned version probes returned Biome1.9.4, Bun1.3.14,
Deno2.8.1 and esbuild0.25.12/0.28.1. Regenerated executable wrappers retain
no old-worktree absolute paths. Named settings are positively UNSET; pinned
PNPM10.30.2's maintained default enables side-effects caching, whose `isBuilt`
route skips fresh postinstalls. Observer44740's incorrect expectation that
configuration queries return effective defaults is retained separately.
No install retry, rebuild, script-policy override or foreign dependency write
was used for this classification.

Setup source/runtime/config/effective-hooks/primary sentinels are unchanged.
Full graph admission is PENDING. The four structural fixtures call the actual
producer with a minimal context; they do not independently prove executable
dominating/rollback/remap behavior or the required case14 emitted-slot join.
Native, baseline, counterfactual and gate checkboxes remain unexecuted. Root
temporarily reassigned the second heavy slot; compiler/native tests remain
on resource hold while read-only setup classification finishes.

Subsequent independently named full graph observer53195 completed0/EOF:
`.tmp/968-graph-admission.dbgd8x/graph-readback.json`, SHA256
`233cfb458dbc332275040af40490aa6f1a03007e9429fe7f03d7712e67a07b69`.
Actual graph floors are45 roots,996 lock snapshots,825 physical private-copy
packages,171 explained platform omissions,1,636 dependency edges and all eight
Vitest3.2.7 family packages. Wanted/installed locks are byte-identical; all
actual links/store paths resolve inside the own destination graph, with zero
pending builds. The normal ignored build is unchanged `unrs-resolver@1.12.2`.
The observer permits ONLY the exact retained cached-lifecycle discrepancy
identified above and rechecks cache-file/probe/wrapper pins before and after;
it does not rewrite the failed install receipt or retry installation. Source,
runtime, private graph, primary dependencies, hooks and exact common metadata
remain unchanged. This admits setup only, not any compiler/native verdict.

### Fresh matched main baseline

Normal baseline observer54220 completed0/EOF. Full source1847 independently
matches all tracked source blobs on6998; globally sorted digest is
`65d84d5d5e4d37186dba1767ce27e4ee307047328c17f5ec9c97332ac4fc319d`.
Only the two owned allocation arguments were inversed; arrow is exactly
`ac821fa9b7098c5ee88502259f44aef7a87c54ed141a86157f92fde33d482260`.
Fresh normal compiler/runtime bundle builds completed0 before native execution.
The copied unchanged36 packet yielded18 PASS/18 FAIL and36 actual variants,
with no missing body. Case14 reproduces the first assertion failure:
`SameValue(function, undefined)`. Its raw wasm, source map and4.1MB emitted WAT
are retained under `.tmp/968-baseline.9KUKcA/32-primary.*`; baseline receipt
SHA256 is `598bd9170a8d827120028135bb98965f67d6a56e8a2f7eb6abf03b3e86d0eff5`.
All source/corpus/private graph/runtime/hooks/config sentinels are unchanged.

The earlier21 PASS/15 FAIL packet is NOT_MATCHED_SOURCE_EPOCH: it used the
Symbol worker's demand/consumer/key overlay1848/26add5ff, not clean main1847/
65d84d5d. Root independently joined both records: exactly direct-null,
ordinary-binding-reader and template-only changed from overlay PASS to clean
main TypeError FAIL. Their three strict reruns therefore do not execute after
primary failure, explaining39 versus36 actual variants without lost rows.
No resampling or expected-result change is used to force historical agreement.
This native-first diagnostic packet has no authoritative auto/full-census credit.

Preflight33536 failed before any producer because the ignored harness observer
mistook a mount-spelled path for a physical file. It was corrected to inventory
the approved mount's canonical real path; physical guards and the original
failure remain. The approved canonical corpus is b363f29d and all11778 original
bytes match digestab852332, including74 Intl; no corpus data was edited.

The exact two-argument candidate was restored after baseline completion. Normal
formatting changed only the owned new test's layout; its body literals remain
unchanged. Candidate16 and matched36 measurements are pending, not inferred
from the baseline. No fix/completion/publication claim is made at this checkpoint.

### Completed matched candidate/removal/restoration measurements

The earlier pending/setup statements are historical checkpoints, superseded by
the actual settled measurements here. Candidate source1847 is globally sorted
digest342a01fb, arrow85056be1; all other source blobs match6998. Every arm uses
the same private graph, runtime, original harness, unchanged copied36 bodies
and native-first diagnostic options. Before/after sentinels pass in every arm.

Candidate new16 observer79726 completed0/EOF with exactly16 collected PASS:
twelve native bodies plus four structural controls, receipt
`d27c354898cd4d5891e9659f2098beebe610d6e257ef160325301a446d943508`.
Candidate full36 observer1626 completed0/EOF,19 PASS/17 FAIL/36 actual variants,
receipt `256721fcd9f19aada452d1a274fbd2a503655418e9d197e0203b5c3c684130e1`.
Joining all36 rows against the matched18/18 baseline changes ONLY case14 to
PASS. The other35 verdicts and body hashes remain identical; the Symbol target,
mixed15/16 and other native capture debt remain recorded failures.

Removing ONLY the two name arguments restores exact clean6998 source65d84d5d.
Observer27095 completed1/EOF with16 collected,6 PASS/10 FAIL (five native PASS,
seven native FAIL, one structural PASS and three structural FAIL), receipt
`966f52626a6673453c8910640e9213116d46cd84b38fad963e2bc6a27ea2494b`.
The unchanged case14 first assertion returns the old function/undefined failure.
Removed full36 observer27592 completed0/EOF,18 PASS/18 FAIL/36 actual variants,
receipt `ea6c39aae23e62da91d526eebe515a4824b42f1619281feaf53d3fb3092d1c80`.

Restoring the exact two arguments returns85056be1. Observer24169 completed0/EOF,
16/16 PASS, receipt
`deb6801e727e0e8cc4b863eab2a5270936c9a696e4b51c842265cafc402c8b84`.
Restored full36 observer49786 completed0/EOF,19 PASS/17 FAIL/36 actual variants,
receipt `3f2d2ecbf349c6105e2abc3d2ecf616997ef53e4dafd9df2bc3b9e49bb973991`.
All five case14 assertions execute and pass; no oracle or body was weakened.

Read-only actual binary decoder38954 completed0/EOF, receipt
`.tmp/968-native-slot-join.8zm4wx/receipt.json`, SHA256
`7ab74a19e6ef6bd2260347d7152263ffee2d295c3d0f167ea6f86fd93fc01aa3`.
Baseline/removal binaries are byte-identical280e1d7c; both parameter/block
closures capture local$3. Candidate/restored binaries are byte-identicaledd4a2e2;
the parameter captures$3 and the block captures$6, null writes$6 and undefined
writes$3. Both actual closure readers join captured field3 to cell payload
field0. Actual native modules validate, have zero imports and reach native entry.
The normal emitted WAT is retained separately from the raw binary decoding.
Decoder55594 rejected relative receipt paths before decoding; that observational
failure remains retained and was corrected only by supplying required absolute
paths. No compiler edit, alternate engine or oracle change was used.

Structural fixtures remain minimal-context controls, not a separate executable
dominance/rollback/remap proof. All36 are native-first diagnostics, not the
maintained auto runner or authoritative frozen11778 census. The17 remaining
native failures are not fixed by this task, and no task5269 completion or full
census percentage is claimed. Adjacent modules and normal gates remain pending.

Adjacent observer64139 subsequently completed0/EOF with55 collected PASS:
issue5323=6,5356=16,5320=23,5303=2 and4302=8. Receipt
`.tmp/968-tests-restored-adjacent.q2koxr/receipt.json` is SHA256
`f96569bd8b6e0d168641a440857d5fdc9e80bed59cfc488cd03ae19129c2c3e9`.
Full source/runtime/private graph/corpus/hooks/config sentinels remain unchanged.
Normal gates are the remaining publication prerequisite.

Initial normal-gate observer22227 completed1/EOF, receipt
`7ebc6f68a8d8dedd5eb0053e25efaf9b9ce9a8ff15979850823f4caa96c2ee21`.
Whole-tree format, TypeScript7 typecheck, LOC/function/oracle/pushRaw/coercion
ratchets and issue IDs/status/integrity passed. The source remains1459 lines,
under1500; no file or function budget exception is necessary or granted.
Lint correctly rejected the new test's unnecessary array export. Removing only
the export modifier leaves all twelve source bodies and assertions unchanged;
fresh sixteen-test and normal-gate verification follows that edit. The rollback
row failed with MODULE_NOT_FOUND because the ignored observer used the wrong
filename, not because the canonical gate rejected source. The observer now uses
the maintained package command's `check-speculative-rollback-sites.mjs`, and the
failed observation remains retained. No suppression, source ratchet waiver,
shared config change or failed-receipt rewrite is used.

After the test-private modifier correction, observer65242 completed0/EOF with
exactly16 collected PASS, receipt
`900a7c0410ab16c675cacdd51b755e267df2db369a335a61755165fe353a0341`.
Fresh normal-gate observer11500 completed0/EOF with all twelve actual gates
passing: whole-tree lint/format, TypeScript7 typecheck, LOC/function/oracle/
pushRaw/coercion/rollback ratchets, issue IDs, done-status and issue integrity.
Receipt `.tmp/968-normal-gates.2TxJym/receipt.json` is SHA256
`422a71d8774972566db2deb2c921a53e42e927478ed6ea33979be19e61b13024`.
The canonical rollback guard actually executed and passed. Full admitted
source/runtime/private graph/corpus/hooks/config sentinels remained unchanged.
Normal commit/push hooks still run during publication; no skip flags are used.
Authenticated contributor ttraenkler matches the maintained CLA exemption
allowlist; no human acceptance checkbox or signature is fabricated.

### Publication

Normal commit observer18922 completed0/EOF: Thomas-authored and committed
`a1c99454ed226336da7a58cffc7c8b915c83fdbf`, parent6998, exact three owned paths,
Codex coauthor, configured `Model: Codex GPT-6.1 Sol High` and checklist mark.
Normal lint-staged, LOC/function gates, the actually selected changed-root
sixteen-test module and oracle ratchet all passed. Commit receipt is SHA256
`2ee4746a9bb38d5e9001095f76c0b3a725ff5b706ce8c460c3bcc40117260273`.
Normal fork push observer75284 completed0/EOF with actual remote branch
readbacka1c994, receipt
`c6d1ab22e786d2c6658d753a4a6d188d798813e9dd24ff24b69df268c666dd56`.
Its type/lint/changed-format/oracle/coercion/issue guards passed; all18 numeric
local parity tests passed. No hook skip, force push, upstream-tracking stanza
or signing-config override was used. The common config, effective hooks and
full source/runtime/private graph/corpus sentinels remain unchanged; the own
HEAD transition to the three-path commit is explicit, not a source repin.

Upstream PR [6540](https://github.com/loopdive/js2/pull/6540) was opened as a
separate non-draft against canonical loopdive/js2 main using Description/CLA
sections and the normal maintainer exemption. Current CI is a separate live
gate, not inferred green from local results. No GitHub issue was created,
no full-census score is claimed and the17 native diagnostic failures remain.
