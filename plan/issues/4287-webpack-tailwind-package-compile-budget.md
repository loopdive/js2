---
id: 4287
title: "perf: Webpack and Tailwind package graphs exceed the 120 second compile budget"
status: ready
sprint: Backlog
created: 2026-08-09
updated: 2026-08-09
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
language_feature: multi-module
goal: dogfood
related: [3993, 4001]
---

# perf: Webpack and Tailwind package graphs exceed the 120 second compile budget

## Problem

After #3993 removes their inherited-class callable aborts, the pinned package
entries continue through body compilation but do not finish inside the catalog
harness's honest 120-second wall-clock limit:

- Webpack 5.109.2 `lib/index.js`: 120,111 ms, timed out, no binary.
- Tailwind CSS 4.3.3 `dist/lib.mjs`: 120,037 ms, timed out, no binary.

These are compatibility blockers because validation and original workloads
cannot run until compilation completes. They are not a performance-regression
gate: the npm-compat report should continue recording the outcome without
blocking unrelated changes.

## Acceptance criteria

- Profile each exact pinned graph far enough to attribute time by compiler
  phase and identify whether it is slow progress or a hang.
- Add a reduced compiler-work regression for each generic hot path that is
  optimized.
- Both package probes complete within their bounded harness budget and report a
  real compile/validation outcome.
- Do not raise the timeout as a substitute for fixing duplicated or unbounded
  compiler work; a larger diagnostic run is allowed to locate the next frontier.
