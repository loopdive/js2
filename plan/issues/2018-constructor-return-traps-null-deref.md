---
id: 2018
title: "any return statement in a base-class constructor makes new C() trap 'dereferencing a null pointer' (bare return, return obj, return primitive)"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [825]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2018 — return in constructor pushes ref.null instead of __self

## Problem

```ts
class A { x = 1; constructor() { if (this.x > 0) return; this.x = 2; } }
new A().x
// wasm: trap "dereferencing a null pointer" at the new site   node: 1
```

Also traps: `constructor() { return { x: 99 } as any; }` (object should
override `this`) and `return 42 as any` (primitive should be ignored).

## Root cause

`src/codegen/statements/control-flow.ts:173-181` — bare `return;` in a
value-returning function pushes a default `ref.null <struct>` for the
ctor's `(ref $A)` return type, and `return <expr>` (164-167) coerces
non-struct values to a null struct ref. `compileReturnStatement` has no
`fctx.isConstructor` arm implementing §10.2.1.3: object result overrides,
everything else returns `this` (`__self`).

## Fix direction

Add an isConstructor arm: bare/primitive return → `local.get __self`;
object return → that object (base classes; derived-ctor primitive return
is a TypeError, partially covered by the static check at
control-flow.ts:142-161 which `as any` bypasses).

## Acceptance criteria

- All three repros match Node
- Guard-clause `return;` in ctors works (common idiom)

## Dupe check

#825 documents only the derived-ctor return-primitive TypeError subset.
New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1326; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
