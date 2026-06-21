---
id: 1350
title: "spec gap: ArrayBuffer resizable + TypedArray detached-buffer guards (100 + 39 test262 fails) — DUPLICATE of #1645"
status: blocked
created: 2026-05-08
updated: 2026-06-19
priority: medium
feasibility: hard
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: typedarray
goal: spec-completeness
sprint: Backlog
parent: 1328
duplicate_of: 1645
---
# #1350 — DUPLICATE of #1645 (ArrayBuffer.resize / detached-buffer guards)

> **Reconciliation 2026-05-28 (dev):** This issue and **#1645** (renumbered from
> #1351) carry **identical content** — same title, same problem statement, same
> acceptance criteria, same impl plan. #1645 received the architect-blocker
> investigation in PR #666 (commit 767abf435, merged 2026-05-27) and is the
> canonical tracking issue. All future work on resizable ArrayBuffer + detached
> guards goes through #1645.
>
> ### Why blocked (summary from #1645's investigation)
> - ArrayBuffer/DataView compile to a **fixed-length `i32_byte` WasmGC vec**
>   (`src/codegen/dataview-native.ts:22`). WasmGC arrays are fixed-length once
>   allocated, so `resize(newLen)` to a larger size is **structurally impossible**
>   without a representation change.
> - Architect must pick between **(a)** over-allocate to `maxByteLength` and
>   track logical length separately, or **(b)** an indirection struct
>   (`{ data: (mut ref vec), len: (mut i32), maxLen, detached }`) so resize swaps
>   in a freshly allocated, copied backing.
> - The issue's stated impl file `src/codegen/registry/typedarray.ts` **does not
>   exist** — the file reference in the legacy plan is stale.
>
> ### Separable follow-up (developer-scoped, not blocked)
> Adding an `IsDetachedBuffer` prologue to TypedArray prototype methods (mirroring
> the DataView guard at `src/runtime.ts:4609`) doesn't require the representation
> spec — the `_detachedBuffers` WeakSet + `__is_detached_buffer` infrastructure
> already exists. #1645's investigation notes this as a candidate sub-issue, but
> it has not been carved out yet. If it is carved, it should be a child of #1645,
> not #1350.
>
> See #1645 for the live tracking, sibling #1595 (transfer methods, also blocked
> on this representation choice), and #1515 (DataView detached / ToIndex —
> already shipped).

## Original content (preserved for history)

# #1350 — ArrayBuffer.resize / detached-buffer guards on TypedArray methods

## Problem

`built-ins/ArrayBuffer`: **87 / 196 pass (44.4%) — 100 fails (44 wasm_compile, 36 assertion_fail,
9 other, 5 null_deref, 1 type_error)**.
`built-ins/DataView`: **410 / 561 pass (73.1%) — 26 runtime_error among 112 fails**.
`built-ins/Uint8Array`: **31 / 68 pass (45.6%) — 37 fails**.

Spec §25.1 (ArrayBuffer): ArrayBuffer can be resizable (constructor accepts `{maxByteLength}`) or
fixed-length. Detached buffers throw TypeError on every read/write/access.

Spec §23.2 (TypedArray): every prototype method must check IsDetachedBuffer at the start, throw
TypeError if detached. ArrayBuffer.transfer detaches the source.

The 44 wasm_compile errors in ArrayBuffer suggest the ResizableArrayBuffer constructor signature
isn't recognized — the typed-codegen path gets a wrong arity.

## Acceptance criteria

1. `built-ins/ArrayBuffer/prototype/resize/length.js` passes.
2. `built-ins/ArrayBuffer/transfer/detaches-source-buffer.js` passes.
3. `built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js` passes.
4. `built-ins/DataView/prototype/getInt32/detached-buffer-throws.js` passes.
5. Pass-rate for `built-ins/ArrayBuffer` rises from 44% to ≥75%.

## Files to modify

- `src/runtime.ts` — `__arraybuffer_*` host imports
- `src/codegen/registry/typedarray.ts` — detached-buffer guards on every prototype method

## Implementation Plan

### Root cause

ResizableArrayBuffer is newer (ES2024); our codegen registry doesn't have an overload for the
options-object constructor `new ArrayBuffer(byteLength, {maxByteLength})`. Type-inference picks
the wrong overload and emits a wasm_compile-failing call.

Detached-buffer guards: each TypedArray method needs a prologue:
```
if (IsDetachedBuffer(this[[ViewedArrayBuffer]])) throw TypeError
```
We've inlined the methods without this guard.

### Approach

1. **Resizable**: add an options-object constructor variant. Store `maxByteLength` in the
   ArrayBuffer struct; `.resize(newLength)` updates `byteLength` if `<= maxByteLength`, throws
   RangeError otherwise.
2. **transfer**: implement by allocating a new buffer, copying data, marking source detached.
3. **Detached guards**: extend the codegen registry so every TypedArray method emits a detached
   check at entry. Add `IsDetachedBuffer` host import that returns 1/0.

### Edge cases

- `transfer()` with no argument → use source's byteLength.
- `transfer(newLen)` where newLen > source: zero-pad.
- Detached check must run even for length-0 access (e.g. `view.getInt8(0)` on a 0-length detached buffer).
- DataView: detached check separate from ArrayBuffer detached.

### Test262 sample

- `test262/test/built-ins/ArrayBuffer/prototype/resize/length.js`
- `test262/test/built-ins/ArrayBuffer/transfer/detaches-source-buffer.js`
- `test262/test/built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js`
