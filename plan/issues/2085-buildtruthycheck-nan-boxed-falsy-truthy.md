---
id: 2085
title: "array HOF predicate truthiness: buildTruthyCheck treats NaN and boxed 0/'' as truthy — contradicts ensureI32Condition's own spec matrix"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2080]
origin: "2026-06-11 coercion-engine analysis (fable agent): code-derived divergence, found during site inventory"
---

# #2085 — second hand-rolled ToBoolean disagrees with the first

## Problem

`buildTruthyCheck` (src/codegen/array-methods.ts:5121) — the truthiness
test used by array HOF predicate results (filter/find/some/every style
callbacks returning non-boolean values) — treats `NaN` and boxed `0`/`""`
as truthy, contradicting §7.1.2 ToBoolean AND the compiler's own
`ensureI32Condition` implementation (src/codegen/index.ts:11696), whose
spec-comment matrix it fails to match.

Expected repro shape (verify when claiming):

```ts
[1, 2, 3].filter((x) => NaN as any)        // wasm keeps all, node keeps none
[0, 1].find((x) => (x as any))             // boxed-0 predicate result truthy
```

## Root cause

Duplicated ToBoolean lowering: `buildTruthyCheck` is an independent
hand-rolled copy that drifted from `ensureI32Condition`. Exactly the
drift class the coercion-engine consolidation
(plan/log/analysis-2026-06/03-coercion-engine-spec.md, Step 4) retires —
fix is either a one-off correction now or absorption into the engine's
emitToBoolean.

## Acceptance criteria

- Repro shapes match Node; predicate truthiness identical to `if (v)`
- buildTruthyCheck and ensureI32Condition agree (ideally one
  implementation)

## Dupe check

#2080 covers any-boxed empty-string truthiness in ensureI32Condition's
helper (standalone); this is the SEPARATE array-methods copy. Found
during the 2026-06 coercion-site inventory; no existing issue. New.
