---
id: 5215
title: "test262 runner silently publishes an incomplete verdict set after queued Vitest timeouts"
status: done
sprint: current
created: 2026-08-30
updated: 2026-08-30
completed: 2026-08-30
pr: 5290
assignee: ttraenkler/codex-es6-census
priority: high
horizon: m
feasibility: medium
reasoning_effort: max
model: gpt-5.6-luna
task_type: bugfix
area: testing
language_feature: test262-harness
goal: test-infrastructure
related: [4444, 3407, 4412]
---

# #5215 — make a test262 report prove verdict completeness

## Problem

The maintained Vitest runner can execute every registered test, lose verdict
rows when queued concurrent callbacks exceed Vitest's test timeout, and still
print `COMPLETED` and publish a report built from the partial JSONL. A
well-formed partial report is therefore indistinguishable from a complete
conformance census unless a caller independently compares its path set.

This is a repository markdown issue only. No GitHub issue was created.

## Exact reproduction

The 2026-08-30 standalone ES2015 diagnostic used:

- source `1f1004f3df195cc5f9e804efcbb2896d3871ca37`;
- the maintained `pnpm run test:262 -- --official-scope-only` runner;
- `TEST262_TARGET=standalone`, `TEST262_WORKERS=2`, and
  `COMPILER_POOL_SIZE=2`;
- exact filter `/private/tmp/js2-es2015-11704-pr5008.txt`, containing 11,704
  unique paths with SHA-256
  `45de809c6bfce7371cee1d20e327758246b0524ecd75481a08b8c03344fced8a`;
- QuickJS standalone provider artifact
  `/private/tmp/js2-quickjs-artifact-2e2d7736713beeda`.

Vitest's final summary proved it registered and executed **11,704 tests**.
Fifteen shards recorded exactly their registered counts, but shard 10 printed
`Chunk 10/16: 731 tests` and later
`Test262 chunk 10/16: 712 total`. The runner nevertheless generated a report
and printed `COMPLETED: 8974 pass / 11685 total`.

The preserved JSONL has SHA-256
`47f34c307c43b06c9c40bb0df754bc22d94435a23cccfdd6de857816e199214a`.
It contains 11,685 physical rows and 11,685 unique paths: 8,974 pass, 2,258
fail, 447 compile_error, 6 compile_timeout, and 0 skip. It has no malformed
rows, duplicates, or paths outside the filter, but is missing exactly 19 paths.
The generated partial report has SHA-256
`f6255daef57aa971bf121b98ea629b53985cf591d47bfc579b54dab538babe59`.

## Root-cause evidence

`vitest.config.ts` permits 32 concurrent callbacks while this run's
`CompilerPool` had only two workers. Vitest starts each callback's timeout while
many calls are still queued behind the pool. The final failure output groups
the unrecorded shard-10 paths under:

```text
Error: Test timed out in 90000ms.
  at tests/test262-shared.ts:644:9
```

Most timed-out callbacks eventually wrote a verdict, but Vitest advanced to
the shard's `afterAll`, shut down the pool, and left the final 19 without a
`recordResult` call. The existing completion file proved the mismatch at that
moment (`registeredTests: 731`, `recordedRows: 712`), but every later shard
overwrote the same file. `scripts/run-test262-vitest.sh` ignores Vitest's
non-zero status because conformance failures are expected, then builds a report
without validating per-shard completion or the expected unique identity set.

## Missing paths

- `test/built-ins/ArrayBuffer/prototype/slice/start-exceeds-end.js`
- `test/built-ins/ArrayBuffer/prototype/slice/tointeger-conversion-start.js`
- `test/built-ins/ArrayBuffer/zero-length.js`
- `test/built-ins/Iterator/prototype/chunks/exhaustion-does-not-call-return.js`
- `test/built-ins/Iterator/prototype/chunks/underlying-iterator-closed-in-parallel.js`
- `test/built-ins/Iterator/prototype/windows/result-is-iterator.js`
- `test/language/arguments-object/cls-decl-gen-meth-static-args-trailing-comma-single-args.js`
- `test/language/arguments-object/cls-expr-gen-meth-args-trailing-comma-spread-operator.js`
- `test/language/computed-property-names/class/static/method-prototype.js`
- `test/language/eval-code/direct/lex-env-distinct-const.js`
- `test/language/global-code/new.target.js`
- `test/language/global-code/script-decl-var-collision.js`
- `test/language/identifiers/val-class.js`
- `test/language/literals/numeric/octal.js`
- `test/language/statementList/eval-block-arrow-function-assignment-expr.js`
- `test/language/statementList/eval-block-with-statment-arrow-function-functionbody.js`
- `test/language/statementList/eval-block-with-statment-expr-arrow-function-boolean-literal.js`
- `test/language/statementList/eval-class-arrow-function-assignment-expr.js`
- `test/language/statementList/fn-arrow-function-assignment-expr.js`

