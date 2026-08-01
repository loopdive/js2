---
id: 3994
title: "compiler: bound recursive package graph traversal for TypeScript"
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

# compiler: bound recursive package graph traversal for TypeScript

## Problem

TypeScript 5.9.3 lib/typescript.js fails with: Codegen error: Maximum call stack size exceeded.

Use bounded or iterative work scheduling for recursive package graph traversal, or provide a structured diagnostic that identifies the recursion front.

Reproduce: pnpm run dogfood:typescript.

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
