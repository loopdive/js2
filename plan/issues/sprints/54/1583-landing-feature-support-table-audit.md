---
id: 1583
sprint: 54
title: Audit landing-page feature support table (ES editions section)
status: done
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: docs+ui
area: landing-page
goal: trustworthy-conformance-reporting
---

# Audit landing-page feature support table (ES editions section)

The landing page (https://js2.loopdive.com/, served from `index.html`) has a
"Compatibility" section with a feature support table grouped by ECMAScript
edition. Each row shows a green checkmark or a fraction like `5844/9130` next
to a feature name. Stakeholder questions:

1. How is the green checkmark computed? Does it mean ALL specific tests for
   this feature pass?
2. What do the fractions like `5844/9130` mean? Presumably passing/total
   counts.
3. Why does a feature with a fraction (not 100%) sometimes still display a
   green checkmark? What's the threshold?
4. Is the table updated automatically when test262 results refresh, or is it
   from a stale snapshot?
5. Expanded feature rows should link to the corresponding test262 source on
   GitHub.

## Acceptance criteria

- [ ] **Investigation report** committed at
      `docs/landing-feature-table-audit.md`: which JSON files feed the table,
      which functions compute per-feature pass counts, what the checkmark
      threshold is. Include actual line numbers in `index.html` and any script
      files.
- [ ] **Verify data freshness**: confirm whether the table reads from a file
      that's auto-updated. If it's stale, document the gap. (Note: PR #486
      just routed the headline pass rate badge through the baselines repo via
      raw.githubusercontent.com — the feature table likely still reads local
      files.)
- [ ] **Surface actual pass rate**: if the green checkmark threshold is not
      "100% pass", show the percentage next to the checkmark (e.g. "✓ 95%")
      to avoid misleading users.
- [ ] **Per-feature test links**: when a row is expanded, show the test262
      paths it covers and link to
      https://github.com/tc39/test262/tree/main/test/... for each.
- [ ] All changes committed on a new branch `fix-landing-feature-table-1583`,
      PR opened against main with description summarizing what was found and
      what changed.

## Files to inspect

- `index.html` — find the "Compatibility" / feature-support table section
  (search for "ES2015", "ES2016", "feature support" markers)
- `benchmarks/results/test262-editions.json` — per-edition aggregate (size
  ~kB)
- `benchmarks/results/test262-categories.json` — per-feature/category
  aggregate
- `scripts/generate-editions.ts` — likely produces `test262-editions.json`
- `dashboard/build-data.js` — possibly produces some feature aggregates

## Out of scope

- Improving the actual pass rates (that's compiler work)
- Redesigning the table layout (this is correctness + links only)

## Reporting

When done, leave a comment on the PR summarizing:
- What the checkmark threshold is (X% or 100%)
- Where the table reads its data from
- What you changed
