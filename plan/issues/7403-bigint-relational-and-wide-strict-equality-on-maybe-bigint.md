---
id: 7403
title: "`<` / `>` against a BigInt and `=== 2n ** 70n` on a maybe-BigInt operand answer false"
status: done
completed: 2026-11-26
sprint: current
created: 2026-11-19
updated: 2026-11-26
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


## Resolution (2026-11-26, measured on `origin/main` c3b7be66)

Both causes confirmed; both are legacy codegen (the IR does not claim these comparisons), so no IR plan.

- **Relational operators.** #7373's `==`/`!=` arm (`bigint-any-operand.ts`) becomes `emitMaybeBigIntComparison`, one
  table-driven arm for `== != < <= > >=` (i64 / ordering-against-0 / f64 form per operator). A BigInt on the dynamic
  side compares as a BigInt; anything else keeps the ToNumber comparison; `null` keeps #7373's `==` answer.
- **Wide BigInts.** The strict-equality helper was already exact for two wide carriers (#6656). The real defect: the
  module's FIRST wide constant was folded before the carrier types existed (`tryFoldBigIntConstant`), so it was
  wrapped to i64 and boxed as a narrow `$BigInt`. It now registers them first.
- A `$BigIntWide` on the dynamic side orders by its sign against the i64 lane (it lay on its low 64 bits:
  `2n ** 70n == 0n` was true). A constant past 64 bits on the static side (`b < 2n ** 71n`) is compared with the new
  `__bigint_carrier_compare` (BigInt::lessThan over narrow/wide carriers, in `bigint-carrier-body.ts` next to the
  equality body, sharing its accessors).

Pins: `tests/issue-7403-bigint-maybe-bigint-comparison.test.ts`, expected values computed by node, gc + standalone.
They include wide pairs with different limb counts and a top limb ≥ 2^31; mutating the carrier ordering to signed
limbs or dropping its limb-count check turns 4 / 10 rows red (RV7438).

Bytes: 160 test262 files (100 sampled + 60 BigInt) × {gc, standalone} are identical to main. Programs that hold a
wide BigInt constant in a reference slot DO change, as intended (the carrier types now exist when the first one is
folded): of 14 such probes, 7 change on both targets — 6 flip from wrong to node's answer, 1 keeps its answer.

### Left open

- A non-constant BigInt wider than 64 bits on the static side (`const w: bigint = f()` on the i64 lane) still wraps:
  the i64 lane cannot hold it, for every BigInt operator, not only these comparisons.
- `tests/issue-6656-bigint-wide-carrier.test.ts > narrowedString` fails on main c3b7be66 and with this change alike.
- The loose `==` rows above (RV7339) are unchanged.
- A wide constant inside an array or object literal (`[2n ** 70n]`, `{ v: 2n ** 70n }`) still wraps.
