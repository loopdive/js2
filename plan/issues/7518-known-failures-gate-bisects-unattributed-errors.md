---
id: 7518
title: "known-failures gate names the file behind an unattributed run error by bisecting its batch"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ci
goal: core-semantics
related: [7501, 7509, 7014]
---

# #7518: the known-failures gate bisects a batch to name the file behind an unattributed run error

## Problem

The post-merge `issue-tests` gate refuses every run error it cannot attribute
to a file (#7501). Nine of the 13 refusals in run 45760154331 were
`[vitest-worker]: Timeout calling "onTaskUpdate"`. vitest 3.2.7 never tags that
error with a file: birpc rejects the RPC promise inside the runner, and the
rejection reaches the main process bare. PR #7455's reporter tag cannot name
it. Nothing names the file to fix.

## Fix

`scripts/known-failures-gate.mjs`, `bisectUntaggedErrors` /
`locateErrorFiles`: after a parallel-pass batch, the gate re-runs the batch in
halves, recursing into the halves whose run raises one of the batch's untagged
errors, until each error reproduces in a single-file run.

- **Per-error labels.** Errors are matched by their first line, so two
  different errors in one batch are traced to their own files instead of one
  batch-wide list stamped on every error. RV7455 reproduced that defect in the
  first attempt, 39d377a8f7. Errors that share a first line cannot be told
  apart: two RPC timeouts share their whole stack. Their label lists every
  file the first line reproduced in, and says it is shared.
- **Hard time budget.** One budget per `runFiles` call
  (`KNOWN_FAILURES_BISECT_BUDGET_S`, default 900 s). It counts only time
  spent in bisection runs, so the batches' own vitest runs between bisections
  do not use it. RV7478 found that a wall-clock deadline, even one started at
  the first bisection, left later batches nothing. Each bisection run's timeout
  is capped at what is left. When the budget is spent, including by a run that
  timed out on it, the label says so. Naming files can never cost a shard its
  partial.
- **Skipped:**
  - errors the reporter already tagged (`[raised while running <file>]`);
  - batches that hit their own timeout, because each half would wait out the
    timeout again.
- **Logged:** one line per bisection run (files, errors reproduced, seconds).
- **Unchanged:** every error is still refused. The label is display text
  only.

Labels:

- `(#7518 bisection: reproduces alone in: <file>)`
- `(#7518 bisection: reproduces alone in: <file>, <file> (same first line, not told apart))`
- `(#7518 bisection: not reproduced in a smaller run)`
- `(#7518 bisection: budget spent before it was located)`

## Evidence

**Real repro, not synthetic.** Four test files run through `runFiles`. One
of them, `c.test.js`, busy-waits 65 s synchronously, which stands in for a slow
compile. Output:

```
known-failures-gate: repro bisection: 2 file(s), 0 of 1 error(s) reproduced, 1s
known-failures-gate: repro bisection: 2 file(s), 1 of 1 error(s) reproduced, 66s
known-failures-gate: repro bisection: 1 file(s), 1 of 1 error(s) reproduced, 66s
known-failures-gate: repro bisection: 1 file(s), 0 of 1 error(s) reproduced, 1s
Error: [vitest-worker]: Timeout calling "onTaskUpdate"
    (#7518 bisection: reproduces alone in: c.test.js)
```

This also settles the timeout's cause: a worker blocked past birpc's 60 s RPC
timeout raises it, without any main-process load.

**Pins** (`tests/issue-7014-integrity.test.ts`):

- two different errors in one batch, each labelled with its own file;
- only the batch's own errors are followed, not new ones a smaller run raises;
- errors that share a first line get the shared label;
- a spent budget makes no runs and says so;
- only time spent bisecting counts, so a later batch still bisects (two
  calls sharing a 2 s budget, 2.5 s apart);
- every bisection run's timeout is capped at the time left;
- a last run that timed out on the budget is reported as a spent budget;
- tagged errors and timed-out batches are skipped;
- end to end through real vitest: a leaking file among three clean ones. The
  leak is tagged by the reporter, and the run's untagged `vitest exited 1`
  record is located to the leaking file.

Mutations checked, each failing at least one pin:
- following every error a smaller run raises (`.filter(() => true)`);
- removing the timeout cap;
- dropping "timed out on the budget → budget spent";
- a wall-clock deadline instead of spent time;
- not adding each run's time to the spent budget.

## Known limits

- **No retry on a load-dependent miss.** An error that needs the whole batch's
  load and does not reproduce in a smaller run is labelled "not reproduced in a
  smaller run", and its file stays unnamed. Flaky runs cause misses, not wrong
  blame.
- **Generic synthetic keys.** The gate's own records, such as `vitest exited 1
  after all selected files finished without an attributable exit`, have the
  same first line whatever the cause. They match any file that exits 1 without
  a failed test. The end-to-end pin relies on that key.
- **Serial re-runs are not bisected.** Untagged errors from the serial re-run
  loop (crashed files, one at a time) are still refused without a label.

## Cost

Bisection runs only for a batch that ends with an untagged run error. It
re-runs about `2·log2(batch)` subsets, bounded by the budget. On the real
repro it took 134 s on top of one 65 s run.

## Acceptance criteria

- Every untagged run error of a parallel-pass batch carries one of the three
  labels.
- No bisection run starts once the budget is spent, and each run's timeout is capped
  at the time left.
- The gate's integrity rule is unchanged: every unattributed error is refused.
