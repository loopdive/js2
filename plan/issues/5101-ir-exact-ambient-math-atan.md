---
id: 5101
title: "IR: own exact ambient Math.atan(number) calls"
status: done
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5101-ir-math-atan
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [3526]
related: [1371, 3233, 4787, 5092, 5094]
files:
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5101-ir-math-atan.test.ts
loc-budget-allow:
  # One new closed intrinsic ID/definition and one exact selector table row.
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  # During initial rollout, the narrow rollback predicate belonged at the
  # shared provider-capability check read by every selector/call-graph Math
  # admission site.
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5101 — Exact ambient `Math.atan(number)` IR ownership

## Objective

Retire the direct AST-to-Wasm route for the bounded exact
`Math.atan(numberExpression)` surface in otherwise IR-eligible synchronous
functions. Reuse the already self-hosted, host-free `math.atan` runtime
provider, represent the source call as a versioned semantic intrinsic, and
leave every coercive or non-ambient shape on the direct path.

This checkpoint is stacked on #5104 for parallel review. Its touched lines are
disjoint from #5094's console renderer and #5092's conditional-expression
grammar: the functional changes are the closed intrinsic vocabulary, the Math
method table, and the shared Math provider-capability predicate.

## Measured direct-codegen residual

For `return Math.atan(x)` today:

1. `src/codegen/expressions/calls.ts` routes the property call to
   `compileBuiltinStaticCall`;
2. `src/codegen/expressions/call-builtin-static.ts` dispatches to
   `compileMathCall`;
3. `src/codegen/expressions/builtins.ts::compileMathCall` takes the unary host
   helper arm, compiles one f64 argument, and emits a direct `Math_atan` call.

IR does not claim that source shape because `IR_MATH_METHOD_TABLE` includes
`atan2` but not `atan`. This is not a runtime gap:

- `PURE_MATH_RUNTIME_FEATURES` and `RUNTIME_FEATURE_SIGNATURES` already contain
  the unary f64 `math.atan` feature;
- `runtime-manifest.ts` already maps it to the self-hosted `Math_atan` provider;
- `math.atan2` already depends on that provider;
- the generic from-AST Math arm lowers every certified table entry through
  `emitIntrinsic` and therefore needs no `atan`-specific builder code.

The remaining contract gap is that `math.atan` is currently provider-only,
not one of the closed source-level `IntrinsicId`s.

## Exact admitted grammar

Admit only a call with all of these properties:

- syntax is the property call `Math.atan(argument)`;
- `Math` resolves to the unshadowed ambient binding;
- there is exactly one non-spread argument;
- the checker/selector proves the argument is primitive `number`;
- the argument independently satisfies the existing Phase-1 expression walk;
- the active backend reports symbolic Math helpers available;
- the containing unit passes every ordinary synchronous ownership, ABI, and
  call-graph closure gate.

The generic Math table and its existing three consumers remain the single
selection/build contract. No parallel `atan` recognizer is added.

## Bounded implementation plan

1. Promote `math.atan` from provider-only runtime feature to closed
   source-level `IntrinsicId`, with the existing unary f64 signature and
   feature/provider mapping.
2. Add `atan: { arity: 1, intrinsic: "math.atan" }` to
   `IR_MATH_METHOD_TABLE`. The existing selector, number proof, call-graph
   walker, builder, manifest preparation, and backend provider resolution then
   consume the same row.
3. Initial rollout retained a narrow per-method selector withdrawal at
   `selectorSupportsMathPlan`; it prevents only this new claim and leaves the
   direct implementation reachable. Keep `JS2WASM_IR_FIRST=0` as the global
   repository control.
4. Widen #3526's closed-vocabulary/runtime-manifest assertions from twelve to
   thirteen direct intrinsic entry points. `math.reduce-trig` remains the only
   provider-only dependency.
5. Extend the all-method #3526 integration source and provider evidence with
   direct `Math.atan` ownership.
6. Add focused #5101 tests for host and standalone IR-only emission, exact
   provider/intrinsic evidence, zero standalone imports, direct-path parity on
   `NaN`, infinities, signed zero, and finite values, the narrow rollback, and
   pre-claim exclusion of shadowed/aliased/wrong-arity/spread/non-number forms.
7. Run focused #5101 and all affected #3526 suites, TypeScript 7 typecheck,
   formatting/lint/ratchets, then push and open a non-draft stacked PR.

## Acceptance criteria

- The closed Math intrinsic vocabulary has thirteen entries and remains
  exhaustive with `IR_MATH_METHOD_TABLE`.
- Exact ambient `Math.atan(number)` emits a `math.atan` semantic intrinsic,
  resolves to the existing self-hosted `Math_atan` callable, and publishes no
  legacy body.
- Host and standalone binaries execute with direct-path parity; standalone has
  zero imports.
- The rollout-only per-method withdrawal kept the same valid source on the direct path.
- Every excluded shape declines before claim with no post-claim error or
  invariant.
- Existing #3526 runtime-manifest, integration, and linear-backend tests pass.
- Typecheck and all required pre-push gates pass.

## Implementation outcome and validation

- `math.atan` is now the thirteenth closed source-level Math intrinsic, with
  the existing unary f64 definition and self-hosted `Math_atan` provider. The
  only selection change was one shared table row plus the narrow rollback in
  `selectorSupportsMathPlan`; from-AST lowering remains completely generic.
- The #3526 closed-vocabulary, manifest, all-method integration, and neutrality
  evidence now describe thirteen intrinsic entry points. `math.reduce-trig`
  remains the sole provider-only feature, and linear legality continues to
  reject every callable-backed Math intrinsic including `math.atan`.
- Focused #5101 plus affected #3526 coverage passes 23/23. It proves host and
  zero-import standalone execution, provider-free semantic IR before manifest
  attachment, exact existing-provider resolution, IR/direct parity across
  finite values, infinities, NaN and signed zero, pre-claim exclusions, and a
  compile-level per-method rollback without withdrawing
  `Math.atan2`.
- TypeScript 7 typecheck, targeted Prettier/Biome, the IR kind-neutrality gate,
  and scoped LOC/function budgets pass. Independent Luna Max review returned
  GO with no P0/P1 finding; it confirmed the compile-level rollback test closes
  the selector-only flag caveat.
- Numerical behavior intentionally remains the existing self-hosted
  `Math_atan` behavior. This issue changes ownership, not the approximation.

## Non-goals

- Aliased, extracted, computed, `globalThis.Math`, `.call`, or `.apply` forms.
- General ToNumber coercion for `any`, `unknown`, strings, objects, unions,
  generics, or spread arguments.
- Wrong/missing/extra arity semantics.
- `Math.asin`, `Math.acos`, `Math.tan`, hyperbolic methods, random, min/max, or
  any other Math-table expansion.
- A new atan algorithm, host import, runtime provider, raw helper call in IR,
  or direct-codegen behavior change.
- Async/class/module-init/multi-source ownership expansion.

## Risk and refusal contract

The provider already exists, so the principal risk is widening the source
surface beyond the generic Math selector's exact number proof. Keeping `atan`
inside the same table used by expression selection, call-graph scanning, and
from-AST lowering preserves one source of truth. Any provider/signature drift
after claim remains a runtime-manifest invariant; unsupported source shapes
must never reach that boundary.

## 2026-08-30 retirement update

The rollout-only per-method withdrawal is retired by the #4522 Math checkpoint.
Exact ambient, global-direct parity, and all existing numeric and near-miss
coverage remain. The shared #3518 matrix provides the literal closed cross-method
census; `experimentalIR: false` is the retained observational oracle.
