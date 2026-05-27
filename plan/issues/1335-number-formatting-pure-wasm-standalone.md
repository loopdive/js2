---
id: 1335
title: "Number.prototype formatting in pure Wasm: integer toString(radix), then Ryu for floats (standalone)"
status: ready
created: 2026-05-08
updated: 2026-05-08
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, runtime
language_feature: number-formatting
goal: standalone-mode
sprint: 50
parent: 1321
---
# #1335 — Number.prototype formatting in pure Wasm (standalone-mode follow-up)

Carved out of #1321. The host-mode bug fix in #1321 made `(255).toString(16)` return `"ff"` instead of `"255"` (and similar for all non-decimal radices), but it still goes through a 2-arg JS host import. Standalone (`--target wasi`) programs that format numbers still fall back / fail.

This issue is the larger pure-Wasm impl that #1321 explicitly deferred. It's split into two phases because float→string is a research-grade algorithm.

## Phase 1: integer + special cases

Add a Wasm helper `__number_toString_radix(f64 value, f64 radix) → externref` that handles:

- `NaN` → `"NaN"`
- `+Infinity` → `"Infinity"`
- `-Infinity` → `"-Infinity"`
- `±0` → `"0"`
- finite integer fitting in i64, radix 2–36 → emit base-N digit loop in Wasm (see algorithm below)
- otherwise (non-integer float, or out-of-i64-range integer) → fall back to existing 2-arg `number_toString_radix` host import (#1321), or trap in standalone mode

Algorithm for integer base-N (idiomatic):
```
let n = abs(value);  // i64
let digits = [];
while (n > 0) {
  let d = n % radix;
  let c = d < 10 ? '0' + d : 'a' + d - 10;
  digits.push(c);
  n = n / radix;
}
if (sign < 0) digits.push('-');
reverse(digits);
build string
```

The string-building is mode-dependent: `wasm:js-string` uses `string.from_char_code_array`; `nativeStrings` uses an i16-array literal. Look at `compileStringLiteral` for the existing patterns.

LOC estimate: ~200 lines in `src/codegen/expressions/builtins.ts` for the helper, ~30 lines in `calls.ts` to wire the call.

## Phase 2: Ryu for float→shortest-round-trip-string

For non-integer floats, port [Ryu](https://github.com/ulfjack/ryu) (Adams 2018) into Wasm. Ryu is the modern replacement for Grisu2/Dragon4 — single algorithm, formal correctness proof, no fallback path needed.

Reference impl: ~1000 lines of C. Wasm port: ~1500 lines (no UB, explicit i64 ops). Well-tested test262 harness will catch any rounding bugs.

Once Ryu lands, both `toString()` (no radix) and `toString(radix)` for non-integer values run in pure Wasm. `toFixed` / `toPrecision` / `toExponential` build on top of Ryu's intermediate digit table.

## Why split

Phase 1 is tractable for a single dev (all integer arithmetic, no algorithm research). Phase 2 needs deep algorithm work and benefits from senior-developer attention. Splitting lets Phase 1 unblock the most common standalone use case (integer numbers in printed output) without waiting for Phase 2.

## Acceptance criteria — Phase 1

- `(255).toString(16)` works in standalone (`--target wasi`) mode
- `NaN`, `±Infinity`, `±0` constants work in standalone
- No regression in JS-host-mode pass rate

## Acceptance criteria — Phase 2

- All `test/built-ins/Number/prototype/{toString,toFixed,toPrecision,toExponential}/` tests pass without JS host (currently 121/138 pass via host)
- Round-trip property: `Number(n.toString()) === n` for all finite floats

## Related

- Parent #1321 — host-mode bug fix (DONE: radix is now passed through 2-arg import)
- #682 — standalone regex backend (separate concern, similar dual-mode pattern)
- ECMA-262 §21.1.3.6 — toString
- ECMA-262 §21.1.3.3 — toFixed
- ECMA-262 §21.1.3.5 — toPrecision
- ECMA-262 §21.1.3.2 — toExponential
- Ulf Adams, "Ryu: Fast Float-to-String Conversion" (PLDI 2018)

## Progress — toFixed / toPrecision / toExponential standalone (PR for #1321 task)

`Number.prototype.{toFixed,toPrecision,toExponential}` now have a pure-Wasm
standalone path. New module `src/codegen/number-format-native.ts` emits
WasmGC-native `number_toFixed` / `number_toExponential` / `number_toPrecision`
functions (registered under the same `ctx.funcMap` names) when
`ctx.wasi || ctx.standalone`, instead of the `env` host imports. Wired in
`src/codegen/declarations.ts` (mirrors `emitNativeParseNumber` #1663). Also
fixed a latent standalone bug: the four `Number#to*` call-site RangeError
throws in `expressions/calls.ts` used `global.get <strIdx>` (externref-global
semantics) which emits `global.get -1` in nativeStrings mode — switched to
`stringConstantExternrefInstrs` (dual-mode helper).

Algorithm uses scaled f64 digit extraction (no Ryu). Exact for the common
range (fractionDigits / precision ≲ 15 significant digits); for extreme
requests (e.g. `(7.7).toFixed(20)`) it returns the f64-rounded value rather
than V8's exact-binary bignum expansion. Tests: `tests/issue-1321-standalone.test.ts`.

**Still open for #1335**: integer `toString(radix)` standalone (Phase 1) and
full Ryu/bignum float→shortest-string + exact-low-digit formatting (Phase 2).
