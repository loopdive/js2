---
id: 4450
title: "standalone: class ES6 semantics residual (~321 non-generator tests) — dstr params dominate (112), subclass (46), definition (36)"
status: ready
sprint: current
created: 2026-08-15
updated: 2026-08-15
priority: high
horizon: l
feasibility: hard
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [4444, 4447, 2158, 2175]
---

# #4450 — class ES6 standalone residual

## Problem

321 non-generator non-passing ES2015 standalone tests under
`language/statements/class` + `language/expressions/class`. Measured 2026-08-15
(`.tmp/es6-standalone-clusters.ts`, baseline_sha `734fab88`):

| ~Tests | Sub-bucket | Note |
|---|---|---|
| 112 | `class/dstr/*` | destructuring in class METHOD PARAMETERS — same lowering machinery as #4447 (for-of dstr). **Re-measure after #4447 lands before dispatching**; a large fraction should flip for free |
| 46 | `class/subclass/*` | builtin subclassing (`extends Array/Error/…`), super-construct semantics |
| 36 | `class/definition/*` | method/accessor definition semantics, `message should be an own property`, missing TypeErrors |
| 10+18 | `gen-method(-static)` + misc | generator methods — #2864's lane, skip |
| ~99 | elements / accessor-name / method(-static) / name-binding / restricted-properties | field-init `NaN vs undefined` (fn-name/NamedEvaluation family), computed accessor names, name binding TDZ |

Top error shapes: "Expected a TypeError but none thrown" (24+11),
`SameValue(«NaN», «undefined»)` (36 across both dirs — NamedEvaluation /
field-value reads), "Cannot destructure 'null' or 'undefined'" thrown when it
should be TypeError-with-different-message-shape or vice-versa (8).

## Direction (not yet a full plan)

1. **Wait for #4447's landing, re-measure `class/dstr`** — do not double-fix
   shared destructuring machinery.
2. Triage `subclass` (46): how much is blocked on #2158 ($ClassMeta prototype
   scaffolding) vs bounded super-construct fixes.
3. `definition` + NamedEvaluation buckets are likely bounded codegen fixes —
   slice them after triage.
4. Write the full `## Implementation Plan` (fable lane) before dispatching, per
   the plan/implement split.

## Acceptance

- Post-#4447 re-measurement recorded here; remaining sub-buckets fixed or
  re-attributed to #2158/#2864 with evidence, scoped-run measured
  (`TEST262_TARGET=standalone TEST262_PATH_FILTER="language/statements/class|language/expressions/class"`).
