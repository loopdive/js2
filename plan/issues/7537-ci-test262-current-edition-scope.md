---
id: 7537
title: "CI test262 scope: IR per merge measures the current edition only, legacy test262 leaves the merge queue, the site shows IR per edition"
status: in-progress
sprint: current
created: 2026-11-26
updated: 2026-11-26
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
goal: test-infrastructure
related: [3431, 3448, 3467, 1956, 2178, 6760, 7354]
---

# #7537 — CI test262 scope: current edition per merge, legacy off the queue

## Problem (project-lead decision, 2026-11-26)

1. The IR measurement runs the full corpus (102 shards) on every push to main.
   Per merge it should measure only the **current ES edition** (today ES5); the
   full corpus stays on the daily `schedule`.
2. The legacy standalone test262 matrix runs in `merge_group`. It leaves the
   queue and runs post-merge (push to main) and/or daily. The required contexts
   `merge shard reports` and `check for test262 regressions` must still publish
   a check run on every PR and merge group.
3. The website must show IR-only test262 numbers per ES edition, refreshed per
   merge for the current edition and daily for all editions.

## Measurements (2026-11-26, origin/main `a9cdc885`)

| What | Source | Value |
| --- | --- | --- |
| IR lane per push | run 45779984142 (push, `6694a8b`) | 102 shards, **295 runner-min** (avg 173 s; ~45 s fixed setup + ~128 s test work per shard); merge job 47 s |
| Legacy lane per merge-group attempt | run 45776708512 (merge_group, `6694a8b`) | 102 shards, **647 runner-min** (avg 380 s), wall ≈ 25 min; plus 2 provider builds ≈ 2 min |
| Legacy lane on the following push | run 45779984142 | skipped (#3448 probe HIT reuses the merge-group artifact) |
| Merge-group wall time, last 10 runs | runs 45769092415 … 45803974240 | 1 min (no shards) to 118 min |
| test262 files in checkout `b363f29d` | `walkTestFiles` + `classifyEdition` (`.tmp` probe, 0.65 s) | 53,575 files; **ES5 = 9,174 files** (17.1 %) |
| ES5 row in the published editions | live `ir/test262-standalone-editions.json` (`6694a8b`) and `scripts/test262-edition-ratchet-baseline.json` | **9,029 rows** (the 145 ES5-classified files the runner scopes as proposals land in the Proposals row) |
| IR ES5 today | same live file | 1,754 pass / 784 fail / 6,491 CE of 9,029 (19 %) |

The comment above `compiler-path-measurement-plan` says the IR matrix costs
"about 2 runner-hours"; the measured figure is 4.9 runner-hours.

### Per merge, before and after

| | Before | After, option A (legacy per push) | After, option B (legacy daily) |
| --- | --- | --- | --- |
| merge_group test262 shards | 102 legacy (647 runner-min per attempt; repeated on every group rebuild) | 0 | 0 |
| push: legacy shards | 0 on HIT, 102 on MISS | 102 (647 runner-min) | 0 |
| push: IR shards | 102 full (295 runner-min) | 16 ES5 (**≈ 49 runner-min, estimate**: 17.1 % of 218 test-min + 16 × 45 s setup) | 16 ES5 (≈ 49) |
| per merge, total | ≈ 942 runner-min + rebuild repeats | ≈ 700 | ≈ 49 |
| daily schedule | 102 IR full (295) | 102 IR full (295) | 102 IR full (295) + 102 legacy (647) |
| queue wall time spent on test262 | ≈ 25 min per entry | 0 | 0 |

**Recommendation: option A.** Per-merge attribution stays exact, the baseline
keeps advancing per SHA, and promote-baseline keeps working as today. Option B
saves ~650 runner-min per merge, but a daily red run then covers a day of
merges and needs a bisect. Lead decides.

## Why the site does not show the IR numbers

The data is published. `deploy-pages.yml` (step "Fetch separate completed IR
standalone measurements") downloads the newest `test262-ir-standalone-measurement`
artifact and the live site serves it: `test262-standalone-ir-status.json` reads
`measured`, source `6694a8b`, and `ir/test262-standalone-editions.json` carries
all 16 edition rows. Two things hide it:

1. **The IR view is gated behind a URL switch.** `website/components/t262-view-state.js`
   `bindIrToggle` hides the IR toggle unless the URL already contains `?ir`;
   only `?ir=1` selects it. Nothing links there.
2. **Main's committed IR status files are placeholders.** `benchmarks/results/test262-standalone-ir-status.json`
   and `test262-ir-status.json` say `unavailable` on purpose
   (`scripts/test262-compiler-path.test.mjs` "historical unavailable artifacts
   remain historical"); the deploy step overwrites the standalone one at build
   time. Reading main therefore shows "unavailable" while the site has numbers.
   Their `reason` text is stale (it still says the IR front door does not exist).

## Decisions the lead must acknowledge

1. **Completed-edition rule moves post-merge.** Today the ES5 rule (every ES5
   row passes on the legacy lane) blocks the merge in `merge shard reports`.
   After change 2 a legacy ES5 regression lands on main and is caught by the
   push run (option A: ~25–100 min after the merge) or the daily run
   (option B). Proposed handling:
   - The push run's `merge shard reports` fails as today: **red status on the
     main commit**. promote-baseline is skipped, so the floor does not move and
     every later push stays red until the regression is fixed or reverted
     (sticky by construction; the completed-edition check is absolute).
   - New job `post-merge regression alert` (push only, when `merge-report`
     failed): comments on the merged PR (number from the merge commit
     subject) with the failing gate, the regressed rows and the run link, and
     adds label `post-merge-regression` to that PR.
   - **Who reverts:** proposed: the lead opens a revert PR unless the authoring
     lane posts a fix-forward PR within 2 hours. Lead to confirm.
   - `baseline-floor-staleness-alert.yml` must not auto-heal over this: its
     auto-heal dispatches `refresh-baseline.yml`, which force-promotes, so
     after 25 lagging commits it would silently bank the regression. Change:
     when the newest completed push run's `merge shard reports` concluded
     `failure`, alert only, never auto-heal.
2. **Should the IR current-edition result gate?** Today it is informational
   (`promotion: false`). Option: run the 16-shard IR ES5 measurement in
   `merge_group` (~49 runner-min, ~5 min wall) and fail a group when an ES5
   row that passed in main's latest IR measurement stops passing. Not in this
   PR unless the lead says so; it would be a follow-up with its own plan.
3. **IR view default.** This PR makes the IR toggle always visible. Whether IR
   becomes the default view is a product call; proposed default unchanged
   (legacy standalone) until the lead says otherwise.

## What Session B loses (coordination thread loopdive/js2#6583)

- No test262 gate in the merge queue: a legacy conformance regression is no
  longer bounced before merge; it lands and turns main red.
- No `auto-park` hold for test262 failures (auto-park only sees merge_group).
- While main is red from such a regression, the legacy baseline and the
  published legacy numbers freeze until it is fixed or reverted.
- Per-merge IR numbers cover ES5 only; other editions refresh daily (the
  site's IR history was already one point per day).
- Merge-group runs no longer produce `test262-group-<sha>` artifacts, so
  anything reading them (the #3448 push reuse, #1956 predecessor diffing) gets
  a miss.
- Gains: ~25 min less queue latency per entry, no test262 rerun on group
  rebuilds.

## Implementation Plan

### Target structure

- **One configured value** — new `scripts/test262-current-edition.json`:
  `{ "edition": "ES5" }`. Advancing it is a one-line reviewed diff. Read by the
  manifest script below and by the plan job; the ratchet baseline is not edited
  (never edit `scripts/*-baseline.json`).
- **Edition selection reuses the classifier** — new
  `scripts/test262-edition-manifest.ts` (~40 lines): `--edition <label>|current
  --output <file>`; writes test-relative paths whose
  `classifyEdition(parseFrontmatter(f), "test/" + f)` equals the edition. It
  imports `parseFrontmatter`, `classifyEdition`, `editionStringToYear` and
  `walkTestFiles` from `scripts/generate-editions.ts` (export `walkTestFiles`;
  no second classifier, no second file walk). The output feeds the runner's
  existing `TEST262_PATH_FILTER_FILE` (exact-match set, filtered before shard
  balancing in `tests/test262-shared.ts`), so no runner change.
- **IR fetch for the site moves out of YAML** — the ~100-line inline
  `IR_MEASUREMENT_FETCH` program in `deploy-pages.yml` becomes
  `scripts/fetch-ir-measurements.mjs`, parameterised by artifact name, so the
  full and current-edition artifacts share one validated download path instead
  of a copy. `scripts/test262-ir-pages-artifacts.test.mjs` imports the module
  instead of slicing YAML.

### Change 1 — IR per merge: current edition only (`test262-sharded.yml`)

- `compiler-path-measurement-plan`: sparse-checkout
  `scripts/test262-current-edition.json`; outputs `run`, `scope`
  (`current-edition` on push, `full` on schedule and dispatch), `edition`,
  `chunk_total` (16 or 102) and `chunks` (JSON list). Fix the "2 runner-hours"
  comment with the measured figure.
- `test262-ir-measurement-shard`: `matrix.chunk: ${{ fromJson(needs.compiler-path-measurement-plan.outputs.chunks) }}`,
  `TEST262_CHUNK_TOTAL` from `chunk_total`. New step before "Run shard", only
  when `scope == current-edition`: run the manifest script and export
  `TEST262_PATH_FILTER_FILE`. Each shard computes the list from its own
  checkout (0.65 s, deterministic for the SHA), so no artifact hand-off.
- `merge-ir-measurement`: `--expected-shards` from `chunk_total`; the
  `IR_MEASUREMENT_ARTIFACTS` program adds `scope: { kind, edition? }` to status
  and every envelope. Artifact name: `test262-ir-standalone-measurement` (full,
  unchanged) or `test262-ir-standalone-edition-measurement` (current edition,
  14-day retention).
- Add `scripts/test262-current-edition.json` and
  `scripts/test262-edition-manifest.ts` to `&test262-paths`.

### Change 2 — legacy test262 off the merge queue

- Delete job `test262-shard-mg`, the `changes` step `mg_matrix` and its output,
  `scripts/gen-test262-mg-matrix.mjs` and `tests/issue-3431-mg-matrix.test.ts`;
  drop the path from `scripts/check-baseline-floor-staleness.mjs` and
  `tests/test262-per-lane-gating.test.ts`.
- `changes`, `runtime-eval-provider`, `temporal-provider`: drop the
  `merge_group` arms (they only fed the deleted matrix). `changes` keeps PR
  scope detection; its merge_group detect branch and
  `scripts/manifest-version-only.mjs` (merge_group-only consumer) are removed.
- `merge-report` (`merge shard reports`): stays `always()`; `SHARD_SKIP_OK`
  becomes true for every `merge_group`, so it publishes the no-op pass. It
  keeps running the full gate set on push. `needs` drops `test262-shard-mg`.
- `regression-gate` (`check for test262 regressions`): already a no-op
  (`HOST_RAN` is always false); only its `needs` changes.
- Option A: nothing else — `test262-shard` already runs on push; the probe now
  always misses. Option B: `test262-shard`, `merge-report` and
  `promote-baseline` gain a `schedule` arm and lose the push arm.
- New job `post-merge-regression-alert` (see decision 1), job-level
  `pull-requests: write`, `issues: write`.
- `baseline-floor-staleness-alert.yml`: no auto-heal while the newest push
  run's `merge shard reports` failed.

**Phase 2 (follow-up issue, id from the lead):** delete the now-dead
merge-group artifact hand-off — `mg-artifact-probe`, the HIT branches in
`promote-baseline`, the merge_group "Publish group results for predecessor
diffing (#1956)" step and their tests (#3448/#3467/#3611). Kept out of this PR
so the behaviour flip stays reviewable; the probe still answers correctly
(always MISS) meanwhile.

### Change 3 — the site shows IR per edition, kept current

- `scripts/fetch-ir-measurements.mjs` (moved from `deploy-pages.yml`): base =
  newest valid full measurement (status, report, categories, editions, daily
  history, as today). Overlay = newest valid current-edition measurement newer
  than the base: its row replaces the same edition's row in
  `ir/test262-standalone-editions.json`, carrying its own `sourceSha`,
  `measuredAt` and `runId`; the envelope keeps the base run's identity. An
  overlay older than the base is ignored.
- `t262-view-state.js`: the IR toggle is always visible (no `?ir` gate);
  `irMeasurementLabel` names the overlaid edition's source when it differs.
- `deploy-pages.yml` already redeploys on every completed `Test262 Sharded`
  run on main, so per-merge ES5 and daily full refresh need no new trigger.
- Placeholder `benchmarks/results/test262-standalone-ir-status.json`: reason
  text rewritten to say it is replaced at deploy by the latest measurement.

### Docs

- `CLAUDE.md`: the IR-migration paragraph ("the figure the site publishes and
  CI measures on every merge to main") → full corpus daily, current edition
  per merge; the per-edition ratchet section → enforced post-merge on push
  (or daily), with the red-main / alert / revert procedure; the merge-protocol
  notes that call `merge_group` the test262 gate.
- `docs/ci-policy.md` §3 and the required-checks table: `merge shard reports`
  is a no-op in `merge_group`; where the completed-edition gates now run.

### Tests

- New `tests/test262-edition-manifest.test.ts`: the manifest for an edition
  equals the set `generate-editions` buckets into that edition on a small
  fixture tree; `current` resolves through the config file.
- Update workflow-structure tests that pin the removed merge_group pieces:
  `tests/issue-4153-test262-sharded-pr-gating.test.ts`,
  `tests/test262-per-lane-gating.test.ts`,
  `tests/issue-5383-standalone-temporal-provider.test.ts`,
  `tests/issue-3451-linked-harness-lane.test.ts`,
  `tests/issue-3522-test262-shard-completion.test.ts`,
  `scripts/test262-ir-pages-artifacts.test.mjs` (plan selection: push →
  16-chunk edition scope, schedule → 102 full; fetch overlay cases),
  `scripts/website-ir-view-state.test.mjs` (toggle visible).
- `actionlint` on both workflows if available; a `workflow_dispatch` dry run
  only with the lead's approval.

### Acceptance criteria

- On push to main the IR lane runs 16 shards over exactly the files
  `classifyEdition` assigns to the configured edition; schedule runs 102 over
  the full corpus. Changing the config file to `ES2015` is the only edit
  needed to move the per-merge scope.
- A merge_group run starts no test262 shard, and both required contexts
  publish a successful check run on PR and merge_group events.
- A push run with a completed-edition regression fails `merge shard reports`,
  comments on and labels the merged PR, and does not trigger an auto-heal.
- The deployed `ir/test262-standalone-editions.json` carries the newest
  per-merge ES5 row and the newest daily row for every other edition; the IR
  toggle is visible without a URL parameter.
- **Code quality:** one edition classifier (no copy of the walk or the rules);
  one IR fetch path for both artifact kinds, as a tested module rather than
  inline YAML; no job, step or script left that only merge_group test262
  consumed, except the Phase 2 hand-off listed above; no new inline program
  in YAML longer than the plan job's existing one.
