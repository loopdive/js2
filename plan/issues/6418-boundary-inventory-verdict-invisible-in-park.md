---
id: 6418
title: "An auto-park citing the #3518 boundary-inventory gate shows no reason in the job log — the step redirects its verdict into the artifact, so the shepherd sees only `exit code 1`"
status: done
sprint: current
created: 2026-09-12
updated: 2026-09-12
completed: 2026-09-12
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infra
area: ci
goal: correctness
---

## Problem

`quality`'s compiler-boundary step runs:

```bash
node --max-old-space-size=2048 scripts/check-compiler-boundaries.mjs \
  --mode inventory --base HEAD^1 > compiler-boundaries-report.json
```

The `>` sends the **entire verdict** — `status`, and the `errors[]` array that
names the offending files — into the artifact. When the gate fails, the job log
contains exactly one line about it:

```
##[error]Process completed with exit code 1.
```

So an `auto-park-bot:merge-group-failure` comment that cites this step gives the
shepherd a failing step name and nothing else. The auto-park comment's own
footer asks the reader to "confirm against the run before removing `hold`" —
which is impossible from the run alone. Recovering the reason needs the
artifact downloaded and unzipped, or the gate re-run locally against the right
base.

Measured on PR #5683 (park run `34674500787`, job `103501812033`): the log
showed only the exit code; running the gate locally produced the real verdict in
one shot:

```json
"status": "invalid-inventory",
"errors": [
  { "code": "unclassified-module", "detail": "src/codegen/statements/eager-capture-box.ts" },
  { "code": "unclassified-target", "detail": "src/codegen/statements/eager-capture-box.ts" }   // x5
]
```

The whole failure was one missing classification row for one new module — a
two-minute fix behind a diagnosis that cost far more than the fix.

### Why it matters beyond one PR

This is the failure family the repo already names in `pre-commit-checklist.md`
("never pipe a gate whose status you need") in its other form: **a gate whose
verdict nobody can read is operationally the same as a gate that did not run.**
Here the status *is* propagated correctly (exit 1 is honest) — it is the
*reason* that is unreadable, which is worse in one specific way: the park looks
indistinguishable from the known main-side drift parks (Temporal,
`runtimeTsLines`) that a shepherd is explicitly allowed to unhold with a
comment. A shepherd pattern-matching on "quality failed, probably group
composition" would remove this `hold` without fixing anything, and the PR would
re-park on the next pass.

## Acceptance criteria

1. The boundary-inventory step's failure reason is visible in the job log —
   e.g. `tee` the report instead of redirecting, or print `status` plus the
   `errors[]` entries to stderr on a non-zero exit. The artifact upload keeps
   working unchanged.
2. A deliberately unclassified module produces a job log that names the file
   and the error codes.
3. Audit the other `quality` steps for the same shape (`> file.json` with no
   console verdict) and give each one a log-visible failure reason.

## Implementation Plan

**Diagnosis (verified on 23a0ddaa26).** `scripts/check-compiler-boundaries.mjs` has exactly two output sites, both `console.log` (L727 success/failure report, L730 `checker-error` catch); it never writes stderr. `.github/workflows/ci.yml:166-167` redirects stdout to `compiler-boundaries-report.json` for the artifact, so a failing run leaves the job log with only the exit code. A local run of the gate on HEAD wrote 0 bytes to stderr. AC3 audit of the whole `quality` job (ci.yml:80-760): this is the **only** step with the `> file.json`-and-no-verdict shape — the lint/format/typecheck lanes `cat` their captured logs (L146-149), and both `select-changed-issue-tests.mjs > /tmp/...` sites (L775, L795) carry `|| { echo "::error::…" }` handlers. Nothing else to fix under AC3; record that finding in the issue.

**Fix — script side (primary), keep stdout JSON pure.** The test harness (`tests/issue-3518-compiler-boundaries.test.ts:95`) does `JSON.parse(result.stdout)`, so the human-readable verdict must go to **stderr**, not stdout.
1. `scripts/check-compiler-boundaries.mjs`, CLI block (L716-739): add a small `printVerdict(report, exitCode)` that, when `exitCode !== 0`, writes to `process.stderr` one header line `compiler-boundaries: <status> (mode=<mode>, exit <n>)` followed by one line per `report.errors[]` entry: `  <code>: <detail>`. Call it in both the success-path branch (after `console.log(JSON…)`) and the catch branch (`checker-error`). On exit 0 print nothing (keeps green logs quiet). Order constraint: stdout JSON is written first and unchanged; stderr summary after.
2. `.github/workflows/ci.yml:166-167`: keep the `>` redirect (artifact upload L169-176 unchanged). Optionally add a `::error::` annotation without a second run: `|| { echo "::error::compiler-boundaries gate failed — reason above (also in artifact compiler-boundaries-${{ github.run_id }})"; exit 1; }`. Do not `tee` (a 2 MB JSON in the log helps nobody); do not add `2>/dev/null`.
3. Add a "how to read this park" line to the auto-park guidance in `docs/ci-policy.md` (or the `steward` skill) only if a one-liner fits; otherwise skip.

