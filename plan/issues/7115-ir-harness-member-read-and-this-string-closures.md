---
id: 7115
title: "IR: function-object member reads and string/`this` member closures (harness rows 1 and 3)"
status: in-review
sprint: current
created: 2026-10-22
updated: 2026-10-29
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7106
depends_on: [7113]
assignee: "ttraenkler/session-d"
# 2026-10-22 (#7115): the member-read receiver use, the closure-local
# dynamic-callee set, `this` / string-result plan wiring and the dynamic `+`
# operand rule for `this` and calls through dynamic bindings.
loc-budget-allow:
  - src/ir/from-ast.ts
  - src/ir/select.ts
# 2026-10-29 (revive onto main): the #7144 walk learns the two carrier sources
# this slice adds to from-ast (`this`, a call through a dynamic slot).
  - src/ir/select-planned-closure-operands.ts
# 2026-10-22 (re-merge after #6829 landed): this PR's scan-arm growth was granted
# by the #7106 issue file while #6829 sat in its diff; restated here (stranded grants).
func-budget-allow:
  - src/ir/select.ts::scanExprInner
---

# IR: function-object member reads, string and `this` member closures

Parent: [#7106](7106-ir-test262-harness-units.md), Stage 4 (`<module-init>`).

This slice is stacked on [#7113](7113-ir-member-closure-throw-only-and-dynamic-conditional.md)
(PR #6834) **and** on PR #6833, #7106 census arm 3. #6833 carries arm 4
(#6831), S3c (#6829) and origin/main. Arm 3 brings the chained `F.p.x = v`
store; arm 4 brings the evidence-free receiver plan; S3c brings
`dyn.current_this` and the IR-owned self-guarded `Test262Error`.

## Census before this slice

Measured on a merge of #6834 and #6833: honest harness, S11.6.1_A2.1_T1,
standalone. There are 9 units, and one of them is legacy: `<module-init>`.
Its blockers, in source order:

1. `var format = compareArray.format;`, in the `assert.compareArray` member
   closure (assert.js:162): `expr-ident-not-in-scope «compareArray»`.
2. `compareArray.format = function (arrayLike) { return "[" +
   Array.prototype.map.call(arrayLike, String).join(", ") + "]"; }`:
   `closure-return-type`.
3. `Test262Error.prototype.toString = function () { return "Test262Error: " +
   this.message; }`: `closure-return-type`.
4. The test body's `var x = 1;`, which #7114 (PR #6835) covers.

## Row 1: a function-object member read

`compareArray.format` is a receiver-only use of the function object, like a
member call or write: the boxed function object, then a dynamic member get.
**Legacy** reads the same property through the same `__extern_get`/dynamic get.

The fix:
- `isFunctionObjectMemberRead` is the new syntax-only predicate. It admits
  exactly a whole `var` initializer, not a `let`/`const` one, an update
  operand or a destructuring target.
- `resolveFunctionObjectReceiver` accepts that read, and so do the planner's
  `isReceiver` and `hasPreparedFunctionObjectReference`. The planner then
  mints the arm-4 receiver plan, opaque when the target is unannotated.
- In a planned member closure, a `var` initialized by such a read is a
  dynamic local when it has exactly one declaration and is never assigned
  (`functionObjectReadLocals`). `format(actual)` then goes through
  `lowerDynamicValueCall`, the same path as #7112, with an undefined receiver.
- from-ast's `+` operand rule (`expressionProducesDynamic`) treats a call
  through a dynamic binding as producing the carrier. Without that,
  `"Actual " + format(actual)` took the TS-typed string-concat path.

## Row 3: a chained store, a string result and `this`

**Planner** (`planMemberClosure`):
- It accepts the chained `F.p.x = function …` left-hand side; the receiver is
  `F`.
- It accepts an oracle `string` result when legacy's physical result is
  `(ref $AnyString)`. The plan signature carries the logical `string`, so
  Program-ABI preparation attaches the canonical carrier, which lowers to
  exactly that ref. A raw `val` ref has no symbolic ABI identity in a
  prepared component, and the first cut crashed there.
- The void body proof became `openBodyKey`. A string plan admits
  `return <value>` and refuses a bare `return;`. A body that reads `this`
  carries `thisStrict` (`isStrictFunction`).
- A prototype method of an **approved fnctor** stays legacy
  (`resolveLiftedMethodThisStruct`). Legacy pins that `this` to the fnctor
  struct and may build a typed-`this` twin with direct-call trampolines
  (#3683), which the IR does not build. `Test262Error` is not affected:
  S3c keeps it out of the fnctor machinery.

**Selector:**
- A `this`-reading plan puts `this` in the closure scope. It needs
  `native-current-this`; a string plan needs `native-string-carrier-coercion`.
- `currentSubjectReturnsBoolean` now holds only for an i32 plan. Before, it
  read "any result".

**from-ast:**
- The closure binds `this` once at entry, `dyn.current_this{strict}`. That is
  OrdinaryCallBindThis and legacy's lifted-closure `__current_this` ladder.
- A dynamic `+` result returned into the `string` result recovers its string
  through `dyn.string_carrier` (the #7106 S1c return arm).

## Census after this slice

On the merge of #6834 and #6833, S11.6.1_A2.1_T1 still has 9 units with 1
legacy, `<module-init>`. Rows 1 and 3 no longer block it. Two harness lines
still do, and both are selector refusals:

- assert.compareArray's `message = message.toString();` (assert.js:151):
  `closure-member-dynamic-method`. This refusal is #7110's fix (2026-10-22),
  cascaded up the stack. The IR's dynamic method call answers `undefined` for
  primitive and vec receivers on the host-free lanes, where legacy
  dispatches by brand. Before the fix this closure was admitted and silently
  wrong whenever `message` was a Symbol.
- Row 2's `Array.prototype.map.call(arrayLike, String).join(", ")`, refused
  the same way.

With both lines masked, the blocker becomes the test body's `var x = 1;`.

With both lines stubbed (`message = String(message);` and
`return "[" + String(arrayLike) + "]";`):
- `built-ins/Math/abs/S15.8.2.1_A1.js` has **0 legacy units**: every harness
  function and `<module-init>` ship IR bodies.
- Six of 34 Math tests (abs, max, floor, sign) are fully IR, and the runner
  passes all six with the IR initializer.
- Synthetic honest-harness probes give the same pass/fail verdicts and the
  same Test262Error messages as the base tree. Four of the seven are now
  IR-initialized.

## Not done here

- **`message.toString()` (assert.js:151)** needs a dynamic method call with
  legacy's brand dispatch (or an exact `toString` arm). That is scoped
  separately, together with row 2.
- **Row 2.** Its body needs `Array.prototype.map.call(arrayLike, String)` and
  `.join(", ")` in the IR. That is scoped separately.
- **Test-body residue seen in the sample:** `var` declarations (#7114), `Math`
  as a value, `TypeError` / `Test262Error` passed as values, array literals
  passed into dynamic arguments, and `propertyHelper.js`'s top-level
  `var __isArray = Array.isArray;`.
- **Pre-existing, unchanged:** a prepared component that groups
  `<module-init>` with IR callers of its member closures demotes post-claim
  with incomplete Program-ABI dependencies, for void plans as well. The
  harness does not take that route.

## Revive onto main (2026-10-29)

Main landed #7112/#7113 in a reworked form and #7144's operand walk. On the
merge:
- `dynamicValueCallTarget` is main's closure-only version (the subject arm and
  the `native-dynamic-value-call` capability were cut in #7112's review); this
  slice adds only its function-object read locals to it.
- `plannedClosureOperandRefusal` (#7144) mirrors this slice's from-ast change:
  `this` in a `this`-plan and a call through a dynamic parameter or read local
  are the carrier (additive `dynamic`). Without it the walk refused
  `"Test262Error: " + this.message` (`closure-additive-operands`).
- The harness census stubs assert.compareArray's three `String(message)`
  calls as well: #7113 refuses `String(carrier)` in a closure that mints a
  carrier join on standalone (`closure-carrier-helper-call`; the helper needs
  `prepared-dynamic-helper-abi`, wasi-only).

## Acceptance

`tests/issue-7106-harness-member-rows.test.ts`:
- Row 1 and row 3 shapes are IR `<module-init>` bodies and match node.
- An approved-fnctor prototype method stays legacy.
- On the honest harness, `<module-init>` stays legacy (the two refused lines).
- With the refused lines stubbed, every unit is IR, the run agrees with node, and a
  wrong expectation still throws.
