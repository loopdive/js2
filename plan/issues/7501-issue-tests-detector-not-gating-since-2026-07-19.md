---
id: 7501
title: "Post-merge issue-tests detector not gating since 2026-07-19"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ci
goal: core-semantics
related: [3008, 7014, 6783, 7497]
---

# #7501: the post-merge issue-tests detector has not gated since 2026-07-19

## What the detector is for

`.github/workflows/issue-tests.yml` (#3008) runs every root `tests/*.test.ts`
file after each merge to main, in 12 shards. It gates the result against the
known-failures baseline in `loopdive/js2wasm-baselines`
(`issue-tests-baseline.json`). A merge that breaks a previously green root test
is meant to turn main red within one run.

## History

- **2026-07-19: last green run on main**, run 29689686622.
- **2026-07-19 to 2026-10-16: the shards crashed.** One vitest fork per shard
  ran out of heap at 1 GB ("Ineffective mark-compacts", then
  `ERR_IPC_CHANNEL_CLOSED`). No partial report was written, so the `gate` job,
  which needs every shard, never ran. #7014 (82e59cfc39, 3f7f4fd150) fixed
  this with a crash-safe per-file runner.
- **2026-10-16 to now: every completed run refuses at the integrity step.**
  The shards finish, but `scripts/issue-tests-gate.mjs` exits 2 with
  `issue-tests run integrity failed` before it diffs anything against the
  baseline. The refusal is by design: vitest reported errors the gate cannot
  attribute to a test file, and an unattributed error must not be banked as a
  known failure. Run 45760154331 (main@76c8adf, 2026-11-26) had 13 of them:

  | errors | cause |
  |---|---|
  | 9 | `[vitest-worker]: Timeout calling "onTaskUpdate"` (shards 2, 4, 6, 8, 9) |
  | 2 | `tests/issue-2701.test.ts`: the JS-host `node:fs` adapter receives a native string struct as its path |
  | 1 | `tests/issue-1151-gap-b.test.ts`: an unhandled rejection on the JS reference side |
  | 1 | `ECONNREFUSED`, source not yet identified |

  The 2026-11-22 to 2026-11-26 runs on main fail the same way, for example
  45657701600, 45706128642 and 45749719348. Runs in between were mostly
  cancelled by the workflow's latest-wins concurrency.

## Impact

- **About 4,287 failing root tests in 1,280 of 4,872 files went unnoticed**
  (`plan/log/root-test-triage-2026-11-26.md`). Only 1,403 of them are in the
  baseline; the baseline cannot ratchet while every run refuses.
- **PRs pay for it.** The required `quality` check runs every root test file
  that a PR adds or modifies (`Changed root test files must pass (#3008)`). So
  each red file blocks any PR that touches it, for a reason that PR did not
  cause. PR #7439 was blocked this way.
- **Real regressions hid among stale tests.** #7497 is an example: a standalone
  wide-BigInt `String()` regression from 2026-09-27 that sat red for two
  months.

## Fix chain

1. **Measured and rejected: fewer forks, smaller batches (PR #7451's first
   version).** Hypothesis: CPU contention. Three forks per 150-file vitest
   invocation on the 4-vCPU runner would starve the main process, so the
   worker RPC times out. #7451 ran the detector with 2 forks and 50-file
   batches. Its `issue-tests` run 45806551748, against run 45760154331 on main
   (partial; shards 3, 5 and 6 had finished when this was written):

   | shard | integrity errors before → after | runtime before → after |
   |---|---|---|
   | 3 | 1 → 1 (`AggregateError`/`ECONNREFUSED`; fixed by #7504) | 21.5 → 20.8 min |
   | 5 | 0 → 0 | 24.7 → 24.3 min |
   | 6 | 2 → 2 (`onTaskUpdate` timeouts) | 23.7 → 35.0 min |

   The timeouts did not move, and shard 6 got 48 % slower, so the hypothesis
   is refuted. The `issue-tests.yml` settings and the
   `KNOWN_FAILURES_MAX_FORKS` knob were reverted forward; #7451 carries only
   this file.

   What the timeouts are instead: a worker that stays blocked for more than
   birpc's 60 s RPC timeout after sending a task update. A 65 s synchronous
   stretch in one test file reproduces exactly
   `[vitest-worker]: Timeout calling "onTaskUpdate"`, at any fork count. The
   per-shard counts are stable across runs, which points at specific files.
2. **PR #7450:** `tests/issue-1151-gap-b.test.ts` observes the JS-side
   rejection.
3. **PR #7461 (#7504):** `node:` builtin arguments get host values for native
   strings. This removes the unhandled errors of `tests/issue-2701.test.ts`
   (2) and `tests/issue-1795.test.ts` (1, the `ECONNREFUSED`).
4. **PR #7455:** the reporter names the file behind a worker-caught unhandled
   error (`[raised while running <file>]`).
5. **PR #7470 (#7509):** an error scheduled after a file's last hook is
   refused, not lost.
6. **PR #7478 (#7518):** batch bisection names the file behind untagged run
   errors, including the `onTaskUpdate` timeouts, within a 900 s budget per
   call.
7. **Remaining:** fix the files #7478's bisection names in the first detector
   run on main after it lands.

   Then a first green gate run seeds and ratchets the baseline. From that run
   on, new failures go red.

The gate itself stays as strict as it is: it refuses every error it cannot
attribute to a file.

## Process lesson

A gate that refuses every run reports the same as a gate that is not wired up.
The workflow is post-merge and not a required check, and nobody was alerted for
four months. Proposed:

- **Staleness alert.** A scheduled check fails loudly, and files or updates an
  issue, when the last green `issue-tests` gate run on main is older than N
  days (suggested N = 3). Watched workflow: `issue-tests.yml`, job `gate`.
- **Name the refusal in the run summary.** "integrity refusal, N unattributed
  errors" should read differently from "N new failures", so a reader sees that
  the gate measured nothing.
- **Count consecutive refusals.** After K consecutive refusals on main, the
  detector should report as a CI incident, not as an ordinary red run.

## Acceptance criteria

- One full `issue-tests` run on main finishes the gate step without an
  integrity refusal. The baseline is then seeded or ratcheted from a real
  measurement.
- No gate rule is loosened: unattributed errors are still refused.
- The staleness alert, or an equivalent signal, exists and has its own issue.
