---
id: 1936
title: "% operator loses precision and returns Infinity/0 for extreme operand ratios (a - trunc(a/b)*b is not fmod)"
status: ready
sprint: 61
created: 2026-06-10
updated: 2026-06-10
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arithmetic
goal: core-semantics
related: [216, 1825]
origin: "2026-06-10 deep-audit sweep (coercion agent): verified miscompile on main"
---

# #1936 — `%` is compiled as `a - trunc(a/b)*b`, which is not IEEE fmod

## Problem

JS `%` ([§13.7 / Number::remainder](https://tc39.es/ecma262/#sec-numeric-types-number-remainder))
is the *exact* mathematical remainder (IEEE fmod). The emitted formula
`a - trunc(a/b)*b` (+ `f64.copysign`) has three rounding steps and:

- drifts by ULPs whenever `a/b` rounds,
- collapses to `0` when `trunc(a/b)*b` rounds to `a`,
- when `a/b` overflows f64 (ratio ≳ 1e308) produces `Inf*b - a → ±Infinity` —
  a categorically wrong value from core arithmetic.

## Repro (verified on main)

```ts
export function mod(a: number, b: number): number { return a % b; }
```

| call | wasm | node |
|------|------|------|
| `0.7 % 0.1` | `0.09999999999999987` | `0.09999999999999992` |
| `81.3 % 0.1` | `0.09999999999999432` | `0.09999999999999265` |
| `1e308 % 1e-308` | `Infinity` | `3.498445546245627e-309` |
| `1e16 % 0.0001` | `0` | `0.00008263976140706314` |
| `123456789.123 % 0.001` | `0` | `0.000999993376923471` |
| `1e300 % 1e-300` | `Infinity` | `4.891554850853602e-301` |

## Root cause

`src/codegen/binary-ops.ts:2678-2722` `emitModulo` computes
`a - trunc(a/b)*b` with `f64.copysign(., a)`. #216 only patched
`x % Infinity` and `-0 % x` on this same formula.

## Fix direction

Implement true fmod: either a JS-host `__fmod` import with a Wasm-native
fallback loop (exponent-aligned subtraction, the classic fmod algorithm —
~20 instructions, no host needed), or at minimum guard the `a/b`-overflow case
and iterate the correction step until `|r| < |b|`. Per dual-mode policy, the
Wasm-native fmod must exist for standalone; the host import is an optional
fast path.

## Acceptance criteria

- All six repro cases match Node bit-for-bit
- Existing #216 edge cases (`x % Infinity`, `-0 % x`, `x % -x`) stay correct
- i32 fast-path `%` (both operands provably i32) unchanged
- Works in standalone mode (no host requirement)

## Dupe check

Grepped `emitModulo`, `fmod`, `modulo`, `remainder` — #216 (done;
Infinity/-0 edge cases only), #1825 (i32 fast-mode rem traps, done).
Precision/overflow not covered anywhere.
