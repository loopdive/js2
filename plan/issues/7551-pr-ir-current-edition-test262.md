---
id: 7551
title: "Per merge, measure test262 only on the IR path and only for the current ES edition; full corpus and legacy lane daily"
status: in-progress
created: 2026-11-26
updated: 2026-11-26
assignee: ttraenkler/ci-pr-ir-edition
priority: high
feasibility: hard
reasoning_effort: high
task_type: ci
area: ci, test262
goal: ci-hardening
sprint: current
horizon: m
es_edition: ES5
related: [1897, 1956, 2097, 2519, 3448, 3467, 3431, 6760]
---

# #7551 — per-merge test262 = IR path × current edition

## Problem

Owner decision (2026-11-26): per merge to main, test262 runs only on the IR
path and only for the ES edition currently being worked on (ES5 today). The
whole corpus and the legacy lane move to a daily cadence. A PR is compared
against the *equivalent* run on main (IR path, current edition).

Measured today (runs on `loopdive/js2`, 2026-11-26):

| Event | What runs | Runner-min | Wall |
|---|---|---|---|
| `merge_group` (run 45788963792) | 102 legacy standalone shards (`test262-shard-mg`) + gates in `merge shard reports` | 652 | 96 min |
| `push` to main (runs 45788961847, 45779984142) | 102 full-corpus IR shards (`test262-ir-measurement-shard`); legacy matrix SKIPPED via the #3448 probe HIT | 295–302 | ~10 min |

So "legacy on every merge" runs in the **merge queue**, not on push; on push
it already reuses the group's artifact.

The work splits in two parts. Part A is independent of the queue design and
is implemented here. Part B reworks the queue's gates and is **plan only**
until the owner approves it.

## Implementation Plan

### Part A — per-merge IR measurement scoped to the current edition (implemented)

**Single source of truth for "current edition":**
`scripts/test262-current-edition.json` → `{ "edition": "ES5", "chunks": 8 }`.
No existing file fits: the edition-ratchet baseline is a `*-baseline.json`
(main is its only writer) and `CURRENT_DRAFT_EDITION` in
`scripts/generate-editions.ts` is the draft edition, a different notion.
Changing the edition is a one-line reviewed diff.

**Classifier reuse.** The edition of a file comes from
`classifyEdition(parseFrontmatter(abs), abs)` in `scripts/generate-editions.ts`.
That is the edition ratchet's classifier. The two-call composition currently
lives inline in `scripts/test262-edition-ratchet.ts::editionOf`. It moves to
`generate-editions.ts` as an exported `classifyTest262File(root, rel)`. The
ratchet and the new script both call it, so there is no second classifier.

**New module `scripts/test262-edition-scope.ts`** (next to the ratchet):

- `editionPaths(test262Root, edition)`: walk `test/**` with the runner's own
  discovery rule (`.js`, not `_FIXTURE`, not `.imports.js`, see
  `tests/test262-runner.ts::findTestFiles`) and keep the files whose edition
  matches. The output is `test/...`-relative, which is the key the runner's
  `TEST262_PATH_FILTER_FILE` set matches (`relative(test262Root, file)`,
  `tests/test262-runner.ts:3750`).
- `compareEditionRuns(candidate, baseline, paths)`: count pass, fail,
  compile_error and other, then diff per test. **regressions** are
  pass → not-pass. **improvements** are not-pass → pass. Three more lists are
  reported but not gated:
  - `pass → compile_timeout`, a runner-load flake (same rule as the edition
    ratchet's host lane, #1192);
  - tests new in the run;
  - tests removed from it.

  Both runs are restricted to the edition's path set, so a full-corpus
  baseline can serve.
- CLI: `paths --out <file>`, and
  `report --results <jsonl> [--baseline <jsonl> --baseline-meta <json>]
  --summary <md> --json <out>`.
  - The baseline must match the run's edition, test262 revision and eval
    engine. On a mismatch, or with no baseline at all, the summary says
    **"no baseline — not compared"** and the step exits 0. It never prints
    "no regressions" in that case.
  - With a baseline, exit 1 when there is a regression, otherwise exit 0.

**Workflow (`.github/workflows/test262-sharded.yml`), one job generalised,
no copied body:**

- `compiler-path-measurement-plan`:
  - The inline program (between `IR_MEASUREMENT_PLAN_START`/`_END`, executed
    by `scripts/test262-ir-pages-artifacts.test.mjs`) now outputs
    `scope = edition | full`, `chunks`, `matrix`, `edition` and `artifact`.
  - `push` → edition. `schedule` and the `workflow_dispatch` measurement →
    full, still 102 chunks.
  - The config reaches it through env, read by a one-file sparse checkout.
- `test262-ir-measurement-shard`:
  - `matrix.chunk: fromJSON(plan.matrix)` and
    `TEST262_CHUNK_TOTAL: plan.chunks`.
  - One new step runs before `Run shard`, only when scope is edition. It
    writes the path list and exports `TEST262_PATH_FILTER_FILE` through
    `$GITHUB_ENV`.
  - The `Run shard` body stays byte-identical to the legacy job's (an
    existing test asserts this).
