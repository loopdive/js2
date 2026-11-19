---
id: TO-ALLOCATE
title: "Lane structure for the Prepared path: fewer lanes, file ownership, one coordinator, short plans"
status: ready
sprint: current
created: 2026-11-19
updated: 2026-11-19
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: process
area: process
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# Lane structure: fewer lanes that do not share files

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R9.

## Problem

On 2026-11-19 thirteen lanes started at 12:38Z. By 15:01Z: 16 PRs opened, 17 of 19 open PRs on `hold`, 13 behind
main, 120 CI runs queued, one docs PR merged. Two lanes built the same realm join. The lanes meet in the same files:
the dynamic-value kind tables and legalization, `program-physical-plan.ts`, `program-consumer.ts`,
`prepared-provider-census.ts`. A second lead session works on the same program without a shared channel. Plan
files have grown to 2,586 lines (#7354 on `claude/7354-o`) and 10,246 lines (#7106); 42,972 plan/doc lines were
added in the window against 36,804 `src` lines.

## To decide

- Lane count the CI and the shared files can carry (proposal: 4 to 5), each owning disjoint modules, with one owner
  for the shared tables and the consumer who merges rows for the others.
- One coordinator for the program; where the second session's work is registered.
- Plan files: the issue holds the plan and acceptance (proposal: under 300 lines); per-slice results and review
  rounds go to the PR body, not the issue.
- Integration order: one integration branch per mechanism instead of stacked PRs per step.

## Acceptance criteria

1. A lane table (owner, modules, branch) is committed and the pre-dispatch gate reads it.
2. No two open PRs edit the same shared table without the table owner's merge.
3. Measured after one week: PRs behind main at any time, CI queue length, merges per day.
