---
id: 4450
title: "standalone: class ES6 semantics residual (~321 non-generator tests) — dstr params dominate (112), subclass (46), definition (36)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-25
priority: high
horizon: l
feasibility: hard
task_type: conformance
area: codegen, conformance
es_edition: es6
goal: standalone-mode
related: [4444, 4447, 2158, 2175]
oracle-ratchet-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/literals.ts
loc-budget-allow:
  - src/codegen/class-bodies.ts
  - src/codegen/literals.ts
  - src/codegen/statements/control-flow.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/statements/control-flow.ts::compileReturnStatement
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

## Implementation Plan (2026-08-25)

1. **Re-measure and separate ownership.** Run the two class path filters on the
   branch base. Partition failures into parameter destructuring, subclass/super,
   definition/accessors, NamedEvaluation/name binding, generators, and
   reflection. Do not implement generator (#2864), reflection (#2158/#2175),
   or shared binding-pattern (#4447) machinery in this branch.
2. **Make class parameter handling consume the shared fix.** Inspect the
   `destructureParamArray` call sites in `src/codegen/class-bodies.ts` and
   `src/codegen/literals.ts`. Add only class-specific argument/local plumbing
   needed to reach the shared helper. If #4447 is not yet available, pin
   representative failing tests and leave the semantic helper change for the
   integration merge rather than forking it here.
3. **Fix NamedEvaluation as one reusable operation.** Trace anonymous
   function/class/arrow initializers in class fields and computed definitions.
   Ensure a missing explicit name receives the property/binding name exactly
   once, without overwriting an existing name, and that reading the initializer
   yields the initialized value rather than the current `NaN`/`undefined`
   carrier mismatch. Reuse the general naming path where possible; avoid a
   class-only metadata side table.
4. **Close definition/accessor ordering.** Verify computed keys are evaluated
   once and in source order, getters/setters are installed as non-enumerable
   own properties, duplicate definitions replace the correct half of an
   accessor pair, and abrupt key/value evaluation prevents later definitions.
   Work in `src/codegen/class-bodies.ts` and the existing class metadata helpers.
5. **Triage subclass construction.** For each builtin family, distinguish
   missing `$ClassMeta`/prototype infrastructure (#2158) from bounded
   `super()` behavior: derived `this` TDZ, exactly-once base construction,
   returned-object substitution, and new.target propagation. Implement the
   bounded common path; record exact files blocked by prototype scaffolding.
6. **Validate without cross-lane loss.** Add focused tests under
   `tests/issue-4450-*.test.ts`, run both class filters in standalone and GC,
   and report per-cluster before/after counts. Re-run after integrating #4447
   to measure the class/dstr gain rather than claiming it from a stale base.

Primary ownership: class lowering (`src/codegen/class-bodies.ts`, class-specific
parts of `src/codegen/literals.ts`) and focused tests. Do not edit TypedArray
machinery or the shared destructuring implementation without coordination.

## Scoped Implementation (2026-08-25)

This change takes one bounded definition/subclass slice while the shared
test262 runner is occupied by #4449:

- `resolveConstantExpression` now folds only the statically-falsy arm of `&&=`
  when collecting class computed names. This preserves the required no-write
  result (`let x = 0; [x &&= 1]`) while allowing the field/method definition to
  use the canonical property key.
- A derived class constructor with no lexical `super()` and a single
  checker-proven primitive return now emits the required TypeError. The
  existing ReferenceError path remains for fall-through, undefined returns,
  and other missing-super bodies; this avoids claiming a broader prototype or
  dynamic-return fix than was measured.

The implementation deliberately does not touch shared destructuring (#4447),
TypedArray lowering (#4449), generator methods, or Error prototype metadata.

## Test Results

- Before (branch base `ef5b5d335`): the computed logical-AND class-field probe
  returned `0`; the exact test262 file failed with `SameValue(«null», «2»)`.
- After: `tests/issue-4450.test.ts` passes 2/2 under standalone; the exact
  computed-key test passes in standalone.
- Before: `class/subclass/builtin-objects/Object/constructor-returns-non-object.js`
  failed with `Expected a TypeError but got a undefined` because the blanket
  missing-super ReferenceError path ran first.
- After: the exact Object subclass test passes in standalone, and the focused
  regression confirms the caught value is a TypeError instance.
- The full standalone/GC class filters are deferred because #4449 owns the
  shared test262 lock; no extrapolated rate or denominator claim is made here.

Remaining class residuals include shared parameter destructuring, broader
NamedEvaluation/accessor ordering, builtin Error prototype fallback, and
prototype metadata cases; these remain assigned to the plan's follow-up lanes.

## Acceptance

- Post-#4447 re-measurement recorded here; remaining sub-buckets fixed or
  re-attributed to #2158/#2864 with evidence, scoped-run measured
  (`TEST262_TARGET=standalone TEST262_PATH_FILTER="language/statements/class|language/expressions/class"`).
