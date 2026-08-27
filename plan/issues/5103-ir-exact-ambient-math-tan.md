---
id: 5103
title: "IR: own exact ambient Math.tan(number) calls"
status: done
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5103-ir-math-tan
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [5101]
related: [1371, 3204, 3526, 4787, 5092, 5094]
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5103-ir-math-tan.test.ts
loc-budget-allow:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5103 — Exact ambient `Math.tan(number)` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.tan(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent the source call as a versioned semantic intrinsic and
reuse the existing host-free `Math_tan` implementation together with its
`Math_sin` and `Math_cos` dependencies.

This checkpoint is intentionally stacked on #5107/#5101 because it extends the
same closed Math vocabulary and runtime manifest. It does not modify the
`Math.tan` algorithm or any direct-codegen implementation.

## Measured residual

`Math.tan` is absent from `IR_MATH_METHOD_TABLE`, so selection declines the
source call and the legacy builtin path emits `Math_tan`. The runtime body is
already available in `src/codegen/math-helpers.ts`: requesting `tan` emits the
existing self-hosted `Math_sin`, `Math_cos`, range-reduction helper, and
`Math_tan` functions in dependency order. The missing contract is the semantic
IR intrinsic/provider graph, not executable behavior.

## Exact admitted grammar

Admit only `Math.tan(argument)` when:

- `Math` is the unshadowed ambient binding;
- there is exactly one non-spread argument;
- the selector proves the argument is primitive `number` and IR-lowerable;
- symbolic Math helpers are available for the active backend; and
- the containing unit passes the ordinary ownership and call-graph gates.

Aliased, computed, shadowed, coercive, spread, and wrong-arity forms remain on
the direct path.

## Implementation plan

1. Add `math.tan` to the closed intrinsic/runtime-feature vocabularies with the
   existing unary-f64 signature.
2. Add provider `selfhost.math.tan` targeting `Math_tan`, with declared
   dependencies on `math.sin` and `math.cos`. Their existing dependencies close
   over `math.reduce-trig` exactly once.
3. Add `tan` to `IR_MATH_METHOD_TABLE`; reuse the generic selector,
   call-graph walker, from-AST intrinsic emitter, manifest preparation, and
   provider materializer.
4. Add narrow rollback `JS2WASM_IR_MATH_TAN=0` without withdrawing any other
   Math intrinsic.
5. Widen #3526 exhaustive vocabulary, dependency, integration, and neutrality
   evidence from thirteen to fourteen source-level Math intrinsics.
6. Add focused tests for host and zero-import standalone ownership, semantic
   intrinsic/provider attachment, dependency closure, direct-path numerical
   parity, narrow rollback, and pre-claim exclusions.
7. Run focused suites, TypeScript 7 typecheck, formatting/lint/ratchets, full
   pre-push checks, then push and open a non-draft stacked PR.

## Acceptance criteria

- Exact ambient `Math.tan(number)` emits IR only and attaches the existing
  self-hosted `Math_tan` callable.
- The frozen manifest declares `math.tan -> [math.cos, math.sin]` and closes
  transitively over the established trigonometric providers without host
  capabilities.
- Host and standalone execution match the direct path, and standalone imports
  remain empty.
- `JS2WASM_IR_MATH_TAN=0` keeps only `Math.tan` on the direct path.
- Every excluded form declines before claim with no invariant or post-claim
  failure.
- Affected #3526 suites, TypeScript 7, and all pre-push gates pass.

## Implementation outcome and validation

- `math.tan` is now the fourteenth closed source-level Math intrinsic. The
  shared Math table admits only exact ambient one-number calls and the generic
  from-AST path emits the semantic intrinsic without any tangent-specific
  builder branch.
- The frozen manifest attaches `selfhost.math.tan` / `Math_tan`, declares
  `math.tan -> [math.cos, math.sin]`, and deduplicates the transitive
  `math.reduce-trig` dependency. The existing provider materializer emits the
  established helper family; no algorithm or direct-codegen file changed.
- `JS2WASM_IR_MATH_TAN=0` withdraws only the new claim. Shadowed, aliased,
  wrong-arity, spread, and non-number forms all decline before claim.
- Four focused/affected suites pass 23/23, including host and zero-import
  standalone execution, exact semantic/provider evidence, dependency closure,
  direct-path parity, rollback, exhaustive Math integration, all-target/backend
  manifest closure, and linear-backend legality.
- TypeScript 7, Prettier, Biome lint, the IR kind-neutrality gate, LOC/function
  budgets, oracle/coercion ratchets, numeric-local parity (18/18), and issue
  integrity pass. Luna Max review returned GO with no P0/P1 finding.

## Non-goals

- General ToNumber coercion, aliases, extracted/computed calls, `.call`, or
  `.apply`.
- `Math.asin`, `Math.acos`, hyperbolic methods, random, min/max, or another
  Math-table expansion.
- A new tangent approximation, host import, raw helper call in IR, or direct
  codegen behavior change.
- Async, class, module-init, or multi-source ownership expansion.

## Risk and rollback

The principal risk is manifest/provider drift: `Math_tan` requires both
`Math_sin` and `Math_cos`, which share `math.reduce-trig`. The frozen manifest
must express that graph and prove deterministic deduplication. The shared Math
table remains the sole source grammar contract. `JS2WASM_IR_MATH_TAN=0` is the
checkpoint rollback; `JS2WASM_IR_FIRST=0` remains the global control.
