---
id: 2101
title: "architect spec: class object model — constructor-as-value + prototype chain representation"
status: ready
sprint: Backlog
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: max
task_type: analysis
area: codegen
language_feature: classes
goal: core-semantics
related: [2023, 2026, 2020, 1991, 2071]
origin: "2026-06-11 analysis program (report 01 CLASS family); stub 08-D16"
---

# #2101 — classes have no runtime object identity

## Problem

Classes lower to flat structs + static dispatch with no constructor
function object and no prototype object: `new.target` is a constant-1 stub
(#2023), classes aren't first-class values (`new K()` on a param throws,
`.constructor` identity broken — #2026), inherited statics unreachable
through the subclass (#2020 fixed point-wise by lookup-walk), `in` cannot
walk a chain (#1991 fixed point-wise via key lists), ctor object-override
unrepresentable (#2071). 11 June issues share this root.

## Root cause

No representation decision for "class as value" or the prototype chain;
the upstream review grades WasmGC codegen C− but proposes no class-model
work — a review gap.

## Deliverable (spec only)

`## Implementation Plan` deciding: per-class runtime descriptor struct
(class-id + ctor funcref + parent ref + method table?) vs fuller prototype
objects; what each option makes representable (#2023/#2026/#2071
feasibility verdicts); cost on the static-dispatch fast path; migration
phases. The #1965/#2082 ctor findings and #2086's consolidation feed in.

## Dupe check

Member issues filed; no model-level owner. New (analysis program).