- `merge-ir-measurement`:
  - `--expected-shards` comes from the plan.
  - The full-corpus steps (report, edition classification, site run history)
    run only when scope is full.
  - In edition scope the job:
    1. picks the newest earlier IR measurement on main whose source commit is
       an ancestor of this one (edition or full artifact);
    2. writes the counts and the per-test diff to `$GITHUB_STEP_SUMMARY`;
    3. uploads the results plus `scope.json` as
       **`test262-ir-standalone-edition-measurement`**;
    4. fails the job (after the upload) when an edition test that passed in
       that baseline no longer passes.

**Consumers — distinct artifact name, chosen over a `scope` field.**

| Consumer | file:line | Effect |
|---|---|---|
| deploy-pages "Fetch separate completed IR standalone measurements" | `deploy-pages.yml:141-234` | Lists artifacts **by name** `test262-ir-standalone-measurement`, so an edition run is invisible to it by construction. The site's IR view, `ir/test262-standalone-editions.json`, `ir/runs/*` and the trend rows now come from the newest **full** (daily) run. Its comment "measured on every merge" is corrected. |
| `scripts/build-pages.js:494-511` | reads the files deploy-pages wrote | unchanged |
| website IR view (`website/components/t262-view-state.js:211`, `index.html:4694`, `report.html:2632`) | served files | unchanged; always whole-corpus |
| edition ratchet, floors, baselines repo | legacy lane only | never read IR artifacts |

A `scope` field would need every one of these readers to check it. The
distinct name needs none of them to change, and nothing can misread it. The
per-merge edition number is visible in the run's job summary and artifact.
Showing "ES5 on IR path as of <sha>" on the site is a follow-up; it is not
needed for correctness.

**Cost.**
- ES5 has 9,029 rows in the edition-ratchet baseline. The script's own count
  is in the Validation section below.
- A full IR shard runs about 520 files in 115–139 s, plus about 40 s of
  setup.
- At 8 chunks that is about 1,130 files and 4.5–6 min per shard: about
  45 runner-min per merge instead of about 300.
- Daily full: unchanged, 102 shards.

**Quality criterion.** No job body is copied and no second classifier is
written. The plan program stays a pure function of env, the scope logic is
unit-tested, and the report script is unit-tested on real runs. That
includes the regression → exit 1 case and the no-baseline case.

### Part B — merge-queue gate on IR × current edition, legacy lane daily (PLAN — awaiting owner approval)

**What the legacy run feeds today (facts, `test262-sharded.yml`):**

- `merge shard reports` (job `merge-report`, :2831) in `merge_group`, with
  `HOST_RAN` hard-false (:2901):
  - standalone high-water floor #2097 (:3078, deferred fail :3571);
  - per-edition ratchet (:3088-3150, `completed` ES5 is zero-tolerance);
  - standalone net guard #1897 (:3284-3393), tolerance **15**
    (`STANDALONE_REGRESSION_TOLERANCE`, :3329), diffing against the
    **latest promoted** `test262-standalone-current.jsonl` (:3359), not a
    per-SHA base;
  - stale-baseline guard (:3506).
  - The catastrophic guard #1668 (:3161), the compile-time guard and the
    host per-row gate are `HOST_RAN`-only, so they are dead today.
- `check for test262 regressions` (`regression-gate`, :3630): every diff step
  is `HOST_RAN == 'true'` (:3767, :3879), so it is a no-op in every event.
  The #3467 per-SHA cache writer `write-run-cache-bot` is `if: false`
  (:5444).
- `promote-baseline` (:4443) on push: on the #3448 HIT (:4545) it promotes
  the group's own JSONL to `loopdive/js2wasm-baselines`
  (`test262-standalone-current.jsonl`, `runs/index.json`) and to
  `benchmarks/results/test262-current.json`. That is the landing page and
  trend graph, plus the floor every later merge group diffs against.
- `baseline-floor-staleness-alert.yml:94` breaches when the floor is more
  than **25** test262-relevant commits behind main and auto-dispatches a
  heal.
- `refresh-baseline.yml:32` already runs a full legacy matrix **every 8 h**
  (cron `17 */8 * * *`) and promotes.

**Target model (owner, 2026-11-26):**

