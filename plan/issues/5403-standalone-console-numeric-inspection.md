---
id: 5403
title: "Preserve negative zero and BigInt suffixes in standalone console output"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
parent: 5393
depends_on: [5399]
loc-budget-allow:
  - src/codegen/native-strings.ts
  - src/ir/from-ast.ts
assignee: "ttraenkler/codex-console-numeric-inspection"
---

## Measured defect

Node 24.4.1 prints raw `-0`, `1n`, and `3n` for the statements below.
Standalone before this repair prints `0`, `1`, and `3`. The explicit String
conversions correctly need different output: `0` and `1`.

```js
console.log(-0);
console.log(1n);
const n = 1n;
console.log(n + 2n);
console.log(String(-0));
console.log(String(1n));
```

The legacy sink uses ordinary ToString for all scalar values. The IR console
renderer independently makes the same choice for f64 numbers. A program with
only `console.log(-0); console.log(0); console.log(1);` demonstrates the IR
failure without being demoted by BigInt expressions.

## Implementation

At the console boundary, identify negative zero by its actual f64 bit pattern
and print `-0`. Append `n` only when the emitted i64 carries the existing BigInt
brand. Native integer annotations remain unbranded and print numeric text.
The shared ToString formatter is unchanged; the exact BigInt formatter from
issue 5399 supplies integer digits without rounding through f64.

## Acceptance criteria

- [x] Raw negative zero and BigInt literals/arithmetic match Node console output.
- [x] Ordinary numeric zero/one and unbranded native i64 stay numeric.
- [x] String(-0) and String(BigInt) retain ordinary String conversion semantics.
- [x] Legacy and IR paths pass with optimization enabled and disabled.
- [x] Standalone modules keep zero imports.

## Validation

The new suite passes 24/24 cases: host/standalone × optimization off/on × IR
off/on, with three source controls per configuration. Node 24.4.1 independently
runs the same sources and supplies the expected primitive output. Standalone
module imports are asserted empty. The existing scalar-console suite passes
3/3 after correcting its previous `-0` expectation from `0` to `-0`.

Typecheck, Biome lint, formatting, and the change-scoped coercion gate pass.
This issue grants only the intentional console-rendering growth in the two
source files; it does not change the general Number/BigInt String formatters.
