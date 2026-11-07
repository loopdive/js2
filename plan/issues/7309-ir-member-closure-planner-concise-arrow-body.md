---
id: 7309
title: "planMemberClosure's body proofs crash on a concise-body arrow (latent; unreachable today)"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: low
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7308, 7198, 7195, 7130]
---

# #7309 — the member-closure planner assumes a block body

## Problem

The body proofs in `planMemberClosure`
(`src/codegen/function-member-closure-planning.ts:541`, and the body-key and
`this` walkers it calls) read `expression.body.statements`. That holds for
every `ts.FunctionExpression`, which always has a `Block` body. It does not
hold for a concise-body arrow (`() => expr`).

## Repro (found by #7308's throwaway probe, 2026-11-07)

The probe let arrows reach the planner by changing three places:

- `select.ts` `isPhase1ClosureLiteral`: `ts.isFunctionExpression(expr) ? …resolve(expr)`;
- `from-ast.ts` `ts.isFunctionExpression(expr) ? cx.functionMemberClosures?.resolve(expr)`;
- `sourceUnit.kind !== "function-expression"`, which also had to accept
  `arrow-function`.

Compiling
`test262/test/built-ins/Date/prototype/toString/non-date-receiver.js` (wrapped,
standalone) then fails `<module-init>` with the invariant
`unexpected-internal-throw: expression.body.statements is not iterable`.
The callback is `() => Date.prototype.toString()`.

## Why it is unreachable today

The planner is FunctionExpression-only in three places:

- the `resolve(expression: ts.FunctionExpression)` signature;
- both entry guards (`ts.isFunctionExpression(expr) ? … : undefined` in the
  selector and in from-ast);
- the `sourceUnit.kind !== "function-expression"` check in
  `planMemberClosure`.

So no arrow reaches the body proofs on main.

## Fix

Branch on `ts.isBlock(expression.body)` in the planner's body proofs:

- refuse a concise body (`return;` from `planMemberClosure`);
- or treat it as `return <expr>;` under the existing result-kind rules.

The fix lands with, or before, any change that lets arrows into the planner.
Add a test that a concise-body arrow either plans or is refused cleanly,
never with an internal throw.
