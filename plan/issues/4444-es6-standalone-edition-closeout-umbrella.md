---
id: 4444
title: "UMBRELLA: ES6 (ES2015) standalone close-out → 100% (discovery scope audit open)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-09-20
assignee: codex/es6-test262-closeout
priority: high
horizon: xl
feasibility: hard
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [2860, 2864, 2865, 2867, 2906, 3032, 3178, 2161, 2175, 2158, 2159, 4445, 4446, 4447, 4449, 4450]
---

# #4444 — UMBRELLA: ES6 (ES2015) standalone edition close-out

## Active implementation checkpoint (2026-09-20)

### Later verified publication and local receipts

- Coordinator synchronized to upstream `200f7e2c8bc00dfb9a9c50dcc4b6570413f8a567`
  after handoff PR #5995 merged. Unfinished notes were preserved on fresh branch
  `codex/4444-es2015-followup-20260920`; the merged PR branch is retired.
- Array regression PR #5994 is merged at
  `4c43798b4979c6f5497b8fc1eca996f8c572c942`; tested head `54bffc6d9a` is an
  ancestor and its `object-runtime.ts` contents exactly match that main.
- Raw-object numeric conversion is published as ready PR #5996 at
  `9e7ea9471ae0f0efd22293f09badfe6c1432760e`, with 6/6 focused controls after
  synchronization. The independent fusion-off/SMI defect remains tracked.
- The original `String/raw/returns-abrupt-from-next-key.js` now passes on the
  deletion candidate and fails on untouched `35e040c08e`, using the isolated
  authoritative runner. Its strict-delete and Symbol control failures also
  occur on the baseline; the physical-field throw is still insufficiently
  diagnosed. This is a local gain, not a published or full-suite result.
  The writer reports the repaired focused fixture at 12/12 checks, including
  four expected observations of existing defects, not twelve conformance
  passes. Its helper-presence assertion explicitly does not yet prove a
  particular source allocation reaches the anonymous deletion arm. Retain
  the producer-to-slot audit as a separate gate. The frozen String.raw manifest
  subsequently completed **30 pass / 0 non-pass**, owner session 59030 exited 0;
  the root independently read the terminal log at
  `/private/tmp/js2-5152-string-raw-frozen30-delete-candidate-20260920.log`.
  Manifest SHA-256:
  `d7d2c223fb766dcc9ed460d3c2ddad520195dfc007db6d3c4f575575ba3e3827`.
  This is one local original-row gain over 29/30, pending upstream integration
  and the frozen IR compatibility check, not a fresh edition-wide census.
  The original-row WAT artifact is **filtered diagnostic output**: root found
  only the `__carrier_bag_delete` function definition, not the allocation or
  module-initializer bodies. Its lack of textual imports is not independently
  sufficient to prove the final binary's import list. Preserve the authoritative
  pass, but require an actual binary import receipt and producer-to-slot evidence
  for those separate claims; the writer has been notified.
  **Subsequent receipt closes that gap:**
  `/private/tmp/js2-5152-return-abrupt-full-artifact-candidate-run-20260920.log`
  records successful primary and strict compilation and actual
  `WebAssembly.Module.imports=[]` for both (one retained `$DONOTEVALUATE`
  IR-fallback warning each). Root inspected full strict WAT allocation of
  type 82 into type 83, extraction of raw field 0 into local 28, and its call
  to `__delete_property` (170), which delegates to `__carrier_bag_delete` (169).
  The exact extracted coercion control also fails identically on candidate
  and untouched 35e: function 50, expected i32 / got ref-null 46, offset 55345.
  These are artifact/paired-control receipts, not additional Test262 gains.
- The RegExp selected-result read guard improves the expanded fixture to
  **39 pass / 4 fail / 43**. The exact initialized alias now returns 1 with
  zero imports on the legacy route. Remaining failures are coercion order,
  plural lastIndex descriptors, Reflect.set, and the separate numeric
  lastIndex IR capability assertion. No edition-wide count is inferred.
  Isolated composition with the Number PR's two-file patch remained
  **39 pass / 4 fail / 43** in
  `.tmp/5198/number5996-composition-focused-20260920.log`; it did not resolve
  the order fixture. The earlier dependency hypothesis was incorrect:
  `ORDER_SOURCE` exercises an object asserted as a static string and protocol
  ToString, not Number conversion. Its natural `any` counterpart already passes.
  The follow-up diagnosis inspected initializer/storage/read carrier preservation
  rather than changing the protocol's existing unconditional ToString call.
  The paired asserted/natural receipts now locate that loss: both use legacy
  codegen and zero imports, returning 29 and 123 respectively. Asserted input
  stores a string-converted value in local 3 (ref-null 6); natural input keeps
  its object carrier (ref-null 80). Both subsequently pass local 3 through the
  same raw-argument slot and protocol ToString. Preserve the initializer's
  value until the actual call; converting earlier would change observable order.
- An explicitly configured Terra Max agent owns a separate iterator-prototype
  residual fix under issue 6484, outside IR ownership. Its isolated three-row
  baseline at `4c43798b4979c6f5497b8fc1eca996f8c572c942` reproduced two genuine
  arguments-iterator truncation failures. The third row, typed-array detachment,
  failed because the QuickJS provider was unavailable: it is an infrastructure
  result, not a semantic verdict. The implementation must preserve permanent
  exhaustion and safely handle logical lengths beyond physical argument storage.
  Review of its initial S4 implementation caught cursor advancement after
  indexed Get. ES2015 ArrayIterator `next` steps 11–15 advance before Get;
  the writer corrected that order and is adding an abrupt-getter control.
  A Node 24 reference probe confirmed one getter call and preserved thrown
  identity, followed by `{value:20, done:false}` from the next index. This is
  a reference oracle, not a compiler pass receipt.
  The first candidate run subsequently completed **2 pass / 0 non-pass**,
  exit 0, for exactly the mapped and unmapped truncation originals on the
  4c43798b base plus the S4 working diff. This is the writer's terminal tool
  receipt (16.621 seconds), not a saved log; root independently verified the
  two-row manifest SHA-256
  `aaa46d8aedd23fa924f10387ffc42b99406237d7547c776899da9e8d6387db3f`
  and the pre-Get cursor increment in source. Safety fixtures and regression
  checks remain required before publication. No detachment result or
  edition-wide count is inferred from these two original-row gains.
  The Number-fix agent has moved to read-only work after its
  recorded Sol model identity was discovered; that attribution is retained.

Evidence: `/private/tmp/js2-5152-return-abrupt-{candidate-delete,base}-35e-20260920.log`
and the RegExp worktree's `.tmp/5198/selected-result-readguard-focused-20260920.log`.

**Regression priority:** extending the same pinned-row comparison to all
48,735 standalone rows found five prior passes now failing with
`illegal cast [in __extern_has() ← __extern_has_idx ← __hof_* ← __module_init]`:

- `built-ins/Array/prototype/some/15.4.4.17-8-10.js`
- `built-ins/Array/prototype/forEach/15.4.4.18-8-10.js`
- `built-ins/Array/prototype/map/15.4.4.19-9-3.js`
- `built-ins/Array/prototype/filter/15.4.4.20-10-3.js`
- `built-ins/Array/prototype/every/15.4.4.16-8-10.js`

These are outside the ES2015 selection, so the no-other-ES2015-change statement
below remains true but is **not broad regression clearance**. Comparing the
two recorded compiler SHAs shows only PR #5991's three source files and its
test file changed. That is strong attribution evidence, not a substitute for
isolated reproduction. The String.raw Terra agent is prioritizing a separate
current-main worktree to reproduce and repair these regressions before
resuming anonymous deletion. Preserve the deletion worktree and retain the
two landed String.raw gains. Track the implementation in existing issue #5152.
The five-row acceptance manifest is
`plan/agent-context/5152-array-subclass-regression-paths-20260920.txt`, SHA-256
`ab15801cdd5330ca442019ac142583e98fd22a46e56d537dd11cc4100397c0db`.
All five paths are unique and physically present in the provisioned corpus.
The old pinned rows are 5/5 pass and the new published rows 0/5 pass.
Isolated runner A/B now reproduces that exact delta: Node 24 with
`run-test262-paths.mts <frozen-5> --standalone --isolate` gives **5 pass** on
untouched `4a6cbdf1ee80` and **5 fail** on `35e040c08e`, with the same five
illegal-cast paths. Logs are retained at
`/private/tmp/js2-5152-array-hof-five-base-4a6-20260920.log` and
`/private/tmp/js2-5152-array-hof-five-candidate-35e-20260920.log`.
The bounded repair preserves the existing fnctor prototype-aware candidate
route whenever `fnctorPrototypeGlobalForStruct` supplies that provider;
the new ordinary reader remains for other admitted types. The post-fix
five-row isolated run is now **5/5 pass**, terminal exit 0, recorded in
`/private/tmp/js2-5152-array-hof-five-after-fnctor-proto-guard-20260920.log`.
The frozen String.raw 30-row retention run is terminal: **29 pass / 1 fail**,
retaining the landed gains with only the existing
`built-ins/String/raw/returns-abrupt-from-next-key.js` strict setter failure.
Evidence is `/private/tmp/js2-5152-string-raw-30-after-fnctor-proto-guard-20260920.log`.
This clears the scoped retention check, not broad regression clearance.
The narrow repair is committed as `54bffc6d9afc925846729e7987b56963d0dfc5b7`
after normal pre-commit gates. The normal push is terminal and accepted by the
fork, with TS7, lint, Prettier, oracle/coercion checks, issue integrity, and
18/18 numeric-local controls passing. Ready upstream PR #5994 is open at that
exact head, with passive peer shepherding assigned. No merge is claimed.
The isolated regression
worktree is `codex-5152-array-hof-reader-regression-20260920`, branch
`codex/5152-array-hof-reader-regression-20260920`, based on exact `35e040c08e`.

Row-level follow-up now confirms that aggregate comparison. Downloaded the
standalone report and JSONL from immutable baselines commit
`950cf4b00bf4375742a5b6a6a84a5f39cf46eb7b`, leaving the prior local cache
untouched. JSONL SHA-256:
`d954ebc1c02232e8d99faa2cde1b2b8b6b30f4f9a4a44ebd34b595b1a3a976b1`.
All 48,735 rows are unique, stamped oracle 14 / honest / auto. Selecting
ES2015 by edition name in the current map yields exactly 11,704 rows and
10,371 pass / 1,047 fail / 286 compile errors. Against the prior pinned
JSONL (`bb397c54305afc558b1569c4076260535eaae7c29df63266e55c08ee1a32bdbe`),
exactly two selected statuses changed, both fail to pass:

- `built-ins/String/raw/template-length-throws.js`
- `built-ins/String/raw/nextkey-is-symbol-throws.js`

No other selected ES2015 status changed. This is an immutable published-row
comparison, not a fresh local rerun or a claim about unselected editions.
Downloaded evidence is retained at
`/private/tmp/js2-es2015-baseline-20260920.uTtFjf/`; the producer report names
compiler `d5e58586d1f915908fe4f20cf6c5f21c8d0c2e49` and generation time
`2026-09-19T23:38:17.737Z` (the mirrored aggregate has its own later timestamp).

The newly committed upstream edition report at `35e040c08e` records
**10,371 pass / 1,047 fail / 286 compile errors / 0 skips**, total **11,704**
ES2015 rows. Its paired standalone summary names baseline compiler
`d5e58586d1f915908fe4f20cf6c5f21c8d0c2e49`, oracle 14, generated
`2026-09-19T23:38:37.044Z`. The previous `4a6cbdf1ee80` edition report had
10,369 pass / 1,049 fail / 286 compile errors at the same denominator.
Thus the committed upstream aggregate improved by two passes; **1,333 rows
remain non-passing**. This is a committed report comparison, not a fresh local
full-suite run; the separate row-level receipt above supplies the per-file
comparison. The earlier local cache is retained as the historical comparator.
The discovery/Intl402
scope audit below is still open; 100% is not achieved.

Fresh upstream synchronization found `35e040c08ed10f793faf26bb0f0eac55be662627`.
It contains the String.raw reader fix via merged PR #5991 (`d5e58586d1`),
including both published commits and the frozen acceptance manifest. The
coordinator preserved its handoff notes in `96619182e4`, then merged this base
in `657f99fca3`. Its compiler, tests, and benchmark files exactly match upstream;
only issue notes and acceptance manifests differ. Normal merge hooks passed.
Implementation branches must identify their post-sync test provenance.
The invalid RegExp baseline run has ended with missing-corpus errors. Its
log is retained separately and none of its rows count as test results.
The anonymous-property deletion follow-up is also synchronized to this base.
Its added controls are not yet acceptance evidence: emitted-WAT inspection
showed open-object allocations rather than the intended anonymous closed
structs. Correct the fixture and prove receiver admission before diagnosing
those failures as defects in the new deletion arm.
The revised 12-control run is terminal **6 pass / 6 fail** at
`/private/tmp/js2-5152-anon-delete-revised12-20260920.log`. Two failures concern
WAT local/type-label assumptions, one is a TypeScript PropertyKey diagnostic,
and three concern strict-delete validation, physical-field behavior, and
Symbol-key behavior. Separate instrument corrections from same-source
baseline comparisons; no deletion fix or conformance gain is established.
An independent exact `$Object` numeric-coercion routing investigation is
ownership-cleared with the IR task and remains unshipped. Its exact original
single-function receipt now returns all seven expected bits with fused
ToNumber enabled, retaining a raw `$Object` local and zero imports. The
unfused diagnostic instead reported invalid bytes under Node 22.23.2.
Configured Node 24.19.0 now reproduces it: `directNumberTrace` fails validation
because `any.convert_extern` receives `local.tee` of `(ref null 77)` rather
than externref. The existing SMI-on/fusion-off helper's fixed local 2 is the
static suspect. The exact-source/options Node 24 pairing is now terminal:
untouched `35e040c08e` and the candidate fail identically in function 52 at
offset `+56305`, establishing an independent pre-existing validation defect.
Candidate WAT replaces the original Number call site's incorrect constant
zero with the intended raw-object conversion sequence. Focused Node 24
acceptance now reports **2/2** for default fused/default SMI and **6/6** for
the full matrix with SMI disabled, including unfused semantics and host/WASI
controls. The checked-in fixture must select that workaround only for its
unfused variant and pass unfiltered under the normal test environment before
publication; default fused coverage must remain unchanged. The baseline
SMI-on/fusion-off defect is a separate tracked defect, not conformance credit.
Evidence lives under the Number worktree's
`.tmp/5198/toprimitive-original-after-{fused,unfused}-20260920.log`.
The exact Node 24 engine error is retained in
`.tmp/5198/toprimitive-original-current-unfused-node24-module.log`.
The paired baseline error is
`.tmp/5198/toprimitive-original-base35e-unfused-node24-module.log`.

RegExp broader candidate measurement has completed on the frozen 190-original
manifest: **99 pass / 84 fail / 7 compile errors / 0 skips**. This is a
candidate-only measurement, not a before/after gain: same-base 190-path
comparison is pending. Its runner and manifest receipt are recorded in #5198.
The 30-case focused matrix and original-nine controls below remain separate
denominators; no result is added to the full ES2015 census yet.

The post-sync alias-capacity matrix is now **31 pass / 11 fail / 42** under
Node 24. Its wrapper exit 0 is not test success; the Vitest failure count is
authoritative. Split-assignment search and two-hop match controls pass, while
saved search aliases, raw lastIndex aliases, and existing descriptor/order
controls remain red. A numeric lastIndex operator control stops at an IR
capability disagreement before runtime; that candidate-only receipt has been
handed to the migration owner without edits to IR files. See the RegExp
worktree's `.tmp/5198/alias-capacity-focused-20260920.log` and issue 5198 for
the exact fixture and failure inventory. No new edition-wide gain is claimed.
The IR owner identifies the assertion at the `recvType.kind === "extern"`
property-write arm in `src/ir/from-ast.ts`: lastIndex reaches DOM/extern setter
classification. No known migration fix addresses it. Preserve the assertion
and pair untouched `35e040c08e` against the candidate before assigning cause;
physical externref storage alone does not establish IR extern-class semantics.
The separate saved-search alias hypothesis has now been tested on the exact
initialized/split source in candidate and untouched `35e040c08e`: all four
report `body-shape-rejected` and use legacy AST, not IR. Candidate initialized
returns 0 despite externref slots, while candidate split returns 1; both base
variants return 0. This falsifies an IR-default-hint explanation for these
fixtures and localizes remaining investigation to legacy coercion/boxing
after slot allocation. No IR provider change is authorized by this evidence.
Four `search-alias-route-{candidate,base}-{initialized,split}-20260920.log`
receipts are retained under the RegExp worktree's `.tmp/5198/` directory.

