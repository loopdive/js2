---
id: 7403
title: "`<` / `>` against a BigInt and `=== 2n ** 70n` on a maybe-BigInt operand answer false"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [7371, 7373, 6642]
---

# #7403 — relational and wide-BigInt comparisons on a maybe-BigInt operand

## Problem

RV7331 found these while reviewing #7371. Both are wrong on `origin/main` (89e4748241), on gc and standalone alike,
and #7371 does not change them.

| shape | node | we answer |
| --- | --- | --- |
| `b < 2n` / `b > 0n` with `b: number \| bigint` or `any` holding a BigInt | `true` | `false` |
| `g() === 2n ** 70n` with `g(): any` or `number \| bigint` returning `2n ** 70n` | `true` | `false` |

Pure `bigint` operands answer correctly in both shapes.

## Cause (from the review; to be confirmed)

- **Relational operators.** The mixed BigInt × Number comparison arm of `compileBinaryExpression` (`binary-ops.ts`)
  treats the maybe-BigInt side as a Number. That is the same static-type gap #7371 closed for `===`, here on `<` / `>`.
- **Wide BigInts.** The runtime strict-equality helper (`ensureExternStrictEqHelper`, `extern-eq-fast.ts`) has a
  bigint × bigint arm for the i64 carrier only, so a BigInt held in the wide carrier never compares equal.

Loose `==` is #7373.

## Loose `==` rows left open by #7373 (RV7339, 2026-11-19)

Pre-existing: the same answer on #7373's base and head. Measured on RV7339's 624-row probe.

| shape | node | we answer |
| --- | --- | --- |
| `"1.0" == 1n`, `"1e0" == 1n` (any operand type, static `string` included) | false | true (StringToBigInt approximated by ToNumber) |
| `Object(1n) == 1n`, `{ valueOf() { return 1n } } == 1n` | true | false (no ToPrimitive) |
| `{ valueOf() { return 1 } } == 1n`, operand typed `{ valueOf(): number }` | `==` true, `!=` false | both true |
| operand typed `{ valueOf(): bigint }` against a BigInt | valid program | invalid Wasm on gc and standalone |
| `9007199254740993n == x`, `x: any` / `number \| bigint` holding 2^53 | false | true (`f64.convert_i64_s` loses the #1827 exact comparison) |
| `const b: null = null; b == 0n` | false | true (does not reach the #7373 arm) |

Most of these go away with one loose-equality helper: a BigInt case in `__extern_loose_eq` (IsLooselyEqual steps 6–13),
after which the #7373 arm folds into it.

