---
id: 4413
title: "The unit suite runs strictly serially — maxForks=1 with no describe.concurrent to compensate"
status: done
sprint: 78
created: 2026-08-14
updated: 2026-08-18
completed: 2026-08-14
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: performance
area: ci
goal: velocity
---

## Problem

`vitest.config.ts` pinned `poolOptions.forks.maxForks = 1`, commented as

> Each test file gets its own fork process … (same strategy as the test262
> chunk runner). maxForks=1 ensures only one fork at a time (no parallel OOM).

That reads the test262 runner backwards. test262's throughput does **not**
come from forks — it comes from `describe.concurrent` plus a CompilerPool of
worker processes running *inside* a single fork, which is exactly what the
neighbouring `maxConcurrency: 32` is for.

The unit suite inherited the one-fork restriction **without** the compensating
mechanism. Measured: **0 of 2,928** files under `tests/` use
`describe.concurrent` or `it.concurrent`, so `maxConcurrency: 32` does nothing
for any of them. The suite therefore ran strictly serially — one file at a
time, one test at a time — using ~25 % of a 4-core box.

## Measurements

24 representative files (`tests/issue-30xx*.test.ts`), 164 tests, on 4 cores /
16 GB. **Identical results at every setting** (155 passed / 9 failed), so this
is pure scheduling, not flakiness:

| `maxForks` | wall   | speedup | peak RAM        |
| ---------- | ------ | ------- | --------------- |
| 1          | 229 s  | 1.00x   | —               |
| 3          | 117 s  | 1.96x   | —               |
| 4          | 110 s  | 2.08x   | —               |
| 8          | 116 s  | 1.97x   | 5.7 GB of 16 GB |

Two things fall out:

- **The OOM concern does not hold at these fork counts.** Eight concurrent
  forks peaked at 5.7 GB of 16 GB, with `--max-old-space-size=512` per fork
  (CI raises it to 1024).
- **Past 4 there is nothing to win** on a 4-core box; 8 is marginally slower
  than 4 from context-switching.

## Fix

`maxForks` is now derived:

```ts
const isTest262Run = Boolean(process.env.TEST262_TARGET || process.env.TEST262_RESULT_PREFIX);
const maxForks = isTest262Run ? 1 : Math.max(1, Number(process.env.VITEST_MAX_FORKS) || availableParallelism() - 1);
```

`parallelism - 1` leaves a core for the editor/agent; `VITEST_MAX_FORKS`
overrides for constrained environments.

**test262 runs stay pinned to 1, and that half of the original reasoning IS
load-bearing.** `run-test262-vitest.sh` hands vitest 16 shard files, each of
which spins up its own CompilerPool. Three shard files at once would put ~9
compiler workers on 4 cores — oversubscribed, and the memory profile the
single-fork rule was genuinely protecting. The carve-out keys off the env vars
that runner already exports.

## Acceptance criteria

- [x] The unit suite parallelises across files by default.
- [x] test262 runs still use exactly one fork.
- [x] `VITEST_MAX_FORKS` overrides the default.
- [x] Results unchanged — same pass/fail set at 1, 3, 4 and 8 forks.

## Follow-up (not done here)

The bigger remaining lever is **intra-file** concurrency: with 0 of 2,928
files using `describe.concurrent`, every test within a file still runs
sequentially even though `maxConcurrency: 32` is already configured and the
CompilerPool can absorb the load. Compile-and-assert tests are largely
independent, so converting the heaviest files is likely worth more than the
2x won here. Wants its own issue and a per-file audit — some tests share
module-level state and would need isolating first.

Also unrelated but observed while measuring: `tests/issue-3009.test.ts`,
`tests/issue-3014.test.ts`, `tests/issue-3000-c.test.ts` and
`tests/issue-3017-function-poison-pill.test.ts` fail on `origin/main` today
(9 tests). Pre-existing, not caused by this change — verified by running them
in a clean worktree at `origin/main`.
