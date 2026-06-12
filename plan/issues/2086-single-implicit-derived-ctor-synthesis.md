---
id: 2086
title: "single implicit-derived-ctor synthesis shared by all three representation paths (externref / WasmGC struct / standalone)"
status: ready
sprint: 63
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: classes
goal: core-semantics
related: [1833, 2082, 2078, 2020, 2021]
origin: "2026-06-11 analysis program (report 05 §2a); stub 08-A1"
---

# #2086 — one rule, three drifting implementations

## Problem

The rule "implicit derived ctor forwards all args to super" is implemented
three times: externref path (class-bodies.ts:1263-1289, fixed by #1833),
WasmGC-struct path (:1292-1356, synthesized ZERO params until #2082's
point fix), and the standalone variant (zeroed base fields, #2078). Each
fix landed in one twin while the others stayed broken — the defining drift
pair of the June corpus.

## Root cause

`src/codegen/class-bodies.ts:1263-1356` — per-representation
re-implementation with no shared `synthesizeImplicitDerivedCtor(repr)`.

## Fix direction

Extract one synthesis function parameterized by representation; the three
paths become thin wrappers. Full analysis:
plan/log/analysis-2026-06/05-structure-review.md §2a.

## Acceptance criteria

- #1833/#2082/#2078 test suites all green from ONE implementation
- A deliberately-injected forwarding bug fails in all three lanes

## Dupe check

#1833 (externref fix, merged), #2082 (struct fix, merged), #2078
(standalone, suspended) are the point fixes; no issue owns the
consolidation. New (analysis program).
