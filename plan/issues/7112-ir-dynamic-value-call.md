---
id: 7112
title: "IR: bare call through a dynamic value (`func()`) + dynamic catch bindings in member closures"
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
depends_on: [7111]
assignee: "ttraenkler/session-d"
# 2026-10-21 (#7112): the dynamic-callee arm in lowerCall and the selector's
# call arm; the shared IsCallable/__apply_closure tail lives in
# function-object-lowering.ts.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/from-ast.ts::lowerCall
  - src/ir/select.ts::isPhase1Expr
---

# IR: `func()` through a dynamic value

This is part of Stage 4 (`<module-init>`) of
[#7106](7106-ir-test262-harness-units.md). It is stacked on
[#7111](7111-ir-uninitialized-dynamic-var.md).

## Problem

The census probe replaces `new Test262Error(x)` with `(x)`, because Stage 3c is
#6829. In that probe, after #7111 the `assert.throws` member closure stopped at
`func()`. That call goes through one of its dynamic parameters
(`expr-local-call-target`). #6821's `bodyCallsDynamicParamCallee` does not
cover it: that function handles calls TO local functions that take dynamic
parameters.

The next blocker in the same closure was the catch binding `thrown`. A lifted
closure's catch binding was a raw externref slot, so `typeof thrown`
demoted at build.

## Measured legacy behavior (standalone)

A bare call of an `any` value runs the inline dynamic dispatch. The order is:
callee, then arguments, then IsCallable. If IsCallable fails, legacy throws a
TypeError with the message `called value is not a function`. Otherwise it
calls through an arity-exact closure arm or the `__apply_closure` fallback,
with `undefined` as `this`. `emitBareCallReceiverReset` clears
`__current_this` during the call and restores it afterwards. Inside a `try`
it also restores on an exception.

## Fix

- **function-object-lowering:** the IsCallable + `__apply_closure` tail of
  the function-object member call is now shared by both call kinds. A new
  `lowerDynamicValueCall` uses it with an undefined receiver and legacy's
  message. `__apply_closure` always enters `__call_fn_method_N`, which
  installs that undefined receiver as `__current_this` for the callee and
  restores it on a normal return.
- **Selector** (`dynamicValueCallTarget`): admits a bare call of a dynamic
  parameter, either of the subject or of a planned member closure, on the
  `native-dynamic-value-call` lanes (wasmgc, non-fast, standalone or wasi).
  The calling body must not read `this`. The one difference from legacy is
  that the shared runtime does not restore `__current_this` when the callee
  throws, so only a caller that never reads its own receiver is admitted.
  Planned member closures already satisfy this, because the plan refuses
  `this`.
- **from-ast:** a dynamic-carrier callee binding (a local, or a slot with a
  dynamic logical type) goes through `lowerDynamicValueCall`. Inside a planned
  member closure the catch parameter is bound as the dynamic carrier
  (`asType: dynamic` over the externref slot, which on the non-fast lanes is
  that carrier). So `typeof thrown`, `thrown === null` and `thrown.constructor`
  use the dynamic operations.

## Acceptance

- `tests/issue-7106-dynamic-value-call.test.ts` checks every result against
  node:
  - calls, a non-callable TypeError, and `this === undefined` inside the
    callee;
  - an `assert.throws`-shaped initializer (Test262Error replaced by a plain
    throw) becomes a prepared IR body with no post-claim errors;
  - a top-level caller that reads `this` stays legacy.
- Census, Test262Error-stripped probe: `assert.throws` no longer blocks
  `<module-init>`. The remaining module-init blockers are:
  - `assert.compareArray` (`operand-coercion-unsupported`);
  - `compareArray.format`, a string-result member closure;
  - `assert._formatIdentityFreeValue = formatIdentityFreeValue;`, a
    function-value RHS.
