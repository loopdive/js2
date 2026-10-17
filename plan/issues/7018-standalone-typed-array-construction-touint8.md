---
id: 7018
title: "standalone: TypedArray construction from values saturates instead of wrapping (`Uint8Array.of(0xda39a3ee)` → 255, `new Uint8Array([big])` → 255) and `Uint8Array.of(...u8)` emits invalid Wasm (`array.get` on a packed i8 array) — uuid's sha1/v5 and every v1 test fail"
status: ready
sprint: current
created: 2026-10-16
updated: 2026-10-16
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: typed-arrays, ToUint8, spread
goal: standalone-gap
related: [7013]
---

# TypedArray construction: ToUint8 saturation and packed-array spread

Found by the [#7013](./7013-standalone-upstream-unit-lane.md) standalone
upstream unit lane (uuid: 16 of 75 tests).

## Repro (standalone)

```ts
function big(): number { return (0x5a39a3ee + 0x80000000) >>> 0; }      // 0xda39a3ee
export function t1(): number { const b = new Uint8Array(1); b[0] = big(); return b[0]; }  // 238 ✓
export function t2(): number { return Uint8Array.of(big())[0]; }                           // 255 ✗ (node 238)
export function t4(): number { const a: any[] = [big()]; return new Uint8Array(a)[0]; }   // 255 ✗
const node = Uint8Array.of(0x9f, 0x68);
export function t5(): number { return Uint8Array.of(1, ...node)[1]; }   // COMPILE: "array.get: Immediate array type N has packed type i8. Use array.get_s or array.get_u"
```

uuid's `sha1` ends `return Uint8Array.of(H[0] >> 24, …, H[0], …)` with
`H[i] >>> 0` values ≥ 2³¹, so every byte taken from a raw `H[i]` reads `0xff`
(`da39a3ff…` instead of `da39a3ee…`). `v1.test.ts` builds
`Uint8Array.of(…, ...RFC_OPTIONS.node)` at module scope, so the whole file
fails validation in `__module_init_chunk_1`.

## Root cause

- Saturation: the construction paths convert each element with
  `i32.trunc_sat_f64_s` before the packed `array.set` — `src/codegen/ta-static-from-of-body.ts:269`,
  `src/codegen/ta-dyn-mop.ts:101,1571`, `src/codegen/ta-dyn-proto-methods.ts:949`,
  `src/codegen/ta-hof-map-filter.ts:248,289`. Saturating truncation clamps
  values ≥ 2³¹ to `0x7fffffff`, whose low byte is `0xff`. ToUint8/ToInt8/
  ToUint16/ToInt32 (§7.1.6–§7.1.11) are modulo 2ⁿ. The element-store path
  (`b[i] = v`) already wraps correctly — reuse its conversion.
- Invalid Wasm: spreading a TypedArray into `%TypedArray%.of` reads the
  source's packed storage with plain `array.get` instead of `array.get_u`/`_s`.

## Implementation Plan

1. Find the conversion the indexed store uses (`grep -rn "ToInt32\|to_int32" src/codegen`
   around the TypedArray element-set emitter) and expose it as one helper
   (`emitToIntegerModulo(ctx, fctx, bits, signed)`: NaN/±Inf → 0, else
   `i64.trunc_sat_f64_s` + `i32.wrap_i64`, exact for |x| < 2⁶³ and correct
   modulo 2³² beyond after an `f64` `fmod 2^32` pre-step).
2. Replace the `i32.trunc_sat_f64_s` element conversions listed above with the
   helper (Uint8Clamped keeps its own clamp).
3. Fix the spread read in the `of` / ctor-from-iterable path to emit
   `array.get_u`/`array.get_s` per the source element type
   (find with `grep -rn "array.get\"" src/codegen/ta-static-from-of-body.ts src/codegen/ta-dyn-mop.ts`).
4. Tests: repros t2/t4/t5 plus Int8/Uint16/Int16/Uint32 boundary values
   (2³¹, 2³², −1, 1e20, NaN, −0) through `of`, `from`, `new X(array)`, and
   `.map`.
5. Scoped standalone test262 `built-ins/TypedArray`, `built-ins/TypedArrayConstructors`
   base vs fix.

## Acceptance

uuid standalone: sha1/v5 hash tests and all of `v1.test.ts` pass; gc binaries
byte-identical.
