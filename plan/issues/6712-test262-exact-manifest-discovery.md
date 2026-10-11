---
id: 6712
title: "Test262 exact-manifest selection restores omitted conformance files"
status: in-progress
sprint: current
created: 2026-09-28
updated: 2026-09-28
assignee: ttraenkler/codex-es2015-manifest
priority: high
horizon: m
feasibility: medium
reasoning_effort: max
task_type: bug
area: test262-runner, conformance
goal: test262-conformance
parent: 4444
related: [4444, 3503]
---

# Test262 exact-manifest discovery

## Evidence and scope

The frozen ES2015 goal has 11,778 original corpus paths. The sorted,
newline-terminated paths without the `test/` prefix have SHA256
`f2fdd4e4544a44608f0b53d89d343526cfa9c9044ca263e860da949dc1a2f59f`.
The audited corpus revision is `b363f29d3c43c626dc852744ad64a0b48a003693`.
Default discovery selects only 11,704 of these paths because `TEST_CATEGORIES`
omits `intl402`. All 74 missing paths remain in the frozen edition-index set.
A filter applied after category discovery cannot restore them.

## Manifest receipt (2026-09-28)

The canonical artifact prepared for this change is
`scripts/test262-es2015-11778-manifest.txt`. It contains 11,778 sorted,
newline-terminated `test/...` identities (826,426 bytes), including 74
`test/intl402/...` identities. Its own SHA256 is
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
Removing exactly the leading `test/` from every entry, sorting, and retaining
the final newline produces the historical frozen SHA256
`f2fdd4e4544a44608f0b53d89d343526cfa9c9044ca263e860da949dc1a2f59f`.

This base's `test262` gitlink is
`b363f29d3c43c626dc852744ad64a0b48a003693`; its current committed edition
map (`website/public/benchmarks/results/test262-file-editions.json`) has SHA256
`f210201674b728743d61f60dad6aeaf036c1f55bdbec433f2180c076e6f49d52` and
reconstructs the same population. This worktree's corpus linkage is
provisioned separately; physical file existence is deliberately checked by the
wrapper's fail-closed preflight after official corpus/dependency provisioning
and an execution slot. No absent corpus file may be removed from this expected
set.

This issue repairs selection and verification, not runtime conformance. Do not
reclassify or exclude the missing files, alter pass counters, or claim their
runtime results without executing the maintained runner. Adding bare `intl402`
would select 3,357 paths from many editions and is not the requested fix.

Base: upstream `359c2d63b6753e0c540b8761d13647b00e24a9a4`.
Branch: `codex/6712-exact-manifest-discovery-20260928`.
Worktree: `/Users/thomas/Code/js2/.codex-worktrees/codex-es2015-scope-audit-20260927`.

The broad umbrella's overlap gate flagged active compiler subissues. This task
is routed separately to avoid treating that STOP as clearance. It owns only
explicit runner selection, completeness wiring, focused tests, and related
documentation. No compiler, IR, registry, runtime-provider, edition-index,
baseline-counter, or workflow changes are in scope. The similarly named
completed issue 3503 handles dynamic-import fixture graphs, not test selection.

## Implementation plan

1. Reconfirm corpus/index identity and preserve the exact 11,778-path manifest.
   Canonical entries use `test/`; record that artifact's own hash and strip only
   this prefix when verifying the historical frozen-set hash above.
2. Introduce opt-in `TEST262_EXACT_MANIFEST_FILE` selection through a small
   helper. Preserve existing category discovery and legacy filter semantics.
   Reject either legacy path filter alongside the exact-manifest option.
3. Validate canonical paths, duplicate entries, traversal, realpath escape,
   absent/non-file entries, non-JavaScript files, fixture-only entries, and an
   empty manifest. Permit the normal final newline. The corpus root may itself
   be symlinked; compare real paths against its real root.
4. Route exact selected original files through the maintained chunk runner's
   existing sharding/execution/verdict flow. Derive display categories from the
   selected paths so subsequent category grouping cannot discard Intl files.
5. Pass the original expected set to completeness validation through the
   maintained wrapper. Require exact identity plus registered/verdict/started/
   settled counts; never validate only a reduced registered subset.
6. Add focused helper and integration controls: ordinary plus Intl selection,
   unchanged default/filter behavior, malformed/missing/escaping inputs,
   duplicate rows, an omitted Intl verdict, truncated callbacks, and empty
   selection. Prove all 11,778 paths and exactly 74 restored Intl identities.
7. After obtaining the execution slot, run focused tests and a small maintained
   whole-assembly ordinary/Intl control. Preserve every non-pass result; a
   discovery success is not a runtime pass. Run normal quality gates and open
   a separate upstream PR with exact hashes, results, and remaining blockers.

