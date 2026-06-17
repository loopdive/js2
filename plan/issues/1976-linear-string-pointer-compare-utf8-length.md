---
id: 1976
title: "linear backend: string relationals compare memory addresses; .length returns UTF-8 byte count; string concat in compound-assign emits invalid module"
status: done
sprint: 63
created: 2026-06-10
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/tld-1921
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

## Resolution (2026-06-16) — UTF-16 `.length` (repro row 3) closed

The remaining `.length` divergence is now fixed **without** an invasive storage
migration. Rather than count code units inside `__str_len` (which slice/indexOf
rely on as a *byte* offset), a dedicated runtime fn was added and only the
user-facing `.length` property routed through it:

- **`src/codegen-linear/runtime.ts`** — new `__str_length_utf16(ptr) -> i32`.
  Walks the stored UTF-8 bytes and counts UTF-16 code units from each leading
  byte's high bits: `0xxxxxxx`/`110xxxxx`/`1110xxxx` → a BMP code point (1 unit,
  advance 1/2/3 bytes), `11110xxx` → an astral code point (2 units / surrogate
  pair, advance 4 bytes). ASCII counts == byte length (unchanged). `__str_len`
  (byte count) is left untouched as the internal primitive.
- **`src/codegen-linear/index.ts`** — the `string.length` property lowering now
  calls `__str_length_utf16` instead of `__str_len`. The `slice(start)`
  `end = str.length` byte fallback still uses `__str_len` (byte offset) — that
  is correct, since `__str_slice` indexes by byte.

Repro table now fully matches Node: `"é".length` → 1, `"é世😀".length` → 4,
`"😀😀".length` → 4 (were 2 / 9 / 8).

**Still residual (genuinely larger, out of scope here):** `slice` / `charCodeAt`
/ `codePointAt` / indexing operate on **byte** offsets, so for *multi-byte*
strings they don't yet match UTF-16 code-unit semantics. That is the full
storage/offset audit the Progress note above describes (WTF-16 storage vs.
code-unit-offset translation), tied to #1588's GC-side UTF-8/WTF-16 decision.
This PR closes all three stated acceptance-criteria repros (criterion 3 blesses
ASCII byte fast paths) and leaves the broader offset unification to that
follow-up.

### Test Results

- `tests/issue-1976.test.ts` — 23/23 pass (the 15 prior cases + 8 new UTF-16
  `.length` cases covering ASCII / Latin-1 / BMP / astral / mixed, plus
  length-after-concat of a multi-byte string).
- All linear-backend suites green after the change: `linear-string` +
  `linear-{basic,advanced,array,runtime,integration,classes,collections,
  controlflow,functions,map,set,bitwise,break-continue,element-assign,u8array,
  ir}` = 136 tests, no regressions.
- `npm run typecheck` + `npm run lint` (Biome) clean.

### Files (this PR)

- `src/codegen-linear/runtime.ts` — new `__str_length_utf16` helper
- `src/codegen-linear/index.ts` — route `string.length` through it
- `tests/issue-1976.test.ts` — UTF-16 `.length` cases
