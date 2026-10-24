---
id: 7054
title: "standalone: calling a rest-parameter closure stored in a property (`this.use = (a, ...hs) => …; app.use('*', mw)`) casts the second argument into the rest-vec slot (→ null) and drops the rest — hono `helper/dev` throws `Array method called on null or undefined` at module init"
status: done
sprint: current
created: 2026-10-17
updated: 2026-10-17
completed: 2026-10-17
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: closures, rest-parameters
goal: standalone-gap
related: [7019, 5334]
# 2026-10-17 — the pack must reuse calls-closures.ts's own
# `compileRestClosureArguments`; moving the helpers out would import back into
# this file and join the codegen import cycle. Two call sites in
# compileCallablePropertyCall choose between the rest pack and the old push.
loc-budget-allow:
  - src/codegen/expressions/calls-closures.ts
func-budget-allow:
  - src/codegen/expressions/calls-closures.ts::compileCallablePropertyCall
---

# Rest closures in properties are called positionally

Split out of [#7019](./7019-standalone-module-init-traps-cjs-graphs.md).

## Problem

hono's `Hono` constructor stores `this.use = (arg1, ...handlers) => {
handlers.forEach(…) }`; its upstream `helper/dev` test builds
`new Hono().use('*', mw).get(…)` at module init. `compileCallablePropertyCall`
lowers the field through a synthetic wrapper derived from the checker
signature, `(externref, vec) -> R`, and pushed arguments positionally: the
second argument was cast to the vec slot (fails → null) and the rest were
dropped. The JS host avoids this by deferring to the runtime rest bridge
(#5334, host-only); host-free there was no rest handling at all.

## Implementation Plan

When `noJsHost(ctx)` and the checker signature's declaration ends in
`...rest` with exactly the wrapper's formal count, treat the wrapper as a
rest closure (`hasRestParam: true`) and reuse `compileRestClosureArguments`:

- multi-candidate ladder: pack into the argument locals and install the true
  `__argc` (`buildArgcExtrasSetupFromLocals` + `emitSetArgc`, as
  `emitMatchedClosureCallArguments` does) instead of
  `collectPropertyCallArgLocals` + `emitClosureCallArgcExtras`;
- single-candidate path: push the pack on the stack (that path installs no
  `__argc`).

Unpackable shapes (mixed dynamic spread) keep the old push.

## Resolution

Implemented as planned. Test `tests/issue-7054-standalone-callable-property-rest.test.ts`
(1/2/0 rest args, an undeclared field, the module-init call). hono
`helper/dev` now initialises (1/8 pass; the other 7 fail on their own
`toEqual` assertions). gc binaries byte-identical.

Out of scope, filed as [#7060](./7060-standalone-any-receiver-use-disposablestack-dispatch.md):
the same call through an `any` receiver dispatches to
`DisposableStack.prototype.use`.
