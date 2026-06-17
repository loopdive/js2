---
id: 2145
title: "Generate plan/log/ir-adoption.md adoption table + bucket counts from source"
status: done
sprint: 63
created: 2026-06-12
updated: 2026-06-16
completed: 2026-06-16
priority: low
feasibility: easy
reasoning_effort: low
task_type: infra
area: tooling
language_feature: compiler-internals
goal: maintainability
related: [1923, 1530]
origin: "2026-06-12 sprint-62 architecture analysis (IR workstream N4)"
---

# #2145 — the hand-maintained IR adoption table is stale

## Problem

`plan/log/ir-adoption.md`'s header already declares the intent to generate
it, but the table is hand-maintained and drifts (e.g. #1372 is done but the
VariableStatement row still cites it).

## Approach

Script inspects `select.ts` rejection reasons + `from-ast.ts` switch arms
and emits the table; CI check (quality job) that the committed table
matches the generated one. Can absorb #1923's reporting surface.

## Acceptance criteria

- `pnpm run gen:ir-adoption` regenerates the table deterministically.
- Quality job fails when the table is stale.

## Notes

Routine dev, S-size, sprint 63.
