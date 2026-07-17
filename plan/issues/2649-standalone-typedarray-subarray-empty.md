---
id: 2649
title: "Standalone: TypedArray.prototype.subarray returns an empty view (.length === 0)"
status: done
assignee: ttraenkler/dev-spec
completed: 2026-07-17
sprint: current
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: typedarray
language_feature: typedarray-methods
goal: standalone-mode
related: [2648, 1907]
# Bug fix: a length-bearing-struct direct-read arm in the length member dispatch
# (subview .length was mis-routed to the vec ref.test fallback → 0). The fix lives
# in the dispatch file that already owns the .length member lowering.
loc-budget-allow:
  - src/codegen/property-access-dispatch.ts
---

# #2649 — Standalone TypedArray.prototype.subarray returns an empty view

## Problem

In `--target standalone`, `TypedArray.prototype.subarray(begin?, end?)` returns a
view whose **`.length` reads as 0** regardless of `begin`/`end` — even for the
no-arg / full-range form. The element data itself is reachable (indexed access on
the result returns the right values), so the bug is specifically in the
**length field** of the returned subarray view, not its backing data.

### Verified repros (host pass / standalone wrong-value, main `06e1e04d68`)

| call (`a = new Int8Array([10,11,12,13])`) | host | standalone |
|---|---|---|
| `a.subarray(1).length` | `3` | **`0`** |
| `a.subarray(0,2).length` | `2` | **`0`** |
| `a.subarray().length` | `4` | **`0`** |
| `a.subarray(1)[0]` | `11` | `11` (data OK) |

So `subarray()` builds the result view but its length field is left at 0.

## Root cause (to confirm)

`compileTypedArraySubarray` (`src/codegen/array-methods.ts`, ~line 3145 dispatch)
appears to construct the result vec/view struct with a zero (or unset) length
field instead of `clamp(end) − clamp(begin)`. Verify whether it shares a backing
array with a separate length, and whether the length write is missing or
mis-clamped. (Bug is value-correctness, not a trap or CE.)

## Notes on test262-row yield

Most `built-ins/TypedArray/prototype/subarray` test262 rows additionally go
through the `testWithTypedArrayConstructors` harness (constructor-as-value →
#1907/#1888 S6-b substrate), so the direct row flip may be limited; the value is
standalone correctness for direct `ta.subarray(...)` call sites. Surfaced while
surveying for the #2648 fix.

## Suggested validation
- New `tests/issue-2649-*`: `subarray(b)`, `subarray(b,e)`, `subarray()`,
  negative begin/end, across packed (Int8/Uint16) and 32-bit (Int32/Float64)
  views × standalone + gc; assert `.length` and element values; gc-mode guard.

## Resolution (2026-07-17)

Root cause was NOT in `compileTypedArraySubarray` — the `$__subview` struct's
length field is built correctly (`max(clamp(end) − clamp(begin), 0)`). The bug
was in the **`.length` member read on the DIRECT chain** `a.subarray(1).length`
(`src/codegen/property-access-dispatch.ts`, the `propName === "length"` block):

- `a.subarray(1)` compiles to a `$__subview_<elem>` struct (field 0 = `length`).
- `resolveWasmType(Int8Array)` gives the plain `$__vec_<elem>` type.
- Since compiled-type ≠ TS-derived vec type, the length dispatch `ref.test`ed
  the subview value against the **vec** type, missed, and fell to the
  `f64.const 0` else-arm → `.length === 0`.
- The via-variable form (`const s = a.subarray(1); s.length`) masked it because
  the local carried the subview type, so `.length` read field 0 directly.

**Fix**: when the compiled receiver is itself a length-bearing struct (field 0
named `length`, i.e. any `$__vec` / `$__subview` / `$__ta_view`), read `.length`
field 0 **directly** off the compiled type — exact, no `ref.test` needed.

### Test Results
`tests/issue-2649-standalone-subarray-length.test.ts` — 10/10 pass: direct-chain
`subarray(b)` / `subarray(b,e)` / `subarray()`, negative begin, element data
through the view, Int32 / Float64 views, nested subarray, via-variable regression
guard, gc-mode guard.
