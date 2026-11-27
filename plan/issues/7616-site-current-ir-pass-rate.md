---
id: 7616
title: "The site shows a current IR test262 pass rate: the current edition after every merge, the full corpus daily"
status: done
completed: 2026-11-27
created: 2026-11-27
updated: 2026-11-27
assignee: ttraenkler/site-ir-rate
priority: high
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci, test262, website
goal: ci-hardening
sprint: current
horizon: s
es_edition: ES5
related: [7551, 7207, 7568]
---

# #7616 — a current IR pass rate on the site

## Problem

Since #7551 the site's IR numbers come only from the full-corpus IR run, and
that run became weekly (owner decision 2026-11-26). The merge queue measures
the current edition (ES5) on the IR path on every merge, but its artifact
(`test262-ir-standalone-edition-measurement`) never reached the site. The
published IR pass rate was therefore up to a week old.

Owner decision 2026-11-27:

1. The site ALSO shows the merge queue's per-merge measurement of the current
   edition, so the number is fresh after every merge.
2. The full-corpus run goes back to DAILY ("once a day is enough").

## Implementation Plan

**Where it lives.** The artifact selection and validation that sat inline in
`.github/workflows/deploy-pages.yml` moves to
`scripts/test262-ir-site-measurements.mjs`, which the deploy step calls. Its
inputs (the `gh` and `git` calls and the file system) are injectable, so the
tests drive it with fixtures; this sandbox cannot download artifacts.

**What is reused / parameterised, not copied.**

- One loop, `dailyMeasurements(kind)`, lists, filters, downloads and keeps the
  newest valid measurement per day, for both artifact names. Per kind only
  the reader differs (`readFull`: the existing checks, unchanged;
  `readEdition`: the edition checks) and what a rejection does (full: fail
  the deploy, as before; edition: skip with a warning, because edition
  artifacts retained from before this change carry no `compilerPath`).
- `producingRun` (source run identity + the one producer job succeeded) is
  shared by both kinds.
- The edition row is counted with the same bucket function as every other
  edition row: `editionBucket` moves out of `scripts/generate-editions.ts`
  into `scripts/lib/test262-edition-bucket.mjs` and both import it
  (generate-editions output byte-identical, checked on the committed JSONL).

**Landed on main.** A measurement counts only when its commit is on main's
first-parent line in the deploy checkout (`git rev-list --first-parent HEAD`;
the checkout already has `fetch-depth: 0`). A merge-queue group's commit is
fast-forwarded onto main when, and only when, the group lands; a failed or
cancelled group's commit is never there. Chosen over the compare API: one
local call for every artifact, no rate limit, no 404 handling for commits of
deleted `gh-readonly-queue/*` branches, and the position on that line orders
measurements by commit. Applied to both kinds (a scheduled run measures the
main tip, so the full kind is unaffected).

**Edition validation** (same rigor as the full artifact): the producing run is
a completed `Test262 Sharded` run of this repository whose single
`merge complete IR standalone measurement` job succeeded (so a group that
failed its edition gate never counts); `scope.json` says `compilerPath: ir`,
`target: standalone`, `scope: edition`, `sourceSha` = the run's head SHA, and
the edition equals `scripts/test262-current-edition.json` AT THAT COMMIT;
`edition-report.json` names the same commit and edition; its row count equals
the report's total. `scope.json` gains `compilerPath` and `target` in
test262-sharded.yml so the artifact describes itself (metadata only; nothing
the queue runs or gates changes).

**What the page shows.** The full run supplies every file as before. When the
newest valid edition measurement is of a LATER commit (first-parent position)
than the full run, its row replaces that edition's row in
`ir/test262-standalone-editions.json`, carrying `scope: "edition"`,
`sourceSha`, `measuredAt`, `runId`; the envelope keeps the full run's
identity. The report page's IR provenance line names the full run's commit and
date, then the edition row's own. The edition history gains the edition runs'
points (newest per day), marked `scope: "edition"`; the trend draws such a
point only at its own edition's scope, where that edition is the whole
cumulative sum (`t262EditionScopeExtract`). With no retained valid edition
artifact, the output is exactly as before.

**Daily.** `test262-sharded.yml` cron back to `23 2 * * *`; every statement of
the weekly cadence that would now be false is corrected (workflows, scripts,
`docs/ci-policy.md`, `docs/releasing.md`, CLAUDE.md, test names, a note in
#7551's file).

**Code-quality acceptance.** No copied validation block: one loop, two
readers. No second status-bucket table. The deploy workflow holds no logic.

**Correctness acceptance.** Tests fail when: an edition artifact of a run that
did not land is accepted (or even downloaded); an edition measurement older
than the full run overrides it; a wrong-edition, wrong-commit, non-IR or
inconsistent artifact is accepted; a failed producer job is accepted; an
edition-only point is drawn at a cumulative scope it does not cover.

## Result (2026-11-27)

Implemented as planned (commit 381af36a5e).

- **Daily.** `test262-sharded.yml` cron `23 2 * * *`. Corrected every
  statement of the weekly cadence that is now false: test262-sharded,
  baseline-floor-staleness-alert, refresh-baseline, retry-test262-baseline,
  `scripts/check-baseline-floor-staleness.mjs`, `scripts/test262-last-full-run.mjs`,
  the queue's edition summary text (`scripts/test262-edition-scope.ts`),
  `docs/ci-policy.md`, `docs/releasing.md`, CLAUDE.md, test names, and a
  "superseded" note in #7551's file.
- **Not changed, deliberately:** the floor-staleness threshold stays 192 h. It
  was derived for the weekly cadence; with daily runs it cannot false-alarm,
  but it now alerts only after about a week of missed promotions. Tightening
  it (~24 h + 3.6 h jitter + ~4 h run time) is a separate owner decision.
- **Site.** `deploy-pages.yml` runs `scripts/test262-ir-site-measurements.mjs`.
  With no retained valid edition artifact its output is the same as the
  former inline step (the previous tests pass unchanged apart from the
  fixtures now naming the run's commit).
- **Tests.** `scripts/test262-ir-pages-artifacts.test.mjs` (69 pass) adds:
  landed newer edition run replaces the row with its own commit/date and the
  envelope and full-corpus score keep the full run's identity; a group that
  never landed is neither shown nor downloaded; an older edition run never
  overrides (but stays in the history); the newest landed commit wins over
  upload order; ten wrong-edition / wrong-commit / non-IR / pre-#7616 /
  inconsistent artifacts are refused with a warning; a failed producer job is
  refused; no edition row without a measured full run; newest per day.
  `tests/issue-7616-ir-edition-trend.test.ts`: an edition-only point is drawn
  only at its own scope. Each guard was removed once and the matching test
  failed (landed filter, newer-than-full check, configured-edition and commit
  checks, position ordering, the trend guard).
- **Pre-existing, unrelated failures** seen while checking neighbours (fail
  identically with the base `report.html`):
  `tests/issue-4362-test262-paths-compact.test.ts` (5) and
  `tests/report-error-patterns-edition-scope.test.ts` (1).
- **Not verifiable offline** (artifact download is blocked here): the first
  deploy after merge. The edition artifacts retained today carry no
  `compilerPath` in `scope.json`, so they are refused with a warning. This
  PR's own merge group already writes the new `scope.json`, so its edition
  row can appear on the deploy after it lands, once that group's run has
  completed (otherwise on the next deploy).
