# Merge-only handoff, 2026-09-09

## Resumed landing work

The user restored the weekly budget to 55% and resumed merge-only work.
Local commit `2262ac910d` integrates main96c497 into this cumulative branch;
the merge changes only 16 generated benchmark/report files, no compiler,
tests or configuration. The original snapshot below is retained as history.

Batch B completed EXIT0: 367/367 tests, 11/11 files, zero failed/pending,
497.45 seconds. Receipt `.tmp/queue-drain-consolidation-B.json` and matching
log are in this worktree. Batch C completed EXIT0: 632/632 tests, 20/20 files,
zero failed/pending, 178.86 seconds; receipt `.tmp/queue-drain-consolidation-C.json`.
Batch D completed EXIT0: 273/273 tests, 6/6 files, zero failed/pending,
177.73 seconds; receipt `.tmp/queue-drain-consolidation-D.json`. Historical pairs
remain unrun. PR5798 remains held; the refreshed local commit is not yet pushed.

Independently reviewed data-only PR5808 was admitted at exact head
`07ab0a6e2d7876da96b5dc614cdc44f6a10df186`. Merge-group candidate
`cbb227e10547f5d3befc4021a7fe5b2775c5060c` has successful CI and intentionally
no-op Test262 checks (HOST_RAN/SHARDS_RAN false). Differential run34392323270
subsequently completed successfully. PR5808 merged at19:04:25Z, and both its
exact reviewed head and merge candidate were verified ancestors of fetched
main `cbb227e10547f5d3befc4021a7fe5b2775c5060c`. Those no-op checks do not clear
issue5807. Refresh the cumulative branch against this data-only main update.

User reduced the remaining weekly budget to 7%. Pause migration expansion and
expensive diagnostics. Work only on landing existing PRs. Parent owns integration
and public writes; native agents are paused except cheap independent readiness
review. Never count stacked merges as delivery or weaken a failing gate.

## Fresh remote state

- 35 open PRs at this handoff, down from the earlier 42.
- PR5743 reached main at `129e3efd4530ae1be56dbf5fdea54ddbbd87443e`.
- Fresh API reports PR5751 MERGED at 2026-09-09T16:31:32Z, merge
  `efa0908e09998c73da592fba32708c7ecca8d6e5`, head `1330f172f78ed794915ffabeacbf2c39cf5bea07`.
- Fresh main is `96c4970002f09ea90c4c5620f4076643250fd2a8`.
- IMPORTANT: run34374533493 still reports FAILURE. Issue5807 remains OPEN.
  Do not describe the two BigInt TypedArray regressions as fixed or waived merely
  because the candidate merged. Reconcile this before admitting the dependent stack.

## Existing publication vehicle and validation

PR5798 is non-draft, held, branch `codex/3518-number-format-consumer-20260909`.
Before this publication its remote head was `b321187ba3df73bd9044ddfb24670bae2196e83f`.
Use this existing PR; do not open a duplicate checkpoint.

Integration worktree: `/private/tmp/js2-3518-queue-drain-consolidation-20260909`.
Pre-checkpoint HEAD: `19a0a9bd8c2c29bfc492b2b6d4bafa0952667eb6`.
It already merges PR5751 head and main522e47f, but NOT fresh main96c497.
Archive b321 preserves historical docs and issue additions without altering policy.

The boundary test-only repair preserves all original 284 cases and adds 18.
Its full suite passed 302/302. The original ten-file integration batch failed
17/1360 before repair; repaired rerun completed EXIT0, 1378/1378 passed,
zero failed/pending. Receipt: `.tmp/queue-drain-consolidation-A-repaired.json`;
log has the same basename. Session35479 is terminal. Source TS7 and inventory
passed before this test-only repair. No source, checker, policy or baseline relaxed.

Remaining composed batches B/C/D and historical execution pairs are UNRUN.
Old pinned manifests reference19a0 and require fresh review after HEAD changes.
Do not claim this checkpoint fully validated or merge-ready.

## Landing sequence

1. Reconcile the merged5751 / failed-gate discrepancy; keep5807 explicit.
2. Review independent main-base green PRs cheaply, including5785; inspect hold
   labels, unresolved review threads and actual queue evidence before admission.
3. Refresh this integration against current main, preserve all issue histories,
   validate the remaining composed surface, then use5798 as cumulative vehicle.
4. Close superseded PRs only after verifying their live heads and unique content
   actually occur on main. Retarget/refresh affected dependents after each merge.

