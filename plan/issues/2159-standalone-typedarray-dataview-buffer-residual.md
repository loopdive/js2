---
id: 2159
title: "Standalone TypedArray/DataView/ArrayBuffer conformance residual (~1,308 tests)"
status: in-progress
sprint: 65
created: 2026-06-15
updated: 2026-06-18
priority: high
feasibility: medium
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 1461
---

# Standalone TypedArray/DataView/buffer conformance residual

## Problem

TypedArray callback methods, generic array-like receivers, and DataView/
ArrayBuffer support landed in #1358, #1461, #1654 (all `done`, sprints
51–58). The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15)
shows **1,308 tests pass in host mode but fail standalone**, attributed to
TypedArray/DataView/buffer semantics — the third-largest catch-up bucket
and currently **untracked/unscheduled**.

## Evidence

- Gap categories: `built-ins/TypedArray` (565), `built-ins/TypedArrayConstructors`
  (321), `built-ins/DataView` (336), `built-ins/ArrayBuffer` (78),
  `built-ins/Atomics` (132).
- Mostly `(none)`-leak `compile_error` (525 TypedArray + 287 ctor +
  135 DataView) — standalone codegen gaps, not host-import shims.

## Acceptance criteria

- Standalone pass count for the TypedArray/DataView/ArrayBuffer/Atomics
  categories rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1461. Part of sprint-62 standalone catch-up (rank 3 by gap
impact). Compile-error-heavy — likely shares root cause with the #2079
late-import index-shift class for some constructors.

---

## Slice 1 (2026-06-16) — packed i8/i16 local leak on typed-array element writes

**Landed.** Triage of the standalone residual found the dominant
`(none)`-leak compile-error class: **every byte/short typed-array element
WRITE** (`a[i] = v` on `Uint8Array` / `Int8Array` / `Uint8ClampedArray` /
`Int16Array` / `Uint16Array`) was a hard compile error in standalone mode.

**Root cause** (`src/codegen/expressions/assignment.ts`
`compileElementAssignment`): the store-value temp local was allocated with the
array's RAW element type — `i8`/`i16`, which are *packed storage* types valid
only inside array elements / struct fields, never in a value position
(param/result/local/global). The binary emitter rejected the leaked local with
`encodeValType: packed storage type "i8" is not valid in a value position`. The
matching READ path already unpacks via `array.get_u`/`_s` → `i32`
(property-access.ts), so reads worked but writes did not — making the entire
byte/short typed-array surface unusable standalone.

**Fix:** unpack the store-value local type `i8`/`i16` → `i32`; `array.set`
re-packs the `i32` into the element. One disjoint type fix, no behavioral change
for `Int32Array`/`Float64Array` (their element type is already a value type).

Verified standalone: set/get, negative in-range values, loop writes, compound
assignment (read-modify-write), and 8-bit store wrap (256 → 0) all pass.
Test: `tests/issue-2159.test.ts`.

### Remaining slices (issue stays open) — triage 2026-06-16

**Slice 2 — ArrayBuffer / TypedArray byteLength + buffer + `new TA(buffer)`.**
A coherent cluster, all standalone:

| repro | standalone | expected |
|---|---|---|
| `new ArrayBuffer(8).byteLength` | `0` | `8` |
| `new Int32Array(buf).length` | `8` | `2` (byteLength/4) |
| `new Int32Array(4).byteLength` | `0` | `16` |
| `new Int32Array(4).byteOffset` | `0` ✓ | `0` |
| `new Int32Array(4).buffer.byteLength` | throws | `16` |

