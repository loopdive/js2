---
id: 2108
title: "coercion drift gate: scripts/check-coercion-sites.mjs — no 9th hand-rolled ToString"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: compiler
language_feature: compiler-internals
goal: correctness
related: [2089]
origin: "2026-06-11 analysis program (report 03 §5); stub 08-F23"
---

# #2108 — drift continues during normal sprint work

## Problem

Nothing stops a ninth ToString copy: the June inventory found the §7.1.17
ToString matrix hand-rolled 7×, and an in-flight fix branch added a fresh
inline ToNumber matrix WHILE the analysis ran — live proof that drift
continues under normal sprint pressure until a gate exists.

## Root cause

The coercion vocabulary (`__extern_toString`, `__any_to_f64`,
`__host_loose_eq`, number_toString emission, …) is callable from anywhere.

## Fix direction

Per plan/log/analysis-2026-06/03-coercion-engine-spec.md §5: grep-count
baseline of coercion-vocabulary uses OUTSIDE src/codegen/coercion-engine
.ts; growth fails CI (`quality` job), `--update-on-decrease` banks
migration progress; engine internals become non-exported once Step 1
seals the vocabulary. Lands AFTER coercion Step 1.

## Acceptance criteria

- Gate live; a synthetic out-of-engine `number_toString` call fails CI;
  migration steps shrink the baseline automatically

## Dupe check

The engine itself is the upstream 1917 slug (+ amendment); the gate is
unfiled. New (analysis program).
