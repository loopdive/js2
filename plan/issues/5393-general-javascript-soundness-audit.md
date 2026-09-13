---
id: 5393
title: "Extend differential auditing to general JavaScript behavior"
status: in-progress
sprint: current
created: 2026-09-08
updated: 2026-09-08
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
task_type: test
area: compiler
goal: correctness
assignee: "ttraenkler/codex-js-soundness"
depends_on: [5387]
---

## Request

After repairing PR 5748's CI failures, extend the differential audit from
TypeScript type-flow hazards to general JavaScript behavior. Preserve the
requirement to file measured defects and reject unsupported semantics instead
of silently changing program behavior.

## Method

Reuse the repository's general-JavaScript differential corpus with fresh
processes, Node reference execution, both Wasm targets, and normal/optimized
compilation. Preserve observable output and completion distinctions. Include
runtime-dependent inputs, state changes, evaluation order, exceptions, identity,
prototypes/descriptors, collections, numeric edges, closures, generators, and
asynchronous behavior. Validate the audit instrument with positive controls and
known divergences. Report mismatches, explicit compiler refusals, harness
limitations, and unmeasured behavior separately.

No finite audit can prove equivalence for all JavaScript programs. "No finding"
is not a general soundness certificate. Unknown or unsupported observations must
remain visible in the result, and compile errors do not count as conformance.

## Acceptance criteria

- [x] Repair the predecessor's CI regressions without expanding failure baselines.
- [x] Commit a broader, reproducible JavaScript corpus and exact execution records.
- [x] Exercise host/standalone and normal/optimized compilation with Node references.
- [x] File new measured defect families or link matching existing issues.
- [x] Add narrow source-located refusals or repairs for confirmed silent divergences.
- [x] Verify matching controls and rerun affected equivalence/quality checks.

## Findings

The committed manifest contains 168 programs: 120 existing corpus specimens and
48 additional JavaScript programs. Fresh-process observation preserves exact
output and distinguishes normal completion, program exceptions, compiler failures,
and unsupported observation protocols. The baseline records 118 divergences
(output, completion, or invalid Wasm), 528 matches, 10 refusals, and 16 unknowns
across 672 comparisons. Repairs and source-located refusals cover every measured
divergence in that manifest. Separate minimized controls cover Number parameter
shadowing and primitive console formatting outside its denominator.

See [the audit report](../audit/javascript-soundness-2026-09-08/README.md) for
final candidate counts, exact records, reproduction, and observation limits.
CI repair validation is recorded in the preceding TypeScript audit directory.