Root: the standalone ArrayBuffer is the `i32_byte` vec struct (field 0 =
**byte** length, field 1 = data) — see `src/codegen/dataview-native.ts`.
`.length` is intercepted as a field-0 read in `property-access.ts` (~line 2516),
but **`byteLength` / `buffer` are not intercepted at all**, so they fall through
to `__extern_length`/default → `0`. The fix is NOT a plain field-0 alias because
`byteLength` is element-size-scaled: ArrayBuffer/Uint8Array `byteLength == length`,
but `Int32Array.byteLength == length*4`, `Float64Array == length*8`, etc. And
`new Int32Array(buffer)` currently mis-computes `length` (uses the buffer's byte
count as the element count instead of `byteLength / BYTES_PER_ELEMENT`). Slice 2
needs: (a) a `byteLength` property interception that scales by the receiver's
element byte-size; (b) a `buffer` accessor returning the backing i32_byte vec;
(c) the `new TA(ArrayBuffer)` constructor to set element count =
`buffer.byteLength / BYTES_PER_ELEMENT`. Medium-sized, representation-aware —
self-contained from slice 1.

#### Slice 2a (LANDED 2026-06-17) — `byteLength` / `byteOffset` interception

**Done — part (a) + `byteOffset`.** Added a standalone/WASI `byteLength` /
`byteOffset` interception in `property-access.ts` (right after the
TextEncoder/TextDecoder block). For an ArrayBuffer/SharedArrayBuffer receiver
`byteLength` = field-0 directly (already a byte count); for a TypedArray
receiver `byteLength` = field-0 (element count) `* BYTES_PER_ELEMENT`, where the
per-name byte size is statically known (Int8/Uint8/Uint8Clamped=1, Int16/Uint16=2,
Int32/Uint32/Float32=4, Float64=8). `byteOffset` is 0 on a fresh-backing view.
Gated on `ctx.wasi || ctx.standalone || ctx.strictNoHostImports` so host mode is
untouched. Verified: ArrayBuffer + all 9 TypedArray kinds, typed locals, typed
params, empty arrays — all correct. Tests: `tests/issue-2159.test.ts`
("byteLength + byteOffset" describe block, 9 cases).

**Still remaining for Slice 2:**
- (b) `.buffer` accessor returning the backing vec (needs a buffer object;
  trickier under the f64-vec representation — the TA backing is NOT an i32_byte
  buffer, so `.buffer` must synthesize/track one).
- (c) `new TA(ArrayBuffer)` element-count + multi-byte reinterpret:
  `emitTypedArrayFromByteBuffer` (new-super.ts) currently treats each source
  *byte* as one destination *element* (`dstArr[i] = srcArr[i] & 0xff`), so an
  8-byte buffer makes an 8-element Int32Array instead of 2. Correct behaviour
  needs length = `buffer.byteLength / BYTES_PER_ELEMENT` and a 4-/8-byte
  little-endian reassembly per element. Representation-heavy; a separate slice.

**Slice 3 — DataView standalone** leaks `env::` host imports
(`new DataView(buf)` + `getInt32`/`setInt32`/`getFloat64`/… not wired to the
native `dataview-native.ts` accessors on this path) — the 336-test DataView
bucket. Larger; likely a senior-dev slice.

**Not a slice:** Int8Array signed-read of an out-of-range store (`a[0]=200` →
expect `-56`) reads unsigned — a separate signed/wrap concern, orthogonal to the
above.

---

## Slice (2026-06-17) — standalone TypedArray.prototype.fill packed-local leak

**Landed.** Re-validation of the TypedArray-method surface standalone found that
`set` / `subarray` / `copyWithin` / `slice` already work natively on byte/short
typed arrays, but **`.fill()` was a hard compile error** for every byte/short
typed array (`Uint8Array` / `Int8Array` / `Uint8ClampedArray` / `Int16Array` /
`Uint16Array`).

**Root cause** (`src/codegen/array-methods.ts` `compileArrayFill`): the
fill-value temp local was allocated with the array's RAW element type — `i8`/`i16`,
which are *packed storage* types valid only in array elements / struct fields,
never in a value position (param/result/local/global). The binary emitter rejected
the leaked local with `encodeValType: packed storage type "i8" is not valid in a
value position` — the same class as the element-WRITE leak fixed in Slice 1, but
in the `fill` path. `Int32Array`/`Float64Array` were unaffected (value-type
elements).

