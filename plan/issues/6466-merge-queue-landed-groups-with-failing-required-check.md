---
id: 6466
title: "three merge groups landed on main with `merge shard reports` = failure, letting an unmeasured −174 through"
status: ready
sprint: current
created: 2026-09-13
updated: 2026-09-13
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: ci
goal: correctness
---

## Problem

`merge shard reports` is a REQUIRED check. On 2026-09-13 three commits landed on
`main` whose only check run for that context concluded `failure`:

| commit | PR | `merge shard reports` | landed |
| --- | --- | --- | --- |
| `607c3c799f` | #5875 | failure | yes |
| `c12c178e55` | #5882 | failure | yes |
| `82ca09dd09` | #5871 | failure | yes |

Reproduce:

```bash
gh api "repos/loopdive/js2/commits/82ca09dd09d086586e54ab22367f2d3a6b1f1026/check-runs?check_name=merge+shard+reports&per_page=100" \
  --jq '.check_runs[] | [.conclusion,.started_at,.html_url] | @tsv'
# failure  2026-09-13T03:40:18Z  .../runs/34735914442/job/103667570755
git merge-base --is-ancestor 82ca09dd09 upstream/main && echo ON-MAIN
```

A single check run each, no later re-run that flipped them green. (`1ada233708`,
in the same window, has `failure,success` — it was re-run, so the queue's normal
behaviour is visible right next to the three that were not.)

## Why it mattered

The shard jobs in that window all died with

```
##[error]Test262 shard did not reach afterAll; refusing partial JSONL evidence
```

because the `test262` submodule gitlink had been replaced by a symlink (repaired
later by `7871adcc79`, #5892). `merge-report` behaved correctly —
`SHARDS_RAN: false`, `SHARD_SKIP_OK: false`, "Fail if required test262 shards did
not succeed" — and failed the required check. The groups landed regardless.

`82ca09dd09` is PR #5871, which carries the −174 standalone `for-await-of`
regression now filed as
[#6465](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6465-for-await-of-declared-async-result-disagreement).
It reached `main` completely unmeasured, then breached the #2097 floor on the
next group that could run shards and parked the whole queue for ~4h
([#6461](https://js2wasm.loopdive.com/dashboard/issue.html?slug=6461-standalone-floor-below-mark-parks-queue)).

## What to determine

1. **How.** Ruleset bypass actor, an admin merge, a queue race between the
   check-run conclusion and the fast-forward, or the merge queue evaluating a
   different head than the one the check attached to. The audit log for
   2026-09-13T03:28–03:41Z is the primary source.
2. **Whether a broken corpus checkout should be able to produce a
   zero-measurement group at all.** The shards failing wholesale is a distinct
   signal from "no test262-relevant change"; today both arrive at `merge-report`
   as an absent artifact set and are separated only by `SHARD_SKIP_OK`. A
   submodule that is not a gitlink should fail the cheap gate, not 52 shard
   jobs — `git ls-files -s test262` must report mode `160000`.
3. Whether any other commit on `main` carries a failing required check
   (sweep `git rev-list --first-parent` against the check-runs API).

## Acceptance criteria

- A cheap-gate assertion that `test262` is a gitlink, so a symlinked submodule
  fails in seconds instead of taking down the whole matrix.
- A written answer to (1), and if it is a queue/ruleset gap, the ruleset change
  or the escalation to GitHub that closes it.
