---
id: 7457
title: "Fold the call planner's `reassigned` set and the script-binding writes query into one analysis"
status: ready
created: 2026-11-23
updated: 2026-11-23
priority: low
horizon: s
goal: ir-full-coverage
sprint: Backlog
related: [7354]
---

# #7457 — Fold the call planner's `reassigned` set and the script-binding writes query into one analysis

## Problem

Two analyses answer "is this function binding reassigned": the call planner's `reassigned` set in `imported-functions.ts` (shared with the ordinary pipeline) and `preparedBindingRewritten` in `src/ir/module-binding-script-var.ts`. After #7354 H2 the Prepared path's soundness depends on both agreeing. They agree on every write form the path lowers today.

## Acceptance criteria

- One analysis, used by the planner and by the Prepared queries.
- Ordinary-pipeline output byte-identical.

## Implementation Plan

Planned together with #7455: one binding-write index per source file. See
`## Implementation Plan` in `plan/issues/7455-open-object-home-name-based-whole-program-scan.md`. This issue is
slice 2 there: the planner's private write scanner in `src/ir/imported-functions.ts` is replaced by the shared
index, after a committed differential test lists and classifies every disagreement.
