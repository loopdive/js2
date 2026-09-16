---
id: 6491
title: "Linked lane: 36 negative early-error rows compile with no diagnostic (honest lane reports the SyntaxError)"
status: ready
sprint: current
created: 2026-09-16
updated: 2026-09-16
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: test262-runner
goal: test262-conformance
depends_on: [3451]
related: [3451, 6486, 3506]
---

# #6491 — early errors not detected on the body-only unit

## Problem (first full-corpus run, 2026-09-16, run 35116762391)

Parity bucket `expected SyntaxError but compiled with no diagnostic (early error
not detected)` = 36 rows: honest `pass` (diagnostic reported), linked `fail`.
The worker passes `enforceJsEarlyErrors: isNegative && negativePhase !== "resolution"`
to both branches, so either the early-error pass does not run on the
`compileMulti` graph the linked body is compiled through, or it runs on the
wrong file (the stub), or the check needs the harness prefix in the same unit
(e.g. duplicate-declaration / `let` redeclaration against a harness name).

## Implementation Plan (2026-09-16, Fable lane; implementation: Opus)

1. Pull the 36 file names from the parity JSON artifact
   (`test262-linked-baseline-8eeaee8e…`, run 35116762391) and group by the
   early-error kind the honest lane reported.
2. For each group, compile the body-only unit through `compileHarnessLinkedBody`
   with `enforceJsEarlyErrors: true` in a vitest probe and check
   `result.errors`; find where `enforceJsEarlyErrors` is consumed in
   `compileMultiSource` (`src/compiler.ts` ~L1840–1960, `detectEarlyErrors`
   call) and whether it covers every user file of the graph.
3. Fix in the compiler/lane, add the rows' shapes as unit cases, re-measure on
   the next `linked_lane` dispatch (bucket → 0).

## Acceptance

- [ ] The 36 rows agree with honest; no honest-lane change.
