---
id: 2649
title: "Standalone: TypedArray.prototype.subarray returns an empty view (.length === 0)"
status: done
completed: 2026-07-17
assignee: ttraenkler/dev-standalone2
sprint: current
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: typedarray
language_feature: typedarray-methods
goal: standalone-mode
related: [2648, 1907]
loc-budget-allow:
  # Intended +19 LOC: read `.length` field 0 directly off a subview receiver's
  # own type instead of ref.test-ing the mismatched vec type (which returned 0).
  - src/codegen/property-access-dispatch.ts
---

## Resolution (2026-07-17)

Fixed in `src/codegen/property-access-dispatch.ts` (the `.length` dispatch).

Root cause: `ta.subarray(...)` returns a `$__subview_<elem>` struct (a window
sharing the parent's backing array). Its element data is reachable, but the
`.length` read is TS-typed as the TypedArray, so the length dispatch
`ref.test`-ed the receiver against the concrete `$__vec_<elem>` type. A subview
is a **sibling** subtype of `$__vec_base` (not the vec), so the `ref.test` FAILS
and the arm fell back to `f64.const 0`.

Fix: when the compiled receiver's OWN static wasm type is a length-prefixed
`{length, data}` struct (the subview), read field 0 **directly** from that type
instead of `ref.test`-ing the mismatched vec type. Correct and cheaper.

Guarded by `tests/issue-2649.test.ts` (13 cases): begin/end/no-arg/negative/empty
windows, packed (Int8/Uint16) and 32-bit/float (Int32/Float64) views, nested
subarray, combined length+element read, a plain typed-array `.length` regression
guard, and a gc-host parity case. No host-lane behavior change (host `subarray`
uses copy/slice semantics — `.length` was never broken there).

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
