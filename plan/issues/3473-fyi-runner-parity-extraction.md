---
id: 3473
title: Extract fyi-runner parity plumbing from stale #3415
status: done
sprint: 73
priority: medium
horizon: m
assignee: ttraenkler/extract-3415-agent
---

## Problem

PR #3420 adopted the runner remainder from stale PR #3415, but its head mixed
that plumbing with compiler/runtime fixes and was no longer mergeable with
current `main`. At adoption time the head was 52 commits behind and three
commits ahead of `origin/main`; the overlapping edits in
`scripts/test262-worker.mjs`, `src/codegen/typeof-delete.ts`, and
`src/runtime.ts` made GitHub report `DIRTY`.

The PR's `quality` job reached the issue-link checker and failed on four
nonexistent issue-file paths. IDs 3468 through 3471 had been reused for other
issues, so this document now records the supersession without naming paths
that do not exist.

## Current-main extraction

The merge-forward keeps only shared-runner work that is still absent from
current `main`:

- `scripts/run-test262-fyi.mjs` sends the literal test262.fyi-assembled source
  through the canonical `scripts/test262-worker.mjs` execution and verdict
  path. It adds bounded source-worker parallelism, per-source timeout and
  recycle handling, deterministic result ordering, an explicit path-list
  input, and revision/runtime metadata in JSON reports.
- `scripts/compiler-pool.ts` and the FYI worker client pin child-process time
  zone semantics to UTC while retaining `TEST262_TZ` as a diagnostic override.
- `scripts/test262-worker.mjs` extends the realm canary to nested
  `Array.prototype[Symbol.unscopables]`, RegExp string iterators, distinct
  generator/async-generator instance and shared prototypes, and the runtime
  intrinsic objects exposed through import getters. These additions are
  combined with current main's shared sandbox-global list from #3441.
- `tests/test262-fyi-runner.test.ts` covers shared-worker verdicts, async
  completion, strict rerun isolation, nested-intrinsic recycling, path/worker
  arguments, and UTC child semantics.

## Explicit boundaries

- Current-main versions of all compiler/codegen/runtime files from the stale
  bundle win. This includes declaration inference, iterator-helper lowering,
  destructuring, delete throws, generator result reads, and JS-host runtime
  support that landed through independent PRs. No such file remains in the
  #3473 diff.
- Existing async-completion support in the shared worker remains untouched;
  the duplicate #3416-era copy from the stale bundle is not reintroduced.
- The abandoned issue documents for the original sub-slices are not recreated.
- Module-goal classification belongs to #3489. The FYI client deliberately
  does not infer or send `inferModuleStrictArguments` in this extraction.
- Node runtime preflight belongs to #3490. Runtime metadata is descriptive and
  does not enforce a Node version here.
- Circular `_FIXTURE` module graphs belong to #3491. That follow-up should
  extend the `FyiSourceExecutor` to shared-worker IPC boundary with fixture
  graph data while preserving this extraction's timeout, recycle, and verdict
  behavior.

## Validation

- Focused FYI-runner tests.
- TypeScript, Biome lint, and Prettier checks for touched code.
- Issue-link, hard-error, and coercion-site quality sub-gates.
- Final diff against `origin/main` limited to this plan and the four assigned
  runner-plumbing files.

## Completion

The current-main extraction is integrated with #3489–#3496. The authoritative
historical gap rerun completes at 970/970 in `gc` and 3,471/3,472 in
standalone; the sole remaining row is the explicit #3494 dynamic-module
capability boundary rather than a shared-worker parity failure.
