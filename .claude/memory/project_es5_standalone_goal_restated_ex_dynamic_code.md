---
name: project_es5_standalone_goal_restated_ex_dynamic_code
description: "Project-lead ruling 2026-08-01: the ES5+untagged standalone goal is ~95.4% EX-DYNAMIC-CODE, not 100%. The 317 dynamic-code files are out of scope, not failures."
metadata: 
  node_type: memory
  type: project
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T20:54:07.705Z
---

**Stakeholder ruling, project lead, 2026-08-01 — option (b), "b for now"**
(revisitable, not permanent).

The goal **"100% test262 standalone pass rate for ES5 and untagged tests" is
arithmetically unreachable** and has been restated as:

> **~95.4%, ex-dynamic-code** — target **8,150 of 8,545** reachable
> (6,176 passing + 1,974 non-dynamic failures).

## The 317 excluded files are DECLINE-BY-DEPENDENCY, not failures

| blocker | files | needs |
|---|---:|---|
| eval / `Function` | ~144 | real eval — the Acorn interpreter provider (#2928); minutes to compile, unaffordable per shard. A **packaging** problem (#2527) as much as semantics. |
| `with` — object environment records with first-class Reference identity | ~162 | a **front-end substrate**, same weight class as the 795-file descriptor MOP |

Near-disjoint; 13 files need both. **Funding eval does NOT deliver `with`** — the
census originally filed `with` as "blocked on #2928", which was wrong and has
been corrected on `main`.

## Operational consequences

- **Do not dispatch agents at the 317.**
- **Do not measure progress against 8,545, and do not report "100%".** A run at
  95.4% is **success**, not a 4.6% shortfall.
- **95.4% is an UPPER BOUND, not a forecast** — 202 files remain unpriced, and
  diffuse usually means expensive per file.

## Why the exclusion is sound (this is the load-bearing control)

A **non-circularity control**: the same detector run over the 6,176 goal-scope
**passes** finds **248 files that use `eval`/`with`/`Function` and pass anyway**.
So "dynamic code is fatal" was never assumed — the 317 were identified by
**engine refusal**, not by mentioning the feature.

Also: `with` is **168 of 175 host-lane too**, so it is shared front-end
scope-analysis work, not a standalone-gap item. The agent that measured it
recommended against funding it as a conformance lever at all.

## Revisit trigger

Reopen option (a) if #2527 packaging ever makes real eval affordable per shard —
that is the gate on the 144.

Provenance: `plan/log/analysis-2026-08-01-es5-untagged-tail-census.md`, baselines
`d8c30f3b7df0` (2026-08-01T17:14:04Z), js2 main `bc54c09da`.

Related: [[reference_cached_baseline_jsonl_goes_stale_within_hours]],
[[feedback_measure_never_extrapolate]],
[[feedback_file_defects_as_issue_markdown_not_tasklist]].
