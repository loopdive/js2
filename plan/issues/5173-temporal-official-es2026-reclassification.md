---
id: 5173
title: "Runner still classifies Temporal as proposal/official:false — ES2026 (17th ed.) shipped it on 2026-06-30"
status: done
sprint: current
created: 2026-08-29
updated: 2026-08-29
completed: 2026-08-29
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: test262-runner, ci
language_feature: temporal
goal: spec-completeness
es_edition: es2026
related: [4628, 661]
---

# #5173 — Temporal is ES2026, not a proposal; reclassify it in the runner

## Problem

Temporal reached Stage 4 at the March 2026 TC39 meeting and Ecma's General
Assembly approved **ECMA-262, 17th edition (ES2026) on 2026-06-30** with
Temporal in it — the edition's largest addition. Upstream test262 moved the
`Temporal` feature flag into the **"Standard language features"** section of
`features.txt` accordingly.

This repo's runner still says otherwise, in two places
(`tests/test262-runner.ts`):

- `PROPOSAL_FEATURES` (~L219): `["Temporal", "proposal feature: Temporal"]`
- `classifyTestScope` (~L263-264): the path-based rule
  `relPath.includes("built-ins/Temporal/")` →
  `{ scope: "proposal", official: false, ... }`

## What this distorts (and what it does NOT)

**Conformance counts are not wrong** — CI shard runs set
`TEST262_INCLUDE_PROPOSALS=1` (`test262-sharded.yml:877`,
`test262-differential.yml`, `refresh-baseline.yml:276`,
`test262-canary.yml:128`), so all ~4,611 Temporal tests run and are counted in
the overall baseline.

What IS wrong is the **official-edition accounting**: `official: false`
excludes the whole Temporal bucket from `official_summary` /
`official_pass` / `official_total` (`scripts/build-test262-report.mjs:1137-1146`,
`scripts/sync-conformance-numbers.mjs:116-122`,
`scripts/check-standalone-highwater.mjs:122,172`). Those numbers now claim
conformance against "official ECMAScript" while silently omitting ~4,611
tests of the published current edition.

Also fragile: any run WITHOUT `TEST262_INCLUDE_PROPOSALS=1`
(`workflow_dispatch` without the flag, ad-hoc local runs) silently skips a
published-edition feature.

## The fix

1. Remove `Temporal` from `PROPOSAL_FEATURES` and delete the
   `built-ins/Temporal/` path rule in `classifyTestScope`, so Temporal
   classifies as ordinary standard scope (`official: true`), like any other
   `built-ins/` path. Tag it `es_edition`-wise wherever the runner records
   editions.
2. **Regenerate `scripts/runner-bundle.mjs`** with the repo's build tooling
   (it embeds a copy of `classifyTestScope`, ~L62682) — never hand-edit the
   bundle.
3. **Handle the official-number drop deliberately — this is the load-bearing
   step.** Flipping ~4,611 tests with only ~200 passes into the official
   bucket drops the headline official conformance percentage by several
   points in one commit. Before pushing, enumerate every consumer that
   gates or floors on official numbers — `check-standalone-highwater.mjs`,
   baseline-floor checks, `sync-conformance-numbers.mjs`, dashboard
   badges/landing summaries — and reseed/adjust each floor in the SAME PR
   with the reason recorded, so the reclassification cannot read as a
   regression and trip a guard or park in the merge queue.
4. Audit for other now-stale entries while there: `import-defer` and
   `source-phase-imports` remain in `PROPOSAL_FEATURES` — verify their
   current TC39 stage against upstream `features.txt` (both were still in
   the proposals section as of the 2026-08-10 tip) and leave them if still
   proposals; record the check either way.

## Acceptance criteria

1. `classifyTestScope` returns `official: true` / standard scope for
   `built-ins/Temporal/**`, in both the runner and the regenerated bundle.
2. Temporal tests run regardless of `TEST262_INCLUDE_PROPOSALS`.
3. Official-summary consumers are updated in the same PR; the expected
   before/after official pass/total is stated in the PR body, with no
   guard tripping in the merge queue (or the specific reseeds called out).
