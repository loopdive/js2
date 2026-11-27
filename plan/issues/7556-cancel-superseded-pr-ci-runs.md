---
id: 7556
title: "A new push to a PR cancels that PR's older CI runs"
status: done
sprint: current
created: 2026-11-27
updated: 2026-11-27
completed: 2026-11-27
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: ci
area: ci
goal: ci-hardening
related: [7551, 7553]
---

# #7556: a new push to a PR cancels that PR's older CI runs

## Problem

`ci.yml` (the workflow with the required `quality` check) and five other
pull-request workflows have no `concurrency` block. Every push to a PR starts
a new run and leaves the run for the previous head going. On 2026-11-26/27 the
repository had about 300 queued runs against 120 runners; a merge-queue run
waited 15 minutes for a runner for `quality` (run 45930010495). Superseded
runs had to be cancelled by hand.

## Implementation Plan

- Add the same `concurrency` block to the six pull-request workflows that have
  none: `ci`, `cross-backend-parity`, `landing-four-lane-backend`,
  `native-messaging-smoke`, `porffor-direct-ab`, `porffor-source-canary`.
- Group: the workflow name plus the PR's ref for `pull_request` events, and
  the run id for every other event. So only a PR's own older run is
  cancelled; runs on `main`, in the merge queue, on a schedule or by dispatch
  each have a group of their own and are neither cancelled nor serialised.
- `issue-tests.yml` already does this; `cla-check` and
  `passive-stack-retarget` run on `pull_request_target` and are a few seconds
  long, so they stay as they are.
- Quality criterion: one identical block per workflow, no per-workflow
  variation.

## Result

Six workflows carry the block. Not measured yet: the effect on the runner
backlog, which shows only once this is on main.
