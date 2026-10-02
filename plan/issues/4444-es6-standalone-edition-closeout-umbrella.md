---
id: 4444
title: "UMBRELLA: ES6 (ES2015) standalone close-out → 100% (discovery scope audit open)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-09-28
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

## 2026-09-28 census handoff: 24 of 128 frozen shards complete

The maintained standalone runner has completed indices 0–23 at frozen source
`f924650c6c26237f62b08a362d7003d4d2b1e12d`. Across the accepted receipts:
**2,191 unique original paths: 2,052 pass, 117 fail, 22 compile errors**.
The original 11,778-path scope is unchanged; **9,587 paths remain unmeasured**.
These are frozen-baseline observations, not current-main or post-fix results.
No landed fix has been subtracted from these counts.

The execution ledger is preserved at
`/Users/thomas/.codex/worktrees/manifest-baseline/js2/.tmp/4444/es2015-fullscope-128-execution-ledger.json`.
All 24 accepted JSONL and completion-file SHA256 hashes were independently
checked; all recorded identities are unique members of the exact manifest
(`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`).
Each shard passed the maintained completeness validator. No scope exclusions
or manual conformance retries were introduced. The tracked census contract is
`plan/agent-context/4444-es2015-fullscope-census-128-ledger.json` in that checkout.

Latest terminal runs, each with 92 registered/verdict identities and zero
explicit exclusions:

- Index 19: 87 pass, 5 fail, 0 compile errors; session 45884 exited 1 in
  88.21 seconds. JSONL SHA256
  `d8f4dea2db07da02a15c941201b29c62fdf75cdad41830edcbe5dcb42f9bebfd`;
  completion SHA256
  `910ffd23edf8152b4cd4f7751ff310fbe5e92de3032ee2ce67700169111079a5`.
- Index 20: 89 pass, 3 fail, 0 compile errors; session 30282 exited 1 in
  88.06 seconds. JSONL SHA256
  `0e82bf826b14b6bb9b914e0372aa36bd09f9a4fc10777374fc225cb8ebdd7f9b`;
  completion SHA256
  `9ecb7ba984020a959ba29c35ffa76af1b8350ac5552cad0e8d1523258bec170b`.
- Index 21: 88 pass, 4 fail, 0 compile errors; session 68795 exited 1 in
  82.82 seconds. JSONL SHA256
  `5ce659b0ed3f7c13f2a3edce92c340f9432d3ba28b0b9f88e401a246128be397`;
  completion SHA256
  `d77bc261a3e6003cabb1d483fff32533edf4207fed834e1ff4b48d4c9fddc0ad`.
- Index 22: 84 pass, 6 fail, 2 compile errors; session 27808 exited 1 in
  87.68 seconds. JSONL SHA256
  `36d4b9856c67b47bb6228940a76f0d48d1a7f314102e759da9d17aa1a8173f17`;
  completion SHA256
  `2d556c49b8369c55c36e29fed8d7d51ab9733108b5c2795dd2effdb145ced471`.
- Index 23: 81 pass, 7 fail, 4 compile errors; session 35200 exited 1 in
  90.92 seconds. JSONL SHA256
  `52566527b0450a9ac4a894c457656d49cb40faca5dfaecd9aab5501e90fb5c03`;
  completion SHA256
  `50bec60527d78ac9b4e2c1c06a74591c6368c0e30414f1553c06c77b13ac8a71`.

Newly observed failures remain in scope, including proposal paths already
present in the frozen manifest. Triage routing is not root-cause attribution:
`Array.prototype.concat_large-typed-array.js` is already listed under #4446;
WeakMap's `iterator-item-second-entry-returns-abrupt.js` belongs with #5151's
iterable-construction follow-up; Iterator `chunks/non-constructible.js` and
`chunks/return-is-not-forwarded-after-exhaustion.js` belong with #5147's helper
semantics. `language/statements/class/subclass/builtins.js` fails its first
Uint8Array-subclass length assertion (2 instead of 10), before the later byte,
prototype, and brand assertions; no inference about those later checks is valid.

Read-only Iterator follow-up at `27d215fb9e`: the `chunks/non-constructible`
original stops at its first assertion, `new iter.chunks(1)`, so the later
`new Iterator.prototype.chunks(1)` and subclass form are not measured by this
failure. Lazy-helper lowering handles calls, while the reflected
`ITERATOR_PROTO_METHODS` list omits `chunks`/`windows`. #5147 already identifies
nonconstructable prototype-closure seeding as unfinished. A dynamic-member
constructor no-match is a source hypothesis, not an emitted-route proof.
Before choosing a repair, capture each original constructor form separately
while retaining the original full test as acceptance, and preserve callee and
argument side effects plus shadowing. Shared `new-super.ts`/prototype glue
ownership must be cleared before edits; no new implementation claim is made.

Index 21 also reconfirms the existing #5156 cluster G residual
`test/built-ins/Date/prototype/toJSON/to-object.js`: the runtime reports
`Date.prototype.toJSON is not yet implemented in --target standalone`.
Source inspection at `732d9f75e6` matches an unwired reflective body:
`array-object-proto.ts` delegates Date members to `emitDateProtoMemberBody`
and `emitDateReflectiveSetterBody`; both decline `toJSON`, and
`native-proto.ts` supplies the catchable refusal. This is not evidence that
the direct Date formatter path is missing. The unchanged test first checks
undefined/null rejection, then successful calls with boxed number and Symbol
receivers and prototype-provided `toISOString`; a blanket TypeError can make
the negative checks pass while still violating the positive cases. Keep all
four assertions when reproducing against current upstream. Reuse #5156's
generic ToObject/ToPrimitive/Invoke plan and clear shared glue ownership before
implementation; do not reopen completed Date getter/formatter slices or
replace this generic method with a Date-brand-only implementation.

Next: resume index 24 using the same pinned compiler/provider/corpus and
serialized execution slot; retain handles through terminal completion and
validate completeness before accepting rows. Reproduce candidates against
current upstream before implementation, preserve each original assertion,
and record plans in the corresponding issue. Final acceptance still requires
all 11,778 original paths passing on the final source under the maintained
standalone runner, with complete identity accounting and no exclusions.

## 2026-09-28 implementation plan: exact-manifest discovery

The implementation is routed to dedicated issue
`plan/issues/6712-test262-exact-manifest-discovery.md`, claimed on upstream's
assignment ledger by `ttraenkler/codex-es2015-manifest`, branch
`codex/6712-exact-manifest-discovery-20260928`, based on
`359c2d63b6753e0c540b8761d13647b00e24a9a4`. This owns runner discovery and
its tests only, not #6651's compiler clusters or the other session's IR work.
The umbrella's overlap gate returned STOP for active compiler subissues; no
implementation proceeded under that result. The dedicated issue's gate
returned CLEAR, and the earlier `4444:manifest-discovery` claim is superseded.

The prior read-only audit reconstructed the frozen 11,778-path ES2015 index
set with SHA256
`f2fdd4e4544a44608f0b53d89d343526cfa9c9044ca263e860da949dc1a2f59f`
(sorted paths without `test/`, newline terminated). The default runner
discovers only 11,704 of them: all 74 omitted paths are under `intl402`.
Default category discovery and a subsequent path filter cannot execute a
path that discovery never selected. This is a coverage defect, not 74 measured
runtime failures. Do not remove those paths, change their edition labels,
or call 11,704/11,704 completion of the original goal.

Implementation sequence:

1. Reconfirm the pinned corpus/index identity on this base and preserve the
   exact full-goal manifest as an auditable artifact. Fail on stale or missing
   input rather than silently regenerating a smaller scope.
2. Add a narrowly isolated explicit-manifest discovery mode to the maintained
   runner. Resolve actual original corpus files from that exact set, including
   otherwise undiscovered categories. Preserve default category discovery for
   existing callers; do not add bare `intl402` (which would add 3,357 paths
   across many editions). Choose one clearly documented manifest input and
   reject ambiguous selection options.
3. Validate canonical corpus-relative paths, duplicates, traversal/escape,
   missing files, and fixture-only entries. Fail visibly before execution on
   invalid input. Route the selected original files through the existing
   filtering, sharding, execution, and result machinery without changing its
   verdict rules or semantic lane.
4. Connect the exact expected manifest to completeness validation. Verify set
   identity and registered/verdict/started/settled counts; an omitted file,
   duplicate, truncated run, or empty selection must not appear successful.
5. Add focused discovery and completeness tests, including an Intl positive
   control that default discovery misses, unchanged default behavior, and
   negative controls for malformed/incomplete input. Prove selection of all
   11,778 paths, including the exact 74 restored paths, independently of any
   runtime pass claim. Under the shared execution slot, run a small maintained
   whole-assembly control containing both ordinary and Intl original files.
6. Run normal quality gates and open a separate upstream PR for this runner
   fix. Record hashes, commands, outcomes, and any remaining blockers here.
   Discovery success alone does not establish a 100% ES2015 pass rate; the full
   manifest must subsequently complete with zero non-pass verdicts.

Expected ownership: `tests/test262-shared.ts`, a small path-selection helper
if needed, directly relevant runner scripts/docs, focused tests, and this
issue. No compiler, IR, registry, runtime provider, edition-index, baseline
counter, or workflow changes are authorized by this slice. Coordinate the
test/build slot before execution; other sessions have live local tests.

### 2026-09-28 measured discovery and next runtime census

Issue 6712's exact-manifest helper resolved all **11,778 unique original
paths**, including **74 Intl paths**, against corpus
`b363f29d3c43c626dc852744ad64a0b48a003693`. Every selected path is tracked
at that revision and no tracked corpus file is modified. Unrelated untracked
probes and symlink directories remain preserved outside the selection; the
corpus is not globally clean. The canonical `test/`-prefixed manifest SHA256 is
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.

The maintained standalone dynamic chunk (index 0, total 1) completed a
two-original control at source base `359c2d63b6` with the issue 6712 runner
changes: **1 pass / 1 fail**, two registered/verdict/started/settled identities,
and zero exclusions. Run ID: `20260928-005752`; JSONL and shard receipt are in
the issue owner's `benchmarks/results/` directory. The ordinary addition
control passed; `test/intl402/Intl/getCanonicalLocales/has-property.js` failed
with `Expected a Test262Error but got a TypeError`. Wrapper exit 0 establishes
dataset completeness, not conformance success. History publication was off.
The original test and its failure remain included.

Next measurement plan, after the runner quality/publication slot:

1. Derive exactly the 74 `test/intl402/` identities from the frozen manifest;
   save the newline-terminated input and its hash without recategorizing or
   adding unrelated Intl files.
2. Execute all 74 original files through the maintained standalone runner,
   with a pinned source revision, provider identity, and independent expected
   manifest. Coordinate the shared compiler slot; preserve every non-pass.
3. Require complete identity and callback accounting before summarizing rows.
   Reproduce concrete failures before assigning implementation issues; do not
   extrapolate the single observed failure to all 74 paths.
4. Keep the original 11,778-file completion bar. Neither discovery coverage nor
   this restored-subset census replaces a complete zero-non-pass full-scope
   run on the final candidate.

### 2026-09-28 measured frozen Intl census

The planned 74-path census is complete at source commit
`db5fe17e84365f93f90c9134636f989f94a453dc`. Its exact frozen input and
wrapper snapshot have SHA256
`f1c370eed335e514cb60340e9d105545719599017fd20acfdfb0be2d9883d2a3`; both
contain precisely the 74 `test/intl402/...` rows from the 11,778-path manifest.
The maintained standalone dynamic chunk (0/1), with one worker, a 4096 MiB
fork heap, history off, and the verified QuickJS linked pair completed all
identity accounting: 74 registered, 74 verdicts, 74 started, 74 settled, and
zero exclusions. The QuickJS artifact key was `2e2d7736713beeda`, its wasm
SHA256 was `e9f8d30bc347dbc56f31b3389f7696eb6dedc9f05ea729781fc412f09a3e6b17`,
and the current compiler-keyed adapter was `6dfa2dab8d8bfa0d`.

The preserved result is **2 pass / 70 fail / 2 compile errors / 0 skip**. The
passes are exactly the DisplayNames and Segmenter
`ctor-custom-get-prototype-poison-throws.js` originals; they do not establish
general user-Intl support. The two compile errors preserve the standalone host
imports for NumberFormat constructor/format and constructor/formatToParts.
Wrapper exit 0 means the expected dataset completed, not that the census
passed. JSONL, completion, and report hashes are respectively
`62150442b185548dd9a95c18a162984d0cd491aaf7ff746ac79bc64101ebac07`,
`3deed2815b81bfe32bfd28d075cd4d879cb55ec6ac7ecf97e11fe02b662c16bf`, and
`2c9c8ec92598fc66f5e18ac44d346f5e6745bf6d645aa756c5f3572fc2036411`.

The report's existing 72-row error bucketing is useful triage data, not a
single-cause diagnosis. The host-only Intl route noted in #5206 and the
provider-local temporal DateTimeFormat shim in #6442 are adjacent but distinct:
neither authorizes excluding paths or claiming a fix for all 72 non-passes.

### Proposed follow-up boundary: standalone user-Intl namespace/API gap

The proof-first [#6717 standalone user-Intl namespace/API
plan](./6717-standalone-user-intl-namespace-api-gap.md) now owns this
follow-up boundary. It remains explicitly distinct from #5206's completed
host-only route and #6442's provider-local Temporal shim. It begins with
original-file reproductions and positive controls: retain the two passing
poison-prototype originals, select representative null/undefined namespace and
host-import-leak cases, and verify each proposed surface through the maintained
standalone runner. It preserves the 74-path and 11,778-path denominators,
states that report buckets are not causal proof, and makes no compiler/runtime
change until its scope and acceptance controls are reviewed.

> **Dispatch plan lives in #6651** (`plan/issues/6651-es2015-standalone-100pct-execution-plan.md`,
> 2026-09-20): fresh census 10,384 / 11,704, the 1,320-row gap partitioned into
> nine frozen cluster manifests under `plan/agent-context/6651/`, each with an
> owner lane, model, effort and a uniform acceptance recipe. Per-cluster
> receipts go there; this file stays the narrative history.

## 2026-09-20 open-PR shepherd handoff

This is a one-shot live audit requested during wrap-up, not a new full-suite
measurement or a claim that every historical worktree is published.

