---
id: 5399
title: "Refuse concrete unsupported JavaScript runtime operations found by the audit"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: correctness
parent: 5393
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
func-budget-allow:
  - src/codegen/expressions/call-identifier.ts::compileIdentifierCall
assignee: "ttraenkler/codex-js-runtime-safety"
---

## Measured defects

The immutable 168-program audit exposes unsupported operations independently of
TypeScript assertions: sparse-array presence, array prototype lookup, host array
coercion, alternate method receivers, derived constructors returning an object
before super, and host Promise.all array materialization. Standalone additionally
loses precision in String(BigInt), serializes private-only class instances as null,
and confuses an absent Map object key with a present undefined value.

Each source and exact before/after observation is in the general JavaScript audit
manifest and artifacts. Diagnostics must identify a concrete unsupported source
operation; absence of a diagnostic is not a claim that arbitrary JavaScript is safe.

## Acceptance criteria

- [x] Repair exact BigInt formatting without a Number round trip.
- [x] Refuse the measured unsupported operations with source locations.
- [x] Preserve supported neighboring operations and shadowed builtin names.
- [x] Rerun the complete four-lane audit and report residual errors honestly.
- [x] Run the full equivalence gate without expanding its baseline.

## Implementation and validation

String(BigInt) now uses the exact native integer formatter. Concrete unsupported
operations receive source-located diagnostics from the shared safety collector.
Thirty focused tests pass, including shadowed declarations, supported coercion
controls, filled-hole membership, and precise BigInt conversion. Unresolved
origins remain unclassified; this is not a general alias or coercion analysis.

Exact baseline/candidate rows and final validation are recorded in the
[general JavaScript audit](../audit/javascript-soundness-2026-09-08/README.md).
