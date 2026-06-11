---
id: 1992
title: "f instanceof Function hard-coded false for function values (collectInstanceOfTags empty → graceful i32.const 0)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: low
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: operators
goal: core-semantics
related: [1721, 1729]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1992 — instanceof Function returns false for closures

## Problem

```ts
const f: any = () => 1;
String(f instanceof Function)  // wasm: "false"   node: "true"
```

`instanceof Object` works (#1729, done).

## Root cause

`src/codegen/typeof-delete.ts:471-492` — `compileInstanceOf` resolves the
RHS as a user class; `Function` yields no tags (`collectInstanceOfTags`
empty) so it emits the graceful-fallback `i32.const 0`. The typeof path
special-cases `Function` (typeof-delete.ts:713) but instanceof does not;
closures are ref structs, so a `ref.test` against the closure struct family
(or the typeof-style "function" predicate) is needed.

## Fix direction

Special-case `Function` RHS in `compileInstanceOf` mirroring the typeof
"function" predicate.

## Acceptance criteria

- Arrow/function/class values: `instanceof Function` → true
- Non-callables stay false

## Dupe check

#1721 (subclass extends Function, done), #1729 (instanceof Object, done).
New.
