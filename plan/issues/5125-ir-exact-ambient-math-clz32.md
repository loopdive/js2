---
id: 5125
title: "IR: own exact ambient Math.clz32 calls"
status: in-progress
created: 2026-08-28
updated: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5125-ir-math-clz32
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, backend, codegen
language_feature: math-builtins, numeric-coercion
goal: ir-full-coverage
depends_on: [5119]
required_by: [5126]
related: [78, 83, 111, 936, 1094, 1126, 1371, 3526, 3739, 5118, 5119]
files:
  - plan/issues/5119-ir-exact-touint32-prerequisite.md
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/lower.ts
  - src/ir/select.ts
  - src/ir/backend/legality.ts
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-3526-ir-linear-math-intrinsics.test.ts
  - tests/issue-5125-ir-math-clz32.test.ts
loc-budget-allow:
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/lower.ts
  - src/ir/select.ts
  - src/ir/backend/legality.ts
func-budget-allow:
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
  - src/ir/select.ts::selectorSupportsMathPlan
  - src/ir/backend/legality.ts::linearInstrError
---

# #5125 — Exact ambient `Math.clz32` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.clz32(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent the source operation as a typed
`math.clz32: f64 -> u32` semantic intrinsic and freeze one host-free composite
provider that applies the exact shared `ToUint32` expansion from #5119 followed
by native `i32.clz` on WasmGC and production linear.

This checkpoint is intentionally stacked on #5137/#5119. It claims only
`Math.clz32`; `Math.imul` remains the independent #5126 follow-up.

## Existing exact substrate

Direct codegen currently compiles `Math.clz32(x)` as a call to the collected
`__toUint32` helper followed by `i32.clz` and signed i32-to-f64 conversion.
#5119 repaired that helper for values beyond signed i64 and extracted the same
IEEE-754 sign/exponent/significand expansion into
`emitWasmInt32Coercion`. The IR lowerer already uses that expansion for
`js.to_uint32` and bitwise coercion with one lazily allocated four-i64 scratch
pool.

The remaining gap is source ownership: `clz32` is absent from
`IR_MATH_METHOD_TABLE`, the pure-Math intrinsic catalogue, and the runtime
provider catalogue, so exact calls still emit legacy bodies.

## Exact admitted grammar

Admit only a non-optional `Math.clz32(argument)` when `Math` is the unshadowed
ambient binding, there is exactly one non-spread argument, the selector proves
primitive `number`, and the containing unit passes ordinary ownership and
call-graph gates. Aliased, computed, optional, shadowed, coercive, Symbol,
spread, zero-argument, and extra-argument forms remain direct.

The semantic result is unsigned i32 because `Math.clz32` returns an integer in
`[0, 32]` and the existing propagation contract classifies it as `u32`.
Ordinary number return/export boundaries must widen it with
`f64.convert_i32_u`; no signed `-1` interpretation is permitted to leak from
the raw i32 carrier.

## Closed provider contract

Extend the backend-composite vocabulary with exactly `math.clz32`. Its provider
consumes one f64, emits the shared exact low-32-bit expansion, then emits one
`i32.clz`, leaving a u32-shaped i32 result. The provider is dependency-free in
the runtime graph because it calls no helper/provider at runtime; #5119 is the
implementation prerequisite and the shared expansion is linked code, not a
second semantic invocation.

The provider must:

- evaluate the source argument exactly once;
- import no host function and call no `__toUint32` or Math helper;
- preserve exact `ToUint32` behavior for every f64, including NaN, infinities,
  fractions, and finite magnitudes beyond signed i64;
- emit the same closed instruction stream on WasmGC and production linear;
- remain rejected by bytecode and Porffor before emission.

## Implementation plan

1. Renumber #5119's stale follow-up references to the atomically reserved
   #5125/#5126 IDs.
2. Add `math.clz32` to the certified pure-Math ID and runtime-feature
   catalogues with the existing f64-to-u32 signature. Add one
   `backend.js.math.clz32` composite provider for all targets and both Wasm
   backends, with no dependencies or host capabilities.
3. Add a composite-marked `clz32` method plan and narrow
   `JS2WASM_IR_MATH_CLZ32=0` rollback. Preserve the generic ambient binding,
   exact arity, non-spread, and primitive-number selector/from-AST path.
4. Extend the closed composite operation union and lower `math.clz32` by
   reusing `emitWasmInt32Coercion` with the existing lazy i64 scratch pool,
   followed by one `i32.clz`.
5. Admit only `math.clz32` at the linear legality boundary; bytecode and
   Porffor retain explicit semantic-intrinsic rejection.
6. Widen the #3526 exhaustive catalogue, runtime manifest, and exact native
   linear set from twenty-nine to thirty Math methods while special-casing the
   typed u32 result assertion.
7. Add focused host, zero-import standalone, and production-linear ownership;
   provider attachment; exact WAT; direct parity over boundary and huge-finite
   values; rollback; and pre-claim exclusions.
8. Run focused Math/ToUint32 regressions, TypeScript 7, formatting, lint,
   neutrality, LOC/function ratchets, and the full pre-push suite. Push the
   plan and implementation as separate checkpoints and open a non-draft PR
   stacked on #5137.

## Acceptance criteria

- Exact ambient one-number `Math.clz32` calls emit IR only on WasmGC and
  production linear with one typed u32 result and no helper/import.
- Runtime results match native JavaScript across zero/high-bit patterns,
  fractions, signed zero, NaN, infinities, `2**32` boundaries, `2**63`,
  `2**64`, `2**65`, `1e20`, and `Number.MAX_VALUE`.
- The frozen provider is dependency-free and host-free, evaluates one f64
  once, uses the shared exact coercion, and ends with one `i32.clz`.
- Export and arithmetic boundaries preserve the result as numeric 0..32 on
  both Wasm backends.
- Missing/malformed providers and unsupported bytecode/Porffor policies fail
  before emission; no saturation or callable fallback is introduced.
- Coercive and excluded call shapes keep direct ownership, and rollback causes
  a clean pre-claim decline with no post-claim errors.

## Non-goals

- `Math.imul`, variadic `min`/`max`/`hypot`, or stateful `Math.random`.
- General object/Symbol/BigInt ToNumber coercion admission.
- A generic arbitrary instruction-sequence provider or expansion DSL.
- Replacing the legacy `__toUint32` helper, which remains required by direct
  `Math.clz32`/`Math.imul` fallbacks.

## Risk and rollback

The primary risk is losing unsigned-result evidence at an IR or export
boundary. Focused result-type/provider assertions and runtime checks at 32-bit
high-bit inputs guard that seam. The second risk is selector overreach into
coercive or optional calls; exclusion and rollback tests keep those shapes
legacy-owned. `JS2WASM_IR_MATH_CLZ32=0` provides narrow rollback, while
`JS2WASM_IR_FIRST=0` remains the global control.

## Outcome

Pending implementation and final Luna Max review.
