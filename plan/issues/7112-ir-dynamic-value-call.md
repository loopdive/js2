---
id: 7112
title: "IR: bare call through a dynamic value (`func()`) in planned member closures"
status: in-review
sprint: current
created: 2026-10-21
updated: 2026-10-25
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
demoted at build — until #7106's `catchIsCarrier` (in `lowerTryStatement`,
now on main) re-tagged every catch binding on the host-free lanes as the
carrier, lifted closure bodies included. Nothing closure-specific remains to
add for it here.

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
- **Selector** (`dynamicValueCallTarget`): admits a bare call (`func()`, no
  `?.`, no spread) of one of a **planned function-member closure's** dynamic
  parameters. The arm has no capability of its own: its lane is the plan's
  lane (`planMemberClosure` requires non-fast, native-first, standalone or
  wasi, and the externref carrier; gc native-first projects as standalone).
  The match is by identifier text, so a catch binding shadowing the parameter
  also takes the arm — sound, since the catch binding is itself the dynamic
  carrier on these lanes. The one
  difference from legacy is that the shared runtime does not restore
  `__current_this` when the callee throws inside a `try`, which only a caller
  that reads its own `this` afterwards could observe — a planned member
  closure never does, because the plan refuses `this`. On host-assisted gc and
  on the fast lane no plan exists, so the shape is refused at select
  (`body-shape-rejected`) and gc output stays byte-identical to main.
- **from-ast:** a dynamic-carrier callee binding (a local, or a slot with a
  dynamic logical type) goes through `lowerDynamicValueCall`. The catch
  parameter inside the lifted closure is already the dynamic carrier on the
  host-free lanes (#7106's `catchIsCarrier` in `lowerTryStatement` applies to
  lifted closure bodies as well), so `typeof thrown`, `thrown === null` and
  `thrown.constructor` use the dynamic operations without a closure-specific
  predicate. The `?.`/spread and "callee lost its carrier" demotes in the
  lowering are selector-contract asserts, not lowering decisions: the selector
  refuses those shapes first.

## Left for a follow-up

A **top-level function** whose own dynamic parameter is called
(`function self(func: any) { func(); }`) is **not** admitted: the arm's
closure-parameter name set is empty outside a planned closure. Independently,
the subject's Phase-1 shape check refuses `func()` at `expr-local-call-target`
before the move-only scan (`dynamicUsesAreMoveOnly`) runs, so the subject
stays legacy with `call-resolution-unsupported` exactly as on main. Admitting
it needs a subject-level name set, the Phase-1 check and the move-only scan
both extended to treat `func()` as admitted (and the own-`this` constraint
above checked for the subject), with its own census measurement of how many
top-level units it unblocks; none of this PR's fixtures depend on it.

## Acceptance

- `tests/issue-7106-dynamic-value-call.test.ts` checks every result against
  node:
  - calls, a non-callable TypeError, and `this === undefined` inside the
    callee;
  - an `assert.throws`-shaped initializer (Test262Error replaced by a plain
    throw) becomes a prepared IR body with no post-claim errors;
  - the admission is lane-gated: the same shape stays legacy, refused at
    select with no post-claim error, on host-assisted gc and on the fast lane.
- Census, Test262Error-stripped probe: `assert.throws` no longer blocks
  `<module-init>`. The remaining module-init blockers are:
  - `assert.compareArray` (`operand-coercion-unsupported`);
  - `compareArray.format`, a string-result member closure;
  - `assert._formatIdentityFreeValue = formatIdentityFreeValue;`, a
    function-value RHS.