## Scope and invariants

- A report may be called complete only when every selected, recordable test has
  exactly one canonical JSONL verdict.
- Expected official-scope exclusions must be counted explicitly; they must not
  make a missing callback look legitimate.
- Conformance failures remain normal data and must not make the shell treat an
  otherwise complete run as infrastructure failure.
- A timed-out or abandoned callback is infrastructure incompleteness, even if
  every emitted JSONL row is well formed.
- Scoped path-filter and shard-glob runs remain supported, but their expected
  selected identity count must be derived from that scope.
- Unit-suite concurrency outside test262 must not regress.

## Implementation plan

1. Reconcile Vitest callback concurrency with the active compiler-pool size for
   test262 runs. Derive the test262-specific `maxConcurrency` from the same
   bounded worker setting instead of queueing 32 timeout clocks behind a
   one- or two-worker pool; preserve the existing unit-suite default.
2. Give every shard a durable, non-overwriting completion manifest. Record its
   registered count, canonical verdict count, explicit official/proposal
   exclusions, and whether all callbacks settled before pool shutdown.
3. Add a reusable completeness validator for the runner. It must reject
   missing shard manifests, `registered != verdicts + explicit exclusions`,
   malformed rows, duplicate identities, unexpected paths for an exact filter,
   and disagreement between manifest totals and JSONL unique totals.
4. Run that validator in `scripts/run-test262-vitest.sh` before report
   construction, symlink updates, history publication, or the `COMPLETED`
   message. Preserve the partial timestamped artifact for diagnosis, but print
   `INCOMPLETE` and exit non-zero with the missing shard/count evidence.
5. Add regression tests reproducing a registered/recorded mismatch and the
   exact overwrite hazard: one incomplete shard followed by a complete shard
   must still block publication. Add positive controls for complete failing
   conformance rows, official-scope exclusions, exact-filter scope, and the
   ordinary non-test262 Vitest concurrency setting.
6. Re-run the 19 paths with one bounded compiler worker to recover dispatch
   verdicts. Then rerun their original shard or an equivalent synthetic runner
   exercise and prove no selected path can disappear behind `COMPLETED`.

## Acceptance criteria

- [x] A shard that registers 731 tests and records 712 cannot be overwritten by
      a later completion file and cannot produce a completed report.
- [x] The runner diagnoses the incomplete shard and exact 19-row deficit before
      updating canonical report/result symlinks.
- [x] A complete run containing ordinary fail/compile_error verdicts still
      builds a report; conformance red is not confused with infrastructure red.
- [x] Exact filters reconcile to their unique selected path set, with zero
      missing, extra, malformed, or duplicate verdict identities.
- [x] Official proposal exclusions are explicit and do not weaken the selected
      path completeness invariant.
- [x] Test262 concurrency is bounded by the active compiler-pool capacity while
      the general unit suite retains its current parallelism.
- [x] Focused regression tests, typecheck, formatting, lint, and issue-integrity
      gates pass.

## Handoff

Implement in the isolated worktree
`/private/tmp/js2-test262-verdict-completeness-20260830`, branch
`codex/5215-test262-verdict-completeness`, based on upstream
`a62aacba5ccc154f6fc378235aaaeeb4a7204231`. Do not edit the user-owned root
checkout. Do not run validation while both one-worker implementation lanes are
occupied; static implementation and unit fixtures may be prepared first.

Once complete and mergeable, this fix gets one non-draft PR from
`ttraenkler/js2` to `loopdive/js2`. Its PR body must name this markdown file and
state that no GitHub issue was created. The dedicated PR shepherd must verify
the exact tested head, body template, mergeability, checks, and readiness before
queueing.

## Static implementation checkpoint (2026-08-30)

The isolated worktree now contains a narrow implementation of the planned
invariants:

- `scripts/test262-concurrency.mjs` derives Test262 callback concurrency from
  `COMPILER_POOL_SIZE`, while `vitest.config.ts` keeps the ordinary unit-suite
  default at 32.
- `tests/test262-shared.ts` registers the exact selected callback set,
  records proposal/official exclusions and callback settlement counts, keeps a
  per-identity canonical-row count, and writes a shard-keyed v2 manifest with
  exclusive (`wx`) creation after the pre-shutdown settlement snapshot.
