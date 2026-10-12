---
id: 6975
title: "standalone: `y.prototype = new K` keeps the fnctor struct as the prototype; `__object_create` drops a non-plain proto, so subclass instances lose inherited methods (Octane box2d `Box2D.inherit` → `SetAsEdge` not a function)"
status: ready
sprint: current
created: 2026-10-11
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: constructor-functions, prototype, new
goal: standalone-gap
related: [6974, 6970, 6969, 6951, 6944]
---

# A `new F` result stored as a prototype stays a fnctor struct

Found by the #6974 implementer (Session D, 2026-10-11). This is box2d's next standalone blocker after
#6974 (PR #6652). Module init and `new b2World(gravity, true)` now complete, then `shape.SetAsEdge(...)`
throws `TypeError: called value is not a function`.

## Cause

`Box2D.inherit` does `function K(){}; K.prototype = x.prototype; y.prototype = new K;`. Because that
`new K` sits on the right of a property assignment, it stays a fnctor **struct** instead of a plain
runtime object. `fnctorNewResultConsumedAsExternref` (`src/codegen/expressions/new-super.ts`) does not
accept that position.

When `new <subclass>` runs, `__object_create(proto)` keeps a prototype only if it is a plain
`$Object`. So the struct is dropped and the subclass loses its inherited methods.

The minimized repro is in the #6974 issue file's Remaining section, and in the #6974 implementer's
worktree `.tmp/`.
- node: `number:number:true:true`
- standalone: `number:undefined:false:true`

## Plan

1. Make a `new F` result stored into a `.prototype` member write lowered as a runtime object. The
   #6974 implementer's unshipped experiment extended `fnctorNewResultConsumedAsExternref` to accept
   `<member> = new F`, and that fixed every `inherit`-shaped repro. Prefer the narrowest form: the
   target is a `.prototype` property, or the result flows into a prototype slot. Alternatively, teach
   `__object_create` to accept a fnctor-struct prototype through the #6944 struct-link helpers. Pick
   whichever is smaller and keeps gc byte-identical.
2. Re-measure box2d. The experiment's next failure was in `b2Island.Solve`: `e.m_force.x` reads back
   undefined. Triage it, and fix it here if it is small and the same family; otherwise file it.

## Acceptance

- The `inherit`-shaped repro matches node on standalone.
- A regression test `tests/issue-6975-*.test.ts` covers: an inherit-style subclass method call; a
  direct `new` control; and `instanceof` across the chain.
- Box2d gets past `SetAsEdge`. Report how far it gets: PASS, or the next blocker with a repro.
