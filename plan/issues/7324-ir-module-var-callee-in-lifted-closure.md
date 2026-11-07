---
id: 7324
title: "IR: calls inside a lifted module-init closure escape the call-graph gate (claim-then-demote)"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7294, 7167]
assignee: "ttraenkler/c-lane-opus"
loc-budget-allow:
  # 2026-11-07 (#7324): select.ts +9 in buildLocalCallGraph: the walk's
  # closure condition and its 3-line comment, the closure-local skip clause,
  # and the 3-line `isLiftedClosure` predicate the two share.
  - src/ir/select.ts
func-budget-allow:
  # 2026-11-07 (#7324): buildLocalCallGraph +3 (303 > 300): the
  # `liftsClosures` flag, its comment and the widened local-callee clause;
  # the rule is the gate's own walk, so it cannot live outside it.
  - src/ir/select.ts::buildLocalCallGraph
---

# #7324 — calls inside a lifted module-init closure escape the call-graph gate

## Problem

On main, the selector admits a module-init whose lifted closure calls a callee
the IR cannot lower, and from-ast then withdraws the unit with
`ir/from-ast: direct call to "…" has no exact AST-site plan in
<module-init>__closure_N`. Three callee kinds reach it:

| Callee in the closure | Example | On main |
| --- | --- | --- |
| a module variable | `var getter = 3; assert.throws(TypeError, function () { getter(); });` | claimed, withdrawn |
| an ambient function | `assert.throws(SyntaxError, function () { RegExp("(?-m:a)"); });` | claimed, withdrawn |
| a function declaration the IR does not claim | `function f({ w: { x } = undefined }) {} assert.throws(TypeError, function () { f(); });` | claimed, withdrawn |

The harness `assert` is `function assert(v) {} assert.throws = function (C, f) {…}`.

The withdrawn attempt is not free: what it materialized before withdrawing
stays in the module. #7294 reached the variable case in
`built-ins/SharedArrayBuffer/prototype/growable/invoked-as-func.js` (`getter`
read from a descriptor): same IR routes, different gc bytes. The wrapped
stride-40 ledger on main shows the other two kinds in
`built-ins/RegExp/syntax-err-arithmetic-modifiers-reverse-add-remove-m.js`
(`RegExp`) and `language/statements/function/dstr/dflt-obj-ptrn-prop-obj-value-undef.js`
(`f`).

## Root cause

`isPhase1Expr`'s call arm sends an out-of-scope identifier callee down the
direct-call branch and leaves it to the call-graph gate (`buildLocalCallGraph`)
to reject a callee that is external or not claimed. That walk stops at every
nested function-like, so a call inside a lifted module-init closure is never
checked, while from-ast lowers that closure's calls through the same direct-call
plans as the module-init's own.

## Implementation Plan

- **Module:** `src/ir/select.ts`, `buildLocalCallGraph`, the gate itself.
- **Rule:** for the `<module-init>` synthetic, the walk descends into lifted
  closures (function expressions and arrows), so their calls get the same
  edge / external classification as the module-init's own. A callee that
  resolves to a declaration inside a lifted closure (its parameters and
  locals) is local, not an edge, exactly as the existing nested-binding
  clause treats closure bindings.
- **Reuse:** the existing walk, its classification branches and the
  resolver's `localValueDeclaration`; one shared `isLiftedClosure` predicate.
  No selector special case per callee kind (a first cut refused only variable
  callees in `isPhase1Expr`; it was replaced by this rule).
- **Scope:** module-init only. Ordinary units' nested closures keep the
  current walk; the stride shows no claim-then-demote there.
- **Quality criterion:** one rule in the gate, no sibling arm.

## Acceptance criteria

- [ ] The three main repros refuse at selection (`external-call` /
      `call-graph-closure`) with identical runtime values; a claimed function
      declaration and a closure parameter call keep the IR route.
- [ ] Wrapped stride-40 ledger: no file gains or loses an IR unit; invariants 0.
- [ ] gc and standalone bytes identical wherever the route set is unchanged,
      except the files main withdrew (their leftover goes away).
- [ ] test262 verdicts identical on the A/B corpus.
