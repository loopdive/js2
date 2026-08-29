---
id: 5195
title: "ES2015 standalone class — r2 residual pass"
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

# #5195 — class r2: cluster and fix the residual class-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5139, part of PR #5173's +152)
plus a second pass (+33, PR #5213; spot-check 40/40 on that tree). The
residual failure count on current main has NOT been re-measured — the wave-8
planning pass that would have produced it was stopped at wind-down.

The documented cheap lever applies: a deliberate "second pass over the #5139
plan on current main" yielded +33 last time; residuals beyond that need fresh
clustering (`language/statements/class/**`, `language/expressions/class/**`).

## Implementation Plan

Planning pass required before implementation (plan/implement split).

- Step 0 — regenerate the class residual list on current main via the
  standalone probe (see #5194 step 0 for the probe shape and the
  `.test262-cache` symlink caveat).
- Step 1 — cluster by error signature into file:function root causes; write
  the cluster table into this file.
- Step 2 — implement per cluster; re-probe; spot-checks stay green.
- Step 3 — five ratchet gates + equivalence gate.

## Acceptance criteria

- Cluster table with measured counts in this file before implementation.
- Measurable net gain on the regenerated list (target set by the planning
  pass); no spot-check or equivalence regressions.

## References

- #5139 (wave-1 plan), PRs #5173, #5213.
- Handover: `plan/agent-context/es2015-standalone-session-handover.md`.
