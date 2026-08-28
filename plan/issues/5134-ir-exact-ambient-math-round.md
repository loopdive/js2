---
id: 5134
title: "IR: own exact ambient Math.round calls"
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
depends_on: [5133]
related: [87, 249, 1371, 1732, 3141, 3526, 4787, 5092, 5133]
files:
  - src/stdlib/math.ts
  - src/codegen/index.ts
  - src/codegen/math-helpers.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/codegen.test.ts
  - tests/equivalence/issue-1371.test.ts
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5134-ir-math-round.test.ts
loc-budget-allow:
  - src/stdlib/math.ts
  - src/codegen/index.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5134 — Exact ambient `Math.round` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.round(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent the source call as the twenty-eighth versioned pure-Math
intrinsic and materialize it through one dependency-free, host-free
self-hosted provider while excluded forms retain direct codegen.

This checkpoint is intentionally stacked on PR #5129 / issue #5133. It
preserves the established direct algorithm exactly, including ties toward
positive infinity, signed zero, NaN payload behavior, infinities, subnormals,
and large integral f64 values.

## Measured residual and feasibility

`round` is absent from `IR_MATH_METHOD_TABLE`, so exact numeric calls currently
emit legacy bodies. `compileMathCall` already implements the correct algorithm
without the incorrect `floor(x + 0.5)` shortcut: compute `floor(x)`, compare the
fraction with `0.5`, select `ceil(x)` or the floor, then restore the required
zero sign. This makes `-1.5 -> -1`, `-0.5 -> -0`, `[-0.5, -0) -> -0`, and
preserves already-integral large f64 values.

A Luna Max dialect probe compiled an ordinary TypeScript mirror through the
current self-hosted IR pipeline and matched direct host/standalone behavior on
edge values. No P0 feasibility blocker exists for WasmGC host or standalone.
The P1 boundary is raw-bit parity for custom NaNs and signed zero. Linear
callable providers remain unsupported and are not widened by this slice.

## Exact admitted grammar

Admit only a non-optional `Math.round(argument)` when `Math` is the unshadowed
ambient binding, there is exactly one non-spread argument, the selector proves
primitive `number`, symbolic Math helpers are available, and the containing
unit passes ordinary ownership and call-graph gates. Aliased, computed,
optional, shadowed, coercive, Symbol, spread, and wrong-arity forms remain
direct.

## Provider algorithm and contract

The self-hosted body mirrors the direct schedule and must not canonicalize NaN
with an early `0 / 0` arm:

```ts
export function Math_round(x: number): number {
  let floorValue: number = Math.floor(x);
  let fraction: number = x - floorValue;
  let result: number = fraction >= 0.5 ? Math.ceil(x) : floorValue;
  if (result === 0) {
    if (x === 0) return x;
    return x < 0 ? -0 : 0;
  }
  return result;
}
```

`math.round` resolves to `selfhost.math.round` / `Math_round` with unary-f64
signature, no manifest dependency, and no host capability. The source-level
`Math.floor` and `Math.ceil` operations lower to existing native f64
instructions inside the helper; they are not callable provider dependencies.

## Implementation plan

1. Add `ROUND_SOURCE` to `src/stdlib/math.ts`, register it in
   `SELF_HOSTED_MATH`, include `round` in direct helper demand, and update the
   self-hosted-family commentary. Keep the established direct fallback body.
2. Add `math.round` to the closed intrinsic and runtime-feature vocabularies
   with a unary-f64 signature and dependency-free `selfhost.math.round`
   provider.
3. Add `round` to `IR_MATH_METHOD_TABLE`, reuse the generic selection,
   from-AST, manifest, and materialization path, and add the independent
   `JS2WASM_IR_MATH_ROUND=0` rollback.
4. Widen #3526 exhaustive vocabulary, integration, linear-legality, and
   neutrality evidence from twenty-seven to twenty-eight source Math
   intrinsics. Refresh stale tests that still describe `round` as a legacy
   `f64.nearest` or unsupported path.
5. Add focused host/standalone IR ownership, zero-import execution,
   dependency-free provider closure, direct raw-bit parity, one-SSA-argument,
   rollback, linear rejection, and pre-claim exclusion coverage. Pin custom
   NaNs, both zeros, values adjacent to positive and negative half ties,
   subnormals, infinities, and large representable integers.
6. Re-run existing #249, #1371, Symbol-coercion, Math equivalence, and stdlib
   regressions; run affected #3526 contracts, TypeScript 7, formatting,
   lint/ratchets, and full pre-push hooks; then open a non-draft PR stacked on
   #5129.

## Acceptance criteria

- Exact ambient one-number `Math.round` calls emit IR only and attach one
  dependency-free, host-free self-hosted callable.
- Host and zero-import standalone execution are raw-bit identical to direct
  codegen across NaN payloads, signed zero, ties, subnormals, finite range
  edges, and infinities.
- Ties remain toward positive infinity, `[-0.5, -0)` remains negative zero,
  and already-integral large values remain unchanged.
- Linear legality rejects the callable provider without widening the five
  native linear Math intrinsics.
- Coercive and all other excluded shapes preserve direct behavior and decline
  before claim without invariants or post-claim errors.
- The narrow rollback, affected regressions, TypeScript 7, and all pre-push
  gates pass.

## Implementation outcome and validation

- `math.round` is the twenty-eighth certified pure Math intrinsic. Exact
  ambient one-number calls now emit IR-only bodies and resolve through the
  dependency-free `selfhost.math.round` provider and `Math_round` symbol.
- The self-hosted source mirrors the established floor/fraction/ceil schedule.
  Raw-bit direct/IR parity passes for custom positive and negative NaNs, both
  zeros, adjacent half ties, subnormals, finite range edges, large integral
  values, and infinities. Ties remain toward positive infinity and
  `[-0.5, 0)` remains negative zero.
- Host execution requests no Math import; standalone execution has zero Wasm
  imports. The manifest closure contains only `math.round`, with no dependency
  or host capability, and the intrinsic carries one SSA argument.
- Shadowed, aliased, computed, optional-invocation, optional-receiver,
  wrong-arity, spread, and non-number forms decline before claim. Symbol and
  coercive forms retain the direct path and established `TypeError` behavior.
- Focused ownership tests pass 14/14, affected #3526 manifest, integration,
  and linear-legality suites pass 13/13, and scoped #249, #1371, Symbol,
  equivalence, and codegen regressions pass 9/9. TypeScript 7,
  kind-neutrality, Prettier, Biome, LOC/function budgets, oracle/coercion
  ratchets, numeric-local parity (18/18), and issue integrity pass.
- Luna Max final review returned GO with no P0/P1 finding and independently
  confirmed NaN payload parity, signed zero, the tie rule, large integrals,
  one evaluation, provider materialization, fallbacks, rollback, linear
  legality, and all twenty-eight-entry contracts.
- PR #5132 is open non-draft and mergeable, stacked directly on #5129's exact
  `Math.sign` ownership branch with CLA green and merge automation armed.

## Non-goals

- General ToNumber coercion, aliases, computed/extracted calls, optional
  chaining, `.call`, or `.apply`.
- A new rounding algorithm, native linear `Math.round`, `Math.fround`,
  `Math.clz32`, `Math.imul`, variadic Math methods, or Number formatting.
- `Math.random`; RNG requires a stateful effect and target-capability design.
- Async, class, module-init, or broader ownership expansion.

## Risk and rollback

The primary risks are accidentally canonicalizing NaN, losing negative zero,
or using the wrong tie rule while moving the established direct schedule into
source. Raw-bit direct/IR parity is the migration invariant.
`JS2WASM_IR_MATH_ROUND=0` provides narrow rollback;
`JS2WASM_IR_FIRST=0` remains the global control.