- `scripts/validate-test262-completeness.mjs` is a reusable pure validator for
  shard registration, verdict/exclusion arithmetic, callback evidence,
  malformed/duplicate/unexpected identities, and JSONL physical/unique totals.
  `scripts/run-test262-vitest.sh` gates report, symlink, history, and
  `COMPLETED` publication on that validator and preserves incomplete JSONL.
  An exact `TEST262_PATH_FILTER_FILE` is passed through as the expected
  callback identity set; the existing OR combination with substring
  `TEST262_PATH_FILTER` fails closed with an explicit unsupported-combination
  diagnostic until a union list can be derived safely.
- The shard workflows consume the new non-overwriting manifest names, and
  focused #5215 fixtures cover incomplete-then-complete shards, ordinary
  failing conformance rows, explicit exclusions, exact scope, and concurrency.

The focused #5215/#3522 Vitest fixtures have now passed (including the CLI
validator/temp-fixture cases) with `TEST262_WORKERS=1`,
`COMPILER_POOL_SIZE=1`, `VITEST_MAX_FORKS=1`, and a single Vitest fork. This is
bounded validation only; the full 11,704-row census remains pending, while the
bounded 19-path rerun is now complete as recorded below. Targeted Prettier,
Biome lint, `bash -n`, and `git diff --check` also pass; the broad scripts
TypeScript config was attempted but reports the repository's existing
thousands of untyped JavaScript/test diagnostics rather than providing a
meaningful change-local gate. The bounded controls below verify publication
gating for incomplete evidence and acceptance of ordinary `fail`/`compile_error`
rows. The repository's normal typecheck, lint, formatting, ratchet,
numeric-local parity, and issue-integrity gates subsequently passed on current
main, as recorded in the publication checkpoint below.

## Bounded acceptance validation (2026-08-30)

The requested 19-path standalone rerun was executed through the maintained
runner with one compiler/test worker. The exact invocation was:

```text
PATH=/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/thomas/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback:$PATH \
TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 VITEST_MAX_FORKS=1 \
TEST262_TARGET=standalone JS2WASM_EVAL_ENGINE=quickjs \
JS2WASM_QUICKJS_ARTIFACT_DIR=/private/tmp/js2-quickjs-artifact-2e2d7736713beeda \
TEST262_PATH_FILTER_FILE=/private/tmp/js2-test262-5215-19-paths.txt \
TEST262_LOCAL_SHARD_GLOB=tests/test262-chunk-dynamic.test.ts \
TEST262_CHUNK_INDEX=0 TEST262_CHUNK_TOTAL=1 TEST262_IT_TIMEOUT_MS=300000 \
TEST262_REPORTER=dot bash scripts/run-test262-vitest.sh --official-scope-only
```

The runner logged `Working tree has local changes; running test262 from
current workspace`, then completed the one dynamic shard with 19 registered
tests. The resulting JSONL has 19 physical rows and 19 unique identities:
15 `pass`, 4 ordinary conformance `fail`, 0 `compile_error`, 0
`compile_timeout`, and 0 `skip`. The durable v2 manifest proves
`registeredTests=19`, `recordedRows=19`, `canonicalVerdicts=19`, zero explicit
exclusions, `callbacksStarted=19`, `callbacksSettled=19`, and
`allCallbacksSettled=true`. The standalone report was constructed as
15 pass / 19 total (78.9%).

Preserved artifacts and SHA-256 digests:

```text
/private/tmp/js2-test262-verdict-completeness-20260830/benchmarks/results/test262-standalone-results-20260830-074856.jsonl
  4cfc254f07c9666e29268acdbd0933b69f0e9a3380a6d3a09245d16bdc4c76cd
/private/tmp/js2-test262-verdict-completeness-20260830/benchmarks/results/test262-standalone-results-20260830-074856.shard-1-of-1.complete.json
  00bb44457a99fa5ffe170d910d29db71201077a24e3e893375ff7aa20a1af417
/private/tmp/js2-test262-verdict-completeness-20260830/benchmarks/results/test262-standalone-report-20260830-074856.json
  41bc3ea4b208e39ff7e9164fd9495098edf3a97bd12b1eaac0daa8122934c186
/private/tmp/js2-test262-5215-19-paths.txt
  58cfd9ee97d1b2bd8ab84dd54ab95c13a8da30deb233ea1f6ca54f95867489da
```

The validator was also invoked directly against those artifacts:

```text
node scripts/validate-test262-completeness.mjs \
  --input benchmarks/results/test262-standalone-results-20260830-074856.jsonl \
  --manifest benchmarks/results/test262-standalone-results-20260830-074856.shard-1-of-1.complete.json \
  --expected-shards 1 \
  --expected-paths-file /private/tmp/js2-test262-5215-19-paths.txt
COMPLETE: 1 shard(s), 19 verdicts, 19 registered (0 explicit exclusions)
```

