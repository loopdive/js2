# IR migration handoff — 2026-10-01

## Latest user-requested wrap-up: executed core and preserved runtime draft

This section supersedes the stand-down state below; all earlier checkpoints remain immutable. Continue the existing ready [PR6374, “docs(ir): preserve migration handoff and extraction baseline”](https://github.com/loopdive/js2/pull/6374), rather than create a duplicate. Publication integrates freshly fetched upstream main `11661c310659b921af5584ceb4155e7c1209c7d2` (six npm-compat artifact changes since the recorded `0d94fc71` read; no active source/test changes). The old queued head was explicitly dequeued before refresh; re-enable protected admission for the exact newly published head. This is a documentation/evidence PR; the incomplete source implementation remains uncommitted.

The source worktree `/private/tmp/js2-ir-source-contracts-main-20261001`, branch `codex/3518-source-contracts-main-20261001`, HEAD/base `1265c47d6fc41300a380ef7e4abc45fdfcfd2c61`, now has **46 source/test/metadata/issue paths** preserved with separate index and worktree bytes. [The resumed manifest](resumed-checkpoint/manifest.json) pins complete file bytes, both patches, original terminal evidence, static donor audit, and the frozen runtime draft. No worktree was reset, stashed, pruned, deleted or overwritten; the dirty canonical Deno lane remains untouched. Archived executable text is preservation evidence only and must never become a reconstruction fallback.

Scoped claim `3518:source-validation-contracts-20261001`, owner `ttraenkler/codex-source-validation-contracts-20261001`, was released on stand-down and its actual canonical record read back: `status=released`, `released_at=2026-10-01T04:15:43Z`, `write_id=89776-u29luamo`. [The release record](resumed-checkpoint/execution-claim-wrapup-release-record.json.raw.txt) is authoritative; no other claim or reservation changed.

Runtime writer stopped at unique freeze `/private/tmp/js2-ir-source-contracts-writer-20261001/.tmp/source-contracts-writer/runtime-evolution-freeze-yN0bkE`, manifest SHA256 `33aa7477d4c73995d205622a6b9a47e5f0e6ad4ba1f9bb95fa56866ba0309e8b`. [Its handoff](resumed-checkpoint/runtime-draft-HANDOFF.md.raw.txt) and all three exact file bytes are archived. **331 rows are drafted; zero were executed.** Formatting and syntax/source arithmetic checks reported27 inverse/forward source pins,34 spans and84 live slices, with35 earlier writer files unchanged. These static checks are not compiler or test evidence. Root checked frozen bytes and every27 current source pin before archival. Writer attribution is Codex GPT-6 Astra Max; root integration/docs attribution is Codex GPT-6 Default.

### Latest executed measurements

- Core: **152/152** (132 new reader controls plus all20 original rows), zero skipped or worker errors. After formatting only the existing seam, its20 original rows passed again. The three frozen helper/receipt/control files remain byte-identical. All old hashes/populations and current raw runtime/type checks remain intact.
- Production TS7: terminal exit0. No test-source typecheck claim.
- Original public Number fixture: **5/9**, zero skipped. The oracle and four explicit legacy cases pass; all four genuine public IR direct/decoded × UTF16/UTF8 cases fail preparation with `runtime feature js.number.from-value has no provider`. Exact original fixture/source bytes, rows, configuration, heap and timeout were preserved.
- Runtime historical checks: latest executed results remain **69/75** and **2/631**. The drafted runtime inverse and new75/631 plumbing have **not been compiled or executed**. The earlier629 failures stop at a shared positive source check, not629 independently attributed production defects.
- Prior scoped component/boundary/program/preservation measurements below remain evidence on their pinned bytes; none certifies full migration or legacy retirement.

[The core/public progress record](../3518-source-contract-core-progress-2026-10-01/progress.md) and its raw archives retain exact execution evidence. Its active claim statement describes execution time; the newer stand-down release record in this checkpoint is authoritative.

### Resume without overlapping work

1. Read the fresh upstream `issue-assignments` ledger, verify all source/draft/archive pins, and reacquire only `3518:source-validation-contracts-20261001` after checking overlaps. Preserve the46-path index/worktree split and all earlier immutable snapshots.
2. The core reader is already integrated and executed: do not redo its initial-read normalization or replace current raw compiler/type reads. Its original unique writer freeze is `.tmp/source-contracts-writer/core-vocabulary-freeze-gOZASp/` in `/private/tmp/js2-ir-source-contracts-writer-20261001`, manifest SHA256 `994f00785c72338a22b2e3080ce4b71a4c0ba793f9b236f8e2deba7cf19c557d`.
3. Review the separately frozen runtime draft and independent static donor audit before copying its three new files. Root owns only initial historical-read plumbing in existing75/631 suites, already preserved but unexecuted. Keep current checks raw; inject old historical mutants after normalization and never normalize mutants twice. The helper must authenticate all27 raw production inputs per operation and use live slices/token roles for all34 inverse spans; no cross-operation cache, historical executable fallback, fake donor or receipt reseed.
4. Run the new runtime controls and original75 first, then every631 original row with strict worker errors and unchanged timeouts/fixtures. Review individual failure rows. Only then rerun affected preservation gates, integrate freshly verified main and produce a normal signed source commit/ready implementation PR. The documentation PR is not implementation delivery.
5. Continue the full A–E extraction specification and original full acceptance. All45 intrinsic identities,44 Call algorithms/lifted entries,2 Construct entries, complete source modes/this/Get/Call/Construct/newTarget/bound behavior, dynamic Function/eval/with, original public Number nine-row fixture, actual fresh-process replay and both-backend equality remain required. **Legacy stays until everything in the IR path is implemented, tested and equal.**

No compiler or test process remains running at stand-down. Native writers finish only their frozen handoff and stop new scope. No polling automation or GitHub issue is created. Protected queue and verified exact main ancestry/content are still required before counting this documentation PR delivered; no full migration completion is claimed.


## Final stand-down: fresh-main continuation preserved

The ready existing [PR6374, “docs(ir): preserve migration handoff and extraction baseline”](https://github.com/loopdive/js2/pull/6374) is being refreshed against freshly verified upstream main `0d94fc71681fd4988ae0ca32dda3a12f614e4b47`. Its one issue-file conflict preserves both the upstream native-realm repair and this lane's source-contract notes. This PR delivers documentation and immutable evidence; the incomplete source implementation is not included as active source. Check the final exact published head, required checks and main content before counting this PR as delivered.

The current source worktree is `/private/tmp/js2-ir-source-contracts-main-20261001`, branch `codex/3518-source-contracts-main-20261001`, HEAD/base `1265c47d6fc41300a380ef7e4abc45fdfcfd2c61`. Its **41 paths remain uncommitted**, with staged and unstaged bytes preserved separately. [The final manifest](final-checkpoint/manifest.json) pins all 76 archives, including [complete file bytes](final-checkpoint/integration-files.raw.txt), both patches, every latest raw test result and terminal log, inventory and specifications. These archives are documentation, never executable historical reconstruction inputs. The earlier worktree and its 34 immutable raw archives remain unchanged; earlier measurements below describe that earlier checkpoint.

Only scoped claim `3518:source-validation-contracts-20261001`, owner `ttraenkler/codex-source-validation-contracts-20261001`, was released again after this continuation. The authoritative branch record was read back: `status=released`, `released_at=2026-10-01T03:42:15Z`, `write_id=76946-fhh4sf6o`. [The exact record](final-checkpoint/claim-final-release-record.json.raw.txt) is preserved. No other claim or reservation was changed. Reclaim after checking the live ledger before resuming source edits. All native writers stopped; no compiler or test process remains running.

### Actual current-source validation

All rows below ran on the preserved source worktree at base `1265c47d`; current main's subsequent `0d94fc71` changes are benchmark/baseline files only. No original fixture, timeout, historical hash or negative control was weakened. All suites have zero pending rows.

| Check | Executed result | Remaining limit |
| --- | --- | --- |
| Production TS7 | PASS, terminal exit 0 | No test-source typecheck claim |
| New live Phase A relocation reader | 65/65 | Authenticated live source and reciprocal reconstruction controls |
| Source/component tests | 121/121 | Includes original component suites and 53 new contract rows |
| Original ownership controls | 22/22 | Original controls unchanged |
| Core vocabulary | **17/20** | Intrinsic, async and string historical receipts still fail |
| Complete boundary suites | 477/477 | 352 semantic/provider and 125 general controls |
| New pre-A program reader plus original program seam | **123/123** | 76 new controls plus all 47 original rows; genuine compiler child executed |
| Runtime data contracts | **69/75** | Six historical receipt failures remain |
| Original historical runtime mutation suite | **2/631** | 629 rows stop at the shared positive source check; not 629 independently attributed production defects |
| LOC/function/JsTag/coercion/oracle | PASS | Actual main-based preservation checks; no full migration credit |
| Inventory | 1761 entries, no inventory errors | Architecture incomplete; all entries tracked, no untracked inputs |
| Reachability | Preservation 6/6 full and 6/6 cut | Graph OPEN, strict modeled closure FAIL, retirement NOT CERTIFIED |

The program reader is integrated and executed; the earlier 37/47 result is superseded by 47/47 on these new bytes, not erased. Its 4096 MiB real compiler child retains original source, root configuration, diagnostics and timeouts. Historical reads reconstruct authenticated live inputs at the initial read only; current compiler/runtime/type reads remain raw. The complete inventory is durably archived as gzip/base64 text, with original decoded length and SHA256 in the manifest.

### Exact resumption order

1. Verify fresh upstream main, the final manifest and all current-source pins. Reclaim the released slice after checking overlaps. Preserve the 41-path index/worktree split; do not reset, stash or overwrite it. The canonical dirty Deno worktree remains untouched.
2. Review the frozen **three-file core vocabulary draft**, archived under `final-checkpoint/core-draft/`. Its manifest SHA256 is `994f00785c72338a22b2e3080ce4b71a4c0ba793f9b236f8e2deba7cf19c557d`. The isolated writer still owns `/private/tmp/js2-ir-source-contracts-writer-20261001/.tmp/source-contracts-writer/core-vocabulary-freeze-gOZASp/`. Its 132 rows are **drafted, not executed**, and the files have **not been copied into the current integration**. The helper authenticates 51 raw inputs, performs Phase A once, reconstructs eight originals and reciprocally proves fifteen current owners through 164 transfers and four current-only residues. Root must change only the initial reads in original core receipt rows to `readCoreVocabularyReceiptSource(path, rawReader)`. Do not pre-normalize Phase A again or replace raw current runtime/compiler/type reads. Run all 132 new and 20 original rows before claiming success.
3. Implement the separate runtime inverse from the preserved `runtime-inverses/` and `runtime-joins/` specs. This work is **not implemented or test-executed**. It specifies 34 bounded spans across eleven modified files, 27 closed production inputs, and actual live ABI-identity donors. Preserve generic provider specialization, canonical aliases, both clock/vector stages, ten link checks, five owner checks and all 631 original controls. Normalize only the initial authenticated raw read; inject historical mutants after normalization. Never normalize a mutated source twice or use stored executable bodies as fallback. The architect's 22 static compatibility checks are not runtime validation evidence.
4. Rerun the original 75 runtime rows, all 631 historical rows, new inverse adversarial controls, current type/runtime controls and complete preservation gates. Inspect individual failures; preserve every before-run. Only after full affected validation and fresh-main integration should the source branch receive a normal signed commit and ready implementation PR. Never publish it as green based on the documentation PR.
5. Continue the full extraction specification and mixed source-call integration. Legacy stays until complete tested equality on both backends. No new downstream scope was started during this wrap-up.

### Verified upstream delivery

[PR6371, “feat(ir): add native realm state and structural object access”](https://github.com/loopdive/js2/pull/6371) **landed** as `1265c47d6fc41300a380ef7e4abc45fdfcfd2c61`. Exact signed head `21c7922d5f8601aab52542690815d5b951796a14` is an ancestor of verified main, and repaired source/test bytes were compared with main. [The delivery receipt](final-checkpoint/pr6371-delivery-verification.json.raw.txt) records all **102 actual protected conformance shards** and the final regression gate succeeding, excluding skipped matrix stubs. Merge-group quality, linear, equivalence, CLA and differential checks succeeded; **merge-group issue-tests was cancelled**. Exact PR-head quality and issue-tests succeeded. Do not describe all merge-group CI as green. Original failures and 35-second controls remain preserved.

[PR6372, “fix(ir): retain closure parameter facts across physical projections”](https://github.com/loopdive/js2/pull/6372) remains verified delivered as `d1d7d68583ba312aa04f58f6144b3222a90c2d5e`, with exact main content and all 102 protected shards/regression/CI/CLA/differential checks previously verified. The original public Number fixture remains **5/9**; no further public-fixture or full migration delivery is claimed.

## Earlier wrap-up checkpoint (03:14 UTC)

This ready PR publishes the handoff and preserved evidence. The new source-contract implementation remains uncommitted and incomplete; its historical checks must pass before publication as a ready implementation. Legacy retirement is not certified. All worktrees and original failures are preserved.

The current integration worktree is `/private/tmp/js2-ir-source-contracts-integration-20261001`, branch `codex/3518-source-contracts-integration-20261001`, HEAD/base `ff564bccab11c53ae1aeaf1d510385e16b54a832`, freshly verified against upstream main. It contains 35 changed or new tracked-source/test/metadata/issue paths, with staged and unstaged edits intentionally preserved. [The immutable wrap-up manifest](resume-checkpoint/manifest.json) authenticates [all current file bytes](resume-checkpoint/integration-files.raw.txt), separate [staged](resume-checkpoint/integration-index.patch.raw.txt) and [unstaged](resume-checkpoint/integration-unstaged.patch.raw.txt) patches, and the exact status. These archives preserve unfinished work; they are not executed historical reconstruction inputs.

Scoped claim `3518:source-validation-contracts-20261001`, owner `ttraenkler/codex-source-validation-contracts-20261001`, was released on stand-down. The actual upstream `issue-assignments` record was read back: status `released`, `released_at=2026-10-01T03:13:54Z`, `write_id=68420-4cmsrof8`. The raw record is [preserved](resume-checkpoint/claim-wrapup-release-record.json.raw.txt). Reclaim through the canonical branch after checking overlapping active claims before editing. No other claim or reservation was released.

## Executed evidence and blockers

All following measurements executed in the integration worktree on the exact preserved bytes. No historical receipt was refreshed and no timeout, fixture or existing negative control was removed. Raw JSON assertions and terminal logs are retained in `resume-checkpoint/` and hashed by its manifest.

| Check | Actual result | Limits |
| --- | --- | --- |
| Production TS7 | PASS | No test-source typecheck claim |
| Source-contract and existing component tests | 121/121 | Includes 53 new and 68 existing assertions |
| Complete boundary suites | 477/477 | 352 semantic/provider and 125 general controls; zero skipped |
| Original ownership suite | 22/22 | Previously failed collection with ENOSPC |
| Core vocabulary suite | 16/20 | Four historical relocation receipts still fail |
| Program-data seam suite | 37/47 | Ten historical declaration/retained-source controls still fail |
| Inventory | Valid, no inventory errors | 1752 entries; architecture and graph explicitly incomplete |
| Main-based LOC/function | PASS | 25 changed source paths, +117 LOC; base ff564bcc |
| JsTag seam | PASS | Exact owner relocation; exemption population remains four |

The program-data execution completed normally at its genuine 4096 MiB child heap limit: the previous 2048 MiB heap override was removed while root configuration, real source, diagnostics, rows and timeouts stayed unchanged. Ten failures remain: input/prepared optional-field historical declarations, retained outcomes, identity and prepared-component-dependency statements, and five declaration-detector controls. This is not a green historical cohort. Core's four failing rows concern intrinsic, async, string and counted-site historical moves. Current runtime/fresh-child vocabulary and real bounded type checks pass, while immutable historical counts and hashes stay unchanged.

The first general-boundary run failed one pre-existing static expectation; current main already had the three frontend roots in its policy. The updated test pins all three existing roots and minimum three, retaining prior contract-root, allowed-edge and historical checks. The original 124/125 run remains archived. Semantic activation records append exactly three entries after the unchanged 88 records; three corruption controls were added. Existing ownership inverses and every source/intermediate/output pin moved unchanged into a shared helper; its 22 original controls still execute.

The untouched before-edit a8cd historical cohort remains 107 passed and 35 failed of 142 collected assertions. A separate ownership file could not collect due to ENOSPC; one program-data compiler child aborted at roughly 2 GiB. All four requested files failed. Preserve [original JSON](baseline-historical.raw.txt), [terminal errors](baseline-historical.log.txt) and [provenance](evidence.json). The current results do not constitute a clean before/after attribution study.

## Frozen implementation and next step

The Phase A writer is `/private/tmp/js2-ir-source-contracts-writer-20261001`, branch `codex/3518-source-contracts-writer-20261001`, base a8cd. Its original 26-path snapshot `.tmp/source-contracts-writer/phase-a-v07xt1lw/` remains immutable and is recorded in [the original manifest](phase-a-frozen-manifest.raw.txt). Twelve actual closed owners replace thirteen old declaration/body donors through identity-preserving aliases. The precise later role revision `.tmp/source-contracts-writer/phase-a-role-correction-qktlatcg/` changes only the new test's invalid `support` role to genuine `lifted-closure`; it is preserved in the current integration archive and [revision receipt](resume-checkpoint/role-correction-receipt.json.raw.txt). Production bytes remain unchanged from the original freeze. Actual writer attribution: Codex GPT-6 Astra Max; integration metadata and existing-test edits: Codex GPT-6 Default.

A separate three-file historical reader draft is frozen in `.tmp/source-contracts-writer/relocation-freeze-ngavd5/`. Its [manifest](resume-checkpoint/relocation-freeze.raw.txt), [handoff](resume-checkpoint/relocation-handoff.raw.txt), helper, receipt and 65 drafted test rows are archived byte-for-byte in `resume-checkpoint/`. It has NOT been integrated, compiled or tested. Static generation reconstructs 13 original donors and reciprocally replays 25 current owners from authenticated live declaration spans, accounting for 184 declarations including 115 moves. These static results are not executed test evidence. Independent review and corruption controls remain required.

The architect's [pre-A inverse findings](resume-checkpoint/pre-a-findings.md.raw.txt) and [fixed manifest](resume-checkpoint/pre-a-inverse-spec.json.raw.txt) preserve read-only provenance and static reciprocal calculations. They are not implemented or adversarially validated. Two identity types moved to shared contracts in cb64af7b; runtime-support changes include both the leading dependency function and the implicit-requirement arm, plus exact optional fields in input/prepared contracts. Missing factories must not be guessed.

Resume in order: verify actual main/base, all archive/current hashes and claim ownership; review and integrate the three-file reader only at initial raw historical reads; then apply authenticated pre-A inverses before existing historical logic. Keep current production/runtime/type reads raw and never normalize injected historical mutations twice. Complete the remaining core/runtime historical reconstruction without storing executable snapshots, changing receipt hashes, or substituting old declarations for current compiled types. Run all new and original affected tests, complete inventory/boundary/preservation gates, normal signed hooks and fresh-main queue checks before publishing source. Serialize heavy compiler/test processes; no validation process is running at this stand-down. Provide an independent pinned test262 checkout if required; never borrow or replace another lane's linked corpus.

Then follow [the full extraction specification](validation-lowering-extraction-spec.md): A closed contracts; B full analysis/verifier/allocation/class-layout bodies; C complete program/runtime rederivation and validator; D generic/Wasm lowering closure; E authentic source identity/fill and linear compatibility. Phase A alone does not make the preserved seven-file mixed source-call draft publishable. That draft remains in `/private/tmp/js2-ir-genuine-mixed-get-call-20261001`, branch `codex/3518-genuine-mixed-get-call-20261001`, base e4737c9, with manifest `.tmp/mixed-invocation/writer/source-target-draft1-glo9qpeg/manifest.json`. Its 43/43 component evidence does not override an invalid dependency inventory.

## Earlier PR observations (superseded by final delivery receipt above)

[PR6371, “feat(ir): add native realm state and structural object access”](https://github.com/loopdive/js2/pull/6371) remains OPEN at exact signed head `21c7922d5f8601aab52542690815d5b951796a14`. Fresh wrap-up reads now show quality and issue-tests SUCCESS, as well as the equivalence gate. Protected auto-merge remains enabled. It has not merged and is not counted delivered. Preserve its original failures, fixtures and 35-second timeout; do not open a duplicate or push unrelated work to that branch. Its repair worktree `/private/tmp/js2-ir-6371-canonical-audit-performance-20261001` is clean. Its signed handoff records 392/392 scoped, 213/213 after main integration, 953/953 normal commit-hook assertions and passing normal push hooks; these local measurements do not replace protected merge-group evidence.

[PR6372, “fix(ir): retain closure parameter facts across physical projections”](https://github.com/loopdive/js2/pull/6372) is independently delivered as `d1d7d68583ba312aa04f58f6144b3222a90c2d5e`. Its three production files and seven-row test match verified main; all 102 actual protected conformance shards and final regression/CI/CLA/differential gates passed. Only this verified main merge counts as delivery here. Main ff564 adds six npm-compat benchmark artifacts beyond a8cd, with no production or test changes.

The ready handoff PR is [PR6374, “docs(ir): preserve migration handoff and extraction baseline”](https://github.com/loopdive/js2/pull/6374). Its prior signed head 5f7797d had quality SUCCESS, no auto-merge request and no merge at the wrap-up decision read. This documentation update preserves evidence only; verify its final exact head and normal hook/publication receipts in the PR body.

## Remaining full acceptance

All 45 intrinsic identities, 44 Call algorithms/lifted entries and 2 intrinsic Construct entries, complete source modes/this/Get/Call/Construct/newTarget/bound behavior, dynamic Function/eval/with, original public nine-row Number fixture, fresh-process replay and both-backend equality remain required. The preserved public Number checkpoint was 5/9. Reachability evidence remains preservation-only 6/6 full and 6/6 cut: graph OPEN, strict modeled closure FAIL, retirement NOT CERTIFIED. Develop and prove the full IR path before retiring legacy. The migration epic remains in progress.

The canonical dirty Deno worktree `/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm`, branch `codex/4376-deno-callback-construction-20260930`, and all other prepared lanes remain untouched. No worktree was deleted, reset, pruned, stashed or overwritten. No GitHub issue or polling automation was created. No passive webhook tool is available; notifications or an explicit resume must drive fresh PR/main reads and protected merge ancestry/content verification.
