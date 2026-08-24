---
id: 4610
title: "`.call(this)` inside a class method dropped the receiver — acorn finishNode's ranges writes silently skipped"
status: done
sprint: current
created: 2026-08-21
updated: 2026-08-21
completed: 2026-08-21
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
language_feature: this, call-apply
goal: npm-library-support
related: [3796, 4192, 3729, 4611]
files:
  - src/codegen/named-this-call.ts
  - tests/issue-4537-method-this-call-receiver.test.ts
---

# `helper.call(this)` inside a class method dropped the receiver

## Problem

`receiverIsAdmitted` (src/codegen/named-this-call.ts, the #3796 named-`this`
trampoline gate) admitted a `this`-keyword receiver only when the enclosing
function reads `__current_this`. A CLASS METHOD's `this` is its receiver
parameter (`fctx.localMap` carries `"this"`), so the gate refused it and the
legacy lowering evaluated-and-DROPPED the receiver: the callee's `this.<f>`
read undefined, and every receiver-guarded statement was silently skipped.

This is acorn's exact wrapper shape —
`finishNode(node, type) { return finishNodeAt.call(this, …) }` — where
`finishNodeAt`'s `if (this.options.ranges) node.range[1] = pos` guard read
`undefined.ranges` (as undefined, not a throw) and never wrote, leaving every
`range` as `[start, 0]` in the acorn official suite's ranges family.

## Fix (landed with this issue)

Admit the `this` receiver when the enclosing `fctx.localMap.has("this")` —
the compiled receiver value is param 0, so the trampoline's
`__current_this` install is exactly as sound as for the `readsCurrentThis`
rung. Regression test: `tests/issue-4537-method-this-call-receiver.test.ts`
(both the minimal shape and the acorn class-shaped finishNode reduction).

## Measured

Class-shaped reduction went `[9,[4,0]]` → `[9,[4,9]]`. The acorn official
suite itself stays 3494/3518: real acorn is the fnctor (prototype-method)
variant, which is additionally blocked by the #4611 field/sidecar split —
that issue carries the remaining reduction.
