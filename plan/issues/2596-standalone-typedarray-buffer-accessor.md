---
id: 2596
title: "Standalone TypedArray/DataView .buffer accessor — illegal cast at runtime"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-typedarray-2595-2597
sprint: 65
created: 2026-06-22
priority: medium
feasibility: hard
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 2159
depends_on: []
---

# Standalone TypedArray/DataView .buffer accessor

## Problem

`view.buffer` (and `dataView.buffer`) traps `illegal cast` at runtime in
`--target standalone`:

```ts
new Int32Array(4).buffer.byteLength     // RT: illegal cast  (want 16)
new DataView(new ArrayBuffer(16)).buffer.byteLength  // RT: illegal cast (want 16)
```

`.buffer` is read by a large swath of TypedArray/DataView tests for byteLength
derivation and for `view.buffer === otherView.buffer` aliasing identity.

## Root cause

A TypedArray's backing is a **typed** vec — `f64` (most views) or `i8`
(standalone `Uint8Array`) — NOT the `i32_byte` ArrayBuffer vec. The `.buffer`
property is currently lowered (or falls through) to a path that `ref.cast`s the
receiver to the `i32_byte` ArrayBuffer vec type, which fails on the f64/i8 vec
→ `illegal cast`. There is **no real backing ArrayBuffer object** tracked for a
view that was constructed as `new Int32Array(n)` (only `new TA(buffer)` starts
from an actual buffer).

This is the deferred "Slice 2b `.buffer` accessor" from #2159 — the TA backing
is not an i32_byte buffer, so `.buffer` must synthesize/track one.

## Implementation Plan

### Scope decision — synthesize a byte-view, don't trap

The two dominant test262 uses are (1) `view.buffer.byteLength` and (2) buffer
**identity/aliasing** (`a.buffer === b.buffer` when `b = a.subarray(...)`, and
`new TA(view.buffer)` round-trips). Full mutable byte-aliasing between an f64
view and its `i32_byte` buffer is the hard part; this slice targets a correct,
non-trapping `.buffer` for the common reads and defers true byte-level aliasing.

### Approach

**Option A (recommended, bounded) — compute `.buffer.byteLength` without
materializing a buffer when the result is only consumed for byteLength.**
This is what the byteLength interception already does for the view itself. Add a
`.buffer` arm that, for `view.buffer.byteLength` chains, folds to
`view.length * BYTES_PER_ELEMENT` (the byte count) — but this only covers the
chained-byteLength case, not identity.

**Option B (more complete) — a lazy `$__ta_buffer` wrapper.**
Track an optional backing-buffer slot on views. Two sub-cases:
- `new TA(buffer)` / `new DataView(buffer)`: the view already knows its source
  `i32_byte` buffer — store a reference so `.buffer` returns the *same* object
  (correct identity). For DataView this is the `$__dv_window.buf` field (already
  exists) or the bare vec. **Return that directly** — no cast needed; this case
  is already a real i32_byte buffer.
- `new TA(n)` (no source buffer): lazily synthesize an `i32_byte` vec of
  `n * BYTES_PER_ELEMENT` bytes on first `.buffer` access. For a read-only
  byteLength/`isView`/identity-once use this is correct; true write-through
  aliasing (mutating the buffer mutates the view) is OUT OF SCOPE — note it.

