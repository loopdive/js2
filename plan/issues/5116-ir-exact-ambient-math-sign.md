---
id: 5116
title: "IR: own exact ambient Math.sign calls"
status: in-progress
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5116-ir-math-sign
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [5115]
related: [1371, 1732, 3141, 3204, 3526, 4787, 5092, 5094, 5101, 5103, 5105, 5106, 5110, 5111, 5114]
files:
  - src/stdlib/math.ts
  - src/codegen/index.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-5116-ir-math-sign.test.ts
loc-budget-allow:
  - src/stdlib/math.ts
  - src/codegen/index.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5116 — Exact ambient `Math.sign` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.sign(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent the source call as a versioned semantic intrinsic and
replace its hand-emitted direct body with one dependency-free, host-free
self-hosted provider shared by direct and IR materialization.

This checkpoint is intentionally stacked on #5123/#5115. It preserves the
existing exact semantics for NaN, signed zero, infinities, subnormals, and
finite values while leaving coercive and dynamic forms on direct codegen.

## Measured residual

`sign` is absent from `IR_MATH_METHOD_TABLE`, so exact numeric calls currently
produce selector-stage `body-shape-rejected` telemetry and emit a legacy body.
The direct implementation in `compileMathCall` evaluates the argument once,
passes through NaN and signed zero, and otherwise applies the operand sign to
one. Unlike the previous 26 methods, no self-hosted `Math_sign` helper exists,
so this checkpoint first expresses that established behavior in the verified
stdlib dialect.

Two Luna Max audits ranked `Math.sign` as the lowest-risk remaining pure Math
residual. `Math.random` is explicitly unsuitable for this slice because the
current semantic intrinsic contract is pure while RNG is observably stateful
and target-capability dependent.

## Exact admitted grammar

Admit only a non-optional `Math.sign(argument)` when `Math` is the unshadowed
ambient binding, there is exactly one non-spread argument, the selector proves
primitive `number`, symbolic Math helpers are available, and the containing
unit passes ordinary ownership/call-graph gates. Aliased, computed, optional,
shadowed, coercive, Symbol, spread, and wrong-arity forms remain direct.

## Implementation plan

1. Add a dependency-free `Math_sign` self-hosted source that evaluates NaN,
   signed zero, and sign exactly like the current direct body; register it in
   `SELF_HOSTED_MATH` and the direct helper-demand set.
2. Add `math.sign` to the closed intrinsic/runtime-feature vocabularies with a
   unary-f64 signature and a dependency-free `selfhost.math.sign` provider.
3. Add `sign` to `IR_MATH_METHOD_TABLE` and reuse the generic selector,
   call-graph walker, from-AST emitter, manifest, and provider materializer.
4. Add an independent `JS2WASM_IR_MATH_SIGN=0` rollback.
5. Widen #3526 exhaustive vocabulary, integration, linear-deferral, and
   neutrality evidence from twenty-six to twenty-seven source Math intrinsics.
6. Add focused host/standalone ownership, dependency-free provider closure,
   exact direct parity, rollback, explicit production-linear deferral, and
   pre-claim exclusion tests across NaN, signed zero, subnormals, finite signs,
   and infinities. Retain the existing Symbol TypeError regression.
7. Re-run existing Math.sign equivalence/coercion regressions, affected #3526
   suites, TypeScript 7, formatting/lint/ratchets, and full pre-push checks;
   then open a non-draft PR stacked on #5123.

## Acceptance criteria

- Exact ambient one-number `Math.sign` calls emit IR only and attach one
  dependency-free, host-free self-hosted callable.
- Host and zero-import standalone execution are bit-identical to the direct
  path across NaN, signed zero, subnormals, finite values, and infinities.
- Production linear selection remains explicit legacy deferral; the manifest's
  catalogue support must not be mistaken for backend legality.
- Symbol/coercive and all other excluded shapes preserve direct behavior and
  decline before claim without invariants or post-claim errors.
- The narrow rollback, affected regressions, TypeScript 7, and all pre-push
  gates pass.

## Non-goals

- General ToNumber coercion, aliases, computed/extracted calls, optional
  chaining, `.call`, or `.apply`.
- `Math.round`, `fround`, `clz32`, `imul`, variadic Math methods, or Number
  predicate/formatting expansion.
- `Math.random`; RNG requires a stateful effect and target-capability design.
- Async, class, module-init, or broader ownership expansion.

## Risk and rollback

The primary semantic risk is changing evaluation or bit identity for NaN and
negative zero while replacing the direct body with a self-hosted helper. Exact
direct/IR parity and existing Symbol-coercion tests are the hard boundaries.
`JS2WASM_IR_MATH_SIGN=0` provides narrow rollback;
`JS2WASM_IR_FIRST=0` remains the global control.
