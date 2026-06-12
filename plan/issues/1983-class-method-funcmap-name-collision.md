---
id: 1983
title: "synthetic class-method names collide with user functions: class A { m() {} } + function A_m() breaks both paths"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: compilable
related: [1370]
origin: "2026-06-10 deep-audit sweep (IR agent, secondary observation): verified on main @ 0c753ea88, both paths"
---

# #1983 — `${ClassName}_${method}` funcMap keying is not collision-free

## Problem

A class method `A.m` is registered under the synthetic name `A_m`; a
user-defined top-level `function A_m()` collides with it. Legacy: runtime
null-ref trap; IR: module-wide CompileError (`argument type mismatch in
call`). Node: works (`12`).

```ts
class A { m(): number { return 10; } }
function A_m(): number { return 2; }
export function test(): number { return new A().m() + A_m(); }
```

## Root cause (area)

funcMap keys use the `${ClassName}_${method}` convention
(`src/codegen/class-bodies.ts`, #1370 keying) with no mangling/uniquing
against user identifiers.

## Fix direction

Use a non-collidable separator in synthetic names (e.g. `A#m` or a reserved
prefix that is not a valid TS identifier), or unique-ify on collision at
registration time. Audit other synthetic name factories (getters/setters,
statics, closure wrappers) for the same convention.

## Acceptance criteria

- Repro returns `12` on both paths
- Mangled names don't leak into exports/WIT
- Other `_`-joined synthetic name sites audited

## Dupe check

#1370 (class-method IR adoption — keying origin). No collision issue on file.
