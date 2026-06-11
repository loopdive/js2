---
id: 2074
title: "standalone: join() on string[] receivers traps null deref (indexed reads of the same array work)"
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
related: [1998, 2078]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2074 — emitArrayJoin null-derefs on native-string element arrays

## Problem

```ts
const a: string[] = ["x","y"]; a.join(";")
// standalone: RuntimeError: dereferencing a null pointer   node: "x;y"
```

Also `"a,b".split(",").join(";")` and `Object.keys(o).join(",")`. Indexed
reads of the same arrays PASS (`split(",")[1]`, `.length`) — the data is
fine; the join loop is broken. This poisoned many array probes whose
display used .join.

## Root cause

`src/codegen/array-methods.ts:4487+` (emitArrayJoin) — the
element-to-string loop null-derefs for ref-typed (native string) element
arrays.

## Fix direction

Handle the native-string element kind in the join loop (elements are
already strings — concat directly, no conversion).

## Acceptance criteria

- All three repros match Node standalone; host mode unchanged
- Sibling check: number[] join standalone still correct

## Dupe check

#1998 (host mode, externref elements, illegal cast — different shape and
mode), #2125 (ex-#1958, split limit). New.