## Acceptance

- Exact mode selects precisely the supplied original-file set, including files
  outside default categories, without expanding unrelated editions.
- Invalid or incomplete selection fails visibly; no silent-empty success.
- Existing default callers retain their selection behavior.
- Completeness is checked against the original expected identities.
- The full frozen set is demonstrably discoverable; runtime completion remains
  unproven until all 11,778 tests execute with zero non-pass verdicts.

## Coordination and handoff

Implementation is assigned to a Terra Max agent in this isolated worktree.
The root agent coordinates execution slots; no tests, builds, or hooks may
overlap another reserved validation run. Issue 4016 currently has priority.
The new issue was reserved atomically. Its dedicated pre-dispatch gate returned
`CLEAR` (exit 0, no blockers or warnings), then the upstream assignment ledger
verified its claim for `ttraenkler/codex-es2015-manifest`. The gate's idiom scan
was unavailable for this new unlanded issue; supplementary upstream PR-title
searches for manifest, discovery, and test262 found no open matches, with a
positive ordinary PR-list/repository identity control. The repository search
identified completed issue 3503 as different fixture-graph work. These checks
do not assert visibility into unclaimed unpublished work elsewhere.
The earlier umbrella-slice claim is superseded. No GitHub issue was created.

## Validation receipt

- 2026-09-28 focused first attempt (before the symlink-policy follow-up):
  `node node_modules/vitest/dist/cli.js run tests/issue-6712-test262-exact-manifest-discovery.test.ts tests/issue-4412-run-history-guard.test.ts tests/test262-path-filter.test.ts tests/issue-5215-test262-verdict-completeness.test.ts --reporter=dot`
  exited 1 after 97.25 seconds: 34 passed / 39 total, 5 failures. One new
  helper assertion compared macOS's lexical `/var` spelling with its
  `/private/var` realpath and is being corrected to compare realpaths. Two new
  selection cases and two existing `test262-path-filter` cases timed out at
  35 seconds while dynamically reloading `test262-runner`; their import-cost
  diagnosis is pending. This is a failed receipt, not a conformance result.

- The isolated existing filter control confirmed that the timeouts were cold
  import cost, not concurrent-test contention: the unchanged
  `tests/test262-path-filter.test.ts -t "matches everything when filter is
  unset" --testTimeout 120000` passed in 43.648 seconds of test time
  (44.28 seconds total). That one-off diagnostic does not change the normal
  timeout or constitute a default-gate pass. The #6712 test instead primes the
  runner once during collection under an explicitly unfiltered environment;
  it does not reset or change the production cache behavior.

- Root performed the physical selection preflight against the existing corpus
  root `/Users/thomas/Code/js2/test262` without mutating it:
  `node scripts/test262-exact-manifest.mjs --input
  scripts/test262-es2015-11778-manifest.txt --test262-root
  /Users/thomas/Code/js2/test262` exited 0 with `Validated 11778 exact
  Test262 path(s)`. Its Git root and HEAD resolve to the pinned
  `b363f29d3c43c626dc852744ad64a0b48a003693`; the helper independently
  observed 11,778 unique identities, 74 Intl identities, and canonical SHA256
  `632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`.
  A later root check compared the manifest to `git ls-tree HEAD` and found all
  11,778/11,778 selected originals tracked at that revision (missing: none),
  with no tracked corpus modifications. The corpus also contains unrelated
  untracked injected/probe files and symlink directories, which are preserved
  and excluded by the exact tracked-original manifest; it must not be called
  globally clean. This proves physical discovery only, not compilation or
  runtime passing.

- Focused #6712 control after the policy/snapshot fixes:
  `node node_modules/vitest/dist/cli.js run
  tests/issue-6712-test262-exact-manifest-discovery.test.ts --reporter=verbose`
  exited 0: 12/12 tests passed (34.59 seconds collection-time priming, 342 ms
  test bodies, 35.46 seconds total). It covers exact original identity
  selection, input failure modes, symlink containment and policy identity,
  fixture/self-import keys, frozen hashes, completeness failures, snapshot
  mutation wiring, and executable early wrapper rejection. Maintained
  ordinary/Intl runtime validation remains pending.

- The first two maintained-runtime starts produced no verdict rows and are
  retained as setup failures: the first snapshot attempt exposed an invalid
  inline static-import expression in the new shell hash bridge before compiler
  build; its follow-up executable bridge test found and corrected the
  dynamic-import argument ordering as well. The second start rebuilt this
  checkout's compiler bundle but could not fetch a QuickJS provider because
  DNS could not resolve `github.com`. The final focused bridge regression then
  passed 12/12 (36.99 seconds total; 35.82 seconds collection, 565 ms test
  bodies), before the runtime retry.

