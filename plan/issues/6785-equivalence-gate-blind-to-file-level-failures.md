---
id: 6785
title: "ci: `equivalence-gate` (required) reads only `assertionResults` — a file that fails to import, a deleted test file, or a fork OOM has zero assertions and passes as 'no new regressions'"
status: done
sprint: Backlog
assignee: "ttraenkler/claude-dev-6785"
branch: "claude/issue-6785-equivalence-gate-floor"
created: 2026-09-30
completed: 2026-10-01
updated: 2026-10-01
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

## Implementation Plan

1. `scripts/equivalence-gate.mjs` — split into pure, exported functions plus a
   `main()` that runs only when the file is executed (`realpath(argv[1])`
   guard), so the CLI is unchanged and the test can import the evaluation:
   - `summarizeReport(report)` — failing/passing ids as before, plus the set
     of files seen and `fileFailures`: a file vitest marks `failed` with no
     tests collected (import / syntax / collect error), with a file-level
     `message`, or with no failing test; and any file with tests still
     `pending` (the run ended under them). `report.success === false` with no
     failing test or file becomes an `unexplained` failure.
   - `evaluateGate(summary, baseline, { partial, diskFiles })` — per-test
     regressions (unchanged), file failures, and — for a whole-suite report
     only — `passing.size < passingFloor`, `files.size < fileCount`, any test
     file on disk absent from the report, and any missing shard partial. A
     baseline without the two numbers fails closed.
   - `bankBaseline(summary, previous)` — `--update` raises `passingFloor` /
     `fileCount` to the run's numbers, never lowers them, and refuses (writes
     nothing, exit 1) a run below either floor or with a file-level failure.
     `--update` also refuses a `SHARD` run and an incomplete set of shard
     partials.
   - `toPartial` / `fromPartial` / `mergeSummaries` — the shard partial now
     carries `shard`, `files`, `fileFailures`, `unexplained`.
2. Sharded CI (`.github/workflows/ci.yml`) — chose **sum the shard reports in
   the `equivalence-gate` job**, not a committed per-shard split: vitest's
   `--shard` assigns files by a hash of the path, so every added test file
   reshuffles the split and a committed per-shard floor would go stale on
   unrelated PRs. Each `equivalence-shard` cell still gates its own per-test
   and per-file failures (`SHARD` set ⇒ partial scope, no floor), writes
   `PARTIAL_OUT`, and uploads it; `equivalence-gate` checks the matrix result,
   sparse-checks-out the script + baseline + `tests/equivalence/`, downloads
   the eight partials, and runs the gate in `MERGE_PARTIALS_DIR` mode, which
   applies the floor and file count to the sum.
3. `vitest.config.ts` — default fork heap 512 → 1024 MB (what the gate already
   used), and `maxForks = min(cores − 1, freemem / (1.5 × heap))`; test262
   runs stay at 1 fork.
4. `CLAUDE.md` — the run command and Project Structure line now name
   `node scripts/equivalence-gate.mjs` and the `tests/equivalence/` directory.
5. `tests/equivalence-gate.test.ts` (new) — fixture reports for every failure
   class plus the clean control; `tests/issue-4609-…` now marks its one-test
   synthetic partial as a single shard (`SHARD=1/8`), since the merged scope
   would otherwise trip the floor before the membership check it pins.

## Resolution

**Banked floor** (`node scripts/equivalence-gate.mjs --update`, single fork,
1 GB fork heap, this branch = origin/main @ 4a860ee9 + #6785): 223 files,
1,740 passing, 22 failing, 3 todo. The 22 failures are exactly the existing
`knownFailures` (unchanged); `passingFloor: 1740`, `fileCount: 223`. A
second full `node scripts/equivalence-gate.mjs` against the banked baseline
exits 0 (223 files, 1,740 passing). A later merge of main added
`await-settled-operand-yields.test.ts` (2 tests, both pass). That puts the
suite at 224 files / 1,742 passing, so the banked numbers are a lower bound,
and the next `--update` raises them.

**Before → after** (old gate = `origin/main:scripts/equivalence-gate.mjs`, both
fed the same data through `MERGE_PARTIALS_DIR`):

| Input | Old gate | New gate |
| --- | --- | --- |
| Real vitest report: a broken import, a syntax error, a collect-time throw (3 probe files, scored as shard 1/8) | exit 0, "No new equivalence regressions" | exit 1, 3 × `FILE FAILURE: <file> — no tests collected: <error>` |
| Real full run with `typeof-extended.test.ts` removed from the report | exit 0, "No new equivalence regressions" | exit 1, `FILE FAILURE … absent from the report`, `FLOOR: 1733 < 1740`, `FLOOR: 222 files < 223` |
| Real full run, unmodified | exit 0 | exit 0 |

**Tests:** `tests/equivalence-gate.test.ts` (new, 16 cases): assertion failure
vs known list, import / syntax / file-level / unfinished-test failures,
unexplained `success:false`, passing-count drop, file-count drop, on-disk file
missing from the report, baseline without floors fails closed, single shard
skips the floor, merged JSON partials meet it, missing shard partial fails,
`--update` raises and never lowers, and two CLI runs (exit codes + messages).
`tests/issue-4609-…` passes with its synthetic partial scored as one shard.

**Known limit, deliberately left:** vitest's JSON report has no per-`describe`
result, so an `afterAll` error inside a `describe` of a file that ALSO has a
failing test is only visible as that file's failure. If the failing test is a
known one, the hook error stays masked. A hook error in a file with no failing
test, or at file level, is caught.

**`vitest.config.ts`:** the default fork heap is now 1024 MB, the same as the
gate. `maxForks` is capped by `freemem / 1.5 GB`, which leaves 3 forks on an
idle 4-core / 16 GB box. I did not re-measure the OOM repro: my
default-config `npx vitest run tests/equivalence` was killed when the
container restarted under other agents' load, so whether the 3-fork default
now completes is not verified here.
