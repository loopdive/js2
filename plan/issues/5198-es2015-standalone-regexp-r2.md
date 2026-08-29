---
id: 5198
title: "ES2015 standalone regexp — r2 residual pass"
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

# #5198 — regexp r2: cluster and fix the residual regexp-bucket failures

## Problem

State after the 2026-08-29 session: wave 1 (#5142, part of PR #5179) plus a
second pass that yielded only +8 (PR #5213). As with promise (#5197), the
small r2 yield means the wave-1 plan is mined out; residuals need fresh
clustering (`built-ins/RegExp/**`, `built-ins/String/prototype/{match,replace,search,split}/**`
symbol-protocol tests).

Related known defect, separate issue: the shared-realm strict-rerun
regression on `cstm-matcher-on-boolean-primitive.js` is #5200 (test-infra,
not a codegen gap — do not chase it here).

## Implementation Plan

Planning pass required before implementation (plan/implement split).

- Step 0 — regenerate the regexp residual list on current main via the
  standalone probe (see #5194 step 0 for probe shape and the
  `.test262-cache` caveat).
- Step 1 — cluster by error signature; write the cluster table into this
  file.
- Step 2 — implement per cluster; re-probe; spot-checks stay green.
- Step 3 — five ratchet gates + equivalence gate.

## Acceptance criteria

- Cluster table with measured counts in this file before implementation.
- Measurable net gain on the regenerated list; no spot-check or equivalence
  regressions.

## References

- #5142 (wave-1 plan), PRs #5179, #5213; #5200 (strict-rerun isolation).
