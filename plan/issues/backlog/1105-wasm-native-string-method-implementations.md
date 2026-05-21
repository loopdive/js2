---
id: 1105
title: "Wasm-native String method implementations for standalone mode"
status: ready
created: 2026-04-12
updated: 2026-04-12
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
language_feature: string-methods
goal: standalone-mode
es_edition: multi
---
# #1105 — Wasm-native String method implementations for standalone mode

## Problem

The `--nativeStrings` flag stores strings as WasmGC i16 arrays instead of wasm:js-string, but string *methods* (split, replace, match, indexOf, slice, trim, etc.) are still delegated to the JS host via `string_*` host imports in runtime.ts. In standalone mode, these methods are unavailable.

## Current state

- **Storage**: nativeStrings uses `(array i16)` — UTF-16 code units, matching JS string semantics
- **Host imports**: runtime.ts exports `string_split`, `string_replace`, `string_match`, `string_indexOf`, `string_slice`, `string_trim`, `string_startsWith`, `string_endsWith`, `string_includes`, `string_charAt`, `string_charCodeAt`, `string_substring`, `string_toLowerCase`, `string_toUpperCase`, `string_padStart`, `string_padEnd`, `string_repeat`, `string_search`, `string_localeCompare`, and more
- **Standalone gap**: none of these work without a JS host

## Approach

Implement string methods as Wasm functions operating on `(array i16)`:

### Tier 1 — Pure array operations (no RegExp dependency)
These can be implemented purely in terms of i16 array operations:
- `charAt`, `charCodeAt`, `codePointAt`
- `indexOf`, `lastIndexOf`, `includes`, `startsWith`, `endsWith`
- `slice`, `substring`
- `trim`, `trimStart`, `trimEnd`
- `padStart`, `padEnd`
- `repeat`
- `concat`
- `toUpperCase`, `toLowerCase` (need Unicode case mapping tables)
- `split` (string separator only, not RegExp)
- `at`

### Tier 2 — RegExp-dependent (depends on #682)
These need a standalone RegExp engine:
- `match`, `matchAll`
- `replace`, `replaceAll` (with RegExp pattern)
- `search`
- `split` (with RegExp separator)

### Tier 3 — Locale-dependent
- `localeCompare`, `toLocaleLowerCase`, `toLocaleUpperCase`
- These may need ICU data or simplified locale handling

## Acceptance criteria

- [ ] Tier 1 methods implemented as Wasm functions on i16 arrays
- [ ] `"hello".indexOf("ll")` returns `2` in standalone mode
- [ ] `"hello world".split(" ")` returns `["hello", "world"]` in standalone mode
- [ ] `"  hello  ".trim()` returns `"hello"` in standalone mode
- [ ] test262 String.prototype tests pass for Tier 1 methods (target: ≥70%)

## Complexity

L — many methods, each relatively straightforward but collectively substantial

## Related

- #682 RegExp standalone engine (Tier 2 depends on this)
- #809 Extract native string helpers → native-strings.ts (codegen refactor)
- nativeStrings flag in CLAUDE.md

## Implementation Plan

(Author: architect, 2026-05-21. Mechanical work — one wasm function
per method, tested individually. Implementation plan focuses on
infrastructure and the first three methods as exemplars.)

### Entry point

`src/codegen/native-strings.ts` (existing). Add per-method emitter
functions invoked from `compileMemberCall` in
`src/codegen/expressions.ts` when:
1. `ctx.nativeStrings || ctx.wasi` is true.
2. Receiver static type is `string`.
3. Method name is in the Tier-1 list.

### Algorithm — example: `indexOf(needle, fromIndex?)`

```wat
(func $__nstr_indexOf
  (param $hay (ref $StringArr))
  (param $needle (ref $StringArr))
  (param $from i32)
  (result i32)
  ;; clamp $from to [0, hay.length]
  ;; for i from $from to hay.length - needle.length:
  ;;   for j from 0 to needle.length - 1:
  ;;     if hay[i+j] != needle[j]: break inner
  ;;   if inner completed: return i
  ;; return -1
  ...)
```

Use existing `array.len`, `array.get_u $StringArr` instructions.

### Example — `trim()`

```wat
(func $__nstr_trim (param $s (ref $StringArr)) (result (ref $StringArr))
  ;; scan from 0 forward while array.get_u $s i ∈ whitespace
  ;; scan from len-1 backward
  ;; array.new_default $StringArr (end - start)
  ;; array.copy
  )
```

Whitespace set per ES2024 §22.1.3.32 — `\t\n\v\f\r   
 -     　﻿`. Encode as a
sorted i32 array constant; use binary search.

### Method coverage — Tier 1 (all in scope for this issue)

| Method | LOC est | Special notes |
|--------|---------|---------------|
| charAt, charCodeAt, codePointAt | 30 | bounds-check returns NaN |
| at | 20 | negative index |
| indexOf, lastIndexOf, includes | 40 each | naive O(nm); Boyer-Moore later |
| startsWith, endsWith | 25 each | |
| slice, substring | 40 each | substring has min/max swap |
| trim, trimStart, trimEnd | 30 each | whitespace constant table |
| padStart, padEnd | 35 each | pad-string repeat handling |
| repeat | 25 | overflow check; throws RangeError if > 2^28 |
| concat | 30 | accepts varargs; length sum |
| split (string sep) | 50 | empty-sep → codepoint split |
| toUpperCase, toLowerCase | 60 + table | Unicode case mapping |

### Unicode case mapping

`toUpperCase`/`toLowerCase` need a Unicode case-folding table. Use
the simple casing rules (§22.1.3.30/31) — a few hundred entries.
Embed as `(data $caseTable ...)` or `(global $caseTable (ref $i32arr))`
loaded from a precomputed constant.

### Edge cases

- **Surrogate pairs** — methods operate on UTF-16 code units, not
  code points. Test282 expects this.
- **Negative indices** — `slice(-3)` → length + (-3). Handle.
- **`undefined` / `null` args** — `indexOf(undefined)` is
  `indexOf("undefined")`. Coerce arg via ToString first.
- **Empty strings** — `"".split("")` → `[]`; `"abc".split("")` →
  `["a","b","c"]`. Both handled.
- **fromIndex larger than length** — `indexOf(needle, 100)` on a
  10-char string → -1.
- **Locale-dependent uppercase** (e.g. Turkish dotted i) — defer to
  Tier 3.
- **`String.prototype.normalize`** — out of scope; would need full
  Unicode normalization tables.

### Test262 paths

- `test/built-ins/String/prototype/<method>/*` — one folder per
  method.

Acceptance: Tier 1 ≥70% pass rate.

### Dependencies

- **#809** — native-strings.ts refactor must land first (codegen
  helper extraction). If not landed, do it as part of this issue's
  Phase 0.
- **#682** RegExp engine → blocks Tier 2.
- **#1535** native bigint → unrelated.

### Risks

- **Binary size**: each method adds 30-80 wasm instructions plus
  case tables. Estimated +15-25KB to standalone module.
- **Performance**: naive O(nm) indexOf is OK for small strings; if
  benchmarks show pain, upgrade to Boyer-Moore in Phase 2.
- **Spec edge cases**: ToString coercion on arg objects (e.g. arg
  with `Symbol.toPrimitive`) needs #1525 — for now, fail with
  TypeError when arg is a wasmgc object.
