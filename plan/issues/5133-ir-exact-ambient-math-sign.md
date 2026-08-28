---
id: 5133
title: "IR: own exact ambient Math.sign calls"
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
depends_on: [5132]
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
  - tests/issue-5133-ir-math-sign.test.ts
loc-budget-allow:
  - src/stdlib/math.ts
  - src/codegen/index.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
---

# #5133 — Exact ambient `Math.sign` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.sign(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent the source call as a versioned semantic intrinsic and
materialize it through one dependency-free, host-free self-hosted provider.
Excluded forms retain the established hand-emitted direct fallback.

This checkpoint depends on issue #5132 and is co-located with it in the
consolidated PR #5145. It preserves the existing exact semantics for NaN,
signed zero, infinities, subnormals, and finite values while leaving coercive
and dynamic forms on direct codegen.

## Measured residual

Before this checkpoint, `sign` was absent from `IR_MATH_METHOD_TABLE`, so exact
numeric calls produced selector-stage `body-shape-rejected` telemetry and
emitted a legacy body. The direct implementation in `compileMathCall`
evaluates the argument once, canonicalizes NaN, passes through signed zero, and
otherwise applies the operand sign to one. Unlike the previous 26 methods, no
self-hosted `Math_sign` helper existed, so this checkpoint first expressed that
established behavior in the verified stdlib dialect.

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
   signed zero, and sign exactly like the current direct body. Force the
   generated NaN through `Math.abs` so host constant-folding cannot retain a
   platform-dependent sign bit; register it in `SELF_HOSTED_MATH` and the
   direct helper-demand set.
2. Add `math.sign` to the closed intrinsic/runtime-feature vocabularies with a
   unary-f64 signature and a dependency-free `selfhost.math.sign` provider.
3. Add `sign` to `IR_MATH_METHOD_TABLE` and reuse the generic selector,
   call-graph walker, from-AST emitter, manifest, and provider materializer.
4. Add an independent `JS2WASM_IR_MATH_SIGN=0` rollback.
5. Widen #3526 exhaustive vocabulary, integration, linear-deferral, and
   neutrality evidence from twenty-six to twenty-seven source Math intrinsics.
6. Add focused host/standalone ownership, dependency-free provider closure,
   exact direct parity, rollback, explicit linear-backend rejection, and
   pre-claim exclusion tests across NaN, signed zero, subnormals, finite signs,
   and infinities. Retain the existing Symbol TypeError regression.
7. Re-run existing Math.sign equivalence/coercion regressions, affected #3526
   suites, TypeScript 7, formatting/lint/ratchets, and full pre-push checks;
   publish the checkpoint in the consolidated non-draft PR #5145.

## Acceptance criteria

- Exact ambient one-number `Math.sign` calls emit IR only and attach one
  dependency-free, host-free self-hosted callable.
- Host and zero-import standalone execution are bit-identical to the direct
  path across NaN, signed zero, subnormals, finite values, and infinities.
- Linear legality rejects the callable provider; the production target's
  established direct `Math.sign` limitation remains explicit, and catalogue
  support is not mistaken for backend support.
- Symbol/coercive and all other excluded shapes preserve direct behavior and
  decline before claim without invariants or post-claim errors.
- The narrow rollback, affected regressions, TypeScript 7, and all pre-push
  gates pass.

## Implementation outcome and validation

- `math.sign` is the twenty-seventh certified pure Math intrinsic. Exact
  ambient one-number calls now emit IR-only bodies and resolve through the
  dependency-free `selfhost.math.sign` provider and `Math_sign` symbol.
- The self-hosted source canonicalizes NaN to the same raw f64 bits as direct
  codegen, preserves both signed zeros, and returns exact sign units for
  subnormals, finite values, and infinities. The NaN arm applies `f64.abs` to
  the result of `0 / 0`, clearing the implementation-chosen NaN sign whether
  the division is folded or evaluated by Wasm. The IR instruction carries one
  SSA argument, preserving one evaluation before the call boundary.
- Host execution requests no Math import; standalone execution has zero Wasm
  imports. The manifest closure contains only `math.sign`, with no dependency
  or host capability.
- Shadowed, aliased, computed, optional-invocation, optional-receiver,
  wrong-arity, spread, and non-number forms decline before claim. The existing
  Symbol path remains direct and throws `TypeError`.
- Focused ownership tests pass 15/15, the affected #3526 manifest,
  integration, and linear-legality suites pass 13/13, and existing scoped
  `Math.sign` equivalence, stdlib, #324, and Symbol regressions pass 6/6.
  TypeScript 7, kind-neutrality, Prettier, Biome, LOC/function budgets,
  oracle/coercion ratchets, numeric-local parity (18/18), and issue integrity
  pass.
- Luna Max final review returned GO with no P0/P1 finding and independently
  confirmed canonical NaN bits, signed zero, one evaluation, fallback
  boundaries, host-free materialization, and linear legality.
- The original stacked checkpoint was consolidated into PR #5145 with the
  other small exact Math/ToUint32 ownership slices. A Linux/x86 changed-root
  run exposed the host-dependent `0 / 0` NaN sign; the follow-up fixes the
  provider and freezes both positive-canonical raw bits and the emitted
  `f64.abs` instruction so arm64 cannot mask the regression.

## Non-goals

- General ToNumber coercion, aliases, computed/extracted calls, optional
  chaining, `.call`, or `.apply`.
- `Math.round`, `fround`, `clz32`, `imul`, variadic Math methods, or Number
  predicate/formatting expansion.
- `Math.random`; RNG requires a stateful effect and target-capability design.
- Async, class, module-init, or broader ownership expansion.

## Risk and rollback

The primary semantic risk is changing evaluation or bit identity for NaN and
negative zero while adding the IR-owned self-hosted path. Exact direct/IR
parity and existing Symbol-coercion tests are the hard boundaries.
`JS2WASM_IR_MATH_SIGN=0` provides narrow rollback;
`JS2WASM_IR_FIRST=0` remains the global control.
