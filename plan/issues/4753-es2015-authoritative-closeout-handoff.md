---
id: 4753
title: "ES2015 authoritative Test262 close-out handoff"
status: in_progress
created: 2026-08-26
updated: 2026-08-26
priority: high
horizon: l
feasibility: medium
reasoning_effort: max
task_type: conformance
area: test262, integration
es_edition: es2015
goal: test262-conformance
related: [4444, 4751, 4752]
---

# #4753 — ES2015 authoritative Test262 close-out handoff

## Objective

Prove and, where necessary, complete 100% ES2015 Test262 conformance after the
combined implementation foundation merged through upstream PR #4974:

<https://github.com/loopdive/js2/pull/4974>

Success requires zero non-passing rows in each required project lane under the
maintained `scripts/run-test262-vitest.sh` runner. Focused issue tests and stale
benchmark artifacts are supporting evidence only; they cannot close this issue.

## Current state

- PR #4974 merged into `loopdive/js2:main` on 2026-08-26. PR #5008 then
  auto-merged its first close-out checkpoint while measurement was active.
  Continued work uses `codex/es6-conformance-closeout` on the `ttraenkler/js2`
  fork and successor upstream draft PR #5010 so checkpoints remain reviewable:
  <https://github.com/loopdive/js2/pull/5010>.
- Handoff head before this issue commit: `df70faa5e`.
- The first combined CI run found one integration-only dead helper. Issue
  #4752 deleted it; the dead-export gate now reports 23 known entries and 0
  new entries.
- Generator close suites #4716/#4718 pass 26/26 after that repair.
- TypeScript 5/7, host-import policy, LOC/function budgets, oracle/coercion
  ratchets, issue integrity/IDs, formatting, and the full pre-push pipeline
  pass locally.
- The file-edition map has 11,778 ES2015 labels. The maintained runner excludes
  `intl402`; exactly 74 labelled files are under that root, leaving the
  documented 11,704-test ES2015 bucket.
- A detached measurement worktree was prepared at
  `/private/tmp/js2-es6-authoritative-measure` on `df70faa5e`. Its dependency
  provisioning linked `node_modules`, but `test262` still needs to be linked
  from `/Users/thomas/Code/js2/test262` before measurement.

## Implementation plan

1. Refresh the measurement worktree to the latest PR #4974 head and provision
   `node_modules`, `test262`, and the shared Test262 cache without modifying the
   dirty root worktree.
2. Generate an exact temporary filter from
   `website/public/benchmarks/results/test262-file-editions.json`: retain rows
   whose edition index is `ES2015` and whose path does not start with
   `intl402/`, then prefix each retained map key with `test/` for the runner's
   `relative(TEST262_ROOT, filePath)` contract. Assert exactly 11,704 distinct
   paths and verify positive-control paths exist before running. The nearby
   `TEST262_PATH_FILTER_FILE` comment saying paths are `test/`-relative is
   stale; unprefixed edition-map keys register zero shard tests.
3. Run the maintained runner with five workers and `--official-scope-only` for
   the host (`TEST262_TARGET=gc`) and standalone (`TEST262_TARGET=standalone`,
   default QuickJS eval provider) lanes. Preserve both timestamped JSONL files
   and reports. Record pass/fail/compile-error/skip denominators separately.
4. Rerun every non-passing row alone before attribution. Partition confirmed
   residuals into narrow semantic clusters, allocate one issue markdown per
   cluster, and dispatch Luna/max agents in separate git worktrees. Agents must
   commit clean branch tips for integration into the successor close-out PR;
   do not open separate component PRs.
5. Integrate each branch into `codex/es6-conformance-closeout`, rerun its exact
   pins and controls plus repository gates, then repeat both complete 11,704-row
   lanes. Continue until both authoritative reports contain zero non-passing
   rows.

## Suggested measurement commands