## Unpublished evidence and protected work

PR5751's old tree `/private/tmp/js2-3518-semantic-provider-integration-20260908`
has two untracked documents: `plan/issues/5807-bigint-typedarray-landing-regressions.md`
and `plan/agent-context/5807-node25-paired-diagnostic-2026-09-09.md`. Preserve them.
Issue5807 already contains public facts and diagnostic limits.

Baseline `/private/tmp/js2-5807-baseline-129e-20260909` and candidate
`/private/tmp/js2-5807-candidate-efa0-20260909` each passed the actual shared-CI-path
three-row diagnostic under Node25.9.0/macOS ARM64/one worker. Separate six-variant
saved binaries were pairwise identical. This is NON-REPRODUCTION, not clearance
of the original Linux x64/four-worker failures. No causal production fix exists.
Shard evidence lives under `/private/tmp/js2-shepherd-5786-repair-20260909/plan/agent-context/`.
High's detailed composed plan is `/private/tmp/js2-3518-lane-b-high-M2Rs26/3518-queue-drain-consolidation-handoff-2026-09-09.md`.
Potential Temporal predecessor is an unconfirmed hypothesis; diagnostics paused.

Preserve dirty root `/Users/thomas/Code/js2`, original number-format worktree,
and frozen E2 generic-output tree. Do not reset, stash, clean, or graft their work.
PR5753 fork push was denied twice; no retry/workaround without approval.

## End-to-end IR status

Prepared synchronous consumer evidence exists. Complete prepared native async,
all owner body fills, timer/frame handling, public default/ABI and strict direct
codegen retirement remain unfinished. No complete end-to-end IR program is
certified by this handoff. New migration work is paused by user instruction.

## Latest resume: historical gate results and attribution

This section supersedes the earlier UNRUN statements. Public PR5798 head at
review is `b2af7c32353df0f138b72608835ff5288cb41603`, CLEAN/MERGEABLE but held;
its base is still the runtime-support transport branch, not main. There are
35 open PRs in the refreshed inventory. No new migration scope is authorized.

Composed batches A/B/C/D passed 2650/2650 tests across 47 files. The no-demand
three-arm and scanner three-arm checks passed. The Promise historical pair
passed repair acceptance (20 baseline semantic gaps, zero candidate gaps),
not preservation. Compiler source tree is `360f3b82efb0a1aee71233122f9c8dd92e9331ef`.

Delay exact preservation did not pass: both children exited zero, but the
outer worker exhausted its heap; saved artifacts differ in all 11 rows.
Frame exact preservation failed normally: 20/21 tests pass, with the paired
row comparison failing; four of five artifact rows differ. The late-import
row remains exactly equal. Do not rerun solely to hide these mismatches.

Astra High completed bounded saved-artifact attribution. All 31 recorded
observations agree excluding instantiated bytes, and all 16 rows have verified
type mappings within the analyzer's bounded search. It explains 1281 WAT forms
by explicit reference mapping and 17 by local declaration renames. Remaining:
41 function forms, 52 export forms, and six start forms. These include string
numeric scanner guards, Promise resolution changes, and eight family
`ref.as_non_null` additions; the Promise repair is not the sole explanation.
Binary sections and encodings are inventoried, not fully reconciled. Original
exact-parity failures remain failures; no acceptance gate or baseline changed.

Receipts in this integration worktree:
- `.tmp/queue-drain-frame-pair-b2af7c32.json` (session93831 EXIT1);
- `.tmp/frame-body-preservation-ObO2Sg/`;
- `.tmp/delay-combinator-preservation-uGms5w/`;
- `.tmp/attribution-9qxM8J/summary.json` and `attribution-v2.json`.
The detailed attribution SHA256 is
`9593ec6d38588d5c182d36c2f69fc7ac338795418cf57ff3c090041b43bd2f9c`.
The older `attribution.json` draft is superseded. No analyzer process remains.

Next: account for residual source changes and export/start/binary differences
before proposing acceptance; retain issue5807's two genuine Linux CI
regressions as unresolved despite local non-reproduction. PR5808's data-only
refresh reached main at `cbb227e10547f5d3befc4021a7fe5b2775c5060c`, already
incorporated here. No additional PR reached main in this resume pass.
Independent PR5400 and PR5397 are conflicting and explicitly unfinished in
their own descriptions; their documentation-like titles are not merge clearance.