CLI controls were run with temporary fixtures. The complete red-data command
was:

```text
node scripts/validate-test262-completeness.mjs \
  --input /private/tmp/js2-test262-5215-red-control.jsonl \
  --manifest /private/tmp/js2-test262-5215-red-control.shard-1-of-1.complete.json \
  --expected-shards 1 \
  --expected-paths-file /private/tmp/js2-test262-5215-red-control-paths.txt
```

It contained one `fail` and one `compile_error`, returned exit 0, and printed
`COMPLETE: 1 shard(s), 2 verdicts, 2 registered (0 explicit exclusions)`.
Its JSONL, manifest, and expected-path file are
`/private/tmp/js2-test262-5215-red-control.jsonl`,
`/private/tmp/js2-test262-5215-red-control.shard-1-of-1.complete.json`, and
`/private/tmp/js2-test262-5215-red-control-paths.txt` with SHA-256
`e191b50181399947be69c3ae5739bc52c05a0970f604a8e648e732415767b762`,
`94668388e0578482a34c957c81201bdc11e0d0999203692250d711c78527a53c`, and
`083d84dfe914d7e01faa0a92961a03cfd5f0eeeb3a8cf0fe69378889f2b4e1aa`.

The incomplete control command was:

```text
node scripts/validate-test262-completeness.mjs \
  --input /private/tmp/js2-test262-5215-incomplete.jsonl \
  --manifest /private/tmp/js2-test262-5215-incomplete.shard-1-of-1.complete.json \
  --expected-shards 1 \
  --expected-paths-file /private/tmp/js2-test262-5215-incomplete-paths.txt
```

It had two registered identities but one row and unsettled callback evidence,
returned exit 2 and `INCOMPLETE`, and reported the missing identity, callback
settlement mismatch, and manifest arithmetic mismatch. Its JSONL, manifest,
and expected-path file are `/private/tmp/js2-test262-5215-incomplete.jsonl`,
`/private/tmp/js2-test262-5215-incomplete.shard-1-of-1.complete.json`, and
`/private/tmp/js2-test262-5215-incomplete-paths.txt` with SHA-256
`ed7ba4896e6a8cbc8338bea48648ba76fcebfab1e661900d610cef9124fb2a6b`,
`aab7a018ac7bb11cfb18680da407a5cd8d53e8a06cf91989aed2e5524f5448cc`, and
`802b3fabffb3a59fcc1b301a7b0a18c52c68e0bad64e6184cd3f04644e7cf206`.

The runner source order remains validator (line 359) before report
construction (line 374), `COMPLETED=true` (line 389), symlink updates (lines
428–429), and history publication (line 467 onward); therefore the nonzero
incomplete control cannot reach report/symlink/history publication.

The full 11,704-row census remains intentionally unrun. It is the umbrella's
final integrated acceptance run, not a prerequisite for publishing this
runner-integrity fix.

## Publication checkpoint (2026-08-30)

The implementation checkpoint was rebased cleanly onto current upstream main
`c243892c7f3a757bdecf6215626b08586ce72c58`. Commit
`3ff0bf1b020620891195c3f180b400a0ab33c378` passed the repository's real
pre-push chain without bypasses: typecheck, lint, Prettier format check, oracle
and coercion-site ratchets, all 18 numeric-local IR parity tests, and committed
issue integrity. The commit hooks also passed the 17 focused #5215/#3522 tests,
LOC/function budgets, formatting/lint, and the oracle ratchet.

The completed fix is published as non-draft upstream PR
https://github.com/loopdive/js2/pull/5290 from
`ttraenkler:codex/5215-test262-verdict-completeness` to `loopdive/js2:main`.
No GitHub issue was created. The dedicated PR shepherd owns exact-head, body,
review, check, conflict, readiness, and merge-queue follow-through.

The first PR CI run exposed one change-local gate false positive: moving the
existing `negativeCompileErrorMatches` import while adding the completeness
helpers matched the verdict-signal detector even though no scoring behavior
changed. The branch now carries the detector's documented in-diff
`oracle-version-exempt:` comment stating that #5215 changes callback evidence,
not Test262 scoring. The same run's non-required QuickJS lane exhausted its
512 MiB Node heap; it had no semantic assertion failure and is not coupled to
the Test262-only concurrency path. The final checkpoint must re-run the
verdict-oracle gate locally and let CI retry both jobs before queue admission.
