---
id: 7438
title: "`Math.atan()` and 30 other Math calls with a missing argument do not compile (`__get_builtin`)"
status: ready
sprint: current
created: 2026-11-20
updated: 2026-11-20
priority: medium
horizon: s
task_type: bug
area: codegen
goal: core-semantics
related: [7380, 1472, 3518]
---

# #7438 — Math calls with a missing argument are a compile error

## Problem

```ts
export function f(): number {
  // @ts-ignore
  return Math.atan();
}
```

node: `NaN`. js2wasm, default JS target and `--target standalone`, IR on and off: compile error
"Codegen error: '`__get_builtin`' (dynamic-shape object/property operation) is not yet supported in --target
standalone (#1472 Phase B)…". On the JS target the message names the standalone target.

Sweep (every Math function called with zero arguments, both targets, `claude/7380-pins-a` `e41fd9cc1d`):

- **Fail on both targets (31):** `abs`, `acos`, `acosh`, `asin`, `asinh`, `atan`, `atanh`, `cbrt`, `ceil`,
  `clz32` (node 32), `cos`, `cosh`, `exp`, `expm1`, `floor`, `fround`, `log`, `log10`, `log1p`, `log2`, `round`,
  `sign`, `sin`, `sinh`, `sqrt`, `tan`, `tanh`, `trunc`, `atan2`, `pow`, `imul` (node 0). Node gives NaN except where
  noted.
- **Correct (4):** `hypot()` 0, `max()` -Infinity, `min()` Infinity, `random()`.

Too few arguments for a two-argument function fail the same way (`Math.imul(left)` measured). Too many arguments
compile.

## Evidence

`tests/issue-3518-ir-math-switch-retirement.test.ts` "keeps all 42 exact-arity misses pre-claim and legacy-owned".

## Acceptance criteria

1. Every function in the fail list compiles with zero arguments and with one argument too few, and returns node's
   value (missing arguments are `undefined`, i.e. NaN after ToNumber), on both targets.
2. The red test above passes unchanged.
