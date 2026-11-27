---
id: 7537
title: "test262 after #7551: legacy ES5 on every push with label-and-alarm attribution, compile timeouts gated only when repeated, daily full run, IR as the site's default view"
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
related: [7551, 7552, 7558, 7354, 2178, 6760, 2547]
---

# #7537 — the delta left after #7551

## Scope

#7551 (PRs #7518, #7523) already put these on main:

- the merge queue's IR × current-edition gate (ES5, 102 shards);
- the reuse of the queue's measurement on push;
- the weekly full run;
- the alert-only staleness rule.

This issue covers the owner decisions of 2026-11-27 that are not on main yet:

1. **A legacy run of the completed editions (ES5) on every push to main.**
2. **Post-merge attribution, phase 1.** This is label plus alarm only, for one
   week, with **no automatic revert**: the lead reverts by hand, and the
   false-positive count for that week is recorded. The owner decides on
   automation afterwards.
3. **Compile timeouts.** A pass → `compile_timeout` is not an immediate
   regression on either lane. It is listed, and **only a repeated timeout
   counts**. This amends #7551's "gate all" on the IR queue gate.
4. **The daily full run** replaces the weekly one.
5. **IR is the website's default view**, with the toggle always visible.
6. **The two IR placeholder status files** get accurate `reason` text.
7. **Docs:** `CLAUDE.md`, `docs/ci-policy.md` and #7551's issue text change to
   match.

Coordination: the #7354 lane owns `test262-sharded.yml` and the IR queue gate
(`scripts/test262-edition-scope.ts`). The changes to both are posted on
coordination PR #7526 before any code (planned-edits comment 7228266256; the
timeout amendment is posted separately).

## Measurements (2026-11-27, origin/main `4caef358`)

| What | Source | Value |
| --- | --- | --- |
| ES5 file list the gates use | `test262-edition-scope.ts paths` on test262 `b363f29d` | **9,029** files: the same classifier and set as the ratchet's ES5 row (`classifyTest262File`). My earlier 9,174 came from raw `classifyEdition` over every file, including proposal-scoped ones, and is not what any gate reads. |
| Legacy shard cost | run 45776708512, 102 standalone shards | avg 380 s per shard: ~45 s setup and ~335 s tests; ≈ 0.65 s per row |
| Provider builds | same run | runtime-eval provider 68 s, Temporal provider 67 s |
| Former daily cron `23 2 * * *` | 30 schedule runs, 2026-10-28 … 11-26 | started 08:33–12:40 UTC, i.e. 6.2–10.3 h late |
| Queue load by hour (UTC) | 100 merge_group runs, 2026-11-26 09:06 … 11-27 21:09 (36 h only) | 03–07 h: 3–6 groups/h; 08–12 h: 5–7; peak 19 h: 11; 21–02 h: 0–2 |

**Cost per test262-relevant push, an estimate, not a measurement:**

- tests: 9,029 rows × 0.65 s ≈ 98 runner-min;
- shard setup: 16 × 45 s ≈ 12 runner-min;
- provider builds: ≈ 2.3 runner-min;
- the re-check (section 2, step 4), only when candidates exist: ≈ 45 s of setup plus up to 60 s per watched row and about 1 s per other row, ≈ 2–4 runner-min;
- the predecessor wait: 0 normally, up to 45 runner-min when push runs overlap;
- total ≈ **112 runner-min** on a clean push, ≈ 7–8 min wall; more when there are candidates or a wait.

The full run then costs ≈ 940 runner-min per day instead of per week.

## Design

### 1. Legacy completed editions on every push

**Which editions:** the editions with `completed: true` in
`scripts/test262-edition-ratchet-baseline.json` (read only). Today that is
ES5. When the IR's current edition moves on, ES5 stays guarded. When ES2015
completes on the legacy lane, it joins automatically.

**Configuration:**

- One new field, `"completedChunks": 16`, in
  `scripts/test262-current-edition.json`, beside the IR's `chunks`.
- `test262-edition-scope.ts paths` gains `--completed`. It reuses
  `editionPaths` for each completed edition, so there is no second classifier
  or walk.

**Jobs in `test262-sharded.yml`.** Each gains a push arm: a non-bot actor, on
the existing `&test262-paths` filter.

