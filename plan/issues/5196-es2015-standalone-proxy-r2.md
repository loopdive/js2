---
id: 5196
title: "ES2015 standalone proxy — r2 residual pass"
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

# #5196 — proxy r2: cluster and fix the residual proxy-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5140, part of PR #5173) plus the
strongest second pass of the batch (+66, PR #5213 — evolved §7.3.9
trap-callable guard, unified non-constructor meta-statics). Residual count on
current main not re-measured; the wave-8 planning pass was stopped.

## Implementation Plan

Planning pass required before implementation (plan/implement split).

- Step 0 — regenerate the proxy residual list (`built-ins/Proxy/**`) on
  current main via the standalone probe (see #5194 step 0 for probe shape and
  the `.test262-cache` caveat).
- Step 1 — cluster by error signature into file:function root causes; write
  the cluster table into this file. Expect the remaining mass in traps whose
  invariant checks are still partial.
- Step 2 — implement per cluster; re-probe; spot-checks stay green.
- Step 3 — five ratchet gates + equivalence gate.

## Acceptance criteria

- Cluster table with measured counts in this file before implementation.
- Measurable net gain on the regenerated list; no spot-check or equivalence
  regressions.

## References

- #5140 (wave-1 plan), PRs #5173, #5213.
