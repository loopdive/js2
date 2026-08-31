---
id: 5130
title: "IR: own exact ambient Math.min/max calls"
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
area: ir, backend, codegen
language_feature: math-builtins, signed-zero, nan-propagation
goal: ir-full-coverage
depends_on: [5126]
required_by: []
related: [78, 83, 85, 111, 302, 936, 1094, 1371, 2054, 2057, 2933, 3526, 5126]
files:
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/lower.ts
  - src/ir/select.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/wasm-math-minmax.ts
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-3526-ir-linear-math-intrinsics.test.ts
  - tests/issue-5130-ir-math-minmax.test.ts
loc-budget-allow:
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/lower.ts
  - src/ir/select.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/wasm-math-minmax.ts
func-budget-allow:
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
  - src/ir/select.ts::selectorSupportsMathPlan
  - src/ir/backend/legality.ts::linearInstrError
---

# #5130 — Exact ambient `Math.min` / `Math.max` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.min(numberExpression, numberExpression)` and
`Math.max(numberExpression, numberExpression)` calls in otherwise IR-eligible
synchronous functions. Represent each operation as a typed
`(f64, f64) -> f64` semantic intrinsic and freeze dependency-free, host-free
backend composites that preserve ECMAScript NaN and signed-zero behavior.

This checkpoint stacks on #5126. It claims the common exact-binary surface
without conflating it with the genuinely variadic function-value, spread, or
coercive paths already owned by direct codegen.

## Exact admitted grammar

Admit only non-optional `Math.min(left, right)` and
`Math.max(left, right)` when `Math` is the unshadowed ambient binding, there
are exactly two non-spread arguments, both are proven primitive `number`, and
the containing unit passes ordinary IR ownership and call-graph gates. Aliased,
computed, optional, shadowed, coercive, Symbol, BigInt, spread, zero-argument,
unary, and three-or-more-argument forms remain direct.

Both semantic signatures are f64/f64 to f64. JavaScript evaluates both
arguments left-to-right before comparing them; selection must not fold or
reorder either expression.

## Closed binary composites

`emitPreparedIntrinsic` evaluates arguments left-to-right and leaves both
f64s on the Wasm stack before invoking a composite. For stack
`[left, right]`, each closed min/max expansion must:

1. store `right`, then `left`, in two lazily allocated f64 backend locals;
2. test `left !== left` and return that NaN when true;
3. otherwise test `right !== right` and return that NaN when true;
4. otherwise reload `left` and `right` and emit `f64.min` or `f64.max`.

The explicit guards pin JavaScript any-NaN propagation instead of relying on
engine-specific NaN behavior. Wasm `f64.min` and `f64.max` then provide the
required signed-zero ordering: min prefers -0 and max prefers +0 regardless of
operand order.

The runtime providers have no semantic dependencies or host capabilities.
WasmGC and production linear receive the same closed instruction stream.
Bytecode and Porffor remain rejected by legality before emission.

## Implementation plan

1. Add `math.min` and `math.max` to the certified Math ID/runtime-feature
   catalogues with the existing f64-binary signature and add dependency-free
   `backend.math.min` / `backend.math.max` composite provider metadata.
2. Initial rollout added exact-binary composite selector plans plus narrow
   per-method rollbacks while retaining ambient-binding, exact-arity,
   non-spread, and primitive-number
   admission gates.
3. Extend the closed composite union and add one shared Wasm min/max emitter
   using two lazily allocated f64 locals, explicit ordered NaN guards, and the
   selected native opcode.
4. Admit only `math.min` and `math.max` at the production-linear semantic
   intrinsic legality boundary; bytecode and Porffor remain fail-closed.
5. Widen #3526's exhaustive catalogue, manifest, provider attachment, and
   native-linear fixtures from thirty-one to thirty-three Math methods.
6. Add focused host, zero-import standalone, and production-linear ownership;
   provider shape; identical WasmGC/linear stack sequence; native/direct parity
   over finite values, infinities, NaNs in both positions, and all signed-zero
   orders; composition; rollback; exact argument evaluation; and pre-claim
   exclusions.
7. Run TypeScript 7, focused prerequisites/integration suites, formatting,
   lint, neutrality, LOC/function/oracle/coercion ratchets, issue integrity,
   and the full pre-push gate. Push plan and implementation as separate
   checkpoints to a non-draft PR stacked on #5144.

## Acceptance criteria

- Exact ambient two-number min/max calls emit IR-only bodies on WasmGC and
  production linear with no Math helper call or host import.
- Results match native JavaScript and direct codegen for finite values,
  infinities, NaNs in either position, and both operand orders of +0/-0.
- Left and right arguments are each evaluated exactly once in source order,
  including when the left result is NaN.
- Each provider is frozen, dependency-free, host-free, and emits two stores,
  ordered NaN guards, then exactly one `f64.min` or `f64.max`.
- Missing/malformed providers and unsupported bytecode/Porffor consumers fail
  closed; excluded/coercive/variadic shapes retain direct ownership and the
  former rollback was pre-claim only.

## Non-goals

- Zero-, one-, or three-plus-argument min/max calls, spread arguments, and
  first-class/aliased variadic Math values.
- General ToNumber admission or compile-time min/max folding.
- `Math.hypot`, stateful `Math.random`, or a generic arbitrary backend
  expansion DSL.

## Risk and rollback

The primary risk is allowing a raw Wasm min/max instruction to hide NaN or
signed-zero differences. Ordered local-based guards and reciprocal-zero tests
pin those semantics independently for each method. The second risk is
short-circuiting right-argument evaluation when left is NaN; argument-order
fixtures require both effects before the composite executes.
During initial rollout, the per-method controls independently withdrew the
claims, while
`JS2WASM_IR_FIRST=0` remains the global control.

## Outcome

Implemented exact ambient two-number `Math.min` and `Math.max` ownership as
typed binary semantic intrinsics backed by dependency-free, host-free Wasm
composites. Each composite stores both already-evaluated operands, propagates
left then right NaN explicitly, and uses regular `f64.min` / `f64.max` for
the required signed-zero ordering. WasmGC and production linear emit identical
closed bodies; bytecode and Porffor remain fail-closed, and each method had an
independent narrow rollback during initial rollout.

Validation passed for all 19 focused #5130 cases, the #3526 linear,
integration, and manifest suites plus the #5126 prerequisite (27/27), and the
existing direct/equivalence min/max fallback suites (21/21). TypeScript 7,
lint, formatting, IR kind-neutrality, LOC/function budgets, oracle/coercion
ratchets, and issue integrity passed. Three Luna Max architecture and priority
audits independently selected this exact checkpoint and found no
checkpoint-scoped semantic blocker.

## 2026-08-30 retirement update

The rollout-only per-method withdrawals are retired by the #4522 Math checkpoint.
Exact ambient, global-direct parity, and all existing numeric and near-miss
coverage remain. The shared #3518 matrix provides the literal closed cross-method
census; `experimentalIR: false` is the retained observational oracle.
