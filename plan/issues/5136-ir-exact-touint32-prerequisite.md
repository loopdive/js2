---
id: 5136
title: "IR: share exact ToUint32 lowering prerequisite"
status: done
created: 2026-08-28
updated: 2026-08-28
completed: 2026-08-28
assignee: ttraenkler/codex
branch: codex/5130-ir-math-minmax
priority: high
horizon: s
feasibility: high
reasoning_effort: max
task_type: refactor
area: ir, backend, codegen
language_feature: math-builtins, numeric-coercion
goal: ir-full-coverage
depends_on: [5135]
required_by: [5125, 5126]
related: [83, 111, 936, 1094, 1126, 1371, 3526, 3739, 5135]
files:
  - src/ir/backend/wasm-int32-coercion.ts
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/intrinsic-support.ts
  - src/ir/lower.ts
  - src/ir/backend/legality.ts
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/index.ts
  - tests/issue-5136-ir-exact-touint32.test.ts
loc-budget-allow:
  - src/ir/nodes.ts
  - src/ir/intrinsics.ts
  - src/ir/runtime-manifest.ts
  - src/ir/intrinsic-support.ts
  - src/ir/lower.ts
  - src/ir/backend/legality.ts
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/builtins.ts
  - src/codegen/index.ts
func-budget-allow:
  - src/ir/intrinsic-support.ts::providerAttachment
  - src/ir/intrinsic-support.ts::sameProvider
  - src/ir/lower.ts::emitPreparedIntrinsic
  - src/ir/lower.ts::lowerIrFunctionBody
  - src/ir/lower.ts::emitInstrTree
  - src/ir/lower.ts::emitJsToInt32
  - src/ir/backend/legality.ts::linearInstrError
  - src/ir/backend/legality.ts::bytecodeInstrError
  - src/ir/backend/legality.ts::porfforInstrError
  - src/codegen/binary-ops.ts::emitToInt32
  - src/codegen/expressions/builtins.ts::compileMathCall
  - src/codegen/index.ts::emitToUint32Helper
---

# #5136 — Shared exact `ToUint32` IR prerequisite

## Objective

Add a typed, provider-backed `js.to_uint32: f64 -> u32` semantic intrinsic and
establish one exact Wasm lowering for the 32-bit bit pattern shared by
ECMAScript `ToInt32` and `ToUint32`. Make the production IR bitwise lowerer and
the legacy `Math.clz32`/`Math.imul` helper consume that same expansion.

This checkpoint repairs the current large-finite direct-codegen bug and removes
the duplicated IR/direct implementation before either Math method is admitted
to IR. It is intentionally stacked on PR #5135 / issue #5135. The follow-up
checkpoints can attach `math.clz32` and `math.imul` providers to this exact
conversion without inheriting a known semantic defect.

## Measured defect

`emitToUint32Helper` currently lowers a finite input with:

```text
i64.trunc_sat_f64_s
i32.wrap_i64
```

That is exact only while the truncated magnitude fits signed i64. Outside that
range, the first operation saturates before the second keeps its low 32 bits.
For example, ECMAScript requires `ToUint32(2**63) === 0`, but signed-i64
saturation produces `INT64_MAX`, whose wrapped low bits are `0xffffffff`.
Consequently direct `Math.clz32(2**63)` and `Math.imul(2**63, 1)` are wrong.

The production IR bitwise path already avoids this defect. It decomposes the
f64 IEEE-754 sign, exponent, and significand, selects only the integer bits that
can reach the low 32 positions, and applies the sign modulo `2**32`. The direct
bitwise path carries a byte-identical copy. This is the proven implementation
to centralize; a new floating modulo approximation is unnecessary.

## Exact contract

For every f64 input, the shared Wasm expansion consumes one f64 and leaves one
i32 whose raw bits equal `ToUint32(input)`:

- `NaN`, `+0`, `-0`, and both infinities produce zero;
- finite fractions truncate toward zero before wrapping;
- all finite magnitudes wrap modulo `2**32`, including values outside signed
  and unsigned i64 range;
- negative inputs are negated modulo `2**32`;
- the i32 bit pattern also represents `ToInt32(input)`, with signedness chosen
  only when a later consumer widens or compares it.

The semantic signature is post-`ToNumber`: one f64 argument and an unsigned i32
result. Object, Symbol, BigInt, and dynamic coercion stay outside this
checkpoint. The provider is a closed `backend-composite` operation, not a
single Wasm opcode, arbitrary instruction list, or callable helper. It must not
import host JavaScript, trap on an f64 input, evaluate the input twice, or use a
saturating conversion as the semantic modulo operation.