**Probe first.** In the worktree, `touch src/codegen/zz-probe.ts` (untracked, delete after) and run `node scripts/check-compiler-boundaries.mjs --mode inventory --base HEAD^1 > .tmp/r.json; echo $?` — parent shows exit 1 and empty stderr; with the fix stderr names `unclassified-module: src/codegen/zz-probe.ts`.

**Regression tests.**
- `tests/issue-3518-compiler-boundaries.test.ts`: extend `run()` (L77-96) to also return `result.stderr`. In the `fails closed for %s` table (L345-368) assert for `extra` that stderr contains `invalid-inventory`, `unclassified-module` and `src/foundation/unclassified.ts`; fails on parent (stderr empty), passes with fix. Anti-vacuity control: in an existing green inventory case assert `stderr === ""` and that `JSON.parse(stdout)` still succeeds (stdout unchanged).
- New `tests/issue-6418-boundary-verdict-in-log.test.ts` in the `ci-quality-failfast.test.ts` style: slice the `Compiler inventory and activated boundaries (#3518)` step from ci.yml, assert it still writes `compiler-boundaries-report.json` (artifact contract), contains no `2>/dev/null` / `2>&1 >` on that command line, and the artifact upload step still has `if-no-files-found: error`.

**Expected movement.** CI-only: no compiler source changes, so every dogfood anchor (webpack 16/16 · three 17/18 · clsx 32/32 · cookie 63740 · lodash 59/62 · redux 67/82 · axios 208/231 · stylelint 108 · tailwindcss 13 · jsdom 6 · styled-components 9 · uuid 75 · marked 16/30 · moment 10 · prettier 107/151 · jest 335/356 · hono 259/324) stays flat, test262 and the standalone lane are untouched. Gates to run before commit: the ratchet chain from CLAUDE.md plus `npx vitest run tests/issue-3518-compiler-boundaries.test.ts tests/ci-quality-failfast.test.ts tests/issue-6418-*.test.ts`. `scripts/*.mjs` counts toward `check-loc-budget` — ~15 added lines, no grant expected.

## Dispatch

**Model: sonnet.** Mechanical CI/infra change: one stderr summary in a script whose output contract is already pinned by tests, one workflow-step tweak, and a contract test modelled on an existing file; the diagnosis and audit are done above.

## Resolution

Fixed 2026-09-12. The verdict now travels on **stderr**; stdout stays the pure
JSON report the artifact upload and `tests/issue-3518-compiler-boundaries.test.ts`
parse.

- `scripts/check-compiler-boundaries.mjs` — new `printVerdict(report, exitCode)`
  writes `compiler-boundaries: <status> (mode=<mode>, exit <n>)` plus one
  `  <code>: <detail>` line per `errors[]` entry, on a non-zero exit only.
  Called from both CLI exits: the normal path (after the JSON `console.log`) and
  the `checker-error` catch, which now builds the report object once and prints
  it both ways. A passing run writes zero bytes of stderr.
- `.github/workflows/ci.yml` — the `>` redirect and the artifact upload are
  unchanged; the command gains an `|| { echo "::error::…"; exit 1; }` handler
  naming the artifact. No `tee` (the report is large), no `2>/dev/null`.

**Probe (parent, at `e8a778638f`).** `touch src/codegen/zz-probe.ts` then
`node scripts/check-compiler-boundaries.mjs --mode inventory --base HEAD^1
> .tmp/r.json 2> .tmp/r.err` → exit 1, **0 bytes** of stderr. With the fix, the
same run prints:

```
compiler-boundaries: invalid-inventory (mode=inventory, exit 1)
  unclassified-module: src/codegen/zz-probe.ts
```

**AC3 audit — independently re-verified, and it confirms the plan.** The
boundary-inventory step was the only `quality` step with the
`> file.json`-and-no-verdict shape. The other two redirect sites in `ci.yml`
(`select-changed-issue-tests.mjs --pinned` at L781, `--changed` at L801) already
carry `::error::` / `::warning::` handlers, and the lint/format/typecheck lanes
`cat` their captured logs. Nothing further to change.

**Regression tests (fail on parent, pass with fix).**
- `tests/issue-3518-compiler-boundaries.test.ts` — `run()` now returns
  `stderr`; all six `fails closed for %s` rows assert the expected error code
  reaches stderr, and the `extra` row additionally asserts `invalid-inventory`
  and the offending path `src/foundation/unclassified.ts`.
  Anti-vacuity control: a new valid-inventory case asserts `stderr === ""` and
  that stdout still parses — it passes on the parent too, which is the point.
- `tests/issue-6418-boundary-verdict-in-log.test.ts` — workflow contract: the
  step still writes `compiler-boundaries-report.json`, the upload still has
  `if-no-files-found: error`, the command carries no `2>` of any form, the
  `::error::` annotation names the artifact, and `printVerdict` writes to
  `process.stderr` rather than `console.log`.

Parent run: 8 failures (6 `fails closed` rows + 2 of the 4 new workflow
assertions). With the fix: 50/50 across
`issue-6418-boundary-verdict-in-log`, `issue-3518-compiler-boundaries` and
`ci-quality-failfast`.

**No compiler source changed** — `scripts/` and `.github/` only — so no dogfood
suite A/B was run and every anchor is unaffected by construction.
