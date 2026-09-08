---
id: 5387
title: "Audit TypeScript unsoundness hazards and reject unsupported JavaScript semantics"
status: in-review
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
assignee: "ttraenkler/codex-unsoundness"
depends_on: [5386]
# Integration and source-map plumbing stay in the shared pipeline; analyses live
# in three small compiler modules. No shared budget baseline is changed.
loc-budget-allow:
  - src/compiler.ts
func-budget-allow:
  - src/compiler.ts::compileSourceSync
---

## Request

Test the sources of TypeScript unsoundness described in
https://effectivetypescript.com/2021/05/06/unsoundness/ against JavaScript,
file reproducible mismatches, and emit compile-time errors for unsupported
semantics rather than silently generating different behavior.

## Scope and method

Use a finite, reproducible probe matrix covering the article's seven headings
and related structural/optional-property cases. Compare Node execution of
type-erased source with JS-host and standalone Wasm execution. Record accepted
matches, existing diagnostics, runtime mismatches, and harness limitations
separately. Include safe controls. This is not a proof of general soundness.

Base: `3bb59a816bbaf7`, including the preceding conditional-alias fix from
**#5386 — Preserve property type changes through conditional object aliases**.
That fix's PR is still undergoing CI; this branch deliberately depends on it.

Compiler diagnostics must identify the unsupported source construct with a
stable diagnostic identifier and source location. They must not execute user
programs during compilation or silently bypass unsupported cases.

## Acceptance criteria

- [x] Commit the audit specimens and measured results with exact denominators.
- [x] File or update issues for every confirmed mismatch family.
- [x] Reject the measured unsupported flows with actionable, source-located errors.
- [x] Preserve matching safe controls and the preceding alias fix.
- [x] Verify the diagnostic behavior through single-source and multi-source APIs.

## Results

See the committed [audit report](../audit/type-unsoundness-2026-09-08/README.md) and its 26 specimens, 78 baseline rows, and 78 candidate rows. The candidate records 19 matching Wasm executions and 33 actionable refusals out of 52, with zero remaining measured mismatches. Refusals are not conformance passes. Five child issues (5388–5392) track the failures and repairs.

The shared pipeline invokes three small static analyses before emission, preserving source locations and keeping the checks independent of TypeScript diagnostic suppression. Regression tests exercise synchronous, single-source, multi-source, and preprocessed source locations.

The scope remains bounded to visible origins and supported structural proofs; this does not certify arbitrary JavaScript programs.