- Maintained whole-assembly ordinary + restored-Intl control (2026-09-28):
  ```text
  TEST262_WORKERS=1 COMPILER_POOL_SIZE=1 VITEST_MAX_FORKS=1 \
  VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 TEST262_TARGET=standalone \
  JS2WASM_EVAL_ENGINE=quickjs \
  JS2WASM_QUICKJS_ARTIFACT_DIR=/Users/thomas/Code/js2/.codex-worktrees/codex-4016-resume-20260927/.test262-cache/quickjs-artifact-2e2d7736713beeda \
  TEST262_EXACT_MANIFEST_FILE=.tmp/6712/ordinary-intl-control.txt \
  TEST262_LOCAL_SHARD_GLOB=tests/test262-chunk-dynamic.test.ts \
  TEST262_CHUNK_INDEX=0 TEST262_CHUNK_TOTAL=1 TEST262_IT_TIMEOUT_MS=300000 \
  TEST262_PUBLISH_HISTORY=0 TEST262_REPORTER=dot \
  bash scripts/run-test262-vitest.sh
  ```
  The runner used the dirty current checkout (so it rebuilt this branch's own
  compiler bundle) and the verified #4016 QuickJS artifact only
  (`libquickjs.wasm` SHA256
  `e9f8d30bc347dbc56f31b3389f7696eb6dedc9f05ea729781fc412f09a3e6b17`).
  Exact preflight and its snapshot both validated two paths; snapshot SHA256
  was `d5d0131484fa1cfbc5548931f309281210b88f557f4ca7dd4ac95ecdf1ef9f94`.
  The dynamic 0/1 completion receipt recorded both original paths as
  registered, started, settled, and verdict-bearing, with zero exclusions.

  It completed the integrity/report flow (wrapper exit 0) at **1 pass / 2
  total**, not 2/2 conformance success: ordinary
  `test/language/expressions/addition/S11.6.1_A4_T6.js` passed; restored Intl
  `test/intl402/Intl/getCanonicalLocales/has-property.js` honestly failed with
  `Test262Error: Expected a Test262Error but got a TypeError`
  (`assertion_fail`). No row was dropped or reclassified. History publication
  was explicitly skipped. Preserved artifact SHA256 values are:
  `test262-standalone-results-20260928-005752.jsonl`
  `ba3d7ec394bbe158c8ad4decbbd8201be87bda259930046a4250090c6f39282a`,
  `test262-standalone-results-20260928-005752.shard-1-of-1.complete.json`
  `fe1d40b932d60a588476f2594b534c06b342318372df9b9ba5e6d169e7e0eb72`,
  and `test262-standalone-report-20260928-005752.json`
  `24d26edb1643e52ef29c790d48e1718f3d6b20e7a154bd16266e6b3b3c5a45ba`.
  This validates exact discovery/registration/completeness wiring for the two
  paths only; it does not establish runtime success for the 11,778-path set.

  Follow-up clue for the parent closeout, not a #6712 implementation claim:
  this original calls `Intl.getCanonicalLocales` with a Proxy whose `has("0")`
  trap throws `Test262Error`, so its expected path depends on that API and
  proxy-order behavior. Root's source triage found no implementation of
  `getCanonicalLocales`; the host Intl namespace route in `identifiers.ts` is
  gated out for standalone/WASI, and the standalone Intl shim documents
  remaining null behavior. That supports a missing standalone Intl
  namespace/API hypothesis, but does not prove the emitter trace or explain
  any other restored Intl path. The failed original remains a counted result.

- Final focused mutation-guard control (2026-09-28):
  `node node_modules/vitest/dist/cli.js run
  tests/issue-6712-test262-exact-manifest-discovery.test.ts --reporter=verbose`
  exited 0 with 12/12 tests passed in 38.38 seconds (36.77 seconds collection,
  946 ms test bodies). It executes the wrapper's actual dynamic-import hash
  bridge and extracted snapshot-integrity guard, proving a changed snapshot is
  rejected rather than allowing the runner and expected set to silently track
  the same mutable manifest.

- Scoped runner/completeness regression control (2026-09-28):
  `node node_modules/vitest/dist/cli.js run
  tests/issue-6712-test262-exact-manifest-discovery.test.ts
  tests/issue-4412-run-history-guard.test.ts
  tests/issue-5215-test262-verdict-completeness.test.ts
  tests/test262-scope-classification.test.ts
  tests/issue-1390-import-defer-skip.test.ts --pool=forks
  --poolOptions.forks.singleFork=true --no-file-parallelism --reporter=dot`
  exited 0 with 5 files / 42 tests passed in 47.69 seconds. This preserves the
  history, verdict, scope, and import-defer controls while exercising the
  exact-manifest path.

