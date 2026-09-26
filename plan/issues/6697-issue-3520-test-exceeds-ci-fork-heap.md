---
id: 6697
title: "tests/issue-3520-closure-host-bridge-abi.test.ts exceeds the 512 MB CI fork heap"
status: done
completed: 2026-09-26
created: 2026-09-26
updated: 2026-09-26
assignee: ttraenkler/opus-6686
priority: high
horizon: s
task_type: bug
area: testing
goal: architecture
sprint: current
parent: 5385
related: [3520, 5385, 6686]
---

# #6697 — issue-3520 test exceeds the CI fork heap

## Problem

PR #6153 (#6686) was auto-parked: in its `merge_group`, the required
`issue-tests` job died with `FATAL ERROR: Ineffective mark-compacts near heap
limit … JavaScript heap out of memory`. That job runs the pinned issue tests
in ONE fork at the default 512 MB heap
(`--pool=forks --poolOptions.forks.singleFork=true`).

Measured 2026-09-26, each of the 16 pinned files alone at that config:
only `tests/issue-3520-closure-host-bridge-abi.test.ts` runs out of memory.
With a 2 GB heap and `--logHeapUsage` it reads about **413 MB right after the
file loads**, **596 MB at test 3** ("strips compiler constructor-closure
exports in standalone and WASI…"), peaking around **810 MB**.

The failure was **already on main before #6686**. With the compiler source at
`8aba4aa6d8` (main just before #6686) the file still OOMs at 512 MB, and its
per-test heap profile matches the post-#6686 one within GC noise. It only
surfaces when a PR pulls the file into the pinned set by touching
`src/codegen/closure-exports.ts` or `src/codegen/expressions/calls.ts`.

## Cause

Every standalone/WASI `compile()` in the file (12 of them, across three
tests) loads the host-free lib set into the fork on top of the gc one. With
the ~413 MB the file already holds after loading the compiler under Vitest,
that pushes live heap past 512 MB.

## Fix

The standalone/WASI compiles now run out of process through
`tests/fixtures/issue-3520-compile-probe.mts` (explicit 2 GB heap; same
pattern as #1712 / `tests/fixtures/issue-6687-regime-probe.mts`). The test
instantiates the returned binaries in-process. Every assertion is unchanged;
only where the `compile()` result comes from changed (`compileHostFreePairs`).

Not moved: the five-file corpus census and the gc `default`/`always`
compiles. After the change the whole file peaks at about 502 MB heap-used at
512 MB and passes, so moving them was not needed to fit. Note the headroom
is thin, and it is set by the file's load cost rather than by any test:
under Vitest, loading the compiler alone takes about 414 MB, and the file
cannot start at a 448 MB heap.

## Test Results (2026-09-26)

- The 16-file pinned list at the CI config (single fork, default 512 MB
  heap): **16/16 files, 276 passed / 2 skipped**. Before the fix it OOMed.
- `tests/issue-3520-closure-host-bridge-abi.test.ts` at the default heap:
  20/20, both in the single-fork CI config and as a plain `vitest run`.
