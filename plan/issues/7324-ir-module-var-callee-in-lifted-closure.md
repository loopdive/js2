---
id: 7324
title: "IR: calls inside a lifted closure escape the call-graph gate (claim-then-demote)"
status: done
completed: 2026-11-07
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
  # 2026-11-07 (#7324): select.ts +8 net (+10/-2): the walk's 3-line
  # comment and widened closure condition, the closure-local skip clause, and
  # the 3-line `isLiftedClosure` predicate the two share.
  - src/ir/select.ts
func-budget-allow:
  # 2026-11-07 (#7324): buildLocalCallGraph +4 (298 -> 302, ceiling 300):
  # the 3-line comment and the widened local-callee clause; the rule is the
  # gate's own walk, so it cannot live outside it.
  - src/ir/select.ts::buildLocalCallGraph
---

# #7324 — calls inside a lifted closure escape the call-graph gate

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
nested function-like, so a call inside a lifted closure is never checked, while
from-ast lowers that closure's calls through the same direct-call plans as its
enclosing unit's own. This holds for the module-init and for ordinary functions
alike (RV7175: `function t(x) { const c = (y) => f(y); return c(x); }` with an
unclaimed `f`, or `RegExp("a")` in the arrow, withdraws `t` with "no exact
AST-site plan in t__closure_0").

## Implementation Plan

- **Module:** `src/ir/select.ts`, `buildLocalCallGraph`, the gate itself.
- **Rule:** for every caller, the walk descends into lifted closures
  (function expressions and arrows), so their calls get the same edge /
  external classification as the enclosing unit's own. A callee that
  resolves to a declaration inside a lifted closure (its parameters and
  locals) is local, not an edge, exactly as the existing nested-binding
  clause treats closure bindings.
- **Reuse:** the existing walk, its classification branches and the
  resolver's `localValueDeclaration`; one shared `isLiftedClosure` predicate.
  No selector special case per callee kind (a first cut refused only variable
  callees in `isPhase1Expr`; it was replaced by this rule).
- **Scope:** every unit. A first cut gated the rule on `<module-init>`; review
  (RV7175) reproduced the same withdrawal in ordinary functions, and dropping
  the gate costs no unit on the stride ledger.
- **Quality criterion:** one rule in the gate, no sibling arm.

## Acceptance criteria

- [x] The three main repros refuse at selection (`external-call` /
      `call-graph-closure`) with identical runtime values; a claimed function
      declaration and a closure parameter call keep the IR route.
- [x] Wrapped stride-40 ledger: no file gains or loses an IR unit; invariants 0.
- [x] gc and standalone bytes identical wherever the route set is unchanged,
      except the files main withdrew (their leftover goes away).
- [x] test262 verdicts identical on the A/B corpus.

## Resolution (2026-11-07): an uninitialized script `var` callee is subsumed by #7287

#7164 (#7287) and this issue's PR (#7175) landed in parallel. `var getter;`
lives in its dynamic module home, and #7287 lowers a statement call through it
as the dynamic call (IsCallable, then a catchable TypeError). The walk now
descends into lifted closures, so that arm admits `getter()` there too, and
`<module-init>` is claimed instead of refused. The claim is sound: on
standalone, wasi and gc it has no post-claim error, and a harness that accepts
only a `TypeError` completes. A module-level reassignment to a non-callable
value is claimed and also correct: `getter = 3`, and `getter = 3; getter =
undefined`, throw the catchable TypeError on all three lanes (RV7185). Every
reassignment to a callable keeps `<module-init>` legacy, so the claimed path
never calls a stale function. The "uninitialized
var" row of the test moves from the refused cases to the claimed ones, and a
runtime case pins the TypeError on all three lanes. `var getter = 3` and
`let getter = 3` stay refused (`external-call`): this rule is unchanged for
callees #7287 does not lower.

Fixed forward in PR #7185, which changes only the test and this file. The
semantics were verified independently by this issue's owner (R8) on merged
main `636331310e`. With the real test262 harness (`assert.throws` checks
`constructor === TypeError`), `var getter; assert.throws(TypeError, function
() { getter(); })` is IR and passes on gc and standalone. An ordering probe
(`r = 1; getter(); r = 2;`, then `assert.sameValue(r, 1)`) shows the TypeError
is thrown at the call, after the code before it and before the code after it.
`let getter;` stays legacy. `var getter = 3` and `var getter = null` stay
refused (`external-call` / `vardecl-module-value-flow`). A reassignment to a
callable never reaches the #7287 arm here (`<module-init>` stays legacy). A
legacy trap on `getter = function () {}; getter = 3; getter()` predates #7164;
it is #7334.

