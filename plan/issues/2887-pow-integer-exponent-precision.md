---
id: 2887
title: "Runtime `**` / `**=` / Math.pow imprecise for integer exponents (3**3 → 26.99…)"
status: done
sprint: current
priority: medium
horizon: s
area: codegen
language_feature: exponentiation-operator
assignee: ttraenkler/explore5
completed: 2026-06-30
---

## Problem

The runtime `Math_pow` Wasm helper (`src/codegen/math-helpers.ts`,
`buildPowBody`) — used by the `**` operator, the `**=` compound assignment, and
`Math.pow` — computed `base ** exp` via the generic `exp(exp * log(base))`
approximation **even for integer exponents**. That path is ~1 ULP low for
non-power-of-two integer results:

```
3 ** 3   → 26.999999999461526   (should be 27)
5 ** 3   → 124.99999999999974   (should be 125)
10 ** 3  → 999.999999999998     (should be 1000)
```

The error was masked for compile-time-constant operands (those are
constant-folded to an exact `f64.const`), so it only surfaced for **runtime**
operands. It became _visibly_ wrong for `**=` on an integer-typed local: the
compiler stores such a local as `i32`, so the imprecise f64 result is truncated
by `i32.trunc_sat_f64_s`:

```
var base = -3; base **= 3;   // → -26  (should be -27)
```

ECMA-262 §13.6 (exponentiation) / §21.3.2.26 (`Math.pow`) defines the result via
the abstract operation **Number::exponentiate**. While the spec permits
implementation-approximated results for irrational cases, test262 hard-codes the
exact integer results (e.g. `language/expressions/exponentiation/exp-assignment-operator.js`
asserts `(base **= 3) === -27`), and the conformance oracle (V8) returns exact
integers for integer exponents via its `power_double_int` fast path.

## Root cause

`buildPowBody` special-cased `exp ∈ {0, 1, -1, 0.5, 2}` and the
base ∈ `{0, ±1, ±Infinity}` cases, but **every other integer exponent fell
through to `exp(exp * log(base))`** (and the negative-base branch did the same
with `|base|` + an odd/even sign flip). No exact integer path existed.

## Fix

Add an exact **exponentiation-by-squaring** fast path to `buildPowBody`, reached
after the existing special-value early-returns. It applies when the exponent is
an integer that fits an i32 loop counter (`trunc(exp) == exp && |exp| < 2^31`):

```
res = 1; b = base; n = |exp| (i32)
while (n) { if (n & 1) res *= b; b *= b; n >>= 1; }
if (exp < 0) res = 1 / res
return res
```

This mirrors V8's `power_double_int` and is **exact** for integer base/exponent
within f64 range. Repeated multiplication carries the sign of a negative base
correctly (no separate odd/even negation), and overflows to ±Inf / underflows to
±0 the same way the generic path would for huge exponents. `±Infinity` and
`|exp| ≥ 2^31` exponents skip the fast path (`|exp| < 2^31` is false) and keep
the original `exp(exp * log|base|)` behaviour — important because `trunc(±Inf) ==
±Inf`, so e.g. `Math.pow(-1.5, Infinity) === +Infinity` (not NaN). Fractional
exponents (`base ** 0.5` aside, which is special-cased to `f64.sqrt`) keep the
generic approximation.

Files: `src/codegen/math-helpers.ts` (`buildPowBody` + 3 added locals
`powRes`/`powBase`/`powN`).

## Acceptance

- `3 ** 3 === 27`, `5 ** 3 === 125`, `10 ** 3 === 1000`, `(-3) ** 3 === -27` at
  runtime (non-folded operands).
- `base **= 3` exact for integer-typed locals.
- No regression in the `Math.pow` special-value suite
  (`applying-the-exp-operator_A5/A6/A9/A10`, ±Infinity exponents, negative base).
- Negative base + non-integer exponent → NaN; fractional exponents unchanged.

## Test Results

`tests/issue-2887.test.ts` — 5/5 pass. Comprehensive 33-case check vs JS
`Math.pow` (integer, negative, fractional, NaN, ±Inf, ±0 bases/exponents) — all
match.