Use the repository's configured Node/pnpm path, then create a temporary filter
outside the repository. The run environment must include:

```text
TEST262_WORKERS=5
COMPILER_POOL_SIZE=5
VITEST_FORK_MAX_OLD_SPACE_SIZE=3072
TEST262_PATH_FILTER_FILE=<absolute path to the verified 11,704-row filter>
TEST262_TARGET=gc               # first lane
TEST262_TARGET=standalone       # second lane
pnpm run test:262 -- --official-scope-only
```

The runner holds a global Test262 lock, so the two complete lanes run
sequentially. Do not substitute the legacy runner or infer full-bucket results
from focused tests.

## Acceptance

- Fresh host report: 11,704/11,704 pass, 0 fail, 0 compile error, 0 skip.
- Fresh standalone report: 11,704/11,704 pass, 0 fail, 0 compile error, 0 skip.
- Every implementation cluster has an issue plan and exact regression tests.
- The successor close-out PR is green and remains the sole active upstream ES6
  implementation PR, with `loopdive/js2:main` as its base.

## Handoff

Do not mark this issue or the ES6 conformance goal done until both complete
reports satisfy the denominators above. The immediate next action is to update
the detached measurement worktree to the latest PR head, link `test262`, create
and validate the exact filter, and start the host lane.

### Measurement checkpoint — 2026-08-26

The detached worktree was updated to PR head `0a2003bcf`. Because a symlink at
the gitlink root makes `git status` reject the submodule path, the working
layout uses a physical `test262/` directory with `test262/test` and
`test262/harness` symlinked to `/Users/thomas/Code/js2/test262`.

Two filter spellings were explicitly tested:

- 11,704 bare edition-map keys: invalid for this runner; all 16 local shards
  registered zero suites. Run `20260826-024040` produced no result rows and is
  not conformance evidence.
- 11,704 distinct `test/`-prefixed keys: valid. All paths exist, and the
  positive control
  `test/language/statements/for-of/generator-close-via-break.js` registered and
  passed 1/1 under the authoritative host runner (run `20260826-024241`).

The complete host sweep then started as run `20260826-024316` with
`TEST262_WORKERS=2`, `COMPILER_POOL_SIZE=2`, `TEST262_TARGET=gc`,
`TEST262_PUBLISH_HISTORY=0`, and the corrected file
`/private/tmp/js2-es2015-11704-runner-paths.txt`. It was stopped gracefully on
user wrap-up before the first 732-row weighted shard completed. The preserved
partial report contains 457/11,704 rows:

```text
367 pass
85 fail
2 compile_error
3 compile_timeout
0 skip
```

This is explicitly an interrupted partial sample, not a pass-rate baseline and
not a complete residual inventory. The partial artifacts are:

```text
/private/tmp/js2-es6-authoritative-measure/benchmarks/results/test262-report-20260826-024316.json
/private/tmp/js2-es6-authoritative-measure/benchmarks/results/test262-results-20260826-024316.jsonl
```

Resume by rerunning the same complete host command from the measurement
worktree; do not append to or infer from the interrupted report. After the host
lane completes, run the standalone lane sequentially, solo-confirm every
non-pass, then allocate issue-backed Luna/max worktrees by semantic cluster.

### Successor close-out checkpoint — 2026-08-26

PR #4974 is merged. Its former head `dc5619b62` is an ancestor of current
upstream `main` (`16dd8ad48`), so the old branch has no diff and cannot back a
new PR. A successor integration worktree was created at
`/private/tmp/js2-es6-conformance-closeout` on branch
`codex/es6-conformance-closeout`, based on that current upstream head.
Draft PR #5008 carries this branch against `loopdive/js2:main`; all further
measurement and implementation checkpoints are pushed there.

A current-branch host measurement had started at `dc5619b62` before the newer
upstream head was discovered. It was stopped gracefully because completing an
obsolete-head denominator would not prove current conformance. Run
`20260826-174658` preserved 2,363 partial rows:

