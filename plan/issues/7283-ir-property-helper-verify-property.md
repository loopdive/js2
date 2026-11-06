---
id: 7283
title: "IR: propertyHelper verifyProperty (and the other 130-file harness units) on the IR path"
status: blocked
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
parent: 7250
related: [7269, 7272, 7266, 2949, 7106]
assignee: "ttraenkler/c-r11"
---

# IR: propertyHelper verifyProperty on the IR path

## Problem

After #7272, every propertyHelper includer still compiles seven harness
units legacy. That keeps the whole ~130-file block (wrapped stride 40) out of
`ir_only_pass`. The seven are `verifyProperty`, `verifyCallableProperty`,
`verifyAccessorProperty`, `verifyEqualTo`, the two `verifyPrimordial*` units
and `<module-init>`. verifyProperty is the unit every includer calls.

## Measurement: stopped at two contract questions

Base: `issue-7272-ir-iswritable-first-statement` @ `8926791e` (#7272 on
#7269 `aad8abd8`). Measured on `built-ins/Boolean/prop-desc.js`, wrapped
standalone, `JS2WASM_IR_SHAPE_DIAG=1`. For verifyProperty's chain I used an
inline copy of propertyHelper (`.tmp/vp.py`), stubbing each refusal in turn.

### First refusal of each legacy unit (real harness)

| unit | first refusal |
| --- | --- |
| verifyProperty | `vardecl-module-binding-alias` on `__getOwnPropertyNames(desc)` |
| verifyCallableProperty | `expr-logical-value-family` on `options && options.verifyProperty \|\| verifyProperty` (a function value as a logical operand) |
| verifyAccessorProperty | `param-type-unresolved(desc)` |
| verifyEqualTo | `param-dynamic-carrier-diverges-from-legacy(value)` (was `abi-signature-parity` before the #7265@418467f9 merge) |
| verifyPrimordialCallableProperty | `param-dynamic-carrier-diverges-from-legacy(options)` |
| verifyPrimordialAccessorProperty | `param-dynamic-carrier-diverges-from-legacy(desc)` |
| `<module-init>` | `expr-ident-not-in-scope` on `Function` |

### verifyProperty's chain, peeled in order

| # | construct | refusal | kind of fix |
| --- | --- | --- | --- |
| 1 | `var names = __getOwnPropertyNames(desc)` + `names.length` / `names[i]` loop | `vardecl-module-binding-alias` | new stored static (`Object.getOwnPropertyNames` → dynamic array) plus a loop over a dynamic array-like. Bounded, but its own slice. |
| 2 | `assert.sameValue(originalDesc, undefined, label + "…")` as a statement | `move-only[concrete]` | **admission (g):** the scan admits a function-object member call (`assert.sameValue`) only in dyn position. A statement drops the result, like the existing statement-position direct-call rule. Measured, ~2 lines. |
| 3 | `assert(__hasOwnProperty(obj, name), …)` | `move-only[dyn]` | **admission (h):** a certified boolean alias call is a concrete operand `boxConcreteToDynamic` boxes, like a comparison (`concreteDynamicAssignmentOperandIsBuildable`). Measured. |
| 4 | `assert.notSameValue(desc, null, "…")` | `move-only[dyn]` (a `null` argument into a dynamic carrier) | **contract: stop.** IR has no producer for a dynamic `null`. `lowerExpr(null, dynamic)` refuses (`nullValueAdmissible`), there is no `dyn.null` op, and `IrDynamicLowering` has `emitUndefined` but no null. Adding one decides how JS null is represented on each lane's carrier. |
| 5 | `__push(failures, label + "…" + String(desc.value))`, `__join(failures, '; ')` | (stubbed) | uncurried `Array.prototype.push` / `join` aliases on a local array, plus a dynamic string concat. Not measured further. |
| 6 | `if (__hasOwnProperty(desc, 'value'))` | `condition-module-value-nonbool` | **admission (i):** a certified boolean alias call through the module binding (not a shadowing local, no module-value argument) is exactly boolean in `trackedModuleInfluenceIsBoolean`. This is the call-result arm only; #7266's value arms are untouched. Measured. |
| 7 | `__hasOwnProperty(desc, 'enumerable') && desc.enumerable !== undefined` | `move-only[concrete]` on `desc.enumerable !== undefined` | **contract: stop.** `dynamicMemberEqualityOperandIsBuildable` refuses a dynamic member read as an equality operand in any value-used function (the callback-boundary carrier seam: legacy array HOFs pass the direct array carrier). verifyProperty is value-used (`var verifyPrimordialProperty = verifyProperty`; `options && options.verifyProperty \|\| verifyProperty`). Narrowing that rule changes the seam's safety contract. |

Admissions (g), (h) and (i) are written and measured: they clear refusals
2, 3 and 6. The diff is ~45 lines in `src/ir/select.ts`. It is not shipped:
on its own it frees 0 units, because 1, 4, 5 and 7 remain. With all of them
applied, `Boolean/prop-desc.js` stays at 7/25 legacy units.

### Zero-legacy files

**0** in this issue's reach. All seven units above are legacy in every
propertyHelper includer. Units 4 and 7 of verifyProperty's chain need
contract decisions, and so do the `param-dynamic-carrier-diverges-from-legacy`
units (their legacy parameter carrier differs by call site).

## Decisions needed (rules owner, #2949 / #7106)

1. **A dynamic `null` producer:** a `dyn.null` op with a per-lane
   `emitNull` on `IrDynamicLowering`, or boxing an externref null through
   the call-argument ABI. Which representation matches legacy's on each
   lane?
2. **The callback-boundary carrier seam for value-used functions:** may a
   function whose only value uses are module-var aliases and `||` fallbacks,
   never passed to an array HOF, count as "direct-only" for dynamic member
   equality operands?

Once both are decided, the order is: (g) (h) (i), then 1 (the
`getOwnPropertyNames` loop), then 5 (`__push` / `__join`), then re-peel.

## Appendix: the measured (g)(h)(i) diff (not shipped)

<details><summary>src/ir/select.ts</summary>

```diff
diff --git a/src/ir/select.ts b/src/ir/select.ts
index 9ceb08aa..33c0078b 100644
--- a/src/ir/select.ts
+++ b/src/ir/select.ts
@@ -3165,6 +3165,8 @@ function concreteDynamicAssignmentOperandIsBuildable(candidate: ts.Expression):
       isComparisonResultOperator(op) || op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken
     );
   }
+  // (#7283) boxed like a comparison.
+  if (isModuleBooleanAliasCall(candidate)) return true;
   return (
     ts.isConditionalExpression(candidate) &&
     concreteDynamicAssignmentOperandIsBuildable(candidate.whenTrue) &&
@@ -4092,6 +4094,9 @@ function dynamicUsesAreMoveOnly(
       if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && !dynNames.has(e.expression.text)) {
         return scanDirectCallArgs(e, e.expression.text);
       }
+      // (#7283) Likewise a member call on a stable function object
+      // (`assert.sameValue(desc, undefined, msg)`): its dynamic result is dropped.
+      if (ts.isCallExpression(e) && functionObjectMemberCallee(e) !== null) return scanExpr(e, true);
       return scanExpr(s.expression, false);
     }
     if (ts.isIfStatement(s)) {
@@ -8180,6 +8185,7 @@ function trackedModuleInfluenceIsBoolean(expr: ts.Expression): boolean {
   if (ts.isConditionalExpression(candidate)) {
     return trackedModuleInfluenceIsBoolean(candidate.whenTrue) && trackedModuleInfluenceIsBoolean(candidate.whenFalse);
   }
+  if (isModuleBooleanAliasCall(candidate)) return true;
   if (ts.isCallExpression(candidate)) {
     if (expressionIsModuleBindingRootedCall(candidate)) return false;
     return currentModuleBindingResolver?.scalarExpressionFamily(candidate) === "boolean";
@@ -8187,6 +8193,21 @@ function trackedModuleInfluenceIsBoolean(expr: ts.Expression): boolean {
   return false;
 }
 
+/**
+ * (#7283) A certified boolean alias call through the module binding itself
+ * (`__hasOwnProperty(obj, name)`, not a local that shadows it), whose
+ * arguments read no module value: its result is the provider's exact
+ * boolean, never the module slot.
+ */
+function isModuleBooleanAliasCall(candidate: ts.Expression): boolean {
+  return (
+    ts.isCallExpression(candidate) &&
+    moduleBinding(candidate.expression) !== undefined &&
+    certifiedAliasCall(candidate, () => false)?.result === "boolean" &&
+    !candidate.arguments.some(expressionTouchesTrackedModuleValue)
+  );
+}
+
 /**
  * A `!` / `&&` / `||` operand whose module influence cannot be misread: every
  * module-derived value in it is boolean, or the whole operand is exactly
diff --git a/test262 b/test262
deleted file mode 160000
index b363f29d..00000000
--- a/test262
+++ /dev/null
@@ -1 +0,0 @@
-Subproject commit b363f29d3c43c626dc852744ad64a0b48a003693
diff --git a/test262 b/test262
new file mode 120000
index 00000000..c5c40262
--- /dev/null
+++ b/test262
@@ -0,0 +1 @@
+/home/user/js2/test262
\ No newline at end of file
```

</details>
