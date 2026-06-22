---
id: 2593
title: "Standalone TypedArray integer element-width wrapping (ToInt8/ToUint16/Uint8Clamped) + signed read"
status: done
assignee: ttraenkler/senior-developer
completed: 2026-06-22
sprint: 65
created: 2026-06-22
priority: high
feasibility: hard
reasoning_effort: max
task_type: conformance
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 2159
depends_on: []
---

# Standalone TypedArray integer element-width wrapping + signed read

## Problem

Integer typed-array element WRITES do not perform the spec
`ToInt8`/`ToUint8`/`ToInt16`/`ToUint16`/`ToInt32`/`ToUint32`/`ToUint8Clamp`
truncation, and the READ does not sign/zero-extend by the view's signedness.
Verified at runtime (standalone AND host — this is a general representation gap):

| repro | actual | spec |
|---|---|---|
| `Int8Array; a[0]=200; a[0]` | `200` | `-56` |
| `Int16Array; a[0]=40000; a[0]` | `40000` | `-25536` |
| `Uint16Array; a[0]=-1; a[0]` | `-1` | `65535` |
| `Uint32Array; a[0]=-1; a[0]` | `-1` | `4294967295` |
| `Uint8ClampedArray; a[0]=300; a[0]` | `300` | `255` |
| `Uint8ClampedArray; a[0]=-5; a[0]` | `-5` | `0` |
| `Uint8ClampedArray; a[0]=1.6; a[0]` | `1.6` | `2` (round-half-to-even) |
| `Uint8Array; a[0]=300; a[0]` | `44` ✓ | `44` |
| `Int32Array; a[0]=-1; a[0]` | `-1` ✓ | `-1` |

Only `Uint8Array` is correct today — it is the ONLY view with packed (`i8`)
storage standalone; every other integer view is f64-backed and stores the full
double with no width truncation.

This is the dominant **value-fidelity** bucket across `built-ins/TypedArray` and
`built-ins/TypedArrayConstructors` — element-set/get conformance, `fill`, `set`,
`of`/`from`, `copyWithin`, ctor-from-array all assert wrapped values.

## Root cause

`src/codegen/index.ts` `typedArrayVecStorage` (line 178) returns packed storage
**only** for `Uint8Array`:

```ts
return (ctx.wasi || ctx.standalone) && name === "Uint8Array"
  ? { key: "i8_byte", type: { kind: "i8" } }
  : { key: "f64", type: { kind: "f64" } };
```

All other integer views fall through to `f64`. An f64 store keeps the full
double; no read-side extend can recover the truncated value. Two coupled fixes
are required (both element-representation level):

1. **Per-view packed storage** — map the integer views to width-matched packed
   element types so `array.set` truncates and `array.get_s/_u` sign/zero-extends:
   `Int8Array`/`Uint8ClampedArray` → `i8`, `Int16Array`/`Uint16Array` → `i16`,
   `Int32Array`/`Uint32Array` → `i32`. Float views stay `f64`.
2. **Read signedness from the TS type** — `array.get_s` for `Int8Array`,
   `array.get_u` for `Uint8Array`/`Uint16Array`/`Uint8ClampedArray`, etc. The
   current packed read hard-codes `i8→get_u`, `i16→get_s` by *storage* kind,
   which is wrong for a signed `Int8Array` and an unsigned `Uint16Array`.

## Implementation Plan

### Approach — scoped, NOT a full representation rewrite

