---
id: 4000
title: "npm-compat: add a capability-explicit Node fs lane for Stylelint"
status: ready
sprint: Backlog
created: 2026-07-30
updated: 2026-08-01
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
language_feature: n/a
goal: dogfood
related: []
---

# npm-compat: add a capability-explicit Node fs lane for Stylelint

## Problem

Stylelint 17.14.1 lib/index.mjs is currently refused because Node fs capability is intentionally disabled.

Add a labeled opt-in Node fs compatibility lane and report it separately on npm-compat. Do not silently grant filesystem access in the default sandboxed lane.

Reproduce: pnpm run dogfood:stylelint.

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
