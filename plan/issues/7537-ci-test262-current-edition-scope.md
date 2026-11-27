---
id: 7537
title: "test262 after #7551: legacy ES5 on every push, post-merge regression path with a 24 h revert, daily full run, IR as the site's default view"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-27
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
goal: test-infrastructure
related: [7551, 7552, 7558, 7354, 2178, 6760]
---

# #7537 — the delta left after #7551

## Scope

#7551 (PRs #7518, #7523) already delivered most of the original brief:

- the merge queue gates on IR × the current edition (ES5, 102 shards,
  `scripts/test262-current-edition.json`);
- push re-runs nothing that the queue measured;
- the full legacy matrix and the full-corpus IR run are weekly (and
  `full_run=true` on dispatch);
- the staleness alert is alert-only.

This issue is what the owner decided on 2026-11-27 that is not on main yet.

1. A **legacy ES5 run on every push** to main (~16 shards).
2. The **post-merge regression path**:
   - red main;
   - the `post-merge-regression` label on the merged PR;
   - a **revert after 24 h** without a fix-forward PR.
3. The full legacy run (with the full-corpus IR run) **daily** instead of
   weekly.
4. **IR as the website's default view**, with the toggle always visible.
5. Accurate `reason` text in the two `test262-*-ir-status.json` placeholders.
6. Matching `CLAUDE.md` and `docs/ci-policy.md` updates.

Owner answers that bound it (2026-11-27):

