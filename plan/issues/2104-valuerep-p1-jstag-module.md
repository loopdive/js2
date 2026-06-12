---
id: 2104
title: "value-rep P1: canonical JsTag module (src/codegen/value-tags.ts) + boxToAny consolidation with jsType hint"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: refactor
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2072, 2080]
origin: "2026-06-11 analysis program (report 02 phase P1); stub 08-E19"
---

# #2104 — tag policy needs a single home or P0 erodes

## Problem

After the in-flight #2072/#2080 type-aware boxing fix (P0), tag policy
still lives in scattered `__any_box_*` call sites: the canonical tag enum,
the `jsStaticType` classifier, the `UNDEF_F64` sentinel constant, and the
function tag have no single module — so the P0 fix can erode as new boxing
sites are added.

## Root cause

No `src/codegen/value-tags.ts`; `coerceType` carries no TS-type parameter
(~351 call sites get an optional `jsType?` hint per the spec).

## Fix direction

Per plan/log/analysis-2026-06/02-value-representation-spec.md P1: the
JsTag enum + classifier + `boxToAny(from, jsType)` API behind coerceType's
optional hint; all box sites route through it; tags 2/3 declared one
numeric class; invariant documented "tag = JS type".

## Acceptance criteria

- All `__any_box_*` emissions flow through the module; P0's tests stay
  green; a grep gate counts direct box calls outside it (ratchet)

## Dupe check

P0 = #2072/#2080 (in flight). The consolidation phase is unfiled. New
(analysis program).
