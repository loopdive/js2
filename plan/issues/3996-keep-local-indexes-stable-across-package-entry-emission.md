---
id: 3996
title: "codegen: keep local indexes stable across package-entry emission"
status: ready
sprint: Backlog
created: 2026-07-30
updated: 2026-08-01
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: n/a
goal: dogfood
related: []
---

# codegen: keep local indexes stable across package-entry emission

## Problem

Packages:
- lodash 4.18.1 lodash.js: __cb_6
- redux 5.0.1 redux.mjs: observable
- moment 2.30.1 moment.mjs: normalizeObjectUnits

Failure: Binary emit error: RangeError: Codegen error: local index out of range — 19 (valid: [0, 15))

Derive local indexes from the final function layout after deferred imports, types, and import insertion.

Reproduce: pnpm run dogfood:lodash, pnpm run dogfood:redux, pnpm run dogfood:moment.

## Provenance

Migrated on 2026-08-01 from a GitHub issue on `loopdive/js2` (opened 2026-07-30)
that was created by an agent in error — this project tracks work as markdown
under `plan/issues/`, not as GitHub issues. The GitHub issue has been closed and
points here. **No content was dropped:** the Problem section above is the
original issue body verbatim.

Metadata below the title is newly assigned and is a **starting estimate, not a
measurement** — `priority`, `horizon` and `feasibility` were not stated in the
original and have not been validated against the corpus. Re-derive before
scheduling.
