---
id: 2011
title: "object-literal getter/setter closures capture copies — writes through accessors never reach the outer scope, getter pairs don't share state"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: objects
goal: core-semantics
related: [1971, 1239, 1999]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2011 — accessor callbacks get private ref cells; no resync on property access

## Problem

```ts
let count = 0;
const o: any = { get x() { count++; return count; } };
const a = o.x; const b = o.x;
a + "," + b + "," + count
// wasm: "1,2,0"   node: "1,2,2"
```

Also: getter+setter pair over a shared `let backing` don't see each other's
writes ("1,1" vs "105,105"); `set x(v){captured = v*2}` leaves captured=0.
Setters ARE invoked (`this.y` side-effect probes pass) — only
closure-captured outer state diverges.

## Root cause

`src/codegen/closures.ts:~2740-2768` — each `compileArrowAsCallback`
allocates its own ref cells per callback (getter, setter, and outer frame
don't share one cell per binding), and the "persistent writebacks" that
re-sync outer locals only run after CallExpressions — accessor-triggering
property reads/writes (`o.x`, `o.x = 5`) never trigger a resync.

## Fix direction

Share one ref cell per captured binding across all callbacks in the same
scope (the general closure-environment model), and treat accessor-invoking
property access as a sync point — or migrate accessors onto the shared
environment used by ordinary closures.

## Acceptance criteria

- All three repros match Node
- Getter/setter pairs share captured state; outer scope observes writes

## Dupe check

Overlaps #1971 item 3 (#1239 residual "setters not invoked") but refines
it: setters fire, capture sharing is what's broken. Filed separately with
cross-ref.
