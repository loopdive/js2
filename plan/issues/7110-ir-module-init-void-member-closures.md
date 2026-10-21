---
id: 7110
title: "IR: void-result function-object member closures in `<module-init>` (assert.js's `assert.sameValue = function …`)"
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
# 2026-10-21 (#7110): the closure-lowering arm for a planned member closure's
# reassigned parameters + the dynamic-slot `+=` arm (from-ast), and the void
# plan's selector state (select). Each growth is that one arm.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
---

# IR: void-result member closures in `<module-init>`

Parent: [#7106](7106-ir-test262-harness-units.md), Stage 4 (`<module-init>`):
"the Stage 2 member-write evidence rule". This was the lead's redirect on
2026-10-21.

## Problem

Measured on main (standalone, original harness,
`language/expressions/addition/S11.6.1_A2.1_T1.js`): 9 units, 4 legacy.
`<module-init>` stopped at
`closure-return-type:FunctionExpression «function (actual, expected, message) { try { if (assert._isSameValue(act…»`.
This is assert.js's top-level `assert.sameValue = function (…) {…}`.

The function-member closure planner (`planMemberClosure`,
`src/codegen/function-member-closure-planning.ts`) accepted only one shape:

- oracle return `boolean` and physical result `i32`;
- a body made only of closed scalar returns (`assert._isSameValue`).

For any other shape it declined. The selector then fell back to "an untyped
closure needs a return annotation".

## Measured legacy ABI

Printed from the planner's own inputs:

| member | oracle signature | legacy physical signature |
|---|---|---|
| `_isSameValue` | `(any, any) → boolean` | `(externref, externref) → i32` |
| `sameValue` | `(any, any, any) → void` | `(externref ×3) → (none)` |

Legacy registers `sameValue` with **no result**. Matching legacy therefore
means a VOID plan, not an invented dynamic result.

## Fix

- **Planner:** also plans oracle-`void` closures whose physical result is
  none. The body is not limited to scalar returns: the IR selector decides
  buildability over an empty outer scope. A new `openVoidBodyKey` refuses only
  what the plan cannot carry: `this`, `super`, `arguments`, `eval`,
  `new.target`, nested functions or classes (captures), `yield`/`await`, and
  `return <value>`. It also records each identifier's resolved declaration, so
  `isCurrent()` treats a rebinding as stale. The signature's result is `null`.
- **Selector:** a planned void closure sets `currentFnIsVoidReturn` and admits
  a bare `return;`. Inside a planned closure the return-context depths are
  reset, so module-init's own return barrier no longer bars the closure's
  early `return;` from inside `try`/`if`.
- **from-ast:** a reassigned parameter of a planned closure (`message += ' '`)
  is seeded into a slot, the same model top-level functions use. Before this,
  the compile threw `assignment to non-slot binding` (an internal throw). A
  dynamic-slot `+=` now lowers through the same `IR_DYN_ADD_FN` that the
  binary `+` uses, reading the left side before evaluating the right side.
- **Prepared dynamic support** (`prepared-dynamic-support.ts`): names the host
  `tag.test` arms for Undefined (`__typeof_undefined`) and Null (`ref.is_null`,
  no callable). This is measured: `message === undefined` and
  `thrown === null` in assert.js.
- **Pre-existing crash fixed** (Program ABI source-callable planning): when a
  module-init prepared component with a lifted member closure failed sealing,
  the closure unit's binding stayed located at the abandoned IR artifact. The
  owner's legacy body then re-allocated the same unit, and
  `planObservedUnit` failed the WHOLE compile with "retained source callable
  __closure_N is not the exact allocator owned by …". This reproduces on main
  with `JS2WASM_TEST_INJECT_IR_PREPARED_SEAL_FAILURE=1` and the existing
  boolean `subject.equal` test. The binding now moves to the live legacy
  allocation (`replaceDefinedFunctionLocator`), and the abandoned artifact
  leaves `irUnitFuncMap`.

## Acceptance

- `tests/issue-7106-module-init-void-member.test.ts`: an
  `assert.sameValue`-shaped initializer is a prepared IR body (`subject` and
  `<module-init>` prepared, no post-claim errors). Every program's result
  equals node's on the same source. That covers the thrown message built
  through the reassigned dynamic `message`, and the early return inside
  try/if. A `this`-reading closure stays off the plan, and the injected seal
  failure compiles and runs.
- Original-harness census: `<module-init>` moves from `closure-return-type` at
  `sameValue` to `constructor-resolution-unsupported`, which is
  `throw new Test262Error(…)` inside the closure (Stage 3c, out of scope).
  With `new Test262Error(x)` stripped to `(x)` (probe only), the next blockers
  are:
  - `assert.throws`: `var expectedName, actualName;` (`vardecl-var-kind`);
  - `assert.compareArray`: `operand-coercion-unsupported`;
  - `compareArray.format`: a STRING-result member closure
    (`closure-return-type`).

  These are the next slices.