The triage warning (#2159) that this is "architect-scope" is about avoiding an
unbounded marshalling rewrite. The bounded plan: **extend packed storage to all
integer views, and confine the f64-vec assumptions to the export marshalling
boundary** (which already classifies non-Uint8 typed arrays as "typed-array" /
`number[]`-on-return — `classifyTypedArrayType`, index.ts:196). Internally,
integer views become packed; the marshalling layer keeps treating them like
`number[]` on the wasm/JS boundary (no new boundary work — those tests assert
*internal* element values, read back through the same wasm module).

### Changes

**1. `src/codegen/index.ts` — `typedArrayVecStorage` (line 178)**
Extend the standalone/WASI map (keep host mode on f64 UNLESS the same packed
path is safe there — verify equivalence tests before widening to host; if risky,
gate the new packing on `noJsHost(ctx)` and leave a follow-up note for host):
```
Int8Array, Uint8ClampedArray       → { key: "i8_byte",  type: { kind: "i8"  } }
Uint8Array                          → { key: "i8_byte",  type: { kind: "i8"  } }  (unchanged)
Int16Array, Uint16Array            → { key: "i16_byte", type: { kind: "i16" } }
Int32Array, Uint32Array            → { key: "i32_byte", type: { kind: "i32" } }
Float32Array                       → f64 (or i32-as-f32 bits — out of scope; keep f64)
Float64Array                       → f64
```
Add a sibling helper `typedArrayPackedSignedness(name): "s" | "u"` →
`Int*`/`Uint*`/`Uint8Clamped` ("u").

**2. Element WRITE truncation — `src/codegen/expressions/assignment.ts`
`compileElementAssignment` (~line 3064, the i8/i16 unpack block)**
After computing the store value as `i32`, apply width truncation BEFORE
`array.set`:
- `i8`/`u8` element: value already wraps via packed `array.set` (storage is
  i8). Confirm `array.set` into an `i8` element truncates to the low 8 bits —
  it does. So `Int8Array`/`Int16Array`/`Int32Array` need NO extra masking; the
  packed `array.set` truncates. **The truncation comes for free from packed
  storage** for Int*/Uint* of 8/16/32.
- **Uint8ClampedArray is special** (§ ToUint8Clamp): NOT modulo — it clamps to
  [0,255] with round-half-to-even. Emit a clamp sequence on the f64 value
  *before* converting to i32: `if NaN → 0; if <=0 → 0; if >=255 → 255; else
  round-half-even`. Add a helper `emitToUint8Clamp(fctx)` (model on existing
  `emitToInt32` in binary-ops.ts). Route Uint8ClampedArray writes through it
  instead of the plain `i32` truncation.
- Float64/Float32 unchanged.

**3. Element READ signedness — `src/codegen/property-access.ts`
`compileElementAccessBody` + `emitBoundsCheckedArrayGet`**
Where the packed element is read, choose `array.get_s` vs `array.get_u` from
`typedArrayPackedSignedness(receiverTypeName)` (recover the TA name from the
receiver's resolved TS type), NOT from the storage kind. Today's hard-coded
`i8→get_u` / `i16→get_s` must become name-driven. The receiver name is
available the same way `byteLength` recovers it (property-access.ts ~2280-2330,
`recvName`).

**4. Coercion sites that already assume f64-vec storage**
Audit these for the newly-packed views and switch their value temp to `i32`
(the Slice-1/fill pattern — unpack i8/i16 to i32 in a value position):
- `compileArrayFill` (array-methods.ts) — already handles i8/i16 unpack; extend
  the gate to the new i16/i32 byte views.
- `set`/`copyWithin`/`slice`/`subarray` element copy loops in array-methods.ts —
  ensure they read/write through `array.get_*`/`array.set` (packed-safe), not an
  f64 temp.
- `new TA([...])` element-init loop (new-super.ts) — coerce each literal element
  to `i32` and let packed `array.set` truncate.

### Wasm IR (Uint8ClampedArray write — the one non-free case)
```wasm
;; value on stack as f64; clamp to [0,255], round-half-even, → i32
;; (helper emitToUint8Clamp)
```

### Edge cases
- `Uint8ClampedArray` rounding is round-half-to-**even** (1.5→2, 2.5→2, 0.5→0).
- `Int32Array`/`Uint32Array`: `array.set` into an `i32` element truncates the
  i32 store value — but the WRITE value must first be `ToInt32`/`ToUint32` of the
  f64 (use `emitToInt32`; for Uint32 the same bit pattern, read back via
  `get_u`).
- NaN → 0 for all integer views (ToIntegerOrInfinity then modulo; for clamped,
  NaN→0 explicitly).
- `.length` / `byteLength` already name-keyed (byteLength map at
  property-access.ts:2319) — verify the i16/i32 byte sizes line up (they do).
- Marshalling boundary (`wrapExports`, #1700): integer views still surface as
  `number[]`-like on the JS boundary; internal element tests don't cross it. Run
  `tests/issue-2159*.test.ts` + the standalone TypedArray equivalence suite to
  confirm no boundary regression.

### Files
- `src/codegen/index.ts` (`typedArrayVecStorage`, new `typedArrayPackedSignedness`)
- `src/codegen/expressions/assignment.ts` (`compileElementAssignment`, clamp)
- `src/codegen/property-access.ts` (read signedness; byteLength byte-size check)
- `src/codegen/binary-ops.ts` (`emitToUint8Clamp` helper)
- `src/codegen/array-methods.ts` (fill/set/copyWithin/slice value temps)
- `src/codegen/expressions/new-super.ts` (ctor element-init coercion)

### Representative failing test262 paths
- `test/built-ins/TypedArray/prototype/fill/fill-values-conversion-operations*`
- `test/built-ins/TypedArrayConstructors/internals/Set/*` (ToInteger conversion)
- `test/built-ins/TypedArrayConstructors/ctors/typedarray-arg/*`
- `test/built-ins/TypedArray/prototype/set/*` (value coercion)
- `test/built-ins/TypedArrayConstructors/ctors/object-arg/*`

### Estimated rows
~120-220 standalone passes (every integer-view element-fidelity assertion,
fill/set value-conversion tests, ctor-from-array coercion tests). Largest single
bucket in the residual.

## Notes
- Element-representation level but **bounded**: confined to storage selection +
  packed read/write + a clamp helper; does NOT touch the value-rep substrate
  #2580 (no dynamic `$Object` reads). The marshalling boundary already treats
  non-Uint8 typed arrays as `number[]`, so no new boundary work.
- **Type-index discipline**: `getOrRegisterVecType` for the new `i16_byte` /
  `i32_byte` keys must register late+once (per `project_type_index_shift_and_deadelim`)
  — do NOT push a struct type mid-class-collection.
- Pairs naturally with #2592 (which produces these vecs) but is independent:
  #2592 can land with today's f64/i8 fidelity, #2593 upgrades the wrapping.
  **Dispatch note**: #2592 and #2593 both touch `calls.ts`/`new-super.ts`
  element-init paths — sequence #2592 first (additive arm), then #2593 (changes
  storage), or assign both to one dev to avoid a `[CONFLICT]`.

## Implementation Notes (2026-06-22, senior-developer)

**Landed (standalone/WASI only; host/gc keeps the f64 lane).**

### Root cause hierarchy
Three layers had to agree on the SAME packed backing vec for an integer view:
1. **Allocation** — `new TA(...)`. Before #2593 the count/literal constructors
   hardcoded `isNativeUint8Array ? i8_byte : f64`, so `new Int32Array(n)`
   allocated an **f64** vec while the read/`.byteLength` paths cast to
   `i32_byte`. That mismatch was the *keystone* bug: an inline
   `new Int32Array(4).byteLength` read field-0 through an `i32_byte` cast that
   never matched (→ `0`), and an empty `new Int32Array(0)` trapped
   (`illegal cast`). A *typed local* (`const a: Int32Array = ...`) happened to
   work only because the binding's declared type coerced the f64 vec to the
   packed vec at the store — inline expressions have no such coercion point.
2. **Write** — element store applies the spec coercion (ToInt8/ToUint8/
   ToInt16/ToUint16/ToInt32/ToUint32, and ToUint8Clamp round-half-to-even).
3. **Read** — sign/zero extension keyed on the **view name** (signed→`array.get_s`,
   unsigned→`array.get_u`), since signed/unsigned views share storage.

### What changed
- **`src/codegen/index.ts`** — `TYPED_ARRAY_PACKED_STORAGE` (Int8/Uint8/
  Uint8Clamped→i8_byte, Int16/Uint16→i16_byte, Int32/Uint32→i32_byte), gated on
  `wasi || standalone`; `typedArrayVecStorage` is now the single source of truth.
  Exported `typedArrayPackedSignedness(name)`. `reserveTypedArraySubviewTypes`
  reserves i16_byte/i32_byte subview backing. Generic vec accessors
  (`__vec_get`, `__vec_pop`) read packed bytes with `array.get_u` (plain
  `array.get` is INVALID on packed i8/i16) and unsigned-convert.
- **`src/codegen/expressions/new-super.ts`** — BOTH count-ctor handlers now
  allocate via `typedArrayVecStorage` (the keystone fix), so the constructor's
  backing vec matches the read/byteLength paths.
- **`src/codegen/property-access.ts`** — view-name-driven get_s/get_u at the vec
  and bare-array read sites; Uint32 unsigned read (`f64.convert_i32_u`);
  `.byteLength` reader uses `typedArrayVecStorage` and a runtime `ref.test`
  guard before the packed-vec cast (empty/mismatched view → length 0, no trap).
- **`src/codegen/array-methods.ts`** — `emitBoundsCheckedArrayGet` takes a
  `signedness` param.
- **`src/codegen/expressions/assignment.ts`** — write-site truncation; routes
  Uint8Clamped through `emitToUint8Clamp`, other packed views through
  `i32.trunc_sat_f64_s` into i32 (unpacked) hint.
- **`src/codegen/binary-ops.ts`** — `emitToUint8Clamp` (clamp to [0,255] with
  round-half-to-even).

### Validation
- New `tests/issue-2593-typedarray-intwidth.test.ts` (18/18) + the #1787
  forward-looking suite flipped to live guards (9/9). Core typed-array sweep
  77/77 (issue-2159, ta-fill, atomics, 2595-2597, 1787).
- The legacy `tests/typed-array-basic.test.ts` / `tests/arraybuffer-dataview.test.ts`
  failures (instantiate with `{}` and lack the now-mandatory `string_constants`
  import added by a sibling PR) are PRE-EXISTING on `origin/main` — unrelated to
  #2593.
- Quality sub-gates green: tsc, prettier (all changed files), stack-balance,
  coercion-sites, any-box-sites, codegen-fallbacks, ir-fallbacks, biome (changed
  files).

### Deliberately out of scope
Cross-view copy conversion (`new Int32Array(someFloat64Array)`) keeps the
pre-#2593 saturating `i32.trunc_sat_f64_s` rather than full modulo wrapping —
that vec-to-vec conversion path is independent of the element write/read core.
