---
id: 5105
title: "IR: own exact ambient Math.asin/Math.acos calls"
status: in-progress
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5105-ir-math-inverse-trig
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [5103]
related: [1371, 3204, 3526, 4787, 5092, 5094, 5101]
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5105-ir-math-inverse-trig.test.ts
loc-budget-allow:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5105 — Exact ambient `Math.asin` / `Math.acos` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.asin(numberExpression)` and `Math.acos(numberExpression)` calls in
otherwise IR-eligible synchronous functions. Represent both source calls as
versioned semantic intrinsics and reuse the existing host-free `Math_asin` and
`Math_acos` implementations plus their established `Math_atan` dependency.

This coherent inverse-trigonometry checkpoint is intentionally stacked on
#5108/#5103. It changes ownership only; the approximations and direct-codegen
fallback remain untouched.

## Measured residual

Neither method appears in `IR_MATH_METHOD_TABLE`, so the selector declines and
the legacy builtin path emits `Math_asin` / `Math_acos`. Both runtime bodies
already exist in `src/codegen/math-helpers.ts`, where requesting either method
materializes `Math_atan` before the derived helper. The missing contract is the
closed semantic intrinsic/provider graph.

## Exact admitted grammar

For each method, admit only `Math.<method>(argument)` when `Math` is the
unshadowed ambient binding, there is exactly one non-spread argument, the
selector proves primitive `number`, symbolic Math helpers are available, and
the containing unit passes ordinary ownership/call-graph gates. Aliased,
computed, shadowed, coercive, spread, and wrong-arity forms remain direct.

## Implementation plan

1. Add `math.asin` and `math.acos` to the closed intrinsic/runtime-feature
   vocabularies with unary-f64 signatures.
2. Add `selfhost.math.asin -> Math_asin` and
   `selfhost.math.acos -> Math_acos`; declare `math.atan` as the dependency of
   each provider.
3. Add both methods to `IR_MATH_METHOD_TABLE` and reuse the generic selector,
   call-graph walker, from-AST emitter, manifest, and provider materializer.
4. Add independent `JS2WASM_IR_MATH_ASIN=0` and
   `JS2WASM_IR_MATH_ACOS=0` rollbacks so either claim can be withdrawn alone.
5. Widen #3526 exhaustive vocabulary, dependency, integration, linear-legality,
   and neutrality evidence from fourteen to sixteen source Math intrinsics.
6. Add focused host/standalone, provider-closure, numerical-parity, rollback,
   and pre-claim exclusion tests for both methods.
7. Run focused suites, TypeScript 7, formatting/lint/ratchets, full pre-push
   checks, then push and open a non-draft PR stacked on #5108.

## Acceptance criteria

- Exact ambient one-number `Math.asin` and `Math.acos` calls emit IR only and
  attach the existing self-hosted callables.
- The manifest closes both features over exactly one deduplicated `math.atan`
  provider and requests no host capability.
- Host and zero-import standalone execution match the direct path across
  domain boundaries, finite values, NaN, infinities, and signed zero.
- Each rollback withdraws only its corresponding method.
- Excluded shapes decline before claim without invariants or post-claim errors.
- Affected #3526 suites, TypeScript 7, and all pre-push gates pass.

## Non-goals

- General ToNumber coercion, aliases, computed/extracted calls, `.call`, or
  `.apply`.
- Another Math-table expansion, a new inverse-trig approximation, host import,
  or direct-codegen behavior change.
- Async, class, module-init, or multi-source ownership expansion.

## Risk and rollback

The principal risk is dependency or source-identity drift. Both semantic
features must depend on `math.atan` without duplicating its provider, while the
shared table remains the sole grammar contract. Independent environment flags
provide narrow checkpoint rollback; `JS2WASM_IR_FIRST=0` remains the global
control.