| Event | test262 work | Required checks' content |
|---|---|---|
| `pull_request` | none (unchanged) | `merge shard reports` / `check for test262 regressions` green-skip (unchanged) |
| `merge_group` | IR × current edition, 8 shards, on the merged tree | `merge shard reports` = IR edition gate: per-test pass → not-pass vs the baseline for `base_sha` fails; parked by auto-park with the regressed tests listed. `check for test262 regressions` stays a no-op. |
| `push` to main | probe `test262-ir-edition-group-<sha>`. HIT: nothing heavy, the group result *is* main's result for that SHA. MISS (direct push, doc-only group): run the IR edition measurement (Part A). | n/a |
| `schedule` (daily) + `workflow_dispatch` | full legacy matrix with `promote-baseline`, high-water floor, ratchet and #1897 guard; full-corpus IR measurement | not PR gates. A breach fails the scheduled run, and its summary names the regressed tests and the commit range / merged PRs since the previous daily run. |

**Single producer = the merge group.**
- `merge_group.head_sha` becomes the main SHA when the queue fast-forwards.
  #3448 already relies on this: push runs promote with zero legacy shards.
- The IR edition gate's baseline is resolved by `base_sha`, which is the
  predecessor group's head when groups are stacked (the #1956 path, :3877).
  It looks for `test262-ir-edition-group-<base_sha>`, then a push-produced
  edition artifact for that SHA, then the nearest first-parent ancestor that
  has one (at most 25 commits; covers doc-only groups, whose test262 tree is
  unchanged). Otherwise there is **no baseline**: the gate passes, and says
  so in its summary.
- Push therefore re-runs nothing in the common case: about 45 runner-min per
  merge instead of about 950.

**Edge cases:**
- **Several PRs in one group.** The diff is the batch's delta. Auto-park
  parks every member, as it does today (:3897-3902).
- **Edition config changed, or first run.** The baseline's `scope.json`
  edition differs, so there is no baseline (explicit notice).
- **test262 submodule bumped.** New files are listed as new and removed
  files as removed; neither is gated. A changed revision is noted.
- **Eval engine mismatch.** The baseline is not used (explicit notice).
- **Completed-edition rule.** The legacy ES5 ratchet stays as it is and runs
  daily. The IR gate is per-test against its own IR baseline (IR ES5 is
  about 20 %), never against that ratchet file.
- **`pass → compile_timeout`.** Listed, not gated (runner-load flake).
  Every other pass → not-pass parks.

**What is lost, stated plainly:**
- A legacy-lane or other-edition regression is **detected after the fact**
  (within about 24 h, or 8 h via `refresh-baseline.yml`), not blocked, and
  it is attributed to a commit range, not a PR.
- The #2097 floor and the #1897 net guard become daily audits.
- Landing-page numbers are "as of the last daily/8-hourly promotion".
- `baseline-floor-staleness-alert` must have its threshold re-based to time
  (more than 26 h), or it will breach after 25 merges per day.
- With the standalone floor promoted daily, the old staleness hazard
  disappears from PR gating: the daily guard diffs against the previous daily
  run, so a within-tolerance drop is attributed once, to that day's range.

**Runner-minutes per merge:** before about 652 (mg) + about 300 (push) ≈ 950,
with mg wall 96 min. After about 45 (mg) + about 1 (push HIT), with mg wall
about 10 min. Daily: about 950 once.

**Size.** Part B touches the required check's content, `promote-baseline`
triggers, the staleness alert and auto-park messaging. It should be its own
PR stacked on this one (`claude/ci-legacy-daily`), after owner sign-off.

## Validation (Part A, local, 2026-11-26)

- **Edition list.** `test262-edition-scope.ts paths` on the sandbox's test262 copy (its
  revision is not readable here: the copy has no git metadata)
  lists 9,174 ES5 files. The promoted standalone baseline (48,735 rows)
  holds **9,029 ES5 rows** by the same classifier, which equals the edition
  ratchet's ES5 `total`. Every one of those rows is in the list, and none is
  missing from it.
  - The 145 extra files are all under `test/intl402/`, which the runner's
    category walk does not discover. The filter is intersected with the
    runner's own discovery, so they are never run, and the per-merge run
    measures 9,029.
- **Report on real IR rows.** The baseline was the concatenated
  `irgap-n26{a..d}` IR results: 411 rows, all ES5. Three cases:
  - Candidate with one pass flipped to fail (and one fail to pass): exit 1,
    listing `test/built-ins/Object/create/15.2.3.5-1-1.js → fail` as a
    regression and one improvement.
  - Candidate identical to the baseline: exit 0, 0 regressions.
  - No baseline: exit 0, with "No baseline — not compared".
