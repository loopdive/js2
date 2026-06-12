---
id: 2081
title: "standalone: loose == between two any operands compares references, never coerces ('1' == 1 → false)"
status: ready
sprint: 62
created: 2026-06-11
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: equality
goal: host-independence
related: [2073, 1986]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2081 — any/any == lowers to ref identity in standalone mode

## Problem

```ts
const a: any = "1"; const b: any = 1;
String(a == b)   // standalone: "false"   node: "true"
const c: any = []; c == 0   // standalone: false   node: true
```

## Root cause

`src/codegen/binary-ops.ts:1750+` — any/any equality lowers to ref
identity standalone instead of §7.2.13 IsLooselyEqual. The `[] == 0` half
may be absorbed by #1900 (in-review, native ToPrimitive) — recheck after
PR 1251 lands; the boxed primitive-vs-primitive half is NOT claimed by it.

## Fix direction

Native IsLooselyEqual over `$AnyValue` tags (shares the lowering #2073
needs for mixed static types — implement together).

## Acceptance criteria

- Both repros match Node standalone (the array case may ride #1900)
- Reference identity preserved for object==object

## Dupe check

#1986/#1987 (strict ===, host), #1990 (host loose eq), #1900/#1910
(object ToPrimitive). Partially new — the primitive/primitive half. Filed.
