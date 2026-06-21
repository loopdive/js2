---
id: 2199
title: "Standalone DataView accessor bounds validation — get/set must throw RangeError, not trap OOB"
status: done
sprint: 64
created: 2026-06-18
updated: 2026-06-18
completed: 2026-06-18
assignee: ttraenkler/sdev-iter
priority: medium
feasibility: medium
reasoning_effort: high
task_type: conformance
area: standalone
language_feature: dataview-arraybuffer
goal: standalone-mode
parent: 2159
---

# Standalone DataView accessor bounds validation

## Problem

On standalone (`--target wasi`), the native DataView accessors trap instead of
throwing the spec-mandated **RangeError**:

```ts
const dv = new DataView(new ArrayBuffer(10));
dv.getFloat64(-1);        // standalone: TRAP "array element access out of bounds"
dv.getFloat64(Infinity);  // standalone: TRAP        (both should throw RangeError)
dv.getInt32(8);           // 8+4>8 OOB: TRAP          (should throw RangeError)
```

A Wasm trap is uncatchable, so the test262
`built-ins/DataView/prototype/<accessor>/detached-buffer-after-toindex-byteoffset.js`
cluster (~59 tests) — which `assert.throws(RangeError, …)` on a negative /
`Infinity` `byteOffset` — all fail.

## Root cause

`emitDataViewAccessor` (`src/codegen/dataview-native.ts`) computed
`trunc(byteOffset) + base` and immediately read/wrote the backing i32-byte
array with **no argument validation** — no `ToIndex` RangeError check and no
`getIndex + elementSize > viewByteLength` bounds check.

## Fix (§24.2.1.1 GetViewValue / §24.2.1.2 SetViewValue)

Additive guard prologue in `emitDataViewAccessor`, all standalone-native (zero
new host imports):

- New `emitDataViewRangeError(ctx)` — builds a catchable RangeError throw via the
  shared `$exc` tag + the in-module `__new_RangeError` constructor
  (`emitWasiErrorConstructor` in no-JS-host mode), mirroring `native-regex.ts`'s
  `regexCapExhaustionThrow`. Pre-built + flushed BEFORE any operand compile so the
  late-import funcIdx shift doesn't corrupt later captures.
- `recoverDvBacking` gains a `viewLenLocal` out-param: the view's byte length —
  the `$__dv_window.byteLength` field for a windowed view, or `array.len(data)`
  for a bare offset-0 view.
- The accessor captures the **f64** request, derives `getIndex =
  i32.trunc_sat_f64_s(req)`, and throws RangeError when
  `isNaN(req) || getIndex < 0 || (getIndex + elementSize) > viewByteLength`
  (the last computed in i64 so the `trunc_sat(+Infinity)=i32.MAX` case can't
  overflow). Valid accesses are byte-identical to before.

### Follow-ups

- **Setter `ToNumber(value)` ordering** — §24.2.1.2 evaluates `ToNumber(value)`
  BEFORE the bounds throw; this PR threw before compiling the setter value, so a
  side-effecting value was skipped on an out-of-bounds set. **Fixed in #2199b**
  (split the guard into index-throw → value compile → bounds-throw).
- **Detached-buffer TypeError (§24.2.1.1 step 7)** — NOT addressed here and a
  separate, larger slice: standalone has **no detached-ArrayBuffer
  representation** at all (`ArrayBuffer.prototype.transfer` does not detach the
  source — `ab.byteLength` stays non-zero, no detached-flag exists). A
  detached-TypeError guard would need (a) a detached-flag field on the
  ArrayBuffer i32-byte vec struct, (b) `transfer()`/`$DETACHBUFFER` setting it,
  (c) a TypeError guard in the accessor prologue (after ToIndex's RangeError).
  The targeted `…-after-toindex-byteoffset` cluster does NOT exercise it (ToIndex
  RangeError fires first), so it's intentionally left for a follow-up issue.

## Test Results

- `tests/issue-2199-dataview-bounds.test.ts` — 11/11 green (`target: "standalone"`,
  zero host imports asserted): getFloat64(-1)/(Infinity), getUint8(100),
  getInt32(5)-on-8, setUint8(-1), setFloat64(100), windowed out-of-window all
  throw RangeError; regression guards — last-valid-offset, round-trips, LE,
  windowed valid read/write — unchanged.
- Existing DataView suites (issue-38-dataview-window, issue-2159,
  arraybuffer-dataview, issue-1654-wasi-dataview-arraybuffer) — unchanged.
- `pnpm run check:ir-fallbacks` — OK. `npx tsc --noEmit` clean.

## Source

Harvest of the standalone failure buckets (2026-06-18, sdev-iter): the DataView
detached-buffer cluster's headline is the missing ToIndex/bounds RangeError.
