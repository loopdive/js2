---
id: 4759
title: "ES2015 module namespace Test262 residuals"
status: in_progress
created: 2026-08-26
updated: 2026-08-26
priority: critical
horizon: m
feasibility: medium
reasoning_effort: max
task_type: conformance
area: modules, runtime, test262
es_edition: es2015
goal: test262-conformance
parent: 4753
assignee: ttraenkler/codex-es6-closeout
files:
  - src/codegen
  - src/runtime
  - tests
  - plan/issues/4759-es2015-module-namespace-residuals.md
---

# #4759 — ES2015 module namespace Test262 residuals

## Problem

The complete host run `20260826-180615` at draft PR #5008 head `39f279650`
contains 20 non-passing `test/language/module-code/namespace/` rows: 19 runtime
failures and one compile error. Sixteen currently normalize to `ns is not
defined`; the remaining rows cover namespace own-key ordering, TDZ/accessor
behavior, and escaped-keyword parsing. Broad full-run attribution is not
sufficient, so each row needs isolated confirmation.

## Implementation plan

1. Extract and rerun all 20 exact paths individually in host and standalone
   modes. Preserve raw diagnostics and separate parser, module-linking, and
   namespace-exotic-object failures.
2. Trace the dominant `ns is not defined` family through Test262 module
   dependency loading and namespace import binding creation. Reduce it to a
   minimal module graph with a positive namespace control.
3. Implement the narrow shared namespace binding/linking fix and add exact
   regression coverage. Do not emulate expected values in the harness.
4. Resolve only adjacent rows with the same proven cause; hand back parser or
   namespace-exotic-object rows as explicit follow-up clusters rather than
   mixing unrelated fixes.
5. Run exact pins and controls in both lanes plus TypeScript 5/7, formatting,
   lint, budgets, and issue gates. Commit a clean branch tip for integration
   into the single draft PR #5008 and record exact results here.

## Acceptance

- Every one of the 20 baseline rows has an isolated disposition.
- The confirmed shared namespace-binding cluster passes host and standalone.
- No test filtering, fixture rewrite, host-oracle shortcut, or skip is added.

