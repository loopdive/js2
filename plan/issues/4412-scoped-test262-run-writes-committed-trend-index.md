---
id: 4412
title: "A scoped local test262 run silently writes the committed trend index"
status: done
sprint: 78
created: 2026-08-14
updated: 2026-08-18
completed: 2026-08-14
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: ci
goal: correctness
---

## Problem

`scripts/run-test262-vitest.sh` appends a summary row to
`benchmarks/results/runs/index.json` whenever a run reaches `COMPLETED`. That
file is **committed** and is what the report page reads for its conformance
trend graph.

The append had no notion of a **scoped** run. The runner supports two
scope-narrowing knobs:

- `TEST262_PATH_FILTER` — pipe-separated substrings, applied per test
- `TEST262_LOCAL_SHARD_GLOB` — run a subset of the 16 shard files

With either set, the run still reaches `COMPLETED`, and the row it posts is a
**partial total presented as a full pass**.

## Observed

2026-08-14, during the #4218 oracle A/B: a single-shard local run appended

```json
{ "timestamp": "20260814-165702", "pass": 1902, "fail": 573, "ce": 236,
  "skip": 1, "total": 2713, "strict_pass": 1782, "strict_total": 2556 }
```

next to real ~30,000-test entries. The planned 32-invocation sharded
experiment would have written 32 such rows.

**Nothing downstream would have caught it.** The row is well-formed and
schema-valid; only its *meaning* is wrong. It surfaced solely because a local
stop hook noticed `git status` was dirty — which is not a control, and would
not have fired in a context that commits routinely or in CI.

## Fix

`scripts/should-publish-run-history.mjs` — a single decision function, called
by the runner (exit 0 = publish, 1 = skip, reason on stdout):

| condition                                | result                  |
| ---------------------------------------- | ----------------------- |
| no scope var set                         | publish                 |
| `TEST262_LOCAL_SHARD_GLOB` = the default | publish                 |
| `TEST262_PATH_FILTER` non-empty          | **skip**                |
| `TEST262_LOCAL_SHARD_GLOB` narrowed      | **skip**                |
| `TEST262_PUBLISH_HISTORY=1`              | publish, naming the scope |
| `TEST262_PUBLISH_HISTORY=0`              | skip                    |

The default is to **refuse**: a scoped run has to opt in, not opt out. Only
the literal `"1"` forces publication — `"yes"`/`"true"` are treated as unset,
so a sloppy override cannot smuggle a partial row through.

The decision lives in its own module rather than inline in the shell script so
it is unit-testable; a guard nobody can test is a guard that rots.

## Acceptance criteria

- [x] A path-filtered run does not append to `runs/index.json`.
- [x] A narrowed-shard-glob run does not append.
- [x] An unscoped run still appends (no behaviour change for CI or a real
      local full run).
- [x] The skip prints why, so it does not read as a failure.
- [x] `TEST262_PUBLISH_HISTORY=1` can force it; only the literal `"1"` counts.
- [x] Unit tests in `tests/issue-4412-run-history-guard.test.ts`, including
      the exact single-shard case that produced the bad row.

## Notes

Found while running a scoped standalone A/B for #4218/#4410 on a container
where a full pass is ~8h per backend. The same class of hazard applies to any
artifact a local run can write — worth a sweep of the other
`benchmarks/results/` writers for scope-awareness.
