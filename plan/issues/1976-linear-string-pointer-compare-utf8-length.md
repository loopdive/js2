---
id: 1976
title: "linear backend: string relationals compare memory addresses; .length returns UTF-8 byte count; string concat in compound-assign emits invalid module"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: string-methods
goal: core-semantics
related: [1588, 1975]
origin: "2026-06-10 deep-audit sweep (optimizer agent): verified on main, target linear"
---

# #1976 — linear strings: pointer ordering, byte lengths, type confusion

## Problem (verified, `target: "linear"`)

| probe | linear | node |
|-------|--------|------|
| `"zzz" < "aaa" ? 1 : 0` | `1` (address order) | `0` |
| `"b" < "abc" ? 1 : 0` | `1` | `0` |
| `"é世😀".length` | `9` (UTF-8 bytes) | `4` (UTF-16 units) |

Also loud (not silent): `let s = ""; s += "ab"` and `const a = "ab" + "c"`
compile `success: true` but fail validation (`F64Add left value type
mismatch` / `set_local I32 expected F64`) — concat result (i32 ptr) typed f64
in compound-assign/declaration paths.

GC backend correct on all.

## Root cause

1. `src/codegen-linear/index.ts:1901-1918` special-cases string
   `===`/`!==`/`+` (via `__str_eq`/`__str_concat`) but `<`/`<=`/`>`/`>=` fall
   through to the `bothI32` pointer-comparison path at 1955-1980 (`i32.lt_s`
   on pointers).
2. Linear strings are stored as UTF-8 bytes (`__str_from_data`,
   codegen-linear/runtime.ts:738ff) and `.length` lowers to `__str_len` = byte
   count; JS `.length` is UTF-16 code units.
3. Compound-assign/decl type tracking marks the concat result f64.

## Fix direction

(1) Add a `__str_cmp` lexicographic (UTF-16 order) runtime fn and route string
relationals before the bothI32 branch. (2) Either store strings as WTF-16
(matching the GC nativeStrings i16 layout) or have `__str_len` count code
units; audit charCodeAt-family on the same decision. (3) Fix the i32/f64 type
tracking for concat results in compound assignment and declarations.

## Acceptance criteria

- All three silent repros match Node in linear mode
- `s += "ab"` / `"ab" + "c"` produce valid modules
- ASCII-only fast paths may remain byte-based if behaviorally identical

## Dupe check

#1588 tracks UTF-8/WTF-16 strategy for the **GC** backend's dual storage; no
issue on linear string compare/length. Unfiled.
