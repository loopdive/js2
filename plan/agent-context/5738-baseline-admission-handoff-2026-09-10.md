# #5738 measurement baseline admission checkpoint

## Current follow-up: original artifact path verified locally

The metadata-only publication prerequisite below is superseded, not waived.
Current baselines commit `2d991b968225280b65fe84cb9f4f686e916603b5` is NOT
byte-identical to the original artifact. Its host hash is
`3cba527b8dc4a667000410a9204884a6dd1e919c39a3c65ba9cdb09b86491e71`:
239 error fields and 237 error_signature fields differ, with embedded NUL
replaced by `^@` in inspected examples. Standalone hash also differs; its
record-level delta is not yet classified. Do not normalize or waive this.

The approved alternative is implemented: `baseline_commit=artifact:10112017687`
loads the reviewed receipt `plan/baseline-evidence/10112017687.json` from the
candidate checkout and downloads that exact original Actions artifact. No
baselines-repository write, replacement, or promotion is required. This binds
the receipt to the candidate commit while retaining original producer identity.
Both consumers still receive one admitted artifact pair from one acquisition.

Real network acquisition succeeded locally in
`/private/tmp/js2-5738-original-admission.Wi150Hsg`: original archive digest,
both lane byte hashes, API producer identity, ancestor relationship, all
48,735 unique records per lane, complete counts and settings admitted. Rechecked
the preserved run 34459540170 candidate JSONLs: exact full path sets and verdict
stamps match. This is admission validation, NOT a new conformance verdict.

Producer registration evidence was read directly from job `102532626616`:
log line 871 reports 52 host shards, 48,735 verdicts/registered, zero exclusions;
line 890 reports the same population for 50 standalone shards. Effective
settings come from the original compiler commit's merge-group job environment,
not the promoted summary (which misleadingly says include_proposals=0).

Follow-up tests: 95/95 across six files, including 31 admission controls and
unchanged legacy resolver/per-lane/matrix tests. Next: publish this follow-up
on #5738, run one skip-promote measurement pinned to the original artifact,
preserve its outcome, then decide protected-queue admission. Stack remains paused.

## Scope and landing hold

User approved a fail-closed baseline-admission repair on existing PR #5738.
Stack refreshes remain paused. This checkpoint does not change compiler code,
comparator rules, oracle versions, baseline contents, or promotion conditions.
Do not enqueue on the strength of synthetic tests or the offline comparison.
Protected merge-group validation is still required before landing.

## Preserved original evidence

- PR head measured: `ea21d583a0e69e9db75255672c87d6b4440d4e50`.
- Failed measurement: https://github.com/loopdive/js2/actions/runs/34459540170.
- Both lanes had 48,735 unique verdicts, all 114 shard jobs completed, and both
  promotion jobs skipped. The fine regression gate failed with 2,889 reported
  regressions against the committed, unstamped May JSONL. Its adjacent metadata
  described a different September population; that mismatch is not evidence of
  2,889 compiler regressions and is not a waived failure.
- Authenticated historical producer run `34368952422`, compiler
  `129e3efd4530ae1be56dbf5fdea54ddbbd87443e`, artifact `10112017687`, archive digest
  `64b24dff0073e087e2c8d3f2d8ce6ccef5131bd916eb3162076397d32c94a324`.
- Offline full-path-set status comparison against that producer: host zero
  regressions/one improvement; standalone two fail-to-compile_timeout changes.
  Not full-row equality, causal attribution, or protected-queue clearance.
- Raw evidence remains at `/private/tmp/js2-5738-conformance-audit.bNAYXXiI`.

## Implementation

`skip_promote=true` dispatches now require `baseline_commit`, a full immutable
commit in `loopdive/js2wasm-baselines`. A single acquisition job retrieves the
pair, authenticates producer run/artifact metadata, verifies archive SHA-256,
and checks that both baseline files are the original artifact members. It
records the ancestor relationship as a cumulative comparison. Shards depend on
successful admission. Both consumers download the same current-run artifact and
revalidate it, including exact candidate path sets, before report guards.

The legacy PR/merge-group resolver is unchanged. Missing evidence never falls
back to committed JSONL, a moving repository head, or count-only standalone
comparison on this measurement path. No automatic rebaseline is introduced.

Required producer file: `test262-baseline-pair.json`, schema 1:

- `compiler_sha`, `corpus_sha`, `oracle_version`.
- `producer`: repository `loopdive/js2`, integer `run_id` and `artifact_id`,
  `artifact_sha256`, and original workflow path.
