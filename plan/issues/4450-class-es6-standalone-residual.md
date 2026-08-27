---
id: 4450
title: "standalone: class ES6 semantics residual (~321 non-generator tests) — dstr params dominate (112), subclass (46), definition (36)"
status: in-progress
sprint: current
created: 2026-08-15
updated: 2026-08-27
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
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/typeof-delete.ts
  - src/runtime.ts
func-budget-allow:
  - src/codegen/class-bodies.ts::compileClassBodiesInner
  - src/codegen/statements/control-flow.ts::compileReturnStatement
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/typeof-delete.ts::compileTypeofComparison
  - src/codegen/typeof-delete.ts::compileTypeofExpression
  - src/runtime.ts::resolveImport
---

# #4450 — class ES6 standalone residual

## Delivery regression repair (2026-08-27)

PR #5024's first upstream quality run exposed a host-import migration ratchet
failure: `runtimeTsLines` was 18,295 against the 18,275 maximum. The semantic
change was already green (2/2 focused host/standalone pins, 8/8 equivalence
shards, and issue tests), but the PR was not merge-ready with that quality
failure.

The class-own-key registry is now expressed without the redundant helper and
duplicated explanatory block. This preserves the separate static-method and
constructor-own-key registries—so `length`, `name`, and `prototype` cannot be
mistaken for writable static methods—while keeping `runtime.ts` at the 18,275
policy-counted-line ceiling after the branch's latest `main` merge.
`check:host-import-policy`, lint, formatting, typecheck,
and the 2/2 focused host/standalone tests pass locally. The repair must be
pushed to the existing standalone fix PR #5024; no separate PR is warranted
because it is a CI repair for that completed fix.

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
## 2026-08-27 Luna/max wave plan — static name/length precedence

The exact bounded slice is four ES2015 class-definition rows:
`fn-name-static-precedence.js`, `fn-name-static-precedence-order.js`,
`fn-length-static-precedence.js`, and `fn-length-static-precedence-order.js`.
The cached host and standalone baselines fail all four; the implementation
branch must establish fresh controls on the combined PR head.

1. Reduce class static `name`/`length` definition order and descriptor state
   without entering generator, parameter-destructuring, or subclass machinery.
2. Fix the shared class-definition metadata path so standard own properties
   exist before a static method of the same name replaces them, with observable
   key order and method value preserved.
3. Add permanent focused tests covering both names and both ordering cases.
4. Rerun the exact 4/4 rows in host and standalone and record exact evidence,
   losses, and any residual handoff before integration into draft PR #5010.

## 2026-08-27 implementation/results handoff — static name/length precedence

The bounded four-row slice is implemented on `codex/4450-es2015-class-meta-v2`
(base `114f8a95a`). The failures had two related causes: class objects use a
closed WasmGC carrier in standalone mode, so the native
`Object.getOwnPropertyNames` path returned no keys, while the host registry
tracked only static method names and omitted the constructor's standard
`length`, `name`, and `prototype` keys. In addition, static `name`/`length`
methods were hidden by compile-time `typeof` folding, and setter-only accessors
could be invoked by the host constructor-name stamp during class creation.

Implementation:

- Added class-specific metadata helpers for the constructor's standard own-key
  order and static method precedence.
- Lowered known-class `Object.getOwnPropertyNames` calls to the native
  standalone object-vector builder, preserving evaluation/TDZ side effects
  and returning `length`, `name`, `prototype`, then non-duplicate static keys.
- Applied the static-method function `typeof` override both to direct typeof
  expressions and to the `typeof` comparison-folding path.
- Made setter-only static `name`/`length` reads return canonical `undefined`;
  host class metadata stamping now leaves those accessor-owned keys alone.
- Extended the host class-object sidecar with the same ordered own-key list
  without changing the static-method descriptor/deletion registry.
- Added `tests/issue-4450-class-meta.test.ts` covering name and length methods,
  computed keys, exact own-key ordering, getter/setter behavior, and a static
  generator that must not execute while reading metadata.

Evidence:

- Fresh direct controls on the combined base: standalone `0/4`, host `0/4`.
- Focused permanent tests: `tests/issue-4450.test.ts` and
  `tests/issue-4450-class-meta.test.ts`: 4/4 passed.
- Fresh exact host command (`pnpm run test:262 --official-scope-only`, pinned
  QuickJS artifact, `COMPILER_POOL_SIZE=2`, four-file filter): run
  `20260827-043015`, report `benchmarks/results/test262-report-20260827-043015.json`,
  `4 pass / 4 total (100.0%)`.
- Fresh exact standalone command with the same controls: run
  `20260827-043237`, report
  `benchmarks/results/test262-standalone-report-20260827-043237.json`,
  `4 pass / 4 total (100.0%)`.

The official runner creates 16 local shard suites for this filter; twelve
empty shard files report Vitest's existing “No test suite found” diagnostic,
but the runner's authoritative scoped result is the four discovered rows and
reports 4/4 in each lane. A monolithic local-shard retry exceeded its 512 MB
heap before producing a report, so it is not used as evidence. No residual
diagnostic instrumentation is part of this checkpoint.

Handoff: commit and push the verified checkpoint from this worktree. The
parent agent should transplant the commit onto a clean `upstream/main`
delivery branch and open the upstream PR on `loopdive/js2`; this branch is
based on the combined PR head and is not itself a PR base. The broader #4450
class residual (destructuring, subclass/prototype, generators, and reflection
machinery) remains outside this slice.

After transplant onto clean upstream `fcded6410`, the focused regression files
passed 4/4 and the authoritative standalone runner was repeated on the final
delivery code. Run `20260827-045029` passed the exact four rows 4/4 with zero
failures, compile errors, compile timeouts, or skips. This clean-base result is
the final acceptance evidence for the ready checkpoint PR.
