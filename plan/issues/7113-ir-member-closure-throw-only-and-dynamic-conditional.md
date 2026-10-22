---
id: 7113
title: "IR: throw-only member closures (void plan) and dynamic-arm conditional values"
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
depends_on: [7112]
assignee: "ttraenkler/session-d"
# 2026-10-21 (#7113): the selector's dynamic-arm conditional predicate and
# from-ast's `tryLowerDynamicConditionalValue`.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
func-budget-allow:
  - src/ir/select.ts::isPhase1Expr
---

# IR: throw-only member closures, dynamic-arm conditionals

Parent: [#7106](7106-ir-test262-harness-units.md), Stage 4 (`<module-init>`). This slice is stacked on
[#7112](7112-ir-dynamic-value-call.md).

The lead's census on the open stack (#6831 + #6830 + #6826, run on
S11.6.1_A2.1_T1) assigned two rows to the member-closure plan owner.

## Row 7: a throw-only body

`Test262Error.thrower = function (message) { throw new Test262Error(message); }`
was refused with `closure-return-type`. The planner's own inputs show why:
the oracle reports the return as `unresolvable` (TS `never`), while the legacy
physical signature is `(externref) → (none)`. Because legacy registers the
closure with no result, it takes the same VOID plan as `sameValue`.
`openVoidBodyKey` still refuses any `return <value>`.

## Row 2: `message === undefined ? '' : message`

`assert.compareArray` failed on this expression with
`expr-mixed-conditional-context`. On the stripped standalone probe the same line
shows up as `operand-coercion-unsupported` at selection. Replacing it by hand
on the base tree moves the blocker, which confirms that this line is the cause.
The #5092 mixed-primitive route covers two
primitive arms, and only in a top-level function. This conditional instead
joins a dynamic parameter with a string literal.

## Fix

- **Selector** (`dynamicConditionalValueArms`): accepts a conditional value
  when one arm is a dynamic parameter (of the subject or of a planned member
  closure) and the other is either a primitive literal or a second such
  parameter. The check runs before the #5092 route.
- **from-ast** (`tryLowerDynamicConditionalValue`):
  - each arm is lowered in its own branch, so evaluation short-circuits;
  - a literal arm is boxed into the carrier inside its branch;
  - the join is bare dynamic.

  A top-level function that uses this shape stays protected by the move-only
  scan, which refuses it (measured), so only planned member closures reach
  the lowering today.

## Acceptance

- `tests/issue-7106-member-closure-shapes.test.ts`: a throw-only member
  closure, and a closure assigning `message = message === undefined ? '' : message`
  together with `value ? value : 7`, are both prepared `<module-init>` IR
  bodies. Results match node.
- Census on the Test262Error-stripped probe: the next `<module-init>` blocker
  is `var format = compareArray.format;`. That is a function-object member
  READ (`expr-ident-not-in-scope «compareArray»`), followed by `format(…)` on
  a dynamic local. Both belong to Stage 2's function-object surface, so this
  slice leaves them for that owner.

## Addendum (2026-10-22): `message.toString()`

The #7110 dynamic-method refusal is merged into this branch. It refuses
method calls on dynamic receivers inside planned member closures, because the
IR's dynamic method call returns `undefined` for primitive and vec receivers.
With it in place, the stripped-probe census stops at
`assert.compareArray`'s `message = message.toString();` (assert.js:151,
`closure-member-dynamic-method`), before reaching
`var format = compareArray.format;`. This slice's two shapes, the throw-only
plan and the dynamic-arm conditional, are unaffected.