- **Cadence:** the full run is daily (this overturns #7551's weekly schedule).
- **Compile timeouts:** a `compile_timeout` is not an immediate regression;
  #7551's exemption on the IR gate stays.

The #7354 lane owns `test262-sharded.yml`. Before any change to it, the
planned edits below are posted on coordination PR #7526.

## Measurements (2026-11-27, origin/main `4caef358`)

| What | Source | Value |
| --- | --- | --- |
| Legacy shard cost | run 45776708512, 102 standalone shards | avg 380 s per shard: ~45 s setup and ~335 s tests; 570 test-min over ~52.6k rows ≈ 0.65 s per row |
| ES5 files | `classifyEdition` over test262 `b363f29d` | 9,174 files (the 9,029-row ES5 bucket plus 145 proposal-scoped files) |
| Legacy ES5 per push, 16 shards | estimate from the two rows above | ≈ 100 test-min + 16 × 45 s ≈ **110 runner-min**, ≈ 7 min wall per shard |
| Former daily cron `23 2 * * *` | 30 schedule runs, 2026-10-28 … 11-26 | started 08:33–12:40 UTC, i.e. **6.2–10.3 h late** |
| Queue load by hour (UTC) | 100 merge_group runs, 2026-11-26 09:06 … 11-27 21:09 (36 h only) | 03–07 h: 3–6 runs/h; 08–12 h: 5–7; 19 h: 11 (peak); 21–02 h: 0–2 |
| Full-run duration to promotion | #7551 record | 2–4 h |

## Design

### 1. Legacy ES5 on every push

**Scope = the completed editions, not the current one.** The legacy lane on
push guards what is finished. It reads `completed: true` from
`scripts/test262-edition-ratchet-baseline.json` (read only; that file is never
edited here). Today that is ES5.

When the IR's current edition moves to ES2015, the push lane still guards ES5.
When ES2015 completes on the legacy lane, it joins automatically. The shard
count is one new field, `"completedChunks": 16`, in
`scripts/test262-current-edition.json`, beside the IR's `chunks`.

**File list = one classifier.** `scripts/test262-edition-scope.ts paths`
already writes an edition's file list with `classifyTest262File`, the
ratchet's own classifier. It gains `--completed`, which lists the files of
every completed edition. There is no second walk and no second classifier.

**Jobs in `test262-sharded.yml`:**

- **`compiler-path-measurement-plan`**: a second, separate step "Select the
  legacy lane's scope" (the IR program is untouched). It emits:
  - `legacy_scope`: `completed` on push, `full` on schedule and dispatch;
  - `legacy_matrix`: `[1..16]` or `[1..102]`;
  - `legacy_chunks`.
- **`test262-shard`**:
  - gains the push arm: push by a non-bot actor; schedule and dispatch as
    today;
  - the matrix and `TEST262_CHUNK_TOTAL` come from the plan;
  - with scope `completed`, one step writes the file list and exports
    `TEST262_PATH_FILTER_FILE`, the same mechanism the IR shards use;
  - `max-parallel` 40 stays for the full run; scoped runs are never
    throttled.
- **`merge-report`** gains the push arm:
  - **Under every scope:** merge, completeness validation and the per-edition
    ratchet. A partial run is still checked row by row for completed editions.
  - **Under `full` only:** the high-water floor (#2097), the stale-high-water
    report, the #1897 net guard and the "commits since the last green full
    run" step. They need whole-corpus counts.
  - **Not affected:** `promote-baseline` already admits only schedule and
    dispatch, so a scoped run never promotes.
- **Compile timeouts on push:** the ratchet gets `--timeouts-listed`, used
  only under `completed` scope. A completed-edition row that is
  `compile_timeout` is listed, not failed; the owner's rule for the IR gate
  carries over. The daily full run keeps the strict rule, so a timeout that
  persists still fails there.

### 2. Post-merge regression path

**Red main.** A completed-edition breach fails `merge shard reports` in the
push run, and the main commit shows red. It stays red: the completed rule is
absolute, so every later push run fails on the same rows until they pass again.

**Label and comment (new job `post-merge regression`).** It runs on push,
after `merge-report`, only when the ratchet step failed. An infrastructure
failure never triggers it.

1. It writes the run's non-passing completed-edition rows to an artifact,
   `test262-completed-edition-failures`.
2. It compares them with the previous push run's artifact:
   - only rows that are **new** in this run are attributed to this push;
   - this run's commit names the PR ("Merge pull request #N");
   - while main is already red, a later unrelated merge is not labelled.
3. It adds `post-merge-regression` to that PR and comments:
   - the new rows;
   - the run link;
   - the 24 h deadline;
   - the fix-forward marker: a PR whose body contains
     `post-merge-regression-fix: #N`.
4. Permissions are job-level `pull-requests: write` and `issues: write`, using
   `GITHUB_TOKEN`.

**Revert after 24 h (new workflow `post-merge-regression-revert.yml`, hourly
cron).** For each PR labelled `post-merge-regression`:

- **Resolved:** if the newest completed push run on main has none of that PR's
  rows, it removes the label and comments "resolved".
- **Revert due:** otherwise, if the label is more than 24 h old and no open or
  merged PR carries the fix-forward marker for it, it opens a revert PR. It
  reuses the npm-compat promotion pattern:
  - `git revert -m 1 <merge commit>` on branch `revert/pr-<N>`;
  - the branch is pushed with `MAIN_DEPLOY_KEY` (environment
    `baseline-promote`);
  - the PR is opened with the existing GitHub App token, so CI fires;
  - the original PR gets `post-merge-regression-reverted`.
- **Revert conflicts:** it comments on the PR and stops; the lead resolves it.

The revert PR goes through the queue like any other PR, and auto-enqueue picks
it up. No push to main.

**Staleness alert.** It stays alert-only. The threshold changes from 192 h to
**48 h**:

- 24 h of cadence;
- 10.3 h of the worst measured start delay;
- 4 h to promotion;
- about 10 h of slack.

### 3. Daily full run

- **Cron:** `schedule` becomes `17 21 * * *`, every day at 21:17 UTC.
  - At the measured 6.2–10.3 h delay it starts around 03:30–07:35 UTC. The
    queue ran 3–6 groups per hour then, against 5–7 in the 08–12 window that
    the 02:23 cron landed in.
  - Minute 17 avoids the top-of-hour and half-hour rush.
- **Known limit:** the delay was measured only for the 02:23 slot, and the
  queue profile for only 36 hours. This issue records the first seven starts
  at the new slot. The 48 h threshold tolerates a delay of up to about 20 h.
- **Wording:** every "weekly" stays true only for what remains weekly. The
  full-run wording becomes "daily" in:
  - `test262-sharded.yml`: header, schedule comment, `test262-shard` comment,
    plan comment;
  - `baseline-floor-staleness-alert.yml` and `refresh-baseline.yml`;
  - `scripts/test262-edition-scope.ts`, `scripts/test262-last-full-run.mjs`
    and `scripts/check-baseline-floor-staleness.mjs`;
  - `docs/ci-policy.md` and `docs/releasing.md`;
  - `CLAUDE.md`;
  - the tests that pin the cron or the word, listed below.

### 4. IR as the website's default view

`website/components/t262-view-state.js`:

- `read()`: `irAvailable` is always true. `ir` is true unless the URL says
  `?ir=0`.
- `write()`: drops the parameter for the default (IR) and writes `ir=0` for
  the legacy view.
- `bindIrToggle`: no longer hides the label.

The inline early check in `website/index.html` (line 6) and
`website/public/benchmarks/report.html` reads the same rule from
`t262ViewState.read()` instead of its own `URLSearchParams` test.

### 5. Placeholder reason text

`benchmarks/results/test262-standalone-ir-status.json` and
`test262-ir-status.json` keep `state: "unavailable"`; the test pins it. Their
`reason` says:

- **standalone:** a placeholder that `deploy-pages` replaces with the latest
  completed IR measurement;
- **host:** the JS-host lane is retired and has no IR measurement.

### 6. Docs

- **`CLAUDE.md`**:
  - the "goal is measured" paragraph;
  - the Test262 cadence block;
  - the edition-ratchet section: completed editions are checked on every push
    to main, after the merge; the full ratchet is checked daily;
  - the red-main → label → 24 h → revert procedure and the fix-forward marker;
  - the baseline table: "as of the last green daily run".
- **`docs/ci-policy.md`**:
  - §3: which gate runs where;
  - §10: the release dispatch;
  - the required-checks table, which is unchanged in content.

## What Session B loses or gains

- Gains:
  - a legacy ES5 regression is caught within one push run (~10 min), not
    within a week;
  - every regression names its PR;
  - full numbers refresh daily.
- Loses:
  - about 110 runner-min per test262-relevant merge, plus about 940 a day
    instead of a week;
  - an automated revert PR can appear for a merge whose author did not post a
    fix-forward PR within 24 h.

## Tests

- **`tests/issue-7551-ir-edition-scope.test.ts`:**
  - `paths --completed` equals the union of the completed editions' files on a
    fixture tree;
  - an edition without `completed` is excluded.
- **`tests/test262-edition-ratchet.test.ts`:**
  - `--timeouts-listed` lists, and does not fail, a completed-edition
    `compile_timeout` row;
  - without the flag, it fails.
- **Workflow-structure tests:**
  - `tests/test262-per-lane-gating.test.ts`: the push arm and the scoped
    matrix;
  - `tests/issue-7551-job-skip-propagation.test.ts`: the push arm of
    `test262-shard` and `merge-report`;
  - `tests/issue-4350-baseline-refresh-cron.test.ts` and
    `scripts/test262-ir-pages-artifacts.test.mjs`: the daily cron;
  - `tests/issue-3611-promote-baseline-runs-on-hit-path.test.ts`: push still
    never promotes.
- **New `tests/issue-7537-post-merge-regression.test.ts`:**
  - attribution of new rows only;
  - the PR number from the merge-commit subject;
  - detection of the fix-forward marker;
  - the 24 h deadline arithmetic;
  - a mocked `gh` for the label, resolve and revert decisions.
- **`scripts/website-ir-view-state.test.mjs`:**
  - the default is IR;
  - `?ir=0` gives the legacy view;
  - the toggle is visible without a parameter.
- **Tooling checks:**
  - `actionlint` on the changed workflows if it is available;
  - a `workflow_dispatch` dry run only with the lead's approval.

## Acceptance criteria

- **Push:** a test262-relevant push to main runs 16 legacy shards over exactly
  the completed editions' files.
  - `merge shard reports` fails when a completed-edition row does not pass,
    except a `compile_timeout`, which is listed.
  - The run never promotes.
- **Labelling:** the first push run with a new completed-edition failure
  labels and comments on its PR. A later merge while main is already red is
  not labelled unless it adds rows.
- **Revert:**
  - a labelled PR without a fix-forward PR gets a revert PR 24 h after the
    label;
  - a resolved one loses the label;
  - a conflicting revert is reported, not forced.
- **Daily run:** the full legacy matrix, the full-corpus IR run and promotion
  run daily at 21:17 UTC. The staleness alert breaches after 48 h.
- **Website:** the site opens on the IR view without a URL parameter, the
  toggle is always visible, and `?ir=0` shows the legacy view.
- **Code quality:**
  - one edition classifier and one file-list writer, extended rather than
    copied;
  - the push lane reuses `test262-shard`, `merge-report` and the
    current-edition config instead of adding parallel jobs;
  - the attribution and revert decisions live in one tested script, with the
    workflows only calling it;
  - no new inline program in YAML.
