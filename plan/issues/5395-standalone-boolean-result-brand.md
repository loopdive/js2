---
id: 5395
title: "Preserve boolean result brands in standalone console output"
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
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
assignee: "ttraenkler/codex-boolean-output"
---

## Measured defect

At the CI-repaired compiler, both standalone and optimized standalone print
`1 -Infinity 0` for this JavaScript program; Node prints
`true -Infinity false`:

```js
var x = -0;
console.log(Object.is(x, -0), 1 / x, Object.is(0, -0));
```

The scalar stdout formatter distinguishes numbers from booleans using the
actual emitted value brand. Some boolean-producing intrinsics lose that brand.
The broader corpus also reproduces numeric boolean output from array
`some`/`every`/`includes`, collection `has`, and regular-expression `test`.

Keep numeric zero/one rendering correct and preserve the type-assertion
unsoundness protections. Repair trustworthy producer evidence rather than
reinterpreting arbitrary numeric values from a TypeScript annotation.

## Acceptance criteria

- [x] Repair the measured boolean output in both standalone optimization lanes.
- [x] Preserve ordinary numeric output and incompatible assertion diagnostics.
- [x] Cover the measured intrinsic families and unrelated number controls.
- [x] Record exact before/after audit evidence and relevant regression tests.

## Implementation and validation

The repair retains intrinsic boolean brands through both lowering paths,
including constant-folded comparisons and Number predicates. The two focused
suites pass 34 tests; numeric zero/one and indexOf controls retain numeric output.

Exact baseline/candidate rows and final validation are recorded in the
[general JavaScript audit](../audit/javascript-soundness-2026-09-08/README.md).
