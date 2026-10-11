---
id: 6799
title: "ci/process: 46 of the last 300 main commits are `[skip ci]` bot pushes and the queue gate 'fails open'; `.husky/pre-push` runs `git commit --no-verify` and skips `format:check` after a 90 s watchdog; dead workflows and 44 orphaned scripts"
status: done
completed: 2026-10-02
sprint: Backlog
created: 2026-09-30
updated: 2026-10-02
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
assignee: "ttraenkler/claude-dev-6799"
branch: "claude/issue-6799-ci-process"
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

## Implementation Plan

Scope set by the orchestrator (2026-10-02) before work started:

- **Part 1** — only make the callers of `main-push-queue-gate.mjs` fail
  CLOSED on a non-zero, non-10 exit. Do NOT redesign the artifact-refresh
  cadence; coalescing the direct pushers into one scheduled promotion needs a
  design decision and is a follow-up (see Resolution).
- **Part 2** — pre-push prettier over changed files only, no timeout; remove
  the `v*`-tag `git commit` branch and move the benchmark refresh into
  `scripts/release.mjs`. `grep -rn "no-verify" .husky` must be empty.
- **Part 3** — the `ci-status-*.yml` stubs and `.claude/ci-status/` belong to
  #6796 (in flight) and `check:godfiles` to #6797: not touched here. Delete
  `issue-5807-linux-replay.yml`; remove the dead `pull_request` code in
  `benchmark-refresh.yml`; add `scripts/check-orphaned-scripts.mjs` + a
  committed baseline, wired into `quality`. Delete an issue-named orphan only
  with zero references anywhere (incl. `plan/`, `website/`); one cited only from
  docs/plan stays, in the baseline.
- **Part 4** — `check:issues` rejects a status outside `SCHEMA.md`'s list;
  normalise the off-schema files in the same change; fix the README wording.

Steps taken:

1. `benchmark-refresh.yml`, `refresh-baseline.yml`, `diff-test.yml` (the third
   carried the identical branch; included so *no* workflow proceeds past a
   non-zero gate exit): `case "$RC"` → `0` proceed, `10` defer, else
   `::error::`, `decision=error`, `exit 1`; push steps guard on
   `decision == 'proceed'`. Contract paragraph in `main-push-queue-gate.mjs`
   and `docs/ci-policy.md` updated. `tests/issue-3915-main-push-queue-gate.test.ts`
   now runs each gate step verbatim for exits 0/10/3/1 in all three workflows.
2. `scripts/hooks/format-gate.sh` rewritten: `format_gate_base` (merge-base
   with `upstream/main`, else `origin/main`), `format_changed_files`
   (`git diff --name-only --diff-filter=d <base>..HEAD` ∩ `^(src|tests|scripts)/.+\.ts$`,
   the `format:check` globs), `run_format_gate` (`pnpm exec prettier --check`
   on those; whole-tree `format:check` if no base resolves; never a timeout).
   `.husky/pre-push` §3b calls it; §2 (tag benchmark commit) removed; §4 (the
   conformance auto-commit, also hook-bypassing) now runs
   `sync:conformance:check` and blocks a real drift with the fix-up command.
   Every hook-bypass mention removed from `.husky/` (pre-commit and commit-msg
   comments reworded). `scripts/release.mjs` gains `refreshReleaseBenchmarks`
   (`pnpm run refresh:benchmarks`, then a path-limited, hook-checked
   `chore(benchmarks): refresh for vX` commit of changed tracked files under
   `benchmarks/results/`; `--skip-benchmarks`; best-effort), and its notes
   amend and printed tag-push command no longer bypass hooks.
   `tests/hooks/pre-push-format-timeout.test.ts` →
   `tests/hooks/pre-push-format-gate.test.ts` (throwaway repo + stub `pnpm`).
   `docs/releasing.md` and the `publish-release` skill updated.
3. `benchmark-refresh.yml`: removed the PR-base checkout, timing-migration
   detect/record, baseline install, PR-base measurement, same-run comparison,
   bootstrap sidebar gate, legacy-Javy probe, and the `pull_request` branches
   in `concurrency`, the auxiliary/cleanup/measure steps and the promote job
   `if:`. `tests/benchmark-lifecycle.test.ts` updated to assert the absence.
   `scripts/check-orphaned-scripts.mjs` (`check:orphaned-scripts`, `quality`
   step after the dead-export gate) + `scripts/orphaned-scripts-baseline.json`;
   `tests/issue-6799-orphaned-scripts.test.ts`.
4. `scripts/lib/issue-status-schema.mjs` parses the list from `SCHEMA.md`;
   `update-issues.mjs --check` fails on any raw status outside it (or an
   unreadable list). `tests/issue-6799-issue-status-schema.test.ts`.

## Resolution