- **Ratchet after the classifier move.** On the promoted baseline it reports
  `ES5 9028 → 9029, OK`, so its classification is unchanged.
- **`fetch-baseline` against loopdive/js2.** The lineage walk and the
  artifact listing selected run 45788961847's full measurement. The download
  itself is blocked by this sandbox's proxy (artifact blob host), not by the
  script. CI uses the same `gh run download` that `deploy-pages.yml` already
  relies on.
- **Tests and checks.**
  - `scripts/test262-ir-pages-artifacts.test.mjs`: 57/57, which covers plan
    scopes, the matrix, the artifact names and the step conditions.
  - `tests/issue-7551-ir-edition-scope.test.ts`: 10/10.
  - Both workflow files parse (yaml 2.8.3).
- **Proven only by the first push to main after merge:**
  - the 8-shard edition run itself;
  - the per-shard wall time (estimated 4.5–6 min);
  - the first edition run's "No baseline" notice. Its nearest earlier
    measurement is a pre-#7551 full artifact without `scope.json`, so that
    run cannot compare. From the second merge on, it compares against the
    previous edition run.

## Review fixes, Part A (2026-11-26)

- **A1 (crash vs. regression).** `report` now exits **3** for "regression
  found", and only after writing the JSON report. Exit 2 is usage; anything
  else is a crash (1 = uncaught throw).
  - The workflow records `verdict = regression` only for exit 3 *with* a
    non-empty report. Any other non-zero exit is `crashed`, and fails in the
    step "Edition report did not complete (#7551) [infra]".
  - Auto-park's infra patterns now match a trailing `[infra]` (self-check
    cases: crash → no park, regression → park).
  - Test: a truncated baseline JSONL exits neither 0 nor 3 and writes no
    report.
- **A2 (dropped rows).**
  - On the same test262 revision, a baseline-passing test with no row in the
    run is a regression with status `missing`.
  - When the revision changed, such a test is listed as "Not comparable
    (test262 revision changed)".
  - The merge step validates edition runs with
    `--expected-paths-file <edition list>`.
  - The list is exactly what the runner registers: discovery
    (`TEST_CATEGORIES` and the file rule) moved, unchanged, from
    `tests/test262-runner.ts` into the dependency-free
    `tests/test262-categories.ts`, which the runner and the scope script both
    use.
  - ES5 now lists **9,029** files, equal to the ratchet's ES5 total. The
    earlier 9,174 included 145 `intl402` files the runner never walks.
- **Nits.**
  - The CLAUDE.md typo is fixed.
  - `listArtifacts` paginates.
  - The baseline revision is `test262Changed: {from, to}`, present only on a
    change, instead of an `"unknown"`/`""` sentinel.
  - The retry helper also recognises server and network failures from the
    artifact blob store, and clears a half-written `gh run download --dir`
    before retrying (tested).
  - The measurement upload has `overwrite: true`, so a re-run of failed jobs
    re-uploads.

## Delta review fixes, Part A (2026-11-26)

- **Tests a narrowed classifier drops.**
  - When the baseline measured the same edition, `compareEditionRuns` now
    checks every baseline row, not just today's path list. A baseline-pass
    test absent from both today's list and the run is a regression,
    `missing`, on the same test262 revision, and "not comparable" when the
    revision changed.
  - A full-corpus baseline cannot tell (it holds every edition's rows), so
    the check applies only to edition baselines.
  - Tested.
- **Non-comparable baselines are skipped, not final.**
  - `fetch-baseline --meta <scope.json>` walks the candidates nearest first:
    `baselineCandidates`, at most 5 downloads.
  - It skips any candidate that predates `scope.json` or differs in edition
    or eval engine, logs why, and takes the first comparable one.
  - "No baseline" now means no comparable measurement among those
    candidates.
  - Tested (`candidateRejection`).

## Delta review r3, Part A (2026-11-26)

- **Edition baselines rank first.** `baselineCandidates` returns every
  EDITION measurement in the window (nearest first, newest first per
  commit) before any FULL one. A weekly full artifact on a main tip is
  newer than that tip's edition artifact, and would otherwise exempt the
  next queue group from the dropped-test check. Tested: on the same sha, a
  newer full candidate and an older edition one → the edition one is
  chosen.
- **Escape hatch for a deliberate reclassification:**
  `scripts/test262-edition-reclassified.json`, a reviewed `{file, reason}`
  list read by `report`.
  - A listed test missing from the run is reported as "deliberately
    reclassified", not gated.
  - The PR that moves the test adds the entry. Its own edition measurement
    then lacks the test, so later merges are clean and the entry can be
    removed.
  - An entry without a reason is refused.
  - Tested. The file joins the test262 path lists.
