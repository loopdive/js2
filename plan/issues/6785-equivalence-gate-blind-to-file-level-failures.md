---
id: 6785
title: "ci: `equivalence-gate` (required) reads only `assertionResults` — a file that fails to import, a deleted test file, or a fork OOM has zero assertions and passes as 'no new regressions'"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: n/a
goal: ci-hardening
related: [4609, 6763, 6783]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — H17/H4"
---

# #6785 — the equivalence ratchet has no floor and no file-level check

## Problem

`scripts/equivalence-gate.mjs:79-92` iterates `report.testResults[].assertionResults`
and diffs failing test ids against `scripts/equivalence-baseline.json`
(22 `knownFailures`). It never reads a file's `status`, the report's
`numFailedTestSuites` / `success`, and has no lower bound on `passing.size`.

Simulated on 2026-09-30: a scratch equivalence file with a broken import
→ vitest JSON `numFailedTestSuites: 1, status: "failed", assertionResults: []`
→ gate prints `gate-visible failing tests: 0` → "✓ No new equivalence
regressions". The same holds for a deleted test file and for a fork OOM,
which the review hit: `npx vitest run tests/equivalence` with the default
config (`maxForks = availableParallelism() - 1`, 512 MB fork heap) died with
`FATAL ERROR: Reached heap limit` + `ERR_IPC_CHANNEL_CLOSED` after ~100 files.
Only the single-fork, 1 GB path inside the gate script completes (8 m 33 s,
1,720 passing / 22 known failing).

Also: CLAUDE.md names `tests/equivalence.test.ts` as "the main suite" and in
the run command; the file does not exist (`No test files found, exiting with
code 1`). The real suite is the directory `tests/equivalence/`.

## Correction

1. In the gate: fail when any `testResults[].status === "failed"` with an
   empty `assertionResults`, when `report.success === false` for a reason
   other than known-failure assertions, and when
   `passing.size < baselinePassingFloor` (store the floor next to
   `knownFailures`; `--update` raises it, never lowers it — same rule as the
   edition ratchet).
2. Record the number of files seen and fail if it drops below the committed
   count (a deleted file is a regression until the baseline is updated
   deliberately).
3. `vitest.config.ts`: derive `maxForks` from available RAM as well as cores,
   or raise `VITEST_FORK_MAX_OLD_SPACE_SIZE` default to 1024 — the 512 MB /
   3-fork default OOMs on a 4-core 16 GB box.
4. CLAUDE.md: replace `npm test -- tests/equivalence.test.ts` with
   `node scripts/equivalence-gate.mjs` and name the directory.

## Acceptance

- A test file with a syntax error in `tests/equivalence/` makes the gate exit
  non-zero with the file named.
- Deleting one equivalence file makes the gate exit non-zero until
  `--update` is run.
- `tests/equivalence-gate.test.ts` (new) drives the gate over fixture JSON
  reports for the three cases (assertion failure, file failure, count drop).
- CLAUDE.md run command works as written.
