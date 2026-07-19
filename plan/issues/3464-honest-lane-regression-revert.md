---
id: 3464
title: "ci(test262): honest-lane (daily) regression detection + revert-PR path"
status: ready
sprint: Backlog
priority: high
horizon: m
task_type: ci
area: ci
goal: maintainability
parent: 3450
depends_on: [3463]
---

# ci(test262): honest-lane regression detection + revert path

Child (d) of the #3450 HYBRID two-oracle pipeline. Full spec:
`plan/design/3450-hybrid-two-oracle-plan.md` §5.

## Problem

A PR can pass the fast merge gate but regress under the honest oracle. Since the
honest lane now runs only on the daily cron and `main` is append-only, such a
regression is caught post-merge at daily latency and must be repaired by a
**revert PR** (never a force-push).

## Scope

- Daily `honest-regression-gate` diffs fresh honest host/standalone reports vs
  the honest baselines, reusing the #1668 catastrophic guard, the #1897
  standalone floor, and **#3457 flap-tolerance**.
- On a real net regression above tolerance: do NOT promote the honest baseline;
  open/flag a `honest-regression`-labeled revert PR for the
  `<last_honest_sha>..HEAD` range with the regressed-row JSONL delta in the body
  (mirror the `auto-park-bot:merge-group-failure` comment format so the shepherd
  playbook applies).
- Multi-commit range: attach the per-bucket delta + range and escalate to the
  tech lead to pick the offending commit (per-commit bisect re-runs are a
  follow-up, out of scope for the first cut).
- Honest baseline never advanced past an un-reverted regression.

## Acceptance criteria

1. A synthetic honest-only regression (passes fast, fails honest) is detected by
   the next daily run and NOT promoted.
2. Detection opens/flags a `honest-regression` revert PR with the delta + range.
3. #3457 flap-tolerance suppresses sub-threshold flakiness (no false revert).
4. Honest baseline never advances past an un-reverted regression.
