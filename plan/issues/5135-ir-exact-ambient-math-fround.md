---
id: 5135
title: "IR: own exact ambient Math.fround calls"
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
language_feature: math-builtins
goal: ir-full-coverage
depends_on: [5134]
related: [78, 111, 936, 1371, 1437, 3526, 4787, 5133, 5134]
files:
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/intrinsic-support.ts
  - src/ir/lower.ts
  - src/ir/select.ts
  - src/ir/backend/emitter.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/porffor/sink.ts
  - scripts/check-ir-kind-neutrality.mjs
  - scripts/ir-kind-neutrality-baseline.json
  - tests/issue-3526-ir-math-intrinsic-integration.test.ts
  - tests/issue-3526-ir-runtime-manifest.test.ts
  - tests/issue-3526-ir-linear-math-intrinsics.test.ts
  - tests/issue-5135-ir-math-fround.test.ts
loc-budget-allow:
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/intrinsic-support.ts
  - src/ir/lower.ts
  - src/ir/select.ts
  - src/ir/backend/emitter.ts
  - src/ir/backend/legality.ts
  - src/ir/backend/porffor/sink.ts
func-budget-allow:
  - src/ir/select.ts::selectorSupportsMathPlan
  - src/ir/intrinsic-support.ts::providerAttachment
  - src/ir/intrinsic-support.ts::sameProvider
  - src/ir/lower.ts::emitPreparedIntrinsic
  - src/ir/backend/legality.ts::linearInstrError
  - src/ir/backend/porffor/sink.ts::PorfforEmitter.emitNumericConversion
---

# #5135 — Exact ambient `Math.fround` IR ownership

## Objective

Retire the direct AST-to-Wasm route for exact ambient
`Math.fround(numberExpression)` calls in otherwise IR-eligible synchronous
functions. Represent the source call as the twenty-ninth versioned pure-Math
intrinsic and attach one closed native backend-sequence provider that emits
`f32.demote_f64` followed by `f64.promote_f32` on both WasmGC and linear.

This checkpoint is intentionally stacked on PR #5132 / issue #5134. It
introduces no runtime helper, import, or public f32 source/IR signature:
`math.fround` remains strictly `(f64) -> f64`, and f32 exists only as the
backend stack intermediate between the two exact conversion instructions.

## Measured residual and feasibility

`compileMathCall` already implements exact `Math.fround` behavior as the two
native Wasm conversions. Both direct WasmGC and linear instruction encoders
support them, including IEEE round-to-nearest-ties-even, NaN, signed zero,
subnormal, finite overflow-to-infinity, and infinity behavior. Exact numeric
calls remain absent from `IR_MATH_METHOD_TABLE`, so they currently emit legacy
bodies.

The semantic provider layer currently models either one closed f64 backend op
or one callable. A Luna Max audit found no P0 blocker and identified one narrow
P1 prerequisite: add a closed `backend-sequence` provider whose only vocabulary
member is `f64.fround`. An architecture review rejected arbitrary instruction
arrays, a self-hosted f64 approximation, and exposing f32 in the semantic
signature.

## Exact admitted grammar

Admit only a non-optional `Math.fround(argument)` when `Math` is the unshadowed
ambient binding, there is exactly one non-spread argument, the selector proves
primitive `number`, and the containing unit passes ordinary ownership and
call-graph gates. Aliased, computed, optional, shadowed, coercive, Symbol,
spread, and wrong-arity forms remain direct.

## Closed backend-sequence contract

Add one semantic provider variant:

```ts
type IrIntrinsicBackendSequence = "f64.fround";

type IrIntrinsicProvider =
  | { kind: "backend-op"; opcode: IrIntrinsicBackendOp }
  | { kind: "backend-sequence"; sequence: IrIntrinsicBackendSequence }
  | { kind: "callable"; target: IrFuncRef };
```

`backend.f64.fround` provides `math.fround` with unary-f64 signature, no
dependency, no host capability, and both WasmGC/linear support. Lowering must
match the closed sequence exhaustively and emit exactly:

```text
f32.demote_f64
f64.promote_f32
```

The implementation extends the existing typed `BackendNumericConversionOp`
emitter seam with those two conversion names and calls
`emitNumericConversion` twice. It does not widen `IrUnop`, add a generic raw
sequence, allocate a local, or evaluate the source argument more than once.
WasmGC and linear already append typed conversion instructions through this
seam. Bytecode remains fail-loud through its existing unsupported-conversion
arm, and Porffor must reject the two new conversion names explicitly rather
than silently dropping the popped value.

## Implementation plan

1. Add the closed `IrIntrinsicBackendSequence` vocabulary and
   `backend-sequence` provider attachment shape. Extend the runtime provider
   implementation union and math-only extraction without changing the five
   single-op `IrIntrinsicBackendOp` members.