- `settings`: explicit `include_proposals`, `semantic_providers`, `eval_engine`,
  `compiler_pool_size`, `ir_first`, `layout_emit`, `native_first`.
- `lanes.host` and `lanes.standalone`: matching `lane`, fixed `file`
  (`test262-current.jsonl` / `test262-standalone-current.jsonl`), `sha256`,
  full-population `total`, producer `registered`, `verdicts`, `excluded: 0`,
  and exact counts for pass/fail/compile_error/compile_timeout/skip.

Every field must be recovered from original producer evidence. Never synthesize
missing settings or registration counts from candidate expectations. Ordinary
report `summary.total` can exclude proposals and is NOT this full population.

## Verification and remaining blocker

- Initial seven-file cohort: 120/128 passed; eight oracle CLI cases failed
  because sandbox denied tsx's local IPC socket (EPERM), not comparator verdicts.
- Same cohort outside sandbox, Node 25 on PATH: 128/128 passed.
- Two additional admission controls then passed: 30/30 admission tests total.
  They preserve a legitimate regression through admission and prove the
  unchanged comparator still fails it; missing producer evidence fails even
  with a plausible fallback JSONL present.
- Unresolved review threads: zero, fully paginated at implementation time.
- Broader workflow cohort initially 43/44: the per-lane test expected two
  merge-group dependencies, but the pre-repair `ea21d583` workflow already has
  three (`changes`, `runtime-eval-provider`, `temporal-provider`). Updated only
  that exact expectation; the merge-group job and skip-safety assertions remain
  unchanged. Normal initial commit hooks passed 106/106 changed-root tests.
- Native subagent resume/spawn refused by service task limit; no sidebar task
  was created as a workaround.

**Not yet runnable against a real admitted pair:** the baselines repository
returned HTTP 404 for `test262-baseline-pair.json` on 2026-09-10. This is an
intentional admission refusal, not a green result. The API identity of the
historical artifact is verified; all original settings and registration evidence
still need assembling and independent review. A producer receipt must be
published at an immutable baselines commit before another measurement run.
This checkpoint does not publish anything to that separate repository.

Next: recover complete original producer evidence, review the receipt, arrange
metadata-only publication (no baseline promotion/replacement), then run one
skip-promote measurement pinned to that commit. Preserve any new failures and
only enqueue #5738 once evidence and protected checks justify it. Do not resume
#5756 or the rest of the stack until #5738's landing decision is resolved.

## Superseding measurement and acquisition repair evidence

### Completed conformance and same-binary runtime reproduction (2026-09-10)

Subsequent observational attribution: the target's __array_from host import returns an array of length 1 before Temporal and length 0 afterwards. Consequently __construct_closure creates the Float64Array with length 0; the predicate is correctly never called on that empty array. Import observations are preserved at /private/tmp/js2-5738-import-trace.oYZWeXWO. An additional loader-only observation of both runtime decoder lookup seams, with no changed lookup decision and no registry reset, preserves the same pass/pass, pass/pass, fail/fail outcome. Its trace is /private/tmp/js2-5738-decoder-trace.hn8YUv6n. For the identical array-like object, the local module reports __struct_field_names="length" and __sget_length=1, while the selected cached peer reports __struct_field_names="day" and __sget_length=0. Initial peer selection occurs with no local exports; the cached peer subsequently overrides the available, correct local decoder. This directly establishes the wrong-decoder mechanism, not merely correlation with Temporal. Earlier diagnostic decoder logs at IUcPN3cx/mBEk2pYW had the observation window end at instantiation before deferred module init; their empty decoder output is not evidence of absent redirection. The corrected observer scopes the window to each actual host-import call.

Proposed next repair (requires approval of the test-runtime lifecycle change, not a waiver): retire the preceding linked-project registry at the existing shared Test262 instantiation boundary for an unlinked invocation as well as a linked one, in the same runtime bundle that owns the import functions. Do not change production decoder precedence globally: foreign objects within a genuinely live linked project still need their owner. Do not reset Temporal realm globals for unrelated unlinked programs, alter fixtures, change verdict logic, promote baselines, or introduce per-fixture exceptions. Add deterministic linked-to-unlinked and linked-to-linked lifecycle controls with a positive same-runtime-copy assertion.