- **`mg-artifact-probe`, `runtime-eval-provider`, `temporal-provider`:**
  without the eval provider about 667 ES5 rows fail by construction.
- **`compiler-path-measurement-plan`:** a second, separate step, "Select the
  legacy lane's scope". The IR program is untouched. It emits:
  - `legacy_scope`: `completed` on push, `full` on schedule and dispatch;
  - `legacy_matrix`;
  - `legacy_chunks`.
- **`test262-shard`:**
  - the matrix and `TEST262_CHUNK_TOTAL` come from the plan;
  - under `completed`, one step writes the `paths --completed` list and
    exports `TEST262_PATH_FILTER_FILE`, the IR shards' mechanism;
  - `max-parallel` 40 stays for the full scope.
- **`merge-report`:**
  - **under every scope:** merge, completeness, the per-edition ratchet;
  - **under `full` only:** the #2097 floor, the stale-floor report, the #1897
    guard and the commit-range step;
  - `promote-baseline` already admits only schedule and dispatch.
- **Push path filter:** add `scripts/test262-edition-ratchet.ts` and
  `scripts/test262-edition-ratchet-baseline.json`.

**Row-set artifact, every run, green ones included.** Every legacy run uploads
`test262-completed-edition-rows`: the completed editions' rows (file → status)
and the run's timeout watch list (section 3).

- **Retention:** 30 days.
- **Predecessor lookup:** `test262-edition-scope.ts fetch-baseline` gains
  `--artifact <name>`. It is the existing first-parent lineage walk and
  cross-run artifact lookup, now parameterised by artifact name instead of a
  copy. Today it is fixed to the IR edition/full pair.

### 2. Attribution, phase 1: label and alarm only

**Order of steps in `merge-report`.** These run on every legacy run (push and
daily), so both lanes judge rows the same way. The re-check result feeds the
ratchet; it is never a note beside it.

1. **Merge and validate** the shard JSONL, as today.
2. **Fetch the predecessor row set.** The predecessor is the nearest
   first-parent ancestor with a test262-relevant push or a full run.
   - While its run is still queued or in progress, the step polls every
     2 min, for at most 45 min. **That holds the `merge-report` runner for
     the wait** (worst case 45 runner-min, only when push runs overlap).
   - After that it falls back to the nearest **measured** ancestor, which
     widens the commit range. It never compares against an unfinished run.
3. **Candidates.** These are completed-edition rows that passed in the
   predecessor (a watched row counts as pass, section 3) and do not pass now.
4. **Re-check once.**
   - The candidates are re-run in the same job, with `TEST262_PATH_FILTER_FILE`
     set to just those rows and pool size 1, so there is no fork-pool
     contention.
   - Watched timeout rows (section 3) run with a raised compile timeout of
     60 s instead of 30 s. This adds a `TEST262_COMPILE_TIMEOUT_MS` input to
     the compiler pool's `timeoutMs`; the default is unchanged.
   - This needs the **full shard setup inside `merge-report`**:
     - the test262 checkout (already there for the classifier);
     - the compiler bundles;
     - the eval and Temporal provider artifacts.
   - That setup moves out of the two shard jobs into one composite action,
     `.github/actions/test262-runner-setup`, used by `test262-shard`,
     `test262-ir-measurement-shard` and both re-check steps. Today the bundle
     build and the provider downloads are written out twice.
   - The step is skipped when there are no candidates.
5. **Override.** Each re-checked row replaces its shard row in the merged
   JSONL, marked `recheck: true`.
   - This happens **before** the ratchet runs and before the row-set artifact
     is written, so a flake that passes on re-check cannot turn main red.
   - The daily run promotes the overridden JSONL.
6. **Ratchet**: the completed-edition check, with the timeout rule of
   section 3.
7. **Red.** If confirmed rows remain, `merge shard reports` fails: main is
   red. It stays red while those rows fail, because the completed rule is
   absolute.