```text
1,882 pass
457 fail
14 compile_error
10 compile_timeout
0 skip
```

Those artifacts remain in
`/private/tmp/js2-es6-authoritative-measure2/benchmarks/results/`; they are a
diagnostic checkpoint only and must not be treated as the current baseline.
The immediate next measurement must start from `16dd8ad48` or the newer
successor PR head, regenerate and validate the 11,704-row `test/`-prefixed
filter, and complete all rows without interruption.

### Complete host baseline — 2026-08-26

The first uninterrupted exact-bucket host measurement completed at successor
draft PR head `39f279650` (run `20260826-180615`). The filter
`/private/tmp/js2-es2015-11704-pr5008.txt` contained 11,704 distinct
`test/`-prefixed paths, all of which existed, and all 16 maintained-runner
shards completed. The exact report summary is:

```text
9,435 pass
2,163 fail
59 compile_error
46 compile_timeout
1 skip
11,704 total
```

This is the complete current host baseline, not acceptance evidence: 2,269
rows remain non-passing and every one must be rerun alone before attribution.
The lone skip is the runner's unsupported compiler-hang classification and is
also a required close-out item. Artifacts are preserved at:

```text
/private/tmp/js2-es6-authoritative-measure3/benchmarks/results/test262-report-20260826-180615.json
/private/tmp/js2-es6-authoritative-measure3/benchmarks/results/test262-results-20260826-180615.jsonl
```

The measurement used `TEST262_WORKERS=5`, `COMPILER_POOL_SIZE=5`,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`, `TEST262_TARGET=gc`,
`TEST262_REPORTER=dot`, and `TEST262_PUBLISH_HISTORY=0`. The host checkpoint was
committed and pushed. PR #5008 subsequently auto-merged at `39f279650`;
successor draft PR #5010 now carries the continuing checkpoints.

### Complete standalone baseline — 2026-08-26

The first uninterrupted exact-bucket standalone measurement completed at exact
code head `0bed210fd` (run `20260826-194014`). It used the same verified
11,704-row filter and all 16 maintained-runner shards completed. The exact
report summary is:

```text
8,402 pass
2,728 fail
571 compile_error
2 compile_timeout
1 skip
11,704 total
```

This is the complete standalone baseline, not acceptance evidence: 3,302 rows
remain non-passing. The two compile timeouts are
`TypedArray/prototype/byteOffset/detached-buffer.js` and
`TypedArray/prototype/Symbol.toStringTag/detached-buffer.js`; the skip is
`language/statements/for-of/body-put-error.js`. All three require fresh solo
confirmation. Artifacts are preserved at:

```text
/private/tmp/js2-es6-authoritative-measure4/benchmarks/results/test262-standalone-report-20260826-194014.json
/private/tmp/js2-es6-authoritative-measure4/benchmarks/results/test262-standalone-results-20260826-194014.jsonl
```

The run used `TEST262_WORKERS=5`, `COMPILER_POOL_SIZE=5`,
`VITEST_FORK_MAX_OLD_SPACE_SIZE=3072`, `TEST262_TARGET=standalone`,
`TEST262_REPORTER=dot`, and `TEST262_PUBLISH_HISTORY=0`. The isolated QuickJS
artifact at `/private/tmp/js2-quickjs-artifact-2e2d7736713beeda` was built from
the pinned submodule using Homebrew LLVM 18 (`clang-18`, `llvm-ar`,
`llvm-ranlib`, and `llvm-nm`) and verified by the standalone provider before
the run.

Draft PR #5010 currently includes issue #4760 checkpoint `01eae69d7` (four
host Promise reaction thenable regressions fixed) and issue #4759 checkpoint
`1c1ba7574` (module-namespace self-import binding linked in both lanes). Issues
#4758, #4759, #4760, and #4761 retain exact dispositions and follow-up work.