Before any landing claim, use three separate arms: A is the original compiler/runtime at 129e3efd4530ae1be56dbf5fdea54ddbbd87443e with original harness; B is that same baseline with only the reviewed lifecycle repair; C is #5738 with the identical lifecycle repair. Preserve A's original artifacts and failures, plus every original fixture. First execute the same six-request bracket (target sloppy/strict, Temporal sloppy/strict, target sloppy/strict) in each arm: 18 new requests total, no retries or sham substitutions, distinct output directories, pinned corpus and verified provider. B and C must agree exactly on all six per-request verdicts and error text; a changed or missing row fails the comparison. This is a new proposed budget, not authorization to resume the older V2 registry-intervention experiment. If the bounded controls support the repair, full baseline/candidate conformance must retain the complete registered fixture set and require exact per-file status/error equality against B, not net pass-count equality or exclusions. Any discrepancy remains a blocker to investigate. A remains immutable and visible; B is comparison evidence, not a replacement/promoted baseline. No lifecycle patch or intervention has been executed at this checkpoint.

Run 34495086258 at aee1215633cf9203cac2fbcb725898c86b623f99 completed successfully: all 114 shards, 48,735 unique verdicts per lane. Original artifact 10112017687 remains the comparator; no promotion occurred. Merged artifact 10160269977 has archive SHA256 e02116dd7dcbe73599c601eb9bff4b13ece1e0ac733fecf90ffae68a152ce890. Extracted rows remain at /private/tmp/js2-5738-destructuring-conformance.s0vdJl5M.

The green host gate is net accounting, not zero per-test regressions: 38,384 passes before/after, with TypedArray/prototype/findLastIndex/return-abrupt-from-predicate-call.js regressing and TypedArrayConstructors/internals/Delete/key-is-out-of-bounds-strict.js improving. Standalone retains 35,214 passes with no pass regression; subarray/coerced-begin-end-shrink.js changes compile_timeout to compile_error. The destructuring fixture repaired in aee121 passes in both lanes. The inventory-only head 7dd342d5b2025ac9f5026362c0c064a6e54421f9 has green quality and other completed PR checks, is mergeable, and has zero unresolved review threads (fully paginated). Neither those checks nor net-zero host accounting waives the remaining row.

The ordinary four-worker local replay completed all 855 registered shard-24 rows, 855 callbacks started/settled, zero exclusions. It reproduces CI's exact Float64Array missing-predicate-exception error. Raw results and completion manifest are benchmarks/results/test262-5738-replay-results-5738-shard24-aee121-20260910.* in this isolated worktree. Read-only IPC observations remain at /private/tmp/js2-5738-shard24-replay.88ImvXyg; worker-44685.jsonl records failing request 1018. Mapping SHA256 of the original assembled harnesses identifies actual worker request history, not completion-neighbor guesses.

Replaying that worker's history through request 1018 reproduces the exact error. Its ten-request suffix (983 through 1018) also reproduces it; the eight-request TypedArray suffix starting at 991 does not. A smaller ordinary worker sequence is sufficient: untouched Temporal/PlainDateTime/prototype/with/options-undefined.js in both modes passes, then untouched TypedArray/prototype/findLastIndex/return-abrupt-from-predicate-call.js fails in both modes. Bracketing Temporal with the target gives pass/pass, pass/pass, fail/fail. No registry reset, realm reset, fixture change, compiler patch, or outcome normalization was introduced by these diagnostics.

The bracketed six-request sequence was repeated solely to capture compiled binaries through the existing worker wasmPath/metaPath outputs. The first capture attempt omitted metaPath and wrote no binaries; it is not binary evidence. The corrected capture is /private/tmp/js2-5738-sequence-wasm.77IX2R9f: request 1.wasm and 5.wasm are byte-identical (SHA256 641155b5f886643769d6bb44778dbb428aa1e15bb2668250e4e826aa42815645), as are 2.wasm and 6.wasm (275c1163ee7ed174421641972bab3fb9eea2f69340ef5531642bbf361cc1165a). Both cmp checks return zero. Thus identical target Wasm passes before Temporal and fails after it; this local reproduction is runtime-state dependent, not changed generated code. The provider is the verified CI binary 1e277d9b4bc3e634f5838bdeff0f8088f56dba8c7e8a394ee38c2c63286df18b, loaded from /private/tmp/js2-5738-ci-temporal.xeH3rGQ8.

