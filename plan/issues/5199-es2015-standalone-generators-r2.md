---
id: 5199
title: "ES2015 standalone generators — r2 residual pass"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: medium
horizon: m
feasibility: medium
task_type: conformance
area: codegen
es_edition: ES2015
goal: standalone-mode
requested_by: claude/fable-es2015
---

# #5199 — generators r2: cluster and fix the residual generator-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5141, part of PR #5179 — includes
the root-cause fix of the #5060 standalone generator-resume trap: V8 12.4 runs
a result-typed `try_table` as `unreachable`; the resume wrapper now trampolines
in a `block (result R)` under an empty-typed `buildTargetTaggedTry`) plus a
second pass (+25, PR #5213). Residual count on current main not re-measured;
the wave-8 planning pass was stopped.

Adjacent recorded defect: yield-star throw delegation has its own held draft
(PR #5063, pre-session) — check its state before clustering that area.

## Implementation Plan

Planning pass required before implementation (plan/implement split).

- Step 0 — regenerate the generators residual list
  (`language/statements/generators/**`, `language/expressions/generators/**`,
  `built-ins/GeneratorPrototype/**`) on current main via the standalone probe
  (see #5194 step 0 for probe shape and the `.test262-cache` caveat).
- Step 1 — cluster by error signature; write the cluster table into this
  file.
- Step 2 — implement per cluster; re-probe; spot-checks stay green.
- Step 3 — five ratchet gates + equivalence gate.

## Acceptance criteria

- Cluster table with measured counts in this file before implementation.
- Measurable net gain on the regenerated list; no spot-check or equivalence
  regressions.

## References

- #5141 (wave-1 plan), PRs #5179, #5213; #5060 (resume-trap root cause).
