---
id: 7272
title: "IR: propertyHelper isWritable's first statement (dynamic isArray, dynamic mixed conditional, dynamic logical operand)"
status: done
completed: 2026-11-06
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
  - The stored-static form becomes one table, `STORED_STATICS`. Each row
    holds the method's namespace, arity, result kind, backend capability and
    object-runtime provider. `Array.isArray` joins
    `Object.getOwnPropertyDescriptor`.
  - A stored static's aliases are withdrawn by a top-level binding of the
    namespace (var, function or class), or by any write to the namespace's
    member in the file: `Array.isArray = …`, `delete`, or a reflective
    `Object.defineProperty(Array, …)` / `Reflect.*`.
  - One classifier, `certifiedAliasCall(call, shadowed)`, returns the alias
    plus its lowering (`result`, `capability`, and `provider` for a stored
    static), with the native arity applied. It replaces the five
    hand-written copies of the 2-argument uncurried test (move-only scan,
    exact-family proof, call graph, from-ast lowering, from-ast unboxed-local
    proof) and the descriptor-specific predicates.
  - Selector: one alias arm, gated on `alias.capability`. The new capability
    `native-array-is-array` is on standalone only: WASI keeps legacy's inline
    `ref.test` chain. The capability names are typed as an `Extract` of the
    canonical `IrBackendTargetCapability`.
  - from-ast: a stored static calls `alias.provider`. The result is a bool
    for `isArray` and dynamic for the descriptor.
  - integration: `STORED_STATIC_PROVIDER_IMPORTS` registers legacy's import
    signature for each one used. The one-off `usesOwnPropertyDescriptor` flag
    is folded into that table.
  - #7269's vardecl exemption stays local to `isPhase1VarDecl`. A first cut
    made every certified alias callee "not a module read" inside
    `expressionTouchesModuleBinding`. That widened other arms, for example
    `!__getOwnPropertyDescriptor(o, k)`, which #7190 deliberately keeps
    refused, so it was reverted.
  - Deferred: the direct `Array.isArray(dyn)` form, which propertyHelper does
    not use.
- **(e) the mixed conditional** (#5092):
  - The selector and from-ast's `mixedPrimitiveConditionalClaim` share one
    exported proof, `mixedPrimitiveConditionalArms` in `select.ts`. Before,
    each restated it.
  - The condition is still a bounded primitive, OR now a boolean result that
    is an i32 however its operands lower:
    - a comparison (`===`, `<`, `in`, `instanceof`, …);
    - `!`, `&&` or `||` of such;
    - a certified boolean alias call.
  - An unproven condition (`[] ? 1.5 : "a"`) keeps the conditional off the
    route, so it falls back to legacy. A first cut accepted any Phase-1
    condition, and the fresh review showed that turns such a conditional into
    a post-claim compile error.
  - The conditional arm records each conditional it admits in the
    per-subject `currentProvenMixedConditionals`. The move-only scan and the
    carrier-local test run after the shape walk and read that verdict. They
    do not re-derive it, so they need no scope and are confined to the
    current subject.
  - A local initialised from such a conditional holds a fresh box, so it is
    exempt from `vardecl-module-binding-alias`.
- **(f) the dynamic logical operand:**
  - `dynamicLogicalValueCarrier` also accepts `mixedConditionalCarrierLocal`:
    a never-written, unannotated local whose initializer the current subject
    admitted as a mixed conditional.
  - The move-only scan treats such a conditional as dyn-shaped, and in a dyn
    position it scans the condition and both concrete arms.
  - The result is a move of one of the two carriers through `dyn.truthy`,
    with no unbox, so the (a)–(c) contract is unchanged.
  - No overlap with #7266, which touches module VALUES in
    `isPhase1ConditionExpr`, not dynamic locals.

Code-quality criterion: no new copy of an alias predicate. Every alias site
goes through `certifiedAliasCall`, and every mixed-conditional site through
`mixedPrimitiveConditionalArms`, or through the verdict that function
recorded.

## Strict code

Strict function code keeps isWritable legacy. Since #7265@418467f9, the
#7260 element store (`obj[name] = newValue`) is admitted in sloppy code
only, until the strict `__dyn_member_set` exotic-receiver defect (#7270) is
fixed. The wrapped ledger compiles each file's primary variant, which is
sloppy unless the file is `onlyStrict`.

## Result

Wrapped ledger, stride 40, standalone, against #7269 at `aad8abd8`:

- **Legacy units:** 4750 → 4373 (−377). isWritable is freed in 128 files, verifyNotWritable in 126 and verifyWritable in 123.
- **No regressions:** no unit becomes legacy, compileOk stays 1118, invariants stay at 0.
- **Zero-legacy files:** 32 → 32. Every includer still has verifyProperty, verifyCallableProperty, verifyAccessorProperty, verifyEqualTo, the two verifyPrimordial* units and `<module-init>` legacy.

verifyProperty's next blockers, peeled with stubs on an inline copy of propertyHelper:

1. `var names = __getOwnPropertyNames(desc)` and the `names[i]` loop (`vardecl-module-binding-alias`).
2. `if (__hasOwnProperty(desc, 'value'))` (`condition-module-value-nonbool`: a certified boolean alias call in a condition).
3. `assert.sameValue(originalDesc, undefined, label + "…")` (`move-only[concrete]`).

## Review (fresh context, 2026-11-06)

The verdict on the first push was **"not met"**. Every finding:

| # | finding | resolution |
| --- | --- | --- |
| 1 | blocker: an unproven condition (`[] ? 1.5 : "a"`) became a post-claim compile error | fixed: boolean-result condition rule; test |
| 2 | `Array.isArray = …` before the alias was a miscompile | fixed: member and reflective writes withdraw; tests |
| 3 | selector and from-ast mixed proofs duplicated | fixed: one exported `mixedPrimitiveConditionalArms` |
| 4 | per-alias facts spread over five tables | fixed: `STORED_STATICS` rows carry result, capability and provider; `certifiedAliasLane` and `STORED_STATIC_PROVIDERS` removed |
| 5 | capability names written three times | partly fixed: the alias module types them as an `Extract` of `IrBackendTargetCapability`. The inline union in `IrSelectionOptions` predates this PR and is left as is. |
| 6 | an orphaned JSDoc in from-ast | fixed: the table is gone |
| 7 | the carrier-local test did not check its declaration belongs to the current subject | fixed: it reads the current subject's admitted set |
| 8 | the route's off-switch was not applied at all four sites | fixed: the proof wrapper checks `exactMixedPrimitiveConditionalContextReady` |
| 9 | the `__extern_is_array` signature is restated in four other files | rebutted: it predates this PR. Integration's table mirrors legacy's registration on purpose. Folding it is its own cleanup. |
| 10 | `declaration!` assertions | fixed: narrowed local |
