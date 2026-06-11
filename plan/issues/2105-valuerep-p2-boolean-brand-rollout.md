---
id: 2105
title: "value-rep P2: boolean brand rollout — ~20 producer + ~12 consumer sites onto {kind:'i32', boolean:true}"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2016, 2030, 2005]
origin: "2026-06-11 analysis program (report 02 phase P2); stub 08-E20"
---

# #2105 — the brand exists with one producer

## Problem

Bare-i32 booleans stringify as "1"/"0" wherever the TS-checker consult
can't see the boolean-ness (any receivers, synthesized results): #2016
hasOwnProperty, #2030 IteratorResult.done, #2005 residue — fixed
point-wise, but every new boolean-producing site re-breaks.

## Root cause

The ValType brand `{kind:"i32", boolean:true}` exists (#1788) with ~1
producer and 4 consumers; ≈20 producer sites (predicates, comparisons,
host-import results) and ≈12 consumer sites (stringify, concat, template,
join) never see it.

## Fix direction

Per the value-rep spec P2: brand all boolean producers; consumers branch
on the brand instead of per-site checker consults; fragile checker
lookups deleted.

## Acceptance criteria

- The #2016/#2030/#2005 test families pass from the brand alone (remove
  their point checks to prove it); truthiness contexts unchanged

## Dupe check

Point fixes merged; the rollout phase is unfiled. New (analysis program).
