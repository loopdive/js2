---
id: 2075
title: "standalone: externref-shaped array receivers leak env.__array_join_any / env.__make_callback imports (residual of #1664 retirement)"
status: done
sprint: 61
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: array-methods
goal: host-independence
related: [2074]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2075 — #1286 externref-receiver fallback calls ensureLateImport unconditionally

## Problem

```ts
class A { f(){return 1} } class B extends A { f(){return 2} }
const arr: A[] = [new A(), new B()];
arr.map(o => String(o.f())).join(",")
// standalone: binary imports env.__make_callback + env.__array_join_any
// → instantiation fails   node: "1,2"
```

Also `[1.5,-0,NaN].join(",")` shapes. This one gateway poisoned 8/12 array
probes in the audit (push-pop, sort, slice, spread, shift, reverse,
length-trunc all failed only via their .join display).

## Root cause

`src/codegen/array-methods.ts:4445-4482` — the #1286 externref-receiver
fallback calls `ensureLateImport("__array_join_any")` (and the callback
path `__make_callback`) with no standalone refusal or native path.

## Fix direction

Standalone: route externref-shaped receivers through the native vec join
(#2074's fixed loop) and native callback structs; otherwise refuse loudly
per the #1888 invariant.

## Acceptance criteria

- Repro returns "1,2" standalone with zero env imports
- The 8 collateral probe shapes pass once combined with #2074

## Dupe check

#1662 (done), #1664 (done — `__array_*` leaks supposedly retired; this is
a residual the retirement missed). New/residual.
