---
id: 7289
title: "IR: relational comparison on dynamic operands skips ToPrimitive for objects (`0 >= []` → false)"
status: ready
sprint: current
created: 2026-11-07
updated: 2026-11-07
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir
goal: ir-full-coverage
related: [7272, 2949, 6921]
---

# IR: relational comparison on dynamic operands skips ToPrimitive for objects

## Problem

In an IR-claimed function, `<`, `<=`, `>` and `>=` over a dynamic operand
give the wrong answer when an operand is an object, including an array.
§7.2.13 IsLessThan applies ToPrimitive (hint Number) to each operand first:
`[]` becomes `""` and then `0`; `[1]` becomes `"1"`; `{ valueOf() { return 5 } }`
becomes `5`; `[2]` and `[10]` become the strings `"2"` and `"10"`, which
compare lexicographically. The IR skips that step, so an object reads as
`NaN` and every comparison with it is false.

Found by the fresh review of #7140 (#7272). #7272 then restricted its
mixed-conditional condition to strict (in)equality, so this defect cannot
reach code that used to be legacy. The defect itself predates #7272 and is
reachable today wherever the move-only scan admits a dynamic relational
operand.

## Repro (head of #7140, `a1d3a3ee`)

```js
function lt(a, b) { return a < b; }   // and le, gt, ge
function lt1(a) { return a < 1; }     // dynamic vs numeric literal
function ge0(a) { return a >= 0; }
```

Each cell lists `lt le gt ge lt1 ge0` for `(a, b)` (1 = true). All six
functions are IR-claimed; gc and standalone give the same results:

| (a, b) | node | gc / standalone IR |
| --- | --- | --- |
| `0, []` | 010111 | **000011** |
| `1, [1]` | 010101 | **000001** |
| `0, {}` | 000011 | 000011 |
| `"a", "b"` | 110000 | 110000 |
| `"10", "9"` | 110001 | 110001 |
| `null, 0` | 010111 | 010111 |
| `undefined, 0` | 000000 | 000000 |
| `{valueOf: 5}, 3` | 001101 | **000001** |
| `[2], [10]` | 001101 | **000001** |
| `true, 0` | 001101 | 001101 |

wasi: not executed. It uses the same `dyn.to_number` lowering.

## Where the lowering lives

- `tryLowerDynamicRelational` (`src/ir/from-ast.ts`, under "#2949 S5.3 —
  dynamic relational") ToNumbers each dynamic operand with `dyn.to_number`
  and then compares f64s.
- `dyn.to_number` (`src/ir/core/dialect/js.ts`) routes to
  `IrDynamicLowering.emitToNumber`:
  - gc / standalone use `__any_to_f64`, which reads the box's numeric slot
    and does no ToPrimitive on an object;
  - host uses `__unbox_number`.
- Its own doc says it covers the "numeric-abstract only" arm of §7.2.13, but
  the S5.P scan also admits dynamic × dynamic (`leftIsDyn && rightIsDyn`, in
  the move-only scan's relational arm in `src/ir/select.ts`), where an
  operand can be an object or a both-strings pair.

## Acceptance

- Every row above matches node on gc and standalone (and on wasi once it
  runs), in sloppy and strict mode.
- Either the dynamic relational lowering applies ToPrimitive (hint Number)
  and takes the both-strings branch of IsLessThan, as legacy's `__any_lt`
  family does on standalone, or the scan stops admitting operands that can
  be objects. The second option keeps those functions legacy, and legacy
  answers correctly.