Next: attribute the runtime-state dependency at the linked/unlinked instantiation boundary. scripts/test262-import-object.mjs retires linked-project registries only inside the linkedModules.length > 0 arm; a subsequent unlinked test takes another arm. This is a concrete candidate, not a proved cause or permission to waive/reset evidence. The previously proposed additional registry-intervention budget remains separate and was not consumed by these ordinary replays. Preserve original failures and all fixtures. Keep #5738 held and stack refreshes paused; #5752 follows only after protected-queue landing. Native subagent dispatch still fails at the agent thread limit. No new implementation scope or PR was opened.

### Subsequent destructuring-order repair (2026-09-10)

Checkpoint aee1215633cf9203cac2fbcb725898c86b623f99 is published. All normal commit/push checks passed, including numeric IR parity 18/18; measurement-only run 34495086258 is live at that SHA against the same original artifact, with promotion disabled. Its PR quality job 102931292495 failed because the two new helpers were absent from the exhaustive module inventory. Registering them with the same unmigrated/mixed-needs-split classification as their source modules fixes that exact failure without changing boundary rules, activated closures, historical evidence, or retirement claims. Local inventory is valid with architecture explicitly incomplete; all 42 boundary-detector controls pass. The four reported unknown dynamic edges remain unknown.

A bounded ordinary unified-worker sequence at aee1215633 used the 12 TypedArray files preceding findLast in run 34484384957 shard 24 completion records, bracketed by the untouched findLast fixture. All 28 requests completed: 26 passed; the map/BigInt callback-arguments fixture failed in both modes with its already-known undefined-versus-3 error. All four before/after findLast controls passed. This refutes that specific trigger sequence, not CI's failure: completion order does not establish worker assignment. No Temporal rows, registry resets, fixture edits, or compiler/runtime modifications were part of this replay. The full measurement remains live and must not be restarted just because the new inventory-only checkpoint changes the branch head.

Full run 34489656611 at 657aea2c7a3e7f663d1d96355aadcfd5b2bdb24e completed all 114 shards, with 48,735 registered/verdict rows per lane and zero exclusions. The caller regression recovered in both lanes. The host fine gate failed on two counted rows: TypedArray findLast/BigInt/return-abrupt-from-predicate-call.js and language/expressions/assignment/dstr/array-elem-iter-thrw-close-skip.js. The standalone per-test edition ratchet also failed on the latter; its later comparator did not run. Do not treat aggregate/stub checks as clearance. Artifact 10157989314, SHA256 390e89dd890037cf3577c715b4fdda5401110473b8090213403722852d153948, remains complete at /private/tmp/js2-5738-strictness-conformance.W0X4DEVu. No promotion or baseline changes occurred.

The untouched destructuring fixture in the production unified worker reproduces pass in sloppy mode and failure in strict mode: Expected a Test262Error but got a ReferenceError. The array-assignment compiler emits its unresolved-reference throw before IteratorStepValue. The current repair drives a single unresolved identifier through the existing strict iterator providers, lets acquisition/step failures escape without closing, and closes a non-exhausted iterator with throw-completion precedence. Existing literal-array lowering is retained when no iterator override is possible. Rest, nested, multi-element, and declared-target lowering are not rewritten.

Local verification rejected intermediate patches: the first introduced native host imports and mixed exception-handling formats; the next exposed an empty-array TypeError and a missing native close. These were not pushed. Native strict stepping accepts USER records with closure-valued fields, while the existing close bridge only handled OBJ records when no method dispatcher existed. The repair admits that USER record to the property bridge only when strict runtime is present, a return getter exists, and there is no return method dispatcher. It uses standard native try-table handling and preserves the pending ReferenceError even if return throws.

Focused validation: tests/issue-5738-destructuring-iterator-order.test.ts 14/14 and existing strict PutValue tests 5/5 pass. Three untouched upstream fixtures run through the original harness in both lanes; eight controls check done/not-done crossed with normal/throwing return in both lanes, including zero standalone host imports. Earlier failing controls remain in the suite, not excluded. Host test lifecycle uses setInstance (not setExports). Broader provider/strictness controls and normal commit/push gates must pass before publishing. This is not a full-conformance pass.

The adjacent strict iterator provider tests pass 4/4 and incremental strictness tests pass 5/5. Repository-configured TypeScript 7 type checking passes; a direct legacy `tsc --noEmit` invocation failed with missing Node type/environment diagnostics and is not a green result. Existing size gates rejected growth in the two large implementation files. The unresolved-write implementation and existing iterator-error constructors now live in focused subsystem helpers; both existing size gates pass without new allowances or baseline edits. Normal commit/push gates remain required.

