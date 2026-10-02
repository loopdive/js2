---
id: 6756
title: "npm-compat perf regressions: native-first any-add over numeric slots, host arguments.length round-trip"
status: done
sprint: current
created: 2026-09-29
updated: 2026-09-29
completed: 2026-09-29
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
goal: performance
related: [3518, 4658]
---
# #6756 — npm-compat performance regressions

## Problem

The npm-compat dashboard's perf history (`benchmarks/results/npm-compat-history.json`)
showed three regressions well outside run-to-run noise (±30 %):

| Lane | Before | After | Window |
| --- | --- | --- | --- |
| react · standalone · static | 0.0017 µs | 0.060 µs (~35×) | 2026-09-28, PR #6205 |
| react · standalone · dynamic | 0.151 µs | 0.547 µs (~3.6×) | 2026-09-28, PR #6205 |
| clsx · standalone · dynamic | 0.53 µs | 0.72 µs (~1.35×) | 2026-09-28, PR #6205 |
| clsx · JS host · dynamic | 0.34 µs | 10.6 µs (~31×) | 2026-08-24 → 08-31, commit 849a24a31f |

All figures measured locally on a 4-core container with
`scripts/generate-npm-compat-report.mjs --only <pkg> --no-write --perf-only --lane <lane>`
at the named before/after revisions (13099016 / cadcd0917 vs 075e05df / 23e2d2ed).
acorn and cookie standalone dips in the same window did not reproduce beyond noise.

## Root causes

1. **Native-first any-add admission (PR #6205).** `admitsAnyAdditionOperands`
   now admits every `any`/`unknown` `+` operand under standalone native-first,
   even when the operand's physical slot is already numeric. `input.length + 1`
   (untyped param inferred as a native string) was boxed through the generic
   `ToPrimitive` addition instead of a plain `f64.add`.
2. **Concat batching proof too narrow (PR #6205).** `compileStringBinaryOpWithNativeAddition`
   batches only when every concat operand is a syntactic primitive producer.
   `seed % 7`, `+x`, and bindings whose slot is a native string / f64 / i32
   (`"foo-" + seed + "-" + index`) were rejected and routed through the
   generic addition.
3. **Host `arguments.length` (849a24a31f).** `emitArgumentsLengthRead` was meant
   for standalone (its writer `argumentsLengthSetArm` is `ctx.standalone`-gated)
   but ran on the JS host too, where it copies the whole arguments vec through
   `__make_iterable` just to read `.length`.

## Fix

- `representationallyNumericOperand`: an `any` operand that is a numeric local
  or `.length` of a native-string local is not admitted to the generic add.
- `isPrimitiveConcatProducer`: arithmetic/bitwise ops with a Number literal
  operand (or `>>>`), unary `+`, and (given a function context) bindings whose
  slot is a native string, f64 or i32 count as primitive. Assertions
  (`x as string`) disable the slot proof so a numeric slot cannot be concatenated.
- `emitArgumentsLengthRead` is gated on `ctx.standalone`.

Tests: `tests/npm-compat-perf-native-add-fastpath.test.ts` (fails on unfixed main).
