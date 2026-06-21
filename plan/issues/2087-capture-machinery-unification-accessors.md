---
id: 2087
title: "capture-machinery unification: object-literal accessors must use the canonical boxedCaptures ref-cell path"
status: ready
sprint: 64
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: closures
goal: core-semantics
related: [2011, 1999]
origin: "2026-06-11 analysis program (report 05 §2b); stub 08-A2"
---

# #2087 — parallel capture path captures copies

## Problem

Object-literal accessors build a parallel closure path that captures
COPIES — writes through accessors never reach the outer scope and
getter/setter pairs don't share state (#2011). Compound assignment on
captured strings diverged the same way (#1999, fixed point-wise). The
parallel path will keep breeding divergences until it's retired.

## Root cause

`src/codegen/literals.ts:299-528` parallel accessor-closure path vs the
canonical `ctx.boxedCaptures` ref-cell machinery owned by closures.ts
(threaded through 13 files).

## Fix direction

Migrate accessor closures onto boxedCaptures (one shared ref cell per
captured binding across all callbacks in a scope); delete the parallel
path. Subsumes the structural half of #2011. Senior-dev lane. Full
analysis: plan/log/analysis-2026-06/05-structure-review.md §2b.

## Acceptance criteria

- #2011's three repros match Node (shared getter/setter state, outer
  visibility)
- Single capture implementation; #1999 tests stay green

## Dupe check

#2011 is the symptom issue (stays open as acceptance vehicle); no issue
owns the machinery unification. New (analysis program).
