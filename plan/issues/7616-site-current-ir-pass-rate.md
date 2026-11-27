---
id: 7616
title: "The site shows a current IR test262 pass rate: the current edition after every merge, the full corpus daily"
status: in-progress
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
