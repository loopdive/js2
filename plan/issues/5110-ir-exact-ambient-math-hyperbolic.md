---
id: 5110
title: "IR: own exact ambient Math.sinh/Math.cosh/Math.tanh calls"
status: done
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5110-ir-math-hyperbolic
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [5106]
related: [1371, 3141, 3204, 3526, 4787, 5092, 5094, 5101, 5103, 5105]
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5110-ir-math-hyperbolic.test.ts
loc-budget-allow:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5110 — Exact ambient `Math.sinh` / `Math.cosh` / `Math.tanh` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.sinh(numberExpression)`, `Math.cosh(numberExpression)`, and
`Math.tanh(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent the coherent hyperbolic family as versioned semantic
intrinsics and reuse the existing host-free helpers plus their shared
`Math_exp` dependency.

This checkpoint is intentionally stacked on #5111/#5106. It changes ownership
only; the established approximations and direct-codegen fallback remain
untouched.

## Measured residual

None of the three methods appears in `IR_MATH_METHOD_TABLE`, so the selector
declines and the legacy builtin path emits `Math_sinh`, `Math_cosh`, or
`Math_tanh`. All three self-hosted runtime bodies already exist in
`src/stdlib/math.ts`, declare `Math_exp` as their sole callee, and are already
covered by direct codegen's `needExp` closure. The missing contract is the
closed semantic intrinsic/provider graph.

## Exact admitted grammar

For each method, admit only a non-optional `Math.<method>(argument)` when
`Math` is the unshadowed ambient binding, there is exactly one non-spread
argument, the selector proves primitive `number`, symbolic Math helpers are
available, and the containing unit passes ordinary ownership/call-graph gates.
Aliased, computed, optional, shadowed, coercive, spread, and wrong-arity forms
remain direct.

## Implementation plan

1. Add `math.sinh`, `math.cosh`, and `math.tanh` to the closed
   intrinsic/runtime-feature vocabularies with unary-f64 signatures.
2. Add `selfhost.math.sinh -> Math_sinh`, `selfhost.math.cosh -> Math_cosh`,
   and `selfhost.math.tanh -> Math_tanh`; declare `math.exp` as each provider's
   sole dependency.
3. Add all three methods to `IR_MATH_METHOD_TABLE` and reuse the generic
   selector, call-graph walker, from-AST emitter, manifest, and provider
   materializer.
4. Add independent `JS2WASM_IR_MATH_SINH=0`,
   `JS2WASM_IR_MATH_COSH=0`, and `JS2WASM_IR_MATH_TANH=0` rollbacks.
5. Widen #3526 exhaustive vocabulary, dependency, integration,
   linear-legality, and neutrality evidence from eighteen to twenty-one source
   Math intrinsics.
6. Add focused host/standalone, provider-closure, bit-exact direct parity,
   method-specific native-oracle, rollback, and pre-claim exclusion tests.
7. Re-run the existing self-hosted Math regressions, affected #3526 suites,
   TypeScript 7, formatting/lint/ratchets, and full pre-push checks; then open a
   non-draft PR stacked on #5111.

## Acceptance criteria

- Exact ambient one-number calls for all three methods emit IR only and attach
  their existing self-hosted callables.
- The manifest closes all three features over exactly one deduplicated
  `math.exp` provider and requests no host capability.
- Host and zero-import standalone execution are bit-identical to the direct
  path across signed zero, finite interiors, saturation/overflow boundaries,
  NaN, and infinities.
- Native-Math sanity checks use explicit method-specific bounds that preserve
  the known approximation envelope without pretending to be libm conformance.
- Each rollback withdraws only its corresponding method, and excluded shapes
  decline before claim without invariants or post-claim errors.
- Affected regressions, TypeScript 7, and all pre-push gates pass.

## Implementation outcome and validation

- `math.sinh`, `math.cosh`, and `math.tanh` are now the nineteenth through
  twenty-first closed source-level Math intrinsics. They reuse the shared Math
  table, generic selector and call-graph walker, and from-AST intrinsic emitter.
- The frozen manifest attaches the existing `Math_sinh`, `Math_cosh`, and
  `Math_tanh` callables, declares `math.exp` as each provider's sole
  dependency, and materializes that dependency once. No Math algorithm or
  direct-codegen file changed.
- Independent `JS2WASM_IR_MATH_SINH=0`, `JS2WASM_IR_MATH_COSH=0`, and
  `JS2WASM_IR_MATH_TANH=0` controls withdraw only their corresponding claim.
  Shadowed, aliased, computed, optional-invocation, optional-receiver,
  wrong-arity, spread, and non-number forms all decline before claim.
- Four focused/affected contract suites pass 45/45. They cover host and
  zero-import standalone ownership, semantic/provider evidence, exact shared
  dependency closure, bit-identical direct parity across cancellation,
  saturation, overflow, NaN, infinities, and signed zero, method-specific
  native-Math relative-error bounds, independent rollbacks, every
  target/backend manifest policy, and linear-backend legality.
- The existing self-hosted Math regressions pass 70/70 across #3141, #1437,
  and `math-inline`. The local Test262 submodule was absent, so repository PR
  automation owns the focused standards rows.
- TypeScript 7, Prettier, Biome lint, the IR kind-neutrality gate, LOC/function
  budgets, oracle/coercion ratchets, numeric-local parity (18/18), and issue
  integrity pass. Luna Max re-review after binding the numerical oracle to
  explicit IR-only outcomes returned GO with no P0/P1 finding.
- PR #5115 is open non-draft, clean, and green, stacked on #5111's exact head.

## Non-goals

- General ToNumber coercion, aliases, computed/extracted calls, optional
  chaining, `.call`, or `.apply`.
- A new hyperbolic approximation, host import, or direct-codegen behavior
  change.
- `Math.cbrt`, `Math.expm1`, inverse hyperbolics, async, class, or module-init
  ownership expansion.

## Risk and rollback

The principal risks are dependency deduplication and inherited cancellation or
overflow behavior. The semantic features must share one `math.exp` provider,
while direct-path bit identity remains the hard migration invariant and native
Math only supplies a coarse numerical sanity bound. Independent environment
flags provide narrow rollback; `JS2WASM_IR_FIRST=0` remains the global control.
