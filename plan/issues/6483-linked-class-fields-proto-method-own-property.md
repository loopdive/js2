---
id: 6483
title: "Linked test262 harness: verifyProperty(C.prototype, m) reports 'not an own property' when the class also declares instance fields"
status: ready
sprint: current
created: 2026-09-15
updated: 2026-09-15
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: runtime
language_feature: classes
goal: test262-conformance
depends_on: [6477]
related: [3451, 6477, 1364]
---

# #6483 — prototype method invisible to the provider when the class has fields

## Problem (measured 2026-09-15 under #6477)

After #6477, all 20 `language/expressions/class/elements/multiple-stacked-definitions-*`
rows agree with the honest lane, while all 20 `multiple-definitions-*` rows
still fail — with a NEW message: `m should be an own property` (was `foo
descriptor value should be foobar`). The only structural difference is that the
non-stacked template declares instance fields (`foo = "foobar"`, `bar =
"barbaz"`) alongside prototype methods `m()` / `m2()` and then runs
`verifyProperty(C.prototype, "m", …)`.

The reduced form `class C { m(){} }` + the same `verifyProperty` PASSES in the
linked lane, so the trigger is the combination of instance fields and
prototype methods on one class object — most likely the class-prototype
registration (`_prototypeMethodNames`, #1364a) or the field-initialiser
constructor shape the provider's `hasOwnProperty` path sees for a foreign
prototype object.

## Acceptance criteria

- [ ] Minimal body (`class C { foo = 1; m(){} }` + `verifyProperty(C.prototype, "m", {enumerable:false, configurable:true, writable:true})`)
      passes linked; the runtime path that answers "not own" is named here.
- [ ] The 20 `multiple-definitions-*` rows flip; honest lane byte-identical.
