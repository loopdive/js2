---
id: 5106
title: "IR: own exact ambient Math.log10/Math.log1p calls"
status: done
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5106-ir-math-log10-log1p
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [5105]
related: [1371, 3204, 3226, 3526, 4787, 5092, 5094, 5101, 5103]
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5106-ir-math-derived-log.test.ts
loc-budget-allow:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5106 — Exact ambient `Math.log10` / `Math.log1p` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.log10(numberExpression)` and `Math.log1p(numberExpression)` calls in
otherwise IR-eligible synchronous functions. Represent both source calls as
versioned semantic intrinsics and reuse the existing host-free `Math_log10`
and `Math_log1p` implementations plus their shared `Math_log` dependency.

This paired derived-log checkpoint is intentionally stacked on #5110/#5105.
It changes ownership only; the established approximations and direct-codegen
fallback remain untouched.

## Measured residual

Neither method appears in `IR_MATH_METHOD_TABLE`, so the selector declines and
the legacy builtin path emits `Math_log10` / `Math_log1p`. Both self-hosted
runtime bodies already exist in `src/stdlib/math.ts`, and direct codegen already
materializes `Math_log` before either derived helper. The missing contract is
the closed semantic intrinsic/provider graph.

## Exact admitted grammar

For each method, admit only `Math.<method>(argument)` when `Math` is the
unshadowed ambient binding, there is exactly one non-spread argument, the
selector proves primitive `number`, symbolic Math helpers are available, and
the containing unit passes ordinary ownership/call-graph gates. Aliased,
computed, shadowed, coercive, spread, and wrong-arity forms remain direct.

## Implementation plan

1. Add `math.log10` and `math.log1p` to the closed intrinsic/runtime-feature
   vocabularies with unary-f64 signatures.
2. Add `selfhost.math.log10 -> Math_log10` and
   `selfhost.math.log1p -> Math_log1p`; declare `math.log` as the dependency of
   each provider.
3. Add both methods to `IR_MATH_METHOD_TABLE` and reuse the generic selector,
   call-graph walker, from-AST emitter, manifest, and provider materializer.
4. Add independent `JS2WASM_IR_MATH_LOG10=0` and
   `JS2WASM_IR_MATH_LOG1P=0` rollbacks so either claim can be withdrawn alone.
5. Widen #3526 exhaustive vocabulary, dependency, integration,
   linear-legality, and neutrality evidence from sixteen to eighteen source
   Math intrinsics.
6. Add focused host/standalone, provider-closure, numerical-parity and
   native-oracle, rollback, and pre-claim exclusion tests for both methods.
7. Run focused suites, TypeScript 7, formatting/lint/ratchets, full pre-push
   checks, then push and open a non-draft PR stacked on #5110.

## Acceptance criteria

- Exact ambient one-number `Math.log10` and `Math.log1p` calls emit IR only and
  attach the existing self-hosted callables.
- The manifest closes both features over exactly one deduplicated `math.log`
  provider and requests no host capability.
- Host and zero-import standalone execution preserve direct-path behavior and
  stay inside explicit native-Math absolute/ULP regression bounds.
- Each rollback withdraws only its corresponding method.
- Excluded shapes decline before claim without invariants or post-claim errors.
- Affected #3526 suites, TypeScript 7, and all pre-push gates pass.

## Implementation outcome and validation

- `math.log10` and `math.log1p` are now the seventeenth and eighteenth
  closed source-level Math intrinsics. Both reuse the shared table, generic
  selector, call-graph walker, and from-AST intrinsic emitter.
- The frozen manifest attaches the existing `Math_log10` and `Math_log1p`
  callables, declares `math.log` as each provider's sole dependency, and
  materializes that dependency once. No Math algorithm or direct-codegen file
  changed.
- Independent `JS2WASM_IR_MATH_LOG10=0` and
  `JS2WASM_IR_MATH_LOG1P=0` controls withdraw only their corresponding claim.
  Shadowed, aliased, computed, optional-invocation, optional-receiver,
  wrong-arity, spread, and non-number forms all decline before claim.
- Four focused/affected suites pass 36/36. They cover host and zero-import
  standalone ownership, semantic/provider evidence, exact dependency closure,
  bit-identical direct-path parity across domain boundaries and the established
  `log10` snap window, explicit native-Math accuracy envelopes, independent
  rollbacks, exhaustive integration, every target/backend manifest policy,
  and linear-backend legality.
- TypeScript 7, Prettier, Biome lint, the IR kind-neutrality gate, LOC/function
  budgets, oracle/coercion ratchets, numeric-local parity (18/18), and issue
  integrity pass. Luna Max re-review after tightening the optional-call claim
  boundary returned GO with no P0/P1 finding; it also confirmed the `log10`
  snap is inherited #3226 behavior preserved bit-for-bit by this ownership
  migration.
- PR #5111 is open non-draft, clean, and green, stacked on #5110's exact head.

## Non-goals

- General ToNumber coercion, aliases, computed/extracted calls, `.call`, or
  `.apply`.
- A new logarithm approximation, host import, or direct-codegen behavior
  change.
- Async, class, module-init, or multi-source ownership expansion.

## Risk and rollback

The principal risk is dependency or numerical-evidence drift. Both semantic
features must depend on `math.log` without duplicating its provider, and the
shared table must remain the sole grammar contract. Independent environment
flags provide narrow checkpoint rollback; `JS2WASM_IR_FIRST=0` remains the
global control.
