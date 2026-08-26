---
id: 4752
title: "Remove superseded native generator close helper"
status: done
created: 2026-08-26
updated: 2026-08-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: low
task_type: integration
area: codegen, conformance
es_edition: es2015
goal: test262-conformance
related: [4716, 4718, 4751]
---

# #4752 — Remove superseded native generator close helper

## Scope

Repair the combined ES6 PR's dead-export gate after its generator conflict
resolution retained `nativeGeneratorCloseInstrs`, even though the integrated
control-flow implementation no longer calls it.

## Implementation plan

1. Confirm the helper and its private return-mode constant have no references.
2. Delete only the unreachable helper and constant; preserve the active
   generator-close implementation selected during integration.
3. Run the dead-export gate, the #4716/#4718 generator suites, both supported
   TypeScript checks, and the integration policy/budget gates.

## Acceptance

- The dead-export gate reports no newly unreferenced top-level codegen helper.
- The generator close and abrupt-completion regression suites remain passing.
- TypeScript and integration policy/budget gates remain passing.

## Test Results

The helper and its `MODE_RETURN` constant had no remaining references after the
combined branch selected the active inline close path. Both were deleted.

- `check:dead-exports`: passed (23 known entries, 0 new).
- `tests/issue-4716.test.ts` and `tests/issue-4718.test.ts`: 26/26 passed.
- TypeScript 5 and TypeScript 7 typechecks: passed.
- Host-import policy, LOC, function-size, oracle, coercion-site, issue-ID,
  issue-integrity, formatting, and `git diff --check` gates: passed.
