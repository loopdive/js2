---
id: 2031
title: "array destructuring with default + rest + short source traps 'array element access out of bounds' — array.copy keeps unclamped source offset"
status: done
sprint: 61
created: 2026-06-11
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: destructuring
goal: core-semantics
related: [1592, 1920]
origin: "2026-06-10 spec-conformance sweep (iterators agent): verified on main"
---

# #2031 — restLen clamped but srcOffset isn't

## Problem

```ts
const [p, q = 9, ...rest] = [1];
// wasm: RuntimeError: array element access out of bounds
// node: p=1, q=9, rest=[]
```

Default-only (`[p, q=9] = [1]`) and rest-only (`[p, ...rest] = [1]`) both
work — the trap needs default + rest + source shorter than the fixed
bindings.

## Root cause

`src/codegen/destructuring-params.ts:1505-1536` — rest lowering clamps
`restLen = max(0, len - i)` but `array.copy(restArr, 0, srcData, i,
restLen)` keeps the **unclamped source offset `i`**; WasmGC `array.copy`
traps when `srcOffset > src.len` even with length 0 (here i=2 > len=1;
without the default the offset sits at i=1 = len, which validates).

## Fix direction

Clamp the source offset to `min(i, len)` (or skip the copy when restLen
is 0).

## Acceptance criteria

- Repro binds p=1, q=9, rest=[]; longer sources unchanged

## Dupe check

#1592 (done) was iterator-step consumption; #1920 standalone-only. New.
