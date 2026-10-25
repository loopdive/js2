---
id: 7113
title: "IR: throw-only member closures (void plan) and dynamic-arm conditional values"
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
  inside a planned member closure when exactly one arm is a primitive literal
  and the other is one of the closure's dynamic parameters (or a nested
  conditional of the same shape). Two dynamic arms are not this shape: the
  generic conditional walk already admits them and the generic lowering joins
  them. The check runs before the #5092 route.
- **Sink** (`dynamicConditionalValuePosition`): the join is a bare dynamic, so
  the shape is admitted only where the closure takes a bare dynamic as-is — a
  `throw`, an expression statement, an untyped declaration initializer, a
  reassignment of a dynamic parameter, or an arm of an outer conditional whose
  sibling arm is itself dynamic. Anywhere else (`var n = 5; n = m ? m : 1;`,
  a call argument, a return) the walk falls through to the #5092 route and is
  refused at select with `operand-coercion-unsupported`, as before this shape
  existed. This is the rule the top-level move-only scan applies to a dynamic
  value in a concrete position; a planned closure does not run that scan, so
  the shape carries the proof itself.
- **from-ast** (`tryLowerDynamicConditionalValue`, over the shared
  `lowerConditionalBranches`):
  - each arm is lowered in its own branch, so evaluation short-circuits;
  - the literal arm is boxed into the carrier inside its branch;
  - the join is bare dynamic.

  A top-level subject never takes the selector shape (its dynamic parameters
  are not in the closure set, and the move-only scan refuses a dynamic/concrete
  join there). The lowering also sees a top-level two-dynamic-arm conditional
  the generic route admitted; it lowers it as the generic tail did (bytes
  identical, measured).

### Review round (2026-10-25)

- **Throw of a concrete scalar in a planned closure is refused at select**
  (`isPhase1ThrowStatement`, `throw-closure-concrete-scalar`). The void plan
  is pre-existing and already reached throw-only bodies with an early
  `return` (`function (m) { if (m) return; throw 42; }` withdrew after the
  claim on the base too); routing `unresolvable` returns into it widened the
  class to every throw-only body, so the gap is closed for planned closures
  here. `lowerThrowStatement` refuses an f64/i32 value unless its
  number-boundary projection is configured, and no lane that mints a plan
  configures it (measured: standalone, wasi, gc native-first). The same
  withdrawal for a **top-level** `throw 42` is pre-existing on every lane and
  stays out of this slice: its refusal would move host-assisted gc bytes.
- **A dynamic parameter joined with `undefined` / `null`** is refused at
  select (`expr-conditional-dynamic-nullish-join`); the generic tail typed
  the arms `dynamic` vs `dynamic<tag:1>` and withdrew (pre-existing on the
  base for closures with an early return).
- **A bare dynamic assigned to a concrete slot** inside a planned closure is
  refused at select (`expr-dynamic-into-concrete-slot`, reported as
  `body-shape-rejected`): the closure's dynamic parameter (`var s = "a";
  s = m;`) or a dynamic-shaped local it minted (`var r = m ? m : 1; s = r;`)
  written to a local with a type annotation or a non-dynamic initializer. On
  the base both shapes withdrew after the claim
  (`property-write-unsupported`, `assignment to "s" (string) got dynamic`)
  and gc native-first failed to compile; the second was new with this slice's
  conditional shape, so its sink rule (`dynamicAssignmentSink`) now covers the
  conditional and the local reads alike. The same rule admits the conditional
  into a dynamic-shaped local (`var r; r = m ? m : 1;`, `var r = m; r = m ?
  m : 1;`), which the first cut over-refused. The rule covers the plain `=`
  and the admitted compound writes (`s += r`, which otherwise claimed and
  withdrew `string-evidence-unsupported`). Still open, out of scope: a
  dynamic value reaching a typed slot through any other expression (`var r =
  m + 1; s = r;`), a chained write (`s = r = m`), or `String(r)` /
  `String(m)` as a throw value (claims, then `late-preparation-unsupported`)
  withdraws after the claim — identical on base and head for a closure with
  a return (measured, `x25r`, `strMr`), and newly reachable in a throw-only
  body, where the base minted no plan at all (`x25`, `strM`). The closure
  runs no move-only scan; closing it means a selector-side dynamic typing of
  the initializer, not another position list.

## Acceptance

- `tests/issue-7106-member-closure-shapes.test.ts`: a throw-only member
  closure, and a closure assigning `message = message === undefined ? '' : message`
  together with `value ? value : 7`, are both prepared `<module-init>` IR
  bodies. Results match node. Refusal rows (`throw 42`, `throw 1` after a
  conditional throw, the typed-slot sink, `m ? m : undefined`) are refused at
  select with no post-claim withdrawal on standalone and gc native-first; the
  host-assisted gc lane mints no plan (bytes identical to the base, measured).
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
