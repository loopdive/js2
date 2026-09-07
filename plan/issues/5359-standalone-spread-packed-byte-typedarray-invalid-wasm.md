---
id: 5359
title: "standalone/wasi: spreading a packed-byte TypedArray emits invalid wasm (array.get on a packed array, and the element is dropped)"
status: ready
sprint: current
created: 2026-09-06
updated: 2026-09-06
priority: high
horizon: m
feasibility: medium
model: opus
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: spread
es_edition: ES2015
goal: standalone-mode
requested_by: ttraenkler/opus
related: [5349, 2835, 2593, 2934]
---

## Problem

`[...u]` where `u` is a `Uint8Array` / `Int8Array` / `Uint8ClampedArray` emits a
module that **fails WebAssembly validation** on `--target standalone` and
`--target wasi`. It is not a wrong answer or a refusal — the binary is rejected
by the engine, so the whole program is dead.

```js
export function test() {
  var u = new Uint8Array([1, 2, 3]);
  return [...u].length;
}
```

```
standalone: INSTANTIATE_FAIL: WebAssembly.instantiate(): Compiling function #50:"test"
  failed: array.get: Immediate array type 10 has packed type i8.
  Use array.get_s or array.get_u instead.
wasi:       VALIDATE_FAIL: same diagnostic
host:       validates (the packed byte storage is gated on `wasi || standalone`)
node 22:    3
```

Two defects at the same site, both visible in the emitted WAT of the spread copy
loop (`.tmp/r2/spread.wat`, `$test`):

```wat
local.get 8            ;; destination externref array
local.get 9            ;; destination index
local.get 7
struct.get 45 1        ;; source vec's `data`  ->  (ref null $__arr_i8_byte)
local.get 10           ;; source index
array.get 10           ;; (1) INVALID: type 10 = $__arr_i8_byte = (array (mut i8))
drop                   ;; (2) the element it just read is DISCARDED
ref.null extern        ;;     and a null is stored in its place
array.set 1
```

1. `array.get` on a packed `(array (mut i8))` is invalid Wasm; the packed
   carriers require `array.get_u` (unsigned for the byte views) — the same rule
   `vec-access-exports.ts` L1170 and `dataview-native.ts` L2608/L2646 already
   observe with an `isPackedByte` branch.
2. Even with the load fixed, the loop `drop`s the loaded value and stores
   `ref.null extern`, so the spread would produce `[null, null, null]` rather
   than `[1, 2, 3]`. Both have to be fixed together for the program to answer.

## Measured answers

Compiler API via `npx tsx` (`compile(src, { target, allowJs: true,
skipSemanticDiagnostics: true })`), oracle node 22. Harness
`.tmp/r2/t16narrow.mts`, run on this branch and on the pre-change base tree
(`.tmp/r2/m0`, = merge commit `3894c2d7f1`) — **byte-for-byte the same verdicts
on both, so this is pre-existing and independent of #5349's brand.**

| program                                              | standalone | node 22 |
| ---------------------------------------------------- | ---------- | ------- |
| `for (var j in u) k++` alone                         | 3          | 3       |
| `[...u].length` alone                                | **INVALID** | 3      |
| `for-in` + `[...u]`                                  | **INVALID** | 303    |
| `for-of` + `[...u]`                                  | **INVALID** | 360    |
| `for-of` + `for-in` (no spread)                      | 63         | 63      |
| `for-of` + `for-in` + `[...u]` (the original t16)    | **INVALID** | 363    |
| `[...u]` over an **`Int8Array`**                     | **INVALID** | 303    |
| `[...u]` over an **`Int32Array`**                    | 303        | 303     |

Spread is the sole trigger: every row containing `[...u]` over a packed-byte
view is invalid, every row without it runs, and an `Int32Array` spread (element
array `(array (mut i32))`, not packed) is fine. `for-in` is **not** implicated —
the round-2 plan for #5349 attributed this to "for-in + spread" from the
composite t16 probe; narrowing it here shows for-in alone is correct and the
composite only looked that way because it also contained a spread.

Not checked, likely in scope for whoever picks this up: `Int16Array` /
`Uint16Array` (element array `(array (mut i16))` — also packed, so probably the
same defect with `array.get_s` / `array.get_u` respectively), and spread in
argument position (`f(...u)`) and in array-literal-with-other-elements position.

## Repro

`/home/user/js2/.tmp/w5/i8brand/p/t16.js` is the original composite probe; the
minimal one is the four-line program at the top of this issue.

## Acceptance criteria

- `[...u]` over `Uint8Array` / `Int8Array` / `Uint8ClampedArray` produces a
  module that validates and answers node's value, on `--target standalone` and
  `--target wasi`, with `result.imports` still `[]` on standalone.
- The same for `Int16Array` / `Uint16Array` (sign-extending with `array.get_s`
  for the signed view), or an explicit measurement showing they were already
  correct.
- The `Int32Array` spread row (303) and the `for-in` / `for-of` rows above are
  unmoved.
- A pin in `tests/` covering at least the minimal repro and one signed packed
  view.
