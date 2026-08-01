---
id: 3997
title: "compiler: scale bounded package compilation beyond Axios and Three.js"
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

# compiler: scale bounded package compilation beyond Axios and Three.js

## Problem

Compilation does not complete within the harness limit for:
- axios 1.16.1 index.js: over 120 seconds
- three 0.185.1 build/three.module.js: over 180 seconds

Add progress attribution and bounded compilation behavior so these can be optimized with a concrete front rather than an opaque timeout.

Reproduce: pnpm run dogfood:axios, pnpm run dogfood:three.

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
