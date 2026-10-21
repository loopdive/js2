---
id: 7107
title: "IR: under-arity direct calls (propertyHelper's `isWritable(obj, name)`) — `undefined` pads + `dyn.publish_argc`"
status: in-review
sprint: current
created: 2026-10-21
updated: 2026-10-21
priority: high
horizon: s
feasibility: hard
reasoning_effort: max
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/session-d"
# 2026-10-21 (#7107, #7106 S1i): one new IR instruction (`dyn.publish_argc`,
# the 36th dialect kind) threaded through its node, verifier, builder,
# lowering, pre-registration and passes — the same shape as S1e's
# `dyn.arguments_length` — plus the selector's under-arity admission and the
# from-ast padding. Each growth is that one arm; the wrapper lives beside its
# S1e sibling in src/codegen/ir-arguments-length.ts (no new file, no new edge).
loc-budget-allow:
  - src/ir/select.ts
  - src/ir/from-ast.ts
  - src/ir/integration.ts
  - src/ir/runtime/verify.ts
  - src/ir/lower-generic.ts
  - src/ir/builder.ts
  - src/ir/core/nodes.ts
  - src/ir/prepared-component-dependencies.ts
func-budget-allow:
  - src/ir/runtime/verify.ts::verifyInstrStructure
  - src/ir/lower-generic.ts::lowerIrFunctionBody
  - src/ir/lower-generic.ts::emitInstrTree
  - src/ir/integration.ts::preregisterDynamicSupport
  - src/ir/integration.ts::makeDynamicLowering
  - src/ir/select.ts::isPhase1Expr
  - src/ir/passes/inline-small.ts::renameInstrOperands
  - src/ir/select.ts::whyNotIrClaimable
---

# IR: under-arity direct calls

Parent: [#7106](7106-ir-test262-harness-units.md), census row "one-off
propertyHelper arms" — the call-arity arm.

## Problem

propertyHelper.js calls `isWritable(obj, name)` (from `verifyProperty`) and
`isWritable(obj, name, verifyProp)` (from `verifyNotWritable`) on a
four-formal function. The selector rejected every direct call whose argument
count differs from the callee's fixed formals
(`call-arity-unsupported` / `expr-direct-call-arity`), and from-ast demoted it
the same way. `isWritable` also reads `arguments.length < 4`, so the count the
callee observes must be the call site's, not the formal count.

## Measured legacy behaviour (standalone, 2026-10-21)

`function caller(obj, name) { return iw(obj, name); }` on a four-formal `iw`
that reads `arguments`:

```
local.get 0  local.get 1
global.get 15  extern.convert_any      ;; missing formal 3 = canonical undefined
global.get 15  extern.convert_any      ;; missing formal 4
i32.const 2  global.set __argc         ;; emitSetArgc(min(actual, formals))
return_call $iw
```

A missing externref formal is `pushDefaultValue` → `emitUndefinedValue`; a
missing `f64` formal is `f64.const 0` (not `undefined` — `add(3)` is 3 there,
NaN in node); `__argc` is published only when the callee uses `arguments`
(`ctx.funcUsesArguments`), and the callee's prologue consumes and clears it.

## Fix

- **Selector** (`src/ir/select.ts`, `underArityDirectCallIsBuildable`): admit a
  direct call to a top-level fixed-formal function with FEWER arguments when
  every missing formal resolves `dynamic` (the same `resolveParamType` verdict
  the callee's own claim uses), the dynamic runtime is buildable, there is no
  spread, the callee is not a generator/async and cannot reach direct `eval`;
  an arguments-reading callee additionally needs the host-free argc protocol
  (`native-arguments-length`, S1e's capability). Over-arity stays legacy (it
  needs `__extras_argv`).
- **from-ast** (`planUnderArityDirectCall`): re-derives the same decision from
  the exact plan signature and the callee declaration
  (`identityContext.declarationByUnitId`), pads each missing formal with
  `dyn.undefined`, and emits `dyn.publish_argc{count}` right before the call
  when the callee reads its own `arguments`.
- **`dyn.publish_argc`** (36th dialect kind, verdict `js`): no operands, no
  result; lowers to `i32.const count; call __ir_publish_argc`
  (`src/codegen/ir-arguments-length.ts`, beside S1e's
  `__ir_arguments_length`), whose body is legacy's `emitSetArgc`
  (`global.set __argc`). Side-effecting in `effects.ts`.

## Acceptance

- `tests/issue-7106-s1i-under-arity-call.test.ts`: every verdict equals node's
  on the same source — padded `undefined`, `arguments.length` = actual count
  (2, 3) observed by an IR callee, no stale `__argc` after a call to a
  non-reader, and concrete-formal / spread / over-arity calls stay on legacy.
- Harness census (`sta.js + assert.js + propertyHelper.js`, standalone,
  `JS2WASM_IR_SHAPE_DIAG=1`): `verifyNotWritable`'s first blocker moves from
  `call-arity-unsupported «isWritable(obj, name, verifyProp)»` to
  `constructor-resolution-unsupported «Test262Error»` (#7106 Stage 3c). No unit
  changes outcome yet: `isWritable` itself is still legacy (module-binding
  alias, the next slice), so its callers stay behind `call-graph-closure`.
