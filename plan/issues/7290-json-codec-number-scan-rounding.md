---
id: 7290
title: "Standalone JSON codec: `__json_parse_text` number scan does not round correctly"
status: ready
sprint: current
created: 2026-11-06
updated: 2026-11-06
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: standalone-gap
related: [7267]
---

# #7290: the standalone JSON codec's number scan rounds incorrectly

## Problem

`__json_parse_text` (`src/codegen/json-codec-native.ts`), the host-free
`JSON.parse` codec used for a text known only at run time, scans JSON numbers
without correct rounding (§25.5.1 → `Number` value of the
StringNumericLiteral, round-to-nearest-even). Legacy's compile-time fold
(`tryEmitJsonParseLiteral`) uses the host parser and is exact, so the bug shows
only for runtime texts. That is pre-existing on `main`. #7267's review found it
when the IR briefly routed literal texts to the codec; #7267 now keeps
those on the fold.

## Measurement (2026-11-06, `main` dc52abf7, standalone)

`function f(s: string): number { return JSON.parse(s); }` with the text in a
`let` (so nothing folds), compared with node by `Object.is`. **10 of 20
wrong:**

| text | codec | node |
| --- | --- | --- |
| `4.35` | 4.3500000000000005 | 4.35 |
| `5e-324` | 0 | 5e-324 |
| `1.7976931348623157e308` | Infinity | 1.7976931348623157e+308 |
| `2.2250738585072014e-308` | 0 | 2.2250738585072014e-308 |
| `1e-7` | 1.0000000000000002e-7 | 1e-7 |
| `1.005` | 1.0050000000000001 | 1.005 |
| `123456789.123456789` | 123456789.12345684 | 123456789.12345679 |
| `7.0e-10` | 7.000000000000002e-10 | 7e-10 |
| `12345678901234567890` | 12345678901234570000 | 12345678901234567000 |
| `3.14159` | 3.1415900000000003 | 3.14159 |
| `0`, `-0`, `1`, `0.1`, `0.5`, `1.5`, `100`, `1e21`, `2.5e10`, `9007199254740993` | correct | — |

The pattern fits a scan that accumulates mantissa and exponent in f64 (one
rounding per step) instead of a correctly rounded decimal-to-binary
conversion. Subnormals underflow to 0 and the largest finite overflows to
Infinity. #7267's reviewer measured 11 of 20 on an overlapping set.

### Second row: legacy's fold gets `true` / `false` wrong

`JSON.parse("true") !== true` and `JSON.parse("false") !== false` throw on
`main` for standalone and gc (the compile-time fold), while the runtime codec
answers them right (measured in #7267's review; reproduced on head with the IR
off).

## Acceptance

- Every text above equals node for runtime texts (standalone, WASI, gc).
- The fold answers `true` / `false` correctly.
- No new host import; gc byte-identical where neither path changes.
