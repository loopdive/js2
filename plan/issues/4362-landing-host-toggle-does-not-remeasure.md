---
id: 4362
title: "Landing page: the JS-host toggle greys rows out but never re-measures them — feature counts, edition bars and edition trend all stay js-host"
status: done
completed: 2026-08-11
created: 2026-08-11
updated: 2026-08-11
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: website
goal: dogfood
sprint: current
related: [2636, 2910, 2914, 4137, 2928, 2929]
# id 4362 reserved via `claim-issue.mjs --allocate --allow-unscanned` on
# 2026-08-11 (gh CLI unavailable in the container; pr_scan=degraded).
# Equivalent open-PR scan via the GitHub MCP at reservation time: the sole open
# PR was #4369 (`ci/npm-compat-refresh`, an artifact-refresh branch that
# introduces no issue file), so the id universe was clean.
---

# #4362 — the landing page's "JS host" toggle does not re-measure anything

Follow-up to the eval/JS-host copy fix (PR #4370). That PR removed a wrong
`host` label from the `eval()` row; this one fixes the reason the label was
load-bearing in the first place.

## Problem

The landing page has a "JS host" toggle that is meant to switch the whole
conformance view between the JS-host lane and the standalone (host-free) lane.
It only really did that in one of the three places it appears to:

| Layer | Toggles? | Why |
| --- | --- | --- |
| Headline conformance donut + pass rate | **yes** | `hydrateConformanceEditionFilter` loads `test262-standalone-report.json` and applies `host_free_pass` |
| Per-edition pass bars in the feature list | **no** | `loadEditionBuckets()` unconditionally fetched `test262-editions.json` and memoised it; the toggle re-ran the render over identical numbers |
| Per-feature row badge / `N / M` chip / `NN%` | **no** | `hydrateFeatureBadges` read `feature-examples.json` once and never re-ran |
| Edition pass-rate-over-time chart | **no** | for a specific edition with the toggle off it set `points = null` and hid the chart outright |

So the toggle's only effect on the feature list was cosmetic: dim the rows
tagged `feat-host` and rewrite their badge to a red `×` (`scoreRow` also scores
them 0). Every number next to every other row kept describing the JS-host lane
while the page claimed to be showing standalone.

That is not a rounding-level discrepancy. Measured on `main` at the time of
writing, 64 of 88 feature rows differ between lanes, and the direction is not
always the one a reader would guess:

| row | js-host | standalone |
| --- | --- | --- |
| `eval()` | 158 / 357 (44%) | **332 / 357 (93%)** |
| `with statement` | 69 / 181 | **96 / 181** |
| `arguments object (full)` | **184 / 263** | 118 / 263 |
| `typeof / instanceof` | **42 / 59** | 36 / 59 |

`eval()` was understated by more than 2x in the mode where it does best — the
standalone interpreter provider (#2928/#2929) beats the JS-host meta-circular
path on `language/eval-code`.

## Fix

**Data.** `generate-editions.ts` gains `--feature-examples-out <path>`: the
standalone lane reads the host catalog and writes its host-free
`passCount`/`totalCount` to a **separate** file
(`website/public/feature-examples-standalone.json`) instead of being skipped.
Patching in place was never an option — it would overwrite the host counts and
show standalone numbers in *both* toggle positions, the same bug mirrored.

The twin is **slim** (name, `testCategories`, and the two counts). The host
catalog is ~4 MB, ~96% of it per-row `tests[]` failure lists that are
lane-independent; duplicating them would ship megabytes to convey ~20 KB of
differing numbers. Slim twin: 19.8 KB.

**Trend history.** `append-run-history.mjs` gains `--standalone-editions`,
writing `runs/standalone-editions-index.json` (same shape as the host
`editions-index.json`). `test262-sharded.yml`'s promote-baseline step now
generates the host-free edition buckets and feeds them in;
`deploy-pages.yml` fetches the new file.

**Page.** `loadEditionBuckets` is keyed by lane (memoised per lane, not
globally); `updateEditionPassBars` reads the toggle; `hydrateFeatureBadges`
becomes a re-appliable `applyFeatureBadges(hostEnabled)` that the toggle calls
*before* the host-row `×` override (order is load-bearing — it rewrites every
badge, so running it after would undo the override); the edition trend chart
reads the standalone series instead of hiding.

## Notes / deliberate limits

- **The standalone edition trend series is not backfilled.** No historical
  standalone edition snapshots exist, so the series starts empty and grows one
  entry per promote. `buildHistoryPoints`'s existing `< 2 points` guard keeps
  the chart hidden until there is something real to plot. It deliberately does
  **not** fall back to the host series — a host curve under a "standalone"
  label is exactly the class of quietly-wrong number this issue removes.
- **Pre-existing, not fixed here:** `editions-index.json` and
  `standalone-index.json` each hold exactly **one** entry on `main` today, so
  the host per-edition trend is itself barely renderable. The append pipeline
  works; it has simply run once. This issue does not change that, and the new
  standalone series inherits the same thinness.
- If `feature-examples-standalone.json` is missing (older deploy, or a local
  build that never ran the standalone pass) the standalone view keeps showing
  host numbers — the pre-#4362 behaviour, and strictly better than blank rows.
  Pinned by a test.

## Verification

- `tests/issue-4362-landing-host-standalone-toggle.test.ts` — drives the real
  `website/index.html` in jsdom with stubbed catalogs and asserts the chip,
  percentage and report link all follow the toggle and round-trip. Confirmed
  to **fail on the pre-fix page** (`expected '158 / 357' to be '332 / 357'`),
  so it is not vacuous.
- `tests/issue-4362-feature-examples-out.test.ts` — the twin gets the
  recomputed counts, the source catalog stays byte-identical, the twin is slim,
  and in-place patching still works when no out path is given.
- Ran the real generator over the fetched standalone baseline JSONL
  (48,735 entries): 51 tag-sliced, 29 path-scored, 8 headline-only rows.
