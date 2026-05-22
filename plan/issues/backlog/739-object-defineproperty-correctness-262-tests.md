---
id: 739
title: "- Object.defineProperty correctness (262 tests)"
status: ready
created: 2026-03-22
updated: 2026-04-28
priority: medium
feasibility: hard
reasoning_effort: max
goal: property-model
test262_fail: 262
files:
  src/codegen/expressions.ts:
    new:
      - "Object.defineProperty implementation with full descriptor support"
---
# #739 -- Object.defineProperty correctness (262 tests)

## Status: backlog

## ECMAScript spec reference

- [§20.1.2.4 Object.defineProperty](https://tc39.es/ecma262/#sec-object.defineproperty) — step 3: call DefinePropertyOrThrow
- [§10.1.6.3 ValidateAndApplyPropertyDescriptor](https://tc39.es/ecma262/#sec-validateandapplypropertydescriptor) — complete validation logic for descriptor compatibility, accessor vs. data conversion


## Problem

262 tests under built-ins/Object/defineProperty and built-ins/Object/defineProperties fail. The compiler's Object.defineProperty implementation is either missing or incomplete.

### ES spec requirements
- Data descriptors: value, writable, enumerable, configurable
- Accessor descriptors: get, set, enumerable, configurable
- Descriptor validation (cannot mix data + accessor)
- Respect existing configurability (non-configurable properties cannot be reconfigured)
- DefineOwnProperty must follow the spec algorithm exactly

### What needs to happen

1. Implement full Object.defineProperty with descriptor validation
2. Object struct must store property attributes (writable, enumerable, configurable)
3. Implement Object.defineProperties as multi-call wrapper
4. Implement Object.getOwnPropertyDescriptor to read attributes back

## Complexity: L (>400 lines, fundamental object model change)

## Implementation Plan

(Author: architect, 2026-05-21. The Object.defineProperty surface
already has substantial codegen at `src/codegen/object-ops.ts` and
runtime support — the work is to harden the existing implementation
against the spec's full ValidateAndApplyPropertyDescriptor algorithm
rather than to write a fresh implementation.)

### Entry point

- **Codegen**: `compileObjectDefineProperty` in
  `src/codegen/object-ops.ts:336` (existing).
- **Runtime**: `_validateAndApplyDescriptor` in
  `src/runtime.ts:153` (existing) — extend to cover the spec
  algorithm completely.
- **Property descriptors storage**: existing sidecar pattern at
  `src/runtime.ts:386` (`_sidecarGet`/`_sidecarSet`) with attribute
  flags packed into a per-property metadata struct.

### Data structure changes

1. Sidecar property metadata, today a flag-byte (`writable=1<<0,
   enumerable=1<<1, configurable=1<<2, accessor=1<<3`), is already in
   place. Add:
   - `hasValue` bit (distinguishes data desc with `value: undefined`
     from data desc with no `value`).
   - `hasGet`, `hasSet` bits (same reason for accessors).
   These map directly to spec fields `[[Value]]`, `[[Get]]`,
   `[[Set]]`.

2. Per-property accessor storage already uses sidecar keys
   `__get_<prop>` / `__set_<prop>` (runtime.ts:1043, 1108); keep,
   no change.

3. WasmGC struct fields with backing storage: when a defineProperty
   call targets a field already present in the struct
   (`object-ops.ts:737`), continue to use `struct.set`, but record
   the attribute flags in the sidecar too — otherwise
   `Object.getOwnPropertyDescriptor` returns wrong attributes for
   declared fields.

### Numbered algorithm — ValidateAndApplyPropertyDescriptor (§10.1.6.3)

Implement faithfully in `_validateAndApplyDescriptor` (runtime.ts:153):

1. **Get current descriptor** (`current`) via `_sidecarGet` of
   metadata, falling back to "data descriptor with value = real
   struct field" for declared fields.

2. **If current is undefined** (property doesn't exist):
   1. If object is not extensible → return false.
   2. If `Desc` is a generic descriptor or data descriptor: create
      a data property with `[[Value]]=Desc.[[Value]] ?? undefined`,
      attributes defaulting to false for each unspecified attribute.
   3. If `Desc` is an accessor descriptor: create accessor property
      similarly.
   4. Store metadata + value/getter/setter; return true.

3. **If current is non-configurable**:
   1. If `Desc.[[Configurable]] === true` → return false.
   2. If `Desc.[[Enumerable]]` is set and differs from current →
      return false.
   3. If `Desc` is generic → return true (no-op succeeds).
   4. If `IsDataDescriptor(current) !== IsDataDescriptor(Desc)` →
      return false (cannot convert data ↔ accessor while non-conf).
   5. If both are data desc:
      - If current is non-writable AND Desc.[[Writable]] === true →
        return false.
      - If current is non-writable AND
        Desc.[[Value]] is present and SameValue(Desc.[[Value]],
        current.[[Value]]) === false → return false.
   6. If both are accessor desc:
      - If Desc.[[Set]] is present and not SameValue with
        current.[[Set]] → return false.
      - If Desc.[[Get]] is present and not SameValue with
        current.[[Get]] → return false.

4. **Apply the descriptor**:
   - For data desc: store value (struct.set or sidecar), set flag
     bits.
   - For accessor desc: store getter/setter under `__get_<prop>` /
     `__set_<prop>`, set accessor bit.
   - Unspecified attributes inherit from current (NOT default to
     false — that's only for new properties).

5. **Return true**.

### Example wasm output — `Object.defineProperty(o, "x", {value: 42})`

After fix:

```wat
local.get $o
i32.const <strpool "x">
f64.const 42
i32.const <flags: hasValue|writable=false|enumerable=false|configurable=false>
call $__defineProperty_value
;; result: o (or trap on validation failure)
```

The flags-byte encoding stays as-is; the new bits go into a second
metadata byte if not already there.

### Edge cases

- **Symbol-keyed properties** — runtime.ts already handles Symbol
  keys via `_sidecarSet`; ensure the validation path mirrors string
  keys. Test: `defineProperty(o, Symbol.iterator, {value: fn})`.
- **TypedArray index keys** — per spec, TypedArray
  `[[DefineOwnProperty]]` has its own algorithm (canonical numeric
  string → out-of-bounds returns false). Add a TypedArray-specific
  branch.
- **Array `length` property** — `Object.defineProperty(arr, "length",
  {value: n})` truncates; non-writable length forbids further
  push/pop. Special-case in `compileObjectDefineProperty`.
- **`__proto__`** — has historic special semantics. Treat as a normal
  own property unless the receiver is a plain object literal.
- **Cross-realm descriptors** — out of scope; we don't support
  multiple realms.
- **Descriptor with both `value` and `get`** — spec rejects with
  TypeError. Validate in `compileObjectDefineProperty` before the
  runtime call.
- **Configurable: undefined vs configurable: false** — `undefined`
  in TS maps to missing field. Use `'configurable' in desc` semantics,
  not truthiness.
- **Frozen / sealed objects** — `[[Extensible]]` must be tracked
  separately on the receiver; new property creation must check it.
- **Receiver is a wasmgc struct (non-extensible by structure)** —
  cannot add new keys without sidecar fallback; ensure sidecar add
  is gated by the extensibility bit.
- **Accessor with `undefined` getter/setter** — valid; per spec a
  property with both `[[Get]]` and `[[Set]]` undefined is a no-op
  read/write.

### Test262 paths to watch

- `test/built-ins/Object/defineProperty/15.2.3.6-*` (all 6.x.x cases)
- `test/built-ins/Object/defineProperties/*`
- `test/built-ins/Object/getOwnPropertyDescriptor/*`
- `test/language/expressions/object/setter-prop-desc.js`,
  `getter-prop-desc.js`

Acceptance: reduce 262 → <50 fails for these clusters.

### Dependencies

- **#929** — currently tracks the
  `Object.defineProperty called on non-object` TypeError; that's the
  receiver-validation portion. Coordinate to avoid file conflicts on
  `src/codegen/object-ops.ts`.
- **#1325** — instanceof tag registry; orthogonal but the
  TypedArray-index branch of defineProperty uses it to detect
  TypedArrays.
- **#983** — opaque-object leak fix; once landed, simplifies
  `_wrapForHost` use in the validation path.

### Risks

- Backwards compat: the existing partial implementation passes some
  cases. The harder spec branches (#3 non-configurable validation)
  could break currently-passing tests if implemented strictly.
  Mitigation: land per-branch with test262 spot-checks, not
  monolithically.
- Performance: every property write now consults metadata. The
  fast-path (declared field, no metadata, struct.set) must remain
  metadata-free for unchanged objects.