- Unrelated existing-control comparison (2026-09-28): clean managed baseline
  `/Users/thomas/.codex/worktrees/manifest-baseline/js2` was verified at
  `359c2d63b6753e0c540b8761d13647b00e24a9a4` with a clean status. Its
  `tests/dynamic-import-fixture-skip.test.ts` source SHA256 matches this branch
  (`330dd1d1282dc71d42620e698817cf002fb9bacda43d0395455a3c5263b363d8`).
  Running its unchanged test with the same Node/Vitest command exited 1:
  3 passed / 1 failed in 35.31 seconds. The pre-existing failure is the
  no-`filePath` expectation that an in-source `_FIXTURE` dynamic import returns
  `skip=true`; it receives `false` on both base and candidate. The durable
  baseline log is
  `.tmp/6712/base359c2-dynamic-import-fixture-skip-20260928.log`. No legacy
  skip policy was changed merely to satisfy that stale assertion.

- Final post-format/lint correction reruns (2026-09-28): the focused #6712
  command above exited 0 with 12/12 passed in 40.40 seconds (39.05 seconds
  collection, 730 ms test bodies), and the five-file scoped command above
  exited 0 with 42/42 passed in 44.79 seconds. The correction replaced
  `delete process.env[...]` in the new test-only environment helper with
  `Reflect.deleteProperty`, preserving an actually unset Node environment
  rather than assigning the string-like `undefined` value. `bash -n
  scripts/run-test262-vitest.sh`, selected Prettier checking, and scoped Biome
  lint all passed. This remains discovery/completeness evidence, not a whole
  Test262 runtime pass claim.

## Publication receipt

