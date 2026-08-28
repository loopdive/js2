---
id: 5111
title: "IR: own exact ambient Math.cbrt calls"
status: in-progress
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5111-ir-math-cbrt
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [5110]
related: [1371, 3141, 3204, 3526, 4787, 5092, 5094, 5101, 5103, 5105, 5106]
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5111-ir-math-cbrt.test.ts
loc-budget-allow:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5111 — Exact ambient `Math.cbrt` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.cbrt(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent the source call as a versioned semantic intrinsic and
reuse the existing host-free, dependency-free `Math_cbrt` helper.

This checkpoint is intentionally stacked on #5115/#5110. It changes ownership
only; the established Newton iteration and direct-codegen fallback remain
untouched.

## Measured residual

`cbrt` is absent from `IR_MATH_METHOD_TABLE`, so the selector declines and the
legacy builtin path emits `Math_cbrt`. The self-hosted runtime body already
exists in `src/stdlib/math.ts`, has no sibling callees, and is already covered
by the direct helper materializer. The missing contract is the closed semantic
intrinsic/provider entry.

## Exact admitted grammar

Admit only a non-optional `Math.cbrt(argument)` when `Math` is the unshadowed
ambient binding, there is exactly one non-spread argument, the selector proves
primitive `number`, symbolic Math helpers are available, and the containing
unit passes ordinary ownership/call-graph gates. Aliased, computed, optional,
shadowed, coercive, spread, and wrong-arity forms remain direct.

## Implementation plan

1. Add `math.cbrt` to the closed intrinsic/runtime-feature vocabularies with a
   unary-f64 signature.
2. Add the dependency-free `selfhost.math.cbrt -> Math_cbrt` provider.
3. Add `cbrt` to `IR_MATH_METHOD_TABLE` and reuse the generic selector,
   call-graph walker, from-AST emitter, manifest, and provider materializer.
4. Add an independent `JS2WASM_IR_MATH_CBRT=0` rollback.
5. Widen #3526 exhaustive vocabulary, integration, linear-legality, and
   neutrality evidence from twenty-one to twenty-two source Math intrinsics.
6. Add focused host/standalone ownership, dependency-free provider closure,
   bit-exact direct parity, native-oracle, rollback, and pre-claim exclusion
   tests covering signs, subnormals, exact cubes, finite interiors, NaN, and
   infinities.
7. Re-run existing cbrt/self-hosted Math regressions, affected #3526 suites,
   TypeScript 7, formatting/lint/ratchets, and full pre-push checks; then open a
   non-draft PR stacked on #5115.

## Acceptance criteria

- Exact ambient one-number `Math.cbrt` calls emit IR only and attach the
  existing dependency-free self-hosted callable.
- Host and zero-import standalone execution are bit-identical to the direct
  path across signed zero, subnormals, exact cubes, finite interiors, NaN, and
  infinities.
- A native-Math oracle pins an explicit absolute/relative accuracy envelope
  while separately proving the oracle ran on an IR-only body.
- The narrow rollback and all excluded shapes decline before claim without
  invariants or post-claim errors.
- Affected regressions, TypeScript 7, and all pre-push gates pass.

## Non-goals

- General ToNumber coercion, aliases, computed/extracted calls, optional
  chaining, `.call`, or `.apply`.
- A new cube-root approximation, host import, or direct-codegen behavior
  change.
- `Math.expm1`, inverse hyperbolics, async, class, or module-init ownership
  expansion.

## Risk and rollback

The principal risk is inherited Newton-iteration behavior for very small or
very large magnitudes. Direct-path bit identity remains the hard migration
invariant and native Math supplies a coarse independent sanity bound. The
method-specific environment flag provides narrow rollback;
`JS2WASM_IR_FIRST=0` remains the global control.
