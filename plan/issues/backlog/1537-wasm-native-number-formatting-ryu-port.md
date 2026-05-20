---
id: 1537
sprint: backlog
title: "Wasm-native number formatting (Ryū port): toString/toFixed/toPrecision/toExponential"
status: backlog
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: runtime
language_feature: number
goal: standalone-wasm
related: [1535]
---

# #1537 — Wasm-native number formatting (Ryū)

## Problem
Five host imports — `number_toString`, `number_toString_radix`, `number_toFixed`, `number_toPrecision`, `number_toExponential` — bridge to `Number.prototype.*` on the JS host. Standalone mode (WASI) cannot stringify a number; this affects `console.log(123.456)`, any string interpolation involving a number, JSON output, and dozens of test262 categories.

## Proposed solution
Port the Ryū algorithm (Adams 2018, "Printing Floating-Point Numbers Quickly and Accurately") to a Wasm-native helper module. Ryū produces the shortest decimal string that round-trips to the same f64.

Layers:
1. **Core**: `__num_to_str_ryu(f64) -> (ptr_to_native_string)` — emits the shortest-roundtrip string.
2. **`Number.prototype.toString()`** (no-arg): direct Ryū output with the ECMA-262 §6.1.6.1.13 rules (negative-sign handling, NaN/Infinity sentinels).
3. **`Number.prototype.toString(radix)`**: for radix ∈ [2,36] and integer values, do a digit-by-digit conversion (1 KB hand-written); for fractional + non-10 radix, use the long-division algorithm from the spec.
4. **`toFixed(digits)`**: round to `digits` decimal places using Ryū's intermediate representation, then format.
5. **`toPrecision(p)`**: choose fixed vs exponential based on magnitude (spec §21.1.3.5).
6. **`toExponential(d)`**: Ryū output reformatted as `D.DDDe±DD`.

## Library/approach
Reference: `dtolnay/ryu` (Rust) — public-domain port of the C reference. Variant `ryu-ecmascript` matches ES output exactly. Algorithm description in Adams' paper is public.

We do **not** depend on the Rust crate at runtime — we re-implement the algorithm directly in `src/codegen/number-helpers.ts` (parallel to `math-helpers.ts`).

## Binary size impact
+8-12 KB Wasm. Includes a precomputed power-of-10 lookup table (~2 KB) and the formatting state machine.

## Test262 impact (estimated)
Number-stringification appears in ~5-8% of failing test262 tests. Estimate **+200-400 passes** in standalone mode and a smaller boost in JS-host mode (the host already does this correctly).

## Implementation steps
1. Create `src/codegen/number-helpers.ts` with `emitInlineNumberFormatters(ctx)` modeled on `emitInlineMathFunctions`.
2. Emit `__num_to_str_ryu` as a Wasm function operating over a native i16-string buffer.
3. Emit thin wrappers `number_toString`, `number_toString_radix`, `number_toFixed`, `number_toPrecision`, `number_toExponential` that take f64 args and return `arrayref (mut i16)` (native string).
4. Gate registration in `src/codegen/declarations.ts` (`primitiveNeeded` set) on `ctx.nativeStrings || ctx.wasi`. Keep host import path for non-native-strings mode for now.
5. Test against test262 `built-ins/Number/prototype/toString`, `toFixed`, `toPrecision`, `toExponential` suites.
6. Verify boundary cases: `-0`, `NaN`, `±Infinity`, `1e21` (engineering threshold), subnormals.

## Risk
ECMA-262 has subtle rules for the shortest-roundtrip boundary (§6.1.6.1.13 step 5) — test262 has ~50 tests dedicated to these edge cases. Use `ryu-ecmascript` as the cross-check oracle.
