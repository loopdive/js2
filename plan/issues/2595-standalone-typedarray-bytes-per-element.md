---
id: 2595
title: "Standalone TypedArray BYTES_PER_ELEMENT — static CE + instance returns 0"
status: done
completed: 2026-06-22
assignee: ttraenkler/agent-typedarray-2595-2597
sprint: 65
created: 2026-06-22
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: typed-arrays
goal: standalone-mode
parent: 2159
depends_on: []
---

# Standalone TypedArray BYTES_PER_ELEMENT

## Problem

Verified on upstream/main (`--target standalone`):

```ts
Int32Array.BYTES_PER_ELEMENT          // CE: BYTES_PER_ELEMENT built-in static property value read not supported (#1907/#1888 S6-b)
new Float64Array(2).BYTES_PER_ELEMENT // compiles, but returns 0 at runtime (should be 8)
```

Both the **static** (`Int32Array.BYTES_PER_ELEMENT`) and **instance**
(`view.BYTES_PER_ELEMENT`) reads are wrong standalone. The byte sizes are
statically known per constructor name — this is a constant fold, no runtime
support needed.

## Root cause

- **Static read** hits `reportUnsupportedStandaloneBuiltinValueRead`
  (`src/codegen/property-access.ts` line ~495) — the generic standalone
  builtin-static-value-read rejection. `BYTES_PER_ELEMENT` is never special-cased
  before that fallthrough.
- **Instance read** (`view.BYTES_PER_ELEMENT`) is not intercepted in the typed
  array property block, so it falls through to a default property read on the vec
  struct → `0`.

The byte-size map **already exists** in property-access.ts as
`TYPED_ARRAY_BYTES_PER_ELEMENT` (line ~2319, used by `byteLength`).

## Implementation Plan

### Approach — constant fold both reads
Hoist `TYPED_ARRAY_BYTES_PER_ELEMENT` (or reference it) so both paths can use it.

**1. Static read — `src/codegen/property-access.ts`**
Before `reportUnsupportedStandaloneBuiltinValueRead` fires for
`<TypedArrayName>.BYTES_PER_ELEMENT`, add a special case: if the builtin name is
in `TYPED_ARRAY_BYTES_PER_ELEMENT` and `propName === "BYTES_PER_ELEMENT"`, emit
the constant (`i32.const` / `f64.const` per `ctx.fast`) and return. Gate behind
`noJsHost(ctx)` (host mode already works via the host import). This is the static
property-value-read path — locate where builtin-static reads are dispatched
(the same function that calls `reportUnsupportedStandaloneBuiltinValueRead`).

**2. Instance read — same file, the typed-array property block (~line 2309,
alongside `byteOffset`/`byteLength`)**
Add a `propName === "BYTES_PER_ELEMENT"` arm in the `if (isBuffer || isTypedArr)`
block: drop the compiled receiver, emit the per-name constant. (ArrayBuffer has
no `BYTES_PER_ELEMENT`; restrict to `isTypedArr`.)

### Wasm IR
```wasm
;; Int32Array.BYTES_PER_ELEMENT  →  (fast) i32.const 4   /  (else) f64.const 4
;; new Float64Array(2).BYTES_PER_ELEMENT  →  drop receiver; f64.const 8
```

### Edge cases
- Per-name values: Int8/Uint8/Uint8Clamped=1, Int16/Uint16=2,
  Int32/Uint32/Float32=4, Float64=8, BigInt64/BigUint64=8 (add the two BigInt
  names to the map if not present).
- Instance form must still evaluate (and drop) the receiver if it has side
  effects (`getView().BYTES_PER_ELEMENT`) — compile the receiver, then `drop`.
- `ctx.fast` vs default: return `i32` in fast mode, `f64` otherwise (match the
  `byteLength`/`byteOffset` arms' return-type convention).

### Files
- `src/codegen/property-access.ts` (both the static-builtin-read dispatch and
  the typed-array instance property block ~2309)

### Representative failing test262 paths
- `test/built-ins/TypedArrayConstructors/BYTES_PER_ELEMENT/*`
- `test/built-ins/TypedArray/prototype/BYTES_PER_ELEMENT/*`
- Many ctor tests read `TA.BYTES_PER_ELEMENT` in setup (`length`/`byteLength`
  derivations) — fixing it unblocks their assertions.

### Estimated rows
~15-40 standalone passes (direct BYTES_PER_ELEMENT tests + setup unblocks).

## Notes
Smallest/easiest slice — pure constant fold, byte-size map already present.
Substrate-independent. Good first-claim or warm-up slice. **Dispatch note**:
touches the same property-access.ts typed-array block as #2596 (.buffer); the
two arms are disjoint (different `propName`), so they can land independently but
a single dev taking both avoids a trivial merge.
