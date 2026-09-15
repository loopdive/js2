---
id: 5396
title: "Preserve array spread arguments passed to compiled rest parameters"
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
  - src/codegen/expressions/builtins.ts
func-budget-allow:
  - src/codegen/expressions/builtins.ts::compileMathCall
assignee: "ttraenkler/codex-rest-spread"
---

## Measured defect

The general JavaScript corpus `builtins/14-spread-args.js` prints `10`, `60`,
and `5` in Node. All four Wasm lanes print `10` and then raise a runtime error.
The ordinary explicit-argument call is a positive control for the same callee.

```js
function sum(...nums) {
  return nums.reduce((a, b) => a + b, 0);
}
console.log(sum(1, 2, 3, 4));
console.log(sum(...[10, 20, 30]));
console.log(Math.max(...[1, 5, 3]));
```

## Acceptance criteria

- [x] Minimize the failing rest/spread call separately from Math spread.
- [x] Repair the representation mismatch or emit an actionable source-located refusal.
- [x] Preserve explicit-argument calls and existing supported spread behavior.
- [x] Compare Node and normal/optimized host and standalone execution.
- [x] Run relevant rest/spread equivalence tests without expanding baselines.

## Implementation and validation

Array spread into a rest-only compiled parameter now materializes a fresh rest
array. Literal Math min/max spreads retain all arguments. Spreads crossing an
unsupported fixed/rest boundary receive a source-located diagnostic. The focused
suite passes 16 tests; the full equivalence gates retain their existing baseline.

Exact baseline/candidate rows and final validation are recorded in the
[general JavaScript audit](../audit/javascript-soundness-2026-09-08/README.md).
