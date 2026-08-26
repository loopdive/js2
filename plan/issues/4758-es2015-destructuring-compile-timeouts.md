---
id: 4758
title: "ES2015 destructuring residual compile-timeout cluster"
status: in_progress
created: 2026-08-26
updated: 2026-08-26
priority: critical
horizon: m
feasibility: medium
reasoning_effort: max
task_type: conformance
area: codegen, performance, test262
es_edition: es2015
goal: test262-conformance
parent: 4753
assignee: ttraenkler/codex-es6-closeout
files:
  - src/codegen
  - tests
  - plan/issues/4758-es2015-destructuring-compile-timeouts.md
---

# #4758 — ES2015 destructuring residual compile-timeout cluster

## Problem

The complete host run `20260826-180615` at draft PR #5008 head `39f279650`
contains 46 compile-timeout rows. Forty are Test262 destructuring (`/dstr/`)
rows and share the maintained runner's ten-second compilation limit. A timeout
is not a semantic failure classification and must be reproduced alone before
changing compiler behavior.

## Implementation plan

1. Extract the exact 40 host rows from the timestamped JSONL artifact and rerun
   each through a one-path filter with one compiler worker. Record which remain
   compile timeouts and which become pass/fail/compile-error when isolated.
2. Profile at least one confirmed timeout from each syntactic family
   (assignment, formal parameters, class methods, loops, generators). Identify
   the smallest shared compiler phase or generated-source expansion responsible
   for the ten-second boundary.
3. Implement only the confirmed shared compiler fix. Add an issue regression
   that exercises the pathological shape and a nearby non-pathological control;
   do not raise the runner timeout or suppress rows.
4. Rerun all 40 exact host pins and their standalone counterparts, TypeScript
   5/7 checks, formatting, lint, LOC/function budgets, and issue metadata gates.
5. Commit a clean branch tip for integration into the single successor draft
   PR #5008. Record exact denominators and any rows proven to belong to a
   different semantic issue in this file.

## Acceptance

- Zero confirmed compile-timeout rows remain in this 40-row cluster.
- Regression and controls pass in host and standalone lanes.
- No timeout increase, skip, fixture rewrite, or filter exemption is used.

