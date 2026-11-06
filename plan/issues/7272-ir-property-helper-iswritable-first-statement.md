---
id: 7272
title: "IR: propertyHelper isWritable's first statement (dynamic isArray, dynamic mixed conditional, dynamic logical operand)"
status: in-progress
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
related: [7269, 2949, 7266, 7106, 5092]
assignee: "ttraenkler/c-r11"
---

# IR: propertyHelper isWritable's first statement

## Problem

[#7269](7269-ir-property-helper-alias-call-vardecls.md) measured that
`isWritable` (and through the call graph, `verifyWritable` and
`verifyNotWritable`) is held back by one statement:

```js
var unlikelyValue = __isArray(obj) && name === "length" ?
  nonIndexNumericPropertyName :
  "unlikelyValue";
var newValue = value || unlikelyValue;
```

It needs three admissions, in this order, each measured before the next:

- (d) `__isArray(dyn)` / `Array.isArray(dyn)` — a static predicate with a
  dynamic operand (`expr-static-predicate-operand`).
- (e) a mixed `number : string` conditional with a dynamic condition, into a
  dynamic carrier (`expr-mixed-conditional-proof`).
- (f) a dynamic local as a logical-value operand (`value || unlikelyValue`,
  `expr-logical-value-family`). This is a scan-rule admission under the
  (a)–(c) contract: the result is a MOVE of one of the two dynamic operands,
  selected by `dyn.truthy`, with no unbox. #7266 touches module VALUES in
  `isPhase1ConditionExpr`, not dynamic locals, so the two do not overlap.

## Implementation Plan

To be filled from measurement, slice by slice.