**Part 1 — fail closed.** Before: a gate exit other than 0/10 wrote
`decision=proceed` with a `::warning::` and pushed `main`. After: the step
fails with `::error::`, writes `decision=error`, and the push step (now
`== 'proceed'`) is skipped. Covered in three workflows; the gate's own
handling of an *unreadable* queue/age (proceed with a warning) is unchanged,
so this cannot freeze an artifact on a flaky API.

`[skip ci]` measurement (2026-10-02, this clone's full first-parent history of
`origin/main`, which is shallow at 281 commits): **67 of 281** are `[skip ci]`
bot pushes vs 213 PR merges (issue's 2026-09-30 figure: 46 of 300). This PR
does not move that number — it only stops a broken gate from pushing.
**Follow-up, not filed:** coalesce the direct pushers (`benchmark-refresh`,
`refresh-baseline`, `diff-test`, plus the inline-gated `test262-sharded`
promote and hourly `baseline-summary-sync`) into one scheduled promotion, or
move them to PRs as #3988 did for npm-compat. Needs a design decision.

**Part 2 — hooks.** The checkpoint push of commit 1 (old hook) printed
`format:check TIMED OUT (90s) — skipping` — the defect, reproduced. The
checkpoint pushes of commits 2 and 3 (new hook) printed
`prettier --check on 2 changed file(s)` / `on 4 changed file(s)` and passed
in seconds. `grep -rn "no-verify" .husky` → empty. `sh -n` passes on all three
hooks and `format-gate.sh`.

**Part 3 — dead CI / scripts.** `issue-5807-linux-replay.yml` deleted (fired
only on pushes to `codex/3518-number-format-consumer-20260909`). Orphans:
**48 of 274** top-level `scripts/` files after this change (the checker's
definition differs slightly from the review's 44/271 count: it does not count
`tests/` or `plan/issues/` references). Of the six orphans the issue names,
`run-test262.sh` and `test262-quick.sh` had zero references anywhere (only
themselves and this issue) and are deleted; `test-and-merge.sh` (#873,
sprint 36), `compiler-worker.mjs` (#699, #725), `run-benchmarks.ts` (#507,
#6776) and `sprint-stats.sh` (#1656) are still cited from `plan/` and stay in
the baseline. **Not done here:** the `ci-status-*.yml` stubs and
`.claude/ci-status/` (#6796, in flight — so the "three stub workflows are
gone" criterion lands with #6796), and `check:godfiles` (#6797).

**Part 4 — status vocabulary.** `SCHEMA.md` said `review` where CLAUDE.md, the
normaliser and 51 files say `in-review`, and omitted `suspended`, the SUSPEND
protocol's documented state (4 files; the normaliser used to rewrite it to
`ready`). The list is now backlog, ready, in-progress, in-review, blocked,
suspended, done, wont-fix. Negative control: against the old list
`check:issues` exited 1 with 65 offenders; with the corrected list, 12.
Normalised (all frontmatter; the issue's "20" also counted three body lines —
two test-output code blocks in #4701/#5109 and a `## Status` section in #2696 —
which are not frontmatter and were left alone):

| File | Was | Now | Evidence |
| --- | --- | --- | --- |
| 1058, 1240, 1609, 1691, 3423, 4753, 4759, 4760 | `in_progress` | `in-progress` | spelling only |
| 1426 | `review` | `done`, completed 2026-05-03 | PR #189 merged (issue renumbered from #1278) |
| 4783 | `review` | `done`, completed 2026-08-27 | PR #5079 merged; test on main |
| 3764 | `complete` | `done`, completed 2026-07-28 | PR #3754 merged; test on main |
| 4761 | `complete` | `done`, completed 2026-08-27 | PR #5027 merged; test on main |

`check:done-status-integrity` passes for the four new `done` files. README now
says each issue file carries problem/criteria/status and the harder ones an
implementation plan (934 of 4,714 issue files have one).

**Gates (2026-10-02):** `check:issues` 0, `check:orphaned-scripts` 0 (negative
control: dropping one baseline entry → exit 1), `check:dead-exports` 0, `lint`
0, `format:check` 0, `typecheck` 0, `check:done-status-integrity` 0,
`check:issue-spec-coverage` 0, `check:oracle-ratchet` 0, `check:coercion-sites`
0, LOC/func budgets 0 (also with `LOC_GATE_BASE=origin/main`). All touched
workflows parse with the `yaml` package. Focused tests: #3915 gate (46),
`tests/hooks/` (57), #6799 orphan (6) and status (4), benchmark-lifecycle,
release tests — all pass. Pre-existing on `main`, not from this change:
`tests/issue-4130-npm-compat-promotion-fast-path.test.ts` fails on the
`Preserve compiler boundary evidence (#3518)` step in `ci.yml` lacking the
npm-compat guard.