**Fix:** unpack the fill-value local type `i8`/`i16` → `i32` (and pass the
unpacked type as the value-arg compile hint); `array.set` re-packs the `i32` into
the element on store. Verified standalone: Uint8/Int8/Int16/Uint16 fill, negative
signed round-trip, start/end range, modulo-256 wrap, and Int32Array no-regression.
Test: `tests/issue-2159-ta-fill.test.ts`.

**Out of this slice:** `subarray` aliasing (the returned view should share the
parent buffer; standalone currently returns a copy) requires offset-windowing —
the shared representation gap with DataView offset / TypedArray-on-buffer
windowing — and is a separate follow-up.

---

## Slice (2026-06-18, #38) — standalone DataView offset-windowing

**Landed.** `new DataView(buffer, byteOffset, byteLength)` in standalone / WASI
mode previously validated the offset/length args for RangeError but then
**discarded the window**: the ctor returned the *full* backing buffer, so every
`dv.get/set*(i, …)` addressed byte `i` of the whole buffer (ignoring the base
offset), and `dv.byteOffset` / `dv.byteLength` reported `0` / full-length. The
explicit `(none)`-leak comment in `new-super.ts` flagged this as the deferred
"view-window base offset" representation slice.

**Design — additive `$__dv_window` wrapper struct** (low blast radius; chosen
over an offset field on every vec, which would tax the hot `a[i]` element-access
path for all arrays):

- New struct `$__dv_window { buf: (ref null __vec_i32_byte), byteOffset: i32,
  byteLength: i32 }` (`getOrRegisterDvWindowType`, lazy, in `dataview-native.ts`;
  cache idx `ctx.dvWindowTypeIdx`).
- The DataView ctor (standalone path, `new-super.ts`) builds a `$__dv_window`
  **only when windowed** (an explicit byteOffset/byteLength arg, `args.length >=
  2`), sharing the parent's backing array (true aliasing — no copy), and returns
  it as externref (DataView locals are externref). Offset-0 default-length views
  keep the bare `i32_byte` vec representation — the dominant, fully-native case,
  zero new cost. The standalone externref-buffer default-length path now reads
  the struct's byte length at runtime (`any.convert_extern` + `ref.cast`) instead
  of the host-only NaN sentinel.
- The native accessors (`emitDataViewAccessor`, `dataview-native.ts`) recover the
  receiver via `recoverDvBacking`: a runtime `ref.test $__dv_window` branch
  yields `(backing array, base byte offset)` for both shapes (wrapper → shared
  array + ctor offset; bare vec → its array + 0), and the base offset is added to
  every byte index.
- `dv.byteOffset` / `dv.byteLength` (`property-access.ts`) get a DataView arm
  that reads the wrapper fields, or `0` / `vec.length` for the bare-vec view.

**Verified** (`tests/issue-38-dataview-window.test.ts`, 8 cases, all standalone):
windowed write visible at the correct absolute byte of the full view; windowed
multi-byte (`setUint16`) aliasing; within-window `int32` round-trip;
`dv.byteOffset` = ctor arg; `dv.byteLength` = explicit + default
(`bufferByteLength - offset`); offset-0 bare-vec fast-path intact; two disjoint
windows don't clobber. coercion-sites gate OK; `tsc --noEmit` clean; existing
standalone DataView/ArrayBuffer/TypedArray suites green (the 6 `string_constants`
import failures in `arraybuffer-dataview.test.ts` are a pre-existing JS-host
harness issue on upstream/main, not a regression).