4. The es_edition accounting (if any per-edition breakdown exists) attributes
   Temporal to ES2026.

## Notes

Found during #4628 (Temporal runtime-object work): the 2,206
`Temporal is not defined` failures are conformance gaps against the
published current edition, not a proposal — this issue makes the repo's
own metrics say so.

## Implementation notes (2026-08-29)

### 1. What changed, and why there

`tests/test262-runner.ts`
: `Temporal` dropped from `PROPOSAL_FEATURES`; the `built-ins/Temporal/`
  path rule deleted from `classifyTestScope`. Temporal now falls through to
  the ordinary `{ scope: "standard", official: true }` tail. The staging
  rule still runs FIRST, so `test/staging/Temporal/**` (3 files) stays
  `proposal` — that is correct and deliberate, staging is not a published
  edition regardless of the feature tag.

`scripts/generate-editions.ts`
: This is where the repo actually "records editions" — the runner itself
  has no edition field. Three edits, all in lockstep with the runner:
  `FEATURE_EDITION.Temporal` 2027 → **2026**; `Temporal` removed from
  `PROPOSAL_FEATURE_TAGS`; the `built-ins/Temporal/` line removed from
  `isProposalScopeByPath`. Without the last two, a Temporal file the
  results walk adds (one the lane never reported) would still be parked in
  the `Proposals` (-1) bucket while its reported siblings sat in ES2026.

`scripts/generate-feature-examples.ts`
: The landing-page catalog's `Temporal` row moved from the `Proposals`
  section to `ES2026`, and gained `testCategories: ["built-ins/Temporal"]`
  so the #2910 row reconciliation can actually score it (it read
  `passCount: 0, totalCount: 0` before, because a Proposals-edition row can
  match no ES2026-classified test).

`tests/report-error-patterns-edition-scope.test.ts`
: Comment-only. Its header asserted in prose that "Temporal is NOT in
  ES2026", which is now false. The mechanism it pins is unaffected — every
  Temporal path in that file is a **synthetic literal** carrying an
  explicit `scope: "proposal"`, so the tests exercise the filter without
  depending on how the runner classifies that path. Left as-is with the
  premise corrected; all 4 tests pass.

### 2. `scripts/runner-bundle.mjs` — DELETED, not regenerated

The plan said "regenerate it, never hand-edit it". Neither was the right
move, and the reason matters:

- **Nothing in the repo references it.** Not `package.json`, not a
  workflow, not another script. `scripts/{ts,js}config.json` explicitly
  *exclude* it.
- **No build recipe produces it.** `build:test262-cli` (the script the plan
  named) writes `dist/test262-fyi-cli.js` + `dist/test262-worker.js`, both
  gitignored. Its only commit in this repo's history is the initial import.
- **It was already stale on three independent axes**, which is the proof it
  is unmaintained: it still listed `upsert` as a proposal (removed in
  #837), its `Test262ScopeInfo` had no `strict` field (predates the
  strict-mode classification), and — the reason this issue found it — it
  still carried the Temporal path rule.
- **Its siblings are all gitignored build outputs.** `.gitignore` already
  lists `scripts/compiler-bundle.mjs`, `runtime-bundle.mjs`,
  `main-compiler-bundle.mjs`, `main-runtime-bundle.mjs`;
  `runner-bundle.mjs` is simply missing from that list, which is why an
  accidental commit stuck.

Regenerating would have committed a fresh ~2.4 MB whole-compiler snapshot
with no consumer, which would rot again on the next runner change — a new
instance of the same defect. Deleted, and added to `.gitignore` alongside
its siblings.

### 3. Measured official before/after

Source: `loopdive/js2wasm-baselines` JSONL, fetched fresh 2026-08-29
(`node scripts/fetch-baseline-jsonl.mjs --force` and
`ensureStandaloneBaselineJsonl({force:true})`), 48,735 rows each. Bucketed
by path on `built-ins/Temporal/` plus the 8
`built-ins/Date/prototype/toTemporalInstant/` tests, which carry
`features: [Temporal]` and so also flip.

