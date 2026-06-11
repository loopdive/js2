---
id: 1965
title: "derived-class construction never executes the base constructor body; super(args) writes args positionally into parent struct fields"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: classes
goal: class-system
related: [1551, 1833, 1366]
origin: "2026-06-10 deep-audit sweep (objects agent): verified miscompile on main"
---

# #1965 — `super(args)` is a positional field copy, not a constructor call

## Problem

Constructing a derived class never runs the base constructor's **body**:
`super(5)` maps arguments positionally onto parent struct fields with
`struct.set`. Any parent ctor logic beyond `this.f = <param>` assignments —
computation, side effects, conditionals, method calls — is silently dropped.
Core OO semantics, silent wrong results.

## Repro (verified on main)

```ts
export function test(): string {
  class A { x: number; constructor(x: number){ this.x = x*2; } }
  class B extends A { constructor(){ super(5); } }
  return String(new B().x);
}
```

| case | wasm | node |
|------|------|------|
| above | `5` | `10` |
| log probe (`A` ctor appends `"Ac;"`, `B` appends `"Bc;"`) | `Bc;` | `Ac;Bc;` |
| implicit ctor (`class B extends A {}`) | `` | `Ac;` |
| base ctor calls overridable method | `` | `B` |

Passes only by accident when the parent ctor consists solely of
`this.f = <expr>` assignments (mined as pseudo-field-initializers).

## Root cause

- `src/codegen/class-bodies.ts:1992` (`compileSuperCall`) — for a user-class
  parent it re-runs ancestor *field initializers* (~2090-2110) then maps
  `super(...)` arguments **positionally onto `assignableParentFields`** with
  `struct.set` (~2105-2200). The parent constructor's parameter binding and
  body statements are never compiled/invoked.
- `src/codegen/class-bodies.ts:1256-1320` (implicit-ctor path) — replays only
  field initializers plus top-level `this.<name> = <expr>` ExpressionStatements
  from the ancestor ctor body; everything else silently dropped.

## Fix direction

Compile each class constructor as a real callable (init function taking
`(self, ...ctorParams)`); `super(args)` evaluates args and `call`s the
parent's init function. The implicit path forwards args to the same parent
init. Architect-level change to class lowering; coordinate with #1551 (super
arg evaluation order, in-progress) and #1833 (builtin-parent forwarder,
in-review).

## Acceptance criteria

- All four repro cases match Node
- 3-level hierarchies: each ctor body runs exactly once, base-first
- Field-initializer-vs-ctor-body ordering per spec (base fields → base ctor
  body → derived fields → derived ctor body)
- Builtin-parent (`extends Error` etc.) path unregressed

## Dupe check

#1551 (in-progress) = super *argument evaluation order* only; #1833
(in-review) = builtin-parent forwarder arg truncation; #1366 (done) documents
the positional mechanism for builtin parents. The user-base-ctor-body gap is
unfiled.