**Out of this slice (→ architect #46):** TypedArray `subarray` aliasing needs an
offset-windowing representation on the **hot `a[i]` element-access path**
(`compileElementAccessBody` / all typed-array access) — a broad, high-blast
change routed to an architect spec (`$__subview` design), not folded here.

## Triage (2026-06-18, cs-2164) — integer typed-array element fidelity is representation-gated, NOT a point fix

Probed the standalone typed-array element surface for a tractable next slice and
found the dominant remaining *value-fidelity* gap is **representation-level**, so
documenting precise scope rather than shipping a no-op:

**Finding — only `Uint8Array` has packed storage; every other integer view is
f64-backed with NO element-width wrapping.** `typedArrayVecStorage` (index.ts:173)
returns `i8`/`i8_byte` storage **only** for `Uint8Array` (under WASI/standalone);
`Int8Array`, `Int16Array`, `Uint16Array`, `Int32Array`, `Uint32Array`, `Float32Array`
all fall through to `f64` storage. Consequences, verified standalone AND host
(so this is a general representation gap, not standalone-specific):

| repro | actual | spec |
|---|---|---|
| `Int8Array; a[0]=200; a[0]` | `200` | `-56` (ToInt8 + sign-extend) |
| `Int16Array; a[0]=40000; a[0]` | `40000` | `-25536` |
| `Uint16Array; a[0]=-1; a[0]` | `-1` | `65535` (ToUint16) |

The f64 store keeps the full double with no `ToInt8`/`ToUint16`/… wrapping, so no
read-side extend can recover the right value. `Uint8Array` is correct today
**because** it already uses packed `i8` storage (`a[0]=300 → 44`, `-1 → 255`
verified).

**Two coupled fixes are required, and both are representation-level:**
1. **Read signedness** (small, but inert alone): the `array.get*` op for a packed
   `i8`/`i16` element is chosen from the *storage* kind, hard-coded `i8→get_u`,
   `i16→get_s` — wrong for a signed `Int8Array` (needs `get_s`) and an unsigned
   `Uint16Array` (needs `get_u`). The view's signedness must come from the
   receiver's TS type. A prototype helper (`typedArrayPackedSignedness` →
   `array.get_s`/`get_u` per `Int*`/`Uint*`) threads cleanly into
   `compileElementAccessBody` + `emitBoundsCheckedArrayGet`, but it is **inert
   until** the views actually use packed storage (only `Uint8Array` does today,
   and it's already right) — so it has zero conformance movement on its own.
2. **Packed storage for all integer views** (the real win, architect-scope):
   extend `typedArrayVecStorage` to map `Int8Array`/`Uint8ClampedArray` → `i8`,
   `Int16Array`/`Uint16Array` → `i16`, `Int32Array`/`Uint32Array` → `i32`, so the
   store `array.set` truncates to the element width (correct ToInt/ToUint
   wrapping) and the read sign/zero-extends. This touches the marshalling
   boundary (`wrapExports` f64-vec assumption, #1700), `__vec_set_byte`/byte
   dispatch, `byteLength` scaling (already name-keyed), `.buffer`, and the
   ctor/method element-coercion sites — a broad, high-blast representation change
   that should be an **architect spec** alongside the #46 subview windowing, not
   a dev slice.

**Recommendation:** route the packed integer-typed-array storage migration to an
architect (pairs naturally with #46 `$__subview` since both rework the
element-access representation). The read-signedness helper above is ready to fold
in *as part of* that change. No code shipped from this triage — the prior
slices (1, 2a, fill, #38 DataView windowing) stand. **#2159 stays open.**

## Triage re-probe (2026-06-21, dev-carla) — verified residuals on upstream/main

Probed against current upstream/main (`--target standalone`). **Working** (no leak):
DataView get/set Int32/Float64 incl. little-endian, `Int16Array(buffer)` element
read, `TypedArray.fill`, `DataView(buf, off, len).byteLength`, `subarray`,
`Float64Array.set([...])`. **Still broken (genuine dev-tractable residuals):**
- `Uint8Array.of(...)` / `Uint8Array.from([...])` → CE `__get_builtin` (the
  static TypedArray factory methods aren't lowered standalone).
- `new Uint8Array([1,2,3]).indexOf(2)` → `Binary emit error: encodeValType:
  packed storage type "i8" is not valid` (the i8-element indexOf path emits an
  invalid packed valType).
Both are in #2159's lane (owner ttraenkler/sdev-json3, live claim) — flagged here
for that owner, not claimed by triage.

---

## Sprint-65 slicing (2026-06-22, architect) — verified residuals → 6 sub-issues

Re-probed the standalone TypedArray/DataView/ArrayBuffer surface against current
upstream/main (compile + instantiate + run, `.tmp/` battery). The original
compile-error class (525+ `(none)`-leak CEs) is **largely fixed** by the prior
slices — most byte/short element ops, DataView get/set Int/Float, `fill`, `set`,
`subarray`, `copyWithin`, `slice`, iterators (`values`/`entries`/for-of/spread)
all compile AND run correctly standalone now. The remaining residual is a mix of
a few CEs, host-import leaks, and **runtime value-fidelity** gaps (which compile
clean but fail test262 assertions). Sliced into 6 dev-tractable sub-issues:

| # | title | rows | feasibility |
|---|---|---|---|
| **#2592** | TypedArray.of / TypedArray.from static factories (CE `__get_builtin`) | ~40-90 | medium |
| **#2593** | Integer element-width wrapping (ToInt8/ToUint16/Uint8Clamp) + signed read | ~120-220 | hard |
| **#2594** | Host-import leaks: `ArrayBuffer.isView`, BigInt64Array ctor, DataView BigInt accessors | ~30-70 | medium |
| **#2595** | `BYTES_PER_ELEMENT` (static CE + instance returns 0) | ~15-40 | easy |
| **#2596** | `.buffer` accessor — `illegal cast` at runtime | ~20-50 | hard |
| **#2597** | `@@toStringTag` — `Object.prototype.toString.call(ta)` returns `[object Object]` | ~15-35 | easy |

**Verified-good standalone (NOT sliced — already correct):** byte/short element
read+write, `fill`, `set` (with offset), `copyWithin`, `slice`, `subarray`,
DataView get/set Int8/Uint8/Int16/Uint16/Uint32/Int32/Float32/Float64 + LE,
DataView OOB→RangeError, `DataView(buf,off,len).byteLength`, `byteLength`/
`byteOffset` interception, iterators (`values`/`entries`/for-of/spread),
`map`/`filter`/`reduce`/`forEach`/`find`/`some`/`every`, `indexOf` on byte views,
`Uint8Array` element wrapping (correct via packed i8 storage).

**Dispatch overlap notes:**
- #2592 + #2593 both touch `calls.ts`/`new-super.ts` element-init paths —
  sequence #2592 first (additive arm) then #2593 (changes storage selection),
  or give both to one dev to avoid a `[CONFLICT]`.
- #2595 + #2596 + #2597 are largely property-access.ts (#2595/#2596 in the
  typed-array property block, disjoint `propName` arms; #2597 in `calls.ts`
  `resolveObjectToStringTag`). Land-order independent.
- #2593 is the biggest win and the hardest (element-representation level, but
  bounded — confined to storage selection + packed read/write + a clamp helper;
  does NOT touch the value-rep substrate #2580).

**Residual NOT covered by these 6 slices (tracked, deferred):**
- True write-through byte-aliasing between an f64 view and its `.buffer` (needs
  the unified byte-storage rep; pairs with #2593's packed migration — #2596
  delivers non-trapping `.buffer` + correct byteLength/identity first).
- `subarray`/`slice` `.buffer` identity is partly gated on the #2357 subview rep.
- `TypedArray.from(string | Set | Map | arbitrary iterator)` — only array-like /
  vec sources are in #2592; iterator sources stay on the existing host path.
- Atomics (132 in the original gap) — a separate concern (SharedArrayBuffer +
  atomic ops), not a TypedArray-element slice; out of this umbrella's 6 slices.
- Detached-buffer semantics beyond the DataView bounds case (#2199, done) —
  `ArrayBuffer.transfer`/`resize` detach + post-detach TypedArray traps are a
  separate ArrayBuffer-lifecycle concern, not sliced here.
