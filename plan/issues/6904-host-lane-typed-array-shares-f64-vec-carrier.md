---
id: 6904
title: "Host-lane TypedArrays share the `__vec_f64` carrier with `number[]`: `Array.isArray(u8)` is true and `new Uint8Array([…]).buffer` is empty (hono encode 40/44, buffer 7/10)"
status: ready
sprint: current
created: 2026-10-07
updated: 2026-10-07
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
goal: dogfood
related: [4360, 6728]
---

## Problem

On the JS-host lane a `Uint8Array` (and every other TypedArray except the
packed-byte constructions) lowers to `__vec_f64` — the same struct type as
`number[]` (`TYPED_ARRAY_NAMES` comment in `src/codegen/index.ts`). Two hono
clusters follow from that, measured 2026-10-07 on upstream main (`e7760d1c2a`):

1. **encode.test.ts 40/44** — the four `decode` rows whose expected value is
   `new TextEncoder().encode(…)`. The host `Uint8Array` is coerced into a
   `__vec_f64` copy at the row literal, so `__upstreamSame` sees
   `Array.isArray(want) === true` against a byte-carrier `got` and fails.
   Reduced: `function isArr(x: any) { return Array.isArray(x); }` answers
   `true` for `new Uint8Array(3)` and for a typed `enc(): Uint8Array` result.
   The static arm (`Array.isArray(decodeBase64(s))`) also answers `true`
   because `isArrayCarrierValType` accepts `__vec_f64`.
2. **buffer.test.ts "ArrayBuffers with different content"** —
   `new Uint8Array([1,2,3,4]).buffer.byteLength` is `0` and
   `new DataView(u.buffer).getUint8` is "not a function", so `equal()` never
   compares a byte.

## Implementation Plan

1. Give host-lane TypedArray values a nominal carrier distinct from `__vec_f64`
   (a final subtype or brand of the byte/element vec, the same discriminator the
   standalone `collectStandaloneArrayCarrierTypeIdxs` exclusions use), so both
   the static `isArrayCarrierValType` arm and the finalize-filled
   `__host_array_carrier` predicate can exclude it.
2. Back `.buffer` of an array-literal-constructed TypedArray with real byte
   storage (or materialize a host `ArrayBuffer` view at the `.buffer` read).
3. Measure test262 `built-ins/Array/isArray`, `built-ins/TypedArray*`,
   `built-ins/DataView` on both lanes base vs fix.

Expected: hono encode 40/44 → 44/44, buffer +1. The two buffer rows failing
`Response is not defined` under `DOGFOOD_PLATFORM: "node"` are a separate
platform-adapter question (Node 22 has a global `Response`).
