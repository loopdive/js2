---
id: 7324
title: "IR: selection admits a call to an out-of-scope variable callee (a module `var` read inside a lifted module-init closure)"
status: in-progress
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: implementation
area: ir
goal: ir-full-coverage
related: [7294, 7167]
assignee: "ttraenkler/c-lane-opus"
loc-budget-allow:
  # 2026-11-07 (#7324): the one selection rule (+7: the guard, its capability
  # code and a 4-line comment saying why) sits in isPhase1Expr's direct-call
  # branch, beside the nested/lexical binding refusal it extends.
  - src/ir/select.ts
func-budget-allow:
  # 2026-11-07 (#7324): the same +7 lands in isPhase1Expr's direct-call
  # branch; the guard belongs beside the nested/lexical refusal it extends,
  # and a one-use helper would only move the comment.
  - src/ir/select.ts::isPhase1Expr
---

# #7324 — selection admits a call to an out-of-scope variable callee

## Problem

On main, the selector admits a module-init whose lifted closure calls a module
**variable**:

```js
function assert(v) {}
assert.throws = function (C, f) { try { f(); } catch (e) { return; } };
var getter = 3;
assert.throws(TypeError, function () { getter(); });
```

from-ast then withdraws the unit: `ir/from-ast: direct call to "getter" has no
exact AST-site plan in <module-init>__closure_1`. The closure's scope has no
binding for `getter`, so the call falls to the direct-call plan, which only a
function declaration has. The same claim-then-demote happens with `let getter = 3`,
`var getter;` and `var getter = parseInt("3")`.

The withdrawn attempt is not free: what it materialized before withdrawing
stays in the module. #7294 reached this gap in
`built-ins/SharedArrayBuffer/prototype/growable/invoked-as-func.js` (the
harness's `assert.throws(TypeError, function () { getter(); })` with `getter`
read from a descriptor): same IR routes, different gc bytes.

## Why the selector misses it

`isPhase1Expr`'s call arm sends an out-of-scope identifier callee down the
direct-call branch and relies on the call-graph gate to reject a callee that is
not a claimed function. That gate (`buildLocalCallGraph`) stops at nested
function-like nodes, so a call inside a lifted closure is never checked.

## Implementation Plan

- **Module:** `src/ir/select.ts`, `isPhase1Expr`'s direct-call branch, next to
  the `expr-nested-call-before-binding` refusal it extends (an out-of-scope
  name that is not a function the plan can name).
- **Reuse:** the module-binding resolver's `localVariableDeclaration`, the
  lookup the selector already uses for this question. No new predicate.
- **Rule:** an out-of-scope callee that resolves to a variable declaration of
  this file refuses with `call-resolution-unsupported`
  (`expr-variable-callee-out-of-scope`). In-scope callees (locals, dynamic
  bindings, closures) take their existing branches first, as do the
  certified alias / imported / ambient call shapes above.
- **Quality criterion:** one guard, no sibling arm, no new helper.

## Acceptance criteria

- [ ] The main repros refuse at selection, with identical runtime values.
- [ ] Wrapped stride-40 ledger: no file loses an IR unit; invariants 0.
- [ ] gc and standalone bytes identical wherever the route set is unchanged.
- [ ] test262 verdicts identical on the affected files.
