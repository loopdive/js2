---
id: 7373
title: "Loose `b == 1n` answers `false` for a BigInt held in an `any`"
status: done
completed: 2026-11-19
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: core-semantics
related: [6642, 7371]
---

# #7373 — loose equality against a BigInt loses a dynamic BigInt operand

## Problem

Found while fixing #7371. On `origin/main` (ee3fcdd610), default and `--target standalone` alike:

```ts
function g(k: boolean): any { return k ? 1n : 2; }
g(true) == 1n;   // node true; we answer false
g(true) === 1n;  // true — strict equality is right (#6642)
```

The same holds for a `number | bigint` operand. A number on the dynamic side compares correctly
(`g(false) == 1n` with `g` returning `1` is true).

## Cause (as read, not yet traced to the line)

In `compileBinaryExpression` (`binary-ops.ts`) a BigInt against a statically non-BigInt operand takes the mixed
BigInt × Number loose-equality arm. That arm converts the dynamic side with ToNumber, so a BigInt value held in an
`externref` never reaches a BigInt comparison. The strict arm has the #6642/#7371 escape to the runtime
strict-equality helper; the loose arm has none.

## Acceptance criteria

- `==` / `!=` between a BigInt and an `any` / `unknown` / `number | bigint` operand answer like node, for a
  BigInt value and a number value on the dynamic side, on gc and standalone.
- Loose equality between statically BigInt and number operands (#1827) keeps its bytes.

## Measured on 6a7d520d23 (2026-11-19, `.tmp/probe.mts`, gc and standalone agree on every row)

| operand type | value | `b == 1n` / `1n == b` | `b != 1n` / `1n != b` |
| --- | --- | --- | --- |
| `any`, `unknown`, `number \| bigint` | `1n` | **false** (node true) | **true** (node false) |
| same | `2n`, `0n`, `-1n` | false, ok | true, ok |
| same | `1` (number) | true, ok | false, ok |
| `any`, `unknown` | `"1"` | true, ok | false, ok |

Side-effect order (`g() == k()`, `k() != g()`) calls left then right, ok; only the answer is wrong.
Static `bigint == number` (#1827) and `bigint == "0x10"` are right.

Neighbours, same head, outside this issue (no operand is statically BigInt, so the BigInt arm never runs):
`b == 1` with `b` an `any` / `unknown` / `number | bigint` holding `1n` answers false; `p() == q()` with two
`any` holding `1n` and `1n` answers false; `1n` against `1` traps (`illegal cast`). `__extern_loose_eq` /
`__any_eq` have no BigInt arm.

## Cause

`compileBinaryExpression`'s mixed BigInt arm (`binary-ops.ts`) sends `==` / `!=` against a non-BigInt static type
to the f64 arm: `f64.convert_i64_s(big) == ToNumber(other)`. ToNumber of a BigInt held in an `externref` is NaN,
so a BigInt on the dynamic side is never equal to anything.

## Implementation Plan

- **Module.** `src/codegen/bigint-any-operand.ts`, next to its sibling `emitStandaloneAnyBigIntBinary` (#5383),
  which already handles "one side is a static BigInt, the other may hold one at run time" for arithmetic: evaluate
  both sides in order into an i64 and an externref local, test `__typeof_bigint`, unbox with `__to_bigint`.
  New export `emitMaybeBigIntLooseEquality`: if the dynamic side is a BigInt, `i64.eq`; otherwise the same
  ToNumber/f64 comparison the static arm emits today. `binary-ops.ts` calls it from the mixed arm for `==` / `!=`
  when `typeMayBeBigInt` (#7371) holds for the non-BigInt side; `undefined` (helpers missing) keeps today's arm.
- **Reuse.** `typeMayBeBigInt`, `__typeof_bigint`, `__to_bigint`, `coerceType`. The operand-to-locals step of
  `emitStandaloneAnyBigIntBinary` becomes one shared function both callers use. In `binary-ops.ts` the non-BigInt
  operand's type, computed twice in the mixed arm, is computed once.
- **Not taken.** Teaching `__extern_loose_eq` / `__any_eq` BigInt would also fix the any × any neighbours, but the
  provider is the generic dynamic path with its own representation (`$AnyValue` tags); that is a separate change.
- **Quality acceptance.** No new predicate or runtime helper; the arithmetic arm's bytes unchanged; the two sibling
  emitters share the operand step; `compileBinaryExpression` grows only by the 4-line call site, inside its budget.

## Result (2026-11-19)

- `emitMaybeBigIntLooseEquality` in `bigint-any-operand.ts`, called from the mixed BigInt arm of
  `compileBinaryExpression` for `==` / `!=` when `typeMayBeBigInt(nonBigIntTsType)`. The operand step is shared with
  `emitStandaloneAnyBigIntBinary` (`compileOperandLocals`); `nonBigIntTsType` is computed once in the arm.
- The helper indices are read after `flushLateImportShifts`: on gc the ToNumber coercion of the fallback registers
  functions, and an index read before it pointed at the wrong function (invalid Wasm).
- Probe (89 rows): every row with a static BigInt operand now matches node on gc and standalone (13 BAD before,
  including the side-effect-order row); the 3 BAD `b == 1` rows are the neighbour below. Also fixed: `bigint | undefined` / `bigint | null` holding
  `1n`, a `bigint` local against an `any`, a BigInt past 2^53 (fits i64), `-7n`.
- `tests/issue-7373-loose-bigint-equality.test.ts`: 34/48 on 6a7d520d23, 48/48 after.
- Neighbour suites (`*bigint*`, `*6642*`, `*loose*`, `*equal*`, 45 files): identical failing set (47) before and after.
- Byte hashes of the 100-file test262 sample, gc and standalone: identical.

Left open (unchanged by this fix, same answer before and after):

- No operand statically BigInt: `b == 1` with `b` holding `1n` answers false; two `any` holding `1n` answer false
  for `==`; an `any` `1n` against an `any` `1` traps (`illegal cast` in `__any_eq`). `__extern_loose_eq` /
  `__any_eq` need a BigInt arm.
- `null == 0n` (an `any` or `bigint | null` holding null) answers true: the fallback's ToNumber(null) is 0.
- `Object(1n) == 1n` and `{ valueOf() { return 1n } } == 1n` answer false (ToPrimitive yielding a BigInt).
- A BigInt wider than i64 on the dynamic side goes through `__to_bigint` (i64), as #7403 notes for `===`.