The earlier measurements below used the `4a6cbdf1ee80` base. String.raw was
published as ready upstream PR #5991 at fork head
`e34ebcbb8e1283eddf9f2cc0b91a55eccbbfd97e`, with normal push gates passed and
independent subagent shepherding assigned, and is now landed as noted above.
RegExp remains unpublished and is integrating the upstream reader changes
before its next validation. A third Terra Max lane owns the exact `$Object`
numeric-conversion investigation in a separate worktree.
Neither candidate's changes are counted in the edition census below.
String.raw (#5152) now measures **29 pass / 1 fail / 0 skips** across its
frozen 30-original standalone manifest, including 2/3 originally failing
rows. The remaining strict-rerun failure is reproduced by deleting a
configurable getter and then assigning to the same property. Delete reports
success and the descriptor read reports absence, but assignment throws;
the exact setter/refusal path is being traced before widening source scope.

RegExp (#5198) latest full focused matrix measures **20/30 pass** after the
native public-flags repair (previously 17/30). The actual failure-name diff
shows flags-getter ordering and both large-index advancement controls fixed,
with no newly failing focused case. Its last completed original
nine-row isolated standalone comparison is **0/9** on untouched `4a6cbdf1ee80`
and **9/9** on the candidate-local post-flags run. This is nine verified improvements in that
cohort, not broad regression clearance or an edition-wide census update.
The implemented flags fix replaces generic reads of the internal bitmask with
own-descriptor lookup and public string flags; original-nine rerun is green.
Nominal-object deferred numeric
conversion is a separate diagnosed residual, not justification to discard raw
lastIndex identity. All focused controls and the 190-original cohort remain
in scope. String.raw's final focused fixture is **5/5**; its host deficit
snapshot is not host conformance. A URI-escape regression control remains red
on both candidate and untouched base.

The IR task confirms no active anonymous-expando deletion or nominal-object
ToPrimitive writer. Follow-up investigations/specifications can proceed; new
shared-runtime implementation still requires narrow composition review.
Preserve its existing class-deletion reserve/fill locals and authenticated
retained-marker/count repair. Do not wait for an unclaimed hypothetical fix.

One compiler/test/hook lease is shared between the two writers. Independent
peer review/shepherding is assigned to RegExp; the coordinator reviews and
shepherds String.raw. Next gates include fresh same-base original comparisons,
remaining correctness fixes, broader regressions, and normal-hook checkpoint
publication to fork-headed PRs against `loopdive/js2`. Unmergeable checkpoints
may be draft; completed mergeable fixes must be ready. Neither lane nor the
edition-wide goal is complete. Detailed plans and logs remain in #5152/#5198.

## Resume after upstream sync (2026-09-19, Codex)

The isolated branch `codex/4444-es2015-resume-20260919` was fast-forwarded
from previous coordinator commit `ea411aa801c43b6659d1c9d8587a2e881fde75bb`
to verified `loopdive/js2` main
`4a6cbdf1ee80b5d1618a7c87b014bc792f0fddc7`. The shared root checkout and
older dirty worktrees, including their uncommitted handoff records, remain
untouched. No reset, stash, or source-patch reapplication was performed.

The committed standalone report now records oracle version **14** and compiler
baseline `a3943f63e07d6d572e3a5f7a66439c32ed518754`, generated
`2026-09-19T19:45:39.783Z`. Its whole-suite totals are not an ES2015 result.
The version-13 ES2015 figures below are historical, not current-main evidence.

Fresh row reconciliation on 2026-09-19: **10,369 pass / 1,049 fail / 286
compile errors**, exactly **11,704 unique ES2015-selected rows**, zero selected
timeouts or skips. The edition map still labels 11,778 paths ES2015; all 74
absent paths are under `intl402/`, so that scope question remains unresolved.
All matched rows are official, `honest`, providers `auto`, oracle 14.
Downloaded JSONL SHA-256
`bb397c54305afc558b1569c4076260535eaae7c29df63266e55c08ee1a32bdbe`
is byte-identical to the file at immutable baselines commit
`6c51eb29ef12208ac8f53ae99eea900b53f51a76` (48,735 unique physical rows).
That commit's matching metadata reports compiler
`a3943f63e07d6d572e3a5f7a66439c32ed518754`, generated
`2026-09-19T19:45:22.353Z`, standalone/auto/official scope. The repository's
new `test262-baseline-pair.json` producer receipt is absent at that baseline
commit: this is a pinned observational census, not a claim of successful
producer-artifact admission or candidate regression-gate equivalence.

RegExp pre-dispatch reconciliation found preserved, unreviewed work on upstream
`claude/es6-5198-regexp-exec-protocol`, exact head
`3b41aeec2824dc51309658fbd0e6a966b8d3761d`, documented in the Sep18 handoff.
Do not recreate it. Its outstanding observable coercion/Get(exec) ordering and
acceptance gaps need review before adoption. Open #5393 remains a separate
tests-only custom-exec checkpoint; #5748 also lists `regexp-standalone.ts`,
so its overlap has been raised with the IR owner before production edits.
The IR owner subsequently confirmed the exact #5748 overlap consists only of
two `{ kind: "i32", boolean: true }` result annotations in
`tryCompileStandaloneRegExpTest`. Preserve those during integration; the rest
of RegExp protocol implementation is unclaimed by that task. Shared generator,
closure, class/provenance, Promise/vector, and layout/lifetime owners remain
reserved. Independent Terra Max review of recovered `3b41aeec28` identified
five protocol blockers, recorded with the correction contract in #5198.
The verified `5198:exec-protocol-recovery` claim now belongs to
`ttraenkler/codex-5198-protocol-recovery`; a separate Terra Max writer has
imported the candidate in its own current-main worktree and is correcting it.
Untouched-main portable controls completed at 6 pass / 3 fail; the imported
candidate completed at 5 pass / 4 fail, exposing coercion ordering and
receiver-replay defects. These are failing regression evidence, not gains.
The independent reviewer remains assigned to final review and PR shepherding.
The old `5198:exec-lastindex-identity` claim still belongs to this task's
`ttraenkler/regexp-residual-20260913` lane; it was not stolen or released.

Independent next-slice triage against the same pinned rows: all **22/22**
ES2015 paths under `MapIteratorPrototype` and `SetIteratorPrototype` already
pass. The Sep18 ranking's ten failing `next` rows must not be redispatched.
The two remaining WeakMap `iterator-item-{first,second}-entry-returns-abrupt`
failures are already documented in #5267 as the module-scope array identity /
accessor-overlay defect, not evidence of a new isolated WeakMap constructor
bug. Their originals return the same accessor-bearing array through an
iterator result, require the original getter error, and require IteratorClose
exactly once. No new claim, implementation, or test run was started for them;
coordinate representation/vector ownership before revisiting that mechanism.
The three `String.raw` failures also remain in the fresh rows and match
existing #5152 Step F. A fresh open-PR gate found both #5748 and #5736 touch
`expressions/call-builtin-static.ts`, its documented materialization site.
No independent writer was dispatched into that overlap. The reserved parent
#5152 has no live claim, but an empty claim alone does not override open-PR
ownership or prove the source is free.

Exact-hunk follow-up found #5748's Boolean annotations and #5736's removed
generator special case do not modify the String.raw arm. A separate Terra Max
read-only audit is now checking the three originals and a bounded correction
plan in its own worktree, as recorded in #5152. The IR owner acknowledged no
conflicting String.raw implementation claim, while retaining literals/runtime
ownership. No String.raw source edits or compiler jobs are authorized yet.

Subsequent audit/release: a separate Terra writer now owns the verified
`5152:closed-struct-raw-readers` slice in its isolated worktree after IR cleared
the two object-runtime reader functions and enumeration helper. The first
safe candidate improves two portable assertions (Symbol boxing and getter
receiver), but is not green. A proposed static-accessor dispatch was removed
after independent review proved it lacked per-instance/temporal presence;
the remaining definition-site dependency is recorded in #5152. Exact original
row checks are pending. RegExp protocol work separately expanded, after exact
IR/open-PR coordination, to runtime lastIndex writability and descriptor
routes; #5198 records the ABI impact and initialization-order design. Neither
lane is a completed fix or a published PR at this checkpoint.

Implementation plan before dispatching another fix:

1. Acquire and pin current standalone row data and matching metadata; derive
   the maintained-runner ES2015 selection and reconcile missing/duplicate rows.
   Keep the unresolved Intl402 scope question explicit.
2. Reconcile previously published fixes and remaining issues against this
   upstream commit, open PRs, and active claims; do not replay frozen patches
   or dispatch work solely from stale issue status.
3. Coordinate with the IR task before shared-source implementation. Its latest
   retained work includes #5753 capture/class/generator repairs and #5883
   vector/Promise integration; an interrupted task is not a released claim.
4. Record a concrete per-fix plan here or in the owning issue, then implement
   in an isolated worktree, verify original tests plus controls, and publish a
   scoped upstream PR with a separate shepherd.

## Active continuation (2026-09-13, Codex)

### Cross-session ownership

The user explicitly identified a parallel IR-migration session. The ES2015
team has sent that session its exact source paths and requested current
ownership and landing order. Until the shared seams are agreed, hold new
overlapping compiler/IR edits and merges; preserve existing work and allow
already-running tests and hooks to finish. Validation of frozen conformance
source and issue/test documentation can continue.

The app task titled `IR migration` replied that it is inactive after handoff,
with no current writers or reservations in these conformance paths. Its old
worktree and staged merge must remain untouched; the landed extraction
supersedes that old state. The active successor has not yet been identified.
The user was asked for its task/worktree, and overlapping new implementation
remains held rather than assuming that the inactive task speaks for it.

Proposed boundary, pending acknowledgment: migration retains program
preparation, native body extraction, and migration receipts; this team owns
scoped generator, Promise, and RegExp conformance behavior and regression
pins. Shared context/declarations/index/literal-allocation edits require
explicit coordination. In particular, do not start the queued true-realm IR
implementation independently of that session, duplicate its extraction, or
weaken its checks. The Promise successor preserves the landed legacy
combinator adapter exactly and passes the current forward-preservation oracle.

### Measured state and active slices

The latest verified canonical record for the current runner discovery is the
standalone baseline for
`6aac84c0b6ef418bbfa6a97cceca25960db7a3f6`: **10,294 pass, 1,116 fail,
293 compile errors, and one compile timeout**, exactly **11,704**
current-runner-selected ES2015 rows. This measured cohort has **1,410 non-pass rows**, not
zero; the separate Intl402 discovery/scope question below is still unresolved.

The fresh download is pinned to baselines-repository commit
`357f932973bfa09c31b09b0ed750c98e621c29d3`; its Git blob
`277c7454dbe7c7dcf7bf12ac547b14e31aee826a` matches the downloaded bytes.
The JSONL SHA-256 is
`728d1aebe31b432ffa208da78dd6113c735182d92aec5576fa04f6512e627e3f`.
Metadata from that same pinned commit records generation at
`2026-09-13T03:29:24.408Z`, target `standalone`, official scope with proposals
disabled, and oracle version 13. Every selected row is `honest` with semantic
providers `auto`. The 48,735 physical rows contain exactly 11,704 selected
rows and 11,704 unique selected paths; there are no missing selected-manifest
paths.

### Discovery-scope audit: Intl402 is unmeasured

The current edition map has **11,778 ES2015-labelled paths**, not 11,704.
All **74 additional paths** are real files under `intl402/` in the pinned
Test262 checkout; they are neither stale entries nor missing files. They are
absent from the baseline because `tests/test262-runner.ts` does not include
`intl402` in `TEST_CATEGORIES`. Its separate `classifyTestScope` function
would classify these non-proposal files as `standard`, `official: true`.
Examples include `intl402/Collator/proto-from-ctor-realm.js`,
`intl402/DisplayNames/ctor-custom-prototype.js`, and
`intl402/TypedArray/prototype/toLocaleString/calls-toLocaleString-number-elements.js`.

No current authoritative ECMA-402 exclusion policy was found in the bounded
repository review. `plan/goals/full-conformance.md` explicitly leaves Intl
conditional on scope; historical exclusion from an ES5 landing census is not
a project-wide scope decision. ECMA-402 may be a separate-standard exclusion,
but discovery omission alone does not prove that policy. The user has been
asked whether the 100% target includes these Intl402 tests or ECMA-262 only.
Until that is resolved, label 11,704 as the **current maintained-runner-selected
ES2015 cohort**, not all edition-map-labelled or all official Test262 coverage.
The 74 additional tests are **unmeasured**, not passing or failing. Do not
silently shrink the denominator or certify the full goal from this cohort
alone. If Intl402 is included, correct discovery and obtain verdicts for the
full required selection rather than assigning results from metadata.

### Comparison and active implementation slices

The previous complete `e0023dbbe6c37e15c1f56ed0c8bc8d15d0afbac3` record
(`07c89a5c2626f3312ff611f008a69ed6d8826e9802da024df39726ddabc1e9ba`)
had 10,255 pass, 1,104 fail, 344 compile errors, and one compile timeout.
An exact pass-set comparison finds **39 gained passes and zero lost passes**.
The gains include the sticky-match original and generator-method tests; these
are baseline differences, not attribution of every change to a single PR.
Earlier, that previous record gained 63 and lost 38 versus September 12
(net +25); retain the distinction between the two comparisons.

The ongoing local census
`test262-standalone-results-20260913-010438.jsonl` remains live and partial on
its frozen older source. Do not replace the canonical denominator or infer
the current integrated pass rate from it. Preserve the running process; it
must not be killed without the user's permission.

Implementation ownership remains partitioned into three isolated Terra Max
worktrees, with peer PR shepherding. Compiler-heavy validation and git hooks
share one team lease alongside the census; no active tests may be killed
without user permission.

- **Generator method regression:** upstream PR #5874 merged as
  `85496937328e9b5d7477946b64fcf213920ad554`. Its four changed files match
  the tested head `5322242ffcdc7d40005925c0955f32060538aaf4` exactly. The
  previously passing floor measured 37/37 and protocol controls 44/44.
  This does not close generator issue 5199: `default-proto.js` remains a
  separate measured regression. The successor's unchanged `default-proto.js`
  and `prototype-value.js` now pass 2/2. Allocation-time prototype-source
  promotion fixes the closed-literal prototype boundary: runtime controls
  now pass 8/8 and selector guards 2/2, including identity and inherited
  property liveness. An additional immediate-read diagnostic still fails
  (30/31 bits): the replacement uses externref while the saved immediate
  getter result has a concrete struct slot and is cast to null. This remains
  a documented blocker; no successor PR or clean diagnostic is claimed.
  Shared source changes are held for migration-owner coordination.
- **Sticky RegExp matching:** upstream PR #5878 merged as
  `302f341bc24a8eeaa216805b536e42292ed0d994`, an ancestor of the new
  baseline compiler commit. All five changed files match tested head
  `9e8203925cc6fa9a352d6a3b2a768297575850b3` exactly. One original failure
  and ten positive controls passed in each lane, plus 3/3 focused pins. The
  fresh complete baseline also records the sticky original as passing.
  Raw lastIndex identity and conditional descriptor state remain unfinished
  in issue 5198. The raw-slot successor's isolated selector tests pass 6/6;
  two runtime tests were excluded by the name filter, so this is not runtime
  integration evidence. A new unsuppressed negative proves a receiver
  redeclaration can invalidate its native-receiver assumption (one selected
  failure, expected false but received true). A new direct contextual checker
  call also needs an oracle-based replacement. Both corrections and allocation
  integration remain unimplemented under the shared-source ownership hold.
- **Observable Promise combinators:** issue 5197 checkpoint `6e684e2950`
  records 13/13 focused pins and the original `all/invoke-resolve.js` plus
  its positive control passing 2/2 before integration. Integration with
  captured upstream `7adc0a6e897556cee50a7024d24a47a0fb1c8052` exposed a
  source-declaration ledger conflict. Observable helpers now live in a
  dedicated module, preserving the landed legacy adapter byte-for-byte and
  passing the current source-preservation verifier. Integrated compiler bundle
  `ee8a61289b2547f6` with rebuilt QuickJS adapter `ade903d7c361865e` passes
  the focused suite 13/13 and unchanged original/control pair 2/2; canonical
  TS7 also passes. Ready upstream PR #5883 publishes integrated head
  `df94fdac9b9a43b579975ee7e57506aecd272809`. Mandatory merge hooks passed
  all 12 changed-root suites; pre-push checks passed, including numeric-local
  18/18 and issue integrity. The frozen fix is complete, but issue 5197's
  remaining protocol work and the full-suite goal remain open.
- **Non-overlapping early-error work:** issue 3444 now has a source-current
  implementation plan for `language/global-code/new.target-arrow.js`, which
  still fails in the fresh baseline. A global arrow does not establish its
  own NewTarget environment. The claimed `3444:newtarget-arrow` slice starts
  at verified upstream `3e92241ecc3ee81df38df29cdd228537364bd19b` in an
  isolated Terra Max worktree. The parent/slice claim check and complete
  issue-file PR scan were clear. A separate source-path scan of all 25 open
  PRs, including all 213 files in #5753 and 238 files in #5798, found no edits
  to its two proposed early-error source files. Only
  `src/compiler/early-errors/predicates.ts`, `node-checks.ts`, a dedicated
  test, and issue 3444 are assigned. Do not modify generic function-scope
  predicates or broaden into the held IR/codegen seams. The author now reports
  23/23 expanded focused controls and the unchanged maintained original/control
  pair passing 2/2, following a starting 1/2 pair and an initial 18-case matrix
  with 8 failures and 10 passes.
  This is candidate evidence, not a promoted full-suite gain. A broader
  neighboring test reports a runtime import LinkError. The exact four-test
  issue-189 suite was rerun on untouched starting head and candidate with the
  same environment: both return one failure, three passes, and the identical
  `__get_undefined` LinkError. This narrow baseline-identical failure is not
  presented as a green suite. TS7 also passes after the final test additions;
  remaining hooks are pending. Peer review's five requested
  accessor/static-field controls are included in the expanded 23-case run.
  No completed PR is claimed for this slice. A separate peer shepherd is
  assigned for its eventual tested head.
- **Next substrate work:** issue 4274 now has a refreshed realm implementation
  plan, exact manifests, and negative provenance controls. It remains queued
  until a worker is available and ownership is rechecked; no source changes
  or full-cohort improvement are claimed.

Continue toward the full 100% goal. Passing all currently selected 11,704 rows
is necessary, but must not become a completion claim while the Intl402 scope
audit remains unresolved. Keep one upstream PR per completed fix, update each
issue with measured evidence and remaining work, and do not turn these
checkpoints into issue-completion claims.

## Resume checkpoint (2026-09-12, Codex)

The authoritative standalone baseline was force-refetched after synchronising
with `loopdive/js2:main` at `d4108568d43f14c361ecc3a58c82633027eaae39`.
The JSONL has **48,735 physical rows** and the checked-in edition map selects
exactly **11,704 unique official ES2015 paths** (edition index 4). It reports:

- **10,230 pass / 11,704 total (87.4%)**;
- **1,144 fail, 329 compile errors, 1 compile timeout, 0 skips**;
- oracle version 13, lane `honest`, semantic providers `auto`;
- compiler baseline SHA `52d1bb7809de26f5c12fca1f887fe7be78f4479c`,
  which is an ancestor of current main by three non-compiler commits;
- JSONL SHA-256
  `45ff56e7570bba0a1bff6590d19d35de2525928adb7e3054789ba35aebb29360`.

This is complete dispatch evidence, not completion evidence: the acceptance bar
remains a maintained-runner execution on the final integrated head with exactly
**11,704 pass and zero rows in every other verdict**.

Draft PR #5736 preserves three 2026-09-08 increments but deliberately combines
two completed-looking fixes with unfinished generator work. It is 202 mainline
commits behind its two unique commits and must stay draft while mixed and
unverified on current main. The latest baseline proves all eleven claimed
completed-row gains are still absent from main: seven `super` rows owned by
#5350 and four inherited TypedArray-constructor rows owned by #5317 remain
`fail` with their pre-fix signatures.

### Implementation plan

1. **#5350 — class prototype writes and bounded missing-super bodies.** Extract
   only commit `357b05f68c8c76b8c4888690941edf9d247243ab` onto a fresh
   current-main worktree, resolve against current class changes without
   broadening its semantic whitelist, and rerun the exact 58-row super cohort,
   41 focused pins, class/capture neighbours, and host/WASI parity controls.
   Require the seven still-failing rows to pass with zero lost rows. Update the
   issue handoff and open one ready, non-draft PR only after that proof.
2. **#5317 — inherited TypedArray constructor Get.** Extract only the three
   TypedArray source changes and their focused test from the second checkpoint
   commit. Preserve actual getter results and receiver identity; default
   constructor selection remains in SpeciesConstructor. Rerun the exact 55-row
   cohort and 15 focused/neighbor pins, requiring the four current failures to
   pass with zero losses. Update the issue handoff and open a separate ready,
   non-draft PR.
3. **#5199 — generic generator protocol.** Continue separately from current
   main. The 2026-09-08 bridge checkpoint is WIP: 4/9 bridge fixtures pass and
   numeric next/return payload preservation is unresolved. Rebuild compiler and
   QuickJS artifacts, strengthen the extracted-method positive control, then
   rerun the 27 pins, bridge/prototype fixtures, 44 protocol rows, and the full
   2,486-row ES2015 generator feature cohort. Keep its PR draft unless every
   owned acceptance check is current and mergeable.
4. Run all implementation lanes in separate worktrees with Terra at maximum
   reasoning. A separate shepherd owns body-template, exact-head, mergeability,
   CI, regression, ready-state, and queue verification for every resulting PR.
5. After each fix lands, force-refetch the baseline and set-diff every passing
   row. Recluster the remaining complete 11,704-row record, update or allocate
   one repository-local markdown issue per unowned mechanism, and repeat. Do
   not create GitHub issues; #5091 and #5099 already exist as completed records
   under `plan/issues/`.

## Handover (2026-09-06, session claude/es6-test262-standalone-g10c7u, wave 5)

ES2015 standalone stood at **10,188 / 11,704 (87.0 %)** after wave 4 (#5604)
landed on 2026-09-05. Wave 5 ran six lanes from Fable-written plans (Opus
medium, Opus high for the Proxy lane, Sonnet high for the mechanical lib.dom
fix), each followed by an adversarial review (one reviewer, two skeptics per
finding) and as many reviewed fix rounds as the reviewer kept finding real
defects. PR-1 integrated five lanes; #5349 (species / byte-vec brand) shipped
as PR-2 after two more reviewed rounds.

### Wave-5 close (2026-09-07)

Three PRs landed, all through the merge queue:

| PR | content | merged (UTC) | promoted standalone baseline |
| --- | --- | --- | --- |
| #5688 | the five PR-1 lanes | 2026-09-06 20:21 | ES2015 **10,219 / 11,704 (87.3 %)**; whole corpus +46 / −2 vs the pre-merge baseline |
| #5694 | #5349 species r5, rounds 1–5 | 2026-09-07 03:14 | ES2015 **10,228 / 11,704 (87.4 %)**; whole corpus +21 / 0 (11 `Array`, 9 `ArrayBuffer`, 1 `TypedArrayConstructors`) |
| #5696 | #5316 r6 — the 2-row Annex B regression #5688 introduced | 2026-09-07 03:57 | the two rows promote with the next baseline (not yet in the 04:10 fetch) |

The −2 of #5688 was found by set-diffing the promoted baseline against the
previous copy, not by any gate: `Object.prototype.__defineGetter__` /
`__defineSetter__` on an EXISTING key of a non-extensible literal or class
instance threw, because #5316's integrity bag now records
`preventExtensions` on those carriers and `__defineProperty_accessor` judged
"new key" from the bag, which cannot see a struct field. Fixed in the accessor
arm with the own-only `__hasOwnProperty` guard (2,054-row control, 0 lost);
the data arm's twin guard was measured and reverted because it silenced the
correct frozen-object throw.

#5349 needed rounds 4 and 5 after the round-3 audit: round 4 kept a
packed-byte receiver's TypedArray brand through `ab.slice` when reached via an
ArrayBuffer-typed binding and recognised the intrinsic `%ArrayBuffer%` as the
species by identity; round 5 hoisted the species ladder's two null
initialisers out of the `if (isPacked == 0)` gate, because a brand-gated
slice site executed twice reused the first execution's species buffer (trap
when longer, silent cross-object corruption otherwise). Full records: the
issue file's "### Round 4" / "### Round 5"; 85 pins, every round-5 pin
executes its site at least twice.

**Follow-ups this close leaves, in priority order.**

1. **wasi own-key ladder for closed-struct carriers.** On `--target wasi`
   `__hasOwnProperty` answers false for a struct-field key (and
   `Object.prototype.hasOwnProperty.call({existing:null}, 'existing')` traps),
   so the #5316 r6 guard is emitted but inert there and the four PR-1-regressed
   wasi shapes keep main's answer. No test262 row is at stake; recorded in
   #5316's r6 residuals with the probe set.
2. **`class B extends ArrayBuffer {}` as the species TRAPs** (node 4) — the
   `IsConstructor` family cannot answer intrinsic identity for a subclass;
   needs ArrayBuffer subclassing. Recorded in #5349 round 4/5 residuals.
3. **`Reflect.defineProperty` of an accessor** over an existing key is a silent
   no-op, over a NEW key of a non-extensible object traps instead of answering
   `false` (the §10.1.6.3 throw is right; the `Reflect` wrapper's catch is
   missing).
4. **#5359** — spreading a packed-byte TypedArray emits invalid wasm.
5. The **Temporal host-flake cluster**: the rebuilt merge group of #5696 was
   parked on 28 `built-ins/Temporal/*` host rows that flip run-to-run (the
   same content passed the gate one run earlier with 10 different Temporal
   flips; a local A/B on 26 of them answers identically on the PR head and on
   main). If the cluster recurs, the gate's own text prescribes a
   `scripts/test262-host-noise-quarantine.json` entry citing both runs.

**Lessons this close added.**

- **Execute a site twice on different arms.** Every round-1…4 pin of #5349 ran
  its slice site once, so a stale Wasm local was invisible until the round-4
  reviewer looped it. A gate placed around an emitter that RETURNS a local to
  its caller must keep that local's initialisation outside the gate.
- **Set-diff the promoted baseline after every merge.** The merge-group
  regression gate scores the host target and the standalone guards score the
  aggregate; a 2-row standalone loss behind a +46 gain passed every one of
  them. The whole-corpus diff of the two baseline copies took one minute and
  found it.
- **A push to main rebuilds the queue group.** The benchmark-artifact refresh
  that follows every merge rebuilt #5696's group and re-rolled the Temporal
  host bucket into a park. Read the cited run before touching the label: the
  first group's log, the changed-path count and a local A/B settle it.
- **`git archive` + bundles is the only base tree that measures.** Both
  post-merge findings were attributed only after re-running the rows on an
  archive of the exact main commit with its own compiler bundle and quickjs
  adapter; a lane snapshot or a stale checkout would have blamed the wrong
  change.

| lane | shipped | owned rows (base → lane) | control | review rounds |
| --- | --- | --- | --- | --- |
| #5316 Proxy r5 (Opus high) | integrity bag learns the instance carrier; gopd fold asks the native on a guard miss; `in` stops folding over a Proxy; §10.5 clauses restored; false PreventExtensions/SetPrototypeOf status; `Reflect.set` with receiver (§10.1.9.2), receiver-Proxy define route, target-Proxy set trap with receiver, non-Object TypeError | +16 (Proxy+Reflect 350 → 366) +1 (integrity) | 464 + 317 rows, 0 lost | review → fix round → clean |
| #5350 super property r1 | class [[HomeObject]] read, base-before-key element read, `extends null` TypeError, uninitialised-`this` guard (lexical + runtime flag), object-literal `super.m()` incl. accessor bodies, `__proto__:` literal links its prototype, callable check | +8 on the 53-row super control (18 → 26; 2 of them main drift), 6 / 13 target rows | 53 rows, 0 lost; 1,089-row class/super control run on the integrated tree (see PR) | review + 5 fix rounds (rounds 3–5 on the loop guard; round 5 by Fable) |
| #5318 class r4 round 2 | tri-state static-accessor gate with a hardened syntactic walker; object-literal evaluated-key accessors; later same-key members DEFINE; host `__proto__:` after a dynamic accessor; spread after a same-key accessor copies via define | +2 (`computed-property-names/object/accessor/{getter,setter}`) | 61 rows identical; 783-row class sweep 0 lost | review + 3 fix rounds |
| #3371 Reflect.construct r2 | nested-function `new.target` stop, symbol-resolved binding count, dynamic in-file targets gated on their whole value set, JSDoc/annotation refusals, `neverConstructed` for named function expressions, destructuring-assignment writes | +10 (218-row control 156 → 166); fix rounds 0 net, ~14 wrong-answer admissions turned back into refusals | 218 + 24 rows, 0 lost; 89-file probe corpus 0 base drift | review + 3 fix rounds |
| #5351 lib.dom shadow (Sonnet high) | a user top-level binding excludes the same-named lib.dom ambient from the import set, scoped per source file | +6 (24 leak rows: 24/24 import-free, 6 pass, 18 now fail on unrelated gaps) | 40-name sweep, 24 rows, byte identity | review → fix round (multi-file scoping) → clean |
| #5349 species r5 (PR-2) | Array ctor null TypeError, defineProperty arming, `ArrayBuffer.prototype.slice` SpeciesConstructor; round 2 brands `$__vec_i8_byte` (`final`) vs the open `$__vec_i32_byte` so step 16 discriminates; round 3 audits every cast/test site that relied on the old identity | +19 measured on the lane (57-row target set 6 → 25), 3,147-row TA/AB/DV control 0 lost on round 2 | in round 3 (Opus high) | review + 2 fix rounds so far |

Expected ES2015 delta from PR-1: roughly +43 owned rows plus collateral; take
the real figure from the promoted baseline. Every number above was measured
with `scripts/run-test262-paths.mts --isolate --standalone` against a
`git archive` base tree with its own compiler bundle and quickjs adapter.

**Residuals carried forward, each with its mechanism in the issue file.**
#5350: a `super.x` read that is genuinely reached before a nested function's
`super()` answers a value instead of throwing (only a flag the nested function
could store would decide it; the r4/r5 records explain why the
never-invent-a-throw direction was chosen); reads inside an arrow inside a
loop (xa8); `super.missing?.()`; `Math.max` as a super member; the 7 rows
blocked by the block-scoped-class captured-`var` write defect. #5318: standalone
`__proto__:` after a dynamic accessor (1010 on every tree); `u: undefined`
member after an accessor traps on every tree. #3371: three conservative
refusals of shapes base also refused (g1h/g2h/g2i); `let T = (function(){…})`
answers 4 on base too; x1/x2 plain-`new` new.target misreads. #5316: the
TypedArray integer-index arm for `Reflect.set` (six rows), `with(proxy)`
re-entrancy (2 rows), `instanceof` fold. #5351: hoisted `var` in a top-level
block / destructuring still leaks (pre-existing). New issues filed: #5359
(for-in + spread over a TypedArray emits invalid wasm).

**Next, in order.** (1) Land PR-2 (#5349 round 3) — the brand split is
architecturally right and unblocks `ArrayBuffer.isView` /
`Object.prototype.toString` precision, but every `ref.cast`/`ref.test` on the
two byte vecs must dispatch on both types; its 3,147-row control is the gate.
(2) #5350's block-scoped-class captured-`var` defect (7 target rows) and the
`u8.buffer` snapshot-copy family found by the #5349 probes (t1/t2/t11/t17). (3)
The TypedArray cluster (187 non-pass rows) once #5349 lands. The sibling
issues #2864 / #2867 / #2175 stay with the other team.

**Lessons this wave added** (the wave-4 list below still holds):

- **Static predicates over dynamic facts converge only by review.** #3371 took
  three rounds and #5350 five because each rule admitted a shape the previous
  reviewer had not probed; each round's reviewer found the next hole in under an
  hour. Budget the review loop, not the first implementation.
- **A representation identity is load-bearing wherever a `ref.cast` never
  trapped.** Splitting `$__vec_i8_byte` from `$__vec_i32_byte` (#5349 round 2)
  was one line and correct, and it exposed three emitters that cast a typed
  array to a buffer "because it always worked". Grep every cast site before
  changing a canonical type, not after the review.
- **Compare a fix tree against the tree it was cut from, never against the
  lane snapshot.** Integration-branch drift (a new import, a new module)
  produces false host-byte positives; two reviewers lost time to it.
- **Host-target probes need `importObject.__setInstance(instance)`.** Without
  it the open-object model is dead and every host answer is wrong on base too;
  one review round's host findings were re-measured after this was found.
- **A finisher agent beats a rerun after a container restart.** Fix commits
  survive; a finisher prompt that names them, resumes the chunked driver (skip
  `.done`, delete the partial chunk) and writes the record saved ~5 h of
  control runs.

## Handover (2026-09-05, session claude/es6-test262-standalone-g10c7u, wave 4)

ES2015 standalone stood at **10,131 / 11,704 (86.6 %)** after #5576 landed
(2026-09-04). Wave 4 ran four Opus-medium lanes from Fable-written r4 plans,
each followed by an adversarial review (one reviewer, two skeptics per finding)
and a reviewed fix round; this PR integrates all four:

| lane | shipped | owned rows (base → lane) | control | review outcome |
| --- | --- | --- | --- | --- |
| #5317 TypedArray | `join` separator arming, `fill`/`copyWithin` end argument | +11 | 259 rows, 0 lost | one inert-fix finding, fixed and re-reviewed |
| #5316 Proxy | §10.5 descriptor-model invariants (step 1) | +19 (0 → 19) | 464 rows, 348 vs 312, 0 lost | wasi false positives → wasi gate, re-reviewed clean |
| #5318 class | computed accessor names, §15.7.14 sidecar order, compiled-body receiver gate | +24 | 783 rows, 246 non-pass vs 271, 0 lost | order + trap fixed; one over-decline left for round 2 (recorded in the issue) |
| #3371 Reflect.construct | runtime `Get(NT,"prototype")`, bound-function `[[Construct]]`, ordinary-construct driver, refusal gate | +11 (+9 collateral in `Function/prototype/bind`) | 218 rows, 166 vs 156, 0 lost | five refusal→wrong-answer findings, all closed by restoring base's refusal |

Expected ES2015 delta on the merge-group report: roughly +65 owned rows plus
collateral; take the real figure from the promoted baseline, not from this
table. Every lane's numbers were measured with
`scripts/run-test262-paths.mts --isolate --standalone` against a
`git archive` base tree, never inferred.

**Next, in order.** (1) #5316 item 1 — the standalone attribute model through a
proxy dispatch — unblocks the most rows per fix (gopd rows, the declined
`IsExtensible` clause, and step 2's `Reflect.set` receiver). (2) #5318 round 2
(nested-class static accessors, plan in the issue) and its dstr slice (16 rows).
(3) #3371 r1 residuals — the 12 rows each need a named mechanism the issue
lists; `new.target` as a runtime value (2 rows) is the largest. (4) #5317's
163 residual rows by family, 14 of them gated on builtin-method reflection
(#2175, other team). The three sibling issues #2864 / #2867 / #2175 stay with
the other team.

**Lessons this wave added** (the 2026-09-04 list below still holds):

- **A container restart kills every running Workflow agent and leaves its
  journal without a result.** Worktrees, commits and the pushed branch survive;
  relaunch with `Workflow({scriptPath, resumeFromRunId})` — an empty journal
  simply re-runs the agent. Two agents were lost this way on 2026-09-05.
- **The quickjs eval adapter is keyed on the compiler-bundle hash.** Rebuild
  `scripts/build-quickjs-eval-provider.mjs` AFTER the last `src/` edit, or
  every runtime-eval row fails with "provider is not built" and reads as a
  regression. Two lanes lost a measurement cycle to this independently.
- **Under load ≥ 6 on this 4-core box, rows time out at compile** (the pool's
  15 s budget), and a control corpus reports phantom losses. Re-run any
  compile_timeout alone at `COMPILER_POOL_SIZE=1` before it counts; the
  120 s per-row budget in `run-test262-paths.mts` does not cover the pool's
  own budget.
- **"Refusal → wrong answer" is the review class that matters for a runtime
  arm.** #3371's r4 lane bought 11 rows with seven silent wrong answers on
  programs base had refused; the fix round restored the refusal for each. A
  reviewer prompt must ask for programs base REFUSED, not only programs base
  ran correctly.
- **Merge-queue shepherding in parallel is cheap and worth it:** four stuck
  PRs (#5578 needing a manual enqueue, #5585 with no CI run, #5594's plain-node
  import fix for the npm-compat refresh, #5593) all landed while the lanes ran.

## Handover (2026-09-04, session claude/es6-test262-standalone-g10c7u)

### Where the goal stands

ES2015 standalone: **10,079 / 11,704 (86.1%)** on the baseline promoted after
PR #5561 (02:45 UTC). Day 2026-09-03 → 09-04 landed seven PRs (#5505, #5526,
#5527, #5534, #5550, #5558, #5561): 9,905 → 10,079, **+174 rows**. The
compile_error count did not move (380) — every wave was `fail` work.

### What is in flight (this PR and the lanes behind it)

| lane | issue | worktree / branch | state at handover |
| --- | --- | --- | --- |
| class | #5195 | `.claude/worktrees/wf_16f0b7f5-bf0-5` / `worktree-wf_16f0b7f5-bf0-5` | **in this PR** — r3-2/4/5/7 kept, r3-3 reverted; three review rounds; 19 rows |
| proxy + reflect | #5196 | `.claude/worktrees/wf_16f0b7f5-bf0-3` / `worktree-wf_16f0b7f5-bf0-3` | **in this PR** — R3-0/2/4/3-E2 + review fixes F1–F6; +20 rows; F9 (WASI-only trap where main compile-failed) recorded, not fixed |
| for-of + collections | #5267 | `.claude/worktrees/wf_9d1e6808-4e2-1` / `worktree-wf_9d1e6808-4e2-1` | **in this PR** — five steps kept, R3-6 reverted after review; 15 rows |

### What the next session should do first

1. **Watch the open PR** from `claude/es6-test262-standalone-g10c7u` until the
   merge queue lands it; a `github-actions[bot]` `hold` is a real merged-baseline
   regression — diagnose the cited run, fix on the branch, re-enqueue once.
2. **Refetch the standalone baseline and re-run the census**
   (`node scripts/fetch-baseline-jsonl.mjs --standalone --force`, then
   `.tmp/census0903/census.mjs` — the script is not committed; it is a 40-line
   reader of `test262-file-editions.json` + the baseline JSONL, easy to recreate).
3. **The CE mass is the next frontier**: expressions 96, class 56, promise 50,
   generators 46, for-of 36 compile_errors. A compile_error is a refusal to emit,
   so these need features, not fixes — plan them as such. #2864 (native
   generator carrier) gates 233 rows across seven clusters and is claimed and
   live in another lane: never start a parallel implementation.
4. Lanes handed over unshipped (if any, per the table) resume from their
   worktree branch: merge `origin/main` first, then the issue's Handover steps.

### Process lessons from this session (load-bearing)

- **A random 1,200-row sample of baseline-passing standalone rows through the
  CI harness** (`TEST262_PATH_FILTER_FILE` with `test/`-prefixed paths,
  `run-test262-vitest.sh`, quickjs oracle) **before every wave PR** caught the
  #5534 merge-queue park that three review rounds and all gates missed. Every
  flagged row is A/B'd against a `git archive` of `origin/main`; local artifacts
  to expect: `RegExp/regexp-modifiers/*` compile errors (fail on main too), a
  `compile_timeout` under load (re-run alone), and a "quickjs provider is not
  built" failure in a worktree missing the `.test262-cache/quickjs*` links.
- **Adversarial review with skeptics, repeated on each fix round.** Of ten
  waves reviewed this way, nine shipped-or-would-have-shipped a confirmed
  regression the lane's own row list, controls, five gates and 8-shard
  equivalence run all missed. Fix rounds are new code: review them too (the
  class lane needed three rounds; a typedarray fix's "single struct.new site"
  claim missed a second site and every module on that path failed Wasm
  validation — grep, do not trust).
- **The failure family to hunt for is "a working program now throws"**: every
  confirmed regression across the class and proxy lanes was a "provable"
  predicate (heritage is not a constructor, chain is all classes, alias is the
  Proxy constructor, revoker is non-constructable) that resolved by NAME or by
  declaration shape without a single-assignment / shadowing proof. Decline to
  base unless the proof holds under reassignment, destructuring, loop heads,
  parameters, `eval`/`with`, and shadowing.
- **Environment**: worktree `node_modules` / `test262` were symlink CHAINS
  through sibling worktrees — removing a shipped worktree broke the others.
  Link them directly to `/home/user/js2/node_modules` and
  `$(readlink -f /home/user/js2/test262)` before removing any worktree. The
  vitest fork heap must be 4 GB for suites that link the runtime-eval provider
  (`VITEST_FORK_MAX_OLD_SPACE_SIZE=4096`, single fork) — including the pre-push
  hook, so push in the background with that variable set. `--target wasi` does
  NOT set `ctx.standalone`; measure each arm on the targets its gate reaches.
- **CI is node 25, the container is node 22.** A node-oracle assertion
  (`new Function` in a test) can hold on one and not the other: V8 in node 25
  no longer gives sloppy functions own `caller`/`arguments`, so a pin that
  asserted node's answer for `G.caller` (class extending a plain function)
  failed only in CI. Probe the running engine instead of asserting a fixed
  answer, and run the changed test files under node 25 before pushing
  (`npx -p node@25` fetches one; `PATH=<its bin>:$PATH` puts the vitest
  forks and the compiler pool on it).
- **A merge-group shard that hits its 40-minute cap with no bot hold is a
  runtime wedge, not a slow family — and the PR-level checks cannot see it.**
  Fixture-graph rows (`language/module-code/**` self-imports and
  `_FIXTURE` graphs, ~200 rows) execute IN-PROCESS in the vitest fork
  (`tests/test262-shared.ts`), outside the compiler pool's 30 s kill, so one
  infinite loop caps the whole shard; the pattern is bimodal (13-18 min or
  40 min) and deterministic per shard set. The 2026-09-04 instance: the
  widened `identifierIsWrittenTo` counted `X.prop = v` as a write to X, which
  made `Test262Error` (sta.js assigns its prototype's `toString`) read as
  reassigned in EVERY row, declined the `new` fold everywhere, and the dynamic
  fallback looped on `namespace/internals/is-extensible.js`. Diagnose by
  reproducing one hung shard locally with CI's env (`TEST262_CHUNK_INDEX` /
  `TEST262_CHUNK_TOTAL` on `tests/test262-chunk-dynamic.test.ts`, the quickjs
  adapter built for the current bundle — without it eval-dependent rows fail
  fast and the wedge is invisible), then `node --prof` the single row through
  `runTest262File`. Artifact downloads from `blob.core.windows.net` are blocked
  by the container proxy, so the partial shard JSONL is not reachable.
- **Model attribution**: workflow agents inherit the session model unless the
  script pins `model`; after the `/model` switch, unpinned "Opus" agents ran on
  Fable 5.1 — two `Model:` trailers had to be rewritten (unpublished commits
  only). Pin `model: 'opus'` explicitly when the directive says Opus.
- **Operational**: never `pkill`/`pgrep` a pattern that appears in your own
  command line (it killed the integrator shell twice); kill by PID after a
  cwd check, and only when your own cwd is not that worktree. A test262 batch
  silent for 15 minutes is a pre-existing compile hang (labelled
  continue/break over nested for-of with closures) — kill and split it.

## 2026-09-04 census — 10,079 / 11,704 (86.1%) after #5561

Baseline refetched 2026-09-04 02:45 UTC (`oracle_lane: "honest"`, promoted
from the merge of PR #5561 — typedarray r3, #5194), same script and edition
map as the censuses below.

**10,079 pass / 11,704 (86.1%) — 1,625 non-pass** (1,244 fail · 380
compile_error · 1 compile_timeout): **+41 rows** over the post-#5558 census.
The rows sum to 1,625.

| Cluster | rows | fail | CE |
| --- | ---: | ---: | ---: |
| expressions | 228 | 131 | 96 |
| typedarray | 201 | 183 | 18 |
| class | 191 | 135 | 56 |
| other built-ins | 168 | 160 | 8 |
| proxy + reflect | 155 | 131 | 24 |
| regexp | 139 | 129 | 10 |
| generators | 121 | 75 | 46 |
| array + object | 121 | 111 | 10 |
| promise | 101 | 51 | 50 |
| for-of + collections | 98 | 62 | 36 |
| statements + lang | 75 | 55 | 20 |
| module-code | 25 | 19 | 6 |
| rest | 2 | 2 | 0 |

Day total since the 2026-09-02 census (9,905): **+174 rows** across seven
PRs. The compile_error count is unchanged at 380 across all of them — every
wave was `fail` work; the CE mass (expressions 96, class 56, promise 50,
generators 46, for-of 36) is what the next plans must open.

## 2026-09-04 census — 10,038 / 11,704 (85.8%) after #5558

Baseline refetched 2026-09-04 01:17 UTC (`oracle_lane: "honest"`, promoted
from the merge of PR #5558 — promise r3, #5197), same script and edition map.

**10,038 pass / 11,704 (85.8%) — 1,666 non-pass** (1,285 fail · 380
compile_error · 1 compile_timeout): **+17 rows** over the post-#5550 census.
The rows sum to 1,666.

| Cluster | rows | fail | CE |
| --- | ---: | ---: | ---: |
| typedarray | 242 | 224 | 18 |
| expressions | 228 | 131 | 96 |
| class | 191 | 135 | 56 |
| other built-ins | 168 | 160 | 8 |
| proxy + reflect | 155 | 131 | 24 |
| regexp | 139 | 129 | 10 |
| generators | 121 | 75 | 46 |
| array + object | 121 | 111 | 10 |
| promise | 101 | 51 | 50 |
| for-of + collections | 98 | 62 | 36 |
| statements + lang | 75 | 55 | 20 |
| module-code | 25 | 19 | 6 |
| rest | 2 | 2 | 0 |

Day total since the 2026-09-02 census (9,905): **+133 rows** across #5505,
#5526, #5527, #5534, #5550 and #5558. The compile_error count has not moved
(380) — every wave so far was `fail` work; the CE mass is the next frontier.

## 2026-09-03 late census — 10,021 / 11,704 (85.6%) after #5550

Baseline refetched 2026-09-03 23:31 UTC (`oracle_lane: "honest"`, promoted
from the merge of PR #5550 — array + object r3, #5268), same script and
edition map as the two censuses below.

**10,021 pass / 11,704 (85.6%) — 1,683 non-pass** (1,302 fail · 380
compile_error · 1 compile_timeout): **+15 rows** over the evening census.
Array + object went 135 → 121 (−14), typedarray 243 → 242 (−1); every other
cluster is unchanged, and the rows still sum to 1,683.

| Cluster | rows | fail | CE |
| --- | ---: | ---: | ---: |
| typedarray | 242 | 224 | 18 |
| expressions | 228 | 131 | 96 |
| class | 191 | 135 | 56 |
| other built-ins | 168 | 160 | 8 |
| proxy + reflect | 155 | 131 | 24 |
| regexp | 139 | 129 | 10 |
| generators | 121 | 75 | 46 |
| array + object | 121 | 111 | 10 |
| promise | 118 | 68 | 50 |
| for-of + collections | 98 | 62 | 36 |
| statements + lang | 75 | 55 | 20 |
| module-code | 25 | 19 | 6 |
| rest | 2 | 2 | 0 |

The lane had measured +21 directory rows on `Array/{from,of}` + `concat` +
`hasOwnProperty`; the census counts only ES2015-edition rows, which is where
the difference comes from — no row was lost in the queue (the merge-group
shards passed and the standalone floor held).

## 2026-09-03 evening census — 10,006 / 11,704 (85.5%), +58 from the day's second wave

Source: the standalone baseline refetched 2026-09-03 20:11 UTC (`node
scripts/fetch-baseline-jsonl.mjs --standalone --force`, `oracle_lane:
"honest"`), after PR #5534 (expressions r2, #5270) merged at 19:54; same
script (`.tmp/census0903/census.mjs`) and edition map as the morning census
below, so the cluster sizes are comparable with that table only.

**ES2015 standalone: 10,006 pass / 11,704 (85.5%) — 1,698 non-pass**
(1,317 fail · 380 compile_error · 1 compile_timeout), up from **9,948
(85.0%)** in the morning: **+58 rows**, from #5527 (built-ins r2, #5269:
other built-ins 197 → 168) and #5534 (expressions r2, #5270: expressions
244 → 228). #5534 parked once in the merge queue — a 325-row standalone
drop from a mint-time `return_call` against placeholder async function
types, invisible at PR level; the localisation method and fix are recorded
in #5270 and the lesson is now part of the wave pipeline: a random ~1,200-row
sample of baseline-passing rows, every flagged row A/B'd against a git
archive of `origin/main`, runs before each wave PR.

| Cluster | rows | fail | CE | owner / state (evening) |
| --- | ---: | ---: | ---: | --- |
| typedarray | 243 | 225 | 18 | #5194 r3 — implemented, round-3 review fixes in flight |
| expressions | 228 | 131 | 96 | #5270 r2 landed (#5534); residual is mostly CE |
| class | 191 | 135 | 56 | #5195 r3 — implementer suspended (WIP patch kept), re-dispatch |
| other built-ins | 168 | 160 | 8 | #5269 r2 landed (#5527); no r3 planned yet |
| proxy + reflect | 155 | 131 | 24 | #5196 r3 — implementer suspended (WIP patch kept), re-dispatch |
| regexp | 139 | 129 | 10 | #5198 codex lane (checkpoint PR #5393) |
| array + object | 135 | 125 | 10 | #5268 r3 — validated, shipping in this PR |
| generators | 121 | 75 | 46 | #2864 claimed and live; 233 rows across clusters gate on it |
| promise | 118 | 68 | 50 | #5197 r3 — validated, ships next |
| for-of + collections | 98 | 62 | 36 | #5267 r3 planned, not yet dispatched |
| statements + lang | 75 | 55 | 20 | residual unowned |
| module-code | 25 | 19 | 6 | #4759 codex closeout lane |
| rest | 2 | 2 | 0 | unowned |

The rows sum to 1,698, so coverage is still complete. The compile_error
share barely moved (391 → 380): the day's two waves were `fail` work, and the
CE mass sits in `expressions` (96), `class` (56), `promise` (50),
`generators` (46) and `for-of + collections` (36) exactly as in the morning.

## 2026-09-03 census — 9,948 / 11,704 (85.0%), full residual coverage

Source: `node scripts/fetch-baseline-jsonl.mjs --standalone --force` fetched
2026-09-03 08:13 UTC (row timestamps 09:07 UTC, `oracle_lane: "honest"`, i.e.
post-#5461 so every number is leak-checked), edition map
`website/public/benchmarks/results/test262-file-editions.json` (`ES2015`).
Reproduce with `.tmp/census0903/census.mjs`; per-cluster TSVs (path, status,
truncated error) land in `.tmp/census0903/`.

**ES2015 standalone: 9,948 pass / 11,704 (85.0%) — 1,756 non-pass**
(1,364 fail · 391 compile_error · 1 compile_timeout), up from **9,905 / 11,704
(84.6%)** at the 2026-09-02 census: **+43 rows**, from PR #5505 (statements +
language semantics r2, #5271) and the other lanes that landed overnight.

Note the clustering here is the one in `.tmp/census0903/census.mjs`, which
differs from the 09-02 census: `class` and `generators` are pulled out of
`language/expressions` and `language/statements` first, so `expressions` here
collects what is left of `language/expressions/*`. Compare cluster *sizes*
across censuses only via that script, not against the 09-02 table.

| Cluster | rows | fail | CE | owner / state |
| --- | ---: | ---: | ---: | --- |
| expressions | 244 | 147 | 96 | #5270 — lane complete, in validation |
| typedarray | 244 | 226 | 18 | #5194 — r2 landed (#5479), r3 planned 09-03 |
| other built-ins | 197 | 178 | 19 | #5269 — lane complete, in round-3 review |
| class | 191 | 135 | 56 | #5195 — r2 landed (#5489), r3 planned 09-03 |
| proxy + reflect | 157 | 133 | 24 | #5196 — **never dispatched**, r3 planned 09-03 |
| regexp | 140 | 130 | 10 | #5198 codex lane (checkpoint PR #5393) |
| array + object | 137 | 127 | 10 | #5268 — r2 partial (#5494), r3 planned 09-03 |
| generators | 121 | 75 | 46 | #680 / #2864 / #1691 codex lane (PR #5063 held) |
| promise | 118 | 68 | 50 | #5197 — slices B–D landed (#5454), r3 planned 09-03 |
| for-of + collections | 101 | 65 | 36 | #5267 — r2 landed (#5458), r3 planned 09-03 |
| statements + lang | 75 | 55 | 20 | #5271 r2 landed (#5505) — residual unowned |
| module-code | 25 | 19 | 6 | #4759 codex closeout lane |
| rest | 6 | 6 | 0 | unowned |

The cluster sizes sum to exactly 1,756, so **every non-pass row is accounted
for**: 948 in the six lanes planned on 09-03, 441 in the two waves in flight,
286 in codex lanes, and 81 (statements + lang residual, rest) still unowned.

**The 391 compile_errors are the harder half.** They are not spread evenly —
`expressions` (96), `class` (56), `promise` (50), `generators` (46) and
`for-of + collections` (36) hold 71% of them, and a compile_error is a refusal
to emit rather than a wrong answer, so it needs a feature, not a fix. Any plan
that counts rows without splitting fail from CE is over-promising.

### Cross-cutting blockers — 281 rows no cluster lane can fix

Three defects are not clusters at all: they are single missing capabilities
whose rows are scattered across other lanes' residual lists. A cluster plan
that counts them is promising rows it cannot deliver.

| blocker | issue | rows | where they sit |
| --- | --- | ---: | --- |
| standalone native generator lowering | #2864 (claimed, live) | 233 | expressions 91 · generators 46 · class 45 · for-of 35 · statements 13 · module-code 2 · proxy 1 |
| `Reflect.construct` with a distinct NewTarget | #3371 (design checkpoint PR #5400) | 33 | proxy+reflect 11 · typedarray 11 · other built-ins 6 · expressions 2 · promise 2 · array+object 1 |
| `Reflect.set` with an explicit receiver | #2046 (design checkpoint PR #5397) | 15 | proxy+reflect 7 · typedarray 6 · statements 2 |

**281 rows, 16% of the residual.** Net of them, the six lanes planned today can
claim at most: typedarray 227, class 146, proxy+reflect 138, array+object 136,
promise 116, for-of+collections 66. Two caveats on that arithmetic — the 44
`env::Promise_*` leaks inside the promise cluster and the 3 RegExp-engine
refusals inside the regexp cluster are *those lanes' own scope*, so they are
not subtracted; and #3371/#2046 are the proxy+reflect lane's own subject
matter, held at design checkpoints rather than blocked elsewhere, so #5196's
plan should treat its 18 as dependent-on-design rather than out of scope.

Reproduce the split with the predicate in the commit that added this section;
the generator rows are isolated in `.tmp/census0903/_gen.tsv`.

## 2026-09-02 post-wave census — 9,905 / 11,704 (84.6%), +232 rows in one day

Source: `node scripts/fetch-baseline-jsonl.mjs --standalone --force` fetched
2026-09-02 21:06 UTC (row timestamps 20:27–20:41 UTC, i.e. after PR #5494
merged at 19:44 UTC, so every wave below is reflected), edition map
`website/public/benchmarks/results/test262-file-editions.json` (`ES2015`;
11,778 labelled, 11,704 in the official runner scope).

**ES2015 standalone: 9,905 pass / 11,704 (84.6%) — 1,799 non-pass**
(1,407 fail · 391 compile_error · 1 compile_timeout), up from
**9,673 / 11,704 (82.6%)** at the 2026-09-01 evening census: **+232 rows**.

Landed this day (all merged to `main`), in order:

| PR | wave | issue | rows claimed |
| --- | --- | --- | ---: |
| #5454 | Promise slices B–D | #5197 | +19 |
| #5458 | for-of / iterators / collections r2 | #5267 | +37 |
| #5224 | buffers wave 1 | #5150 | +16 |
| #5461 | runner: standalone leak check on the in-process path | #5272 | (honesty fix) |
| #5469 | post-#5224 regression fix (module-global `$__ta_view` pin) | #5150 | (restores 9 host rows) |
| #5475 | r2 implementation plans (expressions, statements) | #5270/#5271 | (docs) |
| #5479 | TypedArray r2 | #5194 | +84 |
| #5489 | class r2 (+ #5194 null-proto follow-up) | #5195 | +28 |
| #5494 | Array/Object built-ins r2 | #5268 | +21 |

Two process notes worth keeping:

- **#5461 changed what a measurement means.** Before it, the in-process runner
  (`scripts/run-test262-paths.mts`, every local before/after probe) satisfied a
  leaked `env::*` import from the JS host and scored the row on what happened
  next — so a slice could read "fixed" locally while CI scored
  `host_import_leak`. Every number above is measured with the check in place;
  the TypedArray lane re-scored its 84 claimed flips afterwards and found no
  pseudo-pass, but the class lane found one (`constructor-can-be-generator.js`
  leaks `env::__create_generator`, owned by #680/#2864, now pinned as a leak).
- **Every wave went through an independent adversarial review before shipping,
  and five of six had confirmed regressions their own row lists, controls,
  ratchet gates and equivalence runs all missed** — 13 in total, including two
  that only appeared on the JS-host lane, one that made a whole class of
  subclass declarations fail to compile, and one pre-existing defect in the
  shared carrier-bag key merge (`Reflect.defineProperty` on an existing
  closed-struct field double-listed the key on `main` too). A row list is not a
  regression test: none of these shapes were in the cluster lists the planners
  built, because the lists are drawn from *failing* rows and these broke
  *passing* behaviour outside the cluster.

Remaining non-pass by cluster (same split as the 09-01 census, so the two are
comparable):

| Cluster | 09-01 | 09-02 | Δ | Owner |
| --- | ---: | ---: | ---: | --- |
| class | 209 | 225 | +16 | #5195 r3 residuals R3-1…R3-7 recorded |
| typedarray | 300 | 208 | −92 | #5194 residuals (F3/F4 documented) |
| generators | 318 | 195 | −123 | #680 / #2864 codex lane |
| array + object | 159 | 179 | +20 | #5268 steps 4/5/7/8/9/10 not started |
| other built-ins | 150 | 165 | +15 | #5269 in flight (G/H/A/B/L/J/E/D landed) |
| expressions | 117 | 163 | +46 | #5270 in flight (steps 4–7, 9, 11 open) |
| proxy + reflect | 157 | 157 | 0 | #5196 not dispatched; #3371 / #2046 blocked |
| regexp | 148 | 140 | −8 | #5198 codex lane |
| for-of + collections | 155 | 119 | −36 | #5267 residuals |
| promise | 140 | 118 | −22 | #5197 slices E–H open |
| statements + lang | 84 | 79 | −5 | #5271 in flight (0 → 39 of 68 in scope) |
| module-code | 23 | 24 | +1 | #4759 codex closeout lane |
| rest | 18 | 27 | +9 | folded into the nearest cluster plan |

The clusters that grew did not regress — the counts move because rows leave a
cluster when they pass and because this census clusters by path prefix while
the 09-01 one clustered by the dispatch split; treat the Δ column as a
direction indicator, not as a per-cluster regression signal. The authoritative
"no row regressed" evidence is each wave's own before/after on its row list
plus the merge-group regression gate.

## 2026-09-01 evening dispatch census at d39779cb — cluster ownership + Fable/Opus fan-out

Source: `node scripts/fetch-baseline-jsonl.mjs --standalone --force` (baselines
repo, compiler sha `d39779cbfdd5a9b5fdb54569923fd9810637d495`, generated
2026-09-01T18:33Z — an ancestor of the session branch
`claude/es6-test262-standalone-g10c7u`, which is `origin/main` @ `0d9bfede`),
edition map `website/public/benchmarks/results/test262-file-editions.json`
(`ES2015` label; 11,778 labelled, 11,704 in the official runner scope).

**ES2015 standalone: 9,673 pass / 11,704 (82.6%) — 2,031 non-pass**
(1,644 fail · 386 compile_error · 1 compile_timeout). Status/error class:
1,122 `assertion_fail`, 367 `type_error`, 248 `host_import_leak` CE,
151 other CE, 34 runtime_error CE, 21 promise_error, 15 illegal_cast,
10 null_deref, 10 range_error.

Cluster split (path-disjoint; lists under `.tmp/es2015/<cluster>-{paths.txt,errors.tsv}`,
regenerable from the JSONL + edition map):

| Cluster | Rows | Owner / tracker | Dispatch (this session) |
| --- | ---: | --- | --- |
| generators (`language/*/generators`, `yield`, GeneratorFunction/Prototype, `__create_generator` leaks, "sequential numeric yields" refusal) | 318 | #680 / #2864 codex lane (PR #5383 merged; #5406/#5407 drafts) | **not re-dispatched** |
| typedarray (`built-ins/TypedArray*`, excl. buffers) | 300 | #5194 (Slice A merged #5300; #5385 species merged) | Fable planner → r2 plan in #5194 → Opus |
| class (`language/*/class`, `computed-property-names/class`, `super`, `new.target`) | 209 | #5195 (stub) | Fable planner → plan → Opus |
| array + object built-ins | 159 | new **#5268** | Fable planner → plan → Opus |
| proxy + Reflect | 157 | #5196 (2-row revoker slice merged #5389); #3371 (33 CE, blocked design PR #5400); #2046 (15 CE, design PR #5397) | Fable planner on the unowned trap-invariant residual → Opus |
| for-of + Iterator/*IteratorPrototype + Map/Set/Weak* | 155 | new **#5267** (wave-1 #5144/#5147/#5151; draft PR #5225 mined, not merged) | Fable planner → plan → Opus |
| function/error/symbol/string/JSON/number built-ins | 150 | new **#5269** (wave-1 #5156/#5152) | Fable planner → plan → Opus |
| regexp (`built-ins/RegExp`, annexB RegExp, `Symbol.{match,replace,search,split}`) | 148 | #5198 codex lane (Slice A merged #5296; Slice B draft #5393) | **not re-dispatched** |
| promise | 140 | #5197 (Slice A merged #5292; slices B–H planned) | Opus implementer on Slices B–D directly |
| expressions (object literal, assignment, arrow, call, template, instanceof, …) | 117 | new **#5270** (wave-1 #5149/#5146) | Fable planner → plan → Opus |
| statements + lang semantics (for-in/for/let/const/with/try, global/eval code, arguments, rest, dstr) | 84 | new **#5271** (wave-1 #5154/#5158/#5157) | Fable planner → plan → Opus |
| buffers (ArrayBuffer/DataView) | 53 | #5150 (full plan; WIP draft PR #5224 unvalidated) | Opus implementer directly (mines the WIP) |
| module-code | 23 | #4759 codex closeout lane | not re-dispatched |
| rest (misc singletons) | 18 | — | folded into the nearest cluster plan |

Ids #5267–#5271 were reserved via `claim-issue.mjs --allocate`
(`--no-pr-scan --allow-unscanned`: no `gh` in this container, so the open-PR
scan could not run; the `check:issue-ids:against-main` gate backstops).

Method (unchanged from the 08-28/29 session): Fable planners re-verify each
list on HEAD with `scripts/run-test262-paths.mts --standalone`, cluster by
root cause with file:function sites, and write the `## Implementation Plan`
into the issue; Opus implementers work each plan in an isolated worktree and
commit validated slices; this lane integrates them into the session branch,
runs the ratchet + equivalence gates, and lands batches through PRs.

## Latest forced census (2026-09-01; replaces the stale dispatch headline below)

This is the latest immutable dispatch baseline for this umbrella. It replaces
the older 2026-08-15/27/30 planning headline below, but it is not final
acceptance evidence: upstream `main` advanced after the fetch from the measured
`f841cddc` source to release head `7fffec53`. A complete maintained-runner census on the
final integrated head is still required before any current pass-rate or
completion claim.

- **Compiler source:** detached `upstream/main`
  `f841cddc0f0ea665b63700d9944a4372a34a8b57`.
- **Baseline provenance:** a forced official fetch with
  `node scripts/fetch-baseline-jsonl.mjs --standalone --force` retrieved
  `test262-standalone-current.jsonl` from immutable
  `loopdive/js2wasm-baselines` commit
  `8a39bd1d4ddf200f8db3751c878ece02aa8688fe` (GitHub Actions commit time
  `2026-09-01T00:28:18Z`).  The 22,858,445-byte cache has SHA-256
  `4426cbf6f305ab4a092468b201cc5854d4470b5fe87edf2fe47ba0195a6e8cbf`.
  Its row timestamps span `2026-09-01T02:02:14Z` through
  `2026-09-01T02:24:30Z`. The baselines repository's `main` moved after this
  fetch; cite the immutable commit above, not the moving branch tip.
- **Schema/completeness check:** all 48,735 JSONL rows parse; every row has
  the required string/number/boolean baseline fields, one of
  `pass|fail|compile_error|compile_timeout|skip`, and a unique `(file,strict)`
  identity.  Optional timing/error fields are absent only where the maintained
  runner schema permits them.
- **Edition authority:**
  `website/public/benchmarks/results/test262-file-editions.json` maps every
  fetched row.  Selecting entries whose exact label is `ES2015` produces
  11,704 rows, all `scope_official: true` (11,536 standard and 168 Annex B).
- **Measured result at `f841cddc`:** **9,616 pass / 11,704 total** (82.16%);
  **1,644 fail, 444 compile_error, 0 compile_timeout, 0 skip** — **2,088
  non-pass**. This
  is progress, not completion; the umbrella remains `in-progress` until the
  complete exact population is 11,704 pass with all other status counts zero.

### Acceptance runner and positive control

Do not infer acceptance from this fetched baseline.  A subsequent implementation
must use the maintained runner, an exact 11,704-path filter derived from the
authoritative edition map, and the runner's completion-manifest validator.  The
shape is:

```bash
COMPILER_POOL_SIZE=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=3072 \
TEST262_TARGET=standalone JS2WASM_EVAL_ENGINE=quickjs \
JS2WASM_QUICKJS_ARTIFACT_DIR=/absolute/prebuilt-quickjs-artifact-dir \
TEST262_PATH_FILTER_FILE=/absolute/path/to/exact-es2015-paths.txt \
TEST262_PUBLISH_HISTORY=0 TEST262_REPORTER=dot \
pnpm run test:262 -- --official-scope-only
```

As a focused positive control for the free #2046 slice, the fetched baseline
records `test/built-ins/Reflect/set/set-value-on-accessor-descriptor.js` as a
standalone **pass** (the supported three-argument native `Reflect.set` path).
Before and after any receiver implementation, it can be exercised without a
full suite via:

```bash
printf '%s\n' \
  'test/built-ins/Reflect/set/set-value-on-accessor-descriptor.js' \
  > /absolute/path/to/reflect-set-positive-control.txt
COMPILER_POOL_SIZE=1 TEST262_TARGET=standalone \
JS2WASM_EVAL_ENGINE=quickjs \
JS2WASM_QUICKJS_ARTIFACT_DIR=/absolute/prebuilt-quickjs-artifact-dir \
TEST262_PATH_FILTER_FILE=/absolute/path/to/reflect-set-positive-control.txt \
TEST262_PUBLISH_HISTORY=0 TEST262_REPORTER=dot \
pnpm run test:262 -- --official-scope-only
```

### Current handoff: owned work versus free exact slices

- **Do not duplicate:** the three ES2015 dynamic-`RegExp` `Symbol.match`
  flag-refusal paths are isolated, but a live sibling worktree owns #5198
  (`codex/5198-regexp-exec-r2-f841-20260901`).  Generator continuations are
  covered by open PR #5383; TypedArray species work by #5385; and builtin
  prototype/null-prototype work by #5384.
- **Free, bounded implementation candidate:** #2046's explicit
  `Reflect.set(target,key,value,receiver)` refusal has **15 exact
  compile-error paths**, all with the same fail-loud diagnostic.  The single
  gate is `src/codegen/expressions/call-namespace-static.ts:903-920`; #2046 is
  in progress, no current GitHub PR matches it, and its visible remote branches
  are June-era checkpoints.  The implementation must preserve the positive
  control above and add receiver plumbing rather than drop the fourth argument.
- **Unowned but not yet a safe parallel coding slice:** #3371's arbitrary
  distinct-`Reflect.construct` NewTarget refusal remains on **33 exact
  compile-error paths** at
  `src/codegen/expressions/call-namespace-static.ts:1620-1627`, despite its
  tracker being marked done.  It needs a reopened/new bounded owner before
  implementation; it is not a substitute for the #2046 slice.  The apparent
  three-row `Array.prototype.flat` refusal is already a tail of #5145's
  in-review ArraySpecies/target-property wave, so do not duplicate it.

## Historical measurement (2026-08-15, superseded as a headline)

Source: fresh `test262-standalone-current.jsonl` (baselines repo, fetched
`--force`, 48,735 entries, baseline_sha `734fab88`), classified per-test with
`scripts/generate-editions.ts` `classifyEdition` (host-free pass definition,
`host_import_leak_class` excluded). Reproduction: `.tmp/es6-standalone-clusters.ts`.

**ES2015 standalone: 7,695 pass / 11,704 total (66%) — 3,401 fail, 607
compile_error, 1 skip = 4,009 non-passing.**

## Cluster map → owning issues

Counts are non-passing ES2015-classified tests in the standalone lane; clusters
overlap paths (a generator test under `language/statements/class` counts in the
generator row).

| # | Cluster (root cause) | ~Tests | Owning issue(s) | State |
|---|---|---|---|---|
| 1 | **Native generator carrier** — standalone lowering only supports "sequential numeric yields"; everything else leaks `__create_generator`/`__gen_*` host imports (CE) or mis-executes. Spread across `language/{expressions,statements}/generators`, `yield`, `class` (gen methods), `object` (gen shorthand), for-of/dstr | ~500 | #2864 (in-progress), #2906 (in-progress), #3032, #680; umbrella #3178 | tracked — do NOT duplicate |
| 2 | **Promise/microtask carrier** — `Promise.all/race` leak `Promise_all`/`Promise_race`/`__js_array_new` (CE); `Promise.resolve` "not yet implemented"; `illegal cast [__then_fulfill_N]` in the async drive layer | ~233 | #2867 (ready), #2906, umbrella #3178 | tracked |
| 3 | **Built-in method reflection** — `length.js`/`name.js`/`prop-desc.js`/`not-a-constructor.js`/`invoked-as-func.js` across every built-in: methods are not reified function objects (`Object.getOwnPropertyDescriptor` → "Cannot convert undefined or null to object", `typeof m === "undefined"`) | ~324 | #2175 (ready, arch spec written), #2158, #2159; sibling lane PR #4553 (method name/length meta) is in flight | tracked — architectural |
| 4 | **TypedArray.prototype semantics** — species-constructor protocol (`speciesctor-*`, 55), custom-ctor paths, detached-buffer TypeErrors (~41), coercion/validation order. Excludes row-3 reflection files | ~556 | **#4449** (filed this session, triage-first; reflection part stays #2159) | tracked |
| 5 | **RegExp `@@replace`/`@@match`/`@@split`/`@@search`** — function replacer refusal (CE, "#1913 follow-up"), coercion order, `lastIndex` protocol | ~161 | #2161 (blocked on #2175), F7 dynamic-receiver arch spec pending | tracked/blocked |
| 6 | **for-of destructuring residual** — iterator close/return/throw propagation, trailing-iterator state (`trlg-iter`, 23), nested patterns, fn-name inference, TDZ | ~200 (non-generator) | **#4447 — slice 1 LANDED** (standalone dstr 342→400/569, gc +51, assignment/dstr +6, 0 lost; binding form + eval-order deferred, see issue) | landed |
| 7 | **Class semantics residual** — `class/dstr` method-param destructuring dominates (112, shares #4447's machinery), subclass (46), definition (36), NamedEvaluation `NaN vs undefined` | ~321 (non-generator) | **#4450** (filed this session; re-measure after #4447 lands; overlaps #2158/#2175) | tracked |
| 8 | **annexB String HTML methods** — the direct-call lowering existed (#3069); the gap was the value-erased proto-closure shape | 79 | **#4445 — DONE** (filter 17→95/111 standalone, 13 HTML dirs 82/82, gc identical; reflection files flipped free via method-meta) | done |
| 9 | **Array.prototype extern fallback leak** — `compileArrayConcatExtern` emits `__array_concat_any`/`__js_array_new`/`__js_array_push` → standalone leak-guard CE | ~30 | **#4446 (this session)** | dispatched |
| 10 | Long tail — `Object.prototype` (38), `Function.prototype` (35), `let`/TDZ (26), `arrow-function` (25), `switch` (23), DataView (45), Iterator.prototype (55) | ~250 | untracked — file per-cluster on pickup | open |

## Strategy

1. **The two umbrella dependencies dominate**: rows 1–2 (generator + promise
   carriers, ~733 tests) are owned by the in-flight #3178 machinery retirement
   lane; row 3 (#2175 reflection, ~324 direct + unlocks rows 4/5/7 residuals)
   has an architect spec and sibling-lane momentum (PR #4553). This umbrella
   does not re-dispatch them.
2. **This session dispatches the unowned, bounded clusters** — #4445, #4446,
   #4447 — to Opus implementation agents in parallel worktrees (plans in the
   issue files).
3. **Next-wave triage issues filed**: #4449 (row 4, TypedArray) and #4450
   (row 7, class residual). Row 10's long tail gets per-cluster issues as the
   dispatched wave lands, so counts stay attributable.

## Session results (2026-08-15, wave 1)

- **#4445 landed** (`5b715e1`): annexB String filter 17→95/111 standalone, 13
  HTML dirs 4/82→82/82, gc unchanged (108/111 before/after, official wrapper —
  an earlier 92/111 figure was a fast-driver artifact). Free follow-up found:
  `trimLeft`/`trimRight` miss the same `STRING_PROTO_METHODS` CSV (6 tests;
  `reference-*` also needs alias identity `trimLeft === trimStart`).
- **#4447 slice 1 landed** (`8dcbc88`): standalone for-of/dstr 342→400/569,
  gc 344→395 (+51 — three of four fixes are lane-independent), standalone
  assignment/dstr 240→246, 0 lost anywhere. Deferred: eval-order interleaving,
  §7.4.9 refinements, fn.name, binding form (~30 tests,
  `destructureParamArray`).
- **#4446**: in flight (interim: concat 13→23 pass, 29→1 CE, 0 lost).

## Acceptance

- A fresh authoritative standalone (host-free) run on the final integrated
  head passes every path in the reconciled ES2015 population, with zero fail,
  compile error, compile timeout, skip, missing, or duplicate verdicts.
- Reconcile the edition map with actual runner discovery before claiming
  completion. The current map contains 11,778 ES2015 paths, while default
  discovery covers 11,704 and omits 74 Intl402 paths. A 11,704/11,704 result
  alone is not whole-goal proof while that scope discrepancy is unresolved;
  no exclusion is authorized merely because default discovery omits a path.
- Validate exact selected-path identity against completion manifests and
  physical verdict rows, retaining source/corpus commits and filter hashes.
  Historical denominator statements below describe their dated runs, not a
  waiver of this current completeness requirement.
- Interim checkpoints: each cluster row either has an owning issue with a plan
  or a landed fix; the edition table in this file is refreshed per measurement
  (name the artifact + date per project measurement discipline).

## 2026-08-27 authoritative standalone closeout status

The active goal is the standalone ES2015 edition score. Host measurements are
retained as regression controls but are not part of the completion denominator.
The latest complete maintained-runner ES2015 measurements on the combined
closeout lineage are:

- host run `20260826-180615`: 9,435 pass / 11,704 total, 2,163 fail,
  59 compile errors, 46 compile timeouts, 1 skip;
- standalone run `20260826-194014`: 8,402 pass / 11,704 total, 2,728 fail,
  571 compile errors, 2 compile timeouts, 1 skip.

Later bounded checkpoints have fixed or classified #4758 (40 host
destructuring timeouts), #4759 (20 module-namespace self-import bindings),
#4760 (Promise poisoned-thenable slice), #4762 (mutation-safe realm cleanup),
#4763 (Set replaced-adder abrupt completion), and #3423 (11 nested-object
destructuring rows). Those bounded results do not replace a fresh full 11,704
measurement and are not added arithmetically to the headline.

The active Luna/max wave is issue-backed and isolated: #4449 owns the exact
55-row TypedArray species cohort, #4450 owns four class static `name`/`length`
precedence rows, and #2765 owns three `instanceof` getter/prototype rows. The
single integration target remains upstream draft PR #5010.

Completion requires a fresh authoritative standalone run on the final
integrated head reporting exactly 11,704 pass / 11,704 total with zero fail,
compile error, compile timeout, or skip. Host runs remain required per-slice
regression controls, not a second completion bar. Until the standalone proof
exists, this umbrella remains in progress. Individual completed fixes may be
ready and landed; draft state is reserved for an incomplete or non-mergeable
checkpoint.

## 2026-08-30 Codex resumption and implementation handoff

The 2026-08-27 reference above to a single draft integration PR #5010 is
historical and no longer governs delivery. Current delivery uses one separate
upstream PR per completed fix; only an incomplete or non-mergeable checkpoint
may be draft.

The latest complete exact-filter artifact available at resumption is the
2026-08-28 maintained standalone snapshot. Selecting the frozen 11,704-row
ES2015 map produces **8,681 pass / 2,513 fail / 509 compile_error / 1
compile_timeout / 0 skip**. The artifact SHA-256 is
`260a57b7fb4d53516fa81e1c949d81337968e30ce790d457bcc2d3945c2e9e1e`; the
exact path-map SHA-256 is
`45de809c6bfce7371cee1d20e327758246b0524ecd75481a08b8c03344fced8a`.
Because that artifact does not embed its source commit and predates the
current upstream tree, it is a dispatch baseline, not final acceptance
evidence. Per-slice gains are never added arithmetically to this headline.

Coordination refreshed `loopdive/js2` upstream main to
`a62aacba5ccc154f6fc378235aaaeeb4a7204231`; a fresh fetch immediately after
the diagnostic confirmed that this is still the authoritative upstream head.
The #5194/#5195/#5197/#5198 worktrees and the new #5212/#5213/#5214 lanes are
based on that exact commit. #5131 has integrated it locally but still requires
validation and a corrected commit trailer before its published draft can be
updated.

The full maintained-runner diagnostic on detached source
`1f1004f3df195cc5f9e804efcbb2896d3871ca37` finished all 16 shards of the
11,704-row map with standalone target, two workers, the QuickJS artifact, and
official-scope-only filtering. Vitest's own final summary proves it registered
and executed **11,704 tests**. The canonical JSONL is nevertheless incomplete:
it has **11,685 physical rows / 11,685 unique paths / 8,974 pass / 2,258 fail /
447 compile_error / 6 compile_timeout / 0 skip**. It contains no malformed
rows, duplicate identities, or paths outside the filter, but is missing 19
selected paths. Its SHA-256 is
`47f34c307c43b06c9c40bb0df754bc22d94435a23cccfdd6de857816e199214a`;
the generated partial report SHA-256 is
`f6255daef57aa971bf121b98ea629b53985cf591d47bfc579b54dab538babe59`.

The deficit is localized exactly: shard 10 registered 731 tests and recorded
712, while every other shard reconciled. Vitest grouped the 19 abandoned
callbacks under `Error: Test timed out in 90000ms` at
`tests/test262-shared.ts:644`; the runner then overwrote shard 10's completion
file with later shards and printed `COMPLETED: 8974 pass / 11685 total`. The
atomically allocated markdown issue #5215 records all 19 paths and the
implementation plan for bounded Test262 concurrency, durable per-shard
completion manifests, and a fail-before-publication completeness validator.
This artifact remains exact dispatch evidence for the 11,685 emitted paths,
not an authoritative edition census and not final integrated-head acceptance.

All six recorded timeouts are detached-buffer TypedArray rows: shard 16
reported `byteLength/detached-buffer.js` and
`lastIndexOf/detached-buffer.js`; shard 10 reported
`findIndex/predicate-may-detach-buffer.js` and
`every/callbackfn-detachbuffer.js`; and shard 1 reported
`indexOf/detached-buffer.js` and `buffer/detached-buffer.js`. They remain under
the active #4449 residual and require bounded solo rechecks. The shared census
test lock is now released. After #5212 and #5214 completed their bounded lanes,
#5215 and #5213 each received one compiler/test worker; the global ceiling
remains two and root does not start an overlapping compiler/test lane.

The active work is repository-issue-backed and isolated:

- #5131 owns strict iterator materialization for dynamic spread. Its published
  PR #5272 remains draft because that published checkpoint is conflicting and
  non-mergeable (the shepherd measured 2 commits ahead / 525 behind current
  main); the newer local implementation must integrate current main, pass its
  full focused matrix, and replace the stale handoff before becoming ready.
- #5194 owns the exact 25-row TypedArray `set` Slice A and its host regression
  controls.
- #5195 owns the exact 12-row faithful builtin-subclass slice, with the
  generator carrier explicitly delegated to #5199.
- #5212 is the completed atomically allocated, markdown-only Map/Set provider
  sub-slice from #5195. Its two exact rows pass host and standalone, and its
  single non-draft upstream PR is #5286 at final published head
  `cc653e1cd162ca33a95e659df15a40764d9e7c82`; the dedicated shepherd owns its
  CI/readiness/queue audit.
- #5213 is the atomically allocated, markdown-only two-row class instance
  accessor sub-slice; a separate Luna Max worktree owns the `prototype` key
  collision without touching the collection provider.
- #5214 is the completed atomically allocated, markdown-only six-row NativeError
  prototype-`name` configurability slice. Its exact host/standalone matrix is
  12/12 pass, and its single non-draft upstream PR is #5287 at final published
  head `e7fbfda3bdb6f8ea25acd59ba1cdb376a0aa0f23`; the dedicated shepherd owns
  its CI/readiness/queue audit.
- #5215 is the atomically allocated, markdown-only Test262 verdict-completeness
  repair. Its root-filed implementation plan prevents a timed-out shard from
  being overwritten and published as a complete report; a fresh Luna Max
  worktree now owns the implementation and one-worker validation.
- #5197 owns the exact three-row Promise symbol object-model Slice A.
- #5198 owns the exact nine-row RegExp `exec`/`test` observable-`lastIndex`
  Slice A.

These numbers refer only to markdown files under `plan/issues`; no GitHub
issues are to be created. Implementations use Luna Max agents in separate
provisioned worktrees. Every completed, mergeable fix gets its own non-draft
PR from `ttraenkler/js2` to `loopdive/js2`; only an incomplete or genuinely
non-mergeable checkpoint may remain draft. A separate shepherd agent verifies
the required PR body, mergeability, reviews, CI, exact tested head, and
ready/queue state before landing.

## 2026-09-13 continuous implementation plan

Continuation starts at upstream `e0023dbbe6c37e15c1f56ed0c8bc8d15d0afbac3`.
PRs #5853 and #5862 are merged. A freshly downloaded canonical standalone
snapshot (first physical row timestamp 2026-09-13 00:32:03, SHA-256
`07c89a5c2626f3312ff611f008a69ed6d8826e9802da024df39726ddabc1e9ba`)
contains 48,735 rows. The official ES2015 intersection is 11,704 rows:
10,255 pass, 1,104 fail, 344 compile_error, and 1 compile_timeout.
This is dispatch evidence, not a census attributed to the checkout above.

Implementation ownership and order:

1. #5199: reproduce the three retained generator payload controls on current
   main; implement the separately documented payload/result representation
   plan, preserve protocol controls, and measure exact affected Test262 rows.
2. #5198: reproduce remaining exec lastIndex and deferred Symbol.match rows;
   extend observable cursor handling with focused positive controls and paired
   host/standalone validation. Keep its source changes separate from generators.
3. Coordinator: validate baseline provenance and the complete 11,704-path
   acceptance instrument, refresh the remaining-failure inventory, and select
   subsequent clusters from measured rows as workers become available.

Implementation agents use Terra Max in separate worktrees. Each owner updates
its issue with evidence and opens a separate upstream PR per completed fix.
A dedicated shepherd checks published PRs. Finished mergeable work is ready;
unfinished work is draft. PR completion is a checkpoint: continue to the next
measured residual until the full acceptance condition below is met.

Runner contract correction: `scripts/run-test262-vitest.sh` currently computes
paths relative to the `test262` root, so its exact filter must retain `test/`.
The separate `scripts/run-test262-paths.mts` interface expects paths below
`test262/test`. Do not reuse one filter spelling across those interfaces.
The first 2026-09-13 census attempt used the historical normalized spelling:
all 16 suites registered no tests, produced zero rows, and the completeness
validator correctly exited 2. This is an invalid measurement, not a pass rate.
The retry retains `test/` for all 11,704 selected paths. Earlier instructions
below that prescribe stripping it for the Vitest wrapper are superseded.

## 2026-08-30 current integrated-head census implementation plan

The numeric title no longer repeats the stale 2026-08-28 snapshot. Historical
measurements above remain useful dispatch evidence, but none is the acceptance
numerator. The next headline will be written only from a complete maintained-
runner census on one exact integrated upstream commit.

At this checkpoint, freshly fetched `loopdive/js2` main is
`01fb67624e2f645b7e92dd9f8e47478e3face9ba`. RegExp Slice A PR #5296 is merged
there. TypedArray `set` Slice A PR #5300 is non-draft at exact tested head
`a6bd6301007e37d289e9378a97891a44846e33f9` and is already in the upstream
merge queue; the census must not start until that exact change lands and this
worktree is fast-forwarded or merged to the resulting current main. The
documentation-only ES2018 tracker PR #5304 does not affect the ES2015
denominator. #5131's two fixed empty-spread rows are unclassified, and #5216's
object-spread rows classify as ES2018, so neither may be added to the ES2015
numerator.

The selection authority is the frozen 11,704-path artifact
`/private/tmp/js2-es2015-11704-pr5008.txt`, whose LF-normalized SHA-256 is
`45de809c6bfce7371cee1d20e327758246b0524ecd75481a08b8c03344fced8a`.
Every entry has a leading `test/`; removing only that prefix produces 11,704
unique `test262/test`-relative paths with SHA-256
`90d5e85a13e3721c8e53734e21c01ec894f736412048cf4d8b15ca7ecc47c2cd`.
Before execution, regenerate that normalized file in this worktree's temporary
area, require exact set equality and 11,704 existing files, and record the
Test262 gitlink/checkout `b363f29d3c43c626dc852744ad64a0b48a003693`.

Execution uses the maintained `scripts/run-test262-vitest.sh` path, not a
hand-written verdict approximation: `TEST262_TARGET=standalone`,
`TEST262_PATH_FILTER_FILE=<normalized exact map>`, official scope only,
`TEST262_WORKERS=1`, `COMPILER_POOL_SIZE=1`, `VITEST_MAX_FORKS=1`, and the
pinned QuickJS artifact
`/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`. Keep one compiler/test
worker for this lane and at most two globally. Disable history publication for
the scoped run. Preserve the timestamped JSONL, report, per-shard completion
manifests, source commit, filter hashes, command, and elapsed time in this
tracker before making any claim.

Completeness is a hard gate, not an inference from Vitest's console summary.
The final report must reconcile exactly 11,704 registered tests, 11,704 started
callbacks, 11,704 settled callbacks, 11,704 physical canonical rows, and
11,704 unique selected paths, with no duplicate, malformed, outside-filter, or
missing row. The acceptance result is exactly **11,704 pass / 11,704 total, 0
fail, 0 compile_error, 0 compile_timeout, 0 skip**, with every passing module
host-import free. Any other result keeps this umbrella in progress.

If non-pass rows remain, cluster only this fresh integrated-head artifact by
stable error signature and provider boundary. Root first updates or allocates
one repository-local `plan/issues/*.md` tracker per bounded cluster (new IDs
only through `node scripts/claim-issue.mjs --allocate`), records its exact path
set and implementation plan, and only then fans implementation to Luna Max
agents in separate provisioned worktrees. Each completed fix gets one
mergeable non-draft upstream PR from `ttraenkler/js2`; a genuinely incomplete
or non-mergeable checkpoint alone may remain draft. The dedicated PR shepherd
owns exact head/body/repository/readiness/check/conflict/queue verification.
No GitHub issue is created.

## Cross-realm is 103 of the remaining 1,401 rows — and the shim is the reason (2026-09-16)

Measured on the standalone baseline fetched 2026-09-16 10:46 UTC
(ES2015 `10,303 / 11,704 = 88.0 %`, 1,401 non-pass):

| slice of the remaining 1,401 | rows |
| --- | --- |
| path or body mentions a realm | 103 |
| of those, satisfiable if `$262.createRealm().global` aliased the current global | 91 |
| of those, genuinely need two DISTINCT realms (`notSameValue`, or two realms in one test) | 12 |

**Why they fail today is a harness fact, not an engine fact.**
`tests/test262-runner.ts:2331` returns `const realm = {}; realm.global = realm`
— an empty object. So `$262.createRealm().global.Symbol` is `undefined` and the
row dies in the harness prologue ("Cannot access property on null or undefined
at 330:38"), before it tests anything about the compiler.

Meanwhile the COMPILER already assumes the opposite shim: the #3371 arm in
`src/codegen/property-access-dispatch.ts:327` says in so many words that "the
original Test262 realm shim deliberately aliases `$262.createRealm().global` to
the current native global", and `proxy-value-provenance.ts:200` carries a
matching alias resolver. Two narrow shapes are special-cased there; the general
property read off a realm global is not.

**Do not "fix" this by aliasing the shim.** Pointing `realm.global` at
`globalThis` would flip ~91 rows to pass without the engine gaining any realm
support at all — the rows exist precisely to check that a second realm has its
OWN intrinsics, and the 12 that check distinctness would keep failing while
their 91 siblings passed vacuously. That is the "a floor that is too low never
fires" failure mode this file already warns about, pointed at the pass rate
instead of at a gate.

The honest options, in order of cost:

1. **Genuine realm support**: `createRealm()` instantiates a SECOND instance of
   the compiled module and hands back a `global` backed by that instance's
   intrinsics. Two instances of one standalone module are independent by
   construction, so the distinctness assertions would be true rather than
   arranged. This is the only option that earns the 103 rows.
2. **Quarantine**: count the realm rows as unsupported-by-design and report the
   ES2015 rate with and without them, so the number stops implying a capability
   that is not there.
3. **Leave them failing** (the status quo): honest, and the 103 stay as a known
   7.3 % ceiling on the remaining work.

This is a stakeholder decision, not an implementation detail — it changes what
"100 % ES2015 standalone" can mean. Recorded rather than decided.

## 2026-09-18 — the remaining ES2015 gap, ranked by whether HOST already solves it

The whole remaining gap has been treated as one undifferentiated pile. It is
not. Splitting it against the host lane separates work that is a **port** from
work that is **new engineering in both lanes**, and the two cost wildly
different amounts. This is the ranking to dispatch from.

**Provenance, so nobody restates this as fresh later:** standalone side is the
`baseline-pre-wave.jsonl` full standalone run of 2026-09-17; host side is the
authoritative PR-gate baseline fetched to `.test262-cache/test262-current.jsonl`,
internal timestamp 2026-09-17 11:17, `oracle_lane: linked-harness`,
`oracle_version: 14`, 38,498 pass. Both same-day, so they are comparable.
Taken **before** the three PRs that merged on 2026-09-18 (#5968/#6493,
#5969/#6494, #5970/#6500+#6501), so the counts are a low-water mark by roughly
a dozen rows. Edition classification is `scripts/generate-editions.ts`.

| ES2015 standalone | rows |
| --- | --- |
| non-pass | **1,401** |
| — host **passes** → MIRRORABLE (standalone-only gap) | **559** |
| — host **also fails** → dual-lane, new work in both | **842** |
| — absent from the host baseline | 0 |

### Top clusters by mirrorable rows

| mirror | dual | cluster |
| ---: | ---: | --- |
| **86** | 24 | `built-ins/RegExp/prototype` |
| 38 | 41 | `built-ins/TypedArray/prototype` |
| 32 | 79 | `language/statements/class` |
| 26 | 24 | `language/expressions/generators` |
| 19 | 28 | `language/expressions/class` |
| 17 | 39 | `language/expressions/object` |
| 16 | 35 | `built-ins/Array/prototype` |
| 14 | 10 | `built-ins/String/prototype` |
| 13 | 11 | `built-ins/Function/prototype` |
| 13 | 4 | `built-ins/Proxy/construct` |
| 12 | 4 | `built-ins/TypedArrayConstructors/internals` |
| 12 | 7 | `built-ins/ArrayIteratorPrototype/next` |
| 12 | 19 | `language/statements/generators` |
| 9 | 0 | `annexB/built-ins/RegExp` |
| 9 | 3 | `built-ins/Proxy/defineProperty` |
| 8 | 36 | `built-ins/Promise/all` |
| 8 | 23 | `built-ins/Promise/race` |
| 6 | 53 | `language/statements/for-of` |
| 5 | 0 | `built-ins/{Set,Map}IteratorPrototype/next` |

### How to read this, and how NOT to

- **A high `mirror` count is the cheap work.** Host already performs the
  behaviour correctly, so the standalone fix is "find what the host path does
  that the standalone path skips" rather than "derive the spec from scratch".
  `annexB/built-ins/RegExp` (9/0) and the two iterator-prototype clusters
  (5/0 each) are pure ports with no dual-lane residue at all.
- **A high `dual` count is NOT a reason to avoid a cluster** — it is a reason
  to plan it as real engineering and size it accordingly.
  `language/statements/for-of` (6 mirror / 53 dual) and
  `built-ins/Promise/all` (8/36) are mostly genuine missing semantics.
- **`mirror` is an upper bound on the port, not a promise.** A row can pass in
  host for a reason standalone cannot reuse (a host object, a host import).
  Confirm per cluster before committing, the way #5198 did below.
- **Do not read the totals as current.** They predate 2026-09-18's merges.
  Re-derive with the two baselines above rather than quoting these numbers
  forward.

### Worked example — this ranking was validated on `RegExp/prototype` first

The 190 rows under `built-ins/RegExp/prototype/Symbol.{match,replace,search,split}`
were run on both lanes on `origin/main` `a8b8dfc180`:

| lane | pass | non-pass |
| --- | --- | --- |
| host (gc) | 149 | 41 |
| standalone | 86 | 104 |

Of the 104 standalone non-pass, **64 pass in host** and 40 fail in both — the
same shape this table predicts for the cluster. That split then changed the
plan materially: the `exec`-override mechanism carries 43 standalone rows, but
only **17** of them pass in host, so 26 are dual-lane and not portable. The
first slice's honest target fell from 43 to **9**. See #5198.

The lesson worth keeping: **measure the host side before sizing a standalone
slice.** Without it, a mechanism's standalone row count reads as the
deliverable, and it is not.

## 2026-09-20 post-sync execution handoff

The coordinating branch includes upstream `62221769a8`, incorporating the
merged documentation PR 5997 and a differential baseline refresh. No compiler
change arrived between the earlier `200f7e2c8b` slice receipts and this sync.
The dirty shared main checkout was not modified.

- Normalization implementation is assigned to the isolated #5152 normalization
  worktree. Its fresh isolated standalone baseline at `c47fcc7c081a`
  (including upstream `62221769a8`) finished **11 pass / 3 fail / 14**,
  with no skips or runner errors. The terminal log is
  `/private/tmp/js2-5152-normalize-baseline-20260920.log`, SHA-256
  `80213e5772351e05607389dcba81b034a62602e00892035a2c98e8472182aa99`.
  Only the three `return-normalized-string*` originals failed. The recorded plan requires full
  Unicode-17 transformation and official normalization-corpus coverage, not
  merely repairs for the three known originals.
- The #5198 RegExp lane has 49/55 focused pins passing after the conditional
  argument-slot correction. Its next descriptor probe must distinguish
  physical value mutation from changed read/storage routing; the six red pins
  are not six independent proven defects.
- #5269 Symbol probes are separate from the completed #6484 iterator slice.
  The isolated Symbol implementation now improves the identical two-original
  manifest from **1 pass / 1 fail** on upstream `62221769a8` to **2 pass**,
  using the same `run-test262-paths.mts --isolate --standalone` command.
  Baseline and candidate logs are respectively
  `/private/tmp/js2-5269-symbol-matched-base-terra-20260920-isolated-baseline-pair-20260920.log`
  and `/private/tmp/js2-5269-symbol-controls-terra-20260920-matched-isolated-candidate-pair-20260920.log`.
  This is not yet a completed fix: a subsequent ordinary control for a Symbol
  returned by object-to-primitive conversion fails its value assertion
  (**5 instead of 7**), while the other 11 assertions pass (including three
  explicitly expected, baseline-confirmed later-edition accessor failures).
  Its terminal log is
  `/private/tmp/js2-5269-symbol-controls-terra-20260920-postprimitive-control-baseline-20260920.log`.
  The agent owns a consumer-specific coercion correction; do not change
  global `String` behavior or count the later-edition accessor diagnostics
  as ES2015 gains. Local production edits are permitted in the isolated
  worktree after published-hunk review; fresh IR overlap review remains
  required before integration, and unpublished remote IR work is not known.
- A one-shot publication read finds PR 5996 open, ready and mergeable at
  `9e7ea9471ae0f0efd22293f09badfe6c1432760e`, with no merge commit. Quality,
  issue tests and equivalence checks succeeded, but the Test262 shard jobs
  were skipped. Neither the PR's green summary nor the local slice receipts
  prove a new full ES2015 census.
- The completed anonymous-delete and iterator branches remain local at
  `ead8e8520a` and `0ab8d03e0d`. Publication was denied before execution;
  renewed authorization is pending. Prepared PR descriptions now explicitly
  distinguish successful targeted validation from the outstanding final
  normal pre-push gates. No denied push was retried through another route.

The full standalone goal remains unachieved. Retain the edition/discovery
scope caveat and do not add local slice gains to the historical global pass
count without a fresh authoritative census.

### Follow-up review: call evaluation and optimized reads

The Symbol and normalization owners must preserve complete argument-list
evaluation before builtin coercion. Source review found that the direct
Symbol call forwards its arguments untouched to `compileSymbolCall`, whose
native implementation currently evaluates only the description. Its outer
static-Symbol rejection also precedes later argument evaluation. The existing
normalize implementation similarly throws for a statically invalid form
before evaluating its receiver and ignores later arguments. Each owner is
adding ordinary side-effect/order/abrupt-completion controls while replacing
these call paths; these observations are source evidence, not yet measured
Test262 gains.

A native Node v24 reference check establishes the expected traces for those
new controls (not evidence about js2 execution): `Symbol(descriptionObject,
extra())` records `extra;convert;`; a Symbol-valued first argument still
records `extra;` before `TypeError`; and
`getReceiver().normalize("bad", extra())` records `receiver;extra;` before
`RangeError`. Compile, zero-import, and runtime assertions must remain outside
any expected-value failure wrapper when measuring the corresponding js2 pins.

The RegExp reader correction needs a matching optimization guard: the
`member-get-inline-ic.ts` call-site rewrite can replace the corrected generic
getter with a physical numeric-field read. The isolated owner is validating
a native-RegExp/`lastIndex`-specific decline, preserving ordinary field
optimizations. This is distinct from the dispatcher's own optional inline
cache, which was investigated and ruled out for the failing carrier.

Verified follow-up receipts:

- RegExp's optimized-default reader selection improved from **6/8 to 7/8**
  after that specific decline. Raw null/undefined aliases now pass; the
  aggregate object-identity-after-lock control still fails. The selected run
  skipped the other 56 tests, so this is not a full-suite result. Log:
  `.tmp/5198/lastindex-member-get-inline-decline-focused-20260920.log` in the
  isolated RegExp worktree.
- Symbol's split ToPrimitive/primitive-ToString path and trailing-argument
  evaluation now pass **9 ordinary ES2015 controls**. One supplementary
  accessor control also passes; three baseline-confirmed accessor failures
  remain explicitly expected value assertions. Thus the harness reports
  13 green assertions, not 13 new ES2015 passes. Log:
  `/private/tmp/js2-5269-symbol-controls-terra-20260920-postprimitive-and-argument-order-candidate-20260920.log`.
  Source SHA-256 is
  `9ad3122360e16d7e99d732e542592a23a0c5e6c2fb216ab069c890ad1d425c9f`;
  test SHA-256 is
  `05a06c36348667e653227e4889e11ff729eebd72aba1a8399ee9b7f9fa424118`.
  The original Test262 pair and broader Symbol neighborhood must be rerun
  after this new source change before carrying forward prior pass claims.

The subsequent Symbol retention rerun completed **2/2 original Test262
passes** on that same source SHA, using the identical isolated standalone
runner and manifest. Log:
`/private/tmp/js2-5269-symbol-controls-terra-20260920-final-matched-isolated-candidate-pair-20260920.log`.
An added primitive-rendering control also passes: the focused harness now has
**10 ordinary ES2015 controls + 1 supplementary pass + 3 expected accessor
failures**, with test SHA-256
`28083423263f6516e0a9b9906981bc3e0488491026db04011c64c2cdf6c19a33`.
Log:
`/private/tmp/js2-5269-symbol-controls-terra-20260920-final-focused-candidate-20260920.log`.
Broader neighborhood and repository gates remain outstanding; this does not
establish merge readiness or a full-edition pass count.

The frozen 19-row Symbol description/registry comparison subsequently finished
**baseline 13 pass / 6 fail; candidate 14 pass / 5 fail**. Only
`built-ins/Symbol/desc-to-string.js` changed verdict. The three remaining
semantic/runtime failures have identical reported signatures; two cross-realm
rows on both sides lack the QuickJS provider and remain infrastructure-unmeasured.
Manifest SHA-256:
`445b961b2e9f7baf4389f1feaba033e9fe1843a47a1bf94bfbd8e1a7aaf3215a`.
Logs:
`/private/tmp/js2-5269-symbol-matched-base-terra-20260920-description-registry-baseline-20260920.log`
and `/private/tmp/js2-5269-symbol-controls-terra-20260920-description-registry-candidate-20260920.log`.
The repository-supported provider recovery is being attempted separately;
matching missing-provider errors do not prove absence of regressions there.

Provider recovery subsequently completed in both isolated worktrees. Each
independently built and canary-verified its adapter using the pinned QuickJS
artifact `2e2d7736713beeda`. The two cross-realm originals now have measured
runtime verdicts: **baseline 0/2 pass; candidate 0/2 pass**, with the same
undefined foreign `Symbol.for` error. They are no longer infrastructure-unmeasured.
The measured realm handoff and exact provenance are recorded in
`4274-es2015-true-realms-runtime-ir.md`; implementation remains subject to the
parallel IR migration coordination hold. The description fix therefore has
one measured gain and no observed regression in this frozen 19-row comparison,
not proof of a full-suite result.

The Symbol candidate's subsequent TS7, LOC, and function-budget checks passed.
The coercion-sites gate rejected one new reference to the canonical
`__any_to_string` renderer. Its owner is documenting the scoped allowance and
rerunning the gate; this intermediate receipt is not merge readiness:
`/private/tmp/js2-5269-symbol-controls-terra-20260920-ts7-source-ratchets-20260920.log`.

The scoped-allowance rerun prints successful TS7, LOC, function, coercion,
and oracle results. Its dead-exports command prints two unknown dynamic-import
edges (`optimize.ts:394`, `platform-capability-adapter.ts:151`). The exact
command on pristine `62221769a8` prints the same edges and **exits 0**:
`/private/tmp/js2-5269-symbol-matched-base-terra-20260920-dead-exports-baseline-20260920.log`.
Thus the printed `moved-runtime gate: FAIL` is not alone evidence of a new
Symbol regression or nonzero command exit. The candidate composite's final
exit receipt was not captured; retain that verification gap rather than
inferring an exit status from its printed output.

RegExp's exact runtime-brand guard for plural `lastIndex` descriptor rejection
now passes **5 selected tests / 5**, with **64 unselected tests** in the
69-test file. The unchanged original aggregate and attribution mask are
included alongside illegal-accessor, legal-no-value, and ordinary-object
controls. Receipt in the isolated #5198 worktree:
`.tmp/5198/plural-lastindex-runtime-brand-guard-focused-20260920.log`.
This establishes the targeted sentinel-consumption correction, not resolution
of the separate post-lock alias-reader failure or the entire protocol suite.

Normalization's corrected implementation now passes its first emitted-code
smoke: **3/3 tests**, including the standalone five-bit Unicode/direct-reflective
matrix, a separate six-bit void-operator/void-returning-call effect matrix,
and host preservation. Both standalone fixtures assert an empty import list.
Receipt: `/private/tmp/js2-5152-normalize-smoke-rerun2-20260920.log`.
The original compile failure was a missing mandatory `then` array in the
Hangul decomposition emitter, corrected locally without changing IR traversal.
An intervening test-template syntax error executed no tests and is not counted.
The public expression wrapper already supplies undefined for void calls with
an expected externref; speculative caller fallbacks were removed after source
review, while regression controls remain. The frozen 14-original comparison
and full official Unicode corpus through emitted Wasm are still outstanding;
generator-table verification alone does not certify this implementation.

Symbol's final void-returning-description control passes without changing
production source: the expected-externref expression wrapper already emits
the undefined default after a void call. Final focused receipt is **15 green
harness assertions = 11 ordinary ES2015 passes + 1 supplementary pass + 3
baseline-confirmed expected accessor value failures**, terminal exit 0:
`/private/tmp/js2-5269-symbol-controls-terra-20260920-final-focused-void-candidate-20260920.log`.
The separately recaptured candidate dead-exports command also exits 0 with
the same two unknown dynamic-import observations as pristine main:
`/private/tmp/js2-5269-symbol-controls-terra-20260920-dead-exports-candidate-terminal-20260920.log`.
This closes the earlier missing command-exit receipt; ordinary commit gates
and publication are not inferred from these focused results.

The post-format Symbol gate chain now finishes **terminal exit 0**, including
TS7, lint, formatting, LOC/function/coercion/oracle checks, dead-exports,
staged changed-root tests (the 15-assertion focused file), numeric-local
parity, and issue integrity. Actual measured production SHA-256:
`d9ca35b538b04f7627144adf6b6265ee843ab58074252ef983283d10c1cc8e70`;
test SHA-256:
`69b36cfdf89073e2d98d9b7103f627bfcf070ef57ba341f604392e6f94a3a3b3`.
Receipt:
`/private/tmp/js2-5269-symbol-controls-terra-20260920-normal-scoped-gates-rerun-20260920.log`.
The production difference from the earlier measured SHA is formatting only;
this chain reran the focused tests on the actual formatted content. Commit
hooks and publication remain separate state transitions.

The Symbol commit attempt subsequently passed its hook chain but failed at
`git commit -S`: `cannot run gpg: No such file or directory`. No commit was
created. Read-only configuration checks in both isolated worktrees show no
configured `commit.gpgsign`, `gpg.format`, signer program, or signing key;
the memory describing `/tmp/code-sign` applies to a different container.
Inspection of the raw prior root checkpoint `3ab021e1064a0d97a6e8366a0f1ec386def338c1`
also shows no signature header, so it must not be described as signed.
The user has been asked whether to configure signing or permit unsigned
checkpoints. No security configuration was changed, no unsigned retry was
made, and no push was attempted. Both issue-document changes remain staged;
normalization testing continues independently of this commit blocker.

The frozen normalization comparison has now settled **baseline 11 pass / 3
fail → candidate 14 pass / 0 non-pass**, with the exact same 14-path manifest
and isolated standalone runner settings. The three named normalization
transform rows now pass and all eleven prior controls retain their passes.
Candidate log:
`/private/tmp/js2-5152-normalize-frozen14-candidate-20260920.log`;
base/head/runtime and seven measured production-file SHA-256s:
`/private/tmp/js2-5152-normalize-frozen14-candidate-20260920.txt`.
The authoritative denominator is 14; no skip/error row is being counted as a
pass. This is a measured three-row slice gain, not an updated global census.
Official Unicode-corpus execution, assigned-scalar identity checks, source
gates, commit, and publication remain outstanding for this implementation.

The subsequent numeric-only normalization adapter control passed, including
mutable native-string globals, surrogate barriers, and actual zero Wasm
imports. The one-instance official Unicode-17 corpus test then passed all
**400,680 relations across 20,034 rows**, verifying the loaded fixture arrays'
SHA-256 before compilation. Receipts:
`/private/tmp/js2-5152-normalize-ucd17-adapter-control-20260920.log` and
`/private/tmp/js2-5152-normalize-ucd17-corpus-20260920.log`.
The production hashes still match the frozen 14-original run; corpus-test
SHA-256 is `ba2ac6c2cbd97d425ad0026cea24949fcc0e143beffa067d1a298678564c4d8a`.
This supersedes the pending official-row execution above, but not the pending
UAX Rule-2 assigned-scalar identity test, repository gates, or full-edition
census. It is emitted-Wasm evidence, not just generator validation.

### 2026-09-20 matched shared String-call regression controls

Root ran the unchanged `tests/issue-2875-slice3-search.test.ts` and
`tests/issue-2875-transferred-proto-method-call.test.ts` on the frozen
normalization candidate and pristine `62221769a87acdc32759c656702eede64936feb5`
at `/private/tmp/js2-5269-symbol-matched-base-terra-20260920`. Both completed
**23 pass / 5 fail out of 28**, terminal exit 1. Search coverage is 18/23;
transferred-method coverage is 5/5 on each side. The same five reflective
search cases throw `WebAssembly.Exception` on both sides:

- `includes.call('abcabc', 'ca')` and `includes.call('abcabc', 'a', 4)`;
- `startsWith.call('abcabc', 'ca', 2)`;
- `endsWith.call('abcabc', 'ab', 2)` and `endsWith.call('abcabc', 'bc')`.

Both runs used Node 24 with `VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`, direct
`node node_modules/vitest/vitest.mjs run` with the two files, and
`--pool=forks --poolOptions.forks.singleFork=true --no-file-parallelism`.
Candidate tool session 83944 and baseline session 91211 are terminal. Exact
test SHA-256s match across worktrees:
`b27dc5f1c844ceb1e68053bc6b475eb0685e8f1c0761bd23796f503211efd040`
and `d3714591ac8ab6fd31fd68a930a23124f072507077075547f1acc4d37527948d`,
respectively. All seven candidate production hashes matched the frozen
normalization manifest during the protected run. This is no observed
regression in these 28 controls, not 28 passes; the five existing failures
remain work toward the full goal and were not converted to expected failures.

The RegExp raw-result preservation correction subsequently passes all six
focused controls, including the original 7/31 post-lock mask now reaching 31,
an opaque-any receiver, and ordinary numeric consumers. Its full protocol file
finishes **71 pass / 1 fail out of 72** and TS7 exits 0. The remaining numeric
alias test fails compilation with the IR selector/capability disagreement
`extern property write .lastIndex is capability-deferred`.
Receipts in the isolated #5198 worktree:
`.tmp/5198/regexp-exec-protocol-full72-after-postlock-carrier-20260920.log`
and `.tmp/5198/ts7-after-postlock-carrier-20260920.log`.
The failure was reproduced against clean upstream by the owner, but the test
itself is newly introduced on this branch (`be5ff8ec1f`), not an already-green
upstream test. Consequently this branch is **not merge-ready** while that
assertion remains red. It is retained unchanged and handed to the existing
#3518 IR prerequisite; the parallel IR migration files remain untouched.

Normalization's expanded UCD test file is now **4/4 green**, including the
numeric adapter, all 400,680 official-row relations, 1,120,992 Rule-2 scalar
identities, and 8,192 lone-surrogate identities. That is **1,529,864 measured
normalization relations**, excluding the adapter prerequisite. The assigned
inventory includes 297,334 scalars, of which 137,468 are private use; 17,086
Part-1 scalars are excluded from the Rule-2 identity loop, leaving 280,248.
The 2,048 surrogate code points are tested separately in all four forms.
Root independently counted the same assigned/private-use/surrogate totals
from pinned UnicodeData range endpoints. Receipt:
`/private/tmp/js2-5152-normalize-ucd17-rule2-20260920.log`.
Expanded fixture payload SHA-256:
`733ccbe5078c762ac50a176279f08219f8d1d110e991ccac5c2da4e517bb5833`.
All seven production hashes still match the frozen 14/14 original-test run.
This closes the pending Rule-2/surrogate validation above, not repository
gates, commit/publication, or integrated full-edition conformance.

### Upstream refresh and resumed validation — 2026-09-20

At the user's renewed sync request, `git fetch upstream main` succeeded.
`FETCH_HEAD` and `upstream/main` both resolve to
`62221769a87acdc32759c656702eede64936feb5`; the root working branch
`codex/4444-es2015-followup-20260920` already contains that commit (four
commits ahead, zero behind). No merge, stash, or shared-checkout mutation
was needed. Pending issue handoffs remain preserved.

The Symbol.keyFor child #6647 reports four passing and two failing focused
assertions. Its exact original `arg-non-symbol` remains zero pass / one fail
on both candidate and matched upstream: boxed Symbol rejection is still
incorrect. The no-argument focused control fails compilation in the existing
standalone builtin fallback. These are outstanding defects, not a Test262
gain. The owner released the test lease and continues source-only diagnosis.
Normalization now owns the exclusive test lease for normal repository gates;
the RegExp 190-original matched comparison follows it. The parallel IR
migration remains outside these implementation lanes. Signing and publication
blockers recorded above are unchanged by this fetch authorization.

The renewed selection audit reads the current edition map (SHA-256
`e2217d94c741e54f19bf4a5ac530b27544fc20176e3dccc1106475b398e37388`):
11,778 paths are labelled ES2015, all present in the local corpus. They comprise
6,871 language, 4,652 built-ins, 168 Annex B, 13 harness, and 74 Intl402 paths.
`TEST_CATEGORIES` in `tests/test262-runner.ts` includes the first four groups
but not Intl402. Thus the 11,704 historical discovery population does not
prove coverage of every mapped ES2015 path. The old external manifest
`/private/tmp/js2-es2015-11704-pr5008.txt` is absent on this machine; do not
treat that historical artifact as available input for a resumed census.
Regenerate and validate a current manifest before execution, retaining the
74-path discrepancy explicitly rather than silently excluding it from a
whole-goal completion claim. This audit ran no compiler and consumed no test
lease.

Normalization's post-format original-test rerun is terminal exit 0 and still
reports exactly 14 passes, with zero non-passes and no skip count. Root read
the durable receipt
`/private/tmp/js2-5152-normalize-frozen14-postformat-20260920.log` after the
owner confirmed session 71234 terminated. This supersedes the pre-format
result for the formatted candidate; normal repository gates remain in
progress under the same exclusive lease.

Post-format normalization smoke is terminal **3/3 pass**
(`/private/tmp/js2-5152-normalize-smoke-postformat-20260920.log`), and its
owner reports TS7 terminal exit 0 with no diagnostics
(`/private/tmp/js2-5152-normalize-ts7-postformat-20260920.log`). Root read
the smoke receipt. However, root's inspection of
`/private/tmp/js2-5152-normalize-lint-postformat-20260920.log` found that
Biome skipped the newly generated 2.2 MiB fixture because it exceeds the
1 MiB configured limit, despite the command's reported zero exit status.
This is missing lint coverage, not clean validation of that file. The owner
must resolve it with deterministic smaller generated modules or a genuinely
file-scoped supported exception and explicit validation; global limit
weakening is not authorized. Retain all corpus counts and payload identity
through any resulting fixture-only reorganization, then rerun its tests.

The normalization owner released the compiler lease with no live process;
RegExp now owns it for the frozen 190-path original-test A/B. Root independently
verified that all 190 paths exist and are unique, and that the unchanged
manifest SHA-256 is
`567987a2f7b705a318ce45a003c5bd8e05543a2b2da5718b6ab73dc430105890`.
The edition map classifies **181 ES2015 and 9 ES2018**, so report the two
populations separately; all 190 remain valuable regression controls.
Candidate HEAD `0a25740fe9be65486ae921573199e1adb7d81dc2` lacks three
upstream commits, but their only changes are the umbrella documentation and
`benchmarks/results/diff-test-baseline.json`. Its upstream source base therefore
matches clean baseline `62221769a87acdc32759c656702eede64936feb5` for
`src`, `tests`, `scripts`, package manifest, and lockfile.

Root verified candidate runner PID 21414 live at elapsed 01:28, not merely
inferred from a log file. The exact command/provenance is recorded in the
RegExp worktree's
`.tmp/5198/original-190-standalone-isolate-candidate-after-postlock-carrier-20260920.log`.
This is a live measurement, not a terminal verdict. Baseline execution follows
candidate completion; no other lane may start compiler work meanwhile.

Root independently audited the subsequent fixture split without importing the
compiler or starting tests: parsed numeric declarations from its wrapper and
four chunk modules reconstruct the identical canonical payload SHA-256
`733ccbe5078c762ac50a176279f08219f8d1d110e991ccac5c2da4e517bb5833`.
The data still comprises 20,034 rows, 100,171 cell offsets, and 205,047 scalar
values split into 51,261 + 51,262 + 51,262 + 51,262 elements. Rule-2 retains
280,248 inputs. All five modules are below 1,048,576 bytes; the largest is
the 1,021,416-byte wrapper. This verifies source-data preservation, not yet
Biome coverage or the post-split emitted-Wasm rerun.

The frozen RegExp candidate run is now terminal: **99 pass, 84 fail, 7 compile
errors, 0 skip out of 190**. Root read the terminal counts and verified receipt
SHA-256 `5bdebbaa4d122091bca4ea165563ff0021258f8247725df05045019259a7a886`.
Reconciliation of all 91 unique non-pass paths against the exact manifest and
edition map gives **ES2015: 97 pass / 77 fail / 7 compile errors / 181 total**;
the nine ES2018 controls are **2 pass / 7 fail**. These are candidate totals,
not improvement claims. The owner is proceeding with the already-authorized
matched clean-6222 baseline under the same exclusive compiler lease.

Normalization's split fixture subsequently passes explicit Biome validation:
`/private/tmp/js2-5152-normalize-ucd17-fixture-biome-20260920.log` reports
five files checked. Root compared the two generation hash manifests and found
them identical. The LOC/function gates now cover all seven changed production
files and pass using only issue-5152 allowances, including the generated
3,612-line Unicode table and its 852-line native instruction builder. Their
receipts are `normalize-{loc-budget,func-budget}-after-allow-20260920.log`
under the same `/private/tmp/js2-5152-` prefix. The dead-exports command's
informational moved-runtime/graph-closure failures at `optimize.ts:394` and
`platform-capability-adapter.ts:151` match the previously checked pristine
6222 diagnostics; zero exit status is not runtime-retirement certification.
Post-split compiler/runtime checks remain queued behind RegExp.

The matched RegExp baseline has now terminated with **86 pass / 95 fail /
9 compile errors / 190 total**, zero skips. Its receipt SHA-256 is
`5c9ace085a1b1be8bcd0cdf17c83b79fa47841aa029b706470946511457b92df` at
`/private/tmp/js2-5269-symbol-matched-base-terra-20260920/.tmp/5198/original-190-standalone-isolate-baseline-62221769-after-postlock-carrier-20260920.log`.
Root reconciled every non-pass path and the manifest: **ES2015 improves from
84 pass / 88 fail / 9 compile errors to 97 pass / 77 fail / 7 compile errors
out of 181**. All thirteen newly passing paths are ES2015 (eleven `@@match`,
two `@@search`); no baseline pass becomes a non-pass in the complete 190-path
cohort. `@@match/coerce-global.js` additionally changes compile-error to fail,
which is not a pass gain. The nine ES2018 controls remain 2 pass / 7 fail.

Both runner processes are terminal; the owner released the exclusive lease
and normalization now owns it for post-split runtime revalidation. The
RegExp branch remains unready because its separate full focused file retains
the new IR-capability failure described above; this thirteen-row original
gain does not waive that failure, prove whole-edition conformance, or establish
upstream integration.

Normalization's frozen post-split runtime sequence is complete: Unicode
conformance **4/4**, original Test262 slice **14 pass / 0 non-pass**, smoke
**3/3**, and TS7 terminal exit 0 with no diagnostics. Receipts under
`/private/tmp/js2-5152-` are respectively
`normalize-ucd17-postsplit-20260920.log`,
`normalize-frozen14-postsplit-20260920.log`,
`normalize-smoke-postsplit-20260920.log`, and
`normalize-ts7-postsplit-20260920.log`. Root read the nonempty test receipts;
TS7 terminal status was supplied by the process owner, not inferred from its
empty log. The exact tested files are frozen in
`/private/tmp/js2-5152-normalize-postsplit-candidate-20260920.txt`.
The owner released the compiler lease, now held by Symbol.keyFor for its
no-argument focused rerun and three-original matched comparison. Required
Unicode data attribution is a separate source-only packaging review and must
not be silently blended into the frozen receipt. Signing/publication remain
subject to the existing unresolved blockers.

Symbol.keyFor's no-argument rerun is terminal **5 pass / 1 fail out of 6**:
the omitted-argument TypeError now passes; the real boxed-Symbol assertion
remains red. The exact three-original candidate/baseline pair is **2 pass /
1 fail on both**, with byte-identical logs (SHA-256
`adcd3d78e39e2a09d4d2843c81a7b8227a83c3e82f69a03d9018e95cdea9a604`).
The remaining original failure is `Symbol/keyFor/arg-non-symbol.js` because
`Object(Symbol())` still lacks a distinct wrapper representation. Thus the
focused behavior improves but there is no original-row gain or merge-ready
claim. Issue #6647 retains the exact receipts and corrected wrapper plan:
observable `GetMethod(@@toPrimitive)` precedes any ordinary hint-ordered
conversion, and internal-slot recovery cannot bypass inherited overrides.
The owner released the lease to RegExp's exact-original route diagnostic.

The final normalization notice-bearing checkpoint also completes all four
validation groups: UCD **4/4**, exact originals **14/14**, smoke **3/3**, and
TS7 terminal exit 0. Final logs use the
`/private/tmp/js2-5152-normalize-` prefix and suffix
`-unicode-notice-20260920.log`, with group names `ucd17`, `frozen14`, `smoke`,
and `ts7`. The Unicode notice regeneration preserved the numeric payload and
remained below the fixture lint size limit. Fresh file hashes are recorded in
`/private/tmp/js2-5152-normalize-unicode-notice-candidate-20260920.sha256`.
The owner released the test lease and is preparing the scoped PR body without
bypassing signing or publication restrictions. RegExp now owns the short
exact-original numeric-call-mapping diagnostic; the prior compiled artifact
proved runtime failure and zero imports, but not which helper its callback
actually invokes. No fast-path admission change is justified yet.

The refined exact-original RegExp diagnostic now maps the missing operation:
the final `assert.throws` callback is numeric function 531 (`__closure_65`),
whose complete emitted body is `global.get 12; extern.convert_any; drop`.
It evaluates the subject but has no call route to matching, `__extern_toString`,
or the expected throw. Root verified that body and receipt SHA-256
`f65a4b772aaa6f304c31730b9c8489c8a8a878869efc815ffecb0576f1624478` in
`.tmp/5198/exact-original-symbol-match-coerce-arg-route-mapped-20260920.log`.
The original/assembled/WAT hashes and zero imports match the prior artifact.
This disproves the earlier compile-refusal explanation and motivates tracing
where call emission is lost; it does not yet establish which compiler stage
is responsible. The owner retains a bounded diagnostic lease, without changing
IR ownership or widening the fast-path gate as an unproven fix.

The subsequent emission trace now resolves the apparent contradiction: the
exact callback does enter legacy symbol dispatch, both protocol and native
arms decline, and the native arm specifically rejects the object subject at
its string-like admission guard. The dispatcher then calls `reportError` and
returns null, yet the final artifact still contains only the subject load and
drop. Thus the earlier observation disproved a *terminal compile error*, not
the existence of an internal refusal. Root verified trace SHA-256
`f1c2d403024d9e9f35bdc0e6e9d65d818d9ccdcf2ea99b6ec00d18d35354d693`
in `.tmp/5198/exact-original-symbol-match-coerce-arg-emission-trace-20260920.log`.
The owner is tracing the fallback once more, then restoring temporary tracing
before implementing narrowly verified `@@match` subject coercion. Other symbol
methods must not be admitted merely because they share this guard. Required
controls include exact original execution, successful object conversion,
observable conversion order, abrupt completion, Symbol rejection, and actual
zero-import standalone artifacts. The separate IR migration remains untouched.

Two parallel read-only audits identify additional work without claiming gains:

- Global `@@match`'s `g-success-return-val.js` gets numeric `index` zero instead
  of undefined. Its preceding own-property check passes. The native global
  producer deliberately returns a match-vector carrying index/input metadata,
  and the specialized typed reader exposes that metadata. The RegExp owner
  must coordinate producer, result provenance and global-variable inference;
  suppressing every match-vector read would regress non-global capture arrays.
- `Symbol/not-callable.js` stops at its first `sym()` assertion, so its other
  three call/construction assertions remain individually unmeasured. A factory
  initializer exception in the non-callable call guard is a hypothesis for the
  primitive case. The wrapper forms additionally require real standalone
  Symbol wrappers; changing the shared closure bridge is not a narrow fix.

A fresh fetch and fast-forward-only synchronization with `loopdive/js2 main`
confirmed upstream remains `62221769a87acdc32759c656702eede64936feb5`.
This handoff branch already contains that commit (four ahead, zero behind);
pending edits were preserved without stashing or changing another worktree.

The non-global `@@match` coercion preflight rejects a gate-only fix. In
`.tmp/5198/fast-native-match-coercion-preflight-retry2-20260920.log`, direct
cast-at-call controls give the expected result for ordinary object conversion
and abrupt marker propagation (2/2), but both a raw Symbol and an object whose
`@@toPrimitive` returns Symbol silently stringify instead of throwing (0/2).
All four compile with zero actual imports. These are diagnostic controls, not
original Test262 gains. The earlier retry1 did not preserve the raw argument
through its asserted declaration and cannot establish downstream behavior.
The existing `__extern_toString` route is therefore not a strict implementation
of this spec operation for the newly admitted domain. Implementation must first
perform observable `ToPrimitive(string)` once, reject a resulting Symbol with
TypeError, then convert the primitive to a string. The shared gate remains
unchanged pending that correction and focused validation; global matching and
other symbol methods cannot inherit an unverified admission widening.

The separate global-match result-shape audit found a wider required ownership
boundary before production edits. Changing the global producer from match-vector
to plain string-vector also requires function-local hoisting in
`src/codegen/index.ts` and matching variable handling in
`src/codegen/statements/variables.ts`. Top-level declarations already delegate
their inference to the RegExp helper, so `declarations.ts` itself need not
change. The reflective caller in `string-proto-match-search.ts` also consumes
the shared helper and must be updated if its return type changes; excluding its
tests would not make an incompatible helper ABI safe. That lane remains
source-only pending confirmation that the local-hoisting files do not overlap
the other machine's active IR migration. The independent non-global coercion
fix can proceed within `regexp-standalone.ts` without those ownership changes.

The user subsequently confirmed: "These inference areas are clear to change."
The global-match lane is therefore authorized to implement the coordinated
producer, reader, local-hoister and reflective-caller change in its separate
worktree. This clearance covers the specified inference sites, not IR
implementation or layout changes. Its compiler validation remains queued behind
the current Symbol probe lease; no additional original-row gain is claimed.

### 2026-09-20 publication authorization and verified deliveries

The user explicitly renewed completed-branch publication permission: push to
`ttraenkler/js2`, with fallback to feature branches on `loopdive/js2` if needed,
and permit unsigned commits for these fixes. Neither authorization permits a
direct push to `main`, bypassing repository hooks, or manually merging PRs.
The previously recorded signing/egress blockers no longer apply to this work.

Two completed fixes are now published upstream, both ready (not draft) and
verified `MERGEABLE` when created:

- Unicode normalization: PR [#5999](https://github.com/loopdive/js2/pull/5999),
  fork head `15e401c8208266e1143f903b9428588920abbe38`. The final 15-file
  source/test/generator hash manifest still matches the validated checkpoint.
- Anonymous true-expando deletion: PR
  [#6000](https://github.com/loopdive/js2/pull/6000), fork head
  `b74e1c833deb38444ba59940e62b242b594ef52e`. The publication merge contains
  upstream `62221769`; its source/tests are unchanged from tested `ead8e8520a`.

Both normal pre-push chains completed, including typechecking, lint,
formatting, oracle/coercion ratchets, numeric-local parity **18/18**, and
issue integrity. Remote branch SHAs were verified directly. An existing
shared Git config lock prevented local tracking configuration after successful
pushes; the lock was left untouched and did not prevent publication. The
deletion lane first corrected local pnpm/biome command resolution and reran
the full hook; those environment failures are not passing gate receipts.

A passive shepherd owns the two PRs. Mergeability and local gates are not
claims of completed CI, merged integration, or a new overall ES2015 rate.
The completed iterator and Symbol-description slices have the next serialized
publication slot. The new global-match implementation is held before source
edits so publication of validated work takes priority; non-global strict
coercion remains unvalidated and must not be presented as merge-ready.

The next completed slice is published as ready, mergeable PR
[#6001](https://github.com/loopdive/js2/pull/6001), iterator arguments-length
coercion, with exact fork and PR head
`9e50fe3a01d2c88748f48a7f1e7ead32a7c9995e`. The local tracking-config failure
again did not indicate push failure: direct remote verification proved the
branch landed, preventing a duplicate push. The publication owner's redundant
manual format run lacked a retained final receipt and is not cited as a pass.

The first passive CI read found a concrete PR #5999 quality failure:
`normalize-native.ts`, `normalize-tables.ts`, and
`string-proto-normalize.ts` lack compiler-boundary inventory classifications.
The owner is adding the required exact module classifications, without
weakening the verifier or altering normalization semantics. Test262 jobs
skipped/cancelled after this quality failure provide no conformance result.
PR #6000's CI was still pending at that observation. No PR is counted as a
merged integrated gain until upstream ancestry and fresh test evidence prove it.

Symbol descriptions are also published: ready PR
[#6002](https://github.com/loopdive/js2/pull/6002), exact fork head
`5be42ee36831927600a6256ec6450c366f57b64f`. Both #6001 and #6002 explicitly
report `mergeable: MERGEABLE`; `mergeStateStatus: BEHIND` is a freshness signal,
not evidence of a conflict or grounds to mark these completed fixes draft.

The normalization boundary repair is committed as `e787f5f197` and pushed
with upstream synchronization at
`20c3edc29d0f8ce45d506b9e067330019897e773`. The exact three inventory entries
pass the targeted static gate (`inventoryValid: true`, errors empty, 1,470
modules); the architecture still reports incomplete, not falsely complete.
Normal pre-push gates passed again. Root verified the post-sync smoke log at
`/private/tmp/js2-5152-normalize-smoke-postsync-20260920.log`: **3/3** pass.
The exact 14-original run remains pending at this checkpoint. This repairs
the observed CI cause; fresh CI success is not inferred from a local pass.

The subsequent post-sync original run is terminal **14 pass / 0 non-pass**,
verified in `/private/tmp/js2-5152-normalize-frozen14-postsync-20260920.log`.
It uses the unchanged frozen manifest SHA-256
`027e4b21d7fd72e77e419c2bd758e30a9498b70eafd2aa344daef2c2856ec76e`
and the maintained standalone runner with fresh isolation per original.
The first sandbox invocation failed before any row on a tsx IPC permission
error; the escalated successful retry, not that setup failure, is this receipt.
No source changed during the post-sync validation and the published head
remains `20c3edc29d0f8ce45d506b9e067330019897e773`. The test slot is released
to the existing RegExp worktree's narrow strict-coercion validation. Creating
a separate coercion branch remains pending the requested split approval.

The strict non-global RegExp subject implementation now has its first measured
original result: `Symbol.match/coerce-arg-err.js` passes **1/1** via the
maintained standalone isolated runner, where the earlier exact artifact failed
without invoking conversion. Root read the new log
`.tmp/5198/coerce-arg-err-strict-subject-original-20260920.log`, SHA-256
`9c564ff79bba501370a0917566487437c673c73c10c02008b5c171d0a2fdac1e`.
The seven selected new controls also pass (**7 selected / 79 total**, 72
unselected), covering object conversion, abrupt completion, raw/result Symbol
rejection, nullish and void values, and the unchanged global string path.
The earlier filter invocation selected zero tests and is explicitly invalid
as acceptance evidence. These new results do not resolve the separately
recorded full-file IR failure or prove a 190-original regression sweep.

Full-census preparation against upstream `ea8d7f87` confirms the refreshed
edition map SHA-256
`9193b4d0fbbd7b7ee4df8b5f74afc866906de43ae7f62bd16e1079efa5e43fc1`
still contains **11,778** unique existing ES2015 paths. Default category
discovery omits 74 Intl402 paths; a paths filter cannot add undiscovered files.
The maintained `test:262:fyi` full recursive discovery covers all mapped paths
and accepts `--target standalone --paths-file <exact-manifest> --json <output>`.
Its authoritative preflight requires Node 25 and Unicode 17. Prepare that
runtime separately, then derive and validate the exact sorted manifest from
the eventual integrated map; do not reuse a missing historical temporary list
or use the non-authoritative smoke flag to claim full acceptance. This FYI
artifact is not a replacement for committed CI-baseline JSONL.

The authoritative FYI runtime is now available task-locally at
`/private/tmp/js2-4444-node25-fyi.7D1w1C/node-v25.9.0-darwin-arm64/bin/node`.
The official Darwin arm64 archive matched the Node release SHA-256 manifest:
`e479f3c469d3d9303a44f00a8ea37a3788395d171bb8059c48a4bbbd2e371b59`.
The maintained preflight reports `v25.9.0 / Unicode 17.0`
(`test262-fyi-node25-unicode17-v1`). Provisioning changed no global runtime,
repository dependency, compiler source, or test verdict. The full census has
not started; run it on the reconciled integrated source with a newly verified
complete manifest rather than treating runtime readiness as conformance.

Strict `@@match`'s next bounded checks are terminal and root-read:
Node 24 existing protocol controls **8 selected pass / 79 total** (71
unselected) and direct non-global native controls **3 selected pass / 14 total**
(11 unselected). Their log hashes are respectively
`75af07f2bc79feb52026311cc3139ee59e961c831622563d0bbe2170c8dff9f2`
and `703963376e30caf20f1fde600063632750690d6dae34b53e2065a48ab389e8db`.
The exact original independently passes **1/1 on Node 25**, using the same
manifest SHA-256
`ea762af3e0ca5aafc32ba88f9a5de56ab3a5ce59c2f627d9e4a021c4de66cdcb`.
Keep that Node 25 confirmation separate from the Node 24 cohort, and keep the
unfiltered branch's known IR-first red explicit. The owner released the test
slot; selective branch separation remains awaiting approval, not silently done.

The primitive-Symbol call investigation now corroborates its proposed guard
seam with a single terminal diagnostic, rather than source inference. Both
checker backends report `fact=symbol`, `static=symbol`, no call signature,
and a `Symbol(...)` call-expression initializer, then take the initializer
bailout. The resulting callback calls `__apply_closure`, drops its result,
and continues instead of throwing. Receipt:
`/private/tmp/js2-5269-symbol-route.nq9jp5/probe.log`; the two WAT artifacts
match SHA-256
`b01f564f2dfd845e5021f34aab5e2ee1732de26f6f28d20a1b98aa8c8ed6cd4a`.
Temporary tracing was removed and the original guard file hash restored.
This authorizes the narrowly planned primitive-call correction and controls,
not a runtime-wrapper shortcut or a claim that the four-form original passes.