- Completed capture-index fix [#6012](https://github.com/loopdive/js2/pull/6012)
  is ready, clean, and mergeable; all active checks passed and there were no
  unresolved review threads. The same is true of the completed RegExp numeric
  coercion fix [#5996](https://github.com/loopdive/js2/pull/5996).
- Documentation handoff [#6013](https://github.com/loopdive/js2/pull/6013)
  is ready and mergeable. Its initial quality check was still running; do not
  describe that initial read as all-green CI.
- Annex B syntax work is preserved as unfinished draft
  [#6014](https://github.com/loopdive/js2/pull/6014), with its raw 8P/4F
  compact result and missing validation explicit. Normal pre-push gates passed.
- Split-coercion issue #4016 has a local implementation checkpoint but no code
  PR: normal pre-push rejects five new low-level coercion references. Its
  handoff records the exact gate, source hashes, invalid receiver oracle, and
  required shared-engine review. Do not claim every current fix is in a PR.
- Promise [#5883](https://github.com/loopdive/js2/pull/5883) is behind main
  and held. Its quality report says `inventoryValid: true`, `errors: []`, but
  `architectureComplete: false`. Integrate main only after coordinating with
  the compiler-boundary/IR owner; an empty error list is not gate success.
- Super-property draft [#5839](https://github.com/loopdive/js2/pull/5839)
  conflicts and documents #6420 as its readiness blocker. The class-valued
  object-literal super test expects 2 and gets 0. Resolve the dependency before
  reconciling and revalidating the branch.
- Generator draft [#5736](https://github.com/loopdive/js2/pull/5736)
  conflicts and retains five failures among nine bridge controls. Its old
  lint failure is not a reason to mark this incomplete implementation ready.
- Yield-star [#5063](https://github.com/loopdive/js2/pull/5063) conflicts,
  is held, and describes an unfinished 9/13 standalone checkpoint. Its live
  non-draft state contradicted that handoff; draft state was restored and
  verified, retaining the hold. Its stale host-import policy baseline also
  fails quality.
- RegExp draft [#5393](https://github.com/loopdive/js2/pull/5393) conflicts.
  The remote head `b1b58773` differs from the local branch `7795fd9`, so do not
  overwrite or adopt another machine's changes. The old quality run retained
  14 failures among 42 controls. Obtain the remote author's handoff first.
- Reflect drafts [#5400](https://github.com/loopdive/js2/pull/5400) and
  [#5397](https://github.com/loopdive/js2/pull/5397) conflict and explicitly
  retain unfinished new-target and receiver/prototype work. Their shared
  context/IR-sensitive files are not cleared for this wrap-up to modify.

No unresolved review threads were found on the six agent-audited older PRs
(#5996, #5393, #5883, #5839, #5736, #5063). No branches were force-pushed,
queued, or merged by this shepherd pass. No webhook subscription tool is
available, and the repository prohibits polling; future CI or conflict changes
will require a new event or explicit check, not an unattended watcher promise.

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

### Full-population manifest materialized (2026-09-20)

The next census now has a concrete, fail-closed input artifact:
`/private/tmp/js2-4444-full-es2015-manifest.i16PO6/es2015-11778.txt`.
Its sibling `.receipt.json` records the source map, corpus root, runtime, count,
and hashes; `build-manifest.mjs` in the same temporary directory regenerates it
to a new output path. The script selects the ES2015 edition index, uses
locale-independent JavaScript string ordering, rejects a changed population,
and checks that every selected path exists inside the corpus test root before
writing a new file without overwriting an existing artifact.

Verified: **11,778 unique existing paths**, including **74 Intl402 paths**.
Manifest SHA-256 (newline-terminated):
`f2fdd4e4544a44608f0b53d89d343526cfa9c9044ca263e860da949dc1a2f59f`.
The edition-map SHA-256 remains
`9193b4d0fbbd7b7ee4df8b5f74afc866906de43ae7f62bd16e1079efa5e43fc1`;
the corpus is `b363f29d3c43c626dc852744ad64a0b48a003693`.
Upstream advanced to `ae0a46be50` by merging PRs #6000 and #6001, with no
edition-map change from `ea8d7f87`. Revalidate this manifest against the final
integrated source/map before the maintained Node-25 FYI run. This is population
preparation only: no full census has run, and no new overall pass rate is claimed.

### Integrated census setup checkpoint (2026-09-20)

The isolated census checkout is now clean at upstream `f3520ca177960f49c006edc3fd7acce8bebf58d9`,
which includes merged fixes #5999, #6000, #6001, and #6002. Its directory still
ends in `full-census-ae0-20260920`; use the recorded commit, not that older name,
as provenance. Global-match PR #6004 is published separately and is not included
in this frozen upstream checkpoint.

Initialized the pinned FYI reader submodule at
`beeff8b3d70e65dcdd00270fdb31ab12f041b049` in that checkout only. Maintained
reader discovery finds 53,583 paths, including all 11,778 manifest members
(zero missing); literal harness assembly was also checked without compilation.
The first maintained FYI smoke exited before worker readiness because the fresh
checkout lacked `scripts/runtime-bundle.mjs`. This is an infrastructure failure,
not a measured Test262 failure. Built the runtime bundle using the maintained
`build:runtime-bundle` command; the retried original
`built-ins/TypedArrayConstructors/from/invoked-as-func.js` passes **1/1** on
Node 25, standalone, original harness. Receipt:
`/private/tmp/js2-4444-full-es2015-manifest.i16PO6/smoke-f352.json`.

Before starting the full population, prepare and verify the default QuickJS
eval provider in this checkout's own cache, using the maintained provider
builder. Do not let missing dynamic-eval artifacts masquerade as semantic
failures or change the engine silently. This setup checkpoint is not a full
census and does not establish a new overall pass rate.

The isolated QuickJS provider build subsequently completed and passed its
canaries (adapter key `3cb2c272c6df4394`, 518,166 bytes). The full manifest run
has now started with four maintained FYI workers, Node 25, standalone target,
and explicit `JS2WASM_EVAL_ENGINE=quickjs`. Live log and eventual JSON are
`/private/tmp/js2-4444-full-es2015-manifest.i16PO6/full-f352.log` and
`full-f352.json`. Wait for terminal completion and validate all 11,778 unique
result paths against the manifest before quoting an aggregate. Do not confuse
an intermediate log count with completion. Compiler-bundle SHA-256:
`84f1b83ff7183f2754ce8c932d0ed83ad1a520999d0e3996e34b4d8614617da7`;
runtime-bundle SHA-256:
`679256c1c493e67c46cf8f202d49c287c099f0b4390d46c4e8d5599724db3bd9`.
Root retains the exclusive compiler/test/hook lease while this run is active;
implementation teammates may continue source-only work in separate checkouts.

### Source-only follow-ups queued behind the full census

- Annex B invalid-literal `RegExp.prototype.compile`: candidate in
  `.codex-worktrees/codex-4444-annexb-regexp-compile-audit-20260920`, based on
  `f3520ca177`, tracked in #5198. It stages receiver/arguments before reusing
  the existing literal syntax oracle and runtime SyntaxError emitter, preserving
  receiver state on failure. Compact controls are separate from the four exact
  originals. Source review corrected omitted-flags expectations to the empty
  string. No candidate test or conformance gain has yet been recorded.
- TypedArray mapped `from`: #5194 retains its unvalidated draft and thirteen
  controls. The compatibility collector can double-read `@@iterator` and pass
  native carriers through without a snapshot; the alternative HasProperty
  route mishandles nullish methods. Do not ship either as a complete mapper fix.
  #6484 S6, in `/private/tmp/js2-typedarray-from-iter-next-error-audit-20260920`,
  plans an iterator-owned one-read/cached-method materializer without layout or
  IR changes. Native/static arms must respect observable method overrides.
- Keep the abstract `%TypedArray%.from` original separate: its intrinsic
  refusal may throw before iteration. Frozen unannotated route fixtures in the
  #6484 checkout distinguish it from a concrete constructor; they are not
  measured acceptance tests and do not prove iterator exception rewrapping.

All three records preserve their actual scope. Testing, hooks, and publication
of these new source checkpoints remain queued behind the live census lease.

S6 additive helper source drafting is now authorized after review: no existing
consumer rewiring, no unproven native/static shortcut, and no layout/IR edits.
Keep the iterator provider and mapped TypedArray consumer in separate owned
worktrees during drafting, then integrate and measure them as one completed
fix before opening its PR. An unused provider alone must not claim an original
Test262 gain. The proposed public collector returns a raw array-like source or
a fully collected iterable snapshot; method lookup/caching stays iterator-owned.

S6 source audit found that clean native-array dynamic property reads can miss
the default Array-prototype iterator: the proto companion store/seeder is
demand-gated. Iterator ownership now also includes a narrowly explicit
per-consumer/per-brand demand in `native-proto.ts` and `proto-index-store.ts`
(`vec-props.ts` only if required). Existing demand defaults must remain intact;
do not mutate `protoMemberDirty` or seed every brand globally. Initialize the
companion once before the new Get path, preserving own properties and prior
prototype overrides, accessors, nullish values, and deletions. This is still
unvalidated source work with no IR, context-type, or layout change authorized.

The provisioning gate must use the pre-scan `arrayIteratorMaybeOverridden`
flag, not emptiness of `protoOverrides`, which is populated later during
lowering. The pre-scan itself recognizes bounded syntactic forms; its false
result is not proof that aliased or indirect prototype mutation is impossible.
Source review must establish whether those forms write the runtime companion
observed by Get, or conservatively decline before lowering operands. No
post-evaluation fallback or statement-order-dependent proof is acceptable.

Further source review queued a strict-mapper `thisArg` control in #5194:
the mapped call site currently pads an omitted argument with extern null.
Verify the closure bridge's semantics and distinguish omitted, explicit
undefined, and explicit null before claiming mapper fidelity. The predecessor
route using the same padding is not evidence of correctness. These checks are
still unrun while the full census owns the test lease. Source tracing confirmed
that `__apply_closure` forwards the receiver unchanged to its call bridge;
the #5194 draft now supplies canonical semantic undefined only for an omitted
`thisArg`, preserving explicit null and other evaluated values. This is a
source correction, not a measured pass gain.

S6 draft review identified a compatibility trap before testing: the existing
`ensureObjectRuntime` sets `objectRuntimeTypes` before its ordinary
`reserveProtoIndexStore(ctx)` call. A new unconditional late-provisioning guard
would therefore disable the historical path. Restrict that refusal to the new
explicit demand, preserve the no-options caller, and constrain the demand to
Array rather than every builtin brand. The mapper caller must also provision
the iterator provider before the old array-like helper creates the object
runtime. Both source owners have these ordering requirements; no runtime
verification has occurred yet.

The iterator draft now applies the late guard only to a valid explicit
Array demand and leaves no-options reservation unchanged; both demand/seeder
entry points constrain the opt-in brand to Array. Root re-read those changes
and the scoped whitespace check is clean. Semantic regression controls remain
queued, so this is not runtime validation.

### Next independent Promise slice (read-only census triage)

Frozen-f352 source audit maps the observed resolve-get-once failures to #5197
R3-2 and #5143 C1a: direct literal-array combinators create/subscribe native
promises without observing `Promise.resolve`, including their empty-array arm.
A next independent implementation can own `promise-combinators.ts` and
`expressions/call-namespace-static.ts`: cache one observable resolve Get after
argument evaluation and call it once per element with the correct receiver,
using existing native promise assimilation. Measure empty/nonempty getter and
call counts, receiver/argument identity, abrupt completion, zero imports, and
unchanged host/unmutated paths. This is not yet dispatched or validated and
does not establish completion of the broader R3-2 bundle.

Keep iterator-abrupt Promise rows separate: the current null drain result does
not distinguish Symbol-method visibility from caught next/value abruptness;
#5197 already records the required discriminator. That work overlaps the
active iterator owner. Custom-constructor `.call(C, iterable)` host imports
instead belong to #5143 C1b / #5197 R3-3 / #3390 Slice 3 and require real
NewPromiseCapability behavior, not merely removal of imports.

### Iterator values-closure prerequisite

S6 cannot yet call the default method it observes: Array's seeded
`@@iterator` aliases its reflective `values` closure, whose body currently
falls through to a catchable refusal in `array-object-proto.ts`. Iterator
ownership now includes that file and, only if needed, `array-methods.ts` for
an AST-free producer. Keep this non-IR and preserve existing record layouts.
The direct `compileNativeArrayIterator` eagerly copies elements, so merely
wrapping that producer is insufficient for a generic values closure. Required
behavior includes no indexed reads at creation, live length/indexed Get on
next, permanent exhaustion, and alias identity. Assess the existing record or
closure substrate before implementation; keys/entries are not prerequisites.
Do not introduce an identity shortcut whose only correctness evidence is
equivalence to the existing eager direct lowering. The mapped TypedArray draft
remains unavailable until this dependency is resolved and measured.

The iterator owner identified a no-layout candidate: a new array-like iterator
kind uses the existing `userIter` field for the original receiver and existing
cursor field for the next index. Wire the real reflective `values` closure to
that record, and read/convert length plus indexed values only from `next`.
Audit every kind consumer so its null vec field cannot reach an old vec read;
reuse full Get+ToLength semantics, latch before subsequent length reads, and
advance before indexed Get. This is an unvalidated source plan. The inherited
i32 cursor ceiling remains an explicit residual, not a full-domain claim.

### Full original-harness census terminal receipt

The frozen `f3520ca177960f49c006edc3fd7acce8bebf58d9` standalone census
finished normally with exit 1: **10,377 passed / 1,401 failed / 11,778 total
(88.1049414162% pass)**. Exact set comparison verified every manifest path
appears once, with no missing, extra, or duplicate result. Pass/fail counters
were independently recomputed from all result rows.

Result: `/private/tmp/js2-4444-full-es2015-manifest.i16PO6/full-f352.json`.
SHA-256: `851a8f4e09d048aba2ce76d4c693d16c04efd5477ee36077079934bb00c73d6f`.
Runner: `test262-fyi-original-harness`, project worker, four workers,
standalone, authoritative compatible `test262-fyi-node25-unicode17-v1`,
Node 25.9.0 / Unicode 17 / UTC. Corpus gitlink:
`b363f29d3c43c626dc852744ad64a0b48a003693`; FYI reader gitlink:
`beeff8b3d70e65dcdd00270fdb31ab12f041b049`. The QuickJS provider and bundle
hashes are recorded above. PR #6004 is not included in this frozen revision.

This is the measured full-scope result, not 100% completion and not a
regression comparison to historical CI JSONL from a different harness.
Category counts describe observed rows, not proven root-cause boundaries:
RegExp 122, Promise 99, TypedArray 76, Proxy 75, Array 62, Object 51,
TypedArrayConstructors 44 failing rows; language expressions/statements add
274/232. Reproduce apparent regressions in isolation before attribution.

Root released the census lease to the RegExp owner for the prepared focused
host/standalone controls, four exact-original same-base comparisons, and
existing poison-contract controls. Iterator/TypedArray work remains source-only;
root documentation hooks/publication wait for that bounded lease to end.

The terminal rows divide into 289 compile-phase and 1,112 runtime-phase
failures. Sixteen module-namespace rows report `ReferenceError: ns is not
defined`; the mapper owner has a read-only secondary audit of exact fixtures,
FYI source assembly, worker handling, and a passing module control to locate
the defect. This signature alone does not establish a shared root cause or
justify changing the harness. No tests or IR edits are authorized by that
secondary audit while RegExp owns the test lease.

RegExp's first compact candidate run is terminal exit 1: **8 pass / 4 fail
out of 12**. Receipt:
`/private/tmp/js2-5198-regexp-compile-syntax-candidate-f352-20260920.log`.
Shadowed-undefined controls returned 0 on host and standalone; abrupt receiver
returned 0 on host and failed compilation on standalone with the existing
native-RegExp carrier refusal. All four controls remain present. The owner
retains the bounded lease for identical clean-f352 comparisons and exact
originals; no regression attribution, readiness, or original pass gain is yet
established. Subsequent runs omit the process-wide heap override and retain
only scoped fork resource settings when needed.

### Upstream regression report takes priority

A fresh remote read found main at
`2f6c0f4f57db129c772a476345c28d85010cd175`, including merged PR #6003
(handoff), #6004 (global-match shape), and #6005 (dynamic/member spread).
The frozen census remains f352, not this newer revision.

Upstream #6648 reports two pre-existing witnesses regressed between
`ea8d7f87ff` and `b84d58d64c`: issue-6602 nullable capture filtering now emits
invalid struct construction, and issue-6603 inline nullable-string concat
traps. The report suspects #6004 but does not prove attribution. Its author
owns a priority follow-up: let the current four-original RegExp run finish,
preserve the syntax candidate, create a separate current-main regression
worktree, reproduce unchanged witnesses, and record same-base attribution
before fixing. No expectation edits, IR edits, or layout changes. New-fix
publication waits for this possible regression to be resolved. S68 also
changed `call-receiver-method.ts`; the mapper owner must preserve those edits
when synchronizing its later integration branch.

Because #6003 has merged, these new handoff changes need a new follow-up PR
after the serialized hook slot is free; do not push them as an update to the
already-merged PR or claim that its merged snapshot contains this receipt.

Before switching to #6648, the RegExp candidate completed its four exact
originals with **4/4 pass** (Node 24 maintained isolated standalone runner;
receipt `/private/tmp/js2-5198-regexp-compile-four-candidate-f352-20260920.log`).
This is not the matched original-harness comparison or a resolution of the
four red compact controls. The clean-base/poison checks remain pending and
the source candidate is preserved unchanged. New documentation branch:
`codex/4444-es2015-census-results-20260920`.

### Namespace runner-parity audit and follow-up

Read-only source tracing attributes the 16 namespace `ns` ReferenceErrors to
missing self-import graph routing in the FYI path, not a newly established
compiler regression. The maintained project runner already uses `compileMulti`
for validated namespace self-imports, while FYI graph attachment and worker
selection require nonempty fixture maps; a self edge has no extra fixture.
Existing #4759 records this distinction and a real linked semantic control.

The census namespace subset is 3 pass / 20 fail out of 23. Its three passes
expect ReferenceError and are not reliable positive semantic controls for
linking; retain this vacuity caveat with the overall census measurement.
The standalone goal requires correct execution, not retaining those accidental
passes. No adjusted aggregate or assumed gain is claimed.

The mapper owner is assigned a separate current-main #4759 worktree for a
narrow explicit self-module-graph signal through FYI reader, executor, worker.
Gate it on the namespace path plus validated pinned self edge; do not broaden
all entry files or dynamic fixtures into compileMulti, rewrite source, weaken
verdicts, or remove failures. Controls must include a genuinely linked circular
fixture, the non-namespace Proxy self-import exclusion, and preserved dynamic
imports. Update provenance/version contracts if the repo requires it and
remeasure actual originals after routing. Source-only until the priority
#6648 test lease is released; the TypedArray draft stays in its own checkout.

### 2026-09-28: frozen census index 24 and ownership-gated follow-ups

The next serial shard completed at frozen source
`f924650c6c26237f62b08a362d7003d4d2b1e12d`, not at the current fix candidate.
The exact manifest remained 11,778 paths and passed physical validation.
Retained session `92021` terminated with exit 1 after 97.22 seconds:
**91 registered / 91 verdicts: 86 pass, 5 fail, 0 compile errors, 0 skips**.
The maintained completeness validator accepted the shard with zero exclusions.

Evidence remains in the isolated `manifest-baseline` worktree:

- JSONL: `benchmarks/results/test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk024-a01.jsonl`, SHA-256 `8f1615499403789a07ea772a388cc337fb4d625fc54d20628040e11b8c4c9c98`.
- Completion: same basename with `.shard-25-of-128.complete.json`, SHA-256 `38461287198e7b2073f80089fba6b20950e7a0f129b59cd901f89758c3b12f32`.
- Execution ledger: `.tmp/4444/es2015-fullscope-128-execution-ledger.json`.

Re-reading all 25 accepted shard artifacts verified their hashes and unique
membership in the unchanged manifest: **2,282 measured = 2,138 pass + 122 fail
+ 22 compile errors; 9,496 remain unmeasured**. Next index is 25. These are
frozen-baseline counts, not post-fix acceptance or evidence of pass-rate gains.

The five original failures remain in scope:

- `language/expressions/object/method-definition/yield-as-yield-operand.js`:
  first result value is undefined instead of 1; route to #3032's nested-yield
  machine follow-up, not method metadata. Later assertions are unmeasured.
- `language/statements/class/subclass/builtin-objects/GeneratorFunction/instance-name.js`:
  fails the own-name assertion; inspect #5318's builtin-subclass residue and
  #3371's NewTarget dependency before selecting a repair. This is not
  NewTarget-only: `generator-function-intrinsic.ts` also explicitly leaves
  calling/constructing the intrinsic (CreateDynamicFunction) unmodelled.
  Function-name metadata alone cannot supply the missing created instance.
- `built-ins/Array/prototype/filter/create-proxy.js`: result prototype differs
  from the species constructor prototype for a doubly wrapped array. Retain
  the Proxy ownership hold; do not infer a unique cause from this assertion.
- `language/computed-property-names/object/accessor/getter-super.js`: folded
  `object.a` passes before dynamic `object.b` returns `bnull` instead of
  `b proto m`. Source inspection at `9d3721e2` found the dynamic accessor
  callback in `literals.ts` omits the final `objLocal` argument to
  `emitObjectLiteralAccessorFn`, while both static accessor calls supply it.
  Without that argument the closure cannot capture its home object for
  `super`. This is source evidence, not an emitted-route or repair measurement.
  #5318 still has an active claim; user clearance is pending. If cleared,
  pass the existing local through this callback only, then validate original
  getter/setter tests, runtime-key evaluation once per declaration, borrowed
  receivers, and folded-key controls. No IR/closure-layout change is proposed.
- `built-ins/Iterator/prototype/chunks/next-method-returns-throwing-done.js`:
  expected abrupt completion is absent. #5147 already plans throwing
  `done`/`value` protocol fidelity in the shared iterator stepping helpers;
  do not add a per-test or per-kind exception shortcut.

No listed issue is closed by this handoff, and no held implementation area was
modified. PR #6231 contains the preceding 24-shard checkpoint; this section is
the subsequent local handoff pending the next publication checkpoint.

### 2026-09-28: frozen census index 25 accepted

Under the same frozen source and full manifest, retained session `3215`
terminated with exit 1 after 77.00 seconds. The maintained validator confirmed
**92 registered / 92 verdicts, zero exclusions: 87 pass, 4 fail, 1 compile
error, 0 skips**.

- JSONL: `benchmarks/results/test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk025-a01.jsonl`, SHA-256 `cf3f98c6e7ee09713856b0a1c7d5b9124f1b2250470b361806325b851c6bf330`.
- Completion: same basename with `.shard-26-of-128.complete.json`, SHA-256 `8fee8e2a12284931138584cc01a6bb1ef9ea588f1eac4985114c913ec147e0c2`.

All 26 accepted artifact pairs were hash-verified again, with unique identity
membership checked against the full manifest: **2,374 measured = 2,225 pass +
126 fail + 23 compile errors; 9,404 unmeasured**. Next index is 26. This remains
a frozen baseline, not a final post-fix conformance result.

Retain these five non-passing originals without regrouping by error alone:
`Promise/prototype/then/ctor-throws.js`,
`class/definition/methods-restricted-properties.js`,
`class/decorator/syntax/valid/decorator-member-expr-identifier-reference-yield.js`
(compile error: `yield` rejected as a strict-mode identifier),
`Function/proto-from-ctor-realm.js`, and
`Iterator/prototype/chunks/iterator-return-method-throws.js` (TypeError instead
of Test262Error). Full paths and assertion text are in the retained JSONL;
no later-assertion or root-cause claim is made by this receipt.

Source-trace correction for the decorator row: the exact diagnostic text is
emitted by this repository's `checkReservedIdentifiers` in
`src/compiler/early-errors/module-rules.ts`, which calls `isStrictMode` in
`predicates.ts`. The latter's ancestor walk treats a class declaration as
strict without distinguishing the attached decorator expression. Thus older
plans describing these rows solely as an upstream TypeScript parser limitation
are insufficient. A read-only follow-up is checking decorator expression
context, strict/generator/module negative controls, and cached ancestor facts.
Do not widen the diagnostic allowlist or claim a conformance gain before a
matched original/control run; decorator execution may present another defect.

### 2026-09-28: frozen census index 26 accepted

Retained session `2255` terminated with exit 1 after 89.36 seconds on the
unchanged frozen source. Compiler/runtime bundles, the exact manifest, and both
duration-map hashes were rechecked against the ledger contract. The maintained
validator accepted **92 registered / 92 verdicts: 89 pass, 3 fail, 0 compile
errors, 0 skips, zero exclusions**.

- JSONL: `benchmarks/results/test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk026-a01.jsonl`, SHA-256 `6cff1cf25d790853aa01dfbbfe76299d4a40357c0d9022840553d0f31c5645da`.
- Completion: same basename with `.shard-27-of-128.complete.json`, SHA-256 `ea2a8b7649413b71ddc1df673028ee5344a894f864cb76a67e5de830013dfd18`.

Revalidated all 27 accepted artifact pairs and exact unique membership:
**2,466 measured = 2,314 pass + 129 fail + 23 compile errors; 9,312 remain
unmeasured**. Next index is 27. The three failures are the original
`test/language/statements/class/definition/fn-name-accessor-set.js`,
`test/language/expressions/generators/yield-identifier-non-strict.js`, and
`test/built-ins/Error/proto-from-ctor-realm.js`. They remain failures in the
frozen baseline, with no inferred current-source status or pass gain.

The generator row is not a decorator/parser failure: its receipt says
`reached_test: true`, `strict: no`, and its first `item.done === false` check
observes true. The unexecuted later checks require first value undefined,
second `.next(42)` value 43, and call count 1. The legal inner `var yield`
identifier must not be confused with the outer real suspension in
`return (function(arg) { ... }(yield))`.

Read-only tracing places this in #2864's documented argument-position yield
residual, distinct from #3032's nested-yield operand: native generator planning
handles a return before structural continuation lowering and records the
outer call as a terminal return without a suspension/sent-value spill.
`lowerContinuationRoot` has no call-expression root. This is source-supported
routing, not an executed WAT attribution or a measured fix.

An implementation preflight found no live #3032 claim, but the exact shared
`generators-native.ts` file is touched by open PRs #6101 (suspended yield work)
and #5753 (IR closure support), out of 12 open PRs scanned. #2864's issue also
records an in-progress owner. Keep implementation held for coordination with
that work; do not replace the suspension with a terminal return, exclude this
original, or claim the subsequent assertions ran.

### Decorator focused-test instrument correction

The initial #5141 unit baseline exposed a malformed negative control:
`function* g() { @yield class C {} }` produces TypeScript TS1109 and no
`yield` Identifier node, so `checkReservedIdentifiers` cannot establish its
rejection. Preserve this source for a full-compiler negative check rather than
calling the empty identifier-error set a valid generator result. In particular,
the compiler tolerates TS1109 in its syntax gate, so parser diagnostics alone
do not establish compiler rejection. A separate, parse-clean identifier-context
negative (`function* g() { function yield() {} }`) exercises the intended
`[Yield]` boundary. Correct the instrument before measuring the proposed
strict-mode cache fix, and report any independent admission gap separately.

### 2026-09-28 decorator slice: matched authoritative verification

The narrow #5141 direct-class-decorator strict-context candidate now has a
matched standalone maintained-runner result: **baseline 3 pass / 6 compile
errors → candidate 9 pass / 0 failures**, with the same nine-path manifest.
The six originals are the statement/expression class-decorator pairs for
member, call, and parenthesized `yield` identifier references. The three
controls (generator identifier rejection, strict generator identifier
rejection, and ordinary decorator identifier syntax) remain passing.

Both arms use source base `45ce4a8e207742df5ca3888c0a458e8a48ee1655`,
the candidate changing only the owned strict-context predicate; the baseline
temporarily restores that predicate. Explicit parent `TZ=UTC`,
`JS2WASM_TEST262_TEMPORAL=0`, standalone/auto/QuickJS, one fork, and the exact
manifest match. Manifest SHA-256:
`75c5c6cbc6311db8c37957ab7bf7cc07d0a3673812ea8704628da28f19e602a3`.
The maintained completeness validator accepts both arms: 9/9, zero exclusions;
file-keyed comparison confirms exactly six compile-error-to-pass changes.

Receipts in the `map-size-descriptor/js2` worktree under `benchmarks/results/`:

- Baseline `issue-5141-base-r2-results-5141-base-r2-20260928.jsonl`, SHA-256
  `9a0ceb6df49328bb96ee623d645c3e65f36ab7fc27c4d1eae96eaedc291a24e3`;
  completion SHA-256
  `effa56c6d3b6ebaa85155a05f229a050723ac4aab6a55f7510ae6ebd8055ae6a`.
- Candidate `issue-5141-candidate-root-results-5141-candidate-root-a02.jsonl`,
  SHA-256 `7aa6cc72b9454139de1b421cdbe0f8c8d611d961f41ee3b906f8662d9af258c0`;
  completion SHA-256
  `c0e8a1cb17e2e29f3fca031f2687906e0e736b02d683c743c2e743d3fd2c8e51`.
  Session 62420 terminated exit 0 in 19.48 seconds. Artifact hashes were
  independently rechecked before this handoff update.

Published as ready [PR 6238](https://github.com/loopdive/js2/pull/6238), verified
fork head `f90c59801b04edf8f13c6798e5c1ec02c3a6b2ee`. Normal commit and push
gates passed, including focused 5/5, numeric-local parity 18/18, typecheck,
formatting, lint, budgets, ratchets, and issue integrity. The creation snapshot
reported mergeable, non-draft, behind main, with CI still running; this is not
evidence of landing or final CI success. This does not close the broader #5141
generator issue, establish decorator runtime
semantics, or change the frozen census totals: those remain 2,466 measured
paths (2,314 pass, 129 fail, 23 compile errors), with 9,312 unmeasured. Full
goal completion still requires a complete run on final integrated source.

### 2026-09-28 issue 4016 read-only re-grounding

The protected `codex/4016-resume-20260927` worktree remains at `92afa58c6e`
with uncommitted diagnostic edits in `string-symbol-protocol.ts`, its #4016
focused test, and unrelated #6493 notes. No new test or production change was
made during this audit. The local wrapper-stripping candidate has existing
same-shape trace/WAT evidence that generic lookup, nullish/callable checks,
argument-vector construction, and closure application are emitted; its two
computed `[Symbol.split]` acceptance controls still return zero. This is not
evidence of a completed fix.

The current source-supported obstruction is the literal's closed-struct
representation: `compileObjectLiteralForStruct` does not field-install its
computed method through `matchingProps`, and closed-field lookup does not map
the boxed Symbol key to internal `@@split`. The passing original-shaped
control instead starts with open `{}` and dynamically assigns the real Symbol
key through the existing open-object writer. Do not infer literal-method
correctness from that different producer shape.

Next step is a read-only ownership/design audit of a producer-only route for
scope-proven ambient well-known Symbol methods to the existing open-object
writer. Before implementation, resolve exact file claims and require controls
for shadowed `Symbol`, iterator closed layout, and `Symbol.toPrimitive`.
Aliases, returns, parameters, arrays, and field crossings require separate
type/IR coordination. The host callback-export issue and object-return carrier
remain separate boundaries; the user's bare `4016` does not clear shared IR
or runtime ownership. The dirty #6493 Proxy-setter diagnostic grants no such
clearance either.

The follow-up ownership audit found a concrete collision: #3481 has an active
assignment covering `literals.ts`/ToPrimitive, while #5149 also discusses
computed-method routing. #4016's historical assignment is released, not a live
claim for this producer change. Keep its protected worktree untouched. A later
implementation requires a fresh isolated claim and coordination with those
owners; it must not expand the old wrapper-stripping candidate silently.

Both producer selection and the existing boxed-Symbol writer live in
`literals.ts`; consumers of `objectLiteralForcesHostPath` must remain in
representation lockstep. The prospective resolver must establish a nonempty
ambient declaration set, not infer a global from spelling or absent
declarations. Shadowed/local/parameter/imported `Symbol` must evaluate normally
without global-id boxing. Prove the relevant String-protocol category from
the compiler's protocol implementation before broadening beyond split;
preserve iterator closed layout and the existing ToPrimitive route. Acceptance
needs receiver/argument/result identity, supplied/omitted split limits,
single key evaluation, emitted producer/writer/reader evidence, and the
existing dynamic-assignment control. No focused-only result earns Test262
credit, and escape-boundary failures require separate type/IR coordination.

### Next candidate under read-only review: Array unscopables

Frozen census shards 15 and 22 respectively fail
`test/built-ins/Array/prototype/Symbol.unscopables/prop-desc.js` and `value.js`.
The former reports the missing own property; the latter stops at a
null/undefined property access. #5268's historical D2 notes describe this
unfinished slice despite its broader `done` status. These are frozen-source
observations only: current-main source and fresh-run verification are still
required before dispatch.

The frozen `value.js` checks ten named entries and their descriptors but does
**not** assert an exhaustive own-key set. Do not turn that test subset into an
implementation rule excluding additional semantically required entries. A
valid plan must also account for identity, null prototype, entry descriptors,
and the configurable outer property's deletion/redefinition behavior; an
unconditional synthetic descriptor or immutable read shortcut is insufficient.
Retain the already-passing unscopables/with and cross-realm originals as
controls, and add a non-vacuous Array/with lookup control. No implementation
claim or production edit has been made for this candidate.

### Frozen census index 27 accepted

Session 95152 terminated exit 1 in 94.68 seconds: 93 registered originals,
82 pass, 8 fail, 3 compile errors, zero skips. The maintained completeness
validator confirmed 93/93 with zero exclusions. Compiler/runtime, scope and
duration-map hashes still match the frozen contract; no retry or source edit.

Receipt basename under `benchmarks/results/` is
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk027-a01`.
JSONL SHA-256: `37345bd261c4baed979361a43a717c9e9565b2fc302c0e734bfd737a644dbdbe`.
Completion suffix `.shard-28-of-128.complete.json`, SHA-256:
`68a6e282087dba406cea3a7d865789c4f31c8e019b18920b0df3b0f75ec6a130`.

Re-reading all 28 accepted artifact pairs verifies **2,559 unique in-scope
paths: 2,396 pass, 137 fail, 26 compile errors; 9,219 remain unmeasured**.
These are frozen-source results, not a current post-fix pass rate. Next index
is 28. Eleven nonpassing rows need source-level routing; no new repair credit
is inferred from their error categories.

### Frozen census index 28 accepted

Session 41453 terminated exit 1 in 90.25 seconds: 93 originals, 88 pass,
5 fail, zero compile errors/skips. Completeness validation passed 93/93 with
zero exclusions. Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk028-a01`.
JSONL SHA-256 `15a63b1cf12af291648508dcefbec903507c3c3ac801b19b6011033d53839372`;
completion `.shard-29-of-128.complete.json` SHA-256
`43246f0d7ca948dbda6b524acf1e42b135f415c16542b2f1a5e995b08d5540c5`.

All 29 accepted artifact pairs were hash-checked and their identities checked
against the exact scope with no duplicates: **2,652 measured, 2,484 pass,
142 fail, 26 compile errors; 9,126 unmeasured**. Next index 29. The five failing
originals concern generator-method default parameters/arguments, nested Proxy
descriptor fallback, Symbol registry cross-realm identity, Object.assign to
an existing accessor on a nonextensible target, and exhausted iterator-window
return behavior. These descriptions route investigation, not established
root causes or permission to touch held shared code.

### Frozen census index 29 accepted

Session 10266 terminated exit 1 in 92.78 seconds: 93 originals, 89 pass,
3 fail, 1 compile error, zero skips. Maintained completeness passed 93/93,
zero exclusions. Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk029-a01`.
JSONL SHA-256 `5ffa68b3ee6d5897948dae44ad16ef6ce14460c7555bd64b4205f00fbe256f92`;
completion `.shard-30-of-128.complete.json` SHA-256
`f431c315673167d11a37ded96283420ae7de809f70769a1aa0cd70da9c81d993`.

All 30 accepted artifact pairs and exact-scope identities revalidated:
**2,745 measured: 2,573 pass, 145 fail, 27 compile errors; 9,033 unmeasured**.
Next index 30. The nonpassing originals are yield continuation object-value
identity (`iter-value-specified.js`), a computed class accessor name containing
yield (`accessor-name-inst-computed-yield-expr.js`, compile refusal), RegExp
unicode accessor cross-realm behavior, and iterator-window result identity.
These retain their measured failures and require source-level routing; no
inferred fix or post-integration pass-rate claim.

### Frozen census index 30 accepted

Session 22660 terminated exit 1 in 92.03 seconds: 93 originals, 88 pass,
5 fail, zero compile errors/skips. Completeness passed 93/93 with zero
exclusions. Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk030-a01`.
JSONL SHA-256 `18691bd065c4b28112ae6ff6586e24a780eba9c5d66f703e41a776fea630a096`;
completion `.shard-31-of-128.complete.json` SHA-256
`a10c09215fae7d989214b877fcd69ac58f7f6f9fe47ea28b566d416bddf4132b`.

All 31 accepted artifact pairs and exact-scope identities revalidated:
**2,838 measured: 2,661 pass, 150 fail, 27 compile errors; 8,940 unmeasured**.
Next index 31. The five failures concern typed-array iterator detachment,
dynamic non-eval tail calls, Proxy `has` receiver context through a prototype,
eval completion for a class with RegExp literal flags, and an Error.stack
setter's throwing Proxy trap. Retain existing #6493 diagnostic context/reservation for
the last case; the frozen repeat does not establish a new repair or clear
shared source. Other cases need source-level attribution before dispatch.

### Shard 27 priority routing refinement

`eval-spread-empty-trailing.js` fails the final `nextCount` check (0 instead
of 1), not either preceding `x` assertion. Current source supports a missing
spread-argument iteration path: `eval-inline.ts` compiles/drops extra
arguments, while the generic `SpreadElement` lowering merely evaluates its
operand. Runtime-eval extra-argument paths use the same primitive, so
declining only the inline evaluator is not a semantic repair. Next is a
fresh #5157 ownership check and a plan for eval argument-list evaluation:
evaluate once, iterate spreads with correct abrupt completion and ordering,
then ignore values beyond the first eval argument. This is source-supported
routing, not a tested fix.

`numeric-property-names.js` is already explicitly owned by active #5318.
The first descriptor helper dereferences an undefined descriptor for a class
prototype member; later static/super checks are not reached. Keep it with
that class reification work rather than starting a competing repair.

The remaining index-27 rows route to existing plans, not new fix claims:
Promise.allSettled import leakage to #5143; computed class yield and generator
rest-parameter import leakage to #2864; Proxy ownKeys Symbol transport to
#5176; Array length coercion/writability to #5145; revoked-Proxy ordinary
construction to #5140 (not primarily Reflect NewTarget #3371); dynamic
GeneratorFunction creation to deferred #5141 F2; iterator chunks return-getter
propagation to #5147 with historical #5267 context; and module generator
binding to #5157 F with #2864 prerequisites. Later assertions remain
unmeasured where an earlier assertion stops execution.

### Eval spread implementation dispatch

Freshly fetched upstream main is `1032526dc12302034e558934b60363348e80b8bd`.
A complete action-tied scan of 14 open PRs found no overlap in
`expressions/eval-inline.ts` or `expressions/runtime-eval-provider.ts`;
the parent #5157 has no live claimant. The narrow
`5157:eval-spread-arguments` claim is now verified upstream for
`ttraenkler/codex-eval-spread-arguments`. A Terra Max implementation agent owns
the preserved/reused clean RegExp worktree on the new
`codex/5157-eval-spread-arguments` branch. The full plan is recorded in #5157
before implementation. It must first establish a current matched baseline,
reuse the #5361 `buildSpreadArgList` precedent where appropriate, preserve
all argument-list semantics, and remain outside generic iterator/IR/runtime
files without additional coordination. No repair credit yet.

### Intl audit boundary

Within indices 0–29 only, 11 Intl identities were measured: 9 fail, one
NumberFormat host-import compile error, and one provisional Segmenter
poison-prototype pass. Nothing is inferred about the other 63 frozen Intl
identities. Current source materializes user `Intl` only for host targets;
the namespace/constructor/prototype surface needed by these originals is
missing in standalone. Descriptor-only constants or constructor stubs would
not repair option conversion, realm/NewTarget, or deletion behavior. Existing
#6717 remains the proof-first implementation plan, with host-free provider
and ownership design still required; no safely independent Intl leaf was
identified by this audit.

### Frozen census index 31 accepted (next documentation checkpoint)

Session 33532 terminated exit 1 in 83.59 seconds: 93 originals, 86 pass,
6 fail, 1 compile error, zero skips. Completeness passed 93/93 with zero
exclusions. Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk031-a01`.
JSONL SHA-256 `a9542efb470872690aa7b12b84c44f768aa2ceccf1a511e1ce0a97ee6a55c865`;
completion `.shard-32-of-128.complete.json` SHA-256
`167f5cccae93f6c174240d12c78b1546d8ffcf153c320ffe62f41f9fa4b3f0e4`.

All 32 accepted artifact pairs and exact-scope identities revalidated:
**2,931 measured: 2,747 pass, 156 fail, 28 compile errors; 8,847 unmeasured**.
Next index 32. Nonpassing rows concern copyWithin abrupt `has`, non-eval
tail call in `with`, Promise.all capability resolution, sloppy generator
method receiver, derived-class explicit return identity, a computed accessor
name containing yield (compile refusal), and Error.stack cross-realm setter.
No fix or current integrated pass rate is inferred. This follow-on record
postdates PR 6239's checkpoint and is not part of its published commit.

### Frozen census index 32 accepted (next documentation checkpoint)

Session 77009 terminated exit 1 in 87.66 seconds: 93 originals, 87 pass,
6 fail, zero compile errors/skips. Completeness passed 93/93 with zero
exclusions. Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk032-a01`.
JSONL SHA-256 `e2340eef908f36f1bd187c87cbe80dddec64c1887d3638a760578c8d0e49e7d0`;
completion `.shard-33-of-128.complete.json` SHA-256
`05824c7b9342bfe5f86494b9e77a276f994cc144a74cd099d19dff4b175e214e`.

All 33 accepted artifact pairs and exact-scope identities revalidated:
**3,024 measured: 2,834 pass, 162 fail, 28 compile errors; 8,754 unmeasured**.
Next index 33. Failures concern generator default-prototype identity, a class
computed-key assignment effect, DataView getter identity, Promise.race
self-resolution completion, nested Proxy null-get-trap forwarding, and
Error.stack setter nonconstructibility. They remain failures pending
current-source attribution and repair; no inferred exclusions or fix credit.

### Verified landing and active implementation handoff, 2026-09-28

Decorator slice PR 6238 landed in upstream main
`25834c4af68c688e53c420b9c057bd26153dadf9`. The implementation commit
`f90c59801b04edf8f13c6798e5c1ec02c3a6b2ee` is an ancestor, and its predicate
and focused-test content matches that main revision. This confirms landing
of the previously measured six-original repair, not completion of broad #5141
or a new integrated full-scope measurement.

The independent reflective copyWithin slice is claimed as
`5145:copywithin-reflective` for `ttraenkler/codex-copywithin-reflective`,
verified by the claim tool on upstream issue-assignments. A Terra Max worker
owns isolated branch `codex/5145-copywithin-reflective` at that main revision.
The implementation plan is recorded in #5145 before dispatch. Missing
reflective admission currently throws before the original's Proxy HasProperty
trap; use existing string-keyed object operations, not indexed shortcuts that
bypass live Proxy dispatch. Fresh baseline and implementation are pending.
The worker owns the team's single heavy build/test/hook lease.

The eval spread candidate is NOT complete. Its intermediate seven-original
result was green before a stricter implementation and adversarial controls.
The latest focused split receipt reported five of six passing in
`/private/tmp/5157-focused-split-direct-20260928-1000.log`. Inline literal-array
spread can lower to a tuple carrier that the strict iterator provider does
not admit; binding the same array first changes its carrier and passes.
Separately, the provider's vector fast path bypasses a runtime override of
Array.prototype's iterator: the retained grouped probe returns 23 in compiled
execution versus 7 in the isolated Node oracle. Neither mismatch is excused
by rearranging the controls. The eval worker is auditing exact provider
ownership and recording the residuals in #5157; provider/IR edits are not
authorized by the narrow eval-file claim. No eval fix credit or merge-ready
claim is made from the intermediate result.

Review correction: raw Node's grouped result of 7 is diagnostic, not the
acceptance oracle. The grouped probe's specified score is 15: the first three
protocol checks contribute 1+2+4, the overridden iterator must supply the direct
eval source (8), and the subsequent ordinary method must receive the overridden
string rather than its original literal (so no 16). Matching Node's known
direct-spread behavior would preserve a defect. The worker was instructed to
keep the historical discrepancy but correct the executable expectation.
The [function-call algorithm](https://tc39.es/ecma262/2023/multipage/ecmascript-language-expressions.html#sec-function-calls-runtime-semantics-evaluation)
requires ArgumentListEvaluation followed by direct PerformEval; section
13.3.8.1 requires iteration of the spread operand. No new compiler pass result
is asserted by this test-oracle correction.

Issue 4016's historical plain-string-conversion completion is separate from
its protected custom-Symbol.split diagnostic continuation. The user's bare
4016 reference has not established clearance to edit overlapping IR work.
Keep that checkout and its uncommitted diagnostics intact pending clarification.

### Index-32 Promise.race follow-up boundary

Reading the exact `built-ins/Promise/race/resolve-self.js` original shows it
temporarily replaces Promise.resolve with an identity function, captures the
race capability resolver through a thenable, restores Promise.resolve, and
then resolves the result promise with itself. The frozen failure is missing
async completion, not a measured assertion about the eventual rejection value.
Do not label this a missing self-resolution check solely from its filename.
Completed #4727 covers a different original under `Promise/resolve/` and a
custom-constructor admission path; its historical success is not proof for
this `race` original. Follow-up under the Promise #5143/#5197 plans needs
stage-by-stage controls for override observation, resolver capture, result
identity, rejection and job draining before choosing a source edit. No fresh
current-base run or additional implementation claim has been made here.

### Index-32 DataView and Error.stack audit boundaries

The DataView original `defined-bytelength-and-byteoffset.js` checks byteLength,
byteOffset, buffer identity, constructor identity, then prototype identity, in
that order for six instances. Its frozen error prints two native functions.
Although current Object.getPrototypeOf lowering lacks an explicit DataView
instance route, that absence does not establish the first failing assertion:
`sample.constructor === DataView` precedes it and requires investigation of
the two constructor singleton materialization paths. A fresh step-separated
probe must distinguish these before dispatching a prototype-only fix.

For Error.prototype.stack `setter-not-a-constructor.js`, the reported exception
assertion failure occurs after its isConstructor check, at `new set('')`.
Source audit finds the accessor is already marked nonconstructible, while
the static new-expression admission does not recognize this descriptor-derived
local. The candidate responsibility is construct admission/guarding, not the
setter's body. Shared new-super/non-constructable analysis remains protected;
do not mask this failure with an accessor-specific special case. Both audits
are source-level findings, not new current-base runtime measurements or fixes.

### Frozen census index 33 accepted

Retained terminal session 64824 exited 1 in 78.78 seconds: 93 originals,
85 pass, 8 fail, no compile errors or skips. Completeness passed 93/93 with
zero exclusions. The launch used TEST262_RUN_TIMESTAMP instead of the runner's
RUN_TIMESTAMP, so its actual unique timestamp is `20260928081032`; this only
affects receipt naming. No restart, overwrite or exclusion was performed.
Receipt basename:
`test262-standalone-es2015-fullscope-128-results-20260928081032`.
JSONL SHA-256 `3299d46b1b140427b0b66f2dd19c812198e5256bea10a241d5c278bbfba0048a`;
completion `.shard-34-of-128.complete.json` SHA-256
`356d955cfc99dec5b19ca9e8d5745831b0d34a1c7b4ba9e30ce2e204ccd546ec`.

All 34 accepted artifact pairs and exact-scope identities revalidated:
**3,117 measured: 2,919 pass, 170 fail, 28 compile errors; 8,661 unmeasured**.
Next index 34. Remaining failures in this shard concern Promise constructor
realm, class setter descriptors, TypedArray.map callback receiver identity,
strict object-method receiver, GeneratorFunction prototype and invocation,
Iterator.windows return forwarding, and RangeError constructor realm.
This remains the frozen-source census, not integrated post-fix conformance.
The heavy test lease was returned to the copyWithin worker after termination.

### DataView/construct ownership preflight follow-up

Elevated read-only registry access resolved the earlier DNS-unknown state:
#5269 is reserved (ID allocated) but has no live claim. It is not permission
to allocate that ID again. The exact open-PR file scan found #5784 touches
property-access-dispatch.ts, new-super.ts and array-object-proto.ts; #5753
touches object-get-prototype-of.ts, new-super.ts and array-object-proto.ts.
Both proposed DataView routes and the shared construct guard therefore have
concrete overlap, despite there being no live #5269 claim. Do not dispatch a
production fix from this audit. The audit checkout also contains preserved
#5267/#4497 documentation at stale base 5bfc069422c7; it must not be repurposed
by discarding those changes. Future diagnostics need a current-base isolated
checkout, unchanged original, and separate field/constructor/prototype probes.

### Frozen census index 34 accepted

Terminal session 26064 exited 1 in 88.52 seconds: 93 originals, 90 pass,
2 fail, 1 compile error, zero skips. Completeness passed 93/93 without
exclusions. Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk034-a01`.
JSONL SHA-256 `c07637716afc668f647eef29b3d763f5648b294ebc5ffca8154465e63b70fce3`;
completion `.shard-35-of-128.complete.json` SHA-256
`f7865cfefcee3551e6d6f69b3c95666ee2af8ccdb36a89bd4d8fc1679df751c7`.
All 35 accepted artifact pairs and exact-scope identities revalidated:
**3,210 measured: 3,009 pass, 172 fail, 29 compile errors; 8,568 unmeasured**.
Next index 35. Failures are new.target/value-via-new.js (undefined rather than
constructor identity), Promise.any/resolve-throws-iterator-return-is-not-callable.js
(host import), and Iterator.windows/next-method-returns-throwing-value.js
(expected getter exception absent). These remain in the exact scope; no
inferred fixes or exclusions. The copyWithin worker has the heavy lease again.

### Frozen census index 35 accepted

Terminal session 90861 exited 1 in 91.63 seconds: 93 originals, 90 pass,
3 fail, no compile errors/skips. Completeness passed 93/93, zero exclusions.
Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk035-a01`.
JSONL SHA-256 `e82d90d3d7e3cee331b3a9076f457bbac1b266d46811953ab3903b87ea63a999`;
completion `.shard-36-of-128.complete.json` SHA-256
`15aed76af785d9f35f5957548554c79a4f60cd5feacea07e4a5f466759e32238`.
All 36 artifact pairs and exact-scope identities revalidated:
**3,303 measured: 3,099 pass, 175 fail, 29 compile errors; 8,475 unmeasured**.
Next index 36. Failures: Proxy construct trap-undefined NewTarget realm,
statementList/eval-class-regexp-literal.js (null rather than object), and
Iterator.windows/next-method-throws.js. The eval result-value row is assigned
for separate read-only attribution, not folded into the incomplete spread fix.

The copyWithin draft additionally needs real ToObject boxing for primitive
receivers, not only a nullish guard, and a one-line variadic ABI admission in
array-object-proto.ts to retain optional end. User clearance for that overlapping
seam is pending. No incompatible draft build was attempted. Root holds the
heavy lease after the worker explicitly returned it; no process remains live.

### Frozen census index 36 accepted

Terminal session 23778 exited 1 in 88.10 seconds: 93 originals, 87 pass,
6 fail, no compile errors/skips. Completeness passed 93/93, zero exclusions.
Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk036-a01`.
JSONL SHA-256 `7868e5d4fcbaa8c8df2a9e713ce81acad406cc6e68a74e9b406f4208223695cb`;
completion `.shard-37-of-128.complete.json` SHA-256
`9a8e757e21326894dd833b6ebeb3fe05e6fd8be4826210c091a9e1220d6ad5e5`.
All 37 receipt pairs and exact-scope identities revalidated:
**3,396 measured: 3,186 pass, 181 fail, 29 compile errors; 8,382 unmeasured**.
Next index 37. Failures concern splice species trap ordering, Array.from
missing source elements (NaN rather than undefined), Boolean subclassing,
derived-constructor this-check ordering, Function constructibility, and
Iterator.windows nonconstructibility. No failure is excluded; this is still
the frozen-source census, not an integrated post-fix pass rate.

### Frozen census index 37 accepted

Terminal session 97914 exited 1 in 83.97 seconds: 93 originals, 89 pass,
3 fail, 1 compile error, no skips. Completeness passed 93/93, zero exclusions.
Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk037-a01`.
JSONL SHA-256 `5d65cff98153022f3d160c3c62a47d39c85926c3b98de47e64436eb796128eb0`;
completion `.shard-38-of-128.complete.json` SHA-256
`be9267f09b34ddb56596bc0332e48e5e91a4b8c945424f7a9a83d9bade1a7c44`.
All 38 receipt pairs and exact-scope identities revalidated:
**3,489 measured: 3,275 pass, 184 fail, 30 compile errors; 8,289 unmeasured**.
Next index 38. Failures concern TypedArray construction observing an overridden
Array iterator, class computed-accessor assignment effects, nested Proxy
construction with distinct NewTarget (compile refusal), and Iterator.windows
throwing done getter. Frozen-source evidence only; all remain in scope.

### Frozen census index 38 accepted and next checkpoint base

Terminal session 82652 exited 1 in 88.92 seconds: 93 originals, 86 pass,
4 fail, 3 compile errors, no skips. Completeness passed 93/93, zero exclusions.
Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk038-a01`.
JSONL SHA-256 `f1a54be83e6c7aecd1c62b2991669f75da97e2ada84e2f6a9e08d67167859111`;
completion `.shard-39-of-128.complete.json` SHA-256
`9ae4bf795442c76d9e65867322622d97c583536d6a8b360fa413d065853ff372`.
All 39 receipt pairs and exact-scope identities revalidated:
**3,582 measured: 3,361 pass, 188 fail, 33 compile errors; 8,196 unmeasured**.
Next index 39. Remaining rows concern computed-accessor generator yield,
yield RegExp, noncallable Symbol values, yield-star in finally, captured-local
TDZ writes, generator spread, and rest-parameter constructor arguments.

PR 6239 is confirmed merged as 9b89b94de26530b83935e41d2e9a3751551b517c;
its exact head 01ee5deff06ca47afd80d2a5c2ef28399889826f is an ancestor of
fetched upstream main cb50f21b90, with unchanged handoff document content.
The next docs-only checkpoint branch is `codex/4444-census-handoff-038`,
fast-forwarded to that main while preserving these local updates. This does
not change the frozen census checkout or imply any new compiler repair.

### Post-6243 source refresh: RegExp audit superseded by landed B10

Fresh main cb50f21b90 includes PR 6230 and B10 commit fc823b5de3, introducing
regexp-untyped-receiver.ts and regexp-proto-to-string.ts. Source inspection
confirms a native RegExp __getPrototypeOf patch; the new focused test explicitly
covers eval-{block,class,fn}-regexp-literal{,-flags}. Therefore the earlier
eval-class RegExp source audit at 1032526/25834 describes historical source,
not the current upstream implementation. A remaining it.fails pin alone cannot
establish that the original still fails after this landed change.

The B10 issue record reports six repairs and explicitly warns about stale
QuickJS adapter artifacts. Those author measurements are useful handoff data,
not this census's current-base proof. Next: freshly build current compiler and
adapter, run exact original/neighbor identities via the maintained standalone
runner, and preserve completeness before assigning new repair credit. Keep the
frozen f924650 census unchanged; do not rewrite its historical failures.
This note postdates published documentation PR 6243.

### Eval checkpoint: current-bundle failures and owned ordering hypothesis

The strict-helper checkpoint's official seven-case run still reports three
controls passing and all four spread originals failing with unchanged zero
iteration counters. The worker verified a freshly rebuilt bundle containing
the new helper and all three call sites; stale compiler content is not the
current explanation. Its nine focused controls report five passes and four
failures (two tuple literals, prototype iterator override, grouped protocol).

Root source review identified a distinct, eval-owned ordering hypothesis:
emitStandaloneDirectEvalRuntime emits the global push/activation before
ArgumentListEvaluation, and emitRuntimeEvalResultUnwrap pulls globals after
eval. A top-level counter changed by iteration can therefore be overwritten
from the old published value. The official local-eval assertions pass before
the final counter assertion fails, so zero counter does not prove zero
iteration. Focused controls use function-local captured cells instead.
Indirect/script spread paths already stage arguments before seeding; their
nonspread branches retain the earlier ordering. The Function-constructor path
already documents and implements publishing after user coercions. The worker
is to separate early provider reservation from runtime value publication and
prove the diagnosis with original, global-side-effect and abrupt/nested controls.
No runtime confirmation or new repair credit is claimed from this trace.

The heavy lease was with the independent #2992 Array.from source-shape worker
for fresh baseline/WAT evidence; see the subsequent result below.

### Array.from diagnostic falsifies the proposed source-shape repair

The worker reports terminal maintained-run receipts 20260928-084746 (two
originals: source-object-length fails with NaN versus undefined, while
source-object-without passes) and 20260928-085123 (one-row diagnostic reproduces
the failure). Both have complete registration/verdict counts. These are worker
receipts, not a new integrated pass-rate measurement.

The diagnostic WAT shows an already-open source object, not the proposed closed
source struct. The Array.from result is subsequently materialized as vec_f64;
numeric unboxing converts the missing element's undefined to NaN. Consequently,
do not implement the proposed object-shape-widening exception. The worker is
tracing the actual result-materialization emitter and its ownership boundaries
before proposing a replacement implementation plan in issue 2992.

The diagnostic process is terminal and the heavy lease has transferred to the
5157 eval worker. That worker has separated compile-time sync-helper setup from
runtime global publication after argument evaluation, and added Script-goal
global-counter, ordinary-argument, nested-eval and abrupt-spread controls.
Runtime verification of that repair is pending; no passing credit is claimed.

Root independently inspected the existing diagnostic after correcting its
filename to `original.types.wat` (not `original.wat`; embedded NUL requires
text-mode searching). The module-init locals include `__objlit_24 externref`;
the post-call materialization loop writes array type 3 and constructs struct
type 4, which the paired type receipt identifies as the f64 array/vector.
The matching `type-coercion.ts` materializer selects `__unbox_number` for an
f64 element type. This corroborates the representation-loss diagnosis, not a
new candidate result. Existing receipts are preserved in the worker checkout's
`.tmp/2992-array-from-deleted-source/` with provenance; no diagnostic rerun was
needed to resolve the filename mismatch.

### Eval ordinary-argument control exposes another owned route

The worker reports a fresh 13-control checkpoint: eight pass, five fail. The
new Script-global spread counter, nested eval and abrupt-spread controls pass;
tuple/iterator-override diagnostics remain failing. The ordinary-trailing
Script control also fails and must be retained, not replaced by a passing
source spelling. These are focused results, not official-suite repair credit.

Root source review shows that `calls.ts` routes a top-level Script direct eval
through `emitStandaloneIndirectEvalRuntime` when
`directEvalRunsAtScriptGlobal` is true. That route's nonspread branch still
publishes globals before evaluating trailing arguments. Changing how the test
obtains its source string does not repair this ordering. The worker is to
retain the original diagnostic, add an explicitly function-scoped direct
control, and fix argument staging on the owned indirect/global-Script
nonspread paths using the same early preflight / late publication discipline.
No protected iterator or IR implementation changes are authorized by this.

### Array.from receipt verification and replacement repair boundary

Root ran the repository completeness validator on the existing baseline
20260928-084746 and diagnostic 20260928-085123 receipt pairs: respectively
2/2 and 1/1 registered verdicts, one shard each, zero explicit exclusions,
both validators exit zero. This independently confirms receipt completeness,
not semantic success (the original still fails).

The worker's source trace places the repair before numeric materialization:
Array.from already returns externref, but local/global declaration and hoist
type selection choose the checker-derived f64 vector. A shared representation
predicate must agree across variables.ts, declarations.ts and index.ts;
changing only one emitter would leave incompatible slot types. Root requested
explicit clearance for these inference sections because earlier user approval
was specific to RegExp and does not cover this broader Array.from repair.
The implementation plan continues in issue 2992; production edits remain held
pending that overlap decision. No change to type-coercion's generic numeric
conversion is justified by the current evidence.

### copyWithin checkpoint safety review (not completion)

Root reviewed the new argument-vector ABI guard in the owned helper. It runs
before dependency setup or body emission and rejects the current fixed
externref target slot, so the draft does not misread that slot as a packed
argument vector. The guard deliberately leaves the implementation inactive
until the separately held variadic admission change is permitted. It does
not fix any official test by itself and cannot justify a ready PR. The added
primitive/boxed-string strict-write controls remain executable but unrun;
their suspected provider gaps are not measured failures yet.

### Frozen census index 39 accepted

Session 6803 terminated with exit 1 after 92.42 seconds: 93 originals,
87 pass, five fail, one compile error, zero skips. Completeness independently
passed 93/93 registered verdicts, no exclusions. Receipt basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk039-a01`.
JSONL SHA-256 `6c8c07a25837c19a11343113944d8c10a9a456451261be06fdb70164d3890029`;
completion `.shard-40-of-128.complete.json` SHA-256
`25213eab1ef69a1a4323d54aeea45ad5f06094902fdd716f10e46ddbc07685df`.
All prior receipt hashes and all 3,675 unique exact-scope identities verified:
**40 shards, 3,448 pass, 193 fail, 34 compile errors; 8,103 unmeasured**.
Frozen-source census only, not integrated current conformance. Next index 40.

Nonpasses concern with/Proxy binding lookup, JSON.stringify invalid-replacer
admission, String.match builtin invocation, Proxy getter receiver identity,
Date constructor-realm prototype lookup, and Error.stack setter Proxy traps.
These require individual current-source attribution; error signatures alone
do not establish shared causes. Heavy lease returned to eval after terminal.

### Index 39 String.match failure already has a landed repair candidate

Current cb50f21b90 source includes B9 commit
`0afbe0b9338c069f72360e1ae4bb7c5baf941716`, adding replaced RegExp prototype
symbol invocation to the plain-ToString search/match path. Its focused test
explicitly names `built-ins/String/prototype/match/invoke-builtin-match.js`,
the new frozen failure. The original replaces RegExp.prototype[Symbol.match]
and checks receiver brand, pattern, flags, lastIndex, arguments and returned
identity; it is not evidence of the custom Symbol.split residual in 4016.

Do not dispatch a duplicate production repair based on the frozen failure.
Queue a fresh current-source original/B9-neighbor verification alongside the
already queued B10 check. The issue's reported flips and landed source are
not substitutes for that new maintained-runner result; no census credit or
current pass claim is assigned here.

### Eval official seven now pass on the repaired checkpoint

Worker session 9206 terminated exit zero, run 20260928-110738. Root read all
seven rows and independently ran completeness: **7/7 pass, one shard, zero
exclusions**, including all four unchanged spread originals and the three
controls. This improves the earlier strict-helper checkpoint's 3/7 to 7/7.
Compiler bundle SHA-256
`8ac14ebaf234090dcd1a2c67d2eeaf6b0bc6ad97d9f915af84c4e901a9a194c9`;
worker reports adapter key `0c57caffd9d2b507`, rebuilt and canary-verified.
Result JSONL SHA-256
`dd37cc1dde57e4a536a5ad706a9a3f8da2676a1074214bea7710acd471e0249c`;
completion SHA-256
`54ba255a183e80414c93b14800db02e375c29aca5bdb3d067403daa4eff7638c`.
Both are under the eval checkout's benchmarks/results with basename
`test262-standalone-results-20260928-110738` (completion suffix
`.shard-1-of-1.complete.json`).

This is a dirty-source checkpoint on base 1032526, not landed/current-main
conformance. Focused tuple/iterator override diagnostics remain mandatory;
their earlier failures are not erased by the official seven passing. The
worker retains the heavy lease for the expanded focused suite, followed by
checkpoint publication only with accurate remaining limitations.

The expanded focused suite subsequently reported **11/15 pass**. All added
ordering controls pass, including the retained ordinary array-element source,
alternate top-level source, function-scoped direct eval, nested eval and abrupt
spread. This refutes the earlier tentative source-construction explanation for
the ordinary control: retaining it exposed and verified the indirect-route
ordering repair. Four failures remain: two inline literal spread forms,
prototype iterator override (0 versus 1), and grouped protocol (23 versus 15).
They remain executable; the checkpoint is not ready to merge.

### Documentation PR 6243 one-time publication check

Before deciding where to publish the next handoff, a live upstream read found
PR 6243 still OPEN, non-draft, exact head
135681e58d77aceb6fa5e7881edadcfe2961c3b2. Quality and CLA checks pass, and the
review-thread query returned no unresolved threads (no threads at all).
Mergeability/merge-state were UNKNOWN, so no merge-ready claim or merge action
was made. The Test262 result is explicitly a documentation-only stub, not a
compiler conformance run. No polling/watch was started and no new updates were
pushed onto that open checkpoint. The initial sandbox network read failed;
the permitted elevated read succeeded.

### Fresh B9/B10 current-source verification: 19/19 pass

Root ran the maintained runner on the combined exact B9 (three originals)
and B10 (16 statementList originals) manifest. Session 37521 terminated exit
zero; run 20260928-111229, 48.70 seconds Vitest duration. **19/19 pass, zero
fail/compile errors/skips, complete 19 registered verdicts, zero exclusions.**
Root separately checked every exact identity, uniqueness and reached_test/pass.
The source/test/script tree is byte-identical to main cb50f21b90; checkout HEAD
135681e58d adds documentation only, and the only tracked dirty file is this MD.

Manifest snapshot SHA-256:
`35d5cfb6a7b848557c5dd786a794a12fa7064ef66808000e9b899fc31cd073e1`.
Fresh compiler bundle SHA-256:
`e2d178cdaa848bf25c5a8294faf1dfa76bb6ab1275b19745952025ef1480f905`;
runtime bundle SHA-256:
`70e84aba1c39a5f7808b17b92bd2e980fe35725587e0099d9e4f78c671b1467c`.
QuickJS artifact e9f8d30bc347 unchanged; adapter cache MISS rebuilt and
canary-verified as key `93e46d766b0fa227`, then selected by the worker.
Temporal off, standalone/auto, UTC, one worker, dynamic chunk 1/1.
JSONL `benchmarks/results/test262-standalone-results-20260928-111229.jsonl`
SHA-256 `2342236453f98653b4f5d9a7018377de0ec09fb6b4d0a85f11eb7058ba916801`;
completion suffix `.shard-1-of-1.complete.json` SHA-256
`57a2ee853b4183a88663f0437fbd2b71bf1e2ad1f0405790ed6fe29f8316003e`.

Thus the measured historical eval-class-RegExp and builtin-match originals
are passing on cb50 source. Do not duplicate their landed fixes or rewrite
the frozen census receipts. This 19-row verification is not the full 11,778
suite; history publication was disabled. Heavy lease returned to eval for
checkpoint publication hooks after this process terminated.

### Index 39 JSON invalid-replacer audit: preserve nested values, not a gate bypass

Read-only worker audit at cb50 identifies `JSON/stringify/replacer-wrong-type.js`
as the documented 5269 F3 residual. The original binds `{key:[1]}` to a
variable and supplies a noncallable/nonarray replacer. Current dynamic-replacer
classification is not the missing feature: call-namespace-static refuses its
nested closed value because existing normalization opens only the outer object,
which would otherwise silently omit nested data. Commit
1b482da37659f774f9c116cba4d8fea6623d8a61 deliberately retained that refusal.

Potential repair is JSON-specific recursive normalization of live nested
objects/arrays into codec carriers. Do not simply remove the flat-value guard,
recompile a mutable binding's initializer, or treat the existing refusal-accepting
focused test as semantic completion. The worker is checking exact active claims
and open-PR overlaps and whether a JSON-only companion avoids touching the
protected literals implementation. Parent issue status alone does not establish
live ownership. No production change or fresh current-run verdict is claimed
from this source audit; the frozen original remains in the full goal scope.

### Frozen census index 40 accepted

Session 59200 terminated exit 1 in 97.25 seconds: 93 originals, 84 pass,
eight fail, one compile error, zero skips. Completeness passed 93/93 with
zero exclusions. Basename:
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk040-a01`.
JSONL SHA-256 `25f0b81eafb1902130da318981b4a56a00064fea8e3213097e204d3d38c65799`;
completion `.shard-41-of-128.complete.json` SHA-256
`bd4f72b330eb05352df09a343a387b066108720eb68786ea31ae40668073f232`.
All 41 receipt pairs and exact unique scope membership verified:
**3,768 measured: 3,532 pass, 201 fail, 35 compile errors; 8,010 unmeasured**.
Next index 41. This remains frozen-source evidence, not an integrated pass rate.

Nonpasses concern computed static accessors, computed yield-name methods,
TypedArray subarray detachment, Promise.all subclass construction host imports,
DataView property extension, Proxy cross-realm NewTarget, ordinary __proto__
setting, eval new.target, and Iterator.windows return exceptions. Each needs
current-source verification before repair dispatch, including potential landed
Promise D4 changes. No scope exclusions or retry-based substitutions were made.

Eval publication's normal function-size gate rejected the enlarged direct
provider function (327 versus 301). No budget allowance or hook bypass was
added. The worker is extracting cohesive shared argument staging within its
already owned helper, then must repeat original/focused verification and gates
on that refactored source. Its preceding seven-pass receipt is retained but
cannot alone verify the new refactor. Heavy lease returned after this census.

### Checkpoint 6243 landed; next handoff branch synced

Action-tied upstream inspection confirmed PR 6243 MERGED as
dd6c16e73e63c7a499e338884c1e0d19c594113a. Fetch advanced upstream main to
86dbc35c4e; both the exact PR head 135681e58d and merge commit are ancestors,
and the published handoff document is unchanged between that head and main.
Root created `codex/4444-census-handoff-040` and fast-forwarded it to main,
preserving this new documentation diff. No shared workspace or frozen-census
checkout was changed, and no push to main occurred.

This main update includes PR 6237 prototype-chain extraction into the native
runtime. The preceding B9/B10 19/19 result remains specifically cb50-source
evidence; it was not rerun at 86dbc35c4e and is not silently promoted to that
new base. The eval candidate still measures its explicitly recorded base.

### Eval shared-helper refactor revalidated

The coherent argument-list extraction passed the function/LOC budgets without
an allowance. Fresh maintained run 20260928-112151 (terminal session 62978,
exit zero) again reports seven originals passing. Root independently verified
completion 7/7 with no exclusions. JSONL SHA-256
`53893a482da9d106029a21ef8eafda0e78cef245df4c7fd7b1defe38eb9e2701`;
completion SHA-256
`9bc24bb7f7928d38ff4b1ea16c3497632737035f8d5d91bfb4e0aae9bc27f9a5`.
Worker reports fresh compiler e93deb0651b6446c and adapter cache-miss/canary
key 345fa1d4eabfdd3e, followed by focused session 38332: 11/15 pass with the
same four unresolved semantic failures, no newly failing control. Raw focused
log is preserved in that worktree's
`.tmp/5157-focused-final-refactor-20260928-1123.log`.
These are refactored dirty-source candidate results at base 1032526, not a
landed fix or latest-main measurement. Normal commit/push gates and draft
publication remain pending; the four failures are not accepted semantics.

### JSON audit correction: existing vector support invalidates the broad rationale

Further source inspection corrected the initial recursive-normalization plan:
the native JSON codec already normalizes ordinary vector carriers to ObjVec
through indexed reads (4085, commit 62b2c4f3). The outer materializer stores
the original live nested vector as externref, so `{key:[1]}` does not require
a new vector normalizer merely because its child is an array. The later F3
flat-value refusal still describes that codec arm as absent. This is a stale
refusal rationale, not permission to remove all guards.

Nested closed objects, arbitrary internal/class carriers, sidecar mutations,
and replacer holder identity remain distinct safety questions. The worker's
one-time preflight found 5269 reserved without a live claim, 3176 actively
claimed by ttraenkler/dev-json, and open PRs 5753/5784 overlapping
call-namespace-static.ts; 5753 and 6235 also overlap literals.ts. Root asked
for clearance of only the JSON admission section before implementation.
No literals/runtime/IR change is authorized; no fresh compiler pass is claimed.
This supersedes the earlier suggestion that the original's nested array by
itself requires recursive carrier construction.

### Eval checkpoint published as draft PR 6246

Upstream https://github.com/loopdive/js2/pull/6246 is verified OPEN/DRAFT,
base main, exact fork head 4d35876fb17380df7ebe57b2a4f4a3b60bfd5485.
Root verified the remote ref, created the PR and attached it to this task.
The body uses the repository Description/Validation/CLA layout and dashboard
issue link, distinguishes four repaired originals from three preserved controls,
and discloses 11/15 focused results plus pending latest-main integration.

Normal pre-commit and pre-push gates passed without bypass or budget exception.
Initial push session 68244 stopped at the numeric-local suite's 512 MB Node 22
heap limit before upload. The unchanged commit passed normal push session 70779
under Node 24 with 4 GB fork heap: typecheck, lint, formatting, both ratchets,
18/18 numeric-local IR parity tests and issue integrity. The earlier subagent
fork denial was resolved by root's trusted explicit user authorization for that
exact destination; no direct-main push or force push occurred.

The eval worker is the passive shepherd for 6246. No polling/watch or ready
transition is authorized while the four tuple/iterator failures remain. This
is publication of an unfinished checkpoint, not completion of issue 5157 or
the ES2015 goal. Its clean worktree and diagnostic evidence remain preserved.

### Post-6247 verification plan: landed Promise D4

Documentation checkpoint c713478c21 is published as non-draft upstream PR
6247, verified exact head/base main and MERGEABLE at creation. Normal push
session 99763 passed all gates, including 18/18 numeric-local parity and issue
integrity. This new section is subsequent work, not part of that published head.

The read-only Promise audit maps frozen `Promise/all/ctx-ctor.js` to landed
D4's native class-capability path, also covering race/resolve/reject constructor
receivers. Module-shaped focused coverage does not prove the Script-shaped
original. Root will run those four exact originals plus the previously passing
`Promise/all/resolve-ignores-late-rejection-deferred.js` control on source
86dbc35c4e, with fresh bundles/adapter and completeness. The five-row manifest
is `.tmp/4444/d4-current-exact.txt`; no runtime result is claimed yet.
Known custom-resolve residuals are not mislabelled positive controls or removed
from the full ES2015 scope. Frozen census source and receipts stay unchanged.

### Promise D4 fresh original verification: 5/5 pass

Maintained run 20260928-113946, terminal session 90682 exit zero, completed
five registered verdicts: **5 pass, zero fail/compile errors/skips/exclusions**.
Root independently checked exact identities, uniqueness and reached_test.
All four `Promise/{all,race,resolve,reject}/ctx-ctor.js` originals and the
previously passing late-rejection control pass. The source/script/test tree
is unchanged from 86dbc35c4e; HEAD c713478c21 is documentation-only.

Manifest SHA-256 `d7313987340cd44eb923f762f56d90ffe52f9df8ea04401192eb2e9bc423f53e`.
Compiler bundle `8c54357178577a9e238de9beffd5db5826ceed39456f7a6fad977098d0169be1`;
runtime bundle `8dd093a1ab45e959215add1444dd08afd5716da127f92b9721a2202143c27fbd`.
Adapter MISS rebuilt and canary-verified as dd57532e96e6eb53 against the
unchanged QuickJS artifact e9f8d30bc347. Standalone/auto, UTC, Temporal off,
single worker, one dynamic shard. JSONL basename
`benchmarks/results/test262-standalone-results-20260928-113946.jsonl`
SHA-256 `6c4d310c0d86711e9b50f3b9f3fb766eb11de5594df27b51665bb1bd4975e4df`;
completion `.shard-1-of-1.complete.json` SHA-256
`d7fdd9af3e41f97f7a5a7d01493cd00b82bc3266e5c9f48f7d5015c54212c7e7`.

The frozen all/ctx-ctor host-import failure is therefore resolved on this
measured main source; no duplicate fix is needed. This does not credit the
unmeasured custom-resolve residuals or establish full-suite conformance.
Historical trend publication was disabled for this scoped run.

### Frozen census index 41 accepted

Terminal session 40074 exited 1 in 81.36 seconds: 93 originals, 88 pass,
five fail, no compile errors/skips. Completeness passed 93/93 with no exclusions.
Basename `test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk041-a01`.
JSONL SHA-256 `ff454d3a1c0548448092353be5b5ea50be97db7165274a602071bd8735dd1f4b`;
completion `.shard-42-of-128.complete.json` SHA-256
`fbb96c4ba1fc15809cd4ad44dc9f69e086ffc8a45ba3cdcc2e586c0a1d6cceef`.
All 42 receipt pairs and unique scope membership verified:
**3,861 measured: 3,620 pass, 206 fail, 35 compile errors; 7,917 unmeasured**.
Next index 42. Frozen-source evidence only, not integrated current conformance.

Failures concern computed super property access, Script function declaration
configurability, Iterator.windows nonobject next results, Date subclass
prototype identity and Array.of Proxy define-property abrupt completion.
The Script declaration failure and preceding TypedArray detachment failure
are assigned read-only current-source audits; no edit is licensed merely by
the frozen error message. Existing overlap holds remain in force.

### Frozen census index 42 accepted

Terminal session 7376 exited 1 in 92.60 seconds: 93 originals, 90 pass,
two fail, one compile error, zero skips. Completeness passed 93/93 with no
exclusions. Basename
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk042-a01`.
JSONL SHA-256 `7ff3b37d81f4faac54128d6f967334256f12f3496f7972e77d8cc7e78b99625e`;
completion `.shard-43-of-128.complete.json` SHA-256
`c88b126b389a0415fc0b6e0f17f3ccfa796ce6522d6970486f8ec975ac8b382f`.
All 43 receipt pairs and unique scope membership verified:
**3,954 measured: 3,710 pass, 208 fail, 36 compile errors; 7,824 unmeasured**.
Next index 43. Frozen-source census only, not an integrated current pass rate.
Nonpasses are yield-from-with native generator refusal, Promise.then
`S25.4.5.3_A5.1_T1` async assertion (3 versus 4), and Iterator.windows
throwing return getter (wrong exception type). No retries or exclusions.

### TypedArray detachment audit and current-original verification plan

The worker traced the observed detached-buffer TypeError to a likely fallback
constructor after custom species lookup, not the public byteOffset accessor
(which already returns zero after detachment). The original expects the stored
internal offset after end coercion detaches the buffer and returns a prebuilt
result from a computed `[Symbol.species]` constructor literal. A closed literal
can be invisible to runtime symbol-key lookup, unlike the open holder used by
the existing focused custom-species test. This remains a source hypothesis.

Root will run four unchanged originals on source 86dbc: the failing byteoffset
case, pre-detached ordering case, previously passing custom-ctor control, and
custom-ctor invocation case. The manifest is
`.tmp/4444/typedarray-subarray-current-exact.txt`. Do not alter detachment
semantics to hide a species lookup failure. A producer-side repair would touch
the currently protected literal representation path; no edit is authorized
by this diagnostic plan, and results are not yet known.

### TypedArray current-original verification result

Run `20260928-114844` on source
`86dbc35c4ed772f2f100ec95dbe86ce86e9eee84` completed: **2 pass, 2 fail / 4**.
Independent completeness validation confirms four registered verdicts, all
reached, zero exclusions. Both custom-species constructor controls pass.
`detached-buffer.js` fails observable ToInteger(begin) ordering;
`byteoffset-with-detached-buffer.js` throws a detached-buffer TypeError.
These remain separate diagnostic questions, not a proven shared defect.
The runner wrapper exited zero despite failed verdicts; it is not a pass signal.

JSONL `benchmarks/results/test262-standalone-results-20260928-114844.jsonl`
SHA-256 `02bcada2692fa3b8ffd25dc041b27c2740216b82b03af1392de18bfbff2efa94`;
completion `.shard-1-of-1.complete.json` SHA-256
`8c5a1843c8bb246468030d053c15719010cf0d528dbf96ea7da1b898da938ebb`.
Compiler SHA-256
`8c54357178577a9e238de9beffd5db5826ceed39456f7a6fad977098d0169be1`;
runtime `8dd093a1ab45e959215add1444dd08afd5716da127f92b9721a2202143c27fbd`.
The existing audit worker will reconcile the passing species controls and
trace pre-detached ordering independently before any repair is proposed.

### Array.of Proxy writer implementation handoff

Read-only audit at source 86dbc established that Array.of.call preserves the
constructor's returned Proxy. The shared constructor-lane writer in
`array-from-native.ts` instead calls `__defineProperty_value` (which skips
Proxy defineProperty dispatch), followed by ordinary Set. That cannot implement
CreateDataPropertyOrThrow for a handler exposing only defineProperty.

The next isolated worker must first revalidate issue 5268 ownership and current
PR overlap, update its MD implementation plan, and implement the Proxy writer
through existing descriptor/trap machinery. Descriptor flags must request
writable/enumerable/configurable; false results must throw; abrupt completion
must propagate; no subsequent Set may run on that Proxy path. Preserve existing
non-Proxy vector storage and test Array.from callers as well as Array.of.
No literal, inference or IR changes are included in this assignment.

### Global Script function descriptor audit handoff

At source 86dbc, `language/global-code/script-decl-func.js` enters the dedicated
`$262.evalScript` lowering in calls.ts, then the `__runtime_script_eval`
provider export. The adapter's global-Script path reuses `qjsCreateEdiBindings`,
which creates new bindings by assignment with configurable=true. Pulling the
function value back preserves that descriptor. Global Script declaration
instantiation instead requires configurable=false for this new function.

This is not the normal eval snapshot-order defect in PR 6246. Eval's
configurable=true behavior remains necessary; a global change to the shared
EDI helper would be incorrect. Static function-binding flags and host-mirror
defaults do not cover the dynamic string in this original. The audit worker
is checking adapter ownership and PR overlap before any isolated repair.
Required controls include ordinary eval descriptors, new Script functions,
existing bindings/redeclarations and lexical declaration failures. No provider
edits or new passing-test claims accompany this audit.

### Frozen census index 43 accepted

Terminal session 75409 exited 1 in 85.43 seconds: **92 originals, 85 pass,
7 fail, zero compile errors or skips**. Completeness passed 92/92 with zero
exclusions. Basename
`test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk043-a01`.
JSONL SHA-256 `c5a59ec864e47ac0172aec654dcebc1d867ec1bfea69f93dc8eb2e3e706f1fec`;
completion `.shard-44-of-128.complete.json` SHA-256
`a3c6f5ad6decdb490c03b1f1b37a77061fde8c9c7960dfae57c8a139633742e9`.
All 44 receipt pairs and unique exact-scope membership verified:
**4,046 measured: 3,795 pass, 215 fail, 36 compile errors; 7,732 unmeasured**.
Next index 44. These are frozen-source measurements, not an integrated current
pass rate. Failures concern derived default constructor length, module namespace
key sorting, cross-realm Function/ThrowTypeError behavior, Proxy defineProperty
nonextensible-target invariants and Error.stack Proxy receivers. No retries,
scope exclusions or semantic shortcuts were applied.

### Frozen census index 44 accepted

Session 7704 exited 1 in 93.41 seconds: **93 originals, 85 pass, 8 fail**,
zero compile errors/skips. Completeness passed 93/93 with zero exclusions.
Basename `test262-standalone-es2015-fullscope-128-results-es2015-fullscope-128-f924650-chunk044-a01`;
JSONL SHA-256 `2ff5b4945d3f83f56da3d31d84b41f53eb65a41fb9ffecbc8190a6c6b45b74fb`;
completion `.shard-45-of-128.complete.json` SHA-256
`63706ba2cd2aed3cff41722c4bbda806664bc170684d938f3feeae3e8c8af970`.
All 45 receipt pairs and unique scope identities verified: **4,139 measured,
3,880 pass, 223 fail, 36 compile errors; 7,639 unmeasured**. Next index 45.
Frozen-source evidence only. Failures cover DataView constructor identity,
computed class accessors/symbol methods, destructuring iterator override,
Script declaration collision, Error.stack subclass receiver, Iterator.join
method presence and module namespace key enumeration.

### TypedArray audit distinguishes two mechanisms

The current-source audit identifies early `emitTaDynViewValidate` in
`emitDynViewSpeciesMethodTwoArm` as the pre-detached subarray ordering failure:
start/end coercions must still occur with sourceLength zero. A prospective
subarray-only prelude should use `pushTaDynViewInBoundsLen`, not the effective
length helper, and preserve validation of the newly constructed result.

The passing species controls assign `constructor[Symbol.species]` dynamically;
the failing original uses a closed computed-symbol literal. Closed field
`@@species` lacks a boxed-Symbol lookup arm in closed-struct extern Get, supporting
the independent species fallback hypothesis. No runtime A/B yet proves that
repair. Any consumer/MOP or literal producer edit requires overlap review;
do not combine these mechanisms into one unverified diagnosis.

### Candidate review and test-lease handoff

The Array.of/Array.from Proxy candidate now exists in isolated
`codex/5268-array-of-proxy-create-data-property` on base 86dbc. Root reviewed
the initial shared-writer diff: descriptor dispatch consumes its result,
falsy completion constructs TypeError, and only the ordinary receiver branch
retains dense-slot Set. Fresh throw instruction trees avoid shared remapping.
This is static review, not validation or pass credit. The worker holds the
next heavy-process lease for unchanged-base attribution and candidate tests.

The success regression must expect `define:0,set:length`: final strict Set of
length is required by both algorithms. Poisoning every Set would reject correct
behavior; only unexpected element Set should fail that control. Root's unchanged
86dbc documentation worktree is available for baseline execution without
swapping candidate source files.

The Script descriptor follow-up requires more than changing configurable:
preserve existing var descriptors, validate declaration admissibility and
lexical collisions before effects, and reconcile declared values on abrupt
completion as well as success. The worker's cached-ref audit is insufficient
for remote ownership; fresh action-tied claims/PR overlap checks are required
before creating its separate implementation lane. Ordinary eval's EDI helper
must remain unchanged.

### Proxy candidate dependency review

Root inspected `__create_descriptor`: attribute bits 1/2/4 construct a fresh
ordinary descriptor with value plus all three booleans. The existing
`buildDefineDispatch` already invokes descriptor invariant validation; its
older registration comment claiming that invariants are deferred is stale.
Do not duplicate or bypass that validation in this fix. A trap-absent Proxy
forwarding control is requested because the new branch also routes through
`__obj_define_from_desc` when no defineProperty trap exists. Verify stored value
and writable/enumerable/configurable attributes, not merely absence of throws.

Baseline execution must use the unchanged root documentation worktree even
when its exact manifest is stored in the candidate worktree. Candidate source
has already changed, so running there cannot count as baseline evidence.
No baseline or candidate result has yet been received for this new fix.

### Array.of Proxy baseline independently verified

Maintained run `20260928-100517` in the unchanged-source root documentation
worktree reproduces the original: **0 pass / 1 fail**, reached and settled,
zero exclusions. The exact one-path manifest is SHA-256
`40d661b014462c8dd8b2b7d7fb97acd450c609699c336927dc749325b556839f`.
The failure is missing expected Test262Error from the defineProperty trap.
Root independently read the row and validated completeness against its actual
`.shard-1-of-16.complete.json` receipt (one selected local shard, not a completed
sixteen-shard suite). The registered identity matches the entire one-path scope.

JSONL `benchmarks/results/test262-standalone-results-20260928-100517.jsonl`
SHA-256 `985f25004fd562d99a1b0ea5845a3075a4cff59577f057de2f8e3e7a5a52c1e1`;
completion SHA-256
`dcae659e283819eccfc8fc3955d28845c904c9c7b873ef7b1289072b0d3a5f53`.
Candidate execution is still outstanding. Separately, Node v24.19.0 passed
eight oracle controls (four each for Array.of/from): descriptor and trap order,
exact thrown identity, false rejection and trap-absent forwarding. These are
reference semantics only, not compiler pass credit.

### Array.from candidate review: shared instruction identity

Root found that `ensureNativeArrayFrom` constructs one `perElement` instruction
array and embeds its objects in both the iterator try body and array-like
branch. The candidate adds a Proxy ref.test/type index and throw subtree to
that shared array. `buildStandardTryTable` does not clone: the physical
exception-control helper mutates branch depths and embeds the same body.
Reusing mutable instruction objects across two positions risks repeated index
remapping. A fresh per-element instruction factory for each branch was requested
within the owned array-from-native file; no IR/helper changes are requested.
Both array-like and iterable Array.from controls must exercise the result.
This static review finding is not a measured runtime failure or a passing fix.

### Candidate preparation correction and infrastructure attempt

The worker implemented the per-branch instruction factory, and root verified
both iterator and array-like consumers call it independently. The dedicated
regression now covers iterable Array.from as well. Root executed all five
original fixture bodies against their exact expected output arrays in fresh
Node v24.19.0 contexts: 5/5 reference results, not compiler evidence.

The first candidate runner attempt stopped before compiler build with
`ERROR: test262 symlink failed`; the worker reports terminal PID 86456 and no
candidate verdict or completion receipt. Treat this as setup failure, not a
conformance failure or a completed run. The repository's symlink-only worktree
dependency provisioning is authorized after inspection and preservation checks;
verify corpus identity against baseline before a distinct retry. The valid
unchanged-source baseline remains intact.

The next attempt, run `20260928-101024` / worker session 59517, completed
compiler bundling but stopped before Vitest: the new worktree lacked a cached
QuickJS artifact and local clang-18/WASI tooling. Again there is no candidate
verdict or completion receipt. Root verified the supported
`JS2WASM_QUICKJS_ARTIFACT_DIR` acquisition path and immutable existing binary
SHA-256 `e9f8d30bc347dbc56f31b3389f7696eb6dedc9f05ea729781fc412f09a3e6b17`.
The worker will reuse that artifact with the matching ABI, then build a fresh
compiler-keyed candidate adapter; do not reuse a baseline linked adapter.
No installation, test exclusion or semantic-provider downgrade is needed.

### Array.of Proxy original flips on candidate

Worker session 76653 is terminal. Maintained run `20260928-101135` records
**1/1 pass**, reached, zero exclusions/compile errors, for the unchanged
`Array/of/return-abrupt-from-data-property-using-proxy.js` original. Root
independently read the verdict and verified completeness. Baseline run
`20260928-100517` above failed this same path on unchanged source 86dbc.

Candidate JSONL `benchmarks/results/test262-standalone-results-20260928-101135.jsonl`
SHA-256 `5598c9fdd8212a265a89d6b3fca953a0fdc475514f9d2082468ad4484b3976df`;
completion `.shard-1-of-1.complete.json` SHA-256
`782e16744c7ab2b275b06bf1f99d8f5ef9557eba3a043349b22ed24444a620d8`.
Worker reports candidate adapter key `e9d493340eadb728`, built and canary
verified against bundle prefix `b250085587e81964`; immutable QuickJS artifact
remains e9f8d30bc347. Dedicated regressions and normal gates are still required
before publication/readiness. This isolated candidate flip is not a landed or
integrated full-suite result.

The subarray-ordering worker now owns isolated branch
`codex/6651-subarray-ordering` in `/Users/thomas/.codex/worktrees/subarray-ordering/js2`
at source 86dbc. Exact remote hunk review found the only open array-methods
change is disjoint boolean metadata in PR 5748; PR 5753 has neither target
file across its paginated file list. Only the subarray prelude/import and a
dedicated test are authorized; no closed-symbol or IR changes are included.

### Proxy candidate regression result: not ready

Dedicated session 11522 is terminal: **3/5 pass, 2 fail**. Exact thrown-object
identity, false-result TypeError and ordinary custom/default controls pass.
The successful-trap case observes the required descriptor and exact
define-index/Set-length ordering for Array.of, array-like Array.from and iterable
Array.from, but each comparison with the captured Proxy variable returns false.
The trap-absent forwarding case throws an opaque Wasm exception during module
initialization before descriptor assertions complete.

Both failing assertions stay intact. The worker must compare these exact
fixtures against unchanged source and isolate the first failing operation;
neither failure is established as unrelated or pre-existing. In particular,
the candidate changes the trap-absent dispatch path, so its failure must not be
dismissed as an external limitation without attribution. No ready PR or
five-test green claim is justified. The one original Test262 flip remains
valid isolated evidence, not sufficient acceptance.

### Subarray ordering candidate initial review

The isolated worker has now implemented the planned subarray-only prelude.
Root inspected the diff and the existing in-bounds-length helper: subarray
avoids early validation/materialization, snapshots its length and calculates
the byte offset before end coercion; map/filter/slice retain their prior
validation/materialization path. The plan was corrected to state that moving
offset calculation is a change, not preservation of the old ordering.
Shared-prelude controls for slice/map/filter are required. No compiler result
exists yet for this candidate; it waits behind the Proxy diagnostic lease.

### Proxy attribution and test-slot transfer

The worker reports exact focused-fixture A/B with fresh tsx source loading,
empty imports and valid Wasm: both baseline and candidate fail captured Proxy
identity comparisons, and both throw during the exact trap-absent fixture.
Candidate event traces change from element Set to the required descriptor
dispatch followed by Set(length). These measurements attribute those two
residual fixtures as pre-existing, not proof of global regression freedom.

A baseline direct-versus-bound diagnostic reports direct Array.of/from result
identity true, bound result identity false. This narrows the next emitted-route
investigation to result binding/conversion rather than native return identity;
candidate diagnostic and persisted raw attribution records remain pending.
The original failing assertions are unchanged.

Root verified no compiler process in a read-only process snapshot; the Proxy
worker then explicitly confirmed no live process and released the heavy lease.
The subarray worker's five-control fixture is ready, so it now holds the lease
for the matched four-original maintained run followed by focused regression
checks. No parallel compiler run is authorized.

### Namespace census failures: preserve the harness-linked reproduction

Root read the unchanged `own-property-keys-sort.js` original and the older
6651 N2 audit before proposing another namespace fix. The historical audit
reproduced its standalone illegal cast only in harness-linked assembly;
equivalent compileMulti/self-import/unicode-key probes passed. It specifically
calls for WAT from the runner-assembled module around Reflect.ownKeys index
reads, not another speculative export-sort repair.

For `own-property-keys-binding-types.js`, that audit refuted an alias-resolution
diagnosis with a successful ten-key compileMulti control, while the old runner
observed seven keys. Current frozen census instead records an illegal cast.
These are different first failures; do not transfer the old attribution to the
new result. Future work must remeasure both unchanged originals under the
current maintained runner and inspect its assembled artifact before source
ownership or implementation is assigned. No new namespace fix is claimed.

### Checkpoint publication state and provider review

An action-tied publication check confirms PR 6247 merged at
2026-09-28T10:00:03Z. Fetched upstream main is
`2e23e49fb1d7ee1a6b86ab16c3e85aee1d95c143`; the published checkpoint head
c713478 is an ancestor. Source remains byte-identical: intervening differences
are npm-compat result artifacts. New appended handoffs are still uncommitted
and are not claimed as part of that merged PR.

Script-only provider work is now tracked in local issue 6724. Root review of
its first draft identified three unresolved correctness concerns: unknown
probe/resource results must not silently authorize skipping carrier declaration
checks; fresh-realm own-name differences omit declarations reusing intrinsic
names; and failed value crossings must not be hidden by clearing refusal state.
These were returned to the worker before runtime validation. The dedicated
runTest262File suite is supplemental; a maintained exact-cohort runner receipt
is also required. No provider fix or pass gain is claimed.

### Subarray candidate matched originals: one verified flip

Session 30119 is terminal. Maintained run `20260928-122422` gives **3 pass,
1 fail / 4**, versus baseline 114844's 2 pass/2 fail. Root independently read
all verdicts and verified four registered/settled originals, zero exclusions.
`subarray/detached-buffer.js` now passes and both species controls remain
passing. `byteoffset-with-detached-buffer.js` remains included and fails with
the same detached-buffer TypeError; it is outside this repair's mechanism,
not excluded from the cohort or the goal.

JSONL `benchmarks/results/test262-standalone-results-20260928-122422.jsonl`
SHA-256 `d3bee17997ffda8cf96efbc77ff96488257a8c110202c1f4712266884399997d`;
completion `.shard-1-of-1.complete.json` SHA-256
`e2e44303f5ba1e530f8a178f33fb43d8d0c2f6789c0ea7be6fac01f2d7c2022f`.
Candidate adapter `244c81abc2a5004e` was freshly built and canary-verified.
Focused five-control session 1413 is now live. This is isolated candidate
evidence, not a landed fix or integrated suite result.

### Subarray focused validation complete; publication preparation

Focused session 1413 exited zero in 52.44 seconds: **5/5 passed**. Coverage
includes pre-detached coercions, begin-detach length snapshot, end-detach byte
offset/species arguments, attached shared-view aliasing and map/filter/slice
continuity. Together with the maintained 3/4 versus 2/4 original comparison,
this supports the narrow ordering fix, not the remaining closed-species issue.
The worker is updating issue 6651 and preparing normal gates and an upstream
PR. No commit, published PR or gate success is claimed yet.

Root also verified the Proxy worker's preserved record and source hashes:
validation record `05abcc46f505a3b27e0af99f3043c873312f8e6f40f6573f8cc48ab742723cf9`,
candidate writer `bfbdd069ad742fd4a21867224ad6089f991e8a600738845b6887a9e4e2021995`,
baseline writer `da86fc673667dba0878a196a380b46b9832c8e6450da34fe3c68141ccdf47d95`.
Both worktrees contain the same focused A/B script SHA
`d8c640d3c16dc51421f5d5111379de593148155235e009ef8e905690dcc629d4`.
The Proxy lane now has the released test slot for its bounded candidate
direct-versus-bound diagnostic and existing Array.from regression suite.

### Final checkpoint 44 handoff before publication

The Proxy candidate's direct-versus-bound diagnostic matches baseline
(`of-direct=true`, `of-bound=false`, `from-direct=true`, `from-bound=false`),
with empty imports and valid Wasm. Existing
`issue-5268-r3-array-from.test.ts` then passed **10/10** in terminal session
44027 (60.06 seconds). Dedicated candidate regressions remain **3/5**, with
both unresolved assertions retained. Updated preserved validation record SHA
is `93da38fd86b0ce8f5bfc82d4d10023467e9c7b0ac69fae9ddba188177dbdf13e`.
This checkpoint is not ready to be described as a completed Proxy repair.

The subarray lane now holds the heavy lease for normal publication gates.
The Script provider draft remains unmeasured and under review; metadata probes
must not depend on Object/String/globalThis bindings that user declarations
can replace. No provider success is credited.

Root's handoff branch is `codex/4444-census-handoff-044`, fast-forwarded to
verified upstream `2e23e49fb1d7ee1a6b86ab16c3e85aee1d95c143` without changing
compiler source or the existing baseline fixtures. All census counts remain
frozen-source evidence: **4,139/11,778 measured; 3,880 pass, 223 fail,
36 compile errors; 7,639 unmeasured**. Next frozen index is 45. Current candidate
flips are tracked separately and do not rewrite this historical denominator.
The full integrated 100% goal remains unachieved.

### Proxy result-binding follow-up: producer classification seam

The worker's read-only audit narrows the direct-versus-bound discrepancy:
`call-builtin-static.ts` returns externref from the intrinsic Array.from/of
`.call` route, but module-global inference does not classify that producer as
requiring externref. The initializer therefore requests a vector, and
`type-coercion.ts` materializes one when the Proxy fails the vector ref-test.
This explains the measured identity loss at source level; WAT confirmation
is still pending and no broader inference fix is credited.

The proposed repair is a producer-specific predicate, not a blanket change to
externref-to-vector coercion. It must cover module/local/hoisted bindings,
preserve ordinary/default/nullish constructor lanes, and explicitly account
for generator spill typing. The worker's one-shot overlap check found active
changes in declarations/index/variables/call-builtin-static, so these shared
files remain coordination-gated. The existing failing assertions stay intact.

Subarray's normal commit hooks have passed. The worker reports rebased commit
`010107c75c` in mandatory pre-push validation (session 88040); remote publication
and an upstream PR remain unverified at this checkpoint. The Script GDI worker
is replacing realm-visible bookkeeping with a retained private QuickJS closure
and parser-based name probes. That draft remains unmeasured; valid Unicode and
escaped declarations must not be replaced by blanket refusal to obtain green
tests.

### Frozen census index 45: complete after corpus-link repair

Attempt `es2015-fullscope-128-f924650-chunk045-a01` stopped before collection
(session 84422, exit 1): the local test/harness links referenced an unavailable
worktree. No tests registered and no semantic verdict was produced. Only those
two broken links were repointed to the original preserved corpus revision
`b363f29d3c43c626dc852744ad64a0b48a003693`; the exact-manifest preflight then
validated all 11,778 paths. The failed attempt was retained, not overwritten.

Attempt `es2015-fullscope-128-f924650-chunk045-a02` completed in session 89691
(exit 1, 192.07 seconds): **86 pass, 7 fail / 93**, no compile errors or skips.
Completeness independently passed: 93 registered, 93 verdicts, zero exclusions.
JSONL SHA-256 `ebfcb0c8f30762dadeee59d5e783b820a38ddcd2cc94b3f6f49560673ae10148`;
completion shard-46-of-128 SHA-256
`e12daa3022deb334f9c87c31e9dd42fb50c73d748c6904f287dd82497090f12b`.

All 46 accepted receipt pairs and unique exact-scope identities were rechecked:
**4,232 measured = 3,966 pass + 230 fail + 36 compile errors; 7,546 unmeasured**.
These remain frozen-source results, not integrated current-source conformance.
Next census index is 46. Failures cover GeneratorFunction length, generator
yield/spread, Proxy ownKeys symbol invariants, derived-class this restrictions,
AsyncGeneratorFunction constructability, Error stack getter constructability,
and DataView constructor identity; signatures are routing leads, not proven
root-cause groupings.

The Proxy result-binding WAT diagnostic also completed (session 17872, exit 0,
empty imports), SHA-256
`f131a4539525bb88c59806a5105898b94717f756bf22cdda74bd40107e6813f1`.
The emitted initializer calls the native producer, materializes a new vector
through extern length/index reads, then stores the module binding. This proves
the bound identity loss occurs in result conversion, not the element writer.
The earlier output-write EPERM attempt is retained as infrastructure failure.
Shared inference edits still await overlap clearance. Script GDI baseline
validation has the released heavy-test slot; no candidate pass gain is claimed.

### Script GDI current-source baseline: 7/13

Maintained run `20260928-125722` on documentation HEAD
`c5240cd0e837129e14e7c81b04eb7ef8500b047f` (compiler source unchanged from
86dbc35c) completed with **7 pass, 6 fail / 13**. Root independently validated
13 registered/settled rows, zero exclusions and read every verdict. Manifest
SHA-256 is `15caacb9049a0b885fd6fa9e9da19fa6c126dedec880fc7d2b4f5a0e4b2ce173`.
JSONL SHA-256 `fdc28ed3a96ee012b5a81103e5c78a4e2c768270539d405e3a589a261e654d0c`;
completion shard-1-of-1 SHA-256
`9e0aa5cebcf2bb35d90f33789e8d5d0b4ff4c0194c31f7fffb7d568e6ee6108d`.

Five failures concern Script function/var descriptors, non-configurable
function admission, restricted-global lexical admission and lexical/var
collision. The sixth is the ordinary-eval update-configurable control; it is
an included baseline failure, not a passing guard. The candidate must preserve
all 13 originals and report per-file changes without relabeling that residual.
The wrapper's exit zero does not imply test success. Candidate validation is
next; no repair credit is recorded yet.

Candidate run `20260928-130115` is still live at this checkpoint (worker
session 98528). Its fresh adapter `daecbb7f4e24af46` was built and canary-checked
against the verified native artifact. Partial rows include compile timeouts
for `script-decl-var.js` and the baseline-passing `script-decl-lex-var.js`,
alongside a pass for `script-decl-func.js` and unchanged failures. These partial
results do not establish a successful repair. Exact pool/heap/timeout launch
settings are being audited; the live run is not restarted or discarded. All
timeout verdicts must remain in the eventual comparison.

That candidate is now terminal (98528, exit 2), and completeness rejected it.
The worker's launch audit found all five requested resource controls absent:
COMPILER_POOL_SIZE, VITEST_MAX_FORKS, TEST262_IT_TIMEOUT_MS,
TEST262_WORKER_MAX_OLD_SPACE_SIZE and VITEST_FORK_MAX_OLD_SPACE_SIZE. Defaults
produced seven compiler workers, 512 MiB worker/fork heaps and 90-second test
timeouts. The incomplete receipt must not be credited as a conformance result
or silently replaced. This was a launch-configuration error, not evidence that
the provider implementation is correct or incorrect.

A new matched baseline/candidate pair is authorized with the same exact 13
originals, distinct run IDs, one compiler worker/fork, explicit 4 GiB heaps and
300-second outer test timeout. Both sides must use these identical controls;
the original baseline and incomplete candidate remain preserved. No runner
source changes, exclusions or weakened expectations are authorized.

Corrected serial baseline `20260928-130531` completed (session 73117, exit 0):
**7 pass, 6 fail / 13**, the same six original failures, no timeouts. Root
validated 13 registered/settled verdicts with zero exclusions. JSONL SHA-256
`fb92992a7b3c479dd9baec37976a1166b5c7f2190d2d9b4f7a7553e53269c9a6`;
completion SHA-256
`054b6b534fa52a811e1f3edf9b432d8f27e46cf4127433722bcfa891ccb91c81`.
The runner banner confirmed one unified worker. Candidate comparison uses the
same explicit resource settings and exact manifest; it remains pending.

Matched serial candidate `20260928-130740` is complete (session 93496, wrapper
exit 0): **8 pass, 5 fail / 13**, zero exclusions or timeouts. Root independently
validated completeness and compared every row to baseline 130531. The sole
status flip is `script-decl-func.js` (descriptor assertion to pass).
`script-decl-var.js` remains failing, with the descriptor assertion replaced
by a null/undefined-access TypeError; the original has later descriptor and
non-extensibility stages, so attribution requires a paired stage diagnostic.
All other statuses/errors are unchanged. No broader completion is claimed.

Candidate JSONL SHA-256
`d34b02826d7eb8117d6709ff0596d2b66bfa9c68665ac3a518567d683c940e19`;
completion SHA-256
`44f2d77050bc40314f18bc0f2fd1d60fdfca1f95bf91027b1ca001975c6f7ebd`.
The preserved incomplete run 130115 is not part of this matched comparison.
Five remaining originals and the supplemental intrinsic/Unicode controls
remain required work; this is candidate evidence, not a published fix.

### Literal species focused candidate: 2/4, not complete

The separate candidate on subarray-fix base
`010107c75ce8a46f60cae226af49ad568258fc0a` completed focused session 24089:
**2 pass, 2 fail / 4** (exit 1, 48.23 seconds). Same-object string/symbol-key
collision and inferred alias/property/array/parameter/return flow passed.
The declared contextual carrier boundary threw before its assertion; a local
shadowed `Symbol` returned the wrong result. Root had independently checked
all four expectations against Node24 (4/4); that is oracle evidence only.

All assertions remain intact. Exact baseline comparison is queued before
calling either failure pre-existing. No semantic-completeness or publication
claim is made. The command set NODE_OPTIONS to 4 GiB but omitted the dedicated
Vitest fork heap override; the child's actual heap was not observed before
exit, so a 4 GiB fork must not be claimed. Settled results are retained without
an opportunistic retry. The heavy slot passed to Script stage diagnostics.

### Proxy ownKeys symbol invariant: current-source baseline reproduced

Local issue 6726 tracks the exact frozen missing-Symbol-key row. Maintained
run `20260928-131755` on source-equivalent documentation base `c5240cd0e8`
completed with **0 pass, 1 fail / 1**, no compile errors/skips. The row reached
its assertion: expected TypeError was not thrown. Root independently validated
one registered verdict and zero exclusions. JSONL SHA-256
`7e7c089749eb55115082e56d5411f3ef596c6a3f3e69380d02fe94fff7a4c0a0`;
completion SHA-256
`12ef59a433bbfa6ab15cca34dba2d9d9ab240a50f0298a2bbee0cfa0b4205999`.
Session 2220 is terminal; wrapper exit zero is not a passing test result.

Implementation is held because issue 5316 still claims the same ownKeys
invariant seam. User clearance is pending. The plan also must preserve a
single target OwnPropertyKeys snapshot for nested Proxies; reading names and
symbols independently cannot silently double an observable trap call.
No production edit or repair credit accompanies this baseline.

The supplemental Script stage instrument has not yet produced valid stage
evidence. Session 51453 read markers from the wrong host sandbox; session
75152's positive stage-42 control returned only an opaque WebAssembly exception,
so its staged result was correctly rejected and the candidate diagnostic was
not launched. Root located the existing exported
`extractWasmExceptionMessage(err, instance)` in `tests/test262-runner.ts`:
the module-init catch must use it while the instance is available, rather than
String(err) outside that scope. This is a diagnostic correction, not a change
to the authoritative 13 originals or their 8-pass/5-fail candidate outcome.

Species baseline session 9781 completed (exit 1, 36.62 seconds) on unchanged
subarray base 010107c75c: **0 pass, 4 fail / 4**, compared with candidate
24089's 2 pass/2 fail. Root compared fixtures: executable bodies are identical;
only the diagnostic header comment differs. Baseline used explicit 4 GiB fork
heap, unlike the earlier candidate's unspecified fork override; neither run
reported resource failure and both settled all four assertions.

The same-object key collision and inferred-flow controls returned zero on
baseline and passed on candidate. The shadowed-Symbol control returned zero
on both sides, establishing that exact failure as pre-existing. The contextual
case fails on both but with different exception surfaces; its mechanism is
still unresolved. The worker's source trace points to a closed declared-type
slot losing the open object, requiring broader value-origin tracking rather
than a type-name heuristic. No such shared inference edit is authorized yet.
The original maintained subarray cohort remains the next required comparison;
focused improvements do not substitute for Test262 verdicts.

### Frozen census index 46: 88/93, complete

Run `es2015-fullscope-128-f924650-chunk046-a01` completed in session 75219
(exit 1, 189.60 seconds): **88 pass, 5 fail / 93**, no compile errors/skips.
Completeness passed with 93 registered verdicts and zero exclusions.
JSONL SHA-256 `152d38e3cec95dc7016eb331e0a6d3128f703e74357b649a36e900976345577b`;
completion shard-47-of-128 SHA-256
`9b81ae2c765c933cd9c8cf08ccb1bb77189bb2b737516dc07d8a143fb4aa0b6c`.
All 47 receipt pairs and unique manifest identities were independently checked:
**4,325 measured = 4,054 pass + 235 fail + 36 compile errors; 7,453 unmeasured**.
Next index is 47; source remains the unchanged frozen f924650 census, not an
integrated current-source verification.

Included failures: Iterator chunks result identity, bound-constructor
newTarget through Reflect, ReferenceError cross-realm default prototype,
ArrayBuffer slice non-object receiver, and Error stack getter cross-realm.
These are failure locations, not assumed shared mechanisms. The released
heavy slot passed to the corrected Script marker/stage diagnostic pair.

Corrected-renderer Script diagnostic session 93723 is terminal (exit 1,
41.69 seconds). The renderer now exposes real messages: its stage fixture
reported stage 1 on baseline, but the transport prerequisite itself failed
with `TypeError: not a constructor` while constructing Test262Error inside
evalScript. The stage result is therefore not accepted as paired attribution,
and the candidate diagnostic was not run. The positive marker will use a
primitive string throw to avoid adding an unrelated provider-constructor
requirement; the original acceptance cohort stays unchanged. The raw receipt
is terminal output, not a claimed JSON file (verbose reporter emitted none).
The heavy slot moved to the maintained four-original species comparison.

### Error stack getter constructability: admission audit, not implemented

The frozen getter-not-a-constructor failure was traced read-only on c5240cd
source. The getter is minted as an ordinary native-method closure, correctly
absent from nominal constructible-closure types. Its source-local callable
value misses `tryCompileNativeConstructFromValue` admission in new-super.ts,
so the existing native construct driver's IsConstructor guard is bypassed.
A producer-spelling whitelist for getOwnPropertyDescriptor(...).get would not
repair the semantic hole through aliases, parameters, returns or reassignment.

The candidate seam is generic runtime-callable-value admission when static
constructibility is unresolved, reusing the driver's existing guard after
callee/argument evaluation. Acceptance must include getter aliases and
descriptor/return flows plus ordinary/bound constructor positive controls.
Issue 5269 already records the accessor nonconstructibility requirement and
6612 records the completed driver guard. This is source-supported routing,
not an A/B-proven cause or implementation. Active PRs 5784 and 5753 touch the
shared new-super/native-construct area; edits remain held for overlap clearance.

### Species exact-four comparison: complete, focused controls still open

The maintained candidate run `20260928-113010` completed 4/4 passing original
subarray paths with zero exclusions. Root independently ran the completeness
validator and inspected all four rows. The byteoffset-with-detached-buffer row
now passes with the subarray ordering fix plus the computed-species carrier
patch; the prior ordering-only candidate measured 3/4. Results SHA-256:
`614c0e1fc94eba7421d5263013e36f395aca45f17c2b8739c7c602205f88c2c8`.
Completion SHA-256:
`6d11169744fb20ea55ef1b13fbf0d1f20ffec6d7f383b22d1bd43ef7e67ae087`.
Fresh candidate adapter key: `911f2f4508d4153b`; compiler bundle prefix:
`cc928f2a8017de45`. This is not full-suite credit or a ready-to-merge claim:
contextual narrowing and shadowed-Symbol focused controls still fail. Issue
6651 retains their exact baseline/candidate evidence and implementation hold.

### Iterator chunks result identity: current routing and handoff

Read-only routing of the frozen chunk-46 result-is-iterator failure finds that
the maintained harness injects a source `Iterator` function and assigns its
prototype to the native iterator root. Its instanceof path therefore uses
native-user-instanceof, not native-dynamic-instanceof. The chunks result is a
LazyIterHelper, for which the prototype-chain walker lacks a virtual prototype
seed. The proposed repair is to expose IteratorHelperPrototype, linked to
IteratorPrototype, through getPrototypeOf and the existing generic chain
machinery. A name-based Iterator shortcut would incorrectly accept unrelated
user constructors and is not an acceptable implementation.

This source-supported hypothesis has not been A/B tested. The required shared
prototype files overlap open PRs 6242, 5784 and 5753; no source edits were made.
Issues 5147/5267 are existing routing records, while 6492 and 6651 have active
claims. Obtain ownership clearance before implementing; retain the original
frozen failure and add unrelated-constructor negative controls to acceptance.

### Script-var paired diagnostic: transport validated, stage one on both sides

The corrected primitive-string marker passed on both baseline and candidate,
making the paired diagnostic observable. Baseline session 2583 exited zero
with the expected stage-one assertion; candidate session 10313 exited one
because it expected stage nine but decoded `#6724 Script-var stage=1 failure=`.
Root inspected the candidate JSON failure record. This locates interruption
after evalScript returns but before the new-variable descriptor check finishes;
the empty inner failure text does not establish identical underlying causes.
These are diagnostic assertions, not additional passing Test262 originals.

Baseline JSON SHA-256:
`4ebba764088184f33f2002fad412a1c41e21b762d02ce911651215df4613cf2b`.
Candidate JSON SHA-256:
`234a5d30adcd649f4794d509b952c64a5e9f7fe6b2240998ddbffc8c9052d800`.
Both used explicit parent/fork/worker 4096 MiB and a single worker. The next
action is source inspection of descriptor/global synchronization, preserving
all thirteen originals. The heavy slot transferred to frozen census index 47,
attempt `es2015-fullscope-128-f924650-chunk047-a01`, session 94958; its verdicts
remain unaccepted until terminal completeness validation.

### Frozen census index 47: accepted complete receipt

Session 94958 terminated with exit one after 263.21 seconds: 89 pass, 3 fail,
0 compile errors and 0 skips out of 92. Completeness validation independently
confirmed 92 registered verdicts and zero exclusions. Attempt:
`es2015-fullscope-128-f924650-chunk047-a01`. Results SHA-256:
`56bf00b424b6b26b3b9754ef51ce40bf2fc18b583fd6ee7528c04afa1cedde17`;
completion SHA-256:
`170eec8631a7348407419d248d67efa0a1ea3d6bc1ce5cfe153f5738efa80ec3`.

Failures are class grammar-static-ctor-accessor-meth-valid.js (illegal cast),
Function/prototype/Symbol.hasInstance/prop-desc.js (null/undefined access), and
Function/prototype/bind/instance-construct-newtarget-boundtarget.js (undefined
instead of the expected function). They remain in scope. The descriptor row
has a read-only routing audit assigned; error text alone is not attribution.

All 48 accepted receipt pairs were hash-checked and their paths checked for
uniqueness and exact manifest membership: 4,417 measured = 4,143 pass + 238 fail
+ 36 compile errors; 7,361 remain unmeasured. This is frozen-source census
evidence, not integrated current-source conformance. Next census index: 48.

### ArrayBuffer reflective slice: isolated implementation assigned

Frozen index 46's context-is-not-object.js reaches execution but
ArrayBuffer.prototype.slice.call(undefined) returns without the required
TypeError. Read-only inspection finds the resolver and two-argument member
registration already present, while dataview-native.ts's reflective member
body handles transfer methods but lacks slice. The decline then reaches a
generic fallback; direct slice success does not establish reflective support.

A Terra implementation lane is assigned a separate managed worktree, owning
only dataview-native.ts, focused tests and its MD issue. The inspected open-PR
set has no overlap in that implementation file; calls.ts and array-object-proto
remain protected and must not be edited by this lane. Acceptance must cover
valid reflective calls as well as primitive/wrong-object receivers, omitted
and undefined versus null end, detachment/coercion ordering, species result
validation and copied bytes. Do not reuse static packed-byte recovery as a
runtime receiver brand check. This remains a source-supported diagnosis, not
a measured candidate fix; original rows and matched validation are required.

### Script descriptor fields: candidate correct in the isolated probe

Paired baseline session 88556 exited zero with the expected configurable-field
fault; candidate session 48204 exited one only on the unchanged staged probe.
Candidate marker transport, descriptor presence, and all four value/writable/
enumerable/configurable checks passed. Thus the isolated declaration has the
expected descriptor; stage one's empty failure cannot establish a missing
carrier property or bad flags. The original maintained script-decl-var.js
failure remains unresolved; investigate the different path without weakening
that original. Baseline JSON SHA-256:
`26e04f1de2e3ea8ec27d96877c3e576040f75f433b10d6bc5666f29f00c9f863`;
candidate JSON SHA-256:
`b15943959d0a3d026ad7bd0f08aa48729b111ad7605e965974e79b3077473c6c`.
