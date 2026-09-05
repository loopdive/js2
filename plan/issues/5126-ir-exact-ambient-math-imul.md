---
id: 5126
title: "IR: own exact ambient Math.imul calls"
status: done
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5126-ir-math-imul
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, backend, codegen
language_feature: math-builtins, numeric-coercion
goal: ir-full-coverage
depends_on: [5125]
required_by: []
related: [78, 83, 111, 936, 1094, 1126, 1371, 3526, 3739, 5125, 5136]
files:
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/lower.ts
  - src/ir/select.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/wasm-int32-coercion.ts
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-3526-ir-linear-math-intrinsics.test.ts
  - tests/issue-5126-ir-math-imul.test.ts
loc-budget-allow:
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/lower.ts
  - src/ir/select.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/wasm-int32-coercion.ts
func-budget-allow:
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
  - src/ir/select.ts::selectorSupportsMathPlan
  - src/ir/backend/legality.ts::linearInstrError
---

# #5126 — Exact ambient `Math.imul` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.imul(numberExpression, numberExpression)` calls in otherwise IR-eligible
synchronous functions. Represent the operation as a typed
`math.imul: (f64, f64) -> f64` semantic intrinsic and freeze one host-free
backend composite that applies #5136's exact ToUint32 expansion to both
operands, multiplies their low 32-bit patterns, and restores the signed Int32
result as a JavaScript Number.

This checkpoint stacks on #5125. It completes the two direct Math consumers of
the exact shared ToUint32 substrate; variadic and stateful Math methods remain
separate work.

## Exact admitted grammar

Admit only a non-optional `Math.imul(left, right)` when `Math` is the unshadowed
ambient binding, there are exactly two non-spread arguments, both are proven
primitive `number`, and the containing unit passes ordinary IR ownership and
call-graph gates. Aliased, computed, optional, shadowed, coercive, Symbol,
BigInt, spread, missing-argument, and extra-argument forms remain direct.

The semantic signature is f64/f64 to f64 because ECMAScript exposes the result
as Number. The composite's two internal i32 patterns are implementation detail;
`i32.mul` naturally keeps their low 32 bits and `f64.convert_i32_s` restores the
required signed Int32 result, including negative values and positive zero.

## Closed binary composite

`emitPreparedIntrinsic` evaluates arguments left-to-right and leaves both f64s
on the Wasm stack before invoking a composite. For stack `[left, right]`, the
closed `math.imul` expansion must:

1. consume and exactly coerce `right` with `emitWasmInt32Coercion`;
2. stash that i32 in one lazily allocated backend local;
3. consume and exactly coerce `left` using the same four-i64 scratch pool;
4. reload the right i32, emit `i32.mul`, then `f64.convert_i32_s`.

The runtime provider has no semantic dependency on `js.to_uint32`: it calls no
provider/helper at runtime, and the shared expansion is linked backend code.
WasmGC and linear receive the same closed instruction stream. Bytecode and
Porffor remain rejected by legality before emission.

## Implementation plan

1. Add `math.imul` to the certified Math ID/runtime-feature catalogues with the
   existing f64-binary signature and add dependency-free
   `backend.math.imul` composite provider metadata.
2. Initial rollout added a binary composite-marked selector plan and narrow
   per-method rollback while retaining the shared ambient-binding,
   exact-arity, non-spread, and primitive-number admission gates.
3. Extend the closed composite union and add an exact binary Wasm wrapper that
   uses one i32 rhs local plus #5136's reusable i64 coercion scratch.
4. Admit only `math.imul` at the linear semantic-intrinsic legality boundary;
   bytecode and Porffor remain fail-closed.
5. Widen #3526's exhaustive catalogue, manifest, provider attachment, and
   native-linear fixtures from thirty to thirty-one Math methods.
6. Add focused host, zero-import standalone, and production-linear ownership;
   provider shape; WAT ordering; direct/native parity over modulo and huge
   finite values; signed-result/zero behavior; composition; rollback; exact
   argument evaluation; and pre-claim exclusions.
7. Run TypeScript 7, focused prerequisites/integration suites, formatting,
   lint, neutrality, LOC/function/oracle/coercion ratchets, issue integrity, and
   the full pre-push gate. Push plan and implementation as separate checkpoints
   to a non-draft PR stacked on #5141.

## Acceptance criteria

- Exact ambient two-number `Math.imul` calls emit IR-only bodies on WasmGC and
  production linear with no Math/ToUint32 helper call or host import.
- Runtime results match native JavaScript and direct codegen for NaN,
  infinities, fractions, signed zero, high-bit 32-bit patterns, `2**32`
  boundaries, values beyond signed i64, `1e20`, and `Number.MAX_VALUE`.
- Left and right arguments are each evaluated exactly once in source order.
- The provider is frozen, dependency-free, host-free, and emits right coercion,
  one i32 stash, left coercion, `i32.mul`, and `f64.convert_i32_s` in that order.
- Missing/malformed providers and unsupported bytecode/Porffor consumers fail
  closed; excluded/coercive shapes retain direct ownership, and the former
  rollback was pre-claim only.

## Non-goals

- Variadic `Math.min`/`max`/`hypot`, stateful `Math.random`, or general object
  ToNumber admission.
- Making the early direct import collector IR-aware; a dead legacy
  `__toUint32` definition may remain in whole-module WAT, but the IR body may
  not call it.
- A generic arbitrary backend expansion DSL or cross-provider instruction
  inlining.

## Risk and rollback

The primary risk is reversing operands or destroying the left f64 while the
right operand is coerced. Stack-shape assertions, non-commutative coercion edge
vectors, and side-effect-order tests guard that seam. The second risk is using
saturating conversion for huge values; #5136 regression vectors remain in the
focused bundle. During initial rollout, the per-method control withdrew only
this claim, while
`JS2WASM_IR_FIRST=0` remains the global control.

## Outcome

Implemented exact ambient two-number `Math.imul` ownership as a typed binary
semantic intrinsic backed by one dependency-free, host-free Wasm composite.
The shared exact ToUint32 expansion coerces right then left, reuses the existing
i64 scratch pool plus one lazy i32 rhs local, multiplies with `i32.mul`, and
returns the signed Int32 result as f64. WasmGC and production linear emit the
same closed body; bytecode and Porffor remain fail-closed, and the per-method
control provided the narrow rollback during initial rollout.

Validation passed for the 14 focused #5126 cases, the #3526 linear,
integration, and manifest suites, the #5136 exact-coercion prerequisite (30/30
tests total), TypeScript 7, lint, formatting, IR kind-neutrality, LOC/function
budgets, oracle/coercion ratchets, and issue integrity. Luna Max architecture
and test audits confirmed the stack discipline, provider boundary, and focused
coverage with no checkpoint-scoped blockers.

## 2026-08-30 retirement update

The rollout-only per-method withdrawal is retired by the #4522 Math checkpoint.
Exact ambient, global-direct parity, and all existing numeric and near-miss
coverage remain. The shared #3518 matrix provides the literal closed cross-method
census; `experimentalIR: false` is the retained observational oracle.