2. Teach provider attachment/equality to preserve and compare the sequence.
   Add exhaustive lowering for `f64.fround` through two typed numeric
   conversions and explicit non-Wasm backend rejection.
3. Add `math.fround` and `backend.f64.fround` to the intrinsic, feature,
   provider, and signature catalogues with no dependencies/capabilities.
4. Add a sequence-marked `fround` method plan so both the WasmGC symbolic path
   and linear selector admit it, and add independent
   `JS2WASM_IR_MATH_FROUND=0` rollback. Keep generic from-AST emission.
5. Widen linear legality from five to six native Math semantics only for the
   closed fround sequence. Unknown/malformed sequence values, missing
   providers, unsupported adapters, and provider-shape drift must fail closed.
6. Widen #3526 exhaustive vocabulary, integration, manifest, linear-legality,
   and neutrality evidence from twenty-eight to twenty-nine source Math
   intrinsics.
7. Add focused host, zero-import standalone, and production-linear ownership
   and execution; provider attachment for both policies; exact two-op WAT;
   raw-bit direct parity; rollback; and pre-claim exclusions. Pin custom NaNs,
   both zeros, f32 midpoint ties and adjacent doubles, f64/f32 subnormals,
   finite f32 overflow boundaries, large values, and infinities.
8. Re-run existing fround/Test262-focused regressions, affected #3526 suites,
   TypeScript 7, formatting/lint/ratchets, and full pre-push checks; then open a
   non-draft PR stacked on #5132.

## Acceptance criteria

- Exact ambient one-number `Math.fround` calls emit IR only on WasmGC and
  linear, with one closed `backend-sequence` provider and no helper/import.
- Lowering evaluates one f64 argument once, emits exactly demote then promote,
  and returns f64 without exposing an f32 semantic value.
- Host, zero-import standalone, and production linear execution are raw-bit
  identical to direct codegen across NaN payload behavior, signed zero,
  midpoint ties, subnormals, finite range edges, and infinities.
- The provider closure is exactly `math.fround`; malformed/unknown sequences,
  missing providers/adapters, and unsupported non-Wasm sinks fail loudly.
- Coercive and all other excluded shapes preserve direct behavior and decline
  before claim without invariants or post-claim errors.
- The narrow rollback, affected regressions, TypeScript 7, and all pre-push
  gates pass.

## Outcome

Completed on 2026-08-28 in non-draft PR
[#5135](https://github.com/loopdive/js2/pull/5135), stacked on #5132.

- Added `math.fround` as the twenty-ninth certified pure-Math intrinsic and
  attached the dependency-free, host-free `backend.f64.fround` provider for
  WasmGC and linear policies.
- Added the one-member `backend-sequence` contract and lowered it through the
  typed emitter seam as exactly `f32.demote_f64` then `f64.promote_f32`.
  Bytecode remains fail-loud and Porffor now rejects both conversions
  explicitly.
- Exact ambient one-number calls are IR-owned on WasmGC and production linear;
  excluded/coercive forms still decline before claim, and
  `JS2WASM_IR_MATH_FROUND=0` provides narrow rollback.
- Focused validation passed 15/15 cases, including production-linear ownership,
  malformed-sequence rejection, zero-import standalone execution, and raw-bit
  parity across custom NaNs, signed zero, f32 midpoint ties, subnormal/normal
  boundaries, overflow, finite extremes, and infinities.
- The 13 affected #3526 integration, manifest, and linear-legality tests passed.
  TypeScript 7, IR kind-neutrality, formatting, lint, ratchets, numeric-local
  parity, issue integrity, and the full pre-push suite passed.
- Final Luna Max review returned GO with no actionable P0/P1 findings. At the
  implementation checkpoint, PR #5135 was non-draft, cleanly mergeable, and
  green on CLA and automation checks.

## Non-goals

- Arbitrary backend instruction arrays or a general sequence DSL.
- A public f32 source/IR signature, f32 locals, or a self-hosted approximation.
- Changes to legacy WasmGC/linear direct `Math.fround` lowering.
- `Math.clz32`/`imul` ownership before the shared `ToUint32` saturation bug is
  fixed; variadic `min/max/hypot`; or stateful `Math.random`.
- Async, class, module-init, or broader ownership expansion.

## Risk and rollback

The main architectural risk is turning one exact closed sequence into an
untyped raw-instruction escape hatch; the one-member vocabulary and exhaustive
switch prevent that. Numeric risk is conversion order or hidden re-evaluation,
guarded by raw-bit direct parity and exact WAT assertions.
`JS2WASM_IR_MATH_FROUND=0` provides narrow rollback;
`JS2WASM_IR_FIRST=0` remains the global control.
