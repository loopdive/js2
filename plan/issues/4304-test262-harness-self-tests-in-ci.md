---
id: 4304
title: "Include Test262 harness self-tests in the canonical CI census"
status: in-review
created: 2026-08-09
updated: 2026-08-09
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: testing
language_feature: test262-harness
goal: test-infrastructure
assignee: codex/root
related: [3370, 4251]
files:
  - tests/test262-runner.ts
  - tests/issue-4304-test262-harness-category.test.ts
  - plan/issues/4304-test262-harness-self-tests-in-ci.md
---

# #4304 — include Test262 harness self-tests in CI

## Problem

The Test262 commit pinned by `origin/main` (`b363f29d3c43`) contains **116**
JavaScript self-tests under `test/harness`, including:

- `test/harness/assert-samevalue-nan.js`
- `test/harness/propertyhelper-verifywritable-not-writable.js`
- `test/harness/asyncHelpers-throwsAsync-primitive.js`

The canonical discovery list in `tests/test262-runner.ts` does not contain the
`harness` category. Consequently the local runner, precompiler, linked-harness
inventory, baseline validator, and both GC and standalone sharded CI lanes
discover **0/116** of these tests. Harness helper files are exercised indirectly
by other tests, but that does not prove the upstream harness self-test corpus is
covered.

## Root cause

`TEST_CATEGORIES` is the shared source of discovery for all maintained Test262
execution paths. It lists language, built-in, internationalization, staging,
and Annex B categories, but omits the top-level `harness` directory. The CI
shards iterate this same list in `runTest262Chunk`, so the omission affects both
local measurement and CI rather than only one runner.

## Acceptance criteria

- [x] `TEST_CATEGORIES` includes `harness`.
- [x] Discovery returns every JavaScript test under `test262/test/harness`, with
      a non-vacuous floor of 116 files at the pinned Test262 commit.
- [x] A scoped canonical run records exactly 116 unique harness rows in GC.
- [x] A scoped canonical run records exactly 116 unique harness rows in
      standalone.
- [x] The sharded CI runner consumes the same category list, so merge-group and
      baseline-promotion runs include these rows without a separate workflow
      path.
- [x] Observed failures are reported by lane and dominant signature; adding
      coverage does not turn failures into silent skips or synthetic passes.

## Validation plan

- `pnpm exec vitest run tests/issue-4304-test262-harness-category.test.ts --reporter=dot`
- `TEST262_TARGET=gc TEST262_PATH_FILTER="test/harness/" TEST262_WORKERS=4 pnpm run test:262 -- --official-scope-only`
- `TEST262_TARGET=standalone TEST262_PATH_FILTER="test/harness/" TEST262_WORKERS=4 pnpm run test:262 -- --official-scope-only`
- `pnpm run typecheck`
- `pnpm run check:ir-fallbacks`

## Test Results

Measured on compiler `b97e49a1dd80` with the pinned Test262 commit
`b363f29d3c43`. Both commands used the maintained sharded runner, the literal
upstream harness, `--official-scope-only`, and
`TEST262_PATH_FILTER="test/harness/"`.

| Lane | Pass | Fail | Compile error | Skip | Unique rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| GC | 52 | 64 | 0 | 0 | 116 |
| standalone | 62 | 53 | 1 | 0 | 116 |

The pass sets overlap on 29 files; 23 pass only in GC and 33 pass only in
standalone. The honest headline is therefore not “the harness passes,” but “all
116 harness self-tests are now measured.”

GC failure categories:

| Category | Count |
| --- | ---: |
| other | 49 |
| missing builtin | 10 |
| type error | 3 |
| runtime error | 1 |
| null dereference | 1 |

Standalone failure categories:

| Category | Count |
| --- | ---: |
| assertion failure | 30 |
| other | 11 |
| illegal cast | 6 |
| type error | 3 |
| null dereference | 3 |
| host-import compile refusal | 1 |

The dominant signatures agree with the detailed root-cause inventory in
#4251: exception-constructor identity, async `$DONE`/flag propagation,
`deepEqual` closure dispatch, symbol-keyed property helpers, descriptor restore,
TypedArray callbacks, realm creation, intrinsic reification, dynamic eval, and
Proxy traps. This issue owns admission of the cohort into the canonical census;
#4251 and the linked feature issues own the semantic repairs.

## Implementation Summary

Added the top-level `harness` directory to `TEST_CATEGORIES`, the single list
consumed by the local runner, precompiler, linked-harness inventory, baseline
tools, and `runTest262Chunk`. Both Test262 CI jobs invoke that chunk runner, so
the new category is automatically distributed across the ordinary 57-shard
matrix and the merge-group dynamic matrix.

Added a regression test that independently enumerates the upstream directory,
requires a floor of at least 116 files, and proves `findTestFiles("harness")`
returns the complete set. This fails loudly if the corpus is missing or if
future Test262 updates add files that discovery does not include.
