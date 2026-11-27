---
id: 7553
title: "auto-enqueue skips green PRs whose `mergeable` is still UNKNOWN, sweep after sweep"
status: done
sprint: current
created: 2026-11-27
updated: 2026-11-27
completed: 2026-11-27
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: ci
area: ci
goal: ci-hardening
related: [4094, 2786]
---

# #7553: auto-enqueue skips green PRs whose `mergeable` is UNKNOWN

## Problem

`scripts/enqueue-green-prs.mjs` reads `mergeable` for all open PRs from one
`gh pr list` call. GitHub computes that field lazily: after a push to main it
answers `UNKNOWN` and only starts the computation. The gate fails closed on
`UNKNOWN` ("retry next sweep"), but the next sweep asks the same cold question.

Measured on the sweep of 2026-11-27 01:52 UTC (run log of `auto-enqueue.yml`):
100 open PRs, 28 skipped as `mergeable:UNKNOWN (UNKNOWN)`. PR #7446 had all 44
checks green and `mergeable_state: clean` since 00:47 UTC and was skipped by the
sweeps at 01:03 and 01:52 for this reason alone.

## Implementation Plan

- Module: `scripts/enqueue-green-prs.mjs` only (the workflow checks out just
  this file, so no shared helper can be imported).
- One pure, exported function `settledMergeable(mergeable, reread, pause,
  attempts)`: while the value is `UNKNOWN`, pause and re-read that one PR
  (`freshPrForEnqueue`, which already exists). It is called where the gate reads
  `pr.mergeable`, after the draft / hold / already-queued skips, so only real
  candidates pay for the re-read.
- The gate itself is unchanged: a value that is still `UNKNOWN` is refused.
- Cost bound: 2 re-reads x 2 s per candidate; with 28 cold candidates about
  2.5 minutes worst case. The workflow's concurrency group never cancels the
  running sweep, so a longer sweep is safe.
- Quality criterion: no second eligibility path, no change to
  `enqueueEligibility`, no new dependency.

## Acceptance criteria

- A candidate whose list value is `UNKNOWN` and whose re-read says `MERGEABLE`
  goes on to the checks gate in the same sweep.
- A value that stays `UNKNOWN` is still refused.
- `tests/issue-7553-enqueue-mergeable-unknown.test.ts` covers both.
