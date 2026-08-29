---
id: 5197
title: "ES2015 standalone promise — r2 residual pass"
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

# #5197 — promise r2: cluster and fix the residual promise-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5143, part of PR #5179) plus a
second pass that yielded only +5 (PR #5213, added
`src/codegen/promise-newtarget.ts`). The small r2 yield is the signal: the
easy wins under the existing plan are exhausted, and the remaining failures
likely sit in deeper semantics (job-queue ordering, species/subclass
construction, resolve-function identity) that need their own clustering —
not another pass over the wave-1 plan.

## Implementation Plan

Planning pass required before implementation (plan/implement split).

- Step 0 — regenerate the promise residual list (`built-ins/Promise/**`) on
  current main via the standalone probe (see #5194 step 0 for probe shape and
  the `.test262-cache` caveat).
- Step 1 — cluster by error signature; write the cluster table into this
  file. Separate "needs new machinery" clusters from "plan-coverage gap"
  clusters explicitly.
- Step 2 — implement per cluster; re-probe; spot-checks stay green.
- Step 3 — five ratchet gates + equivalence gate.

## Acceptance criteria

- Cluster table with measured counts in this file before implementation.
- Measurable net gain on the regenerated list; no spot-check or equivalence
  regressions.

## References

- #5143 (wave-1 plan), PRs #5179, #5213.
