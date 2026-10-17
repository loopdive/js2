---
id: 7018
title: "standalone: TypedArray construction from values saturates instead of wrapping (`Uint8Array.of(0xda39a3ee)` → 255, `new Uint8Array([big])` → 255) and `Uint8Array.of(...u8)` emits invalid Wasm (`array.get` on a packed i8 array) — uuid's sha1/v5 and every v1 test fail"
status: done
sprint: current
created: 2026-10-16
updated: 2026-10-17
priority: medium
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: typed-arrays, ToUint8, spread
goal: standalone-gap
related: [7013]
completed: 2026-10-17
loc-budget-allow:
  # 2026-10-17 (#7018): each site gains only its call into the new
  # `ta-int-elem-coercion.ts` (the conversion, the packed `TA.of` spread builder
  # and the view-keyed read op live there); the residue is the dispatch line,
  # an import, and prettier wrapping.
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/expressions/new-builtin-globals.ts
  - src/codegen/literals.ts
func-budget-allow:
  # 2026-10-17 (#7018): same call-site lines as above, inside the existing
  # `TA.of`/`TA.from`, `new TA(arrayLike)` and array-literal spread arms.
  - src/codegen/expressions/call-builtin-static.ts::compileBuiltinStaticCall
  - src/codegen/expressions/new-builtin-globals.ts::tryCompileBuiltinGlobalNew
  - src/codegen/literals.ts::compileArrayLiteral
import-cycles-allow:
  - largestSccSize: 711 # 2026-10-17 (#7018): the new `src/codegen/ta-int-elem-coercion.ts` calls `compileExpression` and is called from the TypedArray arms, so it joins the existing codegen SCC (+1 file); its int32 lowering imports backend/wasmgc directly, so no codegen->ir edge is added.
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

(Original plan kept below. As implemented, measured on the #6718 branch, which
this work stacks on.)

- The issue's root-cause list was partly wrong: the `trunc_sat` sites it names in
  `ta-dyn-mop.ts`, `ta-dyn-proto-methods.ts` and `ta-static-from-of-body.ts` are
  INDEX/LENGTH truncations, not element conversions. The saturating element
  conversions are `coerceType(f64 → i32)` in the static `TA.of`/`TA.from` arms
  (`call-builtin-static.ts`), the `new TA(arrayLike)` copy loop
  (`new-builtin-globals.ts`) and the native `map` helper (`ta-hof-map-filter.ts`).
- `TA.of` compiled each argument with an `i32` hint, so the saturation already
  happened inside `compileExpression`; the argument is now compiled as `f64`.
- `Int16Array`/`Uint16Array` (`i16` storage) were not treated as packed by the
  `TA.of`/`TA.from` arm at all (`storeWasm` was the packed kind itself).
- The spread in `TA.of(…, ...u8)` went through the array-literal builder, which
  both built a `vec<i32>` (not the view's carrier) and read the packed source
  with plain `array.get`.

Original plan:

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

## Resolution

New module `src/codegen/ta-int-elem-coercion.ts`:

- `emitTaIntElemConversion` / `taIntElemConversionInstrs`: f64 → exact ToInt32
  bit pattern via the existing `emitToInt32` (the packed `array.set` keeps the
  low 8/16 bits, which IS ToInt8/ToUint8/ToInt16/ToUint16; ToUint32/ToInt32 are
  the bit pattern), `emitToUint8Clamp` for `Uint8ClampedArray`.
- `tryEmitPackedTaOfWithSpread`: `TA.of(a, ...xs, b)` for packed/`i32_elem`
  storage — arguments evaluated left to right into locals, spreads read with
  their own view's `array.get_s`/`_u`, result built directly in the view's
  carrier. Declines (rolled back) when a spread does not lower to a native vec.
- `wrapF64ToInt32Instrs` for the fctx-free `map` helper; `taSourceGetOp` /
  `taSpreadGetOp` pick `get_s`/`get_u` from the SOURCE view name (signed and
  unsigned views share i8/i16 storage) — this also fixes `new Uint16Array(i8)`
  and `Uint16Array.from(i8)` reading a signed source zero-extended.
- The array-literal spread loop (`[...u8]`) now reads packed sources with
  `get_s`/`get_u` instead of emitting invalid Wasm.

Standalone/WASI only by construction: the JS-host lane stores every numeric
view as `f64`, so none of the packed branches are reachable there. Verified:
gc binaries of the probe fixtures hash identically on base and fix.

Tests: `tests/issue-7018-typedarray-construction-wrap.test.ts` — boundary values
(2³¹, 2³², −1, 1e20, NaN, −0, 300, −129, 65537, 0xda39a3ee, ±1.7, 255.5, ±∞)
through `of` / `from` / `new X(array)` / `new X(any[])` / `.map` for every
integer view, plus the spread shapes, each compared to the JS engine's answer.
Fails on the parent (saturated rows; spread module fails validation), passes
with the fix.

uuid standalone (`JS2WASM_UPSTREAM_TARGET=standalone`): 41/75 → 50/75. The
remaining 25 are `crypto is not defined` (no secure randomness provider in a
standalone module, by design) and 4 "throws RangeError for out-of-range indexes"
that reach the same RNG first.
