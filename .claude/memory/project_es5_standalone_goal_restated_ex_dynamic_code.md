---
name: project_es5_standalone_goal_restated_ex_dynamic_code
description: "Superseded boundary: as of 2026-08-13 the ES5 test262 goal is 100% in both host and standalone, including eval, Function, and with."
metadata:
  node_type: memory
  type: project
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-13T00:00:00.000Z
---

# ES5 completion scope includes dynamic code and `with`

**Current stakeholder ruling, project lead, 2026-08-13 — supersedes the
temporary 2026-08-01 carveout below.**

The goal is **100% test262 conformance for the complete ES5-and-earlier corpus
in both execution lanes**. At the current pinned corpus that means:

- host lane: **9,029 / 9,029 pass**;
- standalone lane: **9,029 / 9,029 pass**;
- zero failures, compile errors, compile timeouts, or skips in that population.

`eval`, indirect eval, the `Function` constructor, and `with` are all inside
the completion boundary. They are implementation work, not exclusions.

## Operational consequences

- Dispatch and prioritize `eval`, `Function`, and `with` defects normally.
- Count every one of the 9,029 ES5-and-earlier rows in both lanes when reporting
  completion.
- Dynamic-source and `with` cohorts may be used as diagnostic partitions, but
  never as denominator exclusions or a substitute completion target.
- Do not report the former ~95.4% ex-dynamic-code target as current.

## Superseded historical ruling

On 2026-08-01 the goal was temporarily described as approximately 95.4%, with
317 dynamic-code/`with` files excluded because the then-current eval packaging
and object-environment-record substrate were considered too expensive. That was
explicitly revisitable and is now obsolete. Its measurements remain useful as
historical routing evidence only; they no longer define scope.

Historical provenance:
`plan/log/analysis-2026-08-01-es5-untagged-tail-census.md`, baseline
`d8c30f3b7df0`, js2 main `bc54c09da`.

Current goal source: `plan/goals/es5.md`.

Related: [[project_test262_lane_parity_program]],
[[feedback_measure_never_extrapolate]],
[[feedback_file_defects_as_issue_markdown_not_tasklist]].