8. **Attribute** (push only).
   - **PR set:** `prNumbersFromCommitSubjects`, auto-park's helper (not
     re-implemented), over `git log --first-parent <predecessor>..<sha>`. A
     queue push carries 2–5 merge commits.
   - **k = 1:** label that PR `post-merge-regression`.
   - **k > 1:** label all k `post-merge-regression-unattributed`. This
     includes the case where the step-2 **fallback widened the range** across
     unmeasured pushes. There is no bisect in phase 1; a per-merge-commit
     bisect is a phase 2 candidate.
   - **Repeated timeouts** are attributed to the PR set stored with the watch
     entry (section 3), not to this push.
9. **Comment and alarm.**
   - One comment per PR, idempotent through an HTML marker. It reuses
     `park()`'s marker-guarded comment and label calls in
     `scripts/auto-park-merge-group-failure.mjs`, extracted into one shared
     function instead of copied.
   - The list of regressed tests uses `scripts/lib/regression-annotation.mjs`'s
     annotation format.
   - **The comment holds:**
     - the confirmed rows;
     - the re-check flakes;
     - the run link;
     - the PR set;
     - whether the latest completed push run on current main still fails
       them;
     - the 24 h revert deadline.
   - One job-summary block goes to the lead, and one marker-guarded comment
     per incident goes on coordination PR #7526.
10. **Repeated failures.** A later push that finds the same rows still failing
    adds nothing. It labels only PRs that add new confirmed rows.
11. **Upload** the row-set artifact (section 1), green runs included.

