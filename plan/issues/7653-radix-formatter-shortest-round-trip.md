---
id: 7653
title: "Native `Number.prototype.toString(radix)` body: shortest round-trip digits for fractions, and integers above 2^53 − 1"
status: backlog
sprint: Backlog
created: 2026-11-28
updated: 2026-11-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
goal: core-semantics
depends_on: []
related: [7350]
---

# #7653 — the radix formatter: shortest round-trip digits, and integers above 2^53 − 1

## Problem

`__sh_num_toString_radix` (`src/stdlib/number-format.ts`, `TOSTRING_RADIX_SOURCE`) is the native body of
`Number.prototype.toString(radix)` for a radix other than 10. It differs from the spec (§21.1.3.6, which leaves the
digit count implementation-approximated but must round-trip) and from V8 in two ways:

1. **Fractions in a radix that is not a power of two.** It prints up to 100 fractional digits
   (`digit = floor(frac · r)` until the remainder is exhausted). V8 prints the shortest digit string that reads back
   to the same double.
2. **Integers above 2^53 − 1.** It calls `__num_fmt_trap()` (an uncatchable trap) for any integer part above
   `MAX_SAFE_INTEGER`, where JavaScript returns digits.

Integers up to 2^53 − 1, ±0, NaN and ±Infinity agree with node in every radix. Fractions agree in radices 2, 4, 8,
16 and 32, except for values below about 1e-30.

**The body is shared.** It is registered in `src/frontend/builtins/prepare-number-format.ts` (the legacy standalone
lane), `src/backend/wasmgc/resources/native-number-format.ts` (the `radix-body` row) and
`src/ir/program/formatter-support.ts` (the Prepared path's support function). A fix changes both lanes' output and
must keep the JS-host lane byte-identical (CLAUDE.md).

## Repros (2026-11-28, main `330caff2a8`)

The left column is node, the right is the body's algorithm. It was transcribed from `TOSTRING_RADIX_SOURCE` into
plain JS (#7350 B3e's `.tmp/b3e-fmt.mjs`) and was not compiled. Over 748 value × radix pairs, 430 agree.

| expression | node | the body |
| --- | --- | --- |
| `(0.1).toString(3)` | `"0.0022002200220022002200220022002201"` | 100 digits, `"0.00220022…0220100002100210000110101…"` |
| `(0.5).toString(3)` | `"0.1111111111111111111111111111111112"` | 100 digits of `1` |
| `(123.456).toString(7)` | `"234.312256641535441"` | 100 fractional digits |
| `(Math.PI).toString(36)` | `"3.53i5ab8p5f"` | `"3.53i5ab8p5fc5vayqter60f6r"` |
| `(1e21).toString(16)` | `"3635c9adc5dea00000"` | trap |
| `(2 ** 53).toString(2)` | `"1" + "0".repeat(53)` | trap |

On the Prepared path (#7350 B3e), both cases become named run-time aborts until this issue lands, so no wrong value
is answered there.

## Direction (to plan)

- Port V8's `DoubleToRadixCString` (shortest digits: generate while the delta to the neighbouring doubles allows,
  then round) into the same TS-source body, so both lanes keep one implementation.
- Integers above 2^53 − 1: the exact binary value's digits (V8 does this with a bignum-free exponent loop for a
  power-of-two radix and a division loop otherwise).
- Acceptance: agreement with node on every pair of the 748-pair table above, run as compiled code on standalone. Also
  the test262 `Number/prototype/toString` rows on both lanes, and byte identity on the JS-host lane.
