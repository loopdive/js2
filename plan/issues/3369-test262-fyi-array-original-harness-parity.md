---
id: 3369
title: "test262.fyi array sample: close original-harness parity gap"
status: done
created: 2026-07-17
updated: 2026-07-17
completed: 2026-07-17
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: compiler, runtime, test262-runner
language_feature: array-literals, spread, exceptions
goal: test262-conformance
assignee: codex/root
related: [3362, 3368]
files:
  - scripts/run-test262-fyi.mjs
  - scripts/test262-fyi-reader.mjs
  - src/codegen
  - src/runtime.ts
  - tests/test262-fyi-runner.test.ts
  - tests/issue-3369.test.ts
  - tests/issue-3369-project-runner.test.ts
loc-budget-allow:
  # Closing the literal-harness gaps requires coordinated representation,
  # dispatch, assignment, iterator, and exception handling in these existing
  # subsystem modules. This allowance is change-scoped to the Test262 batch.
  - src/codegen/expressions/assignment.ts
  - src/runtime.ts
  - src/codegen/property-access.ts
  - src/codegen/object-ops.ts
  - src/codegen/literals.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/declarations.ts
  - src/codegen/statements/loops.ts
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/unary-updates.ts
  - src/codegen/expressions.ts
  - src/codegen/type-coercion.ts
  - src/codegen/expressions/operator-assignment.ts
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/compiler/early-errors/node-checks.ts
---
# #3369 — close the original-harness array-sample parity gap

## Problem

After #3368, the deterministic first 50 sorted paths under
`language/expressions/array` pass **50/50** through the project runner but only
**25/50** through the literal test262.fyi harness assembler.

The 25 original-harness residuals cluster as follows:

1. six array-exotic failures: inherited read-only numeric properties disrupt
   host array materialization, and four sparse numeric arrays expose holes as
   `NaN` instead of `undefined`;
2. twelve invalid-Wasm/type-index failures around custom iterator callbacks;
3. six exception-identity/closure-bridge failures for `Test262Error` and
   `ReferenceError` assertions;
4. one captured-global reference type mismatch in object-spread evaluation
   order.

## Acceptance criteria

- Add permanent original-harness regression coverage for all 25 paths.
- Fix general compiler/runtime/runner integration defects without modifying the
  upstream Test262 bodies or using expected-pass exceptions.
- The literal original harness and project runner both pass all 50 paths in the
  deterministic array sample.
- Preserve the original assembler contract: runtime shim + upstream harness
  includes + raw test source, with no `wrapTest()` transformation.

## Result

Closed the pass gap from **25 tests to zero**. The literal test262.fyi harness
and the project runner now both pass the same deterministic first 50 sorted
paths under `language/expressions/array` (**50/50** each).

The fixes preserve sparse-array `undefined` sentinels, materialize post-hoc
custom iterables through strict `GetIterator`, keep closure/constructor identity
stable across the host boundary, tolerate poisoned numeric Array prototype
properties in runtime bridges, and avoid redundant module-global array
writeback after in-place mutations.

Permanent coverage lives in `tests/issue-3369.test.ts` and
`tests/issue-3369-project-runner.test.ts`: separate Vitest forks exercise every
one of the 25 former original-harness residuals and re-run the matching 50-test
sample through the project runner without loading both compilers into one
512 MB process.
