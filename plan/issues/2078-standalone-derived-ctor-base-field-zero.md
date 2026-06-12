---
id: 2078
title: "standalone: derived-class constructor reads base-initialized field as 0 after super() (same read from a method works)"
status: done
completed: 2026-06-12
sprint: 61
created: 2026-06-11
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes
goal: host-independence
related: [2018, 2082]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2078 — post-super() this.x reads 0 inside the derived ctor only

## Problem

```ts
class A { x: number; constructor() { this.x = 1; } }
class B extends A { y: number; constructor() { super(); this.y = this.x + 1; } }
String(new B().y)
// standalone: "1" (this.x reads 0 inside B's ctor)   node: "2"
```

The same `this.x` read from a method on B passes — ctor-only, post-super
reads.

## Root cause

Not fully pinned — likely `src/codegen/class-bodies.ts`: base-ctor writes
via super() land on a different instance than the derived ctor's `this`
(or the read is compiled against a stale/uninitialized local). Triage
first step: dump WAT for the repro and trace which struct ref super()
writes into vs which one `this.x` reads.

## Acceptance criteria

- Repro returns "2" standalone; host mode and method reads unchanged
- Multi-level chains (A→B→C) correct

## Dupe check

#2018 (ctor return trap, host), #1054 (eval supercall), #2082 (implicit
ctor arg drop — sibling but explicit-ctor here). New.

## Frontmatter reconcile (2026-06-12)

Fixed by merged PR #1354; frontmatter was stale at `ready`. Flipped to `done` during sprint-62 planning triage.
