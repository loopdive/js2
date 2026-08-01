---
id: 3998
title: "codegen: give UUID v1ToV6 a stable source-callable inventory owner"
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

# codegen: give UUID v1ToV6 a stable source-callable inventory owner

## Problem

UUID 14.0.1 dist/index.js fails because source callable v1ToV6 has no consistent exact top-level/compiler support inventory owner.

Establish a stable canonical owner for source callables that originate in package entry graphs.

Reproduce: pnpm run dogfood:uuid.

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