Committed as `db5fe17e84365f93f90c9134636f989f94a453dc`
(`fix(test262): restore exact ES2015 manifest discovery`) with Thomas
Tränkler's required attribution and the Codex/Terra Max trailers. The normal
fork push completed after typecheck, lint, formatting, ratchet, numeric-local,
documentation-sync, and issue-integrity gates passed; its remote ref was
independently verified at that same SHA. The implementation is published for
review as [upstream PR 6210](https://github.com/loopdive/js2/pull/6210), based
on `main`. At publication it is open, non-draft, and GitHub reports
`mergeable=MERGEABLE`; its `BEHIND` state is deliberately not rebased blindly,
so the pinned-base discovery/runtime evidence above remains intact until any
future integration validation is coordinated.

## Post-publication frozen Intl census (2026-09-28)

The 74 `test/intl402/...` identities from the frozen 11,778-path manifest were
measured without adding unrelated Intl editions. The newline-terminated input
`.tmp/6712/intl74-originals.txt` and the wrapper-created exact-manifest
snapshot both have SHA256
`f1c370eed335e514cb60340e9d105545719599017fd20acfdfb0be2d9883d2a3`.
The input is byte-for-line equal to the frozen manifest's 74 Intl rows.

Run `20260928-015700` used the maintained standalone dynamic chunk (index 0,
total 1), one worker, a 4096 MiB fork heap, source commit
`db5fe17e84365f93f90c9134636f989f94a453dc`, and history publication disabled.
Before the wrapper started, the sanctioned QuickJS consumer check reported a
required linked-pair cache hit for artifact key `2e2d7736713beeda`, adapter key
`6dfa2dab8d8bfa0d`, and compiler bundle key `3683fc47b6486637`. The pinned
artifact's `libquickjs.wasm` SHA256 is
`e9f8d30bc347dbc56f31b3389f7696eb6dedc9f05ea729781fc412f09a3e6b17`.

The maintained wrapper completed its accounting: the shard receipt has the
same 74 registered paths as the input, 74 recorded/canonical verdicts,
`callbacksStarted=74`, `callbacksSettled=74`, `allCallbacksSettled=true`, and
zero proposal or official exclusions. Its exit 0 therefore proves complete
dataset accounting, **not** conformance success. The retained outcomes are
2 pass, 70 fail, 2 compile errors, and 0 skips. The two exact passes are
`test/intl402/DisplayNames/ctor-custom-get-prototype-poison-throws.js` and
`test/intl402/Segmenter/ctor-custom-get-prototype-poison-throws.js`; they do
not establish broad API coverage. The two compile errors preserve standalone
host-import leaks for
`NumberFormat/prototype/format/value-tonumber.js`
(`env::Intl_NumberFormat_new`, `env::Intl_NumberFormat_format`) and
`NumberFormat/prototype/formatToParts/value-tonumber.js`
(`env::Intl_NumberFormat_new`, `env::Intl_NumberFormat_formatToParts`).

Preserved artifact SHA256 values are:

- JSONL: `62150442b185548dd9a95c18a162984d0cd491aaf7ff746ac79bc64101ebac07`
- shard completion: `3deed2815b81bfe32bfd28d075cd4d879cb55ec6ac7ecf97e11fe02b662c16bf`
- report: `2c9c8ec92598fc66f5e18ac44d346f5e6745bf6d645aa756c5f3572fc2036411`

The generated report's existing bucketing classifies all 72 non-passes; it is
an aggregation aid, not proof of one implementation cause. In particular,
the observed host-only Intl route and earlier #5206/#6442 work are follow-up
clues only. The proof-first [#6717 standalone user-Intl
plan](./6717-standalone-user-intl-namespace-api-gap.md) now defines the
required representative repros and positive controls before any implementation
is claimed.

## CI generated-index serialization diagnosis (2026-09-28)

The historical reconstruction receipt remains tied to base
`359c2d63b6753e0c540b8761d13647b00e24a9a4`: its generated per-file edition
index had raw SHA256
`f210201674b728743d61f60dad6aeaf036c1f55bdbec433f2180c076e6f49d52` and
reconstructed the frozen set. It is evidence about that base, not an invariant
for a later regenerated report artifact.

The published #6210 quality job checked out GitHub's synthetic merge
`ea11335db4fde6029fdbeab86c9109ac06d56350` (head
`db5fe17e84365f93f90c9134636f989f94a453dc` into current main
`fb006fe12498c7d53c3ff4d99bd389d937dabe9c`). Its generated index SHA256 was
`7ad7c2c05d75ddd9bc436320100d834cc865ca00798f8e1573dc282d7f537b97` after
the baseline-refresh commit `aca46e64cded68942686f67a52c38bb1d3c358ab`.
That refresh reordered the `editions` array's `ES5` and `ES2021` labels and
remapped their compact numeric values (9,174 `ES5` entries `0→1`; 472
`ES2021` entries `1→0`). It made 9,646 numeric mapping changes but zero
semantic edition-label changes.

The exact ES2015 comparison across those two index revisions is unchanged:
11,778 paths on each side, no old-only or new-only identity, and 74 `intl402`
paths on each side. The ongoing regression therefore binds the current index's
sorted semantic ES2015 identities to the immutable stripped-set SHA256
`f2fdd4e4544a44608f0b53d89d343526cfa9c9044ca263e860da949dc1a2f59f`, while
retaining canonical-manifest SHA256
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`, the
11,778/74 census, exact set-difference checks, and completeness controls. A
serialization-only generated-index change no longer wedges an otherwise
identical frozen population; any actual ES2015 membership change still fails.

Post-repair validation (2026-09-28) used the bundled Node `v24.19.0` on
`db5fe17e84365f93f90c9134636f989f94a453dc`, one fork/worker, a 4096 MiB main
and fork heap, and no file parallelism:

```text
NODE_OPTIONS=--max-old-space-size=4096 VITEST_FORK_MAX_OLD_SPACE_SIZE=4096 \
VITEST_MIN_FORKS=1 VITEST_MAX_FORKS=1 <node24> node_modules/vitest/dist/cli.js run \
  tests/issue-6712-test262-exact-manifest-discovery.test.ts \
  tests/issue-4412-run-history-guard.test.ts \
  tests/issue-5215-test262-verdict-completeness.test.ts \
  tests/test262-scope-classification.test.ts \
  tests/issue-1390-import-defer-skip.test.ts \
  --pool=forks --poolOptions.forks.singleFork=true --maxWorkers=1 --minWorkers=1 \
  --no-file-parallelism --reporter=verbose
```

It exited 0: five files and 44 tests passed in 33.89 seconds. The focused
#6712 file supplied 14 of those tests, including the edition-array
reorder/remap positive control and changed-membership negative control. The
input receipts were test SHA256
`1d7cb91c43e94c3164284c2478217736667740334af8447fe9a29692709e2ae3`, canonical
manifest SHA256
`632db3bbecb0d6ea42b0915b13740912bf3fd8e32e2a15a8b28c1f63b6434360`, and the
branch's historical index SHA256
`f210201674b728743d61f60dad6aeaf036c1f55bdbec433f2180c076e6f49d52`. This is
selection/completeness regression evidence only; it does not rerun the frozen
corpus or claim its runtime outcomes.
