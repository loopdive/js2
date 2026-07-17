---
id: 2649
title: "Standalone: TypedArray.prototype.subarray returns an empty view (.length === 0)"
status: done
assignee: dev-refactor
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
---

# #2649 — Standalone TypedArray.prototype.subarray returns an empty view

## Problem

In `--target standalone`, `TypedArray.prototype.subarray(begin?, end?)` returns a
view whose **`.length` reads as 0** regardless of `begin`/`end` — even for the
no-arg / full-range form. The element data itself is reachable (indexed access on
the result returns the right values), so the bug is specifically in the
**length field** of the returned subarray view, not its backing data.

### Verified repros (host pass / standalone wrong-value, main `06e1e04d68`)

| call (`a = new Int8Array([10,11,12,13])`) | host | standalone     |
| ----------------------------------------- | ---- | -------------- |
| `a.subarray(1).length`                    | `3`  | **`0`**        |
| `a.subarray(0,2).length`                  | `2`  | **`0`**        |
| `a.subarray().length`                     | `4`  | **`0`**        |
| `a.subarray(1)[0]`                        | `11` | `11` (data OK) |

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

Root cause was NOT in `compileTypedArraySubarray` (it builds the `$__subview`
struct with the correct windowed `length` at field 0). The bug was in the
**`.length` read dispatch** (`src/codegen/property-access-dispatch.ts`): for a
receiver whose compiled ref type differs from its static TS-derived vec type, it
`ref.test`ed the value against the static plain-`$__vec` type and fell back to
`0` on a miss. `a.subarray(1)` is TS-typed `Int8Array` (→ plain `$__vec`) but
compiles to a `$__subview` struct, so the test always missed → `.length` == 0.

Fix: when the compiled receiver is a known `$__subview` ref type
(`isSubviewTypeIdx`), read its field-0 length directly — no `ref.test` against
the mismatched static type. `$__ta_view` is intentionally excluded (its field-0
can be a resizable-length sentinel, handled by the auto-length arm).

Standalone-only (gc/host `subarray` returns a plain-vec copy whose length
already read correctly). Coverage: `tests/issue-2649.test.ts` (10 cases —
begin/begin+end/no-arg, negative begin/end, stored-in-local, nested subarray,
16-bit element view, element-access regression guard, and a length-driven sum
loop). tsc + prettier clean; `tests/issue-1664.test.ts` (subarray/set) still 7/7.