TypedArray findLast remains unresolved. Fresh ordinary worker requests pass both modes; preceding map/BigInt callback arguments or reduceRight/BigInt internal-length tests do not reproduce it. Completion-neighbor rows are not evidence of same-worker execution. No registry-reset experiment, waiver, or unchanged-head full rerun is authorized by this finding. Native subagent dispatch still fails at the thread limit. Keep #5738 held and stack refreshes paused; #5752 is next only after #5738 reaches main through the protected queue.

### Subsequent caller-cache repair (local validation, 2026-09-10)

Repaired conformance run 34484384957 completed 48,735 rows per lane, zero exclusions. All 20 Temporal regressions recovered; standalone had zero regressions. Host still failed at net -2: Function 15.3.5.4_2-11gs plus TypedArray findLast/BigInt predicate and length/BigInt return-length. Original artifact 10156078401 (SHA256 0fa4c7ffa0186f07d2e14fcd69b38160cd7c40910d82b66f01c624a890d176a4) remains at /private/tmp/js2-5738-repaired-conformance.HAo1msBb. Do not waive these rows or restart blindly.

The exact Function row passes through fresh runTest262File in both lanes. In the production unified worker, untouched original harnesses in order 11gs/12gs/11gs produce pass/fail/pass; a separate worker in order 12gs/11gs produces pass/fail with the exact CI missing-TypeError message. Both controls pass first in a fresh worker. Five requests establish order dependence without a registry-reset intervention.

Direct TypeScript updateSourceFile controls prove the function node is reused and reparented after inserting or removing a source directive. The process-global WeakMap keyed only by that node retains the previous strictness. All four transition tests fail before repair; the independent module-inference control passes. Removing this invalid memoization retains the existing strictness rules but reads current enclosing scopes on each call. This trades a scope walk for correct incremental semantics; no broad cache reset or worker recycling is introduced.

After repair: new tests 5/5, module-arguments tests 5/5, caller suite 12/16. The four constructor failures (two shapes in both lanes) also fail with the original helper, with matching errors and Wasm stack locations; preserve them as pre-existing failures, not a green suite. Rebuilding only the compiler bundle and replaying both original worker orders gives 5/5 passing requests. The runtime bundle and all upstream fixtures are unchanged. This proves the bounded caller repair, not recovery of the two current TypedArray rows or whole conformance. Normal commit/push gates and further validation remain required. Stack refreshes stay paused and #5738 remains held.

The original-artifact admission path is now published at eafbc5fc9a476afb65e90414a8c2afae04cf108a. Run 34477860865 admitted original artifact 10112017687 without normalizing its bytes. Both lanes completed 48,735 registered rows with zero exclusions after a failed-jobs-only retry of standalone shard 15, whose first runner received a shutdown signal. Original attempts and artifacts remain preserved. No baseline promotion occurred.

The completed measurement failed: standalone had zero status regressions; host had 23 raw pass-to-fail rows, of which the unchanged canary policy excluded two, leaving 21 counted regressions. The coarse merge-report threshold is not landing clearance. The fine regression gate failed. All 23 rows passed in the earlier ea21 measurement; that observation alone does not waive them.

All 20 Temporal regressions belong to host shard 6, job 102873292740, artifact 10152747001 (850 registered/verdict rows, zero exclusions). Its log at 12:40:37Z reports the unchanged JSBI source-link assertion rejecting an incomplete bundle, followed by three successful provider loads. Existing PR #5795 commit 085cf77f9e8ee33b223bc6098c9c159d543e884d addresses this exact acquisition mechanism. Its helper and five deterministic tests are imported unchanged; only its ten-line historical issue receipt is brought over, not unrelated donor history.

Initial local validation on Node 25.9.0: acquisition 5/5, adjacent wiring/registry 23/24. The one failure is a literal workflow dependency assertion that predates this branch's added admission dependency. Update that exact expected list while retaining both provider dependencies and the unchanged merge-group expectation; do not change the workflow or weaken the assertion.

Three non-Temporal raw failures remain separate: TypedArray findLastIndex return-abrupt-from-predicate-call, BigInt boolean-tobigint, and Function 15.3.5.4_2-11gs. Their cause remains unresolved. Preserve full artifacts at /private/tmp/js2-5738-conformance-attempt2.lZDW9Ond and the failed remote run. Focused acquisition tests are not a full conformance pass. Keep #5738 held until fresh measurement and protected checks justify landing, then tackle #5752. Stack refreshes remain paused.