## Implementation plan

1. Extract the existing exact IEEE-754 instruction expansion into a small
   Wasm-backend utility with an explicit four-i64-local contract. Keep it free
   of AST, selector, manifest, and `CodegenContext` dependencies.
2. Route direct `emitToInt32` and the WasmGC/linear arm of IR
   `emitJsToInt32` through that utility. Preserve their local allocation and
   release behavior and keep emitted Wasm byte-identical.
3. Add `js.to_uint32` outside the exact twenty-nine-method pure-Math catalogue,
   with f64-to-unsigned-i32 signature and one host-free `backend-composite`
   provider available only to WasmGC and production linear preparation.
   Preserve provider attachment/equality and missing-provider invariants.
4. Lower the composite provider through the shared exact expansion and the
   existing lazily allocated four-i64 scratch pool. Admit it in linear legality
   while keeping bytecode and Porffor explicitly fail-loud before emission.
5. Replace `emitToUint32Helper`'s saturating i64 conversion with the same
   expansion. Add only the four private i64 locals required by the shared
   contract; preserve the helper name, signature, registration point, and
   import-free behavior. Replace the two missing-helper saturation fallbacks
   with invariants so collection drift cannot silently reintroduce bad output.
6. Add focused execution vectors for synthetic `js.to_uint32` IR on WasmGC and
   production linear plus direct `Math.clz32` and `Math.imul` with IR
   disabled, including `2**63`, its negative, very large finite f64 values,
   `2**32` boundaries, fractions, signed zero, NaN, and infinities. Compare to
   native JavaScript rather than duplicating expected conversion logic.
7. Assert both provider and synthesized helper use the shared bit-decomposition
   shape and that the helper
   no longer contains `i64.trunc_sat_f64_s`. Pin zero imports in standalone
   mode and exact direct/IR parity for representative bitwise coercions.
8. Run the existing bitwise, Math builtin, #3526 integration, TypeScript 7,
   neutrality, formatting/lint/ratchets, and full pre-push suites. Push the
   plan, implementation, and outcome as separate checkpoints on a non-draft
   PR stacked on #5135.

## Acceptance criteria

- Direct `Math.clz32` and `Math.imul` match native JavaScript for every focused
  edge, especially finite values at and beyond `2**63`.
- Synthetic `js.to_uint32` IR prepares and executes on WasmGC and production
  linear with an unsigned-i32 result, no callable/helper, and no host import.
- Direct and IR bitwise lowering consume one shared exact expansion and retain
  their existing behavior and instruction shape.
- The generated `__toUint32` helper is import-free, non-trapping for all f64
  inputs, and contains no saturating signed-i64 modulo shortcut.
- Missing providers and unsupported bytecode/Porffor policies fail before
  emission; no backend silently substitutes saturation.
- Existing exact ambient Math ownership, fallback, and neutrality evidence
  remains green.

## Non-goals

- Claiming `Math.clz32` or `Math.imul` in IR; each gets a later small PR.
- Changing source coercion admission, object/Symbol/BigInt behavior, or method
  arity rules.
- Replacing every independent `ToUint32` implementation in string, RegExp,
  array-length, typed-array, or runtime code.
- Migrating variadic `Math.min`/`max`/`hypot` or stateful `Math.random`.

## Risk and rollback

The main risk is local-index drift while moving a stack-sensitive sequence.
Byte-shape assertions and direct-versus-IR execution parity guard that seam.
The Math helper keeps its existing registration and call ABI, so rollback is a
single checkpoint revert with no manifest or public API change.

## Outcome

Implemented one exact IEEE-754 bit-decomposition expansion shared by direct
`ToInt32`, IR bitwise coercion, the legacy `__toUint32` helper, and the new
typed `js.to_uint32` semantic intrinsic. The intrinsic freezes to one
dependency-free, host-free `backend-composite` provider and executes with an
identical instruction stream on WasmGC and production linear; bytecode and
Porffor reject it before emission.

The direct Math helper no longer saturates before wrapping, so `Math.clz32`
and `Math.imul` now match native JavaScript at and beyond the signed-i64 range.
Focused execution covers f64 boundaries, fractions, signed zero, NaN,
infinities, `2**63`, `2**64`, `2**65`, and `Number.MAX_VALUE`. The #3739 exact
ToInt32 suite, #3526 manifest/intrinsic suites, Math stdlib subset, TypeScript 7
typecheck, formatting, diff integrity, and the reviewed neutrality baseline all
pass.
