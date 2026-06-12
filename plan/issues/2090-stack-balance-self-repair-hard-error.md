---
id: 2090
title: "stack-balance self-repair must not invent values — null patch becomes a hard compile error"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: correctness
related: [2089]
origin: "2026-06-11 analysis program (report 04 §2a gap); stub 08-B5"
---

# #2090 — the repair pass masks the bugs it exists to catch

## Problem

The stack-repair pass patches unknown stack-type mismatches with a "safe
default" null value — masking the producing bug TWICE (once at the
producer, once in the pass that should have flagged it). Any module that
reaches this code has a real codegen bug that now ships as a silent null.

## Root cause

`src/codegen/stack-balance.ts:812`. Report 04 §2a marks it an uncovered
gap; §5 Phase 1 concludes there is no legitimate trigger.

## Fix direction

Convert to a structured hard compile error (with the producing function +
instruction context in the message). Can fold into #2089 Phase 1 or land
standalone.

## Acceptance criteria

- The null-patch arm throws a structured CE; full equivalence suite +
  playground examples still compile (proving no legitimate trigger)

## Dupe check

No issue covers the repair pass. New (analysis program).
