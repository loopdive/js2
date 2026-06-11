---
id: 2024
title: "class accessor override with partial pair: get-only override silently drops writes (should TypeError); set-only override reads NaN (should undefined)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes
goal: core-semantics
related: [1456, 1364, 2017]
origin: "2026-06-10 spec-conformance sweep (classes agent): verified on main"
---

# #2024 — accessor write falls through to silent struct-field path

## Problem

```ts
class A { _v = 1; get v(): number { return this._v; } set v(x: number) { this._v = x * 2; } }
class B extends A { get v(): number { return this._v + 100; } }
const b = new B();
try { b.v = 7; } catch (e) { return -1; }
return b._v;
// wasm: 1 (write silently dropped)   node: -1 (TypeError)
```

Per spec, B's own get-only accessor shadows A's setter — strict-mode write
throws TypeError; A's setter must NOT run. Mirror case: set-only override
reading `b.v` gives NaN instead of undefined.

## Root cause

`src/codegen/expressions/assignment.ts:2379-2431` — accessor write path
requires `${typeName}_set_${fieldName}` in funcMap; when the overriding
class is get-only the lookup misses and control falls to the struct-field
path, which finds no field named `v` and silently returns (no strict-mode
TypeError emission).

## Fix direction

When the receiver's class declares a get-only accessor for the prop, emit
TypeError on write (don't walk to the parent's setter); set-only read →
undefined.

## Acceptance criteria

- Repro returns -1; set-only read yields undefined
- Full-pair accessors and inherited accessors unchanged

## Dupe check

#1456 covers private readonly accessor TypeError; #1364 is descriptor
shape. New. Object-literal sibling: #2017.
