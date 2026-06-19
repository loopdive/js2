---
id: 2074-residual
title: "standalone: Array.prototype.join()/toString() of an externref-element (any[]/empty/boxed-any) array emits invalid Wasm (folds #66 + #70)"
status: done
assignee: ttraenkler/sdev-protoglue
sprint: Backlog
created: 2026-06-19
updated: 2026-06-19
completed: 2026-06-19
priority: high
feasibility: medium
reasoning_effort: max
task_type: conformance
area: codegen
language_feature: builtins, arrays, strings
goal: standalone-mode
related: [2074, 2075, 2088, 2105, 2379, 1917, 1461]
origin: "2026-06-19 — sdev-arrayrep flagged #66/#70: standalone join of any[]/empty array emits invalid Wasm"
---

## Problem

In `--target standalone` (native strings), `Array.prototype.join()` /
`Array.prototype.toString()` over an **externref-element** vec — an untyped
`[]`, an `any[]`, a `(string|number)[]`, or an object array — emits an
**invalid Wasm module**:

```
local.set[0] expected type (ref null 6), found ref.as_non_null of type (ref extern)
```

This trips even for an **empty** such array (`[].join()`), because the element
conversion's static type must match the fold accumulator's `(ref null $AnyString)`
even when the loop body never executes. (`built-ins/Array/prototype/join/
S15.4.4.5_A1.1_T1` and friends.)

## Root cause

`compileArrayJoinNative` (`array-methods.ts`) classified the element three ways:
boolean → "true"/"false"; numeric → `number_toString`; **everything else** →
`ref.as_non_null`, assuming a `(ref null $NativeString)` string element. For an
**externref**-element array that assumption is wrong: `ref.as_non_null` of the
externref yields a `(ref extern)`, which mistypes into the
`resultTmp: (ref null $AnyString)` accumulator → invalid module.

## Fix (additive — one new element-conversion arm)

Add an `else if (elemType.kind === "externref")` arm that stringifies each
element through the native `__extern_toString` (§7.1.17, registered by
`ensureObjectRuntime`) — the **same** ToString that `String(x)` / `x + ""` use —
then converts its externref result up to `(ref $AnyString)`:

```ts
ensureObjectRuntime(ctx);
const externToStrIdx = ctx.funcMap.get("__extern_toString");
elemToStr.push({ op: "call", funcIdx: externToStrIdx });   // externref -> externref
elemToStr.push({ op: "any.convert_extern" });
elemToStr.push({ op: "ref.cast", typeIdx: anyStrTypeIdx }); // -> (ref $AnyString)
```

**Why `__extern_toString`, not `__any_to_string`:** the boxed-number element a
`new Array(N)`/`any[]` array stores (`$__box_number_struct` boxed as externref,
#2379) is NOT recovered by the `$AnyValue` tag-dispatcher `__any_to_string` on
the join-fed value — it falls through to `"[object Object]"`. `__extern_toString`
is the canonical native ToString (traced from the working `String(a[0])` path)
and recovers the boxed-number to its numeric text. This is what makes the
numeric-`any[]` arm of #70 come out CORRECT, not just valid.

Array.prototype.toString delegates to join through the same `emitStringJoinFold`,
so it inherits the fix.

## Measured (upstream/main @ ed8c4f6e6, --target standalone)

- empty `any[]` / `[]` `.join()` → VALID, returns "" (was invalid module).
- `any[] = [1,2,3]` `.join(",")` → **"1,2,3"** (len 5, first char '1') — was an
  invalid module pre-fix; the intermediate `__any_to_string` attempt gave
  "[object Object]". Correct now.
- `any[] = ["x","y"]` `.join(",")` → "x,y" (correct).
- `any[] = [1,2,3]` `.toString()` → "1,2,3" (delegates to join).
- All 33 pre-existing join tests (`#2074`/`#2088`/`#2105`) pass — **0 regressions**.
- `built-ins/Array/prototype/join` dir: `S15.4.4.5_A1.1_T1` (empty `new Array()`)
  flips valid. `A2_T3` (string-global sentinel, #51-family), `A3.2_T1` (array
  bounds), `A4_T3`/`A5_T1` (array-like-OBJECT `obj.join = Array.prototype.join`
  receiver — separate #1461/#54 lane) remain invalid; all were invalid on the
  baseline too (no regression).

## Out of scope (separate bugs, not this lane)

- **`new Array()` (empty, no args) construction** under standalone is itself
  invalid (`call expected i32, found array.get externref`) — a `new Array()`
  ctor lane bug (#2379 area), independent of join; excluded from the test set.
- **Array-like-object join** (`obj.join = Array.prototype.join`) — the
  `compileArrayJoinExtern` / array-like receiver lane (#1461-family, #54).

## Test

`tests/issue-2074.test.ts` — new describe block "externref-element (any[] /
empty / boxed-any) join is valid + correct": empty `any[]` join, `any[]`
numeric join value+first-char, `any[]` string join, empty + explicit separator,
and the toString-delegates-to-join cases. All green.

Folds in **#66** (join invalid Wasm) and **#70** (any[]/boxed-any join &
toString correctness).
