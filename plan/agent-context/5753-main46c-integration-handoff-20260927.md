# PR5753 pinned-main integration and original176 receipt

Source-only handoff after the authorized merge/gate slot was returned. No new
Test262 execution is authorized by this document. Parent owns subsequent tests,
publication to the existing held PR, and integration decisions.

## Exact merge and preservation

- Candidate: `fab3c7cd06e1dda0e4237e7fd2c05c352d8249bb`.
- First parent: `5668c8014b8365358ed655bf6f14b11c85a04065`.
- Second parent: `46c10411d69c8e18b6e36c2ff09bbe08069f0711`.
- Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-5753-main-integration-20260927`.
- Branch: `codex/5753-main-integration-20260927`.

The sole conflict was the import block in
`src/codegen/expressions/call-identifier.ts`. Resolution retained
`fixedSourceFunctionCallHandle`, `emitConditionalCaptureBoxRepair`, and
`compileStringConversionArgument`. Compared with computed merge tree
`b4b2017c296b04df554af72893fbdff39468256b`, the final committed tree differs
only by deletion of three conflict-marker lines. No fixture edit or whole-file
ours/theirs replacement was made. Computed objects remain isolated in
`/private/tmp/js2-5753-merge-audit.Yi1xFq`.

All 5,093 tracked paths under the first parent's `tests/` directory match their
Git blob hashes in the integration tree. Of main's 4,999 test-tree paths, 4,963
match; 36 retain pre-existing branch differences, not edits by this resolution.
None is missing. Complete per-path differences are in
`.tmp/5753-integration/fixture-preservation.json` (two consecutive JSON records),
SHA256 `65ac23d7b057b988cc6f345c7926ca873b98256e986b436ca76a9f94aa75004b`.
These are file-preservation counts, not test outcomes.

Original `codex-5753-main-repair-20260927` unpublished files were not changed:

- `plan/agent-context/5753-class-ownness-plan-20260927.md`:
  `5dee70dba6eef6b533a12284981f5e7958d292774e28b59c04d7336e44da6f03`.
- `plan/agent-context/5753-class-evaluation-pair-20260927.json`:
  `84de831654899acb031f4821157fae4222dc9f312f589695a3e75c57b49ff18e`.

## Terminal gate receipt

Handles 81660 (source TS7), 46995 (normal merge-commit hooks), and 93915
(remaining gates) all terminated exit 0. Compiler slot explicitly returned.

Source TS7 used `node node_modules/typescript7/lib/tsc.js --noEmit -p tsconfig.ts7.json`.
Normal hooks ran with sanctioned `SKIP_SLOW_PRECOMMIT=1`; lint-staged and
LOC/function budgets passed. No no-verify, gate relaxation, or baseline rewrite.
Change-scoped gates used
`LOC_GATE_BASE=46c10411d69c8e18b6e36c2ff09bbe08069f0711`.
Diff-check, oracle ratchet, coercion sites, and compiler-boundary inventory
passed. Inventory is valid with zero errors but `graphComplete: false`.

Logs under `.tmp/5753-integration/`, SHA256:

- `source-ts7.log` and `diff-check.log` (empty successful output):
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `merge-commit.log`: `1c2aafc32ecd56f4f04ba9310eb944b8f9f739c8c7a58081d18f047d362e9ea2`.
- `oracle.log`: `b0b62acf8eb74d55ea9e9be0edf3f2dac9972b48c89c02edf4605a0c9ef8b281`.
- `coercion.log`: `2e140e1ebfc50e92a3fa15c93990d110f1dae54f77e9c13888858c82151b49e2`.
- `inventory.log`: `be6065d770c028dbafed4a2e84701c0ec5057517a420c716e3b7c84e060dd101`.

Thomas Tränkler <git@thomas.traenkler.com> is author and committer. The message
contains `Co-authored-by: Codex <codex@openai.com>`,
`Model: Codex GPT-5 Default`, and final ✓. Raw commit has no signature;
`commit.gpgsign` was unset, not disabled by this worker. An earlier commentary
incorrectly called it signed and was corrected. No amendment was performed.

## Original176 population and completion evidence

Historical pair only: main `935dab385ba7f21588ea371d052e7f143f894205` versus
candidate `b212925eaba4a038e3b422b21232c41000e2b451`.
Main 154/176 pass, candidate 38/176 pass, 129 losses and 13 gains.
These are NOT results for main46c or fab3c7. Shared class-evaluation 0/8
diagnostics are a separate population and do not reclassify the 129 losses.

Exact path file:
`/Users/thomas/Code/js2/.codex-worktrees/codex-5753-floor-main-20260927/.tmp/5753-floor-176-paths.txt`.
SHA256 `ef9ebf3863cd491beaab54070f7494a04428efc4a9d4d553f9c367aacbf6e745`.
Read-only set comparison confirmed it equals BOTH historical completion
manifests' registeredPaths, 176/176, not a narrowed family selection.

Corpus `/private/tmp/js2-test262-b363-vBCLpp` was verified at
`b363f29d3c43c626dc852744ad64a0b48a003693`. Historical floor-main `test262/test`
and `test262/harness` link to that corpus. Preserve complete sources and harness.

Original result and completion files, under
`/Users/thomas/Code/js2/.codex-worktrees/`:

- `codex-5753-floor-main-20260927/benchmarks/results/test262-standalone-results-5753-main176-20260927.jsonl`,
  SHA256 `601e1c4fc972dd85d7706a58fa9f76101baa4ae1365bd9e2acbb1b4581d732fa`.
- `codex-5753-floor-main-20260927/benchmarks/results/test262-standalone-results-5753-main176-20260927.shard-1-of-1.complete.json`.
- `codex-5753-floor-candidate-20260927/benchmarks/results/test262-standalone-results-5753-candidate176-20260927.jsonl`,
  SHA256 `d9417a6d3bb59ad7dca9300d41ad00ec4a2018afccde958b3d80b9c7d8142a89`.
- `codex-5753-floor-candidate-20260927/benchmarks/results/test262-standalone-results-5753-candidate176-20260927.shard-1-of-1.complete.json`.

Both manifests were read directly: 176 registered tests, 176 recorded rows,
176 canonical verdicts, all callbacks settled, zero proposal/official exclusions.
The main log `.tmp/5753-floor-176-run.log` records 154 pass/22 fail, 507.47s,
Vitest3.2.4, dynamic-chunk harness, one unified worker, recycle realm canary.
Tracked copies of full rows and pairing remain in this tree's
`plan/agent-context/5753-original-floor-{main176,candidate176}-20260927.jsonl`,
`5753-original-floor-pair176-20260927.json`, and
`5753-original-floor-main176-provenance-20260927.json`. The latter's old
"candidate not yet run" limitation predates the complete pair receipt.

## Command reconstruction: NOT recovered shell history, NOT executed

No verbatim historical shell invocation was found in the bounded local receipt
search. Pair16's configuration record and original176 logs establish Node22.23.2,
standalone/auto, proposals included, QuickJS, fullRuntimeEval=true (ignored by
QuickJS per the original log), empty IR-first/fnctor-layout-emit overrides,
one worker, 2048 MiB fork/worker limits, 300000ms timeout, chunk0/1.
The runner is `tests/test262-chunk-dynamic.test.ts`, using maintained
test262-shared/runner and original-harness code. This reconstructed invocation
expresses those settings; it is not an original command receipt:

```sh
TEST262_TARGET=standalone TEST262_SEMANTIC_PROVIDERS=auto \
TEST262_INCLUDE_PROPOSALS=1 JS2WASM_EVAL_ENGINE=quickjs \
TEST262_FULL_RUNTIME_EVAL=1 JS2WASM_IR_FIRST= JS2WASM_FNCTOR_LAYOUT_EMIT= \
COMPILER_POOL_SIZE=1 VITEST_MAX_FORKS=1 VITEST_FORK_MAX_OLD_SPACE_SIZE=2048 \
TEST262_WORKER_MAX_OLD_SPACE_SIZE=2048 TEST262_IT_TIMEOUT_MS=300000 \
TEST262_CHUNK_INDEX=0 TEST262_CHUNK_TOTAL=1 TEST262_REALM_CANARY=recycle \
TEST262_PATH_FILTER_FILE=/Users/thomas/Code/js2/.codex-worktrees/codex-5753-floor-main-20260927/.tmp/5753-floor-176-paths.txt \
RUN_TIMESTAMP=UNIQUE_ARM_RECEIPT_ID \
node node_modules/vitest/dist/cli.js run tests/test262-chunk-dynamic.test.ts \
  --maxWorkers=1 --no-file-parallelism
```

Before any grant-driven execution: use separate exact main46c and fab3c7 subjects;
confirm Node version, original corpus links, no inherited conflicting path filter
or lane override, and independently fresh compiler/runtime bundles and canary-
verified QuickJS adapters for EACH subject. Never share historical built artifacts
or reuse result IDs. Provider build commands/identities must be recorded anew;
this handoff does not certify their readiness. Use each subject's harness and
record source hashes/settings, including any harness drift. Do not override
strict-mode behavior or reinterpret the runner's primary/strict outcomes.

After each arm, validate its JSONL plus completion manifest with
`scripts/validate-test262-completeness.mjs --input <jsonl> --expected-shards 1
--expected-paths-file <exact176file> --manifest <completion>`. Preserve full raw
errors and nonpassing-to-nonpassing differences. Require the exact 176 unique
registered and completed paths and zero exclusions before pairing. Even a good
176-row comparison is not the full historical 48,735-test population, full IR
equivalence, or permission to remove the hold or retire legacy paths.
