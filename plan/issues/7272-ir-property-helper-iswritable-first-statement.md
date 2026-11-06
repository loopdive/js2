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

Measured slice by slice on `issue-7269-ir-property-helper-alias-calls`
@ `65647c66`, using a fixture that copies isWritable verbatim. None of the
three slices changes the resolver contract.

- **(d) `__isArray`** (`src/ir/uncurried-object-alias.ts`):
  - The stored-static form becomes a table, `STORED_STATICS`, with each
    method's namespace and arity. `Array.isArray` joins
    `Object.getOwnPropertyDescriptor`. A top-level binding of the namespace
    (var, function or class) withdraws its aliases.
  - One classifier, `certifiedAliasCall(call, shadowed)`, returns `{ form,
    method, result }` with the native arity applied. It replaces the five
    hand-written copies of the 2-argument uncurried test (move-only scan,
    exact-family proof, call graph, from-ast lowering, from-ast unboxed-local
    proof) and the descriptor-specific predicates.
  - Selector: one alias arm, with a per-alias capability
    (`certifiedAliasLane`). The new capability `native-array-is-array` is on
    standalone only: WASI keeps legacy's inline `ref.test` chain.
  - from-ast: the stored statics call their provider from the
    `STORED_STATIC_PROVIDERS` table (`__getOwnPropertyDescriptor` → dynamic,
    `__extern_is_array` → bool).
  - integration: `STORED_STATIC_PROVIDER_IMPORTS` registers legacy's import
    signature for each one used. The one-off `usesOwnPropertyDescriptor` flag
    is folded into that table.
  - `expressionTouchesModuleBinding` no longer counts a certified alias
    call's callee as a module read; only its arguments count. That subsumes
    #7269's vardecl special case, which is removed.
  - Deferred: the direct `Array.isArray(dyn)` form, which propertyHelper does
    not use.
- **(e) the mixed conditional** (#5092, `select.ts` plus from-ast's claim):
  - The condition no longer needs a checker-primitive family. Any Phase-1
    condition lowers through `lowerToBooleanForCondition`.
  - The proof is one function, `mixedPrimitiveConditionalArmsProven`, shared
    by the conditional arm, the vardecl alias rule and the move-only scan.
  - A local initialised from such a conditional holds a fresh box, so it is
    exempt from `vardecl-module-binding-alias`.
- **(f) the dynamic logical operand:**
  - `dynamicLogicalValueCarrier` also accepts `mixedConditionalCarrierLocal`:
    a never-written, unannotated local of the current function whose
    initializer is a proven mixed conditional.
  - The move-only scan treats such a conditional as dyn-shaped, and in a dyn
    position it scans the condition and both concrete arms.
  - The result is a move of one of the two carriers through `dyn.truthy`,
    with no unbox, so the (a)–(c) contract is unchanged.
  - No overlap with #7266, which touches module VALUES in
    `isPhase1ConditionExpr`, not dynamic locals.

Code-quality criterion: no new copy of an alias predicate. Every alias site
goes through `certifiedAliasCall`, and every mixed-conditional site through
`mixedPrimitiveConditionalArmsProven`.
