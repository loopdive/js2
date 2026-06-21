---
id: 2199b
title: "Standalone DataView setter operation order — ToNumber(value) before the bounds RangeError"
status: done
sprint: 64
created: 2026-06-18
updated: 2026-06-18
completed: 2026-06-18
assignee: ttraenkler/sdev-iter
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: dataview-arraybuffer
goal: standalone-mode
parent: 2199
depends_on: [2199]
---

# Standalone DataView setter operation order

## Problem

#2199 added a single combined bounds guard to the DataView accessors, but it
threw the bounds RangeError **before** compiling the setter `value`. §24.2.1.2
SetViewValue splits into two throw points around `ToNumber(value)`:

```
step 4  getIndex = ToIndex(byteOffset)               -> RangeError (index)  BEFORE value
step 5  numberValue = ToNumber(value)                   (value.valueOf runs here)
step 8  getIndex + elementSize > viewByteLength       -> RangeError (bounds) AFTER value
```

So an out-of-bounds set must still RUN the value's `valueOf` (and propagate a
throw from it) before the bounds RangeError fires — ~35 standalone-failing
test262 cases (`DataView/prototype/set*/{return-abrupt-from-tonumber-value,
range-check-after-value-conversion,index-check-before-value-conversion,…}`).

## Fix

`emitDataViewAccessor` (`src/codegen/dataview-native.ts`) — split the single
guard into `emitIndexThrow()` (NaN/negative, ToIndex) and `emitBoundsThrow()`
(`getIndex + elementSize > viewLen`, i64 math). Order:

- **Getter** (no value): `emitIndexThrow()` then `emitBoundsThrow()` adjacent
  (byte-identical to #2199's combined behaviour).
- **Setter**: `emitIndexThrow()` → compile `value` (+ `littleEndian`) →
  `emitBoundsThrow()` → write. The value/littleEndian coercions now run their
  side effects after the index check but before the bounds check, matching the
  spec.

Additive same-file reorder, zero new host imports.

### Out of scope (pre-existing, verified on the #2199 base)

- An object-literal value with a throwing `valueOf` (`dv.setInt16(0,
  {valueOf(){throw}})`) hits a separate `expected f64` object→f64 coercion gap —
  fails identically on the #2199 base, not introduced here.
- BigInt setters (`setBigInt64`/`setBigUint64`) are an unsupported-feature gap.

## Test Results

- `tests/issue-2199b-dataview-setter-order.test.ts` — 8/8 green (`target:
  "standalone"`, zero host imports): OOB-set runs value side-effect + still
  throws RangeError; negative-index set throws WITHOUT running the value; valid
  round-trips, last-valid-offset, getter-OOB, setter-OOB unchanged.
- `tests/issue-2199-dataview-bounds.test.ts` (the #2199 parent) + DataView
  regression suites — unchanged.
- `pnpm run check:ir-fallbacks` OK; `tsc` + prettier clean.

## Source

Deferred edge from #2199 (the targeted detached-buffer cluster didn't exercise
setter value-ordering); picked up as a same-file follow-up (2026-06-18, sdev-iter).
