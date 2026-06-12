---
id: 2020
title: "inherited static fields unreachable through subclass name (B.count → null; static method inheritance works)"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [1643]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2020 — static read doesn't walk classParentMap

## Problem

```ts
class A { static count = 11; static m(): number { return 5; } }
class B extends A {}
(B as any).count   // wasm: null   node: 11
```

`B.m()` (inherited static *method*) works; only fields fail.

## Root cause

`src/codegen/property-access.ts:1875-1882` — static read looks up
`staticProps.get("B_count")` only; no walk up `ctx.classParentMap` to find
`A_count` (§10.2.7: static members inherit via the constructor
[[Prototype]] chain).

## Fix direction

On miss, walk classParentMap and retry `<Ancestor>_<prop>`; same for
static writes through the subclass name (spec: write creates an own
static on B — document the chosen behavior).

## Acceptance criteria

- Repro returns 11; multi-level inheritance works; own statics shadow

## Dupe check

#1643 (static init order, in-review) doesn't cover inheritance lookup;
#1395/#1116b done. New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1333; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