| lane                     | official pass/total before | after                    |
| ------------------------ | -------------------------- | ------------------------ |
| JS-host                  | 34,547 / 43,621 (79.2 %)   | 35,141 / 48,232 (72.9 %) |
| standalone (host-free)   | 33,488 / 43,621 (76.8 %)   | 33,641 / 48,232 (69.8 %) |

Bucket detail: `built-ins/Temporal/**` = 4,603 rows (JS-host 594 pass /
4,009 fail; standalone 153 host-free pass). `toTemporalInstant` = 8 rows,
0 pass in both lanes. Total moved: **4,611**, matching the estimate.
`intl402/` is not in the corpus at all (0 rows), so the ~2.1k
`intl402/Temporal/**` files are not part of this delta.

The **full-corpus** totals do not move at all — 48,735 rows and 35,377
(JS-host) / 33,876 (standalone host-free) passes before and after. Only
the official/proposal split moves; `scope_summaries.proposal` shrinks from
5,114 to 503 rows.

### 4. Consumers audited, and what was reseeded

| consumer                                          | reads                                | action                                                                                       |
| ------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------- |
| `check-standalone-highwater.mjs` (the #2097 floor) | `full_summary.host_free_pass`        | **no change needed** — the gate keys on the FULL corpus, which this PR does not move          |
| `benchmarks/results/test262-standalone-highwater.json` | its own `official_pass`/`official_total` | **reseeded** 33,256 / 43,621 → **33,641 / 48,232**                                        |
| `README.md` standalone conformance line            | the mark's `official_*`              | regenerated via `pnpm run sync:conformance`: 33,256 / 43,621 (76.2 %) → 33,641 / 48,232 (69.7 %) |
| `sync-conformance-numbers.mjs` JS-host line        | `benchmarks/results/test262-report.json` `summary` | **left alone** — see below                                                     |
| `build-test262-report.mjs`                         | per-row `scope` / `scope_official`   | no change needed; the split is derived from the rows the runner emits                         |
| `check-baseline-floor-staleness.mjs`               | `baseline_sha` commit distance       | scope/official never read                                                                     |
| `diff-test262.ts` (regression gate)                | `file` + `status` (+ wasm sha)       | no change needed — see §5                                                                     |
| dashboard/landing edition timeline                 | `test262-editions.json`              | regenerated by `build:pages`; the ES2026 notch drops, which is the point                      |

Why the mark's `official_*` is reseeded but the committed **report** is
not: the report (`benchmarks/results/test262-report.json`) is rewritten by
`promote-baseline` on *every* push to main, so it self-heals within one
merge cycle and hand-editing it would mean fabricating a dozen derived
fields. The high-water mark's `official_*`, by contrast, is only rewritten
when the mark actually **ratchets** (`hostFree > markHostFree`) — on a flat
day it never does, so the stale 43,621 denominator would sit in README
indefinitely. Both reseeded numbers come from the same fresh standalone
baseline read, not from an estimate.

The mark's `pass` / `host_free_pass` (33,644) were deliberately **not**
touched: raising the ratchet is `promote-baseline --update`'s job, and the
current measurement (33,876) is above the floor either way.

### 5. Merge-group regression gate — neutrality verified, not assumed

`scripts/diff-test262.ts` contains **no** reference to `scope`,
`scope_official`, `includeProposals` or `include_proposals` (grepped). It
keys each row on `file` + `status`, with the #1222 wasm-sha noise filter.
This PR changes classification metadata only — no test's status moves, and
no row enters or leaves the corpus (the shard runs set
`TEST262_INCLUDE_PROPOSALS=1`, so Temporal ran and counted both before and
after). The catastrophic guard (#1668) and the #1897/#2097 standalone
guards all consume the same full-corpus figures. Expected merge-group
result: **zero** regressions, zero net change.

The one behavioural change is in the *other* direction and is the point of
the issue: a run **without** `TEST262_INCLUDE_PROPOSALS=1` no longer skips
Temporal. Verified directly with the env var unset — `built-ins/Temporal/`
and `Date/prototype/toTemporalInstant/` return `standard` / `official:true`
/ `skip:false`, while `staging/Temporal/`, `import-defer` and
`source-phase-imports` still return `proposal` / `skip:true`.

### 6. Audit of the remaining `PROPOSAL_FEATURES` entries

Checked against the vendored corpus's `test262/features.txt` on 2026-08-29.
That file has a `## Standard language features` header at L80 — everything
above it is a proposal, everything below shipped in a published edition.

| feature                | line | section                    | verdict                      |
| ---------------------- | ---- | -------------------------- | ---------------------------- |
| `source-phase-imports` | 40   | proposals                  | still a proposal — **KEEP**  |
| `import-defer`         | 46   | proposals                  | still a proposal — **KEEP**  |
| `Temporal`             | 249  | Standard language features | shipped — **REMOVED**        |

Both survivors confirmed still in the proposals section; no further
reclassification is due. Their runner scope is also independently
corroborated by the baseline: the 511 non-Temporal proposal-scope rows are
exactly `language/expressions/import.source` + `AbstractModuleSource`
(source-phase-imports) and `language/import` (import-defer).

### 7. Merge-queue park of PR #5209 (2026-08-29) — NOT caused by this change

PR #5209 was auto-parked. Two required checks failed in the `merge_group`
(run 33233874554): `merge shard reports` with **"Standalone root-cause map
has 24 unclassified failures; threshold is 0"**, and `check for test262
regressions` with **net −947 pass (35,377 → 34,430)**.

The working hypothesis at park time was that the reclassification pushed
~4.5k Temporal failures into the standard/official bucket and that 24 of
them had no root-cause classifier. **That mechanism does not exist**, and
the 24 are not Temporal:

- **The root-cause map is scope-blind.** In `build-test262-report.mjs`,
  `rootCauseRecords` collects *every* non-pass/non-skip standalone row —
  there is no `scope` / `scope_official` filter anywhere in the ingestion
  loop or the dedup. The `temporal-proposal` bucket matches on the **path**
  `built-ins/temporal`, not on scope. So no record can enter or leave the
  map because of this PR. Confirmed empirically: building the standalone
  report from the current main baseline gives **0 unclassified**.
- **The 24 are one codegen family, zero Temporal.** All 24 are
  `compile_error` with
  `stack-balance (#1058): function "…" reaches an instruction array from
  incompatible control-flow or function-local contexts. The repair pass
  refuses to mutate one shared body for all owners`:
  15 × `built-ins/Error/prototype/stack/**` (`makeNativeError`),
  7 × `harness/**` (`deepEqual-*`, `testTypedArray*`; `cacheComparison`,
  `__closure_69`), 2 × `language/expressions/instanceof/S15.3.5.3_*`
  (`__closure_61`). The family has **2,580** occurrences across the merged
  run and **0** in main's promoted baseline; the other 2,556 are absorbed
  by existing path buckets, leaving these 24 unowned.
- **This PR changes no compiler code.** `git diff --name-only` against main
  lists nine files: `.gitignore`, `README.md`, the high-water JSON, this
  issue file, two `scripts/generate-*.ts`, the deleted `runner-bundle.mjs`,
  and two files under `tests/`. Zero under `src/`, so the merged state's
  emitted Wasm is identical to main's.
- **Another PR reproduced it first.** PR #5199's `merge_group` run
  (33232469498, base `bdb19824b0`, ~40 min earlier, unrelated work) failed
  with the *identical* "24 unclassified failures" line and the *identical*
  `Net: -947 pass (35377 → 34430)`. Two unrelated PRs cannot share a net to
  the test — the −947 belongs to `main`. The regression job says as much
  itself: it printed a shared bucket signature plus a **BASELINE DRIFT
  WARNING** (baseline 6 test262-relevant commits behind main HEAD).

**No map change was made, deliberately.** Adding a bucket for a live,
unfixed codegen regression is functionally identical to raising the
threshold by 24: it turns the gate green while the 2,580 CEs stand. That is
the same accounting-laundering the strict `--max-unclassified-root-causes 0`
policy (#2961) exists to prevent, and the same defect class as
special-casing Temporal out of the official bucket — which is what this
issue removes. The unclassified gate is doing its job; the fix belongs with
the `#1058` stack-balance change on `main`, not here.
