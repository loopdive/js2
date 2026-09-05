---
id: 5114
title: "IR: own exact ambient Math.expm1 calls"
status: done
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5114-ir-math-expm1
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [5111]
related: [1371, 3141, 3204, 3526, 4787, 5092, 5094, 5101, 5103, 5105, 5106, 5110]
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5114-ir-math-expm1.test.ts
loc-budget-allow:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5114 — Exact ambient `Math.expm1` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.expm1(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent the source call as a versioned semantic intrinsic and
reuse the existing host-free `Math_expm1` helper plus its `Math_exp`
dependency.

This checkpoint is intentionally stacked on #5118/#5111. It changes ownership
only; the established Taylor/general algorithm and direct-codegen fallback
remain untouched.

## Measured residual

`expm1` is absent from `IR_MATH_METHOD_TABLE`, so the selector declines and the
legacy builtin path emits `Math_expm1`. The self-hosted runtime body already
exists in `src/stdlib/math.ts`, declares `Math_exp` as its sole callee, and is
already covered by direct codegen's `needExp` closure. The missing contract is
the closed semantic intrinsic/provider entry.

## Exact admitted grammar

Admit only a non-optional `Math.expm1(argument)` when `Math` is the unshadowed
ambient binding, there is exactly one non-spread argument, the selector proves
primitive `number`, symbolic Math helpers are available, and the containing
unit passes ordinary ownership/call-graph gates. Aliased, computed, optional,
shadowed, coercive, spread, and wrong-arity forms remain direct.

## Implementation plan

1. Add `math.expm1` to the closed intrinsic/runtime-feature vocabularies with
   a unary-f64 signature.
2. Add `selfhost.math.expm1 -> Math_expm1` with `math.exp` as its sole
   dependency.
3. Add `expm1` to `IR_MATH_METHOD_TABLE` and reuse the generic selector,
   call-graph walker, from-AST emitter, manifest, and provider materializer.
4. Initial rollout added an independent per-method rollback.
5. Widen #3526 exhaustive vocabulary, dependency, integration,
   linear-legality, and neutrality evidence from twenty-two to twenty-three
   source Math intrinsics.
6. Add focused host/standalone ownership, exact provider closure, bit-exact
   direct parity, Taylor-threshold/native-oracle, rollback, and pre-claim
   exclusion tests across signed zero, tiny values, branch boundaries, finite
   interiors, NaN, and infinities.
7. Re-run existing expm1/self-hosted Math regressions, affected #3526 suites,
   TypeScript 7, formatting/lint/ratchets, and full pre-push checks; then open a
   non-draft PR stacked on #5118.

## Acceptance criteria

- Exact ambient one-number `Math.expm1` calls emit IR only and attach the
  existing self-hosted callable through one `math.exp` dependency.
- Host and zero-import standalone execution are bit-identical to the direct
  path across the Taylor boundary, signed zero, finite values, NaN, and
  infinities.
- A native-Math oracle pins explicit Taylor/general accuracy bounds while
  separately proving the oracle ran on an IR-only body.
- The former narrow rollback was validated alongside excluded shapes, which
  decline before claim without
  invariants or post-claim errors.
- Affected regressions, TypeScript 7, and all pre-push gates pass.

## Implementation outcome and validation

- `math.expm1` is now the twenty-third closed source-level Math intrinsic. It
  reuses the generic exact-ambient selector, call-graph walker, from-AST
  intrinsic emitter, and provider materializer.
- The frozen manifest attaches the existing host-free `Math_expm1` callable,
  closes it over exactly one shared `math.exp` dependency, and requests no
  host capability. No Math algorithm or direct-codegen file changed.
- The per-method rollback withdrew only this claim. Shadowed, aliased,
  computed, optional-invocation, optional-receiver, wrong-arity, spread, and
  non-number forms all decline before claim without invariants or post-claim
  errors.
- Six focused/affected and legacy suites pass 78/78. They cover host and
  zero-import standalone execution, exact provider closure, direct-path bit
  parity across adjacent Taylor-boundary values, IEEE specials, extreme
  magnitudes, and the inherited overflow band, plus explicit native-Math
  envelopes, rollback, exhaustive manifest/integration contracts, and linear
  legality.
- TypeScript 7, Prettier, Biome lint, the IR kind-neutrality gate, LOC/function
  budgets, oracle/coercion ratchets, numeric-local parity (18/18), and issue
  integrity pass. Luna Max final review independently reran the focused and
  affected evidence and returned GO with no P0/P1 finding.
- PR #5121 is open non-draft and conflict-free, stacked on #5118's exact
  `Math.cbrt` ownership branch.

## Non-goals

- General ToNumber coercion, aliases, computed/extracted calls, optional
  chaining, `.call`, or `.apply`.
- A new expm1 approximation, host import, or direct-codegen behavior change.
- Inverse hyperbolics, async, class, or module-init ownership expansion.

## Measured numerical disposition

The existing direct and self-hosted paths share the same order-four Taylor
arm and degree-seven `Math_exp` dependency. The ownership change deliberately
preserves that implementation. A Luna audit measured and the focused suite
now pins three separate envelopes instead of presenting one misleading global
accuracy claim:

- strict Taylor inputs immediately below `|x| = 1e-5`: at most `3e-21`
  absolute error, `3e-16` relative error, and two ULPs;
- the fallback inputs at and immediately above the strict boundary: at most
  `2e-16` absolute error, `2e-11` relative error, and 100,000 ULPs;
- representative finite inputs in the safe `[-709, 709]` range: at most
  `3e-8` relative/scaled-absolute error and 200 million ULPs.

The large ULP ceilings expose inherited approximation behavior rather than
endorsing correct rounding. In particular, cancellation in `Math_exp(x) - 1`
produces roughly 57,000 ULPs at the positive threshold, and the existing
repeated-squaring `Math_exp` overflows near `709.43613930310403` while native
`Math.expm1` remains finite until roughly `709.782712893384`. Exact IR/direct
parity covers both sides of the Taylor branch and that overflow band. Improving
the shared numerical algorithm remains separate from this ownership-only PR.

## Risk and rollback

The principal risks are cancellation near zero and behavior at the strict
`|x| < 1e-5` Taylor boundary. Direct-path bit identity remains the hard
migration invariant and native Math supplies method-specific independent
accuracy bounds. The rollout-only per-method withdrawal provided narrow
rollback; `JS2WASM_IR_FIRST=0` remains the global control.

## 2026-08-30 retirement update

The rollout-only per-method withdrawal is retired by the #4522 Math checkpoint.
Exact ambient, global-direct parity, and all existing numeric and near-miss
coverage remain. The shared #3518 matrix provides the literal closed cross-method
census; `experimentalIR: false` is the retained observational oracle.
