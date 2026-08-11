# Landing page feature support table — audit (#1583)

This document explains what the "Compatibility" section on the
[landing page](https://js2wasm.loopdive.com/) shows, where its data comes
from, what its badges and fractions actually mean, and what was
changed to make it more honest.

## TL;DR

| Element | Means | Data source |
|---|---|---|
| `Edition features · synced from TC39` chips | Complete Stage-4 proposal membership for ES2016 and later, grouped by TC39's expected publication year. | `website/public/es-edition-features.json`, refreshed from TC39's `finished-proposals.md` during every Pages build. |
| Green `✓` / yellow `⚠` / red `✗` badge on a feature row | Live verdict derived from the feature's Test262 pass rate; the hard-coded glyph is only the no-data/offline fallback. | `website/public/feature-examples.json`, hydrated at runtime and baked into `index.html` after baseline promotion. |
| `N / T` fraction next to a feature name (e.g. `5844 / 9130`) | Live test262 pass-count for the listed `data-t262-paths`. Tone colour: green ≥ 90%, yellow ≥ 50%, red < 50%. | `public/benchmarks/results/test262-categories.json` (was 18 days stale prior to #1583); now also tries `test262-report.json` as the fresher fallback. |
| `NN%` bar in the section header (e.g. "ES2015 — 63%") | Live aggregate pass rate for that ES edition. | `public/benchmarks/results/test262-editions.json` (auto-refreshed every push to main). |
| Headline donut + pass-rate badge (top of page) | Live, fetched from the dedicated baselines repo (PR #486). | `https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-current.json` |

## 1. Source-of-truth files

The Compatibility section is rendered by markup hard-coded in
`index.html` (`#goals` → `<div class="feat-tables">`, lines
~1550–3190). Four pieces of dynamic data are layered on top via the
inline scripts at the bottom of the file:

| Script (search anchor) | Reads | Updates |
|---|---|---|
| `updateEditionPassBars` (~line 5150) | `./benchmarks/results/test262-editions.json` | The `NN%` bar in each `.feat-edition` section header. |
| `hydrateOfficialFeatureCatalog` | `./es-edition-features.json` | The complete TC39 Stage-4 membership chips for every ES2016+ edition section. |
| `hydrateFeatureCoverage` (~line 5198) | `https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-current.json` | The "feature areas implemented" stat (≥ 50% pass threshold). |
| `hydrateFeatureBadges` | `./feature-examples.json` | Per-row badge, `N / T` fraction, and the "View test results →" link in the expanded body. |

The hard-coded detail rows are intentionally a smaller, curated set with compiler examples. They are no longer the
edition membership list: `scripts/sync-es-edition-features.ts` parses TC39's canonical `finished-proposals.md` table,
writes `website/public/es-edition-features.json`, and the landing page renders the complete ES2016+ list above those
detail rows. `scripts/run-pages-build.mjs` refreshes that artifact on every Pages build and retains the committed
last-known-good copy when TC39 is temporarily unreachable.

## 2. What does the green checkmark mean?

It is now a computed Test262 verdict. Each `<div class="feat-row">` in `index.html` still ships with one of three
fallback badges:

```html
<span class="feat-badge full">✓</span>     <!-- author says: works -->
<span class="feat-badge partial">⚠</span>  <!-- author says: works with caveats -->
<span class="feat-badge none">✗</span>     <!-- author says: not supported -->
```

`hydrateFeatureBadges()` replaces that fallback from the live feature ratio: ≥90% is `✓`, a non-zero ratio below 90%
is `⚠`, and 0% is `✗`. Rows without an isolated Test262 population retain a neutral/manual fallback. The historical
audit below records the stale state before #2665 introduced this runtime derivation.

The former behavior caused the symptom the stakeholder asked about: rows like
`language/statements` ship a green `✓` while the live count next to
them reads `5844 / 9130` (= 64% pass). The user sees a green
checkmark and infers "this is fully supported"; the fraction tells a
different story.

### Audit of curated badges vs. real pass rates (May 2026)

Computed from `test262-categories.json` against the
`data-t262-paths` attribute on each row:

| Badge | Path(s) | Pass | Total | Pct |
|---|---|---|---|---|
| ✓ full | `language/statements` | 5844 | 9130 | 64.0% — misleading |
| ✓ full | `language/function-code` | 147 | 217 | 67.7% — misleading |
| ✓ full | `built-ins/Object` | 1855 | 3409 | 54.4% — misleading |
| ✓ full | `built-ins/String` | 701 | 1222 | 57.4% — misleading |
| ✓ full | `built-ins/Number` | 295 | 336 | 87.8% — close-ish |
| ✓ full | `built-ins/JSON` | 83 | 165 | 50.3% — misleading |
| ✓ full | `built-ins/Error,built-ins/NativeErrors` | 108 | 152 | 71.1% — misleading |
| ✓ full | `language/destructuring` | 16 | 18 | 88.9% — close-ish |
| ✓ full | `built-ins/GeneratorFunction,built-ins/GeneratorPrototype` | 15 | 84 | 17.9% — badly misleading |
| ✓ full | `language/block-scope` | 141 | 145 | 97.2% — accurate |
| ✗ none | `built-ins/Promise` | 433 | 637 | 68.0% — pessimistic |
| ✗ none | `built-ins/Set` | 268 | 383 | 70.0% — pessimistic |
| ⚠ partial | `built-ins/RegExp` | 1502 | 1879 | 79.9% — about right |
| ⚠ partial | `built-ins/Array` | 1391 | 3062 | 45.4% — about right |

The pattern is consistent: many rows that pre-date the live counts
were stamped `✓` to reflect "we support the basic case", not "all
test262 tests pass". Some rows (Generators, Promise, Set) are simply
out of date.

## 3. What is the fraction `5844 / 9130`?

This is rendered live by `hydrateFeatureRowCounts()` at
`index.html:5241`. For each `.feat-row[data-t262-paths]`:

1. Split the comma-separated paths in `data-t262-paths`.
2. For each path, look it up in `test262-categories.json` (depth-2
   path buckets emitted by `scripts/build-test262-report.mjs`).
3. Sum `pass` and `total − skip` across the listed paths.
4. Append `<span class="feat-row-counts">N / T</span>` to the
   `.feat-name`.
5. Pick a tone: `data-tone="pass"` (green) ≥ 90 %,
   `data-tone="partial"` (yellow) ≥ 50 %, `data-tone="fail"` (red)
   otherwise.

These thresholds (90 / 50) are independent from the static badge
classes (`full` / `partial` / `none`); they only colour the fraction,
not the badge.

## 4. Is the table updated automatically?

Mixed. Three different files feed the three live elements; only two
are auto-refreshed.

| File | Auto-refresh? | Refreshed by |
|---|---|---|
| `public/benchmarks/results/test262-editions.json` | Yes | `test262-sharded.yml` → `Commit small artifacts to main repo` step (every push to main). |
| `https://raw.githubusercontent.com/loopdive/js2wasm-baselines/main/test262-current.json` | Yes | `test262-sharded.yml` → `Push baseline artifacts to js2wasm-baselines repo` (PR #486). |
| `public/benchmarks/results/test262-categories.json` | **No (was stale)** | Generated by `scripts/build-test262-report.mjs` next to the report file, but the workflow promote step never copied it into `public/benchmarks/results/`. Last committed manually on 2026-05-03; landing page categories were therefore ~18 days behind the real pass rate. |

`test262-report.json` IS auto-refreshed every push and its
`categories` field contains the same data as `test262-categories.json`
— so we already had a fresh source on the page; we just weren't
reading from it.

### Fixes in this PR

1. **Promote `test262-categories.json` in CI.** Added an explicit copy
   step in `test262-sharded.yml`'s `promote-baseline` job so the
   standalone categories file lands in `public/benchmarks/results/`
   alongside the report file. The build script already emits it next
   to the merged report; only the copy/commit was missing.
2. **Read fresher source on the client.** `hydrateFeatureRowCounts()`
   now tries `test262-report.json` (auto-refreshed) first and falls
   back to `test262-categories.json` only if the report is
   unavailable. This means the per-row fractions are always at most
   one CI run behind reality, even if the categories file is briefly
   stale.

## 5. Per-feature pass-rate honesty

For every `.feat-row[data-t262-paths]` where the static badge says
`✓ full` but the live pass rate is below 95 %, we now append an
explicit `✓ NN%` percentage badge next to the checkmark so the
visitor sees that "supported" doesn't mean "every test262 test
passes for this feature":

```html
<!-- Before -->
<span class="feat-badge full">✓</span>
<span class="feat-name">for-in <span class="feat-row-counts">5844 / 9130</span></span>

<!-- After -->
<span class="feat-badge full">
  ✓<span class="feat-badge-pct" data-tone="partial">64%</span>
</span>
<span class="feat-name">for-in <span class="feat-row-counts">5844 / 9130</span></span>
```

The added percentage uses the same green/yellow/red tone the fraction
already uses. Rows where the live pass rate is ≥ 95 % keep the bare
checkmark — the green badge there is honest.

This is **non-destructive**: the original `feat-badge full` class
stays, and rows without `data-t262-paths` or without category data
keep the bare badge.

## 6. Per-feature test262 source links

When a feature row's `<details>` body is expanded, we now also render
direct links to the test262 source on GitHub for each declared path:

```html
<div class="feat-test262-paths">
  <span>test262 sources:</span>
  <a href="https://github.com/tc39/test262/tree/main/test/built-ins/Array"
     target="_blank" rel="noopener">built-ins/Array</a>
</div>
```

This is in addition to the existing "View test results →" link
(which points at the in-tree `feature-report.html` page).

## 7. Implementation summary (files changed)

- `index.html` — updated `hydrateFeatureRowCounts()` (~line 5241):
  - Tries `test262-report.json` first, falls back to
    `test262-categories.json`.
  - When the live ratio < 95 % and the badge class is `full`,
    appends a `.feat-badge-pct` tone-coloured percentage inside the
    badge.
  - Renders a `.feat-test262-paths` block inside the expanded
    `<details>` body with GitHub source links per path.
  - Adds matching CSS for `.feat-badge-pct` and
    `.feat-test262-paths`.
- `.github/workflows/test262-sharded.yml` — `promote-baseline` job
  now copies `test262-categories.json` from the merged-reports
  artifact into `public/benchmarks/results/` and stages it for the
  commit step.
- `docs/landing-feature-table-audit.md` — this file.

## 8. Open follow-ups (not in this PR)

- Auto-derive the static badge tone from the live ratio (would
  remove the curated badge entirely). Out of scope: the badges also
  encode intent ("this is the canonical compile path") that a raw
  pass rate cannot.
- Sweep the badges that this audit flagged as misleading (Generators,
  Promise, Set, etc.) and either flip them to `⚠` or document the
  caveat. Tracking task to be filed separately.
