---
id: 4383
title: "UUID original suite exposes vector, crypto, exception, and callback ABI gaps"
status: in_progress
sprint: current
created: 2026-08-12
updated: 2026-08-12
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: arrays, closures, exceptions, crypto
goal: npm-library-support
assignee: ttraenkler/codex
related: [3995]
files:
  - tests/dogfood/uuid-upstream-suite.mjs
  - tests/dogfood/report/uuid-upstream-suite.json
loc-budget-allow:
  - src/codegen/statements/nested-declarations.ts
  - src/runtime.ts
  - src/codegen/expressions/identifiers.ts
  - src/codegen/array-methods.ts
  - src/codegen/index.ts
  - src/codegen/property-access.ts
  - src/codegen/expressions/call-tail-dispatch.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/expressions/call-identifier.ts
  - src/codegen/expressions/calls-closures.ts
  - src/codegen/closures.ts
  - src/codegen/closure-exports.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/object-runtime.ts
  - src/codegen/binary-ops.ts
  - src/codegen/registry/imports.ts
  - src/codegen/expressions/call-receiver-method.ts
  - src/codegen/context/types.ts
  - src/codegen/literals.ts
  - src/codegen/statements/variables.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
  - src/codegen/index.ts::generateMultiModule
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
  - src/codegen/expressions/identifiers.ts::compileIdentifierCore
  - src/codegen/expressions/calls.ts::compileCallExpression
  - src/codegen/statements/nested-declarations.ts::compileNestedFunctionDeclaration
  - src/runtime.ts::<anonymous>#89
  - src/codegen/vec-access-exports.ts::_emitVecAccessExportsInner
  - src/codegen/closures.ts::compileLiftedClosureBody
  - src/codegen/object-runtime.ts::fillApplyClosure
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/expressions/calls.ts::tryEmitInlineDynamicCall
  - src/codegen/binary-ops.ts::compileBinaryExpression
  - src/codegen/closures/arrow-phases.ts::planClosureCaptures
  - src/codegen/expressions/call-receiver-method.ts::compileReceiverMethodCall
  - src/codegen/expressions/call-tail-dispatch.ts::compileTailDispatch
  - src/codegen/closures.ts::compileArrowAsCallback
  - src/codegen/statements/nested-declarations.ts::emitSetExtrasArgv
  - src/codegen/array-methods.ts::compileArrayMethodCall
  - src/codegen/closure-exports.ts::emitClosureMethodCallExportN
  - src/codegen/literals.ts::compileArrayLiteral
  - src/codegen/index.ts::generateModule
  - src/codegen/statements/variables.ts::compileVariableStatement
  - src/codegen/statements/nested-declarations.ts::hoistFunctionDeclarations
---

# UUID original suite exposes vector, crypto, exception, and callback ABI gaps

## Problem

The pinned `uuid@14.0.1` adapter runs ten original upstream files and all 75
registered callbacks pass in Node. Only **3/75** pass after compiling the same
callbacks and the published implementation to Wasm. This is runtime evidence,
not an extrapolation from compiler diagnostics.

Nine generated test modules validate. `v7.test.ts` instead emits an invalid
callback trampoline:

```text
__call_fn_2: call_ref[1] expected i64, found externref
```

That single ABI defect blocks all 14 v7 callbacks before execution.

## Measured failure buckets

The runner records the thrown assertion/error text for every callback. The
remaining 58 executing failures cluster as follows:

- byte-vector parsing/stringification and output-buffer writes return unequal
  arrays or `undefined` strings (`parse`, `stringify`, v4, and v6);
- v1's option/state path traps with `RuntimeError: illegal cast` in all ten
  selected callbacks;
- v3/v5 digest helpers produce empty output, namespace/property reads become
  null, and expected exceptions are not preserved;
- the Node RNG path reports length 0 instead of 16, while v4's native-random
  probes report `crypto is not defined`;
- `validate` and `version` table cases observe null/undefined results rather
  than the published helper results.

The exact names and messages live in the generated
`tests/dogfood/report/uuid-upstream-suite.json`; the headline alone is not the
acceptance oracle.

## Acceptance criteria

- [x] `v7.test.ts` emits valid Wasm and its 14 callbacks execute.
- [x] The v1 illegal-cast cluster is reduced to a minimal compiler regression
      and fixed without UUID-specific source rewriting.
- [ ] Byte-vector parse/stringify/buffer-offset behavior matches Node.
- [x] Node-platform `crypto`/RNG capability is either provided honestly or
      reported as unavailable without silently returning wrong bytes.
- [x] Expected RangeError/validation paths preserve throw behavior.
- [ ] The unchanged original suite reaches 75/75 Node and 75/75 Wasm, with zero
      harness-incompatible tests.

## 2026-08-12 implementation checkpoint

The unchanged pinned suite now reaches **72/75 Wasm** with **75/75 Node**, all
ten generated modules compile, and every emitted binary validates. This branch
fixes the broad vector/callable/runtime failures generically: typed-array
identity survives internal calls and host method mutation, optional and shadowed
closures retain their source callable, missing dynamic option fields remain
`undefined` across internal calls, and generated struct reads use authoritative
field ownership plus collision-safe shape IDs.

Three upstream assertions remain and are intentionally recorded rather than
hidden by adapter rewrites:

- safe stringify reads byte 15 from a 15-byte `Uint8Array`; the numeric-index
  lowering currently turns the out-of-bounds `undefined` into index zero, so the
  expected validation exception is not thrown;
- `updateV1State` loses the typed array assigned to the dynamic `state.node`
  property before the following `state.node[0] |= 1` read;
- the v7 bit-flip property test exposes the compiler's signed 64-bit BigInt
  ceiling when reconstructing an unsigned 128-bit UUID value.

These residuals are the follow-up work required for the final 75/75 acceptance
target. No UUID result is memoized or precomputed.

## Reproduction

```bash
node --import tsx tests/dogfood/uuid-upstream-suite.mjs --json
```
