---
id: 2107
title: "value-rep P4: standalone any-helper conformance on canonical tags (__any_strict_eq, __any_unbox_bool, $__any_to_string, __any_typeof)"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: host-independence
related: [2104, 2080]
origin: "2026-06-11 analysis program (report 02 phase P4); stub 08-E22"
---

# #2107 — consumer-side fixes deferred from P0

## Problem

The standalone any-helpers dispatch on stale tag assumptions even after
type-aware boxing (P0): `__any_strict_eq` bails on tagA≠tagB so `0 === -0`
fails across the i32/f64 tag pair (#1987 residue), `__any_unbox_bool` has
no tag-5 string-length arm, `$__any_to_string` lacks the refval string
branch, `__any_typeof` lacks tag-5/6/7 arms.

## Root cause

src/codegen/any-helpers.ts:384-443 / 887-1000 / 1076-1163 and
native-strings.ts:5480-5586 — helper bodies written against the old tag
world.

## Fix direction

Per the value-rep spec P4: rewrite the four helper bodies against the
canonical JsTag module (#2104). Coordinates with coercion-engine Step 3
(the engine owns operator ENTRY points; P4 owns the helper BODIES).

## Acceptance criteria

- Standalone: 0===-0 true across tags, any-boxed "" falsy, typeof correct
  for all 8 tags, String(any) correct for every tag
- Host mode unchanged; the 8 probe tables from the spec's guardrail
  section pass in the standalone lane

## Dupe check

P0 issues (#2072/#2080) cover boxing only; helper conformance is the
deferred consumer half. New (analysis program).
