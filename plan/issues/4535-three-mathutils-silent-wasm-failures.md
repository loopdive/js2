---
id: 4535
title: "three.js: MathUtils.damp differs from Node in the final floating result (17/18 pass)"
status: ready
sprint: current
created: 2026-08-16
updated: 2026-08-26
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: codegen, testing
language_feature: modules
goal: npm-library-support
related: [3995]
files:
  - tests/dogfood/three-upstream-suite.mjs
  - tests/dogfood/upstream-suite-runner.mjs
---

# three.js MathUtils: isolate the remaining `damp` numeric mismatch

## Problem

The pinned upstream slice (`test/unit/src/math/MathUtils.tests.js`) now compiles,
validates, and passes **17/18** tests in Wasm. Node passes **18/18**. The earlier
uniform 0/18 result was a runner-observability defect fixed by the merged
per-test runner work; it is not the current compiler problem.

Only `damp` remains. The exact result is:

```text
number:1.1478562110442545 !== number:1.1478562110337887
```

This is a real numeric parity failure on the same runtime-owned inputs, not an
unavailable test or a reason to relax the upstream assertion.

## Reproduction

```bash
node --import tsx tests/dogfood/three-upstream-suite.mjs --json
```

## Implementation Plan (Fable; implement per the plan/implement split)

1. Reduce the exact `damp` inputs and record every intermediate value in Node
   and Wasm, especially the `Math.exp` result, subtraction, multiplication,
   and final addition.
2. Determine whether the divergence comes from a generic numeric lowering,
   evaluation-order, host `Math.exp`, or unintended `f32` conversion boundary.
3. Fix the generic compiler/runtime path. Do not special-case three.js, change
   the expected value, precompute the answer, or add a package-only tolerance.
4. Commit a focused regression as `tests/issue-4535.test.ts`, then re-run the
   unchanged pinned upstream suite and adjacent numeric/equivalence tests.

## Acceptance criteria

- [x] Root cause of the obsolete uniform 0/18 result is named and fixed.
- [x] The remaining failure is isolated to `MathUtils.damp` at **17/18**.
- [ ] The exact upstream slice passes **18/18** with unchanged inputs and
      expectations.
- [ ] Reduction test committed.
