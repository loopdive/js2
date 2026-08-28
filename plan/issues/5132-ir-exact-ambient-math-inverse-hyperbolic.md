---
id: 5132
title: "IR: own exact ambient Math.asinh/Math.acosh/Math.atanh calls"
status: done
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5130-ir-math-minmax
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [5114]
related: [1371, 3141, 3204, 3526, 4787, 5092, 5094, 5101, 5103, 5105, 5106, 5110, 5111]
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5132-ir-math-inverse-hyperbolic.test.ts
loc-budget-allow:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5132 — Exact ambient inverse-hyperbolic Math IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.asinh(numberExpression)`, `Math.acosh(numberExpression)`, and
`Math.atanh(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent all three source calls as versioned semantic intrinsics
and reuse their existing host-free helpers plus one deduplicated `Math_log`
dependency.

This checkpoint is intentionally stacked on #5121/#5114. It changes ownership
only; the established formulas, approximation behavior, and direct-codegen
fallback remain untouched.

## Measured residual

The three methods are absent from `IR_MATH_METHOD_TABLE`, so the selector
declines and the legacy builtin path emits `Math_asinh`, `Math_acosh`, or
`Math_atanh`. Their self-hosted runtime bodies already exist in
`src/stdlib/math.ts`, each declares `Math_log` as its sole sibling callee, and
direct codegen already closes all three over that helper. The missing contract
is the closed semantic intrinsic/provider entry for each source method.

## Exact admitted grammar

Admit only a non-optional `Math.<method>(argument)` when `Math` is the
unshadowed ambient binding, `<method>` is `asinh`, `acosh`, or `atanh`, there is
exactly one non-spread argument, the selector proves primitive `number`,
symbolic Math helpers are available, and the containing unit passes ordinary
ownership/call-graph gates. Aliased, computed, optional, shadowed, coercive,
spread, and wrong-arity forms remain direct.

## Implementation plan

1. Add `math.asinh`, `math.acosh`, and `math.atanh` to the closed
   intrinsic/runtime-feature vocabularies with unary-f64 signatures.
2. Add `selfhost.math.asinh -> Math_asinh`, `selfhost.math.acosh ->
   Math_acosh`, and `selfhost.math.atanh -> Math_atanh`, each with `math.log`
   as its sole dependency.
3. Add all three methods to `IR_MATH_METHOD_TABLE` and reuse the generic
   selector, call-graph walker, from-AST emitter, manifest, and provider
   materializer.
4. Add independent `JS2WASM_IR_MATH_ASINH=0`,
   `JS2WASM_IR_MATH_ACOSH=0`, and `JS2WASM_IR_MATH_ATANH=0` rollbacks.
5. Widen #3526 exhaustive vocabulary, dependency, integration,
   linear-legality, and neutrality evidence from twenty-three to twenty-six
   source Math intrinsics.
6. Add focused host/standalone ownership, exact shared-provider closure,
   bit-exact direct parity, method-specific native-oracle, rollback, and
   pre-claim exclusion tests across domains, signed zero, tiny values, finite
   interiors, range edges, NaN, and infinities.
7. Re-run existing inverse-hyperbolic/self-hosted Math regressions, affected
   #3526 suites, TypeScript 7, formatting/lint/ratchets, and full pre-push
   checks; then open a non-draft PR stacked on #5121.

## Acceptance criteria

- Exact ambient one-number calls for all three methods emit IR only and attach
  their existing self-hosted callables.
- The manifest closes all three features over exactly one deduplicated
  `math.log` provider and requests no host capability.
- Host and zero-import standalone execution are bit-identical to the direct
  path across domain boundaries, signed zero, tiny values, finite interiors,
  inherited range edges, NaN, and infinities.
- Native-Math checks pin explicit method-specific safe-range envelopes while
  separately proving every oracle ran on an IR-only body.
- Each narrow rollback withdraws only its corresponding method, and excluded
  shapes decline before claim without invariants or post-claim errors.
- Affected regressions, TypeScript 7, and all pre-push gates pass.

## Implementation outcome and validation

- `math.asinh`, `math.acosh`, and `math.atanh` are now the twenty-fourth
  through twenty-sixth closed source-level Math intrinsics. They reuse the
  generic exact-ambient selector, call-graph walker, from-AST intrinsic
  emitter, and provider materializer.
- The frozen manifest attaches the existing host-free `Math_asinh`,
  `Math_acosh`, and `Math_atanh` callables, closes each over `math.log`,
  materializes that dependency once, and requests no host capability. No Math
  algorithm or direct-codegen file changed.
- Independent `JS2WASM_IR_MATH_ASINH=0`, `JS2WASM_IR_MATH_ACOSH=0`, and
  `JS2WASM_IR_MATH_ATANH=0` controls withdraw only their corresponding claim.
  Shadowed, aliased, computed, optional-invocation, optional-receiver,
  wrong-arity, spread, and non-number forms all decline before claim.
- Four focused/affected contract suites pass 45/45. They cover host and
  zero-import standalone execution, exact dependency-first provider closure,
  direct-path bit parity across domains, adjacent endpoints, signed zero,
  subnormals, infinities, and the inherited square-overflow boundary,
  method-specific native envelopes, independent rollbacks, every
  target/backend manifest policy, and explicit production linear deferral.
- Existing inverse-hyperbolic/self-hosted Math regressions pass 51/51 across
  #3141 and `math-inline`.
- TypeScript 7, Prettier, Biome lint, the IR kind-neutrality gate, LOC/function
  budgets, oracle/coercion ratchets, numeric-local parity (18/18), and issue
  integrity pass. Luna Max final review returned GO with no P0/P1 finding.
- PR #5123 is open non-draft, conflict-free, and green, stacked on #5121's
  exact `Math.expm1` ownership branch.

## Non-goals

- General ToNumber coercion, aliases, computed/extracted calls, optional
  chaining, `.call`, or `.apply`.
- New inverse-hyperbolic approximations, host imports, or direct-codegen
  behavior changes.
- Async, class, module-init, or broader non-Math ownership expansion.

## Measured numerical disposition

The existing direct and self-hosted paths share the same formulas and
`Math_log` approximation. This ownership checkpoint preserves them exactly. A
Luna Max audit measured distinct safe-range envelopes, now pinned by the
focused IR-only oracle:

- `asinh` on moderate `|x| >= 1e-3`: at most `2e-12` relative error, with a
  `2e-16` absolute envelope for tiny values;
- `acosh` away from one: at most `2e-12` relative error, with a measured
  `5e-13` absolute envelope immediately above one;
- `atanh` in the regular interior: at most `2e-8` relative error, with
  `2e-16` absolute error near zero and `1e-8` near the domain endpoints.

These are regression envelopes, not correct-rounding claims. The existing
`x * x` formulas overflow above roughly `1.3407807929942596e154`, so `asinh`
and `acosh` return positive or signed infinity while native Math remains
finite. `asinh` also maps subnormals to signed zero, and `atanh` maps
`-Number.MIN_VALUE` to positive zero. Exact IR/direct parity explicitly covers
these inherited range and cancellation behaviors; improving the shared
algorithms remains separate from this ownership-only PR.

## Risk and rollback

The principal risks are inherited cancellation near zero, domain endpoints,
and multiplication overflow in the existing `x * x` formulas for large finite
inputs. Direct-path bit identity remains the hard migration invariant; native
Math evidence will use separately measured safe ranges rather than disguise
known approximation limits. Independent environment flags provide narrow
rollback; `JS2WASM_IR_FIRST=0` remains the global control.
