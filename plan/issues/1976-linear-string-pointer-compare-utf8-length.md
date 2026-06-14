---
id: 1976
title: "linear backend: string relationals compare memory addresses; .length returns UTF-8 byte count; string concat in compound-assign emits invalid module"
status: ready
sprint: 62
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

## Progress (2026-06-12) — relationals + concat-typing fixed; UTF-8 length follow-up

**Done (this PR):**

1. **String relationals** (`<`/`<=`/`>`/`>=`) now compare by content. Added a
   `__str_cmp` runtime fn (lexicographic byte compare → -1/0/1) and route string
   relationals through it before the `bothI32` pointer-comparison path. For
   ASCII this matches JS UTF-16 ordering. (Multi-byte UTF-8 orders by byte, which
   can differ for astral code points — folded into the length follow-up below.)
2. **Concat type confusion → invalid module** fixed. `s += t` for a string `s`
   now calls `__str_concat` and stores the i32 result (was `f64.add` → i32/f64
   mismatch); `inferExprType` treats a string `a + b` as an i32 result so
   `const x = "a" + b` declares an i32 local. Both compound-assign and
   declaration paths produce valid modules now.

Repro rows 1–2 (relationals) match Node; both invalid-module cases are gone.
`tests/issue-1976.test.ts` (15 cases) + all 136 existing linear tests green.

**Remaining (separate follow-up):** `.length` still returns the UTF-8 **byte**
count, not UTF-16 code units (`"é世😀".length` → 9, Node → 4). Fixing this needs
either WTF-16 storage (matching the GC nativeStrings i16 layout) or a code-unit
count in `__str_len`, plus an audit of `charCodeAt`/`codePointAt`/slice on the
same decision — a substantial string-subsystem change, larger than the compare
+ concat fixes here. ASCII lengths are correct. (Related to #1588's GC-side
UTF-8/WTF-16 work.)

### Files

- `src/codegen-linear/runtime.ts` — new `__str_cmp` helper
- `src/codegen-linear/index.ts` — route string relationals through `__str_cmp`;
  string `+=` via `__str_concat`; `inferExprType` string-concat → i32
