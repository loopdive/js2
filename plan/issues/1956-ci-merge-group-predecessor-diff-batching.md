---
id: 1956
title: "CI: merge-group predecessor diffing → enable merge-queue batching (rollups) safely"
status: done
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: hard
reasoning_effort: high
sprint: 61
depends_on: [1951, 1952]
area: ci
---
## Implemented (2026-06-11)

As designed below, with one deviation: results are published as
`test262-group-<group-head-sha>` workflow artifacts (3-day retention) by
merge-report on merge_group runs, and the regression-gate resolves the
predecessor as `HEAD^1` of the group ref and downloads the artifact via the
actions API (job got `actions: read`). Resolution path is logged as
`pred_path=hit|miss|…` in the step output for observability. Queue ruleset
flip applied post-merge: `max_entries_to_build: 5`, `max_entries_to_merge: 5`,
`min_entries_to_merge: 1` — min stays 1 deliberately: a single multi-PR group
gets one combined run and would reintroduce intra-group masking; with min=1
every PR keeps its own run, predecessor-diffed, so batching only adds
*concurrency*, not aggregation. docs/ci-policy.md §queue updated.

## Problem

The merge queue is pinned to batch=1 (docs/ci-policy.md: "each PR validated on
its own merge_group ref, no ALLGREEN hiding"). Under load this serializes
~5–12 min of full-matrix validation per queued PR (observed queue depth 6 on
2026-06-10; #1311 waited behind 4 PRs ≈ 40–60 min). Batching (minimum group
size > 1) would validate N PRs in one run — but with the current gate, which
diffs the group against the *main baseline* and passes on **net** ≥ −tolerance,
one PR's improvement can mask another's regression inside the same group
(ALLGREEN hiding). That masking is the documented reason for batch=1.

## Design: diff each group against its predecessor group

The per-test diff infrastructure (diff-test262.ts, #1081 runs/ cache) makes
per-PR attribution possible *inside* the queue:

1. **Publish group results**: every merge_group run uploads its merged host +
   standalone JSONLs as a workflow **artifact** named
   `test262-group-<group-head-sha>` (retention 3 days). Artifacts, not the
   baselines repo — group results are ephemeral and would bloat a git repo
   (~36MB per group).
2. **Resolve the predecessor**: the queue builds groups incrementally —
   group_k's head is a merge commit whose **first parent is group_{k−1}'s
   head** (or the main tip for the queue head). So `git rev-parse HEAD^1` on
   the group ref identifies the predecessor.
3. **Baseline resolution order** (regression-gate, merge_group event):
   a. artifact `test262-group-<HEAD^1>` from a recent run (cross-run download
      via the actions artifacts API) — exact predecessor, isolates THIS PR's
      delta even in a batch;
   b. #1081 `runs/<HEAD^1>` cache entry in the baselines repo (HEAD^1 is a
      main commit when this PR is the queue head);
   c. latest-main baseline (today's behavior) with a drift warning.
4. **Gate**: per-PR delta gating (net < 0 for *this PR's* delta fails) —
   tolerances can tighten because predecessor diffs carry no cross-PR drift.
5. **Flip the queue settings** (ruleset API / scripts/enable-branch-protection.sh):
   raise max-entries-to-build (concurrent group validation) and
   min/max-entries-to-merge with a short wait timer. Update docs/ci-policy.md
   §batch=1 rationale — the hiding objection is retired by (1)–(4).

## Validation plan

- Land (1)–(4) while the queue is still batch=1: predecessor resolution then
  always hits (b) or (c) and behavior is identical-or-stricter. Watch one week
  of queue traffic for resolution-path stats (log a/b/c hit rates).
- Then flip (5) conservatively (build 3 / merge 3 / wait 2 min), watch bounce
  rate; a red group disbands and retries, so the win depends on the bad-PR
  rate at queue entry (kept low by PR-time validation, #1954 scoped or full).

## Failure modes to handle

- Predecessor artifact missing (expired, run cancelled by #1952's sweeper,
  parallel group raced) → fall through (b)/(c), warn.
- Group built non-incrementally (queue implementation detail changes) →
  HEAD^1 won't resolve to a known group/run; falls through safely.
- Artifact download needs `actions: read` on the regression-gate job.
