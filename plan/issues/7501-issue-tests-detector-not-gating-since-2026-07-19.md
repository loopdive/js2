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

1. **PR #7451:** the detector workflow (`issue-tests.yml`, shard job) runs
   the gate's parallel pass with 2 forks and 50 files per vitest invocation,
   instead of `availableParallelism() - 1` forks (3 on the 4-vCPU runner) and
   150 files. `scripts/known-failures-gate.mjs` gains
   `KNOWN_FAILURES_MAX_FORKS`, which it passes to the child vitest as
   `VITEST_MAX_FORKS`. Checked against `vitest.config.ts`: `maxForks`
   resolves to 3 without it on a 4-core box and to 2 with it.
   - The script's defaults are unchanged, so the PR-time `issue-tests-shard`
     job in `ci.yml` (8 shards, 100-minute limit) is unaffected.
   - The cause is a hypothesis, not a measurement: CPU contention. Several
     tests (`issue-4485`, `issue-4621`, `es5-standalone-harness-selftests`)
     instead attribute `onTaskUpdate` timeouts to a worker's own event loop
     being blocked by a long synchronous compile. Fewer forks helps under
     either explanation; smaller batches help only under the first.
   - The PR's own `issue-tests` run is the measurement, against run
     45760154331.
   - Known gap: a set `VITEST_MAX_FORKS` overrides the config's RAM guard
     (`forksByRam`) instead of capping it. That is harmless on a 16 GB runner
     at 2 forks.
2. **PR #7450:** `tests/issue-1151-gap-b.test.ts` observes the JS-side
   rejection.
3. **Remaining:**
   - `tests/issue-2701.test.ts`: JS host only; it needs either a fix in the
     host adapter boundary or a decision for the sunsetting JS-host lane;
   - the `ECONNREFUSED` source;
   - whatever unattributed errors the first post-#7451 run on main still
     shows.

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
