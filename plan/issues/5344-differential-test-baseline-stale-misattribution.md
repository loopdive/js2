---
id: 5344
title: "`Differential test` diffs against a baseline last refreshed 2026-07-19 and is not required — it blames whichever PR is in the queue"
status: ready
sprint: current
created: 2026-09-05
updated: 2026-09-05
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: infra
area: ci
goal: correctness
---

## Problem

`benchmarks/results/diff-test-baseline.json` was last committed **2026-07-19**
(`0b1a2cca8f`). `.github/workflows/diff-test.yml` and
`scripts/diff-test-gate.ts` exist to maintain it and evidently have not run
in seven weeks. Because the gate reports the *delta* against that baseline,
and because `Differential test` is **not** one of the six required checks
(verified: `cheap gate`, `merge shard reports`, `quality`,
`equivalence-gate`, `check for test262 regressions`, `cla-check`), the result
is a check that is red on clean `main`, attributes a weeks-old delta to
whichever PR happens to be in the merge queue, and stops nobody.

This is worse than no gate. On 2026-09-05 it cost the #5333 P0 fix (PR
#5620) real time: `closures/06-nested.js: match → mismatch` looked like a
closure regression on a closure PR. It reproduced with the change reverted
and at `4946cf70fe`, so the agent left evidence on the PR to stop anyone
parking it — but only because it checked.

## Acceptance criteria

1. The baseline is current: refreshed from `main`, committed, and the refresh
   path (`diff-test.yml` or a step in an existing post-merge workflow)
   demonstrably runs — show a run.
2. `Differential test` is green on clean `main` after the refresh.
3. The delta gate's own comment (which claims a workflow refreshes the
   baseline) matches reality.
4. **A recommendation, not a unilateral change**, on making it required —
   with the cost figure and the false-positive history from this issue. Adding
   a required check is a ruleset change (`docs/ci-policy.md` §7); propose it
   in the PR body.
5. Since this touches `.github/workflows/**` from a fork head, expect the
   `needs-manual-enqueue` label (#3584); that is a lead action, not a hold.

## Implementation Plan

1. Read `.github/workflows/diff-test.yml` — find its trigger and why it has
   not written the baseline since July. The three usual causes in this repo:
   a `paths:` filter that no longer matches; a concurrency group cancelled by
   the more frequent main pushes (see the `npm-compat-refresh` lesson in
   CLAUDE.md — never `cancel-in-progress` a job longer than its trigger
   interval); or a promotion step gated on a sha-equality check that always
   defers. Fix the actual cause.
2. Read `scripts/diff-test-gate.ts` for the baseline format and the refresh
   command. Regenerate locally from current `main`
   (`node --import tsx scripts/diff-test-gate.ts --update` or equivalent —
   confirm the flag), commit the result.
3. If the refresh belongs in a post-merge workflow, model it on
   `benchmark-refresh.yml` (direct push with the main-push-queue-gate), **not**
   on a PR-based promotion — and mind the "gate promotion on artifact
   freshness, never on commit-sha equality" rule.
4. Verify: run the gate locally against the new baseline on clean `main` → 0
   delta. Push, confirm the workflow runs and the check is green.
5. PR body: state cost, state the recommendation on `required`.

## Dispatch

Model: **sonnet**. CI plumbing with a known cause-space and a clear
definition of done; no compiler judgement needed.