**The lead reverts by hand, after a 24 h window** (owner, 2026-11-27: "Ja,
aber 24 h Frist").

- The labelled PR's author has 24 h from the label to land a fix-forward PR.
- When the window has passed and the latest completed push run on current
  main still fails the confirmed rows, the lead opens a plain revert PR
  through the queue.
- The comment states the deadline: the label time + 24 h, in UTC.
- In phase 1 nothing opens a revert PR automatically, and nothing reads a
  marker or a label to act on it.

**False-positive record.** The issue file gets a table, kept by the lead for
the week from the first labelled incident. Each row records:

- the date;
- the run;
- the PR set;
- the confirmed rows;
- whether it was real or a false positive, and why.

The owner decides on automation from that table.

**Permissions:** job-level `pull-requests: write` and `issues: write`, with
`GITHUB_TOKEN`. No deploy key and no app token.

### 3. Compile timeouts: listed once, then re-checked and attributed to the origin

**First sighting (both lanes).** A row that passed in the baseline and is
`compile_timeout` now is **listed, not gated**. It joins the measurement's
`timeoutWatch` list, carried in the run's artifact, as:

```
{ file, firstSeenSha, prs }
```

- `firstSeenSha` is the measured commit where it first timed out.
- `prs` is that commit's PR set: the queue group's PRs on the IR gate, or the
  push's first-parent PR set on the legacy lane.

**Later measurements.** A row on the baseline's `timeoutWatch`:

- **`pass` now:** resolved, and dropped from the list.
- **`compile_timeout` again:** **re-checked once with the raised timeout**
  (section 2, step 4).
  - If it passes, it stays on the list unchanged, as a flake.
  - If it still times out, it is a **confirmed repeated timeout**.
- **Any other non-pass now:** also a confirmed repeat. The timeout already
  hid this row's result at `firstSeenSha`, so this measurement cannot tell
  whether the current change caused it.

**A confirmed repeat never parks a queue group and never blames the current
push.**

- It raises the label and alarm of section 2 on the **originating** PR set,
  `prs`: `post-merge-regression` when there is one PR, `-unattributed`
  otherwise.
- That PR has already merged, so this is post-merge by construction.
- It then **leaves `timeoutWatch`** and is recorded in the artifact's
  `alarmed` list with its origin.
- The next baseline holds it as non-pass. It is therefore neither re-gated
  nor re-alarmed, and it stays a known failure until it passes again or the
  lead reverts.
- This is what prevents the wedge where P1 merges on a free first timeout and
  P2, P3 … are parked because their base is P1's measurement.

**Known limit, stated:** a group that genuinely breaks a watched row is not
parked for it, only alarmed against the originating PR. The lead triages from
the alarm.

**Where it lives:**

- The ratchet's existing per-row path already lists `pass → compile_timeout`
  without gating it (`test262-edition-ratchet.ts`, the `timeouts` bucket, L643
  and L683).
- That predicate and the watch-list transitions move to one small shared
  helper, `scripts/lib/test262-timeout-watch.mjs`:
  - `classify(baselineStatus, watched, nowStatus)` returns `pass`,
    `listed`, `recheck`, `regression` or `confirmedRepeat`;
  - `nextWatch(prevWatch, outcomes, origin)` builds the next list.
- The ratchet path and `compareEditionRuns` in `test262-edition-scope.ts` both
  use the helper.
- **IR queue gate:**
  - `EditionDiff` gains `timeouts` (listed) and `confirmedRepeats` beside
    `regressions`. Only `regressions` fails the report.
  - `merge-ir-measurement` runs the re-check with the same composite setup.
  - The artifact carries `timeoutWatch` and `alarmed`.
  - In merge_group, a confirmed repeat triggers the section 2 alarm on the
    originating PRs, not auto-park.
  - This amends #7551 B3 (L150 and L312 say "gated").
- **Legacy push lane and daily full run:** the completed-edition check reads
  the predecessor row-set artifact's `timeoutWatch` in the same way.

### 4. Daily full run

- **Cron:** `schedule` becomes `17 21 * * *`.
  - At the measured 6.2–10.3 h delay it starts around 03:30–07:35 UTC, when
    the queue ran 3–6 groups per hour, against 5–7 in the 08–12 window that
    the old 02:23 slot hit.
  - Minute 17 avoids the top-of-hour and half-hour rush.
- **Known limits:**
  - The delay was measured only at 02:23, and the queue profile covers only
    36 hours. The issue records the first seven starts at the new slot.
  - Scheduled runs are themselves delayed, so the run can land in a busier
    hour.
- **Staleness alert:** the threshold goes from 192 h to **48 h**: 24 h of
  cadence, 10.3 h of the worst measured delay, 4 h to promotion, about 10 h of
  slack. Operationally:
  - a red alert means no green full run has promoted for two days;
  - the landing-page numbers and the legacy baseline are older than that;
  - the lead dispatches `full_run=true`, after fixing whatever failed.
  - The alert never dispatches anything itself.
- **Wording:** "weekly" becomes "daily" in:
  - the workflow header and comments;
  - `baseline-floor-staleness-alert.yml` and `refresh-baseline.yml`;
  - `test262-edition-scope.ts`, `test262-last-full-run.mjs` and
    `check-baseline-floor-staleness.mjs`;
  - `docs/ci-policy.md` and `docs/releasing.md`;
  - `CLAUDE.md`.

### 5. IR as the website's default view

`website/components/t262-view-state.js`, `read()`:

- **IR view:** no `ir` parameter, or `?ir=1`.
- **Legacy view:**
  - `?ir=` or `?ir=0`;
  - `mode=host` (the JS-host lane has no IR measurement);
  - an IR status of `unavailable` (the page shows the status reason above
    the legacy numbers).

The rest of the file:

- `write()` drops the parameter for the default and writes `ir=0` for legacy.
- `bindIrToggle` always shows the toggle.

The inline early checks in `website/index.html` (line 6) and
`website/public/benchmarks/report.html` call `t262ViewState.read()` instead of
their own `URLSearchParams` test.

### 6. Placeholder reason text

`benchmarks/results/test262-standalone-ir-status.json` and
`test262-ir-status.json` keep `state: "unavailable"`; a test pins it. The
reason text says:

- **standalone:** "Placeholder: deploy-pages replaces it with the latest
  completed IR measurement";
- **host:** "The JS-host lane is retired; it has no IR measurement".

### 7. Docs

- **`CLAUDE.md`:**
  - the "goal is measured" paragraph;
  - the Test262 cadence block, with timeouts listed once and gated when
    repeated, and the daily run;
  - the edition-ratchet section: completed editions are checked on every push
    after the merge, with label and alarm, and the lead reverts by hand;
  - the baseline table: "as of the last green daily run".
- **`docs/ci-policy.md`:** §3, §10 and the gate table.
- **`plan/issues/7551-…md`:** a dated amendment note on B3 (timeouts) and the
  cadence.

## Tests

- **`tests/issue-7551-ir-edition-scope.test.ts`:**
  - `paths --completed` equals the completed editions' union, and a
    non-completed edition is excluded;
  - `fetch-baseline --artifact` selects by name;
  - the gate's report: a confirmed repeat is not in `regressions`, so it
    does not fail the group.
- **New `tests/test262-timeout-watch.test.ts`** (the shared helper):
  - first timeout: listed, with `firstSeenSha` and `prs`;
  - watched → pass: resolved and dropped;
  - watched → timeout → re-check pass: stays watched;
  - watched → timeout → re-check timeout: a confirmed repeat, moved to
    `alarmed`, origin kept;
  - watched → fail: a confirmed repeat;
  - a never-passed timeout: never listed;
  - an `alarmed` row is not re-alarmed in the next measurement;
  - the P1/P2/P3 sequence: P1 merges on a first timeout, and groups P2 and
    P3 are not parked; the alarm names P1.
- **`tests/test262-edition-ratchet.test.ts`:**
  - the completed-edition check uses the helper on a predecessor row set;
  - a `recheck: true` override that passes clears the row before the check.
- **New `tests/issue-7537-post-merge-attribution.test.ts`:**
  - k = 1 is labelled and k > 1 is labelled unattributed;
  - only new confirmed rows count, and a flake on re-run is not attributed;
  - the comment is idempotent through the marker;
  - while main stays red, the next push labels nothing;
  - waiting on an in-flight predecessor, and falling back to the nearest
    measured ancestor (mocked `gh`);
  - **a fallback that widens the range to k > 1 labels all of them
    unattributed.**
- **Workflow structure:**
  - the push arms: `tests/test262-per-lane-gating.test.ts`,
    `tests/issue-7551-job-skip-propagation.test.ts`,
    `tests/issue-5383-standalone-temporal-provider.test.ts`;
  - no promotion on push:
    `tests/issue-3611-promote-baseline-runs-on-hit-path.test.ts`;
  - the daily cron: `tests/issue-4350-baseline-refresh-cron.test.ts`,
    `scripts/test262-ir-pages-artifacts.test.mjs`.
- **`scripts/website-ir-view-state.test.mjs`:**
  - the default is IR;
  - `?ir=`, `?ir=0`, `mode=host` and an unavailable status give the legacy
    view;
  - the toggle is visible without a parameter.
- **Tooling checks:** `actionlint` if available; a `workflow_dispatch` dry run
  only with the lead's approval.

## Acceptance criteria

- **Push:** a test262-relevant push to main runs 16 legacy shards over exactly
  the 9,029 completed-edition files, builds the eval and Temporal providers,
  uploads the row set, and never promotes.
- **Attribution:**
  - a confirmed new completed-edition failure turns the push run red;
  - it labels the single PR (k = 1) or all k PRs as unattributed (k > 1);
  - it comments idempotently and posts one alarm on #7526;
  - a flake that passes on re-check is overridden in the merged JSONL before
    the ratchet, so it neither turns main red nor labels anything;
  - the comment names the 24 h deadline, and nothing reverts automatically.
- **Timeouts:**
  - a first pass → `compile_timeout` is listed and blocks nothing, on the IR
    queue gate and on the legacy lane;
  - a watched row that times out again and fails its raised-timeout re-check
    alarms its **originating** PR set and leaves the watch list;
  - it never parks a later group and never labels a later push.
- **Daily run:** the full run and promotion happen daily at 21:17 UTC, and the
  staleness alert fires after 48 h.
- **Website:** the site opens on the IR view, the toggle is always visible,
  and the legacy view is reachable and is the fallback.
- **Code quality:**
  - one classifier and one file-list writer (`paths`, extended);
  - one first-parent artifact lookup (`fetch-baseline`, parameterised);
  - one timeout helper (`scripts/lib/test262-timeout-watch.mjs`) shared by
    the ratchet and the IR gate;
  - one runner-setup composite action shared by both shard jobs and both
    re-check steps, removing today's duplicated bundle build and provider
    download steps;
  - auto-park's PR-set and comment/label logic, shared rather than copied;
  - the push lane reuses `test262-shard` and `merge-report` instead of
    parallel jobs;
  - no new inline program in YAML.

## False-positive record (phase 1, kept by the lead)

| Date | Run | PR set | Confirmed rows | Real / false positive, why |
| --- | --- | --- | --- | --- |
