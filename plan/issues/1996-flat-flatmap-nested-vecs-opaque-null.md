---
id: 1996
title: "flat/flatMap host bridge leaves nested WasmGC vecs opaque — [[1,2],[3,4]].flat() → [null,null] (silent data corruption)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: host-interop
language_feature: array-methods
goal: core-semantics
related: [1969, 1995]
origin: "2026-06-10 spec-conformance sweep (arrays agent): verified on main"
---

# #1996 — _toJsArray converts only the outer vec

## Problem

```ts
const a: number[][] = [[1,2],[3,4]];
JSON.stringify(a.flat())          // wasm: "[null,null]"   node: "[1,2,3,4]"
[1,2,3].flatMap((x: number) => [x, x*2])
                                  // wasm: [null,null,null] node: [1,2,2,4,3,6]
```

## Root cause

`src/runtime.ts:4134-4156` — `_toJsArray` converts only the outer vec;
inner elements fetched via `__vec_get` stay opaque WasmGC refs, so
`jsArr.flat()`/`flatMap` can't recognize them as arrays (fail
`Array.isArray`), and callback-returned wasm vecs are appended whole.
JSON.stringify renders them `null`.

## Fix direction

Recursively unwrap vec refs in `_toJsArray` (depth-limited by the flat
depth), or teach the flat/flatMap shims to unwrap vec refs in elements and
callback results. Same family as #1969 (`__array_concat_any` doesn't
recognize vec structs).

## Acceptance criteria

- Both repros match Node on both nesting levels
- flat(2)/flat(Infinity) on wasm-vec-of-vec inputs correct

## Dupe check

#1969 is the same family scoped to concat args; flat/flatMap paths not
covered. New, related to #1969.
