---
id: 7441
title: "Native `Math.*` on the standalone target differs from node: up to 1.5e-8 relative, and wrong for large arguments"
status: ready
sprint: current
created: 2026-11-20
updated: 2026-11-20
priority: high
horizon: m
task_type: bug
area: runtime, standalone
goal: standalone-gap
related: [7380, 3518]
---

# #7441 — native Math functions are not correctly rounded, and some break for large or tiny arguments

## Problem

On `--target standalone` and the JS target (identical results; both use the same native core), the transcendental `Math` functions
give answers that differ from node's. Example: `Math.atan(0.5)` gives `0.4636476094151571`, node
`0.4636476090008061`; `Math.log(0.5)` gives `-0.6931471702560121`, node `-0.6931471805599453`. Some are not
precision issues but wrong results: `Math.sin(1e300)` is `-Infinity`, `Math.cbrt(1e300)` is `1.95e148`,
`Math.sinh(5e-324)` is `0`.

test262 compares many of these with exact values (`Math.log2(0.5) === -1`, `Math.cbrt(1e300)`, tiny-argument
identities such as `sinh(x) === x`), so this costs standalone conformance.

## Measurement

`claude/7380-pins-a` `e41fd9cc1d`, `--target standalone`, each function compiled as
`export function f(x) { return Math.<name>(x); }` (binary ones with `(x, y)`), 200 inputs: 0, -0, NaN, ±Infinity,
±1, ±0.5, 2, π, e, 1e-300, 5e-324, 1e300, 0.9999999, 1.0000001, and 183 signed values spread from 1e-8 to 1e8.
"Differing" means not `Object.is`-equal to node's result.

| function | inputs differing | max relative error | worst input (standalone, node) |
| --- | ---: | ---: | --- |
| `abs` | 0/200 | 0 |  |
| `acos` | 21/200 | 1.63e-10 | `acos(-0.31117799022997783) = 1.88722863870046, node 1.8872286390073088` |
| `acosh` | 41/200 | ∞ (special value) | `acosh(1e+300) = Infinity, node 691.4686750787736` |
| `asin` | 26/200 | 9.70e-10 | `asin(-0.31117799022997783) = -0.3164323119055635, node -0.316432312212412` |
| `asinh` | 125/200 | ∞ (special value) | `asinh(1e+300) = Infinity, node 691.4686750787736` |
| `atan` | 44/200 | 1.78e-9 | `atan(2.718281828459045) = 1.2182829071897905, node 1.2182829050172777` |
| `atanh` | 47/200 | 1.00e+0 | `atanh(5e-324) = 0, node 5e-324` |
| `cbrt` | 142/200 | 1.95e+48 | `cbrt(1e+300) = 1.9509221155311695e+148, node 1e+100` |
| `ceil` | 0/200 | 0 |  |
| `clz32` | 0/200 | 0 |  |
| `cos` | 150/200 | ∞ (special value) | `cos(1e+300) = Infinity, node -0.5753861119575491` |
| `cosh` | 38/200 | 4.02e-9 | `cosh(3.141592653589793) = 11.591953228934605, node 11.591953275521519` |
| `exp` | 32/200 | 4.03e-9 | `exp(3.141592653589793) = 23.140692539431114, node 23.140692632779267` |
| `expm1` | 52/200 | 7.88e-9 | `expm1(-0.31117799022997783) = -0.2674165305436135, node -0.267416528436251` |
| `floor` | 0/200 | 0 |  |
| `fround` | 0/200 | 0 |  |
| `log` | 55/200 | 1.49e-8 | `log(0.5) = -0.6931471702560121, node -0.6931471805599453` |
| `log10` | 61/200 | 1.49e-8 | `log10(0.5) = -0.3010299911890399, node -0.3010299956639812` |
| `log1p` | 72/200 | 1.49e-8 | `log1p(-0.5) = -0.6931471702560121, node -0.6931471805599453` |
| `log2` | 44/200 | 1.49e-8 | `log2(0.5) = -0.9999999851345667, node -1` |
| `round` | 0/200 | 0 |  |
| `sign` | 0/200 | 0 |  |
| `sin` | 152/200 | ∞ (special value) | `sin(1e+300) = -Infinity, node -0.8178819121159085` |
| `sinh` | 72/200 | 1.00e+0 | `sinh(5e-324) = 0, node 5e-324` |
| `sqrt` | 0/200 | 0 |  |
| `tan` | 161/200 | ∞ (special value) | `tan(1e+300) = NaN, node 1.4214488238747245` |
| `tanh` | 61/200 | 1.00e+0 | `tanh(5e-324) = 0, node 5e-324` |
| `trunc` | 0/200 | 0 |  |
| `atan2` | 51/200 | 2.27e-8 | `atan2(-1.1613955240216916e-7, 2.9081373043240113e-7) = -0.37995505946622604, node -0.37995506807428275` |
| `pow` | 18/200 | 3.81e-7 | `pow(0.5, -37.01265660048742) = 138649941389.49167, node 138649994267.2532` |
| `imul` | 0/200 | 0 |  |
| `hypot` | 0/200 | 0 |  |
| `max` | 0/200 | 0 |  |
| `min` | 0/200 | 0 |  |

Spot checks, confirmed by the #7380 PR 2b review. The default JS target and `--target standalone` give identical
results for every row, because both use the same native core:

| call | js2wasm (JS and standalone) | node |
| --- | --- | --- |
| `Math.cbrt(1e300)` | 1.9509221155311695e+148 | 1e+100 |
| `Math.cos(1e300)` | Infinity | -0.5753861119575491 |
| `Math.sinh(5e-324)` | 0 | 5e-324 |
| `Math.log2(0.5)` | -0.9999999851345667 | -1 |
| `Math.exp(Math.PI)` | 23.140692539431114 | 23.140692632779267 |
| `Math.atan(0.5)` | 0.4636476094151571 | 0.4636476090008061 |
| `Math.log(0.5)` | -0.6931471702560121 | -0.6931471805599453 |

"∞ (special value)" means a finite node result became ±Infinity or NaN (or the reverse). Exact on all 200 inputs:
`abs`, `ceil`, `clz32`, `floor`, `fround`, `round`, `sign`, `sqrt`, `trunc`, `imul`, `hypot`, `max`, `min`.

## Evidence

Found during the #7380 PR 2b triage; no existing red test compares the digits (the `issue-3518-ir-math-*` tests
check exact arity and routing, not values).

## Acceptance criteria

1. Every function in the table matches node on the 200-input sweep, or the remaining differences are at most 1 ulp
   and listed with a reason (node's libm is not correctly rounded everywhere either).
2. No special-value failures: large arguments of `sin`/`cos`/`tan` reduced correctly, `cbrt` exact on powers,
   tiny arguments of `sinh`/`tanh`/`atanh`/`asinh` return the argument.
3. The sweep becomes a test that compares with node's results.
