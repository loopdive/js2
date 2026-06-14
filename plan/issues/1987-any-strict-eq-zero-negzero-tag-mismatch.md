---
id: 1987
title: "any-boxed 0 === -0 returns false: __any_strict_eq bails on i32-box vs f64-box tag mismatch before numeric compare"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-13
completed: 2026-06-13
priority: low
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: equality
goal: core-semantics
related: [1986]
origin: "2026-06-10 spec-conformance sweep (equality agent): verified on main"
---

# #1987 — number tag mismatch in `__any_strict_eq`

## Problem

```ts
const d: any = 0; const e: any = -0;
String(d === e)  // wasm: "false", node: "true"  (d == e is true in both)
```

## Root cause

`src/codegen/any-helpers.ts:909-916` — `__any_strict_eq` returns 0 whenever
`tagA != tagB`, but numbers can be boxed as i32 (tag 2, via `__any_box_i32`,
type-coercion.ts:1182) or f64 (tag 3). `0` and `-0` get different tags, so
the `f64.eq` numeric branch is never reached. Tags 2 and 3 are both
"number" per §7.2.16 and must compare numerically (under which
`+0 === -0` is true).

## Fix direction

In `__any_strict_eq`, treat tag 2 and tag 3 as the same type class: if both
tags ∈ {2,3}, convert both to f64 and compare with `f64.eq`.

## Acceptance criteria

- `(0 as any) === (-0 as any)` → true; `(1 as any) === (1.0 computed)` stays true
- NaN !== NaN preserved

## Dupe check

Grepped negative-zero issues — only standalone-mode #1776 (done). New.