**Recommendation**: implement **Option B for the `new TA(buffer)` / DataView
case** (return the real backing buffer — correct identity, no synthesis, no
trap) and **Option A for the `new TA(n)` case** (fold `.buffer.byteLength`;
return a fresh i32_byte vec of the right byte length for a bare `.buffer` read so
`.byteLength` works and it doesn't trap). Document the write-through-aliasing
limitation. This kills the `illegal cast` and passes the byteLength + identity
(for buffer-sourced views) tests.

### Changes

**1. `src/codegen/property-access.ts` — `.buffer` arm in the
`if (isBuffer || isTypedArr || isDataView)` region (~line 2309)**
- For a DataView receiver: return `$__dv_window.buf` (windowed) or the bare
  `i32_byte` vec (unwindowed) — both are real ArrayBuffer vecs.
- For a TypedArray receiver with a tracked source buffer: return the tracked
  `i32_byte` buffer ref.
- For a TypedArray receiver with no source buffer: synthesize an `i32_byte` vec
  with field-0 = `view.length * BYTES_PER_ELEMENT` (compute from the vec's
  field-0 × byte size; allocate a zero-filled data array of that byte length).
  Return it as the ArrayBuffer vec ref (externref-coerced as views are).
- **Never** `ref.cast` the f64/i8 view vec to `i32_byte` — that is the bug.

**2. (if Option B buffer tracking) `src/codegen/expressions/new-super.ts`**
Thread the source-buffer ref into a view slot when `new TA(buffer)` /
`new DataView(buffer)` is built, so `.buffer` returns the same object.

### Edge cases
- `view.buffer.byteLength` chain — the synthesized/returned buffer's field-0 is
  the byte count, so `.byteLength` reads correctly via the existing buffer
  byteLength arm.
- `new Int32Array(someBuffer).buffer === someBuffer` — must hold (identity) for
  the buffer-sourced case (Option B).
- `subarray` result `.buffer` identity (`s.buffer === a.buffer`) — depends on
  the #2357 subview rep; if subview tracks the parent buffer, return it; else
  note as a residual.
- Empty view (`new Int32Array(0).buffer.byteLength` → 0) — must not trap.

### Files
- `src/codegen/property-access.ts` (`.buffer` arm, ~2309)
- `src/codegen/expressions/new-super.ts` (optional buffer-source tracking)
- `src/codegen/dataview-native.ts` (DataView `.buffer` recover, reuse
  `recoverDvBacking`)

### Representative failing test262 paths
- `test/built-ins/TypedArray/prototype/buffer/*`
- `test/built-ins/DataView/prototype/buffer/*`
- `test/built-ins/TypedArrayConstructors/ctors/buffer-arg/*` (identity)

### Estimated rows
~20-50 standalone passes (direct `.buffer` tests + the many tests that read
`.buffer.byteLength` in assertions). Identity-dependent tests partly gated on
#2357 subview rep.

## Notes
Representation-adjacent (`.buffer` synthesis) but **non-trapping is the floor** —
even Option A alone (fold byteLength, return a non-cast vec) removes the
`illegal cast` that blocks every `.buffer`-touching test. Substrate-independent
(no `$Object` dynamic reads). True write-through byte-aliasing between an f64
view and its byte buffer is explicitly deferred (would require the unified
byte-storage rep — pairs with #2593's packed migration). **Dispatch note**:
shares the property-access.ts typed-array block with #2595 (disjoint `propName`
arms).

## Resolution (2026-06-22) — Option A (non-trapping floor)

Implemented a `.buffer` arm in `compilePropertyAccess`
(`src/codegen/property-access.ts`, just after the byteLength/byteOffset block),
gated on `propName === "buffer" && noJsHost(ctx)` and a TypedArray/DataView
receiver. It **synthesizes** a fresh `i32_byte` ArrayBuffer vec whose field-0
byte length == the view's byte length, with a zero-filled data array — never
`ref.cast`s the f64/i8 view vec to the i32_byte buffer type (that cast was the
`illegal cast` bug). Byte length:
- **TypedArray**: element-count (vec field 0) × `BYTES_PER_ELEMENT` (reuses the
  hoisted `TYPED_ARRAY_BYTES_PER_ELEMENT` map from #2595).
- **DataView**: runtime `ref.test $__dv_window` branch — a windowed view reads
  its field-2 `byteLength`; a bare i32_byte vec reads field 0 (mirrors the
  existing DataView byteLength arm so both shapes work; a static cast to one
  shape would `illegal cast` the other).

`view.buffer.byteLength` is now correct and non-trapping for `new TA(n)`, bare
`new DataView(buf)`, windowed `new DataView(buf, off, len)`, and empty views
(no trap). Bounded — stayed entirely within the property-access.ts TA block; no
new-super.ts buffer-source tracking needed for the byteLength/non-trapping goal.

Also removed a leftover `JS2WASM_DBG_2595` debug `console.error` that shipped in
#1912's byteLength block (harmless env-gated no-op, but production cruft).

**Deferred (documented, out of scope):** true write-through byte-aliasing
(mutating `.buffer` mutates the view) and buffer **identity**
(`new TA(buf).buffer === buf`, `a.buffer === b.buffer` for subviews) — both need
the unified byte-storage representation (pairs with #2593's packed migration)
and/or source-buffer tracking in new-super.ts (#2357 subview rep). The
synthesized buffer is a fresh object, so identity-dependent test262 cases remain
residual; the dominant `.buffer.byteLength` reads now pass.

Validated: `tests/issue-2596.test.ts` (9 tests) — Int32/Float64/Uint8/Int16/Int8
`.buffer.byteLength`, empty view (no trap), `.buffer` to local, bare + windowed
DataView. tsc + prettier + coercion-sites clean; packed-typedarray,
dataview-window, dataview-bounds, and #2595/#2597 suites still green (64 tests).
