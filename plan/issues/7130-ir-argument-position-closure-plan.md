---
id: 7130
title: "IR: plan closure literals passed as arguments to a top-level function value (census step 2)"
status: in-review
sprint: current
created: 2026-10-22
updated: 2026-10-22
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: feature
area: ir
goal: ir-full-coverage
parent: 7106
assignee: "ttraenkler/session-d"
depends_on: [7119, 7115, 7113]
# 2026-10-22 (#7130): the planner's anchor is split into memberAnchor /
# argumentAnchor helpers (the plan body is unchanged); one capture line in
# from-ast.
loc-budget-allow:
  - src/codegen/function-member-closure-planning.ts
  - src/ir/from-ast.ts
---

# IR: plan closure literals passed as arguments

Parent: [#7106](7106-ir-test262-harness-units.md). This is step 2 of the
integrated-stack census of 2026-10-22, the `closure-return-type` class. It is a
test-body blocker in 59 of the 266 sampled test262 files, for example
`assert.throws(RangeError, function () { … })`.

## Problem

In a script, every unannotated closure literal was refused with
`closure-return-type` unless it was a planned member closure (`F.x = function
…`). The selector needs a return-type annotation or a plan, and JavaScript has
no annotations. A closure passed to `assert.throws`, or to any helper, therefore
kept `<module-init>` legacy.

## Fix

`planMemberClosure`'s anchor is now one of two shapes:
- the existing member store, `memberAnchor`;
- a new **argument anchor**, `argumentAnchor`.

**What counts as an argument anchor.** A closure literal is an argument of a
call whose callee names a same-source top-level function value, either
`run(fn)` or the function-object member call `assert.throws(E, fn)`. The call
sits in `<module-init>`, or in a top-level function, at any block depth.

**What the plan provides.** The plan itself is unchanged:
- legacy's own physical signature, so legacy and IR callers agree on the
  closure ABI;
- dynamic `any` parameters;
- a void, boolean or string result, with the open-body proof;
- `this` bound at entry.

**What the anchor must keep current.** `isCurrent` re-checks the call, the
argument slot, the callee and the callee's resolved target.

**What is excluded.** Builtin callees (`arr.forEach(function …)`) are not
anchors, because their callback lowering has its own contract.

**Module-scope bindings inside a closure.** A `var` that is a `moduleGlobal`
binding in `<module-init>`'s scope was a capture refusal ("captures non-local
binding"). It is a global, so the lifted body now reaches the same `__mod_`
storage itself and nothing is captured.

## Measured

`tests/issue-7130-argument-closure-plan.test.ts` (standalone, script goal)
compares each case with node and with a legacy compile
(`experimentalIR: false`). In each case `<module-init>` is IR, and a wrong
expectation still throws from both the IR body and the legacy body. The cases:
- the closure writes a module `var`;
- the closure reads dynamic parameters;
- the closure calls `n.toString()` on a parameter, through #7119's wrapper;
- the call sits inside a block.

The builtin-callee control stays legacy.

## Next blockers inside such closures (measured on probes, not built)

- **A module `var` that receives a dynamic value** (`got = n`) has no
  representable slot: `vardecl-module-storage-unrepresentable`, census step 3.
- **`throw 1` in a closure** gives `throw-value-unsupported` ("throw val not in
  slice 9").
- **A top-level function callee that calls its dynamic parameter** (`function
  runIt(fn) { fn(); }`) keeps `<module-init>` legacy through
  `call-graph-closure`.
