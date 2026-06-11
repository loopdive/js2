---
id: 1977
title: "linear backend: Array.push past capacity silently corrupts adjacent heap objects — no growth, no bounds checks in the array runtime"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: array-methods
goal: crash-free
related: [1925, 1856, 46]
origin: "2026-06-10 deep-audit sweep (optimizer agent): verified on main, target linear"
---

# #1977 — linear array runtime: unbounded writes into the bump arena

## Problem (verified, `target: "linear"`)

```ts
export function test(): number {
  const a = [1];
  const b = [100, 200, 300];
  for (let i = 0; i < 20; i++) a.push(0);
  return b[0] + b[1] + b[2];
}
```

linear: `500` (`b[0]` overwritten by `a`'s pushes) — node and GC backend:
`600`. Silent cross-object memory corruption.

Also: `a[5] = 9` on `[1]` leaves `a.length === 1` (node: 6) — store beyond
length neither extends nor errors; `a[-1]` / `a[10]` read raw header/neighbor
memory (garbage instead of `undefined`).

## Root cause

`src/codegen-linear/runtime.ts:533-560` — `__arr_push` stores at
`ptr+16+len*4` and increments `len` with **no capacity comparison and no
reallocation path**; :574-582 `__arr_set` and :563-570 `__arr_get` do raw
`i32.store`/`i32.load` with no bounds check and no length update. Works only
while the array is the most recent bump allocation.

## Fix direction

Cap check + grow-and-copy in `__arr_push` (double cap, `__malloc`, memcpy —
requires a realloc-aware handle/indirection since linear has no GC
forwarding); `__arr_set` extends `len` (zero-filling the gap) when
`idx >= len` and bounds-checks against cap; `__arr_get` returns the
undefined-sentinel for `idx >= len`.

## Acceptance criteria

- Repro returns `600` in linear mode
- `a[5] = 9` extends length to 6; OOB reads yield undefined-sentinel
- Push-heavy stress test (1000 pushes, interleaved allocations) stable

## Dupe check

#1925 is the **GC/WASI codegen's** linear-uint8 fast path
(`src/codegen/linear-uint8-*.ts`) — different subsystem. #1856 (allocator
modes), #46 (backend creation) don't mention bounds/growth. Unfiled.
