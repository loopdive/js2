---
id: 3458
title: "fix(website): standalone edition conformance is per-edition, not cumulative — total mismatches js-host on the landing page"
status: done
sprint: current
priority: medium
horizon: s
task_type: fix
area: website
goal: maintainability
assignee: ttraenkler/dev-web
completed: 2026-07-19
---

## Problem

On the landing page, selecting an ECMAScript edition (e.g. ES2015) shows
INCONSISTENT total test counts between the two conformance lanes:

- **js-host ES2015**: Pass 19,785 / Fail 8,589 / CE 359 / total **28,734**
- **standalone ES2015**: Pass 10,238 / Fail 3,241 / CE 1,906 / total **15,386**

The same test262 corpus underlies both lanes, so at any edition scope the TOTAL
must be identical across lanes (within a tiny skip delta). It wasn't, because
the two lanes rendered with DIFFERENT aggregation semantics.

## Root cause

1. **js-host** uses the `<t262-edition-bars>` web component
   (`website/index.html` ~1733, `website/components/t262-charts.js`). It computes
   **CUMULATIVE** running totals through the selected edition
   (`t262-charts.js:1157-1173`, `cumulativeScopes` / `running` accumulator; UI
   copy "Showing cumulative conformance through …" at `t262-charts.js:1326`).
   So js-host ES2015 = ≤ES3 + ES5 + ES2015. This is the INTENDED behavior.

2. **standalone** used a SEPARATE inline path in `website/index.html`
   (`getStandaloneSummary` → `getStandaloneEditionSummary` /
   `standaloneData.editionBuckets.get(scope)`). This returned the
   **SINGLE-edition** bucket for the selected scope only (ES2015 bucket ≈ 15.4k),
   NOT the cumulative sum. THIS WAS THE BUG.

## Fix

Made the standalone edition path CUMULATIVE, mirroring the js-host widget. Added
`getStandaloneCumulativeEditionSummary(standaloneData, scope, strictOnly)` in
`website/index.html`, which sums `standaloneData.editionBuckets` for every real
edition (rank < 98, excluding Legacy/Deprecated + Proposals) at or below the
selected scope's rank, in the shared `featureEditionRank` order (the same
ordering `<t262-edition-bars>` uses via `T262_EDITION_SCOPE_RANK`). The
`getStandaloneSummary` edition branch now calls this cumulative helper first and
only falls back to the single-edition `getStandaloneEditionSummary` in the
degraded case where the standalone editions file is absent. The strict-mode
ratio scaling (`applySummaryRatios`) is applied to the cumulative SUM, not a
single bucket. The "overall" / "overall+proposal" scopes are unchanged (they
already use headline summaries and were correct).

## Verify

Cumulative totals computed from the committed
`website/public/benchmarks/results/test262-standalone-editions.json`:

| scope   | before (single bucket) | after (cumulative) | js-host |
| ------- | ---------------------- | ------------------ | ------- |
| ≤ ES3   | 274                    | 274                | ~274    |
| ES5     | 13,086                 | 13,360             | ~13.3k  |
| ES2015  | **15,386**             | **28,758**         | ~28,734 |

For ES2015 the standalone total now reads ~28,758 (≤ES3 274 + ES5 13,086 +
ES2015 15,398), matching js-host's ~28,734 within the tiny skip delta — instead
of the previous 15,386. Every edition scope's standalone total now agrees with
the js-host total.
