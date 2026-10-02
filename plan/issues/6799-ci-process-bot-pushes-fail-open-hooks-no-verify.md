---
id: 6799
title: "ci/process: 46 of the last 300 main commits are `[skip ci]` bot pushes and the queue gate 'fails open'; `.husky/pre-push` runs `git commit --no-verify` and skips `format:check` after a 90 s watchdog; dead workflows and 44 orphaned scripts"
status: ready
sprint: Backlog
created: 2026-09-30
updated: 2026-09-30
priority: medium
horizon: m
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: ci
language_feature: n/a
goal: ci-hardening
related: [3915, 2178, 3988, 4094, 6784, 6796]
requested_by: ttraenkler/claude-review
origin: "2026-09-30 codebase review (plan/agent-context/claude-codebase-review-2026-09-30.md) — #5/#6/#8/#9"
---

# #6799 — CI process debt (measured 2026-09-30)

## 1. Pushes to main are frequent and the guard is advisory

- Five workflows `git push deploykey HEAD:main`: `baseline-summary-sync.yml:369`
  (hourly cron), `benchmark-refresh.yml:535` (every push), `diff-test.yml:319`,
  `refresh-baseline.yml:952`, `test262-sharded.yml:4996`.
- **46 of the last 300** first-parent main commits are `[skip ci]` bot pushes
  (31 sharded-baseline, 13 benchmark, 2 summary-sync) vs 169 PR merges.
  CLAUDE.md itself: every push to main rebuilds in-flight merge groups (#3915).
- `scripts/main-push-queue-gate.mjs` is consulted but overridden:
  `benchmark-refresh.yml:463` / `refresh-baseline.yml:833`
  `"gate exited ${RC}; failing open" … decision=proceed`.

Fix: fail closed on a gate error; batch the artifact refreshes into one
scheduled promotion per N hours (the npm-compat path already moved to a PR —
#3988 — do the same for the three remaining direct pushers, or at least
coalesce them).

## 2. Hooks

- `.husky/pre-push:161/168`: `format:check` under a 90 s watchdog → "TIMED
  OUT — skipping". Measured: 82 s idle, 108 s with one concurrent job → the
  check is skipped exactly when the machine is busy. Fix: run prettier on
  changed files only (`git diff --name-only <upstream>..HEAD`), no watchdog.
- `.husky/pre-push` runs `git commit --no-verify` on `v*` tags (benchmark
  auto-commit), contradicting the project-lead order (CLAUDE.md, 2026-08-22).
  Fix: move the benchmark refresh into `scripts/release.mjs` (already the
  only sanctioned tag path) and drop the hook branch.

## 3. Dead / duplicated CI and scripts

- `ci-status-basic/feed/pending.yml` are `workflow_dispatch`-only stubs;
  their output directory is tracked (#6796).
- `benchmark-refresh.yml` has 8 `github.event_name == 'pull_request'`
  conditionals but no `pull_request` trigger (dead steps).
- `issue-5807-linux-replay.yml` fires only on push to one dev branch
  (`codex/3518-number-format-consumer-20260909`).
- Trigger histogram (39 workflows): `workflow_dispatch` 28, `schedule` 16,
  `push` 12, `pull_request` 9, `workflow_run` 6, `merge_group` 4,
  `pull_request_target` 3, `workflow_call` 1, `issue_comment` 1; 4
  dispatch-only.
- `scripts/`: 271 files; 157 referenced by `package.json`/`.github`/`.husky`,
  10 only by `.claude/`, 55 only by other scripts, 5 only by docs,
  **44 orphaned** (16 %): e.g. `scripts/run-test262.sh`, `test-and-merge.sh`,
  `compiler-worker.mjs`, `test262-quick.sh`, `run-benchmarks.ts`,
  `sprint-stats.sh`. `check:godfiles` is red on main and run nowhere.

Fix: delete the stubs, the branch-pinned workflow, and the orphaned scripts
(one PR, list them); add `scripts/check-orphaned-scripts.mjs` to `quality`
with the current baseline so the count only goes down.

## 4. Issue frontmatter vocabulary

20 issue files carry off-schema statuses (`in_progress` ×8, `review`,
`complete`, `fail`, "done — see PR." …); 1,160 are tagged `sprint: current`;
only 761 / 4,686 carry `## Implementation Plan` although README says specs
exist "for every … work item". Fix: `check:issues` rejects a status outside
`SCHEMA.md`'s list (normalise the 20 in the same PR); README wording.

## Acceptance

- `git log --first-parent -300 main | grep -c '\[skip ci\]'` trends down and
  is reported in the PR; no workflow proceeds past a non-zero gate exit.
- `format:check` in pre-push cannot be skipped by load.
- `grep -rn "no-verify" .husky` returns nothing.
- `pnpm run check:orphaned-scripts` exists and passes; the three stub
  workflows are gone.
- `pnpm run check:issues` fails on an off-schema status.
