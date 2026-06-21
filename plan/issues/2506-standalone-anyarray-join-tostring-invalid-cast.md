---
id: 2506
title: "standalone: any[]/boxed-any element join() & toString() emit invalid Wasm (local.set $AnyString type mismatch)"
status: done
assignee: ttraenkler/sdev-arrayrep
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: arrays, array-methods, native-strings
goal: standalone-mode
related: [2074, 2105, 2106, 2505]
origin: "2026-06-19 sdev-arrayrep: array-rep scan after #2505 (new Array(N).sort) landed"
---

# #2506 — standalone `any[].join()` / `any[].toString()` invalid Wasm

## Problem (file-verified, current main, `--target standalone`)

```ts
const a: any[] = [1, 2, 3];
a.join(",");      // INVALID Wasm
a.toString();     // INVALID Wasm
```

```
local.set[0] expected type (ref null 6), found ref.as_non_null of type (ref extern)
```

`number[]`, `string[]`, and `new Array(N)` joins are all VALID — the defect is
specific to a **boxed-any (`externref`) element array** (`any[]`, mixed-type
literals like `[1, "x", true]`).

## Root cause

`compileArrayJoinNative` (`src/codegen/array-methods.ts`) builds the
element→string fold. Its non-numeric, non-boolean branch assumed the element is a
`$NativeString` ref and emitted `ref.as_non_null` to lift it to `(ref $AnyString)`.
But an `any[]` element array is `$__arr_externref` — each element is a raw
`externref` (a `__box_number` / `__box_boolean`-boxed value), NOT a NativeString.
`ref.as_non_null` of that externref then `local.set`s into the `(ref $AnyString)`
result local → validator type mismatch. Same #2505-class divergence (boxed-any
element rep), this time in the join fold rather than the sort stringify.

## Fix

In the join fold's element-stringify, add an `elemType.kind === "externref"` arm
that routes each boxed-any element through **`__extern_toString`** (externref →
externref native string) — the *same* runtime ToString that `String(x)` and
template literals (`` `${x}` ``) use for an `any` value — then `any.convert_extern`
+ `ref.cast $AnyString` for the concat fold. `__extern_toString` is resolved via
`ensureLateImport` and the late-import shift flushed up front so the baked call
funcIdx is stable.

**Not `__any_to_string`** (the `$AnyValue`-tag dispatcher): an `any[]` element is
a `__box_number`/`__box_boolean` externref, not a `$AnyValue` struct, so that path
mis-stringifies it to `"[object Object]"`. (A first attempt used `__any_to_string`
and produced VALID-but-WRONG output — `[1,2,3].join(",")` → `"[object Object],…"`;
verified the externref path round-trips the value: `String(a[0])`/`` `${a[0]}` ``
both already route through `__extern_toString` and give "1".)

## Acceptance criteria

1. `any[] [1,2,3].join(",")` → VALID standalone Wasm AND correct content "1,2,3".
2. `any[].toString()`, mixed `[1,"x",true].join("-")` ("1-x-true"), boolean/string
   any[] elements, empty any[] all valid + correct.
3. No regression: `number[]`, `string[]`, typed `boolean[]` joins unchanged.

## Resolution (sdev-arrayrep, 2026-06-19)

Single-arm fix in `compileArrayJoinNative` per above. `tests/issue-2505-anyarray-join.test.ts`
(9 tests) asserts content via `.length`/`.charCodeAt` (no native-string decode
needed). #2074/#2502/#1993/#2106 suites green; tsc clean.
