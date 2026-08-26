---
id: 4760
title: "ES2015 Promise.prototype.then Test262 residuals"
status: in_progress
created: 2026-08-26
updated: 2026-08-26
priority: critical
horizon: m
feasibility: medium
reasoning_effort: max
task_type: conformance
area: promises, runtime, test262
es_edition: es2015
goal: test262-conformance
parent: 4753
assignee: ttraenkler/codex-es6-closeout
files:
  - src/codegen
  - src/runtime
  - tests
  - plan/issues/4760-es2015-promise-then-residuals.md
---

# #4760 — ES2015 Promise.prototype.then Test262 residuals

## Problem

The complete host run `20260826-180615` at draft PR #5008 head `39f279650`
contains 16 non-passing `test/built-ins/Promise/prototype/then/` rows: 14
runtime failures and two Wasm compile errors. The observable groups include
constructor/capability validation, poisoned thenables, reaction-handler
scheduling, async completion, and the builtin length descriptor. They may have
different causes and must be isolated before implementation.

## Implementation plan

1. Rerun all 16 exact paths individually in host and standalone modes and
   classify stable failures by specification operation and error signature.
2. Start with the largest coherent family confirmed by solo runs, reduce it to
   a minimal issue regression, and identify the owning promise/runtime path.
3. Implement the narrow shared fix with positive controls for settlement order,
   rejection propagation, constructor validation, and asynchronous completion
   as applicable. Do not make the Test262 harness accept synchronous behavior.
4. Rerun all 16 pins to detect adjacent fixes and regressions. Record unrelated
   compile/ABI rows as explicit follow-up handoffs rather than conflating them.
5. Run both targets, TypeScript 5/7, formatting, lint, budgets, and issue gates.
   Commit a clean branch tip for integration into the sole successor draft PR
   #5008 and update this issue with exact denominators.

## Acceptance

- All 16 baseline rows have isolated, reproducible dispositions.
- The implemented semantic cluster passes in host and standalone modes with
  exact regressions and controls.
- No timeout increase, filter exemption, skip, or oracle-only workaround.
