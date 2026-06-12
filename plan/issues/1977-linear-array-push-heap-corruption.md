---
id: 1977
title: "linear backend: Array.push past capacity silently corrupts adjacent heap objects — no growth, no bounds checks in the array runtime"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: critical
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: array-methods
goal: crash-free
related: [2045, 1856, 46]
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

#2045 is the **GC/WASI codegen's** linear-uint8 fast path
(`src/codegen/linear-uint8-*.ts`) — different subsystem. #1856 (allocator
modes), #46 (backend creation) don't mention bounds/growth. Unfiled.

## Resolution (2026-06-12)

Implemented growth via relocation + forwarding in
`src/codegen-linear/runtime.ts`:

- `__arr_grow(ptr, minCap) → newPtr` — allocates a fresh block with
  `cap = max(cap*2, minCap, 4)`, copies `len` elements, and rewrites the OLD
  header into a forwarding record (tag `0x06` at +0, new pointer at +4).
  Linear has no GC forwarding, so stale aliases are handled lazily: every
  accessor first chases the forwarding chain via the new idempotent
  `__arr_resolve` helper (registered by both `addUint8ArrayRuntime` and
  `addArrayRuntime`, so direct-runtime tests that build modules manually
  keep working).
- `__arr_push` — resolves, grows when `len >= cap`, then stores.
- `__arr_set` — resolves; grows when `idx >= cap`; zero-fills the gap and
  extends `len` to `idx+1` when `idx >= len` (JS store-beyond-length);
  negative `idx` (a JS non-index property write) is a no-op instead of
  corrupting header/neighbour memory.
- `__arr_get` — resolves; `idx >= len` (unsigned, covers negative) returns
  0, the linear backend's `undefined` representation.
- `__arr_len` — resolves before loading.
- `__u8arr_from_arr` — resolves its array argument at entry (only raw
  offset-16 array consumer outside the core accessors; the map/set
  offset-16 hits are their own structures, and the simd.ts array helpers
  are currently unreferenced dead code).

Tag dispatch sites in `src/codegen-linear/index.ts` (`tag == 0x02` →
Uint8Array else Array) stay correct: a forwarded header (0x06) routes to
the `__arr_*` helpers, which resolve internally.

## Test Results

- Repro returns 600 in linear mode (was 500).
- `tests/issue-1977.test.ts` — 8/8: neighbour integrity, relocation value
  survival, alias-through-growth, `a[5]=9` → length 6, zero-filled gap,
  OOB/negative reads → 0, 1000-push interleaved stress (sum verified),
  in-capacity behaviour unregressed.
- All 17 linear suites (`tests/linear-*.test.ts`) — 136/136 pass.
