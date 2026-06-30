---
id: 2871
title: "Conformance report page: standalone pass-rate toggle, mobile overflow, empty benchmarks, edition-scoped error patterns, standalone differential"
status: done
sprint: current
priority: medium
horizon: m
feasibility: medium
created: 2026-06-30
completed: 2026-06-30
task_type: feature
area: website, build
goal: standalone
related: [2860]
---

# #2871 — Conformance report page fixes (standalone toggle / mobile / benchmarks / edition error patterns / differential)

`website/public/benchmarks/report.html` (served at
`https://js2.loopdive.com/benchmarks/report.html`) had five gaps reported by
the stakeholder:

1. **No standalone pass-rate toggle.** The page only rendered the host (JS
   runtime) report. There is a parallel standalone (pure-Wasm) report with the
   same schema (`test262-standalone-report.json`, already deployed) that was
   not surfaced.
2. **"By Category" overflowed on mobile width.** The wide table (Distribution
   column) had no horizontal-scroll wrapper.
3. **Performance Benchmarks / Trends showed no numbers.** `latest.json` and
   `history.json` 404 on the live site: `build-pages.js` copied them only from
   `website/public/benchmarks/results/` (where they don't exist) instead of the
   canonical `benchmarks/results/` (where they do).
4. **Error patterns ignored the edition slider.** The "Error Patterns" section
   aggregated all failures regardless of the selected ES edition range, unlike
   the category table.
5. **No differential filter** for standalone-mode errors that don't exist in a
   JS host.

## Resolution

- **#3 (build pipeline):** `scripts/build-pages.js` now sources
  `latest.json`/`history.json` from canonical `benchmarks/results/` first
  (falling back to the public copy) so the deployed page can fetch them.
- **#2 (CSS):** the category table is wrapped in a `.table-scroll`
  (`overflow-x: auto`) container; a `max-width: 640px` media query trims body
  padding. The standalone toggle, differential note and root-cause issue-link
  styles were added.
- **#1 (standalone toggle):** `main()` builds a host view and a standalone view
  (when the standalone report is present) and renders a "Host mode /
  Standalone" segmented switch (choice persisted in `localStorage`).
  `renderConformance` was parameterized on a `view` object
  (`{ mode, report, editionsSrc, categoryEditions, fileResultsSrc }`) so the
  same renderer drives both. Standalone degrades gracefully where it lacks data
  (no per-file JSONL → no per-file drilldown; no per-category×edition file → the
  category table isn't edition-filtered).
- **#4 (edition-scoped error patterns):** a shared `computeAllowedCategories()`
  helper drives both the category table and the error-pattern section; the
  section re-renders on every `edition-change` and only counts failures whose
  category falls in the selected edition range.
- **#5 (differential):** in standalone mode the section renders the report's
  curated `root_cause_map` buckets (issue-linked). A "Standalone-only (not in
  JS host)" toggle filters to the host-dependency buckets — the failures that
  occur in pure-Wasm standalone mode but pass with a JS host (44 buckets → 9,
  ~20k of ~31k failures). A true per-file set-difference isn't possible yet: no
  standalone per-file JSONL is deployed (only the aggregate report); the
  curated root-cause classification is the best available differential.

## Files

- `website/public/benchmarks/report.html`
- `scripts/build-pages.js`
