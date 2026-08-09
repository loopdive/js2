---
id: 3579
title: "default lane: Array.prototype.sort() on an any/union-element array no-ops (host ToString sort unregistered)"
status: done
completed: 2026-07-24
assignee: ttraenkler/dev-opus-search
created: 2026-07-24
updated: 2026-07-24
priority: medium
feasibility: medium
task_type: bug
area: codegen
es_edition: es5
language_feature: array-methods
goal: builtin-methods
umbrella: 3185
related: [3185, 3201, 2502, 3251]
# (#3102 LOC ratchet) The host ToString-sort fix adds the boxed-any stringify
# arm to compileArrayDefaultToStringSort (array-methods.ts, +38) and the any/
# union sort-import registration to the import-collector (+18) — both behavioral
# arms in existing god-files, not a new subsystem. Grant this change-set the
# allowance. NOTE: block list — the gate's parseFrontmatterList does not read a
# multi-line flow array.
loc-budget-allow:
  - src/codegen/array-methods.ts
  - src/codegen/declarations/import-collector.ts
# (#3400 R-FUNC per-function ceiling) The any/union sort-import arm adds two
# branches to the import-collector's dispatch visitor. Grant the function.
func-budget-allow:
  - src/codegen/declarations/import-collector.ts::unifiedVisitNode
# (#2108 coercion-site drift) The host boxed-any sort stringify REUSES the
# existing `__extern_toString` runtime ToString (the same primitive emitToString
# wraps) — +1 hand-rolled coercion vocabulary in array-methods.ts, intentional
# (calling the coercion-engine wrapper needs a ts.Type the oracle can't vend;
# direct primitive reuse is the ratchet-clean path). Grant the file.
coercion-sites-allow:
  - src/codegen/array-methods.ts
origin: "2026-07-24 #3201 measurement — contained default-sort slice split out of #3201"
---

# #3579 — default `sort()` on an `any`/union-element array silently no-op'd

Contained slice split out of **#3201**. The default (no-comparator)
`Array.prototype.sort()` on an **untyped / `any[]` / mixed-union** array
compiled to a **no-op** (elements never reordered): `[10, 9, 1].sort()` on an
untyped array returned `[10, 9, 1]` instead of the §23.1.3.30 ToString order
`[1, 10, 9]`.

## Root cause (host lane)

Two-part gap:

1. **`compileArrayDefaultToStringSort` never ran** — its `string_compare` host
   import was resolved via `ctx.funcMap.get("string_compare")`, which is only
   populated by the **import-collector pre-pass** for `number`/`boolean`/
   `string` element `.sort()` (import-collector.ts). For an `any`/union element
   the collector registered nothing → `compareIdx === undefined` → the helper
   returned `null` → the caller no-op'd the sort (the #2502 externref-safety
   no-op).
2. **`stringifyTail` assumed a real string** — even had the compare been
   registered, the host non-numeric branch emitted only `ref.as_non_null`, i.e.
   it fed the RAW boxed element to `string_compare`, which cannot order boxed
   numbers/undefined.

## Fix (host lane only; standalone/native keeps its externref-bail no-op)

- **import-collector.ts** — pre-register `string_compare` for a no-comparator
  `.sort()` whose element type is `any`/`unknown`/union (the externref-boxing
  cases). Gated by the existing `!ctx.nativeStrings` guard on the actual
  `addImport`, and `compileArrayDefaultToStringSort` gates on the real
  `externref` ValType, so a union that lowers to a ref simply no-ops (inert).
- **array-methods.ts `compileArrayDefaultToStringSort`** — reuse the existing
  runtime import `__extern_toString` (already used in this file for
  `compileArrayJoinExtern`; the same primitive `emitToString`'s dynamic branch
  wraps — needs **no `ts.Type`/checker query**, so it's oracle-ratchet-clean and
  does not touch sdev-1917's #1917 coercion tree) to ToString each boxed element
  before `string_compare`. The RAW (nullable) externref is passed straight to
  `__extern_toString` (which handles `null`→"null") — a `new Array(N)` all-holes
  array must NOT be `ref.as_non_null`'d (that traps the null holes — the #2502
  regression the guard test caught). A safety bail returns `null` (no-op) for a
  host ref/ref_null (struct) element that cannot flow into
  `string_compare(externref, externref)`.

## Measured (default gc lane, fork-per-file)

**Permanent conformance repro (#2093):**
`test262/test/built-ins/Array/prototype/sort/S15.4.4.11_A2.1_T3.js` (the flipped
file) + the regression guard `tests/issue-2502-sort-externref.test.ts`.

- `built-ins/Array/prototype/sort`: **47→48… (dir 8→9 pass), +1 genuine flip
  `S15.4.4.11_A2.1_T3` (mixed `[-1, obj, 1, "X", …]` ToString sort), 0
  regressions.** (Other A2.* are comparator-path sorts — `.sort(cmp)` via
  `tryCompileComparatorSort`, not this default path; A1.1/A1.2 are the
  hole-read substrate #3251/#2001; A1.4 needs the undefined-read substrate — all
  out of scope here per measurement, not the ~4 I first extrapolated.)
- Broader latent value: **every** untyped-array `.sort()` now orders instead of
  silently no-op'ing (a real correctness fix beyond the single test262 flip).

## Guard

- Full sort test262 dir: +1 / 0 regressions.
- `issue-2502-sort-externref` 8/8 (the all-holes `new Array(N).sort()` trap
  regression was caught and fixed here), `issue-2379-standalone-sort-rep`,
  `issue-3201-sort-includes`, `issue-1589-tosorted-hang`: 28/28.
- array-methods / array-prototype-methods / functional-array-methods: 59/59.
- The 14 array-capacity/fast-arrays/arrays-enums fails are **pre-existing on
  origin/main** (verified with the change reverted), unrelated.
- tsc clean.

## Standalone note (dual-mode)

`__extern_toString` is an existing HOST import (zero new imports). Standalone/
native mode keeps its pre-existing externref-bail no-op for `any`-element sorts
— a pre-existing gap tracked under the value-rep substrate (#3251/#2379), NOT a
regression introduced here.
