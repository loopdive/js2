---
id: 2190c
title: "standalone: heterogeneous inner tuple of any[] drops off-kind element ([[\"a\",7]] / [[7,\"ab\"]] traps on read-back)"
status: done
assignee: ttraenkler/sdev-arrayrep
created: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen
goal: standalone-conformance
sprint: 63
depends_on: [2190]
---

## Problem

In standalone (`--target standalone`) an `any[]` whose elements are
HETEROGENEOUS inner tuples traps when the off-kind element is read back:

```ts
const e: any[] = [["a", 7]];   e[0][1]; // trap (number dropped → null $AnyString)
const e: any[] = [[7, "ab"]];  e[0][1]; // trap (string dropped → NaN f64)
```

Distinct from #88 (homogeneous-string sub-array READ, the `__extern_get_idx`
arm) and from #2511 (the wasi/native-strings WRITE widening, which is NOT on
upstream/main yet and was gated to string-FIRST literals only).

## Root cause (WAT-pinned)

`compileArrayLiteral` (`src/codegen/literals.ts`) infers the inner vec element
type from the FIRST element:
- `["a", 7]` → element 0 is a string → `$AnyString[]` vec; the number `7` then
  can't be stored, so codegen emits `f64.const 7; drop; ref.null $AnyString;
  ref.as_non_null` — a null in slot 1.
- `[7, "ab"]` → element 0 is a number → `f64[]` vec; the string is
  `extern.convert_any`'d + `__unbox_number`'d to NaN — slot 1 reads back NaN.

Either way the off-kind element is lost at CONSTRUCTION, and the later
`e[0][i]` read traps (null-deref) or returns a wrong-kind value.

The existing widenings missed both: `hasObjectElem` (numeric-first) deliberately
EXCLUDES string elements; the #2511 string-first widening isn't on main and only
covered the string-first ordering.

## Fix

Two mirror widenings in `compileArrayLiteral`, both gated on `ctx.nativeStrings`
(true under standalone + WASI):

1. **string-first** (`["a", 7]`): if the heuristic picked `$AnyString`/
   `$NativeString` and any element is NOT a native string, widen the vec to
   `externref` (this is the #2511 widening, now also landing here).
2. **number-first** (`[7, "ab"]`): in the `hasObjectElem` arm, additionally
   detect a native-string element — but ONLY when the literal's contextual type
   is `any` (the inner tuple of an `any[]` is contextually `any` directly; a
   top-level `const a: any[]` is contextually `Array<any>` — accept both). A
   genuine `(number|string)[]` union or `number[]` literal is untouched (its
   contextual element type is not `any`), preserving the #1021/#786 first-element
   fast path and the historical `[0, "last"]` behaviour.

Widening to externref boxes each element by its own static type
(`__box_number`/`__box_boolean`/native-string) at construction, so every element
survives and reads back correctly.

## Measured (standalone, valid Wasm, 0 env imports)

| case | before | after |
|---|---|---|
| `[["a", 7]]` `e[0][1]` | trap | 7 |
| `[["a", 7]]` `e[0][0].length` | trap | 1 |
| `[[7, "ab"]]` `e[0][1].length` | trap | 2 |
| `[[7, "ab"]]` `e[0][0]` | trap | 7 |
| `[["a", 9, "ccc"]]` `e[0][2].len + e[0][1]` | trap | 12 |
| `[[true, 7]]` `e[0][0]` boolean tag | (lost) | preserved |

Regression-clean: `number[]`/`number[][]`/`string[]`/flat `any[]`/`[0,"last"]`
unchanged; #88 homogeneous cases (same function) unchanged. `tests/issue-2190`
(+8 #2190b cases, 20 total) green; #2162b/#2036/#2014/#2505/#786 green; tsc +
coercion-sites gate clean.

Out of scope: the `(number|string)[]` *union*-typed literal `[0, "last"]` still
traps on `(a[1] as string)` — a DISTINCT union-representation problem (not an
`any` context; broken on main too).

## Note

This branch stacks on #88 (PR #1777) — both modify nearby `literals.ts` /
`object-runtime.ts` regions. Once #1777 lands, this PR's net diff is the
`literals.ts` widening + the #2190b test block.
