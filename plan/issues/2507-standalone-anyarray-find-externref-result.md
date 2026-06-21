---
id: 2507
title: "standalone: any[].find()/findLast() emit invalid Wasm (externref element stored into f64 result slot)"
status: done
assignee: ttraenkler/sdev-arrayrep
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: arrays, array-methods
goal: standalone-mode
related: [2505, 2506, 2106]
origin: "2026-06-19 sdev-arrayrep: array-rep scan after #2505/#2506"
---

# #2507 — standalone `any[].find()` / `findLast()` invalid Wasm

## Problem (file-verified, current main, `--target standalone`)

```ts
const a: any[] = [1, 2, 3];
a.find((x: any) => (x as number) > 1);  // INVALID Wasm
```

```
local.set[0] expected type f64, found local.get of type externref
```

`findIndex` / `findLastIndex` are VALID (they return an index, not the element);
`number[].find` is VALID. The defect is specific to a **boxed-any (`externref`)
element array** (`any[]`, `new Array(N)`) under `find` / `findLast`.

## Root cause

`compileArrayFind` / `compileArrayFindLast` (`src/codegen/array-methods.ts`)
return the matched **element**. In non-fast (standalone) mode the result local
was hard-typed `{ kind: "f64" }` with a NaN "not found" sentinel — fine for a
numeric element array, but for an `any[]` the element loaded by `array.get` is an
`externref`, so `local.set`ting it into the f64 result local fails validation.
The found-branch only converts `i32 → f64`, never handles an `externref` element.
Same boxed-any element-rep family as #2505 (sort) / #2506 (join), here in the
find result slot.

## Fix

In both `compileArrayFind` and `compileArrayFindLast`: when `elemType.kind ===
"externref"`, keep the result type `externref` and use `ref.null.extern` (the
`undefined` value) as the "not found" sentinel — which is the correct spec result
(`Array.prototype.find` returns `undefined` when nothing matches). Numeric /
boolean / string-ref element finds are unchanged (still f64 with NaN sentinel in
non-fast mode, elemType in fast mode).

## Acceptance criteria

1. `any[].find(cb)` returns the matched element value; VALID standalone Wasm.
2. `any[].find` with no match returns `undefined`; `any[].findLast(cb)` returns
   the last match; string-element any[] find works.
3. No regression: `number[].find`/`findLast`, `findIndex`/`findLastIndex`.

## Resolution (sdev-arrayrep, 2026-06-19)

Two-site fix per above. `tests/issue-2507-anyarray-find.test.ts` (7) verifies
any[] find/findLast element return + undefined-on-no-match + string-element;
number[] find/findLast + findIndex regressions green. `tsc` clean. (The
`functional-array-methods.test.ts` harness failures are the pre-existing
`__unbox_number` LinkError, task #67 — confirmed unrelated by stashing the fix.)
