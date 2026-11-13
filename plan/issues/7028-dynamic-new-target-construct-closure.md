---
id: 7028
title: "host: `new.target` is 0 inside a class constructor reached through an untyped parameter (`function make(K: any) { return new K(); }`) — the #3981 `__construct_closure` arm shadows the #2026 tag-dispatch path that sets it"
status: ready
sprint: Backlog
created: 2026-10-17
updated: 2026-10-17
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: new.target, classes
goal: class-system
related: [7014, 7026, 2026, 3981]
requested_by: ttraenkler/wave15-values-a
---

# #7028 — `new.target` lost on the `__construct_closure` arm

Found while triaging `tests/issue-2026-dynamic-new-spread.test.ts` for #7014
(wave 15). Two tests there stay red: "sets new.target to the dispatched
class inside the dynamic ctor" (0, want 1) and "new.target discriminates
between two dynamically-constructed classes" (0, want 3).

## Mechanism

#3981 admitted untyped (`any`) PARAMETER callees to
`resolvesToConstructableFunctionValue` (`new-super.ts`), so `new K()` with
`K: any` now takes the host `__construct_closure` arm, which
`Reflect.construct`s a wrapped callable and never sets the compiler's
new-target global. Before, the call reached the #2026 dynamic-new path, which
tag-dispatches over the program's classes and sets new.target to the
dispatched class id (PR-3b). #7026 already routes SPREAD calls back to the
#2026 path; argument-free and plain-argument calls still take the closure arm.

## Fix direction

When the program has struct-backed classes, try the #2026 class tag dispatch
first and fall back to `__construct_closure` only for a non-class callee (the
fnctor case #3981 was written for), or set new.target inside the closure arm
when the callee is a class object. Keep the #3981 fnctor-parameter tests
green.
